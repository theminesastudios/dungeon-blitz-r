
import { GlobalState } from './GlobalState';
import { GameData } from './GameData';
import { EntityHandler } from '../handlers/EntityHandler';
import { CombatHandler } from '../handlers/CombatHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { NpcDef } from '../data/NpcLoader';
import { Client } from './Client';
import { sharesRoomIds } from './PartySync';
import { getClientLevelScope, getScopeLevelName } from './LevelScope';
import { DungeonCompletionConditions } from './DungeonCompletionConditions';
import { getRoomBossAwareRoomId, isRoomBossEntity } from './RoomBossState';
import { EntityState } from './Entity';
import { performance } from 'perf_hooks';
import { AdminRuntimeSettings } from './AdminRuntimeSettings';


export class AILogic {
    static readonly INTERVAL = 125; // ms (0.125s)
    static readonly TIMESTEP = 1 / 60.0;
    // Aggro radii, restored to the original game values (240/360/180/260). The v1.11.0
    // halving (120/180/90/130) left enemies standing still until the player was almost
    // on top of them: boss-melee aggro (90) sat below melee attack range (95) and ranged
    // aggro (180) below ranged attack range (300), so a pulled enemy swung in place
    // instead of closing the gap. These values also keep the server's boss radii aligned
    // with CombatHandler's (180/260) and roughly in line with the client SWF's own
    // 250px Brain.AGGRO_RADIUS, so server-driven and client-driven enemies engage at
    // similar distances.
    static readonly MELEE_AGGRO_RADIUS = 240;
    static readonly RANGED_AGGRO_RADIUS = 360;
    static readonly BOSS_MELEE_AGGRO_RADIUS = 180;
    static readonly BOSS_RANGED_AGGRO_RADIUS = 260;
    static readonly LEASH_RADIUS = 1800;
    static readonly RETURN_SPEED = 20;
    static readonly HOME_EPSILON = 1;
    static readonly STOP_DISTANCE = 50;
    static readonly ATTACK_RANGE = 95;
    static readonly RANGED_ATTACK_RANGE = 300;
    static readonly ATTACK_COOLDOWN = 1000; // ms
    // Grace period between a room going empty and the enemy resetting home, so a
    // player stepping back and forth across a room boundary cannot drive an
    // aggro/reset loop. Cleared the moment a valid player is seen again.
    static readonly RESET_DEBOUNCE_MS = Math.max(
        0,
        Number(process.env.AI_RESET_DEBOUNCE_MS ?? 1500)
    );
    static readonly BASE_NPC_DAMAGE = 15;
    static readonly ENABLE_SERVER_AUTHORITY_HOSTILE_AI = process.env.ENABLE_SERVER_AUTHORITY_HOSTILE_AI === '1';
    static readonly SLOW_TICK_MS = Math.max(25, Number(process.env.AI_SLOW_TICK_MS ?? 100));
    private static tickInProgress = false;

    private static hasCombatPull(npc: any): boolean {
        return Math.max(0, Math.round(Number(npc?.aggroTargetEntityId ?? 0))) > 0 ||
            Math.max(0, Math.round(Number(npc?.aggroTargetToken ?? 0))) > 0;
    }

    private static clearAggroTarget(npc: any): void {
        if (!npc || typeof npc !== 'object') {
            return;
        }

        npc.aggroTargetEntityId = 0;
        npc.aggroTargetToken = 0;
        npc.nextAttack = 0;
    }

    private static ensureHomePosition(npc: any): { x: number; y: number } {
        if (!Number.isFinite(Number(npc.aiHomeX))) {
            npc.aiHomeX = Number(npc.roomBossHomeX ?? npc.spawnX ?? npc.homeX ?? npc.x ?? 0);
        }
        if (!Number.isFinite(Number(npc.aiHomeY))) {
            npc.aiHomeY = Number(npc.roomBossHomeY ?? npc.spawnY ?? npc.homeY ?? npc.y ?? 0);
        }
        return { x: Number(npc.aiHomeX), y: Number(npc.aiHomeY) };
    }

    private static getIdleState(npc: any): EntityState {
        if (!Number.isFinite(Number(npc.aiHomeEntState))) {
            npc.aiHomeEntState = Number(npc.spawnEntState ?? npc.entState ?? EntityState.SLEEP);
        }
        return Number(npc.aiHomeEntState) === EntityState.DRAMA ? EntityState.DRAMA : EntityState.SLEEP;
    }

