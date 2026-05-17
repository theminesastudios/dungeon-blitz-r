import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { CombatHandler } from '../handlers/CombatHandler';
import { LevelHandler } from '../handlers/LevelHandler';
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
    playerSpawned: boolean;
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    clientEntID: number;
    lastDoorId: number;
    lastDoorTargetLevel: string;
    forcedDungeonCompletionScope: string;
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
    lastDungeonCutsceneStartScope?: string;
    lastDungeonCutsceneStartAt?: number;
    lastDungeonCutsceneEndScope?: string;
    lastDungeonCutsceneEndAt?: number;
    knownEntityIds: Set<number>;
    character: {
        name: string;
        level: number;
        xp: number;
        gold: number;
        CurrentLevel: { name: string; x: number; y: number };
        PreviousLevel: { name: string; x: number; y: number };
        missions: Record<string, { state: number; currCount?: number; claimed?: number; complete?: number }>;
        questTrackerState: number;
        lastCompletedDungeonLevel?: string;
    };
    characters: any[];
    entities: Map<number, any>;
    dungeonRun: any;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
    armPendingTransferGrace: () => void;
};

type WelcomePartyCase = {
    level: string;
    missionId: MissionID;
    followupMissionId: MissionID;
    bossName: string;
    gatewayLevel: string;
};

const WELCOME_PARTY_CASES: WelcomePartyCase[] = [
    {
        level: 'JC_Mission1',
        missionId: MissionID.HeadToValhaven,
        followupMissionId: MissionID.MeetWithOdin,
        bossName: 'ImperialChampion',
        gatewayLevel: 'JadeCity'
    },
    {
        level: 'JC_Mission1Hard',
        missionId: MissionID.HeadToValhavenHard,
        followupMissionId: MissionID.MeetWithOdinHard,
        bossName: 'ImperialChampionHard',
        gatewayLevel: 'JadeCityHard'
    }
];

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('JC_Mission1') || !LevelConfig.has('JC_Mission1Hard')) {
        LevelConfig.load(dataDir);
    }
    if (!GameData.getEntType('ImperialChampion') || !GameData.getEntType('ImperialChampionHard')) {
        GameData.load(dataDir);
    }
    if (
        !MissionLoader.getMissionDef(MissionID.HeadToValhaven) ||
        !MissionLoader.getMissionDef(MissionID.HeadToValhavenHard)
    ) {
        MissionLoader.load(dataDir);
    }
}

function createClient(testCase: WelcomePartyCase, index: number, nameSuffix: string): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = {
        name: `WelcomeParty${nameSuffix}${index}`,
        level: 50,
        xp: 0,
        gold: 0,
        CurrentLevel: { name: testCase.level, x: 0, y: 0 },
        PreviousLevel: { name: testCase.level.endsWith('Hard') ? 'JadeCityHard' : 'JadeCity', x: 0, y: 0 },
        missions: {
            [String(MissionID.DeliverToSwamp)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1
            },
            [String(testCase.missionId)]: {
                state: 1,
                currCount: 0
            }
        },
        questTrackerState: 64
    };

    return {
        token: 29100 + index,
        userId: null,
        playerSpawned: true,
        currentLevel: testCase.level,
        levelInstanceId: `${testCase.level}-welcome-party-${nameSuffix}-${index}`,
        currentRoomId: 14,
        clientEntID: 39100 + index,
        lastDoorId: -1,
        lastDoorTargetLevel: '',
        forcedDungeonCompletionScope: '',
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
        knownEntityIds: new Set<number>(),
        character,
        characters: [character],
        entities: new Map<number, any>(),
        dungeonRun: null,
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        },
        armPendingTransferGrace() {
            return undefined;
        }
    };
}

function createBoss(testCase: WelcomePartyCase, index: number, defeated: boolean): any {
    return {
        id: 49200 + index,
        name: testCase.bossName,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entRank: 'Boss',
        entState: defeated ? EntityState.DEAD : EntityState.ACTIVE,
        maxHp: 100,
        hp: defeated ? 0 : 100,
        dead: defeated,
        clientSpawned: true,
        roomId: 14
    };
}

function buildLevelCompletePayload(completionPercent: number = 100): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(completionPercent);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(1);
    bb.writeMethod9(0);
    return bb.toBuffer();
}

function buildPowerHitPayload(targetId: number, sourceId: number, damage: number, powerId: number = 77): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(targetId);
    bb.writeMethod4(sourceId);
    bb.writeMethod24(damage);
    bb.writeMethod4(powerId);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildEntityDestroyPayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildDoorPacket(doorId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(doorId);
    return bb.toBuffer();
}

function readMethod91(br: BitReader): number {
    const prefix = br.readMethod20(3);
    return br.readMethod20((prefix + 1) * 2);
}

