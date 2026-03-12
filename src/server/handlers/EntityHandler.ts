import { NpcLoader, NpcDef } from '../data/NpcLoader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { Client } from '../core/Client';
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

    private static normalizeIdentityName(value: unknown): string {
        return String(value ?? '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '');
    }

    private static usesClientSpawn(levelName: string): boolean {
        return EntityHandler.CLIENT_SPAWN_LEVELS.has(levelName);
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
        const entName = br.readMethod26();

        const team = br.readMethod20(Entity.TEAM_BITS);
        const isPlayer = br.readMethod15(); // bool
        const yOffset = br.readMethod706();

        // Optional Cue Data
        const hasCue = br.readMethod15();
        const cueData: any = {};
        if (hasCue) {
            if (br.readMethod15()) {
                cueData["character_name"] = br.readMethod13();
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
             PetHandler.sendMountEquipPacket(
                client,
                client.clientEntID,
                Number(client.character?.equippedMount ?? props.equippedMount ?? 0)
            );
             EntityHandler.sendExistingPlayersToJoiner(client);
             EntityHandler.broadcastPlayerSpawn(client, props);
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
            EntityHandler.sendEntity(client, entityProps);
        }
    }

    static removeOwnedEntities(client: Client): void {
        const levelName = client.currentLevel;
        if (!levelName) {
            return;
        }

        const levelMap = GlobalState.levelEntities.get(levelName);
        if (!levelMap) {
            return;
        }

        const charNameNorm = EntityHandler.normalizeIdentityName(client.character?.name);
        for (const [entityId, entityProps] of Array.from(levelMap.entries())) {
            const entityNameNorm = EntityHandler.normalizeIdentityName(entityProps?.name);
            const isOwnedPlayer = Boolean(entityProps?.isPlayer) && (
                (client.clientEntID > 0 && entityId === client.clientEntID) ||
                (charNameNorm && entityNameNorm === charNameNorm)
            );
            const isOwnedClientSpawn = Boolean(entityProps?.clientSpawned) && Number(entityProps?.ownerToken ?? 0) === client.token;

            if (isOwnedPlayer || isOwnedClientSpawn) {
                levelMap.delete(entityId);
            }
        }

        if (levelMap.size === 0) {
            GlobalState.levelEntities.delete(levelName);
        }
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
