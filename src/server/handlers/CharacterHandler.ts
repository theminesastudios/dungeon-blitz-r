import { Client, clearKeepTutorialTimers, createKeepTutorialState } from '../core/Client';
import { CharacterTemplates } from '../core/CharacterTemplates';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { LevelHandler } from './LevelHandler';
import { MissionHandler } from './MissionHandler';
import { WorldEnter } from '../utils/WorldEnter';
import { normalizeCharacterInventoryGears } from '../utils/GearInventory';
import { Config } from '../core/config';
import { JsonAdapter } from '../database/JsonAdapter';
import { Character } from '../database/Database';
import { LoginHandler } from './LoginHandler';
import { AbilityHandler } from './AbilityHandler';
import { SocialHandler } from './SocialHandler';
import { GuildHandler } from './GuildHandler';
import { EntityHandler } from './EntityHandler';
import { PetHandler } from './PetHandler';
import { DebugLogger } from '../core/Debug';
import { syncClientDungeonRunState } from '../core/DungeonRunStats';
import { ensureCharacterSocialState, normalizeCharacterKey } from '../core/SocialState';
import { getPartyIdForClient, areClientsInSameParty } from '../core/PartySync';
import { TransferTokenAllocator } from '../core/TransferTokenAllocator';
import { normalizeGender } from '../utils/normalizeGender';
import {
    createDungeonInstanceId,
    getClientLevelScope,
    getScopeLevelInstanceId,
    getScopeLevelName,
    normalizeLevelInstanceId
} from '../core/LevelScope';

const db = new JsonAdapter();

export class CharacterHandler {
    private static async saveCharacterSnapshot(client: Client): Promise<void> {
        if (!client.character) {
            return;
        }

        if (!client.userId) {
            client.characters = CharacterHandler.upsertCharacterList(client.characters, client.character);
            return;
        }

        client.characters = await db.saveCharacterSnapshot(client.userId, client.character);
    }

    private static initializeFreshCharacterProgress(character: Character): void {
        const newbieSpawn = LevelConfig.getSpawn("NewbieRoad");

        character.CurrentLevel = { name: "TutorialBoat", x: 0, y: 0 };
        character.PreviousLevel = {
            name: "NewbieRoad",
            x: newbieSpawn.x,
            y: newbieSpawn.y
        };
        character.dialogueLanguage = 'en';
        character.missions = {};
        character.questTrackerState = 0;
    }

    private static sendBootstrappedStoryMission(client: Client, missionId: number): void {
        if (!client.character || missionId <= 0) {
            return;
        }

        const missions = client.character.missions;
        if (!missions || typeof missions !== 'object' || Array.isArray(missions)) {
            return;
        }

        const state = Number((missions as Record<string, Record<string, unknown>>)[String(missionId)]?.state ?? 0);
        if (state !== 1 && state !== 2) {
            return;
        }

        MissionHandler.sendMissionAdded(client, missionId, state);
    }

    private static normalizeCharacterName(value: string | null | undefined): string {
        return String(value || '').trim().toLowerCase();
    }

    private static isPlaceholderCharacterName(value: string | null | undefined): boolean {
        const normalized = CharacterHandler.normalizeCharacterName(value);
        return normalized === '' || normalized === 'player';
    }

    private static allocateTransferToken(targetLevel: string): number {
        return TransferTokenAllocator.allocate(targetLevel);
    }

    private static isSessionStale(session: Client): boolean {
        return session.socket.destroyed || session.socket.readyState !== 'open';
    }

