import { GlobalState, SharedDungeonProgressState } from './GlobalState';
import { DungeonSpawnLoader, DungeonSpawnConfig } from '../data/DungeonSpawnLoader';
import { getActiveDungeonRunStats } from './DungeonRunStats';
import { EntityTeam } from './Entity';
import { LevelConfig } from './LevelConfig';
import { getClientLevelScope, getScopeLevelName } from './LevelScope';
import { getClientCharacterKey, getPartyLeaderCharacterKeyForClient } from './PartySync';
import { normalizeCharacterKey } from './SocialState';
import {
    isWolfsEndDungeonLevel,
    isDungeonStatsDefeated,
    isDungeonStatsHostile
} from './WolfsEndDungeonStatsPolicy';
import {
    hasEastWingCombatDeathEvidence,
    isEastWingRequiredEnemy,
    logEastWingProgressBlocked
} from './EastWingEnemyDebug';

const GOBLIN_RIVER_INITIAL_PROGRESS = 11;
const SHARED_DUNGEON_PROGRESS_EXCLUDED_LEVELS = new Set<string>([
    'TutorialBoat',
    'TutorialDungeon',
    'TutorialDungeonHard'
]);
const SERVER_AUTHORITY_HOSTILE_PROGRESS_LEVELS = new Set<string>([
    'AC_Mission1',
    'Castle',
    'CastleHard',
    'JC_Mini2',
    'JC_Mini2Hard'
]);
const EAST_WING_LEVELS = new Set<string>([
    'JC_Mini2',
    'JC_Mini2Hard'
]);

function normalizeAuthorityToken(value: unknown): number {
    const token = Number(value ?? 0);
    return Number.isFinite(token) && token > 0 ? Math.round(token) : 0;
}

function clampProgress(value: unknown): number {
    const progress = Number(value ?? 0);
    if (!Number.isFinite(progress)) {
        return 0;
    }

    return Math.max(0, Math.min(100, Math.round(progress)));
}

function getRequiredForClearProgressConfig(levelName: string | null | undefined): DungeonSpawnConfig | null {
    return DungeonSpawnLoader.getSpawnConfigForLevel(LevelConfig.normalizeLevelName(levelName));
}

function usesRequiredForClearProgress(levelScope: string | null | undefined, levelName: string | null | undefined): boolean {
    if (getRequiredForClearProgressConfig(levelName)) {
        return true;
    }

    const levelMap = GlobalState.levelEntities.get(String(levelScope ?? '').trim());
    for (const entity of levelMap?.values() ?? []) {
        if (entity?.requiredForClear === true) {
            return true;
        }
    }

    return false;
}

function logRequiredForClearProgress(
    levelScope: string,
    levelName: string | null | undefined,
    totals: { total: number; defeated: number },
    progress: number
): void {
    const config = getRequiredForClearProgressConfig(levelName);
    if (!config) {
        return;
    }

    console.log(
        `[DungeonProgress] level=${config.levelId || config.levelName} levelName=${config.levelName} dungeon="${config.dungeonName}" scope=${levelScope} totalRequired=${totals.total} deadRequired=${totals.defeated} percent=${progress}`
    );
    if (EAST_WING_LEVELS.has(config.levelName)) {
        let rawDeadEntities = 0;
        let ignoredRawDeadWithoutCombat = 0;
        for (const entity of GlobalState.levelEntities.get(levelScope)?.values() ?? []) {
            if (!isEastWingRequiredEnemy(levelScope, entity)) {
                continue;
            }
            if (isEntityDefeated(entity)) {
                rawDeadEntities++;
                if (!hasEastWingCombatDeathEvidence(entity)) {
                    ignoredRawDeadWithoutCombat++;
                }
            }
        }
        console.log(
            `[EastWingProgress] totalRequired=${totals.total} deadRequired=${totals.defeated} acceptedCombatKills=${totals.defeated} rawDeadEntities=${rawDeadEntities} ignoredRawDeadWithoutCombat=${ignoredRawDeadWithoutCombat} percent=${progress}`
        );
    }
}

function hasDefeatedEastWingBoss(levelScope: string): boolean {
    const levelMap = GlobalState.levelEntities.get(levelScope);
    for (const entity of levelMap?.values() ?? []) {
        if (
            entity?.requiredForClear === true &&
            (entity?.boss === true || entity?.roomBoss === true || entity?.isRoomBoss === true) &&
            isCombatValidDefeatedEntity(levelScope, Math.max(0, Math.round(Number(entity?.id ?? 0))), entity, 'SharedDungeonProgress.hasDefeatedEastWingBoss')
        ) {
            return true;
        }
    }

    return false;
}

