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
        const savePath = path.join(this.savesDir, `${userId}.json`);
        try {
            const data = await fs.readFile(savePath, 'utf8');
            if (!data.trim()) return [];
            const save: UserSaveData = JSON.parse(data);
            return save.characters;
        } catch (err: any) {
            if (err.code === 'ENOENT') return [];
            // If JSON is invalid, return empty? Or throw?
            // Returning empty might be safer to avoid crash loop, but might lose data if file corrupted.
            // For now, let's just handle potential empty file (which is common corruption or init state).
            if (err instanceof SyntaxError) return []; 
            throw err;
        }
    }

    public async saveCharacters(userId: number, characters: Character[]): Promise<void> {
        await this.ensureSavesDir();
        const savePath = path.join(this.savesDir, `${userId}.json`);
        const saveData: UserSaveData = { user_id: userId, characters };
        await fs.writeFile(savePath, JSON.stringify(saveData, null, 2));
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
