import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import {
    getWolfsEndLiveStatCap,
    getWolfsEndTimeBonusCap,
    noteDungeonRunBossCutscene,
    noteDungeonRunCast,
    noteDungeonRunDeath,
    noteDungeonRunEntitySeen,
    noteDungeonRunHit,
    noteDungeonRunKill,
    syncClientDungeonRunState
} from '../core/DungeonRunStats';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { NpcLoader } from '../data/NpcLoader';
import { MissionID } from '../data/runtime';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    userId: number | null;
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    character: {
        name: string;
        level: number;
        CurrentLevel: { name: string; x: number; y: number };
        PreviousLevel: { name: string; x: number; y: number };
        missions: Record<string, any>;
        questTrackerState: number;
    };
    entities: Map<number, any>;
    pendingLoot: Map<number, any>;
    processedRewardSources: Set<string>;
    sentPackets: SentPacket[];
    dungeonRun: any;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

const LIVE_ACCURACY_CAP = 40_000;
const LIVE_DEATHS_BASE = 40_000;
const LIVE_BOSS_RUN_KILL_CAP = 160_000;

function ensureGameDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('TutorialDungeon')) {
        LevelConfig.load(dataDir);
    }
    if (!GameData.getEntType('TreasureChestEmpty')) {
        GameData.load(dataDir);
    }
    if (NpcLoader.getRawNpcsForLevel('TutorialDungeon').length === 0) {
        NpcLoader.load(dataDir);
    }
}

function createFakeClient(): FakeClient {
    const sentPackets: SentPacket[] = [];
    return {
        token: 9100,
        userId: null,
        currentLevel: 'TutorialDungeon',
        levelInstanceId: 'tracker-run',
        currentRoomId: 0,
        playerSpawned: true,
        clientEntID: 777,
        character: {
            name: 'TrackerRunner',
            level: 5,
            CurrentLevel: { name: 'TutorialDungeon', x: 0, y: 0 },
            PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 },
            missions: {
                [String(MissionID.RescueAnna)]: {
                    state: 1,
                    currCount: 0
                }
            },
            questTrackerState: 0
        },
        entities: new Map<number, any>(),
        pendingLoot: new Map<number, any>(),
        processedRewardSources: new Set<string>(),
        sentPackets,
        dungeonRun: null,
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createFakeDungeonClient(levelName: string, missionId: MissionID): FakeClient {
    const client = createFakeClient();
    client.currentLevel = levelName;
    client.levelInstanceId = `${levelName}-tracker-run`;
    client.character.CurrentLevel = { name: levelName, x: 0, y: 0 };
    client.character.missions = {
        [String(missionId)]: {
            state: 1,
            currCount: 0
        }
    };
    return client;
}

function getExpectedWolfsEndTimeCap(levelName: string): number {
    const normalizedLevel = LevelConfig.normalizeLevelName(levelName) || levelName;
    const baseLevelName = normalizedLevel.replace(/Hard$/, '');

    switch (baseLevelName) {
        case 'TutorialDungeon':
        case 'GoblinRiverDungeon':
            return 40_000;
        case 'CraftTownTutorial':
            return 60_000;
        case 'GhostBossDungeon':
            return 80_000;
        case 'DreamDragonDungeon':
            return 100_000;
        default:
            throw new Error(`Unexpected Wolf's End level ${levelName}`);
    }
}

function getExpectedWolfsEndLiveStatCap(levelName: string): number {
    const normalizedLevel = LevelConfig.normalizeLevelName(levelName) || levelName;
    const baseLevelName = normalizedLevel.replace(/Hard$/, '');

    switch (baseLevelName) {
        case 'CraftTownTutorial':
            return 60_000;
        default:
            return 40_000;
    }
}

function resetTrackerEntityBuckets(client: FakeClient): void {
    client.dungeonRun.entryAccumulator.eligibleEnemyIds = new Set<number>();
    client.dungeonRun.entryAccumulator.killedEnemyIds = new Set<number>();
    client.dungeonRun.entryAccumulator.bossEnemyIds = new Set<number>();
    client.dungeonRun.entryAccumulator.eligibleChestIds = new Set<number>();
    client.dungeonRun.entryAccumulator.openedChestIds = new Set<number>();
    client.dungeonRun.entryAccumulator.eligibleObjectiveIds = new Set<number>();
    client.dungeonRun.entryAccumulator.completedObjectiveIds = new Set<number>();
    client.dungeonRun.entryAccumulator.failedObjectiveIds = new Set<number>();
    client.dungeonRun.entryAccumulator.totalEnemiesEligible = 0;
    client.dungeonRun.entryAccumulator.killedEnemies = 0;
    client.dungeonRun.entryAccumulator.skippedEnemies = 0;
    client.dungeonRun.entryAccumulator.totalChestsEligible = 0;
    client.dungeonRun.entryAccumulator.openedChests = 0;
    client.dungeonRun.entryAccumulator.totalObjectivesEligible = 0;
    client.dungeonRun.entryAccumulator.completedObjectives = 0;
    client.dungeonRun.entryAccumulator.failedObjectives = 0;
    client.dungeonRun.entryAccumulator.playerDeaths = 0;
    client.dungeonRun.windowAccumulator = {
        ...client.dungeonRun.windowAccumulator,
        eligibleEnemyIds: new Set<number>(),
        killedEnemyIds: new Set<number>(),
        bossEnemyIds: new Set<number>(),
        eligibleChestIds: new Set<number>(),
        openedChestIds: new Set<number>(),
        eligibleObjectiveIds: new Set<number>(),
        completedObjectiveIds: new Set<number>(),
        failedObjectiveIds: new Set<number>(),
        totalEnemiesEligible: 0,
        killedEnemies: 0,
        skippedEnemies: 0,
        totalChestsEligible: 0,
        openedChests: 0,
        totalObjectivesEligible: 0,
        completedObjectives: 0,
        failedObjectives: 0,
        playerDeaths: 0,
        treasureGold: 0
    };
    client.dungeonRun.totalShots = 0;
    client.dungeonRun.successfulHits = 0;
    client.dungeonRun.missedShots = 0;
    client.dungeonRun.pendingShots = new Map();
    client.dungeonRun.nextShotSequence = 0;
    client.dungeonRun.accuracyRatio = 0;
    client.dungeonRun.accuracyWindowActive = false;
    client.dungeonRun.accuracyWindowSource = 'none';
}

function triggerBossCutscene(client: FakeClient, boss: any): void {
    client.entities.set(boss.id, { ...boss, roomId: client.currentRoomId });
    noteDungeonRunBossCutscene(getClientLevelScope(client as never), client.currentRoomId, boss.id);
}

function createLevelCompletePacket(
    completionPercent: number = 100,
    remainingKills: number = 1,
    requiredKills: number = 2
): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(completionPercent);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(remainingKills);
    bb.writeMethod9(requiredKills);
    bb.writeMethod9(3);
    return bb.toBuffer();
}

