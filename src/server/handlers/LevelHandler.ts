import { Client } from '../core/Client';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { LevelConfig } from '../core/LevelConfig';
import { GlobalState } from '../core/GlobalState';
import { WorldEnter } from '../utils/WorldEnter';
import { Config } from '../core/config';
import { NpcLoader, NpcDef } from '../data/NpcLoader';
import { EntityHandler } from './EntityHandler';
import { JsonAdapter } from '../database/JsonAdapter';

const db = new JsonAdapter();

export class LevelHandler {
    static handleRequestDoorState(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const doorId = br.readMethod9();
        
        // Lookup door target in LevelConfig
        const currentLevel = client.currentLevel || "NewbieRoad";
        const target = LevelConfig.getDoorTarget(currentLevel, doorId);
        
        const bb = new BitBuffer();
        bb.writeMethod4(doorId);
        
        if (target) {
            // If target exists, door is open/usable (State 1 = Static/Open)
            bb.writeMethod91(1); // DOORSTATE_STATIC
            bb.writeMethod13(target);
        } else {
            // Locked or unknown (State 0 = Locked)
            bb.writeMethod91(0); // DOORSTATE_LOCKED
            bb.writeMethod13("");
        }

        client.sendBitBuffer(0x42, bb);
    }

    static spawnLevelNpcs(client: Client, levelName: string): void {
        EntityHandler.sendInitialLevelEntities(client, levelName);
    }

    // 0x2D: Open Door
    static handleOpenDoor(client: Client, data: Buffer): void {
        const br = new BitReader(data);
        const doorId = br.readMethod9();

        const currentLevel = client.currentLevel || "NewbieRoad";
        let targetLevel = LevelConfig.getDoorTarget(currentLevel, doorId);

        // Fallback for dungeons: use entry level? 
        // For now, simpler logic.
        
        if (!targetLevel && doorId === 999) {
            targetLevel = "CraftTown";
        }

        console.log(`[Level] Open Door ${doorId} in ${currentLevel} -> ${targetLevel}`);

        // Send 0x2E Door Target
        if (targetLevel) {
            const bb = new BitBuffer();
            bb.writeMethod4(doorId);
            bb.writeMethod13(targetLevel);
            client.sendBitBuffer(0x2E, bb);
        }
    }

