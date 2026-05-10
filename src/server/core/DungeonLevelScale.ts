import { GameData } from './GameData';
import { GlobalState } from './GlobalState';
import { LevelConfig } from './LevelConfig';
import type { Client } from './Client';
import { getPartyIdForClient } from './PartySync';
import { normalizeCharacterKey } from './SocialState';

const MAX_PLAYER_LEVEL = 50;
const MAX_PACKET_LEVEL = 63;

type RuntimeLevelCharacter = {
    name?: unknown;
    level?: unknown;
    xp?: unknown;
};

function clampLevel(value: number, maxLevel: number): number {
    return Math.max(1, Math.min(maxLevel, Math.round(Number(value) || 1)));
}

export function resolvePlayerRuntimeLevel(character: RuntimeLevelCharacter | null | undefined): number {
    const xpLevel = GameData.getPlayerLevelFromXp(Math.max(0, Number(character?.xp ?? 0)));
    const characterLevel = Math.max(1, Number(character?.level ?? 0));
    const resolvedLevel = xpLevel > 1 ? xpLevel : characterLevel;
    return clampLevel(resolvedLevel, MAX_PLAYER_LEVEL);
}

export function resolveDungeonTeamHighestPlayerLevel(
    levelName: string | null | undefined,
    character: RuntimeLevelCharacter | null | undefined,
    client: Pick<Client, 'character'> | null | undefined = null
): number {
    const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
    let highestLevel = resolvePlayerRuntimeLevel(character);
    if (!normalizedLevel) {
        return highestLevel;
    }

    const characterPartyId = Number(GlobalState.partyByMember.get(normalizeCharacterKey(character?.name)) ?? 0);
    const partyId = characterPartyId || (client?.character ? getPartyIdForClient(client) : 0);
    if (partyId <= 0) {
        return highestLevel;
    }

    for (const other of GlobalState.sessionsByToken.values()) {
        if (!other.character || getPartyIdForClient(other) !== partyId) {
            continue;
        }
        if (LevelConfig.normalizeLevelName(other.currentLevel) !== normalizedLevel) {
            continue;
        }

        highestLevel = Math.max(highestLevel, resolvePlayerRuntimeLevel(other.character));
    }

    return highestLevel;
}

export function resolveDungeonEnemyScaleLevel(
    levelName: string | null | undefined,
    configuredLevel: number,
    character: RuntimeLevelCharacter | null | undefined,
    client: Pick<Client, 'character'> | null | undefined = null
): number {
    if (!LevelConfig.isDungeonLevel(levelName)) {
        return clampLevel(configuredLevel, MAX_PACKET_LEVEL);
    }

    const highestLevel = resolveDungeonTeamHighestPlayerLevel(levelName, character, client);
    return clampLevel(highestLevel * 2, MAX_PACKET_LEVEL);
}
