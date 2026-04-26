import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { MissionHandler } from '../handlers/MissionHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    currentLevel: string;
    levelInstanceId: string;
    userId: number | null;
    character: {
        name: string;
        CurrentLevel: { name: string; x: number; y: number };
        PreviousLevel: { name: string; x: number; y: number };
        missions: Record<string, { state: number; currCount?: number }>;
        questTrackerState: number;
        level?: number;
        xp?: number;
        gold?: number;
        magicForge?: { stats_by_building: Record<string, unknown> };
        buildingUpgrade?: { buildingID: number; rank: number; ReadyTime: number };
    };
    lastDoorId?: number;
    lastDoorTargetLevel?: string;
    armPendingTransferGrace?: () => void;
    pendingDungeonCompletionScope?: string;
    pendingDungeonCompletionRequestedAt?: number;
    pendingDungeonCompletionLastSkitAt?: number;
    pendingDungeonCompletionNotBeforeAt?: number;
    pendingDungeonCompletionSettleMs?: number;
    pendingDungeonCompletionPayload?: Buffer | null;
    pendingDungeonCompletionForceSharedScope?: string;
    pendingDungeonCompletionTimer?: NodeJS.Timeout | null;
    pendingDungeonCompletionFlushActive?: boolean;
    pendingDungeonCompletionWaitForCutsceneEnd?: boolean;
    activeDungeonCutsceneScope?: string;
    activeDungeonCutsceneRoomId?: number;
    forcedDungeonCompletionScope?: string;
    keepTutorialState?: { bossDefeated: boolean };
    sentPackets: SentPacket[];
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureLevelConfigLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('CraftTownTutorial')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.ClearYourHouse)) {
        MissionLoader.load(dataDir);
    }
}

function createFakeClient(): FakeClient {
    const sentPackets: SentPacket[] = [];

    return {
        currentLevel: 'CraftTownTutorial',
        levelInstanceId: 'keep-run',
        userId: null,
        character: {
            name: 'KeepRunner',
            CurrentLevel: { name: 'CraftTown', x: 918, y: 1440 },
            PreviousLevel: { name: 'WolfsEnd', x: 1210, y: 880 },
            missions: {
                '5': {
                    state: 1,
                    currCount: 0
                }
            },
            questTrackerState: 0,
            level: 1,
            xp: 0,
            gold: 0,
            magicForge: {
                stats_by_building: {
                    '12': 0
                }
            },
            buildingUpgrade: {
                buildingID: 12,
                rank: 5,
                ReadyTime: 999999999
            }
        },
        lastDoorId: 0,
        lastDoorTargetLevel: '',
        armPendingTransferGrace() {
            return undefined;
        },
        pendingDungeonCompletionScope: '',
        pendingDungeonCompletionRequestedAt: 0,
        pendingDungeonCompletionLastSkitAt: 0,
        pendingDungeonCompletionNotBeforeAt: 0,
        pendingDungeonCompletionSettleMs: 0,
        pendingDungeonCompletionPayload: null,
        pendingDungeonCompletionForceSharedScope: '',
        pendingDungeonCompletionTimer: null,
        pendingDungeonCompletionFlushActive: false,
        pendingDungeonCompletionWaitForCutsceneEnd: false,
        activeDungeonCutsceneScope: '',
        activeDungeonCutsceneRoomId: 0,
        forcedDungeonCompletionScope: '',
        keepTutorialState: { bossDefeated: true },
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createLevelCompletePacket(): Buffer {
    const bb = new BitBuffer();
    bb.writeMethod9(100);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(1);
    bb.writeMethod9(3);
    return bb.toBuffer();
}

function decodeDoorTarget(packet: Buffer): { doorId: number; targetLevel: string } {
    const br = new BitReader(packet);
    return {
        doorId: br.readMethod4(),
        targetLevel: br.readMethod13()
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function seedClearedKeepLevelState(): void {
    GlobalState.levelEntities.set(
        'CraftTownTutorial#keep-run',
        new Map<number, any>([
            [
                7401,
                {
                    id: 7401,
                    name: 'IntroGoblinShamanHood',
                    isPlayer: false,
                    x: 49,
                    y: 1459,
                    team: 2,
                    entState: 6,
                    hp: 0,
                    dead: true
                }
            ]
        ])
    );
}

async function testQueuedDungeonCompletionWaitsForCutsceneEnd(): Promise<void> {
    const client = createFakeClient();
    seedClearedKeepLevelState();

    MissionHandler.noteDungeonCutsceneStart(client as never, 7);
    MissionHandler.scheduleDungeonCompletion(
        client as never,
        createLevelCompletePacket(),
        {
            forcedDungeonCompletionScope: 'CraftTownTutorial#keep-run',
            initialDelayMs: 0,
            settleDelayMs: 0
        }
    );

    await sleep(50);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'queued dungeon completion stats should not open while the boss cutscene is active'
    );

    MissionHandler.noteDungeonCutsceneEnd(client as never, 7);
    await sleep(25);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'queued keep completion should not open dungeon stats even after the cutscene end packet'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x2E),
        true,
        'queued keep completion should offer the Home transfer after the cutscene end packet'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.ClearYourHouse)]?.state ?? 0),
        3,
        'queued keep completion should claim I Claim This Keep after the cutscene end packet'
    );
    assert.equal(client.character.xp, 5, 'queued keep completion should pay the quest XP reward');
    assert.equal(client.character.gold, 5, 'queued keep completion should pay the quest gold reward');
    assert.equal(Number(client.character.magicForge?.stats_by_building?.['12'] ?? 0), 5);
}

