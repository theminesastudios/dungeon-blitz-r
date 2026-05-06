import { strict as assert } from 'assert';
import * as path from 'path';
import { createKeepTutorialState } from '../core/Client';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { CombatHandler } from '../handlers/CombatHandler';
import { EntityHandler } from '../handlers/EntityHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { RewardHandler } from '../handlers/RewardHandler';
import { Entity, EntityState } from '../core/Entity';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { NpcLoader } from '../data/NpcLoader';
import { getClientLevelScope } from '../core/LevelScope';
import { JsonAdapter } from '../database/JsonAdapter';
import { Config } from '../core/config';
import { getSharedDungeonDefeatedSpawnKeys, getSharedDungeonProgressTotals, recomputeSharedDungeonProgress } from '../core/SharedDungeonProgress';
import { getDungeonSnapshotSpawnKey, getReusableIncompleteDungeonSnapshotInstanceId, isPersistentDungeonSnapshotLevel } from '../core/PersistentDungeonSnapshot';

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
    playerSpawned: boolean;
    clientEntID: number;
    userId: number | null;
    mountTransferGraceUntil: number;
    syncAnchorStartedAt: number;
    startedRoomEvents: Set<string>;
    knownEntityIds: Set<number>;
    processedRewardSources: Set<string>;
    pendingLoot: Map<number, any>;
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
    const dataDir = path.join(Config.DATA_DIR, 'data');
    if (!LevelConfig.has('TutorialDungeon')) {
        LevelConfig.load(dataDir);
    }
    if (NpcLoader.getRawNpcsForLevel('TutorialDungeon').length === 0) {
        NpcLoader.load(dataDir);
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
        playerSpawned: true,
        clientEntID: 0,
        userId: 1,
        mountTransferGraceUntil: 0,
        syncAnchorStartedAt: 0,
        startedRoomEvents: new Set<string>(),
        knownEntityIds: new Set<number>(),
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
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

function expectedDuplicateDestroyPacketIds(withCanonicalSeed: boolean = true): number[] {
    const ids = [0x0D, 0x07, 0x0D, 0x07, 0x0D];
    if (withCanonicalSeed) {
        ids.push(0x0F);
    }
    return ids;
}

function buildDestroyEntityPayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod15(true);
    return bb.toBuffer();
}

