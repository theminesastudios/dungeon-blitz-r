import * as fs from 'fs/promises';
import * as path from 'path';
import { IDatabase, Character, UserSaveData } from './Database';
import { Config } from '../core/config';

export class JsonAdapter implements IDatabase {
    private accountsPath: string;
    private savesDir: string;

    constructor() {
        // Resolve paths relative to the current working directory of the process
        // or absolute paths. Config.DATA_DIR is '../../server' from src/server/core/Config.ts
        // But when running, we are likely in src/server or root.
        
        // Let's assume we run from src/server for now or fix path resolution.
        this.accountsPath = path.resolve(Config.DATA_DIR, 'Accounts.json');
        this.savesDir = path.resolve(Config.DATA_DIR, 'saves');
    }

    private async readSaveFile(userId: number): Promise<UserSaveData | null> {
        const savePath = path.join(this.savesDir, `${userId}.json`);
        try {
            const data = await fs.readFile(savePath, 'utf8');
            if (!data.trim()) {
                return { user_id: userId, characters: [] };
            }
            return JSON.parse(data) as UserSaveData;
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                return null;
            }
            if (err instanceof SyntaxError) {
                console.error(`[JsonAdapter] Invalid save JSON at ${savePath}`);
                return null;
            }
            throw err;
        }
    }

    private async ensureSavesDir(): Promise<void> {
        try {
            await fs.mkdir(this.savesDir, { recursive: true });
        } catch (err) {
            // Ignore if exists
        }
    }

    private async readAccounts(): Promise<Array<{ email: string, user_id: number }>> {
        try {
            const data = await fs.readFile(this.accountsPath, 'utf8');
            if (!data.trim()) {
                return [];
            }
            return JSON.parse(data);
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                return [];
            }
            throw err;
        }
    }

    public async getAccountId(email: string): Promise<number | null> {
        const accounts = await this.readAccounts();
        const account = accounts.find(acc => acc.email.toLowerCase() === email.toLowerCase());
        return account ? account.user_id : null;
    }

    public async createAccount(email: string): Promise<number> {
        await this.ensureSavesDir();
        
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
        const save = await this.readSaveFile(userId);
        if (!save || !Array.isArray(save.characters)) {
            return [];
        }
        return save.characters;
    }

    public async saveCharacters(userId: number, characters: Character[]): Promise<void> {
        await this.ensureSavesDir();
        const savePath = path.join(this.savesDir, `${userId}.json`);
        const normalizedCharacters = Array.isArray(characters) ? characters : [];
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
            await fs.rename(tmpPath, savePath);
        } finally {
            await fs.rm(tmpPath, { force: true }).catch(() => undefined);
        }
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
