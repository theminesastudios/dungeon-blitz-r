
import { GlobalState } from './GlobalState';
import { GameData } from './GameData';
import { EntityHandler } from '../handlers/EntityHandler';
import { CombatHandler } from '../handlers/CombatHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { NpcDef } from '../data/NpcLoader';
import { Client } from './Client';
import { sharesRoomIds } from './PartySync';
import { getClientLevelScope, getScopeLevelName } from './LevelScope';
import { LevelConfig } from './LevelConfig';


export class AILogic {
    static readonly INTERVAL = 125; // ms (0.125s)
    static readonly TIMESTEP = 1 / 60.0;
    static readonly MELEE_AGGRO_RADIUS = 240;
    static readonly RANGED_AGGRO_RADIUS = 360;
    static readonly BOSS_MELEE_AGGRO_RADIUS = 180;
    static readonly BOSS_RANGED_AGGRO_RADIUS = 260;
    static readonly LEASH_RADIUS = 1800;
    static readonly STOP_DISTANCE = 50;
    static readonly ATTACK_RANGE = 95;
    static readonly RANGED_ATTACK_RANGE = 300;
    static readonly ATTACK_COOLDOWN = 1000; // ms
    static readonly BASE_NPC_DAMAGE = 15;
    static readonly ENABLE_SERVER_AUTHORITY_HOSTILE_AI = process.env.ENABLE_SERVER_AUTHORITY_HOSTILE_AI === '1';

    private static hasCombatPull(npc: any): boolean {
        return Math.max(0, Math.round(Number(npc?.lastCombatActivityAt ?? 0))) > 0 ||
            Math.max(0, Math.round(Number(npc?.aggroTargetEntityId ?? 0))) > 0;
    }

    private static clearAggroTarget(npc: any): void {
        if (!npc || typeof npc !== 'object') {
            return;
        }

        npc.aggroTargetEntityId = 0;
        npc.aggroTargetToken = 0;
        npc.nextAttack = 0;
    }

    private static clearDeadAggroTarget(npc: any, players: Client[], levelScope: string): void {
        const aggroTargetEntityId = Math.max(0, Math.round(Number(npc?.aggroTargetEntityId ?? 0)));
        if (aggroTargetEntityId <= 0) {
            return;
        }

        const target = players.find((player) => player.clientEntID === aggroTargetEntityId);
        if (target && CombatHandler.isPlayerDeadForCombat(target, levelScope)) {
            AILogic.clearAggroTarget(npc);
        }
    }

    // Run AI loop for all levels
    static start() {
        setInterval(() => {
            // Iterate over all active levels (keys of levelEntities)
            for (const levelScope of GlobalState.levelEntities.keys()) {
                AILogic.updateLevel(levelScope);
            }
        }, AILogic.INTERVAL);
    }

    static updateLevel(levelScope: string) {
        const levelEntities = GlobalState.levelEntities.get(levelScope);
        if (!levelEntities) return;
        const levelName = getScopeLevelName(levelScope);
        const nowMs = Date.now();

        const players: Client[] = [];
        const activeCutsceneRoomIds = new Set<number>();
        for (const session of GlobalState.sessionsByToken.values()) {
            if (session.playerSpawned && getClientLevelScope(session) === levelScope && session.character) {
                players.push(session);
                if (String(session.activeDungeonCutsceneScope ?? '').trim() === levelScope) {
                    const roomId = Number(session.activeDungeonCutsceneRoomId ?? -1);
                    if (Number.isFinite(roomId) && roomId >= 0) {
                        activeCutsceneRoomIds.add(Math.round(roomId));
                    }
                }
            }
        }

        if (players.length === 0) {
            if (CombatHandler.hasOutOfCombatRegenPresence(levelScope)) {
                CombatHandler.processOutOfCombatRegen(levelScope, nowMs);
            }
            CombatHandler.processBuffExpirations(levelScope, nowMs);
            return;
        }
        CombatHandler.processOutOfCombatRegen(levelScope, nowMs);
        CombatHandler.processBuffExpirations(levelScope, nowMs);

        // Iterate over Map entries to get ID and Object
        for (const [entId, npc] of levelEntities.entries()) {
            if (npc.isPlayer || npc.team !== 2) continue; // Only Enemy NPCs
            if (EntityHandler.usesServerAuthorityHostiles(levelName) && !AILogic.ENABLE_SERVER_AUTHORITY_HOSTILE_AI) continue; // JC_Mini1Hard uses client proxies for AI/animation.
            if (Boolean(npc.hybridCanonicalHostile) && !AILogic.ENABLE_SERVER_AUTHORITY_HOSTILE_AI) continue; // TODO: feature-flag server AI for promoted hybrid hostiles.
            if (npc.clientSpawned) continue; // Client-owned monsters should not receive server AI movement.
            // Simple dead check (if no hp prop, assume 100)
            if ((npc.hp !== undefined && npc.hp <= 0)) continue;
            const npcRoomId = Number.isFinite(Number(npc?.roomId)) ? Math.round(Number(npc.roomId)) : -1;
            if (npcRoomId >= 0 && activeCutsceneRoomIds.has(npcRoomId)) continue;

            AILogic.updateNpc(npc, players, levelScope);
        }
    }