    private static purgeSameCharacterGhosts(activeClient: Client, userId: number, characterName: string): void {
        const normalizedCharName = String(characterName || '').trim().toLowerCase();

        for (const [levelScopeKey, levelMap] of Array.from(GlobalState.levelEntities.entries())) {
            const liveEntityIds = new Set<number>();
            const liveOwnerTokens = new Set<number>();

            for (const session of GlobalState.sessionsByToken.values()) {
                if (session === activeClient || CharacterHandler.isSessionStale(session)) {
                    continue;
                }
                if (!session.playerSpawned || getClientLevelScope(session) !== levelScopeKey) {
                    continue;
                }

                if (session.clientEntID > 0) {
                    liveEntityIds.add(session.clientEntID);
                }
                if (session.token > 0) {
                    liveOwnerTokens.add(session.token);
                }
            }

            for (const [entityId, entityProps] of Array.from(levelMap.entries())) {
                const normalizedEntityName = String(entityProps?.name || '').trim().toLowerCase();
                const ownerUserId = Number(entityProps?.ownerUserId ?? 0);
                const ownerToken = Number(entityProps?.ownerToken ?? 0);
                const isSameUser = ownerUserId > 0 && ownerUserId === userId;
                const isSameCharacter = normalizedEntityName === normalizedCharName;
                const isDuplicatePlayer = Boolean(entityProps?.isPlayer) && (isSameUser || isSameCharacter);
                const isDuplicateOwnedSpawn = Boolean(entityProps?.clientSpawned) && isSameUser;

                if (!isDuplicatePlayer && !isDuplicateOwnedSpawn) {
                    continue;
                }
                if (getClientLevelScope(activeClient) === levelScopeKey && activeClient.clientEntID > 0 && activeClient.clientEntID === entityId) {
                    continue;
                }
                if (liveEntityIds.has(entityId)) {
                    continue;
                }
                if (Boolean(entityProps?.clientSpawned) && ownerToken > 0 && liveOwnerTokens.has(ownerToken)) {
                    continue;
                }

                levelMap.delete(entityId);
                EntityHandler.broadcastDestroyEntity(
                    getScopeLevelName(levelScopeKey),
                    entityId,
                    null,
                    getScopeLevelInstanceId(levelScopeKey),
                    entityProps
                );
            }

            if (levelMap.size === 0) {
                GlobalState.levelEntities.delete(levelScopeKey);
            }
        }

        for (const [token, other] of Array.from(GlobalState.sessionsByToken.entries())) {
            if (other === activeClient) {
                continue;
            }
            if (other.userId !== userId) {
                continue;
            }
            if (!CharacterHandler.isSessionStale(other)) {
                continue;
            }

            EntityHandler.removeOwnedEntities(other);
            GlobalState.sessionsByToken.delete(token);
            if (GlobalState.sessionsByUserId.get(userId) === other) {
                GlobalState.sessionsByUserId.delete(userId);
            }
            GlobalState.pendingTeleports.delete(token);
            GlobalState.tokenChar.delete(token);
            const otherCharacterKey = normalizeCharacterKey(other.character?.name);
            if (otherCharacterKey && GlobalState.sessionsByCharacterName.get(otherCharacterKey) === other) {
                GlobalState.sessionsByCharacterName.delete(otherCharacterKey);
            }
            other.playerSpawned = false;
        }
    }

    private static upsertCharacterList(characters: Character[], character: Character): Character[] {
        const next = Array.isArray(characters) ? [...characters] : [];
        ensureCharacterSocialState(character);
        const normalizedName = CharacterHandler.normalizeCharacterName(character?.name);
        const index = next.findIndex((entry) => CharacterHandler.normalizeCharacterName(entry?.name) === normalizedName);

        if (index >= 0) {
            next[index] = character;
            return next;
        }

        next.push(character);
        return next;
    }

    private static async reloadCurrentCharacterFromSave(client: Client): Promise<void> {
        if (!client.character) {
            return;
        }

        if (!client.userId) {
            client.characters = CharacterHandler.upsertCharacterList(client.characters, client.character);
            return;
        }

        const loadedCharacters = await db.loadCharacters(client.userId);
        const normalizedName = CharacterHandler.normalizeCharacterName(client.character?.name);
        const loadedCharacter = loadedCharacters.find((entry) =>
            CharacterHandler.normalizeCharacterName(entry?.name) === normalizedName
        );

        if (loadedCharacter) {
            client.character = loadedCharacter;
            client.characters = loadedCharacters;
            DebugLogger.logProgress('CharacterReload:loaded', client, loadedCharacter, {
                source: 'disk'
            });
            return;
        }

        client.characters = CharacterHandler.upsertCharacterList(loadedCharacters, client.character);
        DebugLogger.logProgress('CharacterReload:missingOnDisk', client, client.character, {
            source: 'memory'
        });
    }

