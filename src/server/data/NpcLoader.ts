import fs from 'fs';
import path from 'path';

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
        'GoblinRiverDungeon',
        'GoblinRiverDungeonHard',
        'JC_Mini1Hard'
    ]);

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

    static load(serverDataDir: string) {
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
