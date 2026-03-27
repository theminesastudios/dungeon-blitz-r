import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { EntityHandler } from '../handlers/EntityHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

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
}

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

function parseDestroyEntityId(payload: Buffer): number {
    const br = new BitReader(payload);
    return br.readMethod4();
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

function testOutdoorPartyPeerSeedDestroysMatchingLocalDuplicateAfterCanonicalSeed(): void {
    const owner = createFakeClient('Alpha');
    const watcher = createFakeClient('Beta');

    owner.currentLevel = 'NewbieRoad';
    watcher.currentLevel = 'NewbieRoad';
    owner.currentRoomId = 1;
    watcher.currentRoomId = 1;

    const canonical = {
        id: 2206,
        name: 'IntroGoblin',
        isPlayer: false,
        x: 120,
        y: 220,
        v: 0,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: owner.token,
        ownerPartyId: 78,
        roomId: owner.currentRoomId
    };
    const localDuplicate = {
        id: 3206,
        name: canonical.name,
        isPlayer: false,
        x: 122,
        y: 222,
        v: 0,
        team: canonical.team,
        entState: canonical.entState,
        clientSpawned: true,
        ownerToken: watcher.token,
        ownerPartyId: 78,
        roomId: watcher.currentRoomId
    };

    watcher.entities.set(localDuplicate.id, { ...localDuplicate });
    watcher.knownEntityIds.add(localDuplicate.id);
    GlobalState.levelEntities.set('NewbieRoad', new Map([[canonical.id, canonical]]));
    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(watcher.token, watcher as never);
    GlobalState.partyByMember.set('alpha', 78);
    GlobalState.partyByMember.set('beta', 78);

    const known = EntityHandler.ensureEntityKnown(watcher as never, 'NewbieRoad', canonical.id);

    assert.equal(known, true, 'party watcher should receive the canonical outdoor hostile');
    assert.deepEqual(
        watcher.sentPackets.map((packet) => packet.id),
        [0x0F, 0x0D],
        'canonical hostile should seed before the watcher local duplicate is destroyed'
    );
    assert.equal(parseDestroyEntityId(watcher.sentPackets[1]!.payload), localDuplicate.id);
    assert.equal(watcher.entities.has(localDuplicate.id), false, 'watcher local duplicate should be removed from local cache');
    assert.equal(watcher.knownEntityIds.has(localDuplicate.id), false, 'watcher local duplicate should be forgotten');
    assert.equal(watcher.knownEntityIds.has(canonical.id), true, 'watcher should keep the canonical hostile known');
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

function testSendExistingVisibleClientSpawnEntitiesPrunesStaleOutdoorOwnerBeforeSeed(): void {
    const owner = createFakeClient('Alpha');
    const joiner = createFakeClient('Beta');

    owner.currentLevel = 'NewbieRoad';
    joiner.currentLevel = 'NewbieRoad';
    owner.currentRoomId = 2;
    joiner.currentRoomId = 2;

    const stale = {
        id: 2553,
        name: 'IntroGoblin',
        isPlayer: false,
        x: 100,
        y: 200,
        v: 0,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: 99999,
        ownerPartyId: 99,
        roomId: 2
    };
    const canonical = {
        id: 2554,
        name: 'IntroGoblin',
        isPlayer: false,
        x: 140,
        y: 240,
        v: 0,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: owner.token,
        ownerPartyId: 99,
        roomId: 2
    };

    GlobalState.levelEntities.set('NewbieRoad', new Map([
        [stale.id, stale],
        [canonical.id, canonical]
    ]));
    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    GlobalState.partyByMember.set('alpha', 99);
    GlobalState.partyByMember.set('beta', 99);

    (EntityHandler as any).sendExistingVisibleClientSpawnEntitiesToJoiner(joiner as never);

    const levelMap = GlobalState.levelEntities.get('NewbieRoad');
    assert.equal(levelMap?.has(stale.id), false, 'stale outdoor owner entity should be pruned from the shared level map');
    assert.equal(levelMap?.has(canonical.id), true, 'active outdoor owner entity should remain');
    assert.deepEqual(joiner.sentPackets.map((packet) => packet.id), [0x0D, 0x0F]);
    assert.equal(parseDestroyEntityId(joiner.sentPackets[0]!.payload), stale.id, 'stale entity should be destroyed before seeding canonical state');
    assert.equal(joiner.knownEntityIds.has(canonical.id), true, 'joiner should only keep the canonical outdoor entity');
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

function main(): void {
    ensureLevelConfigLoaded();

    const levelEntities = new Map(GlobalState.levelEntities);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const partyByMember = new Map(GlobalState.partyByMember);
    GlobalState.levelEntities.clear();
    GlobalState.sessionsByToken.clear();
    GlobalState.partyByMember.clear();

    try {
        testOutdoorLevelsUseClientSpawn();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testClientSpawnLevelsDoNotSendServerNpcCopies();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testClientSpawnLevelsStartEmptyWithoutServerNpcInit();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testOutdoorHostileClientSpawnIsNotSeededToPeers();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testOutdoorHostileClientSpawnSeedsToPartyPeers();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testOutdoorPartyPeerSeedDestroysMatchingLocalDuplicateAfterCanonicalSeed();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDungeonHostileClientSpawnSeedsToPartyPeersOnly();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDungeonPartyAuthoritySuppressesDuplicateHostileSpawns();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testOutdoorPartyAuthoritySuppressesDuplicateNpcSpawns();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDungeonPartyAuthoritySuppressesDuplicateTargetDummySpawns();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testCraftTownTutorialSameIdDuplicateDoesNotForceDestroyRespawn();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testSoloDungeonHostileReferencePromotesToPartyJoinerSeed();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testSoloDungeonNpcReferencePromotesToPartyJoinerSeed();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testSendExistingVisibleClientSpawnEntitiesPrunesStaleOutdoorOwnerBeforeSeed();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testConflictingLocalIdsStillTriggerRemotePlayerSeed();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testSafeRemotePlayerIdsRelayMovementWithoutCollision();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testOutdoorHostileIncrementalUpdatesDoNotRelayToPeers();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testOutdoorHostileIncrementalUpdatesRelayToPartyPeers();
    } finally {
        GlobalState.levelEntities = levelEntities;
        GlobalState.sessionsByToken = sessionsByToken;
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
