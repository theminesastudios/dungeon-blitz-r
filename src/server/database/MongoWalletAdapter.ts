import { Collection, Db, MongoClient } from 'mongodb';
import { Character } from './Database';
import {
    createWalletDocument,
    getCharacterNameKey,
    getWalletDocumentId,
    LockboxDelta,
    normalizeWalletDocument,
    normalizeWalletNumber,
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

export class MongoWalletAdapter implements WalletPersistenceAdapter {
    private client: MongoClient | null = null;
    private db: Db | null = null;
    private collection: Collection<WalletDocument> | null = null;

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
        const collection = db.collection<WalletDocument>(this.collectionName);
        await collection.createIndex(
            { gameUserId: 1, characterNameKey: 1 },
            { unique: true, partialFilterExpression: { gameUserId: { $exists: true } } }
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

    private getCollection(): Collection<WalletDocument> {
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
            gold: initialDocument.gold,
            mammothIdols: initialDocument.mammothIdols,
            DragonKeys: initialDocument.DragonKeys,
            dragonOre: initialDocument.dragonOre,
            SilverSigils: initialDocument.SilverSigils,
            RoyalSigils: initialDocument.RoyalSigils,
            lockboxes: initialDocument.lockboxes,
            version: initialDocument.version
        };
        const identityUpdate: Record<string, unknown> = {
            gameUserId: identity.gameUserId,
            characterNameKey,
            characterName: String(character.name ?? '').trim(),
            updatedAt: now
        };

        const result = await this.getCollection().findOneAndUpdate(
            { _id: documentId },
            {
                $setOnInsert: insertOnlyDocument,
                $set: identityUpdate,
                $unset: {
                    userId: '',
                    discordUserId: '',
                    identityProvider: '',
                    createdAt: '',
                    lastUpdated: ''
                }
            },
            {
                upsert: true,
                returnDocument: 'after'
            }
        );

        if (!result) {
            throw new Error(`Mongo wallet upsert returned no document for user ${identity.gameUserId}/${characterNameKey}`);
        }

        return normalizeWalletDocument(result);
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

        return result ? normalizeWalletDocument(result) : null;
    }

    private buildSufficientBalanceFilter(delta: WalletDelta): Record<string, unknown> {
        const filter: Record<string, unknown> = {};
        const lockboxBalanceFilters: Record<string, unknown>[] = [];
        for (const field of WALLET_CURRENCY_FIELDS) {
            const amount = normalizeSignedDelta(delta[field]);
            if (amount < 0) {
                filter[field] = { $gte: Math.abs(amount) };
            }
        }

        for (const lockboxDelta of this.normalizeLockboxDeltas(delta.lockboxes)) {
            if (lockboxDelta.delta < 0) {
                lockboxBalanceFilters.push({
                    lockboxes: {
                        $elemMatch: {
                            lockboxID: lockboxDelta.lockboxID,
                            count: { $gte: Math.abs(lockboxDelta.delta) }
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
            updatedAt: '$$NOW'
        };

        for (const field of WALLET_CURRENCY_FIELDS) {
            const amount = normalizeSignedDelta(delta[field]);
            if (amount === 0) {
                continue;
            }

            setStage[field] = {
                $max: [
                    0,
                    {
                        $add: [
                            { $ifNull: [`$${field}`, 0] },
                            amount
                        ]
                    }
                ]
            };
        }

        const lockboxDeltas = this.normalizeLockboxDeltas(delta.lockboxes);
        if (lockboxDeltas.length > 0) {
            let lockboxesExpression: unknown = { $ifNull: ['$lockboxes', []] };
            for (const lockboxDelta of lockboxDeltas) {
                lockboxesExpression = this.buildLockboxDeltaExpression(lockboxesExpression, lockboxDelta);
            }
            setStage.lockboxes = lockboxesExpression;
        }

        if (Object.keys(setStage).length === 1 && setStage.updatedAt) {
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
                        { $eq: ['$$lockbox.lockboxID', lockboxId] },
                        {
                            lockboxID: '$$lockbox.lockboxID',
                            count: {
                                $max: [
                                    0,
                                    {
                                        $add: [
                                            { $ifNull: ['$$lockbox.count', 0] },
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
                                in: { $eq: ['$$lockbox.lockboxID', lockboxId] }
                            }
                        }
                    },
                    mapped,
                    {
                        $concatArrays: [
                            inputExpression,
                            [{ lockboxID: lockboxId, count: delta }]
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
                        cond: { $gt: ['$$lockbox.count', 0] }
                    }
                },
                sortBy: { lockboxID: 1 }
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
