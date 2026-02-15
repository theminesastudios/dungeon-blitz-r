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
    private static SPAWN_POINTS: Record<string, SpawnPoint> = {}; // We'll hardcode some defaults or parse if available
    private static DOOR_MAP: Map<string, string> = new Map(); // Key: "LevelName_DoorID"

    // Hardcoded spawns from Python
    private static DEFAULT_SPAWNS: Record<string, SpawnPoint> = {
        "NewbieRoad": { x: 1421, y: 826 },
        "CraftTown": { x: 360, y: 1460 },
        "BridgeTown": { x: 3944, y: 838 },
        "SwampRoadNorth": { x: 4360, y: 595 },
        "OldMineMountain": { x: 189, y: 1335 },
        "EmeraldGlades": { x: -1433, y: -1883 },
        "Castle": { x: -1280, y: -1941 },
        "ShazariDesert": { x: 618, y: 647 },
        "JadeCity": { x: 10430, y: 1058 }
    };

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
        return this.DOOR_MAP.get(key) || null;
    }
}
