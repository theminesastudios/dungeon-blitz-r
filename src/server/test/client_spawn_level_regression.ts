import { strict as assert } from 'assert';
import { GlobalState } from '../core/GlobalState';
import { EntityHandler } from '../handlers/EntityHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    character: { name: string };
    currentLevel: string;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    knownEntityIds: Set<number>;
    entities: Map<number, any>;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
};

let nextFakeToken = 1000;

function createFakeClient(name: string): FakeClient {
    const sentPackets: SentPacket[] = [];

    return {
        token: nextFakeToken++,
        character: { name },
        currentLevel: 'NewbieRoad',
        currentRoomId: 1,
        playerSpawned: true,
        clientEntID: 0,
        knownEntityIds: new Set<number>(),
        entities: new Map<number, any>(),
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        }
    };
}

function testOutdoorLevelsUseClientSpawn(): void {
    for (const levelName of [
        'CraftTown',
        'BridgeTown',
        'BridgeTownHard',
        'SwampRoadNorth',
        'SwampRoadConnection',
        'OldMineMountain',
        'EmeraldGlades',
        'Castle',
        'ShazariDesert',
        'JadeCityHard'
    ]) {
        assert.equal(EntityHandler.isClientSpawnLevel(levelName), true, `${levelName} should use client-spawn NPC sync`);
    }

    assert.equal(EntityHandler.isClientSpawnLevel('TutorialDungeon'), false);
}

function testClientSpawnLevelsDoNotSendServerNpcCopies(): void {
    const client = createFakeClient('Watcher');
    const levelMap = new Map<number, any>([
        [1001, { id: 1001, name: 'ServerGoblin', isPlayer: false, clientSpawned: false }],
        [1002, { id: 1002, name: 'ClientGoblin', isPlayer: false, clientSpawned: true }],
        [1003, { id: 1003, name: 'OtherPlayer', isPlayer: true }]
    ]);

    GlobalState.levelEntities.set('BridgeTown', levelMap);

    EntityHandler.sendInitialLevelEntities(client as never, 'BridgeTown');

    assert.equal(client.sentPackets.length, 0);
    assert.equal(client.entities.size, 0);
    assert.equal(levelMap.has(1001), false, 'stale server NPC copy should be removed');
    assert.equal(levelMap.has(1002), true, 'client-spawn NPC state should remain');
    assert.equal(levelMap.has(1003), true, 'player state should remain');
}

function testClientSpawnLevelsStartEmptyWithoutServerNpcInit(): void {
    const client = createFakeClient('Watcher');

    EntityHandler.sendInitialLevelEntities(client as never, 'BridgeTown');

    const levelMap = GlobalState.levelEntities.get('BridgeTown');
    assert.ok(levelMap, 'client-spawn level should still have a state bucket');
    assert.equal(levelMap?.size, 0, 'server should not seed outdoor NPCs for client-spawn levels');
    assert.equal(client.sentPackets.length, 0);
}

function testOutdoorHostileClientSpawnIsNotSeededToPeers(): void {
    const client = createFakeClient('Watcher');
    client.currentLevel = 'NewbieRoad';

    const hostile = {
        id: 2201,
        name: 'IntroGoblin',
        isPlayer: false,
        x: 100,
        y: 200,
        v: 0,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: 55,
        roomId: client.currentRoomId
    };

    GlobalState.levelEntities.set('NewbieRoad', new Map([[hostile.id, hostile]]));
    client.knownEntityIds.add(hostile.id);
    client.entities.set(hostile.id, { ...hostile });

    const known = EntityHandler.ensureEntityKnown(client as never, 'NewbieRoad', hostile.id);

    assert.equal(known, false, 'baked outdoor hostiles should not be seeded to other clients');
    assert.equal(client.sentPackets.length, 0);
    assert.equal(client.entities.size, 1, 'existing local hostile should remain untouched');
}

function testConflictingLocalIdsStillTriggerRemotePlayerSeed(): void {
    const sender = createFakeClient('Alpha');
    const watcher = createFakeClient('Beta');

    sender.currentLevel = 'NewbieRoad';
    watcher.currentLevel = 'NewbieRoad';
    sender.clientEntID = 2203;

    const localHostile = {
        id: sender.clientEntID,
        name: 'IntroGoblin',
        isPlayer: false,
        x: 90,
        y: 140,
        v: 0,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: watcher.token,
        roomId: watcher.currentRoomId
    };
    const remotePlayer = {
        id: sender.clientEntID,
        name: sender.character.name,
        isPlayer: true,
        x: 0,
        y: 0,
        v: 0,
        team: 1,
        entState: 0,
        ownerToken: sender.token,
        roomId: sender.currentRoomId
    };

    watcher.entities.set(localHostile.id, localHostile);
    watcher.knownEntityIds.add(localHostile.id);
    GlobalState.levelEntities.set('NewbieRoad', new Map([[remotePlayer.id, remotePlayer]]));
    GlobalState.sessionsByToken.set(sender.token, sender as never);

    const known = EntityHandler.ensureEntityKnown(watcher as never, 'NewbieRoad', remotePlayer.id);

    assert.equal(known, true, 'conflicting local ids should force a fresh player seed');
    assert.deepEqual(watcher.sentPackets.map((packet) => packet.id), [0x0F]);
    assert.equal(watcher.knownEntityIds.has(remotePlayer.id), true);
}