    private static buildPaperDollPacket(character: Character): BitBuffer {
        const bb = new BitBuffer(false);

        for (const value of [
            character.name,
            character.class,
            normalizeGender(character.gender),
            character.headSet,
            character.hairSet,
            character.mouthSet,
            character.faceSet
        ]) {
            bb.writeMethod13(String(value ?? ''));
        }

        for (const color of [
            character.hairColor,
            character.skinColor,
            character.shirtColor,
            character.pantColor
        ]) {
            bb.writeMethod6(Number(color ?? 0), 24);
        }

        const fallbackTemplate = CharacterTemplates.get(String(character.class ?? ''));
        const equippedGears = Array.isArray(character.equippedGears) && character.equippedGears.length > 0
            ? character.equippedGears
            : Array.isArray(fallbackTemplate?.equippedGears)
                ? fallbackTemplate.equippedGears
                : [];

        for (let i = 0; i < 6; i++) {
            const slot = equippedGears[i];
            const gearId = Array.isArray(slot)
                ? Number(slot[0] ?? 0)
                : Number((slot as Record<string, unknown> | undefined)?.gearID ?? 0);
            bb.writeMethod6(gearId, 11);
        }

        return bb;
    }

    private static buildLookUpdatePacket(entityId: number, character: Character): BitBuffer {
        const bb = new BitBuffer(false);

        bb.writeMethod4(Number(entityId || 0));
        bb.writeMethod13(String(character.headSet ?? ''));
        bb.writeMethod13(String(character.hairSet ?? ''));
        bb.writeMethod13(String(character.mouthSet ?? ''));
        bb.writeMethod13(String(character.faceSet ?? ''));
        bb.writeMethod13(normalizeGender(character.gender));
        bb.writeMethod6(Number(character.hairColor ?? 0), 24);
        bb.writeMethod6(Number(character.skinColor ?? 0), 24);

        return bb;
    }

    private static buildLevelGearsPacket(character: Character): BitBuffer {
        const bb = new BitBuffer(false);
        const inventoryGears = normalizeCharacterInventoryGears(character);

        bb.writeMethod4(inventoryGears.length);
        for (const rawGear of inventoryGears) {
            const gear = (rawGear && typeof rawGear === 'object') ? rawGear as Record<string, unknown> : {};
            bb.writeMethod6(Number(gear.gearID ?? 0), 11);
            bb.writeMethod6(Number(gear.tier ?? 0), 2);
        }

        return bb;
    }

    private static syncCurrentPlayerLookEntity(client: Client): void {
        const entityId = Number(client.clientEntID || 0);
        if (!client.character || entityId <= 0) {
            return;
        }

        const character = client.character;
        const applyLookFields = (entity: Record<string, unknown> | undefined): void => {
            if (!entity) {
                return;
            }

            entity.gender = normalizeGender(character.gender);
            entity.headSet = character.headSet;
            entity.hairSet = character.hairSet;
            entity.mouthSet = character.mouthSet;
            entity.faceSet = character.faceSet;
            entity.hairColor = Number(character.hairColor ?? 0);
            entity.skinColor = Number(character.skinColor ?? 0);
        };

        applyLookFields(client.entities.get(entityId));

        const levelScope = getClientLevelScope(client);
        if (levelScope) {
            applyLookFields(GlobalState.levelEntities.get(levelScope)?.get(entityId));
        }
    }

    private static broadcastLookUpdate(client: Client): void {
        if (!client.character) {
            return;
        }

        const entityId = Number(client.clientEntID || 0);
        if (entityId <= 0) {
            return;
        }

        const lookUpdate = CharacterHandler.buildLookUpdatePacket(entityId, client.character).toBuffer();
        const levelScope = getClientLevelScope(client);

        client.send(0x8F, lookUpdate);

        if (!levelScope) {
            return;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (other === client || !other.playerSpawned || getClientLevelScope(other) !== levelScope) {
                continue;
            }

            other.send(0x8F, lookUpdate);
        }
    }