function parseDoorStatePacket(payload: Buffer): { doorId: number; state: number; targetLevel: string } {
    const br = new BitReader(payload);
    return {
        doorId: br.readMethod4(),
        state: readMethod91(br),
        targetLevel: br.readMethod13()
    };
}

function setScopedBoss(client: FakeClient, boss: any): void {
    const levelScope = `${client.currentLevel}#${client.levelInstanceId}`;
    boss.ownerToken = client.token;
    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [boss.id, boss]
    ]));
}

async function testClientCompletionBeforeBossDeathIsIgnored(testCase: WelcomePartyCase, index: number): Promise<void> {
    const client = createClient(testCase, index, 'Early');
    setScopedBoss(client, createBoss(testCase, index, false));

    await MissionHandler.handleSetLevelComplete(client as never, buildLevelCompletePayload());

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        `${testCase.level} should not show completion before Imperial Commander Grahl is defeated`
    );
    assert.equal(
        Number(client.character.missions[String(testCase.missionId)]?.state ?? 0),
        1,
        `${testCase.level} should remain in progress before Imperial Commander Grahl is defeated`
    );
    assert.equal(
        String(client.pendingDungeonCompletionScope ?? ''),
        '',
        `${testCase.level} should not queue completion before the required boss death`
    );
}

async function testForcedBossCompletionWaitsForDefeatCutscene(testCase: WelcomePartyCase, index: number): Promise<void> {
    const client = createClient(testCase, index, 'Forced');
    setScopedBoss(client, createBoss(testCase, index, true));

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, createBoss(testCase, index, true));

    assert.equal(
        Boolean(client.pendingDungeonCompletionWaitForCutsceneEnd),
        true,
        `${testCase.level} boss death should wait for the defeat cutscene`
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        `${testCase.level} should not show completion before the defeat cutscene ends`
    );
    assert.equal(
        Number(client.character.missions[String(testCase.missionId)]?.state ?? 0),
        1,
        `${testCase.level} should stay in progress until the defeat cutscene ends`
    );

    MissionHandler.noteDungeonCutsceneEnd(client as never, 14);
    await Promise.resolve();

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        true,
        `${testCase.level} should show completion after the defeat cutscene ends`
    );
    assert.equal(
        Number(client.character.missions[String(testCase.missionId)]?.state ?? 0) >= 2,
        true,
        `${testCase.level} should complete the mission after the defeat cutscene ends`
    );
    assert.equal(
        Number(client.character.missions[String(testCase.followupMissionId)]?.state ?? 0) >= 2,
        true,
        `${testCase.level} should prime the Valhaven follow-up mission`
    );
}

async function testClientCompletionAfterBossDeathWaitsForDefeatCutscene(testCase: WelcomePartyCase, index: number): Promise<void> {
    const client = createClient(testCase, index, 'Client');
    setScopedBoss(client, createBoss(testCase, index, true));

    await MissionHandler.handleSetLevelComplete(client as never, buildLevelCompletePayload());

    assert.equal(
        Boolean(client.pendingDungeonCompletionWaitForCutsceneEnd),
        true,
        `${testCase.level} client level-complete should wait for the boss defeat cutscene`
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        `${testCase.level} client level-complete should not show completion before the defeat cutscene ends`
    );

    MissionHandler.noteDungeonCutsceneEnd(client as never, 14);
    await Promise.resolve();

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        true,
        `${testCase.level} client level-complete should show completion after the defeat cutscene ends`
    );
    assert.equal(
        Number(client.character.missions[String(testCase.missionId)]?.state ?? 0) >= 2,
        true,
        `${testCase.level} client level-complete should finish the mission after the defeat cutscene ends`
    );
    assert.equal(
        Number(client.character.missions[String(testCase.followupMissionId)]?.state ?? 0) >= 2,
        true,
        `${testCase.level} client level-complete should prime the Valhaven follow-up mission`
    );
}

