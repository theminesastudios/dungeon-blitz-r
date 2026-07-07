import fs from 'fs';
import path from 'path';
import dungeonEnemyElements from './dungeon_enemy_elements.json';
import { DungeonSpawnLoader } from './DungeonSpawnLoader';

export interface NpcDef {
    id: number;
    name: string;
    x: number;
    y: number;
    v?: number;
    team: number;
    untargetable?: boolean;
    render_depth_offset?: number;
    character_name?: string;
    DramaAnim?: string;
    SleepAnim?: string;
    summonerId?: number;
    power_id?: number;
    entState: number;
    facing_left?: boolean;
    health_delta?: number;
    buffs?: any[];
    [key: string]: any;
}

export class NpcLoader {
    private static levelsFiltered: Map<string, NpcDef[]> = new Map();
    private static levelsRaw: Map<string, NpcDef[]> = new Map();
    private static readonly SERVER_HOSTILE_LEVELS = new Set<string>([
        'AC_Mission1',
        'AC_Mission1Hard',
        'GoblinRiverDungeon',
        'GoblinRiverDungeonHard',
        'Castle',
        'CastleHard',
        'JC_Mini1Hard',
        'JC_Mini2',
        'JC_Mini2Hard'
    ]);
    private static readonly DERIVED_SERVER_HOSTILE_LEVELS = new Set<string>([
        'AC_Mission1',
        'AC_Mission1Hard'
    ]);
    private static readonly DERIVED_SERVER_HOSTILE_BASE_IDS: Record<string, number> = {
        AC_Mission1: 86000000,
        AC_Mission1Hard: 87000000
    };

    private static normalizeLevelName(levelName: string): string {
        return String(levelName ?? '').trim();
    }

    private static resolveFallbackLevelName(levelName: string): string | null {
        const normalizedLevel = this.normalizeLevelName(levelName);
        if (!normalizedLevel.endsWith('Hard')) {
            return null;
        }

        const baseLevel = normalizedLevel.slice(0, -4);
        return this.levelsRaw.has(baseLevel) ? baseLevel : null;
    }

    private static cloneNpcDef(npc: NpcDef): NpcDef {
        return {
            ...npc,
            buffs: Array.isArray(npc?.buffs) ? [...npc.buffs] : []
        };
    }

    private static getLevelNpcList(source: Map<string, NpcDef[]>, levelName: string): NpcDef[] {
        const normalizedLevel = this.normalizeLevelName(levelName);
        const direct = source.get(normalizedLevel);
        if (direct) {
            return direct.map((npc) => this.cloneNpcDef(npc));
        }

        const fallbackLevel = this.resolveFallbackLevelName(normalizedLevel);
        if (!fallbackLevel) {
            return [];
        }

        return (source.get(fallbackLevel) ?? []).map((npc) => this.cloneNpcDef(npc));
    }

    private static filterLevelNpcs(levelName: string, npcs: any[]): any[] {
        if (this.SERVER_HOSTILE_LEVELS.has(this.normalizeLevelName(levelName))) {
            return npcs;
        }

        // Match the Python server: client SWFs already own hostile spawns and
        // some tutorial actors, so only keep server-authored friendly/scripted NPCs.
        let filtered = npcs.filter((npc) => Number(npc?.team ?? 0) !== 2);

        if (levelName === 'TutorialBoat') {
            const bakedNpcs = new Set(['IntroParrot', 'NPCCaptainSteering']);
            filtered = filtered.filter((npc) => !bakedNpcs.has(String(npc?.name ?? '')));
        }

        if (levelName === 'TutorialDungeon') {
            const bakedNpcs = new Set(['IntroParrot', 'IntroGoblinNPC', 'NPCAnna']);
            filtered = filtered.filter((npc) => !bakedNpcs.has(String(npc?.name ?? '')));
        }

        return filtered;
    }

    private static normalizeNpcList(npcs: any[]): NpcDef[] {
        return npcs.map((item: any) => ({
            ...item,
            id: Number(item.id ?? 0),
            name: String(item.name ?? ""),
            x: Number(item.x ?? item.pos_x ?? 0),
            y: Number(item.y ?? item.pos_y ?? 0),
            v: Number(item.v ?? item.velocity_x ?? 0),
            team: Number(item.team ?? 0),
            untargetable: Boolean(item.untargetable),
            render_depth_offset: Number(item.render_depth_offset ?? 0),
            character_name: String(item.character_name ?? ""),
            DramaAnim: String(item.DramaAnim ?? ""),
            SleepAnim: String(item.SleepAnim ?? ""),
            summonerId: Number(item.summonerId ?? 0),
            power_id: Number(item.power_id ?? 0),
            entState: Number(item.entState ?? 0),
            facing_left: Boolean(item.facing_left),
            health_delta: Number(item.health_delta ?? 0),
            buffs: Array.isArray(item.buffs) ? item.buffs : []
        }));
    }

