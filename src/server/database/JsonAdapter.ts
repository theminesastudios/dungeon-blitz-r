import * as fs from 'fs/promises';
import * as path from 'path';
import { IDatabase, Character, DiscordAccountProfile, SponsorAccountMetadata, UserAccount, UserSaveData } from './Database';
import { Config } from '../core/config';
import { GameData } from '../core/GameData';
import { normalizeAccountIdentifier, PasswordRecord } from '../auth/PasswordAuth';
import { WalletService } from './WalletService';

export class JsonAdapter implements IDatabase {
    private static readonly renameRetryDelaysMs = [25, 50, 100, 200, 350];
    private static readonly saveQueues = new Map<string, Promise<void>>();
    private static renameFile = (fromPath: string, toPath: string): Promise<void> =>
        fs.rename(fromPath, toPath);
    private accountsPath: string;
    private savesDir: string;
    private legacyAccountsPath: string;
    private legacySavesDir: string;

    constructor() {
        this.accountsPath = path.resolve(Config.DATA_DIR, 'data', 'Accounts.json');
        this.savesDir = path.resolve(Config.DATA_DIR, 'data', 'saves');
        this.legacyAccountsPath = path.resolve(Config.DATA_DIR, 'Accounts.json');
        this.legacySavesDir = path.resolve(Config.DATA_DIR, 'saves');
    }

    private normalizeCharacterName(value: string | null | undefined): string {
        return String(value ?? '').trim().toLowerCase();
    }

    private normalizeCharacterProgress(character: Character | null | undefined): Character | null | undefined {
        if (!character) {
            return character;
        }

        const xp = Math.max(0, Number(character.xp ?? 0));
        const normalizedLevel = GameData.getPlayerLevelFromXp(xp);
        if (Number(character.level ?? 1) !== normalizedLevel) {
            character.level = normalizedLevel;
        }

        return character;
    }

    private async readSaveFile(userId: number): Promise<UserSaveData | null> {
        for (const savePath of [
            path.join(this.savesDir, `${userId}.json`),
            path.join(this.legacySavesDir, `${userId}.json`)
        ]) {
            try {
                const data = await fs.readFile(savePath, 'utf8');
                if (!data.trim()) {
                    return { user_id: userId, characters: [] };
                }
                return JSON.parse(data) as UserSaveData;
            } catch (err: any) {
                if (err.code === 'ENOENT') {
                    continue;
                }
                if (err instanceof SyntaxError) {
                    console.error(`[JsonAdapter] Invalid save JSON at ${savePath}`);
                    return null;
                }
                throw err;
            }
        }

        return null;
    }

    private async ensureSavesDir(): Promise<void> {
        try {
            await fs.mkdir(this.savesDir, { recursive: true });
        } catch (err) {
            // Ignore if exists
        }
    }

    private static delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    private static isRetryableRenameError(err: any): boolean {
        return ['EPERM', 'EBUSY', 'EACCES', 'ENOTEMPTY'].includes(String(err?.code ?? ''));
    }

    private async renameWithRetry(tmpPath: string, savePath: string): Promise<void> {
        for (let attempt = 0; attempt <= JsonAdapter.renameRetryDelaysMs.length; attempt += 1) {
            try {
                await JsonAdapter.renameFile(tmpPath, savePath);
                return;
            } catch (err: any) {
                const delayMs = JsonAdapter.renameRetryDelaysMs[attempt];
                if (!JsonAdapter.isRetryableRenameError(err) || delayMs == null) {
                    throw err;
                }

                await JsonAdapter.delay(delayMs);
            }
        }

        throw new Error(`[JsonAdapter] Failed to rename ${tmpPath} to ${savePath}`);
    }

