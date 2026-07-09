import { Collection, Db, MongoClient } from 'mongodb';
import { Character } from './Database';
import {
    createWalletDocument,
    getCharacterNameKey,
    getWalletDocumentId,
    LockboxDelta,
    normalizeWalletDocument,
    normalizeWalletNumber,
    WalletCurrencyField,
    WalletDelta,
    WalletDocument,
    WalletOwnerIdentity,
    WALLET_CURRENCY_FIELDS
} from './WalletTypes';

export interface WalletPersistenceAdapter {
    connect(): Promise<void>;
    close(): Promise<void>;
    getOrCreateWallet(identity: WalletOwnerIdentity, character: Character): Promise<WalletDocument>;
    applyDelta(identity: WalletOwnerIdentity, character: Character, delta: WalletDelta): Promise<WalletDocument | null>;
}

type MongoWalletDocument = { _id: string } & Record<string, unknown>;

// Stored field names are shortened to keep wallet documents small in the shared
// minidb collection. Long names remain on the in-process WalletDocument type.
const MONGO_FIELD: Record<WalletCurrencyField, string> = {
    gold: 'g',
    mammothIdols: 'mi',
    DragonKeys: 'dk',
    dragonOre: 'do',
    SilverSigils: 'ss',
    RoyalSigils: 'rs'
};
const F_LOCKBOXES = 'lb';
const F_GAME_USER_ID = 'uid';
const F_CHARACTER_NAME_KEY = 'ck';
const F_CHARACTER_NAME = 'cn';
const F_VERSION = 'v';
const F_UPDATED_AT = 'u';

// Long-named fields written by earlier wallet document versions.
const LEGACY_FIELDS = [
    'userId',
    'discordUserId',
    'identityProvider',
    'createdAt',
    'lastUpdated',
    'gameUserId',
    'characterNameKey',
    'characterName',
    'updatedAt',
    'version',
    'gold',
    'mammothIdols',
    'DragonKeys',
    'dragonOre',
    'SilverSigils',
    'RoyalSigils',
    'lockboxes'
] as const;

function encodeLockboxes(lockboxes: Array<{ lockboxID: number; count: number }>): Array<{ id: number; c: number }> {
    return lockboxes.map(({ lockboxID, count }) => ({ id: lockboxID, c: count }));
}

function decodeWalletDocument(raw: MongoWalletDocument): WalletDocument {
    const rawLockboxes = Array.isArray(raw[F_LOCKBOXES])
        ? raw[F_LOCKBOXES] as unknown[]
        : Array.isArray(raw.lockboxes) ? raw.lockboxes as unknown[] : [];
    const lockboxes = rawLockboxes.map((entry) => {
        const item = entry as Record<string, unknown>;
        return {
            lockboxID: normalizeWalletNumber(item.id ?? item.lockboxID),
            count: normalizeWalletNumber(item.c ?? item.count)
        };
    });

    return normalizeWalletDocument({
        _id: raw._id,
        gameUserId: raw[F_GAME_USER_ID] ?? raw.gameUserId ?? raw.userId,
        characterNameKey: raw[F_CHARACTER_NAME_KEY] ?? raw.characterNameKey,
        characterName: raw[F_CHARACTER_NAME] ?? raw.characterName,
        gold: raw[MONGO_FIELD.gold] ?? raw.gold,
        mammothIdols: raw[MONGO_FIELD.mammothIdols] ?? raw.mammothIdols,
        DragonKeys: raw[MONGO_FIELD.DragonKeys] ?? raw.DragonKeys,
        dragonOre: raw[MONGO_FIELD.dragonOre] ?? raw.dragonOre,
        SilverSigils: raw[MONGO_FIELD.SilverSigils] ?? raw.SilverSigils,
        RoyalSigils: raw[MONGO_FIELD.RoyalSigils] ?? raw.RoyalSigils,
        lockboxes,
        version: raw[F_VERSION] ?? raw.version,
        updatedAt: raw[F_UPDATED_AT] ?? raw.updatedAt
    } as unknown as WalletDocument);
}

