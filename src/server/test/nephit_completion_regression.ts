import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type SentPacket = { id: number; payload: Buffer };

type FakeClient = {
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    token: number;
    userId: null;
    playerSpawned: boolean;
    clientEntID: number;
    character: any;
    characters: any[];
    sentPackets: SentPacket[];
    entities: Map<number, any>;
    pendingDungeonCompletionScope: string;
    pendingDungeonCompletionRequestedAt: number;
    pendingDungeonCompletionLastSkitAt: number;
    pendingDungeonCompletionNotBeforeAt: number;
    pendingDungeonCompletionSettleMs: number;
    pendingDungeonCompletionPayload: Buffer | null;
    pendingDungeonCompletionForceSharedScope: string;
    pendingDungeonCompletionTimer: NodeJS.Timeout | null;
    pendingDungeonCompletionFlushActive: boolean;
    pendingDungeonCompletionWaitForCutsceneEnd: boolean;
    activeDungeonCutsceneScope: string;
    activeDungeonCutsceneRoomId: number;
    lastDungeonCutsceneStartScope: string;
    lastDungeonCutsceneStartAt: number;
    lastDungeonCutsceneEndScope: string;
    lastDungeonCutsceneEndAt: number;
    forcedDungeonCompletionScope: string;
    finalizingDungeonCompletionScope: string;
    completedDungeonCompletionScope: string;
    completedDungeonCompletionSentAt: number;
    armPendingTransferGrace(): void;
    send(id: number, payload: Buffer): void;
    sendBitBuffer(id: number, bb: BitBuffer): void;
};

const TEST_SETTLE_MS = 12;

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('GhostBossDungeon')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.KillNephit)) {
        MissionLoader.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
}

