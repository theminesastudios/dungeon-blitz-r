import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { LevelHandler } from '../handlers/LevelHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type FakeClient = {
    token: number;
    userId: number | null;
    clientEntID: number;
    character: any;
    characters: any[];
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    forcedDungeonCompletionScope: string;
    completedDungeonCompletionScope: string;
    activeDungeonCutsceneScope: string;
    playerSpawned: boolean;
    entities: Map<number, any>;
    knownEntityIds: Set<number>;
    sentPackets: Array<{ id: number; payload: Buffer }>;
    sendBitBuffer(id: number, bb: BitBuffer): void;
    send(id: number, payload: Buffer): void;
};

function ensureDataLoaded(): void {
    if (!LevelConfig.has('JC_Mission9')) {
        LevelConfig.load(path.resolve(__dirname, '../data'));
    }
}

function createClient(levelName: string = 'JC_Mission9', flowId: string = 'hiding-out-flow'): FakeClient {
    const sentPackets: Array<{ id: number; payload: Buffer }> = [];
    const character = {
        name: `${levelName}BossTester`,
        CurrentLevel: { name: levelName, x: 0, y: 0 },
        missions: {}
    };

    return {
        token: levelName.endsWith('Hard') ? 9402 : 9401,
        userId: null,
        clientEntID: 1,
        character,
        characters: [character],
        currentLevel: levelName,
        levelInstanceId: `${levelName.toLowerCase()}-${flowId}`,
        currentRoomId: 17,
        forcedDungeonCompletionScope: '',
        completedDungeonCompletionScope: '',
        activeDungeonCutsceneScope: '',
        playerSpawned: true,
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        },
        send(id: number, payload: Buffer): void {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        }
    };
}

function createEntityStatePacket(entityId: number, entState: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod45(0);
    bb.writeMethod45(0);
    bb.writeMethod45(0);
    bb.writeMethod6(entState, 2);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

async function sleep(ms: number = 0): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

function createLevelCompletePacket(progress: number = 100, remainingKills: number = 0, requiredKills: number = 1): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(progress);
    bb.writeMethod9(5000);
    bb.writeMethod9(100);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(remainingKills);
    bb.writeMethod9(requiredKills);
    bb.writeMethod9(10);
    return bb.toBuffer();
}

function addEntity(client: FakeClient, entity: any): void {
    client.entities.set(entity.id, entity);
    const levelScope = getClientLevelScope(client as never);
    let levelEntities = GlobalState.levelEntities.get(levelScope);
    if (!levelEntities) {
        levelEntities = new Map<number, any>();
        GlobalState.levelEntities.set(levelScope, levelEntities);
    }
    levelEntities.set(entity.id, entity);
}

function createBoss(id: number, name: string, defeated: boolean): any {
    return {
        id,
        name,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entRank: 'Boss',
        entState: defeated ? EntityState.DEAD : EntityState.ACTIVE,
        hp: defeated ? 0 : 100,
        maxHp: 100,
        dead: defeated,
        clientSpawned: true,
        playerDamageContributed: true,
        roomId: 17
    };
}

async function withScheduleCapture(run: (scheduled: Array<{ scope: string; waitForCutsceneEnd: boolean }>) => Promise<void>): Promise<void> {
    const originalSchedule = MissionHandler.scheduleDungeonCompletion;
    const scheduled: Array<{ scope: string; waitForCutsceneEnd: boolean }> = [];

    MissionHandler.scheduleDungeonCompletion = ((client: any, _payload: Buffer, options: any = {}) => {
        scheduled.push({
            scope: String(options?.forcedDungeonCompletionScope ?? `${client.currentLevel}#${client.levelInstanceId}`),
            waitForCutsceneEnd: Boolean(options?.waitForCutsceneEnd)
        });
        client.forcedDungeonCompletionScope = String(options?.forcedDungeonCompletionScope ?? '');
    }) as typeof MissionHandler.scheduleDungeonCompletion;

    try {
        await run(scheduled);
    } finally {
        MissionHandler.scheduleDungeonCompletion = originalSchedule;
    }
}