export class MongoWalletAdapter implements WalletPersistenceAdapter {
    private client: MongoClient | null = null;
    private db: Db | null = null;
    private collection: Collection<MongoWalletDocument> | null = null;

    constructor(
        private readonly uri: string,
        private readonly dbName: string,
        private readonly collectionName: string
    ) {}

    async connect(): Promise<void> {
        if (this.collection) {
            return;
        }

        if (!this.uri.trim()) {
            throw new Error('MONGODB_URI is required when ENABLE_MONGO_WALLET is active');
        }

        const client = new MongoClient(this.uri, { ignoreUndefined: true });
        await client.connect();
        const db = client.db(this.dbName);
        const collection = db.collection<MongoWalletDocument>(this.collectionName);
        await collection.createIndex(
            { [F_GAME_USER_ID]: 1, [F_CHARACTER_NAME_KEY]: 1 },
            { unique: true, partialFilterExpression: { [F_GAME_USER_ID]: { $exists: true } } }
        );

        this.client = client;
        this.db = db;
        this.collection = collection;
    }

    async close(): Promise<void> {
        const client = this.client;
        this.client = null;
        this.db = null;
        this.collection = null;
        await client?.close();
    }

    private getCollection(): Collection<MongoWalletDocument> {
        if (!this.collection) {
            throw new Error('Mongo wallet adapter is not connected');
        }

        return this.collection;
    }

    async getOrCreateWallet(identity: WalletOwnerIdentity, character: Character): Promise<WalletDocument> {
        const characterNameKey = getCharacterNameKey(character);
        const documentId = getWalletDocumentId(identity, character);
        const now = new Date();
        const initialDocument = createWalletDocument(identity, character);
        const insertOnlyDocument = {
            [MONGO_FIELD.gold]: initialDocument.gold,
            [MONGO_FIELD.mammothIdols]: initialDocument.mammothIdols,
            [MONGO_FIELD.DragonKeys]: initialDocument.DragonKeys,
            [MONGO_FIELD.dragonOre]: initialDocument.dragonOre,
            [MONGO_FIELD.SilverSigils]: initialDocument.SilverSigils,
            [MONGO_FIELD.RoyalSigils]: initialDocument.RoyalSigils,
            [F_LOCKBOXES]: encodeLockboxes(initialDocument.lockboxes),
            [F_VERSION]: initialDocument.version
        };
        const identityUpdate: Record<string, unknown> = {
            [F_GAME_USER_ID]: identity.gameUserId,
            [F_CHARACTER_NAME_KEY]: characterNameKey,
            [F_CHARACTER_NAME]: String(character.name ?? '').trim(),
            [F_UPDATED_AT]: now
        };
        const legacyUnset: Record<string, ''> = {};
        for (const field of LEGACY_FIELDS) {
            legacyUnset[field] = '';
        }

        const result = await this.getCollection().findOneAndUpdate(
            { _id: documentId },
            {
                $setOnInsert: insertOnlyDocument,
                $set: identityUpdate,
                $unset: legacyUnset
            },
            {
                upsert: true,
                returnDocument: 'after'
            }
        );

        if (!result) {
            throw new Error(`Mongo wallet upsert returned no document for user ${identity.gameUserId}/${characterNameKey}`);
        }

        return decodeWalletDocument(result);
    }

    async applyDelta(identity: WalletOwnerIdentity, character: Character, delta: WalletDelta): Promise<WalletDocument | null> {
        const updatePipeline = this.buildDeltaPipeline(delta);
        if (updatePipeline.length === 0) {
            return this.getOrCreateWallet(identity, character);
        }

        const filter: Record<string, unknown> = {
            _id: getWalletDocumentId(identity, character),
            ...this.buildSufficientBalanceFilter(delta)
        };

        const result = await this.getCollection().findOneAndUpdate(
            filter,
            updatePipeline as any,
            { returnDocument: 'after' }
        );

        return result ? decodeWalletDocument(result) : null;
    }