    private static applyStateToCopies(levelScope: string, npc: any, apply: (copy: any) => void): void {
        const entityId = Math.max(0, Math.round(Number(npc?.id ?? 0)));
        if (entityId <= 0) return;

        apply(npc);
        const canonical = GlobalState.levelEntities.get(levelScope)?.get(entityId);
        if (canonical && canonical !== npc) apply(canonical);
        for (const session of GlobalState.getSessionsInLevelScope(levelScope)) {
            if (getClientLevelScope(session) !== levelScope) continue;
            const copy = session.entities.get(entityId);
            if (copy && copy !== npc && copy !== canonical) apply(copy);
        }
    }

    private static broadcastMovement(
        levelScope: string,
        npc: any,
        deltaX: number,
        deltaY: number,
        entState: EntityState,
        running: boolean
    ): void {
        const bbMove = new BitBuffer(false);
        bbMove.writeMethod4(npc.id);
        bbMove.writeMethod45(Math.round(deltaX));
        bbMove.writeMethod45(Math.round(deltaY));
        bbMove.writeMethod45(0);
        bbMove.writeMethod6(entState, 2);
        bbMove.writeMethod15(Boolean(npc.facingLeft));
        bbMove.writeMethod15(running);
        bbMove.writeMethod15(false);
        bbMove.writeMethod15(false);
        bbMove.writeMethod15(false);
        bbMove.writeMethod15(false);
        CombatHandler.broadcastEntityViewPacket(levelScope, npc, 0x07, bbMove.toBuffer(), [npc.id]);
    }

    private static setActive(levelScope: string, npc: any): void {
        if (Number(npc.entState ?? EntityState.ACTIVE) === EntityState.ACTIVE && !npc.aiIdleAtHome) return;
        AILogic.applyStateToCopies(levelScope, npc, (copy) => {
            copy.entState = EntityState.ACTIVE;
            copy.aiIdleAtHome = false;
        });
        AILogic.broadcastMovement(levelScope, npc, 0, 0, EntityState.ACTIVE, false);
    }

    private static resetHomeAndIdle(npc: any, levelScope: string): boolean {
        const home = AILogic.ensureHomePosition(npc);
        const idleState = AILogic.getIdleState(npc);
        const currentX = Number(npc.x ?? 0);
        const currentY = Number(npc.y ?? 0);
        const deltaX = home.x - currentX;
        const deltaY = home.y - currentY;
        const alreadyReset = Math.abs(deltaX) <= AILogic.HOME_EPSILON &&
            Math.abs(deltaY) <= AILogic.HOME_EPSILON &&
            Number(npc.entState ?? EntityState.ACTIVE) === idleState &&
            Boolean(npc.aiIdleAtHome) &&
            !AILogic.hasCombatPull(npc);
        if (alreadyReset) return false;

        AILogic.applyStateToCopies(levelScope, npc, (copy) => {
            copy.x = home.x;
            copy.y = home.y;
            copy.v = 0;
            copy.entState = idleState;
            copy.running = false;
            copy.bRunning = false;
            copy.backpedal = false;
            copy.bBackpedal = false;
            copy.aiIdleAtHome = true;
            AILogic.clearAggroTarget(copy);
        });
        AILogic.broadcastMovement(levelScope, npc, deltaX, deltaY, idleState, false);
        return true;
    }

    private static returnTowardHome(npc: any, levelScope: string): void {
        AILogic.clearAggroTarget(npc);
        const home = AILogic.ensureHomePosition(npc);
        const dx = home.x - Number(npc.x ?? 0);
        const dy = home.y - Number(npc.y ?? 0);
        const distance = Math.hypot(dx, dy);
        if (distance <= AILogic.RETURN_SPEED + AILogic.HOME_EPSILON) {
            AILogic.resetHomeAndIdle(npc, levelScope);
            return;
        }

        const moveX = (dx / distance) * AILogic.RETURN_SPEED;
        const moveY = (dy / distance) * AILogic.RETURN_SPEED;
        const nextX = Number(npc.x ?? 0) + moveX;
        const nextY = Number(npc.y ?? 0) + moveY;
        AILogic.applyStateToCopies(levelScope, npc, (copy) => {
            copy.x = nextX;
            copy.y = nextY;
            copy.v = 0;
            copy.facingLeft = dx < 0;
            copy.entState = EntityState.ACTIVE;
            copy.running = true;
            copy.bRunning = true;
            copy.aiIdleAtHome = false;
        });
        AILogic.broadcastMovement(levelScope, npc, moveX, moveY, EntityState.ACTIVE, true);
    }