    private async performSaveCharacters(
        userId: number,
        characters: Character[],
        savePath: string
    ): Promise<void> {
        await this.ensureSavesDir();
        const normalizedCharacters = await WalletService.applyMongoWalletsBeforeJsonSave(
            userId,
            this.mergeLiveSessionCharacter(
                userId,
                Array.isArray(characters) ? characters : []
            )
        );
        const existing = await this.readSaveFile(userId);

        if (
            normalizedCharacters.length === 0 &&
            existing &&
            Array.isArray(existing.characters) &&
            existing.characters.length > 0
        ) {
            console.warn(
                `[JsonAdapter] Refusing to overwrite non-empty save ${savePath} with an empty character list`
            );
            return;
        }

        const saveData: UserSaveData = { user_id: userId, characters: normalizedCharacters };
        const tmpPath = `${savePath}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;

        try {
            await fs.writeFile(tmpPath, JSON.stringify(saveData, null, 2));
            await this.renameWithRetry(tmpPath, savePath);
        } finally {
            await fs.rm(tmpPath, { force: true }).catch(() => undefined);
        }
    }

    private mergeLiveSessionCharacter(userId: number, characters: Character[]): Character[] {
        const nextCharacters = Array.isArray(characters)
            ? characters.map((entry) => this.normalizeCharacterProgress(entry) as Character)
            : [];

        try {
            const { GlobalState } = require('../core/GlobalState') as typeof import('../core/GlobalState');
            const liveSessions = GlobalState.getActiveSessionsByUserId(userId);
            for (const session of liveSessions) {
                const liveCharacter = this.normalizeCharacterProgress(session.character);
                if (!liveCharacter) {
                    continue;
                }

                const normalizedName = this.normalizeCharacterName(liveCharacter?.name);
                const index = nextCharacters.findIndex((entry) =>
                    this.normalizeCharacterName(entry?.name) === normalizedName
                );

                if (index >= 0) {
                    nextCharacters[index] = liveCharacter;
                } else {
                    nextCharacters.push(liveCharacter);
                }
            }
        } catch {
            return nextCharacters;
        }

        return nextCharacters;
    }

    private static async waitForQueuedSave(savePath: string): Promise<void> {
        const pendingSave = JsonAdapter.saveQueues.get(savePath);
        if (!pendingSave) {
            return;
        }

        await pendingSave.catch(() => undefined);
    }

    private normalizeEmailAliases(value: unknown): string[] {
        if (!Array.isArray(value)) {
            return [];
        }

        return Array.from(new Set(
            value
                .map((entry) => normalizeAccountIdentifier(entry))
                .filter((entry) => entry.length > 0)
        ));
    }

    private accountMatchesEmail(account: UserAccount, normalizedEmail: string): boolean {
        if (normalizeAccountIdentifier(account.email) === normalizedEmail) {
            return true;
        }

        return this.normalizeEmailAliases(account.emailAliases).includes(normalizedEmail);
    }

    private normalizeDiscordId(value: unknown): string {
        return String(value ?? '').trim();
    }

    private assertUsableDiscordProfile(discordUser: DiscordAccountProfile): { discordId: string; discordEmail: string } {
        const discordId = this.normalizeDiscordId(discordUser?.id);
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
        const sponsorStatus = String(sponsor.sponsorStatus ?? '').trim() ||
            (sponsorEligible ? 'active' : 'none');

        return {
            ...account,
            isSponsor: sponsorEligible,
            sponsorEligible,
            sponsorStatus,
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
            discordUser.displayName ||
            discordUser.globalName ||
            discordUser.username ||
            ''
        ).trim();
        const sponsorStatus = String(account.sponsorStatus ?? '').trim() || 'unknown';

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
            sponsorStatus,
            sponsorEligible: Boolean(account.sponsorEligible ?? false)
        }, sponsor);
    }

    private async readAccounts(): Promise<UserAccount[]> {
        for (const accountsPath of [this.accountsPath, this.legacyAccountsPath]) {
            try {
                const data = await fs.readFile(accountsPath, 'utf8');
                if (!data.trim()) {
                    return [];
                }
                const parsed = JSON.parse(data);
                if (!Array.isArray(parsed)) {
                    console.error(`[JsonAdapter] Accounts JSON at ${accountsPath} is not an array`);
                    return [];
                }

                return parsed
                    .filter((entry: Partial<UserAccount>) =>
                        typeof entry?.email === 'string' &&
                        Number.isSafeInteger(Number(entry?.user_id)) &&
                        Number(entry?.user_id) > 0
                    )
                    .map((entry: UserAccount) => {
                        const emailAliases = this.normalizeEmailAliases(entry.emailAliases);
                        return {
                            ...entry,
                            email: normalizeAccountIdentifier(entry.email),
                            ...(emailAliases.length > 0 ? { emailAliases } : {}),
                            user_id: Math.round(Number(entry.user_id))
                        };
                    });
            } catch (err: any) {
                if (err.code === 'ENOENT') {
                    continue;
                }
                if (err instanceof SyntaxError) {
                    console.error(`[JsonAdapter] Invalid accounts JSON at ${accountsPath}: ${err.message}`);
                    continue;
                }
                throw err;
            }
        }

        return [];
    }

    public async getAccount(email: string): Promise<UserAccount | null> {
        const normalizedEmail = normalizeAccountIdentifier(email);
        if (!normalizedEmail) {
            return null;
        }

        const accounts = await this.readAccounts();
        return accounts.find(acc => this.accountMatchesEmail(acc, normalizedEmail)) ?? null;
    }

    public async getAccountById(userId: number): Promise<UserAccount | null> {
        const normalizedUserId = Math.max(0, Math.round(Number(userId ?? 0)));
        if (!normalizedUserId) {
            return null;
        }

        const accounts = await this.readAccounts();
        return accounts.find(acc => acc.user_id === normalizedUserId) ?? null;
    }

    public async getAccountId(email: string): Promise<number | null> {
        const account = await this.getAccount(email);
        return account ? account.user_id : null;
    }

    public async findAccountByDiscordId(discordId: string): Promise<UserAccount | null> {
        const normalizedDiscordId = this.normalizeDiscordId(discordId);
        if (!normalizedDiscordId) {
            return null;
        }

        const accounts = await this.readAccounts();
        return accounts.find(acc => this.normalizeDiscordId(acc.discordId) === normalizedDiscordId) ?? null;
    }

    public async linkDiscordToAccount(
        userId: number,
        discordUser: DiscordAccountProfile,
        sponsor?: SponsorAccountMetadata
    ): Promise<UserAccount> {
        await fs.mkdir(path.dirname(this.accountsPath), { recursive: true });

        const normalizedUserId = Math.max(0, Math.round(Number(userId ?? 0)));
        const { discordId } = this.assertUsableDiscordProfile(discordUser);
        if (!normalizedUserId) {
            throw new Error('Cannot link Discord without a game account.');
        }

        const accounts = await this.readAccounts();
        const accountIndex = accounts.findIndex(acc => acc.user_id === normalizedUserId);
        if (accountIndex < 0) {
            throw new Error('Game account not found.');
        }

        const existingDiscordOwner = accounts.find(acc =>
            acc.user_id !== normalizedUserId &&
            this.normalizeDiscordId(acc.discordId) === discordId
        );
        if (existingDiscordOwner) {
            throw new Error('Discord account is already linked to another game account.');
        }

        const existingAccountDiscordId = this.normalizeDiscordId(accounts[accountIndex].discordId);
        if (existingAccountDiscordId && existingAccountDiscordId !== discordId) {
            throw new Error('Game account is already linked to another Discord account.');
        }

        const account = this.applyDiscordProfile(accounts[accountIndex], discordUser, sponsor);
        accounts[accountIndex] = account;
        await fs.writeFile(this.accountsPath, JSON.stringify(accounts, null, 2));
        return account;
    }

    public async createDiscordAccount(
        email: string,
        discordUser: DiscordAccountProfile,
        sponsor?: SponsorAccountMetadata
    ): Promise<UserAccount> {
        await this.ensureSavesDir();
        await fs.mkdir(path.dirname(this.accountsPath), { recursive: true });

        const normalizedEmail = normalizeAccountIdentifier(email);
        const { discordId, discordEmail } = this.assertUsableDiscordProfile(discordUser);
        if (!normalizedEmail) {
            throw new Error('Cannot create Discord account without a generated email.');
        }

        const accounts = await this.readAccounts();
        const existingDiscordIndex = accounts.findIndex(acc => this.normalizeDiscordId(acc.discordId) === discordId);
        if (existingDiscordIndex >= 0) {
            const account = this.applyDiscordProfile(accounts[existingDiscordIndex], discordUser, sponsor);
            accounts[existingDiscordIndex] = account;
            await fs.writeFile(this.accountsPath, JSON.stringify(accounts, null, 2));
            return account;
        }

        const existingEmailOwner = accounts.find(acc => this.accountMatchesEmail(acc, normalizedEmail));
        if (existingEmailOwner) {
            throw new Error('Discord-derived account email is already used by another game account.');
        }

        const maxId = accounts.length > 0 ? Math.max(...accounts.map(a => a.user_id)) : 0;
        const newId = maxId + 1;
        const aliases = discordEmail !== normalizedEmail &&
            !accounts.some(acc => this.accountMatchesEmail(acc, discordEmail))
            ? [discordEmail]
            : [];
        const account = this.applyDiscordProfile({
            email: normalizedEmail,
            ...(aliases.length > 0 ? { emailAliases: aliases } : {}),
            user_id: newId,
            accountSource: 'discord_oauth'
        }, discordUser, sponsor);

        accounts.push(account);
        await fs.writeFile(this.accountsPath, JSON.stringify(accounts, null, 2));

        const saveData: UserSaveData = { user_id: newId, characters: [] };
        await fs.writeFile(path.join(this.savesDir, `${newId}.json`), JSON.stringify(saveData, null, 2));

        return account;
    }

    public async createAccount(email: string, passwordRecord: PasswordRecord): Promise<UserAccount> {
        await this.ensureSavesDir();
        await fs.mkdir(path.dirname(this.accountsPath), { recursive: true });

        const normalizedEmail = normalizeAccountIdentifier(email);
        if (!normalizedEmail) {
            throw new Error('Cannot create account without an email.');
        }

        const accounts = await this.readAccounts();

        const existing = accounts.find(acc => this.accountMatchesEmail(acc, normalizedEmail));
        if (existing) {
            throw new Error('Account already exists.');
        }

        const maxId = accounts.length > 0 ? Math.max(...accounts.map(a => a.user_id)) : 0;
        const newId = maxId + 1;
        const account: UserAccount = {
            email: normalizedEmail,
            user_id: newId,
            ...passwordRecord
        };

        accounts.push(account);
        await fs.writeFile(this.accountsPath, JSON.stringify(accounts, null, 2));

        const saveData: UserSaveData = { user_id: newId, characters: [] };
        await fs.writeFile(path.join(this.savesDir, `${newId}.json`), JSON.stringify(saveData, null, 2));

        return account;
    }

    public async updateAccountPassword(email: string, passwordRecord: PasswordRecord): Promise<UserAccount | null> {
        await fs.mkdir(path.dirname(this.accountsPath), { recursive: true });

        const normalizedEmail = normalizeAccountIdentifier(email);
        if (!normalizedEmail) {
            return null;
        }

        const accounts = await this.readAccounts();
        const index = accounts.findIndex(acc => this.accountMatchesEmail(acc, normalizedEmail));
        if (index < 0) {
            return null;
        }

        const existingAccount = accounts[index] as UserAccount & { password?: unknown };
        const { password: _plaintextPassword, ...safeExistingAccount } = existingAccount;
        const emailAliases = this.normalizeEmailAliases(safeExistingAccount.emailAliases);
        const account: UserAccount = {
            ...safeExistingAccount,
            email: normalizeAccountIdentifier(safeExistingAccount.email) || normalizedEmail,
            ...(emailAliases.length > 0 ? { emailAliases } : {}),
            ...passwordRecord
        };
        accounts[index] = account;
        await fs.writeFile(this.accountsPath, JSON.stringify(accounts, null, 2));
        return account;
    }

    public async loadCharacters(userId: number): Promise<Character[]> {
        await JsonAdapter.waitForQueuedSave(path.join(this.savesDir, `${userId}.json`));
        const save = await this.readSaveFile(userId);
        if (!save || !Array.isArray(save.characters)) {
            return [];
        }
        const characters = save.characters.map((entry) => this.normalizeCharacterProgress(entry) as Character);
        return WalletService.overlayWallets(userId, characters);
    }

    public async loadAllCharacterRecords(): Promise<UserSaveData[]> {
        const records: UserSaveData[] = [];

        try {
            const files = await fs.readdir(this.savesDir);
            for (const file of files) {
                if (!file.endsWith('.json')) {
                    continue;
                }

                try {
                    const data = await fs.readFile(path.join(this.savesDir, file), 'utf8');
                    if (!data.trim()) {
                        continue;
                    }

                    const save = JSON.parse(data) as UserSaveData;
                    if (!Array.isArray(save.characters)) {
                        continue;
                    }

                    records.push(save);
                } catch {
                    continue;
                }
            }
        } catch {
            return [];
        }

        return records;
    }

    public async saveCharacters(userId: number, characters: Character[]): Promise<void> {
        const savePath = path.join(this.savesDir, `${userId}.json`);
        const previousWrite = JsonAdapter.saveQueues.get(savePath) ?? Promise.resolve();
        const currentWrite = previousWrite
            .catch(() => undefined)
            .then(() => this.performSaveCharacters(userId, characters, savePath));

        JsonAdapter.saveQueues.set(savePath, currentWrite);

        try {
            await currentWrite;
        } finally {
            if (JsonAdapter.saveQueues.get(savePath) === currentWrite) {
                JsonAdapter.saveQueues.delete(savePath);
            }
        }
    }

    public async saveCharacterSnapshot(userId: number, character: Character): Promise<Character[]> {
        const characters = await this.loadCharacters(userId);
        const normalizedName = this.normalizeCharacterName(character?.name);
        const index = characters.findIndex((entry) =>
            this.normalizeCharacterName(entry?.name) === normalizedName
        );

        if (index >= 0) {
            characters[index] = character;
        } else {
            characters.push(character);
        }

        await this.saveCharacters(userId, characters);
        return characters;
    }

    public async isCharacterNameTaken(name: string): Promise<boolean> {
         // This is expensive in JSON, but matches Python implementation
         // In real DB, this would be a query.
         // Here we iterate all files.
         const cleanName = name.trim().toLowerCase();
         
         try {
             const files = await fs.readdir(this.savesDir);
             for (const file of files) {
                 if (!file.endsWith('.json')) continue;
                 try {
                    const data = await fs.readFile(path.join(this.savesDir, file), 'utf8');
                    if (!data.trim()) continue;
                    const save: UserSaveData = JSON.parse(data);
                    if (save.characters.some(c => c.name.trim().toLowerCase() === cleanName)) {
                        return true;
                    }
                 } catch (err) {
                     continue;
                 }
             }
         } catch (err) {
             // Directory might not exist yet
         }
         return false;
    }

    public async getAccountIdByCharName(charName: string): Promise<number | null> {
         const cleanName = charName.trim().toLowerCase();
         try {
             const files = await fs.readdir(this.savesDir);
             for (const file of files) {
                 if (!file.endsWith('.json')) continue;
                 try {
                    const data = await fs.readFile(path.join(this.savesDir, file), 'utf8');
                    if (!data.trim()) continue;
                    const save: UserSaveData = JSON.parse(data);
                    if (save.characters.some(c => c.name.trim().toLowerCase() === cleanName)) {
                        return save.user_id;
                    }
                 } catch (err) {
                     continue;
                 }
             }
         } catch (err) {
             // Directory might not exist yet
         }
         return null;
    }
}
