import fs from 'fs';
import path from 'path';
import { DungeonSpawnLoader } from './DungeonSpawnLoader';
import { TutorialDungeonMechanics } from '../core/TutorialDungeonMechanics';

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
        'JC_Mini1Hard',
        'JC_Mini2'
    ]);

    // A Hard level normally reuses its base level's NPC list because it is the
    // same geometry at a higher difficulty. TutorialDungeonHard is not: Dread
    // Goblin Hideout is built from a_Level_GoblinBeachHard, a completely
    // different room set — which is also why it has no NPCAnna and no Chains03.
    //
    // Inheriting anyway planted TutorialDungeon's authored boss (GoblinBoss1,
    // id 3923550, level position 22695,2959) into the Dread run. Those are the
    // *normal* dungeon's coordinates, and in the Dread layout they land on top
    // of room 09's treasure chest — the motionless second Tag Ugo standing by
    // the chest, never driven, never damaged, never removed. It also counts as
    // an undefeated required boss, so the run's objectives never complete.
    private static readonly LEVELS_WITHOUT_BASE_NPC_FALLBACK = new Set<string>([
        'TutorialDungeonHard'
    ]);

    private static normalizeLevelName(levelName: string): string {
        return String(levelName ?? '').trim();
    }

    private static resolveFallbackLevelName(levelName: string): string | null {
        const normalizedLevel = this.normalizeLevelName(levelName);
        if (!normalizedLevel.endsWith('Hard') || this.LEVELS_WITHOUT_BASE_NPC_FALLBACK.has(normalizedLevel)) {
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
            const knownIds = new Set(filtered.map((npc) => Number(npc?.id ?? 0)));
            for (const npc of npcs) {
                if (!TutorialDungeonMechanics.isCompletionBoss(levelName, npc)) {
                    continue;
                }
                const id = Number(npc?.id ?? 0);
                if (knownIds.has(id)) {
                    continue;
                }
                filtered.push(TutorialDungeonMechanics.decorateNpc(levelName, npc));
                knownIds.add(id);
            }
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
            DungeonSpawnLoader.load(serverDataDir);
            for (const levelName of DungeonSpawnLoader.getLoadedLevelNames()) {
                const generatedNpcs = DungeonSpawnLoader.getNpcsForLevel(levelName);
                if (generatedNpcs.length === 0) {
                    continue;
                }

                const existingRaw = this.levelsRaw.get(levelName) ?? [];
                const existingIds = new Set(existingRaw.map((npc) => Math.round(Number(npc.id ?? 0))));
                const mergedRaw = [
                    ...existingRaw,
                    ...generatedNpcs.filter((npc) => !existingIds.has(Math.round(Number(npc.id ?? 0))))
                ];
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