    static handlePaperDollRequest(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const requestedName = br.readMethod26();
        const normalizedName = CharacterHandler.normalizeCharacterName(requestedName);

        const character = client.characters.find((entry) =>
            CharacterHandler.normalizeCharacterName(entry?.name) === normalizedName
        ) ?? (
            client.character && CharacterHandler.normalizeCharacterName(client.character.name) === normalizedName
                ? client.character
                : null
        );

        if (!character) {
            client.send(0x1A, Buffer.alloc(0));
            console.log(`[0x19] Character '${requestedName}' not found; sent empty 0x1A`);
            return;
        }

        client.sendBitBuffer(0x1A, CharacterHandler.buildPaperDollPacket(character));
    }

    static handleRequestArmoryGears(client: Client, data: Buffer): void {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        br.readMethod9();
        client.sendBitBuffer(0xF5, CharacterHandler.buildLevelGearsPacket(client.character));
    }

    static async handleHomeLookChange(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const character = client.character;
        const br = new BitReader(data);
        const headSet = br.readMethod26();
        const hairSet = br.readMethod26();
        const mouthSet = br.readMethod26();
        const faceSet = br.readMethod26();
        const gender = br.readMethod26();
        const hairColor = br.remainingBits() >= 24 ? br.readMethod20(24) : character.hairColor;
        const skinColor = br.remainingBits() >= 24 ? br.readMethod20(24) : character.skinColor;

        character.headSet = headSet;
        character.hairSet = hairSet;
        character.mouthSet = mouthSet;
        character.faceSet = faceSet;
        character.gender = normalizeGender(gender);
        character.hairColor = Number(hairColor ?? 0);
        character.skinColor = Number(skinColor ?? 0);

        CharacterHandler.syncCurrentPlayerLookEntity(client);

        await CharacterHandler.saveCharacterSnapshot(client);

        client.sendBitBuffer(0x1A, CharacterHandler.buildPaperDollPacket(character));
        CharacterHandler.broadcastLookUpdate(client);

        DebugLogger.logProgress('CharacterLookChange:saved', client, character, {
            headSet,
            mouthSet,
            hairSet,
            faceSet,
            gender,
            hairColor: Number(hairColor ?? 0),
            skinColor: Number(skinColor ?? 0)
        });
    }

    static async handleLoginCharacterCreate(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const name = br.readMethod26();
        const className = br.readMethod26();
        const gender = br.readMethod26();
        const head = br.readMethod26();
        const hair = br.readMethod26();
        const mouth = br.readMethod26();
        const face = br.readMethod26();
        const hairColor = br.readMethod20(24);
        const skinColor = br.readMethod20(24);
        const shirtColor = br.readMethod20(24);
        const pantColor = br.readMethod20(24);

        if (!client.userId) {
            console.log(`[CharCreate] No userId for client`);
            return;
        }

        // Check if name taken
        const isTaken = await db.isCharacterNameTaken(name);
        if (isTaken) {
             // Send Popup
             const bb = new BitBuffer();
             bb.writeMethod13("Character name is unavailable.");
             bb.writeMethod6(0, 1); // Disconnect = false
             client.sendBitBuffer(0x1B, bb);
             return;
        }

        // Create Character Object from Template
        let newChar = CharacterTemplates.get(className);
        
        if (!newChar) {
             console.error(`[CharCreate] No template found for class ${className}, using fallback.`);
             newChar = {
                class: className,
                level: 1,
                xp: 0,
                gold: 0,
                // ... minimal defaults ...
             };
        }

        // Apply Customization
        newChar.name = name;
        newChar.gender = normalizeGender(gender);
        newChar.headSet = head;
        newChar.hairSet = hair;
        newChar.mouthSet = mouth;
        newChar.faceSet = face;
        newChar.hairColor = hairColor;
        newChar.skinColor = skinColor;
        newChar.shirtColor = shirtColor;
        newChar.pantColor = pantColor;

        CharacterHandler.initializeFreshCharacterProgress(newChar);
        AbilityHandler.repairCharacterAbilityState(newChar);
        
        // Initialize arrays if missing
        if (!newChar.equippedGears) newChar.equippedGears = [];
        if (!newChar.inventoryGears) newChar.inventoryGears = [];
        if (!newChar.friends) newChar.friends = [];

        client.characters.push(newChar);
        await db.saveCharacters(client.userId, client.characters);
        client.character = newChar;

        console.log(`[CharCreate] Created char ${name} for user ${client.userId}`);

        // Enter World
        CharacterHandler.sendEnterWorld(client, newChar);
    }

