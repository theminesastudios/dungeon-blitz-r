import { Character } from './Database';

export const WALLET_DOCUMENT_VERSION = 1;

export type WalletCurrencyField =
    | 'gold'
    | 'mammothIdols'
    | 'DragonKeys'
    | 'dragonOre'
    | 'SilverSigils'
    | 'RoyalSigils';

export type WalletCurrencyDelta = Partial<Record<WalletCurrencyField, number>>;

export interface LockboxCount {
    lockboxID: number;
    count: number;
}

export interface LockboxDelta {
    lockboxID: number;
    delta: number;
}

export interface WalletSnapshot {
    gold: number;
    mammothIdols: number;
    DragonKeys: number;
    dragonOre: number;
    SilverSigils: number;
    RoyalSigils: number;
    lockboxes: LockboxCount[];
}

export interface WalletOwnerIdentity {
    gameUserId: number;
    userId: string;
    discordUserId?: string;
    identityProvider: 'discord' | 'game';
}

export interface WalletDocument extends WalletSnapshot {
    _id: string;
    userId: string;
    gameUserId: number;
    discordUserId?: string;
    identityProvider: 'discord' | 'game';
    characterNameKey: string;
    characterName: string;
    version: number;
    createdAt: Date;
    updatedAt: Date;
    lastUpdated: number;
}

export interface WalletDelta extends WalletCurrencyDelta {
    lockboxes?: LockboxDelta[];
}

export const WALLET_CURRENCY_FIELDS: readonly WalletCurrencyField[] = [
    'gold',
    'mammothIdols',
    'DragonKeys',
    'dragonOre',
    'SilverSigils',
    'RoyalSigils'
];

export function getCharacterNameKey(characterOrName: Character | string | null | undefined): string {
    const name = typeof characterOrName === 'string'
        ? characterOrName
        : String(characterOrName?.name ?? '');

    return name.trim().toLowerCase();
}

export function normalizeWalletNumber(value: unknown): number {
    const numeric = Number(value ?? 0);
    if (!Number.isFinite(numeric)) {
        return 0;
    }

    return Math.max(0, Math.round(numeric));
}

export function normalizeWalletUserId(value: unknown): string {
    return String(value ?? '').trim();
}

export function createWalletOwnerIdentity(
    gameUserId: number,
    discordUserId?: string | null
): WalletOwnerIdentity {
    const normalizedGameUserId = normalizeWalletNumber(gameUserId);
    const normalizedDiscordUserId = normalizeWalletUserId(discordUserId);

    return {
        gameUserId: normalizedGameUserId,
        userId: normalizedDiscordUserId || String(normalizedGameUserId),
        discordUserId: normalizedDiscordUserId || undefined,
        identityProvider: normalizedDiscordUserId ? 'discord' : 'game'
    };
}

export function getWalletDocumentId(
    identity: WalletOwnerIdentity,
    characterOrName: Character | string | null | undefined
): string {
    return `${normalizeWalletNumber(identity.gameUserId)}:${getCharacterNameKey(characterOrName)}`;
}

export function normalizeLockboxes(rawLockboxes: unknown): LockboxCount[] {
    const counts = new Map<number, number>();
    for (const entry of Array.isArray(rawLockboxes) ? rawLockboxes : []) {
        const lockboxID = normalizeWalletNumber((entry as Record<string, unknown>)?.lockboxID);
        const count = normalizeWalletNumber((entry as Record<string, unknown>)?.count);
        if (lockboxID <= 0 || count <= 0) {
            continue;
        }

        counts.set(lockboxID, (counts.get(lockboxID) ?? 0) + count);
    }

    return Array.from(counts.entries())
        .map(([lockboxID, count]) => ({ lockboxID, count }))
        .sort((left, right) => left.lockboxID - right.lockboxID);
}

export function extractWalletSnapshot(character: Character | null | undefined): WalletSnapshot {
    const rawDragonOre = (character as Record<string, unknown> | null | undefined)?.dragonOre ??
        (character as Record<string, unknown> | null | undefined)?.DragonOre ??
        0;

    return {
        gold: normalizeWalletNumber(character?.gold),
        mammothIdols: normalizeWalletNumber(character?.mammothIdols),
        DragonKeys: normalizeWalletNumber((character as Record<string, unknown> | null | undefined)?.DragonKeys),
        dragonOre: normalizeWalletNumber(rawDragonOre),
        SilverSigils: normalizeWalletNumber((character as Record<string, unknown> | null | undefined)?.SilverSigils),
        RoyalSigils: normalizeWalletNumber((character as Record<string, unknown> | null | undefined)?.RoyalSigils),
        lockboxes: normalizeLockboxes((character as Record<string, unknown> | null | undefined)?.lockboxes)
    };
}

