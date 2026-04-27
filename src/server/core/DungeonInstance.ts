import { NpcLoader } from '../data/NpcLoader';
import { Entity, EntityState, EntityTeam } from './Entity';
import { GameData } from './GameData';
import { GlobalState, DungeonInstanceState, ActiveDungeonInstanceRef } from './GlobalState';
import { LevelConfig } from './LevelConfig';
import { getClientLevelScope, getLevelScopeKey, getScopeLevelName, normalizeLevelInstanceId } from './LevelScope';
import { normalizeCharacterKey } from './SocialState';
import type { Client } from './Client';

type CombatPoint = {
    x: number;
    y: number;
};

type EnemyAttackValidation = {
    ok: boolean;
    damage: number;
    reason?: string;
};

const HOSTILE_BASE_HITPOINTS = [
    100, 4920, 5580, 6020, 6520, 7040, 7580, 8180, 8800, 9480, 10180, 10960, 11740, 12640, 13540, 14540,
    15560, 16660, 17860, 19120, 20440, 21860, 23360, 24960, 26680, 28460, 30380, 32420, 34580, 36900, 39320,
    41920, 44660, 47560, 50660, 53940, 57420, 61080, 64980, 69120, 73520, 78160, 83100, 88300, 93820, 99700,
    105880, 112460, 119400, 126760, 134560
] as const;

const DEFAULT_ATTACK_COOLDOWN_MS = 750;
const DEFAULT_MELEE_RANGE = 220;
const DEFAULT_RANGED_RANGE = 650;
const RANGE_GRACE = 180;
// Small first rollout: only enable dungeons whose multiplayer hostile
// population is already validated against the server NPC data. Add more
// dungeon levels here as their scripted/tutorial flows are verified.
const SERVER_AUTHORITATIVE_DUNGEON_LEVELS = new Set<string>([
    'GoblinRiverDungeon',
    'GoblinRiverDungeonHard'
]);

function normalizeLevelName(levelName: string | null | undefined): string {
    return LevelConfig.normalizeLevelName(levelName);
}

function isHostileTemplate(npc: any): boolean {
    return Number(npc?.team ?? 0) === EntityTeam.ENEMY;
}

function getBaseHpForLevel(level: number): number {
    const maxIndex = HOSTILE_BASE_HITPOINTS.length - 1;
    const clampedLevel = Math.max(1, Math.min(maxIndex, Math.floor(Number(level) || 1)));
    return HOSTILE_BASE_HITPOINTS[clampedLevel];
}

function estimateHostileMaxHp(entity: any): number {
    const entType = GameData.getEntType(String(entity?.name ?? '')) ?? {};
    const rawLevel = Number(entity?.level ?? entType?.Level ?? entType?.baseLevel ?? entType?.ExpLevel ?? 1);
    const hitPointScale = Number(entity?.HitPoints ?? entity?.hitPoints ?? entType?.HitPoints ?? NaN);
    if (!Number.isFinite(hitPointScale) || hitPointScale <= 0) {
        return Math.max(1, Math.round(Number(entity?.maxHp ?? entity?.hp ?? 100)));
    }

    return Math.max(1, Math.round(getBaseHpForLevel(rawLevel) * hitPointScale));
}

function getEntityPosition(entity: any): CombatPoint | null {
    const x = Number(entity?.physPosX ?? entity?.x ?? entity?.pos_x ?? NaN);
    const y = Number(entity?.physPosY ?? entity?.y ?? entity?.pos_y ?? NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return null;
    }
    return { x, y };
}

function getEnemyDamageCap(entity: any): number {
    const entType = GameData.getEntType(String(entity?.name ?? '')) ?? {};
    const damageScalar = Math.max(
        0.25,
        Number(entity?.meleeDamage ?? entType?.MeleeDamage ?? 0),
        Number(entity?.magicDamage ?? entType?.MagicDamage ?? 0),
        Number(entity?.rangedDamage ?? entType?.RangedDamage ?? 0)
    );
    const rank = GameData.getEntityRank(entity);
    const rankMultiplier = rank === 'Boss'
        ? 4
        : rank === 'MiniBoss'
            ? 3
            : rank === 'Lieutenant'
                ? 2
                : 1;
    const maxHp = estimateHostileMaxHp(entity);

    // Temporary bridge while Flash owns AI: allow authored spikes, but never
    // accept damage unrelated to the enemy's configured scale/health.
    return Math.max(25, Math.round(maxHp * 0.35 * damageScalar * rankMultiplier));
}

