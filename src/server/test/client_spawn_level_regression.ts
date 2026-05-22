import { strict as assert } from 'assert';
import * as path from 'path';
import { createKeepTutorialState } from '../core/Client';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { Entity } from '../core/Entity';
import { CombatHandler } from '../handlers/CombatHandler';
import { EntityHandler } from '../handlers/EntityHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { NpcLoader } from '../data/NpcLoader';
import { getCraftTownHomeInstanceId } from '../utils/HomeVisitGuard';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    character: { name: string; level?: number; xp?: number };
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    userId: number | null;
    mountTransferGraceUntil: number;
    syncAnchorStartedAt: number;
    startedRoomEvents: Set<string>;
    triggeredLevelStates: Set<string>;
    knownEntityIds: Set<number>;
    entityIdAliases: Map<number, number>;
    sharedEntityRemoteUpdateDeferredIds: Set<number>;
    entities: Map<number, any>;
    keepTutorialState?: ReturnType<typeof createKeepTutorialState> | null;
    clientSpawnConfirmed?: boolean;
    clientSpawnFallbackTimer?: NodeJS.Timeout | null;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

let nextFakeToken = 1000;
const GOBLIN_RIVER_LEVELS = ['GoblinRiverDungeon', 'GoblinRiverDungeonHard'] as const;
const CRAFT_TOWN_HELPER_IDS = [1073605, 1139141, 1335749, 1401285, 1270213, 1532357, 1597893, 1466821];


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

