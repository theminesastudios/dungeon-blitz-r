
import { GlobalState } from './GlobalState';
import { GameData } from './GameData';
import { EntityHandler } from '../handlers/EntityHandler';
import { CombatHandler } from '../handlers/CombatHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { NpcDef } from '../data/NpcLoader';
import { Client } from './Client';


export class AILogic {
    static readonly INTERVAL = 125; // ms (0.125s)
    static readonly TIMESTEP = 1 / 60.0;
    static readonly MELEE_AGGRO_RADIUS = 320;
    static readonly RANGED_AGGRO_RADIUS = 520;
    static readonly LEASH_RADIUS = 1800;
    static readonly STOP_DISTANCE = 50;
    static readonly ATTACK_RANGE = 95;
    static readonly RANGED_ATTACK_RANGE = 300;
    static readonly ATTACK_COOLDOWN = 1000; // ms
    static readonly BASE_NPC_DAMAGE = 15;

    // Run AI loop for all levels
    static start() {
        setInterval(() => {
            // Iterate over all active levels (keys of levelEntities)
            for (const levelName of GlobalState.levelEntities.keys()) {
                AILogic.updateLevel(levelName);
            }
        }, AILogic.INTERVAL);
    }

    static updateLevel(levelName: string) {
        const levelEntities = GlobalState.levelEntities.get(levelName);
        if (!levelEntities) return;

        const players: Client[] = [];
        for (const session of GlobalState.sessionsByToken.values()) {
            if (session.playerSpawned && session.currentLevel === levelName && session.character) {
                players.push(session);
            }
        }

        if (players.length === 0) return;

        // Iterate over Map entries to get ID and Object
        for (const [entId, npc] of levelEntities.entries()) {
            if (npc.isPlayer || npc.team !== 2) continue; // Only Enemy NPCs
            if (npc.clientSpawned) continue; // Client-owned monsters should not receive server AI movement.
            // Simple dead check (if no hp prop, assume 100)
            if ((npc.hp !== undefined && npc.hp <= 0)) continue;

            AILogic.updateNpc(npc, players, levelName);
        }
    }

    static updateNpc(npc: any, players: Client[], levelName: string) {
        let target: Client | null = null;
        let minDist = Number.MAX_VALUE;
        const npcX = npc.x || 0;
        const npcY = npc.y || 0;

        for (const p of players) {
             if (!p.character || !p.character.CurrentLevel) continue;
             const px = p.character.CurrentLevel.x;
             const py = p.character.CurrentLevel.y;
             
             // Check if player is dead?
             // For now assume alive.

             const dist = Math.hypot(px - npcX, py - npcY);
             if (dist < minDist) {
                 minDist = dist;
                 target = p;
             }
        }

        if (!target || !target.character || !target.character.CurrentLevel) return;

        const entType = GameData.getEntType(npc.name);
        const isRanged = entType?.RangedPower ? true : false;
        const attackRange = isRanged ? AILogic.RANGED_ATTACK_RANGE : AILogic.ATTACK_RANGE;
        const aggroRadius = isRanged ? AILogic.RANGED_AGGRO_RADIUS : AILogic.MELEE_AGGRO_RADIUS;

        if (minDist <= aggroRadius) {
            const targetX = target.character.CurrentLevel.x;
            const targetY = target.character.CurrentLevel.y;

            // Attack Logic
            if (minDist <= attackRange) {
                const now = Date.now();
                if (!npc.nextAttack || now >= npc.nextAttack) {
                    npc.nextAttack = now + AILogic.ATTACK_COOLDOWN;
                    
                    const damage = AILogic.BASE_NPC_DAMAGE; // Flattened for now
                    const powerId = 1693; // DefaultMobMelee
                    
                    // 1. Broadcast Power Cast (0x09)
                    const bbCast = new BitBuffer();
                    bbCast.writeMethod4(npc.id);
                    bbCast.writeMethod4(powerId); // PowerID
                    bbCast.writeMethod15(true);  // hasTargetEntity
                    bbCast.writeMethod15(false); // hasTargetPos
                    // ... other flags 0
                    bbCast.writeMethod15(false); // hasProjectile
                    bbCast.writeMethod15(false); // isCharged
                    bbCast.writeMethod15(false); // hasExtra
                    bbCast.writeMethod15(false); // hasFlags

                    AILogic.broadcastToLevel(levelName, 0x09, bbCast.toBuffer());

                    // 2. Broadcast Power Hit (0x0A)
                    const bbHit = new BitBuffer();
                    bbHit.writeMethod4(target.clientEntID); // Target
                    bbHit.writeMethod4(npc.id);             // Source
                    bbHit.writeMethod24(damage);            // Damage
                    bbHit.writeMethod4(powerId);            // PowerID
                    bbHit.writeMethod15(false); // Anim override
                    bbHit.writeMethod15(false); // Effect override
                    bbHit.writeMethod15(false); // Crit

                    AILogic.broadcastToLevel(levelName, 0x0A, bbHit.toBuffer());
                }
            } else {
                // Chase Logic
                const dx = targetX - npcX;
                const dy = targetY - npcY;
                const dist = Math.hypot(dx, dy);
                
                if (dist > 0) {
                    const speed = 5.0; // Arbitrary speed per tick (approx 40 px/sec if 8 ticks/sec)
                    const moveX = (dx / dist) * speed;
                    const moveY = (dy / dist) * speed;

                    // Update NPC Position
                    npc.x += moveX;
                    npc.y += moveY;
                    npc.facingLeft = dx < 0;

                    // Broadcast Movement (0x07)
                    // Delta compression usually implies sending *changes* since last ack, 
                    // but here we just send absolute delta maybe?
                    // Python sends delta.
                    // Packet 0x07 expects deltaX, deltaY.
                    
                    const bbMove = new BitBuffer();
                    bbMove.writeMethod4(npc.id);
                    bbMove.writeMethod45(Math.round(moveX));
                    bbMove.writeMethod45(Math.round(moveY));
                    bbMove.writeMethod45(0); // DeltaV
                    bbMove.writeMethod6(0, 2); // State
                    
                    bbMove.writeMethod15(npc.facingLeft); // bLeft
                    bbMove.writeMethod15(true);  // bRunning
                    bbMove.writeMethod15(false); // bJumping
                    bbMove.writeMethod15(false); // bDropping
                    bbMove.writeMethod15(false); // bBackpedal
                    bbMove.writeMethod15(false); // isAirborne

                    AILogic.broadcastToLevel(levelName, 0x07, bbMove.toBuffer());
                }
            }
        }
    }

    private static broadcastToLevel(levelName: string, packetId: number, data: Buffer) {
        for (const session of GlobalState.sessionsByToken.values()) {
            if (session.playerSpawned && session.currentLevel === levelName) {
                session.send(packetId, data);
            }
        }
    }
}