export function usesSharedDungeonProgress(levelName: string | null | undefined): boolean {
    const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
    return Boolean(normalizedLevel) &&
        !SHARED_DUNGEON_PROGRESS_EXCLUDED_LEVELS.has(normalizedLevel) &&
        (
            isWolfsEndDungeonLevel(normalizedLevel) ||
            Boolean(getRequiredForClearProgressConfig(normalizedLevel))
        );
}

export function getSharedDungeonInitialProgress(levelName: string | null | undefined): number {
    const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
    if (
        normalizedLevel === 'GoblinRiverDungeon' ||
        normalizedLevel === 'GoblinRiverDungeonHard'
    ) {
        return GOBLIN_RIVER_INITIAL_PROGRESS;
    }

    return 0;
}

export function getSharedDungeonProgressState(
    levelScope: string | null | undefined
): SharedDungeonProgressState | null {
    const scopeKey = String(levelScope ?? '').trim();
    if (!scopeKey) {
        return null;
    }

    const state = GlobalState.levelQuestProgress.get(scopeKey);
    if (!state) {
        return null;
    }

    state.progress = clampProgress(state.progress);
    state.authorityToken = normalizeAuthorityToken(state.authorityToken);
    state.trackedHostileIds ??= new Set<number>();
    state.defeatedHostileIds ??= new Set<number>();
    return state;
}

export function getOrCreateSharedDungeonProgressState(
    levelScope: string | null | undefined
): SharedDungeonProgressState | null {
    const scopeKey = String(levelScope ?? '').trim();
    if (!scopeKey) {
        return null;
    }

    const existing = getSharedDungeonProgressState(scopeKey);
    if (existing) {
        return existing;
    }

    const created: SharedDungeonProgressState = {
        progress: 0,
        authorityToken: 0,
        trackedHostileIds: new Set<number>(),
        defeatedHostileIds: new Set<number>(),
        liveStatsByCharacter: new Map()
    };
    GlobalState.levelQuestProgress.set(scopeKey, created);
    return created;
}

function refreshSharedDungeonLiveStats(
    state: SharedDungeonProgressState,
    levelScope: string
): void {
    state.liveStatsByCharacter ??= new Map();
    state.liveStatsByCharacter.clear();

    for (const session of GlobalState.sessionsByToken.values()) {
        if (!session?.playerSpawned || getClientLevelScope(session) !== levelScope) {
            continue;
        }

        const characterKey = getClientCharacterKey(session);
        if (!characterKey) {
            continue;
        }

        const runStats = getActiveDungeonRunStats(session);
        const scoreSummary = runStats?.scoreSummary;
        if (!runStats || !scoreSummary) {
            continue;
        }

        state.liveStatsByCharacter.set(characterKey, {
            updatedAt: Date.now(),
            levelName: runStats.levelName,
            scoreMode: runStats.scoreMode,
            totalScore: scoreSummary.finalStat.total,
            kills: scoreSummary.finalStat.kills,
            treasure: scoreSummary.finalStat.treasure,
            accuracy: scoreSummary.finalStat.accuracy,
            deaths: scoreSummary.finalStat.deaths,
            timeBonus: scoreSummary.finalStat.timeBonus,
            resultBar: scoreSummary.resultBar,
            rank: scoreSummary.rank
        });
    }
}

function usesServerAuthorityHostileProgress(levelNameOrScope: string | null | undefined): boolean {
    const levelName = getScopeLevelName(String(levelNameOrScope ?? ''));
    const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
    return typeof normalizedLevel === 'string' &&
        normalizedLevel.length > 0 &&
        SERVER_AUTHORITY_HOSTILE_PROGRESS_LEVELS.has(normalizedLevel);
}

function isSharedDungeonTrackedHostile(levelNameOrScope: string | null | undefined, entity: any): boolean {
    if (!isDungeonStatsHostile(entity)) {
        return false;
    }

    if (entity?.requiredForClear === true) {
        return true;
    }

    if (usesServerAuthorityHostileProgress(levelNameOrScope)) {
        return (
            Boolean(entity?.serverAuthorityHostile) ||
            (
                !Boolean(entity?.clientSpawned) &&
                !Boolean(entity?.isPlayer) &&
                Number(entity?.team ?? EntityTeam.UNKNOWN) === EntityTeam.ENEMY
            )
        );
    }

    return Boolean(entity?.clientSpawned) || Boolean(entity?.serverAuthorityHostile);
}

function isEntityDefeated(entity: any): boolean {
    return isDungeonStatsDefeated(entity);
}