    // 0x1D: Level Transfer Request
    static async handleLevelTransferRequest(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const token = br.readMethod9();
        const requestedLevel = br.readMethod13();

        console.log(`[Level] Transfer Request (0x1D): Token=${token}, Level=${requestedLevel}`);

        // Safety: ensure client is authenticated or token matches
        if (!client.character) {
             // Attempt to recover session from token
             const entry = GlobalState.tokenChar.get(token);
             if (entry) {
                 client.character = entry.character;
                 client.userId = entry.userId;
                 console.log(`[Level] Recovered session for user ${client.userId} (Char: ${client.character.name}) using token ${token}`);
             } else {
                 console.error(`[Level] No character on session during transfer request. Token=${token} not found in tokenChar.`);
                 console.log(`[Level] Available tokens: ${Array.from(GlobalState.tokenChar.keys()).join(", ")}`);
                 return;
             }
        }

        // 1. Determine Target Level
        let targetLevel = requestedLevel;
        if (!targetLevel || targetLevel === "None") {
            targetLevel = "NewbieRoad"; 
        }

        // 2. Get Old Position
        const oldLevel = client.currentLevel || "NewbieRoad";
        const ent = client.entities.get(client.clientEntID);
        let oldX = 0, oldY = 0;

        if (ent) {
            oldX = ent.x;
            oldY = ent.y;
        }

        // 3. Calculate New Spawn
        // Default spawn from config
        const spawn = LevelConfig.getSpawn(targetLevel);
        const newX = spawn.x;
        const newY = spawn.y;

        // 4. Update Character State (PreviousLevel / CurrentLevel) logic
        // Only if coming from a non-dungeon (safe) level
        if (oldLevel && !LevelConfig.get(oldLevel).isDungeon) {
            if (targetLevel === "CraftTown") {
                // Determine if we should save the previous level
                // If we are NOT coming from CraftTown, save it.
                if (oldLevel !== "CraftTown") {
                    client.character.PreviousLevel = { name: oldLevel, x: oldX, y: oldY };
                }
                // If we ARE coming from CraftTown (CraftTown -> CraftTown?), we keep the existing PreviousLevel.
            } else if (targetLevel !== "CraftTown") {
                 // Normal travel: Old level becomes PreviousLevel (if safe)
                 if (oldLevel !== "CraftTown") {
                     client.character.PreviousLevel = { name: oldLevel, x: oldX, y: oldY };
                 }
                 // If we leave CraftTown to a normal zone, we might want to keep CraftTown as previous? 
                 // Python says: "Prefer CurrentLevel if it’s a safe non-CraftTown... elif prev_name..."
                 // Basically, if we are in CraftTown, and go to Field, PreviousLevel in DB is probably where we came from BEFORE CraftTown.
                 // But here we set PreviousLevel to valid safe zones. 
                 
                 // Let's stick to the user request: "CraftTown should have returned the player to NewbieRoad at the first, then last coordinate"
                 // This implies that when entering CraftTown, we saved NewbieRoad.
                 // When leaving CraftTown (via "Return"?), we read PreviousLevel.
                 
                 // If this 0x1D is "Leaving CraftTown", we are just going to `targetLevel`.
                 // If `targetLevel` is NewbieRoad, we just go there.
            }
        }
        
        // Update CurrentLevel to new location
        client.character.CurrentLevel = { name: targetLevel, x: newX, y: newY };

        // 5. Generate New Token
        const newToken = Math.floor(Math.random() * 0xFFFF);
        
        // 6. Check House Visit Override
        let hostChar = client.character;
        // Use token from packet (0x1D) to lookup house visit
        if (GlobalState.houseVisits.has(token)) {
            hostChar = GlobalState.houseVisits.get(token)!;
            GlobalState.houseVisits.delete(token); // Consume
            console.log(`[Level] House Visit active! Host: ${hostChar.name}`);
        }

        // 7. Store Pending Transfer State
        if (client.userId) {
            GlobalState.pendingWorld.set(newToken, {
                character: client.character,
                userId: client.userId,
                targetLevel: targetLevel,
                previousLevel: client.character.PreviousLevel?.name || "NewbieRoad"
            });
        }
        
        // 8. Send Enter World (0x21)
        const levelSpec = LevelConfig.get(targetLevel);
        const isHard = targetLevel.endsWith("Hard");
        const newHasCoord = true;
        
        const pkt = WorldEnter.buildEnterWorldPacket(
            newToken,
            0, "", false, 0, 0, // Old world info (dummy for now)
            Config.HOST,
            Config.PORTS[0],
            levelSpec.swf,
            levelSpec.mapId,
            levelSpec.baseId,
            targetLevel,
            isHard ? "Hard" : "",
            isHard ? "Hard" : "",
            levelSpec.isDungeon,
            newHasCoord, newX, newY,
            hostChar
        );

        client.sendBitBuffer(0x21, pkt);
        
        // Spawn Entities for new level?
        // Moved to EntityHandler.handleEntityFullUpdate (triggered by client 0x8)
        
        // However, we must spawn the user's pet again for the new level
        const { PetHandler } = require('./PetHandler');
        PetHandler.spawnPet(client);
    }

    // 0x07: Incremental Update (Movement)
    static handleEntityIncrementalUpdate(client: Client, data: Buffer): void {
        // data passed from Client is already the payload (header stripped)
        const br = new BitReader(data);
        const entityId = br.readMethod4();
        const isSelf = (entityId === client.clientEntID);

        // If it's us and we haven't spawned, ignore
        // In TS we don't track 'player_spawned' explicitly like python yet, but usually we can ignore.
        
        const deltaX = br.readMethod45();
        const deltaY = br.readMethod45();
        const deltaVX = br.readMethod45();

        const STATE_BITS = 2; // Entity.const_316
        const entState = br.readMethod6(STATE_BITS);

        const flags = {
            bLeft: br.readMethod15(),
            bRunning: br.readMethod15(),
            bJumping: br.readMethod15(),
            bDropping: br.readMethod15(),
            bBackpedal: br.readMethod15()
        };

        const isAirborne = br.readMethod15();
        const velocityY = isAirborne ? br.readMethod24() : 0;

        // Update Entity
        if (!client.entities) return;
        const ent = client.entities.get(entityId);
        if (!ent) return;

        ent.x += deltaX;
        ent.y += deltaY;
        // ent.velocityX += deltaVX; // We don't track velocity in simple Entity struct yet?
        // ent.state = entState;
        
        // Update Saved Coords if it's us and safe level
        if (isSelf && client.character) {
             const currentLevel = client.currentLevel || "NewbieRoad";
             // Check if safe level
             const isDungeon = LevelConfig.get(currentLevel).isDungeon;
             
             if (currentLevel === "CraftTown" || !isDungeon) {
                 if (!client.character.CurrentLevel) {
                     client.character.CurrentLevel = { name: currentLevel, x: ent.x, y: ent.y };
                 } else {
                     client.character.CurrentLevel.name = currentLevel; // Ensure name matches
                     client.character.CurrentLevel.x = ent.x;
                     client.character.CurrentLevel.y = ent.y;
                 }
                 // Also ensure PreviousLevel is NOT overwritten here, traversing logic is in 0x1D
             }
            }
    }

}