    /**
     * Debounced reset. Returns true only when the enemy actually changed state.
     *
     * The first empty tick just arms `aiResetPendingAt`; the reset lands once the
     * room has stayed empty for RESET_DEBOUNCE_MS. An enemy that is already home
     * and idle short-circuits so a quiet room costs one cheap check per tick.
     */
    private static resetHomeAndIdleDebounced(npc: any, levelScope: string, nowMs: number): boolean {
        if (Boolean(npc.aiIdleAtHome) && !AILogic.hasCombatPull(npc)) {
            npc.aiResetPendingAt = 0;
            return false;
        }

        let pendingAt = Number(npc.aiResetPendingAt ?? 0);
        if (!Number.isFinite(pendingAt) || pendingAt <= 0) {
            pendingAt = nowMs;
            npc.aiResetPendingAt = nowMs;
        }
        // Fall through rather than return, so a zero debounce still resets on the
        // first empty tick instead of always costing one extra tick.
        if (nowMs - pendingAt < AILogic.RESET_DEBOUNCE_MS) {
            return false;
        }

        npc.aiResetPendingAt = 0;
        return AILogic.resetHomeAndIdle(npc, levelScope);
    }

    private static clearDeadAggroTarget(npc: any, players: Client[], levelScope: string): void {
        const aggroTargetEntityId = Math.max(0, Math.round(Number(npc?.aggroTargetEntityId ?? 0)));
        const aggroTargetToken = Math.max(0, Math.round(Number(npc?.aggroTargetToken ?? 0)));
        if (aggroTargetEntityId <= 0 && aggroTargetToken <= 0) {
            return;
        }

        const target = players.find((player) =>
            (aggroTargetEntityId > 0 && player.clientEntID === aggroTargetEntityId) ||
            (aggroTargetToken > 0 && player.token === aggroTargetToken)
        );
        if (!target || CombatHandler.isPlayerDeadForCombat(target, levelScope)) {
            AILogic.clearAggroTarget(npc);
        }
    }

    // Run AI loop for all levels
    static start() {
        const timer = setInterval(() => AILogic.runTick(), AILogic.INTERVAL);
        timer.unref?.();
    }

    static runTick(): void {
        if (AILogic.tickInProgress) {
            console.warn('[AILogic] Skipped overlapping AI tick');
            return;
        }

        AILogic.tickInProgress = true;
        const startedAt = performance.now();
        let scopeCount = 0;
        let playerCount = 0;
        let npcCount = 0;
        try {
            for (const [levelScope, indexedSessions] of GlobalState.sessionsByLevelScope.entries()) {
                const levelEntities = GlobalState.levelEntities.get(levelScope);
                if (indexedSessions.size === 0 || !levelEntities || levelEntities.size === 0) {
                    continue;
                }
                const result = AILogic.updateLevel(levelScope);
                if (result.players === 0) {
                    continue;
                }
                scopeCount += 1;
                playerCount += result.players;
                npcCount += result.npcs;
            }
        } finally {
            AILogic.tickInProgress = false;
            const durationMs = performance.now() - startedAt;
            if (durationMs >= AILogic.SLOW_TICK_MS) {
                console.warn(
                    `[AILogic] Slow tick durationMs=${durationMs.toFixed(1)} scopes=${scopeCount} players=${playerCount} npcs=${npcCount}`
                );
            }
        }
    }