function isCombatValidDefeatedEntity(levelScope: string | null | undefined, entityId: number, entity: any, sourcePath: string): boolean {
    if (!isEntityDefeated(entity)) {
        return false;
    }

    if (!isEastWingRequiredEnemy(levelScope, entity)) {
        return true;
    }

    if (hasEastWingCombatDeathEvidence(entity)) {
        return true;
    }

    logEastWingProgressBlocked('non_combat_death_attempt', sourcePath, String(levelScope ?? ''), entity, {
        entityId,
        hpBefore: Math.round(Number(entity?.combatDeathHpBefore ?? entity?.hp ?? 0)),
        hpAfter: Math.round(Number(entity?.hp ?? 0)),
        deathCause: entity?.deathCause ?? entity?.combatDeathCause ?? 'unknown',
        eventId: entity?.combatDeathEventId ?? ''
    });
    return false;
}

export function resolveSharedDungeonProgressAuthorityToken(levelScope: string | null | undefined): number {
    const scopeKey = String(levelScope ?? '').trim();
    if (!scopeKey) {
        return 0;
    }

    let scopedPartyLeaderKey = '';
    for (const session of GlobalState.sessionsByToken.values()) {
        if (!session?.playerSpawned || getClientLevelScope(session) !== scopeKey) {
            continue;
        }

        const leaderKey = getPartyLeaderCharacterKeyForClient(session);
        if (leaderKey) {
            scopedPartyLeaderKey = leaderKey;
            break;
        }
    }

    if (scopedPartyLeaderKey) {
        for (const session of GlobalState.sessionsByToken.values()) {
            if (
                session?.playerSpawned &&
                session.token > 0 &&
                getClientLevelScope(session) === scopeKey &&
                normalizeCharacterKey(session.character?.name) === scopedPartyLeaderKey
            ) {
                return session.token;
            }
        }
    }

    const levelMap = GlobalState.levelEntities.get(scopeKey);
    const counts = new Map<number, number>();

    for (const entity of levelMap?.values() ?? []) {
        if (!entity || entity.isPlayer || !entity.clientSpawned || Number(entity.team ?? 0) !== 2) {
            continue;
        }

        const ownerToken = normalizeAuthorityToken(entity.ownerToken);
        if (ownerToken <= 0) {
            continue;
        }

        counts.set(ownerToken, (counts.get(ownerToken) ?? 0) + 1);
    }

    let bestToken = 0;
    let bestCount = 0;
    for (const [ownerToken, count] of counts.entries()) {
        if (count > bestCount || (count === bestCount && ownerToken < bestToken)) {
            bestToken = ownerToken;
            bestCount = count;
        }
    }

    if (bestToken > 0) {
        return bestToken;
    }

    return normalizeAuthorityToken(getSharedDungeonProgressState(scopeKey)?.authorityToken);
}

export function hasSharedDungeonProgressHostiles(levelScope: string | null | undefined): boolean {
    const scopeKey = String(levelScope ?? '').trim();
    if (!scopeKey) {
        return false;
    }

    return getSharedDungeonProgressTotals(scopeKey).total > 0;
}

export function noteSharedDungeonHostileState(levelScope: string | null | undefined, entityId: number, entity: any): void {
    if (!entityId || !isSharedDungeonTrackedHostile(levelScope, entity)) {
        return;
    }

    const state = getOrCreateSharedDungeonProgressState(levelScope);
    if (!state) {
        return;
    }

    state.trackedHostileIds?.add(entityId);
    if (isCombatValidDefeatedEntity(levelScope, entityId, entity, 'SharedDungeonProgress.noteSharedDungeonHostileState')) {
        state.defeatedHostileIds?.add(entityId);
    } else {
        state.defeatedHostileIds?.delete(entityId);
    }
}

export function noteSharedDungeonHostileDestroyed(levelScope: string | null | undefined, entityId: number, entity: any): void {
    if (!entityId || !isSharedDungeonTrackedHostile(levelScope, entity)) {
        return;
    }

    const state = getOrCreateSharedDungeonProgressState(levelScope);
    if (!state) {
        return;
    }

    state.trackedHostileIds?.add(entityId);
    if (isCombatValidDefeatedEntity(levelScope, entityId, entity, 'SharedDungeonProgress.noteSharedDungeonHostileDestroyed')) {
        state.defeatedHostileIds?.add(entityId);
    }
}

