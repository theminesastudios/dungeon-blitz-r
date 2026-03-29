import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
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
    character: {
        name: string;
        level: number;
        CurrentLevel: { name: string; x: number; y: number };
        PreviousLevel: { name: string; x: number; y: number };
        missions: Record<string, { state: number; currCount?: number }>;
        questTrackerState: number;
    };
    characters: any[];
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureLevelConfigLoaded(): void {
    if (!LevelConfig.has('GoblinRiverDungeon')) {
        LevelConfig.load(path.resolve(__dirname, '../data'));
    }
}

function createClient(token: number, name: string): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = {
        name,
        level: 10,
        CurrentLevel: { name: 'GoblinRiverDungeon', x: 0, y: 0 },
        PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 },
        missions: {},
        questTrackerState: 0
    };

    return {
        token,
        userId: token,
        playerSpawned: true,
        currentLevel: 'GoblinRiverDungeon',
        levelInstanceId: 'goblin-shared',
        currentRoomId: 1,
        character,
        characters: [character],
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createQuestProgressPacket(progress: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(progress);
    return bb.toBuffer();
}

function createLevelCompletePacket(progress: number = 100, remainingKills: number = 0, requiredKills: number = 1): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(progress);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(remainingKills);
    bb.writeMethod9(requiredKills);
    bb.writeMethod9(3);
    return bb.toBuffer();
}

function parseQuestProgress(payload: Buffer): number {
    const br = new BitReader(payload);
    return br.readMethod4();
}

async function testGoblinRiverQuestProgressFollowsHostileOwnerAuthority(): Promise<void> {
    const authority = createClient(801, 'Leader');
    const joiner = createClient(802, 'Member');

    GlobalState.sessionsByToken.set(authority.token, authority as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    GlobalState.levelEntities.set('GoblinRiverDungeon#goblin-shared', new Map<number, any>([
        [
            5001,
            {
                id: 5001,
                name: 'GoblinClub',
                isPlayer: false,
                team: 2,
                entState: 0,
                clientSpawned: true,
                ownerToken: authority.token,
                roomId: 1
            }
        ]
    ]));

    await LevelHandler.handleQuestProgressUpdate(joiner as never, createQuestProgressPacket(100));

    assert.equal(joiner.character.questTrackerState, 0, 'non-authority joiner progress should be ignored until the hostile owner updates');
    assert.equal(authority.character.questTrackerState, 0, 'authority should not inherit the joiner’s false completion');
    assert.deepEqual(
        joiner.sentPackets.filter((packet) => packet.id === 0xB7).map((packet) => parseQuestProgress(packet.payload)),
        [0],
        'joiner should be corrected back to the shared dungeon progress'
    );

    await LevelHandler.handleQuestProgressUpdate(authority as never, createQuestProgressPacket(42));

    assert.equal(authority.character.questTrackerState, 42);
    assert.equal(joiner.character.questTrackerState, 42);
    assert.deepEqual(
        authority.sentPackets.filter((packet) => packet.id === 0xB7).map((packet) => parseQuestProgress(packet.payload)).slice(-1),
        [42],
        'authority update should set the canonical shared progress'
    );
    assert.deepEqual(
        joiner.sentPackets.filter((packet) => packet.id === 0xB7).map((packet) => parseQuestProgress(packet.payload)).slice(-1),
        [42],
        'joiner should receive the canonical shared progress update'
    );
}

async function testGoblinRiverLevelCompleteWaitsForSharedProgressCompletion(): Promise<void> {
    const authority = createClient(811, 'Leader');
    const joiner = createClient(812, 'Member');

    GlobalState.sessionsByToken.set(authority.token, authority as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    GlobalState.levelEntities.set('GoblinRiverDungeon#goblin-shared', new Map<number, any>([
        [
            5101,
            {
                id: 5101,
                name: 'GoblinArmorAxe',
                isPlayer: false,
                team: 2,
                entState: 0,
                clientSpawned: true,
                ownerToken: authority.token,
                roomId: 1
            }
        ]
    ]));

    await MissionHandler.handleSetLevelComplete(joiner as never, createLevelCompletePacket());

    assert.equal(
        joiner.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'non-authority joiner should not complete the dungeon while the shared progress is incomplete'
    );

    await LevelHandler.handleQuestProgressUpdate(authority as never, createQuestProgressPacket(100));
    await MissionHandler.handleSetLevelComplete(authority as never, createLevelCompletePacket());

    assert.equal(
        authority.sentPackets.some((packet) => packet.id === 0x87),
        true,
        'authority should complete the dungeon once the shared progress reaches 100%'
    );
    assert.deepEqual(
        joiner.sentPackets.filter((packet) => packet.id === 0xB7).map((packet) => parseQuestProgress(packet.payload)).slice(-1),
        [100],
        'joiner should receive the shared 100% progress before completion'
    );
}

async function main(): Promise<void> {
    ensureLevelConfigLoaded();

    const levelEntities = new Map(GlobalState.levelEntities);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const levelQuestProgress = new Map(GlobalState.levelQuestProgress);
    GlobalState.levelEntities.clear();
    GlobalState.sessionsByToken.clear();
    GlobalState.levelQuestProgress.clear();

    try {
        await testGoblinRiverQuestProgressFollowsHostileOwnerAuthority();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        await testGoblinRiverLevelCompleteWaitsForSharedProgressCompletion();
    } finally {
        GlobalState.levelEntities = levelEntities;
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.levelQuestProgress = levelQuestProgress;
    }

    console.log('shared_dungeon_progress_regression: ok');
}

void main().catch((error) => {
    console.error('shared_dungeon_progress_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