function decodeDungeonCompletePacket(payload: Buffer): {
    stars: number;
    resultBar: number;
    rank: number;
    kills: number;
    accuracy: number;
    deaths: number;
    treasure: number;
    timeBonus: number;
} {
    const br = new BitReader(payload);
    return {
        stars: br.readMethod6(4),
        resultBar: br.readMethod4(),
        rank: br.readMethod4(),
        kills: br.readMethod4(),
        accuracy: br.readMethod4(),
        deaths: br.readMethod4(),
        treasure: br.readMethod4(),
        timeBonus: br.readMethod4()
    };
}

function assertResultMatchesTrackerSummary(client: FakeClient, result: ReturnType<typeof decodeDungeonCompletePacket>): void {
    const summary = client.dungeonRun.finalizedStats?.scoreSummary;
    assert.ok(summary, 'finalized tracker should expose a score summary');
    assert.equal(result.kills, summary!.finalStat.kills, 'result kill score should come from the tracker summary');
    assert.equal(result.accuracy, summary!.finalStat.accuracy, 'result accuracy should come from the tracker summary');
    assert.equal(result.deaths, summary!.finalStat.deaths, 'result death score should come from the tracker summary');
    assert.equal(result.treasure, summary!.finalStat.treasure, 'result treasure should come from the tracker summary');
    assert.equal(result.timeBonus, summary!.finalStat.timeBonus, 'result time bonus should come from the tracker summary');
}

