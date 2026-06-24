import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { LevelHandler } from '../handlers/LevelHandler';
import { SocialHandler } from '../handlers/SocialHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { getLevelScopeKey } from '../core/LevelScope';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    character: { name: string; level: number; dialogueLanguage?: string; CurrentLevel?: { name: string; x: number; y: number } };
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    startedRoomEvents: Set<string>;
    triggeredLevelStates: Set<string>;
    entities: Map<number, any>;
    activeDungeonCutsceneScope: string;
    activeDungeonCutsceneRoomId: number;
    lastDungeonCutsceneStartScope: string;
    lastDungeonCutsceneStartAt: number;
    lastDungeonCutsceneEndScope: string;
    lastDungeonCutsceneEndAt: number;
    pendingDungeonCompletionScope: string;
    pendingDungeonCompletionWaitForCutsceneEnd: boolean;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('JC_Mission3')) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
}

function createFakeClient(name: string, token: number): FakeClient {
    const sentPackets: SentPacket[] = [];
    return {
        token,
        character: {
            name,
            level: 50,
            dialogueLanguage: 'en',
            CurrentLevel: { name: 'JC_Mission3', x: 1000, y: 1000 }
        },
        currentLevel: 'JC_Mission3',
        levelInstanceId: 'cinematic-sync',
        currentRoomId: 2,
        playerSpawned: true,
        clientEntID: token + 1000,
        startedRoomEvents: new Set<string>(),
        triggeredLevelStates: new Set<string>(),
        entities: new Map<number, any>(),
        activeDungeonCutsceneScope: '',
        activeDungeonCutsceneRoomId: 0,
        lastDungeonCutsceneStartScope: '',
        lastDungeonCutsceneStartAt: 0,
        lastDungeonCutsceneEndScope: '',
        lastDungeonCutsceneEndAt: 0,
        pendingDungeonCompletionScope: '',
        pendingDungeonCompletionWaitForCutsceneEnd: false,
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function buildRoomEventStartPayload(roomId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(roomId);
    bb.writeMethod15(true);
    return bb.toBuffer();
}

function buildRoomClosePayload(roomId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(roomId);
    return bb.toBuffer();
}

function buildRoomStatePayload(roomId: number, cameraId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(roomId);
    bb.writeMethod9(cameraId);
    return bb.toBuffer();
}

function buildRoomThoughtPayload(entityId: number, text: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod13(text);
    return bb.toBuffer();
}

function packetCount(client: FakeClient, packetId: number): number {
    return client.sentPackets.filter((packet) => packet.id === packetId).length;
}

function testSharedDungeonCinematicRunsOnceFromOwner(): void {
    const mage = createFakeClient('Mage', 91001);
    const rogue = createFakeClient('Rogue', 92002);
    GlobalState.sessionsByToken.set(mage.token, mage as never);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);

    const scope = getLevelScopeKey(mage.currentLevel, mage.levelInstanceId);
    LevelHandler.handleRoomEventStart(mage as never, buildRoomEventStartPayload(2));

    assert.equal(packetCount(rogue, 0xA5), 1, 'first cutscene start should relay to the party viewer');
    assert.equal(mage.activeDungeonCutsceneScope, scope, 'owner should record active cutscene scope');
    assert.equal(rogue.activeDungeonCutsceneScope, scope, 'viewer should record active cutscene scope');

    mage.sentPackets.length = 0;
    rogue.sentPackets.length = 0;
    SocialHandler.handleRoomThought(mage as never, buildRoomThoughtPayload(101, 'The dragon wakes.'));
    assert.equal(packetCount(mage, 0x76), 1, 'owner cutscene bubble should still echo locally');
    assert.equal(packetCount(rogue, 0x76), 1, 'owner cutscene bubble should relay to the viewer');

    mage.sentPackets.length = 0;
    rogue.sentPackets.length = 0;
    LevelHandler.handleRoomEventStart(rogue as never, buildRoomEventStartPayload(2));
    SocialHandler.handleRoomThought(rogue as never, buildRoomThoughtPayload(101, 'The dragon wakes.'));
    LevelHandler.handleRoomStateUpdate(rogue as never, buildRoomStatePayload(2, 7));
    LevelHandler.handleRoomClose(rogue as never, buildRoomClosePayload(2));

    assert.equal(packetCount(mage, 0xA5), 0, 'late viewer start should not restart the cutscene for the owner');
    assert.equal(packetCount(mage, 0x76), 0, 'late viewer bubble should not relay');
    assert.equal(packetCount(mage, 0xA9), 0, 'late viewer camera timeline should not relay');
    assert.equal(packetCount(mage, 0xA6), 0, 'late viewer close should not end the owner timeline early');

    mage.sentPackets.length = 0;
    rogue.sentPackets.length = 0;
    LevelHandler.handleRoomClose(mage as never, buildRoomClosePayload(2));

    assert.equal(packetCount(rogue, 0xA6), 1, 'owner cutscene close should relay to the viewer');
    assert.equal(mage.activeDungeonCutsceneScope, '', 'owner active cutscene should clear after close');
    assert.equal(rogue.activeDungeonCutsceneScope, '', 'viewer active cutscene should clear after close');

    mage.sentPackets.length = 0;
    rogue.sentPackets.length = 0;
    LevelHandler.handleRoomEventStart(rogue as never, buildRoomEventStartPayload(2));
    SocialHandler.handleRoomThought(rogue as never, buildRoomThoughtPayload(101, 'The dragon wakes.'));
    LevelHandler.handleRoomClose(rogue as never, buildRoomClosePayload(2));

    assert.equal(packetCount(mage, 0xA5), 0, 'completed cutscene should not start again');
    assert.equal(packetCount(mage, 0x76), 0, 'completed cutscene should not replay duplicate bubbles');
    assert.equal(packetCount(mage, 0xA6), 0, 'completed cutscene should not close again');
}

function main(): void {
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const dungeonCutscenes = new Map(GlobalState.dungeonCutscenes);

    ensureDataLoaded();
    try {
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCutscenes.clear();
        testSharedDungeonCinematicRunsOnceFromOwner();
        console.log('shared_dungeon_cinematic_regression: ok');
    } finally {
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.dungeonCutscenes = dungeonCutscenes;
    }
}

void main();