async function withFakeNow<T>(initialNow: number, run: (setNow: (nextNow: number) => void) => Promise<T>): Promise<T> {
    const originalNow = Date.now;
    let now = initialNow;
    Date.now = () => now;

    try {
        return await run((nextNow: number) => {
            now = nextNow;
        });
    } finally {
        Date.now = originalNow;
    }
}

async function testHidingOutWaitsForBothBossesAtOnce(): Promise<void> {
    const client = createClient('JC_Mission9', 'both-bosses-dead');
    const levelScope = getClientLevelScope(client as never);
    const firstBoss = createBoss(9501, 'RisenBandit', true);
    const secondBoss = createBoss(9502, 'RisenBandit2', false);

    GlobalState.sessionsByToken.set(client.token, client as never);
    addEntity(client, firstBoss);
    addEntity(client, secondBoss);

    await withScheduleCapture(async (scheduled) => {
        await MissionHandler.handleForcedDungeonBossCompletion(client as never, firstBoss);
        assert.deepEqual(scheduled, [], 'Hiding Out should not complete after only Shadow of Authority dies');

        secondBoss.entState = EntityState.DEAD;
        secondBoss.hp = 0;
        secondBoss.dead = true;
        await MissionHandler.handleForcedDungeonBossCompletion(client as never, secondBoss);
        assert.deepEqual(
            scheduled,
            [{ scope: levelScope, waitForCutsceneEnd: true }],
            'Hiding Out should complete only after both shadows are dead and wait for the defeat cutscene'
        );
    });
}

async function testHidingOutDeadBodiesCompleteFromSingleDeadStateScan(): Promise<void> {
    const client = createClient('JC_Mission9', 'dead-bodies-single-scan');
    const levelScope = getClientLevelScope(client as never);
    const firstBoss = createBoss(9701, 'RisenBandit', true);
    const secondBoss = createBoss(9702, 'RisenBandit2', true);

    GlobalState.sessionsByToken.set(client.token, client as never);
    addEntity(client, firstBoss);
    addEntity(client, secondBoss);

    await withScheduleCapture(async (scheduled) => {
        await MissionHandler.handleForcedDungeonBossCompletion(client as never, firstBoss);
        assert.deepEqual(
            scheduled,
            [{ scope: levelScope, waitForCutsceneEnd: true }],
            'Hiding Out should complete when both shadows are dead bodies during one boss completion scan'
        );
    });
}

async function testHidingOutKillStateQueuesCompletionWithoutMissionProgress(): Promise<void> {
    const client = createClient('JC_Mission9', 'kill-state-no-mission-progress');
    const levelScope = getClientLevelScope(client as never);
    const firstBoss = createBoss(9711, 'RisenBandit', false);
    const secondBoss = createBoss(9712, 'RisenBandit2', false);
    firstBoss.clientDefeatVerified = true;
    secondBoss.clientDefeatVerified = true;

    GlobalState.sessionsByToken.set(client.token, client as never);
    addEntity(client, firstBoss);
    addEntity(client, secondBoss);

    await withScheduleCapture(async (scheduled) => {
        await LevelHandler.handleEntityIncrementalUpdate(
            client as never,
            createEntityStatePacket(firstBoss.id, EntityState.DEAD)
        );
        assert.deepEqual(scheduled, [], 'first Hiding Out boss kill-state should not complete the dungeon by itself');

        await LevelHandler.handleEntityIncrementalUpdate(
            client as never,
            createEntityStatePacket(secondBoss.id, EntityState.DEAD)
        );
        assert.deepEqual(
            scheduled,
            [{ scope: levelScope, waitForCutsceneEnd: true }],
            'Hiding Out boss kill-state should queue completion even when no kill mission progress waits on it'
        );
    });
}

