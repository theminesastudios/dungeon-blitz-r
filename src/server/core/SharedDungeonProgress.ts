import { GlobalState } from './GlobalState';
import { LevelConfig } from './LevelConfig';

const SHARED_DUNGEON_PROGRESS_LEVELS = new Set<string>([
    'GoblinRiverDungeon',
    'GoblinRiverDungeonHard'
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

export function usesSharedDungeonProgress(levelName: string | null | undefined): boolean {
    const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
    return Boolean(normalizedLevel) && SHARED_DUNGEON_PROGRESS_LEVELS.has(normalizedLevel);
}

export function getSharedDungeonProgressState(
    levelScope: string | null | undefined
): { progress: number; authorityToken: number } | null {
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
    return state;
}

export function getOrCreateSharedDungeonProgressState(
    levelScope: string | null | undefined
): { progress: number; authorityToken: number } | null {
    const scopeKey = String(levelScope ?? '').trim();
    if (!scopeKey) {
        return null;
    }

    const existing = getSharedDungeonProgressState(scopeKey);
    if (existing) {
        return existing;
    }

    const created = { progress: 0, authorityToken: 0 };
    GlobalState.levelQuestProgress.set(scopeKey, created);
    return created;
}

export function resolveSharedDungeonProgressAuthorityToken(levelScope: string | null | undefined): number {
    const scopeKey = String(levelScope ?? '').trim();
    if (!scopeKey) {
        return 0;
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

export function setSharedDungeonProgressState(
    levelScope: string | null | undefined,
    progress: number,
    authorityToken?: number
): { progress: number; authorityToken: number } | null {
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
