import { NpcLoader, NpcDef } from '../data/NpcLoader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { Client, clearClientSpawnFallbackTimer, createKeepTutorialState } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { GlobalState } from '../core/GlobalState';
import { Entity, EntityProps, EntityState } from '../core/Entity';
import { PetHandler } from './PetHandler';

export class EntityHandler {
    private static readonly CLIENT_SPAWN_LEVELS = new Set<string>([
        'CraftTownTutorial',
        'NewbieRoad',
        'NewbieRoadHard'
    ]);
    private static readonly MOUNT_SYNC_RETRY_DELAYS_MS = [0, 300, 1200, 2500, 4000];

    private static normalizeIdentityName(value: unknown): string {
        return String(value ?? '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '');
    }

    private static usesClientSpawn(levelName: string): boolean {
        return EntityHandler.CLIENT_SPAWN_LEVELS.has(levelName);
    }

    static isClientSpawnLevel(levelName: string): boolean {
        return EntityHandler.usesClientSpawn(levelName);
    }

    private static getCraftTownTutorialState(client: Client) {
        if (client.currentLevel !== 'CraftTownTutorial') {
            return null;
        }

        if (!client.keepTutorialState) {
            client.keepTutorialState = createKeepTutorialState();
        }

        return client.keepTutorialState;
    }

    private static sendStartSkit(client: Client, entityId: number, dialogueId: number, missionId: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod6(dialogueId, 3);
        bb.writeMethod4(missionId);
        client.sendBitBuffer(0x7B, bb);
    }

    private static sendRoomBossInfo(levelName: string, roomId: number, bossId: number, bossName: string): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(Math.max(0, roomId));
        bb.writeMethod4(bossId);
        bb.writeMethod26(bossName);
        bb.writeMethod4(0);
        bb.writeMethod26('');
        const payload = bb.toBuffer();

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || other.currentLevel !== levelName) {
                continue;
            }
            other.send(0xAC, payload);
        }
    }

    private static sendRoomSound(levelName: string, roomId: number, soundName: string, volume: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(Math.max(0, roomId));
        bb.writeMethod13(soundName);
        bb.writeMethod4(Math.max(0, Math.min(100, Math.round(volume * 100))));
        const payload = bb.toBuffer();

        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || other.currentLevel !== levelName) {
                continue;
            }
            other.send(0xA8, payload);
        }
    }

    private static sendNpcState(client: Client, entityId: number, entState: number, facingLeft: boolean): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod45(0);
        bb.writeMethod45(0);
        bb.writeMethod45(0);
        bb.writeMethod6(entState, 2);
        bb.writeMethod15(facingLeft);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        bb.writeMethod15(false);
        client.sendBitBuffer(0x07, bb);
    }

    private static sendSetUntargetable(client: Client, entityId: number, untargetable: boolean): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod15(untargetable);
        client.sendBitBuffer(0xAE, bb);
    }

    private static sendDestroyEntity(client: Client, entityId: number): void {
        client.send(0x0D, EntityHandler.buildDestroyEntityPayload(entityId));
    }

    private static buildDestroyEntityPayload(entityId: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(entityId);
        bb.writeMethod15(false);
        return bb.toBuffer();
    }

    static broadcastDestroyEntity(levelName: string, entityId: number, excludedClient: Client | null = null): void {
        if (!levelName || entityId <= 0) {
            return;
        }

        const payload = EntityHandler.buildDestroyEntityPayload(entityId);
        for (const other of GlobalState.sessionsByToken.values()) {
            if (other === excludedClient || !other.playerSpawned || other.currentLevel !== levelName) {
                continue;
            }

            other.send(0x0D, payload);
        }
    }

    private static getEquippedMountId(value: unknown): number {
        const mountId = Number(value ?? 0);
        return Number.isFinite(mountId) && mountId > 0 ? mountId : 0;
    }

    private static sendMountState(client: Client, entityId: number, mountId: number): void {
        if (entityId <= 0 || mountId <= 0) {
            return;
        }

        PetHandler.sendMountEquipPacket(client, entityId, mountId);
    }

    private static scheduleSelfMountSync(client: Client, entityId: number, mountId: number): void {
        if (entityId <= 0 || mountId <= 0) {
            return;
        }

        const levelName = client.currentLevel;
        const token = client.token;
        for (const delayMs of EntityHandler.MOUNT_SYNC_RETRY_DELAYS_MS) {
            setTimeout(() => {
                if (
                    !client.playerSpawned ||
                    client.currentLevel !== levelName ||
                    client.token !== token ||
                    client.clientEntID !== entityId
                ) {
                    return;
                }

                EntityHandler.sendMountState(client, entityId, mountId);
            }, delayMs);
        }
    }

    private static sendOtherPlayerMountToJoiner(joiner: Client, other: Client): void {
        if (!other.character || other.clientEntID <= 0) {
            return;
        }

        const mountId = EntityHandler.getEquippedMountId(other.character.equippedMount);
        EntityHandler.sendMountState(joiner, other.clientEntID, mountId);
    }

    private static broadcastPlayerMountState(client: Client, entityId: number, mountId: number): void {
        if (!client.currentLevel || mountId <= 0) {
            return;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (other === client || !other.playerSpawned || other.currentLevel !== client.currentLevel) {
                continue;
            }

            EntityHandler.sendMountState(other, entityId, mountId);
        }
    }

    private static suppressCraftTownTutorialBoss(client: Client, entityId: number): void {
        client.entities.delete(entityId);
        GlobalState.levelEntities.get(client.currentLevel)?.delete(entityId);
        EntityHandler.sendDestroyEntity(client, entityId);
    }

    private static handleCraftTownTutorialEntitySeen(client: Client, entityId: number, entityName: string): void {
        const state = EntityHandler.getCraftTownTutorialState(client);
        if (!state) {
            return;
        }

        if (entityName === 'IntroParrot' && !state.introSkitSent) {
            EntityHandler.sendStartSkit(client, entityId, 0, 5);
            state.introSkitSent = true;
        }

        if (entityName !== 'GoblinShamanHood' && entityName !== 'IntroGoblinShamanHood') {
            return;
        }

        if (
            state.bossEntitySource === 'fallback' &&
            state.bossEntitySeen !== null &&
            state.bossEntitySeen !== entityId
        ) {
            EntityHandler.suppressCraftTownTutorialBoss(client, entityId);
            return;
        }

        if (entityName === 'GoblinShamanHood' && !state.bossIntroForced) {
            // The plain boss art should not be visible before the keep intro begins.
            EntityHandler.suppressCraftTownTutorialBoss(client, entityId);
            return;
        }

        state.bossEntitySeen = entityId;
        state.bossEntitySource = 'client';

        if (!state.bossInfoSentIds.has(entityId)) {
            EntityHandler.sendRoomBossInfo(
                client.currentLevel,
                client.currentRoomId,
                entityId,
                'Ranik, The Geomancer'
            );
            state.bossInfoSentIds.add(entityId);
        }

        if (!state.bossMusicStarted) {
            EntityHandler.sendRoomSound(
                client.currentLevel,
                client.currentRoomId,
                'D02_MoodLoop_GoblinHideout',
                0.9
            );
            state.bossMusicStarted = true;
        }
    }
    
    // Server -> Client: Spawn Entity (Packet 0xF)
    static sendEntity(client: Client, entity: EntityProps | any): void {
        let props: EntityProps;
        
        if (entity.id && entity.entState !== undefined) {
             props = entity as EntityProps;
        } else {
             // Fallback for NpcDef or other objects
             props = Entity.fromNpc(entity);
        }
        
        const data = Entity.serialize(props);
        client.send(0xF, data);
    }

    // Deprecated: use sendEntity
    static sendNpc(client: Client, npc: NpcDef): void {
        this.sendEntity(client, npc);
    }

    // 0x8
    static handleEntityFullUpdate(client: Client, data: Buffer): void {
        const br = new BitReader(data);

        const entityId = br.readMethod9();
        const posX = br.readMethod24();
        const posY = br.readMethod24();
        const velocityX = br.readMethod24();
        let entName = br.readMethod26();

        const team = br.readMethod20(Entity.TEAM_BITS);
        const isPlayer = br.readMethod15(); // bool
        const yOffset = br.readMethod706();

        // Optional Cue Data
        const hasCue = br.readMethod15();
        const cueData: any = {};
        if (hasCue) {
            if (br.readMethod15()) {
                cueData["character_name"] = br.readMethod13();
                // Comma-prefixed character_name overrides entity type for server identification
                const cname = String(cueData["character_name"] ?? '');
                if (cname.startsWith(',')) {
                    const overrideName = cname.substring(1);
                    if (overrideName) {
                        entName = overrideName;
                    }
                }
            }
            if (br.readMethod15()) {
                cueData["DramaAnim"] = br.readMethod13();
            }
            if (br.readMethod15()) {
                cueData["SleepAnim"] = br.readMethod13();
            }
        }

        const hasSummoner = br.readMethod15();
        let summonerId = 0;
        if (hasSummoner) {
            summonerId = br.readMethod9();
        }

        const hasPower = br.readMethod15();
        let powerId = 0;
        if (hasPower) {
            powerId = br.readMethod9();
        }

        const entState = br.readMethod20(Entity.STATE_BITS);

        const bLeft = br.readMethod15();
        const bRunning = br.readMethod15();
        const bJumping = br.readMethod15();
        const bDropping = br.readMethod15();
        const bBackpedal = br.readMethod15();

        const entNameNorm = EntityHandler.normalizeIdentityName(entName);
        const charNameNorm = EntityHandler.normalizeIdentityName(client.character?.name);
        const isSelfPacket = Boolean(isPlayer && entNameNorm && charNameNorm && entNameNorm === charNameNorm);

        if (isPlayer && (client.clientEntID === 0 || (isSelfPacket && client.clientEntID !== entityId))) {
            client.clientEntID = entityId;
        }

        const ownsThisPlayerPacket = Boolean(
            isPlayer &&
            client.character &&
            (isSelfPacket || (client.clientEntID > 0 && client.clientEntID === entityId))
        );

        const props: EntityProps & { clientSpawned?: boolean; ownerToken?: number; ownerUserId?: number } = ownsThisPlayerPacket
            ? {
                ...Entity.fromCharacter(entityId, client.character!, {
                    x: posX,
                    y: posY,
                    v: velocityX,
                    team,
                    entState,
                    facingLeft: bLeft,
                    renderDepthOffset: yOffset
                }),
                characterName: cueData.character_name,
                dramaAnim: cueData.DramaAnim,
                sleepAnim: cueData.SleepAnim,
                summonerId,
                powerId,
                clientSpawned: false,
                ownerToken: client.token || 0,
                ownerUserId: client.userId || 0
            }
            : {
                id: entityId,
                name: entName,
                isPlayer: isPlayer,
                x: posX,
                y: posY,
                v: velocityX,
                team: team,
                renderDepthOffset: yOffset,
                characterName: cueData.character_name,
                dramaAnim: cueData.DramaAnim,
                sleepAnim: cueData.SleepAnim,
                summonerId: summonerId,
                powerId: powerId,
                entState: entState,
                facingLeft: bLeft,
                clientSpawned: !isPlayer,
                ownerToken: client.token || 0,
                ownerUserId: client.userId || 0
                // bRunning etc are flags
            };

        client.entities.set(entityId, props);

        if (!isPlayer) {
            client.clientSpawnConfirmed = true;
            clearClientSpawnFallbackTimer(client);
            if (client.currentLevel === 'CraftTownTutorial') {
                EntityHandler.handleCraftTownTutorialEntitySeen(client, entityId, String(props.name ?? ''));
            }
        }

        // Update GlobalState
        if (client.currentLevel) {
            let levelMap = GlobalState.levelEntities.get(client.currentLevel);
            if (!levelMap) {
                levelMap = new Map();
                GlobalState.levelEntities.set(client.currentLevel, levelMap);
            }
            levelMap.set(entityId, props);
        }

        // Broadcast to others in level
        EntityHandler.broadcastToLevel(client, data);

        if (isPlayer && !client.playerSpawned) {
             client.playerSpawned = true;
             client.mountTransferGraceUntil = Math.max(client.mountTransferGraceUntil, Date.now() + 4000);
             const equippedMountId = EntityHandler.getEquippedMountId(
                client.character?.equippedMount ?? props.equippedMount ?? 0
            );
             EntityHandler.scheduleSelfMountSync(client, client.clientEntID, equippedMountId);
             EntityHandler.sendExistingPlayersToJoiner(client);
             EntityHandler.broadcastPlayerSpawn(client, props);
             EntityHandler.broadcastPlayerMountState(client, props.id, equippedMountId);
        }
    }

    static sendInitialLevelEntities(client: Client, levelName: string): void {
        console.log(`[EntityHandler] Sending initial entities for ${levelName} to ${client.character?.name}`);
        
        let levelMap = GlobalState.levelEntities.get(levelName);
        if (!levelMap) {
            levelMap = new Map();
            GlobalState.levelEntities.set(levelName, levelMap);

            if (EntityHandler.usesClientSpawn(levelName)) {
                console.log(`[EntityHandler] Skipping server NPC init for client-spawn level ${levelName}`);
            } else {
                const npcs = NpcLoader.getNpcsForLevel(levelName);
                console.log(`[EntityHandler] Initializing ${npcs.length} NPCs for ${levelName}`);

                for (const npc of npcs) {
                    const entityProps = Entity.fromNpc(npc);
                    levelMap.set(npc.id, entityProps);
                }
            }
        }

        if (EntityHandler.usesClientSpawn(levelName)) {
            return;
        }

        for (const [id, entityProps] of levelMap.entries()) {
            if (id === client.clientEntID) continue;
            if (entityProps?.isPlayer) continue;
            if (entityProps?.clientSpawned) continue;
            client.entities.set(id, { ...entityProps });
            EntityHandler.sendEntity(client, entityProps);
        }
    }

    static removeOwnedEntities(client: Client, broadcastDestroy: boolean = false): number[] {
        const levelName = client.currentLevel;
        if (!levelName) {
            return [];
        }

        const levelMap = GlobalState.levelEntities.get(levelName);
        if (!levelMap) {
            return [];
        }

        const charNameNorm = EntityHandler.normalizeIdentityName(client.character?.name);
        const removedEntityIds: number[] = [];
        for (const [entityId, entityProps] of Array.from(levelMap.entries())) {
            const entityNameNorm = EntityHandler.normalizeIdentityName(entityProps?.name);
            const isOwnedPlayer = Boolean(entityProps?.isPlayer) && (
                (client.clientEntID > 0 && entityId === client.clientEntID) ||
                (charNameNorm && entityNameNorm === charNameNorm)
            );
            const isOwnedClientSpawn = Boolean(entityProps?.clientSpawned) && Number(entityProps?.ownerToken ?? 0) === client.token;

            if (isOwnedPlayer || isOwnedClientSpawn) {
                levelMap.delete(entityId);
                removedEntityIds.push(entityId);
            }
        }

        if (broadcastDestroy) {
            for (const entityId of removedEntityIds) {
                EntityHandler.broadcastDestroyEntity(levelName, entityId, client);
            }
        }

        if (levelMap.size === 0) {
            GlobalState.levelEntities.delete(levelName);
        }

        return removedEntityIds;
    }

    private static sendExistingPlayersToJoiner(joiner: Client): void {
        for (const other of GlobalState.sessionsByToken.values()) {
            if (other === joiner) {
                continue;
            }
            if (!other.playerSpawned || other.currentLevel !== joiner.currentLevel) {
                continue;
            }
            if (other.userId && joiner.userId && other.userId === joiner.userId && other.character?.name === joiner.character?.name) {
                continue;
            }
            if (!other.character || other.clientEntID <= 0) {
                continue;
            }

            const otherProps = other.entities.get(other.clientEntID);
            if (!otherProps) {
                continue;
            }

            EntityHandler.sendEntity(joiner, Entity.fromCharacter(other.clientEntID, other.character, otherProps));
            EntityHandler.sendOtherPlayerMountToJoiner(joiner, other);
        }
    }

    private static broadcastPlayerSpawn(client: Client, props: EntityProps): void {
        if (!client.character || !client.currentLevel) {
            return;
        }

        const playerEntity = Entity.fromCharacter(props.id, client.character, props);
        for (const other of GlobalState.sessionsByToken.values()) {
            if (other === client || !other.playerSpawned || other.currentLevel !== client.currentLevel) {
                continue;
            }
            EntityHandler.sendEntity(other, playerEntity);
        }
    }

    private static broadcastToLevel(sender: Client, data: Buffer): void {
        const myLevel = sender.currentLevel;
        if (!myLevel || !sender.playerSpawned) return;

        for (const other of GlobalState.sessionsByToken.values()) {
            if (other !== sender && other.playerSpawned && other.currentLevel === myLevel) {
                 other.send(0x8, data);
            }
        }
    }
}
