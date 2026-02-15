import fs from 'fs';
import path from 'path';

export interface MissionDef {
    MissionName: string;
    MissionID: number;
    Tier?: number;
    Time?: number;
    highscore?: number; // Lowercase to match usage
    CompleteCount?: number;
}

export class MissionLoader {
    private static missions: Map<number, MissionDef> = new Map();
    private static maxId: number = 0;

    static load(dataDir: string): void {
        const filePath = path.join(dataDir, 'MissionTypes.json');
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            const json = JSON.parse(data);
            
            for (const item of json) {
                const id = parseInt(item.MissionID);
                if (!isNaN(id)) {
                    this.missions.set(id, {
                        MissionName: item.MissionName,
                        MissionID: id,
                        Tier: item.Tier ? parseInt(item.Tier) : 0,
                        Time: item.Time ? parseInt(item.Time) : 0,
                        highscore: item.Highscore ? parseInt(item.Highscore) : (item.highscore ? parseInt(item.highscore) : 0),
                        CompleteCount: item.CompleteCount ? parseInt(item.CompleteCount) : 1
                    });
                    if (id > this.maxId) this.maxId = id;
                }
            }
            console.log(`[MissionLoader] Loaded ${this.missions.size} missions. Max ID: ${this.maxId}`);
        } catch (e) {
            console.error(`[MissionLoader] Failed to load missions: ${e}`);
        }
    }

    static getMissionDef(id: number): MissionDef | undefined {
        // if (this.missions.size === 0) this.load(); // Cannot lazy load without dataDir
        return this.missions.get(id);
    }

    static getTotalMissions(): number {
        return this.maxId;
    }
}
