import { Collection, Document, Filter, MongoClient } from 'mongodb';
import { normalizeAccountIdentifier, PasswordRecord } from '../auth/PasswordAuth';
import {
    Character,
    DiscordAccountProfile,
    IDatabase,
    SponsorAccountMetadata,
    UserAccount,
    UserSaveData
} from './Database';

type MongoAccountDocument = Document & UserAccount & { _id: string; createdAt?: Date; updatedAt?: Date };
type MongoSaveDocument = Document & UserSaveData & { _id: string; createdAt?: Date; updatedAt?: Date };
type MongoCounterDocument = Document & { _id: string; value: number; createdAt?: Date; updatedAt?: Date };

export interface GameDataPersistenceAdapter extends IDatabase {
    connect(): Promise<void>;
    close(): Promise<void>;
    loadAllCharacterRecords(): Promise<UserSaveData[]>;
    loadCharacterRecordsByGuild(guildName: string): Promise<UserSaveData[]>;
    getAccountIdByCharName(charName: string): Promise<number | null>;
}

function normalizeDiscordId(value: unknown): string {
    return String(value ?? '').trim();
}

function normalizeEmailAliases(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }

    return Array.from(new Set(
        value
            .map((entry) => normalizeAccountIdentifier(entry))
            .filter((entry) => entry.length > 0)
    ));
}

function accountFilterByEmail(email: string): Filter<MongoAccountDocument> {
    return { $or: [{ email }, { emailAliases: email }] } as Filter<MongoAccountDocument>;
}

function decodeAccount(raw: MongoAccountDocument | null): UserAccount | null {
    if (!raw) {
        return null;
    }

    const { _id: _mongoId, createdAt: _createdAt, updatedAt: _updatedAt, ...account } = raw;
    const emailAliases = normalizeEmailAliases(account.emailAliases);
    return {
        ...account,
        email: normalizeAccountIdentifier(account.email),
        ...(emailAliases.length > 0 ? { emailAliases } : {}),
        user_id: Math.round(Number(account.user_id))
    } as UserAccount;
}

function decodeSave(raw: MongoSaveDocument | null): UserSaveData | null {
    if (!raw) {
        return null;
    }

    return {
        user_id: Math.round(Number(raw.user_id)),
        characters: Array.isArray(raw.characters) ? raw.characters as Character[] : []
    };
}

export class MongoGameDataAdapter implements GameDataPersistenceAdapter {
    private client: MongoClient | null = null;
    private accounts: Collection<MongoAccountDocument> | null = null;
    private saves: Collection<MongoSaveDocument> | null = null;
    private counters: Collection<MongoCounterDocument> | null = null;
    private connectPromise: Promise<void> | null = null;

    constructor(
        private readonly uri: string,
        private readonly databaseName: string,
        private readonly accountsCollectionName = 'accounts',
        private readonly savesCollectionName = 'saves',
        private readonly countersCollectionName = 'counters'
    ) {}

    public async connect(): Promise<void> {
        if (this.accounts && this.saves && this.counters) {
            return;
        }
        if (this.connectPromise) {
            return this.connectPromise;
        }
        if (!this.uri.trim()) {
            throw new Error('MONGODB_URI is required when Mongo game-data persistence is enabled.');
        }

        const client = new MongoClient(this.uri, { ignoreUndefined: true });
        this.connectPromise = (async () => {
            await client.connect();
            const db = client.db(this.databaseName);
            const accounts = db.collection<MongoAccountDocument>(this.accountsCollectionName);
            const saves = db.collection<MongoSaveDocument>(this.savesCollectionName);
            const counters = db.collection<MongoCounterDocument>(this.countersCollectionName);

            await Promise.all([
                accounts.createIndex({ email: 1 }, { unique: true, name: 'account_email_unique' }),
                accounts.createIndex({ user_id: 1 }, { unique: true, name: 'account_user_id_unique' }),
                accounts.createIndex(
                    { discordId: 1 },
                    { unique: true, sparse: true, name: 'account_discord_id_unique' }
                ),
                saves.createIndex({ user_id: 1 }, { unique: true, name: 'save_user_id_unique' }),
                saves.createIndex({ 'characters.name': 1 }, { name: 'save_character_name' }),
                // Backs loadCharacterRecordsByGuild, which runs on every region change and
                // every guild chat message for guilded players.
                saves.createIndex({ 'characters.guild.name': 1 }, { name: 'save_character_guild_name' })
            ]);

            this.client = client;
            this.accounts = accounts;
            this.saves = saves;
            this.counters = counters;
        })().catch((error) => {
            this.connectPromise = null;
            void client.close().catch(() => undefined);
            throw error;
        });

        return this.connectPromise;
    }