function hasLivingEnemyInRoom(levelMap: Map<number, any> | undefined, state: DungeonInstanceState, roomId: number): boolean {
    if (!levelMap || roomId < 0) {
        return false;
    }

    for (const enemyId of state.enemyIds) {
        const enemy = levelMap.get(enemyId);
        if (!enemy || Number(enemy.roomId ?? -1) !== roomId) {
            continue;
        }
        if (!DungeonInstance.isEnemyAlive(enemy)) {
            continue;
        }
        return true;
    }

    return false;
}

export class DungeonInstance {
    static isServerAuthoritativeDungeon(levelName: string | null | undefined): boolean {
        const normalizedLevel = normalizeLevelName(levelName);
        if (!normalizedLevel || !LevelConfig.isDungeonLevel(normalizedLevel)) {
            return false;
        }
        if (!SERVER_AUTHORITATIVE_DUNGEON_LEVELS.has(normalizedLevel)) {
            return false;
        }

        return NpcLoader.getRawNpcsForLevel(normalizedLevel).some(isHostileTemplate);
    }

    static isServerAuthoritativeDungeonEntity(entity: any): boolean {
        return Boolean(entity?.serverAuthoritativeDungeon);
    }

    static isEnemyAlive(entity: any): boolean {
        return Boolean(entity) &&
            !Boolean(entity.dead) &&
            Number(entity.hp ?? 1) > 0 &&
            Number(entity.entState ?? EntityState.ACTIVE) !== EntityState.DEAD;
    }

    static getActiveInstanceForCharacter(
        characterName: string | null | undefined,
        levelName: string | null | undefined
    ): ActiveDungeonInstanceRef | null {
        const characterKey = normalizeCharacterKey(characterName);
        const normalizedLevel = normalizeLevelName(levelName);
        if (!characterKey || !normalizedLevel) {
            return null;
        }

        const ref = GlobalState.activeDungeonByCharacter.get(characterKey);
        if (!ref || normalizeLevelName(ref.levelName) !== normalizedLevel) {
            return null;
        }
        if (!GlobalState.dungeonInstances.has(ref.scopeKey)) {
            return null;
        }

        return ref;
    }

    static rememberActiveInstance(client: Pick<Client, 'character' | 'currentLevel' | 'levelInstanceId'>): void {
        const characterKey = normalizeCharacterKey(client.character?.name);
        const levelName = normalizeLevelName(client.currentLevel);
        const levelInstanceId = normalizeLevelInstanceId(client.levelInstanceId);
        const scopeKey = getLevelScopeKey(levelName, levelInstanceId);
        if (!characterKey || !scopeKey || !DungeonInstance.isServerAuthoritativeDungeon(levelName)) {
            return;
        }

        GlobalState.activeDungeonByCharacter.set(characterKey, {
            levelName,
            levelInstanceId,
            scopeKey,
            updatedAt: Date.now()
        });
    }

    static clearActiveInstanceForCharacter(characterName: string | null | undefined): void {
        const characterKey = normalizeCharacterKey(characterName);
        if (characterKey) {
            GlobalState.activeDungeonByCharacter.delete(characterKey);
        }
    }

