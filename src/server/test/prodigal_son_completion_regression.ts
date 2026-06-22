import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { CombatHandler } from '../handlers/CombatHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    forcedDungeonCompletionScope: string;
    activeDungeonCutsceneScope?: string;
    activeDungeonCutsceneRoomId?: number;
    pendingDungeonCompletionScope?: string;
    pendingDungeonCompletionWaitForCutsceneEnd?: boolean;
    pendingDungeonCompletionPayload?: Buffer | null;
    pendingDungeonCompletionTimer?: NodeJS.Timeout | null;
    pendingDungeonCompletionFlushActive?: boolean;
    userId: number | null;
    character: {
        name: string;
        level: number;
        xp: number;
        CurrentLevel: { name: string; x: number; y: number };
        PreviousLevel: { name: string; x: number; y: number };
        missions: Record<string, Record<string, number>>;
        questTrackerState: number;
        lastCompletedDungeonLevel?: string;
    };
    entities: Map<number, unknown>;
    sentPackets: SentPacket[];
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('JC_Mission3')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.TheProdigalSon)) {
        MissionLoader.load(dataDir);
    }
    if (!GameData.getEntType('DefectorMage')) {
        GameData.load(dataDir);
    }
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

function createCharRegenPacket(entityId: number, amount: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(entityId);
    bb.writeMethod24(amount);
    return bb.toBuffer();
}

function createClient(levelName: string, missionId: number, flowId: string): FakeClient {
    const sentPackets: SentPacket[] = [];
    return {
        token: levelName.endsWith('Hard') ? 48803 : 48802,
        currentLevel: levelName,
        levelInstanceId: `prodigal-${flowId}`,
        currentRoomId: 13,
        playerSpawned: true,
        forcedDungeonCompletionScope: '',
        pendingDungeonCompletionTimer: null,
        userId: null,
        character: {
            name: `ProdigalTester-${flowId}`,
            level: 28,
            xp: 0,
            CurrentLevel: { name: levelName, x: 0, y: 0 },
            PreviousLevel: { name: levelName.endsWith('Hard') ? 'JadeCityHard' : 'JadeCity', x: 0, y: 0 },
            missions: {
                [String(missionId)]: {
                    state: 1,
                    currCount: 0
                }
            },
            questTrackerState: 72
        },
        entities: new Map(),
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function setLevelEntities(client: FakeClient, entities: Array<[number, unknown]>): void {
    const entityMap = new Map<number, unknown>(entities);
    client.entities = entityMap;
    GlobalState.levelEntities.set(`${client.currentLevel}#${client.levelInstanceId}`, entityMap);
}

function createBossReport(id: number, name: string, defeated: boolean): Record<string, unknown> {
    return {
        id,
        name,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entRank: 'Boss',
        entState: defeated ? EntityState.DEAD : EntityState.ACTIVE,
        dead: defeated,
        hp: defeated ? 0 : 500,
        roomId: 13
    };
}

async function testProdigalSonIgnoresClientCompletionBeforeDefectorDefeat(): Promise<void> {
    const client = createClient('JC_Mission3', MissionID.TheProdigalSon, 'early');
    setLevelEntities(client, [
        [9301, createBossReport(9301, 'PrinceFriedrichHocke', false)]
    ]);

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket());

    assert.equal(
        Number(client.character.missions[String(MissionID.TheProdigalSon)]?.state ?? 0),
        1,
        'The Prodigal Son should stay in progress before the defector/prince boss is defeated'
    );
    assert.equal(client.character.questTrackerState, 72);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x87), false);
}

