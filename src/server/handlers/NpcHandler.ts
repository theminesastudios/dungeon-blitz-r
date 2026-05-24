import { Client } from '../core/Client';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { Character } from '../database/Database';
import { MissionDialogueLoader } from '../data/MissionDialogueLoader';
import { NpcDialogueLoader } from '../data/NpcDialogueLoader';
import { MissionDef, MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { NpcLoader } from '../data/NpcLoader';
import { LevelConfig } from '../core/LevelConfig';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { getClientLevelScope } from '../core/LevelScope';
import { RewardHandler } from './RewardHandler';
import { MissionHandler } from './MissionHandler';

type MissionEntry = Record<string, any>;
type ResolvedNpc = Record<string, any>;

export class NpcHandler {
    private static readonly MISSION_NOT_STARTED = 0;
    private static readonly MISSION_IN_PROGRESS = 1;
    private static readonly MISSION_READY_TO_TURN_IN = 2;
    private static readonly MISSION_CLAIMED = 3;
    private static readonly PRIMED_CONTACT_DIALOGUE_COUNT = -1;
    private static readonly FIRST_MISSION_ID = MissionID.DefendTheShip;
    private static readonly FIRST_MISSION_NPC_KEY = 'nrcaptfink';
    private static readonly RETURN_DIALOGUE_BASE_MS = 10;
    private static readonly RETURN_DIALOGUE_CHAR_MS = 1;
    private static readonly DEFAULT_TURN_IN_STARS = 3;
    private static readonly DEFAULT_DIALOGUE_LANGUAGE = 'en';
    private static readonly ATTACK_OF_OPPORTUNITY_MISSION_ID = 233;
    private static readonly ATTACK_OF_OPPORTUNITY_HARD_MISSION_ID = 254;
    private static readonly ATTACK_OF_OPPORTUNITY_SATELLITE_IDS = new Set([234, 235, 236]);
    private static readonly ATTACK_OF_OPPORTUNITY_HARD_SATELLITE_IDS = new Set([255, 256, 257]);
    private static readonly STONE_ORACLE_MISSION_BY_MOAI_KEY: Readonly<Record<string, { missionId: number; bit: number }>> = {
        ommmoai01: { missionId: MissionID.StoneOraclesSpeak, bit: 1 },
        ommmoai02: { missionId: MissionID.StoneOraclesSpeak, bit: 2 },
        ommmoai03: { missionId: MissionID.StoneOraclesSpeak, bit: 4 },
        ommmoai01hard: { missionId: MissionID.StoneOraclesSpeakHard, bit: 1 },
        ommmoai02hard: { missionId: MissionID.StoneOraclesSpeakHard, bit: 2 },
        ommmoai03hard: { missionId: MissionID.StoneOraclesSpeakHard, bit: 4 }
    };

    private static persistCharacter(client: Client, reason: string): void {
        if (!client.userId || !client.character) {
            return;
        }

        const index = client.characters.findIndex((entry) => entry.name === client.character?.name);
        if (index >= 0) {
            client.characters[index] = client.character;
        } else {
            client.characters.push(client.character);
        }
        if (typeof client.scheduleCharacterSave === 'function') {
            client.scheduleCharacterSave(reason);
        }
    }

    static async handleTalkToNpc(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const npcId = br.readMethod9();
        const levelName = String(client.currentLevel || client.character.CurrentLevel?.name || '');
        const npc = NpcHandler.findNpc(client, levelName, npcId);

        let dialogueId = 0;
        let missionId = 0;
        let didMutate = false;
        let missionNpcKey = '';
        let dialogueNpcKey = '';
        let delayedFirstMissionTurnIn = false;

        if (npc) {
            const rawNpcKey = String(
                npc.characterName ??
                npc.character_name ??
                npc.entType ??
                npc.name ??
                ''
            );
            missionNpcKey = NpcHandler.normalizeMissionNpcKey(rawNpcKey);
            dialogueNpcKey = NpcHandler.normalizeNpcKey(rawNpcKey);

            if (
                missionNpcKey === NpcHandler.FIRST_MISSION_NPC_KEY &&
                client.pendingMissionTurnIns.has(NpcHandler.FIRST_MISSION_ID)
            ) {
                return;
            }

            if (
                missionNpcKey === NpcHandler.FIRST_MISSION_NPC_KEY &&
                NpcHandler.getMissionState(client.character, NpcHandler.FIRST_MISSION_ID) < NpcHandler.MISSION_CLAIMED
            ) {
                const storyRepair = MissionHandler.repairEarlyStoryOnLogin(client.character, levelName);
                if (storyRepair.didMutate) {
                    didMutate = true;
                }
            }

            if (NpcHandler.repairCompletedKeepQuestTurnIn(client.character, missionNpcKey)) {
                didMutate = true;
            }
            if (NpcHandler.repairCompletedDungeonQuestTurnIn(client.character, missionNpcKey)) {
                didMutate = true;
            }
            if (NpcHandler.noteStoneOracleConsulted(client, missionNpcKey)) {
                didMutate = true;
            }

            const matched = NpcHandler.findBestMission(client.character, missionNpcKey);
            if (matched) {
                dialogueId = matched.dialogueId;
                missionId = matched.missionId;

                if (dialogueId === 2 && matched.state === NpcHandler.MISSION_NOT_STARTED) {
                    const missionDef = MissionLoader.getMissionDef(missionId);
                    const aggregateProgress = NpcHandler.getAggregateMissionStartProgress(
                        client.character,
                        missionDef
                    );
                    const initialState = aggregateProgress?.state ?? NpcHandler.getInitialMissionState(missionDef);
                    NpcHandler.setMissionState(
                        client.character,
                        missionId,
                        initialState,
                        aggregateProgress ? { currCount: aggregateProgress.currCount } : {}
                    );
                    NpcHandler.resetQuestTrackerForStartedDungeonMission(
                        client.character,
                        missionDef,
                        initialState
                    );
                    NpcHandler.sendMissionAdded(client, missionId, initialState);
                    if (aggregateProgress && aggregateProgress.currCount > 0) {
                        NpcHandler.sendMissionProgress(client, missionId, aggregateProgress.currCount);
                    }
                    if (aggregateProgress?.becameReadyToTurnIn) {
                        NpcHandler.sendMissionComplete(client, missionId);
                    }
                    didMutate = true;
                } else if (dialogueId === 2 && matched.primedContactOffer) {
                    NpcHandler.setMissionState(
                        client.character,
                        missionId,
                        matched.state,
                        { currCount: 0 }
                    );
                    didMutate = true;
                } else if (
                    dialogueId === 4 &&
                    (matched.state === NpcHandler.MISSION_IN_PROGRESS ||
                        matched.state === NpcHandler.MISSION_READY_TO_TURN_IN)
                ) {
                    if (missionId === NpcHandler.FIRST_MISSION_ID) {
                        client.pendingMissionTurnIns.add(NpcHandler.FIRST_MISSION_ID);
                        delayedFirstMissionTurnIn = true;
                    } else {
                        // Сначала показываем UI завершения миссии
                        const missionDef = MissionLoader.getMissionDef(missionId);
                        const missionEntry = NpcHandler.getMissionEntry(client.character, missionId);
                        NpcHandler.sendMissionCompleteUi(
                            client,
                            missionId,
                            NpcHandler.getMissionCompletionStars(missionDef, missionEntry),
                            NpcHandler.getMissionCompletionScore(missionDef, missionEntry)
                        );

                        // Затем начисляем награды
                        if (missionDef) {
                            const expReward = missionDef.ExpRewardValue ?? 0;
                            const goldReward = missionDef.GoldRewardValue ?? 0;

                            // Начисление опыта
                            if (expReward > 0) {
                                client.character.xp = Number(client.character.xp ?? 0) + expReward;
                                client.character.level = GameData.getPlayerLevelFromXp(Number(client.character.xp ?? 0));
                                NpcHandler.sendXpReward(client, expReward);
                            }

                            // Начисление золота
                            if (goldReward > 0) {
                                client.character.gold = Number(client.character.gold ?? 0) + goldReward;
                                RewardHandler.sendGoldReward(client, goldReward, false);
                            }
                        }

                        NpcHandler.setMissionState(
                            client.character,
                            missionId,
                            NpcHandler.MISSION_CLAIMED
                        );

                        // Сохраняем прогресс
                        if (client.userId) {
                            NpcHandler.persistCharacter(client, 'npc mission turn-in');
                        }

                        const followupMissionId = NpcHandler.autoAcceptFollowupMission(
                            client.character,
                            missionDef?.ReturnName ?? missionDef?.ContactName ?? ''
                        );
                        if (followupMissionId > 0) {
                            const followupDef = MissionLoader.getMissionDef(followupMissionId);
                            NpcHandler.sendMissionAdded(
                                client,
                                followupMissionId,
                                NpcHandler.getInitialMissionState(followupDef)
                            );
                        }

                        didMutate = true;
                    }
                }
            } else {
                const progressedMissionId = NpcHandler.noteActiveTargetNpcProgress(client, npc, missionNpcKey);
                if (progressedMissionId) {
                    dialogueId = 3;
                    missionId = progressedMissionId;
                    didMutate = true;
                }
            }
        }

        if (!dialogueId || !missionId) {
            NpcHandler.sendNpcBubble(
                client,
                npcId,
                NpcHandler.getFallbackLine(client.character, levelName, dialogueNpcKey)
            );
            return;
        }

        if (didMutate && client.userId) {
            NpcHandler.persistCharacter(client, 'npc dialogue mission update');
        }

        NpcHandler.sendResolvedDialogue(client, npcId, dialogueId, missionId);
        if (delayedFirstMissionTurnIn) {
            NpcHandler.scheduleFirstMissionFollowup(client, missionNpcKey);
        }
    }

    private static findNpc(client: Client, levelName: string, npcId: number): ResolvedNpc | null {
        const local = client.entities.get(npcId);
        const levelMap = GlobalState.levelEntities.get(getClientLevelScope(client));
        const global = levelMap?.get(npcId);
        const fromLoader = NpcLoader.getNpcsForLevel(levelName).find((npc) => npc.id === npcId);
        if (!local && !global && !fromLoader) {
            return null;
        }

        return {
            ...(fromLoader ?? {}),
            ...(global ?? {}),
            ...(local ?? {})
        };
    }

    private static findBestMission(
        character: Character,
        npcKey: string
    ): { missionId: number; dialogueId: number; state: number; primedContactOffer: boolean } | null {
        if (!npcKey) {
            return null;
        }

        let best: { missionId: number; dialogueId: number; state: number; priority: number; primedContactOffer: boolean } | null = null;

        for (let missionId = 1; missionId <= MissionLoader.getTotalMissions(); missionId++) {
            const missionDef = MissionLoader.getMissionDef(missionId);
            if (!missionDef) {
                continue;
            }

            const entry = NpcHandler.getMissionEntry(character, missionId);
            const state = NpcHandler.getMissionState(character, missionId);
            const contactKey = NpcHandler.normalizeMissionNpcKey(missionDef.ContactName ?? '');
            const returnKey = NpcHandler.getMissionReturnNpcKey(missionDef);
            const primedContactOffer =
                missionId === MissionID.FindAnnasFather &&
                state === NpcHandler.MISSION_READY_TO_TURN_IN &&
                Number(entry.currCount ?? 0) === NpcHandler.PRIMED_CONTACT_DIALOGUE_COUNT;
            let priority = 0;
            let dialogueId = 0;

            if (
                npcKey === returnKey &&
                state === NpcHandler.MISSION_READY_TO_TURN_IN
            ) {
                priority = 4;
                dialogueId = 4;
            } else if (
                npcKey === contactKey &&
                primedContactOffer
            ) {
                priority = 3;
                dialogueId = 2;
            } else if (
                npcKey === contactKey &&
                (
                    state === NpcHandler.MISSION_IN_PROGRESS ||
                    state === NpcHandler.MISSION_READY_TO_TURN_IN
                )
            ) {
                priority = 3;
                dialogueId = 3;
            } else if (
                npcKey === contactKey &&
                state === NpcHandler.MISSION_NOT_STARTED &&
                NpcHandler.canStartMission(character, missionDef)
            ) {
                priority = 2;
                dialogueId = 2;
            } else if (
                (npcKey === contactKey || npcKey === returnKey) &&
                state >= NpcHandler.MISSION_CLAIMED
            ) {
                priority = 1;
                dialogueId = 5;
            }

            if (!priority) {
                continue;
            }

            if (!best || priority > best.priority) {
                best = { missionId, dialogueId, state, priority, primedContactOffer };
            }
        }

        return best
            ? {
                missionId: best.missionId,
                dialogueId: best.dialogueId,
                state: best.state,
                primedContactOffer: best.primedContactOffer
            }
            : null;
    }

    private static autoAcceptFollowupMission(character: Character, npcName: string): number {
        const normalizedNpc = NpcHandler.normalizeMissionNpcKey(npcName);
        if (!normalizedNpc) {
            return 0;
        }

        for (let missionId = 1; missionId <= MissionLoader.getTotalMissions(); missionId++) {
            if (NpcHandler.getMissionState(character, missionId) !== NpcHandler.MISSION_NOT_STARTED) {
                continue;
            }

            const missionDef = MissionLoader.getMissionDef(missionId);
            if (!missionDef) {
                continue;
            }

            const contactKey = NpcHandler.normalizeMissionNpcKey(missionDef.ContactName ?? '');
            const returnKey = NpcHandler.getMissionReturnNpcKey(missionDef);
            const startsAtReturnOnly = !contactKey && Boolean(returnKey) && returnKey === normalizedNpc;
            if (!startsAtReturnOnly) {
                continue;
            }

            if (!NpcHandler.canStartMission(character, missionDef)) {
                continue;
            }

            const initialState = NpcHandler.getInitialMissionState(missionDef);
            NpcHandler.setMissionState(character, missionId, initialState, { currCount: 0 });
            return missionId;
        }

        return 0;
    }

    private static getAggregateMissionStartProgress(
        character: Character,
        missionDef: MissionDef | undefined
    ): { state: number; currCount: number; becameReadyToTurnIn: boolean } | null {
        if (!missionDef) {
            return null;
        }

        const missionId = Number(missionDef.MissionID ?? 0);
        const satelliteIds =
            missionId === NpcHandler.ATTACK_OF_OPPORTUNITY_MISSION_ID
                ? NpcHandler.ATTACK_OF_OPPORTUNITY_SATELLITE_IDS
                : missionId === NpcHandler.ATTACK_OF_OPPORTUNITY_HARD_MISSION_ID
                    ? NpcHandler.ATTACK_OF_OPPORTUNITY_HARD_SATELLITE_IDS
                    : null;
        if (!satelliteIds) {
            return null;
        }

        const completeCount = Math.max(1, Number(missionDef.CompleteCount ?? 1));
        const currCount = Math.min(
            completeCount,
            Array.from(satelliteIds).reduce((count, satelliteId) => {
                return count + (NpcHandler.getMissionState(character, satelliteId) >= NpcHandler.MISSION_CLAIMED ? 1 : 0);
            }, 0)
        );
        const becameReadyToTurnIn = currCount >= completeCount;

        return {
            state: becameReadyToTurnIn
                ? NpcHandler.MISSION_READY_TO_TURN_IN
                : NpcHandler.MISSION_IN_PROGRESS,
            currCount,
            becameReadyToTurnIn
        };
    }

    private static canStartMission(character: Character, missionDef: MissionDef): boolean {
        if (!NpcHandler.isMissionZoneUnlocked(character, missionDef)) {
            return false;
        }

        for (const prereqName of missionDef.PreReqMissions ?? []) {
            const prereqId = MissionLoader.getMissionIdByName(prereqName);
            if (!prereqId) {
                continue;
            }

            if (NpcHandler.getMissionState(character, prereqId) < NpcHandler.MISSION_CLAIMED) {
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

        return NpcHandler.getMissionState(character, MissionID.DeliverToSwamp) >= NpcHandler.MISSION_CLAIMED;
    }

    private static missionRequiresTurnIn(missionDef: MissionDef): boolean {
        if (Number(missionDef.MissionID ?? 0) === MissionID.ClearYourHouse) {
            return true;
        }

        return Boolean(String(missionDef.ReturnName ?? '').trim());
    }

    private static getMissionReturnNpcKey(missionDef: MissionDef): string {
        const returnKey = NpcHandler.normalizeMissionNpcKey(missionDef.ReturnName ?? '');
        if (returnKey) {
            return returnKey;
        }

        if (Number(missionDef.MissionID ?? 0) === MissionID.ClearYourHouse) {
            return NpcHandler.normalizeMissionNpcKey(missionDef.ContactName ?? '');
        }

        return '';
    }

    private static repairCompletedKeepQuestTurnIn(character: Character, npcKey: string): boolean {
        const keepMissionDef = MissionLoader.getMissionDef(MissionID.ClearYourHouse);
        if (!keepMissionDef || npcKey !== NpcHandler.getMissionReturnNpcKey(keepMissionDef)) {
            return false;
        }

        if (NpcHandler.getMissionState(character, MissionID.ClearYourHouse) !== NpcHandler.MISSION_IN_PROGRESS) {
            return false;
        }

        if (Number(character.questTrackerState ?? 0) < 100) {
            return false;
        }

        NpcHandler.setMissionState(
            character,
            MissionID.ClearYourHouse,
            NpcHandler.MISSION_READY_TO_TURN_IN,
            { currCount: Math.max(1, Number(keepMissionDef.CompleteCount ?? 1)) }
        );
        return true;
    }

    private static repairCompletedDungeonQuestTurnIn(character: Character, npcKey: string): boolean {
        if (!npcKey || Number(character.questTrackerState ?? 0) < 100) {
            return false;
        }

        const completedDungeonLevel = LevelConfig.normalizeLevelName(character.lastCompletedDungeonLevel);
        if (!completedDungeonLevel) {
            return false;
        }

        for (let missionId = 1; missionId <= MissionLoader.getTotalMissions(); missionId++) {
            const missionDef = MissionLoader.getMissionDef(missionId);
            const missionDungeon = LevelConfig.normalizeLevelName(missionDef?.Dungeon);
            if (!missionDef || !missionDungeon || missionDungeon !== completedDungeonLevel) {
                continue;
            }
            if (npcKey !== NpcHandler.getMissionReturnNpcKey(missionDef)) {
                continue;
            }
            if (NpcHandler.getMissionState(character, missionId) !== NpcHandler.MISSION_IN_PROGRESS) {
                continue;
            }

            NpcHandler.setMissionState(
                character,
                missionId,
                NpcHandler.MISSION_READY_TO_TURN_IN,
                { currCount: Math.max(1, Number(missionDef.CompleteCount ?? 1)) }
            );
            return true;
        }

        return false;
    }

    private static noteStoneOracleConsulted(client: Client, npcKey: string): boolean {
        if (!client.character) {
            return false;
        }

        const oracle = NpcHandler.STONE_ORACLE_MISSION_BY_MOAI_KEY[npcKey];
        if (!oracle) {
            return false;
        }

        if (NpcHandler.getMissionState(client.character, oracle.missionId) !== NpcHandler.MISSION_IN_PROGRESS) {
            return false;
        }

        const missionDef = MissionLoader.getMissionDef(oracle.missionId);
        if (!missionDef) {
            return false;
        }

        const entry = NpcHandler.getMissionEntry(client.character, oracle.missionId);
        const currentMask = Math.max(0, Number(entry.oracleMask ?? 0));
        if ((currentMask & oracle.bit) !== 0) {
            return false;
        }

        const nextMask = currentMask | oracle.bit;
        entry.oracleMask = nextMask;
        const nextCount = [1, 2, 4].reduce(
            (count, bit) => count + ((nextMask & bit) ? 1 : 0),
            0
        );
        const completeCount = Math.max(1, Number(missionDef.CompleteCount ?? 1));
        const nextState = nextCount >= completeCount
            ? NpcHandler.MISSION_READY_TO_TURN_IN
            : NpcHandler.MISSION_IN_PROGRESS;

        NpcHandler.setMissionState(client.character, oracle.missionId, nextState, {
            currCount: Math.min(nextCount, completeCount)
        });
        NpcHandler.getMissionEntry(client.character, oracle.missionId).oracleMask = nextMask;
        NpcHandler.sendMissionProgress(client, oracle.missionId, 1);
        if (nextState === NpcHandler.MISSION_READY_TO_TURN_IN) {
            NpcHandler.sendMissionComplete(client, oracle.missionId);
        }
        return true;
    }

    private static noteActiveTargetNpcProgress(client: Client, npc: ResolvedNpc, npcKey: string): number | null {
        if (!client.character || !npcKey || !NpcHandler.isFriendlyNpc(npc)) {
            return null;
        }

        for (let missionId = 1; missionId <= MissionLoader.getTotalMissions(); missionId++) {
            const missionDef = MissionLoader.getMissionDef(missionId);
            if (!missionDef || NpcHandler.getMissionState(client.character, missionId) !== NpcHandler.MISSION_IN_PROGRESS) {
                continue;
            }

            if (
                String(missionDef.Dungeon ?? '').trim() ||
                !NpcHandler.missionRequiresTurnIn(missionDef) ||
                !NpcHandler.getMissionActiveTargetNpcKeys(missionDef).includes(npcKey)
            ) {
                continue;
            }

            const completeCount = Math.max(1, Number(missionDef.CompleteCount ?? 1));
            const entry = NpcHandler.getMissionEntry(client.character, missionId);
            const currentCount = Math.max(0, Number(entry.currCount ?? 0));
            const nextCount = Math.min(completeCount, currentCount + 1);
            const nextState = nextCount >= completeCount
                ? NpcHandler.MISSION_READY_TO_TURN_IN
                : NpcHandler.MISSION_IN_PROGRESS;

            NpcHandler.setMissionState(client.character, missionId, nextState, { currCount: nextCount });
            NpcHandler.sendMissionProgress(client, missionId, 1);
            if (nextState === NpcHandler.MISSION_READY_TO_TURN_IN) {
                NpcHandler.sendMissionComplete(client, missionId);
            }
            return missionId;
        }

        return null;
    }

    private static isFriendlyNpc(npc: ResolvedNpc): boolean {
        return Number(npc.team ?? npc.Team ?? 0) === 3;
    }

    private static getMissionActiveTargetNpcKeys(missionDef: MissionDef): string[] {
        return String(missionDef.ActiveTarget ?? '')
            .split(',')
            .map((entry) => NpcHandler.normalizeMissionNpcKey(entry))
            .filter(Boolean);
    }

    private static missionStartsReadyToTurnIn(missionDef: MissionDef | undefined): boolean {
        if (!missionDef) {
            return false;
        }

        return !String(missionDef.Dungeon ?? '').trim() &&
            NpcHandler.missionRequiresTurnIn(missionDef) &&
            Number(missionDef.CompleteCount ?? 1) <= 0;
    }

    private static getInitialMissionState(missionDef: MissionDef | undefined): number {
        return NpcHandler.missionStartsReadyToTurnIn(missionDef)
            ? NpcHandler.MISSION_READY_TO_TURN_IN
            : NpcHandler.MISSION_IN_PROGRESS;
    }

    private static resetQuestTrackerForStartedDungeonMission(
        character: Character,
        missionDef: MissionDef | undefined,
        state: number
    ): void {
        if (state !== NpcHandler.MISSION_IN_PROGRESS) {
            return;
        }

        if (!String(missionDef?.Dungeon ?? '').trim()) {
            return;
        }

        character.questTrackerState = 0;
        character.lastCompletedDungeonLevel = '';
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
        const missions = NpcHandler.getMissionStateMap(character);
        const entry = missions[String(missionId)];
        return Number((entry && typeof entry === 'object' ? entry.state : undefined) ?? NpcHandler.MISSION_NOT_STARTED);
    }

    private static getMissionEntry(character: Character, missionId: number): MissionEntry {
        const missions = NpcHandler.getMissionStateMap(character);
        const entry = missions[String(missionId)];
        return entry && typeof entry === 'object' ? entry : {};
    }

    private static setMissionState(
        character: Character,
        missionId: number,
        state: number,
        extra: Partial<MissionEntry> = {}
    ): void {
        const missions = NpcHandler.getMissionStateMap(character);
        const key = String(missionId);
        const next: MissionEntry = {
            ...(missions[key] && typeof missions[key] === 'object' ? missions[key] : {})
        };

        next.state = state;
        if (extra.currCount !== undefined) {
            next.currCount = Number(extra.currCount);
        }
        if (state >= NpcHandler.MISSION_CLAIMED) {
            next.claimed = 1;
            next.complete = 1;
        } else {
            delete next.claimed;
            delete next.complete;
        }

        if (state === NpcHandler.MISSION_IN_PROGRESS && next.currCount === undefined) {
            next.currCount = 0;
        }

        missions[key] = next;
    }

    private static sendMissionAdded(
        client: Client,
        missionId: number,
        state: number = NpcHandler.MISSION_IN_PROGRESS
    ): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(missionId);
        bb.writeMethod11(state === NpcHandler.MISSION_IN_PROGRESS ? 1 : 0, 1);
        client.sendBitBuffer(0x85, bb);
    }

    private static sendMissionComplete(client: Client, missionId: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(missionId);
        client.sendBitBuffer(0x86, bb);
    }

    private static sendMissionProgress(client: Client, missionId: number, progress: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(missionId);
        bb.writeMethod4(Math.max(0, progress));
        client.sendBitBuffer(0x83, bb);
    }

    private static getMissionCompletionStars(missionDef: MissionDef | undefined, missionEntry: MissionEntry): number {
        return (missionDef?.Time ?? false)
            ? Math.max(0, Number(missionEntry.Tier ?? NpcHandler.DEFAULT_TURN_IN_STARS))
            : NpcHandler.DEFAULT_TURN_IN_STARS;
    }

    private static getMissionCompletionScore(missionDef: MissionDef | undefined, missionEntry: MissionEntry): number {
        return (missionDef?.Time ?? false)
            ? Math.max(0, Number(missionEntry.highscore ?? 0))
            : 0;
    }

    private static sendMissionCompleteUi(client: Client, missionId: number, stars: number, dungeonScore: number = 0): void {
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

    private static sendStartSkit(client: Client, npcId: number, dialogueId: number, missionId: number): void {
        const bb = new BitBuffer();
        bb.writeMethod4(npcId);
        bb.writeMethod6(dialogueId, 3);
        bb.writeMethod4(missionId);
        MissionHandler.noteDungeonSkitActivity(client);
        client.sendBitBuffer(0x7B, bb);
    }

    private static sendResolvedDialogue(client: Client, npcId: number, dialogueId: number, missionId: number): void {
        const language = NpcHandler.getDialogueLanguage(client.character);
        if (language !== NpcHandler.DEFAULT_DIALOGUE_LANGUAGE) {
            const localizedText = MissionDialogueLoader.getDialogueText(missionId, dialogueId, language);
            if (localizedText) {
                NpcHandler.sendNpcBubble(client, npcId, localizedText);
                return;
            }
        }

        NpcHandler.sendStartSkit(client, npcId, dialogueId, missionId);
    }

    private static sendNpcBubble(client: Client, npcId: number, text: string): void {
        const bb = new BitBuffer();
        bb.writeMethod4(npcId);
        bb.writeMethod13(text);
        MissionHandler.noteDungeonSkitActivity(client);
        client.sendBitBuffer(0x76, bb);
    }

    private static scheduleFirstMissionFollowup(client: Client, npcKey: string): void {
        const delayMs = NpcHandler.estimateDialogueDelay(
            MissionDialogueLoader.getDialogueText(
                NpcHandler.FIRST_MISSION_ID,
                4,
                NpcHandler.getDialogueLanguage(client.character)
            )
        );

        setTimeout(() => {
            void NpcHandler.finalizeFirstMissionTurnIn(client, npcKey);
        }, delayMs);
    }

    private static async finalizeFirstMissionTurnIn(client: Client, npcKey: string): Promise<void> {
        try {
            if (!client.character) {
                return;
            }

            // Сначала показываем UI завершения миссии
            const missionDef = MissionLoader.getMissionDef(NpcHandler.FIRST_MISSION_ID);
            const missionEntry = NpcHandler.getMissionEntry(client.character, NpcHandler.FIRST_MISSION_ID);
            NpcHandler.sendMissionCompleteUi(
                client,
                NpcHandler.FIRST_MISSION_ID,
                NpcHandler.getMissionCompletionStars(missionDef, missionEntry),
                NpcHandler.getMissionCompletionScore(missionDef, missionEntry)
            );

            // Затем начисляем награды
            if (missionDef) {
                const expReward = missionDef.ExpRewardValue ?? 0;
                const goldReward = missionDef.GoldRewardValue ?? 0;

                // Начисление опыта
                if (expReward > 0) {
                    client.character.xp = Number(client.character.xp ?? 0) + expReward;
                    client.character.level = GameData.getPlayerLevelFromXp(Number(client.character.xp ?? 0));
                    NpcHandler.sendXpReward(client, expReward);
                }

                // Начисление золота
                if (goldReward > 0) {
                    client.character.gold = Number(client.character.gold ?? 0) + goldReward;
                    RewardHandler.sendGoldReward(client, goldReward, false);
                }
            }

            NpcHandler.setMissionState(
                client.character,
                NpcHandler.FIRST_MISSION_ID,
                NpcHandler.MISSION_CLAIMED
            );

            // Сохраняем прогресс
            if (client.userId) {
                NpcHandler.persistCharacter(client, 'first mission turn-in');
            }
        } finally {
            client.pendingMissionTurnIns.delete(NpcHandler.FIRST_MISSION_ID);
        }
    }

    private static estimateDialogueDelay(text: string): number {
        const firstLine = String(text ?? '')
            .split('=')
            .map((segment) => segment.trim())
            .find(Boolean);

        if (!firstLine) {
            return 0;
        }

        return NpcHandler.RETURN_DIALOGUE_BASE_MS + firstLine.length * NpcHandler.RETURN_DIALOGUE_CHAR_MS;
    }

    private static getDialogueLanguage(character: Character | null | undefined): string {
        const normalized = String(character?.dialogueLanguage ?? '').trim().toLowerCase();
        return normalized || NpcHandler.DEFAULT_DIALOGUE_LANGUAGE;
    }

    private static getFallbackLine(character: Character, levelName: string, npcKey: string): string {
        const configuredLines = NpcDialogueLoader.getLinesForNpc(
            levelName,
            npcKey,
            character,
            NpcHandler.getDialogueLanguage(character)
        );
        if (configuredLines.length > 0) {
            return configuredLines[Math.floor(Math.random() * configuredLines.length)];
        }

        const lines: Record<string, string[]> = {
            nrcaptfink: [
                'We made it to shore alive, at least.',
                'I must get word to the king!'
            ],
            captainfink: [
                'We made it to shore alive, at least.',
                'I must get word to the king!'
            ],
            nrmayor01: [
                'Thank the heavens you have arrived!',
                'Our fighters need their leader.'
            ],
            anna: [
                'Our fighters need their leader.',
                'Someone named Nephit is trying to control the goblins.'
            ],
            nranna03: [
                'Our fighters need their leader.',
                'Someone named Nephit is trying to control the goblins.'
            ],
            nrquestanna01: [
                'Someone named Nephit is trying to control the goblins.'
            ],
            nrpecky: [
                'Squawk! This way!',
                'Squawk! Follow Pecky!'
            ]
        };

        const pool = lines[npcKey] || ['...'];
        return pool[Math.floor(Math.random() * pool.length)];
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
            fink: 'nrcaptfink',
            captain: 'nrcaptfink',
            npccaptain: 'nrcaptfink',
            npcorder01: 'vhjackal02',
            npcorder02: 'vhodin01',
            npcorder03: 'vhfabmab01',
            npcorder04: 'vhodin01',
            npcorder01hard: 'vhjackal02hard',
            npcorder02hard: 'vhodin01hard',
            npcorder03hard: 'vhfabmab01hard',
            npcorder04hard: 'vhodin01hard',
            npcrebel01: 'vhrebel01',
            npcrebel02: 'vhrebel02',
            npcrebel01hard: 'vhrebel01hard',
            npcrebel02hard: 'vhrebel02hard',
            npcvagrant02: 'vhskitts01',
            npcvagrant01: 'vhvagrant01',
            npcvagrant02hard: 'vhskitts01hard',
            npcvagrant01hard: 'vhvagrant01hard',
            npcmonk01: 'vhmonk01',
            npcmonk01hard: 'vhmonk01hard',
            affric: 'nraffric',
            npcaffric: 'nraffric',
            odem: 'nrodem',
            npcodem: 'nrodem',
            elric: 'nrelric',
            npcelric: 'nrelric',
            ehric: 'nrelric'
        };

        return aliases[normalized] ?? normalized;
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
            fink: 'nrcaptfink',
            npcorder01: 'vhjackal02',
            npcorder02: 'vhodin01',
            npcorder03: 'vhfabmab01',
            npcorder04: 'vhodin01',
            npcorder01hard: 'vhjackal02hard',
            npcorder02hard: 'vhodin01hard',
            npcorder03hard: 'vhfabmab01hard',
            npcorder04hard: 'vhodin01hard',
            npcrebel01: 'vhrebel01',
            npcrebel02: 'vhrebel02',
            npcrebel01hard: 'vhrebel01hard',
            npcrebel02hard: 'vhrebel02hard',
            npcvagrant02: 'vhskitts01',
            npcvagrant01: 'vhvagrant01',
            npcvagrant02hard: 'vhskitts01hard',
            npcvagrant01hard: 'vhvagrant01hard',
            npcmonk01: 'vhmonk01',
            npcmonk01hard: 'vhmonk01hard',
            npcodem: 'odem',
            npcodemhard: 'odemhard'
        };

        return aliases[normalized] ?? normalized;
    }
}
