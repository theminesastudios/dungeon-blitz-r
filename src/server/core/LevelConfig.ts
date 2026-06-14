import * as fs from 'fs';
import * as path from 'path';
import { readJsonFile } from '../utils/JsonFile';

export interface LevelSpec {
    swf: string;
    mapId: number;
    baseId: number;
    isDungeon: boolean;
    isHard: boolean;
}

export interface SpawnPoint {
    x: number;
    y: number;
}

export interface DoorTravelSpec {
    targetLevel: string;
    targetDoorId: number;
}

export interface DoorEntrySpec {
    sourceLevel: string;
    sourceDoorId: number;
    targetLevel: string;
    targetDoorId: number;
    requiredMissions: string;
}

export interface DungeonSafeReturn {
    level: string;
    x: number;
    y: number;
    hasCoord: boolean;
}

export class LevelConfig {
    private static LEVELS: Record<string, LevelSpec> = {};
    private static DOOR_MAP: Map<string, string> = new Map(); // Key: "LevelName_DoorID"
    private static DOOR_TARGETS: Map<string, DoorTravelSpec> = new Map(); // Key: "LevelName_DoorID"
    private static DOOR_ENTRIES_BY_TARGET: Map<string, DoorEntrySpec[]> = new Map(); // Key: "TargetLevel"
    private static DOOR_SPAWNS: Map<string, SpawnPoint> = new Map(); // Key: "LevelName_DoorID"
    private static LEVEL_NAME_CANONICAL: Record<string, string> = {};
    private static LEVEL_NAME_COMPACT_CANONICAL: Record<string, string> = {};
    private static readonly NON_DUNGEON_OVERRIDES = new Set([
        'CraftTown'
    ]);
    private static readonly LEVEL_ALIASES: Record<string, string> = {
        "blackrosemire": "SwampRoadNorth",
        "blackrosemirehard": "SwampRoadNorthHard",
        "goblinkidnappers": "TutorialDungeon",
        "goblinkidnappershard": "TutorialDungeonHard",
        "wolfsend": "NewbieRoad",
        "wolfsendhard": "NewbieRoadHard",
        "newbieroad": "NewbieRoad",
        "newbieroadhard": "NewbieRoadHard"
    };
    private static readonly DOOR_FALLBACKS: Record<string, string> = {
        "NewbieRoad_2": "SwampRoadNorth",
        "NewbieRoadHard_2": "SwampRoadNorthHard",
        "TutorialBoat_2": "NewbieRoad"
    };
    // Hardcoded spawns from Python
    private static DEFAULT_SPAWNS: Record<string, SpawnPoint> = {
        "NewbieRoad": { x: 1421, y: 826 },
        "NewbieRoadHard": { x: 1421, y: 826 },
        "CraftTown": { x: 360, y: 1460 },
        "CraftTownTutorial": { x: -6886, y: 1623 },
        "BridgeTown": { x: 3944, y: 838 },
        "BridgeTownHard": { x: 3944, y: 838 },
        "SwampRoadNorth": { x: 4360, y: 595 },
        "SwampRoadNorthHard": { x: 4360, y: 595 },
        "OldMineMountain": { x: 189, y: 1335 },
        "OldMineMountainHard": { x: 189, y: 1335 },
        "CemeteryHill": { x: 7469, y: 385 },
        "CemeteryHillHard": { x: 7469, y: 385 },
        "EmeraldGlades": { x: -1433, y: -1883 },
        "EmeraldGladesHard": { x: -1433, y: -1883 },
        "Castle": { x: -1280, y: -1941 },
        "CastleHard": { x: -1280, y: -1941 },
        "ShazariDesert": { x: 618, y: 647 },
        "ShazariDesertHard": { x: 618, y: 647 },
        "JadeCity": { x: 10430, y: 1058 },
        "JadeCityHard": { x: 10430, y: 1058 }
    };

    private static readonly DUNGEON_ENTRY_SPAWN_OVERRIDES: Record<string, SpawnPoint> = {
        "OMM_Mission8": { x: 2375, y: 849 },
        "OMM_Mission8Hard": { x: 2375, y: 849 }
    };

