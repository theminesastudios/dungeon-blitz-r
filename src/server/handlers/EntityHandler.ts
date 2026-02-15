import { NpcLoader, NpcDef } from '../data/NpcLoader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { Client } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { GlobalState } from '../core/GlobalState';
import { Entity, EntityProps, EntityState } from '../core/Entity';

export class EntityHandler {
    
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

        if (isPlayer && client.clientEntID === 0) {
            client.clientEntID = entityId;
        }

        const props: EntityProps = {
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
            facingLeft: bLeft
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
             // Send existing entities (packet 0xF) to the new joiner
             EntityHandler.sendInitialLevelEntities(client, client.currentLevel || "NewbieRoad");
        }
    }

    static sendInitialLevelEntities(client: Client, levelName: string): void {
        console.log(`[EntityHandler] Sending initial entities for ${levelName} to ${client.character?.name}`);
        
        let levelMap = GlobalState.levelEntities.get(levelName);
        if (!levelMap) {
            levelMap = new Map();
            GlobalState.levelEntities.set(levelName, levelMap);
            
            const npcs = NpcLoader.getNpcsForLevel(levelName);
            console.log(`[EntityHandler] Initializing ${npcs.length} NPCs for ${levelName}`);
            
            for (const npc of npcs) {
                const entityProps: any = {
                    id: npc.id,
                    name: npc.name,
                    isPlayer: false,
                    x: npc.x,
                    y: npc.y,
                    v: 0,
                    team: 2, // Enemy
                    renderDepthOffset: 0,
                    entState: 0,
                    facingLeft: false,
                };
                levelMap.set(npc.id, entityProps);
            }
        }

        for (const [id, entityProps] of levelMap.entries()) {
            if (id === client.clientEntID) continue;
            EntityHandler.sendEntity(client, entityProps);
        }
    }

    private static broadcastToLevel(sender: Client, data: Buffer): void {
        const myLevel = sender.currentLevel;
        if (!myLevel || !sender.playerSpawned) return;
        
        // If this is the FIRST 0x8 from a player, we might want to send 0xF to OTHERS?
        // But broadcastToLevel sends 0x8. 
        // If other clients didn't receive 0xF for this player yet, 0x8 might be ignored or might cause spawn?
        // Let's rely on 0x8 for now (as per original code), 
        // OR we can explicitly send 0xF to others if this is new spawn?
        // For now, sticking to 0x8 broadcast.

        for (const other of GlobalState.sessionsByToken.values()) {
            if (other !== sender && other.playerSpawned && other.currentLevel === myLevel) {
                 other.send(0x8, data);
            }
        }
    }
}
