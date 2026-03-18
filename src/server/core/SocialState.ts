import { Character } from '../database/Database';

export interface FriendEntry {
    name: string;
    isRequest: boolean;
}

export interface PartyGroup {
    id: number;
    leader: string;
    members: string[];
    locked: boolean;
}

export interface PendingTeleport {
    targetLevel: string;
    levelInstanceId?: string;
    x: number;
    y: number;
    hasCoord: boolean;
    syncAnchorToken?: number;
    syncAnchorCharacterName?: string;
    syncEntryLevel?: string;
    syncRoomId?: number;
    syncStartedRoomIds?: number[];
}

export function normalizeCharacterKey(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
}

export function normalizeFriendEntry(value: unknown): FriendEntry | null {
    if (typeof value === 'string') {
        const name = String(value).trim();
        return name ? { name, isRequest: false } : null;
    }

    if (!value || typeof value !== 'object') {
        return null;
    }

    const raw = value as Record<string, unknown>;
    const name = String(raw.name ?? '').trim();
    if (!name) {
        return null;
    }

    return {
        name,
        isRequest: Boolean(raw.isRequest)
    };
}

export function normalizeFriendEntries(value: unknown): FriendEntry[] {
    const items = Array.isArray(value) ? value : [];
    const deduped = new Map<string, FriendEntry>();

    for (const item of items) {
        const entry = normalizeFriendEntry(item);
        if (!entry) {
            continue;
        }

        const key = normalizeCharacterKey(entry.name);
        const existing = deduped.get(key);
        if (!existing) {
            deduped.set(key, entry);
            continue;
        }

        if (existing.isRequest && !entry.isRequest) {
            deduped.set(key, entry);
        }
    }

    return Array.from(deduped.values());
}

export function normalizeIgnoredEntry(value: unknown): string | null {
    if (typeof value === 'string') {
        const name = String(value).trim();
        return name || null;
    }

    if (!value || typeof value !== 'object') {
        return null;
    }

    const raw = value as Record<string, unknown>;
    const name = String(raw.name ?? raw.charName ?? '').trim();
    return name || null;
}

export function normalizeIgnoredEntries(value: unknown): string[] {
    const items = Array.isArray(value) ? value : [];
    const deduped = new Map<string, string>();

    for (const item of items) {
        const entry = normalizeIgnoredEntry(item);
        if (!entry) {
            continue;
        }

        const key = normalizeCharacterKey(entry);
        if (!key || deduped.has(key)) {
            continue;
        }

        deduped.set(key, entry);
    }

    return Array.from(deduped.values());
}

export function getCharacterIgnoredEntries(character: Character | null | undefined): string[] {
    if (!character) {
        return [];
    }

    ensureCharacterSocialState(character);
    return Array.isArray(character.ignored) ? (character.ignored as string[]) : [];
}

export function isCharacterIgnoring(character: Character | null | undefined, name: string): boolean {
    const targetKey = normalizeCharacterKey(name);
    if (!targetKey) {
        return false;
    }

    return getCharacterIgnoredEntries(character).some((entry) => normalizeCharacterKey(entry) === targetKey);
}
export function ensureCharacterSocialState(character: Character | null | undefined): boolean {
    if (!character) {
        return false;
    }

    let mutated = false;
    const normalizedFriends = normalizeFriendEntries(character.friends);
    if (!Array.isArray(character.friends) || character.friends.length !== normalizedFriends.length) {
        character.friends = normalizedFriends;
        mutated = true;
    } else {
        for (let index = 0; index < normalizedFriends.length; index++) {
            const current = normalizeFriendEntry(character.friends[index]);
            const next = normalizedFriends[index];
            if (!current || current.name !== next.name || current.isRequest !== next.isRequest) {
                character.friends = normalizedFriends;
                mutated = true;
                break;
            }
        }
    }

    if (!Array.isArray(character.friends)) {
        character.friends = [];
        mutated = true;
    }

    const normalizedIgnored = normalizeIgnoredEntries(character.ignored);
    if (!Array.isArray(character.ignored) || character.ignored.length !== normalizedIgnored.length) {
        character.ignored = normalizedIgnored;
        mutated = true;
    } else {
        for (let index = 0; index < normalizedIgnored.length; index++) {
            const current = normalizeIgnoredEntry(character.ignored[index]);
            const next = normalizedIgnored[index];
            if (!current || current !== next) {
                character.ignored = normalizedIgnored;
                mutated = true;
                break;
            }
        }
    }

    if (!Array.isArray(character.ignored)) {
        character.ignored = [];
        mutated = true;
    }
    return mutated;
}
