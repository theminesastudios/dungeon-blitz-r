import * as fs from 'fs';
import * as path from 'path';
import { MageGear, PaladinGear, RogueGear } from '../data/runtime';

export class GameData {
    static readonly MONSTER_GOLD_TABLE: number[] = [0, 43, 46, 49, 53, 57, 61, 65, 70, 75, 80, 86, 92, 98, 106, 113, 121, 130, 139, 149, 160, 171, 184, 197, 211, 226, 243, 260, 279, 299, 320, 343, 368, 394, 422, 453, 485, 520, 557, 597, 640, 686, 735, 788, 844, 905, 970, 1040, 1114, 1194, 1280];
    static readonly MONSTER_EXP_TABLE: number[] = [0, 10, 13, 15, 17, 20, 23, 26, 30, 35, 40, 46, 53, 61, 70, 80, 92, 106, 121, 139, 160, 184, 211, 243, 279, 320, 368, 422, 485, 557, 640, 735, 844, 970, 1114, 1280, 1470, 1689, 1940, 2229, 2560, 2941, 3378, 3880, 4457, 5120, 5881, 6756, 7760, 8914, 10240];
    static readonly PLAYER_XP_THRESHOLDS: number[] = [0, 0, 100, 350, 750, 1400, 2400, 3900, 6000, 9000, 13000, 18500, 26000, 36000, 49000, 66000, 88000, 116000, 152000, 198000, 256000, 330000, 424000, 544000, 697000, 893000, 1143000, 1462000, 1869000, 2387000, 3047000, 3420000, 3550000, 3680000, 3810000, 3940000, 4070000, 4100000, 4130000, 4160000, 4190000, 4220000, 4250000, 4280000, 4295000, 4310000, 4325000, 4340000, 4355000, 4367860, 4500000];
    static MOUNT_IDS: { [key: string]: number } = {};
    static CONSUMABLES: any[] = [];
    static CHARMS: any[] = [];
    static DYES: Array<{ id: number; name: string; rarity: string }> = [];
    static ENTTYPES: { [key: string]: any } = {};
    static MATERIALS: any[] = [];
    static MATERIALS_BY_REALM: Record<string, { M: number[]; R: number[]; L: number[] }> = {};
    static GEAR_DATA: { realm_drops: Record<string, number[]>; boss_drops: Record<string, number[]>; global_drops: number[] } = {
        realm_drops: {},
        boss_drops: {},
        global_drops: []
    };
    private static readonly CLASS_GEAR_IDS: Record<string, Set<number>> = {
        paladin: GameData.buildEnumValueSet(PaladinGear),
        rogue: GameData.buildEnumValueSet(RogueGear),
        mage: GameData.buildEnumValueSet(MageGear)
    };

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

        try {
            const dyesPath = path.join(dataDir, 'DyeTypes.json');
            if (fs.existsSync(dyesPath)) {
                const rawDyes = JSON.parse(fs.readFileSync(dyesPath, 'utf-8'));
                GameData.DYES = Object.entries(rawDyes).map(([id, value]) => ({
                    id: Number(id),
                    name: String((value as { name?: string }).name ?? ''),
                    rarity: String((value as { rarity?: string }).rarity ?? 'M')
                }));
                console.log(`[GameData] Loaded ${GameData.DYES.length} dyes.`);
            }
        } catch (err) {
            console.error(`[GameData] Failed to load DyeTypes.json:`, err);
        }

        try {
            const materialsPath = path.join(dataDir, 'Materials.json');
            if (fs.existsSync(materialsPath)) {
                GameData.MATERIALS = JSON.parse(fs.readFileSync(materialsPath, 'utf-8'));
                GameData.MATERIALS_BY_REALM = {};
                for (const material of GameData.MATERIALS) {
                    const realm = String(material.DropRealm || '').trim();
                    const rarity = String(material.Rarity || 'M').trim();
                    const materialId = Number(material.MaterialID || 0);
                    if (!realm || materialId <= 0) {
                        continue;
                    }
                    if (!GameData.MATERIALS_BY_REALM[realm]) {
                        GameData.MATERIALS_BY_REALM[realm] = { M: [], R: [], L: [] };
                    }
                    if (rarity === 'R' || rarity === 'L') {
                        GameData.MATERIALS_BY_REALM[realm][rarity].push(materialId);
                    } else {
                        GameData.MATERIALS_BY_REALM[realm].M.push(materialId);
                    }
                }
                console.log(`[GameData] Loaded ${GameData.MATERIALS.length} materials.`);
            }
        } catch (err) {
            console.error(`[GameData] Failed to load Materials.json:`, err);
        }