function createFakeClient(name: string, level: number = 1): FakeClient {
    const sentPackets: SentPacket[] = [];

    return {
        token: nextFakeToken++,
        character: { name, level },
        currentLevel: 'NewbieRoad',
        levelInstanceId: '',
        currentRoomId: 1,
        playerSpawned: true,
        clientEntID: 0,
        userId: 1,
        mountTransferGraceUntil: 0,
        syncAnchorStartedAt: 0,
        startedRoomEvents: new Set<string>(),
        triggeredLevelStates: new Set<string>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        sharedEntityRemoteUpdateDeferredIds: new Set<number>(),
        entities: new Map<number, any>(),
        keepTutorialState: null,
        clientSpawnConfirmed: false,
        clientSpawnFallbackTimer: null,
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

function buildDestroyEntityPayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod15(true);
    return bb.toBuffer();
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

function decodeNpcBubblePacket(payload: Buffer): { npcId: number; text: string } {
    const br = new BitReader(payload);
    return {
        npcId: br.readMethod4(),
        text: br.readMethod13()
    };
}

function readSerializedRemotePlayer(payload: Buffer): {
    id: number;
    name: string;
    level: number;
    masterClass: number;
    velocity: number;
    healthDelta: number;
    buffCount: number;
} {
    const br = new BitReader(payload);
    const id = br.readMethod4();
    const name = br.readMethod13();
    assert.equal(br.readMethod15(), true, 'remote player payload should include player customization');

    br.readMethod13(); // class
    br.readMethod13(); // gender
    br.readMethod13(); // head
    br.readMethod13(); // hair
    br.readMethod13(); // mouth
    br.readMethod13(); // face
    br.readMethod6(24);
    br.readMethod6(24);
    br.readMethod6(24);
    br.readMethod6(24);

    for (let slot = 0; slot < 6; slot++) {
        if (!br.readMethod15()) {
            continue;
        }

        br.readMethod6(11);
        br.readMethod6(2);
        br.readMethod6(16);
        br.readMethod6(16);
        br.readMethod6(16);
        br.readMethod6(8);
        br.readMethod6(8);
    }

    br.readMethod45(); // x
    br.readMethod45(); // y
    const velocity = br.readMethod45();
    br.readMethod6(Entity.TEAM_BITS);
    assert.equal(br.readMethod15(), true, 'remote player payload should take the player branch');
    br.readMethod15(); // idle reset
    br.readMethod15(); // spawn fx
    br.readMethod6(7); // active pet
    br.readMethod6(6); // pet special
    br.readMethod6(7); // mount
    br.readMethod6(5); // consumable

    if (br.readMethod15()) {
        for (let index = 0; index < 3; index++) {
            br.readMethod6(7);
            br.readMethod6(6);
        }
    }

    for (let index = 0; index < 3; index++) {
        if (br.readMethod15()) {
            br.readMethod13();
        }
    }

    if (br.readMethod15()) {
        br.readMethod4();
    }
    if (br.readMethod15()) {
        br.readMethod4();
    }

    br.readMethod6(Entity.STATE_BITS);
    br.readMethod15(); // facing left

    const level = br.readMethod6(Entity.MAX_CHAR_LEVEL_BITS);
    const masterClass = br.readMethod6(4);
    if (br.readMethod15()) {
        throw new Error('test fixture should not include talent data');
    }

    const healthDelta = br.readMethod45();
    const buffCount = br.readMethod4();
    return { id, name, level, masterClass, velocity, healthDelta, buffCount };
}

function createGoblinRiverHostile(
    id: number,
    name: string,
    ownerToken: number,
    ownerPartyId: number,
    roomId: number,
    x: number = 120,
    y: number = 220
): any {
    return {
        id,
        name,
        isPlayer: false,
        x,
        y,
        v: 0,
        team: 2,
        renderDepthOffset: 0,
        entState: 0,
        clientSpawned: true,
        ownerToken,
        ownerPartyId,
        roomId
    };
}

function testRemotePlayerEntityPacketMatchesClientReadOrder(): void {
    const payload = Entity.serialize({
        id: 5012,
        name: 'Fleerpuh',
        isPlayer: true,
        class: 'Paladin',
        gender: 'male',
        headSet: 'Head01',
        hairSet: 'Hair01',
        mouthSet: 'Mouth01',
        faceSet: 'Face01',
        hairColor: 0x111111,
        skinColor: 0x222222,
        shirtColor: 0x333333,
        pantColor: 0x444444,
        equippedGears: [],
        x: 123,
        y: 456,
        v: 0,
        team: 1,
        idleReset: false,
        spawnFx: false,
        activePet: {
            petID: 0,
            special_id: 0
        },
        equippedMount: 0,
        activeConsumableId: 0,
        abilities: [],
        characterName: '',
        dramaAnim: '',
        sleepAnim: '',
        summonerId: 0,
        powerId: 0,
        entState: 0,
        facingLeft: true,
        noJumpAttack: true,
        level: 37,
        masterClass: 3,
        talents: [],
        healthDelta: 9,
        buffs: []
    } as any);

    assert.deepEqual(readSerializedRemotePlayer(payload), {
        id: 5012,
        name: 'Fleerpuh',
        level: 37,
        masterClass: 3,
        velocity: 0,
        healthDelta: 9,
        buffCount: 0
    });
}

function testNewlyRelevantEntitySeedsClearVelocity(): void {
    const client = createFakeClient('Watcher');
    const movingPlayer = {
        id: 5013,
        name: 'Runner',
        isPlayer: true,
        class: 'Paladin',
        gender: 'male',
        x: 321,
        y: 654,
        v: 190,
        team: 1,
        entState: 0,
        level: 12,
        masterClass: 1,
        equippedGears: [],
        abilities: [],
        talents: [],
        buffs: []
    };

    EntityHandler.sendEntity(client as never, movingPlayer as never);

    const packet = client.sentPackets.find((sent) => sent.id === 0x0F);
    assert.ok(packet);
    assert.equal(
        readSerializedRemotePlayer(packet!.payload).velocity,
        0,
        'server-seeded newly relevant entities should not trip the client hidden-until-movement flag'
    );
}

function testConfiguredLevelsUseClientSpawn(): void {
    for (const levelName of [
        'CraftTown',
        'BridgeTown',
        'BridgeTownHard',
        ...GOBLIN_RIVER_LEVELS,
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

function testCraftTownPlayerSpawnsAreScopedByHomeOwner(): void {
    const alice = createFakeClient('Alice');
    const bob = createFakeClient('Bob');
    const aliceVisitor = createFakeClient('AliceVisitor');

    alice.currentLevel = 'CraftTown';
    bob.currentLevel = 'CraftTown';
    aliceVisitor.currentLevel = 'CraftTown';
    alice.levelInstanceId = getCraftTownHomeInstanceId({ name: 'Alice' } as never);
    bob.levelInstanceId = getCraftTownHomeInstanceId({ name: 'Bob' } as never);
    aliceVisitor.levelInstanceId = getCraftTownHomeInstanceId(
        { name: 'AliceVisitor' } as never,
        { name: 'Alice' } as never
    );
    alice.clientEntID = 701;
    bob.clientEntID = 702;
    aliceVisitor.clientEntID = 703;
    alice.entities.set(701, { id: 701, x: 100, y: 200, isPlayer: true });
    bob.entities.set(702, { id: 702, x: 300, y: 400, isPlayer: true });
    aliceVisitor.entities.set(703, { id: 703, x: 500, y: 600, isPlayer: true });

    GlobalState.sessionsByToken.set(alice.token, alice as never);
    GlobalState.sessionsByToken.set(bob.token, bob as never);
    GlobalState.sessionsByToken.set(aliceVisitor.token, aliceVisitor as never);

    EntityHandler.refreshPlayerSnapshot(alice as never);

    assert.equal(
        bob.sentPackets.some((packet) => packet.id === 0x0F),
        false,
        'players in different owners Homes should not receive each other player spawns'
    );
    assert.equal(
        aliceVisitor.sentPackets.some((packet) => packet.id === 0x0F),
        true,
        'visitors to the same owner Home should receive that owner player spawn'
    );
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

function testGoblinRiverClientSpawnLevelsPruneServerNpcCopies(): void {
    for (const levelName of GOBLIN_RIVER_LEVELS) {
        const client = createFakeClient('Watcher');
        client.currentLevel = levelName;

        const levelMap = new Map<number, any>([
            [9101, { id: 9101, name: 'ServerGoblin', isPlayer: false, clientSpawned: false }],
            [9102, { id: 9102, name: 'ClientGoblin', isPlayer: false, clientSpawned: true }],
            [9103, { id: 9103, name: 'OtherPlayer', isPlayer: true }]
        ]);

        GlobalState.levelEntities.set(levelName, levelMap);

        EntityHandler.sendInitialLevelEntities(client as never, levelName);

        assert.equal(levelMap.has(9101), false, `${levelName} should prune stale server-seeded hostiles`);
        assert.equal(levelMap.has(9102), true, `${levelName} should preserve canonical client-spawn hostiles`);
        assert.equal(levelMap.has(9103), true, `${levelName} should preserve players`);
        assert.equal(client.sentPackets.length, 0, `${levelName} should not seed server NPC packets`);
    }
}

function testGoblinRiverClientSpawnLevelsStartEmptyWithoutServerNpcInit(): void {
    for (const levelName of GOBLIN_RIVER_LEVELS) {
        const client = createFakeClient('Watcher');
        client.currentLevel = levelName;

        EntityHandler.sendInitialLevelEntities(client as never, levelName);

        const levelMap = GlobalState.levelEntities.get(levelName);
        assert.ok(levelMap, `${levelName} should create a level state bucket`);
        assert.equal(levelMap?.size, 0, `${levelName} should start empty until the leader client spawns hostiles`);
        assert.equal(client.sentPackets.length, 0, `${levelName} should not send server NPCs on join`);
    }
}

function testOutdoorHostileClientSpawnIsNotSeededToPeers(): void {
    const client = createFakeClient('Watcher');
    client.currentLevel = 'NewbieRoad';

    const hostile: any = {
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

function testOutdoorHostileClientSpawnStaysPrivateToPartyPeers(): void {
    const owner = createFakeClient('Alpha');
    const watcher = createFakeClient('Beta');

    owner.currentLevel = 'NewbieRoad';
    watcher.currentLevel = 'NewbieRoad';
    owner.currentRoomId = 1;
    watcher.currentRoomId = 7;

    const hostile: any = {
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

    assert.equal(known, false, 'party peers should not receive outdoor hostile seeds');
    assert.deepEqual(watcher.sentPackets.map((packet) => packet.id), []);
    assert.equal(watcher.knownEntityIds.has(hostile.id), false);
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

    const hostile: any = {
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
    assert.deepEqual(follower.sentPackets.map((packet) => packet.id), []);
    assert.equal(follower.knownEntityIds.has(canonical.id), true);
    assert.equal(follower.knownEntityIds.has(3301), false);
    assert.equal(follower.entities.get(3301)?.sharedCanonicalId, canonical.id);
    assert.equal(follower.entityIdAliases.get(3301), canonical.id);
}

function testDungeonHostileSpawnBroadcastWaitsForJoinerCanonicalAdoption(): void {
    const owner = createFakeClient('Alpha');
    const follower = createFakeClient('Beta');

    owner.currentLevel = 'TutorialDungeon';
    follower.currentLevel = 'TutorialDungeon';
    owner.currentRoomId = 4;
    follower.currentRoomId = 4;

    GlobalState.levelEntities.set('TutorialDungeon', new Map<number, any>());
    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(follower.token, follower as never);
    GlobalState.partyByMember.set('alpha', 93);
    GlobalState.partyByMember.set('beta', 93);

    const canonical = {
        id: 2311,
        name: 'IntroGoblin',
        isPlayer: false,
        x: 120,
        y: 220,
        v: 0,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: owner.token,
        ownerPartyId: 93,
        roomId: owner.currentRoomId
    };

    GlobalState.levelEntities.get('TutorialDungeon')?.set(canonical.id, canonical);
    owner.entities.set(canonical.id, canonical);
    owner.knownEntityIds.add(canonical.id);
    (EntityHandler as any).broadcastToLevel(
        owner as never,
        (EntityHandler as any).buildEntityFullUpdatePayload(canonical),
        canonical
    );

    assert.deepEqual(
        follower.sentPackets.map((packet) => packet.id),
        [],
        'live shared hostile spawn should not be pushed before the follower adopts the canonical entity'
    );

    const duplicate = {
        id: 3311,
        name: canonical.name,
        isPlayer: false,
        x: 122,
        y: 218,
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
        'TutorialDungeon',
        GlobalState.levelEntities.get('TutorialDungeon'),
        duplicate
    );

    assert.equal(suppressed, true);
    assert.deepEqual(follower.sentPackets.map((packet) => packet.id), []);
    assert.equal(follower.knownEntityIds.has(2311), true);
    assert.equal(follower.entityIdAliases.get(3311), 2311);
    assert.equal(follower.entities.get(3311)?.sharedCanonicalId, 2311);
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
    assert.deepEqual(follower.sentPackets.map((packet) => packet.id), []);
    assert.equal(follower.knownEntityIds.has(canonical.id), true);
    assert.equal(follower.knownEntityIds.has(3302), false);
    assert.equal(follower.entities.get(3302)?.sharedCanonicalId, canonical.id);
    assert.equal(follower.entityIdAliases.get(3302), canonical.id);
}

function testOutdoorNpcSpawnsStayPrivateToOwner(): void {
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

    const known = EntityHandler.ensureEntityKnown(follower as never, 'NewbieRoad', canonical.id);
    const suppressed = (EntityHandler as any).suppressDuplicateSharedClientSpawn(
        follower as never,
        'NewbieRoad',
        GlobalState.levelEntities.get('NewbieRoad'),
        duplicate
    );

    const levelMap = GlobalState.levelEntities.get('NewbieRoad');
    assert.equal(known, false, 'party peers should not receive private outdoor NPC seeds');
    assert.equal(suppressed, false, 'private outdoor NPC spawns should not collapse to a party canonical entity');
    assert.equal(levelMap?.size, 1, 'the owner NPC should remain isolated in the shared level map');
    assert.deepEqual(follower.sentPackets, [], 'private outdoor NPCs should not emit destroy/adopt packets to party peers');
    assert.equal(follower.knownEntityIds.has(canonical.id), false);
    assert.equal(follower.entities.has(3401), false);
}

function testOutdoorHostileSpawnsStayPrivateToOwner(): void {
    const owner = createFakeClient('Alpha');
    const follower = createFakeClient('Beta');

    owner.currentLevel = 'NewbieRoad';
    follower.currentLevel = 'NewbieRoad';
    owner.currentRoomId = 2;
    follower.currentRoomId = 2;

    const canonical = {
        id: 2402,
        name: 'IntroGoblin',
        isPlayer: false,
        x: 418,
        y: 568,
        v: 0,
        team: 2,
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
        id: 3402,
        name: canonical.name,
        isPlayer: false,
        x: 420,
        y: 570,
        v: 0,
        team: canonical.team,
        entState: canonical.entState,
        clientSpawned: true,
        ownerToken: follower.token,
        ownerPartyId: 93,
        roomId: follower.currentRoomId
    };

    const known = EntityHandler.ensureEntityKnown(follower as never, 'NewbieRoad', canonical.id);
    const suppressed = (EntityHandler as any).suppressDuplicateSharedClientSpawn(
        follower as never,
        'NewbieRoad',
        GlobalState.levelEntities.get('NewbieRoad'),
        duplicate
    );

    const levelMap = GlobalState.levelEntities.get('NewbieRoad');
    assert.equal(known, false, 'party peers should not receive private outdoor hostile seeds');
    assert.equal(suppressed, false, 'private outdoor hostile spawns should not collapse to a party canonical entity');
    assert.equal(levelMap?.size, 1, 'the owner hostile should remain isolated in the shared level map');
    assert.deepEqual(follower.sentPackets, [], 'private outdoor hostiles should not emit destroy/adopt packets to party peers');
    assert.equal(follower.knownEntityIds.has(canonical.id), false);
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
    assert.deepEqual(follower.sentPackets.map((packet) => packet.id), []);
    assert.equal(follower.knownEntityIds.has(canonical.id), true);
    assert.equal(follower.entities.get(3450)?.sharedCanonicalId, canonical.id);
    assert.equal(follower.entityIdAliases.get(3450), canonical.id);
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

function testCraftTownTutorialTracksClientSpawnBoardHelpers(): void {
    const client = createFakeClient('Alpha');
    client.currentLevel = 'CraftTownTutorial';
    client.keepTutorialState = createKeepTutorialState();

    (EntityHandler as any).handleCraftTownTutorialEntitySeen(
        client as never,
        CRAFT_TOWN_HELPER_IDS[0],
        'GoblinDagger',
        { dramaAnim: 'Board' }
    );
    (EntityHandler as any).handleCraftTownTutorialEntitySeen(
        client as never,
        CRAFT_TOWN_HELPER_IDS[0],
        'GoblinDagger',
        { dramaAnim: 'Board' }
    );
    (EntityHandler as any).handleCraftTownTutorialEntitySeen(
        client as never,
        2602,
        'GoblinDagger',
        { dramaAnim: 'Board' }
    );
    (EntityHandler as any).handleCraftTownTutorialEntitySeen(
        client as never,
        CRAFT_TOWN_HELPER_IDS[1],
        'GoblinDagger',
        { dramaAnim: 'Board' }
    );

    assert.deepEqual(client.keepTutorialState?.helperEntityIds, [CRAFT_TOWN_HELPER_IDS[0], CRAFT_TOWN_HELPER_IDS[1]]);
}

function testCraftTownTutorialBossIntroUsesRunLoopThoughts(): void {
    const client = createFakeClient('Alpha');
    client.currentLevel = 'CraftTownTutorial';
    client.levelInstanceId = 'keep-run';
    client.currentRoomId = 1;
    client.keepTutorialState = createKeepTutorialState();
    (client as any).character = {
        name: 'Alpha',
        CurrentLevel: { name: 'CraftTownTutorial', x: 80, y: 1450 }
    };

    client.entities.set(2603, { id: 2603, name: 'IntroParrot', x: 0, y: 743, entState: 1, facingLeft: false });
    client.entities.set(2604, { id: 2604, name: 'NPCHomeGemMerchant', x: 1095, y: 1447, entState: 1, facingLeft: true });
    client.entities.set(2605, { id: 2605, name: 'IntroGoblinShamanHood', x: 49, y: 1459, entState: 2, facingLeft: false });

    GlobalState.sessionsByToken.set(client.token, client as never);

    (LevelHandler as any).sendCraftTownTutorialBossIntroSkit(client as never, client.keepTutorialState, 2605);

    const thoughts = client.sentPackets
        .filter((packet) => packet.id === 0x76)
        .map((packet) => decodeNpcBubblePacket(packet.payload).text);

    assert.equal(thoughts.includes('<Run Loop><Goto Red 2> Stop the human!'), true);
    assert.equal(thoughts.includes("<End> Don't let him|her take our home!"), true);
}

function testCraftTownTutorialServerFallbackDoesNotSeedInitialHostiles(): void {
    const client = createFakeClient('Alpha');
    client.currentLevel = 'CraftTownTutorial';
    client.levelInstanceId = 'keep-fallback';
    client.currentRoomId = 1;
    client.keepTutorialState = createKeepTutorialState();
    (client as any).character = {
        name: 'Alpha',
        CurrentLevel: { name: 'CraftTownTutorial', x: 80, y: 1450 }
    };

    (LevelHandler as any).spawnCraftTownTutorialServerFallback(client as never);

    const levelMap = GlobalState.levelEntities.get('CraftTownTutorial#keep-fallback');
    assert.ok(levelMap, 'fallback should still seed a scoped level map');

    const hostileCount = Array.from(levelMap!.values()).filter((entity) => Number(entity?.team ?? 0) === 2).length;
    assert.equal(hostileCount, 0, 'fallback should not seed the authored goblin population');

    const sentHostiles = client.sentPackets
        .filter((packet) => packet.id === 0x0F)
        .map((packet) => {
            const br = new BitReader(packet.payload);
            br.readMethod4();
            br.readMethod24();
            br.readMethod24();
            br.readMethod24();
            br.readMethod26();
            return br.readMethod20(2);
        })
        .filter((team) => team === 2);
    assert.deepEqual(sentHostiles, [], 'fallback should not send hostile spawn packets up front');
}

function testCraftTownTutorialBossRecoveryActivatesTrackedHelpersImmediately(): void {
    const client = createFakeClient('Alpha');
    client.currentLevel = 'CraftTownTutorial';
    client.levelInstanceId = 'keep-run';
    client.currentRoomId = 1;
    client.keepTutorialState = createKeepTutorialState();
    client.keepTutorialState.bossEntitySeen = 2701;
    client.keepTutorialState.bossEntitySource = 'fallback';
    client.keepTutorialState.helperEntityIds = CRAFT_TOWN_HELPER_IDS.slice(0, 3);
    (client as any).character = {
        name: 'Alpha',
        CurrentLevel: { name: 'CraftTownTutorial', x: 80, y: 1450 }
    };

    const boss = { id: 2701, name: 'IntroGoblinShamanHood', x: 49, y: 1459, entState: 2, untargetable: true, facingLeft: false };
    const helperOne = { id: CRAFT_TOWN_HELPER_IDS[0], name: 'GoblinDagger', x: -1449, y: 1399, entState: 2, untargetable: true, dramaAnim: 'Board', facingLeft: false };
    const helperTwo = { id: CRAFT_TOWN_HELPER_IDS[1], name: 'GoblinDagger', x: -1349, y: 1399, entState: 2, untargetable: true, dramaAnim: 'Board', facingLeft: false };
    const helperThree = { id: CRAFT_TOWN_HELPER_IDS[2], name: 'GoblinDagger', x: 269, y: 1459, entState: 2, untargetable: true, dramaAnim: 'Board', facingLeft: false };

    client.entities.set(boss.id, boss);
    const levelMap = new Map<number, any>([
        [boss.id, boss],
        [helperOne.id, helperOne],
        [helperTwo.id, helperTwo],
        [helperThree.id, helperThree]
    ]);

    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.levelEntities.set('CraftTownTutorial#keep-run', levelMap);

    (LevelHandler as any).armCraftTownTutorialBossRecovery(client as never, boss.id);

    assert.equal(levelMap.get(helperOne.id)?.entState, 0);
    assert.equal(levelMap.get(helperOne.id)?.untargetable, false);
    assert.equal(levelMap.get(helperOne.id)?.dramaAnim, '');
    assert.equal(levelMap.get(helperTwo.id)?.entState, 0);
    assert.equal(levelMap.get(helperTwo.id)?.untargetable, false);
    assert.equal(levelMap.get(helperThree.id)?.entState, 0);
    assert.equal(levelMap.get(helperThree.id)?.untargetable, false);
    assert.equal(client.entities.get(boss.id)?.entState, 0);
    assert.equal(client.entities.get(boss.id)?.untargetable, false);
}

function testCraftTownTutorialBossRecoverySeedsClientTrackedHelpersImmediately(): void {
    const client = createFakeClient('Alpha');
    client.currentLevel = 'CraftTownTutorial';
    client.levelInstanceId = 'keep-client-run';
    client.currentRoomId = 1;
    client.keepTutorialState = createKeepTutorialState();
    client.keepTutorialState.bossEntitySeen = 2711;
    client.keepTutorialState.bossEntitySource = 'client';
    client.keepTutorialState.helperEntityIds = CRAFT_TOWN_HELPER_IDS.slice(0, 3);
    (client as any).character = {
        name: 'Alpha',
        CurrentLevel: { name: 'CraftTownTutorial', x: 80, y: 1450 }
    };

    const boss = { id: 2711, name: 'IntroGoblinShamanHood', x: 49, y: 1459, entState: 2, untargetable: true, facingLeft: false };
    const helperOne = { id: CRAFT_TOWN_HELPER_IDS[0], name: 'GoblinDagger', x: -1449, y: 1399, entState: 2, untargetable: true, dramaAnim: 'Board', facingLeft: false };
    const helperTwo = { id: CRAFT_TOWN_HELPER_IDS[1], name: 'GoblinDagger', x: -1349, y: 1399, entState: 2, untargetable: true, dramaAnim: 'Board', facingLeft: false };
    const helperThree = { id: CRAFT_TOWN_HELPER_IDS[2], name: 'GoblinDagger', x: 269, y: 1459, entState: 2, untargetable: true, dramaAnim: 'Board', facingLeft: false };

    client.entities.set(boss.id, boss);
    const levelMap = new Map<number, any>([
        [boss.id, boss],
        [helperOne.id, helperOne],
        [helperTwo.id, helperTwo],
        [helperThree.id, helperThree]
    ]);

    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.levelEntities.set('CraftTownTutorial#keep-client-run', levelMap);

    (LevelHandler as any).armCraftTownTutorialBossRecovery(client as never, boss.id);

    assert.deepEqual(client.keepTutorialState?.helperWaveActiveIds, CRAFT_TOWN_HELPER_IDS.slice(0, 3));
    assert.equal(levelMap.get(helperOne.id)?.entState, 0);
    assert.equal(levelMap.get(helperTwo.id)?.entState, 0);
    assert.equal(levelMap.get(helperThree.id)?.entState, 0);
}

function testCraftTownTutorialBossRecoveryIgnoresTrackedStrayHelpers(): void {
    const client = createFakeClient('Alpha');
    client.currentLevel = 'CraftTownTutorial';
    client.levelInstanceId = 'keep-client-stray';
    client.currentRoomId = 1;
    client.keepTutorialState = createKeepTutorialState();
    client.keepTutorialState.bossEntitySeen = 2711;
    client.keepTutorialState.bossEntitySource = 'client';
    client.keepTutorialState.helperEntityIds = [7310194];
    (client as any).character = {
        name: 'Alpha',
        CurrentLevel: { name: 'CraftTownTutorial', x: 80, y: 1450 }
    };

    const boss = { id: 2711, name: 'IntroGoblinShamanHood', x: 49, y: 1459, entState: 2, untargetable: true, facingLeft: false };
    const strayHelper = { id: 7310194, name: 'GoblinDagger', x: -2000, y: 1399, entState: 2, untargetable: true, dramaAnim: 'Board', facingLeft: false };

    client.entities.set(boss.id, boss);
    client.entities.set(strayHelper.id, { ...strayHelper });

    const levelMap = new Map<number, any>([
        [boss.id, boss],
        [strayHelper.id, strayHelper]
    ]);

    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.levelEntities.set('CraftTownTutorial#keep-client-stray', levelMap);

    (LevelHandler as any).armCraftTownTutorialBossRecovery(client as never, boss.id);

    assert.deepEqual(
        client.keepTutorialState?.helperWaveActiveIds,
        [],
        'boss recovery should not server-spawn a helper wave when only a stray tracked goblin exists'
    );
    assert.equal(
        client.keepTutorialState?.helperEntityIds.includes(strayHelper.id),
        false,
        'stray boarded goblins should not remain in the helper rotation'
    );
    assert.equal(levelMap.get(strayHelper.id)?.entState, 2, 'stray helper should remain boarded and inactive');
    assert.equal(levelMap.get(strayHelper.id)?.untargetable, true, 'stray helper should stay untargetable');
}

function testCraftTownTutorialBossIntroStillTriggersAfterClientSpawnConfirmation(): void {
    const client = createFakeClient('Alpha');
    client.currentLevel = 'CraftTownTutorial';
    client.levelInstanceId = 'keep-client';
    client.currentRoomId = 1;
    client.keepTutorialState = createKeepTutorialState();
    client.clientSpawnConfirmed = true;
    (client as any).character = {
        name: 'Alpha',
        CurrentLevel: { name: 'CraftTownTutorial', x: 80, y: 1450 }
    };

    client.entities.set(2801, { id: 2801, name: 'IntroParrot', x: 0, y: 743, entState: 1, facingLeft: false });
    client.entities.set(2802, { id: 2802, name: 'NPCHomeGemMerchant', x: 1095, y: 1447, entState: 1, facingLeft: true });
    client.entities.set(2803, { id: 2803, name: 'GoblinDagger', x: 960, y: 1459, entState: 0, facingLeft: false });

    const levelMap = new Map<number, any>([
        [2801, client.entities.get(2801)],
        [2802, client.entities.get(2802)],
        [2803, client.entities.get(2803)]
    ]);

    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.levelEntities.set('CraftTownTutorial#keep-client', levelMap);

    (LevelHandler as any).maybeTriggerCraftTownTutorialBossIntro(client as never);

    assert.equal(client.keepTutorialState?.bossIntroForced, true);
    assert.equal(client.keepTutorialState?.bossRecoveryArmed, true);
    assert.equal(client.keepTutorialState?.helperEntityIds.length, 0);
    assert.equal(client.keepTutorialState?.bossEntitySeen, null);
}

function testCraftTownTutorialReinforcementsOnlyUseExistingHelpers(): void {
    const client = createFakeClient('Alpha');
    client.currentLevel = 'CraftTownTutorial';
    client.levelInstanceId = 'keep-seed';
    client.currentRoomId = 1;
    client.keepTutorialState = createKeepTutorialState();
    client.keepTutorialState.helperEntityIds = [CRAFT_TOWN_HELPER_IDS[0]];
    client.keepTutorialState.bossEntitySource = 'fallback';

    const loneHelper = {
        id: CRAFT_TOWN_HELPER_IDS[0],
        name: 'GoblinDagger',
        x: -1449,
        y: 1399,
        entState: 2,
        untargetable: true,
        dramaAnim: 'Board',
        facingLeft: false
    };

    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.levelEntities.set('CraftTownTutorial#keep-seed', new Map<number, any>([[loneHelper.id, loneHelper]]));

    (LevelHandler as any).summonCraftTownTutorialReinforcements(client as never);

    assert.deepEqual(client.keepTutorialState?.helperEntityIds, [CRAFT_TOWN_HELPER_IDS[0]]);
    assert.deepEqual(client.keepTutorialState?.helperWaveActiveIds, [CRAFT_TOWN_HELPER_IDS[0]]);
    assert.equal(client.entities.get(CRAFT_TOWN_HELPER_IDS[0])?.entState, 0);
    assert.equal(client.entities.get(CRAFT_TOWN_HELPER_IDS[0])?.untargetable, false);
    for (const helperId of CRAFT_TOWN_HELPER_IDS.slice(1)) {
        assert.equal(client.entities.has(helperId), false, `missing helper ${helperId} should not be server-spawned`);
    }
}

function testCraftTownTutorialKnownHelpersUseStateUpdatesInsteadOfDuplicateSpawns(): void {
    const client = createFakeClient('Alpha');
    client.currentLevel = 'CraftTownTutorial';
    client.levelInstanceId = 'keep-known';
    client.currentRoomId = 1;
    client.keepTutorialState = createKeepTutorialState();
    client.keepTutorialState.helperEntityIds = CRAFT_TOWN_HELPER_IDS.slice(0, 3);
    client.keepTutorialState.bossEntitySource = 'fallback';

    const levelMap = new Map<number, any>();
    for (const [index, helperId] of CRAFT_TOWN_HELPER_IDS.slice(0, 3).entries()) {
        const helper = {
            id: helperId,
            name: 'GoblinDagger',
            x: index * 80,
            y: 1459,
            entState: 2,
            untargetable: true,
            dramaAnim: 'Board',
            facingLeft: false
        };
        levelMap.set(helperId, helper);
        client.entities.set(helperId, { ...helper });
        client.knownEntityIds.add(helperId);
    }

    GlobalState.levelEntities.set('CraftTownTutorial#keep-known', levelMap);

    (LevelHandler as any).summonCraftTownTutorialReinforcements(client as never);

    assert.equal(client.sentPackets.filter((packet) => packet.id === 0x0F).length, 0, 'known helpers should not be re-spawned');
    assert.equal(client.sentPackets.filter((packet) => packet.id === 0xAE).length, 3, 'known helpers should receive untargetable updates');
    assert.equal(client.sentPackets.filter((packet) => packet.id === 0x07).length, 3, 'known helpers should receive state updates');
}

async function testCraftTownTutorialHelperWaveRespawnsAfterAllHelpersDie(): Promise<void> {
    const client = createFakeClient('Alpha');
    client.currentLevel = 'CraftTownTutorial';
    client.levelInstanceId = 'keep-wave';
    client.currentRoomId = 1;
    client.keepTutorialState = createKeepTutorialState();
    client.keepTutorialState.helperEntityIds = [...CRAFT_TOWN_HELPER_IDS];
    client.keepTutorialState.bossEntitySource = 'fallback';
    (client as any).character = {
        name: 'Alpha',
        CurrentLevel: { name: 'CraftTownTutorial', x: 80, y: 1450 }
    };

    const levelMap = new Map<number, any>();
    for (const [index, helperId] of CRAFT_TOWN_HELPER_IDS.entries()) {
        levelMap.set(helperId, {
            id: helperId,
            name: 'GoblinDagger',
            x: index * 80,
            y: 1459,
            entState: 2,
            untargetable: true,
            dramaAnim: 'Board',
            facingLeft: false
        });
    }

    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.levelEntities.set('CraftTownTutorial#keep-wave', levelMap);

    (LevelHandler as any).summonCraftTownTutorialReinforcements(client as never);

    const firstWave = [...(client.keepTutorialState?.helperWaveActiveIds ?? [])];
    assert.deepEqual(firstWave, CRAFT_TOWN_HELPER_IDS.slice(0, 3));

    for (const helperId of firstWave) {
        await CombatHandler.handleEntityDestroy(client as never, buildDestroyEntityPayload(helperId));
    }

    const secondWave = [...(client.keepTutorialState?.helperWaveActiveIds ?? [])];
    assert.equal(secondWave.length, 2, 'next helper wave should spawn two reinforcements');
    assert.equal(secondWave.some((helperId) => firstWave.includes(helperId)), false, 'next helper wave should rotate to fresh helpers');
    for (const helperId of secondWave) {
        assert.equal(client.entities.get(helperId)?.entState, 0, `helper ${helperId} should be active in the next wave`);
        assert.equal(client.entities.get(helperId)?.untargetable, false, `helper ${helperId} should be targetable in the next wave`);
    }
}

async function testCraftTownTutorialClientSourceHelperWaveRespawnsAfterAllHelpersDie(): Promise<void> {
    const client = createFakeClient('Alpha');
    client.currentLevel = 'CraftTownTutorial';
    client.levelInstanceId = 'keep-client-wave';
    client.currentRoomId = 1;
    client.keepTutorialState = createKeepTutorialState();
    client.keepTutorialState.bossEntitySeen = 2901;
    client.keepTutorialState.bossEntitySource = 'client';
    client.keepTutorialState.helperEntityIds = [...CRAFT_TOWN_HELPER_IDS];
    (client as any).character = {
        name: 'Alpha',
        CurrentLevel: { name: 'CraftTownTutorial', x: 80, y: 1450 }
    };

    const boss = {
        id: 2901,
        name: 'IntroGoblinShamanHood',
        x: 49,
        y: 1459,
        entState: 0,
        untargetable: false,
        facingLeft: false,
        health_delta: 0
    };
    const levelMap = new Map<number, any>([[boss.id, boss]]);

    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.levelEntities.set('CraftTownTutorial#keep-client-wave', levelMap);
    client.entities.set(boss.id, { ...boss });
    for (const [index, helperId] of CRAFT_TOWN_HELPER_IDS.entries()) {
        const helper = {
            id: helperId,
            name: 'GoblinDagger',
            x: index * 80,
            y: 1459,
            entState: 2,
            untargetable: true,
            dramaAnim: 'Board',
            facingLeft: false
        };
        client.entities.set(helperId, { ...helper });
        client.knownEntityIds.add(helperId);
    }

    (LevelHandler as any).summonCraftTownTutorialReinforcements(client as never);

    const firstWave = [...(client.keepTutorialState?.helperWaveActiveIds ?? [])];
    assert.deepEqual(firstWave, CRAFT_TOWN_HELPER_IDS.slice(0, 3));

    for (const helperId of firstWave) {
        await CombatHandler.handleEntityDestroy(client as never, buildDestroyEntityPayload(helperId));
    }

    const secondWave = [...(client.keepTutorialState?.helperWaveActiveIds ?? [])];
    assert.equal(secondWave.length, 2, 'client-source helper wave should respawn as a 2-goblin wave');
    assert.equal(secondWave.some((helperId) => firstWave.includes(helperId)), false, 'client-source helper wave should rotate to fresh helpers');
}

function testCraftTownTutorialClientSourceBossWoundedThoughtsPlay(): void {
    const client = createFakeClient('Alpha');
    client.currentLevel = 'CraftTownTutorial';
    client.levelInstanceId = 'keep-client-boss-lines';
    client.currentRoomId = 1;
    client.keepTutorialState = createKeepTutorialState();
    client.keepTutorialState.bossEntitySeen = 2951;
    client.keepTutorialState.bossEntitySource = 'client';
    client.keepTutorialState.helperEntityIds = [...CRAFT_TOWN_HELPER_IDS];
    (client as any).character = {
        name: 'Alpha',
        CurrentLevel: { name: 'CraftTownTutorial', x: 80, y: 1450 }
    };

    const boss = {
        id: 2951,
        name: 'IntroGoblinShamanHood',
        x: 49,
        y: 1459,
        entState: 0,
        untargetable: false,
        facingLeft: false,
        health_delta: 0
    };

    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.levelEntities.set('CraftTownTutorial#keep-client-boss-lines', new Map<number, any>([[boss.id, boss]]));
    client.entities.set(boss.id, { ...boss });

    LevelHandler.checkCraftTownTutorialBossHealth(client as never, boss.id, 1600);
    LevelHandler.checkCraftTownTutorialBossHealth(client as never, boss.id, 1600);

    const thoughts = client.sentPackets
        .filter((packet) => packet.id === 0x76)
        .map((packet) => decodeNpcBubblePacket(packet.payload).text);

    assert.equal(thoughts.includes('To me! Protect your home!'), true);
    assert.equal(thoughts.includes('I will not fall! To me, brothers!'), true);
}

function testSoloDungeonHostileReferencePromotesWithoutEagerJoinerSeed(): void {
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

    assert.deepEqual(
        joiner.sentPackets.map((packet) => packet.id),
        [],
        'live shared hostiles should wait for the joiner client spawn before canonical adoption to avoid duplicates'
    );
    assert.equal(canonical.ownerPartyId, 96, 'solo hostile reference should be promoted to party ownership once the dungeon becomes party-shared');
    assert.equal(joiner.knownEntityIds.has(canonical.id), false);
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

function testTutorialDungeonTraversalParrotStartsWhenPlayerReachesRoom(): void {
    const client = createFakeClient('Alpha');
    client.currentLevel = 'TutorialDungeon';
    client.currentRoomId = 0;
    client.clientEntID = 101;
    (client as any).character = {
        name: 'Alpha',
        CurrentLevel: { name: 'TutorialDungeon', x: 100, y: 2100 }
    };

    const player = { id: 101, name: 'Alpha', isPlayer: true, x: 100, y: 2100, team: 1 };
    const parrot = {
        id: 384606,
        name: 'IntroParrot',
        isPlayer: false,
        x: 7271,
        y: 2074,
        v: 0,
        team: 3,
        entState: 0,
        facingLeft: false
    };

    client.entities.set(player.id, player);
    client.entities.set(parrot.id, { ...parrot });
    client.knownEntityIds.add(parrot.id);
    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.levelEntities.set('TutorialDungeon', new Map<number, any>([
        [player.id, player],
        [parrot.id, parrot]
    ]));

    LevelHandler.primeTutorialRoomEvents(client as never);

    assert.equal(
        client.startedRoomEvents.has('TutorialDungeon:4'),
        false,
        'traversal tutorial room should not be consumed at dungeon entry'
    );

    player.x = 7200;
    player.y = 2100;
    client.sentPackets.length = 0;
    (LevelHandler as any).maybeTriggerTutorialDungeonDropTutorial(client as never, 7200, 2100, {});

    assert.deepEqual(
        client.sentPackets.filter((packet) => packet.id === 0xA5),
        [],
        'server should not synthesize the traversal room before the client reports it'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x07),
        false,
        'known TutorialDungeon parrot should not receive incremental movement before its display object is ready'
    );
    assert.equal(client.currentRoomId, 0);
    assert.equal(client.entities.get(384606)?.x, 7271);
    assert.equal(client.entities.get(384606)?.y, 2074);

    player.x = 7400;
    player.y = 2210;
    client.currentRoomId = 4;
    client.sentPackets.length = 0;
    (LevelHandler as any).maybeTriggerTutorialDungeonDropTutorial(
        client as never,
        7400,
        2210,
        { bJumping: true }
    );

    const followupRooms = client.sentPackets
        .filter((packet) => packet.id === 0xA5)
        .map((packet) => parseRoomEventStart(packet.payload).roomId);

    assert.deepEqual(followupRooms, [5]);
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x76),
        false,
        'TutorialDungeon traversal should not inject server-authored parrot dialog over the client tutorial scripts'
    );
}

async function testDeepgardDragonMiniBossIntroStartsOnTriggerCrossing(): Promise<void> {
    const roomId = 2003367144;
    const leader = createFakeClient('Alpha');
    const follower = createFakeClient('Beta');
    leader.currentLevel = 'AC_Mission1';
    follower.currentLevel = 'AC_Mission1';
    leader.levelInstanceId = 'deepgard-run';
    follower.levelInstanceId = 'deepgard-run';
    leader.clientEntID = 9101;
    follower.clientEntID = 9102;
    leader.entities.set(leader.clientEntID, {
        id: leader.clientEntID,
        name: 'Alpha',
        isPlayer: true,
        x: -2700,
        y: -2500,
        v: 0,
        team: 1
    });
    follower.entities.set(follower.clientEntID, {
        id: follower.clientEntID,
        name: 'Beta',
        isPlayer: true,
        x: -2800,
        y: -2500,
        v: 0,
        team: 1
    });
    GlobalState.sessionsByToken.set(leader.token, leader as never);
    GlobalState.sessionsByToken.set(follower.token, follower as never);

    await LevelHandler.handleEntityIncrementalUpdate(
        leader as never,
        buildIncrementalUpdatePayload(leader.clientEntID, 160, 0, 0)
    );

    const leaderTriggers = leader.sentPackets
        .filter((packet) => packet.id === 0x40)
        .map((packet) => parseLevelState(packet.payload));
    const followerTriggers = follower.sentPackets
        .filter((packet) => packet.id === 0x40)
        .map((packet) => parseLevelState(packet.payload));

    assert.deepEqual(leaderTriggers, [{ key: `${roomId}^Trigger^am_Trigger_Cutscene`, value: '' }]);
    assert.deepEqual(followerTriggers, [{ key: `${roomId}^Trigger^am_Trigger_Cutscene`, value: '' }]);
    assert.equal(leader.triggeredLevelStates.has(`AC_Mission1:${roomId}:am_Trigger_Cutscene`), true);
    assert.equal(follower.triggeredLevelStates.has(`AC_Mission1:${roomId}:am_Trigger_Cutscene`), true);
    assert.equal(leader.startedRoomEvents.has(`AC_Mission1:${roomId}`), false);
    assert.equal(follower.startedRoomEvents.has(`AC_Mission1:${roomId}`), false);

    leader.sentPackets.length = 0;
    follower.sentPackets.length = 0;
    await LevelHandler.handleEntityIncrementalUpdate(
        leader as never,
        buildIncrementalUpdatePayload(leader.clientEntID, 80, 0, 0)
    );

    assert.deepEqual(
        leader.sentPackets.filter((packet) => packet.id === 0xA5),
        [],
        'Deepgard mini-boss trigger should only be synthesized once per run'
    );
    assert.deepEqual(leader.sentPackets.filter((packet) => packet.id === 0x40), []);
    assert.deepEqual(follower.sentPackets.filter((packet) => packet.id === 0xA5), []);
    assert.deepEqual(follower.sentPackets.filter((packet) => packet.id === 0x40), []);
}

async function testDeepgardDragonMiniBossIntroIgnoresWrongVerticalBand(): Promise<void> {
    const client = createFakeClient('Alpha');
    client.currentLevel = 'AC_Mission1Hard';
    client.clientEntID = 9201;
    client.entities.set(client.clientEntID, {
        id: client.clientEntID,
        name: 'Alpha',
        isPlayer: true,
        x: -2700,
        y: -500,
        v: 0,
        team: 1
    });
    GlobalState.sessionsByToken.set(client.token, client as never);

    await LevelHandler.handleEntityIncrementalUpdate(
        client as never,
        buildIncrementalUpdatePayload(client.clientEntID, 160, 0, 0)
    );

    assert.deepEqual(client.sentPackets.filter((packet) => packet.id === 0xA5), []);
    assert.deepEqual(client.sentPackets.filter((packet) => packet.id === 0x40), []);
    assert.equal(client.triggeredLevelStates.has('AC_Mission1Hard:2003367144:am_Trigger_Cutscene'), false);
}

async function testBackAlleyDealsBossIntroStartsArenaRoomBeforeTrigger(): Promise<void> {
    const roomId = 2553897284;
    const leader = createFakeClient('Alpha');
    const follower = createFakeClient('Beta');
    leader.currentLevel = 'JC_Mission2';
    follower.currentLevel = 'JC_Mission2';
    leader.levelInstanceId = 'back-alley-run';
    follower.levelInstanceId = 'back-alley-run';
    leader.currentRoomId = 0;
    follower.currentRoomId = 0;
    leader.clientEntID = 9301;
    follower.clientEntID = 9302;
    leader.entities.set(leader.clientEntID, {
        id: leader.clientEntID,
        name: 'Alpha',
        isPlayer: true,
        x: 25360,
        y: 3259,
        v: 0,
        team: 1
    });
    follower.entities.set(follower.clientEntID, {
        id: follower.clientEntID,
        name: 'Beta',
        isPlayer: true,
        x: 25300,
        y: 3259,
        v: 0,
        team: 1
    });
    GlobalState.sessionsByToken.set(leader.token, leader as never);
    GlobalState.sessionsByToken.set(follower.token, follower as never);

    await LevelHandler.handleEntityIncrementalUpdate(
        leader as never,
        buildIncrementalUpdatePayload(leader.clientEntID, 160, 0, 0)
    );

    const leaderRoomStarts = leader.sentPackets
        .filter((packet) => packet.id === 0xA5)
        .map((packet) => parseRoomEventStart(packet.payload));
    const followerRoomStarts = follower.sentPackets
        .filter((packet) => packet.id === 0xA5)
        .map((packet) => parseRoomEventStart(packet.payload));
    const leaderTriggers = leader.sentPackets
        .filter((packet) => packet.id === 0x40)
        .map((packet) => parseLevelState(packet.payload));
    const followerTriggers = follower.sentPackets
        .filter((packet) => packet.id === 0x40)
        .map((packet) => parseLevelState(packet.payload));

    assert.deepEqual(leaderRoomStarts, [{ roomId, flag: true }]);
    assert.deepEqual(followerRoomStarts, [{ roomId, flag: true }]);
    assert.deepEqual(leaderTriggers, [{ key: `${roomId}^Trigger^am_Trigger_Boss`, value: '' }]);
    assert.deepEqual(followerTriggers, [{ key: `${roomId}^Trigger^am_Trigger_Boss`, value: '' }]);
    assert.equal(leader.currentRoomId, roomId);
    assert.equal(follower.currentRoomId, roomId);
    assert.equal(leader.startedRoomEvents.has(`JC_Mission2:${roomId}`), true);
    assert.equal(follower.startedRoomEvents.has(`JC_Mission2:${roomId}`), true);
    assert.equal(leader.triggeredLevelStates.has(`JC_Mission2:${roomId}:am_Trigger_Boss`), true);
    assert.equal(follower.triggeredLevelStates.has(`JC_Mission2:${roomId}:am_Trigger_Boss`), true);

    leader.sentPackets.length = 0;
    follower.sentPackets.length = 0;
    await LevelHandler.handleEntityIncrementalUpdate(
        leader as never,
        buildIncrementalUpdatePayload(leader.clientEntID, 80, 0, 0)
    );

    assert.deepEqual(leader.sentPackets.filter((packet) => packet.id === 0xA5), []);
    assert.deepEqual(leader.sentPackets.filter((packet) => packet.id === 0x40), []);
    assert.deepEqual(follower.sentPackets.filter((packet) => packet.id === 0xA5), []);
    assert.deepEqual(follower.sentPackets.filter((packet) => packet.id === 0x40), []);
}

async function testBackAlleyDealsBossIntroStartsWhenAlreadyPastTrigger(): Promise<void> {
    const roomId = 2553897284;
    const client = createFakeClient('Alpha');
    client.currentLevel = 'JC_Mission2';
    client.levelInstanceId = 'back-alley-run';
    client.currentRoomId = 0;
    client.clientEntID = 9401;
    client.entities.set(client.clientEntID, {
        id: client.clientEntID,
        name: 'Alpha',
        isPlayer: true,
        x: 25520,
        y: 3259,
        v: 0,
        team: 1
    });
    GlobalState.sessionsByToken.set(client.token, client as never);

    await LevelHandler.handleEntityIncrementalUpdate(
        client as never,
        buildIncrementalUpdatePayload(client.clientEntID, 0, 0, 0)
    );

    const roomStarts = client.sentPackets
        .filter((packet) => packet.id === 0xA5)
        .map((packet) => parseRoomEventStart(packet.payload));
    const triggers = client.sentPackets
        .filter((packet) => packet.id === 0x40)
        .map((packet) => parseLevelState(packet.payload));

    assert.deepEqual(roomStarts, [{ roomId, flag: true }]);
    assert.deepEqual(triggers, [{ key: `${roomId}^Trigger^am_Trigger_Boss`, value: '' }]);
    assert.equal(client.currentRoomId, roomId);
    assert.equal(client.startedRoomEvents.has(`JC_Mission2:${roomId}`), true);
    assert.equal(client.triggeredLevelStates.has(`JC_Mission2:${roomId}:am_Trigger_Boss`), true);
}

async function testProdigalSonDefectorMomentsStartOnTriggerCrossing(): Promise<void> {
    const triggers = [
        { roomId: 1971923064, startX: 9700, deltaX: 160, y: -1450 },
        { roomId: 2061059764, startX: 18100, deltaX: 160, y: -1150 }
    ];
    const leader = createFakeClient('Alpha');
    const follower = createFakeClient('Beta');
    leader.currentLevel = 'JC_Mission3';
    follower.currentLevel = 'JC_Mission3';
    leader.levelInstanceId = 'prodigal-run';
    follower.levelInstanceId = 'prodigal-run';
    leader.clientEntID = 9501;
    follower.clientEntID = 9502;
    leader.entities.set(leader.clientEntID, {
        id: leader.clientEntID,
        name: 'Alpha',
        isPlayer: true,
        x: triggers[0].startX,
        y: triggers[0].y,
        v: 0,
        team: 1
    });
    follower.entities.set(follower.clientEntID, {
        id: follower.clientEntID,
        name: 'Beta',
        isPlayer: true,
        x: triggers[0].startX - 100,
        y: triggers[0].y,
        v: 0,
        team: 1
    });
    GlobalState.sessionsByToken.set(leader.token, leader as never);
    GlobalState.sessionsByToken.set(follower.token, follower as never);

    for (const trigger of triggers) {
        const leaderEntity = leader.entities.get(leader.clientEntID)!;
        leaderEntity.x = trigger.startX;
        leaderEntity.y = trigger.y;
        leader.sentPackets.length = 0;
        follower.sentPackets.length = 0;

        await LevelHandler.handleEntityIncrementalUpdate(
            leader as never,
            buildIncrementalUpdatePayload(leader.clientEntID, trigger.deltaX, 0, 0)
        );

        const expected = { key: `${trigger.roomId}^Trigger^am_Trigger_01`, value: '' };
        const leaderTriggers = leader.sentPackets
            .filter((packet) => packet.id === 0x40)
            .map((packet) => parseLevelState(packet.payload));
        const followerTriggers = follower.sentPackets
            .filter((packet) => packet.id === 0x40)
            .map((packet) => parseLevelState(packet.payload));

        assert.deepEqual(leaderTriggers, [expected]);
        assert.deepEqual(followerTriggers, [expected]);
        assert.equal(leader.triggeredLevelStates.has(`JC_Mission3:${trigger.roomId}:am_Trigger_01`), true);
        assert.equal(follower.triggeredLevelStates.has(`JC_Mission3:${trigger.roomId}:am_Trigger_01`), true);
    }
}

async function testProdigalSonDefectorMomentsIgnoreWrongVerticalBand(): Promise<void> {
    const client = createFakeClient('Alpha');
    client.currentLevel = 'JC_Mission3Hard';
    client.clientEntID = 9601;
    client.entities.set(client.clientEntID, {
        id: client.clientEntID,
        name: 'Alpha',
        isPlayer: true,
        x: 9700,
        y: 500,
        v: 0,
        team: 1
    });
    GlobalState.sessionsByToken.set(client.token, client as never);

    await LevelHandler.handleEntityIncrementalUpdate(
        client as never,
        buildIncrementalUpdatePayload(client.clientEntID, 160, 0, 0)
    );

    assert.deepEqual(client.sentPackets.filter((packet) => packet.id === 0x40), []);
    assert.equal(client.triggeredLevelStates.has('JC_Mission3Hard:1971923064:am_Trigger_01'), false);
}

async function testProdigalSonDefectorMomentOnlyStartsOnce(): Promise<void> {
    const client = createFakeClient('Alpha');
    client.currentLevel = 'JC_Mission3';
    client.clientEntID = 9701;
    client.entities.set(client.clientEntID, {
        id: client.clientEntID,
        name: 'Alpha',
        isPlayer: true,
        x: 9700,
        y: -1450,
        v: 0,
        team: 1
    });
    GlobalState.sessionsByToken.set(client.token, client as never);

    await LevelHandler.handleEntityIncrementalUpdate(
        client as never,
        buildIncrementalUpdatePayload(client.clientEntID, 160, 0, 0)
    );
    assert.deepEqual(
        client.sentPackets
            .filter((packet) => packet.id === 0x40)
            .map((packet) => parseLevelState(packet.payload)),
        [{ key: '1971923064^Trigger^am_Trigger_01', value: '' }]
    );

    client.sentPackets.length = 0;
    const player = client.entities.get(client.clientEntID)!;
    player.x = 9700;
    player.y = -1450;
    await LevelHandler.handleEntityIncrementalUpdate(
        client as never,
        buildIncrementalUpdatePayload(client.clientEntID, 160, 0, 0)
    );

    assert.deepEqual(
        client.sentPackets.filter((packet) => packet.id === 0x40),
        [],
        'The Prodigal Son defector trigger should only be synthesized once per run'
    );
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

async function testSharedDungeonIncrementalUpdateSkipsAliasedViewerMovement(): Promise<void> {
    const owner = createFakeClient('Alpha');
    const joiner = createFakeClient('Beta');

    owner.currentLevel = 'TutorialDungeon';
    joiner.currentLevel = 'TutorialDungeon';
    owner.currentRoomId = 4;
    joiner.currentRoomId = 4;

    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    GlobalState.partyByMember.set('alpha', 301);
    GlobalState.partyByMember.set('beta', 301);

    const canonical = {
        id: 8101,
        name: 'IntroGoblin',
        isPlayer: false,
        x: 120,
        y: 220,
        v: 0,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: owner.token,
        ownerPartyId: 301,
        roomId: owner.currentRoomId
    };

    GlobalState.levelEntities.set('TutorialDungeon', new Map([[canonical.id, canonical]]));
    owner.entities.set(canonical.id, { ...canonical });
    owner.knownEntityIds.add(canonical.id);
    joiner.entityIdAliases.set(9101, canonical.id);
    joiner.knownEntityIds.add(canonical.id);
    joiner.entities.set(9101, { ...canonical, id: 9101, sharedCanonicalId: canonical.id });

    await LevelHandler.handleEntityIncrementalUpdate(
        owner as never,
        buildIncrementalUpdatePayload(canonical.id, 8, -2, 0)
    );

    assert.equal(
        joiner.sentPackets.some((packet) => packet.id === 0x07),
        false,
        'shared client-spawn hostile movement should stay local to avoid joiner LinkUpdater crashes'
    );
}

async function testHiddenAliasedHostileNeverReceivesRemoteMovement(): Promise<void> {
    const owner = createFakeClient('Alpha');
    const joiner = createFakeClient('Beta');

    owner.currentLevel = 'TutorialDungeon';
    joiner.currentLevel = 'TutorialDungeon';
    owner.currentRoomId = 4;
    joiner.currentRoomId = 4;

    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    GlobalState.partyByMember.set('alpha', 302);
    GlobalState.partyByMember.set('beta', 302);

    const canonical = {
        id: 8102,
        name: 'IntroGoblin',
        isPlayer: false,
        x: 120,
        y: 220,
        v: 0,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: owner.token,
        ownerPartyId: 302,
        roomId: owner.currentRoomId
    };
    const localDuplicate = {
        ...canonical,
        id: 9102,
        x: 122,
        y: 218,
        v: 9,
        ownerToken: joiner.token,
        ownerPartyId: 302,
        roomId: joiner.currentRoomId
    };

    GlobalState.levelEntities.set('TutorialDungeon', new Map([[canonical.id, canonical]]));
    owner.entities.set(canonical.id, { ...canonical });
    owner.knownEntityIds.add(canonical.id);

    const suppressed = (EntityHandler as any).suppressDuplicateSharedClientSpawn(
        joiner as never,
        'TutorialDungeon',
        GlobalState.levelEntities.get('TutorialDungeon'),
        localDuplicate
    );
    assert.equal(suppressed, true);

    await LevelHandler.handleEntityIncrementalUpdate(
        owner as never,
        buildIncrementalUpdatePayload(canonical.id, 8, -2, 0)
    );
    assert.equal(
        joiner.sentPackets.some((packet) => packet.id === 0x07),
        false,
        'remote movement should wait while the joiner local spawn is still hidden by spawn velocity'
    );

    await LevelHandler.handleEntityIncrementalUpdate(
        joiner as never,
        buildIncrementalUpdatePayload(localDuplicate.id, 1, 0, 0)
    );
    assert.equal(
        owner.sentPackets.some((packet) => packet.id === 0x07),
        false,
        'joiner local alias movement should only mark the local entity ready, not drive canonical movement'
    );

    await LevelHandler.handleEntityIncrementalUpdate(
        owner as never,
        buildIncrementalUpdatePayload(canonical.id, 6, -1, 0)
    );

    assert.equal(
        joiner.sentPackets.some((packet) => packet.id === 0x07),
        false,
        'shared client-spawn hostile movement should remain client-local even after local alias readiness'
    );
}

function testOutdoorHostileIncrementalUpdatesDoNotRelayToPeers(): void {
    const sender = createFakeClient('Alpha');
    const watcher = createFakeClient('Beta');

    sender.currentLevel = 'NewbieRoad';
    watcher.currentLevel = 'NewbieRoad';
    sender.currentRoomId = 1;
    watcher.currentRoomId = 1;

    const hostile: any = {
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

function testOutdoorHostileIncrementalUpdatesDoNotRelayToPartyPeers(): void {
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

    assert.equal(
        watcher.sentPackets.some((packet) => packet.id === 0x07 || packet.id === 0x0F),
        false,
        'private outdoor hostile movement should remain owner-local even for party mates in the same level'
    );
}

function testOutdoorNpcIncrementalUpdatesDoNotRelayToPartyPeers(): void {
    const sender = createFakeClient('Alpha');
    const watcher = createFakeClient('Beta');

    sender.currentLevel = 'NewbieRoad';
    watcher.currentLevel = 'NewbieRoad';
    sender.currentRoomId = 2;
    watcher.currentRoomId = 2;

    const npc = {
        id: 2206,
        name: 'VillageGuide',
        isPlayer: false,
        x: 100,
        y: 200,
        v: 0,
        team: 3,
        entState: 0,
        clientSpawned: true,
        ownerToken: sender.token,
        roomId: sender.currentRoomId
    };

    sender.entities.set(npc.id, { ...npc });
    sender.knownEntityIds.add(npc.id);
    watcher.entities.set(npc.id, { ...npc, ownerToken: watcher.token });
    watcher.knownEntityIds.add(npc.id);

    GlobalState.levelEntities.set('NewbieRoad', new Map([[npc.id, npc]]));
    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(watcher.token, watcher as never);
    GlobalState.partyByMember.set('alpha', 189);
    GlobalState.partyByMember.set('beta', 189);

    LevelHandler.handleEntityIncrementalUpdate(
        sender as never,
        buildIncrementalUpdatePayload(npc.id, 8, -2, 1)
    );

    assert.equal(
        watcher.sentPackets.some((packet) => packet.id === 0x07 || packet.id === 0x0F),
        false,
        'private outdoor NPC movement should remain owner-local even for party mates in the same room'
    );
}

function testDungeonJoinerReplaysStartedRoomEventsFromPartyAnchor(): void {
    const anchor = createFakeClient('Alpha');
    const joiner = createFakeClient('Beta');

    anchor.currentLevel = 'TutorialBoat';
    joiner.currentLevel = 'TutorialBoat';
    anchor.levelInstanceId = '41035';
    joiner.levelInstanceId = '41035';
    anchor.currentRoomId = 5;
    joiner.currentRoomId = 0;
    anchor.syncAnchorStartedAt = 100;
    joiner.syncAnchorStartedAt = 50;
    anchor.clientEntID = 7001;
    joiner.clientEntID = 7002;

    anchor.startedRoomEvents.add('TutorialBoat:0');
    anchor.startedRoomEvents.add('TutorialBoat:1');
    anchor.startedRoomEvents.add('TutorialBoat:5');
    joiner.startedRoomEvents.add('TutorialBoat:0');

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
    assert.equal(joiner.startedRoomEvents.has('TutorialBoat:1'), true);
    assert.equal(joiner.startedRoomEvents.has('TutorialBoat:5'), true);
}

function testGoblinRiverDungeonLeaderHostilesSeedToPartyJoinersOnly(): void {
    for (const levelName of GOBLIN_RIVER_LEVELS) {
        const owner = createFakeClient('Alpha');
        const partyWatcher = createFakeClient('Beta');
        const stranger = createFakeClient('Gamma');

        owner.currentLevel = levelName;
        owner.levelInstanceId = 'gr-shared';
        owner.currentRoomId = 2;
        partyWatcher.currentLevel = levelName;
        partyWatcher.levelInstanceId = 'gr-shared';
        stranger.currentLevel = levelName;
        stranger.levelInstanceId = 'gr-shared';
        partyWatcher.currentRoomId = 8;
        stranger.currentRoomId = 2;

        const hostile = {
            id: 4810,
            name: 'GoblinClub',
            isPlayer: false,
            x: 180,
            y: 240,
            v: 0,
            team: 2,
            entState: 0,
            clientSpawned: true,
            ownerToken: owner.token,
            ownerPartyId: 191,
            roomId: owner.currentRoomId
        };

        GlobalState.levelEntities.set(`${levelName}#gr-shared`, new Map([[hostile.id, hostile]]));
        GlobalState.sessionsByToken.set(owner.token, owner as never);
        GlobalState.sessionsByToken.set(partyWatcher.token, partyWatcher as never);
        GlobalState.sessionsByToken.set(stranger.token, stranger as never);
        GlobalState.partyByMember.set('alpha', 191);
        GlobalState.partyByMember.set('beta', 191);
        GlobalState.partyGroups.set(191, { id: 191, leader: 'Alpha', members: ['Alpha', 'Beta'], locked: false });

        const partyKnown = EntityHandler.ensureEntityKnown(partyWatcher as never, levelName, hostile.id);
        const strangerKnown = EntityHandler.ensureEntityKnown(stranger as never, levelName, hostile.id);

        assert.equal(partyKnown, true, `${levelName} should seed leader-owned hostiles to party joiners`);
        assert.deepEqual(
            partyWatcher.sentPackets.map((packet) => packet.id),
            [0x0F],
            `${levelName} party joiner should receive one canonical hostile seed`
        );
        assert.equal(strangerKnown, false, `${levelName} should not seed leader-owned hostiles to non-party viewers`);
        assert.equal(stranger.sentPackets.length, 0, `${levelName} non-party viewers should receive no hostile seed`);
    }
}

function testGoblinRiverDungeonSuppressesFollowerClientHostileSpawns(): void {
    for (const levelName of GOBLIN_RIVER_LEVELS) {
        const leader = createFakeClient('Alpha');
        const follower = createFakeClient('Beta');
        leader.currentLevel = levelName;
        follower.currentLevel = levelName;
        leader.levelInstanceId = 'gr-unsynced';
        follower.levelInstanceId = 'gr-unsynced';
        leader.currentRoomId = 4;
        follower.currentRoomId = 0;

        const canonical = createGoblinRiverHostile(
            5302,
            'GoblinArmorAxe',
            leader.token,
            198,
            leader.currentRoomId
        );

        GlobalState.levelEntities.set(`${levelName}#gr-unsynced`, new Map([[canonical.id, canonical]]));
        GlobalState.sessionsByToken.set(leader.token, leader as never);
        GlobalState.sessionsByToken.set(follower.token, follower as never);
        GlobalState.partyByMember.set('alpha', 198);
        GlobalState.partyByMember.set('beta', 198);
        GlobalState.partyGroups.set(198, { id: 198, leader: 'Alpha', members: ['Alpha', 'Beta'], locked: false });

        const duplicate = createGoblinRiverHostile(
            6302,
            canonical.name,
            follower.token,
            198,
            follower.currentRoomId,
            canonical.x,
            canonical.y
        );

        const suppressed = (EntityHandler as any).suppressFollowerLeaderAuthoritativeDungeonSpawn(
            follower as never,
            levelName,
            GlobalState.levelEntities.get(`${levelName}#gr-unsynced`),
            duplicate
        );

        const levelMap = GlobalState.levelEntities.get(`${levelName}#gr-unsynced`);
        assert.equal(suppressed, true, `${levelName} should suppress follower hostile spawns before room sync finishes`);
        assert.equal(levelMap?.size, 1, `${levelName} should keep a single canonical hostile`);
        assert.deepEqual(
            follower.sentPackets.map((packet) => packet.id),
            [],
            `${levelName} follower should keep its local hostile and alias it to the leader hostile`
        );
        assert.equal(follower.knownEntityIds.has(canonical.id), true);
        assert.equal(follower.knownEntityIds.has(6302), false);
        assert.equal(follower.entityIdAliases.get(6302), canonical.id);
        assert.equal(follower.entities.get(6302)?.sharedCanonicalId, canonical.id);
    }
}

function testTutorialDungeonJoinerSkipsStartedRoomReplayFromPartyAnchor(): void {
    const anchor = createFakeClient('Alpha');
    const joiner = createFakeClient('Beta');

    anchor.currentLevel = 'TutorialDungeon';
    joiner.currentLevel = 'TutorialDungeon';
    anchor.currentRoomId = 6;
    joiner.currentRoomId = 0;
    anchor.syncAnchorStartedAt = 100;
    joiner.syncAnchorStartedAt = 50;
    anchor.clientEntID = 7101;
    joiner.clientEntID = 7102;

    anchor.startedRoomEvents.add('TutorialDungeon:0');
    anchor.startedRoomEvents.add('TutorialDungeon:3');
    anchor.startedRoomEvents.add('TutorialDungeon:6');
    joiner.startedRoomEvents.add('TutorialDungeon:0');

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

    GlobalState.sessionsByToken.set(anchor.token, anchor as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    GlobalState.partyByMember.set('alpha', 277);
    GlobalState.partyByMember.set('beta', 277);

    (EntityHandler as any).sendExistingPlayersToJoiner(joiner as never);

    const roomPackets = joiner.sentPackets.filter((packet) => packet.id === 0xA5);
    assert.deepEqual(roomPackets, [], 'TutorialDungeon joiner should not replay advanced room starts from the party anchor');
    assert.equal(joiner.currentRoomId, 0);
    assert.equal(joiner.startedRoomEvents.has('TutorialDungeon:3'), false);
    assert.equal(joiner.startedRoomEvents.has('TutorialDungeon:6'), false);
}

function testGoblinRiverDungeonAllowsFollowerFirstCanonicalHostileSpawn(): void {
    for (const levelName of GOBLIN_RIVER_LEVELS) {
        const leader = createFakeClient('Alpha');
        const follower = createFakeClient('Beta');
        leader.currentLevel = levelName;
        follower.currentLevel = levelName;
        leader.levelInstanceId = 'gr-follower-first';
        follower.levelInstanceId = 'gr-follower-first';
        leader.currentRoomId = 4;
        follower.currentRoomId = 0;

        GlobalState.levelEntities.set(`${levelName}#gr-follower-first`, new Map<number, any>());
        GlobalState.sessionsByToken.set(leader.token, leader as never);
        GlobalState.sessionsByToken.set(follower.token, follower as never);
        GlobalState.partyByMember.set('alpha', 211);
        GlobalState.partyByMember.set('beta', 211);
        GlobalState.partyGroups.set(211, { id: 211, leader: 'Alpha', members: ['Alpha', 'Beta'], locked: false });

        const followerHostile = createGoblinRiverHostile(6401, 'GoblinArmorAxe', follower.token, 211, follower.currentRoomId);

        const suppressed = (EntityHandler as any).suppressFollowerLeaderAuthoritativeDungeonSpawn(
            follower as never,
            levelName,
            GlobalState.levelEntities.get(`${levelName}#gr-follower-first`),
            followerHostile
        );

        assert.equal(suppressed, false, `${levelName} should keep the first follower hostile when no canonical shared hostile exists`);
        assert.deepEqual(follower.sentPackets, [], `${levelName} follower should not receive destroy or replacement packets before canonical hostile exists`);
    }
}

function testGoblinRiverDungeonLeaderLateSpawnDedupesToFollowerCanonical(): void {
    for (const levelName of GOBLIN_RIVER_LEVELS) {
        const leader = createFakeClient('Alpha');
        const follower = createFakeClient('Beta');
        leader.currentLevel = levelName;
        follower.currentLevel = levelName;
        leader.levelInstanceId = 'gr-late-leader';
        follower.levelInstanceId = 'gr-late-leader';
        leader.currentRoomId = 4;
        follower.currentRoomId = 0;

        const canonical = createGoblinRiverHostile(7401, 'GoblinArmorAxe', follower.token, 233, follower.currentRoomId);
        const levelMap = new Map<number, any>([[canonical.id, canonical]]);

        GlobalState.levelEntities.set(`${levelName}#gr-late-leader`, levelMap);
        GlobalState.sessionsByToken.set(leader.token, leader as never);
        GlobalState.sessionsByToken.set(follower.token, follower as never);
        GlobalState.partyByMember.set('alpha', 233);
        GlobalState.partyByMember.set('beta', 233);
        GlobalState.partyGroups.set(233, { id: 233, leader: 'Alpha', members: ['Alpha', 'Beta'], locked: false });

        const leaderDuplicate = createGoblinRiverHostile(
            7402,
            canonical.name,
            leader.token,
            233,
            leader.currentRoomId,
            canonical.x,
            canonical.y
        );

        const suppressed = (EntityHandler as any).suppressDuplicateSharedClientSpawn(
            leader as never,
            levelName,
            levelMap,
            leaderDuplicate
        );

        assert.equal(suppressed, true, `${levelName} leader should adopt existing follower-authored canonical hostile`);
        assert.deepEqual(
            leader.sentPackets.map((packet) => packet.id),
            [],
            `${levelName} late leader should keep its local hostile and alias it to the follower canonical hostile`
        );
        assert.equal(leader.knownEntityIds.has(canonical.id), true);
        assert.equal(leader.knownEntityIds.has(7402), false);
        assert.equal(leader.entityIdAliases.get(7402), canonical.id);
        assert.equal(leader.entities.get(7402)?.sharedCanonicalId, canonical.id);
        assert.equal(levelMap.size, 1, `${levelName} late leader dedupe should keep only the canonical hostile in scope`);
    }
}

function testGoblinRiverDungeonJoinerSkipsStartedRoomReplayFromPartyAnchor(): void {
    for (const levelName of GOBLIN_RIVER_LEVELS) {
        const anchor = createFakeClient('Alpha');
        const joiner = createFakeClient('Beta');

        anchor.currentLevel = levelName;
        joiner.currentLevel = levelName;
        anchor.levelInstanceId = 'gr-progress';
        joiner.levelInstanceId = 'gr-progress';
        anchor.currentRoomId = 6;
        joiner.currentRoomId = 0;
        anchor.syncAnchorStartedAt = 100;
        joiner.syncAnchorStartedAt = 50;
        anchor.clientEntID = 7101;
        joiner.clientEntID = 7102;

        anchor.startedRoomEvents.add(`${levelName}:0`);
        anchor.startedRoomEvents.add(`${levelName}:3`);
        anchor.startedRoomEvents.add(`${levelName}:6`);
        joiner.startedRoomEvents.add(`${levelName}:0`);

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

        GlobalState.sessionsByToken.set(anchor.token, anchor as never);
        GlobalState.sessionsByToken.set(joiner.token, joiner as never);
        GlobalState.partyByMember.set('alpha', 277);
        GlobalState.partyByMember.set('beta', 277);

        (EntityHandler as any).sendExistingPlayersToJoiner(joiner as never);

        const roomPackets = joiner.sentPackets.filter((packet) => packet.id === 0xA5);
        assert.deepEqual(roomPackets, [], `${levelName} joiner should not replay advanced room starts from the party anchor`);
        assert.equal(joiner.currentRoomId, 0, `${levelName} joiner should keep its fresh intro room state`);
        assert.equal(joiner.startedRoomEvents.has(`${levelName}:3`), false);
        assert.equal(joiner.startedRoomEvents.has(`${levelName}:6`), false);
    }
}

function testDungeonClientSpawnHostilesUsePlayerRuntimeLevel(): void {
    const client = createFakeClient('Scaler', 12);
    client.currentLevel = 'GoblinRiverDungeon';
    client.levelInstanceId = 'scaled-run';
    client.clientEntID = 9001;

    const hostile: any = {
        id: 9002,
        name: 'GoblinDagger',
        isPlayer: false,
        x: 200,
        y: 300,
        v: 0,
        team: 2,
        entState: 0
    };

    (EntityHandler as any).applyRuntimeDungeonEntityLevel(client as never, client.currentLevel, hostile);

    assert.equal(hostile.level, 12, 'solo dungeon client-spawn hostiles should use the player runtime level');
}

function testDungeonClientSpawnHostilesUseMaxPartyRuntimeLevel(): void {
    const low = createFakeClient('Lowbie', 12);
    const high = createFakeClient('Fifty', 50);
    low.currentLevel = 'GoblinRiverDungeon';
    high.currentLevel = 'CraftTown';
    low.levelInstanceId = 'party-scaled-run';
    low.clientEntID = 9101;
    high.clientEntID = 9102;

    GlobalState.sessionsByToken.set(low.token, low as never);
    GlobalState.sessionsByToken.set(high.token, high as never);
    GlobalState.partyByMember.set('lowbie', 305);
    GlobalState.partyByMember.set('fifty', 305);
    GlobalState.partyGroups.set(305, { id: 305, leader: 'Lowbie', members: ['Lowbie', 'Fifty'], locked: false });

    const hostile: any = {
        id: 9103,
        name: 'GoblinDagger',
        isPlayer: false,
        x: 200,
        y: 300,
        v: 0,
        team: 2,
        entState: 0
    };

    (EntityHandler as any).applyRuntimeDungeonEntityLevel(low as never, low.currentLevel, hostile);

    assert.equal(hostile.level, 50, 'party dungeon hostiles should scale to the highest live party member level');
}

function testJoiningHighLevelPartyMemberRescalesExistingDungeonHostiles(): void {
    const low = createFakeClient('Lowbie', 12);
    const high = createFakeClient('Fifty', 50);
    low.currentLevel = 'GoblinRiverDungeon';
    high.currentLevel = 'GoblinRiverDungeon';
    low.levelInstanceId = 'rescale-run';
    high.levelInstanceId = 'rescale-run';

    GlobalState.sessionsByToken.set(low.token, low as never);
    GlobalState.sessionsByToken.set(high.token, high as never);
    GlobalState.partyByMember.set('lowbie', 306);
    GlobalState.partyByMember.set('fifty', 306);
    GlobalState.partyGroups.set(306, { id: 306, leader: 'Lowbie', members: ['Lowbie', 'Fifty'], locked: false });

    const hostile = {
        id: 9201,
        name: 'GoblinDagger',
        isPlayer: false,
        x: 200,
        y: 300,
        v: 0,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: low.token,
        ownerPartyId: 306,
        level: 12
    };
    GlobalState.levelEntities.set('GoblinRiverDungeon#rescale-run', new Map<number, any>([[hostile.id, hostile]]));
    low.entities.set(hostile.id, { ...hostile });

    const updatedCount = EntityHandler.rescaleDungeonEntitiesForParty(high as never);
    const scaledHostile = GlobalState.levelEntities.get('GoblinRiverDungeon#rescale-run')?.get(9201);
    assert.equal(updatedCount, 1);
    assert.equal(scaledHostile?.level, 50, 'joining high-level party member should raise existing shared hostile level');
    assert.equal(low.entities.get(hostile.id)?.level, 50, 'owner local entity cache should be raised with the shared hostile');
}

async function main(): Promise<void> {
    ensureLevelConfigLoaded();

    const levelEntities = new Map(GlobalState.levelEntities);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const partyByMember = new Map(GlobalState.partyByMember);
    const partyGroups = new Map(GlobalState.partyGroups);
    GlobalState.levelEntities.clear();
    GlobalState.sessionsByToken.clear();
    GlobalState.partyByMember.clear();
    GlobalState.partyGroups.clear();

    try {
        testRemotePlayerEntityPacketMatchesClientReadOrder();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testNewlyRelevantEntitySeedsClearVelocity();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testConfiguredLevelsUseClientSpawn();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testCraftTownPlayerSpawnsAreScopedByHomeOwner();

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
        testGoblinRiverClientSpawnLevelsPruneServerNpcCopies();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testGoblinRiverClientSpawnLevelsStartEmptyWithoutServerNpcInit();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testOutdoorHostileClientSpawnIsNotSeededToPeers();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testOutdoorHostileClientSpawnStaysPrivateToPartyPeers();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDungeonHostileClientSpawnSeedsToPartyPeersOnly();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testGoblinRiverDungeonLeaderHostilesSeedToPartyJoinersOnly();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        testGoblinRiverDungeonAllowsFollowerFirstCanonicalHostileSpawn();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDungeonPartyAuthoritySuppressesDuplicateHostileSpawns();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDungeonHostileSpawnBroadcastWaitsForJoinerCanonicalAdoption();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDungeonPartyAuthoritySuppressesDuplicateHostileSpawnsAcrossUnsyncedRooms();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testGoblinRiverDungeonSuppressesFollowerClientHostileSpawns();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        testGoblinRiverDungeonLeaderLateSpawnDedupesToFollowerCanonical();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testOutdoorNpcSpawnsStayPrivateToOwner();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testOutdoorHostileSpawnsStayPrivateToOwner();

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
        testCraftTownTutorialTracksClientSpawnBoardHelpers();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testCraftTownTutorialBossIntroUsesRunLoopThoughts();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testCraftTownTutorialServerFallbackDoesNotSeedInitialHostiles();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testCraftTownTutorialBossRecoveryActivatesTrackedHelpersImmediately();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testCraftTownTutorialBossRecoverySeedsClientTrackedHelpersImmediately();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testCraftTownTutorialBossRecoveryIgnoresTrackedStrayHelpers();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testCraftTownTutorialBossIntroStillTriggersAfterClientSpawnConfirmation();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testCraftTownTutorialReinforcementsOnlyUseExistingHelpers();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testCraftTownTutorialKnownHelpersUseStateUpdatesInsteadOfDuplicateSpawns();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        await testCraftTownTutorialHelperWaveRespawnsAfterAllHelpersDie();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        await testCraftTownTutorialClientSourceHelperWaveRespawnsAfterAllHelpersDie();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testCraftTownTutorialClientSourceBossWoundedThoughtsPlay();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testSoloDungeonHostileReferencePromotesWithoutEagerJoinerSeed();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testSoloDungeonNpcReferencePromotesToPartyJoinerSeed();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testTutorialDungeonTraversalParrotStartsWhenPlayerReachesRoom();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        await testDeepgardDragonMiniBossIntroStartsOnTriggerCrossing();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        await testDeepgardDragonMiniBossIntroIgnoresWrongVerticalBand();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        await testBackAlleyDealsBossIntroStartsArenaRoomBeforeTrigger();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        await testBackAlleyDealsBossIntroStartsWhenAlreadyPastTrigger();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        await testProdigalSonDefectorMomentsStartOnTriggerCrossing();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        await testProdigalSonDefectorMomentsIgnoreWrongVerticalBand();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        await testProdigalSonDefectorMomentOnlyStartsOnce();

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
        await testSharedDungeonIncrementalUpdateSkipsAliasedViewerMovement();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        await testHiddenAliasedHostileNeverReceivesRemoteMovement();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testOutdoorHostileIncrementalUpdatesDoNotRelayToPeers();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testOutdoorHostileIncrementalUpdatesDoNotRelayToPartyPeers();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testOutdoorNpcIncrementalUpdatesDoNotRelayToPartyPeers();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDungeonJoinerReplaysStartedRoomEventsFromPartyAnchor();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testTutorialDungeonJoinerSkipsStartedRoomReplayFromPartyAnchor();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testGoblinRiverDungeonJoinerSkipsStartedRoomReplayFromPartyAnchor();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDungeonClientSpawnHostilesUsePlayerRuntimeLevel();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        testDungeonClientSpawnHostilesUseMaxPartyRuntimeLevel();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        testJoiningHighLevelPartyMemberRescalesExistingDungeonHostiles();
    } finally {
        GlobalState.levelEntities = levelEntities;
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.partyByMember = partyByMember;
        GlobalState.partyGroups = partyGroups;
    }

    console.log('client_spawn_level_regression: ok');
}

void main().catch((error) => {
    console.error('client_spawn_level_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