    static async handleCharacterSelect(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const charName = br.readMethod26().trim();

        if (!client.userId) {
            console.log(`[CharacterSelect] No userId for client`);
            return;
        }

        client.characters = await db.loadCharacters(client.userId);
        const requestedName = CharacterHandler.normalizeCharacterName(charName);
        let char = client.characters.find((entry) => CharacterHandler.normalizeCharacterName(entry.name) === requestedName);

        if (!char && client.characters.length > 0 && CharacterHandler.isPlaceholderCharacterName(charName)) {
            char = client.characters[0];
            console.log(`[CharacterSelect] Placeholder name '${charName || '(empty)'}' received for user ${client.userId}; falling back to ${char.name}`);
        }

        if (!char && client.characters.length === 1) {
            char = client.characters[0];
            console.log(
                `[CharacterSelect] Requested '${charName || '(empty)'}' for user ${client.userId} did not match the only saved character; falling back to ${char.name}`
            );
        }

        if (!char) {
            const availableNames = client.characters.map((entry) => entry.name).filter(Boolean);
            console.log(`[CharacterSelect] Character ${charName} not found for user ${client.userId}. Available: ${availableNames.join(', ') || '(none)'}`);
            LoginHandler.sendCharacterList(client);

            const bb = new BitBuffer(false);
            const suffix = availableNames.length > 0
                ? `Available: ${availableNames.join(', ')}`
                : 'This account has no characters yet.';
            bb.writeMethod13(`Character '${charName}' was not found on this account. ${suffix}`);
            bb.writeMethod6(0, 1);
            client.sendBitBuffer(0x1B, bb);
            return;
        }

        client.character = char;
        console.log(`[CharacterSelect] Selected ${char.name}`);
        
        CharacterHandler.sendEnterWorld(client, char);
    }