export function getSharedDungeonProgressTotals(
    levelScope: string | null | undefined
): { total: number; defeated: number; ignoredClientOnly: number } {
    const scopeKey = String(levelScope ?? '').trim();
    if (!scopeKey) {
        return { total: 0, defeated: 0, ignoredClientOnly: 0 };
    }

    const state = getOrCreateSharedDungeonProgressState(scopeKey);
    if (!state) {
        return { total: 0, defeated: 0, ignoredClientOnly: 0 };
    }

    const tracked = state.trackedHostileIds ?? new Set<number>();
    const defeated = state.defeatedHostileIds ?? new Set<number>();
    const levelMap = GlobalState.levelEntities.get(scopeKey);
    let ignoredClientOnly = 0;

    for (const [entityId, entity] of levelMap?.entries() ?? []) {
        if (
            usesServerAuthorityHostileProgress(scopeKey) &&
            Boolean(entity?.clientSpawned) &&
            !Boolean(entity?.isPlayer) &&
            Number(entity?.team ?? EntityTeam.UNKNOWN) === EntityTeam.ENEMY
        ) {
            ignoredClientOnly++;
        }
        if (!isSharedDungeonTrackedHostile(scopeKey, entity)) {
            continue;
        }

        tracked.add(entityId);
        if (isCombatValidDefeatedEntity(scopeKey, entityId, entity, 'SharedDungeonProgress.getSharedDungeonProgressTotals')) {
            defeated.add(entityId);
        } else {
            defeated.delete(entityId);
        }
    }

    let defeatedCount = 0;
    for (const entityId of defeated.values()) {
        if (tracked.has(entityId)) {
            defeatedCount++;
        }
    }

    return {
        total: tracked.size,
        defeated: defeatedCount,
        ignoredClientOnly
    };
}

export function recomputeSharedDungeonProgress(levelScope: string | null | undefined): SharedDungeonProgressState | null {
    const state = getOrCreateSharedDungeonProgressState(levelScope);
    const scopeKey = String(levelScope ?? '').trim();
    if (!state || !scopeKey) {
        return null;
    }

    const totals = getSharedDungeonProgressTotals(levelScope);
    const levelName = getScopeLevelName(levelScope);
    const previousProgress = clampProgress(state.progress);
    const preserveEastWingProgress =
        EAST_WING_LEVELS.has(levelName) &&
        previousProgress > 0 &&
        (
            totals.total <= 0 ||
            Boolean(state.bossDead) ||
            Boolean(state.bossDeathCommitted) ||
            Boolean(state.bossTombstoned) ||
            Boolean(state.pendingCompletion) ||
            Boolean(state.completionFinalized)
        );
    if (preserveEastWingProgress) {
        state.progress = previousProgress;
        refreshSharedDungeonLiveStats(state, scopeKey);
        return state;
    }

    if (usesRequiredForClearProgress(scopeKey, levelName)) {
        const computedProgress = totals.total > 0
            ? clampProgress(Math.floor((totals.defeated / totals.total) * 100))
            : 0;
        state.progress = EAST_WING_LEVELS.has(levelName) && (Boolean(state.bossDeathCommitted) || hasDefeatedEastWingBoss(scopeKey))
            ? Math.max(25, computedProgress)
            : computedProgress;
        logRequiredForClearProgress(scopeKey, levelName, totals, state.progress);
        refreshSharedDungeonLiveStats(state, scopeKey);
        return state;
    }

    if (usesSharedDungeonProgress(levelName)) {
        const initialProgress = getSharedDungeonInitialProgress(levelName);
        const computedProgress = totals.total > 0
            ? clampProgress(initialProgress + ((totals.defeated / totals.total) * (100 - initialProgress)))
            : initialProgress;
        state.progress = EAST_WING_LEVELS.has(levelName) && Boolean(state.bossDeathCommitted)
            ? Math.max(25, computedProgress)
            : computedProgress;
        if (usesServerAuthorityHostileProgress(levelScope)) {
            console.log(
                `[MultiplayerSync][progress_server_registry] total=${totals.total} dead=${totals.defeated} ignoredClientOnly=${totals.ignoredClientOnly ?? 0} percent=${state.progress}`
            );
        }
        refreshSharedDungeonLiveStats(state, scopeKey);
        return state;
    }

    const computedProgress = totals.total > 0
        ? clampProgress((totals.defeated / totals.total) * 100)
        : 0;
    state.progress = EAST_WING_LEVELS.has(levelName) && Boolean(state.bossDeathCommitted)
        ? Math.max(25, computedProgress)
        : computedProgress;
    refreshSharedDungeonLiveStats(state, scopeKey);
    return state;
}

export function setSharedDungeonProgressState(
    levelScope: string | null | undefined,
    progress: number,
    authorityToken?: number
): SharedDungeonProgressState | null {
    const state = getOrCreateSharedDungeonProgressState(levelScope);
    if (!state) {
        return null;
    }

    state.progress = clampProgress(progress);
    const normalizedAuthorityToken = normalizeAuthorityToken(authorityToken);
    if (normalizedAuthorityToken > 0) {
        state.authorityToken = normalizedAuthorityToken;
    }

    return state;
}