async function testHidingOutCutsceneEndCompletesDeadBodiesWithoutPendingCompletion(): Promise<void> {
    const client = createClient('JC_Mission9', 'cutscene-end-dead-bodies-no-pending');
    const levelScope = getClientLevelScope(client as never);
    const firstBoss = createBoss(9721, 'RisenBandit', true);
    const secondBoss = createBoss(9722, 'RisenBandit2', true);

    GlobalState.sessionsByToken.set(client.token, client as never);
    addEntity(client, firstBoss);
    addEntity(client, secondBoss);

    MissionHandler.noteDungeonCutsceneStart(client as never, 17);
    MissionHandler.noteDungeonCutsceneEnd(client as never, 17);
    await sleep(0);
    await sleep(0);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        true,
        'Hiding Out should show stats after the cutscene ends when both boss bodies remain and no pending completion was armed'
    );
    assert.equal(client.forcedDungeonCompletionScope, '');
    assert.equal(client.character.questTrackerState, 100);
    assert.equal(client.completedDungeonCompletionScope, levelScope);
}

async function testHidingOutRejectsSeparatedBossDeaths(): Promise<void> {
    const client = createClient('JC_Mission9', 'separated-boss-deaths');
    const firstBoss = createBoss(9511, 'RisenBandit', true);
    const secondBoss = createBoss(9512, 'RisenBandit2', false);

    GlobalState.sessionsByToken.set(client.token, client as never);
    addEntity(client, firstBoss);
    addEntity(client, secondBoss);

    await withFakeNow(10_000, async (setNow) => {
        await withScheduleCapture(async (scheduled) => {
            await MissionHandler.handleForcedDungeonBossCompletion(client as never, firstBoss);

            setNow(18_500);
            firstBoss.entState = EntityState.ACTIVE;
            firstBoss.hp = 100;
            firstBoss.dead = false;
            secondBoss.entState = EntityState.DEAD;
            secondBoss.hp = 0;
            secondBoss.dead = true;

            await MissionHandler.handleForcedDungeonBossCompletion(client as never, secondBoss);
            await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket(100, 0, 1));
            assert.deepEqual(
                scheduled,
                [],
                'Hiding Out should not complete when the two shadow deaths are separated by the revive window'
            );
            assert.equal(client.sentPackets.some((packet) => packet.id === 0x87), false);
        });
    });
}

async function testHidingOutWaitsForExplicitCutsceneEndBeforeStats(): Promise<void> {
    const client = createClient('JC_Mission9', 'explicit-cutscene-end-before-stats');
    const levelScope = getClientLevelScope(client as never);
    const firstBoss = createBoss(9731, 'RisenBandit', true);
    const secondBoss = createBoss(9732, 'RisenBandit2', true);

    GlobalState.sessionsByToken.set(client.token, client as never);
    addEntity(client, firstBoss);
    addEntity(client, secondBoss);

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, firstBoss);
    assert.equal(
        Boolean((client as any).pendingDungeonCompletionWaitForCutsceneEnd),
        true,
        'Hiding Out should queue completion behind the boss cutscene'
    );

    await sleep(25);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'Hiding Out should not show stats before the explicit cutscene end signal'
    );

    MissionHandler.noteDungeonCutsceneEnd(client as never, 17);
    await sleep(0);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        true,
        'Hiding Out should show stats after the explicit cutscene end signal'
    );
    assert.equal(client.completedDungeonCompletionScope, levelScope);
}

async function testHidingOutPendingCompletionCancelsWhenBossRevivesBeforeFlush(): Promise<void> {
    const client = createClient('JC_Mission9', 'revived-before-pending-flush');
    const firstBoss = createBoss(9741, 'RisenBandit', true);
    const secondBoss = createBoss(9742, 'RisenBandit2', true);

    GlobalState.sessionsByToken.set(client.token, client as never);
    addEntity(client, firstBoss);
    addEntity(client, secondBoss);

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, firstBoss);
    assert.equal(
        Boolean((client as any).pendingDungeonCompletionWaitForCutsceneEnd),
        true,
        'Hiding Out should queue completion when both shadows are initially down'
    );

    secondBoss.entState = EntityState.ACTIVE;
    secondBoss.hp = 100;
    secondBoss.dead = false;

    MissionHandler.noteDungeonCutsceneEnd(client as never, 17);
    await sleep(0);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'Hiding Out should not show stats if a shadow revives before the cutscene ends'
    );
    assert.equal(client.completedDungeonCompletionScope, '');
    assert.equal(client.forcedDungeonCompletionScope, '');
}