    private static buildDerivedServerHostileNpcs(levelName: string): NpcDef[] {
        const normalizedLevel = this.normalizeLevelName(levelName);
        if (!this.DERIVED_SERVER_HOSTILE_LEVELS.has(normalizedLevel)) {
            return [];
        }

        const source = (dungeonEnemyElements as Record<string, any>)[normalizedLevel];
        const enemyTypes = Array.isArray(source?.enemyTypes) ? source.enemyTypes : [];
        const rooms = Array.isArray(source?.rooms) && source.rooms.length > 0
            ? source.rooms.map((room: unknown) => String(room || 'server_room'))
            : [`${normalizedLevel}_server_room`];
        const baseId = this.DERIVED_SERVER_HOSTILE_BASE_IDS[normalizedLevel] ?? 86000000;
        const npcs: NpcDef[] = [];

        let spawnIndex = 0;
        for (const enemyType of enemyTypes) {
            const name = String(enemyType?.enemyType ?? '').trim();
            const count = Math.max(0, Math.round(Number(enemyType?.count ?? 0)));
            if (!name || count <= 0) {
                continue;
            }

            for (let typeIndex = 0; typeIndex < count; typeIndex++) {
                const roomIndex = spawnIndex % rooms.length;
                const roomName = rooms[roomIndex];
                const lane = Math.floor(roomIndex / 5);
                const slot = roomIndex % 5;
                npcs.push({
                    id: baseId + spawnIndex + 1,
                    name,
                    x: 1200 + (slot * 1800) + (typeIndex * 175),
                    y: -2200 + (lane * 850),
                    v: 0,
                    team: 2,
                    untargetable: false,
                    render_depth_offset: -50 - spawnIndex,
                    character_name: '',
                    DramaAnim: '',
                    SleepAnim: '',
                    summonerId: 0,
                    power_id: 0,
                    entState: 1,
                    facing_left: false,
                    health_delta: 0,
                    buffs: [],
                    roomId: roomIndex,
                    sourceRoom: roomName,
                    spawnGroup: roomName,
                    spawnIndex,
                    serverSpawned: true
                });
                spawnIndex++;
            }
        }

        return npcs;
    }

    static load(serverDataDir: string) {
        this.levelsRaw.clear();
        this.levelsFiltered.clear();

        // serverDataDir is '.../src/server/data' (or similar based on config).
        // New path is directly inside 'src/server/data/npcs'.
        const npcDir = path.join(serverDataDir, 'npcs');
        
        try {
            if (!fs.existsSync(npcDir)) {
                 console.error(`[NpcLoader] Directory not found: ${npcDir}`);
                 return;
            }

            const files = fs.readdirSync(npcDir);
            for (const file of files) {
                if (file.endsWith('.json')) {
                    const levelName = path.basename(file, '.json');
                    const filePath = path.join(npcDir, file);
                    try {
                        const content = fs.readFileSync(filePath, 'utf-8');
                        const data = JSON.parse(content);
                        if (Array.isArray(data)) {
                             this.levelsRaw.set(levelName, this.normalizeNpcList(data));
                             this.levelsFiltered.set(
                                 levelName,
                                 this.normalizeNpcList(this.filterLevelNpcs(levelName, data))
                             );
                        }
                    } catch (err) {
                        console.error(`[NpcLoader] Error loading ${file}:`, err);
                    }
                }
            }
            for (const levelName of this.DERIVED_SERVER_HOSTILE_LEVELS) {
                if (this.levelsRaw.has(levelName)) {
                    continue;
                }
                const derivedNpcs = this.buildDerivedServerHostileNpcs(levelName);
                if (derivedNpcs.length === 0) {
                    continue;
                }
                this.levelsRaw.set(levelName, this.normalizeNpcList(derivedNpcs));
                this.levelsFiltered.set(levelName, this.normalizeNpcList(this.filterLevelNpcs(levelName, derivedNpcs)));
            }
            DungeonSpawnLoader.load(serverDataDir);
            for (const levelName of DungeonSpawnLoader.getLoadedLevelNames()) {
                const generatedNpcs = DungeonSpawnLoader.getNpcsForLevel(levelName);
                if (generatedNpcs.length === 0) {
                    continue;
                }

                const existingRaw = this.levelsRaw.get(levelName) ?? [];
                const mergedById = new Map<number, NpcDef>();
                for (const npc of existingRaw) {
                    mergedById.set(Math.round(Number(npc.id ?? 0)), npc);
                }
                for (const npc of generatedNpcs) {
                    mergedById.set(Math.round(Number(npc.id ?? 0)), npc);
                }
                const mergedRaw = Array.from(mergedById.values());
                this.levelsRaw.set(levelName, this.normalizeNpcList(mergedRaw));
                this.levelsFiltered.set(
                    levelName,
                    this.normalizeNpcList(this.filterLevelNpcs(levelName, mergedRaw))
                );
                console.log(`[NpcLoader] Merged ${generatedNpcs.length} generated dungeon spawns for ${levelName}.`);
            }
            console.log(`[NpcLoader] Loaded NPCs for ${this.levelsRaw.size} levels.`);
        } catch (e) {
             console.error(`[NpcLoader] Failed to load NPCs:`, e);
        }
    }

    static getNpcsForLevel(levelName: string): NpcDef[] {
        return this.getLevelNpcList(this.levelsFiltered, levelName);
    }

    static getRawNpcsForLevel(levelName: string): NpcDef[] {
        return this.getLevelNpcList(this.levelsRaw, levelName);
    }
}
