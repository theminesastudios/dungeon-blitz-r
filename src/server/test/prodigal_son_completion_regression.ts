import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
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

function createClient(levelName: string, missionId: number, flowId: string): FakeClient {
    const sentPackets: SentPacket[] = [];
    return {
        token: levelName.endsWith('Hard') ? 48803 : 48802,
        currentLevel: levelName,
        levelInstanceId: `prodigal-${flowId}`,
        currentRoomId: 13,
        playerSpawned: true,
        forcedDungeonCompletionScope: '',
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

function setLevelEntities(client: FakeClient, entities: Array<[number, unknown]>): void {
    const entityMap = new Map<number, unknown>(entities);
    client.entities = entityMap;
    GlobalState.levelEntities.set(`${client.currentLevel}#${client.levelInstanceId}`, entityMap);
}

function createPrinceAlias(id: number, defeated: boolean): Record<string, unknown> {
    return {
        id,
        name: 'PrinceFriedrichHocke',
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
        [9301, createPrinceAlias(9301, false)]
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
            flowId: 'normal'
        },
        {
            levelName: 'JC_Mission3Hard',
            missionId: MissionID.TheProdigalSonHard,
            flowId: 'hard'
        }
    ];

    for (const testCase of cases) {
        const client = createClient(testCase.levelName, testCase.missionId, testCase.flowId);
        const levelScope = `${client.currentLevel}#${client.levelInstanceId}`;
        setLevelEntities(client, [
            [9302, createPrinceAlias(9302, true)]
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

async function main(): Promise<void> {
    ensureDataLoaded();
    await testProdigalSonIgnoresClientCompletionBeforeDefectorDefeat();
    await testProdigalSonCompletesFromPrinceAlias();
    GlobalState.levelEntities.delete('JC_Mission3#prodigal-early');
    GlobalState.levelEntities.delete('JC_Mission3#prodigal-normal');
    GlobalState.levelEntities.delete('JC_Mission3Hard#prodigal-hard');
    console.log('prodigal_son_completion_regression: ok');
}

void main().catch((error) => {
    console.error('prodigal_son_completion_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
