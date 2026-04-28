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
import { EntityState, EntityTeam } from '../core/Entity';
import { BuildingID } from '../core/Enums';
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
import { RewardHandler } from './RewardHandler';

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
    static readonly DUNGEON_COMPLETION_SKIT_SETTLE_MS = 1500;
    static readonly DUNGEON_COMPLETION_MAX_DEFER_MS = 15000;
    static readonly CRAFT_TOWN_TUTORIAL_COMPLETION_DELAY_MS = 43 * 250;
    private static readonly PRIMED_CONTACT_DIALOGUE_COUNT = -1;
    private static readonly ACHIEVEMENT_MAMMOTH_IDOL_REWARD = 10;
    private static readonly CRAFT_TOWN_REPAIRED_KEEP_RANK = 5;
    private static readonly CRAFT_TOWN_TUTORIAL_BOSS_NAMES = new Set([
        'GoblinShamanHood',
        'IntroGoblinShamanHood'
    ]);
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
    private static readonly SWAMP_SPIDER_KILL_NAMES = new Set([
        'SwampSpider',
        'SwampSpider2',
        'SwampSpiderGiant',
        'SwampSpiderSuperGiant',
        'SwampSpiderQueen'
    ]);
    private static readonly SWAMP_SPIDER_HARD_KILL_NAMES = new Set([
        'SwampSpiderHard',
        'SwampSpider2Hard',
        'SwampSpiderGiantHard',
        'SwampSpiderSuperGiantHard',
        'SwampSpiderQueenHard'
    ]);
    private static readonly SWAMP_LIZARD_BANNER_KILL_NAMES = new Set([
        'LizardBanner'
    ]);
    private static readonly SWAMP_LIZARD_BANNER_HARD_KILL_NAMES = new Set([
        'LizardBannerHard'
    ]);
    private static readonly KILL_PROGRESS_TARGETS: Readonly<Record<number, ReadonlySet<string>>> = {
        [MissionID.GetGoblinNoserings]: new Set(['GoblinBrute']),
        [MissionID.GetGoblinWands]: new Set(['GoblinShamanHood', 'GoblinShamanSkullHat']),
        [MissionID.GetGoblinNoseringsHard]: new Set(['GoblinBruteHard']),
        [MissionID.GetGoblinWandsHard]: new Set(['GoblinShamanHoodHard', 'GoblinShamanSkullHatHard']),
        [MissionID.KillGoblins]: MissionHandler.NEWBIE_ROAD_GOBLIN_KILL_NAMES,
        [MissionID.KillGoblinsHard]: MissionHandler.NEWBIE_ROAD_HARD_GOBLIN_KILL_NAMES,
        [MissionID.GetLizardBanners]: MissionHandler.SWAMP_LIZARD_BANNER_KILL_NAMES,
        [MissionID.GetLizardBannersHard]: MissionHandler.SWAMP_LIZARD_BANNER_HARD_KILL_NAMES,
        [MissionID.GetSpiderFangs]: MissionHandler.SWAMP_SPIDER_KILL_NAMES,
        [MissionID.GetSpiderFangsHard]: MissionHandler.SWAMP_SPIDER_HARD_KILL_NAMES,
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

        if (
            currentLevel === 'CraftTown' &&
            questProgress >= 100 &&
            MissionHandler.getMissionState(character, MissionID.ClearYourHouse) === MissionHandler.MISSION_IN_PROGRESS
        ) {
            const keepMissionDef = MissionLoader.getMissionDef(MissionID.ClearYourHouse);
            MissionHandler.setMissionState(
                character,
                MissionID.ClearYourHouse,
                MissionHandler.MISSION_READY_TO_TURN_IN,
                keepMissionDef,
                { currCount: Math.max(1, Number(keepMissionDef?.CompleteCount ?? 1)) }
            );
            MissionHandler.ensureCraftTownKeepRepaired(character);
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
            const allowDungeonEnemyProgress =
                LevelConfig.isDungeonLevel(currentLevel) &&
                !String(missionDef?.Dungeon ?? '').trim();
            if (!missionDef || (!allowDungeonEnemyProgress && !MissionHandler.isMissionAvailableInCurrentLevel(missionDef, currentLevel))) {
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

        const pendingScope = String(client.pendingDungeonCompletionScope ?? '').trim();
        if (
            pendingScope &&
            !client.pendingDungeonCompletionFlushActive &&
            pendingScope === getClientLevelScope(client)
        ) {
            if (client.pendingDungeonCompletionWaitForCutsceneEnd) {
                client.pendingDungeonCompletionPayload = Buffer.from(data);
                return;
            }
            MissionHandler.clearPendingDungeonCompletion(client);
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
        const defeatedDungeonBossForcesCompletion = MissionHandler.hasDefeatedDungeonBoss(client, levelScope);
        const activeCutsceneScope = String(client.activeDungeonCutsceneScope ?? '').trim();
        if (
            levelScope &&
            activeCutsceneScope === levelScope &&
            !client.pendingDungeonCompletionFlushActive
        ) {
            MissionHandler.scheduleDungeonCompletion(
                client,
                data,
                {
                    forcedDungeonCompletionScope: forceSharedDungeonCompletion ? levelScope : undefined,
                    initialDelayMs: 0,
                    settleDelayMs: 0,
                    waitForCutsceneEnd: true
                }
            );
            return;
        }

        const trackerCompletionPercent = Math.max(0, Number(client.character.questTrackerState ?? 0));
        let effectiveCompletionPercent = isWolfsEndDungeonLevel(currentLevel)
            ? Math.max(completionPercent, trackerCompletionPercent)
            : completionPercent;
        let actualKills = Math.max(requiredKills - remainingKills, 0);
        let clearedDungeon =
            effectiveCompletionPercent >= 100 ||
            (requiredKills > 0 && remainingKills <= 0);
        const allowCraftTownTutorialClientCompletion =
            currentLevel === 'CraftTownTutorial' &&
            Boolean(client.keepTutorialState?.bossDefeated) &&
            clearedDungeon;

        if (usesSharedDungeonProgress(currentLevel) && levelScope) {
            const sharedState = forceSharedDungeonCompletion || defeatedDungeonBossForcesCompletion
                ? getOrCreateSharedDungeonProgressState(levelScope)
                : recomputeSharedDungeonProgress(levelScope) ?? getOrCreateSharedDungeonProgressState(levelScope);
            if (sharedState) {
                if (!forceSharedDungeonCompletion && !defeatedDungeonBossForcesCompletion && sharedState.progress < 100) {
                    if (allowCraftTownTutorialClientCompletion) {
                        sharedState.progress = 100;
                        effectiveCompletionPercent = 100;
                        client.character.questTrackerState = 100;
                        MissionHandler.broadcastSharedDungeonQuestProgress(levelScope, 100);
                    } else {
                        if (!hasSharedDungeonProgressHostiles(levelScope)) {
                            return;
                        }
                        return;
                    }
                }

                if (forceSharedDungeonCompletion || defeatedDungeonBossForcesCompletion) {
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
                    defeatedDungeonBossForcesCompletion ||
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
            currentLevel !== 'TutorialBoat' &&
            currentLevel !== 'TutorialDungeon'
        ) {
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
                    MissionHandler.sendMissionAdded(client, completedMissionId, missionUpdate.state);
                    MissionHandler.sendMissionComplete(client, completedMissionId);
                }

                const completedMissionDef = MissionLoader.getMissionDef(completedMissionId);

                if (
                    missionUpdate.newlyCompleted &&
                    completedMissionId !== MissionID.DefendTheShip &&
                    completedMissionId !== MissionID.ClearYourHouse &&
                    completedMissionDef
                ) {
                    MissionHandler.sendMissionCompleteUi(
                        client,
                        completedMissionId,
                        missionUpdate.persistedStars,
                        missionUpdate.persistedScore
                    );
                }

                const primedMissionId = MissionHandler.primeRescueAnnaFollowup(client, completedMissionId);
                if (primedMissionId > 0) {
                    didMutate = true;
                }

                if (
                    currentLevel === 'CraftTownTutorial' &&
                    completedMissionId === MissionID.ClearYourHouse &&
                    MissionHandler.ensureCraftTownKeepRepaired(client.character)
                ) {
                    didMutate = true;
                }

                if (
                    missionUpdate.newlyCompleted &&
                    completedMissionId === MissionID.ClearYourHouse &&
                    MissionHandler.claimKeepQuestCompletionReward(client, missionUpdate)
                ) {
                    didMutate = true;
                }
            }

            if (
                currentLevel !== 'CraftTownTutorial' &&
                currentLevel !== 'TutorialBoat' &&
                MissionHandler.moveCharacterBackToSafeLevel(client.character, currentLevel)
            ) {
                didMutate = true;
            }
        }

        if (didMutate) {
            await MissionHandler.saveCharacter(client);
        }

        if (
            currentLevel === 'CraftTownTutorial' &&
            completedMissionId === MissionID.ClearYourHouse
        ) {
            MissionHandler.sendCraftTownTutorialHomeDoorTarget(client);
        } else {
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
        }
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
        if (!currentLevel) {
            return;
        }

        const levelScope = getClientLevelScope(client);
        if (!levelScope || client.forcedDungeonCompletionScope === levelScope) {
            return;
        }

        if (currentLevel === 'CraftTownTutorial') {
            if (!MissionHandler.isCraftTownTutorialBossEntity(destroyedEntity)) {
                return;
            }

            MissionHandler.scheduleDungeonCompletion(
                client,
                MissionHandler.buildSyntheticLevelCompletePacket(100),
                {
                    forcedDungeonCompletionScope: levelScope,
                    initialDelayMs: 0,
                    settleDelayMs: 0,
                    waitForCutsceneEnd: true
                }
            );
            return;
        }

        if (!LevelConfig.isDungeonLevel(currentLevel)) {
            return;
        }

        if (currentLevel === 'TutorialBoat') {
            return;
        }

        if (!MissionHandler.shouldForceCompleteDungeonOnEnemyDefeat(levelScope, destroyedEntity)) {
            return;
        }

        const authorityToken = resolveSharedDungeonProgressAuthorityToken(levelScope);
        if (authorityToken > 0 && authorityToken !== client.token) {
            return;
        }

        if (getActiveDungeonRunStats(client)?.finalizedStats) {
            return;
        }

        const isCutsceneActive = String(client.activeDungeonCutsceneScope ?? '').trim() === levelScope;
        const cutsceneStartAt = String(client.lastDungeonCutsceneStartScope ?? '').trim() === levelScope
            ? Math.max(0, Number(client.lastDungeonCutsceneStartAt ?? 0))
            : 0;
        const cutsceneEndAt = String(client.lastDungeonCutsceneEndScope ?? '').trim() === levelScope
            ? Math.max(0, Number(client.lastDungeonCutsceneEndAt ?? 0))
            : 0;
        const isBossEntity = MissionHandler.isDungeonBossEntity(destroyedEntity);
        const normalizedLevel = LevelConfig.normalizeLevelName(currentLevel) || String(currentLevel ?? '').trim();
        const shouldWaitForPostBossCutscene =
            isBossEntity &&
            (normalizedLevel === 'GoblinRiverDungeon' ||
             normalizedLevel === 'GoblinRiverDungeonHard' ||
             normalizedLevel === 'GhostBossDungeon' ||
             normalizedLevel === 'GhostBossDungeonHard');
        const waitForCutsceneEnd = isCutsceneActive ||
            shouldWaitForPostBossCutscene ||
            (isBossEntity && (cutsceneEndAt <= 0 || cutsceneEndAt < cutsceneStartAt));
        const instantCompletion = isBossEntity && !shouldWaitForPostBossCutscene;
        MissionHandler.scheduleDungeonCompletion(
            client,
            MissionHandler.buildSyntheticLevelCompletePacket(100),
            {
                forcedDungeonCompletionScope: levelScope,
                initialDelayMs: (waitForCutsceneEnd || instantCompletion) ? 0 : undefined,
                settleDelayMs: (waitForCutsceneEnd || instantCompletion) ? 0 : undefined,
                waitForCutsceneEnd
            }
        );
    }

    static scheduleDungeonCompletion(
        client: Client,
        payload: Buffer,
        options: {
            forcedDungeonCompletionScope?: string;
            initialDelayMs?: number;
            settleDelayMs?: number;
            waitForCutsceneEnd?: boolean;
        } = {}
    ): void {
        const levelScope = getClientLevelScope(client);
        if (!client.character || !levelScope) {
            return;
        }

        const now = Date.now();
        const initialDelayMs = Math.max(
            0,
            Math.round(Number(options.initialDelayMs ?? MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS))
        );
        const settleDelayMs = Math.max(
            0,
            Math.round(Number(options.settleDelayMs ?? MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS))
        );
        client.pendingDungeonCompletionScope = levelScope;
        client.pendingDungeonCompletionRequestedAt = now;
        client.pendingDungeonCompletionLastSkitAt = now;
        client.pendingDungeonCompletionNotBeforeAt = now + initialDelayMs;
        client.pendingDungeonCompletionSettleMs = settleDelayMs;
        client.pendingDungeonCompletionPayload = Buffer.from(payload);
        client.pendingDungeonCompletionForceSharedScope = String(options.forcedDungeonCompletionScope ?? '').trim();
        client.pendingDungeonCompletionWaitForCutsceneEnd = Boolean(options.waitForCutsceneEnd);

        MissionHandler.armPendingDungeonCompletionTimer(
            client,
            client.pendingDungeonCompletionWaitForCutsceneEnd
                ? MissionHandler.DUNGEON_COMPLETION_MAX_DEFER_MS
                : initialDelayMs
        );
    }

    static noteDungeonSkitActivity(client: Client): void {
        const pendingScope = String(client.pendingDungeonCompletionScope ?? '').trim();
        if (!pendingScope || getClientLevelScope(client) !== pendingScope) {
            return;
        }

        if (client.pendingDungeonCompletionWaitForCutsceneEnd) {
            return;
        }

        client.pendingDungeonCompletionLastSkitAt = Date.now();
        const settleDelayMs = Math.max(0, Number(client.pendingDungeonCompletionSettleMs ?? MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS));
        const remainingNotBeforeMs = Math.max(
            0,
            Number(client.pendingDungeonCompletionNotBeforeAt ?? 0) - Date.now()
        );
        MissionHandler.armPendingDungeonCompletionTimer(
            client,
            Math.max(remainingNotBeforeMs, settleDelayMs)
        );
    }

    static noteDungeonCutsceneStart(client: Client, roomId: number): void {
        const scope = getClientLevelScope(client);
        if (!scope) {
            return;
        }

        client.activeDungeonCutsceneScope = scope;
        client.activeDungeonCutsceneRoomId = Math.max(0, Math.round(Number(roomId ?? 0)));
        client.lastDungeonCutsceneStartScope = scope;
        client.lastDungeonCutsceneStartAt = Date.now();
    }

    static noteDungeonCutsceneEnd(client: Client, roomId: number): void {
        const scope = getClientLevelScope(client);
        if (!scope) {
            return;
        }

        const endedRoomId = Math.max(0, Math.round(Number(roomId ?? 0)));
        const activeCutsceneScope = String(client.activeDungeonCutsceneScope ?? '').trim();
        if (
            activeCutsceneScope === scope &&
            client.activeDungeonCutsceneRoomId > 0 &&
            endedRoomId > 0 &&
            client.activeDungeonCutsceneRoomId !== endedRoomId
        ) {
            return;
        }

        client.lastDungeonCutsceneEndScope = scope;
        client.lastDungeonCutsceneEndAt = Date.now();
        if (!client.lastDungeonCutsceneStartScope) {
            client.lastDungeonCutsceneStartScope = scope;
            client.lastDungeonCutsceneStartAt = client.lastDungeonCutsceneEndAt;
        }

        if (activeCutsceneScope === scope) {
            client.activeDungeonCutsceneScope = '';
            client.activeDungeonCutsceneRoomId = 0;
        }

        const pendingScope = String(client.pendingDungeonCompletionScope ?? '').trim();
        if (pendingScope && pendingScope === scope) {
            client.pendingDungeonCompletionWaitForCutsceneEnd = false;
            void MissionHandler.flushPendingDungeonCompletion(client);
        }
    }

    private static armPendingDungeonCompletionTimer(client: Client, delayMs: number): void {
        if (client.pendingDungeonCompletionTimer) {
            clearTimeout(client.pendingDungeonCompletionTimer);
        }

        const safeDelay = Math.max(0, Math.round(Number(delayMs ?? 0)));
        client.pendingDungeonCompletionTimer = setTimeout(() => {
            client.pendingDungeonCompletionTimer = null;
            void MissionHandler.flushPendingDungeonCompletion(client);
        }, safeDelay);
        client.pendingDungeonCompletionTimer.unref?.();
    }

    private static clearPendingDungeonCompletion(client: Client): void {
        if (client.pendingDungeonCompletionTimer) {
            clearTimeout(client.pendingDungeonCompletionTimer);
            client.pendingDungeonCompletionTimer = null;
        }
        client.pendingDungeonCompletionScope = '';
        client.pendingDungeonCompletionRequestedAt = 0;
        client.pendingDungeonCompletionLastSkitAt = 0;
        client.pendingDungeonCompletionNotBeforeAt = 0;
        client.pendingDungeonCompletionSettleMs = 0;
        client.pendingDungeonCompletionPayload = null;
        client.pendingDungeonCompletionForceSharedScope = '';
        client.pendingDungeonCompletionFlushActive = false;
        client.pendingDungeonCompletionWaitForCutsceneEnd = false;
    }

    private static async flushPendingDungeonCompletion(client: Client): Promise<void> {
        const pendingScope = String(client.pendingDungeonCompletionScope ?? '').trim();
        const currentScope = getClientLevelScope(client);
        const payload = client.pendingDungeonCompletionPayload;
        if (!client.character || !pendingScope || !payload || currentScope !== pendingScope) {
            MissionHandler.clearPendingDungeonCompletion(client);
            return;
        }

        const now = Date.now();
        const requestedAt = Math.max(0, Number(client.pendingDungeonCompletionRequestedAt ?? 0));
        if (client.pendingDungeonCompletionWaitForCutsceneEnd) {
            const cutsceneWaitDeadlineAt = requestedAt + MissionHandler.DUNGEON_COMPLETION_MAX_DEFER_MS;
            if (now < cutsceneWaitDeadlineAt) {
                MissionHandler.armPendingDungeonCompletionTimer(client, cutsceneWaitDeadlineAt - now);
                return;
            }

            client.pendingDungeonCompletionWaitForCutsceneEnd = false;
            if (String(client.activeDungeonCutsceneScope ?? '').trim() === pendingScope) {
                client.activeDungeonCutsceneScope = '';
                client.activeDungeonCutsceneRoomId = 0;
            }
        }

        const activeCutsceneScope = String(client.activeDungeonCutsceneScope ?? '').trim();
        if (activeCutsceneScope && activeCutsceneScope === pendingScope) {
            MissionHandler.armPendingDungeonCompletionTimer(client, MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS);
            return;
        }

        const lastSkitAt = Math.max(requestedAt, Number(client.pendingDungeonCompletionLastSkitAt ?? 0));
        const notBeforeAt = Math.max(requestedAt, Number(client.pendingDungeonCompletionNotBeforeAt ?? 0));
        const settleDelayMs = Math.max(0, Number(client.pendingDungeonCompletionSettleMs ?? MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS));
        const quietForMs = now - lastSkitAt;
        const maxQuietWaitDeadline = Math.max(
            requestedAt + MissionHandler.DUNGEON_COMPLETION_MAX_DEFER_MS,
            notBeforeAt + settleDelayMs
        );

        if (now < notBeforeAt) {
            MissionHandler.armPendingDungeonCompletionTimer(client, notBeforeAt - now);
            return;
        }

        if (
            quietForMs < settleDelayMs &&
            now < maxQuietWaitDeadline
        ) {
            MissionHandler.armPendingDungeonCompletionTimer(
                client,
                settleDelayMs - quietForMs
            );
            return;
        }

        const forcedScope = String(client.pendingDungeonCompletionForceSharedScope ?? '').trim();
        MissionHandler.clearPendingDungeonCompletion(client);

        if (forcedScope) {
            client.forcedDungeonCompletionScope = forcedScope;
        }

        try {
            client.pendingDungeonCompletionFlushActive = true;
            await MissionHandler.handleSetLevelComplete(client, payload);
        } finally {
            client.pendingDungeonCompletionFlushActive = false;
            if (forcedScope && client.forcedDungeonCompletionScope === forcedScope && getActiveDungeonRunStats(client)?.finalizedStats) {
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

    private static primeRescueAnnaFollowup(client: Client, completedMissionId: number): number {
        if (!client.character || completedMissionId !== MissionID.RescueAnna) {
            return 0;
        }

        if (MissionHandler.getMissionState(client.character, MissionID.FindAnnasFather) !== MissionHandler.MISSION_NOT_STARTED) {
            return 0;
        }

        const missionDef = MissionLoader.getMissionDef(MissionID.FindAnnasFather);
        if (!missionDef || !MissionHandler.canStartMission(client.character, missionDef)) {
            return 0;
        }

        const initialState = MissionHandler.getInitialMissionState(missionDef);
        if (initialState !== MissionHandler.MISSION_READY_TO_TURN_IN) {
            return 0;
        }

        MissionHandler.setMissionState(
            client.character,
            MissionID.FindAnnasFather,
            initialState,
            missionDef,
            { currCount: MissionHandler.PRIMED_CONTACT_DIALOGUE_COUNT }
        );
        MissionHandler.sendMissionAdded(client, MissionID.FindAnnasFather, initialState);
        return MissionID.FindAnnasFather;
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

    private static claimKeepQuestCompletionReward(
        client: Client,
        missionUpdate: DungeonMissionUpdateResult
    ): boolean {
        if (!client.character || missionUpdate.missionId !== MissionID.ClearYourHouse) {
            return false;
        }

        const missionDef = MissionLoader.getMissionDef(MissionID.ClearYourHouse);
        if (!missionDef) {
            return false;
        }

        MissionHandler.setMissionState(
            client.character,
            MissionID.ClearYourHouse,
            MissionHandler.MISSION_CLAIMED,
            missionDef,
            {
                currCount: Math.max(1, Number(missionDef.CompleteCount ?? 1)),
                Tier: missionUpdate.persistedStars,
                highscore: missionUpdate.persistedScore
            }
        );
        MissionHandler.sendMissionCompleteUi(
            client,
            MissionID.ClearYourHouse,
            missionUpdate.persistedStars,
            missionUpdate.persistedScore
        );
        MissionHandler.grantMissionRewards(client, missionDef);
        return true;
    }

    private static grantMissionRewards(client: Client, missionDef: MissionDef): void {
        if (!client.character) {
            return;
        }

        const expReward = Math.max(0, Number(missionDef.ExpRewardValue ?? 0));
        if (expReward > 0) {
            client.character.xp = Number(client.character.xp ?? 0) + expReward;
            client.character.level = GameData.getPlayerLevelFromXp(Number(client.character.xp ?? 0));
            MissionHandler.sendXpReward(client, expReward);
        }

        const goldReward = Math.max(0, Number(missionDef.GoldRewardValue ?? 0));
        if (goldReward > 0) {
            client.character.gold = Number(client.character.gold ?? 0) + goldReward;
            RewardHandler.sendGoldReward(client, goldReward, false);
        }
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
        if (Number(missionDef.MissionID ?? 0) === MissionID.ClearYourHouse) {
            return true;
        }

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

    private static sendXpReward(client: Client, amount: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(amount);
        client.sendBitBuffer(0x2B, bb);
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

    private static ensureCraftTownKeepRepaired(character: Character): boolean {
        const magicForge = (character.magicForge ??= { stats_by_building: {} } as any);
        if (!magicForge.stats_by_building) {
            magicForge.stats_by_building = {};
        }

        const statsByBuilding = magicForge.stats_by_building as Record<string, unknown>;
        const keepKey = String(BuildingID.Keep);
        const currentRank = Number(statsByBuilding[keepKey] ?? 0);
        if (
            Number.isFinite(currentRank) &&
            currentRank >= MissionHandler.CRAFT_TOWN_REPAIRED_KEEP_RANK
        ) {
            return false;
        }

        statsByBuilding[keepKey] = MissionHandler.CRAFT_TOWN_REPAIRED_KEEP_RANK;
        if (character.buildingUpgrade?.buildingID === BuildingID.Keep) {
            character.buildingUpgrade = { buildingID: 0, rank: 0, ReadyTime: 0 };
        }
        return true;
    }

    private static sendCraftTownTutorialHomeDoorTarget(client: Client): void {
        const doorId = 2;
        const targetLevel = 'CraftTown';

        client.lastDoorId = doorId;
        client.lastDoorTargetLevel = targetLevel;
        client.armPendingTransferGrace?.();

        const bb = new BitBuffer();
        bb.writeMethod4(doorId);
        bb.writeMethod13(targetLevel);
        client.sendBitBuffer(0x2E, bb);
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
        return GameData.isBossEntity(entity);
    }

    private static isCraftTownTutorialBossEntity(entity: any): boolean {
        return MissionHandler.CRAFT_TOWN_TUTORIAL_BOSS_NAMES.has(String(entity?.name ?? '').trim());
    }

    private static shouldForceCompleteDungeonOnEnemyDefeat(levelScope: string, entity: any): boolean {
        if (MissionHandler.isDungeonBossEntity(entity)) {
            return true;
        }

        return !MissionHandler.hasRemainingDungeonHostiles(levelScope);
    }

    private static hasDefeatedDungeonBoss(client: Client, levelScope: string | null | undefined): boolean {
        const scopeKey = String(levelScope ?? '').trim();
        if (!scopeKey) {
            return false;
        }

        const stats = getActiveDungeonRunStats(client);
        if (stats && stats.levelScope === scopeKey && stats.bossKilled) {
            return true;
        }

        const levelMap = GlobalState.levelEntities.get(scopeKey);
        if (!levelMap?.size) {
            return false;
        }

        for (const entity of levelMap.values()) {
            if (
                entity &&
                !entity.isPlayer &&
                Number(entity.team ?? 0) === EntityTeam.ENEMY &&
                MissionHandler.isDungeonBossEntity(entity) &&
                (
                    Boolean(entity.dead) ||
                    Number(entity.entState ?? EntityState.ACTIVE) === EntityState.DEAD ||
                    Number(entity.hp ?? 1) <= 0
                )
            ) {
                return true;
            }
        }

        return false;
    }

    private static hasRemainingDungeonHostiles(levelScope: string): boolean {
        const levelMap = GlobalState.levelEntities.get(levelScope);
        if (!levelMap?.size) {
            return false;
        }

        for (const candidate of levelMap.values()) {
            if (MissionHandler.isAliveDungeonHostile(candidate)) {
                return true;
            }
        }

        return false;
    }

    private static isAliveDungeonHostile(entity: any): boolean {
        if (!entity || entity.isPlayer) {
            return false;
        }

        if (Number(entity.team ?? 0) !== EntityTeam.ENEMY) {
            return false;
        }

        if (Boolean(entity.untargetable)) {
            return false;
        }

        if (Boolean(entity.dead) || Number(entity.entState ?? EntityState.ACTIVE) === EntityState.DEAD) {
            return false;
        }

        if (Number(entity.hp ?? 1) <= 0) {
            return false;
        }

        return true;
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
            npcanna: 'nranna03',
            annaoutside: 'nranna03',
            npcannaoutside: 'nranna03',
            nrquestanna01: 'nranna03',
            nrquestanna02: 'nranna03',
            nrquestanna03: 'nranna03',
            annaoutsidehard: 'nranna03hard',
            npcannaoutsidehard: 'nranna03hard',
            nrquestanna01hard: 'nranna03hard',
            nrquestanna02hard: 'nranna03hard',
            nrquestanna03hard: 'nranna03hard',
            pecky: 'nrpecky',
            captainfink: 'nrcaptfink',
            fink: 'nrcaptfink'
        };

        return aliases[normalized] ?? normalized;
    }
}
