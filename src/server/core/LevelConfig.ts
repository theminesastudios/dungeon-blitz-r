import * as fs from 'fs';
import * as path from 'path';

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

export class LevelConfig {
    private static LEVELS: Record<string, LevelSpec> = {};
    private static DOOR_MAP: Map<string, string> = new Map(); // Key: "LevelName_DoorID"
    private static LEVEL_NAME_CANONICAL: Record<string, string> = {};
    private static readonly LEVEL_ALIASES: Record<string, string> = {
        "blackrosemire": "SwampRoadNorth",
        "blackrosemirehard": "SwampRoadNorthHard",
        "goblinkidnappers": "GoblinRiverDungeon",
        "goblinkidnappershard": "GoblinRiverDungeonHard",
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
    private static readonly SPECIAL_SPAWNS: Record<string, SpawnPoint> = {
        "SwampRoadNorth_NewbieRoad": { x: 20298, y: 639 },
        "SwampRoadNorthHard_NewbieRoadHard": { x: 20298, y: 639 },
        "SwampRoadConnection_SwampRoadNorth": { x: 193, y: 511 },
        "SwampRoadConnectionHard_SwampRoadNorthHard": { x: 193, y: 511 },
        "EmeraldGlades_OldMineMountain": { x: 18552, y: 4021 },
        "EmeraldGladesHard_OldMineMountainHard": { x: 18552, y: 4021 },
        "SwampRoadNorth_SwampRoadConnection": { x: 325, y: 368 },
        "SwampRoadNorthHard_SwampRoadConnectionHard": { x: 325, y: 368 },
        "BridgeTown_SwampRoadConnection": { x: 10533, y: 461 },
        "BridgeTownHard_SwampRoadConnectionHard": { x: 10533, y: 461 },
        "OldMineMountain_BridgeTown": { x: 16986, y: -296 },
        "OldMineMountainHard_BridgeTownHard": { x: 16986, y: -296 },
        "BridgeTown_BridgeTownHard": { x: 11439, y: 2199 },
        "BridgeTownHard_BridgeTown": { x: 11439, y: 2199 },
        "Castle_BridgeTown": { x: 10566, y: 493 },
        "CastleHard_BridgeTownHard": { x: 10566, y: 493 },
        "ShazariDesert_ShazariDesertHard": { x: 14851, y: 638 },
        "ShazariDesertHard_ShazariDesert": { x: 14851, y: 638 },
        "JadeCity_ShazariDesert": { x: 25857, y: 1298 },
        "JadeCityHard_ShazariDesertHard": { x: 25857, y: 1298 }
    };

    // Hardcoded spawns from Python
    private static DEFAULT_SPAWNS: Record<string, SpawnPoint> = {
        "NewbieRoad": { x: 1421, y: 826 },
        "NewbieRoadHard": { x: 1421, y: 826 },
        "CraftTown": { x: 360, y: 1460 },
        "BridgeTown": { x: 3944, y: 838 },
        "BridgeTownHard": { x: 3944, y: 838 },
        "SwampRoadNorth": { x: 4360, y: 595 },
        "SwampRoadNorthHard": { x: 4360, y: 595 },
        "OldMineMountain": { x: 189, y: 1335 },
        "OldMineMountainHard": { x: 189, y: 1335 },
        "EmeraldGlades": { x: -1433, y: -1883 },
        "EmeraldGladesHard": { x: -1433, y: -1883 },
        "Castle": { x: -1280, y: -1941 },
        "CastleHard": { x: -1280, y: -1941 },
        "ShazariDesert": { x: 618, y: 647 },
        "ShazariDesertHard": { x: 618, y: 647 },
        "JadeCity": { x: 10430, y: 1058 },
        "JadeCityHard": { x: 10430, y: 1058 }
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

    static load(dataDir: string) {
        // Load Level Config
        try {
            const levelConfigPath = path.join(dataDir, 'level_config.json');
            const levelData = JSON.parse(fs.readFileSync(levelConfigPath, 'utf-8'));

            for (const [name, spec] of Object.entries(levelData)) {
                if (typeof spec !== 'string') continue;
                // Format: "LevelsNR.swf/a_Level_NewbieRoad 1 1 false" or "... Hard"
                const parts = spec.split(' ');
                if (parts.length >= 3) {
                    const swf = parts[0]; // e.g., LevelsNR.swf/a_Level_NewbieRoad
                    const mapId = parseInt(parts[1], 10);
                    const baseId = parseInt(parts[2], 10);
                    const isDungeon = parts[3].toLowerCase() === 'true';
                    const isHard = parts.length > 4 && parts[4] === 'Hard';

                    LevelConfig.LEVELS[name] = { swf, mapId, baseId, isDungeon, isHard };
                    LevelConfig.LEVEL_NAME_CANONICAL[name.toLowerCase()] = name;
                }
            }
            console.log(`[LevelConfig] Loaded ${Object.keys(LevelConfig.LEVELS).length} levels.`);
        } catch (err) {
            console.error(`[LevelConfig] Failed to load level_config.json:`, err);
        }

        // Load Door Map
        try {
            const doorMapPath = path.join(dataDir, 'door_map.json');
            const doorData = JSON.parse(fs.readFileSync(doorMapPath, 'utf-8'));
            
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

        const compact = raw.toLowerCase().replace(/[^a-z0-9]+/g, "");
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

    static getDoorTarget(level: string, doorId: number): string | null {
        // Special Case: 999 -> CraftTown
        if (doorId === 999) return "CraftTown";
        
        const key = `${level}_${doorId}`;
        return this.DOOR_MAP.get(key) || this.DOOR_FALLBACKS[key] || null;
    }

    static isDungeonLevel(levelName: string | null | undefined): boolean {
        const normalized = this.normalizeLevelName(levelName);
        if (!normalized) {
            return false;
        }
        return Boolean(this.LEVELS[normalized]?.isDungeon);
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
        if (!targetLevel || !this.isDungeonLevel(targetLevel)) {
            return '';
        }

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

        return this.normalizeLevelName(entryLevelName) || String(entryLevelName || '');
    }

    static getSpawnCoordinates(
        char: any,
        currentLevelName: string | null | undefined,
        targetLevelName: string | null | undefined
    ): { x: number; y: number; hasCoord: boolean } {
        const currentLevel = this.normalizeLevelName(currentLevelName);
        const targetLevel = this.normalizeLevelName(targetLevelName);

        if (!targetLevel) {
            return { x: 0, y: 0, hasCoord: false };
        }

        const special = currentLevel ? this.SPECIAL_SPAWNS[`${currentLevel}_${targetLevel}`] : undefined;
        if (special) {
            return { x: Math.round(special.x), y: Math.round(special.y), hasCoord: true };
        }

        if (this.isDungeonLevel(targetLevel)) {
            return { x: 0, y: 0, hasCoord: false };
        }

        const currentRecord = this.asLevelRecord(char?.CurrentLevel);
        if (
            this.normalizeLevelName(currentRecord.name) === targetLevel &&
            Number.isFinite(currentRecord.x) &&
            Number.isFinite(currentRecord.y)
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
            Number.isFinite(previousRecord.y)
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
