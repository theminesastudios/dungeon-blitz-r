import fs from 'fs';
import path from 'path';

export interface DungeonSpawnEnemy {
    id?: number;
    canonicalId?: number;
    spawnIndex?: number;
    type: string;
    name?: string;
    x: number;
    y: number;
    roomId?: number;
    groupId?: string | null;
    waveId?: string | null;
    triggerId?: string | null;
    level?: number | null;
    requiredForClear?: boolean;
    boss?: boolean;
    miniboss?: boolean;
    roomBoss?: boolean;
    isRoomBoss?: boolean;
    roomBossName?: string;
    displayName?: string;
    scripted?: boolean;
    sourceRoom?: string;
    sourceVar?: string;
    sourceLine?: number;
    sourceSymbolId?: number;
    sourceCharacterId?: number;
    depth?: number;
    spawnKey?: string;
    hp?: number;
    maxHp?: number;
    [key: string]: unknown;
}

export interface DungeonSpawnConfig {
    levelId: string;
    levelName: string;
    dungeonName: string;
    source?: {
        swf?: string;
        levelClass?: string;
        roomClasses?: string[];
        extractor?: string;
    };
    generatedFromScript?: boolean;
    canonicalIdBase?: number;
    enemies: DungeonSpawnEnemy[];
}

type DungeonSpawnNpcDef = Record<string, unknown> & {
    id: number;
    name: string;
    x: number;
    y: number;
    v: number;
    team: number;
    entState: number;
    roomId: number;
};

export class DungeonSpawnLoader {
    private static configsByLevel: Map<string, DungeonSpawnConfig> = new Map();
    private static npcsByLevel: Map<string, DungeonSpawnNpcDef[]> = new Map();

    private static normalizeLevelName(levelName: string | null | undefined): string {
        return String(levelName ?? '').trim();
    }

    private static normalizeNumber(value: unknown, fallback: number = 0): number {
        const numeric = Number(value ?? fallback);
        return Number.isFinite(numeric) ? numeric : fallback;
    }

    private static cloneEnemy(enemy: DungeonSpawnEnemy): DungeonSpawnEnemy {
        return { ...enemy };
    }

    private static cloneConfig(config: DungeonSpawnConfig): DungeonSpawnConfig {
        return {
            ...config,
            source: config.source ? { ...config.source, roomClasses: [...(config.source.roomClasses ?? [])] } : undefined,
            enemies: config.enemies.map((enemy) => this.cloneEnemy(enemy))
        };
    }

    private static cloneNpc(npc: DungeonSpawnNpcDef): DungeonSpawnNpcDef {
        return { ...npc };
    }

    private static validateConfig(file: string, data: any): DungeonSpawnConfig | null {
        const levelName = this.normalizeLevelName(data?.levelName);
        if (!levelName || !Array.isArray(data?.enemies)) {
            console.error(`[DungeonSpawnLoader] Invalid dungeon spawn registry: ${file}`);
            return null;
        }

        const spawnKeys = new Set<string>();
        const canonicalIds = new Set<number>();
        for (const [index, enemy] of data.enemies.entries()) {
            const type = String(enemy?.type ?? enemy?.name ?? '').trim();
            const x = Number(enemy?.x);
            const y = Number(enemy?.y);
            if (!type || !Number.isFinite(x) || !Number.isFinite(y)) {
                console.error(`[DungeonSpawnLoader] Invalid enemy at ${file}#${index}`);
                return null;
            }

            for (const healthField of ['hp', 'maxHp'] as const) {
                if (enemy?.[healthField] === undefined || enemy?.[healthField] === null) {
                    continue;
                }

                const health = Number(enemy[healthField]);
                if (!Number.isFinite(health) || health <= 0) {
                    console.error(`[DungeonSpawnLoader] Invalid ${healthField} at ${file}#${index}`);
                    return null;
                }
            }

            const canonicalId = Math.round(Number(enemy?.canonicalId ?? enemy?.id ?? 0));
            if (canonicalId <= 0 || canonicalIds.has(canonicalId)) {
                console.error(`[DungeonSpawnLoader] Invalid or duplicate canonicalId at ${file}#${index}`);
                return null;
            }
            canonicalIds.add(canonicalId);

            const spawnKey = String(enemy?.spawnKey ?? '').trim();
            if (!spawnKey || spawnKeys.has(spawnKey)) {
                console.error(`[DungeonSpawnLoader] Invalid or duplicate spawnKey at ${file}#${index}`);
                return null;
            }
            spawnKeys.add(spawnKey);
        }

        return {
            ...data,
            levelId: String(data?.levelId ?? ''),
            levelName,
            dungeonName: String(data?.dungeonName ?? levelName),
            generatedFromScript: Boolean(data?.generatedFromScript),
            enemies: data.enemies.map((enemy: DungeonSpawnEnemy) => ({ ...enemy }))
        };
    }

