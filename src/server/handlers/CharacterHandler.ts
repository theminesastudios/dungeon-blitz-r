import { Client, clearKeepTutorialTimers, createKeepTutorialState } from '../core/Client';
import { CharacterTemplates } from '../core/CharacterTemplates';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { LevelHandler } from './LevelHandler';
import { MissionHandler } from './MissionHandler';
import { WorldEnter } from '../utils/WorldEnter';
import { Config } from '../core/config';
import { JsonAdapter } from '../database/JsonAdapter';
import { Character } from '../database/Database';
import { LoginHandler } from './LoginHandler';

const db = new JsonAdapter();

export class CharacterHandler {
    private static initializeFreshCharacterProgress(character: Character): void {
        const newbieSpawn = LevelConfig.getSpawn("NewbieRoad");

        character.CurrentLevel = { name: "TutorialBoat", x: 0, y: 0 };
        character.PreviousLevel = {
            name: "NewbieRoad",
            x: newbieSpawn.x,
            y: newbieSpawn.y
        };
        character.missions = {};
        character.questTrackerState = 0;
    }

    private static normalizeCharacterName(value: string | null | undefined): string {
        return String(value || '').trim().toLowerCase();
    }

    private static isPlaceholderCharacterName(value: string | null | undefined): boolean {
        const normalized = CharacterHandler.normalizeCharacterName(value);
        return normalized === '' || normalized === 'player';
    }

    private static purgeSameCharacterGhosts(activeClient: Client, userId: number, characterName: string): void {
        const normalizedCharName = String(characterName || '').trim().toLowerCase();

        for (const [levelName, levelMap] of Array.from(GlobalState.levelEntities.entries())) {
            for (const [entityId, entityProps] of Array.from(levelMap.entries())) {
                if (!entityProps?.isPlayer) {
                    continue;
                }
                if (String(entityProps?.name || '').trim().toLowerCase() !== normalizedCharName) {
                    continue;
                }
                if (activeClient.currentLevel === levelName && activeClient.clientEntID > 0 && activeClient.clientEntID === entityId) {
                    continue;
                }
                levelMap.delete(entityId);
            }

            if (levelMap.size === 0) {
                GlobalState.levelEntities.delete(levelName);
            }
        }

        for (const [token, other] of Array.from(GlobalState.sessionsByToken.entries())) {
            if (other === activeClient) {
                continue;
            }
            if (other.userId !== userId) {
                continue;
            }
            if (other.character?.name !== characterName) {
                continue;
            }

            GlobalState.sessionsByToken.delete(token);
            if (GlobalState.sessionsByUserId.get(userId) === other) {
                GlobalState.sessionsByUserId.delete(userId);
            }
            other.socket.destroy();
        }
    }

    private static upsertCharacterList(characters: Character[], character: Character): Character[] {
        const next = Array.isArray(characters) ? [...characters] : [];
        const normalizedName = CharacterHandler.normalizeCharacterName(character?.name);
        const index = next.findIndex((entry) => CharacterHandler.normalizeCharacterName(entry?.name) === normalizedName);

        if (index >= 0) {
            next[index] = character;
            return next;
        }

        next.push(character);
        return next;
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
        newChar.gender = gender;
        newChar.headSet = head;
        newChar.hairSet = hair;
        newChar.mouthSet = mouth;
        newChar.faceSet = face;
        newChar.hairColor = hairColor;
        newChar.skinColor = skinColor;
        newChar.shirtColor = shirtColor;
        newChar.pantColor = pantColor;

        CharacterHandler.initializeFreshCharacterProgress(newChar);
        
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
        const previousLevelName = char.PreviousLevel?.name || "NewbieRoad";
        const spawn = LevelConfig.getSpawnCoordinates(char, previousLevelName, currentLevelName);

        // Generate Transfer Token
        const token = Math.floor(Math.random() * 0xFFFF); 
        
        // Store Pending State
        if (client.userId) {
             GlobalState.pendingWorld.set(token, {
                character: char,
                targetLevel: currentLevelName,
                previousLevel: previousLevelName,
                userId: client.userId,
                newX: spawn.x,
                newY: spawn.y,
                newHasCoord: spawn.hasCoord
            });
            GlobalState.pendingExtended.set(token, true);
        }

        // Get Level Config
        const levelSpec = LevelConfig.get(currentLevelName);
        const isHard = currentLevelName.endsWith("Hard");

        const pkt = WorldEnter.buildEnterWorldPacket(
            token,
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
        client.userId = entry.userId;
        client.token = token;
        client.clientEntID = 0;
        client.currentLevel = entry.targetLevel;
        client.entryLevel = LevelConfig.get(entry.targetLevel).isDungeon ? entry.previousLevel : '';
        client.currentRoomId = 0;
        client.lastDoorId = -1;
        client.lastDoorTargetLevel = '';
        client.playerSpawned = false;
        client.entities.clear();
        client.clientSpawnConfirmed = false;
        clearKeepTutorialTimers(client.keepTutorialState);
        client.keepTutorialState = entry.targetLevel === 'CraftTownTutorial' ? createKeepTutorialState() : null;
        client.startedRoomEvents.clear();
        client.pendingLoot.clear();
        client.processedRewardSources.clear();

        if (entry.targetLevel === 'CraftTownTutorial') {
            LevelHandler.resetCraftTownTutorialInstance();
        }

        if (client.userId) {
            const loadedCharacters = await db.loadCharacters(client.userId);
            client.characters = CharacterHandler.upsertCharacterList(loadedCharacters, client.character);
        } else {
            client.characters = CharacterHandler.upsertCharacterList(client.characters, client.character);
        }

        const storyRepair = MissionHandler.repairEarlyStoryOnLogin(client.character, entry.targetLevel);
        if (storyRepair.didMutate && client.userId) {
            client.characters = CharacterHandler.upsertCharacterList(client.characters, client.character);
            void db.saveCharacters(client.userId, client.characters);
        }

        CharacterHandler.purgeSameCharacterGhosts(client, entry.userId, entry.character.name);
        
        GlobalState.sessionsByToken.set(token, client);
        if (client.userId) {
            GlobalState.sessionsByUserId.set(client.userId, client);
            // Ensure persistence mapping exists
            GlobalState.tokenChar.set(token, { character: entry.character, userId: client.userId });
        }
        GlobalState.pendingWorld.delete(token);
        GlobalState.pendingExtended.delete(token);
        
        console.log(`[GameLogin] Client logged in with token ${token} as ${client.character.name}`);

        const spawn = {
            x: entry.newX ?? 0,
            y: entry.newY ?? 0,
            hasCoord: entry.newHasCoord ?? false
        };

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
        
        client.sendBitBuffer(0x10, pdPkt);
        console.log(`[GameLogin] Sent 0x10 (Player Data)`);

        if (storyRepair.addedMissionId > 0) {
            MissionHandler.sendMissionAdded(client, storyRepair.addedMissionId);
        }
        
        // Spawn NPCs
        LevelHandler.spawnLevelNpcs(client, entry.targetLevel);
        LevelHandler.primeTutorialRoomEvents(client);
        await LevelHandler.prepareCraftTownTutorialEntry(client);
        LevelHandler.scheduleClientSpawnFallback(client);
    }
}
