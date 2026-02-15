import * as fs from 'fs';
import * as path from 'path';

export class GameData {
    static MOUNT_IDS: { [key: string]: number } = {};
    static CONSUMABLES: any[] = [];
    static CHARMS: any[] = [];
    static ENTTYPES: { [key: string]: any } = {};

    static load(dataDir: string) {
        // EntTypes
        try {
            const entPath = path.join(dataDir, 'EntTypes.json');
            if (fs.existsSync(entPath)) {
                const data = JSON.parse(fs.readFileSync(entPath, 'utf-8'));
                const rawList = data.EntTypes?.EntType || [];
                const rawDict: { [key: string]: any } = {};
                for (const item of rawList) {
                    rawDict[item.EntName] = item;
                }
                
                // Resolve inheritance
                GameData.ENTTYPES = {};
                for (const name in rawDict) {
                    GameData.ENTTYPES[name] = GameData.resolveEntType(name, rawDict);
                }
                console.log(`[GameData] Loaded ${Object.keys(GameData.ENTTYPES).length} EntTypes.`);
            }
        } catch (err) {
             console.error(`[GameData] Failed to load EntTypes.json:`, err);
        }

        try {
            const mountPath = path.join(dataDir, 'mount_ids.json');
            if (fs.existsSync(mountPath)) {
                GameData.MOUNT_IDS = JSON.parse(fs.readFileSync(mountPath, 'utf-8'));
                console.log(`[GameData] Loaded ${Object.keys(GameData.MOUNT_IDS).length} mounts.`);
            }
        } catch (err) {
            console.error(`[GameData] Failed to load mount_ids.json:`, err);
        }

        try {
            const consumPath = path.join(dataDir, 'ConsumableTypes.json');
            if (fs.existsSync(consumPath)) {
                GameData.CONSUMABLES = JSON.parse(fs.readFileSync(consumPath, 'utf-8'));
                console.log(`[GameData] Loaded ${GameData.CONSUMABLES.length} consumables.`);
            }
        } catch (err) {
            console.error(`[GameData] Failed to load ConsumableTypes.json:`, err);
        }

        try {
            const charmPath = path.join(dataDir, 'Charms.json');
            if (fs.existsSync(charmPath)) {
                GameData.CHARMS = JSON.parse(fs.readFileSync(charmPath, 'utf-8'));
                console.log(`[GameData] Loaded ${GameData.CHARMS.length} charms.`);
            }
        } catch (err) {
            console.error(`[GameData] Failed to load Charms.json:`, err);
        }
    }


    private static resolveEntType(name: string, rawDict: any): any {
        const item = rawDict[name];
        if (!item) return {};
        
        let resolved = {};
        if (item.parent && item.parent !== "none" && rawDict[item.parent]) {
             resolved = GameData.resolveEntType(item.parent, rawDict);
        }
        return { ...resolved, ...item };
    }

    static getEntType(name: string): any {
        return GameData.ENTTYPES[name] || null;
    }

    static getMountId(name: string): number {
        return GameData.MOUNT_IDS[name] || 0;
    }

    static getConsumableId(name: string): number {
        const item = GameData.CONSUMABLES.find(c => c.ConsumableName === name);
        return item ? parseInt(item.ConsumableID) : 0;
    }

    static getCharmId(name: string): number {
        const item = GameData.CHARMS.find(c => c.CharmName === name);
        return item ? parseInt(item.CharmID) : 0;
    }
}