function getDeathPenaltyPerDeath(levelName: string, deathIndex: number): number {
    const spec = LevelConfig.get(levelName);
    const levelTier = Math.max(1, Number(spec.baseId || 1));
    const difficultyScalar = (spec.isHard ? 1.35 : 1) * (1 + ((levelTier - 1) * 0.08));
    const streakScalar = 1 + (Math.max(1, deathIndex) - 1) * 0.2;
    return Math.max(1, Math.round((4_000 + (levelTier * 750)) * difficultyScalar * streakScalar));
}

function getExpectedDeathScore(levelName: string, deathCount: number): number {
    let totalPenalty = 0;
    for (let deathIndex = 1; deathIndex <= deathCount; deathIndex++) {
        totalPenalty += getDeathPenaltyPerDeath(levelName, deathIndex);
    }
    return Math.max(0, LIVE_DEATHS_BASE - totalPenalty);
}

function getExpectedTimeBonus(levelName: string, bossRun: boolean, cap: number, elapsedMs: number): number {
    const spec = LevelConfig.get(levelName);
    const levelTier = Math.max(1, Number(spec.baseId || 1));
    const hardScalar = spec.isHard ? 1.15 : 1;
    const modeScalar = bossRun ? 0.85 : 1;
    const wolfsEndScalar = 1.5;
    const targetMs = Math.max(240_000, Math.round((120_000 + (levelTier * 60_000)) * hardScalar * modeScalar * wolfsEndScalar));
    const drainWindowMs = Math.max(targetMs, Math.round(targetMs * 2));
    const clampedElapsedMs = Math.max(0, elapsedMs);
    const remainingRatio = clampedElapsedMs <= targetMs
        ? 1
        : Math.max(0, Math.min(1, 1 - ((Math.min(clampedElapsedMs, drainWindowMs) - targetMs) / Math.max(1, drainWindowMs - targetMs))));
    return Math.round(cap * remainingRatio);
}

async function finalizeAndReadResult(client: FakeClient): Promise<ReturnType<typeof decodeDungeonCompletePacket>> {
    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket());
    const resultPacket = client.sentPackets.find((packet) => packet.id === 0x87);
    assert.ok(resultPacket, 'dungeon completion should send 0x87');
    return decodeDungeonCompletePacket(resultPacket!.payload);
}

async function finalizeAndReadResultWithPacket(
    client: FakeClient,
    completionPercent: number,
    remainingKills: number = 1,
    requiredKills: number = 2
): Promise<ReturnType<typeof decodeDungeonCompletePacket>> {
    await MissionHandler.handleSetLevelComplete(
        client as never,
        createLevelCompletePacket(completionPercent, remainingKills, requiredKills)
    );
    const resultPacket = client.sentPackets.find((packet) => packet.id === 0x87);
    assert.ok(resultPacket, 'dungeon completion should send 0x87');
    return decodeDungeonCompletePacket(resultPacket!.payload);
}

async function testBossRunNoDeathsKeepsDeathsBase(): Promise<void> {
    const client = createFakeDungeonClient('GhostBossDungeon', MissionID.KillNephit);
    const levelScope = getClientLevelScope(client as never);
    const boss = { id: 90002, name: 'NephitLargeEye', team: 2, entRank: 'Boss', hp: 10 };

    GlobalState.sessionsByToken.set(client.token, client as never);
    syncClientDungeonRunState(client as never);
    resetTrackerEntityBuckets(client);
    triggerBossCutscene(client, boss);
    noteDungeonRunCast(client as never, { sourceId: client.clientEntID, projectileId: null, isPersistent: false });
    noteDungeonRunHit(client as never, {
        sourceId: client.clientEntID,
        targetId: boss.id,
        targetEntity: boss,
        damage: 25
    });
    noteDungeonRunKill(levelScope, ['trackerrunner'], boss.id, boss);

    const result = await finalizeAndReadResult(client);
    assertResultMatchesTrackerSummary(client, result);
    assert.equal(client.dungeonRun.finalizedStats?.scoreMode, 'boss_run', 'pure boss completion should remain boss_run');
    assert.equal(result.deaths, LIVE_DEATHS_BASE, 'boss runs with no deaths should keep the 40000 deaths base');
}

