import * as fs from 'fs/promises';
import * as path from 'path';
import { IDatabase, Character, UserSaveData } from './Database';
import { Config } from '../core/config';

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
        const normalizedCharacters = this.mergeLiveSessionCharacter(
            userId,
            Array.isArray(characters) ? characters : []
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
        const nextCharacters = Array.isArray(characters) ? [...characters] : [];

        try {
            const { GlobalState } = require('../core/GlobalState') as typeof import('../core/GlobalState');
            const liveCharacter = GlobalState.sessionsByUserId.get(userId)?.character;
            if (!liveCharacter) {
                return nextCharacters;
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

    private async readAccounts(): Promise<Array<{ email: string, user_id: number }>> {
        for (const accountsPath of [this.accountsPath, this.legacyAccountsPath]) {
            try {
                const data = await fs.readFile(accountsPath, 'utf8');
                if (!data.trim()) {
                    return [];
                }
                return JSON.parse(data);
            } catch (err: any) {
                if (err.code === 'ENOENT') {
                    continue;
                }
                throw err;
            }
        }

        return [];
    }

    public async getAccountId(email: string): Promise<number | null> {
        const accounts = await this.readAccounts();
        const account = accounts.find(acc => acc.email.toLowerCase() === email.toLowerCase());
        return account ? account.user_id : null;
    }

    public async createAccount(email: string): Promise<number> {
        await this.ensureSavesDir();
        await fs.mkdir(path.dirname(this.accountsPath), { recursive: true });
        
        const accounts = await this.readAccounts();

        // Check if exists
        const existing = accounts.find(acc => acc.email.toLowerCase() === email.toLowerCase());
        if (existing) return existing.user_id;

        // Generate new ID
        const maxId = accounts.length > 0 ? Math.max(...accounts.map(a => a.user_id)) : 0;
        const newId = maxId + 1;

        accounts.push({ email, user_id: newId });
        await fs.writeFile(this.accountsPath, JSON.stringify(accounts, null, 2));

        // Create empty save file
        const saveData: UserSaveData = { user_id: newId, characters: [] };
        await fs.writeFile(path.join(this.savesDir, `${newId}.json`), JSON.stringify(saveData, null, 2));

        return newId;
    }

    public async loadCharacters(userId: number): Promise<Character[]> {
        await JsonAdapter.waitForQueuedSave(path.join(this.savesDir, `${userId}.json`));
        const save = await this.readSaveFile(userId);
        if (!save || !Array.isArray(save.characters)) {
            return [];
        }
        return save.characters;
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