    public async close(): Promise<void> {
        const client = this.client;
        this.client = null;
        this.accounts = null;
        this.saves = null;
        this.counters = null;
        this.connectPromise = null;
        await client?.close();
    }

    private async getCollections(): Promise<{
        accounts: Collection<MongoAccountDocument>;
        saves: Collection<MongoSaveDocument>;
        counters: Collection<MongoCounterDocument>;
    }> {
        await this.connect();
        if (!this.accounts || !this.saves || !this.counters) {
            throw new Error('Mongo game-data collections are not initialized.');
        }
        return { accounts: this.accounts, saves: this.saves, counters: this.counters };
    }

    private assertUsableDiscordProfile(
        discordUser: DiscordAccountProfile
    ): { discordId: string; discordEmail: string } {
        const discordId = normalizeDiscordId(discordUser?.id);
        const discordEmail = normalizeAccountIdentifier(discordUser?.email);
        if (!discordId) {
            throw new Error('Cannot link Discord without a Discord user id.');
        }
        if (!discordEmail || discordUser.emailVerified !== true) {
            throw new Error('Discord account must include a verified email before it can be linked.');
        }
        return { discordId, discordEmail };
    }

    private applySponsorMetadata(account: UserAccount, sponsor?: SponsorAccountMetadata): UserAccount {
        if (!sponsor) {
            return account;
        }

        const sponsorEligible = sponsor.sponsorEligible === true;
        return {
            ...account,
            isSponsor: sponsorEligible,
            sponsorEligible,
            sponsorStatus: String(sponsor.sponsorStatus ?? '').trim() || (sponsorEligible ? 'active' : 'none'),
            sponsorSource: String(sponsor.sponsorSource ?? '').trim() || account.sponsorSource,
            sponsorCheckedAt: String(sponsor.sponsorCheckedAt ?? '').trim() || new Date().toISOString(),
            sponsorRecordId: String(sponsor.sponsorRecordId ?? '').trim() || account.sponsorRecordId
        };
    }

    private applyDiscordProfile(
        account: UserAccount,
        discordUser: DiscordAccountProfile,
        sponsor?: SponsorAccountMetadata
    ): UserAccount {
        const { discordId, discordEmail } = this.assertUsableDiscordProfile(discordUser);
        const displayName = String(
            discordUser.displayName || discordUser.globalName || discordUser.username || ''
        ).trim();
        return this.applySponsorMetadata({
            ...account,
            discordId,
            discordUsername: String(discordUser.username ?? '').trim(),
            discordGlobalName: String(discordUser.globalName ?? '').trim(),
            discordDisplayName: displayName,
            discordEmail,
            discordEmailVerified: true,
            discordAvatar: String(discordUser.avatar ?? '').trim(),
            discordLinkedAt: account.discordLinkedAt || new Date().toISOString(),
            discordSyncRequired: true,
            accountSource: account.accountSource || 'discord_oauth',
            sponsorStatus: String(account.sponsorStatus ?? '').trim() || 'unknown',
            sponsorEligible: Boolean(account.sponsorEligible ?? false)
        }, sponsor);
    }

    private async allocateUserId(): Promise<number> {
        const { accounts, counters } = await this.getCollections();
        const highest = await accounts.find({}, { projection: { user_id: 1 } })
            .sort({ user_id: -1 })
            .limit(1)
            .next();
        const floor = Math.max(0, Math.round(Number(highest?.user_id ?? 0)));
        await counters.updateOne(
            { _id: 'game_user_id' },
            { $max: { value: floor }, $setOnInsert: { createdAt: new Date() } },
            { upsert: true }
        );
        const counter = await counters.findOneAndUpdate(
            { _id: 'game_user_id' },
            { $inc: { value: 1 }, $set: { updatedAt: new Date() } },
            { returnDocument: 'after' }
        );
        const userId = Math.round(Number(counter?.value ?? 0));
        if (!Number.isSafeInteger(userId) || userId <= 0) {
            throw new Error('MongoDB did not allocate a valid game user id.');
        }
        return userId;
    }