async function testBossRunDeathsUseDungeonScaledPenalty(): Promise<void> {
    const client = createFakeDungeonClient('GhostBossDungeon', MissionID.KillNephit);
    const levelScope = getClientLevelScope(client as never);
    const boss = { id: 90012, name: 'NephitLargeEye', team: 2, entRank: 'Boss', hp: 10 };

    GlobalState.sessionsByToken.set(client.token, client as never);
    syncClientDungeonRunState(client as never);
    resetTrackerEntityBuckets(client);
    noteDungeonRunDeath(client as never);
    triggerBossCutscene(client, boss);
    noteDungeonRunDeath(client as never);
    noteDungeonRunCast(client as never, { sourceId: client.clientEntID, projectileId: null, isPersistent: false });
    noteDungeonRunHit(client as never, {
        sourceId: client.clientEntID,
        targetId: boss.id,
        targetEntity: boss,
        damage: 25
    });
    noteDungeonRunKill(levelScope, ['trackerrunner'], boss.id, boss);

    const result = await finalizeAndReadResult(client);
    assertResultMatchesTrackerSummary(client, result);
    assert.equal(
        result.deaths,
        client.dungeonRun.finalizedStats!.scoreSummary.unlockedCap.deaths,
        'Wolf\'s End full clears should clamp deaths to the max bucket even if the run had deaths'
    );
}

async function testBossRunAccuracyUsesBossFightOnlyWhenNoPreBossHits(): Promise<void> {
    const client = createFakeDungeonClient('GhostBossDungeon', MissionID.KillNephit);
    const levelScope = getClientLevelScope(client as never);
    const preBossMinion = { id: 90021, name: 'GoblinClub', team: 2, entRank: 'Minion', hp: 10 };
    const boss = { id: 90022, name: 'NephitLargeEye', team: 2, entRank: 'Boss', hp: 10 };

    GlobalState.sessionsByToken.set(client.token, client as never);
    syncClientDungeonRunState(client as never);
    resetTrackerEntityBuckets(client);
    noteDungeonRunEntitySeen(client as never, preBossMinion.id, preBossMinion);
    noteDungeonRunCast(client as never, { sourceId: client.clientEntID, projectileId: null, isPersistent: false });

    triggerBossCutscene(client, boss);
    noteDungeonRunCast(client as never, { sourceId: client.clientEntID, projectileId: null, isPersistent: false });
    noteDungeonRunHit(client as never, {
        sourceId: client.clientEntID,
        targetId: boss.id,
        targetEntity: boss,
        damage: 25
    });
    noteDungeonRunCast(client as never, { sourceId: client.clientEntID, projectileId: null, isPersistent: false });
    noteDungeonRunKill(levelScope, ['trackerrunner'], boss.id, boss);

    const result = await finalizeAndReadResult(client);
    assertResultMatchesTrackerSummary(client, result);
    assert.equal(client.dungeonRun.finalizedStats?.accuracyWindowSource, 'boss_cutscene', 'boss-only runs should score accuracy from the boss window');
    assert.equal(
        result.accuracy,
        client.dungeonRun.finalizedStats!.scoreSummary.unlockedCap.accuracy,
        'Wolf\'s End boss-only full clears should clamp accuracy to max even when the pre-clear combat had misses'
    );
}

async function testBossRunAccuracyStartsAtFirstPreBossHit(): Promise<void> {
    const client = createFakeDungeonClient('GhostBossDungeon', MissionID.KillNephit);
    const levelScope = getClientLevelScope(client as never);
    const minion = { id: 90031, name: 'GoblinClub', team: 2, entRank: 'Minion', hp: 10 };
    const boss = { id: 90032, name: 'NephitLargeEye', team: 2, entRank: 'Boss', hp: 10 };

    GlobalState.sessionsByToken.set(client.token, client as never);
    syncClientDungeonRunState(client as never);
    resetTrackerEntityBuckets(client);
    noteDungeonRunEntitySeen(client as never, minion.id, minion);
    noteDungeonRunCast(client as never, { sourceId: client.clientEntID, projectileId: null, isPersistent: false });
    noteDungeonRunCast(client as never, { sourceId: client.clientEntID, projectileId: null, isPersistent: false });
    noteDungeonRunHit(client as never, {
        sourceId: client.clientEntID,
        targetId: minion.id,
        targetEntity: minion,
        damage: 25
    });
    noteDungeonRunKill(levelScope, ['trackerrunner'], minion.id, minion);

    triggerBossCutscene(client, boss);
    noteDungeonRunCast(client as never, { sourceId: client.clientEntID, projectileId: null, isPersistent: false });
    noteDungeonRunHit(client as never, {
        sourceId: client.clientEntID,
        targetId: boss.id,
        targetEntity: boss,
        damage: 25
    });
    noteDungeonRunCast(client as never, { sourceId: client.clientEntID, projectileId: null, isPersistent: false });
    noteDungeonRunKill(levelScope, ['trackerrunner'], boss.id, boss);

    const result = await finalizeAndReadResult(client);
    assertResultMatchesTrackerSummary(client, result);
    assert.equal(client.dungeonRun.finalizedStats?.accuracyWindowSource, 'pre_boss_hit', 'pre-boss combat should anchor the accuracy window at the first hit');
    assert.equal(
        result.accuracy,
        client.dungeonRun.finalizedStats!.scoreSummary.unlockedCap.accuracy,
        'Wolf\'s End full clears should clamp accuracy to max after the run reaches full completion'
    );
}