    static ensure(levelName: string | null | undefined, levelInstanceId: string | null | undefined): DungeonInstanceState | null {
        const normalizedLevel = normalizeLevelName(levelName);
        if (!DungeonInstance.isServerAuthoritativeDungeon(normalizedLevel)) {
            return null;
        }

        const normalizedInstanceId = normalizeLevelInstanceId(levelInstanceId);
        const scopeKey = getLevelScopeKey(normalizedLevel, normalizedInstanceId);
        if (!scopeKey) {
            return null;
        }

        let state = GlobalState.dungeonInstances.get(scopeKey);
        let levelMap = GlobalState.levelEntities.get(scopeKey);
        if (state && levelMap) {
            return state;
        }

        levelMap ??= new Map<number, any>();
        const now = Date.now();
        state ??= {
            levelName: normalizedLevel,
            levelInstanceId: normalizedInstanceId,
            scopeKey,
            enemyIds: new Set<number>(),
            deadEnemyIds: new Set<number>(),
            completedRoomIds: new Set<number>(),
            openedChestIds: new Set<number>(),
            completed: false,
            createdAt: now,
            updatedAt: now
        };

        for (const [entityId, entity] of Array.from(levelMap.entries())) {
            if (entity?.isPlayer || entity?.serverAuthoritativeDungeon) {
                continue;
            }
            levelMap.delete(entityId);
        }

        // TODO(server-ai): these are authoritative spawn/state records only.
        // Full pathing, aggro, and attack choice should move here after the
        // Flash AI bridge is removed.
        for (const npc of NpcLoader.getRawNpcsForLevel(normalizedLevel)) {
            if (!isHostileTemplate(npc)) {
                continue;
            }

            const entity: any = {
                ...Entity.fromNpc(npc),
                serverAuthoritativeDungeon: true,
                clientSpawned: false,
                dungeonInstanceId: normalizedInstanceId,
                spawnTemplateId: Number(npc.id ?? 0)
            };
            const maxHp = estimateHostileMaxHp(entity);
            const healthDelta = Math.round(Number(entity.healthDelta ?? entity.health_delta ?? 0));
            entity.maxHp = maxHp;
            entity.hp = Math.max(0, Math.min(maxHp, maxHp + Math.min(0, healthDelta)));
            entity.dead = entity.hp <= 0 || Number(entity.entState ?? EntityState.ACTIVE) === EntityState.DEAD;
            if (entity.dead) {
                entity.entState = EntityState.DEAD;
            }

            levelMap.set(entity.id, entity);
            state.enemyIds.add(entity.id);
            if (!DungeonInstance.isEnemyAlive(entity)) {
                state.deadEnemyIds.add(entity.id);
            }
        }

        state.completed = state.enemyIds.size > 0 && state.deadEnemyIds.size >= state.enemyIds.size;
        state.updatedAt = now;
        GlobalState.levelEntities.set(scopeKey, levelMap);
        GlobalState.dungeonInstances.set(scopeKey, state);
        return state;
    }

    static getState(levelScope: string | null | undefined): DungeonInstanceState | null {
        const scopeKey = String(levelScope ?? '').trim();
        return scopeKey ? GlobalState.dungeonInstances.get(scopeKey) ?? null : null;
    }

    static getCompletionProgress(levelScope: string | null | undefined): number {
        const state = DungeonInstance.getState(levelScope);
        if (!state || state.enemyIds.size === 0) {
            return 0;
        }

        return Math.max(0, Math.min(100, Math.round((state.deadEnemyIds.size / state.enemyIds.size) * 100)));
    }

    static noteEnemyState(levelScope: string | null | undefined, entityId: number, entity: any): void {
        const state = DungeonInstance.getState(levelScope);
        if (!state || entityId <= 0 || !state.enemyIds.has(entityId)) {
            return;
        }

        if (DungeonInstance.isEnemyAlive(entity)) {
            state.deadEnemyIds.delete(entityId);
        } else {
            state.deadEnemyIds.add(entityId);
        }
        state.completed = state.enemyIds.size > 0 && state.deadEnemyIds.size >= state.enemyIds.size;
        state.updatedAt = Date.now();

        const roomId = Number.isFinite(Number(entity?.roomId)) ? Math.round(Number(entity.roomId)) : -1;
        if (roomId >= 0 && !hasLivingEnemyInRoom(GlobalState.levelEntities.get(state.scopeKey), state, roomId)) {
            state.completedRoomIds.add(roomId);
        }
    }

    static noteRoomClearReported(levelScope: string | null | undefined, roomId: number): boolean {
        const state = DungeonInstance.getState(levelScope);
        if (!state || roomId < 0) {
            return false;
        }

        if (hasLivingEnemyInRoom(GlobalState.levelEntities.get(state.scopeKey), state, roomId)) {
            return false;
        }

        state.completedRoomIds.add(Math.round(roomId));
        state.updatedAt = Date.now();
        return true;
    }

    static noteChestOpened(levelScope: string | null | undefined, chestId: number): boolean {
        const state = DungeonInstance.getState(levelScope);
        if (!state || chestId <= 0) {
            return true;
        }

        if (state.openedChestIds.has(chestId)) {
            return false;
        }

        state.openedChestIds.add(chestId);
        state.updatedAt = Date.now();
        return true;
    }

