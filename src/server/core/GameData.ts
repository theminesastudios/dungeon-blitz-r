import * as fs from 'fs';
import * as path from 'path';
import { MageGear, PaladinGear, RogueGear } from '../data/runtime';
import { disassemble, parseAbc, parseSwf } from '../scripts/swfPatchUtils';
import type { Instruction } from '../scripts/swfPatchUtils';
import { readJsonFile } from '../utils/JsonFile';
import { LevelConfig } from './LevelConfig';

type GearDropSource = 'boss' | 'realm';

interface GearDropRule {
    gearId: number;
    gearName: string;
    realm: string;
    bossName: string;
    level: number;
}

interface GearDropContext {
    entName: string;
    realm: string;
    currentLevel?: string | null;
}

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
    private static GEAR_DROP_RULES_BY_ID: Record<number, GearDropRule[]> = {};
    private static GEAR_DROP_RULES_LOADED = false;
    private static BOSS_DROP_DUNGEON_BY_SOURCE: Record<string, string> = {};
    private static REALM_DROP_DUNGEON_BY_SOURCE_LEVEL: Record<string, string> = {};
    private static GEAR_DROP_LOCATION_MAPS_LOADED = false;
    private static readonly BOSS_ENTITY_NAME_ALIASES = new Set<string>([
        'AncientDragonDream',
        'DragonDream',
        'DreamDragon',
        'YoungDragonDream',
        'YoungDragonDreamHard'
    ]);
    private static readonly CLASS_GEAR_IDS: Record<string, Set<number>> = {
        paladin: GameData.buildEnumValueSet(PaladinGear),
        rogue: GameData.buildEnumValueSet(RogueGear),
        mage: GameData.buildEnumValueSet(MageGear)
    };

    static load(dataDir: string) {
        try {
            if (!LevelConfig.has('NewbieRoad') && fs.existsSync(path.join(dataDir, 'level_config.json'))) {
                LevelConfig.load(dataDir);
            }
        } catch (err) {
            console.error(`[GameData] Failed to ensure LevelConfig is loaded:`, err);
        }

        // EntTypes
        try {
            const entPath = path.join(dataDir, 'EntTypes.json');
            if (fs.existsSync(entPath)) {
                const data = readJsonFile<any>(entPath);
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
                GameData.MOUNT_IDS = readJsonFile<{ [key: string]: number }>(mountPath);
                console.log(`[GameData] Loaded ${Object.keys(GameData.MOUNT_IDS).length} mounts.`);
            }
        } catch (err) {
            console.error(`[GameData] Failed to load mount_ids.json:`, err);
        }

        try {
            const consumPath = path.join(dataDir, 'ConsumableTypes.json');
            if (fs.existsSync(consumPath)) {
                GameData.CONSUMABLES = readJsonFile<any[]>(consumPath);
                console.log(`[GameData] Loaded ${GameData.CONSUMABLES.length} consumables.`);
            }
        } catch (err) {
            console.error(`[GameData] Failed to load ConsumableTypes.json:`, err);
        }

        try {
            const charmPath = path.join(dataDir, 'Charms.json');
            if (fs.existsSync(charmPath)) {
                GameData.CHARMS = readJsonFile<any[]>(charmPath);
                console.log(`[GameData] Loaded ${GameData.CHARMS.length} charms.`);
            }
        } catch (err) {
            console.error(`[GameData] Failed to load Charms.json:`, err);
        }

        try {
            const dyesPath = path.join(dataDir, 'DyeTypes.json');
            if (fs.existsSync(dyesPath)) {
                const rawDyes = readJsonFile<Record<string, { name?: string; rarity?: string; color?: number | string }>>(dyesPath);
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
                GameData.MATERIALS = readJsonFile<any[]>(materialsPath);
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
                GameData.GEAR_DATA = readJsonFile<{ realm_drops: Record<string, number[]>; boss_drops: Record<string, number[]>; global_drops: number[] }>(gearPath);
                console.log(`[GameData] Loaded gear drop data.`);
            }
        } catch (err) {
            console.error(`[GameData] Failed to load gear_data.json:`, err);
        }

        GameData.loadGearDropRules(dataDir);
        GameData.loadGearDropLocationMaps(dataDir);
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

    private static normalizeEntityDropName(value: string | null | undefined): string {
        return String(value ?? '').trim().replace(/Hard$/i, '');
    }

    private static normalizeDungeonLevelKey(value: string | null | undefined): string {
        const normalized = LevelConfig.normalizeLevelName(value);
        return GameData.normalizeLookupKey(String(normalized || value || '').replace(/Hard$/i, ''));
    }

    private static buildRealmDropLocationKey(realm: string, level: number): string {
        return GameData.normalizeLookupKey(`${realm}${Math.max(0, Math.round(level))}`);
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
        excludedGearIds?: Iterable<number>,
        context?: GearDropContext,
        source?: GearDropSource
    ): number {
        const classFiltered = GameData.filterGearDropsForClass(dropIds, className, excludedGearIds);
        const filtered = source
            ? classFiltered.filter((gearId) => GameData.isGearDropAllowedForSource(gearId, context, source))
            : classFiltered;
        if (filtered.length === 0) {
            return 0;
        }
        return filtered[Math.floor(Math.random() * filtered.length)] ?? 0;
    }

    private static loadGearDropRules(dataDir: string): void {
        GameData.GEAR_DROP_RULES_BY_ID = {};
        GameData.GEAR_DROP_RULES_LOADED = false;

        const xmlPath = GameData.findClientContentPath(dataDir, 'xml', 'GearTypes.xml');
        if (!xmlPath) {
            console.warn('[GameData] GearTypes.xml not found; gear source filtering will use legacy source buckets.');
            return;
        }

        try {
            const xml = fs.readFileSync(xmlPath, 'utf8');
            const gearBlockPattern = /<Gear\s+([^>]*?)>([\s\S]*?)<\/Gear>/g;
            let match: RegExpExecArray | null;

            while ((match = gearBlockPattern.exec(xml)) !== null) {
                const attrs = match[1] ?? '';
                const body = match[2] ?? '';
                const gearId = Number(GameData.getXmlAttribute(attrs, 'GearID') ?? 0);
                if (!Number.isFinite(gearId) || gearId <= 0) {
                    continue;
                }

                const realm = GameData.decodeXmlText(GameData.getXmlTagValue(body, 'Realm'));
                const bossName = GameData.normalizeEntityDropName(GameData.decodeXmlText(GameData.getXmlTagValue(body, 'BossName')));
                const level = Math.max(0, Math.round(Number(GameData.getXmlTagValue(body, 'Level') || 0)));
                if ((!realm && !bossName) || level <= 0) {
                    continue;
                }

                const rule: GearDropRule = {
                    gearId: Math.round(gearId),
                    gearName: GameData.decodeXmlText(GameData.getXmlAttribute(attrs, 'GearName') ?? ''),
                    realm,
                    bossName,
                    level
                };
                const existing = GameData.GEAR_DROP_RULES_BY_ID[rule.gearId] ?? [];
                const key = `${rule.realm}|${rule.bossName}|${rule.level}`;
                if (!existing.some((item) => `${item.realm}|${item.bossName}|${item.level}` === key)) {
                    existing.push(rule);
                    GameData.GEAR_DROP_RULES_BY_ID[rule.gearId] = existing;
                }
            }

            GameData.GEAR_DROP_RULES_LOADED = true;
            console.log(`[GameData] Loaded gear source rules for ${Object.keys(GameData.GEAR_DROP_RULES_BY_ID).length} gear ids.`);
        } catch (err) {
            GameData.GEAR_DROP_RULES_BY_ID = {};
            console.error('[GameData] Failed to load GearTypes.xml source rules:', err);
        }
    }

    private static loadGearDropLocationMaps(dataDir: string): void {
        GameData.BOSS_DROP_DUNGEON_BY_SOURCE = {};
        GameData.REALM_DROP_DUNGEON_BY_SOURCE_LEVEL = {};
        GameData.GEAR_DROP_LOCATION_MAPS_LOADED = false;

        const swfPath = GameData.findClientContentPath(dataDir, 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
        if (!swfPath) {
            console.warn('[GameData] DungeonBlitz.swf not found; gear dungeon filtering will fall back to source rules only.');
            return;
        }

        try {
            const swf = parseSwf(swfPath);
            const abc = parseAbc(swf);
            let bossLocationCount = 0;
            let realmLocationCount = 0;

            for (const methodBody of abc.methodBodies.values()) {
                const code = swf.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
                let instructions: Instruction[];
                try {
                    instructions = disassemble(code, `gear-drop-location:${methodBody.methodIdx}`);
                } catch {
                    continue;
                }

                for (let index = 0; index + 3 < instructions.length; index += 1) {
                    const mapInstruction = instructions[index];
                    const keyInstruction = instructions[index + 1];
                    const levelInstruction = instructions[index + 2];
                    const setInstruction = instructions[index + 3];
                    if (
                        mapInstruction.opcode !== 0x60 ||
                        keyInstruction.opcode !== 0x2c ||
                        levelInstruction.opcode !== 0x2c ||
                        setInstruction.opcode !== 0x61
                    ) {
                        continue;
                    }

                    const mapName = abc.multinameNames[GameData.readInstructionOperand(mapInstruction) ?? -1] ?? '';
                    if (mapName !== 'var_22' && mapName !== 'var_32') {
                        continue;
                    }

                    const sourceKey = abc.stringValues[GameData.readInstructionOperand(keyInstruction) ?? -1] ?? '';
                    const levelName = abc.stringValues[GameData.readInstructionOperand(levelInstruction) ?? -1] ?? '';
                    const dungeonKey = GameData.normalizeDungeonLevelKey(levelName);
                    if (!sourceKey || !dungeonKey) {
                        continue;
                    }

                    if (mapName === 'var_22') {
                        const bossKey = GameData.normalizeLookupKey(GameData.normalizeEntityDropName(sourceKey));
                        if (bossKey && !GameData.BOSS_DROP_DUNGEON_BY_SOURCE[bossKey]) {
                            bossLocationCount += 1;
                        }
                        GameData.BOSS_DROP_DUNGEON_BY_SOURCE[bossKey] = dungeonKey;
                    } else {
                        const realmKey = GameData.normalizeLookupKey(sourceKey);
                        if (realmKey && !GameData.REALM_DROP_DUNGEON_BY_SOURCE_LEVEL[realmKey]) {
                            realmLocationCount += 1;
                        }
                        GameData.REALM_DROP_DUNGEON_BY_SOURCE_LEVEL[realmKey] = dungeonKey;
                    }
                }
            }

            GameData.GEAR_DROP_LOCATION_MAPS_LOADED = bossLocationCount > 0 && realmLocationCount > 0;
            console.log(`[GameData] Loaded ${realmLocationCount} realm and ${bossLocationCount} boss gear drop locations.`);
        } catch (err) {
            GameData.BOSS_DROP_DUNGEON_BY_SOURCE = {};
            GameData.REALM_DROP_DUNGEON_BY_SOURCE_LEVEL = {};
            console.error('[GameData] Failed to load gear drop location maps from DungeonBlitz.swf:', err);
        }
    }

    private static findClientContentPath(dataDir: string, ...segments: string[]): string | null {
        const candidates = [
            path.resolve(dataDir, '..', '..', 'client', 'content', ...segments),
            path.resolve(dataDir, '..', '..', '..', 'client', 'content', ...segments),
            path.resolve(process.cwd(), 'src', 'client', 'content', ...segments),
            path.resolve(process.cwd(), 'client', 'content', ...segments)
        ];

        for (const candidate of candidates) {
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }

        return null;
    }

    private static readInstructionOperand(instruction: Instruction | undefined, operandIndex: number = 0): number | null {
        const value = instruction?.operands?.[operandIndex]?.[1];
        return Number.isFinite(value) ? Number(value) : null;
    }

    private static getXmlAttribute(attrs: string, name: string): string | null {
        const match = attrs.match(new RegExp(`${name}="([^"]*)"`));
        return match?.[1] ?? null;
    }

    private static getXmlTagValue(body: string, tagName: string): string {
        const match = body.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`));
        return String(match?.[1] ?? '').trim();
    }

    private static decodeXmlText(value: string): string {
        return value
            .replace(/&quot;/g, '"')
            .replace(/&apos;/g, "'")
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&amp;/g, '&')
            .trim();
    }

    private static isGearDropAllowedForSource(
        gearId: number,
        context: GearDropContext | undefined,
        source: GearDropSource
    ): boolean {
        if (!context) {
            return false;
        }

        if (!GameData.GEAR_DROP_RULES_LOADED) {
            return true;
        }

        const rules = GameData.GEAR_DROP_RULES_BY_ID[gearId];
        if (!rules?.length) {
            return false;
        }

        if (source === 'boss') {
            const entityKey = GameData.normalizeLookupKey(GameData.normalizeEntityDropName(context.entName));
            return rules.some((rule) => {
                if (!rule.bossName || GameData.normalizeLookupKey(rule.bossName) !== entityKey) {
                    return false;
                }
                return GameData.isGearRuleAllowedInCurrentDungeon(rule, context, source);
            });
        }

        const realmKey = GameData.normalizeLookupKey(context.realm);
        return rules.some((rule) => {
            if (rule.bossName || !rule.realm || GameData.normalizeLookupKey(rule.realm) !== realmKey) {
                return false;
            }
            return GameData.isGearRuleAllowedInCurrentDungeon(rule, context, source);
        });
    }

    private static isGearRuleAllowedInCurrentDungeon(
        rule: GearDropRule,
        context: GearDropContext,
        source: GearDropSource
    ): boolean {
        const currentDungeonKey = GameData.normalizeDungeonLevelKey(context.currentLevel);
        if (!currentDungeonKey) {
            return false;
        }

        const expectedDungeonKey = source === 'boss'
            ? GameData.BOSS_DROP_DUNGEON_BY_SOURCE[GameData.normalizeLookupKey(rule.bossName)]
            : GameData.REALM_DROP_DUNGEON_BY_SOURCE_LEVEL[GameData.buildRealmDropLocationKey(rule.realm, rule.level)];

        if (expectedDungeonKey) {
            return expectedDungeonKey === currentDungeonKey;
        }

        return !GameData.GEAR_DROP_LOCATION_MAPS_LOADED;
    }

    static getEntType(name: string): any {
        return GameData.ENTTYPES[name] || null;
    }

    static getEntityRank(entity: any): string {
        const entityName = String(entity?.name ?? entity?.EntName ?? entity?.entName ?? '').trim();
        const entType = entityName ? GameData.getEntType(entityName) ?? {} : {};
        return String(entity?.entRank ?? entity?.EntRank ?? entType?.EntRank ?? entType?.entRank ?? '').trim();
    }

    static isBossEntity(entity: any): boolean {
        const entityName = String(entity?.name ?? entity?.EntName ?? entity?.entName ?? '').trim();
        const rank = GameData.getEntityRank(entity);
        if (rank === 'Boss' || rank === 'MiniBoss') {
            return true;
        }

        if (entityName && GameData.BOSS_ENTITY_NAME_ALIASES.has(entityName)) {
            return true;
        }

        const baseEntityName = GameData.normalizeEntityDropName(entityName);
        return Boolean(entityName && (GameData.GEAR_DATA.boss_drops?.[entityName] || GameData.GEAR_DATA.boss_drops?.[baseEntityName]));
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

    static getGearIdForEntity(
        entName: string,
        className?: string,
        excludedGearIds?: Iterable<number>,
        currentLevel?: string | null
    ): number {
        const entType = GameData.getEntType(entName);
        if (!entType) {
            return 0;
        }

        const context: GearDropContext = {
            entName,
            realm: String(entType.Realm ?? '').trim(),
            currentLevel
        };

        const baseEntName = GameData.normalizeEntityDropName(entName);
        const bossDrops = GameData.GEAR_DATA.boss_drops?.[entName] ?? GameData.GEAR_DATA.boss_drops?.[baseEntName];
        if (bossDrops) {
            return GameData.pickRandomGearId(bossDrops, className, excludedGearIds, context, 'boss');
        }

        if (String(entType.EntRank ?? '').trim() === 'Boss') {
            return 0;
        }

        const realm = String(entType.Realm ?? '');
        const realmDrops = GameData.GEAR_DATA.realm_drops?.[realm];
        const realmGearId = GameData.pickRandomGearId(realmDrops, className, excludedGearIds, context, 'realm');
        if (realmGearId > 0) {
            return realmGearId;
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
