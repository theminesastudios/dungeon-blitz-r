import { Config } from '../core/config';
import { DiscordAccountLinkStore } from '../integrations/DiscordAccountLinkStore';
import { Character } from './Database';
import { MongoWalletAdapter, WalletPersistenceAdapter } from './MongoWalletAdapter';
import {
    applyWalletSnapshot,
    createWalletDocument,
    createWalletOwnerIdentity,
    extractWalletSnapshot,
    getWalletFieldValue,
    LockboxDelta,
    normalizeLockboxes,
    normalizeWalletNumber,
    setWalletFieldValue,
    WalletCurrencyField,
    WalletDelta,
    WalletDocument,
    WalletOwnerIdentity,
    WALLET_CURRENCY_FIELDS
} from './WalletTypes';

type WalletClient = {
    userId: number | null;
    character: Character | null;
};

type WalletIdentityResolver = (gameUserId: number) => Promise<WalletOwnerIdentity>;

const discordAccountLinks = new DiscordAccountLinkStore();

async function resolveWalletOwnerIdentity(gameUserId: number): Promise<WalletOwnerIdentity> {
    const normalizedGameUserId = normalizeWalletNumber(gameUserId);
    const link = await discordAccountLinks.findByUserId(normalizedGameUserId).catch((error) => {
        console.warn(`[Wallet] Could not read Discord account link for game user ${normalizedGameUserId}:`, error);
        return null;
    });

    // The Discord bot stores user documents by string Discord snowflake. Wallet
    // documents mirror that userId shape when a link exists, but they never copy
    // OAuth tokens or linked-role metadata into the game wallet collection.
    return createWalletOwnerIdentity(normalizedGameUserId, link?.discordUserId);
}

export class WalletService {
    private static enabled = Boolean(Config.ENABLE_MONGO_WALLET);
    private static initialized = false;
    private static identityResolver: WalletIdentityResolver = resolveWalletOwnerIdentity;
    private static adapter: WalletPersistenceAdapter = new MongoWalletAdapter(
        Config.MONGODB_URI,
        Config.MONGODB_DB_NAME,
        Config.MONGODB_WALLET_COLLECTION
    );

    static isEnabled(): boolean {
        return WalletService.enabled;
    }

    static configureForTests(
        adapter: WalletPersistenceAdapter,
        enabled: boolean,
        identityResolver: WalletIdentityResolver = async (gameUserId) => createWalletOwnerIdentity(gameUserId)
    ): void {
        WalletService.adapter = adapter;
        WalletService.enabled = enabled;
        WalletService.initialized = !enabled;
        WalletService.identityResolver = identityResolver;
    }

    static async initialize(): Promise<void> {
        if (!WalletService.enabled || WalletService.initialized) {
            return;
        }

        await WalletService.adapter.connect();
        WalletService.initialized = true;
        console.log(
            `[Wallet] Mongo wallet enabled db=${Config.MONGODB_DB_NAME} collection=${Config.MONGODB_WALLET_COLLECTION}`
        );
    }

    static async close(): Promise<void> {
        await WalletService.adapter.close();
        WalletService.initialized = false;
    }

    static async overlayWallet(userId: number, character: Character | null | undefined): Promise<void> {
        if (!WalletService.enabled || !character) {
            return;
        }

        const identity = await WalletService.resolveIdentity(userId);
        const wallet = await WalletService.adapter.getOrCreateWallet(identity, character);
        applyWalletSnapshot(character, wallet);
    }

    static async overlayWallets(userId: number, characters: Character[]): Promise<Character[]> {
        if (!WalletService.enabled || !Array.isArray(characters) || characters.length === 0) {
            return characters;
        }

        await Promise.all(characters.map((character) => WalletService.overlayWallet(userId, character)));
        return characters;
    }

    static async applyMongoWalletsBeforeJsonSave(userId: number, characters: Character[]): Promise<Character[]> {
        if (!WalletService.enabled || !Array.isArray(characters) || characters.length === 0) {
            return characters;
        }

        // JSON remains the save format for character state. When Mongo wallet
        // mode is active, these overlays prevent stale JSON wallet values from
        // replacing the server-authoritative Mongo wallet.
        return WalletService.overlayWallets(userId, characters);
    }

    static async refreshCharacterWallet(client: WalletClient): Promise<void> {
        if (!client.userId || !client.character) {
            return;
        }

        await WalletService.overlayWallet(client.userId, client.character);
    }

    static async spend(client: WalletClient, field: WalletCurrencyField, amount: number): Promise<boolean> {
        return WalletService.applyDelta(client, { [field]: -normalizeWalletNumber(amount) });
    }

    static async grant(client: WalletClient, field: WalletCurrencyField, amount: number): Promise<boolean> {
        return WalletService.applyDelta(client, { [field]: normalizeWalletNumber(amount) });
    }

