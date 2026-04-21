import { strict as assert } from 'assert';
import * as path from 'path';
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
    token?: number;
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId?: number;
    playerSpawned?: boolean;
    clientEntID?: number;
    userId: number | null;
    character: {
        name: string;
        CurrentLevel: { name: string; x: number; y: number };
        PreviousLevel: { name: string; x: number; y: number };
        missions: Record<string, { state: number; currCount?: number }>;
        questTrackerState: number;
    };
    entities?: Map<number, unknown>;
    dungeonRun?: unknown;
    forcedDungeonCompletionScope?: string;
    sentPackets: SentPacket[];
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
    send: (id: number, payload: Buffer) => void;
};

function ensureDataLoaded(): void {
    if (!LevelConfig.has('TutorialBoat')) {
        LevelConfig.load(path.resolve(__dirname, '../data'));
    }
    if (!MissionLoader.getMissionDef(MissionID.DefendTheShip)) {
        MissionLoader.load(path.resolve(__dirname, '../data'));
    }
}

function createFakeClient(): FakeClient {
    const sentPackets: SentPacket[] = [];

    return {
        token: 9401,
        currentLevel: 'TutorialBoat',
        levelInstanceId: 'lost-at-sea-regression',
        currentRoomId: 1,
        playerSpawned: true,
        clientEntID: 9401,
        userId: null,
        character: {
            name: 'LostAtSeaRunner',
            CurrentLevel: { name: 'TutorialBoat', x: 0, y: 0 },
            PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 },
            missions: {
                [String(MissionID.DefendTheShip)]: {
                    state: 1,
                    currCount: 0
                }
            },
            questTrackerState: 0
        },
        entities: new Map(),
        dungeonRun: null,
        forcedDungeonCompletionScope: '',
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        },
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        }
    };
}

function createLevelCompletePacket(): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(100);
    bb.writeMethod9(209);
    bb.writeMethod9(155);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(1);
    bb.writeMethod9(5);
    return bb.toBuffer();
}

async function testTutorialBoatCompletionPreservesCurrentLevelUntilExitTransfer(): Promise<void> {
    const client = createFakeClient();

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket());

    assert.equal(client.sentPackets.some((packet) => packet.id === 0x87), true);
    assert.equal(Number(client.character.missions[String(MissionID.DefendTheShip)]?.state ?? 0), 2);
    assert.deepEqual(
        client.character.CurrentLevel,
        { name: 'TutorialBoat', x: 0, y: 0 },
        'Lost at Sea should not rewrite the active map to NewbieRoad during completion handling'
    );
    assert.deepEqual(
        client.character.PreviousLevel,
        { name: 'NewbieRoad', x: 1421, y: 826 },
        'Lost at Sea should keep the safe return point for the later transfer'
    );
}

async function testTutorialBoatBossKillDoesNotForceEarlyCompletion(): Promise<void> {
    const client = createFakeClient();
    const boss = {
        id: 6402,
        name: 'IntroKraken',
        entRank: 'Boss',
        entState: 6,
        hp: 0,
        dead: true
    };

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'Lost at Sea boss defeat should not use the generic forced-completion shortcut'
    );
    assert.equal(
        String((client as any).pendingDungeonCompletionScope ?? ''),
        '',
        'Lost at Sea should wait for the normal delayed completion packet instead of scheduling boss-kill completion'
    );
}

async function main(): Promise<void> {
    ensureDataLoaded();
    await testTutorialBoatBossKillDoesNotForceEarlyCompletion();
    await testTutorialBoatCompletionPreservesCurrentLevelUntilExitTransfer();
    console.log('tutorial_boat_completion_regression: ok');
}

void main().catch((error) => {
    console.error('tutorial_boat_completion_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