async function testProdigalSonCompletesFromPrinceAlias(): Promise<void> {
    const cases = [
        {
            levelName: 'JC_Mission3',
            missionId: MissionID.TheProdigalSon,
            flowId: 'normal',
            bossName: 'PrinceFriedrichHocke'
        },
        {
            levelName: 'JC_Mission3Hard',
            missionId: MissionID.TheProdigalSonHard,
            flowId: 'hard',
            bossName: 'PrinceFriedrichHocke'
        },
        {
            levelName: 'JC_Mission3Hard',
            missionId: MissionID.TheProdigalSonHard,
            flowId: 'hard-spaced',
            bossName: 'Prince Friedrich Hocke'
        },
        {
            levelName: 'JC_Mission3Hard',
            missionId: MissionID.TheProdigalSonHard,
            flowId: 'hard-base-defector',
            bossName: 'DefectorMage'
        }
    ];

    for (const testCase of cases) {
        const client = createClient(testCase.levelName, testCase.missionId, testCase.flowId);
        const levelScope = `${client.currentLevel}#${client.levelInstanceId}`;
        setLevelEntities(client, [
            [9302, createBossReport(9302, testCase.bossName, true)]
        ]);
        client.forcedDungeonCompletionScope = levelScope;
        client.pendingDungeonCompletionFlushActive = true;

        await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket());

        assert.equal(
            Number(client.character.missions[String(testCase.missionId)]?.state ?? 0),
            2,
            `${testCase.levelName} should complete from the prince display-name alias`
        );
        assert.equal(client.character.questTrackerState, 100);
        assert.equal(client.character.lastCompletedDungeonLevel, testCase.levelName);
        assert.equal(client.sentPackets.some((packet) => packet.id === 0x87), true);
    }
}

async function testDreadProdigalSonCompletionWaitsForCinematicEnd(): Promise<void> {
    const client = createClient('JC_Mission3Hard', MissionID.TheProdigalSonHard, 'hard-cinematic');
    const levelScope = `${client.currentLevel}#${client.levelInstanceId}`;
    const boss = createBossReport(9303, 'DefectorMage', true);
    setLevelEntities(client, [
        [9303, boss]
    ]);

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);
    await sleep(0);

    assert.equal(
        String(client.pendingDungeonCompletionScope ?? ''),
        levelScope,
        'Dread Prodigal Son boss death should queue completion for the active dungeon run'
    );
    assert.equal(
        Boolean(client.pendingDungeonCompletionWaitForCutsceneEnd),
        true,
        'Dread Prodigal Son boss death should wait for the post-death cinematic'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'Dread Prodigal Son should not show completion before the cinematic ends'
    );

    MissionHandler.noteDungeonCutsceneEnd(client as never, 13);
    await sleep(0);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        true,
        'Dread Prodigal Son should show dungeon completion when the cinematic ends'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.TheProdigalSonHard)]?.state ?? 0),
        2,
        'Dread Prodigal Son should complete the mission after the cinematic-end release'
    );
}

async function testDreadProdigalSonClientCompletionReleasesPendingCinematic(): Promise<void> {
    const client = createClient('JC_Mission3Hard', MissionID.TheProdigalSonHard, 'hard-client-complete');
    const levelScope = `${client.currentLevel}#${client.levelInstanceId}`;
    const boss = createBossReport(9304, 'DefectorMage', true);
    setLevelEntities(client, [
        [9304, boss]
    ]);

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);
    await sleep(0);

    assert.equal(
        String(client.pendingDungeonCompletionScope ?? ''),
        levelScope,
        'Dread Prodigal Son boss death should hold pending completion while the cinematic plays'
    );
    assert.equal(
        Boolean(client.pendingDungeonCompletionWaitForCutsceneEnd),
        true,
        'Dread Prodigal Son should wait for a cinematic release before showing stats'
    );

    client.activeDungeonCutsceneScope = levelScope;
    client.activeDungeonCutsceneRoomId = 13;

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket());
    await sleep(0);

    assert.equal(
        Boolean(client.pendingDungeonCompletionWaitForCutsceneEnd),
        false,
        'Dread Prodigal Son client completion should release the pending cinematic wait'
    );
    assert.equal(
        String(client.activeDungeonCutsceneScope ?? ''),
        '',
        'Dread Prodigal Son client completion should clear a stale active cinematic gate'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        true,
        'Dread Prodigal Son should show dungeon completion when the client reports completion after the cinematic'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.TheProdigalSonHard)]?.state ?? 0),
        2,
        'Dread Prodigal Son should complete the hard mission after the client-reported cinematic end'
    );
}