async function testPowerHitDoesNotPrematurelyCompleteWelcomeParty(testCase: WelcomePartyCase, index: number): Promise<void> {
    const client = createClient(testCase, index, 'PowerHit');
    const boss = createBoss(testCase, index, false);
    boss.maxHp = 1;
    boss.hp = 1;
    setScopedBoss(client, boss);
    const levelScope = `${client.currentLevel}#${client.levelInstanceId}`;

    await CombatHandler.handlePowerHit(
        client as never,
        buildPowerHitPayload(boss.id, client.clientEntID, 5)
    );

    const scopedBoss = GlobalState.levelEntities.get(levelScope)?.get(boss.id);
    assert.equal(
        Boolean(scopedBoss?.dead),
        false,
        `${testCase.level} power-hit HP tracking should not mark Imperial Commander Grahl dead before the client defeat`
    );
    assert.equal(
        Number(scopedBoss?.hp ?? 0),
        1,
        `${testCase.level} power-hit HP tracking should leave Imperial Commander Grahl at 1 HP until the client defeat`
    );
    assert.equal(
        String(client.pendingDungeonCompletionScope ?? ''),
        '',
        `${testCase.level} power-hit HP tracking should not queue dungeon completion`
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        `${testCase.level} should not show completion from power-hit HP tracking`
    );

    await MissionHandler.handleSetLevelComplete(client as never, buildLevelCompletePayload());

    assert.equal(
        String(client.pendingDungeonCompletionScope ?? ''),
        '',
        `${testCase.level} client level-complete should still be ignored while Grahl has not sent a real defeat`
    );
    assert.equal(
        Number(client.character.missions[String(testCase.missionId)]?.state ?? 0),
        1,
        `${testCase.level} should remain in progress before Grahl's real defeat`
    );
    assert.equal(
        Number(client.character.missions[String(testCase.followupMissionId)]?.state ?? 0),
        0,
        `${testCase.level} should not prime the Valhaven follow-up before Grahl's real defeat`
    );

    await CombatHandler.handleEntityDestroy(client as never, buildEntityDestroyPayload(boss.id));

    assert.equal(
        Boolean(client.pendingDungeonCompletionWaitForCutsceneEnd),
        true,
        `${testCase.level} real boss defeat should wait for the defeat cutscene`
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        `${testCase.level} should not show completion before the defeat cutscene ends after real boss defeat`
    );

    MissionHandler.noteDungeonCutsceneEnd(client as never, 14);
    await Promise.resolve();

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        true,
        `${testCase.level} should show completion after the real defeat cutscene ends`
    );
    assert.equal(
        Number(client.character.missions[String(testCase.missionId)]?.state ?? 0) >= 2,
        true,
        `${testCase.level} should complete after Grahl's real defeat`
    );
}

function testShazariGatewayTargetsValhavenAfterWelcomeParty(testCase: WelcomePartyCase, index: number): void {
    const client = createClient(testCase, index, 'Gateway');
    client.currentLevel = testCase.level.endsWith('Hard') ? 'ShazariDesertHard' : 'ShazariDesert';
    client.character.CurrentLevel = { name: client.currentLevel, x: 0, y: 0 };

    LevelHandler.handleRequestDoorState(client as never, buildDoorPacket(2));
    let doorStatePacket = client.sentPackets.find((packet) => packet.id === 0x42);
    assert.ok(doorStatePacket);
    assert.equal(
        parseDoorStatePacket(doorStatePacket.payload).targetLevel,
        testCase.level,
        `${client.currentLevel} door 2 should still point at Welcome Party before the mission is complete`
    );

    client.character.missions[String(testCase.missionId)] = {
        state: 3,
        currCount: 1,
        claimed: 1,
        complete: 1
    };

    client.sentPackets.length = 0;
    LevelHandler.handleRequestDoorState(client as never, buildDoorPacket(2));
    doorStatePacket = client.sentPackets.find((packet) => packet.id === 0x42);
    assert.ok(doorStatePacket);
    assert.equal(
        parseDoorStatePacket(doorStatePacket.payload).targetLevel,
        testCase.gatewayLevel,
        `${client.currentLevel} door 2 should point at Valhaven after Welcome Party is complete`
    );

    client.sentPackets.length = 0;
    LevelHandler.handleOpenDoor(client as never, buildDoorPacket(2));
    assert.equal(
        client.lastDoorTargetLevel,
        testCase.gatewayLevel,
        `${client.currentLevel} door 2 should transfer to Valhaven after Welcome Party is complete`
    );
}

async function main(): Promise<void> {
    ensureDataLoaded();

    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const levelEntities = new Map(GlobalState.levelEntities);
    const levelQuestProgress = new Map(GlobalState.levelQuestProgress);

    try {
        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();

        for (let index = 0; index < WELCOME_PARTY_CASES.length; index += 1) {
            const testCase = WELCOME_PARTY_CASES[index];
            await testClientCompletionBeforeBossDeathIsIgnored(testCase, index);
            await testPowerHitDoesNotPrematurelyCompleteWelcomeParty(testCase, index + 5);
            await testForcedBossCompletionWaitsForDefeatCutscene(testCase, index + 10);
            await testClientCompletionAfterBossDeathWaitsForDefeatCutscene(testCase, index + 20);
            testShazariGatewayTargetsValhavenAfterWelcomeParty(testCase, index + 30);
        }

        console.log('welcome_party_completion_regression: ok');
    } finally {
        for (const session of GlobalState.sessionsByToken.values()) {
            if (session.pendingDungeonCompletionTimer) {
                clearTimeout(session.pendingDungeonCompletionTimer);
            }
        }
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.levelEntities = levelEntities;
        GlobalState.levelQuestProgress = levelQuestProgress;
    }
}

void main().catch((error) => {
    console.error('welcome_party_completion_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
