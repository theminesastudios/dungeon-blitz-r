import { Client } from '../core/Client';
import {
    buildDefaultDungeonScoreProfile,
    getDungeonScoreProfile,
    getDungeonScoreTotalCap,
    type ResolvedDungeonScoreProfile
} from '../core/DungeonScoreProfiles';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { isWolfsEndDungeonLevel } from '../core/WolfsEndDungeonStatsPolicy';
import { finalizeDungeonRun, getActiveDungeonRunStats, noteDungeonRunCompletionProgress } from '../core/DungeonRunStats';
import { buildDungeonRunScoreSummary } from '../core/DungeonRunStats';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import {
    getSharedDungeonProgressTotals,
    getOrCreateSharedDungeonProgressState,
    hasSharedDungeonProgressHostiles,
    recomputeSharedDungeonProgress,
    resolveSharedDungeonProgressAuthorityToken,
    usesSharedDungeonProgress
} from '../core/SharedDungeonProgress';
import { Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { MissionDef, MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

const db = new JsonAdapter();

type MissionEntry = Record<string, any>;
type DungeonCompletionResult = {
    actualKills: number;
    totalScore: number;
    stars: number;
    resultBar: number;
    rank: number;
    killsScore: number;
    accuracyScore: number;
    deathsScore: number;
    treasureScore: number;
    timeBonusScore: number;
};

type DungeonMissionUpdateResult = {
    missionId: number;
    state: number;
    newlyCompleted: boolean;
    persistedStars: number;
    persistedScore: number;
};

export class MissionHandler {
    private static readonly MISSION_NOT_STARTED = 0;
    private static readonly MISSION_IN_PROGRESS = 1;
    private static readonly MISSION_READY_TO_TURN_IN = 2;
    private static readonly MISSION_CLAIMED = 3;
    private static readonly ACHIEVEMENT_MAMMOTH_IDOL_REWARD = 10;
    private static readonly NEWBIE_ROAD_GOBLIN_KILL_NAMES = new Set([
        'GoblinArmorSword',
        'GoblinBrute',
        'GoblinClub',
        'GoblinDagger',
        'GoblinHatchet',
        'GoblinMiniBoss',
        'GoblinShamanHood',
        'GoblinShamanSkullHat'
    ]);
    private static readonly NEWBIE_ROAD_HARD_GOBLIN_KILL_NAMES = new Set([
        'GoblinArmorSwordHard',
        'GoblinBruteHard',
        'GoblinClubHard',
        'GoblinDaggerHard',
        'GoblinHatchetHard',
        'GoblinMiniBossHard',
        'GoblinShamanHoodHard',
        'GoblinShamanSkullHatHard'
    ]);
    private static readonly KILL_PROGRESS_TARGETS: Readonly<Record<number, ReadonlySet<string>>> = {
        [MissionID.GetGoblinNoserings]: new Set(['GoblinBrute']),
        [MissionID.GetGoblinWands]: new Set(['GoblinShamanHood', 'GoblinShamanSkullHat']),
        [MissionID.GetGoblinNoseringsHard]: new Set(['GoblinBruteHard']),
        [MissionID.GetGoblinWandsHard]: new Set(['GoblinShamanHoodHard', 'GoblinShamanSkullHatHard']),
        [MissionID.KillGoblins]: MissionHandler.NEWBIE_ROAD_GOBLIN_KILL_NAMES,
        [MissionID.KillGoblinsHard]: MissionHandler.NEWBIE_ROAD_HARD_GOBLIN_KILL_NAMES,
        [MissionID.GetHobgoblinNoserings]: new Set(['BlackGoblinBrute']),
        [MissionID.GetHobgoblinNoseringsHard]: new Set(['BlackGoblinBruteHard'])
    };

    static repairEarlyStoryOnLogin(
        character: Character,
        currentLevelRaw: string
    ): { didMutate: boolean; addedMissionId: number } {
        const currentLevel = String(currentLevelRaw || character.CurrentLevel?.name || '');
        const questProgress = Number(character.questTrackerState ?? 0);
        let didMutate = false;
        let addedMissionId = 0;

        const mission1State = MissionHandler.getMissionState(character, MissionID.DefendTheShip);
        const mission2State = MissionHandler.getMissionState(character, MissionID.MeetTheTown);

        const shouldBootstrapMission1 =
            mission1State === MissionHandler.MISSION_NOT_STARTED &&
            mission2State === MissionHandler.MISSION_NOT_STARTED &&
            (
                questProgress >= 100 ||
                currentLevel === 'TutorialBoat' ||
                (
                    currentLevel === 'NewbieRoad' &&
                    Number(character.level ?? 1) <= 2
                )
            );

        if (shouldBootstrapMission1) {
            const initialMission1State =
                questProgress >= 100
                    ? MissionHandler.MISSION_READY_TO_TURN_IN
                    : MissionHandler.MISSION_IN_PROGRESS;
            MissionHandler.setMissionState(
                character,
                MissionID.DefendTheShip,
                initialMission1State,
                MissionLoader.getMissionDef(MissionID.DefendTheShip),
                { currCount: initialMission1State >= MissionHandler.MISSION_READY_TO_TURN_IN ? 1 : 0 }
            );
            if (character.questTrackerState == null) {
                character.questTrackerState = 0;
            }
            didMutate = true;
            addedMissionId = MissionID.DefendTheShip;
        }

        const repairedMission1State = MissionHandler.getMissionState(character, MissionID.DefendTheShip);
        if (
            mission2State === MissionHandler.MISSION_NOT_STARTED &&
            questProgress >= 100 &&
            repairedMission1State === MissionHandler.MISSION_IN_PROGRESS
        ) {
            MissionHandler.setMissionState(
                character,
                MissionID.DefendTheShip,
                MissionHandler.MISSION_READY_TO_TURN_IN,
                MissionLoader.getMissionDef(MissionID.DefendTheShip),
                { currCount: 1 }
            );
            didMutate = true;
        }

        if (
            currentLevel !== 'TutorialBoat' &&
            mission2State === MissionHandler.MISSION_NOT_STARTED &&
            MissionHandler.getMissionState(character, MissionID.DefendTheShip) >= MissionHandler.MISSION_CLAIMED
        ) {
            const mission2Def = MissionLoader.getMissionDef(MissionID.MeetTheTown);
            if (mission2Def && MissionHandler.canStartMission(character, mission2Def)) {
                MissionHandler.setMissionState(
                    character,
                    MissionID.MeetTheTown,
                    MissionHandler.getInitialMissionState(mission2Def),
                    mission2Def,
                    { currCount: 0 }
                );
                didMutate = true;
                if (addedMissionId === 0) {
                    addedMissionId = MissionID.MeetTheTown;
                }
            }
        }

        if (MissionHandler.normalizeInstantReturnMissionStates(character)) {
            didMutate = true;
        }

        if (MissionHandler.repairCompletedDungeonMissionStates(character, currentLevel)) {
            didMutate = true;
        }

        if (
            MissionHandler.getMissionState(character, MissionID.ClearYourHouse) >= MissionHandler.MISSION_CLAIMED &&
            Number(character.questTrackerState ?? 0) < 100
        ) {
            character.questTrackerState = 100;
            didMutate = true;
        }

        return { didMutate, addedMissionId };
    }

    static syncMissionStateToClient(client: Client): void {
        if (!client.character) {
            return;
        }

        MissionHandler.sendQuestProgress(client, Math.max(0, Number(client.character.questTrackerState ?? 0)));
    }

    static async handleEnemyDefeatMissionProgress(client: Client, destroyedEntity: any): Promise<void> {
        if (!client.character) {
            return;
        }

        const defeatedNames = MissionHandler.getDefeatedEnemyNames(destroyedEntity);
        if (!defeatedNames.length) {
            return;
        }

        const currentLevel =
            LevelConfig.normalizeLevelName(client.currentLevel || String(client.character.CurrentLevel?.name ?? '')) ||
            client.currentLevel ||
            String(client.character.CurrentLevel?.name ?? '');
        if (!currentLevel) {
            return;
        }

        const missions = MissionHandler.getMissionStateMap(client.character);
        let didMutate = false;

        for (const [missionIdText, rawEntry] of Object.entries(missions)) {
            const missionId = Number(missionIdText);
            if (!Number.isFinite(missionId)) {
                continue;
            }

            const missionDef = MissionLoader.getMissionDef(missionId);
            if (!missionDef || !MissionHandler.isMissionAvailableInCurrentLevel(missionDef, currentLevel)) {
                continue;
            }

            const targetNames = MissionHandler.KILL_PROGRESS_TARGETS[missionId];
            const activeTargetNames = MissionHandler.getMissionActiveTargetNames(missionDef);
            const matchesKillTarget = Boolean(
                targetNames && defeatedNames.some((name) => targetNames.has(name))
            );
            const matchesActiveTarget = activeTargetNames.some((name) => defeatedNames.includes(name));
            if (!matchesKillTarget && !matchesActiveTarget) {
                continue;
            }

            const entry = MissionHandler.asMissionEntry(rawEntry);
            if (Number(entry.state ?? MissionHandler.MISSION_NOT_STARTED) !== MissionHandler.MISSION_IN_PROGRESS) {
                continue;
            }

            const currentCount = Math.max(0, Number(entry.currCount ?? 0));
            const completeCount = Math.max(1, Number(missionDef.CompleteCount ?? 1));
            if (currentCount >= completeCount) {
                continue;
            }

            const nextCount = Math.min(completeCount, currentCount + 1);
            const nextState =
                nextCount >= completeCount
                    ? MissionHandler.MISSION_READY_TO_TURN_IN
                    : MissionHandler.MISSION_IN_PROGRESS;

            MissionHandler.setMissionState(client.character, missionId, nextState, missionDef, {
                currCount: nextCount
            });
            MissionHandler.sendMissionProgress(client, missionId, 1);
            if (nextState === MissionHandler.MISSION_READY_TO_TURN_IN) {
                MissionHandler.sendMissionComplete(client, missionId);
            }
            didMutate = true;
        }

        if (didMutate) {
            await MissionHandler.saveCharacter(client);
        }
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

        const currentLevel =
            LevelConfig.normalizeLevelName(client.currentLevel || String(client.character.CurrentLevel?.name ?? '')) ||
            client.currentLevel ||
            String(client.character.CurrentLevel?.name ?? '');
        const levelScope = getClientLevelScope(client);
        const forceSharedDungeonCompletion = Boolean(levelScope) && client.forcedDungeonCompletionScope === levelScope;
        const trackerCompletionPercent = Math.max(0, Number(client.character.questTrackerState ?? 0));
        let effectiveCompletionPercent = isWolfsEndDungeonLevel(currentLevel)
            ? Math.max(completionPercent, trackerCompletionPercent)
            : completionPercent;
        let actualKills = Math.max(requiredKills - remainingKills, 0);
        let clearedDungeon =
            effectiveCompletionPercent >= 100 ||
            (requiredKills > 0 && remainingKills <= 0);

        if (usesSharedDungeonProgress(currentLevel) && levelScope) {
            const sharedState = forceSharedDungeonCompletion
                ? getOrCreateSharedDungeonProgressState(levelScope)
                : recomputeSharedDungeonProgress(levelScope) ?? getOrCreateSharedDungeonProgressState(levelScope);
            if (sharedState) {
                if (!forceSharedDungeonCompletion && sharedState.progress < 100) {
                    if (!hasSharedDungeonProgressHostiles(levelScope)) {
                        return;
                    }
                    return;
                }

                if (forceSharedDungeonCompletion) {
                    sharedState.progress = 100;
                    effectiveCompletionPercent = 100;
                    client.character.questTrackerState = 100;
                    MissionHandler.broadcastSharedDungeonQuestProgress(levelScope, 100);
                } else {
                    effectiveCompletionPercent = Math.max(effectiveCompletionPercent, Number(sharedState.progress ?? 0));
                }
                noteDungeonRunCompletionProgress(client, effectiveCompletionPercent);
                clearedDungeon =
                    forceSharedDungeonCompletion ||
                    effectiveCompletionPercent >= 100 ||
                    (requiredKills > 0 && remainingKills <= 0);

                const liveAuthorityToken = resolveSharedDungeonProgressAuthorityToken(levelScope);
                if (liveAuthorityToken > 0) {
                    sharedState.authorityToken = liveAuthorityToken;
                }

                if (!forceSharedDungeonCompletion && sharedState.authorityToken > 0 && client.token !== sharedState.authorityToken) {
                    return;
                }
            }
        }
        noteDungeonRunCompletionProgress(client, effectiveCompletionPercent);

        let didMutate = false;
        if (currentLevel === 'TutorialBoat' || currentLevel === 'TutorialDungeon') {
            clearedDungeon = true;
            if (currentLevel === 'TutorialBoat') {
                actualKills = Math.max(actualKills, requiredKills, 1);
            }
            if (Number(client.character.questTrackerState ?? 0) !== 100) {
                client.character.questTrackerState = 100;
                didMutate = true;
            }
            MissionHandler.sendQuestProgress(client, 100);
        }

        if (
            clearedDungeon &&
            currentLevel === 'TutorialBoat' &&
            MissionHandler.getMissionState(client.character, MissionID.DefendTheShip) === MissionHandler.MISSION_NOT_STARTED &&
            MissionHandler.getMissionState(client.character, MissionID.MeetTheTown) === MissionHandler.MISSION_NOT_STARTED
        ) {
            MissionHandler.setMissionState(
                client.character,
                MissionID.DefendTheShip,
                MissionHandler.MISSION_IN_PROGRESS,
                MissionLoader.getMissionDef(MissionID.DefendTheShip),
                { currCount: 0 }
            );
            didMutate = true;
        }

        const completionResult = MissionHandler.buildDungeonCompletionResult(
            client,
            currentLevel,
            levelScope,
            {
                completionPercent: effectiveCompletionPercent,
                bonusScoreTotal,
                goldReward,
                requiredKills,
                actualKills,
                dungeonCompleted: clearedDungeon
            }
        );

        let completedMissionId = 0;
        if (clearedDungeon) {
            const missionUpdate = MissionHandler.updateDungeonMissionResult(client.character, currentLevel, {
                stars: completionResult.stars,
                score: completionResult.totalScore,
                completedAt: Math.floor(Date.now() / 1000)
            });
            completedMissionId = missionUpdate.missionId;
            if (completedMissionId) {
                didMutate = true;
                if (missionUpdate.newlyCompleted) {
                    MissionHandler.sendMissionComplete(client, completedMissionId);
                }

                const completedMissionDef = MissionLoader.getMissionDef(completedMissionId);

                if (
                    missionUpdate.newlyCompleted &&
                    missionUpdate.state >= MissionHandler.MISSION_CLAIMED &&
                    completedMissionId !== MissionID.DefendTheShip &&
                    completedMissionDef &&
                    !MissionHandler.missionRequiresTurnIn(completedMissionDef)
                ) {
                    MissionHandler.sendMissionCompleteUi(
                        client,
                        completedMissionId,
                        missionUpdate.persistedStars,
                        missionUpdate.persistedScore
                    );
                }
            }

            if (currentLevel !== 'CraftTownTutorial' && MissionHandler.moveCharacterBackToSafeLevel(client.character, currentLevel)) {
                didMutate = true;
            }
        }

        if (didMutate) {
            await MissionHandler.saveCharacter(client);
        }

        MissionHandler.sendDungeonComplete(client, {
            stars: completionResult.stars,
            resultBar: completionResult.resultBar,
            rank: completionResult.rank,
            kills: completionResult.killsScore,
            accuracy: completionResult.accuracyScore,
            deaths: completionResult.deathsScore,
            treasure: completionResult.treasureScore,
            timeBonus: completionResult.timeBonusScore
        });
        if (forceSharedDungeonCompletion && client.forcedDungeonCompletionScope === levelScope) {
            client.forcedDungeonCompletionScope = '';
        }
    }

    static async handleForcedDungeonBossCompletion(client: Client, destroyedEntity: any): Promise<void> {
        if (!client.character) {
            return;
        }

        const currentLevel =
            LevelConfig.normalizeLevelName(client.currentLevel || String(client.character.CurrentLevel?.name ?? '')) ||
            client.currentLevel ||
            String(client.character.CurrentLevel?.name ?? '');
        if (!currentLevel || !LevelConfig.isDungeonLevel(currentLevel)) {
            return;
        }

        if (!MissionHandler.isDungeonBossEntity(destroyedEntity)) {
            return;
        }

        const levelScope = getClientLevelScope(client);
        if (!levelScope || client.forcedDungeonCompletionScope === levelScope) {
            return;
        }

        const authorityToken = resolveSharedDungeonProgressAuthorityToken(levelScope);
        if (authorityToken > 0 && authorityToken !== client.token) {
            return;
        }

        if (getActiveDungeonRunStats(client)?.finalizedStats) {
            return;
        }

        client.forcedDungeonCompletionScope = levelScope;
        try {
            await MissionHandler.handleSetLevelComplete(
                client,
                MissionHandler.buildSyntheticLevelCompletePacket(100)
            );
        } finally {
            if (client.forcedDungeonCompletionScope === levelScope && getActiveDungeonRunStats(client)?.finalizedStats) {
                client.forcedDungeonCompletionScope = '';
            }
        }
    }

    static async handleBadgeRequest(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const badgeKey = String(br.readMethod26() ?? '').trim();
        if (!badgeKey) {
            return;
        }

        const missionId = MissionLoader.getMissionIdByName(badgeKey);
        if (!missionId) {
            return;
        }

        const missionDef = MissionLoader.getMissionDef(missionId);
        if (!missionDef?.Tier) {
            return;
        }

        if (MissionHandler.getMissionState(client.character, missionId) >= MissionHandler.MISSION_CLAIMED) {
            return;
        }

        MissionHandler.setMissionState(
            client.character,
            missionId,
            MissionHandler.MISSION_CLAIMED,
            missionDef,
            { currCount: Math.max(1, Number(missionDef.CompleteCount ?? 1)) }
        );

        client.character.mammothIdols = Number(client.character.mammothIdols ?? 0) + MissionHandler.ACHIEVEMENT_MAMMOTH_IDOL_REWARD;

        MissionHandler.sendMissionProgress(client, missionId, 1);
        MissionHandler.sendMammothIdolUpdate(client);
        MissionHandler.sendAchievementCompleteUi(client, missionId);
        await MissionHandler.saveCharacter(client);
    }

    private static updateDungeonMissionResult(
        character: Character,
        currentLevel: string,
        completion: {
            stars: number;
            score: number;
            completedAt: number;
        }
    ): DungeonMissionUpdateResult {
        const missions = MissionHandler.getMissionStateMap(character);

        for (const [missionIdText, rawEntry] of Object.entries(missions)) {
            const missionId = Number(missionIdText);
            if (!Number.isFinite(missionId)) {
                continue;
            }

            const entry = MissionHandler.asMissionEntry(rawEntry);
            const currentState = Number(entry.state ?? MissionHandler.MISSION_NOT_STARTED);
            if (currentState <= MissionHandler.MISSION_NOT_STARTED) {
                continue;
            }

            const missionDef = MissionLoader.getMissionDef(missionId);
            if (!missionDef || missionDef.Dungeon !== currentLevel) {
                continue;
            }

            let nextState = currentState;
            let newlyCompleted = false;
            const existingStars = Math.max(0, Number(entry.Tier ?? 0));
            const existingScore = Math.max(0, Number(entry.highscore ?? 0));
            const shouldReplaceBest =
                completion.score > existingScore ||
                (completion.score === existingScore && completion.stars > existingStars);
            const persistedStars = shouldReplaceBest ? completion.stars : existingStars;
            const persistedScore = shouldReplaceBest ? completion.score : existingScore;
            const persistedTime = shouldReplaceBest
                ? completion.completedAt
                : Math.max(0, Number(entry.Time ?? completion.completedAt));

            if (currentState === MissionHandler.MISSION_IN_PROGRESS) {
                nextState = MissionHandler.missionRequiresTurnIn(missionDef)
                    ? MissionHandler.MISSION_READY_TO_TURN_IN
                    : MissionHandler.MISSION_CLAIMED;
                newlyCompleted = true;
            }

            MissionHandler.setMissionState(character, missionId, nextState, missionDef, {
                currCount: nextState >= MissionHandler.MISSION_READY_TO_TURN_IN
                    ? Math.max(1, Number(missionDef.CompleteCount ?? 1))
                    : Number(entry.currCount ?? 0),
                Tier: persistedStars,
                highscore: persistedScore,
                Time: persistedTime
            });
            return {
                missionId,
                state: nextState,
                newlyCompleted,
                persistedStars,
                persistedScore
            };
        }

        return {
            missionId: 0,
            state: MissionHandler.MISSION_NOT_STARTED,
            newlyCompleted: false,
            persistedStars: 0,
            persistedScore: 0
        };
    }

    private static autoAcceptFollowupMission(
        character: Character,
        npcName: string,
        excludeMissionId: number
    ): number {
        const normalizedNpc = MissionHandler.normalizeMissionNpcKey(npcName);
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

            if (MissionHandler.normalizeMissionNpcKey(missionDef.ContactName ?? '') !== normalizedNpc) {
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
        if (!MissionHandler.isMissionZoneUnlocked(character, missionDef)) {
            return false;
        }

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

    private static isMissionZoneUnlocked(character: Character, missionDef: MissionDef): boolean {
        const zoneSet = String(missionDef.ZoneSet ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);

        if (!zoneSet.length) {
            return true;
        }

        if (zoneSet.some((zone) => zone.startsWith('NewbieRoad') || zone.startsWith('Tutorial') || zone === 'CraftTownTutorial')) {
            return true;
        }

        return MissionHandler.getMissionState(character, MissionID.DeliverToSwamp) >= MissionHandler.MISSION_CLAIMED;
    }

    private static isMissionAvailableInCurrentLevel(missionDef: MissionDef, currentLevel: string): boolean {
        const zoneSet = String(missionDef.ZoneSet ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);

        return !zoneSet.length || zoneSet.includes(currentLevel);
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

    private static buildQuestProgressPayload(percent: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(Math.max(0, Math.min(100, Math.round(Number(percent ?? 0)))));
        return bb.toBuffer();
    }

    private static broadcastSharedDungeonQuestProgress(levelScope: string, progress: number): void {
        const payload = MissionHandler.buildQuestProgressPayload(progress);
        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== levelScope) {
                continue;
            }

            if (other.character) {
                other.character.questTrackerState = progress;
            }
            other.send(0xB7, payload);
        }
    }

    private static sendMissionProgress(client: Client, missionId: number, progress: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(missionId);
        bb.writeMethod4(Math.max(0, progress));
        client.sendBitBuffer(0x83, bb);
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

    private static sendAchievementCompleteUi(client: Client, missionId: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(missionId);
        bb.writeMethod11(0, 1);
        client.sendBitBuffer(0x84, bb);
    }

    private static sendMammothIdolUpdate(client: Client): void {
        if (!client.character) {
            return;
        }

        const bb = new BitBuffer(false);
        bb.writeMethod4(Number(client.character.mammothIdols ?? 0));
        bb.writeMethod4(0);
        bb.writeMethod11(client.character.showHigher ? 1 : 0, 1);
        client.sendBitBuffer(0xA1, bb);
    }

    private static clamp(value: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
    }

    private static getDungeonParTimeMs(levelName: string, killTarget: number): number {
        const normalizedKillTarget = Math.max(1, Math.round(Number(killTarget) || 0));
        const baseMinutes = 8 + (normalizedKillTarget * 0.3);
        const hardMultiplier = LevelConfig.get(levelName).isHard ? 1.1 : 1;
        return Math.max(60_000, Math.round(baseMinutes * hardMultiplier * 60_000));
    }

    private static buildDungeonCompletionResult(
        client: Client,
        currentLevel: string,
        levelScope: string,
        raw: {
            completionPercent: number;
            bonusScoreTotal: number;
            goldReward: number;
            requiredKills: number;
            actualKills: number;
            dungeonCompleted: boolean;
        }
    ): DungeonCompletionResult {
        const normalizedLevel = LevelConfig.normalizeLevelName(currentLevel) || currentLevel;
        const runStats = getActiveDungeonRunStats(client);
        const finalizedRun = finalizeDungeonRun(
            client,
            raw.dungeonCompleted ? 'success' : 'fail',
            {
                completionPercent: raw.completionPercent,
                dungeonCompleted: raw.dungeonCompleted
            }
        );
        const scoreSummary = finalizedRun?.scoreSummary ?? (runStats ? buildDungeonRunScoreSummary(runStats) : null);
        const profile: ResolvedDungeonScoreProfile =
            scoreSummary?.profile ?? getDungeonScoreProfile(normalizedLevel) ?? buildDefaultDungeonScoreProfile(normalizedLevel);
        const maxTotalScore = getDungeonScoreTotalCap(profile);
        const killsScore = Math.max(0, Number(scoreSummary?.finalStat.kills ?? 0));
        const accuracyScore = Math.max(0, Number(scoreSummary?.finalStat.accuracy ?? 0));
        const deathsScore = Math.max(0, Number(scoreSummary?.finalStat.deaths ?? 0));
        const treasureScore = Math.max(0, Number(scoreSummary?.finalStat.treasure ?? 0));
        const timeBonusScore = Math.max(0, Number(scoreSummary?.finalStat.timeBonus ?? 0));
        const totalScore = Math.max(0, Number(scoreSummary?.finalStat.total ?? (killsScore + accuracyScore + deathsScore + treasureScore + timeBonusScore)));
        const stars = Math.max(0, Math.min(10, Number(scoreSummary?.stars ?? 0)));
        const rank = Math.max(1, Math.min(10, Number(scoreSummary?.rank ?? 10)));
        const effectiveKillCount = Math.max(
            0,
            Number(finalizedRun?.killedEnemies ?? runStats?.killedEnemies ?? raw.actualKills ?? 0)
        );

        return {
            actualKills: effectiveKillCount,
            totalScore,
            stars,
            resultBar: scoreSummary?.resultBar ?? profile.resultBar,
            rank,
            killsScore,
            accuracyScore,
            deathsScore,
            treasureScore,
            timeBonusScore
        };
    }

    private static sendDungeonComplete(
        client: Client,
        stats: {
            stars: number;
            resultBar: number;
            rank: number;
            kills: number;
            accuracy: number;
            deaths: number;
            treasure: number;
            timeBonus: number;
        }
    ): void {
        const bb = new BitBuffer(false);
        bb.writeMethod6(Math.max(0, Math.min(stats.stars, 15)), 4);
        bb.writeMethod4(Math.max(0, stats.resultBar));
        bb.writeMethod4(Math.max(0, stats.rank));
        bb.writeMethod4(Math.max(0, stats.kills));
        bb.writeMethod4(Math.max(0, stats.accuracy));
        bb.writeMethod4(Math.max(0, stats.deaths));
        bb.writeMethod4(Math.max(0, stats.treasure));
        bb.writeMethod4(Math.max(0, stats.timeBonus));
        client.sendBitBuffer(0x87, bb);
    }

    private static buildSyntheticLevelCompletePacket(completionPercent: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod9(Math.max(0, Math.min(100, Math.round(Number(completionPercent ?? 0)))));
        bb.writeMethod9(0);
        bb.writeMethod9(0);
        bb.writeMethod9(0);
        bb.writeMethod9(0);
        bb.writeMethod9(0);
        bb.writeMethod9(0);
        bb.writeMethod9(1);
        bb.writeMethod9(3);
        return bb.toBuffer();
    }

    private static getMissionActiveTargetNames(missionDef: MissionDef): string[] {
        return String(missionDef.ActiveTarget ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);
    }

    private static getDefeatedEnemyNames(entity: any): string[] {
        const names = new Set<string>();
        for (const raw of [
            entity?.name,
            entity?.characterName,
            entity?.character_name
        ]) {
            const normalized = String(raw ?? '').trim();
            if (normalized) {
                names.add(normalized);
            }
        }
        return [...names];
    }

    private static isDungeonBossEntity(entity: any): boolean {
        const entityName = String(entity?.name ?? '').trim();
        const entType = entityName ? GameData.getEntType(entityName) ?? {} : {};
        const entRank = String(entity?.entRank ?? entType?.EntRank ?? '').trim();
        return entRank === 'Boss';
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

    private static repairCompletedDungeonMissionStates(
        character: Character,
        currentLevelRaw: string
    ): boolean {
        if (Number(character.questTrackerState ?? 0) < 100) {
            return false;
        }

        const currentLevel =
            LevelConfig.normalizeLevelName(currentLevelRaw || String(character.CurrentLevel?.name ?? '')) ||
            String(currentLevelRaw || character.CurrentLevel?.name || '');
        const missions = MissionHandler.getMissionStateMap(character);
        let didMutate = false;

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
            const dungeonLevel =
                LevelConfig.normalizeLevelName(String(missionDef?.Dungeon ?? '')) ||
                String(missionDef?.Dungeon ?? '').trim();
            if (!missionDef || !dungeonLevel || currentLevel === dungeonLevel) {
                continue;
            }

            MissionHandler.setMissionState(
                character,
                missionId,
                MissionHandler.missionRequiresTurnIn(missionDef)
                    ? MissionHandler.MISSION_READY_TO_TURN_IN
                    : MissionHandler.MISSION_CLAIMED,
                missionDef,
                {
                    currCount: Math.max(1, Number(missionDef.CompleteCount ?? 1)),
                    Tier: Number(entry.Tier ?? 0),
                    highscore: Number(entry.highscore ?? 0),
                    Time: Number(entry.Time ?? 0)
                }
            );
            didMutate = true;
        }

        return didMutate;
    }

    private static async saveCharacter(client: Client): Promise<void> {
        if (!client.userId || !client.character) {
            return;
        }

        const chars = await db.loadCharacters(client.userId);
        const idx = chars.findIndex((entry) => entry.name === client.character?.name);
        if (idx !== -1) {
            chars[idx] = client.character;
        } else {
            chars.push(client.character);
        }
        client.characters = chars;
        await db.saveCharacters(client.userId, chars);
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
            next.Tier = Number(extra.Tier ?? next.Tier ?? 0);
            next.highscore = Number(extra.highscore ?? next.highscore ?? 0);
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

    private static normalizeMissionNpcKey(value: string): string {
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