function testSafeRemotePlayerIdsRelayMovementWithoutCollision(): void {
    const sender = createFakeClient('Alpha');
    const watcher = createFakeClient('Beta');

    sender.currentLevel = 'NewbieRoad';
    watcher.currentLevel = 'NewbieRoad';
    sender.currentRoomId = 1;
    watcher.currentRoomId = 1;
    sender.clientEntID = 3200;

    const localHostile = {
        id: 2203,
        name: 'IntroGoblin',
        isPlayer: false,
        x: 90,
        y: 140,
        v: 0,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: watcher.token,
        roomId: watcher.currentRoomId
    };
    const remotePlayer = {
        id: sender.clientEntID,
        name: sender.character.name,
        isPlayer: true,
        x: 100,
        y: 200,
        v: 0,
        team: 1,
        entState: 0,
        ownerToken: sender.token,
        roomId: sender.currentRoomId
    };

    sender.entities.set(remotePlayer.id, { ...remotePlayer });
    watcher.entities.set(localHostile.id, localHostile);
    watcher.knownEntityIds.add(localHostile.id);

    GlobalState.levelEntities.set('NewbieRoad', new Map([[remotePlayer.id, remotePlayer]]));
    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(watcher.token, watcher as never);

    LevelHandler.handleEntityIncrementalUpdate(
        sender as never,
        buildIncrementalUpdatePayload(remotePlayer.id, 7, -3, 0)
    );

    assert.deepEqual(
        watcher.sentPackets.map((packet) => packet.id),
        [0x0F, 0x07],
        'safe remote player ids should still seed and relay movement even when the watcher has local outdoor mobs'
    );
}

function buildIncrementalUpdatePayload(entityId: number, deltaX: number, deltaY: number, deltaVX: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod45(deltaX);
    bb.writeMethod45(deltaY);
    bb.writeMethod45(deltaVX);
    bb.writeMethod6(0, 2);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function testOutdoorHostileIncrementalUpdatesDoNotRelayToPeers(): void {
    const sender = createFakeClient('Alpha');
    const watcher = createFakeClient('Beta');

    sender.currentLevel = 'NewbieRoad';
    watcher.currentLevel = 'NewbieRoad';
    sender.currentRoomId = 1;
    watcher.currentRoomId = 1;

    const hostile = {
        id: 2202,
        name: 'IntroGoblin',
        isPlayer: false,
        x: 100,
        y: 200,
        v: 0,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: sender.token,
        roomId: sender.currentRoomId
    };

    sender.entities.set(hostile.id, { ...hostile });
    sender.knownEntityIds.add(hostile.id);
    watcher.entities.set(hostile.id, { ...hostile, ownerToken: watcher.token });
    watcher.knownEntityIds.add(hostile.id);

    GlobalState.levelEntities.set('NewbieRoad', new Map([[hostile.id, hostile]]));
    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(watcher.token, watcher as never);

    LevelHandler.handleEntityIncrementalUpdate(
        sender as never,
        buildIncrementalUpdatePayload(hostile.id, 12, -4, 3)
    );

    assert.equal(
        watcher.sentPackets.some((packet) => packet.id === 0x07 || packet.id === 0x0F),
        false,
        'baked outdoor hostile movement should stay local even when peers know the same local entity id'
    );
}

function main(): void {
    const levelEntities = new Map(GlobalState.levelEntities);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    GlobalState.levelEntities.clear();
    GlobalState.sessionsByToken.clear();

    try {
        testOutdoorLevelsUseClientSpawn();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        testClientSpawnLevelsDoNotSendServerNpcCopies();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        testClientSpawnLevelsStartEmptyWithoutServerNpcInit();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        testOutdoorHostileClientSpawnIsNotSeededToPeers();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        testConflictingLocalIdsStillTriggerRemotePlayerSeed();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        testSafeRemotePlayerIdsRelayMovementWithoutCollision();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        testOutdoorHostileIncrementalUpdatesDoNotRelayToPeers();
    } finally {
        GlobalState.levelEntities = levelEntities;
        GlobalState.sessionsByToken = sessionsByToken;
    }

    console.log('client_spawn_level_regression: ok');
}

try {
    main();
} catch (error) {
    console.error('client_spawn_level_regression: failed');
    console.error(error);
    process.exitCode = 1;
}