async function testClientLevelCompleteWaitsForCutsceneEnd(): Promise<void> {
    const client = createFakeClient();
    seedClearedKeepLevelState();

    MissionHandler.noteDungeonCutsceneStart(client as never, 7);
    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket());
    await sleep(50);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'client level-complete packets should not open dungeon stats while the cutscene is active'
    );
    assert.equal(
        client.pendingDungeonCompletionScope,
        'CraftTownTutorial#keep-run',
        'client level-complete packets should be queued against the active cutscene scope'
    );
    assert.equal(
        client.pendingDungeonCompletionWaitForCutsceneEnd,
        true,
        'client level-complete packets should require the cutscene end signal before flushing'
    );

    MissionHandler.noteDungeonCutsceneStart(client as never, 7);
    MissionHandler.noteDungeonCutsceneEnd(client as never, 7);
    await sleep(25);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'client level-complete packets should not open dungeon stats for I Claim This Keep'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x2E),
        true,
        'client level-complete packets should send the player Home after the skit'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.ClearYourHouse)]?.state ?? 0),
        3,
        'client level-complete packets should claim I Claim This Keep after cutscene end'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x2B),
        true,
        'client level-complete packets should send the I Claim This Keep XP reward'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x35),
        true,
        'client level-complete packets should send the I Claim This Keep gold reward'
    );
}

async function testCraftTownTutorialCompletionPreservesReturnCoordinatesUntilExitTransfer(): Promise<void> {
    const client = createFakeClient();

    seedClearedKeepLevelState();

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket());

    assert.equal(client.sentPackets.some((packet) => packet.id === 0x87), false);
    const doorTargetPacket = client.sentPackets.find((packet) => packet.id === 0x2E);
    assert.ok(doorTargetPacket, 'I Claim This Keep completion should send a Home door target');
    assert.deepEqual(
        decodeDoorTarget(doorTargetPacket.payload),
        { doorId: 2, targetLevel: 'CraftTown' },
        'I Claim This Keep should transfer back to Home'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x84),
        true,
        'I Claim This Keep should send its mission complete reward UI when the quest is auto-claimed'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x86),
        true,
        'I Claim This Keep completion should tell the client the mission completed'
    );
    assert.equal(Number(client.character.magicForge?.stats_by_building?.['12'] ?? 0), 5);
    assert.equal(Number(client.character.missions[String(MissionID.ClearYourHouse)]?.state ?? 0), 3);
    assert.equal(client.character.xp, 5);
    assert.equal(client.character.gold, 5);
    assert.deepEqual(client.character.buildingUpgrade, { buildingID: 0, rank: 0, ReadyTime: 0 });
    assert.deepEqual(client.character.CurrentLevel, { name: 'CraftTown', x: 918, y: 1440 });
    assert.deepEqual(client.character.PreviousLevel, { name: 'WolfsEnd', x: 1210, y: 880 });
}

