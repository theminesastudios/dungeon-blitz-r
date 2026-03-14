import fs from 'fs';
import path from 'path';

export interface MissionDef {
    MissionName: string;
    MissionID: number;
    Tier?: boolean;
    Time?: boolean;
    highscore?: number;
    CompleteCount?: number;
    ReturnName?: string;
    ReturnText?: string;
    ContactName?: string;
    Dungeon?: string;
    ZoneSet?: string;
    MissionLevel?: number;
    PreReqMissions?: string[];
}

export class MissionLoader {
    private static missions: Map<number, MissionDef> = new Map();
    private static missionIdsByName: Map<string, number> = new Map();
    private static maxId: number = 0;

    private static isTruthy(value: unknown): boolean {
        if (typeof value === 'boolean') {
            return value;
        }
        if (value === null || value === undefined) {
            return false;
        }

        const normalized = String(value).trim().toLowerCase();
        return ["1", "true", "yes", "y", "t"].includes(normalized);
    }

    private static normalizeMissionName(value: unknown): string {
        return String(value ?? "").trim().toLowerCase();
    }

    static load(dataDir: string): void {
        const filePath = path.join(dataDir, 'MissionTypes.json');
        try {
            const data = fs.readFileSync(filePath, 'utf8');
            const json = JSON.parse(data);

            this.missions.clear();
            this.missionIdsByName.clear();
            this.maxId = 0;
            
            for (const item of json) {
                const id = parseInt(item.MissionID);
                if (!isNaN(id)) {
                    const parsedCompleteCount = parseInt(item.CompleteCount ?? "1", 10);
                    const completeCount = Number.isFinite(parsedCompleteCount)
                        ? Math.max(0, parsedCompleteCount)
                        : 1;
                    const missionName = String(item.MissionName ?? "").trim();
                    const preReqMissions = String(item.PreReqMissions ?? "")
                        .split(",")
                        .map((entry) => entry.trim())
                        .filter(Boolean);

                    this.missions.set(id, {
                        MissionName: missionName,
                        MissionID: id,
                        Tier: this.isTruthy(item.Achievement),
                        Time: this.isTruthy(item.Timed) || Boolean(item.Dungeon),
                        highscore: completeCount,
                        CompleteCount: completeCount,
                        ReturnName: item.ReturnName || "",
                        ReturnText: item.ReturnText || "",
                        ContactName: item.ContactName || "",
                        Dungeon: item.Dungeon || "",
                        ZoneSet: item.ZoneSet || "",
                        MissionLevel: parseInt(item.MissionLevel ?? "0", 10) || 0,
                        PreReqMissions: preReqMissions
                    });
                    const normalizedName = this.normalizeMissionName(missionName);
                    if (normalizedName) {
                        this.missionIdsByName.set(normalizedName, id);
                    }
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

    static getMissionIdByName(name: string): number | undefined {
        return this.missionIdsByName.get(this.normalizeMissionName(name));
    }

    static getTotalMissions(): number {
        return this.maxId;
    }
}