async function testBossRunElapsedTimingUsesEntryToDungeonCompletion(): Promise<void> {
    const client = createFakeDungeonClient('GhostBossDungeon', MissionID.KillNephit);
    const levelScope = getClientLevelScope(client as never);
    const boss = { id: 90042, name: 'NephitLargeEye', team: 2, entRank: 'Boss', hp: 10 };

    GlobalState.sessionsByToken.set(client.token, client as never);
    syncClientDungeonRunState(client as never);
    resetTrackerEntityBuckets(client);
    const elapsedMsBeforeBossDefeat = 180_000;
    const elapsedMsAfterBossDefeat = 45_000;
    const totalElapsedMs = elapsedMsBeforeBossDefeat + elapsedMsAfterBossDefeat;
    const runStart = Date.now() - totalElapsedMs;
    client.dungeonRun.entryStartTime = runStart;
    client.dungeonRun.runStartTime = runStart;
    client.dungeonRun.entryAccumulator.startTime = runStart;

    triggerBossCutscene(client, boss);
    noteDungeonRunCast(client as never, { sourceId: client.clientEntID, projectileId: null, isPersistent: false });
    noteDungeonRunHit(client as never, {
        sourceId: client.clientEntID,
        targetId: boss.id,
        targetEntity: boss,
        damage: 25
    });
    noteDungeonRunKill(levelScope, ['trackerrunner'], boss.id, boss);
    client.dungeonRun.bossDefeatTime = Date.now() - elapsedMsAfterBossDefeat;

    const result = await finalizeAndReadResult(client);
    const timeCap = client.dungeonRun.finalizedStats!.scoreSummary.unlockedCap.timeBonus;
    const expected = getExpectedTimeBonus('GhostBossDungeon', true, timeCap, totalElapsedMs);
    assertResultMatchesTrackerSummary(client, result);
    assert.equal(result.timeBonus, expected, 'boss-run time bonus should use entry-to-dungeon-completion elapsed time');
}

async function testGoblinRiverFullClearKeepsPositiveTimeBonusAtTenMinutes(): Promise<void> {
    const client = createFakeDungeonClient('GoblinRiverDungeon', MissionID.RescueAnna);
    const levelScope = getClientLevelScope(client as never);
    const hostile = { id: 90101, name: 'GoblinClub', team: 2, entRank: 'Minion', hp: 10, clientSpawned: true, ownerToken: client.token, roomId: 1 };

    GlobalState.sessionsByToken.set(client.token, client as never);
    syncClientDungeonRunState(client as never);
    resetTrackerEntityBuckets(client);
    const elapsedMs = 600_000;
    const runStart = Date.now() - elapsedMs;
    client.dungeonRun.entryStartTime = runStart;
    client.dungeonRun.runStartTime = runStart;
    client.dungeonRun.entryAccumulator.startTime = runStart;
    client.entities.set(hostile.id, hostile);
    noteDungeonRunEntitySeen(client as never, hostile.id, hostile);
    noteDungeonRunCast(client as never, { sourceId: client.clientEntID, projectileId: null, isPersistent: false, hasTargetPos: true });
    noteDungeonRunHit(client as never, {
        sourceId: client.clientEntID,
        targetId: hostile.id,
        targetEntity: hostile,
        damage: 25
    });
    noteDungeonRunKill(levelScope, ['trackerrunner'], hostile.id, { ...hostile, hp: 0, dead: true, entState: 6 });

    client.character.questTrackerState = 100;
    const result = await finalizeAndReadResultWithPacket(client, 100, 0, 1);
    assertResultMatchesTrackerSummary(client, result);
    assert.equal(result.timeBonus > 0, true, 'Goblin River full clears should still award time bonus after a ten-minute run');
}

