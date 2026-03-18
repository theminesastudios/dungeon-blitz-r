import { Client } from './Client';
import { LevelConfig } from './LevelConfig';

const DUNGEON_SCOPE_SEPARATOR = '#';

export function normalizeLevelInstanceId(value: unknown): string {
    return String(value ?? '').trim();
}

export function createDungeonInstanceId(seed: number | string | null | undefined): string {
    if (typeof seed === 'number' && Number.isFinite(seed)) {
        const rounded = Math.round(seed);
        return rounded > 0 ? String(rounded) : '';
    }

    return normalizeLevelInstanceId(seed);
}

export function getLevelScopeKey(
    levelName: string | null | undefined,
    levelInstanceId?: string | null | undefined
): string {
    const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
    if (!normalizedLevel) {
        return '';
    }

    const normalizedInstanceId = normalizeLevelInstanceId(levelInstanceId);
    if (!normalizedInstanceId) {
        return normalizedLevel;
    }

    return normalizedInstanceId
        ? `${normalizedLevel}${DUNGEON_SCOPE_SEPARATOR}${normalizedInstanceId}`
        : normalizedLevel;
}

export function getClientLevelScope(
    client: Pick<Client, 'currentLevel' | 'levelInstanceId'> | null | undefined
): string {
    return getLevelScopeKey(client?.currentLevel, client?.levelInstanceId);
}

export function getScopeLevelName(scopeKey: string | null | undefined): string {
    const raw = String(scopeKey ?? '');
    const separatorIndex = raw.indexOf(DUNGEON_SCOPE_SEPARATOR);
    return separatorIndex >= 0 ? raw.substring(0, separatorIndex) : raw;
}

export function getScopeLevelInstanceId(scopeKey: string | null | undefined): string {
    const raw = String(scopeKey ?? '');
    const separatorIndex = raw.indexOf(DUNGEON_SCOPE_SEPARATOR);
    return separatorIndex >= 0 ? raw.substring(separatorIndex + 1) : '';
}

export function areClientsInSameLevelScope(
    left: Pick<Client, 'currentLevel' | 'levelInstanceId'> | null | undefined,
    right: Pick<Client, 'currentLevel' | 'levelInstanceId'> | null | undefined
): boolean {
    const leftScope = getClientLevelScope(left);
    return Boolean(leftScope) && leftScope === getClientLevelScope(right);
}

export function isClientInLevelScope(
    client: Pick<Client, 'currentLevel' | 'levelInstanceId'> | null | undefined,
    levelName: string | null | undefined,
    levelInstanceId?: string | null | undefined
): boolean {
    return getClientLevelScope(client) === getLevelScopeKey(levelName, levelInstanceId);
}