    static async applyDelta(client: WalletClient, delta: WalletDelta): Promise<boolean> {
        if (!client.character) {
            return false;
        }

        const normalizedDelta = WalletService.normalizeDelta(delta);
        if (!WalletService.hasAnyDelta(normalizedDelta)) {
            return true;
        }

        if (!WalletService.enabled || !client.userId) {
            return WalletService.applyLocalDelta(client.character, normalizedDelta);
        }

        const identity = await WalletService.resolveIdentity(client.userId);
        await WalletService.adapter.getOrCreateWallet(identity, client.character);
        const wallet = await WalletService.adapter.applyDelta(identity, client.character, normalizedDelta);
        if (!wallet) {
            await WalletService.overlayWallet(client.userId, client.character);
            return false;
        }

        applyWalletSnapshot(client.character, wallet);
        return true;
    }

    static extractCharacterWallet(character: Character): WalletDocument | null {
        if (!character) {
            return null;
        }

        const now = new Date();
        return {
            ...createWalletDocument(createWalletOwnerIdentity(0), character),
            createdAt: now,
            updatedAt: now,
            lastUpdated: now.getTime()
        };
    }

    private static async resolveIdentity(userId: number): Promise<WalletOwnerIdentity> {
        return WalletService.identityResolver(normalizeWalletNumber(userId));
    }

    private static applyLocalDelta(character: Character, delta: WalletDelta): boolean {
        const currentSnapshot = extractWalletSnapshot(character);
        for (const field of WALLET_CURRENCY_FIELDS) {
            const amount = Number(delta[field] ?? 0);
            if (amount < 0 && getWalletFieldValue(character, field) < Math.abs(amount)) {
                return false;
            }
        }

        const normalizedLockboxes = normalizeLockboxes(currentSnapshot.lockboxes);
        for (const lockboxDelta of WalletService.normalizeLockboxDeltas(delta.lockboxes)) {
            if (lockboxDelta.delta >= 0) {
                continue;
            }

            const currentCount = normalizedLockboxes.find((entry) => entry.lockboxID === lockboxDelta.lockboxID)?.count ?? 0;
            if (currentCount < Math.abs(lockboxDelta.delta)) {
                return false;
            }
        }

        for (const field of WALLET_CURRENCY_FIELDS) {
            const amount = Number(delta[field] ?? 0);
            if (amount === 0) {
                continue;
            }

            setWalletFieldValue(character, field, getWalletFieldValue(character, field) + amount);
        }

        for (const lockboxDelta of WalletService.normalizeLockboxDeltas(delta.lockboxes)) {
            const entry = normalizedLockboxes.find((lockbox) => lockbox.lockboxID === lockboxDelta.lockboxID);
            if (entry) {
                entry.count = Math.max(0, normalizeWalletNumber(entry.count) + lockboxDelta.delta);
            } else if (lockboxDelta.delta > 0) {
                normalizedLockboxes.push({ lockboxID: lockboxDelta.lockboxID, count: lockboxDelta.delta });
            }
        }

        character.lockboxes = normalizeLockboxes(normalizedLockboxes);
        return true;
    }

    private static normalizeDelta(delta: WalletDelta): WalletDelta {
        const normalized: WalletDelta = {};
        for (const field of WALLET_CURRENCY_FIELDS) {
            const value = normalizeSignedDelta(delta[field]);
            if (value !== 0) {
                normalized[field] = value;
            }
        }

        const lockboxes = WalletService.normalizeLockboxDeltas(delta.lockboxes);
        if (lockboxes.length > 0) {
            normalized.lockboxes = lockboxes;
        }

        return normalized;
    }

    private static normalizeLockboxDeltas(lockboxes: LockboxDelta[] | undefined): LockboxDelta[] {
        const totals = new Map<number, number>();
        for (const entry of Array.isArray(lockboxes) ? lockboxes : []) {
            const lockboxID = normalizeWalletNumber(entry.lockboxID);
            const delta = normalizeSignedDelta(entry.delta);
            if (lockboxID <= 0 || delta === 0) {
                continue;
            }

            totals.set(lockboxID, (totals.get(lockboxID) ?? 0) + delta);
        }

        return Array.from(totals.entries())
            .filter(([, delta]) => delta !== 0)
            .map(([lockboxID, delta]) => ({ lockboxID, delta }));
    }

    private static hasAnyDelta(delta: WalletDelta): boolean {
        return WALLET_CURRENCY_FIELDS.some((field) => Number(delta[field] ?? 0) !== 0) ||
            (Array.isArray(delta.lockboxes) && delta.lockboxes.length > 0);
    }
}

function normalizeSignedDelta(value: unknown): number {
    const numeric = Number(value ?? 0);
    if (!Number.isFinite(numeric)) {
        return 0;
    }

    return Math.round(numeric);
}
