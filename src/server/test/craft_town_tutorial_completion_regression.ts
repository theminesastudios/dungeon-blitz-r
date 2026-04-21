import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { MissionHandler } from '../handlers/MissionHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

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
    };
    pendingDungeonCompletionScope?: string;
    pendingDungeonCompletionRequestedAt?: number;
    pendingDungeonCompletionLastSkitAt?: number;
    pendingDungeonCompletionNotBeforeAt?: number;
    pendingDungeonCompletionSettleMs?: number;
    pendingDungeonCompletionPayload?: Buffer | null;
    pendingDungeonCompletionForceSharedScope?: string;
    pendingDungeonCompletionTimer?: NodeJS.Timeout | null;
    pendingDungeonCompletionFlushActive?: boolean;
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
            questTrackerState: 0
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

async function testCraftTownTutorialCompletionPreservesReturnCoordinatesUntilExitTransfer(): Promise<void> {
    const client = createFakeClient();

    seedClearedKeepLevelState();

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket());

    assert.equal(client.sentPackets.some((packet) => packet.id === 0x87), true);
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
        MissionHandler.CRAFT_TOWN_TUTORIAL_COMPLETION_DELAY_MS,
        'keep fallback completion should wait for the full defeat cutscene before it can flush'
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

    await sleep(
        MissionHandler.CRAFT_TOWN_TUTORIAL_COMPLETION_DELAY_MS + 300
    );

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        true,
        'the queued keep completion should still flush once the cutscene delay has elapsed'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.ClearYourHouse)]?.state ?? 0),
        3,
        'the fallback keep completion should claim I Claim This Keep so the home tutorial follow-up can start'
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
        1,
        'a real keep completion packet should replace the fallback instead of producing a duplicate exit'
    );
    assert.equal(
        client.pendingDungeonCompletionScope,
        '',
        'processing the real keep completion should clear the queued fallback state'
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