function createFakeClient(name: string, token: number, questTrackerState: number): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = {
        name,
        CurrentLevel: { name: 'GhostBossDungeon', x: 3200, y: 1400 },
        PreviousLevel: { name: 'NewbieRoad', x: 1210, y: 880 },
        missions: {
            [String(MissionID.KillNephit)]: {
                state: 1,
                currCount: 0
            }
        },
        questTrackerState,
        level: 12,
        xp: 0,
        gold: 0
    };

    return {
        currentLevel: 'GhostBossDungeon',
        levelInstanceId: `nephit-run-${token}`,
        currentRoomId: 12,
        token,
        userId: null,
        playerSpawned: true,
        clientEntID: token + 1000,
        character,
        characters: [character],
        sentPackets,
        entities: new Map(),
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
        lastDungeonCutsceneStartScope: '',
        lastDungeonCutsceneStartAt: 0,
        lastDungeonCutsceneEndScope: '',
        lastDungeonCutsceneEndAt: 0,
        forcedDungeonCompletionScope: '',
        finalizingDungeonCompletionScope: '',
        completedDungeonCompletionScope: '',
        completedDungeonCompletionSentAt: 0,
        armPendingTransferGrace() {
            return undefined;
        },
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createNephitBoss(alias: string = 'Nephit'): any {
    return {
        id: 8801,
        name: alias,
        characterName: `,${alias}`,
        character_name: `,${alias}`,
        isPlayer: false,
        roomId: 12,
        team: EntityTeam.ENEMY,
        entState: EntityState.DEAD,
        hp: 0,
        maxHp: 1,
        dead: true,
        clientSpawned: true,
        clientDefeatVerified: true,
        playerDamageContributed: true
    };
}

function createAliveNephitBoss(alias: string = 'Nephit'): any {
    return {
        ...createNephitBoss(alias),
        entState: EntityState.ACTIVE,
        hp: 1000,
        maxHp: 1000,
        dead: false,
        clientDefeatVerified: false,
        playerDamageContributed: false
    };
}

function createBossDungeonClient(name: string, token: number, levelName: string): FakeClient {
    const missionDef = MissionLoader.findPrimaryMissionByDungeon(levelName);
    assert.ok(missionDef, `${levelName} should have a primary mission`);
    const missionId = Number(missionDef.MissionID ?? 0);
    assert.ok(missionId > 0, `${levelName} primary mission should have an id`);

    const client = createFakeClient(name, token, 0);
    client.currentLevel = levelName;
    client.levelInstanceId = `${levelName.toLowerCase()}-run-${token}`;
    client.character.CurrentLevel = { name: levelName, x: 3200, y: 1400 };
    client.character.missions = {
        [String(missionId)]: {
            state: 1,
            currCount: 0
        }
    };
    return client;
}

function createImperialChampionBoss(): any {
    return {
        id: 9901,
        name: 'ImperialChampion',
        characterName: ',ImperialChampion',
        character_name: ',ImperialChampion',
        isPlayer: false,
        roomId: 8,
        team: EntityTeam.ENEMY,
        entState: EntityState.DEAD,
        hp: 0,
        maxHp: 1,
        dead: true,
        clientSpawned: true,
        clientDefeatVerified: true,
        playerDamageContributed: true
    };
}

function seedNephitRun(client: FakeClient, boss: any): void {
    const scope = getClientLevelScope(client as never);
    client.entities.set(boss.id, boss);
    GlobalState.levelEntities.set(scope, new Map([
        [boss.id, boss],
        [
            8802,
            {
                id: 8802,
                name: 'SkeletonWarrior',
                isPlayer: false,
                roomId: 5,
                team: EntityTeam.ENEMY,
                entState: EntityState.ACTIVE,
                hp: 100,
                maxHp: 100,
                dead: false,
                clientSpawned: true
            }
        ]
    ]));
}

function seedSingleBossRun(client: FakeClient, boss: any): void {
    const scope = getClientLevelScope(client as never);
    client.entities.set(boss.id, boss);
    GlobalState.levelEntities.set(scope, new Map([[boss.id, boss]]));
}

function seedNephitRunWithClientOnlyBossProxy(client: FakeClient, boss: any): void {
    const scope = getClientLevelScope(client as never);
    client.entities.set(boss.id, boss);
    GlobalState.levelEntities.set(scope, new Map([
        [
            8802,
            {
                id: 8802,
                name: 'SkeletonWarrior',
                isPlayer: false,
                roomId: 5,
                team: EntityTeam.ENEMY,
                entState: EntityState.ACTIVE,
                hp: 100,
                maxHp: 100,
                dead: false,
                clientSpawned: true
            }
        ]
    ]));
}

function rankPacketCount(client: FakeClient): number {
    return client.sentPackets.filter((packet) => packet.id === 0x87).length;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForPendingSettle(): Promise<void> {
    await sleep(TEST_SETTLE_MS + 25);
}

async function testNephitAliasCompletesAfterPostBossSkitQuiet(): Promise<void> {
    const client = createFakeClient('NephitRunner', 83001, 0);
    const boss = createNephitBoss('Nephit');
    seedNephitRun(client, boss);

    assert.equal(rankPacketCount(client), 0, 'rank screen must not appear before boss defeat');

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);

    assert.equal(client.pendingDungeonCompletionScope, getClientLevelScope(client as never));
    assert.equal(client.pendingDungeonCompletionWaitForCutsceneEnd, true);
    assert.equal(rankPacketCount(client), 0, 'rank screen must not appear before post-boss skit settles');

    MissionHandler.noteDungeonCutsceneStart(client as never, 12);
    MissionHandler.noteDungeonSkitActivity(client as never);
    await waitForPendingSettle();

    assert.equal(rankPacketCount(client), 0, 'rank screen must wait for the post-boss cutscene close');
    MissionHandler.noteDungeonCutsceneEnd(client as never, 12);
    await waitForPendingSettle();

    assert.equal(rankPacketCount(client), 1, 'normal dungeon rank/statistics packet should be sent after the cutscene ends');
    assert.equal(Number(client.character.questTrackerState ?? 0), 100, 'completion should update tracker to 100 after validation');
    assert.ok(
        Number(client.character.missions[String(MissionID.KillNephit)]?.state ?? 0) >= 2,
        'Nephit dungeon mission should be persisted as completed or ready to turn in'
    );

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);
    MissionHandler.noteDungeonSkitActivity(client as never);
    await waitForPendingSettle();

    assert.equal(rankPacketCount(client), 1, 'rank/statistics packet should be sent exactly once per run');
}