    private static sendEnterWorld(client: Client, char: Character): void {
        // Determine Level
        const currentLevelName = char.CurrentLevel?.name || "NewbieRoad";
        const previousLevelName =
            LevelConfig.resolveDungeonEntryLevel(
                currentLevelName,
                char.PreviousLevel?.name || "NewbieRoad",
                char
            ) ||
            char.PreviousLevel?.name ||
            "NewbieRoad";
        const spawn = LevelConfig.getSpawnCoordinates(char, previousLevelName, currentLevelName);
        const isDungeonLevel = LevelConfig.isDungeonLevel(currentLevelName);

        // Generate Transfer Token
        const token = CharacterHandler.allocateTransferToken(currentLevelName);
        
        // Store Pending State
        if (client.userId) {
             // For dungeon levels, try to find a party member already in the same dungeon
             // and reuse their levelInstanceId so both players share the same level scope.
             let levelInstanceId = '';
             let syncAnchorStartedAt: number | undefined = isDungeonLevel ? Date.now() : undefined;
             let syncAnchorToken: number | undefined = isDungeonLevel ? token : undefined;
             let syncAnchorCharacterName: string | undefined = isDungeonLevel ? char.name : undefined;
             let syncRoomId: number | undefined;
             let syncStartedRoomIds: number[] | undefined;
             let syncEntryLevel: string | undefined;

             if (isDungeonLevel) {
                 const normalizedTarget = LevelConfig.normalizeLevelName(currentLevelName);
                 // Search active sessions for a party member in the same dungeon
                 for (const other of GlobalState.sessionsByToken.values()) {
                     if (!other.playerSpawned || !other.character) continue;
                     if (LevelConfig.normalizeLevelName(other.currentLevel) !== normalizedTarget) continue;
                     if (!areClientsInSameParty(client, other)) continue;
                     if (normalizeCharacterKey(other.character.name) === normalizeCharacterKey(char.name)) continue;

                     // Found a party member in the same dungeon — reuse their level scope
                     levelInstanceId = normalizeLevelInstanceId(other.levelInstanceId) || createDungeonInstanceId(token);
                     syncAnchorStartedAt = other.syncAnchorStartedAt > 0 ? other.syncAnchorStartedAt : Date.now();
                     syncAnchorToken = other.syncAnchorToken > 0 ? other.syncAnchorToken : token;
                     syncAnchorCharacterName = String(other.syncAnchorCharacterName || other.character.name).trim();
                     // NOTE: Do NOT sync syncRoomId or syncStartedRoomIds here.
                     // Room progress replay causes null errors in the Flash client when
                     // it receives room event start packets before the level SWF is loaded.
                     // Room progress will sync naturally as the Flash client loads rooms.
                     syncEntryLevel = LevelConfig.normalizeLevelName(other.entryLevel) || undefined;
                     console.log(`[EnterWorld] Syncing dungeon instance for ${char.name} with party anchor ${other.character.name} (instanceId=${levelInstanceId})`);
                     break;
                 }

                 if (!levelInstanceId) {
                     levelInstanceId = createDungeonInstanceId(token);
                 }
             }

             GlobalState.pendingWorld.set(token, {
                character: char,
                targetLevel: currentLevelName,
                levelInstanceId: levelInstanceId || undefined,
                previousLevel: previousLevelName,
                userId: client.userId,
                newX: spawn.x,
                newY: spawn.y,
                newHasCoord: spawn.hasCoord,
                syncAnchorStartedAt,
                syncAnchorToken,
                syncAnchorCharacterName,
                syncRoomId,
                syncStartedRoomIds,
                syncEntryLevel
            });
            GlobalState.pendingExtended.set(token, true);
        }

        // Get Level Config
        const levelSpec = LevelConfig.get(currentLevelName);
        const isHard = currentLevelName.endsWith("Hard");

        const pendingEntry = GlobalState.pendingWorld.get(token);
        const resolvedTransferToken = pendingEntry?.syncAnchorToken || token;

        const pkt = WorldEnter.buildEnterWorldPacket(
            resolvedTransferToken, // Ensure Flash client uses the Host's token for Room Event Generation Offset
            0, "", false, 0, 0,
            Config.HOST,
            Config.PORTS[0],
            levelSpec.swf,
            levelSpec.mapId,
            levelSpec.baseId,
            currentLevelName,
            isHard ? "Hard" : "",
            isHard ? "Hard" : "",
            levelSpec.isDungeon,
            spawn.hasCoord,
            spawn.x,
            spawn.y,
            char
        );

        DebugLogger.logProgress('EnterWorld:initialPacket', client, char, {
            transferToken: resolvedTransferToken,
            targetLevel: currentLevelName,
            targetSwf: levelSpec.swf,
            previousLevel: previousLevelName,
            previousSwf: '',
            sendExtended: true
        });

        // Store token mapping for persistence
        if (client.userId) {
            GlobalState.tokenChar.set(token, { character: char, userId: client.userId });
        }

        client.sendBitBuffer(0x21, pkt);
        console.log(`[EnterWorld] Sent 0x21 to client for char ${char.name}, token=${token}`);
    }