    private static toNpcDef(config: DungeonSpawnConfig, enemy: DungeonSpawnEnemy): DungeonSpawnNpcDef {
        const id = Math.round(this.normalizeNumber(enemy.canonicalId ?? enemy.id));
        const boss = Boolean(enemy.boss);
        const displayName = String(enemy.displayName ?? enemy.roomBossName ?? '').trim();
        const roomBossName = String(enemy.roomBossName ?? displayName).trim();
        return {
            ...enemy,
            id,
            canonicalId: id,
            name: String(enemy.name ?? enemy.type),
            entType: String(enemy.type ?? enemy.name ?? ''),
            x: Math.round(this.normalizeNumber(enemy.x)),
            y: Math.round(this.normalizeNumber(enemy.y)),
            v: 0,
            team: 2,
            entState: 1,
            roomId: Math.round(this.normalizeNumber(enemy.roomId, -1)),
            levelId: config.levelId,
            levelName: config.levelName,
            dungeonName: config.dungeonName,
            generatedFromScript: Boolean(config.generatedFromScript),
            spawnSource: 'dungeonSpawns',
            requiredForClear: Boolean(enemy.requiredForClear),
            spawnIndex: Math.round(this.normalizeNumber(enemy.spawnIndex, 0)),
            spawnKey: String(enemy.spawnKey ?? ''),
            boss,
            miniboss: Boolean(enemy.miniboss),
            roomBoss: Boolean(enemy.roomBoss ?? boss),
            isRoomBoss: Boolean(enemy.isRoomBoss ?? enemy.roomBoss ?? boss),
            roomBossName,
            displayName,
            sourceRoom: String(enemy.sourceRoom ?? ''),
            sourceVar: String(enemy.sourceVar ?? ''),
            sourceLine: Math.round(this.normalizeNumber(enemy.sourceLine, 0)),
            sourceSymbolId: Math.round(this.normalizeNumber(enemy.sourceSymbolId, 0)),
            sourceCharacterId: Math.round(this.normalizeNumber(enemy.sourceCharacterId, 0)),
            sourceSwf: String(config.source?.swf ?? ''),
            sourceLevelClass: String(config.source?.levelClass ?? ''),
            sourceExtractor: String(config.source?.extractor ?? '')
        };
    }

    static load(serverDataDir: string): void {
        this.configsByLevel.clear();
        this.npcsByLevel.clear();

        const spawnDir = path.join(serverDataDir, 'dungeonSpawns');
        if (!fs.existsSync(spawnDir)) {
            return;
        }

        for (const file of fs.readdirSync(spawnDir).sort()) {
            if (!file.endsWith('.enemies.json')) {
                continue;
            }

            const filePath = path.join(spawnDir, file);
            try {
                const data = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
                const config = this.validateConfig(file, data);
                if (!config) {
                    continue;
                }

                const levelName = this.normalizeLevelName(config.levelName);
                const npcs = config.enemies.map((enemy) => this.toNpcDef(config, enemy));
                this.configsByLevel.set(levelName, config);
                this.npcsByLevel.set(levelName, npcs);
                console.log(
                    `[DungeonSpawnLoader] loaded level=${config.levelId} levelName=${levelName} dungeon="${config.dungeonName}" enemies=${npcs.length} requiredForClear=${npcs.filter((npc) => npc.requiredForClear).length}`
                );
            } catch (error) {
                console.error(`[DungeonSpawnLoader] Error loading ${file}:`, error);
            }
        }
    }

    static hasLevel(levelName: string | null | undefined): boolean {
        return this.configsByLevel.has(this.normalizeLevelName(levelName));
    }

    static getLoadedLevelNames(): string[] {
        return Array.from(this.configsByLevel.keys()).sort();
    }

    static getSpawnConfigForLevel(levelName: string | null | undefined): DungeonSpawnConfig | null {
        const config = this.configsByLevel.get(this.normalizeLevelName(levelName));
        return config ? this.cloneConfig(config) : null;
    }

    static getNpcsForLevel(levelName: string | null | undefined): DungeonSpawnNpcDef[] {
        return (this.npcsByLevel.get(this.normalizeLevelName(levelName)) ?? []).map((npc) => this.cloneNpc(npc));
    }
}