async function testQuestTrackerTwentySixStillCompletesAfterBossSkit(): Promise<void> {
    const client = createFakeClient('NephitTrackerRunner', 83002, 26);
    const boss = createNephitBoss('Nephit');
    seedNephitRun(client, boss);

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);

    assert.equal(Number(client.character.questTrackerState ?? 0), 26, 'tracker should remain partial before completion flush');
    assert.equal(rankPacketCount(client), 0);

    MissionHandler.noteDungeonCutsceneStart(client as never, 12);
    MissionHandler.noteDungeonSkitActivity(client as never);
    await waitForPendingSettle();
    assert.equal(rankPacketCount(client), 0, 'boss objective should not complete before the ending cutscene closes');

    MissionHandler.noteDungeonCutsceneEnd(client as never, 12);
    await waitForPendingSettle();

    assert.equal(rankPacketCount(client), 1, 'boss objective should complete even when tracker was stuck at 26 percent');
    assert.equal(Number(client.character.questTrackerState ?? 0), 100);
}

async function testPostCutsceneCompletesWhenDefeatedBossProxyOnlyExistsClientSide(): Promise<void> {
    const client = createFakeClient('NephitProxyRunner', 83004, 37);
    const boss = createNephitBoss('Nephit');
    seedNephitRunWithClientOnlyBossProxy(client, boss);

    MissionHandler.noteDungeonCutsceneStart(client as never, 12);
    MissionHandler.noteDungeonCutsceneEnd(client as never, 12);
    await waitForPendingSettle();

    assert.equal(rankPacketCount(client), 1, 'post-cutscene completion should recover defeated Nephit proxy from client cache');
    assert.equal(Number(client.character.questTrackerState ?? 0), 100);
    assert.ok(
        Number(client.character.missions[String(MissionID.KillNephit)]?.state ?? 0) >= 2,
        'recovered Nephit proxy completion should persist mission state'
    );
}

async function testNonNephitBossDungeonStillOpensRankScreen(): Promise<void> {
    const client = createBossDungeonClient('ImperialRunner', 83005, 'JC_Mission1');
    const boss = createImperialChampionBoss();
    seedSingleBossRun(client, boss);

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);
    MissionHandler.noteDungeonSkitActivity(client as never);
    await waitForPendingSettle();

    assert.equal(rankPacketCount(client), 1, 'non-Nephit boss dungeon should still send the rank/statistics packet');
}

async function testEarlyCutsceneDoesNotCompleteBeforeBossDeath(): Promise<void> {
    const client = createFakeClient('EarlySceneRunner', 83003, 26);
    const boss = createAliveNephitBoss('Nephit');
    seedNephitRun(client, boss);

    MissionHandler.noteDungeonCutsceneStart(client as never, 3);
    MissionHandler.noteDungeonSkitActivity(client as never);
    MissionHandler.noteDungeonCutsceneEnd(client as never, 3);
    await waitForPendingSettle();

    assert.equal(rankPacketCount(client), 0, 'early non-boss cutscene must not trigger completion');
    assert.equal(Number(client.character.questTrackerState ?? 0), 26);
}

async function main(): Promise<void> {
    ensureDataLoaded();

    const originalSettleMs = MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS;
    const levelEntities = new Map(GlobalState.levelEntities);
    const levelQuestProgress = new Map(GlobalState.levelQuestProgress);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);

    try {
        (MissionHandler as any).DUNGEON_COMPLETION_SKIT_SETTLE_MS = TEST_SETTLE_MS;

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        await testNephitAliasCompletesAfterPostBossSkitQuiet();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        await testQuestTrackerTwentySixStillCompletesAfterBossSkit();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        await testPostCutsceneCompletesWhenDefeatedBossProxyOnlyExistsClientSide();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        await testNonNephitBossDungeonStillOpensRankScreen();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        await testEarlyCutsceneDoesNotCompleteBeforeBossDeath();
    } finally {
        (MissionHandler as any).DUNGEON_COMPLETION_SKIT_SETTLE_MS = originalSettleMs;
        GlobalState.levelEntities = levelEntities;
        GlobalState.levelQuestProgress = levelQuestProgress;
        GlobalState.sessionsByToken.clear();
        for (const [token, session] of sessionsByToken) {
            GlobalState.sessionsByToken.set(token, session);
        }
    }

    console.log('nephit_completion_regression: ok');
}

void main().catch((error) => {
    console.error('nephit_completion_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