    static updateLevel(levelScope: string): { players: number; npcs: number } {
        const levelEntities = GlobalState.levelEntities.get(levelScope);
        if (!levelEntities || levelEntities.size === 0) return { players: 0, npcs: 0 };
        const levelName = getScopeLevelName(levelScope);
        const nowMs = Date.now();

        const players: Client[] = [];
        const activeCutsceneRoomIds = new Set<number>();
        for (const session of GlobalState.getSessionsInLevelScope(levelScope)) {
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

        CombatHandler.processOutOfCombatRegen(levelScope, nowMs);
        CombatHandler.processBuffExpirations(levelScope, nowMs);

        if (AdminRuntimeSettings.snapshot.freezeEnemies) {
            return { players: players.length, npcs: 0 };
        }

        const playersByRoom = new Map<number, Client[]>();
        for (const player of players) {
            const roomId = Number.isFinite(Number(player.currentRoomId)) ? Math.round(Number(player.currentRoomId)) : -1;
            if (roomId < 0) continue;
            const roomPlayers = playersByRoom.get(roomId) ?? [];
            roomPlayers.push(player);
            playersByRoom.set(roomId, roomPlayers);
        }

        // Iterate over Map entries to get ID and Object
        let updatedNpcs = 0;
        for (const [entId, npc] of levelEntities.entries()) {
            if (npc.isPlayer || npc.team !== 2) continue; // Only Enemy NPCs
            if (EntityHandler.usesServerAuthorityHostiles(levelName) && !AILogic.ENABLE_SERVER_AUTHORITY_HOSTILE_AI) continue; // JC_Mini1Hard uses client proxies for AI/animation.
            if (Boolean(npc.hybridCanonicalHostile) && !AILogic.ENABLE_SERVER_AUTHORITY_HOSTILE_AI) continue; // TODO: feature-flag server AI for promoted hybrid hostiles.
            if (npc.clientSpawned) continue; // Client-owned monsters should not receive server AI movement.
            // Simple dead check (if no hp prop, assume 100)
            if ((npc.hp !== undefined && npc.hp <= 0)) continue;
            const npcRoomId = getRoomBossAwareRoomId(npc);
            if (npcRoomId >= 0 && activeCutsceneRoomIds.has(npcRoomId)) continue;

            const candidates = npcRoomId >= 0
                ? (playersByRoom.get(npcRoomId) ?? [])
                : players;
            if (candidates.length === 0) {
                if (AILogic.resetHomeAndIdleDebounced(npc, levelScope, nowMs)) updatedNpcs += 1;
                continue;
            }
            AILogic.updateNpc(npc, candidates, levelScope, nowMs);
            updatedNpcs += 1;
        }
        return { players: players.length, npcs: updatedNpcs };
    }

    static updateNpc(npc: any, players: Client[], levelScope: string, nowMs: number = Date.now()) {
        const home = AILogic.ensureHomePosition(npc);
        let target: Client | null = null;
        let minDist = Number.MAX_VALUE;
        const npcX = npc.x || 0;
        const npcY = npc.y || 0;
        const npcRoomId = getRoomBossAwareRoomId(npc);
        const levelName = getScopeLevelName(levelScope);
        const entType = GameData.getEntType(npc.name);
        const isRanged = entType?.RangedPower ? true : false;
        const isBoss = DungeonCompletionConditions.isRequiredBoss(levelName, npc, levelScope) ||
            isRoomBossEntity(levelScope, npc);
        AILogic.clearDeadAggroTarget(npc, players, levelScope);
        const aggroTargetEntityId = Math.max(0, Math.round(Number(npc?.aggroTargetEntityId ?? 0)));
        const aggroTargetToken = Math.max(0, Math.round(Number(npc?.aggroTargetToken ?? 0)));

        for (const p of players) {
            if (!p.character || !p.character.CurrentLevel) continue;
            if (CombatHandler.isPlayerDeadForCombat(p, levelScope)) continue;
            if (aggroTargetEntityId > 0 && p.clientEntID !== aggroTargetEntityId) continue;
            if (aggroTargetToken > 0 && p.token !== aggroTargetToken) continue;
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
            // Players are in the room but none are a valid target (all dead, or
            // locked to a different aggro holder) — same debounce as an empty room.
            AILogic.resetHomeAndIdleDebounced(npc, levelScope, nowMs);
            return;
        }

        const attackRange = isRanged ? AILogic.RANGED_ATTACK_RANGE : AILogic.ATTACK_RANGE;
        const aggroRadius = isBoss
            ? (isRanged ? AILogic.BOSS_RANGED_AGGRO_RADIUS : AILogic.BOSS_MELEE_AGGRO_RADIUS)
            : (isRanged ? AILogic.RANGED_AGGRO_RADIUS : AILogic.MELEE_AGGRO_RADIUS);

        const distanceFromHome = Math.hypot(Number(npc.x ?? 0) - home.x, Number(npc.y ?? 0) - home.y);
        if (minDist > AILogic.LEASH_RADIUS || (minDist > aggroRadius && distanceFromHome > AILogic.HOME_EPSILON)) {
            AILogic.returnTowardHome(npc, levelScope);
            return;
        }

        if (minDist > aggroRadius) {
            AILogic.resetHomeAndIdleDebounced(npc, levelScope, nowMs);
            return;
        }

        if (minDist <= aggroRadius) {
            // A live target cancels any armed reset, so a player re-entering while
            // the enemy is walking home resumes combat instead of finishing the walk.
            npc.aiResetPendingAt = 0;
            AILogic.setActive(levelScope, npc);
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

                    const nextX = Number(npc.x ?? 0) + moveX;
                    const nextY = Number(npc.y ?? 0) + moveY;
                    AILogic.applyStateToCopies(levelScope, npc, (copy) => {
                        copy.x = nextX;
                        copy.y = nextY;
                        copy.v = 0;
                        copy.facingLeft = dx < 0;
                        copy.entState = EntityState.ACTIVE;
                        copy.running = true;
                        copy.bRunning = true;
                        copy.aiIdleAtHome = false;
                    });

                    AILogic.broadcastMovement(levelScope, npc, moveX, moveY, EntityState.ACTIVE, true);
                }
            }
        }
    }

    private static isBossLike(npc: any): boolean {
        const rank = GameData.getEntityRank(npc);
        return rank === 'Boss' || rank === 'MiniBoss' || GameData.isBossEntity(npc);
    }
}
