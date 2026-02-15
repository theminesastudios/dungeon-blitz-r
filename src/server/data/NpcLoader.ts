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
}

export class NpcLoader {
    private static levelsRaw: Map<string, NpcDef[]> = new Map();

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
                             // Map ensures numeric types where needed
                             const cached: NpcDef[] = data.map((item: any) => ({
                                 id: item.id,
                                 name: item.name,
                                 x: item.x,
                                 y: item.y,
                                 v: item.v || 0,
                                 team: item.team,
                                 untargetable: !!item.untargetable,
                                 render_depth_offset: item.render_depth_offset || 0,
                                 character_name: item.character_name || "",
                                 DramaAnim: item.DramaAnim || "",
                                 SleepAnim: item.SleepAnim || "",
                                 summonerId: item.summonerId || 0,
                                 power_id: item.power_id || 0,
                                 entState: item.entState || 1,
                                 facing_left: !!item.facing_left,
                                 health_delta: item.health_delta || 0,
                                 buffs: item.buffs || []
                             }));
                             
                             this.levelsRaw.set(levelName, cached);
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
        return this.levelsRaw.get(levelName) || [];
    }
}