    private async insertAccountWithEmptySave(account: UserAccount): Promise<UserAccount> {
        const { accounts, saves } = await this.getCollections();
        const now = new Date();
        const accountDocument: MongoAccountDocument = {
            _id: `user:${account.user_id}`,
            ...account,
            createdAt: now,
            updatedAt: now
        };
        await accounts.insertOne(accountDocument);
        try {
            await saves.insertOne({
                _id: String(account.user_id),
                user_id: account.user_id,
                characters: [],
                createdAt: now,
                updatedAt: now
            });
        } catch (error) {
            await accounts.deleteOne({ _id: accountDocument._id });
            throw error;
        }
        return account;
    }

    public async getAccount(email: string): Promise<UserAccount | null> {
        const normalizedEmail = normalizeAccountIdentifier(email);
        if (!normalizedEmail) {
            return null;
        }
        const { accounts } = await this.getCollections();
        return decodeAccount(await accounts.findOne(accountFilterByEmail(normalizedEmail)));
    }

    public async getAccountById(userId: number): Promise<UserAccount | null> {
        const normalizedUserId = Math.max(0, Math.round(Number(userId ?? 0)));
        if (!normalizedUserId) {
            return null;
        }
        const { accounts } = await this.getCollections();
        return decodeAccount(await accounts.findOne({ user_id: normalizedUserId }));
    }

    public async getAccountId(email: string): Promise<number | null> {
        const account = await this.getAccount(email);
        return account?.user_id ?? null;
    }

    public async findAccountByDiscordId(discordId: string): Promise<UserAccount | null> {
        const normalizedDiscordId = normalizeDiscordId(discordId);
        if (!normalizedDiscordId) {
            return null;
        }
        const { accounts } = await this.getCollections();
        return decodeAccount(await accounts.findOne({ discordId: normalizedDiscordId }));
    }

    public async linkDiscordToAccount(
        userId: number,
        discordUser: DiscordAccountProfile,
        sponsor?: SponsorAccountMetadata
    ): Promise<UserAccount> {
        const normalizedUserId = Math.max(0, Math.round(Number(userId ?? 0)));
        const { discordId } = this.assertUsableDiscordProfile(discordUser);
        if (!normalizedUserId) {
            throw new Error('Cannot link Discord without a game account.');
        }
        const { accounts } = await this.getCollections();
        const raw = await accounts.findOne({ user_id: normalizedUserId });
        const existing = decodeAccount(raw);
        if (!raw || !existing) {
            throw new Error('Game account not found.');
        }
        const discordOwner = await accounts.findOne({
            discordId,
            user_id: { $ne: normalizedUserId }
        });
        if (discordOwner) {
            throw new Error('Discord account is already linked to another game account.');
        }
        const existingDiscordId = normalizeDiscordId(existing.discordId);
        if (existingDiscordId && existingDiscordId !== discordId) {
            throw new Error('Game account is already linked to another Discord account.');
        }
        const account = this.applyDiscordProfile(existing, discordUser, sponsor);
        await accounts.updateOne(
            { _id: raw._id },
            { $set: { ...account, updatedAt: new Date() } }
        );
        return account;
    }

    public async createDiscordAccount(
        email: string,
        discordUser: DiscordAccountProfile,
        sponsor?: SponsorAccountMetadata
    ): Promise<UserAccount> {
        const normalizedEmail = normalizeAccountIdentifier(email);
        const { discordId, discordEmail } = this.assertUsableDiscordProfile(discordUser);
        if (!normalizedEmail) {
            throw new Error('Cannot create Discord account without a generated email.');
        }
        const { accounts } = await this.getCollections();
        const existingDiscord = await accounts.findOne({ discordId });
        if (existingDiscord) {
            const decoded = decodeAccount(existingDiscord)!;
            const account = this.applyDiscordProfile(decoded, discordUser, sponsor);
            await accounts.updateOne(
                { _id: existingDiscord._id },
                { $set: { ...account, updatedAt: new Date() } }
            );
            return account;
        }
        if (await accounts.findOne(accountFilterByEmail(normalizedEmail))) {
            throw new Error('Discord-derived account email is already used by another game account.');
        }

        const userId = await this.allocateUserId();
        const aliases = discordEmail !== normalizedEmail &&
            !(await accounts.findOne(accountFilterByEmail(discordEmail)))
            ? [discordEmail]
            : [];
        const account = this.applyDiscordProfile({
            email: normalizedEmail,
            ...(aliases.length > 0 ? { emailAliases: aliases } : {}),
            user_id: userId,
            accountSource: 'discord_oauth'
        }, discordUser, sponsor);
        return this.insertAccountWithEmptySave(account);
    }