    private buildSufficientBalanceFilter(delta: WalletDelta): Record<string, unknown> {
        const filter: Record<string, unknown> = {};
        const lockboxBalanceFilters: Record<string, unknown>[] = [];
        for (const field of WALLET_CURRENCY_FIELDS) {
            const amount = normalizeSignedDelta(delta[field]);
            if (amount < 0) {
                filter[MONGO_FIELD[field]] = { $gte: Math.abs(amount) };
            }
        }

        for (const lockboxDelta of this.normalizeLockboxDeltas(delta.lockboxes)) {
            if (lockboxDelta.delta < 0) {
                lockboxBalanceFilters.push({
                    [F_LOCKBOXES]: {
                        $elemMatch: {
                            id: lockboxDelta.lockboxID,
                            c: { $gte: Math.abs(lockboxDelta.delta) }
                        }
                    }
                });
            }
        }

        if (lockboxBalanceFilters.length === 1) {
            Object.assign(filter, lockboxBalanceFilters[0]);
        } else if (lockboxBalanceFilters.length > 1) {
            filter.$and = lockboxBalanceFilters;
        }

        return filter;
    }

    private buildDeltaPipeline(delta: WalletDelta): Record<string, unknown>[] {
        const setStage: Record<string, unknown> = {
            [F_UPDATED_AT]: '$$NOW'
        };

        for (const field of WALLET_CURRENCY_FIELDS) {
            const amount = normalizeSignedDelta(delta[field]);
            if (amount === 0) {
                continue;
            }

            setStage[MONGO_FIELD[field]] = {
                $max: [
                    0,
                    {
                        $add: [
                            { $ifNull: [`$${MONGO_FIELD[field]}`, 0] },
                            amount
                        ]
                    }
                ]
            };
        }

        const lockboxDeltas = this.normalizeLockboxDeltas(delta.lockboxes);
        if (lockboxDeltas.length > 0) {
            let lockboxesExpression: unknown = { $ifNull: [`$${F_LOCKBOXES}`, []] };
            for (const lockboxDelta of lockboxDeltas) {
                lockboxesExpression = this.buildLockboxDeltaExpression(lockboxesExpression, lockboxDelta);
            }
            setStage[F_LOCKBOXES] = lockboxesExpression;
        }

        if (Object.keys(setStage).length === 1 && setStage[F_UPDATED_AT]) {
            return [];
        }

        return [{ $set: setStage }];
    }

    private buildLockboxDeltaExpression(inputExpression: unknown, lockboxDelta: LockboxDelta): unknown {
        const lockboxId = normalizeWalletNumber(lockboxDelta.lockboxID);
        const delta = normalizeSignedDelta(lockboxDelta.delta);
        const mapped = {
            $map: {
                input: inputExpression,
                as: 'lockbox',
                in: {
                    $cond: [
                        { $eq: ['$$lockbox.id', lockboxId] },
                        {
                            id: '$$lockbox.id',
                            c: {
                                $max: [
                                    0,
                                    {
                                        $add: [
                                            { $ifNull: ['$$lockbox.c', 0] },
                                            delta
                                        ]
                                    }
                                ]
                            }
                        },
                        '$$lockbox'
                    ]
                }
            }
        };

        const withAddedLockbox = delta > 0
            ? {
                $cond: [
                    {
                        $anyElementTrue: {
                            $map: {
                                input: inputExpression,
                                as: 'lockbox',
                                in: { $eq: ['$$lockbox.id', lockboxId] }
                            }
                        }
                    },
                    mapped,
                    {
                        $concatArrays: [
                            inputExpression,
                            [{ id: lockboxId, c: delta }]
                        ]
                    }
                ]
            }
            : mapped;

        return {
            $sortArray: {
                input: {
                    $filter: {
                        input: withAddedLockbox,
                        as: 'lockbox',
                        cond: { $gt: ['$$lockbox.c', 0] }
                    }
                },
                sortBy: { id: 1 }
            }
        };
    }

    private normalizeLockboxDeltas(lockboxes: LockboxDelta[] | undefined): LockboxDelta[] {
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
}

function normalizeSignedDelta(value: unknown): number {
    const numeric = Number(value ?? 0);
    if (!Number.isFinite(numeric)) {
        return 0;
    }

    return Math.round(numeric);
}
