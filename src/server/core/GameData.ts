import * as fs from 'fs';
import * as path from 'path';
import { MageGear, PaladinGear, RogueGear } from '../data/runtime';

export class GameData {
    static readonly MONSTER_GOLD_TABLE: number[] = [0, 43, 46, 49, 53, 57, 61, 65, 70, 75, 80, 86, 92, 98, 106, 113, 121, 130, 139, 149, 160, 171, 184, 197, 211, 226, 243, 260, 279, 299, 320, 343, 368, 394, 422, 453, 485, 520, 557, 597, 640, 686, 735, 788, 844, 905, 970, 1040, 1114, 1194, 1280];
    static readonly MONSTER_EXP_TABLE: number[] = [0, 10, 13, 15, 17, 20, 23, 26, 30, 35, 40, 46, 53, 61, 70, 80, 92, 106, 121, 139, 160, 184, 211, 243, 279, 320, 368, 422, 485, 557, 640, 735, 844, 970, 1114, 1280, 1470, 1689, 1940, 2229, 2560, 2941, 3378, 3880, 4457, 5120, 5881, 6756, 7760, 8914, 10240];
    // Mirrors the extracted ActionScript `Entity.EXPERIENCE_TABLE` used by the client.
    static readonly PLAYER_XP_THRESHOLDS: number[] = [
        0, 0, 100, 360, 810, 1490, 2490, 3870, 5690, 8090, 11240,
        15240, 20300, 26660, 34590, 44390, 56390, 71110, 89130, 110910, 137320,
        169320, 207960, 254380, 310270, 377230, 457230, 552910, 666850, 802650, 964180,
        1156180, 1384030, 1654110, 1974210, 2352970, 2800970, 3330170, 3955100, 4692300, 5561610,
        6585610, 7791420, 9210180, 10878580, 12839660, 15143660, 17848920, 21024240, 24749040, 29116900,
        4294967295
    ];
    static MOUNT_IDS: { [key: string]: number } = {};
    static CONSUMABLES: any[] = [];
    static CHARMS: any[] = [];
    static DYES: Array<{ id: number; name: string; rarity: string; color: number | null }> = [];
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
                    rarity: String((value as { rarity?: string }).rarity ?? 'M'),
                    color: Number.isFinite(Number((value as { color?: number | string }).color))
                        ? Number((value as { color?: number | string }).color)
                        : null
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

    private static filterGearDropsForClass(
        dropIds: number[] | undefined,
        className: string | null | undefined,
        excludedGearIds?: Iterable<number>
    ): number[] {
        if (!Array.isArray(dropIds) || dropIds.length === 0) {
            return [];
        }

        const excluded = new Set<number>();
        if (excludedGearIds) {
            for (const gearId of excludedGearIds) {
                const normalized = Number(gearId);
                if (Number.isFinite(normalized) && normalized > 0) {
                    excluded.add(Math.round(normalized));
                }
            }
        }

        const allowedIds = GameData.CLASS_GEAR_IDS[String(className ?? '').trim().toLowerCase()];
        if (!allowedIds) {
            return dropIds
                .map((id) => Number(id))
                .filter((id) => Number.isFinite(id) && !excluded.has(id));
        }

        return dropIds
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id) && allowedIds.has(id) && !excluded.has(id));
    }

    private static pickRandomGearId(
        dropIds: number[] | undefined,
        className: string | null | undefined,
        excludedGearIds?: Iterable<number>
    ): number {
        const filtered = GameData.filterGearDropsForClass(dropIds, className, excludedGearIds);
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

    static getDyeColor(nameOrId: string | number): number | null {
        const dyeId = GameData.getDyeId(nameOrId);
        if (dyeId <= 0) {
            return null;
        }

        return GameData.DYES.find((dye) => dye.id === dyeId)?.color ?? null;
    }

    static getRandomDyeId(allowedRarities?: Iterable<string>): number {
        if (!Array.isArray(GameData.DYES) || GameData.DYES.length === 0) {
            return 0;
        }

        const allowed = new Set<string>();
        if (allowedRarities) {
            for (const rarity of allowedRarities) {
                const normalized = String(rarity ?? '').trim().toUpperCase();
                if (normalized) {
                    allowed.add(normalized);
                }
            }
        }

        const pool = allowed.size > 0
            ? GameData.DYES.filter((dye) => allowed.has(String(dye.rarity).toUpperCase()))
            : GameData.DYES;
        return pool[Math.floor(Math.random() * pool.length)]?.id ?? 0;
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

    static getGearIdForEntity(entName: string, className?: string, excludedGearIds?: Iterable<number>): number {
        const entType = GameData.getEntType(entName);
        if (!entType) {
            return 0;
        }

        const bossDrops = GameData.GEAR_DATA.boss_drops?.[entName];
        const bossGearId = GameData.pickRandomGearId(bossDrops, className, excludedGearIds);
        if (bossGearId > 0) {
            return bossGearId;
        }

        const realm = String(entType.Realm ?? '');
        const realmDrops = GameData.GEAR_DATA.realm_drops?.[realm];
        const realmGearId = GameData.pickRandomGearId(realmDrops, className, excludedGearIds);
        if (realmGearId > 0) {
            return realmGearId;
        }

        const globalDrops = GameData.GEAR_DATA.global_drops;
        const globalGearId = GameData.pickRandomGearId(globalDrops, className, excludedGearIds);
        if (globalGearId > 0) {
            return globalGearId;
        }

        return 0;
    }

    static getRandomMaterialForRealm(realm: string, allowedRarities?: Iterable<string>): number {
        const drops = GameData.MATERIALS_BY_REALM[realm];
        if (!drops) {
            return 0;
        }

        const allowed = new Set<string>();
        if (allowedRarities) {
            for (const rarity of allowedRarities) {
                const normalized = String(rarity ?? '').trim().toUpperCase();
                if (normalized) {
                    allowed.add(normalized);
                }
            }
        }

        const pool: number[] = [];
        if (!allowed.size || allowed.has('M')) {
            pool.push(...drops.M);
        }
        if (!allowed.size || allowed.has('R')) {
            pool.push(...drops.R);
        }
        if (!allowed.size || allowed.has('L')) {
            pool.push(...drops.L);
        }

        if (pool.length > 0) {
            return pool[Math.floor(Math.random() * pool.length)] ?? 0;
        }

        return 0;
    }
}