        try {
            const gearPath = path.join(dataDir, 'gear_data.json');
            if (fs.existsSync(gearPath)) {
                GameData.GEAR_DATA = JSON.parse(fs.readFileSync(gearPath, 'utf-8'));
                console.log(`[GameData] Loaded gear drop data.`);
            }
        } catch (err) {
            console.error(`[GameData] Failed to load gear_data.json:`, err);
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

    private static normalizeLookupKey(value: string | null | undefined): string {
        return String(value ?? '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
    }

    private static buildEnumValueSet(enumObject: Record<string, string | number>): Set<number> {
        const ids = new Set<number>();
        for (const value of Object.values(enumObject)) {
            if (typeof value === 'number' && Number.isFinite(value)) {
                ids.add(value);
            }
        }
        return ids;
    }

    private static filterGearDropsForClass(dropIds: number[] | undefined, className: string | null | undefined): number[] {
        if (!Array.isArray(dropIds) || dropIds.length === 0) {
            return [];
        }

        const allowedIds = GameData.CLASS_GEAR_IDS[String(className ?? '').trim().toLowerCase()];
        if (!allowedIds) {
            return dropIds.filter((id) => Number.isFinite(Number(id))).map((id) => Number(id));
        }

        return dropIds
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && allowedIds.has(id));
    }

    private static pickRandomGearId(dropIds: number[] | undefined, className: string | null | undefined): number {
        const filtered = GameData.filterGearDropsForClass(dropIds, className);
        if (filtered.length === 0) {
            return 0;
        }
        return filtered[Math.floor(Math.random() * filtered.length)] ?? 0;
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

    static getDyeId(nameOrId: string | number): number {
        const numericId = Number(nameOrId);
        if (Number.isFinite(numericId) && numericId > 0) {
            return Math.round(numericId);
        }

        const lookupKey = GameData.normalizeLookupKey(String(nameOrId));
        if (!lookupKey) {
            return 0;
        }

        const entry = GameData.DYES.find((dye) => GameData.normalizeLookupKey(dye.name) === lookupKey);
        return entry?.id ?? 0;
    }

    static getPlayerLevelFromXp(xp: number): number {
        for (let level = GameData.PLAYER_XP_THRESHOLDS.length - 1; level > 0; level--) {
            if (xp >= GameData.PLAYER_XP_THRESHOLDS[level]) {
                return Math.min(level, 50);
            }
        }
        return 1;
    }

    static calculateNpcGold(entName: string, level: number): number {
        const entType = GameData.getEntType(entName);
        if (!entType) {
            return 0;
        }

        const goldDrop = String(entType.GoldDrop ?? '0').split(',');
        const primaryScalar = Number(goldDrop[0] ?? 0);
        const index = Math.max(0, Math.min(level, GameData.MONSTER_GOLD_TABLE.length - 1));
        const baseGold = GameData.MONSTER_GOLD_TABLE[index];

        const rank = String(entType.EntRank ?? 'Minion');
        let rankMultiplier = 1;
        if (rank === 'Lieutenant') {
            rankMultiplier = 3;
        } else if (rank === 'MiniBoss' || rank === 'Boss') {
            rankMultiplier = 10;
        }

        const lowRoll = primaryScalar * baseGold * 0.5 * rankMultiplier;
        return Math.max(0, Math.floor(lowRoll + (lowRoll * 2 + 1) * Math.random()));
    }

    static calculateNpcExp(entName: string, level: number): number {
        const entType = GameData.getEntType(entName);
        if (!entType) {
            return 0;
        }

        const expMult = Number(entType.ExpMult ?? 1);
        const index = Math.max(0, Math.min(level, GameData.MONSTER_EXP_TABLE.length - 1));
        return Math.round(GameData.MONSTER_EXP_TABLE[index] * expMult);
    }

    static getGearIdForEntity(entName: string, className?: string): number {
        const entType = GameData.getEntType(entName);
        if (!entType) {
            return 0;
        }

        const bossDrops = GameData.GEAR_DATA.boss_drops?.[entName];
        const bossGearId = GameData.pickRandomGearId(bossDrops, className);
        if (bossGearId > 0) {
            return bossGearId;
        }

        const realm = String(entType.Realm ?? '');
        const realmDrops = GameData.GEAR_DATA.realm_drops?.[realm];
        const realmGearId = GameData.pickRandomGearId(realmDrops, className);
        if (realmGearId > 0) {
            return realmGearId;
        }

        const globalDrops = GameData.GEAR_DATA.global_drops;
        const globalGearId = GameData.pickRandomGearId(globalDrops, className);
        if (globalGearId > 0) {
            return globalGearId;
        }

        return 0;
    }

    static getRandomMaterialForRealm(realm: string): number {
        const drops = GameData.MATERIALS_BY_REALM[realm];
        if (!drops) {
            return 0;
        }

        const roll = Math.random();
        if (roll < 0.05 && drops.L.length > 0) {
            return drops.L[Math.floor(Math.random() * drops.L.length)] ?? 0;
        }
        if (roll < 0.30 && drops.R.length > 0) {
            return drops.R[Math.floor(Math.random() * drops.R.length)] ?? 0;
        }
        if (drops.M.length > 0) {
            return drops.M[Math.floor(Math.random() * drops.M.length)] ?? 0;
        }
        return 0;
    }
}