    private static readonly DOOR_TARGET_OVERRIDES: Record<string, number> = {
        "SwampRoadNorth_1_SwampRoadConnection": 1,
        "SwampRoadNorthHard_1_SwampRoadConnectionHard": 1,
        "BridgeTown_1_SwampRoadConnection": 2,
        "BridgeTownHard_1_SwampRoadConnectionHard": 2,
        "BridgeTown_3_Castle": 1,
        "BridgeTownHard_3_CastleHard": 1,
        "ShazariDesert_2_JadeCity": 1,
        "ShazariDesertHard_2_JadeCityHard": 1
    };

    private static asLevelRecord(value: any): { name?: string; x?: number; y?: number } {
        if (!value || typeof value !== 'object') {
            return {};
        }
        return value;
    }

    private static copyLevelRecord(value: any): { name: string; x: number; y: number } {
        const record = LevelConfig.asLevelRecord(value);
        return {
            name: String(record.name || ''),
            x: Number(record.x ?? 0),
            y: Number(record.y ?? 0)
        };
    }

    private static isMissingAuthoredSpawn(levelName: string, x: number, y: number): boolean {
        return (
            (levelName === 'CemeteryHill' || levelName === 'CemeteryHillHard') &&
            Math.round(Number(x)) === 0 &&
            Math.round(Number(y)) === 0
        );
    }

    private static hasDefaultSpawn(levelName: string): boolean {
        return Boolean(this.DEFAULT_SPAWNS[levelName]);
    }

    private static getDoorKey(levelName: string, doorId: number): string {
        return `${levelName}_${Math.round(Number(doorId))}`;
    }

    private static getDoorTravelKey(sourceLevelName: string, sourceDoorId: number, targetLevelName: string): string {
        return `${sourceLevelName}_${Math.round(Number(sourceDoorId))}_${targetLevelName}`;
    }

