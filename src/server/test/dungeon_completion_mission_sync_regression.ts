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
        lastCompletedDungeonLevel?: string;
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

function createForgottenForgeClient(): FakeClient {
    const client = createFakeClient();
    client.currentLevel = 'OMM_Mission6';
    client.levelInstanceId = 'forgotten-forge-flow';
    client.forcedDungeonCompletionScope = 'OMM_Mission6#forgotten-forge-flow';
    client.character.name = 'ForgottenForgeTester';
    client.character.level = 17;
    client.character.CurrentLevel = { name: 'OMM_Mission6', x: 0, y: 0 };
    client.character.PreviousLevel = { name: 'OldMineMountain', x: 189, y: 1335 };
    client.character.missions = {
        [String(MissionID.DeliverToSwamp)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        [String(MissionID.AbandonedArmory)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        }
    };
    client.character.questTrackerState = 100;
    client.sentPackets.length = 0;
    return client;
}

function createLordTillyRestClient(): FakeClient {
    const client = createFakeClient();
    client.currentLevel = 'CH_Mission4';
    client.levelInstanceId = 'lord-tilly-rest-flow';
    client.forcedDungeonCompletionScope = 'CH_Mission4#lord-tilly-rest-flow';
    client.character.name = 'LordTillyRestTester';
    client.character.level = 12;
    client.character.CurrentLevel = { name: 'CH_Mission4', x: 0, y: 0 };
    client.character.PreviousLevel = { name: 'CemeteryHill', x: 7469, y: 385 };
    client.character.missions = {
        [String(MissionID.JackalTreasure)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        [String(MissionID.MissingPappy)]: {
            state: 1,
            currCount: 0
        }
    };
    client.character.questTrackerState = 100;
    client.sentPackets.length = 0;
    return client;
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

function decodeMissionCompleteUiPacket(payload: Buffer): { missionId: number; stars: number; score: number } {
    const br = new BitReader(payload);
    return {
        missionId: br.readMethod4(),
        stars: br.readMethod15() ? br.readMethod6(4) : 0,
        score: br.readMethod4()
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
        client.sentPackets.some((packet) => packet.id === 0x84),
        false,
        'dungeon completion should not show the reward UI for missions that still require an NPC turn-in'
    );
    assert.equal(
        client.character.questTrackerState,
        100,
        'dungeon completion should move the live quest tracker state to 100 immediately'
    );
    assert.equal(
        client.character.lastCompletedDungeonLevel,
        'DreamDragonDungeon',
        'dungeon completion should remember which exact dungeon supplied the global 100% tracker state'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0xB7),
        true,
        'even low incoming progress should be overridden so the client shows the dungeon as finished immediately'
    );
}

async function testLordTillyRestWaitsForNpcRewardClaim(): Promise<void> {
    const client = createLordTillyRestClient();

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket(100, 0, 1));

    assert.equal(
        Number(client.character.missions[String(MissionID.MissingPappy)]?.state ?? 0),
        2,
        "Lord Tilly's Rest should become ready to turn in after dungeon completion"
    );
    assert.equal(
        client.character.missions[String(MissionID.MissingPappy)]?.claimed,
        undefined,
        "Lord Tilly's Rest should not be marked claimed before talking to the return NPC"
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x86),
        true,
        "Lord Tilly's Rest should still emit the mission-complete notification"
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x84),
        false,
        "Lord Tilly's Rest should not open the reward UI until the return NPC turn-in"
    );
}

async function testDungeonCompletionDoesNotCreateUnstartedMission(): Promise<void> {
    const client = createForgottenForgeClient();

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket(100, 0, 1));

    assert.equal(
        Number(client.character.missions[String(MissionID.ForgottenForge)]?.state ?? 0),
        0,
        'dungeon completion should not create a Forgotten Forge mission that the character never accepted'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.ForgottenForge)]?.currCount ?? 0),
        0,
        'unstarted dungeon missions should not be shown as 1/1 after completion'
    );
    assert.equal(
        client.character.lastCompletedDungeonLevel,
        undefined,
        'unstarted dungeon completion should not overwrite the last completed mission turn-in target'
    );

    const missionAdded = client.sentPackets.find((packet) => packet.id === 0x85);
    assert.equal(
        missionAdded,
        undefined,
        'unstarted dungeon completion should not send a surprise mission snapshot'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x84),
        false,
        'unstarted dungeon completion should not emit a mission reward UI'
    );
}

async function testAcceptedForgottenForgeCompletionWaitsForTurnIn(): Promise<void> {
    const client = createForgottenForgeClient();
    client.character.missions[String(MissionID.ForgottenForge)] = {
        state: 1,
        currCount: 0
    };

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket(100, 0, 1));

    assert.equal(
        Number(client.character.missions[String(MissionID.ForgottenForge)]?.state ?? 0),
        2,
        'accepted Forgotten Forge should become ready to turn in after completion'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.ForgottenForge)]?.currCount ?? 0),
        1,
        'accepted Forgotten Forge should persist completed objective count'
    );
    assert.equal(
        client.character.lastCompletedDungeonLevel,
        'OMM_Mission6',
        'accepted Forgotten Forge should remember the completed dungeon level for turn-in repair'
    );

    const missionAdded = client.sentPackets.find((packet) => packet.id === 0x85);
    assert.ok(missionAdded, 'accepted dungeon completion should sync the ready-to-turn-in mission snapshot');
    assert.deepEqual(decodeMissionAddedPacket(missionAdded!.payload), {
        missionId: MissionID.ForgottenForge,
        active: 0
    });
}

async function main(): Promise<void> {
    ensureDataLoaded();
    await testDungeonCompletionSyncsReadyMissionStateImmediately();
    await testLordTillyRestWaitsForNpcRewardClaim();
    await testDungeonCompletionDoesNotCreateUnstartedMission();
    await testAcceptedForgottenForgeCompletionWaitsForTurnIn();
    console.log('dungeon_completion_mission_sync_regression: ok');
}

void main().catch((error) => {
    console.error('dungeon_completion_mission_sync_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