    static async handleGameServerLogin(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const token = br.readMethod9();
        const levelSwf = br.readMethod26(); 
        const firstLogin = br.readMethod15();
        const isDev = br.readMethod15();

        const entry = GlobalState.pendingWorld.get(token);
        if (!entry) {
            console.log(`[GameLogin] Invalid token ${token}`);
            return;
        }

        const sendExtended = firstLogin || Boolean(GlobalState.pendingExtended.get(token));

        client.character = entry.character;
        PetHandler.normalizeMountState(client.character);
        client.userId = entry.userId;
        client.token = token;
        client.clientEntID = 0;
        client.currentLevel = entry.targetLevel;
        client.levelInstanceId = LevelConfig.isDungeonLevel(entry.targetLevel)
            ? normalizeLevelInstanceId(entry.levelInstanceId) || createDungeonInstanceId(token)
            : '';
        console.log(`[GameLogin] ${entry.character.name} entering ${entry.targetLevel} with levelInstanceId='${client.levelInstanceId}' (from entry: '${entry.levelInstanceId}')`);
        client.entryLevel = LevelConfig.resolveDungeonEntryLevel(
            entry.targetLevel,
            entry.previousLevel,
            entry.character
        );
        const entryCoords = Boolean(entry.syncEntryHasCoord)
            && Number.isFinite(Number(entry.syncEntryX))
            && Number.isFinite(Number(entry.syncEntryY))
            ? {
                x: Math.round(Number(entry.syncEntryX)),
                y: Math.round(Number(entry.syncEntryY)),
                hasCoord: true
            }
            : LevelConfig.resolveDungeonEntryCoordinates(
                entry.targetLevel,
                entry.previousLevel,
                entry.character
            );
        client.entryX = entryCoords.x;
        client.entryY = entryCoords.y;
        client.entryHasCoord = entryCoords.hasCoord;
        client.syncAnchorStartedAt = Number.isFinite(Number(entry.syncAnchorStartedAt)) && Number(entry.syncAnchorStartedAt) > 0
            ? Math.round(Number(entry.syncAnchorStartedAt))
            : 0;
        client.syncAnchorToken = Number.isFinite(Number(entry.syncAnchorToken)) && Number(entry.syncAnchorToken) > 0
            ? Math.round(Number(entry.syncAnchorToken))
            : (LevelConfig.isDungeonLevel(entry.targetLevel) ? token : 0);
        client.syncAnchorCharacterName = String(
            entry.syncAnchorCharacterName ??
            (LevelConfig.isDungeonLevel(entry.targetLevel) ? entry.character.name : '')
        ).trim();
        client.currentRoomId = Number.isFinite(Number(entry.syncRoomId)) && Number(entry.syncRoomId) >= 0
            ? Math.round(Number(entry.syncRoomId))
            : 0;
        client.lastDoorId = -1;
        client.lastDoorTargetLevel = '';
        client.playerSpawned = false;
        client.worldEnteredAt = Date.now();
        client.mountTransferGraceUntil = Date.now() + 5000;
        client.entities.clear();
        client.clientSpawnConfirmed = false;
        clearKeepTutorialTimers(client.keepTutorialState);
        client.keepTutorialState = entry.targetLevel === 'CraftTownTutorial' ? createKeepTutorialState() : null;
        client.startedRoomEvents.clear();
        client.pendingLoot.clear();
        client.processedRewardSources.clear();
        syncClientDungeonRunState(client);

        if (entry.targetLevel === 'CraftTownTutorial') {
            LevelHandler.resetCraftTownTutorialInstance();
        }

        await CharacterHandler.reloadCurrentCharacterFromSave(client);

        await GuildHandler.refreshClientGuildState(client);
        const socialRepairDidMutate = ensureCharacterSocialState(client.character);
        const abilityRepairDidMutate = AbilityHandler.repairCharacterAbilityState(client.character);
        const storyRepair = MissionHandler.repairEarlyStoryOnLogin(client.character, entry.targetLevel);
        const expectedLevelSwf = LevelConfig.get(entry.targetLevel).swf;
        if ((socialRepairDidMutate || abilityRepairDidMutate || storyRepair.didMutate) && client.userId) {
            client.characters = CharacterHandler.upsertCharacterList(client.characters, client.character);
            void db.saveCharacters(client.userId, client.characters);
        }

        DebugLogger.logProgress('GameLogin:ready', client, client.character, {
            token,
            firstLogin,
            sendExtended,
            levelSwf,
            expectedLevelSwf,
            levelSwfMatchesTarget: levelSwf === expectedLevelSwf,
            isDev,
            storyRepairDidMutate: storyRepair.didMutate,
            storyRepairAddedMissionId: storyRepair.addedMissionId,
            socialRepairDidMutate,
            abilityRepairDidMutate
        });

        if (levelSwf !== expectedLevelSwf) {
            DebugLogger.logProgress('GameLogin:swfMismatch', client, client.character, {
                token,
                targetLevel: entry.targetLevel,
                expectedLevelSwf,
                clientLevelSwf: levelSwf,
                firstLogin,
                sendExtended
            });
        }

        CharacterHandler.purgeSameCharacterGhosts(client, entry.userId, entry.character.name);
        
        GlobalState.sessionsByToken.set(token, client);
        const liveCharacter = client.character;
        if (client.userId) {
            GlobalState.sessionsByUserId.set(client.userId, client);
            // Ensure persistence mapping exists
            GlobalState.tokenChar.set(token, { character: liveCharacter, userId: client.userId });
        }
        GlobalState.usedTransferTokens.set(token, {
            character: liveCharacter,
            userId: entry.userId,
            targetLevel: entry.targetLevel,
            levelInstanceId: client.levelInstanceId || undefined,
            previousLevel: entry.previousLevel,
            newX: entry.newX,
            newY: entry.newY,
            newHasCoord: entry.newHasCoord,
            syncAnchorStartedAt: entry.syncAnchorStartedAt,
            syncAnchorToken: client.syncAnchorToken > 0 ? client.syncAnchorToken : undefined,
            syncAnchorCharacterName: client.syncAnchorCharacterName || undefined,
            syncEntryLevel: entry.syncEntryLevel,
            syncRoomId: entry.syncRoomId,
            syncStartedRoomIds: entry.syncStartedRoomIds
        });
        const characterKey = normalizeCharacterKey(client.character.name);
        if (characterKey) {
            GlobalState.sessionsByCharacterName.set(characterKey, client);
        }
        GlobalState.pendingWorld.delete(token);
        GlobalState.pendingExtended.delete(token);
        
        console.log(`[GameLogin] Client logged in with token ${token} as ${client.character.name}`);

        const spawn = {
            x: entry.newX ?? 0,
            y: entry.newY ?? 0,
            hasCoord: entry.newHasCoord ?? false
        };
        LevelHandler.prepareGoblinRiverDungeonEntryState(client);

        // Send Player Data (0x10)
        const pdPkt = WorldEnter.buildPlayerDataPacket(
            client.character,
            token,
            0, 
            0,
            entry.targetLevel,
            spawn.x,
            spawn.y,
            spawn.hasCoord,
            sendExtended
        );
        const pdBuffer = pdPkt.toBuffer();

        client.send(0x10, pdBuffer);
        console.log(`[GameLogin] Sent 0x10 (Player Data)`);
        DebugLogger.logProgress('GameLogin:sentPlayerData', client, client.character, {
            token,
            sendExtended,
            targetLevel: entry.targetLevel,
            payloadLength: pdBuffer.length,
            payloadPreview: DebugLogger.previewBuffer(pdBuffer)
        });

        MissionHandler.syncMissionStateToClient(client);
        CharacterHandler.sendBootstrappedStoryMission(client, storyRepair.addedMissionId);

        SocialHandler.handleSessionReady(client);
        
        // Spawn NPCs
        LevelHandler.spawnLevelNpcs(client, entry.targetLevel);
        const restoredRoomProgress = LevelHandler.restoreTransferredRoomProgress(client, entry);
        if (!restoredRoomProgress) {
            LevelHandler.primeTutorialRoomEvents(client);
        }
        LevelHandler.syncSharedDungeonQuestProgressState(client);
        await LevelHandler.prepareCraftTownTutorialEntry(client);
        LevelHandler.scheduleClientSpawnFallback(client);
    }
}