    static updateNpc(npc: any, players: Client[], levelScope: string) {
        let target: Client | null = null;
        let minDist = Number.MAX_VALUE;
        const npcX = npc.x || 0;
        const npcY = npc.y || 0;
        const npcRoomId = Number.isFinite(Number(npc?.roomId)) ? Number(npc.roomId) : -1;
        const levelName = getScopeLevelName(levelScope);
        const entType = GameData.getEntType(npc.name);
        const isRanged = entType?.RangedPower ? true : false;
        const isBoss = AILogic.isBossLike(npc);
        const isDungeonLevel = LevelConfig.isDungeonLevel(levelName);
        AILogic.clearDeadAggroTarget(npc, players, levelScope);
        const aggroTargetEntityId = Math.max(0, Math.round(Number(npc?.aggroTargetEntityId ?? 0)));

        if (isDungeonLevel && !isBoss && !AILogic.hasCombatPull(npc)) {
            return;
        }

        for (const p of players) {
            if (!p.character || !p.character.CurrentLevel) continue;
            if (CombatHandler.isPlayerDeadForCombat(p, levelScope)) continue;
            if (!isBoss && aggroTargetEntityId > 0 && p.clientEntID !== aggroTargetEntityId) continue;
            const playerRoomId = Number.isFinite(Number(p.currentRoomId)) ? Math.round(Number(p.currentRoomId)) : -1;
            if (isBoss) {
                if (playerRoomId < 0 || npcRoomId < 0 || playerRoomId !== Math.round(npcRoomId)) continue;
            } else if (!sharesRoomIds(p.currentRoomId, npcRoomId)) {
                continue;
            }
            const px = p.character.CurrentLevel.x;
            const py = p.character.CurrentLevel.y;

            const dist = Math.hypot(px - npcX, py - npcY);
            if (dist < minDist) {
                minDist = dist;
                target = p;
            }
        }

        if (!target || !target.character || !target.character.CurrentLevel) {
            if (isBoss && aggroTargetEntityId > 0) {
                AILogic.clearAggroTarget(npc);
            }
            return;
        }

        const attackRange = isRanged ? AILogic.RANGED_ATTACK_RANGE : AILogic.ATTACK_RANGE;
        const aggroRadius = isBoss
            ? (isRanged ? AILogic.BOSS_RANGED_AGGRO_RADIUS : AILogic.BOSS_MELEE_AGGRO_RADIUS)
            : (isRanged ? AILogic.RANGED_AGGRO_RADIUS : AILogic.MELEE_AGGRO_RADIUS);

        if (isBoss && minDist > aggroRadius) {
            AILogic.clearAggroTarget(npc);
            return;
        }

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
                    const bbCast = new BitBuffer(false);
                    bbCast.writeMethod4(npc.id);
                    bbCast.writeMethod4(powerId); // PowerID
                    bbCast.writeMethod15(false); // hasTargetEntity
                    bbCast.writeMethod15(true);  // hasTargetPos
                    bbCast.writeMethod24(Math.round(targetX));
                    bbCast.writeMethod24(Math.round(targetY));
                    bbCast.writeMethod15(false); // hasProjectile
                    bbCast.writeMethod15(false); // isPersistent
                    bbCast.writeMethod15(false); // hasComboData
                    bbCast.writeMethod15(false); // hasPowerResourceData

                    CombatHandler.broadcastEntityViewPacket(levelScope, npc, 0x09, bbCast.toBuffer(), [npc.id, target.clientEntID]);

                    // 2. Broadcast Power Hit (0x0A)
                    const bbHit = new BitBuffer(false);
                    bbHit.writeMethod4(target.clientEntID); // Target
                    bbHit.writeMethod4(npc.id);             // Source
                    bbHit.writeMethod24(damage);            // Damage
                    bbHit.writeMethod4(powerId);            // PowerID
                    bbHit.writeMethod15(false); // Anim override
                    bbHit.writeMethod15(false); // Effect override
                    bbHit.writeMethod15(false); // Crit

                    void CombatHandler.handlePowerHit(target, bbHit.toBuffer()).catch((error) => {
                        console.error('[AILogic] Failed to process NPC power hit:', error);
                    });
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
                    
                    const bbMove = new BitBuffer(false);
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

                    CombatHandler.broadcastEntityViewPacket(levelScope, npc, 0x07, bbMove.toBuffer(), [npc.id]);
                }
            }
        }
    }

    private static isBossLike(npc: any): boolean {
        const rank = GameData.getEntityRank(npc);
        return rank === 'Boss' || rank === 'MiniBoss' || GameData.isBossEntity(npc);
    }
}
