import { Client } from '../core/Client';
import { BitReader } from '../network/protocol/bitReader';
import { GlobalState } from '../core/GlobalState';
import { BitBuffer } from '../network/protocol/bitBuffer';


export class CombatHandler {

    
    // 0x9: Power Cast
    static async handlePowerCast(client: Client, data: Buffer): Promise<void> {
        // ... (Existing logic, maybe stripped to just broadcast if we want to be safe, but existing parsing is fine)
        // For efficiency, since we just broadcast, we can parse minimally or just broadcast the raw data if we trust it.
        // But the existing code parses it. We'll keep it as is or optimize? 
        // Existing code reads but doesn't use much.
        // Let's keep parsing for validation/debug.
        
        // Broadcast
        CombatHandler.broadcastToLevel(client, 0x9, data);
    }
    
    // 0x0A: Power Hit
    static async handlePowerHit(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const targetId = br.readMethod9();
        const sourceId = br.readMethod9();
        const damage = br.readMethod24();
        const powerId = br.readMethod9();
        
        // ... Parsing rest if needed for server logic ...
        // Anim override
        if (br.readMethod15()) br.readMethod9();
        // Effect override
        if (br.readMethod15()) br.readMethod9();
        // Crit
        const isCrit = br.readMethod15();
        
        // TODO: Server-side HP verification and Loot logic
        // For now, we broadcast to let clients show numbers/death.
        
        // Note: Python handles "Client-side entity" vs "Server entity".
        // If unknown entity, it just broadcasts.
        
        CombatHandler.broadcastToLevel(client, 0x0A, data);
        
        // HP Update Handling (0x3A) is vital for "authoritative" feel, 
        // but if we just echo 0x0A, clients often handle their own HP for non-authoritative entities?
        // Python sends 0x3A for Players.
    }

    // 0x0E: Projectile Explode
    static async handleProjectileExplode(client: Client, data: Buffer): Promise<void> {
        // Just broadcast
        CombatHandler.broadcastToLevel(client, 0x0E, data);
    }
    
    // 0x0D: Entity Destroy
    static async handleEntityDestroy(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const entityId = br.readMethod9();
        
        // Remove from server session map if present
        if (client.entities.has(entityId)) {
            client.entities.delete(entityId);
        }
        
        // Broadcast
        CombatHandler.broadcastToLevel(client, 0x0D, data);
    }
    
    // 0x77: Request Respawn
    static async handleRequestRespawn(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const usePotion = br.readMethod15();
        
        // Logic to consume potion?
        // For now, just send RespawnComplete (0x80)
        
        const healAmount = 100; // Placeholder or calculate from level
        
        const bb = new BitBuffer();
        bb.writeMethod24(healAmount);
        bb.writeMethod15(usePotion);
        
        client.sendBitBuffer(0x80, bb);
    }
    
    // 0x82: Respawn Broadcast (Revive)
    static async handleRespawnBroadcast(client: Client, data: Buffer): Promise<void> {
        const br = new BitReader(data);
        const entId = br.readMethod9();
        // Broadcast
        CombatHandler.broadcastToLevel(client, 0x82, data);
    }
    
    // 0x79: Buff Tick / DOT
    static async handleBuffTickDot(client: Client, data: Buffer): Promise<void> {
        CombatHandler.broadcastToLevel(client, 0x79, data);
    }

    // 0x0B: Add Buff
    static async handleAddBuff(client: Client, data: Buffer): Promise<void> {
        CombatHandler.broadcastToLevel(client, 0x0B, data);
    }

    // 0x0C: Remove Buff
    static async handleRemoveBuff(client: Client, data: Buffer): Promise<void> {
        CombatHandler.broadcastToLevel(client, 0x0C, data);
    }

    private static broadcastToLevel(sender: Client, packetId: number, data: Buffer): void {
        const myLevel = sender.currentLevel;
        if (!myLevel || !sender.playerSpawned) return;

        for (const other of GlobalState.sessionsByToken.values()) {
            if (other !== sender && other.playerSpawned && other.currentLevel === myLevel) {
                 other.send(packetId, data);
            }
        }
    }
}