async function testCraftTownTutorialBossKillSchedulesDelayedFallbackCompletion(): Promise<void> {
    const client = createFakeClient();
    const boss = {
        id: 7401,
        name: 'IntroGoblinShamanHood',
        isPlayer: false,
        x: 49,
        y: 1459,
        team: 2,
        entState: 6,
        hp: 0,
        dead: true
    };

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'Ranik death should not exit the keep immediately'
    );
    assert.equal(
        client.pendingDungeonCompletionScope,
        'CraftTownTutorial#keep-run',
        'Ranik death should queue a keep completion fallback in the active keep instance'
    );
    assert.equal(
        Number(client.pendingDungeonCompletionNotBeforeAt ?? 0) -
            Number(client.pendingDungeonCompletionRequestedAt ?? 0),
        0,
        'keep fallback completion should rely on the cutscene end signal instead of a fixed delay'
    );
    assert.equal(
        client.pendingDungeonCompletionForceSharedScope,
        'CraftTownTutorial#keep-run',
        'keep fallback completion should bypass the shared-progress empty-board guard once Ranik is down'
    );
    assert.equal(
        Number(client.pendingDungeonCompletionSettleMs ?? -1),
        0,
        'keep fallback completion should not add extra settle delay after the defeat skit finishes'
    );
    assert.equal(
        client.pendingDungeonCompletionWaitForCutsceneEnd,
        true,
        'boss death should only arm completion for the cutscene end signal'
    );

    await sleep(
        MissionHandler.CRAFT_TOWN_TUTORIAL_COMPLETION_DELAY_MS + 300
    );

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'the queued keep completion should not flush just because the old boss-death delay elapsed'
    );

    MissionHandler.noteDungeonCutsceneStart(client as never, 7);
    MissionHandler.noteDungeonCutsceneEnd(client as never, 7);
    await sleep(0);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'the queued keep completion should not show dungeon stats after the cutscene end signal'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x2E),
        true,
        'the queued keep completion should send the player Home after the cutscene end signal'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.ClearYourHouse)]?.state ?? 0),
        3,
        'the fallback keep completion should claim I Claim This Keep'
    );
}

async function testCraftTownTutorialRealCompletionCancelsPendingFallback(): Promise<void> {
    const client = createFakeClient();
    const boss = {
        id: 7401,
        name: 'IntroGoblinShamanHood',
        isPlayer: false,
        x: 49,
        y: 1459,
        team: 2,
        entState: 6,
        hp: 0,
        dead: true
    };

    seedClearedKeepLevelState();
    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);
    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket());

    assert.equal(
        client.sentPackets.filter((packet) => packet.id === 0x87).length,
        0,
        'I Claim This Keep should suppress both real and fallback dungeon stat packets'
    );
    assert.equal(
        client.pendingDungeonCompletionScope,
        'CraftTownTutorial#keep-run',
        'real keep completion should stay queued while the cutscene gate is waiting'
    );

    MissionHandler.noteDungeonCutsceneEnd(client as never, 7);
    await sleep(0);

    assert.equal(
        client.pendingDungeonCompletionScope,
        '',
        'cutscene end should clear the queued keep completion state'
    );
}

function testCraftTownTutorialSharedProgressDoesNotAutoCompleteBeforeBossDefeat(): void {
    const client = createFakeClient();
    client.keepTutorialState = { bossDefeated: false };
    (client as FakeClient & { playerSpawned?: boolean; token?: number; dungeonRun?: { finalizedAt?: number } }).playerSpawned = true;
    (client as FakeClient & { playerSpawned?: boolean; token?: number; dungeonRun?: { finalizedAt?: number } }).token = 7001;

    GlobalState.sessionsByToken.set(7001, client as never);
    GlobalState.levelQuestProgress.set('CraftTownTutorial#keep-run', {
        progress: 100,
        authorityToken: 7001,
        completionRequested: false,
        trackedHostileIds: new Set<number>(),
        defeatedHostileIds: new Set<number>(),
        liveStatsByCharacter: new Map()
    });

    (LevelHandler as any).maybeAutoCompleteSharedDungeon(
        'CraftTownTutorial#keep-run',
        GlobalState.levelQuestProgress.get('CraftTownTutorial#keep-run')
    );

    assert.equal(
        GlobalState.levelQuestProgress.get('CraftTownTutorial#keep-run')?.completionRequested,
        false,
        'keep intro progress should not auto-complete the dungeon before Ranik is actually defeated'
    );
    assert.equal(
        client.pendingDungeonCompletionScope,
        '',
        'keep intro progress should not queue a forced completion while the boss cutscene is only starting'
    );
}

async function main(): Promise<void> {
    ensureLevelConfigLoaded();

    const levelEntities = new Map(GlobalState.levelEntities);
    const levelQuestProgress = new Map(GlobalState.levelQuestProgress);
    GlobalState.levelEntities.clear();
    GlobalState.levelQuestProgress.clear();

    try {
        await testQueuedDungeonCompletionWaitsForCutsceneEnd();
        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        await testClientLevelCompleteWaitsForCutsceneEnd();
        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        await testCraftTownTutorialBossKillSchedulesDelayedFallbackCompletion();
        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        await testCraftTownTutorialRealCompletionCancelsPendingFallback();
        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        await testCraftTownTutorialCompletionPreservesReturnCoordinatesUntilExitTransfer();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        testCraftTownTutorialSharedProgressDoesNotAutoCompleteBeforeBossDefeat();
    } finally {
        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities = levelEntities;
        GlobalState.levelQuestProgress = levelQuestProgress;
    }

    console.log('craft_town_tutorial_completion_regression: ok');
}

void main().catch((error) => {
    console.error('craft_town_tutorial_completion_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
