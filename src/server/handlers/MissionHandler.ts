import { Client } from '../core/Client';
import { LevelConfig } from '../core/LevelConfig';
import { Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { MissionDef, MissionLoader } from '../data/MissionLoader';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

const db = new JsonAdapter();

type MissionEntry = Record<string, any>;

export class MissionHandler {
    private static readonly MISSION_NOT_STARTED = 0;
    private static readonly MISSION_IN_PROGRESS = 1;
    private static readonly MISSION_READY_TO_TURN_IN = 2;
    private static readonly MISSION_CLAIMED = 3;
    private static readonly DEFAULT_DUNGEON_TIER = 10;
    private static readonly DEFAULT_DUNGEON_HIGHSCORE = 99999999;

    static repairEarlyStoryOnLogin(
        character: Character,
        currentLevelRaw: string
    ): { didMutate: boolean; addedMissionId: number } {
        const currentLevel = String(currentLevelRaw || character.CurrentLevel?.name || '');
        let didMutate = false;
        let addedMissionId = 0;

        const mission1State = MissionHandler.getMissionState(character, 1);
        const mission2State = MissionHandler.getMissionState(character, 2);

        const shouldBootstrapMission1 =
            mission1State === MissionHandler.MISSION_NOT_STARTED &&
            mission2State === MissionHandler.MISSION_NOT_STARTED &&
            (
                currentLevel === 'TutorialBoat' ||
                (
                    currentLevel === 'NewbieRoad' &&
                    Number(character.level ?? 1) <= 2
                )
            );

        if (shouldBootstrapMission1) {
            MissionHandler.setMissionState(
                character,
                1,
                MissionHandler.MISSION_IN_PROGRESS,
                MissionLoader.getMissionDef(1),
                { currCount: 0 }
            );
            if (character.questTrackerState == null) {
                character.questTrackerState = 0;
            }
            didMutate = true;
            addedMissionId = 1;
        }

        if (
            addedMissionId === 0 &&
            currentLevel !== 'TutorialBoat' &&
            mission2State === MissionHandler.MISSION_NOT_STARTED &&
            Number(character.questTrackerState ?? 0) >= 100 &&
            mission1State >= MissionHandler.MISSION_IN_PROGRESS
        ) {
            MissionHandler.setMissionState(
                character,
                1,
                MissionHandler.MISSION_READY_TO_TURN_IN,
                MissionLoader.getMissionDef(1),
                { currCount: 1 }
            );
            didMutate = true;
        }

        if (MissionHandler.normalizeInstantReturnMissionStates(character)) {
            didMutate = true;
        }

        return { didMutate, addedMissionId };
    }

    static async handleSetLevelComplete(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const completionPercent = br.readMethod9();
        const bonusScoreTotal = br.readMethod9();
        const goldReward = br.readMethod9();
        br.readMethod9(); // material reward
        br.readMethod9(); // gear count
        const remainingKills = br.readMethod9();
        const requiredKills = br.readMethod9();
        const levelWidthScore = br.readMethod9();

        const currentLevel = client.currentLevel || String(client.character.CurrentLevel?.name ?? '');
        let actualKills = Math.max(requiredKills - remainingKills, 0);
        let clearedDungeon =
            completionPercent >= 100 ||
            (requiredKills > 0 && remainingKills <= 0);

        let didMutate = false;
        if (currentLevel === 'TutorialBoat' || currentLevel === 'TutorialDungeon') {
            clearedDungeon = true;
            actualKills = Math.max(actualKills, requiredKills, 1);
            if (Number(client.character.questTrackerState ?? 0) !== 100) {
                client.character.questTrackerState = 100;
                didMutate = true;
            }
            MissionHandler.sendQuestProgress(client, 100);
        }

        if (
            clearedDungeon &&
            currentLevel === 'TutorialBoat' &&
            MissionHandler.getMissionState(client.character, 1) === MissionHandler.MISSION_NOT_STARTED &&
            MissionHandler.getMissionState(client.character, 2) === MissionHandler.MISSION_NOT_STARTED
        ) {
            MissionHandler.setMissionState(
                client.character,
                1,
                MissionHandler.MISSION_IN_PROGRESS,
                MissionLoader.getMissionDef(1),
                { currCount: 0 }
            );
            didMutate = true;
        }

        let completedMissionId = 0;
        if (clearedDungeon) {
            completedMissionId = MissionHandler.completeActiveDungeonMission(client.character, currentLevel);
            if (completedMissionId) {
                didMutate = true;
                MissionHandler.sendMissionComplete(client, completedMissionId);

                if (completedMissionId === 3) {
                    const contactNpc = 'Anna';
                    const addedMissionId = MissionHandler.autoAcceptFollowupMission(
                        client.character,
                        contactNpc,
                        completedMissionId
                    );
                    if (addedMissionId) {
                        didMutate = true;
                        MissionHandler.sendMissionAdded(
                            client,
                            addedMissionId,
                            MissionHandler.getMissionState(client.character, addedMissionId)
                        );
                    }
                }

                if (completedMissionId !== 1) {
                    MissionHandler.sendMissionCompleteUi(
                        client,
                        completedMissionId,
                        levelWidthScore || 3,
                        bonusScoreTotal
                    );
                }
            }

            if (MissionHandler.moveCharacterBackToSafeLevel(client.character, currentLevel)) {
                didMutate = true;
            }
        }

        if (didMutate && client.userId) {
            await db.saveCharacters(client.userId, client.characters);
        }

        MissionHandler.sendDungeonComplete(client, {
            stars: levelWidthScore || 3,
            kills: actualKills,
            treasure: goldReward
        });
    }

    private static completeActiveDungeonMission(character: Character, currentLevel: string): number {
        const missions = MissionHandler.getMissionStateMap(character);

        for (const [missionIdText, rawEntry] of Object.entries(missions)) {
            const missionId = Number(missionIdText);
            if (!Number.isFinite(missionId)) {
                continue;
            }

            const entry = MissionHandler.asMissionEntry(rawEntry);
            if (Number(entry.state ?? MissionHandler.MISSION_NOT_STARTED) !== MissionHandler.MISSION_IN_PROGRESS) {
                continue;
            }

            const missionDef = MissionLoader.getMissionDef(missionId);
            if (!missionDef || missionDef.Dungeon !== currentLevel) {
                continue;
            }

            const completionState = MissionHandler.missionRequiresTurnIn(missionDef)
                ? MissionHandler.MISSION_READY_TO_TURN_IN
                : MissionHandler.MISSION_CLAIMED;

            MissionHandler.setMissionState(character, missionId, completionState, missionDef, {
                currCount: Math.max(1, Number(missionDef.CompleteCount ?? 1))
            });
            return missionId;
        }

        return 0;
    }

    private static autoAcceptFollowupMission(
        character: Character,
        npcName: string,
        excludeMissionId: number
    ): number {
        const normalizedNpc = MissionHandler.normalizeNpcKey(npcName);
        if (!normalizedNpc) {
            return 0;
        }

        for (let missionId = 1; missionId <= MissionLoader.getTotalMissions(); missionId++) {
            if (missionId === excludeMissionId) {
                continue;
            }

            const missionDef = MissionLoader.getMissionDef(missionId);
            if (!missionDef) {
                continue;
            }

            if (MissionHandler.getMissionState(character, missionId) !== MissionHandler.MISSION_NOT_STARTED) {
                continue;
            }

            if (MissionHandler.normalizeNpcKey(missionDef.ContactName ?? '') !== normalizedNpc) {
                continue;
            }

            if (!MissionHandler.canStartMission(character, missionDef)) {
                continue;
            }

            const initialState = MissionHandler.getInitialMissionState(missionDef);
            MissionHandler.setMissionState(character, missionId, initialState, missionDef, {
                currCount: 0
            });
            return missionId;
        }

        return 0;
    }

    private static canStartMission(character: Character, missionDef: MissionDef): boolean {
        const prereqs = missionDef.PreReqMissions ?? [];
        for (const prereqName of prereqs) {
            const prereqId = MissionLoader.getMissionIdByName(prereqName);
            if (!prereqId) {
                continue;
            }
            if (MissionHandler.getMissionState(character, prereqId) < MissionHandler.MISSION_CLAIMED) {
                return false;
            }
        }
        return true;
    }

    private static moveCharacterBackToSafeLevel(character: Character, currentLevel: string): boolean {
        if (!LevelConfig.get(currentLevel).isDungeon) {
            return false;
        }

        const previousLevel = character.PreviousLevel;
        if (previousLevel?.name) {
            const nextName = String(previousLevel.name);
            const nextX = Number(previousLevel.x ?? 0);
            const nextY = Number(previousLevel.y ?? 0);
            const currentName = String(character.CurrentLevel?.name ?? '');
            const currentX = Number(character.CurrentLevel?.x ?? 0);
            const currentY = Number(character.CurrentLevel?.y ?? 0);

            if (currentName === nextName && currentX === nextX && currentY === nextY) {
                return false;
            }

            character.CurrentLevel = { name: nextName, x: nextX, y: nextY };
            return true;
        }

        if (currentLevel === 'TutorialBoat' || currentLevel === 'TutorialDungeon') {
            const spawn = LevelConfig.getSpawn('NewbieRoad');
            character.CurrentLevel = { name: 'NewbieRoad', x: spawn.x, y: spawn.y };
            return true;
        }

        return false;
    }

    private static missionRequiresTurnIn(missionDef: MissionDef): boolean {
        return Boolean(String(missionDef.ReturnName ?? '').trim());
    }

    private static missionStartsReadyToTurnIn(missionDef: MissionDef): boolean {
        return !String(missionDef.Dungeon ?? '').trim() &&
            MissionHandler.missionRequiresTurnIn(missionDef) &&
            Number(missionDef.CompleteCount ?? 1) <= 0;
    }

    private static getInitialMissionState(missionDef: MissionDef): number {
        return MissionHandler.missionStartsReadyToTurnIn(missionDef)
            ? MissionHandler.MISSION_READY_TO_TURN_IN
            : MissionHandler.MISSION_IN_PROGRESS;
    }

    private static sendQuestProgress(client: Client, percent: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(percent);
        client.sendBitBuffer(0xB7, bb);
    }

    static sendMissionAdded(
        client: Client,
        missionId: number,
        state: number = MissionHandler.MISSION_IN_PROGRESS
    ): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(missionId);
        bb.writeMethod11(state === MissionHandler.MISSION_IN_PROGRESS ? 1 : 0, 1);
        client.sendBitBuffer(0x85, bb);
    }

    private static sendMissionComplete(client: Client, missionId: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(missionId);
        client.sendBitBuffer(0x86, bb);
    }

    private static sendMissionCompleteUi(
        client: Client,
        missionId: number,
        stars: number,
        dungeonScore: number
    ): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(missionId);
        bb.writeMethod11(1, 1);
        bb.writeMethod6(Math.max(0, Math.min(stars, 15)), 4);
        bb.writeMethod4(Math.max(0, dungeonScore));
        client.sendBitBuffer(0x84, bb);
    }

    private static sendDungeonComplete(
        client: Client,
        stats: {
            stars: number;
            resultBar?: number;
            rank?: number;
            kills: number;
            accuracy?: number;
            deaths?: number;
            treasure: number;
            timeBonus?: number;
        }
    ): void {
        const bb = new BitBuffer(false);
        bb.writeMethod6(Math.max(0, Math.min(stats.stars, 15)), 4);
        bb.writeMethod4(stats.resultBar ?? 1);
        bb.writeMethod4(stats.rank ?? 1);
        bb.writeMethod4(Math.max(0, stats.kills));
        bb.writeMethod4(stats.accuracy ?? 50);
        bb.writeMethod4(stats.deaths ?? 0);
        bb.writeMethod4(Math.max(0, stats.treasure));
        bb.writeMethod4(stats.timeBonus ?? 0);
        client.sendBitBuffer(0x87, bb);
    }

    private static getMissionStateMap(character: Character): Record<string, MissionEntry> {
        const raw = character.missions;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            character.missions = {};
            return character.missions;
        }
        return raw as Record<string, MissionEntry>;
    }

    private static getMissionState(character: Character, missionId: number): number {
        const missions = MissionHandler.getMissionStateMap(character);
        const entry = MissionHandler.asMissionEntry(missions[String(missionId)]);
        return Number(entry.state ?? MissionHandler.MISSION_NOT_STARTED);
    }

    private static normalizeInstantReturnMissionStates(character: Character): boolean {
        let didMutate = false;

        for (let missionId = 1; missionId <= MissionLoader.getTotalMissions(); missionId++) {
            const missionDef = MissionLoader.getMissionDef(missionId);
            if (!missionDef || !MissionHandler.missionStartsReadyToTurnIn(missionDef)) {
                continue;
            }

            if (MissionHandler.getMissionState(character, missionId) !== MissionHandler.MISSION_IN_PROGRESS) {
                continue;
            }

            MissionHandler.setMissionState(
                character,
                missionId,
                MissionHandler.MISSION_READY_TO_TURN_IN,
                missionDef
            );
            didMutate = true;
        }

        return didMutate;
    }

    private static setMissionState(
        character: Character,
        missionId: number,
        state: number,
        missionDef: MissionDef | undefined,
        extra: Partial<MissionEntry> = {}
    ): void {
        const missions = MissionHandler.getMissionStateMap(character);
        const key = String(missionId);
        const next = MissionHandler.asMissionEntry(missions[key]);

        next.state = state;
        if (extra.currCount !== undefined) {
            next.currCount = Number(extra.currCount);
        }

        if ((missionDef?.Time ?? false) && state >= MissionHandler.MISSION_READY_TO_TURN_IN) {
            next.Tier = Number(extra.Tier ?? next.Tier ?? MissionHandler.DEFAULT_DUNGEON_TIER);
            next.highscore = Number(
                extra.highscore ?? next.highscore ?? MissionHandler.DEFAULT_DUNGEON_HIGHSCORE
            );
            next.Time = Number(extra.Time ?? next.Time ?? Math.floor(Date.now() / 1000));
        }

        if (state >= MissionHandler.MISSION_CLAIMED) {
            next.claimed = 1;
            next.complete = 1;
        } else {
            delete next.claimed;
            delete next.complete;
        }

        missions[key] = next;
    }

    private static asMissionEntry(value: unknown): MissionEntry {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? { ...(value as MissionEntry) }
            : {};
    }

    private static normalizeNpcKey(value: string): string {
        const normalized = String(value ?? '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');

        if (!normalized) {
            return '';
        }

        const aliases: Record<string, string> = {
            mayorristas: 'nrmayor01',
            mayor: 'nrmayor01',
            anna: 'nranna03',
            pecky: 'nrpecky',
            captainfink: 'nrcaptfink',
            fink: 'nrcaptfink'
        };

        return aliases[normalized] ?? normalized;
    }
}
