import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { MissionID } from '../data/runtime';
import { MissionLoader } from '../data/MissionLoader';
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
    if (!LevelConfig.has('SD_Mission3')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.BloodAndSand)) {
        MissionLoader.load(dataDir);
    }
    if (!GameData.getEntType('OutlanderWyrm')) {
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

function createBloodAndSandClient(): FakeClient {
    const sentPackets: SentPacket[] = [];
    return {
        token: 13105,
        currentLevel: 'SD_Mission3',
        levelInstanceId: 'blood-and-sand-run',
        currentRoomId: 8,
        playerSpawned: true,
        forcedDungeonCompletionScope: '',
        userId: null,
        character: {
            name: 'Fleerpuh',
            level: 24,
            xp: 0,
            CurrentLevel: { name: 'SD_Mission3', x: 0, y: 0 },
            PreviousLevel: { name: 'ShazariDesert', x: 0, y: 0 },
            missions: {
                [String(MissionID.BloodAndSand)]: {
                    state: 1,
                    currCount: 0
                }
            },
            questTrackerState: 90
        },
        entities: new Map(),
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

async function testBloodAndSandIgnoresIntroCompletionReport(): Promise<void> {
    const client = createBloodAndSandClient();
    GlobalState.levelEntities.set('SD_Mission3#blood-and-sand-run', new Map());

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket());

    assert.equal(
        Number(client.character.missions[String(MissionID.BloodAndSand)]?.state ?? 0),
        1,
        'Blood and Sand should remain in progress when the boss intro transition reports all kills cleared'
    );
    assert.equal(client.character.questTrackerState, 90);
    assert.equal(client.character.lastCompletedDungeonLevel, undefined);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x87), false);
}

async function testBloodAndSandIgnoresChampionDeath(): Promise<void> {
    const client = createBloodAndSandClient();
    GlobalState.levelEntities.set(
        'SD_Mission3#blood-and-sand-run',
        new Map([
            [9002, {
                id: 9002,
                name: 'OutlanderBoss',
                isPlayer: false,
                team: EntityTeam.ENEMY,
                entState: EntityState.DEAD,
                dead: true,
                hp: 0
            }]
        ])
    );

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, {
        id: 9002,
        name: 'OutlanderBoss',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entState: EntityState.DEAD,
        dead: true,
        hp: 0
    });
    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket());

    assert.equal(
        Number(client.character.missions[String(MissionID.BloodAndSand)]?.state ?? 0),
        1,
        'Blood and Sand should not complete from the Champion of the Sun death'
    );
    assert.equal(client.forcedDungeonCompletionScope, '');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x87), false);
}

async function testBloodAndSandStaysOpenWhilePitLordIsAlive(): Promise<void> {
    const client = createBloodAndSandClient();
    GlobalState.levelEntities.set(
        'SD_Mission3#blood-and-sand-run',
        new Map([
            [9002, {
                id: 9002,
                name: 'OutlanderBoss',
                isPlayer: false,
                team: EntityTeam.ENEMY,
                entState: EntityState.DEAD,
                dead: true,
                hp: 0
            }],
            [9003, {
                id: 9003,
                name: 'OutlanderWyrm',
                isPlayer: false,
                team: EntityTeam.ENEMY,
                entState: EntityState.ACTIVE,
                dead: false,
                hp: 500
            }]
        ])
    );

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket());

    assert.equal(
        Number(client.character.missions[String(MissionID.BloodAndSand)]?.state ?? 0),
        1,
        'Blood and Sand should remain in progress while the Pit Lord is still alive'
    );
    assert.equal(client.character.questTrackerState, 90);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x87), false);
}

async function testBloodAndSandCompletesAfterPitLordDeath(): Promise<void> {
    const client = createBloodAndSandClient();
    GlobalState.levelEntities.set(
        'SD_Mission3#blood-and-sand-run',
        new Map([
            [9003, {
                id: 9003,
                name: 'OutlanderWyrm',
                isPlayer: false,
                team: EntityTeam.ENEMY,
                entState: EntityState.DEAD,
                dead: true,
                hp: 0
            }]
        ])
    );

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket());

    assert.equal(
        Number(client.character.missions[String(MissionID.BloodAndSand)]?.state ?? 0),
        2,
        'Blood and Sand should complete once the required Pit Lord actor is defeated'
    );
    assert.equal(client.character.questTrackerState, 100);
    assert.equal(client.character.lastCompletedDungeonLevel, 'SD_Mission3');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x87), true);
}

async function main(): Promise<void> {
    ensureDataLoaded();
    await testBloodAndSandIgnoresIntroCompletionReport();
    await testBloodAndSandIgnoresChampionDeath();
    await testBloodAndSandStaysOpenWhilePitLordIsAlive();
    await testBloodAndSandCompletesAfterPitLordDeath();
    GlobalState.levelEntities.delete('SD_Mission3#blood-and-sand-run');
    console.log('blood_and_sand_completion_regression: ok');
}

void main().catch((error) => {
    console.error('blood_and_sand_completion_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
