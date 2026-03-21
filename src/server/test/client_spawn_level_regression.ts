import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { Entity } from '../core/Entity';
import { EntityHandler } from '../handlers/EntityHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { SocialHandler } from '../handlers/SocialHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { NpcLoader } from '../data/NpcLoader';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    character: { name: string };
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    syncAnchorToken: number;
    playerSpawned: boolean;
    clientEntID: number;
    syncAnchorStartedAt: number;
    startedRoomEvents: Set<string>;
    deferredRoomEventStarts: Set<string>;
    knownEntityIds: Set<number>;
    entities: Map<number, any>;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

let nextFakeToken = 1000;


// MOCK SETTIMEOUT FOR SYNCHRONOUS TESTS
global.setTimeout = ((fn: any, delay: number) => {
    // Execute immediately in tests
    fn();
    return 0 as any;
}) as any;

function ensureLevelConfigLoaded(): void {
    if (!LevelConfig.has('TutorialDungeon')) {
        LevelConfig.load(path.resolve(__dirname, '../data'));
    }
    if (NpcLoader.getRawNpcsForLevel('TutorialDungeon').length === 0) {
        NpcLoader.load(path.resolve(__dirname, '../data'));
    }
}

function createFakeClient(name: string): FakeClient {
    const sentPackets: SentPacket[] = [];

    return {
        token: nextFakeToken++,
        character: { name },
        currentLevel: 'NewbieRoad',
        levelInstanceId: '',
        currentRoomId: 1,
        syncAnchorToken: 0,
        playerSpawned: true,
        clientEntID: 0,
        syncAnchorStartedAt: 0,
        startedRoomEvents: new Set<string>(),
        deferredRoomEventStarts: new Set<string>(),
        knownEntityIds: new Set<number>(),
        entities: new Map<number, any>(),
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function parseDestroyEntityId(payload: Buffer): number {
    const br = new BitReader(payload);
    return br.readMethod4();
}

function parseRoomEventStart(payload: Buffer): { roomId: number; flag: boolean } {
    const br = new BitReader(payload);
    return {
        roomId: br.readMethod4(),
        flag: br.readMethod15()
    };
}

function parseLevelState(payload: Buffer): { key: string; value: string } {
    const br = new BitReader(payload);
    return {
        key: br.readMethod26(),
        value: br.readMethod26()
    };
}

function buildLevelStatePayload(key: string, value: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod26(key);
    bb.writeMethod26(value);
    return bb.toBuffer();
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

function testNewbieRoadSeedsServerNpcCopies(): void {
    const client = createFakeClient('Watcher');

    EntityHandler.sendInitialLevelEntities(client as never, 'NewbieRoad');

    const levelMap = GlobalState.levelEntities.get('NewbieRoad');
    assert.ok(levelMap, 'NewbieRoad should have a shared state bucket');

    const seededServerNpcs = Array.from(levelMap!.values()).filter((entity) => !entity?.isPlayer && !entity?.clientSpawned);
    assert.ok(seededServerNpcs.length > 0, 'NewbieRoad should seed server-authored NPCs');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x0F), true, 'joining clients should receive seeded NewbieRoad NPCs');
    assert.equal(seededServerNpcs.some((entity) => entity?.team === 3), true, 'friendly NPCs should come from the server seed');
    assert.equal(seededServerNpcs.some((entity) => entity?.team === 1), false, 'neutral helper actors should stay out of the server-seeded NPC set');
}

function testTutorialDungeonSeedsRawServerNpcsWhenScopeAlreadyHasPlayer(): void {
    const client = createFakeClient('Watcher');
    client.currentLevel = 'TutorialDungeon';
    client.levelInstanceId = 'party-seed';
    client.clientEntID = 9001;

    GlobalState.levelEntities.set('TutorialDungeon#party-seed', new Map<number, any>([
        [client.clientEntID, {
            id: client.clientEntID,
            name: client.character.name,
            isPlayer: true,
            team: 1,
            ownerToken: client.token
        }]
    ]));

    EntityHandler.sendInitialLevelEntities(client as never, 'TutorialDungeon');

    const levelMap = GlobalState.levelEntities.get('TutorialDungeon#party-seed');
    assert.ok(levelMap, 'TutorialDungeon should have a scoped shared state bucket');

    const seededServerNpcs = Array.from(levelMap!.values()).filter((entity) => !entity?.isPlayer && !entity?.clientSpawned);
    assert.ok(seededServerNpcs.length > 0, 'TutorialDungeon should seed server NPCs even when the player is already present in the scope map');
    assert.equal(seededServerNpcs.some((entity) => entity?.team === 2), true, 'hostile dungeon NPCs should be seeded for the first entrant');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x0F), true, 'first entrant should immediately receive seeded dungeon NPCs');
}

