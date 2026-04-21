import { strict as assert } from 'assert';
import * as path from 'path';
import { LevelConfig } from '../core/LevelConfig';
import { MissionLoader } from '../data/MissionLoader';
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
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    forcedDungeonCompletionScope: string;
    userId: number | null;
    character: {
        name: string;
        level: number;
        xp?: number;
        gold?: number;
        CurrentLevel: { name: string; x: number; y: number };
        PreviousLevel: { name: string; x: number; y: number };
        missions: Record<string, Record<string, number>>;
        questTrackerState: number;
    };
    entities: Map<number, unknown>;
    sentPackets: SentPacket[];
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('DreamDragonDungeon')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.SlayTheDragon)) {
        MissionLoader.load(dataDir);
    }
}

function createFakeClient(): FakeClient {
    const sentPackets: SentPacket[] = [];

    return {
        token: 7777,
        currentLevel: 'DreamDragonDungeon',
        levelInstanceId: 'dragon-flow',
        currentRoomId: 1,
        playerSpawned: true,
        forcedDungeonCompletionScope: 'DreamDragonDungeon#dragon-flow',
        userId: null,
        character: {
            name: 'DragonFlowTester',
            level: 2,
            xp: 0,
            gold: 0,
            CurrentLevel: { name: 'DreamDragonDungeon', x: 0, y: 0 },
            PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 },
            missions: {
                [String(MissionID.KillNephit)]: {
                    state: 3,
                    currCount: 1,
                    claimed: 1,
                    complete: 1
                },
                [String(MissionID.SlayTheDragon)]: {
                    state: 1,
                    currCount: 0
                }
            },
            questTrackerState: 100
        },
        entities: new Map(),
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createLevelCompletePacket(progress: number = 100, remainingKills: number = 0, requiredKills: number = 1): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(progress);
    bb.writeMethod9(209122);
    bb.writeMethod9(155);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(remainingKills);
    bb.writeMethod9(requiredKills);
    bb.writeMethod9(10);
    return bb.toBuffer();
}

function decodeMissionAddedPacket(payload: Buffer): { missionId: number; active: number } {
    const br = new BitReader(payload);
    return {
        missionId: br.readMethod4(),
        active: br.readMethod6(1)
    };
}

async function testDungeonCompletionSyncsReadyMissionStateImmediately(): Promise<void> {
    const client = createFakeClient();
    client.character.questTrackerState = 64;

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket(5, 19, 20));

    assert.equal(
        Number(client.character.missions[String(MissionID.SlayTheDragon)]?.state ?? 0),
        2,
        "The Dragon's Dream should become ready to turn in after dungeon completion"
    );

    const missionAdded = client.sentPackets.find((packet) => packet.id === 0x85);
    assert.ok(
        missionAdded,
        'dungeon completion should push an immediate mission snapshot so the client quest flow updates without relogging'
    );
    assert.deepEqual(
        decodeMissionAddedPacket(missionAdded!.payload),
        {
            missionId: MissionID.SlayTheDragon,
            active: 0
        },
        'ready-to-turn-in dungeon missions should be sent back as inactive snapshots immediately after completion'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x86),
        true,
        'dungeon completion should still emit the mission-complete packet'
    );
    assert.equal(
        client.character.questTrackerState,
        100,
        'dungeon completion should move the live quest tracker state to 100 immediately'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0xB7),
        true,
        'even low incoming progress should be overridden so the client shows the dungeon as finished immediately'
    );
}

async function main(): Promise<void> {
    ensureDataLoaded();
    await testDungeonCompletionSyncsReadyMissionStateImmediately();
    console.log('dungeon_completion_mission_sync_regression: ok');
}

void main().catch((error) => {
    console.error('dungeon_completion_mission_sync_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
