import type { Character } from '../database/Database';
import { GameData } from './GameData';
import { GlobalState } from './GlobalState';
import type { Client } from './Client';
import { getPartyIdForClient } from './PartySync';

export function clampRuntimeLevel(value: unknown, fallbackLevel: number = 1): number {
    const fallback = Math.max(1, Math.min(50, Math.round(Number(fallbackLevel) || 1)));
    const level = Math.round(Number(value));
    if (!Number.isFinite(level) || level <= 0) {
        return fallback;
    }

    return Math.max(1, Math.min(50, level));
}

export function getCharacterRuntimeLevel(
    character: Partial<Pick<Character, 'level' | 'xp'>> | null | undefined,
    fallbackLevel: number = 1
): number {
    const xpLevel = GameData.getPlayerLevelFromXp(Math.max(0, Number(character?.xp ?? 0)));
    const characterLevel = Math.max(1, Number(character?.level ?? 0));
    const resolvedLevel = xpLevel > 1 ? xpLevel : characterLevel;
    return clampRuntimeLevel(resolvedLevel, fallbackLevel);
}

export function getPartyRuntimeLevelForClient(
    client: Pick<Client, 'character'> | null | undefined,
    fallbackCharacter: Partial<Pick<Character, 'level' | 'xp'>> | null | undefined = client?.character,
    fallbackLevel: number = 1
): number {
    const ownRuntimeLevel = getCharacterRuntimeLevel(fallbackCharacter, fallbackLevel);
    const partyId = getPartyIdForClient(client);
    if (partyId <= 0) {
        return ownRuntimeLevel;
    }

    let maxLevel = ownRuntimeLevel;
    for (const session of GlobalState.sessionsByToken.values()) {
        if (!GlobalState.isSessionOpen(session) || getPartyIdForClient(session) !== partyId) {
            continue;
        }

        maxLevel = Math.max(maxLevel, getCharacterRuntimeLevel(session.character, ownRuntimeLevel));
    }

    return clampRuntimeLevel(maxLevel, ownRuntimeLevel);
}

// Enemy scaling belongs to the dungeon instance, not to whoever happens to be
// asking. The Flash client sizes a boss health bar from the level the server
// stamped on it, so deriving that level per client — from that client's own
// party — is what let two people standing in the same room watch two different
// bars drain at two different rates. Everyone sharing a level scope now shares
// one number by construction.
//
// Sticky for the life of the scope: a boss must not heal because the highest
// level player in the run walked out or disconnected mid-fight.
const scopeRuntimeLevels = new Map<string, number>();

export function getScopeRuntimeLevel(
    levelScope: string | null | undefined,
    joiningClient?: Pick<Client, 'character'> | null | undefined,
    fallbackLevel: number = 1
): number {
    const scopeKey = String(levelScope ?? '').trim();
    if (!scopeKey) {
        return getPartyRuntimeLevelForClient(joiningClient, joiningClient?.character, fallbackLevel);
    }

    let maxLevel = Math.max(0, Math.round(Number(scopeRuntimeLevels.get(scopeKey) ?? 0)));
    for (const session of GlobalState.getSessionsInLevelScope(scopeKey)) {
        if (!GlobalState.isSessionOpen(session)) {
            continue;
        }

        // Party level, not character level: a player brings the difficulty their
        // party already implies into the instance with them.
        maxLevel = Math.max(maxLevel, getPartyRuntimeLevelForClient(session, session.character, fallbackLevel));
    }
    if (joiningClient) {
        // The joiner is not indexed into the scope yet on the entry path.
        maxLevel = Math.max(
            maxLevel,
            getPartyRuntimeLevelForClient(joiningClient, joiningClient.character, fallbackLevel)
        );
    }

    const resolved = clampRuntimeLevel(maxLevel, fallbackLevel);
    scopeRuntimeLevels.set(scopeKey, resolved);
    return resolved;
}

export function clearScopeRuntimeLevel(levelScope: string | null | undefined): void {
    scopeRuntimeLevels.delete(String(levelScope ?? '').trim());
}