    private static compactLevelLookupKey(levelName: string | null | undefined): string {
        return String(levelName ?? '')
            .trim()
            .replace(/\\/g, '/')
            .replace(/^.*\//, '')
            .replace(/^a_Level_/i, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '');
    }

    private static registerCanonicalLevelName(alias: string | null | undefined, canonical: string): void {
        const raw = String(alias ?? '').trim();
        if (!raw) {
            return;
        }

        const lower = raw.toLowerCase();
        if (!LevelConfig.LEVEL_NAME_CANONICAL[lower]) {
            LevelConfig.LEVEL_NAME_CANONICAL[lower] = canonical;
        }

        const compact = LevelConfig.compactLevelLookupKey(raw);
        if (compact && !LevelConfig.LEVEL_NAME_COMPACT_CANONICAL[compact]) {
            LevelConfig.LEVEL_NAME_COMPACT_CANONICAL[compact] = canonical;
        }
    }

    private static findClientContentPath(dataDir: string, ...segments: string[]): string | null {
        const candidates = [
            path.resolve(dataDir, '..', '..', 'client', 'content', ...segments),
            path.resolve(dataDir, '..', '..', '..', 'client', 'content', ...segments)
        ];

        return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
    }

    private static readXmlTag(block: string, tagName: string): string {
        const match = block.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
        return String(match?.[1] ?? '').trim();
    }

    private static loadDoorTargets(dataDir: string): void {
        LevelConfig.DOOR_TARGETS.clear();
        LevelConfig.DOOR_ENTRIES_BY_TARGET.clear();

        const doorTypesPath = LevelConfig.findClientContentPath(dataDir, 'xml', 'DoorTypes.xml');
        if (!doorTypesPath) {
            console.warn('[LevelConfig] DoorTypes.xml not found; door-aware spawn will use fallback coordinates.');
            return;
        }

        try {
            const xml = fs.readFileSync(doorTypesPath, 'utf8');
            for (const match of xml.matchAll(/<DoorType>([\s\S]*?)<\/DoorType>/gi)) {
                const block = match[1];
                const levelName = LevelConfig.normalizeLevelName(LevelConfig.readXmlTag(block, 'MapName'));
                const targetLevel = LevelConfig.normalizeLevelName(LevelConfig.readXmlTag(block, 'TargetMapName'));
                const doorId = Number(LevelConfig.readXmlTag(block, 'DoorID'));
                const targetDoorId = Number(LevelConfig.readXmlTag(block, 'TargetDoorID'));
                const requiredMissions = LevelConfig.readXmlTag(block, 'RequiredMissions');
                if (
                    !levelName ||
                    !targetLevel ||
                    !Number.isFinite(doorId) ||
                    !Number.isFinite(targetDoorId)
                ) {
                    continue;
                }

                LevelConfig.DOOR_TARGETS.set(
                    LevelConfig.getDoorKey(levelName, doorId),
                    { targetLevel, targetDoorId: Math.round(targetDoorId) }
                );

                const entries = LevelConfig.DOOR_ENTRIES_BY_TARGET.get(targetLevel) ?? [];
                entries.push({
                    sourceLevel: levelName,
                    sourceDoorId: Math.round(doorId),
                    targetLevel,
                    targetDoorId: Math.round(targetDoorId),
                    requiredMissions
                });
                LevelConfig.DOOR_ENTRIES_BY_TARGET.set(targetLevel, entries);
            }
            console.log(`[LevelConfig] Loaded ${LevelConfig.DOOR_TARGETS.size} door target links.`);
        } catch (err) {
            console.error('[LevelConfig] Failed to load DoorTypes.xml:', err);
        }
    }

    private static loadDoorSpawns(dataDir: string): void {
        LevelConfig.DOOR_SPAWNS.clear();

        try {
            const doorSpawnPath = path.join(dataDir, 'door_spawn_map.json');
            const rawSpawns = readJsonFile<Record<string, Record<string, SpawnPoint>>>(doorSpawnPath);
            for (const [rawLevelName, doorSpawns] of Object.entries(rawSpawns)) {
                const levelName = LevelConfig.normalizeLevelName(rawLevelName);
                if (!levelName || !doorSpawns || typeof doorSpawns !== 'object') {
                    continue;
                }

                for (const [rawDoorId, spawn] of Object.entries(doorSpawns)) {
                    const doorId = Number(rawDoorId);
                    const x = Number(spawn?.x);
                    const y = Number(spawn?.y);
                    if (!Number.isFinite(doorId) || !Number.isFinite(x) || !Number.isFinite(y)) {
                        continue;
                    }

                    LevelConfig.DOOR_SPAWNS.set(
                        LevelConfig.getDoorKey(levelName, doorId),
                        { x: Math.round(x), y: Math.round(y) }
                    );
                }
            }
            console.log(`[LevelConfig] Loaded ${LevelConfig.DOOR_SPAWNS.size} door spawn points.`);
        } catch (err) {
            console.error('[LevelConfig] Failed to load door_spawn_map.json:', err);
        }
    }

    static load(dataDir: string) {
        // Load Level Config
        try {
            const levelConfigPath = path.join(dataDir, 'level_config.json');
            const levelData = readJsonFile<Record<string, string>>(levelConfigPath);

            for (const [name, spec] of Object.entries(levelData)) {
                if (typeof spec !== 'string') continue;
                // Format: "LevelsNR.swf/a_Level_NewbieRoad 1 1 false" or "... Hard"
                const parts = spec.split(' ');
                if (parts.length >= 3) {
                    const swf = parts[0]; // e.g., LevelsNR.swf/a_Level_NewbieRoad
                    const mapId = parseInt(parts[1], 10);
                    const baseId = parseInt(parts[2], 10);
                    const isDungeon = parts[3].toLowerCase() === 'true'
                        && !LevelConfig.NON_DUNGEON_OVERRIDES.has(name);
                    const isHard = parts.length > 4 && parts[4] === 'Hard';

                    LevelConfig.LEVELS[name] = { swf, mapId, baseId, isDungeon, isHard };
                    LevelConfig.registerCanonicalLevelName(name, name);
                    LevelConfig.registerCanonicalLevelName(swf, name);
                    LevelConfig.registerCanonicalLevelName(swf.split('/').pop(), name);
                }
            }
            console.log(`[LevelConfig] Loaded ${Object.keys(LevelConfig.LEVELS).length} levels.`);
        } catch (err) {
            console.error(`[LevelConfig] Failed to load level_config.json:`, err);
        }

        // Load Door Map
        try {
            const doorMapPath = path.join(dataDir, 'door_map.json');
            const doorData = readJsonFile<any[]>(doorMapPath);
            
            // Format: [[["CurrentLevel", DoorID], "TargetLevel"], ...]
            if (Array.isArray(doorData)) {
                for (const entry of doorData) {
                    // entry: [ [Level, ID], Target ]
                    const keyPart = entry[0];
                    const target = entry[1];
                    const level = keyPart[0];
                    const doorId = keyPart[1];
                    
                    const key = `${level}_${doorId}`;
                    LevelConfig.DOOR_MAP.set(key, target);
                }
                console.log(`[LevelConfig] Loaded ${LevelConfig.DOOR_MAP.size} doors.`);
            }
        } catch (err) {
             console.error(`[LevelConfig] Failed to load door_map.json:`, err);
        }

        LevelConfig.loadDoorTargets(dataDir);
        LevelConfig.loadDoorSpawns(dataDir);
    }

    static get(levelName: string): LevelSpec {
        return this.LEVELS[levelName] || { swf: "", mapId: 0, baseId: 0, isDungeon: false, isHard: false };
    }

    static has(levelName: string): boolean {
        return Boolean(levelName) && Boolean(this.LEVELS[levelName]);
    }

    static normalizeLevelName(levelName: string | null | undefined): string {
        if (levelName == null) {
            return "";
        }

        const raw = String(levelName).trim();
        if (!raw) {
            return "";
        }

        if (this.LEVELS[raw]) {
            return raw;
        }

        const canonical = this.LEVEL_NAME_CANONICAL[raw.toLowerCase()];
        if (canonical) {
            return canonical;
        }

        const compact = this.compactLevelLookupKey(raw);
        const compactCanonical = this.LEVEL_NAME_COMPACT_CANONICAL[compact];
        if (compactCanonical) {
            return compactCanonical;
        }

        return this.LEVEL_ALIASES[compact] || raw;
    }

    static getSpawn(levelName: string): SpawnPoint {
        // Check hardcoded defaults
        if (this.DEFAULT_SPAWNS[levelName]) {
            return this.DEFAULT_SPAWNS[levelName];
        }
        // Fallback
        return { x: 0, y: 0 };
    }

    static getDungeonEntrySpawnOverride(levelName: string | null | undefined): SpawnPoint | null {
        const normalized = this.normalizeLevelName(levelName);
        if (!normalized) {
            return null;
        }

        return this.DUNGEON_ENTRY_SPAWN_OVERRIDES[normalized] ?? null;
    }

    static getDoorTarget(level: string, doorId: number): string | null {
        // Special Case: 999 -> CraftTown
        if (doorId === 999) return "CraftTown";
        
        const key = `${level}_${doorId}`;
        return this.DOOR_MAP.get(key) || this.DOOR_FALLBACKS[key] || null;
    }

    private static getDoorTravelSpawn(
        currentLevel: string,
        targetLevel: string,
        sourceDoorId: number | null | undefined
    ): SpawnPoint | null {
        const doorId = Number(sourceDoorId);
        if (!currentLevel || !targetLevel || !Number.isFinite(doorId) || doorId < 0) {
            return null;
        }

        const overrideTargetDoorId = LevelConfig.DOOR_TARGET_OVERRIDES[
            LevelConfig.getDoorTravelKey(currentLevel, doorId, targetLevel)
        ];
        const linkedDoor = LevelConfig.DOOR_TARGETS.get(LevelConfig.getDoorKey(currentLevel, doorId));
        const targetDoorId = Number.isFinite(Number(overrideTargetDoorId))
            ? Math.round(Number(overrideTargetDoorId))
            : (
                linkedDoor &&
                LevelConfig.normalizeLevelName(linkedDoor.targetLevel) === targetLevel
                    ? linkedDoor.targetDoorId
                    : 0
            );

        if (!targetDoorId) {
            return null;
        }

        return LevelConfig.DOOR_SPAWNS.get(LevelConfig.getDoorKey(targetLevel, targetDoorId)) ?? null;
    }

    static isDungeonLevel(levelName: string | null | undefined): boolean {
        const normalized = this.normalizeLevelName(levelName);
        if (!normalized) {
            return false;
        }
        return Boolean(this.LEVELS[normalized]?.isDungeon);
    }

    static isPersistentDungeonLevel(levelName: string | null | undefined): boolean {
        const normalized = this.normalizeLevelName(levelName);
        if (!normalized || normalized === 'TutorialBoat') {
            return false;
        }
        return this.isDungeonLevel(normalized);
    }

    static isSaveAllowedLevel(levelName: string | null | undefined): boolean {
        const normalized = this.normalizeLevelName(levelName);
        if (!normalized) {
            return false;
        }
        if (normalized === 'CraftTown') {
            return true;
        }
        return !this.isDungeonLevel(normalized);
    }

    static resolveSafeReturnLevel(
        candidates: Array<string | null | undefined>,
        options?: {
            fallbackLevel?: string;
            excludedLevels?: Array<string | null | undefined>;
        }
    ): string {
        const excludedLevels = new Set(
            (options?.excludedLevels ?? [])
                .map((levelName) => this.normalizeLevelName(levelName))
                .filter((levelName): levelName is string => Boolean(levelName))
        );

        for (const candidate of candidates) {
            const normalized = this.normalizeLevelName(candidate);
            if (!normalized || excludedLevels.has(normalized)) {
                continue;
            }
            if (!this.isSaveAllowedLevel(normalized)) {
                continue;
            }
            return normalized;
        }

        const fallbackLevel = this.normalizeLevelName(options?.fallbackLevel || 'NewbieRoad');
        if (fallbackLevel && !excludedLevels.has(fallbackLevel) && this.isSaveAllowedLevel(fallbackLevel)) {
            return fallbackLevel;
        }

        return 'NewbieRoad';
    }

    static resolveDungeonEntryLevel(
        targetLevelName: string | null | undefined,
        entryLevelName: string | null | undefined,
        char?: any
    ): string {
        const targetLevel = this.normalizeLevelName(targetLevelName);
        if (targetLevel === 'CraftTown') {
            return this.resolveSafeReturnLevel(
                [
                    entryLevelName,
                    char?.PreviousLevel?.name,
                    char?.CurrentLevel?.name
                ],
                {
                    fallbackLevel: 'NewbieRoad',
                    excludedLevels: ['CraftTown']
                }
            );
        }

        if (!targetLevel || !this.isDungeonLevel(targetLevel)) {
            return '';
        }

        return this.normalizeLevelName(entryLevelName) || String(entryLevelName || '');
    }

    static resolveDungeonEntryCoordinates(
        targetLevelName: string | null | undefined,
        entryLevelName: string | null | undefined,
        char?: any
    ): { x: number; y: number; hasCoord: boolean } {
        const targetLevel = this.normalizeLevelName(targetLevelName);
        const entryLevel = this.resolveDungeonEntryLevel(targetLevelName, entryLevelName, char);
        if (!targetLevel || !this.isDungeonLevel(targetLevel) || !entryLevel) {
            return { x: 0, y: 0, hasCoord: false };
        }

        const currentRecord = this.asLevelRecord(char?.CurrentLevel);
        if (
            this.normalizeLevelName(currentRecord.name) === entryLevel &&
            Number.isFinite(currentRecord.x) &&
            Number.isFinite(currentRecord.y) &&
            !this.isMissingAuthoredSpawn(entryLevel, Number(currentRecord.x), Number(currentRecord.y))
        ) {
            return {
                x: Math.round(Number(currentRecord.x)),
                y: Math.round(Number(currentRecord.y)),
                hasCoord: true
            };
        }

        const previousRecord = this.asLevelRecord(char?.PreviousLevel);
        if (
            this.normalizeLevelName(previousRecord.name) === entryLevel &&
            Number.isFinite(previousRecord.x) &&
            Number.isFinite(previousRecord.y) &&
            !this.isMissingAuthoredSpawn(entryLevel, Number(previousRecord.x), Number(previousRecord.y))
        ) {
            return {
                x: Math.round(Number(previousRecord.x)),
                y: Math.round(Number(previousRecord.y)),
                hasCoord: true
            };
        }

        if (this.hasDefaultSpawn(entryLevel)) {
            const spawn = this.getSpawn(entryLevel);
            return { x: Math.round(spawn.x), y: Math.round(spawn.y), hasCoord: true };
        }

        return { x: 0, y: 0, hasCoord: false };
    }

    private static findDoorEntryToLevel(
        targetLevelName: string | null | undefined,
        preferredSourceLevelName?: string | null
    ): DoorEntrySpec | null {
        const targetLevel = this.normalizeLevelName(targetLevelName);
        if (!targetLevel) {
            return null;
        }

        const entries = (this.DOOR_ENTRIES_BY_TARGET.get(targetLevel) ?? [])
            .filter((entry) => this.isSaveAllowedLevel(entry.sourceLevel));
        if (!entries.length) {
            return null;
        }

        const preferredSource = this.normalizeLevelName(preferredSourceLevelName);
        if (preferredSource) {
            const preferred = entries.find((entry) => entry.sourceLevel === preferredSource);
            if (preferred) {
                return preferred;
            }
        }

        return entries.find((entry) => !entry.requiredMissions) ?? entries[0] ?? null;
    }

    private static getDoorSpawn(levelName: string | null | undefined, doorId: number | null | undefined): SpawnPoint | null {
        const level = this.normalizeLevelName(levelName);
        const id = Number(doorId);
        if (!level || !Number.isFinite(id)) {
            return null;
        }

        return this.DOOR_SPAWNS.get(this.getDoorKey(level, Math.round(id))) ?? null;
    }

    private static getSavedCoordinatesForLevel(
        char: any,
        levelName: string
    ): { x: number; y: number; hasCoord: boolean } | null {
        for (const record of [this.asLevelRecord(char?.CurrentLevel), this.asLevelRecord(char?.PreviousLevel)]) {
            if (
                this.normalizeLevelName(record.name) === levelName &&
                Number.isFinite(record.x) &&
                Number.isFinite(record.y) &&
                !this.isMissingAuthoredSpawn(levelName, Number(record.x), Number(record.y))
            ) {
                return {
                    x: Math.round(Number(record.x)),
                    y: Math.round(Number(record.y)),
                    hasCoord: true
                };
            }
        }

        return null;
    }

    static resolveDungeonSafeReturn(
        dungeonLevelName: string | null | undefined,
        entryLevelName: string | null | undefined,
        char?: any,
        entryCoords?: { x?: number; y?: number; hasCoord?: boolean }
    ): DungeonSafeReturn | null {
        const dungeonLevel = this.normalizeLevelName(dungeonLevelName);
        if (!dungeonLevel || !this.isPersistentDungeonLevel(dungeonLevel)) {
            return null;
        }

        const explicitEntryLevel = this.normalizeLevelName(entryLevelName);
        const explicitEntry = explicitEntryLevel && this.isSaveAllowedLevel(explicitEntryLevel)
            ? explicitEntryLevel
            : '';
        const previousLevel = this.normalizeLevelName(char?.PreviousLevel?.name);
        const preferredDoorSource = explicitEntry || (previousLevel && this.isSaveAllowedLevel(previousLevel) ? previousLevel : '');
        const inferredDoorEntry = this.findDoorEntryToLevel(dungeonLevel, preferredDoorSource);
        const safeLevel = this.resolveSafeReturnLevel(
            [
                explicitEntry,
                inferredDoorEntry?.sourceLevel,
                entryLevelName,
                char?.PreviousLevel?.name,
                char?.CurrentLevel?.name
            ],
            { fallbackLevel: dungeonLevel === 'TutorialDungeon' ? 'NewbieRoad' : 'NewbieRoad' }
        );

        const entryX = Number(entryCoords?.x);
        const entryY = Number(entryCoords?.y);
        if (entryCoords?.hasCoord && Number.isFinite(entryX) && Number.isFinite(entryY)) {
            return {
                level: safeLevel,
                x: Math.round(entryX),
                y: Math.round(entryY),
                hasCoord: true
            };
        }

        const savedCoordinates = this.getSavedCoordinatesForLevel(char, safeLevel);
        if (savedCoordinates) {
            return { level: safeLevel, ...savedCoordinates };
        }

        const doorEntry = this.findDoorEntryToLevel(dungeonLevel, safeLevel);
        const doorSpawn = this.getDoorSpawn(doorEntry?.sourceLevel, doorEntry?.sourceDoorId);
        if (doorSpawn) {
            return {
                level: safeLevel,
                x: Math.round(doorSpawn.x),
                y: Math.round(doorSpawn.y),
                hasCoord: true
            };
        }

        if (this.hasDefaultSpawn(safeLevel)) {
            const spawn = this.getSpawn(safeLevel);
            return {
                level: safeLevel,
                x: Math.round(spawn.x),
                y: Math.round(spawn.y),
                hasCoord: true
            };
        }

        return {
            level: safeLevel,
            x: 0,
            y: 0,
            hasCoord: false
        };
    }

    static getSpawnCoordinates(
        char: any,
        currentLevelName: string | null | undefined,
        targetLevelName: string | null | undefined,
        sourceDoorId?: number | null
    ): { x: number; y: number; hasCoord: boolean } {
        const currentLevel = this.normalizeLevelName(currentLevelName);
        const targetLevel = this.normalizeLevelName(targetLevelName);

        if (!targetLevel) {
            return { x: 0, y: 0, hasCoord: false };
        }

        const doorSpawn = currentLevel
            ? this.getDoorTravelSpawn(currentLevel, targetLevel, sourceDoorId)
            : null;
        if (doorSpawn) {
            return { x: Math.round(doorSpawn.x), y: Math.round(doorSpawn.y), hasCoord: true };
        }

        if (targetLevel === 'CraftTownTutorial') {
            const spawn = this.getSpawn(targetLevel);
            return { x: Math.round(spawn.x), y: Math.round(spawn.y), hasCoord: true };
        }

        if (this.isDungeonLevel(targetLevel)) {
            return { x: 0, y: 0, hasCoord: false };
        }

        const currentRecord = this.asLevelRecord(char?.CurrentLevel);
        if (
            this.normalizeLevelName(currentRecord.name) === targetLevel &&
            Number.isFinite(currentRecord.x) &&
            Number.isFinite(currentRecord.y) &&
            !this.isMissingAuthoredSpawn(targetLevel, Number(currentRecord.x), Number(currentRecord.y))
        ) {
            return {
                x: Math.round(Number(currentRecord.x)),
                y: Math.round(Number(currentRecord.y)),
                hasCoord: true
            };
        }

        const previousRecord = this.asLevelRecord(char?.PreviousLevel);
        if (
            this.normalizeLevelName(previousRecord.name) === targetLevel &&
            Number.isFinite(previousRecord.x) &&
            Number.isFinite(previousRecord.y) &&
            !this.isMissingAuthoredSpawn(targetLevel, Number(previousRecord.x), Number(previousRecord.y))
        ) {
            return {
                x: Math.round(Number(previousRecord.x)),
                y: Math.round(Number(previousRecord.y)),
                hasCoord: true
            };
        }

        const spawn = this.getSpawn(targetLevel);
        return { x: Math.round(spawn.x), y: Math.round(spawn.y), hasCoord: true };
    }

    static updateSavedLevelsOnTransfer(
        char: any,
        _oldLevelName: string | null | undefined,
        newLevelName: string | null | undefined,
        newX: number,
        newY: number
    ): void {
        const newLevel = this.normalizeLevelName(newLevelName);
        if (!newLevel || !this.isSaveAllowedLevel(newLevel)) {
            return;
        }

        const currentRecord = this.asLevelRecord(char?.CurrentLevel);
        const previousRecord = this.asLevelRecord(char?.PreviousLevel);
        const currentName = this.normalizeLevelName(currentRecord.name);
        const previousName = this.normalizeLevelName(previousRecord.name);

        if (newLevel === 'CraftTown') {
            let safeFrom: { name: string; x: number; y: number } | null = null;
            if (currentName && this.isSaveAllowedLevel(currentName) && currentName !== 'CraftTown') {
                safeFrom = this.copyLevelRecord(currentRecord);
            } else if (previousName && this.isSaveAllowedLevel(previousName) && previousName !== 'CraftTown') {
                safeFrom = this.copyLevelRecord(previousRecord);
            }

            if (safeFrom) {
                char.PreviousLevel = safeFrom;
            }

            char.CurrentLevel = { name: 'CraftTown', x: Math.round(newX), y: Math.round(newY) };
            return;
        }

        if (currentName && this.isSaveAllowedLevel(currentName) && currentName !== newLevel) {
            char.PreviousLevel = this.copyLevelRecord(currentRecord);
        }

        char.CurrentLevel = { name: newLevel, x: Math.round(newX), y: Math.round(newY) };
    }
}