export function applyWalletSnapshot(character: Character | null | undefined, wallet: WalletSnapshot): void {
    if (!character) {
        return;
    }

    // These fields are server-authoritative when Mongo wallet mode is enabled.
    character.gold = normalizeWalletNumber(wallet.gold);
    character.mammothIdols = normalizeWalletNumber(wallet.mammothIdols);
    character.DragonKeys = normalizeWalletNumber(wallet.DragonKeys);
    character.DragonOre = normalizeWalletNumber(wallet.dragonOre);
    character.dragonOre = normalizeWalletNumber(wallet.dragonOre);
    character.SilverSigils = normalizeWalletNumber(wallet.SilverSigils);
    character.RoyalSigils = normalizeWalletNumber(wallet.RoyalSigils);
    character.lockboxes = normalizeLockboxes(wallet.lockboxes);
}

export function createWalletDocument(identity: WalletOwnerIdentity, character: Character): WalletDocument {
    const now = new Date();
    const snapshot = extractWalletSnapshot(character);
    const normalizedIdentity = createWalletOwnerIdentity(
        identity.gameUserId,
        identity.discordUserId ?? (identity.identityProvider === 'discord' ? identity.userId : undefined)
    );

    return {
        _id: getWalletDocumentId(normalizedIdentity, character),
        userId: normalizedIdentity.userId,
        gameUserId: normalizedIdentity.gameUserId,
        discordUserId: normalizedIdentity.discordUserId,
        identityProvider: normalizedIdentity.identityProvider,
        characterNameKey: getCharacterNameKey(character),
        characterName: String(character.name ?? '').trim(),
        ...snapshot,
        version: WALLET_DOCUMENT_VERSION,
        createdAt: now,
        updatedAt: now,
        lastUpdated: now.getTime()
    };
}

export function normalizeWalletDocument(document: WalletDocument): WalletDocument {
    const fallbackGameUserId = normalizeWalletNumber(document.gameUserId ?? document.userId);
    const rawUserId = normalizeWalletUserId(document.userId);
    const rawDiscordUserId = normalizeWalletUserId(document.discordUserId);
    const discordUserId = rawDiscordUserId || (document.identityProvider === 'discord' ? rawUserId : '');
    const identity = createWalletOwnerIdentity(fallbackGameUserId, discordUserId);
    const characterNameKey = getCharacterNameKey(document.characterNameKey || document.characterName);
    const createdAt = document.createdAt instanceof Date ? document.createdAt : new Date(document.createdAt);
    const updatedAt = document.updatedAt instanceof Date ? document.updatedAt : new Date(document.updatedAt);

    return {
        _id: normalizeWalletUserId(document._id) || getWalletDocumentId(identity, characterNameKey),
        userId: rawUserId || identity.userId,
        gameUserId: identity.gameUserId,
        discordUserId: identity.discordUserId,
        identityProvider: identity.identityProvider,
        characterNameKey,
        characterName: String(document.characterName ?? '').trim(),
        ...extractWalletSnapshot(document as unknown as Character),
        version: Math.max(1, Math.round(Number(document.version ?? WALLET_DOCUMENT_VERSION))),
        createdAt,
        updatedAt,
        lastUpdated: normalizeWalletNumber(document.lastUpdated ?? updatedAt.getTime())
    };
}

export function getWalletFieldValue(character: Character, field: WalletCurrencyField): number {
    if (field === 'dragonOre') {
        return normalizeWalletNumber(character.dragonOre ?? character.DragonOre);
    }

    return normalizeWalletNumber((character as Record<string, unknown>)[field]);
}

export function setWalletFieldValue(character: Character, field: WalletCurrencyField, value: number): void {
    const normalized = normalizeWalletNumber(value);
    if (field === 'dragonOre') {
        character.dragonOre = normalized;
        character.DragonOre = normalized;
        return;
    }

    (character as Record<string, unknown>)[field] = normalized;
}
