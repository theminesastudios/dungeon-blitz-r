import { Config } from '../core/config';
import { Character } from './Database';
import { WalletJournal, WalletJournalDeltaEntry, WalletJournalStore } from './WalletJournal';
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

interface PendingGoldGrant {
    identity: WalletOwnerIdentity;
    characterName: string;
    amount: number;
    journalIds: string[];
}

async function resolveWalletOwnerIdentity(gameUserId: number): Promise<WalletOwnerIdentity> {
    return createWalletOwnerIdentity(gameUserId);
}

export class WalletService {
    private static enabled = Boolean(Config.ENABLE_MONGO_WALLET);
    private static initialized = false;
    private static journalSequence = 0;
    private static pendingGoldGrants = new Map<string, PendingGoldGrant>();
    private static flushTimers = new Map<string, NodeJS.Timeout>();
    private static flushPromises = new Map<string, Promise<void>>();
    private static identityResolver: WalletIdentityResolver = resolveWalletOwnerIdentity;
    private static journal: WalletJournalStore = new WalletJournal();
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
        identityResolver: WalletIdentityResolver = async (gameUserId) => createWalletOwnerIdentity(gameUserId),
        journal: WalletJournalStore = new NoopWalletJournal()
    ): void {
        WalletService.clearFlushTimers();
        WalletService.adapter = adapter;
        WalletService.enabled = enabled;
        WalletService.initialized = !enabled;
        WalletService.identityResolver = identityResolver;
        WalletService.journal = journal;
        WalletService.pendingGoldGrants.clear();
        WalletService.flushPromises.clear();
    }

    static async initialize(): Promise<void> {
        if (!WalletService.enabled || WalletService.initialized) {
            return;
        }

        await WalletService.adapter.connect();
        await WalletService.replayJournal();
        WalletService.initialized = true;
        console.log(
            `[Wallet] Mongo wallet enabled db=${Config.MONGODB_DB_NAME} collection=${Config.MONGODB_WALLET_COLLECTION}`
        );
    }

    static async close(): Promise<void> {
        await WalletService.flushAllPending();
        WalletService.clearFlushTimers();
        await WalletService.adapter.close();
        WalletService.initialized = false;
    }

    static async overlayWallet(userId: number, character: Character | null | undefined): Promise<void> {
        if (!WalletService.enabled || !character) {
            return;
        }

        const identity = await WalletService.resolveIdentity(userId);
        await WalletService.flushPendingGoldGrant(identity, character);
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
        await Promise.all(characters.map(async (character) => {
            const identity = await WalletService.resolveIdentity(userId);
            await WalletService.flushPendingGoldGrant(identity, character);
        }));
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
        if (WalletService.isBufferableGoldGrant(normalizedDelta)) {
            return WalletService.bufferGoldGrant(client.character, identity, normalizeWalletNumber(normalizedDelta.gold));
        }

        await WalletService.flushPendingGoldGrant(identity, client.character);
        await WalletService.adapter.getOrCreateWallet(identity, client.character);
        const wallet = await WalletService.adapter.applyDelta(identity, client.character, normalizedDelta);
        if (!wallet) {
            await WalletService.overlayWallet(client.userId, client.character);
            return false;
        }

        applyWalletSnapshot(client.character, wallet);
        return true;
    }

    static async flushWallet(client: WalletClient): Promise<void> {
        if (!WalletService.enabled || !client.userId || !client.character) {
            return;
        }

        const identity = await WalletService.resolveIdentity(client.userId);
        await WalletService.flushPendingGoldGrant(identity, client.character);
    }

    static extractCharacterWallet(character: Character): WalletDocument | null {
        if (!character) {
            return null;
        }

        const now = new Date();
        return {
            ...createWalletDocument(createWalletOwnerIdentity(0), character),
            updatedAt: now
        };
    }

    private static async resolveIdentity(userId: number): Promise<WalletOwnerIdentity> {
        return WalletService.identityResolver(normalizeWalletNumber(userId));
    }

    private static async bufferGoldGrant(
        character: Character,
        identity: WalletOwnerIdentity,
        amount: number
    ): Promise<boolean> {
        const normalizedAmount = normalizeWalletNumber(amount);
        if (normalizedAmount <= 0) {
            return true;
        }

        const entry: WalletJournalDeltaEntry = {
            id: WalletService.createJournalId(identity, character),
            gameUserId: identity.gameUserId,
            characterNameKey: String(character.name ?? '').trim().toLowerCase(),
            characterName: String(character.name ?? '').trim(),
            delta: { gold: normalizedAmount },
            createdAt: new Date().toISOString()
        };

        try {
            await WalletService.journal.appendDelta(entry);
        } catch (error) {
            console.warn('[Wallet] Failed to journal buffered gold grant; writing Mongo immediately:', error);
            await WalletService.adapter.getOrCreateWallet(identity, character);
            const wallet = await WalletService.adapter.applyDelta(identity, character, { gold: normalizedAmount });
            if (!wallet) {
                return false;
            }
            applyWalletSnapshot(character, wallet);
            return true;
        }

        setWalletFieldValue(character, 'gold', getWalletFieldValue(character, 'gold') + normalizedAmount);

        const key = WalletService.getPendingKey(identity, character);
        const existing = WalletService.pendingGoldGrants.get(key);
        if (existing) {
            existing.amount += normalizedAmount;
            existing.journalIds.push(entry.id);
        } else {
            WalletService.pendingGoldGrants.set(key, {
                identity,
                characterName: String(character.name ?? '').trim(),
                amount: normalizedAmount,
                journalIds: [entry.id]
            });
        }

        WalletService.scheduleGoldFlush(key);
        return true;
    }

    private static async flushPendingGoldGrant(
        identity: WalletOwnerIdentity,
        character: Character
    ): Promise<void> {
        const key = WalletService.getPendingKey(identity, character);
        const activeFlush = WalletService.flushPromises.get(key);
        if (activeFlush) {
            await activeFlush;
            return;
        }

        const flushPromise = WalletService.flushPendingGoldGrantUnlocked(key, character)
            .finally(() => WalletService.flushPromises.delete(key));
        WalletService.flushPromises.set(key, flushPromise);
        await flushPromise;
    }

    private static async flushPendingGoldGrantUnlocked(key: string, character?: Character): Promise<void> {
        WalletService.clearFlushTimer(key);
        const pending = WalletService.pendingGoldGrants.get(key);
        if (!pending || pending.amount <= 0) {
            return;
        }
        WalletService.pendingGoldGrants.delete(key);
        const flushSnapshot: PendingGoldGrant = {
            identity: pending.identity,
            characterName: pending.characterName,
            amount: pending.amount,
            journalIds: [...pending.journalIds]
        };

        try {
            const flushCharacter = character ?? WalletService.createJournalCharacter(flushSnapshot.characterName);
            await WalletService.adapter.getOrCreateWallet(flushSnapshot.identity, flushCharacter);
            const wallet = await WalletService.adapter.applyDelta(flushSnapshot.identity, flushCharacter, { gold: flushSnapshot.amount });
            if (!wallet) {
                throw new Error(`Failed to flush buffered gold grant for ${key}`);
            }

            await WalletService.journal.markFlushed(flushSnapshot.journalIds);
            if (character) {
                applyWalletSnapshot(character, wallet);
            }
        } catch (error) {
            WalletService.mergePendingGoldGrant(key, flushSnapshot);
            throw error;
        }
    }

    private static async flushAllPending(): Promise<void> {
        for (const activeFlush of Array.from(WalletService.flushPromises.values())) {
            await activeFlush;
        }

        for (const key of Array.from(WalletService.pendingGoldGrants.keys())) {
            const pending = WalletService.pendingGoldGrants.get(key);
            if (!pending) {
                continue;
            }

            await WalletService.flushPendingGoldGrantUnlocked(key, WalletService.createJournalCharacter(pending.characterName));
        }
    }

    private static async replayJournal(): Promise<void> {
        const pendingEntries = await WalletService.journal.loadPending();
        if (pendingEntries.length === 0) {
            return;
        }

        const grouped = new Map<string, PendingGoldGrant>();
        for (const entry of pendingEntries) {
            const identity = createWalletOwnerIdentity(entry.gameUserId);
            const characterName = entry.characterName || entry.characterNameKey;
            const character = WalletService.createJournalCharacter(characterName);
            const key = WalletService.getPendingKey(identity, character);
            const amount = normalizeWalletNumber(entry.delta.gold);
            if (amount <= 0) {
                continue;
            }

            const existing = grouped.get(key);
            if (existing) {
                existing.amount += amount;
                existing.journalIds.push(entry.id);
            } else {
                grouped.set(key, {
                    identity,
                    characterName,
                    amount,
                    journalIds: [entry.id]
                });
            }
        }

        for (const [key, pending] of grouped) {
            WalletService.pendingGoldGrants.set(key, pending);
            await WalletService.flushPendingGoldGrantUnlocked(key, WalletService.createJournalCharacter(pending.characterName));
        }

        console.log(`[Wallet] Replayed ${pendingEntries.length} pending wallet journal entr${pendingEntries.length === 1 ? 'y' : 'ies'}`);
    }

    private static isBufferableGoldGrant(delta: WalletDelta): boolean {
        return normalizeWalletNumber(delta.gold) > 0 &&
            WALLET_CURRENCY_FIELDS.every((field) => field === 'gold' || Number(delta[field] ?? 0) === 0) &&
            (!Array.isArray(delta.lockboxes) || delta.lockboxes.length === 0);
    }

    private static scheduleGoldFlush(key: string): void {
        WalletService.clearFlushTimer(key);
        const timer = setTimeout(() => {
            const pending = WalletService.pendingGoldGrants.get(key);
            if (!pending) {
                return;
            }

            void WalletService.flushPendingGoldGrantUnlocked(
                key,
                WalletService.createJournalCharacter(pending.characterName)
            ).catch((error) => {
                console.warn(`[Wallet] Buffered gold flush failed for ${key}; will retry:`, error);
                WalletService.scheduleGoldFlush(key);
            });
        }, Config.MONGO_WALLET_FLUSH_INTERVAL_MS);
        timer.unref?.();
        WalletService.flushTimers.set(key, timer);
    }

    private static clearFlushTimer(key: string): void {
        const timer = WalletService.flushTimers.get(key);
        if (timer) {
            clearTimeout(timer);
            WalletService.flushTimers.delete(key);
        }
    }

    private static clearFlushTimers(): void {
        for (const key of Array.from(WalletService.flushTimers.keys())) {
            WalletService.clearFlushTimer(key);
        }
    }

    private static getPendingKey(identity: WalletOwnerIdentity, character: Character): string {
        return `${identity.gameUserId}:${String(character.name ?? '').trim().toLowerCase()}`;
    }

    private static mergePendingGoldGrant(key: string, pending: PendingGoldGrant): void {
        const existing = WalletService.pendingGoldGrants.get(key);
        if (existing) {
            existing.amount += pending.amount;
            existing.journalIds.push(...pending.journalIds);
            return;
        }

        WalletService.pendingGoldGrants.set(key, {
            identity: pending.identity,
            characterName: pending.characterName,
            amount: pending.amount,
            journalIds: [...pending.journalIds]
        });
    }

    private static createJournalId(identity: WalletOwnerIdentity, character: Character): string {
        WalletService.journalSequence += 1;
        return `${Date.now()}-${process.pid}-${identity.gameUserId}-${String(character.name ?? '').trim().toLowerCase()}-${WalletService.journalSequence}`;
    }

    private static createJournalCharacter(characterName: string): Character {
        return {
            name: characterName,
            class: '',
            gender: '',
            level: 1,
            gold: 0
        };
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

class NoopWalletJournal implements WalletJournalStore {
    async appendDelta(_entry: WalletJournalDeltaEntry): Promise<void> {}

    async markFlushed(_ids: string[]): Promise<void> {}

    async loadPending(): Promise<WalletJournalDeltaEntry[]> {
        return [];
    }
}

function normalizeSignedDelta(value: unknown): number {
    const numeric = Number(value ?? 0);
    if (!Number.isFinite(numeric)) {
        return 0;
    }

    return Math.round(numeric);
}