async function testGoblinRiverFullClearKeepsMaxTimeBonusBeforeParTime(): Promise<void> {
    const client = createFakeDungeonClient('GoblinRiverDungeon', MissionID.RescueAnna);
    const levelScope = getClientLevelScope(client as never);
    const hostile = { id: 90111, name: 'GoblinClub', team: 2, entRank: 'Minion', hp: 10, clientSpawned: true, ownerToken: client.token, roomId: 1 };

    GlobalState.sessionsByToken.set(client.token, client as never);
    syncClientDungeonRunState(client as never);
    resetTrackerEntityBuckets(client);
    const elapsedMs = 255_000;
    const runStart = Date.now() - elapsedMs;
    client.dungeonRun.entryStartTime = runStart;
    client.dungeonRun.runStartTime = runStart;
    client.dungeonRun.entryAccumulator.startTime = runStart;
    client.entities.set(hostile.id, hostile);
    noteDungeonRunEntitySeen(client as never, hostile.id, hostile);
    noteDungeonRunCast(client as never, { sourceId: client.clientEntID, projectileId: null, isPersistent: false, hasTargetPos: true });
    noteDungeonRunHit(client as never, {
        sourceId: client.clientEntID,
        targetId: hostile.id,
        targetEntity: hostile,
        damage: 25
    });
    noteDungeonRunKill(levelScope, ['trackerrunner'], hostile.id, { ...hostile, hp: 0, dead: true, entState: 6 });

    client.character.questTrackerState = 100;
    const result = await finalizeAndReadResultWithPacket(client, 100, 0, 1);
    assertResultMatchesTrackerSummary(client, result);
    assert.equal(
        result.timeBonus,
        client.dungeonRun.finalizedStats!.scoreSummary.unlockedCap.timeBonus,
        'Goblin River full clears faster than the par time should keep the max time bonus'
    );
}

async function testWolfsEndTimeBonusCapsStayDungeonSpecific(): Promise<void> {
    const resolverCases: Array<{ levelName: string; expectedCap: number }> = [
        { levelName: 'TutorialDungeon', expectedCap: 40_000 },
        { levelName: 'GoblinRiverDungeon', expectedCap: 40_000 },
        { levelName: 'CraftTownTutorial', expectedCap: 60_000 },
        { levelName: 'GhostBossDungeon', expectedCap: 80_000 },
        { levelName: 'DreamDragonDungeon', expectedCap: 100_000 }
    ];

    for (const testCase of resolverCases) {
        assert.equal(
            getWolfsEndTimeBonusCap(testCase.levelName, 10_000),
            testCase.expectedCap,
            `${testCase.levelName} should resolve to its dungeon-specific time bonus cap`
        );
        assert.equal(
            testCase.expectedCap,
            getExpectedWolfsEndTimeCap(testCase.levelName),
            `${testCase.levelName} helper expectation should match the regression table`
        );
    }

}

function testWolfsEndLiveStatCapsStayDungeonSpecific(): void {
    const cases: Array<{ levelName: string; expectedCap: number }> = [
        { levelName: 'TutorialDungeon', expectedCap: 40_000 },
        { levelName: 'GoblinRiverDungeon', expectedCap: 40_000 },
        { levelName: 'CraftTownTutorial', expectedCap: 60_000 },
        { levelName: 'GhostBossDungeon', expectedCap: 40_000 },
        { levelName: 'DreamDragonDungeon', expectedCap: 40_000 }
    ];

    for (const testCase of cases) {
        assert.equal(
            getWolfsEndLiveStatCap(testCase.levelName, LIVE_ACCURACY_CAP),
            testCase.expectedCap,
            `${testCase.levelName} should resolve to its dungeon-specific live stat cap`
        );
        assert.equal(
            getExpectedWolfsEndLiveStatCap(testCase.levelName),
            testCase.expectedCap,
            `${testCase.levelName} regression table should match the live stat cap helper`
        );
    }
}