function testNewbieRoadRejectsClientSpawnedNonEnemyNpcs(): void {
    const client = createFakeClient('Watcher');
    client.currentLevel = 'NewbieRoad';
    client.currentRoomId = 3;

    const bb = new BitBuffer(false);
    bb.writeMethod4(7001); // entityId
    bb.writeMethod45(100); // x
    bb.writeMethod45(200); // y
    bb.writeMethod45(0); // v
    bb.writeMethod26('NPCAnnaOutside');
    bb.writeMethod6(3, Entity.TEAM_BITS); // team
    bb.writeMethod15(false); // isPlayer
    bb.writeMethod45(0); // yOffset
    bb.writeMethod15(false); // hasCue
    bb.writeMethod15(false); // hasSummoner
    bb.writeMethod15(false); // hasPower
    bb.writeMethod6(0, Entity.STATE_BITS); // entState
    bb.writeMethod15(false); // bLeft
    bb.writeMethod15(false); // bRunning
    bb.writeMethod15(false); // bJumping
    bb.writeMethod15(false); // bDropping
    bb.writeMethod15(false); // bBackpedal

    (EntityHandler as any).handleEntityFullUpdate(client as never, bb.toBuffer());

    assert.deepEqual(client.sentPackets.map((packet) => packet.id), [0x0D], 'client-authored NewbieRoad NPCs should be destroyed instead of accepted');
    assert.equal(parseDestroyEntityId(client.sentPackets[0]!.payload), 7001);
    assert.equal(client.entities.has(7001), false);
}