    public async createAccount(email: string, passwordRecord: PasswordRecord): Promise<UserAccount> {
        const normalizedEmail = normalizeAccountIdentifier(email);
        if (!normalizedEmail) {
            throw new Error('Cannot create account without an email.');
        }
        const { accounts } = await this.getCollections();
        if (await accounts.findOne(accountFilterByEmail(normalizedEmail))) {
            throw new Error('Account already exists.');
        }
        return this.insertAccountWithEmptySave({
            email: normalizedEmail,
            user_id: await this.allocateUserId(),
            ...passwordRecord
        });
    }

    public async updateAccountPassword(
        email: string,
        passwordRecord: PasswordRecord
    ): Promise<UserAccount | null> {
        const normalizedEmail = normalizeAccountIdentifier(email);
        if (!normalizedEmail) {
            return null;
        }
        const { accounts } = await this.getCollections();
        const raw = await accounts.findOneAndUpdate(
            accountFilterByEmail(normalizedEmail),
            {
                $set: { ...passwordRecord, updatedAt: new Date() },
                $unset: { password: '' }
            },
            { returnDocument: 'after' }
        );
        return decodeAccount(raw);
    }

    public async loadCharacters(userId: number): Promise<Character[]> {
        const { saves } = await this.getCollections();
        return decodeSave(await saves.findOne({ user_id: Math.round(Number(userId)) }))?.characters ?? [];
    }

    public async loadAllCharacterRecords(): Promise<UserSaveData[]> {
        const { saves } = await this.getCollections();
        const records = await saves.find({}).toArray();
        return records.map(decodeSave).filter((entry): entry is UserSaveData => Boolean(entry));
    }

    // Guild lookups used to pull the entire saves collection and filter in Node, which put a
    // full-collection scan and decode on the region-change and guild-chat paths. Match on the
    // stored guild name instead; guild names are whitespace-normalized before they are saved,
    // so a case-insensitive exact match is equivalent to the in-process comparison.
    public async loadCharacterRecordsByGuild(guildName: string): Promise<UserSaveData[]> {
        const cleanName = String(guildName ?? '').trim().replace(/\s+/g, ' ');
        if (!cleanName) {
            return [];
        }
        const escaped = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const { saves } = await this.getCollections();
        const records = await saves
            .find({ 'characters.guild.name': { $regex: `^${escaped}$`, $options: 'i' } } as Filter<MongoSaveDocument>)
            .toArray();
        return records.map(decodeSave).filter((entry): entry is UserSaveData => Boolean(entry));
    }

    public async saveCharacters(userId: number, characters: Character[]): Promise<void> {
        const normalizedUserId = Math.round(Number(userId));
        const { saves } = await this.getCollections();
        await saves.updateOne(
            { user_id: normalizedUserId },
            {
                $set: {
                    user_id: normalizedUserId,
                    characters: Array.isArray(characters) ? characters : [],
                    updatedAt: new Date()
                },
                $setOnInsert: {
                    _id: String(normalizedUserId),
                    createdAt: new Date()
                }
            },
            { upsert: true }
        );
    }

    public async isCharacterNameTaken(name: string): Promise<boolean> {
        const cleanName = String(name ?? '').trim();
        if (!cleanName) {
            return false;
        }
        const escaped = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const { saves } = await this.getCollections();
        return Boolean(await saves.findOne(
            { 'characters.name': { $regex: `^${escaped}$`, $options: 'i' } },
            { projection: { _id: 1 } }
        ));
    }

    public async getAccountIdByCharName(charName: string): Promise<number | null> {
        const cleanName = String(charName ?? '').trim();
        if (!cleanName) {
            return null;
        }
        const escaped = cleanName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const { saves } = await this.getCollections();
        const save = await saves.findOne(
            { 'characters.name': { $regex: `^${escaped}$`, $options: 'i' } },
            { projection: { user_id: 1 } }
        );
        return save ? Math.round(Number(save.user_id)) : null;
    }
}