async function testDreadProdigalSonMarkerHpReportTriggersCompletion(): Promise<void> {
    const client = createClient('JC_Mission3', MissionID.TheProdigalSon, 'marker-hp-report');
    const levelScope = `${client.currentLevel}#${client.levelInstanceId}`;
    const marker = {
        id: 9305,
        name: 'DefectorMageMarker',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entRank: 'Marker',
        entState: EntityState.ACTIVE,
        dead: false,
        hp: 403680,
        maxHp: 403680,
        roomId: 13
    };
    const duplicateDefector = {
        id: 9306,
        name: 'DefectorMage',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entRank: 'Boss',
        entState: EntityState.ACTIVE,
        dead: false,
        hp: 403680,
        maxHp: 403680,
        roomId: 0
    };
    setLevelEntities(client, [
        [9305, marker],
        [9306, duplicateDefector]
    ]);

    CombatHandler.handleCharRegen(client as never, createCharRegenPacket(9305, -403680));
    await sleep(0);

    assert.equal(
        String(client.pendingDungeonCompletionScope ?? ''),
        levelScope,
        'DefectorMageMarker HP report kill should queue Prodigal Son dungeon completion'
    );
    assert.equal(
        Boolean(client.pendingDungeonCompletionWaitForCutsceneEnd),
        true,
        'DefectorMageMarker HP report kill should wait for the post-death cinematic'
    );

    client.activeDungeonCutsceneScope = levelScope;
    client.activeDungeonCutsceneRoomId = 13;

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket());
    await sleep(0);

    assert.equal(
        String(client.activeDungeonCutsceneScope ?? ''),
        '',
        'DefectorMageMarker client completion should clear a stale active cinematic gate'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        true,
        'Prodigal Son should show dungeon completion after the marker HP report kill and client completion'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.TheProdigalSon)]?.state ?? 0),
        2,
        'Prodigal Son should complete from the DefectorMageMarker HP report kill'
    );
}

async function testGenericBossHpReportDoesNotTriggerDungeonCompletion(): Promise<void> {
    const client = createClient('GhostBossDungeon', MissionID.KillNephit, 'generic-hp-report');
    const boss = {
        id: 9310,
        name: 'NephitLargeEye',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entRank: 'Boss',
        entState: EntityState.ACTIVE,
        dead: false,
        hp: 500,
        maxHp: 500,
        roomId: 4
    };
    setLevelEntities(client, [
        [9310, boss]
    ]);

    CombatHandler.handleCharRegen(client as never, createCharRegenPacket(9310, -500));
    await sleep(0);

    assert.equal(
        String(client.pendingDungeonCompletionScope ?? ''),
        '',
        'generic boss HP reports should not queue dungeon completion without the normal kill/destroy path'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'generic boss HP reports should not send dungeon completion'
    );
}

async function main(): Promise<void> {
    ensureDataLoaded();
    await testProdigalSonIgnoresClientCompletionBeforeDefectorDefeat();
    await testProdigalSonCompletesFromPrinceAlias();
    await testDreadProdigalSonCompletionWaitsForCinematicEnd();
    await testDreadProdigalSonClientCompletionReleasesPendingCinematic();
    await testDreadProdigalSonMarkerHpReportTriggersCompletion();
    await testGenericBossHpReportDoesNotTriggerDungeonCompletion();
    GlobalState.levelEntities.delete('JC_Mission3#prodigal-early');
    GlobalState.levelEntities.delete('JC_Mission3#prodigal-normal');
    GlobalState.levelEntities.delete('JC_Mission3#prodigal-marker-hp-report');
    GlobalState.levelEntities.delete('JC_Mission3Hard#prodigal-hard');
    GlobalState.levelEntities.delete('JC_Mission3Hard#prodigal-hard-spaced');
    GlobalState.levelEntities.delete('JC_Mission3Hard#prodigal-hard-base-defector');
    GlobalState.levelEntities.delete('JC_Mission3Hard#prodigal-hard-cinematic');
    GlobalState.levelEntities.delete('JC_Mission3Hard#prodigal-hard-client-complete');
    GlobalState.levelEntities.delete('GhostBossDungeon#prodigal-generic-hp-report');
    console.log('prodigal_son_completion_regression: ok');
}

void main().catch((error) => {
    console.error('prodigal_son_completion_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
