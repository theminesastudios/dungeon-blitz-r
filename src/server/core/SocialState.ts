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
    craftTownHostCharacter?: Character;
    x: number;
    y: number;
    hasCoord: boolean;
    syncAnchorToken?: number;
    syncAnchorCharacterName?: string;
    syncRoomId?: number;
    syncStartedRoomIds?: number[];
    syncQuestProgress?: number;
}

export const MAX_FRIEND_ENTRIES = 100;
export const MAX_FRIEND_INPUT_ITEMS = MAX_FRIEND_ENTRIES * 4;
export const MAX_SOCIAL_NAME_BYTES = 48;

export function sanitizeSocialText(value: unknown, fallback = ''): string {
    if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        return fallback;
    }

    const text = String(value)
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!text) {
        return fallback;
    }

    const encoded = Buffer.from(text, 'utf8');
    if (encoded.length <= MAX_SOCIAL_NAME_BYTES) {
        return text;
    }

    let end = MAX_SOCIAL_NAME_BYTES;
    while (end > 0 && (encoded[end] & 0xc0) === 0x80) {
        end--;
    }

    return encoded.subarray(0, end).toString('utf8').trim() || fallback;
}

export function clampSocialLevel(value: unknown): number {
    const level = Number(value);
    if (!Number.isFinite(level)) {
        return 1;
    }

    return Math.max(1, Math.min(Math.floor(level), 63));
}

export function normalizeCharacterKey(value: unknown): string {
    return String(value ?? '').trim().toLowerCase();
}

export function normalizeFriendEntry(value: unknown): FriendEntry | null {
    if (typeof value === 'string') {
        const name = sanitizeSocialText(value);
        return name ? { name, isRequest: false } : null;
    }

    if (!value || typeof value !== 'object') {
        return null;
    }

    const raw = value as Record<string, unknown>;
    const name = sanitizeSocialText(raw.name);
    if (!name) {
        return null;
    }

    return {
        name,
        isRequest: Boolean(raw.isRequest)
    };
}

export function normalizeFriendEntries(value: unknown): FriendEntry[] {
    const items = Array.isArray(value) ? value.slice(0, MAX_FRIEND_INPUT_ITEMS) : [];
    const deduped = new Map<string, FriendEntry>();

    for (const item of items) {
        if (deduped.size >= MAX_FRIEND_ENTRIES) {
            break;
        }

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

export function getFriendListSanitizationSummary(value: unknown): {
    rawCount: number;
    normalizedCount: number;
    droppedCount: number;
    truncated: boolean;
} {
    const rawCount = Array.isArray(value) ? value.length : 0;
    const normalizedCount = normalizeFriendEntries(value).length;
    return {
        rawCount,
        normalizedCount,
        droppedCount: Math.max(0, rawCount - normalizedCount),
        truncated: rawCount > MAX_FRIEND_ENTRIES
    };
}

export function normalizeIgnoredEntry(value: unknown): string | null {
    if (typeof value === 'string') {
        const name = sanitizeSocialText(value);
        return name || null;
    }

    if (!value || typeof value !== 'object') {
        return null;
    }

    const raw = value as Record<string, unknown>;
    const name = sanitizeSocialText(raw.name ?? raw.charName);
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
