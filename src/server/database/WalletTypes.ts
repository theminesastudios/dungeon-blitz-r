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
}

export interface WalletDocument extends WalletSnapshot {
    _id: string;
    gameUserId: number;
    characterNameKey: string;
    characterName: string;
    version: number;
    updatedAt: Date;
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

function normalizeWalletString(value: unknown): string {
    return String(value ?? '').trim();
}

export function createWalletOwnerIdentity(gameUserId: number): WalletOwnerIdentity {
    return {
        gameUserId: normalizeWalletNumber(gameUserId)
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
    const normalizedIdentity = createWalletOwnerIdentity(identity.gameUserId);

    return {
        _id: getWalletDocumentId(normalizedIdentity, character),
        gameUserId: normalizedIdentity.gameUserId,
        characterNameKey: getCharacterNameKey(character),
        characterName: String(character.name ?? '').trim(),
        ...snapshot,
        version: WALLET_DOCUMENT_VERSION,
        updatedAt: now
    };
}

export function normalizeWalletDocument(document: WalletDocument): WalletDocument {
    const legacyDocument = document as WalletDocument & { userId?: unknown };
    const fallbackGameUserId = normalizeWalletNumber(document.gameUserId ?? legacyDocument.userId);
    const identity = createWalletOwnerIdentity(fallbackGameUserId);
    const characterNameKey = getCharacterNameKey(document.characterNameKey || document.characterName);
    const updatedAt = document.updatedAt instanceof Date ? document.updatedAt : new Date(document.updatedAt);

    return {
        _id: normalizeWalletString(document._id) || getWalletDocumentId(identity, characterNameKey),
        gameUserId: identity.gameUserId,
        characterNameKey,
        characterName: String(document.characterName ?? '').trim(),
        ...extractWalletSnapshot(document as unknown as Character),
        version: Math.max(1, Math.round(Number(document.version ?? WALLET_DOCUMENT_VERSION))),
        updatedAt
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