async function testBossSceneKillsOnlyUseBossEncounterEnemies(): Promise<void> {
    const client = createFakeDungeonClient('GhostBossDungeon', MissionID.KillNephit);
    const levelScope = getClientLevelScope(client as never);
    const preBossMinion = { id: 90051, name: 'GoblinClub', team: 2, entRank: 'Minion', hp: 10 };
    const boss = { id: 90052, name: 'NephitLargeEye', team: 2, entRank: 'Boss', hp: 10 };
    const bossAdd = { id: 90053, name: 'GhostMinion', team: 2, entRank: 'Minion', hp: 10 };

    GlobalState.sessionsByToken.set(client.token, client as never);
    syncClientDungeonRunState(client as never);
    resetTrackerEntityBuckets(client);
    noteDungeonRunEntitySeen(client as never, preBossMinion.id, preBossMinion);

    triggerBossCutscene(client, boss);
    noteDungeonRunEntitySeen(client as never, bossAdd.id, bossAdd);
    noteDungeonRunCast(client as never, { sourceId: client.clientEntID, projectileId: null, isPersistent: false });
    noteDungeonRunHit(client as never, {
        sourceId: client.clientEntID,
        targetId: boss.id,
        targetEntity: boss,
        damage: 25
    });
    noteDungeonRunKill(levelScope, ['trackerrunner'], boss.id, boss);

    const result = await finalizeAndReadResult(client);
    assertResultMatchesTrackerSummary(client, result);
    assert.equal(client.dungeonRun.finalizedStats?.scoreMode, 'boss_run', 'skipping pre-boss enemies should stay in boss_run mode');
    assert.equal(
        result.kills,
        client.dungeonRun.finalizedStats!.scoreSummary.unlockedCap.kills,
        'Wolf\'s End full clears should clamp boss-run kills to the max bucket once completion reaches 100%'
    );
}

async function testNoChestBossRunsUseHostileFallbackTreasure(): Promise<void> {
    const client = createFakeDungeonClient('GhostBossDungeon', MissionID.KillNephit);
    const levelScope = getClientLevelScope(client as never);
    const boss = { id: 90058, name: 'NephitLargeEye', team: 2, entRank: 'Boss', hp: 10 };

    GlobalState.sessionsByToken.set(client.token, client as never);
    syncClientDungeonRunState(client as never);
    resetTrackerEntityBuckets(client);
    triggerBossCutscene(client, boss);
    noteDungeonRunCast(client as never, {
        sourceId: client.clientEntID,
        hasTargetPos: true,
        projectileId: null,
        isPersistent: false
    });
    noteDungeonRunHit(client as never, {
        sourceId: client.clientEntID,
        targetId: boss.id,
        targetEntity: boss,
        damage: 25
    });
    noteDungeonRunKill(levelScope, ['trackerrunner'], boss.id, boss);

    const result = await finalizeAndReadResult(client);
    assertResultMatchesTrackerSummary(client, result);
    assert.equal(
        result.treasure,
        client.dungeonRun.finalizedStats!.scoreSummary.unlockedCap.treasure,
        'no-chest Wolf\'s End boss runs should max treasure through hostile fallback progress'
    );
}

async function testFinalPacketMatchesTrackerWithoutFallbackInflation(): Promise<void> {
    const client = createFakeDungeonClient('GhostBossDungeon', MissionID.KillNephit);
    const levelScope = getClientLevelScope(client as never);
    const boss = { id: 90062, name: 'NephitLargeEye', team: 2, entRank: 'Boss', hp: 10 };

    GlobalState.sessionsByToken.set(client.token, client as never);
    syncClientDungeonRunState(client as never);
    resetTrackerEntityBuckets(client);
    triggerBossCutscene(client, boss);
    noteDungeonRunCast(client as never, { sourceId: client.clientEntID, projectileId: null, isPersistent: false });
    noteDungeonRunKill(levelScope, ['trackerrunner'], boss.id, boss);

    const result = await finalizeAndReadResult(client);
    assertResultMatchesTrackerSummary(client, result);
    assert.equal(
        result.accuracy,
        client.dungeonRun.finalizedStats!.scoreSummary.unlockedCap.accuracy,
        'Wolf\'s End full clears should max accuracy even if completion was driven by dungeon progress rather than landed-hit bookkeeping'
    );
    assert.notEqual(result.accuracy, 50, 'accuracy should not fall back to the old fabricated default');
    assert.notEqual(result.deaths, 80_000, 'deaths should no longer use the legacy profile-perfect value');
}