    static findCanonicalEnemy(levelScope: string, incoming: any): any | null {
        const state = DungeonInstance.getState(levelScope);
        const levelMap = GlobalState.levelEntities.get(levelScope);
        if (!state || !levelMap || !incoming) {
            return null;
        }

        const incomingId = Number(incoming.id ?? 0);
        const exact = incomingId > 0 ? levelMap.get(incomingId) : null;
        if (exact && state.enemyIds.has(incomingId)) {
            return exact;
        }

        const incomingName = String(incoming.name ?? '').trim().toLowerCase();
        const incomingPos = getEntityPosition(incoming);
        let best: any | null = null;
        let bestDistanceSq = Number.POSITIVE_INFINITY;
        for (const enemyId of state.enemyIds) {
            const candidate = levelMap.get(enemyId);
            if (!candidate || String(candidate.name ?? '').trim().toLowerCase() !== incomingName) {
                continue;
            }

            const candidatePos = getEntityPosition(candidate);
            const distanceSq = incomingPos && candidatePos
                ? ((candidatePos.x - incomingPos.x) ** 2) + ((candidatePos.y - incomingPos.y) ** 2)
                : 0;
            if (distanceSq < bestDistanceSq) {
                best = candidate;
                bestDistanceSq = distanceSq;
            }
        }

        return bestDistanceSq <= 500 * 500 ? best : null;
    }

    static validateReportedEnemyAttack(
        reportingClient: Client,
        levelScope: string,
        enemy: any,
        targetSession: Client | null,
        requestedDamage: number,
        nowMs: number = Date.now()
    ): EnemyAttackValidation {
        const state = DungeonInstance.getState(levelScope);
        const enemyId = Number(enemy?.id ?? 0);
        if (!state || !state.enemyIds.has(enemyId)) {
            return { ok: false, damage: 0, reason: 'enemy-not-in-instance' };
        }
        if (!DungeonInstance.isEnemyAlive(enemy)) {
            return { ok: false, damage: 0, reason: 'enemy-dead' };
        }
        if (!targetSession?.playerSpawned || getClientLevelScope(targetSession) !== levelScope) {
            return { ok: false, damage: 0, reason: 'target-not-in-instance' };
        }

        const enemyPos = getEntityPosition(enemy);
        const targetEntity = targetSession.entities.get(targetSession.clientEntID) ??
            GlobalState.levelEntities.get(levelScope)?.get(targetSession.clientEntID);
        const targetPos = getEntityPosition(targetEntity);
        if (!enemyPos || !targetPos) {
            return { ok: false, damage: 0, reason: 'missing-position' };
        }

        const entType = GameData.getEntType(String(enemy.name ?? '')) ?? {};
        const range = entType.RangedPower ? DEFAULT_RANGED_RANGE : DEFAULT_MELEE_RANGE;
        const dx = enemyPos.x - targetPos.x;
        const dy = enemyPos.y - targetPos.y;
        if ((dx * dx) + (dy * dy) > (range + RANGE_GRACE) ** 2) {
            return { ok: false, damage: 0, reason: 'out-of-range' };
        }

        const nextAttackAt = Math.max(0, Math.round(Number(enemy.nextAuthoritativeAttackAt ?? 0)));
        if (nextAttackAt > nowMs) {
            return { ok: false, damage: 0, reason: 'cooldown' };
        }

        enemy.nextAuthoritativeAttackAt = nowMs + DEFAULT_ATTACK_COOLDOWN_MS;
        enemy.lastAuthoritativeAttackerToken = reportingClient.token;
        const damageCap = getEnemyDamageCap(enemy);
        return {
            ok: true,
            damage: Math.max(0, Math.min(Math.round(Number(requestedDamage) || 0), damageCap))
        };
    }

    static validateEnemyTarget(levelScope: string, enemy: any): boolean {
        const state = DungeonInstance.getState(levelScope);
        const enemyId = Number(enemy?.id ?? 0);
        return Boolean(state && state.enemyIds.has(enemyId) && DungeonInstance.isEnemyAlive(enemy));
    }

    static isServerAuthoritativeScope(levelScope: string | null | undefined): boolean {
        return DungeonInstance.isServerAuthoritativeDungeon(getScopeLevelName(levelScope));
    }
}