function testDungeonNonLeaderHostileClientSpawnCanEstablishCanonicalState(): void {
    const leader = createFakeClient('Alpha');
    const follower = createFakeClient('Beta');

    leader.currentLevel = 'TutorialDungeon';
    follower.currentLevel = 'TutorialDungeon';
    leader.levelInstanceId = 'party-scope';
    follower.levelInstanceId = 'party-scope';
    leader.currentRoomId = 4;
    follower.currentRoomId = 4;

    leader.syncAnchorToken = leader.token;
    follower.syncAnchorToken = leader.token;

    GlobalState.sessionsByToken.set(leader.token, leader as never);
    GlobalState.sessionsByToken.set(follower.token, follower as never);
    GlobalState.partyByMember.set('alpha', 101);
    GlobalState.partyByMember.set('beta', 101);

    const bb = new BitBuffer(false);
    bb.writeMethod4(7101); // entityId
    bb.writeMethod45(100); // x
    bb.writeMethod45(200); // y
    bb.writeMethod45(0); // v
    bb.writeMethod26('IntroGoblin');
    bb.writeMethod6(2, Entity.TEAM_BITS); // team
    bb.writeMethod15(false); // isPlayer
    bb.writeMethod45(0); // yOffset
    bb.writeMethod15(false); // hasCue
    bb.writeMethod15(false); // hasSummoner
    bb.writeMethod15(false); // hasPower
    bb.writeMethod6(0, Entity.STATE_BITS); // entState
    bb.writeMethod15(false); // bLeft
    bb.writeMethod15(false); // bRunning
    bb.writeMethod15(false); // bJumping
    bb.writeMethod15(false); // bDropping
    bb.writeMethod15(false); // bBackpedal

    (EntityHandler as any).handleEntityFullUpdate(follower as never, bb.toBuffer());

    assert.equal(follower.entities.has(7101), true, 'non-leader dungeon starter should be allowed to establish shared hostile state');
    assert.equal(GlobalState.levelEntities.get('TutorialDungeon#party-scope')?.has(7101), true);
    assert.equal(follower.sentPackets.some((packet) => packet.id === 0x0D), false, 'shared dungeon hostile should not be pre-emptively destroyed');
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

function testOutdoorHostileClientSpawnSeedsToPartyPeers(): void {
    const owner = createFakeClient('Alpha');
    const watcher = createFakeClient('Beta');

    owner.currentLevel = 'NewbieRoad';
    watcher.currentLevel = 'NewbieRoad';
    owner.currentRoomId = 1;
    watcher.currentRoomId = 7;

    const hostile = {
        id: 2204,
        name: 'IntroGoblin',
        isPlayer: false,
        x: 120,
        y: 220,
        v: 0,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: owner.token,
        roomId: owner.currentRoomId
    };

    GlobalState.levelEntities.set('NewbieRoad', new Map([[hostile.id, hostile]]));
    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(watcher.token, watcher as never);
    GlobalState.partyByMember.set('alpha', 77);
    GlobalState.partyByMember.set('beta', 77);

    const known = EntityHandler.ensureEntityKnown(watcher as never, 'NewbieRoad', hostile.id);

    assert.equal(known, true, 'party peers should receive outdoor hostile seeds');
    assert.deepEqual(watcher.sentPackets.map((packet) => packet.id), [0x0F]);
    assert.equal(watcher.knownEntityIds.has(hostile.id), true);
}

function testDungeonHostileClientSpawnSeedsToPartyPeersOnly(): void {
    const owner = createFakeClient('Alpha');
    const partyWatcher = createFakeClient('Beta');
    const stranger = createFakeClient('Gamma');

    owner.currentLevel = 'TutorialDungeon';
    partyWatcher.currentLevel = 'TutorialDungeon';
    stranger.currentLevel = 'TutorialDungeon';
    owner.currentRoomId = 1;
    partyWatcher.currentRoomId = 5;
    stranger.currentRoomId = 1;

    const hostile = {
        id: 2210,
        name: 'IntroGoblin',
        isPlayer: false,
        x: 180,
        y: 240,
        v: 0,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: owner.token,
        roomId: owner.currentRoomId
    };

    GlobalState.levelEntities.set('TutorialDungeon', new Map([[hostile.id, hostile]]));
    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(partyWatcher.token, partyWatcher as never);
    GlobalState.sessionsByToken.set(stranger.token, stranger as never);
    GlobalState.partyByMember.set('alpha', 91);
    GlobalState.partyByMember.set('beta', 91);

    const partyKnown = EntityHandler.ensureEntityKnown(partyWatcher as never, 'TutorialDungeon', hostile.id);
    const strangerKnown = EntityHandler.ensureEntityKnown(stranger as never, 'TutorialDungeon', hostile.id);

    assert.equal(partyKnown, true, 'dungeon hostile sync should now reach party peers');
    assert.deepEqual(partyWatcher.sentPackets.map((packet) => packet.id), [0x0F]);
    assert.equal(strangerKnown, false, 'non-party dungeon viewers should not receive hostile seeds');
    assert.equal(stranger.sentPackets.length, 0);
}

function testDungeonPartyAuthoritySuppressesDuplicateHostileSpawns(): void {
    const owner = createFakeClient('Alpha');
    const follower = createFakeClient('Beta');

    owner.currentLevel = 'TutorialDungeon';
    follower.currentLevel = 'TutorialDungeon';
    owner.currentRoomId = 4;
    follower.currentRoomId = 4;

    const canonical = {
        id: 2301,
        name: 'IntroGoblin',
        isPlayer: false,
        x: 120,
        y: 220,
        v: 0,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: owner.token,
        ownerPartyId: 92,
        roomId: owner.currentRoomId
    };

    GlobalState.levelEntities.set('TutorialDungeon', new Map([[canonical.id, canonical]]));
    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(follower.token, follower as never);
    GlobalState.partyByMember.set('alpha', 92);
    GlobalState.partyByMember.set('beta', 92);

    const duplicate = {
        id: 3301,
        name: canonical.name,
        isPlayer: false,
        x: 123,
        y: 218,
        v: 0,
        team: canonical.team,
        entState: canonical.entState,
        clientSpawned: true,
        ownerToken: follower.token,
        ownerPartyId: 92,
        roomId: follower.currentRoomId
    };

    const suppressed = (EntityHandler as any).suppressDuplicateSharedClientSpawn(
        follower as never,
        'TutorialDungeon',
        GlobalState.levelEntities.get('TutorialDungeon'),
        duplicate
    );

    const levelMap = GlobalState.levelEntities.get('TutorialDungeon');
    assert.equal(suppressed, true, 'follower hostile spawn should be suppressed when a party authority already owns the room');
    assert.equal(levelMap?.size, 1, 'duplicate dungeon hostile should not be added as a second shared entity');
    assert.deepEqual(follower.sentPackets.map((packet) => packet.id), [0x0D, 0x0F]);
    assert.equal(parseDestroyEntityId(follower.sentPackets[0]!.payload), 3301);
    assert.equal(follower.knownEntityIds.has(canonical.id), true);
    assert.equal(follower.knownEntityIds.has(3301), false);
    assert.equal(follower.entities.has(3301), false);
}

function testDungeonPartyAuthoritySuppressesDuplicateHostileSpawnsAcrossUnsyncedRooms(): void {
    const owner = createFakeClient('Alpha');
    const follower = createFakeClient('Beta');

    owner.currentLevel = 'TutorialDungeon';
    follower.currentLevel = 'TutorialDungeon';
    owner.currentRoomId = 4;
    follower.currentRoomId = 0;

    const canonical = {
        id: 2302,
        name: 'IntroGoblin',
        isPlayer: false,
        x: 120,
        y: 220,
        v: 0,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: owner.token,
        ownerPartyId: 98,
        roomId: owner.currentRoomId
    };

    GlobalState.levelEntities.set('TutorialDungeon', new Map([[canonical.id, canonical]]));
    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(follower.token, follower as never);
    GlobalState.partyByMember.set('alpha', 98);
    GlobalState.partyByMember.set('beta', 98);

    const duplicate = {
        id: 3302,
        name: canonical.name,
        isPlayer: false,
        x: 123,
        y: 218,
        v: 0,
        team: canonical.team,
        entState: canonical.entState,
        clientSpawned: true,
        ownerToken: follower.token,
        ownerPartyId: 98,
        roomId: follower.currentRoomId
    };

    const suppressed = (EntityHandler as any).suppressDuplicateSharedClientSpawn(
        follower as never,
        'TutorialDungeon',
        GlobalState.levelEntities.get('TutorialDungeon'),
        duplicate
    );

    const levelMap = GlobalState.levelEntities.get('TutorialDungeon');
    assert.equal(suppressed, true, 'follower hostile spawn should still be suppressed while the joiner room state is unsynced');
    assert.equal(levelMap?.size, 1, 'cross-room dungeon hostile should still collapse to the existing shared entity');
    assert.deepEqual(follower.sentPackets.map((packet) => packet.id), [0x0D, 0x0F]);
    assert.equal(parseDestroyEntityId(follower.sentPackets[0]!.payload), 3302);
    assert.equal(follower.knownEntityIds.has(canonical.id), true);
    assert.equal(follower.knownEntityIds.has(3302), false);
    assert.equal(follower.entities.has(3302), false);
}

function testOutdoorPartyAuthoritySuppressesDuplicateNpcSpawns(): void {
    const owner = createFakeClient('Alpha');
    const follower = createFakeClient('Beta');

    owner.currentLevel = 'NewbieRoad';
    follower.currentLevel = 'NewbieRoad';
    owner.currentRoomId = 2;
    follower.currentRoomId = 2;

    const canonical = {
        id: 2401,
        name: 'VillageGuide',
        isPlayer: false,
        x: 410,
        y: 560,
        v: 0,
        team: 3,
        entState: 0,
        clientSpawned: true,
        ownerToken: owner.token,
        ownerPartyId: 93,
        roomId: owner.currentRoomId
    };

    GlobalState.levelEntities.set('NewbieRoad', new Map([[canonical.id, canonical]]));
    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(follower.token, follower as never);
    GlobalState.partyByMember.set('alpha', 93);
    GlobalState.partyByMember.set('beta', 93);

    const duplicate = {
        id: 3401,
        name: canonical.name,
        isPlayer: false,
        x: 412,
        y: 563,
        v: 0,
        team: canonical.team,
        entState: canonical.entState,
        clientSpawned: true,
        ownerToken: follower.token,
        ownerPartyId: 93,
        roomId: follower.currentRoomId
    };

    const suppressed = (EntityHandler as any).suppressDuplicateSharedClientSpawn(
        follower as never,
        'NewbieRoad',
        GlobalState.levelEntities.get('NewbieRoad'),
        duplicate
    );

    const levelMap = GlobalState.levelEntities.get('NewbieRoad');
    assert.equal(suppressed, true, 'follower NPC spawn should be suppressed when a party authority already owns the room');
    assert.equal(levelMap?.size, 1, 'duplicate outdoor NPC should not be added as a second shared entity');
    assert.deepEqual(follower.sentPackets.map((packet) => packet.id), [0x0D, 0x0F]);
    assert.equal(parseDestroyEntityId(follower.sentPackets[0]!.payload), 3401);
    assert.equal(follower.knownEntityIds.has(canonical.id), true);
    assert.equal(follower.entities.has(3401), false);
}

function testOutdoorPartyAuthoritySuppressesDuplicateHostileSpawnsAcrossUnsyncedRooms(): void {
    const owner = createFakeClient('Alpha');
    const follower = createFakeClient('Beta');

    owner.currentLevel = 'NewbieRoad';
    follower.currentLevel = 'NewbieRoad';
    owner.currentRoomId = 2;
    follower.currentRoomId = 0;

    const canonical = {
        id: 2402,
        name: 'GoblinDagger',
        isPlayer: false,
        x: 410,
        y: 560,
        v: 0,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: owner.token,
        ownerPartyId: 99,
        roomId: owner.currentRoomId
    };

    GlobalState.levelEntities.set('NewbieRoad', new Map([[canonical.id, canonical]]));
    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(follower.token, follower as never);
    GlobalState.partyByMember.set('alpha', 99);
    GlobalState.partyByMember.set('beta', 99);

    const duplicate = {
        id: 3402,
        name: canonical.name,
        isPlayer: false,
        x: 412,
        y: 563,
        v: 0,
        team: canonical.team,
        entState: canonical.entState,
        clientSpawned: true,
        ownerToken: follower.token,
        ownerPartyId: 99,
        roomId: follower.currentRoomId
    };

    const suppressed = (EntityHandler as any).suppressDuplicateSharedClientSpawn(
        follower as never,
        'NewbieRoad',
        GlobalState.levelEntities.get('NewbieRoad'),
        duplicate
    );

    const levelMap = GlobalState.levelEntities.get('NewbieRoad');
    assert.equal(suppressed, true, 'follower hostile spawn should still be suppressed while the joiner room state is unsynced in shared outdoor levels');
    assert.equal(levelMap?.size, 1, 'cross-room outdoor hostile should still collapse to the existing shared entity');
    assert.deepEqual(follower.sentPackets.map((packet) => packet.id), [0x0D, 0x0F]);
    assert.equal(parseDestroyEntityId(follower.sentPackets[0]!.payload), 3402);
    assert.equal(follower.knownEntityIds.has(canonical.id), true);
    assert.equal(follower.knownEntityIds.has(3402), false);
    assert.equal(follower.entities.has(3402), false);
}

function testDungeonPartyAuthoritySuppressesDuplicateTargetDummySpawns(): void {
    const owner = createFakeClient('Alpha');
    const follower = createFakeClient('Beta');

    owner.currentLevel = 'TutorialDungeon';
    follower.currentLevel = 'TutorialDungeon';
    owner.currentRoomId = 1;
    follower.currentRoomId = 1;

    const canonical = {
        id: 2450,
        name: 'IntroDummy1',
        isPlayer: false,
        x: 4000,
        y: 2099,
        v: 0,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: owner.token,
        ownerPartyId: 94,
        roomId: owner.currentRoomId
    };

    GlobalState.levelEntities.set('TutorialDungeon', new Map([[canonical.id, canonical]]));
    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(follower.token, follower as never);
    GlobalState.partyByMember.set('alpha', 94);
    GlobalState.partyByMember.set('beta', 94);

    const duplicate = {
        id: 3450,
        name: canonical.name,
        isPlayer: false,
        x: 4002,
        y: 2101,
        v: 0,
        team: canonical.team,
        entState: canonical.entState,
        clientSpawned: true,
        ownerToken: follower.token,
        ownerPartyId: 94,
        roomId: follower.currentRoomId
    };

    const suppressed = (EntityHandler as any).suppressDuplicateSharedClientSpawn(
        follower as never,
        'TutorialDungeon',
        GlobalState.levelEntities.get('TutorialDungeon'),
        duplicate
    );

    assert.equal(suppressed, true, 'target dummy spawns should collapse to the first shared authority');
    assert.deepEqual(follower.sentPackets.map((packet) => packet.id), [0x0D, 0x0F]);
    assert.equal(parseDestroyEntityId(follower.sentPackets[0]!.payload), 3450);
    assert.equal(follower.knownEntityIds.has(canonical.id), true);
    assert.equal(follower.entities.has(3450), false);
}

function testCraftTownTutorialSameIdDuplicateDoesNotForceDestroyRespawn(): void {
    const owner = createFakeClient('Alpha');
    const follower = createFakeClient('Beta');

    owner.currentLevel = 'CraftTownTutorial';
    follower.currentLevel = 'CraftTownTutorial';
    owner.currentRoomId = 1;
    follower.currentRoomId = 1;

    const canonical = {
        id: 2501,
        name: 'IntroParrot',
        isPlayer: false,
        x: 300,
        y: 410,
        v: 0,
        team: 3,
        entState: 0,
        clientSpawned: true,
        ownerToken: owner.token,
        ownerPartyId: 95,
        roomId: owner.currentRoomId
    };

    GlobalState.levelEntities.set('CraftTownTutorial', new Map([[canonical.id, canonical]]));
    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(follower.token, follower as never);
    GlobalState.partyByMember.set('alpha', 95);
    GlobalState.partyByMember.set('beta', 95);

    const suppressed = (EntityHandler as any).suppressDuplicateSharedClientSpawn(
        follower as never,
        'CraftTownTutorial',
        GlobalState.levelEntities.get('CraftTownTutorial'),
        {
            ...canonical,
            ownerToken: follower.token
        }
    );

    assert.equal(suppressed, true, 'same-id tutorial duplicates should still lose authority');
    assert.deepEqual(follower.sentPackets, [], 'same-id duplicates should not force a destroy/respawn packet cycle');
    assert.equal(follower.knownEntityIds.has(canonical.id), true);
    assert.equal(follower.entities.has(canonical.id), false);
}

function testSoloDungeonHostileReferencePromotesToPartyJoinerSeed(): void {
    const owner = createFakeClient('Alpha');
    const joiner = createFakeClient('Beta');

    owner.currentLevel = 'TutorialDungeon';
    joiner.currentLevel = 'TutorialDungeon';
    owner.currentRoomId = 4;
    joiner.currentRoomId = 9;

    const canonical = {
        id: 2551,
        name: 'IntroGoblin',
        isPlayer: false,
        x: 800,
        y: 600,
        v: 0,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: owner.token,
        ownerPartyId: 0,
        roomId: owner.currentRoomId
    };

    GlobalState.levelEntities.set('TutorialDungeon', new Map([[canonical.id, canonical]]));
    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    GlobalState.partyByMember.set('alpha', 96);
    GlobalState.partyByMember.set('beta', 96);

    (EntityHandler as any).sendExistingVisibleClientSpawnEntitiesToJoiner(joiner as never);

    assert.deepEqual(joiner.sentPackets.map((packet) => packet.id), [0x0F]);
    assert.equal(canonical.ownerPartyId, 96, 'solo hostile reference should be promoted to party ownership once the dungeon becomes party-shared');
    assert.equal(joiner.knownEntityIds.has(canonical.id), true);
}

function testSoloDungeonNpcReferencePromotesToPartyJoinerSeed(): void {
    const owner = createFakeClient('Alpha');
    const joiner = createFakeClient('Beta');

    owner.currentLevel = 'TutorialDungeon';
    joiner.currentLevel = 'TutorialDungeon';
    owner.currentRoomId = 6;
    joiner.currentRoomId = 1;

    const canonical = {
        id: 2552,
        name: 'IntroParrot',
        isPlayer: false,
        x: 300,
        y: 410,
        v: 0,
        team: 3,
        entState: 0,
        clientSpawned: true,
        ownerToken: owner.token,
        ownerPartyId: 0,
        roomId: owner.currentRoomId
    };

    GlobalState.levelEntities.set('TutorialDungeon', new Map([[canonical.id, canonical]]));
    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    GlobalState.partyByMember.set('alpha', 97);
    GlobalState.partyByMember.set('beta', 97);

    (EntityHandler as any).sendExistingVisibleClientSpawnEntitiesToJoiner(joiner as never);

    assert.deepEqual(joiner.sentPackets.map((packet) => packet.id), [0x0F]);
    assert.equal(canonical.ownerPartyId, 97, 'solo NPC reference should be promoted to party ownership once the dungeon becomes party-shared');
    assert.equal(joiner.knownEntityIds.has(canonical.id), true);
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

function testOutdoorHostileIncrementalUpdatesRelayToPartyPeers(): void {
    const sender = createFakeClient('Alpha');
    const watcher = createFakeClient('Beta');

    sender.currentLevel = 'NewbieRoad';
    watcher.currentLevel = 'NewbieRoad';
    sender.currentRoomId = 1;
    watcher.currentRoomId = 7;

    const hostile = {
        id: 2205,
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
    GlobalState.levelEntities.set('NewbieRoad', new Map([[hostile.id, hostile]]));
    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(watcher.token, watcher as never);
    GlobalState.partyByMember.set('alpha', 88);
    GlobalState.partyByMember.set('beta', 88);

    LevelHandler.handleEntityIncrementalUpdate(
        sender as never,
        buildIncrementalUpdatePayload(hostile.id, 12, -4, 3)
    );

    assert.deepEqual(
        watcher.sentPackets.map((packet) => packet.id),
        [0x0F, 0x07],
        'party peers should receive outdoor hostile movement as shared enemy state'
    );
}

function testDungeonJoinerReplaysStartedRoomEventsFromPartyAnchor(): void {
    const anchor = createFakeClient('Alpha');
    const joiner = createFakeClient('Beta');

    anchor.currentLevel = 'TutorialDungeon';
    joiner.currentLevel = 'TutorialDungeon';
    anchor.levelInstanceId = '41035';
    joiner.levelInstanceId = '41035';
    anchor.currentRoomId = 5;
    joiner.currentRoomId = 0;
    anchor.syncAnchorStartedAt = 100;
    joiner.syncAnchorStartedAt = 50;
    anchor.clientEntID = 7001;
    joiner.clientEntID = 7002;

    anchor.startedRoomEvents.add('TutorialDungeon:0');
    anchor.startedRoomEvents.add('TutorialDungeon:1');
    anchor.startedRoomEvents.add('TutorialDungeon:5');
    joiner.startedRoomEvents.add('TutorialDungeon:0');

    const anchorProps = {
        id: anchor.clientEntID,
        name: 'Alpha',
        isPlayer: true,
        x: 100,
        y: 200,
        team: 1,
        entState: 0
    };

    anchor.entities.set(anchor.clientEntID, anchorProps);
    joiner.entities.set(joiner.clientEntID, {
        id: joiner.clientEntID,
        name: 'Beta',
        isPlayer: true,
        x: 120,
        y: 200,
        team: 1,
        entState: 0
    });

    GlobalState.sessionsByToken.set(anchor.token, anchor as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    GlobalState.partyByMember.set('alpha', 77);
    GlobalState.partyByMember.set('beta', 77);

    (EntityHandler as any).sendExistingPlayersToJoiner(joiner as never);

    const roomPackets = joiner.sentPackets.filter((packet) => packet.id === 0xA5);
    assert.deepEqual(
        roomPackets.map((packet) => parseRoomEventStart(packet.payload)),
        [
            { roomId: 1, flag: true },
            { roomId: 5, flag: true }
        ],
        'joiner should replay missing dungeon room starts from the party anchor only once'
    );
    assert.equal(joiner.currentRoomId, 5, 'joiner should inherit the party anchor room before visible client-spawn seeding');
    assert.equal(joiner.startedRoomEvents.has('TutorialDungeon:1'), true);
    assert.equal(joiner.startedRoomEvents.has('TutorialDungeon:5'), true);
}

function testTutorialDungeonPrimeRoomEventsFlushAfterSelfSpawn(): void {
    const client = createFakeClient('Alpha');
    client.currentLevel = 'TutorialDungeon';
    client.playerSpawned = false;

    LevelHandler.primeTutorialRoomEvents(client as never);

    assert.equal(client.sentPackets.length, 0, 'tutorial dungeon room starts should wait until the local player entity exists');
    assert.equal(client.startedRoomEvents.has('TutorialDungeon:0'), true);
    assert.equal(client.startedRoomEvents.has('TutorialDungeon:1'), true);
    assert.equal(client.deferredRoomEventStarts.has('TutorialDungeon:0'), true);
    assert.equal(client.deferredRoomEventStarts.has('TutorialDungeon:1'), true);

    client.playerSpawned = true;
    LevelHandler.flushDeferredRoomEventStarts(client as never);

    const roomPackets = client.sentPackets.filter((packet) => packet.id === 0xA5);
    assert.deepEqual(
        roomPackets.map((packet) => parseRoomEventStart(packet.payload)),
        [
            { roomId: 0, flag: true },
            { roomId: 1, flag: true }
        ],
        'tutorial dungeon bootstrap should flush deferred room starts after self spawn'
    );
    assert.equal(client.deferredRoomEventStarts.size, 0);
}

function testDungeonJoinerSeedsVisibleHostilesImmediatelyAfterRoomReplay(): void {
    const anchor = createFakeClient('Alpha');
    const joiner = createFakeClient('Beta');

    anchor.currentLevel = 'TutorialDungeon';
    joiner.currentLevel = 'TutorialDungeon';
    anchor.levelInstanceId = '41035';
    joiner.levelInstanceId = '41035';
    anchor.currentRoomId = 5;
    joiner.currentRoomId = 0;
    anchor.syncAnchorToken = anchor.token;
    joiner.syncAnchorToken = anchor.token;
    anchor.syncAnchorStartedAt = 100;
    joiner.syncAnchorStartedAt = 50;
    anchor.clientEntID = 7001;
    joiner.clientEntID = 7002;

    anchor.startedRoomEvents.add('TutorialDungeon:0');
    anchor.startedRoomEvents.add('TutorialDungeon:1');
    anchor.startedRoomEvents.add('TutorialDungeon:5');

    anchor.entities.set(anchor.clientEntID, {
        id: anchor.clientEntID,
        name: 'Alpha',
        isPlayer: true,
        x: 100,
        y: 200,
        team: 1,
        entState: 0
    });
    joiner.entities.set(joiner.clientEntID, {
        id: joiner.clientEntID,
        name: 'Beta',
        isPlayer: true,
        x: 120,
        y: 200,
        team: 1,
        entState: 0
    });

    const hostile = {
        id: 9101,
        name: 'GoblinScout',
        isPlayer: false,
        x: 420,
        y: 315,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: anchor.token,
        ownerUserId: 0,
        ownerPartyId: 77,
        roomId: 5
    };

    GlobalState.sessionsByToken.set(anchor.token, anchor as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    GlobalState.partyByMember.set('alpha', 77);
    GlobalState.partyByMember.set('beta', 77);
    GlobalState.levelEntities.set('TutorialDungeon#41035', new Map<number, any>([
        [hostile.id, hostile]
    ]));

    (EntityHandler as any).sendExistingPlayersToJoiner(joiner as never);

    assert.equal(joiner.currentRoomId, 5, 'joiner should inherit anchor room before hostile seeding');
    assert.equal(joiner.startedRoomEvents.has('TutorialDungeon:5'), true);
    assert.equal(joiner.sentPackets.some((packet) => packet.id === 0x0F), true, 'joiner should immediately receive visible shared hostiles');
    assert.equal(joiner.knownEntityIds.has(hostile.id), true, 'joiner should mark the hostile as known after immediate seeding');
    assert.equal(
        joiner.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntityId(packet.payload) === hostile.id),
        false,
        'joiner should not destroy the shared hostile while seeding it'
    );
}

function testDungeonJoinerReplaysStoredLevelStateFromScope(): void {
    const anchor = createFakeClient('Alpha');
    const joiner = createFakeClient('Beta');

    anchor.currentLevel = 'TutorialDungeon';
    joiner.currentLevel = 'TutorialDungeon';
    anchor.levelInstanceId = '41035';
    joiner.levelInstanceId = '41035';
    anchor.clientEntID = 7001;
    joiner.clientEntID = 7002;

    anchor.entities.set(anchor.clientEntID, {
        id: anchor.clientEntID,
        name: 'Alpha',
        isPlayer: true,
        x: 100,
        y: 200,
        team: 1,
        entState: 0
    });

    GlobalState.sessionsByToken.set(anchor.token, anchor as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    GlobalState.partyByMember.set('alpha', 77);
    GlobalState.partyByMember.set('beta', 77);

    const statePayload = buildLevelStatePayload('5^SetDynamicCollision^am_DynamicCollision_Test', 'Off');
    SocialHandler.handleLevelState(anchor as never, statePayload);
    joiner.sentPackets.length = 0;

    (EntityHandler as any).sendExistingPlayersToJoiner(joiner as never);

    const statePackets = joiner.sentPackets.filter((packet) => packet.id === 0x40);
    assert.deepEqual(
        statePackets.map((packet) => parseLevelState(packet.payload)),
        [
            { key: '5^SetDynamicCollision^am_DynamicCollision_Test', value: 'Off' }
        ],
        'joiner should replay stored room level-state packets such as dynamic collision'
    );
}

function main(): void {
    ensureLevelConfigLoaded();

    const levelEntities = new Map(GlobalState.levelEntities);
    const levelStateByScope = new Map(GlobalState.levelStateByScope);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const partyGroups = new Map(GlobalState.partyGroups);
    const partyByMember = new Map(GlobalState.partyByMember);
    GlobalState.levelEntities.clear();
    GlobalState.levelStateByScope.clear();
    GlobalState.sessionsByToken.clear();
    GlobalState.partyGroups.clear();
    GlobalState.partyByMember.clear();

    try {
        testOutdoorLevelsUseClientSpawn();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testClientSpawnLevelsDoNotSendServerNpcCopies();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testClientSpawnLevelsStartEmptyWithoutServerNpcInit();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testNewbieRoadSeedsServerNpcCopies();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testTutorialDungeonSeedsRawServerNpcsWhenScopeAlreadyHasPlayer();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testNewbieRoadRejectsClientSpawnedNonEnemyNpcs();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        testDungeonNonLeaderHostileClientSpawnCanEstablishCanonicalState();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        testOutdoorHostileClientSpawnIsNotSeededToPeers();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testOutdoorHostileClientSpawnSeedsToPartyPeers();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDungeonHostileClientSpawnSeedsToPartyPeersOnly();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDungeonPartyAuthoritySuppressesDuplicateHostileSpawns();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDungeonPartyAuthoritySuppressesDuplicateHostileSpawnsAcrossUnsyncedRooms();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testOutdoorPartyAuthoritySuppressesDuplicateNpcSpawns();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testOutdoorPartyAuthoritySuppressesDuplicateHostileSpawnsAcrossUnsyncedRooms();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDungeonPartyAuthoritySuppressesDuplicateTargetDummySpawns();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testCraftTownTutorialSameIdDuplicateDoesNotForceDestroyRespawn();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testSoloDungeonHostileReferencePromotesToPartyJoinerSeed();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testSoloDungeonNpcReferencePromotesToPartyJoinerSeed();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testConflictingLocalIdsStillTriggerRemotePlayerSeed();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testSafeRemotePlayerIdsRelayMovementWithoutCollision();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testOutdoorHostileIncrementalUpdatesDoNotRelayToPeers();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testOutdoorHostileIncrementalUpdatesRelayToPartyPeers();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDungeonJoinerReplaysStartedRoomEventsFromPartyAnchor();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testTutorialDungeonPrimeRoomEventsFlushAfterSelfSpawn();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDungeonJoinerSeedsVisibleHostilesImmediatelyAfterRoomReplay();

        GlobalState.levelEntities.clear();
        GlobalState.levelStateByScope.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDungeonJoinerReplaysStoredLevelStateFromScope();
    } finally {
        GlobalState.levelEntities = levelEntities;
        GlobalState.levelStateByScope = levelStateByScope;
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.partyGroups = partyGroups;
        GlobalState.partyByMember = partyByMember;
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