async function testHidingOutRejectsClientCompletionAfterOneBossDies(): Promise<void> {
    const client = createClient('JC_Mission9', 'client-complete-one-boss-dead');
    const firstBoss = createBoss(9521, 'RisenBandit', true);
    const secondBoss = createBoss(9522, 'RisenBandit2', false);

    GlobalState.sessionsByToken.set(client.token, client as never);
    addEntity(client, firstBoss);
    addEntity(client, secondBoss);

    await withScheduleCapture(async (scheduled) => {
        await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket(100, 0, 1));
        assert.deepEqual(scheduled, [], 'client completion packets should be ignored after only one Hiding Out shadow dies');
        assert.equal(client.sentPackets.some((packet) => packet.id === 0x87), false);
    });
}

async function testHidingOutDoesNotCompleteAfterRevivedBossIsAlive(): Promise<void> {
    const client = createClient('JC_Mission9', 'revived-first-boss');
    const firstBoss = createBoss(9551, 'RisenBandit', true);
    const secondBoss = createBoss(9552, 'RisenBandit2', false);

    GlobalState.sessionsByToken.set(client.token, client as never);
    addEntity(client, firstBoss);
    addEntity(client, secondBoss);

    await withScheduleCapture(async (scheduled) => {
        await MissionHandler.handleForcedDungeonBossCompletion(client as never, firstBoss);

        firstBoss.entState = EntityState.ACTIVE;
        firstBoss.hp = 100;
        firstBoss.dead = false;
        secondBoss.entState = EntityState.DEAD;
        secondBoss.hp = 0;
        secondBoss.dead = true;

        await MissionHandler.handleForcedDungeonBossCompletion(client as never, secondBoss);
        assert.deepEqual(
            scheduled,
            [],
            'Hiding Out should not complete when one shadow was revived before the other dies'
        );
    });
}

async function testHardHidingOutWaitsForBothBosses(): Promise<void> {
    const client = createClient('JC_Mission9Hard', 'hard-both-bosses-dead');
    const levelScope = getClientLevelScope(client as never);
    const firstBoss = createBoss(9601, 'RisenBanditHard', true);
    const secondBoss = createBoss(9602, 'RisenBandit2Hard', true);

    GlobalState.sessionsByToken.set(client.token, client as never);
    addEntity(client, firstBoss);
    addEntity(client, secondBoss);

    await withScheduleCapture(async (scheduled) => {
        await MissionHandler.handleForcedDungeonBossCompletion(client as never, firstBoss);
        await MissionHandler.handleForcedDungeonBossCompletion(client as never, secondBoss);
        assert.deepEqual(
            scheduled,
            [{ scope: levelScope, waitForCutsceneEnd: true }],
            'hard Hiding Out should use the hard shadow pair as required bosses'
        );
    });
}

async function main(): Promise<void> {
    ensureDataLoaded();
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const levelEntities = new Map(GlobalState.levelEntities);

    try {
        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        await testHidingOutWaitsForBothBossesAtOnce();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        await testHidingOutDeadBodiesCompleteFromSingleDeadStateScan();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        await testHidingOutKillStateQueuesCompletionWithoutMissionProgress();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        await testHidingOutCutsceneEndCompletesDeadBodiesWithoutPendingCompletion();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        await testHidingOutRejectsSeparatedBossDeaths();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        await testHidingOutWaitsForExplicitCutsceneEndBeforeStats();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        await testHidingOutPendingCompletionCancelsWhenBossRevivesBeforeFlush();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        await testHidingOutRejectsClientCompletionAfterOneBossDies();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        await testHidingOutDoesNotCompleteAfterRevivedBossIsAlive();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        await testHardHidingOutWaitsForBothBosses();
    } finally {
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.levelEntities = levelEntities;
    }

    console.log('hiding_out_completion_objectives_regression: ok');
}

void main().catch((error) => {
    console.error('hiding_out_completion_objectives_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