async function testDreamDragonQuestTrackerFullClearOverridesPacketProgress(): Promise<void> {
    const client = createFakeDungeonClient('DreamDragonDungeon', MissionID.SlayTheDragon);
    const levelScope = getClientLevelScope(client as never);
    const boss = { id: 90072, name: 'DreamDragon', team: 2, entRank: 'Boss', hp: 10 };

    GlobalState.sessionsByToken.set(client.token, client as never);
    syncClientDungeonRunState(client as never);
    resetTrackerEntityBuckets(client);
    client.character.questTrackerState = 100;

    triggerBossCutscene(client, boss);
    noteDungeonRunCast(client as never, { sourceId: client.clientEntID, projectileId: null, isPersistent: false });
    noteDungeonRunHit(client as never, {
        sourceId: client.clientEntID,
        targetId: boss.id,
        targetEntity: boss,
        damage: 25
    });
    noteDungeonRunKill(levelScope, ['trackerrunner'], boss.id, boss);

    const result = await finalizeAndReadResultWithPacket(client, 99, 1, 2);
    assertResultMatchesTrackerSummary(client, result);
    assert.equal(
        client.dungeonRun.finalizedStats?.completionPercent,
        100,
        'Wolf\'s End completion should use the higher server-tracked quest progress when finalizing'
    );
    assert.equal(
        result.kills,
        client.dungeonRun.finalizedStats!.scoreSummary.unlockedCap.kills,
        'Dream Dragon full progress should clamp kills to max even if the client packet progress lags behind'
    );
    assert.equal(
        result.treasure,
        client.dungeonRun.finalizedStats!.scoreSummary.unlockedCap.treasure,
        'Dream Dragon full progress should clamp treasure to max even if the client packet progress lags behind'
    );
    assert.equal(
        result.accuracy,
        client.dungeonRun.finalizedStats!.scoreSummary.unlockedCap.accuracy,
        'Dream Dragon full progress should clamp accuracy to max even if the client packet progress lags behind'
    );
    assert.equal(
        result.deaths,
        client.dungeonRun.finalizedStats!.scoreSummary.unlockedCap.deaths,
        'Dream Dragon full progress should clamp deaths to max even if the client packet progress lags behind'
    );
}

async function main(): Promise<void> {
    ensureGameDataLoaded();

    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    GlobalState.sessionsByToken.clear();

    try {
        await testBossRunNoDeathsKeepsDeathsBase();
        GlobalState.sessionsByToken.clear();

        await testBossRunDeathsUseDungeonScaledPenalty();
        GlobalState.sessionsByToken.clear();

        await testBossRunAccuracyUsesBossFightOnlyWhenNoPreBossHits();
        GlobalState.sessionsByToken.clear();

        await testBossRunAccuracyStartsAtFirstPreBossHit();
        GlobalState.sessionsByToken.clear();

        await testBossRunElapsedTimingUsesEntryToDungeonCompletion();
        GlobalState.sessionsByToken.clear();

        await testGoblinRiverFullClearKeepsPositiveTimeBonusAtTenMinutes();
        GlobalState.sessionsByToken.clear();

        await testGoblinRiverFullClearKeepsMaxTimeBonusBeforeParTime();
        GlobalState.sessionsByToken.clear();

        await testWolfsEndTimeBonusCapsStayDungeonSpecific();
        GlobalState.sessionsByToken.clear();

        testWolfsEndLiveStatCapsStayDungeonSpecific();
        GlobalState.sessionsByToken.clear();

        await testBossSceneKillsOnlyUseBossEncounterEnemies();
        GlobalState.sessionsByToken.clear();

        await testNoChestBossRunsUseHostileFallbackTreasure();
        GlobalState.sessionsByToken.clear();

        await testFinalPacketMatchesTrackerWithoutFallbackInflation();
        GlobalState.sessionsByToken.clear();

        await testDreamDragonQuestTrackerFullClearOverridesPacketProgress();
    } finally {
        GlobalState.sessionsByToken = sessionsByToken;
    }

    console.log('dungeon_run_tracker_regression: ok');
}

void main().catch((error) => {
    console.error('dungeon_run_tracker_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
