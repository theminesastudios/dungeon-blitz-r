import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { CombatHandler } from '../handlers/CombatHandler';
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
    entityIdAliases: Map<number, number>;
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
        entityIdAliases: new Map<number, number>(),
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

function createKeepClient(name: string, token: number): FakeClient {
    const client = createFakeClient(name, token);
    client.currentLevel = 'NR_Tales1Keep';
    client.levelInstanceId = 'keep-solo-cinematic';
    client.character.CurrentLevel = { name: 'NR_Tales1Keep', x: 1000, y: 1000 };
    return client;
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

function buildRoomBossInfoPayload(roomId: number, bossId: number, bossName: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(roomId);
    bb.writeMethod9(bossId);
    bb.writeMethod26(bossName);
    bb.writeMethod9(0);
    bb.writeMethod26('');
    return bb.toBuffer();
}

function buildRoomThoughtPayload(entityId: number, text: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod13(text);
    return bb.toBuffer();
}

function buildPowerHitPayload(targetId: number, sourceId: number, damage: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(targetId);
    bb.writeMethod4(sourceId);
    bb.writeMethod24(damage);
    bb.writeMethod4(77);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
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
    SocialHandler.handleRoomThought(rogue as never, buildRoomThoughtPayload(101, 'A second warning.'));
    LevelHandler.handleRoomStateUpdate(rogue as never, buildRoomStatePayload(2, 7));
    LevelHandler.handleRoomClose(rogue as never, buildRoomClosePayload(2));

    assert.equal(packetCount(mage, 0xA5), 0, 'late viewer start should not restart the cutscene for the owner');
    assert.equal(packetCount(rogue, 0xA5), 1, 'late viewer should receive its own cutscene border start');
    assert.equal(packetCount(mage, 0x76), 2, 'active cutscene bubbles should keep relaying instead of stopping after the first line');
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

function testSharedDungeonBossInfoStartsBorderForAllMembers(): void {
    const mage = createFakeClient('Mage', 91001);
    const rogue = createFakeClient('Rogue', 92002);
    GlobalState.sessionsByToken.set(mage.token, mage as never);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);

    LevelHandler.handleRoomBossInfo(mage as never, buildRoomBossInfoPayload(2, 500001, 'AncientDragonGoldMini'));

    assert.equal(packetCount(mage, 0xA5), 1, 'boss info should trigger cutscene border for the source client if room start has not arrived yet');
    assert.equal(packetCount(rogue, 0xA5), 1, 'boss info should trigger cutscene border for party viewers if room start has not arrived yet');
    assert.equal(packetCount(rogue, 0xAC), 1, 'boss info should still relay the boss bar packet to party viewers');

    mage.sentPackets.length = 0;
    rogue.sentPackets.length = 0;
    LevelHandler.handleRoomEventStart(mage as never, buildRoomEventStartPayload(2));

    assert.equal(packetCount(mage, 0xA5), 0, 'late owner room start should not replay cutscene border for source after boss info');
    assert.equal(packetCount(rogue, 0xA5), 0, 'late owner room start should not replay cutscene border for viewers after boss info');
}

function testPostDeathCompletionCanReuseCompletedRoomCutscene(): void {
    const mage = createFakeClient('Mage', 91001);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    const scope = getLevelScopeKey(mage.currentLevel, mage.levelInstanceId);
    LevelHandler.handleRoomEventStart(mage as never, buildRoomEventStartPayload(2));
    LevelHandler.handleRoomClose(mage as never, buildRoomClosePayload(2));
    assert.equal(mage.activeDungeonCutsceneScope, '', 'pre-boss room cutscene should be completed before the boss death sequence');

    mage.pendingDungeonCompletionScope = scope;
    mage.pendingDungeonCompletionWaitForCutsceneEnd = true;
    mage.sentPackets.length = 0;

    LevelHandler.handleRoomEventStart(mage as never, buildRoomEventStartPayload(2));
    assert.equal(mage.activeDungeonCutsceneScope, scope, 'post-death boss cutscene should reopen a completed room cutscene');

    SocialHandler.handleRoomThought(mage as never, buildRoomThoughtPayload(101, 'The defector is beaten.'));
    assert.equal(packetCount(mage, 0x76), 1, 'post-death boss dialogue should relay while completion waits for the cutscene');
}

function testSoloKeepCutsceneSkitIsNotSuppressedBySharedState(): void {
    const mage = createKeepClient('Mage', 91001);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    LevelHandler.handleRoomEventStart(mage as never, buildRoomEventStartPayload(2));
    LevelHandler.handleRoomClose(mage as never, buildRoomClosePayload(2));
    mage.sentPackets.length = 0;

    SocialHandler.handleRoomThought(mage as never, buildRoomThoughtPayload(101, 'I claim this keep.'));
    assert.equal(packetCount(mage, 0x76), 1, 'solo keep cutscene skits should not be suppressed by shared cinematic duplicate state');
}

async function testSharedDungeonCinematicSuppressesPlayerDamage(): Promise<void> {
    const mage = createFakeClient('Mage', 91001);
    const rogue = createFakeClient('Rogue', 92002);
    GlobalState.sessionsByToken.set(mage.token, mage as never);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);

    const scope = getLevelScopeKey(mage.currentLevel, mage.levelInstanceId);
    GlobalState.levelEntities.set(scope, new Map<number, any>([
        [500001, {
            id: 500001,
            name: 'AncientDragonGoldMini',
            isPlayer: false,
            team: 2,
            hp: 10000,
            maxHp: 10000,
            entState: 0,
            roomId: 2
        }]
    ]));

    LevelHandler.handleRoomEventStart(mage as never, buildRoomEventStartPayload(2));
    await CombatHandler.handlePowerHit(rogue as never, buildPowerHitPayload(500001, rogue.clientEntID, 9000));

    assert.equal(
        GlobalState.levelEntities.get(scope)?.get(500001)?.hp,
        10000,
        'player power hits during the shared cinematic should not damage the hostile'
    );
}

async function main(): Promise<void> {
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const dungeonCutscenes = new Map(GlobalState.dungeonCutscenes);
    const levelEntities = new Map(GlobalState.levelEntities);

    ensureDataLoaded();
    try {
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCutscenes.clear();
        GlobalState.levelEntities.clear();
        testSharedDungeonCinematicRunsOnceFromOwner();
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCutscenes.clear();
        GlobalState.levelEntities.clear();
        testSharedDungeonBossInfoStartsBorderForAllMembers();
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCutscenes.clear();
        GlobalState.levelEntities.clear();
        testPostDeathCompletionCanReuseCompletedRoomCutscene();
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCutscenes.clear();
        GlobalState.levelEntities.clear();
        testSoloKeepCutsceneSkitIsNotSuppressedBySharedState();
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCutscenes.clear();
        GlobalState.levelEntities.clear();
        await testSharedDungeonCinematicSuppressesPlayerDamage();
        console.log('shared_dungeon_cinematic_regression: ok');
    } finally {
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.dungeonCutscenes = dungeonCutscenes;
        GlobalState.levelEntities = levelEntities;
    }
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