function buildRewardRequestPayload(receiverId: number, sourceId: number, x: number, y: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(receiverId);
    bb.writeMethod9(sourceId);
    bb.writeMethod15(false);
    bb.writeMethod309(1);
    bb.writeMethod15(false);
    bb.writeMethod309(1);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod24(x);
    bb.writeMethod24(y);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildPowerHitPayload(targetId: number, sourceId: number, damage: number, powerId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(targetId);
    bb.writeMethod9(sourceId);
    bb.writeMethod24(damage);
    bb.writeMethod9(powerId);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildClientEntityFullUpdatePayload(entity: {
    id: number;
    name: string;
    isPlayer: boolean;
    x: number;
    y: number;
    v: number;
    team: number;
    entState: number;
    renderDepthOffset?: number;
}): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(entity.id);
    bb.writeMethod24(Math.round(Number(entity.x ?? 0)));
    bb.writeMethod24(Math.round(Number(entity.y ?? 0)));
    bb.writeMethod24(Math.round(Number(entity.v ?? 0)));
    bb.writeMethod26(entity.name ?? '');
    bb.writeMethod20(Entity.TEAM_BITS, Number(entity.team ?? 0));
    bb.writeMethod15(Boolean(entity.isPlayer));
    const renderDepthOffset = Math.round(Number(entity.renderDepthOffset ?? 0));
    const renderMagnitude = Math.abs(renderDepthOffset);
    const renderBits = Math.max(2, ((renderMagnitude > 0 ? Math.floor(Math.log2(renderMagnitude)) + 1 : 1) + 1) & ~1);
    bb.writeMethod15(renderDepthOffset < 0);
    bb.writeMethod6((renderBits / 2) - 1, 3);
    bb.writeMethod6(renderMagnitude, renderBits);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod20(Entity.STATE_BITS, Number(entity.entState ?? 0));
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function parseRoomEventStart(payload: Buffer): { roomId: number; flag: boolean } {
    const br = new BitReader(payload);
    return {
        roomId: br.readMethod4(),
        flag: br.readMethod15()
    };
}

function decodeNpcBubblePacket(payload: Buffer): { npcId: number; text: string } {
    const br = new BitReader(payload);
    return {
        npcId: br.readMethod4(),
        text: br.readMethod13()
    };
}

function decodeNewlyRelevantNpcPayload(payload: Buffer): {
    id: number;
    name: string;
    x: number;
    y: number;
    v: number;
    team: number;
    isPlayer: boolean;
    entState: number;
    facingLeft: boolean;
    healthDelta: number;
    buffCount: number;
} {
    const br = new BitReader(payload);
    const id = br.readMethod4();
    const name = br.readMethod13();
    const hasPlayerOptions = br.readMethod15();
    assert.equal(hasPlayerOptions, false, 'NPC spawn payload should not include player appearance options');
    const x = br.readMethod45();
    const y = br.readMethod45();
    const v = br.readMethod45();
    const team = br.readMethod6(2);
    const isPlayer = br.readMethod15();
    assert.equal(isPlayer, false, 'NPC spawn payload should not enter the player field branch');
    br.readMethod15(); // untargetable
    br.readMethod739(); // render depth offset
    if (br.readMethod15()) {
        br.readMethod4(); // behavior speed
    }
    if (br.readMethod15()) {
        br.readMethod13(); // character name
    }
    if (br.readMethod15()) {
        br.readMethod13(); // drama anim
    }
    if (br.readMethod15()) {
        br.readMethod13(); // sleep anim
    }
    if (br.readMethod15()) {
        br.readMethod4(); // summoner
    }
    if (br.readMethod15()) {
        br.readMethod4(); // power
    }
    const entState = br.readMethod6(2);
    const facingLeft = br.readMethod15();
    const healthDelta = br.readMethod45();
    const buffCount = br.readMethod4();
    return { id, name, x, y, v, team, isPlayer, entState, facingLeft, healthDelta, buffCount };
}

function decodeNewlyRelevantPlayerAppearance(payload: Buffer): {
    id: number;
    name: string;
    className: string;
    gender: string;
    headSet: string;
    hairSet: string;
    mouthSet: string;
    faceSet: string;
    hairColor: number;
    skinColor: number;
    shirtColor: number;
    pantColor: number;
    activePetId: number;
    activePetSpecialId: number;
    equippedMount: number;
    activeConsumableId: number;
    hasExtraPetSlots: boolean;
} {
    const br = new BitReader(payload);
    const id = br.readMethod4();
    const name = br.readMethod13();
    const hasPlayerOptions = br.readMethod15();
    assert.equal(hasPlayerOptions, true, 'player spawn payload should include appearance options');

    const className = br.readMethod13();
    const gender = br.readMethod13();
    const headSet = br.readMethod13();
    const hairSet = br.readMethod13();
    const mouthSet = br.readMethod13();
    const faceSet = br.readMethod13();
    const hairColor = br.readMethod6(24);
    const skinColor = br.readMethod6(24);
    const shirtColor = br.readMethod6(24);
    const pantColor = br.readMethod6(24);

    for (let slot = 0; slot < 6; slot++) {
        if (!br.readMethod15()) {
            continue;
        }
        br.readMethod6(11); // gear id
        br.readMethod6(2); // tier
        br.readMethod6(16); // rune 1
        br.readMethod6(16); // rune 2
        br.readMethod6(16); // rune 3
        br.readMethod6(8); // color 1
        br.readMethod6(8); // color 2
    }

    br.readMethod45(); // x
    br.readMethod45(); // y
    br.readMethod45(); // velocity
    br.readMethod6(2); // team
    const isPlayer = br.readMethod15();
    assert.equal(isPlayer, true, 'player spawn payload should enter the player field branch');
    br.readMethod15(); // idle reset
    br.readMethod15(); // spawn fx
    const activePetId = br.readMethod6(7);
    const activePetSpecialId = br.readMethod6(6);
    const equippedMount = br.readMethod6(7);
    const activeConsumableId = br.readMethod6(5);
    const hasExtraPetSlots = br.readMethod15();

    return {
        id,
        name,
        className,
        gender,
        headSet,
        hairSet,
        mouthSet,
        faceSet,
        hairColor,
        skinColor,
        shirtColor,
        pantColor,
        activePetId,
        activePetSpecialId,
        equippedMount,
        activeConsumableId,
        hasExtraPetSlots
    };
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

function testConfiguredLevelsUseClientSpawn(): void {
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

    assert.equal(EntityHandler.isClientSpawnLevel('TutorialDungeon'), true, 'TutorialDungeon should keep local cue-driven spawns');
    for (const levelName of GOBLIN_RIVER_LEVELS) {
        assert.equal(EntityHandler.isClientSpawnLevel(levelName), false, `${levelName} should use server-spawn NPC sync`);
    }
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

function testGoblinRiverUsesServerSpawnedHostiles(): void {
    for (const levelName of GOBLIN_RIVER_LEVELS) {
        const client = createFakeClient('Watcher');
        client.currentLevel = levelName;
        client.levelInstanceId = `${levelName}-instance`;
        client.character = { name: 'Watcher', level: 15 } as any;

        const npcs = NpcLoader.getNpcsForLevel(levelName);
        assert.equal(npcs.length, 102, `${levelName} should load Goblin Camp hostile reference spawns`);
        assert.equal(npcs.every((npc) => Number(npc.team) === 2), true, `${levelName} should keep server hostile NPCs`);

        EntityHandler.sendInitialLevelEntities(client as never, levelName);

        const scopeKey = `${levelName}#${client.levelInstanceId}`;
        const levelMap = GlobalState.levelEntities.get(scopeKey);
        assert.ok(levelMap, `${levelName} should create a scoped server entity map`);
        assert.equal(levelMap?.size, 102, `${levelName} should seed canonical server NPCs`);
        assert.equal(client.sentPackets.filter((packet) => packet.id === 0x0F).length, 102, `${levelName} should send server spawn packets`);
    }
}

function testGoblinRiverCharacterSnapshotSkipsDefeatedServerSpawn(): void {
    const firstNpc = NpcLoader.getNpcsForLevel('GoblinRiverDungeon')[0];
    const firstSpawnKey = getDungeonSnapshotSpawnKey(Entity.fromNpc(firstNpc));
    assert.ok(firstSpawnKey, 'Goblin Camp NPC data should resolve stable spawn keys');

    const client = createFakeClient('Watcher');
    client.currentLevel = 'GoblinRiverDungeon';
    client.levelInstanceId = 'goblin-snapshot-instance';
    client.character = {
        name: 'Watcher',
        level: 15,
        dungeonSnapshots: {
            GoblinRiverDungeon: {
                levelName: 'GoblinRiverDungeon',
                levelInstanceId: 'goblin-snapshot-instance',
                progress: 1,
                deadSpawnKeys: [firstSpawnKey],
                updatedAt: Date.now()
            }
        }
    } as any;

    EntityHandler.sendInitialLevelEntities(client as never, 'GoblinRiverDungeon');

    const levelMap = GlobalState.levelEntities.get('GoblinRiverDungeon#goblin-snapshot-instance');
    assert.ok(levelMap, 'Goblin Camp should create a scoped server entity map from snapshot state');
    assert.equal(levelMap?.has(firstNpc.id), false, 'defeated snapshot enemy should not be re-seeded');
    assert.equal(levelMap?.size, 101, 'only living Goblin Camp enemies should be spawned');
    assert.equal(client.sentPackets.filter((packet) => packet.id === 0x0F).length, 101);
}

function testGoblinRiverClientHostileFullUpdateIsSuppressedInServerDungeon(): void {
    const firstNpc = NpcLoader.getNpcsForLevel('GoblinRiverDungeon')[0];
    const client = createFakeClient('Watcher');
    client.currentLevel = 'GoblinRiverDungeon';
    client.levelInstanceId = 'goblin-server-authority';
    client.character = { name: 'Watcher', level: 15 } as any;

    EntityHandler.sendInitialLevelEntities(client as never, 'GoblinRiverDungeon');
    client.sentPackets.length = 0;

    const duplicateId = 777001;
    const suppressed = (EntityHandler as any).suppressClientSpawnedServerDungeonHostile(
        client as never,
        'GoblinRiverDungeon',
        GlobalState.levelEntities.get('GoblinRiverDungeon#goblin-server-authority'),
        {
            id: duplicateId,
            name: firstNpc.name,
            isPlayer: false,
            x: firstNpc.x,
            y: firstNpc.y,
            v: 0,
            team: 2,
            entState: 0,
            clientSpawned: true
        }
    );

    const levelMap = GlobalState.levelEntities.get('GoblinRiverDungeon#goblin-server-authority');
    assert.equal(suppressed, true, 'client-spawn duplicate should be suppressed in a server-authoritative Goblin Camp scope');
    assert.equal(levelMap?.has(duplicateId), false, 'client-spawn duplicate should not enter a server-authoritative Goblin Camp scope');
    assert.equal(parseDestroyEntityId(client.sentPackets[0]!.payload), duplicateId, 'client-spawn duplicate should be destroyed locally');
    assert.equal(client.knownEntityIds.has(firstNpc.id), true, 'client should keep the canonical server-spawn enemy');
}

async function testGoblinRiverPowerHitKillPersistsBeforeSpawnRetry(): Promise<void> {
    const firstNpc = NpcLoader.getNpcsForLevel('GoblinRiverDungeon')[0];
    const firstSpawnKey = getDungeonSnapshotSpawnKey(Entity.fromNpc(firstNpc));
    assert.ok(firstSpawnKey, 'Goblin Camp NPC data should resolve stable spawn keys');

    const client = createFakeClient('Watcher');
    client.currentLevel = 'GoblinRiverDungeon';
    client.levelInstanceId = 'goblin-hit-persist-instance';
    client.userId = 42;
    client.clientEntID = 18074;
    client.character = { name: 'Watcher', class: 'Mage', level: 15 } as any;

    const scopeKey = 'GoblinRiverDungeon#goblin-hit-persist-instance';
    GlobalState.sessionsByToken.set(client.token, client as never);
    EntityHandler.sendInitialLevelEntities(client as never, 'GoblinRiverDungeon');
    const liveEnemy = GlobalState.levelEntities.get(scopeKey)?.get(firstNpc.id);
    assert.ok(liveEnemy, 'Goblin Camp server enemy should exist before combat damage');
    liveEnemy.maxHp = 10;
    liveEnemy.hp = 10;

    let savedUserId = 0;
    let savedCharacter: any = null;
    const originalSaveCharacterSnapshot = JsonAdapter.prototype.saveCharacterSnapshot;
    JsonAdapter.prototype.saveCharacterSnapshot = async function(userId: number, character: any): Promise<any[]> {
        savedUserId = userId;
        savedCharacter = character;
        return [character];
    };

    try {
        await CombatHandler.handlePowerHit(
            client as never,
            buildPowerHitPayload(firstNpc.id, client.clientEntID, 999999, 77)
        );
    } finally {
        JsonAdapter.prototype.saveCharacterSnapshot = originalSaveCharacterSnapshot;
    }

    assert.equal(savedUserId, 42);
    assert.deepEqual(savedCharacter?.dungeonSnapshots?.GoblinRiverDungeon?.deadSpawnKeys, [firstSpawnKey]);

    client.sentPackets.length = 0;
    EntityHandler.sendInitialLevelEntities(client as never, 'GoblinRiverDungeon');

    const levelMap = GlobalState.levelEntities.get(scopeKey);
    assert.equal(levelMap?.has(firstNpc.id), false, 'server spawn retry should not re-seed a killed Goblin Camp enemy');
    assert.equal(
        client.sentPackets
            .filter((packet) => packet.id === 0x0F)
            .some((packet) => decodeNewlyRelevantNpcPayload(packet.payload).id === firstNpc.id),
        false,
        'server spawn retry should not resend the killed Goblin Camp enemy'
    );
}

function testDerelictionUsesServerSpawnedHostiles(): void {
    for (const levelName of ['BT_Mission4', 'BT_Mission4Hard'] as const) {
        const client = createFakeClient('Watcher');
        client.currentLevel = levelName;
        client.levelInstanceId = `${levelName}-instance`;
        client.character = { name: 'Watcher', level: 15 } as any;

        assert.equal(EntityHandler.isClientSpawnLevel(levelName), false, `${levelName} should not use client-spawn NPC sync`);

        const npcs = NpcLoader.getNpcsForLevel(levelName);
        assert.equal(npcs.length, 140, `${levelName} should load Dereliction hostile reference spawns`);
        assert.equal(npcs.every((npc) => Number(npc.team) === 2), true, `${levelName} should keep server hostile NPCs`);

        EntityHandler.sendInitialLevelEntities(client as never, levelName);

        const scopeKey = `${levelName}#${client.levelInstanceId}`;
        const levelMap = GlobalState.levelEntities.get(scopeKey);
        assert.ok(levelMap, `${levelName} should create a scoped server entity map`);
        assert.equal(levelMap?.size, 140, `${levelName} should seed canonical server NPCs`);
        assert.equal(client.sentPackets.filter((packet) => packet.id === 0x0F).length, 140, `${levelName} should send server spawn packets`);
        assert.equal(client.sentPackets.length, 140, `${levelName} initial join should only send spawn packets`);

        const firstSpawn = client.sentPackets.find((packet) => packet.id === 0x0F);
        assert.ok(firstSpawn, `${levelName} should send at least one spawn packet`);
        const decoded = decodeNewlyRelevantNpcPayload(firstSpawn.payload);
        assert.equal(decoded.id, npcs[0].id, `${levelName} spawn packet should preserve server entity id`);
        assert.equal(decoded.name, npcs[0].name, `${levelName} spawn packet should preserve enemy type`);
        assert.equal(decoded.team, 2, `${levelName} spawn packet should decode as enemy team`);
        assert.equal(decoded.healthDelta, 0, `${levelName} spawn packet should align health delta with client decode order`);
        assert.equal(decoded.buffCount, 0, `${levelName} spawn packet should align buff count with client decode order`);
    }
}

function testNpcSpawnPayloadMatchesClientDecodeOrderAfterFacing(): void {
    const payload = Entity.serialize({
        id: 123456,
        name: 'MeylourMage',
        isPlayer: false,
        x: 100,
        y: 200,
        v: 0,
        team: 2,
        entState: 0,
        facingLeft: true,
        healthDelta: 7,
        buffs: []
    });

    const decoded = decodeNewlyRelevantNpcPayload(payload);
    assert.equal(decoded.id, 123456);
    assert.equal(decoded.name, 'MeylourMage');
    assert.equal(decoded.facingLeft, true);
    assert.equal(decoded.healthDelta, 7, 'NPC healthDelta should immediately follow facingLeft in the client 0x0F decode');
    assert.equal(decoded.buffCount, 0);
}

function testDerelictionCharacterSnapshotSkipsDefeatedServerSpawn(): void {
    const firstNpc = NpcLoader.getNpcsForLevel('BT_Mission4')[0];
    assert.ok(firstNpc?.spawnKey, 'Dereliction NPC data should include stable spawn keys');

    const client = createFakeClient('Watcher');
    client.currentLevel = 'BT_Mission4';
    client.levelInstanceId = 'snapshot-instance';
    client.character = {
        name: 'Watcher',
        level: 15,
        dungeonSnapshots: {
            BT_Mission4: {
                levelName: 'BT_Mission4',
                levelInstanceId: 'snapshot-instance',
                progress: 1,
                deadSpawnKeys: [firstNpc.spawnKey],
                updatedAt: Date.now()
            }
        }
    } as any;

    EntityHandler.sendInitialLevelEntities(client as never, 'BT_Mission4');

    const levelMap = GlobalState.levelEntities.get('BT_Mission4#snapshot-instance');
    assert.ok(levelMap, 'Dereliction should create a scoped server entity map from snapshot state');
    assert.equal(levelMap?.has(firstNpc.id), false, 'defeated snapshot enemy should not be re-seeded');
    assert.equal(levelMap?.size, 139, 'only living Dereliction enemies should be spawned');
    assert.equal(client.sentPackets.filter((packet) => packet.id === 0x0F).length, 139);
}

function testDerelictionProgressUsesReferenceSpawnCountBeforeSeeding(): void {
    const firstNpc = NpcLoader.getNpcsForLevel('BT_Mission4')[0];
    assert.ok(firstNpc?.spawnKey, 'Dereliction NPC data should include stable spawn keys');

    const scopeKey = 'BT_Mission4#partial-known-dead';
    GlobalState.levelQuestProgress.set(scopeKey, {
        progress: 0,
        authorityToken: 0,
        trackedHostileIds: new Set([firstNpc.id]),
        defeatedHostileIds: new Set([firstNpc.id]),
        defeatedSpawnKeys: new Set([firstNpc.spawnKey]),
        liveStatsByCharacter: new Map()
    });

    const sharedState = recomputeSharedDungeonProgress(scopeKey);
    const totals = getSharedDungeonProgressTotals(scopeKey);

    assert.equal(totals.total, 140, 'Dereliction progress should count against the full server NPC reference set before spawn seeding finishes');
    assert.equal(totals.defeated, 1, 'only the known defeated Dereliction spawn should count as defeated');
    assert.ok(Number(sharedState?.progress ?? 100) < 100, 'one defeated Dereliction enemy must not complete the dungeon before all server hostiles are defeated');
}

async function testDerelictionLatePartyJoinerUsesSharedDefeatedRegistry(): Promise<void> {
    const firstNpc = NpcLoader.getNpcsForLevel('BT_Mission4')[0];
    assert.ok(firstNpc?.spawnKey, 'Dereliction NPC data should include stable spawn keys');

    const scopeKey = 'BT_Mission4#party-shared-defeats';
    const leader = createFakeClient('Alpha');
    leader.currentLevel = 'BT_Mission4';
    leader.levelInstanceId = 'party-shared-defeats';
    leader.userId = 42;
    leader.clientEntID = 18074;
    leader.character = { name: 'Alpha', class: 'Mage', level: 15 } as any;

    GlobalState.sessionsByToken.set(leader.token, leader as never);
    EntityHandler.sendInitialLevelEntities(leader as never, 'BT_Mission4');
    const liveEnemy = GlobalState.levelEntities.get(scopeKey)?.get(firstNpc.id);
    assert.ok(liveEnemy, 'Dereliction leader should have a canonical server enemy before the kill');
    liveEnemy.maxHp = 10;
    liveEnemy.hp = 10;

    const originalSaveCharacterSnapshot = JsonAdapter.prototype.saveCharacterSnapshot;
    JsonAdapter.prototype.saveCharacterSnapshot = async function(userId: number, character: any): Promise<any[]> {
        return [character];
    };

    try {
        await CombatHandler.handlePowerHit(
            leader as never,
            buildPowerHitPayload(firstNpc.id, leader.clientEntID, 999999, 77)
        );
    } finally {
        JsonAdapter.prototype.saveCharacterSnapshot = originalSaveCharacterSnapshot;
    }

    assert.equal(
        getSharedDungeonDefeatedSpawnKeys(scopeKey).has(firstNpc.spawnKey),
        true,
        'Dereliction kill should register the stable spawn key on the shared instance'
    );

    const joiner = createFakeClient('Beta');
    joiner.currentLevel = 'BT_Mission4';
    joiner.levelInstanceId = 'party-shared-defeats';
    joiner.userId = 43;
    joiner.clientEntID = 18075;
    joiner.character = { name: 'Beta', class: 'Mage', level: 15 } as any;

    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    GlobalState.partyGroups.set(3901, {
        id: 3901,
        leader: 'Alpha',
        members: ['Alpha', 'Beta'],
        locked: false
    });
    GlobalState.partyByMember.set('alpha', 3901);
    GlobalState.partyByMember.set('beta', 3901);

    assert.equal(
        LevelHandler.prepareGoblinRiverDungeonEntryState(joiner as never),
        true,
        'late Dereliction party joiner should sync shared defeated enemies into its snapshot on entry'
    );
    assert.deepEqual(
        (joiner.character as any).dungeonSnapshots?.BT_Mission4?.deadSpawnKeys,
        [firstNpc.spawnKey],
        'late party joiner snapshot should receive already-defeated shared enemies'
    );

    joiner.sentPackets.length = 0;
    EntityHandler.sendInitialLevelEntities(joiner as never, 'BT_Mission4');

    const levelMap = GlobalState.levelEntities.get(scopeKey);
    assert.equal(levelMap?.has(firstNpc.id), false, 'late party joiner should not resurrect the defeated Dereliction enemy');
    assert.equal(
        joiner.sentPackets
            .filter((packet) => packet.id === 0x0F)
            .some((packet) => decodeNewlyRelevantNpcPayload(packet.payload).id === firstNpc.id),
        false,
        'late party joiner should not receive a spawn packet for the defeated Dereliction enemy'
    );
}

function testDerelictionClientHostileFullUpdateIsSuppressedInServerDungeon(): void {
    const firstNpc = NpcLoader.getNpcsForLevel('BT_Mission4')[0];
    assert.ok(firstNpc?.spawnKey, 'Dereliction NPC data should include stable spawn keys');

    const client = createFakeClient('Watcher');
    client.currentLevel = 'BT_Mission4';
    client.levelInstanceId = 'dereliction-server-authority';
    client.character = { name: 'Watcher', level: 15 } as any;

    EntityHandler.sendInitialLevelEntities(client as never, 'BT_Mission4');
    client.sentPackets.length = 0;

    const duplicateId = 777101;
    const suppressed = (EntityHandler as any).suppressClientSpawnedServerDungeonHostile(
        client as never,
        'BT_Mission4',
        GlobalState.levelEntities.get('BT_Mission4#dereliction-server-authority'),
        {
            id: duplicateId,
            name: firstNpc.name,
            isPlayer: false,
            x: firstNpc.x,
            y: firstNpc.y,
            v: 0,
            team: 2,
            entState: 0,
            clientSpawned: true
        }
    );

    const levelMap = GlobalState.levelEntities.get('BT_Mission4#dereliction-server-authority');
    assert.equal(suppressed, true, 'client-spawn duplicate should be suppressed in a server-authoritative Dereliction scope');
    assert.equal(levelMap?.has(duplicateId), false, 'client-spawn duplicate should not enter a server-authoritative Dereliction scope');
    assert.equal(parseDestroyEntityId(client.sentPackets[0]!.payload), duplicateId, 'client-spawn duplicate should be destroyed locally');
    assert.equal(client.knownEntityIds.has(firstNpc.id), true, 'client should keep the canonical server-spawn Dereliction enemy');
}

function testAllMissionDungeonsUsePersistentSnapshots(): void {
    assert.equal(isPersistentDungeonSnapshotLevel('SRN_Mission4'), true, 'ordinary mission dungeons should use persistent dungeon snapshots');
    assert.equal(isPersistentDungeonSnapshotLevel('BT_Mission2Hard'), true, 'hard mission dungeons should use persistent dungeon snapshots');
    assert.equal(isPersistentDungeonSnapshotLevel('TutorialDungeon'), false, 'tutorial levels should stay out of persistent dungeon snapshots');
}

function testPersistentDungeonSuppressesDefeatedClientSpawnHostile(): void {
    const client = createFakeClient('Watcher');
    client.currentLevel = 'SRN_Mission4';
    client.levelInstanceId = 'all-dungeon-client-spawn';
    client.character = {
        name: 'Watcher',
        level: 15,
        dungeonSnapshots: {
            SRN_Mission4: {
                levelName: 'SRN_Mission4',
                levelInstanceId: 'all-dungeon-client-spawn',
                progress: 17,
                deadSpawnKeys: ['3:WyrmGreat:1200:900:771001'],
                updatedAt: Date.now()
            }
        }
    } as any;

    const levelMap = new Map<number, any>();
    GlobalState.levelEntities.set('SRN_Mission4#all-dungeon-client-spawn', levelMap);
    client.sentPackets.length = 0;

    const suppressed = (EntityHandler as any).suppressDefeatedPersistentDungeonHostile(
        client as never,
        'SRN_Mission4',
        levelMap,
        {
            id: 771001,
            name: 'WyrmGreat',
            isPlayer: false,
            roomId: 3,
            x: 1200,
            y: 900,
            v: 0,
            team: 2,
            entState: 0,
            clientSpawned: true
        }
    );

    assert.equal(suppressed, true, 'persistent snapshots should suppress already-defeated client-spawn dungeon hostiles');
    assert.equal(levelMap.has(771001), false, 'suppressed defeated client hostile should not enter the shared dungeon map');
    assert.equal(parseDestroyEntityId(client.sentPackets[0]!.payload), 771001, 'suppressed defeated client hostile should be destroyed locally');
}

function testBridgeTownMission2SeedsServerHostiles(): void {
    const npcs = NpcLoader.getNpcsForLevel('BT_Mission2');
    assert.equal(npcs.length, 81, 'BT_Mission2 should load authored hostile reference spawns');

    const client = createFakeClient('Watcher');
    client.currentLevel = 'BT_Mission2';
    client.levelInstanceId = 'bt-mission2-server-spawn';
    client.character = { name: 'Watcher', level: 15 } as any;

    EntityHandler.sendInitialLevelEntities(client as never, 'BT_Mission2');

    const levelMap = GlobalState.levelEntities.get('BT_Mission2#bt-mission2-server-spawn');
    assert.equal(levelMap?.size, 81, 'BT_Mission2 should seed server hostile entities');
    assert.equal(client.sentPackets.filter((packet) => packet.id === 0x0F).length, 81);
}

function testDerelictionNewInstanceResetsStaleCharacterSnapshot(): void {
    const firstNpc = NpcLoader.getNpcsForLevel('BT_Mission4')[0];
    assert.ok(firstNpc?.spawnKey, 'Dereliction NPC data should include stable spawn keys');

    const client = createFakeClient('Watcher');
    client.currentLevel = 'BT_Mission4';
    client.levelInstanceId = 'fresh-instance';
    client.character = {
        name: 'Watcher',
        level: 15,
        dungeonSnapshots: {
            BT_Mission4: {
                levelName: 'BT_Mission4',
                levelInstanceId: 'old-instance',
                progress: 100,
                deadSpawnKeys: [firstNpc.spawnKey],
                updatedAt: Date.now()
            }
        }
    } as any;

    EntityHandler.sendInitialLevelEntities(client as never, 'BT_Mission4');

    const snapshot = (client.character as any).dungeonSnapshots.BT_Mission4;
    const levelMap = GlobalState.levelEntities.get('BT_Mission4#fresh-instance');
    assert.ok(levelMap, 'fresh Dereliction instance should create a scoped server entity map');
    assert.equal(levelMap?.size, 140, 'fresh Dereliction instance should not inherit stale defeated enemies');
    assert.equal(client.sentPackets.filter((packet) => packet.id === 0x0F).length, 140);
    assert.equal(snapshot.levelInstanceId, 'fresh-instance');
    assert.equal(snapshot.progress, 0);
    assert.deepEqual(snapshot.deadSpawnKeys, []);
}

function testDerelictionIncompleteSnapshotReusesInstanceOnReentry(): void {
    const firstNpc = NpcLoader.getNpcsForLevel('BT_Mission4')[0];
    assert.ok(firstNpc?.spawnKey, 'Dereliction NPC data should include stable spawn keys');

    const client = createFakeClient('Watcher');
    client.currentLevel = 'BridgeTown';
    client.levelInstanceId = '';
    client.character = {
        name: 'Watcher',
        level: 15,
        dungeonSnapshots: {
            BT_Mission4: {
                levelName: 'BT_Mission4',
                levelInstanceId: 'saved-dereliction-run',
                progress: 2,
                deadSpawnKeys: [firstNpc.spawnKey],
                updatedAt: Date.now()
            }
        }
    } as any;

    assert.equal(
        getReusableIncompleteDungeonSnapshotInstanceId(client.character as any, 'BT_Mission4'),
        'saved-dereliction-run',
        'incomplete Dereliction snapshots should be eligible for re-entry'
    );

    const syncState = (LevelHandler as any).buildTransferSyncState(client as never, 'BT_Mission4', null);
    assert.equal(syncState?.levelInstanceId, 'saved-dereliction-run', 'Dereliction re-entry should reuse the incomplete snapshot instance');
}

function testDerelictionFreshRunReplacesStaleDeadServerScope(): void {
    const firstNpc = NpcLoader.getNpcsForLevel('BT_Mission4')[0];
    assert.ok(firstNpc?.spawnKey, 'Dereliction NPC data should include stable spawn keys');

    const client = createFakeClient('Watcher');
    client.currentLevel = 'BT_Mission4';
    client.levelInstanceId = 'stale-dead-scope';
    client.character = {
        name: 'Watcher',
        level: 15,
        dungeonSnapshots: {
            BT_Mission4: {
                levelName: 'BT_Mission4',
                levelInstanceId: 'stale-dead-scope',
                progress: 0,
                deadSpawnKeys: [],
                updatedAt: Date.now()
            }
        }
    } as any;

    const scopeKey = 'BT_Mission4#stale-dead-scope';
    GlobalState.levelEntities.set(scopeKey, new Map([
        [firstNpc.id, {
            ...Entity.fromNpc(firstNpc),
            dead: true,
            hp: 0,
            entState: EntityState.DEAD
        }]
    ]));
    GlobalState.levelQuestProgress.set(scopeKey, {
        progress: 100,
        authorityToken: 0,
        trackedHostileIds: new Set([firstNpc.id]),
        defeatedHostileIds: new Set([firstNpc.id]),
        liveStatsByCharacter: new Map()
    });

    EntityHandler.sendInitialLevelEntities(client as never, 'BT_Mission4');

    const levelMap = GlobalState.levelEntities.get(scopeKey);
    const revivedEnemy = levelMap?.get(firstNpc.id);
    assert.ok(levelMap, 'fresh Dereliction run should keep a scoped server entity map');
    assert.equal(levelMap?.size, 140, 'fresh Dereliction run should seed all live server hostiles');
    assert.notEqual(Boolean(revivedEnemy?.dead), true, 'stale dead server entity should be replaced with a live spawn');
    assert.notEqual(Number(revivedEnemy?.entState ?? EntityState.ACTIVE), EntityState.DEAD);
    assert.equal(recomputeSharedDungeonProgress(scopeKey)?.progress, 0);
}

function testDerelictionExistingEmptyScopeStillSeedsServerHostiles(): void {
    const client = createFakeClient('Watcher');
    client.currentLevel = 'BT_Mission4';
    client.levelInstanceId = 'previously-empty';
    client.character = { name: 'Watcher', level: 15 } as any;
    GlobalState.levelEntities.set('BT_Mission4#previously-empty', new Map());

    EntityHandler.sendInitialLevelEntities(client as never, 'BT_Mission4');

    const levelMap = GlobalState.levelEntities.get('BT_Mission4#previously-empty');
    assert.equal(levelMap?.size, 140, 'existing empty Dereliction scope should still be seeded by the server');
    assert.equal(client.sentPackets.filter((packet) => packet.id === 0x0F).length, 140);
}

async function testDerelictionDestroyedServerEnemyPersistsCharacterSnapshot(): Promise<void> {
    const firstNpc = NpcLoader.getNpcsForLevel('BT_Mission4')[0];
    assert.ok(firstNpc?.spawnKey, 'Dereliction NPC data should include stable spawn keys');

    const client = createFakeClient('Watcher');
    client.currentLevel = 'BT_Mission4';
    client.levelInstanceId = 'persist-instance';
    client.userId = 42;
    client.character = { name: 'Watcher', level: 15 } as any;
    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.levelQuestProgress.set('BT_Mission4#persist-instance', {
        progress: 12,
        authorityToken: 0,
        trackedHostileIds: new Set([firstNpc.id]),
        defeatedHostileIds: new Set([firstNpc.id]),
        liveStatsByCharacter: new Map()
    });

    let savedUserId = 0;
    let savedCharacter: any = null;
    const originalSaveCharacterSnapshot = JsonAdapter.prototype.saveCharacterSnapshot;
    JsonAdapter.prototype.saveCharacterSnapshot = async function(userId: number, character: any): Promise<any[]> {
        savedUserId = userId;
        savedCharacter = character;
        return [character];
    };

    try {
        await LevelHandler.persistDungeonEnemyDestroyed('BT_Mission4#persist-instance', {
            ...Entity.fromNpc(firstNpc),
            clientSpawned: false
        });
    } finally {
        JsonAdapter.prototype.saveCharacterSnapshot = originalSaveCharacterSnapshot;
    }

    assert.equal(savedUserId, 42);
    assert.equal(savedCharacter?.dungeonSnapshots?.BT_Mission4?.progress, 12);
    assert.deepEqual(savedCharacter?.dungeonSnapshots?.BT_Mission4?.deadSpawnKeys, [firstNpc.spawnKey]);
    assert.equal(
        getSharedDungeonDefeatedSpawnKeys('BT_Mission4#persist-instance').has(firstNpc.spawnKey),
        true,
        'persisting a Dereliction enemy death should update the shared defeated-spawn registry'
    );
}

async function testDerelictionRewardPacketPersistsDefeatedServerEnemySnapshot(): Promise<void> {
    const firstNpc = NpcLoader.getNpcsForLevel('BT_Mission4')[0];
    assert.ok(firstNpc?.spawnKey, 'Dereliction NPC data should include stable spawn keys');

    const client = createFakeClient('Watcher');
    client.currentLevel = 'BT_Mission4';
    client.levelInstanceId = 'reward-persist-instance';
    client.userId = 42;
    client.clientEntID = 18074;
    client.character = { name: 'Watcher', class: 'Mage', level: 15 } as any;

    const scopeKey = 'BT_Mission4#reward-persist-instance';
    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.levelEntities.set(scopeKey, new Map([
        [firstNpc.id, {
            ...Entity.fromNpc(firstNpc),
            id: firstNpc.id,
            spawnKey: firstNpc.spawnKey
        }]
    ]));
    GlobalState.levelQuestProgress.set(scopeKey, {
        progress: 0,
        authorityToken: 0,
        trackedHostileIds: new Set([firstNpc.id]),
        defeatedHostileIds: new Set(),
        liveStatsByCharacter: new Map()
    });

    let savedUserId = 0;
    let savedCharacter: any = null;
    const originalSaveCharacterSnapshot = JsonAdapter.prototype.saveCharacterSnapshot;
    JsonAdapter.prototype.saveCharacterSnapshot = async function(userId: number, character: any): Promise<any[]> {
        savedUserId = userId;
        savedCharacter = character;
        return [character];
    };

    try {
        await RewardHandler.handleGrantReward(
            client as never,
            buildRewardRequestPayload(client.clientEntID, firstNpc.id, firstNpc.x, firstNpc.y)
        );
    } finally {
        JsonAdapter.prototype.saveCharacterSnapshot = originalSaveCharacterSnapshot;
    }

    assert.equal(savedUserId, 42);
    assert.deepEqual(savedCharacter?.dungeonSnapshots?.BT_Mission4?.deadSpawnKeys, [firstNpc.spawnKey]);
    assert.equal(
        getSharedDungeonDefeatedSpawnKeys(scopeKey).has(firstNpc.spawnKey),
        true,
        'reward-proven Dereliction defeat should update the shared defeated-spawn registry'
    );
    assert.notEqual(GlobalState.levelEntities.get(scopeKey)?.has(firstNpc.id), true, 'reward-proven defeated Dereliction enemy should be removed from canonical scope');
}

async function testDerelictionPowerHitKillPersistsBeforeSpawnRetry(): Promise<void> {
    const firstNpc = NpcLoader.getNpcsForLevel('BT_Mission4')[0];
    assert.ok(firstNpc?.spawnKey, 'Dereliction NPC data should include stable spawn keys');

    const client = createFakeClient('Watcher');
    client.currentLevel = 'BT_Mission4';
    client.levelInstanceId = 'hit-persist-instance';
    client.userId = 42;
    client.clientEntID = 18074;
    client.character = { name: 'Watcher', class: 'Mage', level: 15 } as any;

    const scopeKey = 'BT_Mission4#hit-persist-instance';
    GlobalState.sessionsByToken.set(client.token, client as never);
    EntityHandler.sendInitialLevelEntities(client as never, 'BT_Mission4');
    const liveEnemy = GlobalState.levelEntities.get(scopeKey)?.get(firstNpc.id);
    assert.ok(liveEnemy, 'Dereliction server enemy should exist before combat damage');
    liveEnemy.maxHp = 10;
    liveEnemy.hp = 10;

    let savedUserId = 0;
    let savedCharacter: any = null;
    const originalSaveCharacterSnapshot = JsonAdapter.prototype.saveCharacterSnapshot;
    JsonAdapter.prototype.saveCharacterSnapshot = async function(userId: number, character: any): Promise<any[]> {
        savedUserId = userId;
        savedCharacter = character;
        return [character];
    };

    try {
        await CombatHandler.handlePowerHit(
            client as never,
            buildPowerHitPayload(firstNpc.id, client.clientEntID, 999999, 77)
        );
    } finally {
        JsonAdapter.prototype.saveCharacterSnapshot = originalSaveCharacterSnapshot;
    }

    assert.equal(savedUserId, 42);
    assert.deepEqual(savedCharacter?.dungeonSnapshots?.BT_Mission4?.deadSpawnKeys, [firstNpc.spawnKey]);
    assert.equal(
        getSharedDungeonDefeatedSpawnKeys(scopeKey).has(firstNpc.spawnKey),
        true,
        'combat-killed Dereliction enemy should update the shared defeated-spawn registry'
    );

    client.sentPackets.length = 0;
    EntityHandler.sendInitialLevelEntities(client as never, 'BT_Mission4');

    const levelMap = GlobalState.levelEntities.get(scopeKey);
    assert.equal(levelMap?.has(firstNpc.id), false, 'server spawn retry should not re-seed an enemy killed by combat damage');
    assert.equal(
        client.sentPackets
            .filter((packet) => packet.id === 0x0F)
            .some((packet) => decodeNewlyRelevantNpcPayload(packet.payload).id === firstNpc.id),
        false,
        'server spawn retry should not resend the killed Dereliction enemy'
    );
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

function testOutdoorHostileClientSpawnStaysPrivateToPartyPeers(): void {
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

    assert.equal(partyKnown, true, 'TutorialDungeon hostiles should seed from the owner to party joiners');
    assert.deepEqual(partyWatcher.sentPackets.map((packet) => packet.id), expectedDuplicateDestroyPacketIds());
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
    assert.equal(suppressed, true, 'TutorialDungeon follower hostiles should collapse to the owner canonical hostile');
    assert.equal(levelMap?.size, 1, 'duplicate dungeon hostile should not be added as a second shared entity');
    assert.deepEqual(follower.sentPackets.map((packet) => packet.id), expectedDuplicateDestroyPacketIds());
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
    assert.equal(suppressed, true, 'TutorialDungeon follower hostiles should collapse across unsynced room state');
    assert.equal(levelMap?.size, 1, 'cross-room dungeon hostile should still collapse to the existing shared entity');
    assert.deepEqual(follower.sentPackets.map((packet) => packet.id), expectedDuplicateDestroyPacketIds());
    assert.equal(follower.knownEntityIds.has(canonical.id), true);
    assert.equal(follower.knownEntityIds.has(3302), false);
    assert.equal(follower.entities.has(3302), false);
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

    assert.equal(suppressed, false, 'TutorialDungeon target dummy spawns should remain local to each tutorial client');
    assert.deepEqual(follower.sentPackets.map((packet) => packet.id), []);
    assert.equal(follower.knownEntityIds.has(canonical.id), false);
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

function testTutorialDungeonSameIdHostileDuplicateDestroysAndReseedsCanonical(): void {
    const owner = createFakeClient('Alpha');
    const follower = createFakeClient('Beta');

    owner.currentLevel = 'TutorialDungeon';
    follower.currentLevel = 'TutorialDungeon';
    owner.levelInstanceId = 'same-id-hostile';
    follower.levelInstanceId = 'same-id-hostile';
    owner.currentRoomId = 1;
    follower.currentRoomId = 1;

    const canonical = {
        id: 2502,
        name: 'IntroGoblinClub',
        isPlayer: false,
        x: 300,
        y: 410,
        v: 0,
        team: 2,
        entState: 0,
        clientSpawned: true,
        ownerToken: owner.token,
        ownerPartyId: 195,
        roomId: owner.currentRoomId
    };

    GlobalState.levelEntities.set('TutorialDungeon#same-id-hostile', new Map([[canonical.id, canonical]]));
    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(follower.token, follower as never);
    GlobalState.partyByMember.set('alpha', 195);
    GlobalState.partyByMember.set('beta', 195);
    follower.knownEntityIds.add(canonical.id);
    follower.entities.set(canonical.id, { ...canonical, ownerToken: follower.token });

    const suppressed = (EntityHandler as any).suppressDuplicateSharedClientSpawn(
        follower as never,
        'TutorialDungeon',
        GlobalState.levelEntities.get('TutorialDungeon#same-id-hostile'),
        {
            ...canonical,
            ownerToken: follower.token
        }
    );

    assert.equal(suppressed, true, 'same-id TutorialDungeon hostile duplicates should lose authority');
    assert.deepEqual(
        follower.sentPackets.map((packet) => packet.id),
        expectedDuplicateDestroyPacketIds(),
        'same-id hostile duplicate should be destroyed before the creator canonical is re-seeded'
    );
    assert.equal(parseDestroyEntityId(follower.sentPackets[0]!.payload), canonical.id);
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

    assert.deepEqual(joiner.sentPackets.map((packet) => packet.id), expectedDuplicateDestroyPacketIds());
    assert.equal(canonical.ownerPartyId, 96, 'TutorialDungeon hostile references should promote into party-shared enemies');
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

    assert.deepEqual(joiner.sentPackets.map((packet) => packet.id), []);
    assert.equal(canonical.ownerPartyId, 0, 'TutorialDungeon NPC references should not be promoted into party-shared NPCs');
    assert.equal(joiner.knownEntityIds.has(canonical.id), false);
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

function testIncompleteRemotePlayerSaveSerializesSafeAppearance(): void {
    const anchor = createFakeClient('Incomplete');
    const joiner = createFakeClient('Viewer');

    anchor.currentLevel = 'NewbieRoad';
    joiner.currentLevel = 'NewbieRoad';
    anchor.clientEntID = 8101;
    joiner.clientEntID = 8102;
    anchor.character = { name: 'Incomplete' };
    anchor.entities.set(anchor.clientEntID, {
        id: anchor.clientEntID,
        name: 'Incomplete',
        isPlayer: true,
        x: 100,
        y: 200,
        team: 1,
        entState: 0
    });

    GlobalState.sessionsByToken.set(anchor.token, anchor as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);

    (EntityHandler as any).sendExistingPlayersToJoiner(joiner as never);

    const spawnPacket = joiner.sentPackets.find((packet) => packet.id === 0x0F);
    assert.ok(spawnPacket, 'joiner should receive the existing player spawn');
    const decoded = decodeNewlyRelevantPlayerAppearance(spawnPacket.payload);

    assert.equal(decoded.id, anchor.clientEntID);
    assert.equal(decoded.name, 'Incomplete');
    assert.equal(decoded.className, 'Paladin');
    assert.equal(decoded.gender, 'Male');
    assert.equal(decoded.headSet, 'Short');
    assert.equal(decoded.hairSet, 'Do10');
    assert.equal(decoded.mouthSet, 'M08');
    assert.equal(decoded.faceSet, 'F13');
    assert.equal(decoded.hairColor, 10325505);
    assert.equal(decoded.skinColor, 10060614);
    assert.equal(decoded.shirtColor, 3273228);
    assert.equal(decoded.pantColor, 208786);
    assert.equal(decoded.hasExtraPetSlots, false);
}

function testRemotePlayerSpawnDoesNotSerializeAbilitiesAsPets(): void {
    const payload = Entity.serialize(Entity.fromCharacter(8201, {
        name: 'Caster',
        class: 'Mage',
        gender: 'Male',
        level: 10,
        equippedMount: 1,
        activePet: { typeID: 65, special_id: 21 },
        activeConsumableID: 0,
        learnedAbilities: [
            { abilityID: 98, rank: 10 },
            { abilityID: 100, rank: 10 },
            { abilityID: 103, rank: 10 }
        ],
        equippedGears: []
    } as any, {
        x: 100,
        y: 200,
        team: 1,
        entState: 0
    }));

    const decoded = decodeNewlyRelevantPlayerAppearance(payload);
    assert.equal(decoded.activePetId, 65);
    assert.equal(decoded.activePetSpecialId, 21);
    assert.equal(decoded.equippedMount, 1);
    assert.equal(decoded.activeConsumableId, 0);
    assert.equal(decoded.hasExtraPetSlots, false, 'learned abilities must not be encoded into the extra pet slot block');
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
            expectedDuplicateDestroyPacketIds(),
            `${levelName} follower should destroy its duplicate and adopt the leader hostile`
        );
        assert.equal(parseDestroyEntityId(follower.sentPackets[0]!.payload), 6302);
        assert.equal(follower.knownEntityIds.has(canonical.id), true);
        assert.equal(follower.knownEntityIds.has(6302), false);
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
            expectedDuplicateDestroyPacketIds(),
            `${levelName} late leader should destroy its duplicate and receive the follower canonical hostile`
        );
        assert.equal(parseDestroyEntityId(leader.sentPackets[0]!.payload), 7402);
        assert.equal(leader.knownEntityIds.has(canonical.id), true);
        assert.equal(leader.knownEntityIds.has(7402), false);
        assert.equal(levelMap.size, 1, `${levelName} late leader dedupe should keep only the canonical hostile in scope`);
    }
}

function testDungeonTeamOwnedHostilesSurviveCreatorDisconnect(): void {
    for (const levelName of GOBLIN_RIVER_LEVELS) {
        const owner = createFakeClient('Alpha');
        const follower = createFakeClient('Beta');
        owner.currentLevel = levelName;
        follower.currentLevel = levelName;
        owner.levelInstanceId = 'team-owned-disconnect';
        follower.levelInstanceId = 'team-owned-disconnect';
        owner.currentRoomId = 4;
        follower.currentRoomId = 4;
        owner.clientEntID = 7501;
        follower.clientEntID = 7502;

        const hostile = createGoblinRiverHostile(7601, 'GoblinArmorAxe', owner.token, 241, owner.currentRoomId);
        const levelMap = new Map<number, any>([
            [owner.clientEntID, { id: owner.clientEntID, name: 'Alpha', isPlayer: true }],
            [follower.clientEntID, { id: follower.clientEntID, name: 'Beta', isPlayer: true }],
            [hostile.id, hostile]
        ]);

        GlobalState.levelEntities.set(`${levelName}#team-owned-disconnect`, levelMap);
        GlobalState.sessionsByToken.set(owner.token, owner as never);
        GlobalState.sessionsByToken.set(follower.token, follower as never);
        GlobalState.partyByMember.set('alpha', 241);
        GlobalState.partyByMember.set('beta', 241);
        GlobalState.partyGroups.set(241, { id: 241, leader: 'Alpha', members: ['Alpha', 'Beta'], locked: false });

        const removed = EntityHandler.removeOwnedEntities(owner as never);

        assert.deepEqual(removed, [owner.clientEntID], `${levelName} creator disconnect should only remove the creator player entity`);
        assert.equal(levelMap.has(hostile.id), true, `${levelName} team hostile should stay alive after its original owner leaves`);
        assert.equal(levelMap.get(hostile.id)?.ownerToken, 0, `${levelName} preserved hostile should no longer belong to the departed token`);
        assert.equal(levelMap.get(hostile.id)?.ownerPartyId, 241, `${levelName} preserved hostile should remain party-owned`);
        assert.deepEqual(
            follower.sentPackets.filter((packet) => packet.id === 0x0D).map((packet) => parseDestroyEntityId(packet.payload)),
            [owner.clientEntID],
            `${levelName} follower should not receive a destroy packet for the preserved hostile`
        );
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

function testDungeonServerSpawnHostilesUsePlayerRuntimeLevel(): void {
    const client = createFakeClient('Scaler');
    client.currentLevel = 'GoblinRiverDungeon';
    client.levelInstanceId = 'scaled-run';
    client.character = {
        ...client.character,
        level: 37,
        xp: 0
    } as any;
    client.clientEntID = 9001;

    EntityHandler.sendInitialLevelEntities(client as never, 'GoblinRiverDungeon');

    const levelScope = getClientLevelScope(client as never);
    const firstNpc = NpcLoader.getNpcsForLevel('GoblinRiverDungeon')[0];
    const hostile = GlobalState.levelEntities.get(levelScope)?.get(firstNpc.id);
    assert.equal(hostile?.level, 37, 'dungeon server-spawn hostiles should use the player runtime level');
}

function testServerNpcSeedWaitsForPlayerSpawn(): void {
    const client = createFakeClient('Iondoblack');
    client.currentLevel = 'BT_Mission4';
    client.levelInstanceId = '62415';
    client.playerSpawned = false;
    client.clientEntID = 0;
    client.character = {
        ...client.character,
        class: 'Mage',
        level: 4
    } as any;

    LevelHandler.spawnLevelNpcs(client as never, 'BT_Mission4');
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x0F),
        false,
        'server NPC spawns should not be sent before the player entity initializes'
    );

    const payload = buildClientEntityFullUpdatePayload({
        id: 6241501,
        name: 'Iondoblack',
        isPlayer: true,
        x: 100,
        y: 200,
        v: 0,
        team: 1,
        entState: 0
    });

    EntityHandler.handleEntityFullUpdate(client as never, payload);

    assert.equal(client.playerSpawned, true, 'player full update should mark the client spawned');
    assert.equal(
        client.sentPackets.filter((packet) => packet.id === 0x0F).length,
        140,
        'server NPC spawns should be sent after the player entity initializes'
    );
}

async function main(): Promise<void> {
    ensureLevelConfigLoaded();

    const levelEntities = new Map(GlobalState.levelEntities);
    const levelQuestProgress = new Map(GlobalState.levelQuestProgress);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const partyByMember = new Map(GlobalState.partyByMember);
    const partyGroups = new Map(GlobalState.partyGroups);
    GlobalState.levelEntities.clear();
    GlobalState.levelQuestProgress.clear();
    GlobalState.sessionsByToken.clear();
    GlobalState.partyByMember.clear();
    GlobalState.partyGroups.clear();

    try {
        testConfiguredLevelsUseClientSpawn();

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
        testGoblinRiverUsesServerSpawnedHostiles();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testGoblinRiverCharacterSnapshotSkipsDefeatedServerSpawn();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testGoblinRiverClientHostileFullUpdateIsSuppressedInServerDungeon();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        await testGoblinRiverPowerHitKillPersistsBeforeSpawnRetry();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDerelictionUsesServerSpawnedHostiles();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testNpcSpawnPayloadMatchesClientDecodeOrderAfterFacing();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDerelictionCharacterSnapshotSkipsDefeatedServerSpawn();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDerelictionProgressUsesReferenceSpawnCountBeforeSeeding();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testDerelictionLatePartyJoinerUsesSharedDefeatedRegistry();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        testDerelictionClientHostileFullUpdateIsSuppressedInServerDungeon();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testAllMissionDungeonsUsePersistentSnapshots();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testPersistentDungeonSuppressesDefeatedClientSpawnHostile();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testBridgeTownMission2SeedsServerHostiles();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDerelictionNewInstanceResetsStaleCharacterSnapshot();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDerelictionIncompleteSnapshotReusesInstanceOnReentry();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDerelictionFreshRunReplacesStaleDeadServerScope();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDerelictionExistingEmptyScopeStillSeedsServerHostiles();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        await testDerelictionDestroyedServerEnemyPersistsCharacterSnapshot();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        await testDerelictionRewardPacketPersistsDefeatedServerEnemySnapshot();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        await testDerelictionPowerHitKillPersistsBeforeSpawnRetry();

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
        testDungeonPartyAuthoritySuppressesDuplicateHostileSpawns();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDungeonPartyAuthoritySuppressesDuplicateHostileSpawnsAcrossUnsyncedRooms();

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
        testTutorialDungeonSameIdHostileDuplicateDestroysAndReseedsCanonical();

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
        testSoloDungeonHostileReferencePromotesToPartyJoinerSeed();

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
        testIncompleteRemotePlayerSaveSerializesSafeAppearance();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testRemotePlayerSpawnDoesNotSerializeAbilitiesAsPets();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testTutorialDungeonJoinerSkipsStartedRoomReplayFromPartyAnchor();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testGoblinRiverDungeonLeaderHostilesSeedToPartyJoinersOnly();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testGoblinRiverDungeonSuppressesFollowerClientHostileSpawns();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testGoblinRiverDungeonAllowsFollowerFirstCanonicalHostileSpawn();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testGoblinRiverDungeonLeaderLateSpawnDedupesToFollowerCanonical();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDungeonTeamOwnedHostilesSurviveCreatorDisconnect();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testGoblinRiverDungeonJoinerSkipsStartedRoomReplayFromPartyAnchor();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testDungeonServerSpawnHostilesUsePlayerRuntimeLevel();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        testServerNpcSeedWaitsForPlayerSpawn();
    } finally {
        GlobalState.levelEntities = levelEntities;
        GlobalState.levelQuestProgress = levelQuestProgress;
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
