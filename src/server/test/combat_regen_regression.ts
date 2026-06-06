import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { CombatHandler } from '../handlers/CombatHandler';
import { CommandHandler } from '../handlers/CommandHandler';
import { EquipmentHandler } from '../handlers/EquipmentHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { Entity, EntityState } from '../core/Entity';
import { getClientLevelScope } from '../core/LevelScope';
import { AILogic } from '../core/AILogic';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    characters: any[];
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    userId: number | null;
    character: { name: string; level: number; class?: string; MasterClass?: number; CurrentLevel?: { name: string; x: number; y: number } } | null;
    authoritativeMaxHp: number;
    authoritativeCurrentHp: number;
    combatStatsDirty: boolean;
    allowDirtyCombatStatsRegen: boolean;
    lastCombatStatsRefreshRequestAt: number;
    lastCombatActivityAt: number;
    lastCombatRegenTickAt: number;
    enemyDeathRegenArmed: boolean;
    processedRewardSources: Set<string>;
    pendingLoot: Map<number, any>;
    knownEntityIds: Set<number>;
    entities: Map<number, any>;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, payload: BitBuffer) => void;
};

let originalGameDataLoaded = false;

function ensureOriginalGameDataLoaded(): void {
    if (originalGameDataLoaded) {
        return;
    }

    const dataDir = path.resolve(__dirname, '../data');
    const originalConsoleLog = console.log;
    try {
        console.log = () => undefined;
        GameData.load(dataDir);
    } finally {
        console.log = originalConsoleLog;
    }
    assert.equal(LevelConfig.isDungeonLevel('DreamDragonDungeon'), true, 'test data should mark DreamDragonDungeon as a dungeon');
    originalGameDataLoaded = true;
}

function resetState(): void {
    GlobalState.sessionsByToken.clear();
    GlobalState.sessionsByUserId.clear();
    GlobalState.sessionsByCharacterName.clear();
    GlobalState.levelEntities.clear();
    GlobalState.levelQuestProgress.clear();
    GlobalState.combatContributions.clear();
    GlobalState.entityLifeNonces.clear();
    GlobalState.entityLastRewardNonces.clear();
}

function createFakeClient(token: number, name: string, roomId: number): FakeClient {
    const sentPackets: SentPacket[] = [];

    return {
        token,
        characters: [],
        currentLevel: 'BridgeTown',
        levelInstanceId: '',
        currentRoomId: roomId,
        playerSpawned: true,
        clientEntID: token + 1000,
        userId: token,
        character: {
            name,
            level: 10,
            class: 'mage',
            MasterClass: 0,
            CurrentLevel: { name: 'BridgeTown', x: 0, y: 0 }
        },
        authoritativeMaxHp: 1000,
        authoritativeCurrentHp: 1000,
        combatStatsDirty: false,
        allowDirtyCombatStatsRegen: false,
        lastCombatStatsRefreshRequestAt: 0,
        lastCombatActivityAt: 0,
        lastCombatRegenTickAt: 0,
        enemyDeathRegenArmed: false,
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entities: new Map<number, any>(),
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, payload: BitBuffer) {
            sentPackets.push({ id, payload: payload.toBuffer() });
        }
    };
}

function moveClientToLevel(session: FakeClient, levelName: string): void {
    session.currentLevel = levelName;
    session.levelInstanceId = '';
    if (session.character?.CurrentLevel) {
        session.character.CurrentLevel.name = levelName;
    }
}

function attachPlayerEntity(session: FakeClient): void {
    const entity = {
        ...Entity.fromCharacter(session.clientEntID, session.character as any, {
            x: 0,
            y: 0,
            team: 1,
            entState: EntityState.ACTIVE,
            roomId: session.currentRoomId
        }),
        ownerToken: session.token,
        ownerUserId: session.userId ?? 0,
        roomId: session.currentRoomId,
        hp: session.authoritativeCurrentHp,
        maxHp: session.authoritativeMaxHp
    };

    session.entities.set(session.clientEntID, entity);
    session.knownEntityIds.add(session.clientEntID);

    const levelScope = getClientLevelScope(session as never);
    let levelMap = GlobalState.levelEntities.get(levelScope);
    if (!levelMap) {
        levelMap = new Map<number, any>();
        GlobalState.levelEntities.set(levelScope, levelMap);
    }
    levelMap.set(session.clientEntID, entity);
}

function buildIncrementalStatePayload(entityId: number, entState: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod45(0);
    bb.writeMethod45(0);
    bb.writeMethod45(0);
    bb.writeMethod6(entState, 2);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function parseRegenPacket(payload: Buffer): { entityId: number; amount: number } {
    const br = new BitReader(payload);
    return {
        entityId: br.readMethod4(),
        amount: br.readMethod4()
    };
}

function buildCombatStatsPayload(meleeDamage: number, magicDamage: number, maxHp: number, scale: number, revision: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(meleeDamage);
    bb.writeMethod9(magicDamage);
    bb.writeMethod9(maxHp);
    bb.writeMethod20(4, scale);
    bb.writeMethod9(revision);
    return bb.toBuffer();
}

function buildUpdateSingleGearPayload(entityId: number, slot: number, gearId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(entityId);
    bb.writeMethod91(slot);
    bb.writeMethod20(11, gearId);
    return bb.toBuffer();
}

function testPlayerAndDungeonBossRegenAfterIdle(): void {
    resetState();
    ensureOriginalGameDataLoaded();

    const nowMs = 10_000;
    const player = createFakeClient(1, 'Alpha', 3);
    moveClientToLevel(player, 'DreamDragonDungeon');
    player.authoritativeCurrentHp = 600;
    player.lastCombatActivityAt = nowMs - 6000;

    attachPlayerEntity(player);
    const playerEntity = player.entities.get(player.clientEntID)!;
    playerEntity.hp = 600;
    playerEntity.maxHp = 1000;

    const hostileId = 900001;
    const hostile = {
        id: hostileId,
        name: 'YoungDragonDream',
        isPlayer: false,
        clientSpawned: true,
        team: 2,
        roomId: player.currentRoomId,
        entState: EntityState.ACTIVE,
        dead: false,
        hp: 400,
        maxHp: 1000,
        lastCombatActivityAt: nowMs - 6000,
        lastCombatRegenTickAt: 0
    };
    player.entities.set(hostileId, hostile);
    player.knownEntityIds.add(hostileId);

    const levelScope = getClientLevelScope(player as never);
    GlobalState.levelEntities.get(levelScope)!.set(hostileId, hostile);
    GlobalState.sessionsByToken.set(player.token, player as never);

    CombatHandler.processOutOfCombatRegen(levelScope, nowMs);

    assert.equal(player.authoritativeCurrentHp, 700, 'player should recover 10% of max HP after the idle window');
    assert.equal(playerEntity.hp, 700, 'player entity snapshot should track regenerated HP');
    assert.equal(hostile.hp, 410, 'dungeon bosses should regenerate from idle time while the player is alive');

    const regenPackets = player.sentPackets.filter((packet) => packet.id === 0x3B);
    assert.equal(regenPackets.length, 2, 'player should receive self and boss regen while both are idle');

    const parsedRegenPackets = regenPackets.map((packet) => parseRegenPacket(packet.payload));
    assert.deepEqual(parsedRegenPackets.filter((packet) => packet.entityId === player.clientEntID), [
        { entityId: player.clientEntID, amount: 100 }
    ]);
    assert.deepEqual(parsedRegenPackets.filter((packet) => packet.entityId === hostileId), [
        { entityId: hostileId, amount: 10 }
    ]);
}

function testPlayerRegenUsesEntityHealEncoding(): void {
    resetState();

    const nowMs = 10_000;
    const player = createFakeClient(3, 'Gamma', 7);
    player.character!.level = 2;
    player.authoritativeMaxHp = 8031;
    player.authoritativeCurrentHp = 6306;
    player.lastCombatActivityAt = nowMs - 6000;

    attachPlayerEntity(player);
    const playerEntity = player.entities.get(player.clientEntID)!;
    playerEntity.hp = 6306;
    playerEntity.maxHp = 8031;

    const levelScope = getClientLevelScope(player as never);
    GlobalState.sessionsByToken.set(player.token, player as never);

    CombatHandler.processOutOfCombatRegen(levelScope, nowMs);

    assert.equal(player.authoritativeCurrentHp, 7109, 'player should recover 803 HP from 6306/8031 after the idle window');

    const regenPacket = player.sentPackets.find((packet) => packet.id === 0x3B);
    assert.ok(regenPacket, 'player regen should emit the heal packet');
    assert.deepEqual(parseRegenPacket(regenPacket!.payload), {
        entityId: player.clientEntID,
        amount: 803
    });
}

function testPlayerRegenSeedsMissingActivityAndTrustsAuthoritativeHp(): void {
    resetState();

    const nowMs = 10_000;
    const player = createFakeClient(14, 'Xi', 29);
    player.authoritativeMaxHp = 1000;
    player.authoritativeCurrentHp = 600;
    player.lastCombatActivityAt = 0;

    attachPlayerEntity(player);
    const playerEntity = player.entities.get(player.clientEntID)!;
    playerEntity.hp = 1000;
    playerEntity.maxHp = 1000;

    const levelScope = getClientLevelScope(player as never);
    GlobalState.levelEntities.get(levelScope)!.get(player.clientEntID)!.hp = 1000;
    GlobalState.sessionsByToken.set(player.token, player as never);

    CombatHandler.processOutOfCombatRegen(levelScope, nowMs);

    assert.equal(player.authoritativeCurrentHp, 600, 'missing regen activity should be seeded without an immediate heal');
    assert.equal(player.sentPackets.length, 0, 'missing regen activity should not emit an immediate packet');
    assert.equal(player.lastCombatActivityAt, nowMs - 5_000, 'injured players should get a regen anchor when combat activity is missing');

    CombatHandler.processOutOfCombatRegen(levelScope, nowMs + 1_000);

    assert.equal(player.authoritativeCurrentHp, 700, 'player regen should use authoritative HP when entity snapshots are stale full');
    assert.equal(playerEntity.hp, 700, 'stale player entity HP should be corrected by regen');
    const regenPacket = player.sentPackets.find((packet) => packet.id === 0x3B);
    assert.ok(regenPacket, 'seeded player regen should emit the heal packet on the next tick');
    assert.deepEqual(parseRegenPacket(regenPacket!.payload), {
        entityId: player.clientEntID,
        amount: 100
    });
}

function testAiHeartbeatContinuesPlayerRegenUntilFull(): void {
    resetState();

    const player = createFakeClient(4, 'Delta', 9);
    player.character!.level = 2;
    player.authoritativeMaxHp = 8031;
    player.authoritativeCurrentHp = 6306;
    player.lastCombatActivityAt = 4_000;

    attachPlayerEntity(player);
    const playerEntity = player.entities.get(player.clientEntID)!;
    playerEntity.hp = 6306;
    playerEntity.maxHp = 8031;

    const levelScope = getClientLevelScope(player as never);
    GlobalState.sessionsByToken.set(player.token, player as never);

    const originalDateNow = Date.now;
    try {
        Date.now = () => 10_000;
        AILogic.updateLevel(levelScope);
        assert.equal(player.authoritativeCurrentHp, 7109, 'first server heartbeat tick should heal 803 HP');

        Date.now = () => 10_500;
        AILogic.updateLevel(levelScope);
        assert.equal(player.authoritativeCurrentHp, 7109, 'player regen should wait for the next full second before healing again');

        Date.now = () => 11_000;
        AILogic.updateLevel(levelScope);
        assert.equal(player.authoritativeCurrentHp, 7912, 'second server heartbeat tick should continue healing');

        Date.now = () => 12_000;
        AILogic.updateLevel(levelScope);
        assert.equal(player.authoritativeCurrentHp, 8031, 'subsequent heartbeat ticks should carry the player to full HP');
    } finally {
        Date.now = originalDateNow;
    }
}

function testDeadPlayerDoesNotRegen(): void {
    resetState();

    const player = createFakeClient(5, 'Epsilon', 11);
    player.character!.level = 2;
    player.authoritativeMaxHp = 8031;
    player.authoritativeCurrentHp = 6306;
    player.lastCombatActivityAt = 4_000;

    attachPlayerEntity(player);
    const playerEntity = player.entities.get(player.clientEntID)!;
    playerEntity.hp = 6306;
    playerEntity.maxHp = 8031;
    playerEntity.dead = true;
    playerEntity.entState = EntityState.DEAD;

    const levelScope = getClientLevelScope(player as never);
    GlobalState.sessionsByToken.set(player.token, player as never);

    const originalDateNow = Date.now;
    try {
        Date.now = () => 10_000;
        AILogic.updateLevel(levelScope);
    } finally {
        Date.now = originalDateNow;
    }

    assert.equal(player.authoritativeCurrentHp, 6306, 'dead players should not regenerate until they revive');
    assert.equal(player.sentPackets.length, 0, 'dead players should not receive regen packets');
}

function testStaleHundredHpSnapshotDoesNotShrinkPlayerRegen(): void {
    resetState();

    const nowMs = 10_000;
    const player = createFakeClient(6, 'Zeta', 13);
    player.character!.level = 2;
    player.authoritativeMaxHp = 100;
    player.authoritativeCurrentHp = 41;
    player.lastCombatActivityAt = nowMs - 6000;

    attachPlayerEntity(player);
    const playerEntity = player.entities.get(player.clientEntID)!;
    playerEntity.hp = 41;
    playerEntity.maxHp = 100;

    const levelScope = getClientLevelScope(player as never);
    GlobalState.sessionsByToken.set(player.token, player as never);

    CombatHandler.processOutOfCombatRegen(levelScope, nowMs);

    const regenPacket = player.sentPackets.find((packet) => packet.id === 0x3B);
    assert.ok(regenPacket, 'stale player snapshot should still emit a regen packet');
    assert.deepEqual(parseRegenPacket(regenPacket!.payload), {
        entityId: player.clientEntID,
        amount: 803
    });
}

function testDirtyCombatStatsBlockRegenUntilFreshSync(): void {
    resetState();

    const player = createFakeClient(7, 'Eta', 15);
    player.character!.level = 2;
    player.authoritativeMaxHp = 8031;
    player.authoritativeCurrentHp = 6306;
    player.combatStatsDirty = true;
    player.lastCombatStatsRefreshRequestAt = 8_500;
    player.lastCombatActivityAt = 4_000;

    attachPlayerEntity(player);
    const playerEntity = player.entities.get(player.clientEntID)!;
    playerEntity.hp = 6306;
    playerEntity.maxHp = 8031;

    const levelScope = getClientLevelScope(player as never);
    GlobalState.sessionsByToken.set(player.token, player as never);

    const originalDateNow = Date.now;
    try {
        Date.now = () => 10_000;
        AILogic.updateLevel(levelScope);
        assert.equal(
            player.sentPackets.some((packet) => packet.id === 0x3B),
            false,
            'dirty combat stats should block regen until fresh stats arrive'
        );
        assert.equal(
            player.sentPackets.some((packet) => packet.id === 0xFB),
            true,
            'dirty combat stats should trigger a combat stat refresh request'
        );

        CommandHandler.handleSendCombatStats(player as never, buildCombatStatsPayload(123, 234, 7200, 3, 12));
        player.sentPackets.length = 0;

        Date.now = () => 11_000;
        AILogic.updateLevel(levelScope);
        const regenPacket = player.sentPackets.find((packet) => packet.id === 0x3B);
        assert.ok(regenPacket, 'regen should resume after fresh combat stats arrive');
        assert.deepEqual(parseRegenPacket(regenPacket!.payload), {
            entityId: player.clientEntID,
            amount: 894
        });
    } finally {
        Date.now = originalDateNow;
    }
}

async function testGearChangeDirtyStatsStillAllowPlayerRegen(): Promise<void> {
    resetState();

    const player = createFakeClient(12, 'Mu', 25);
    player.userId = null;
    player.character!.level = 2;
    player.authoritativeMaxHp = 8031;
    player.authoritativeCurrentHp = 6306;
    player.lastCombatActivityAt = 4_000;
    (player.character as any).equippedGears = [];
    (player.character as any).inventoryGears = [
        { gearID: 1177, tier: 2, runes: [0, 0, 0], colors: [0, 0] }
    ];
    player.characters = [player.character];

    attachPlayerEntity(player);
    const playerEntity = player.entities.get(player.clientEntID)!;
    playerEntity.hp = 6306;
    playerEntity.maxHp = 8031;

    const levelScope = getClientLevelScope(player as never);
    GlobalState.sessionsByToken.set(player.token, player as never);

    const originalDateNow = Date.now;
    try {
        Date.now = () => 10_000;
        await EquipmentHandler.handleUpdateSingleGear(
            player as never,
            buildUpdateSingleGearPayload(player.clientEntID, 5, 1177)
        );

        assert.equal(player.combatStatsDirty, true, 'gear changes should still request a fresh combat stat sync');
        assert.equal(player.allowDirtyCombatStatsRegen, true, 'gear stat refreshes should not starve HP regen');
        assert.equal(
            player.sentPackets.some((packet) => packet.id === 0xFB),
            true,
            'gear changes should request combat stats immediately'
        );

        player.sentPackets.length = 0;
        AILogic.updateLevel(levelScope);

        assert.equal(player.authoritativeCurrentHp, 7109, 'player regen should continue after changing gear');
        const regenPacket = player.sentPackets.find((packet) => packet.id === 0x3B);
        assert.ok(regenPacket, 'gear change should not prevent the regen packet');
        assert.deepEqual(parseRegenPacket(regenPacket!.payload), {
            entityId: player.clientEntID,
            amount: 803
        });
    } finally {
        Date.now = originalDateNow;
    }
}

function testIdleWindowBlocksRegen(): void {
    resetState();

    const nowMs = 10_000;
    const player = createFakeClient(2, 'Beta', 5);
    player.authoritativeCurrentHp = 600;
    player.lastCombatActivityAt = nowMs - 5750;

    attachPlayerEntity(player);
    const playerEntity = player.entities.get(player.clientEntID)!;
    playerEntity.hp = 600;
    playerEntity.maxHp = 1000;

    const levelScope = getClientLevelScope(player as never);
    GlobalState.sessionsByToken.set(player.token, player as never);

    CombatHandler.processOutOfCombatRegen(levelScope, nowMs);

    assert.equal(player.authoritativeCurrentHp, 600, 'regen should not start before the first 1000ms tick is due');
    assert.equal(player.sentPackets.length, 0, 'no regen packet should be emitted before the idle timer matures');
}

async function testDeadPlayerArmsBossRegenForNextOriginalTick(): Promise<void> {
    resetState();
    ensureOriginalGameDataLoaded();

    const nowMs = 10_000;
    const player = createFakeClient(8, 'Theta', 17);
    moveClientToLevel(player, 'DreamDragonDungeon');
    attachPlayerEntity(player);
    const playerEntity = player.entities.get(player.clientEntID)!;
    playerEntity.dead = true;
    playerEntity.entState = EntityState.DEAD;

    const bossId = 900008;
    const boss = {
        id: bossId,
        name: 'YoungDragonDream',
        isPlayer: false,
        clientSpawned: true,
        team: 2,
        roomId: player.currentRoomId,
        entState: EntityState.ACTIVE,
        dead: false,
        hp: 400,
        maxHp: 1000,
        lastCombatActivityAt: nowMs - 100,
        lastCombatRegenTickAt: 0
    };

    const levelScope = getClientLevelScope(player as never);
    GlobalState.levelEntities.get(levelScope)!.set(bossId, boss);
    player.knownEntityIds.add(bossId);
    GlobalState.sessionsByToken.set(player.token, player as never);

    const request = new BitBuffer(false);
    request.writeMethod15(false);

    const originalDateNow = Date.now;
    try {
        Date.now = () => nowMs;
        await CombatHandler.handleRequestRespawn(player as never, request.toBuffer());

        assert.equal(boss.hp, 400, 'player death should arm boss regen without applying an extra immediate tick');
        assert.equal(player.enemyDeathRegenArmed, true, 'death regen should be armed until the player respawns');

        Date.now = () => nowMs + 500;
        CombatHandler.processOutOfCombatRegen(levelScope, Date.now());

        assert.equal(boss.hp, 410, 'boss should receive the first original regen tick 500ms after death is processed');
        const bossRegenPackets = player.sentPackets
            .filter((packet) => packet.id === 0x3B)
            .map((packet) => parseRegenPacket(packet.payload))
            .filter((packet) => packet.entityId === bossId);
        assert.deepEqual(bossRegenPackets, [{ entityId: bossId, amount: 10 }]);
    } finally {
        Date.now = originalDateNow;
    }
}

async function testClientDeadStateArmsBossRegenForNextOriginalTick(): Promise<void> {
    resetState();
    ensureOriginalGameDataLoaded();

    const player = createFakeClient(10, 'Kappa', 21);
    moveClientToLevel(player, 'DreamDragonDungeon');
    attachPlayerEntity(player);
    const nowMs = 10_000;

    const bossId = 900010;
    const boss = {
        id: bossId,
        name: 'YoungDragonDream',
        isPlayer: false,
        clientSpawned: true,
        team: 2,
        roomId: player.currentRoomId,
        entState: EntityState.ACTIVE,
        dead: false,
        hp: 400,
        maxHp: 1000,
        lastCombatActivityAt: 0,
        lastCombatRegenTickAt: 0
    };

    const levelScope = getClientLevelScope(player as never);
    GlobalState.levelEntities.get(levelScope)!.set(bossId, boss);
    player.knownEntityIds.add(bossId);
    GlobalState.sessionsByToken.set(player.token, player as never);

    const originalDateNow = Date.now;
    try {
        Date.now = () => nowMs;
        await LevelHandler.handleEntityIncrementalUpdate(
            player as never,
            buildIncrementalStatePayload(player.clientEntID, EntityState.DEAD)
        );

        assert.equal(boss.hp, 400, 'client-reported player death should arm boss regen without applying an extra immediate tick');
        assert.equal(player.enemyDeathRegenArmed, true, 'client-reported player death should keep boss regen armed until respawn');

        Date.now = () => nowMs + 500;
        CombatHandler.processOutOfCombatRegen(levelScope, Date.now());

        assert.equal(boss.hp, 410, 'client-reported player death should allow the first original regen tick after 500ms');
        const bossRegenPackets = player.sentPackets
            .filter((packet) => packet.id === 0x3B)
            .map((packet) => parseRegenPacket(packet.payload))
            .filter((packet) => packet.entityId === bossId);
        assert.deepEqual(bossRegenPackets, [{ entityId: bossId, amount: 10 }]);
    } finally {
        Date.now = originalDateNow;
    }
}

async function testRespawnRequestMarksDeadBeforeArmingBossRegen(): Promise<void> {
    resetState();
    ensureOriginalGameDataLoaded();

    const player = createFakeClient(11, 'Lambda', 23);
    moveClientToLevel(player, 'DreamDragonDungeon');
    attachPlayerEntity(player);
    const nowMs = 10_000;

    const bossId = 900011;
    const boss = {
        id: bossId,
        name: 'YoungDragonDream',
        isPlayer: false,
        clientSpawned: true,
        team: 2,
        roomId: player.currentRoomId,
        entState: EntityState.ACTIVE,
        dead: false,
        hp: 400,
        maxHp: 1000,
        lastCombatActivityAt: 0,
        lastCombatRegenTickAt: 0
    };

    const levelScope = getClientLevelScope(player as never);
    GlobalState.levelEntities.get(levelScope)!.set(bossId, boss);
    player.knownEntityIds.add(bossId);
    GlobalState.sessionsByToken.set(player.token, player as never);

    const request = new BitBuffer(false);
    request.writeMethod15(false);

    const originalDateNow = Date.now;
    try {
        Date.now = () => nowMs;
        await CombatHandler.handleRequestRespawn(player as never, request.toBuffer());

        assert.equal(boss.hp, 400, 'respawn request should mark the player dead before arming boss regen');
        assert.equal(player.authoritativeCurrentHp, 0, 'respawn request should record the death before sending the revive prompt');
        assert.equal(player.enemyDeathRegenArmed, true, 'respawn request should arm boss regen until the revive broadcast arrives');

        Date.now = () => nowMs + 500;
        CombatHandler.processOutOfCombatRegen(levelScope, Date.now());

        assert.equal(boss.hp, 410, 'respawn request should let the boss heal on the first original regen tick');
        const bossRegenPackets = player.sentPackets
            .filter((packet) => packet.id === 0x3B)
            .map((packet) => parseRegenPacket(packet.payload))
            .filter((packet) => packet.entityId === bossId);
        assert.deepEqual(bossRegenPackets, [{ entityId: bossId, amount: 10 }]);
    } finally {
        Date.now = originalDateNow;
    }
}

async function testRespawnDoesNotFullHealBoss(): Promise<void> {
    resetState();
    ensureOriginalGameDataLoaded();

    const player = createFakeClient(9, 'Iota', 19);
    moveClientToLevel(player, 'DreamDragonDungeon');
    attachPlayerEntity(player);
    const playerEntity = player.entities.get(player.clientEntID)!;
    playerEntity.dead = true;
    playerEntity.entState = EntityState.DEAD;
    const nowMs = 10_000;

    const bossId = 900009;
    const boss = {
        id: bossId,
        name: 'YoungDragonDream',
        isPlayer: false,
        clientSpawned: true,
        team: 2,
        roomId: player.currentRoomId,
        entState: EntityState.ACTIVE,
        dead: false,
        hp: 400,
        maxHp: 1000,
        lastCombatActivityAt: 0,
        lastCombatRegenTickAt: 0
    };

    const levelScope = getClientLevelScope(player as never);
    GlobalState.levelEntities.get(levelScope)!.set(bossId, boss);
    player.knownEntityIds.add(bossId);
    GlobalState.sessionsByToken.set(player.token, player as never);

    const request = new BitBuffer(false);
    request.writeMethod15(false);

    const originalDateNow = Date.now;
    try {
        Date.now = () => nowMs;
        await CombatHandler.handleRequestRespawn(player as never, request.toBuffer());
        assert.equal(boss.hp, 400, 'respawn should not apply an immediate full or partial boss heal');

        Date.now = () => nowMs + 500;
        CombatHandler.processOutOfCombatRegen(levelScope, Date.now());

        assert.equal(boss.hp, 410, 'respawn should only apply the first slow boss regen tick');
        const oversizedEnemyHeals = player.sentPackets
            .filter((packet) => packet.id === 0x3B)
            .map((packet) => parseRegenPacket(packet.payload))
            .filter((packet) => packet.entityId === bossId && packet.amount > 1000);
        assert.deepEqual(oversizedEnemyHeals, [], 'respawn should not send a full-bar enemy heal packet');
    } finally {
        Date.now = originalDateNow;
    }
}

async function testKnownOverworldBossNameDoesNotUseDungeonBossRegen(): Promise<void> {
    resetState();
    ensureOriginalGameDataLoaded();

    const nowMs = 10_000;
    const player = createFakeClient(13, 'Nu', 27);
    moveClientToLevel(player, 'BridgeTown');
    attachPlayerEntity(player);
    const playerEntity = player.entities.get(player.clientEntID)!;
    playerEntity.dead = true;
    playerEntity.entState = EntityState.DEAD;

    const bossId = 900013;
    const boss = {
        id: bossId,
        name: 'YoungDragonDream',
        isPlayer: false,
        clientSpawned: true,
        team: 2,
        roomId: player.currentRoomId,
        entState: EntityState.ACTIVE,
        dead: false,
        hp: 400,
        maxHp: 1000,
        lastCombatActivityAt: 0,
        lastCombatRegenTickAt: 0
    };

    const levelScope = getClientLevelScope(player as never);
    GlobalState.levelEntities.get(levelScope)!.set(bossId, boss);
    player.knownEntityIds.add(bossId);
    GlobalState.sessionsByToken.set(player.token, player as never);

    const request = new BitBuffer(false);
    request.writeMethod15(false);

    const originalDateNow = Date.now;
    try {
        Date.now = () => nowMs;
        await CombatHandler.handleRequestRespawn(player as never, request.toBuffer());

        Date.now = () => nowMs + 500;
        CombatHandler.processOutOfCombatRegen(levelScope, Date.now());

        assert.equal(boss.hp, 400, 'known non-dungeon levels should not count dungeon boss names for boss regen');
        const bossRegenPackets = player.sentPackets
            .filter((packet) => packet.id === 0x3B)
            .map((packet) => parseRegenPacket(packet.payload))
            .filter((packet) => packet.entityId === bossId);
        assert.deepEqual(bossRegenPackets, []);
    } finally {
        Date.now = originalDateNow;
    }
}

function createRegenHostile(id: number, name: string, roomId: number, overrides: Record<string, unknown> = {}): any {
    return {
        id,
        name,
        isPlayer: false,
        clientSpawned: true,
        team: 2,
        roomId,
        entState: EntityState.ACTIVE,
        dead: false,
        hp: 400,
        maxHp: 1000,
        lastCombatActivityAt: 4_500,
        lastCombatRegenTickAt: 0,
        ...overrides
    };
}

async function testDungeonBossRegenUsesFetchedBossList(): Promise<void> {
    ensureOriginalGameDataLoaded();

    const scenarios = [
        {
            levelName: 'DreamDragonDungeon',
            bossName: 'YoungDragonDream',
            blocked: [
                { name: 'MagmaCyclopsBoss', entRank: 'Boss' },
                { name: 'BanditGreatSpider', entRank: 'MiniBoss' }
            ]
        },
        {
            levelName: 'GoblinRiverDungeon',
            bossName: 'GoblinBoss2',
            blocked: [
                { name: 'GoblinDagger', entRank: 'Minion' },
                { name: 'BanditGreatSpider', entRank: 'MiniBoss' }
            ]
        },
        {
            levelName: 'BT_Mission2',
            bossName: 'BanditBoss',
            blocked: [
                { name: 'BanditGreatSpider', entRank: 'MiniBoss' },
                { name: 'YoungDragonDream', entRank: 'Boss' }
            ]
        }
    ];

    for (const [scenarioIndex, scenario] of scenarios.entries()) {
        resetState();

        const player = createFakeClient(20 + scenarioIndex, `BossList${scenarioIndex}`, 41 + scenarioIndex);
        moveClientToLevel(player, scenario.levelName);
        player.authoritativeCurrentHp = 0;
        player.enemyDeathRegenArmed = true;

        const bossId = 910000 + (scenarioIndex * 10);
        const boss = createRegenHostile(bossId, scenario.bossName, player.currentRoomId);
        const blockedEntities = scenario.blocked.map((blocked, blockedIndex) => createRegenHostile(
            bossId + blockedIndex + 1,
            blocked.name,
            player.currentRoomId,
            { entRank: blocked.entRank }
        ));

        const levelScope = getClientLevelScope(player as never);
        GlobalState.levelEntities.set(levelScope, new Map<number, any>([
            [boss.id, boss],
            ...blockedEntities.map((entity) => [entity.id, entity] as [number, any])
        ]));
        player.knownEntityIds.add(boss.id);
        for (const entity of blockedEntities) {
            player.knownEntityIds.add(entity.id);
        }
        GlobalState.sessionsByToken.set(player.token, player as never);

        CombatHandler.processOutOfCombatRegen(levelScope, 10_500);

        assert.equal(boss.hp, 410, `${scenario.levelName} listed boss should regenerate`);
        for (const entity of blockedEntities) {
            assert.equal(entity.hp, 400, `${scenario.levelName} unlisted ${entity.name} should not regenerate`);
        }

        const regenPackets = player.sentPackets
            .filter((packet) => packet.id === 0x3B)
            .map((packet) => parseRegenPacket(packet.payload));
        assert.deepEqual(regenPackets.filter((packet) => packet.entityId === boss.id), [{ entityId: boss.id, amount: 10 }]);
        for (const entity of blockedEntities) {
            assert.deepEqual(regenPackets.filter((packet) => packet.entityId === entity.id), []);
        }
    }
}

async function testClientOnlyBossRegenDoesNotHealNormalEnemies(): Promise<void> {
    resetState();
    ensureOriginalGameDataLoaded();

    const nowMs = 10_000;
    const player = createFakeClient(15, 'Omicron', 31);
    moveClientToLevel(player, 'DreamDragonDungeon');
    attachPlayerEntity(player);

    const bossId = 900015;
    const boss = {
        id: bossId,
        name: 'YoungDragonDream',
        isPlayer: false,
        clientSpawned: true,
        team: 2,
        roomId: player.currentRoomId,
        entState: EntityState.ACTIVE,
        dead: false,
        hp: 400,
        maxHp: 1000,
        lastCombatActivityAt: 0,
        lastCombatRegenTickAt: 0
    };
    const normalId = 900016;
    const normal = {
        id: normalId,
        name: 'GoblinDagger',
        isPlayer: false,
        clientSpawned: true,
        team: 2,
        roomId: player.currentRoomId,
        entState: EntityState.ACTIVE,
        dead: false,
        hp: 400,
        maxHp: 1000,
        lastCombatActivityAt: 0,
        lastCombatRegenTickAt: 0
    };
    const unlistedBossId = 900019;
    const unlistedBoss = {
        id: unlistedBossId,
        name: 'UnlistedDungeonBoss',
        entRank: 'Boss',
        isPlayer: false,
        clientSpawned: true,
        team: 2,
        roomId: player.currentRoomId,
        entState: EntityState.ACTIVE,
        dead: false,
        hp: 400,
        maxHp: 1000,
        lastCombatActivityAt: 0,
        lastCombatRegenTickAt: 0
    };

    const levelScope = getClientLevelScope(player as never);
    player.entities.set(bossId, boss);
    player.entities.set(normalId, normal);
    player.entities.set(unlistedBossId, unlistedBoss);
    player.knownEntityIds.add(bossId);
    player.knownEntityIds.add(normalId);
    player.knownEntityIds.add(unlistedBossId);
    GlobalState.sessionsByToken.set(player.token, player as never);

    const request = new BitBuffer(false);
    request.writeMethod15(false);

    const originalDateNow = Date.now;
    try {
        Date.now = () => nowMs;
        await CombatHandler.handleRequestRespawn(player as never, request.toBuffer());

        Date.now = () => nowMs + 500;
        CombatHandler.processOutOfCombatRegen(levelScope, Date.now());

        assert.equal(boss.hp, 410, 'client-only dungeon bosses should regenerate after player death');
        assert.equal(normal.hp, 400, 'normal enemies should not receive boss regen');
        assert.equal(unlistedBoss.hp, 400, 'generic boss-ranked enemies should not regen unless listed for that dungeon');
        const regenPackets = player.sentPackets
            .filter((packet) => packet.id === 0x3B)
            .map((packet) => parseRegenPacket(packet.payload));
        assert.deepEqual(regenPackets.filter((packet) => packet.entityId === bossId), [{ entityId: bossId, amount: 10 }]);
        assert.deepEqual(regenPackets.filter((packet) => packet.entityId === normalId), []);
        assert.deepEqual(regenPackets.filter((packet) => packet.entityId === unlistedBossId), []);
    } finally {
        Date.now = originalDateNow;
    }
}

async function testAuthoritativeDeadPlayerStateAllowsBossRegen(): Promise<void> {
    resetState();
    ensureOriginalGameDataLoaded();

    const nowMs = 10_000;
    const player = createFakeClient(16, 'Pi', 33);
    moveClientToLevel(player, 'DreamDragonDungeon');
    player.authoritativeCurrentHp = 0;
    player.enemyDeathRegenArmed = true;

    const bossId = 900017;
    const boss = {
        id: bossId,
        name: 'YoungDragonDream',
        isPlayer: false,
        clientSpawned: true,
        team: 2,
        roomId: player.currentRoomId,
        entState: EntityState.ACTIVE,
        dead: false,
        hp: 400,
        maxHp: 1000,
        lastCombatActivityAt: nowMs - 5_500,
        lastCombatRegenTickAt: 0
    };
    const normalId = 900018;
    const normal = {
        id: normalId,
        name: 'GoblinDagger',
        isPlayer: false,
        clientSpawned: true,
        team: 2,
        roomId: player.currentRoomId,
        entState: EntityState.ACTIVE,
        dead: false,
        hp: 400,
        maxHp: 1000,
        lastCombatActivityAt: nowMs - 5_500,
        lastCombatRegenTickAt: 0
    };

    const levelScope = getClientLevelScope(player as never);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [bossId, boss],
        [normalId, normal]
    ]));
    player.knownEntityIds.add(bossId);
    player.knownEntityIds.add(normalId);
    GlobalState.sessionsByToken.set(player.token, player as never);

    CombatHandler.processOutOfCombatRegen(levelScope, nowMs + 500);

    assert.equal(boss.hp, 410, 'authoritative dead player state should allow boss regen');
    assert.equal(normal.hp, 400, 'authoritative dead player state should still not heal normal enemies');
    const regenPackets = player.sentPackets
        .filter((packet) => packet.id === 0x3B)
        .map((packet) => parseRegenPacket(packet.payload));
    assert.deepEqual(regenPackets.filter((packet) => packet.entityId === bossId), [{ entityId: bossId, amount: 10 }]);
    assert.deepEqual(regenPackets.filter((packet) => packet.entityId === normalId), []);
}

async function run(): Promise<void> {
    testPlayerAndDungeonBossRegenAfterIdle();
    testPlayerRegenUsesEntityHealEncoding();
    testPlayerRegenSeedsMissingActivityAndTrustsAuthoritativeHp();
    testAiHeartbeatContinuesPlayerRegenUntilFull();
    testDeadPlayerDoesNotRegen();
    testStaleHundredHpSnapshotDoesNotShrinkPlayerRegen();
    testDirtyCombatStatsBlockRegenUntilFreshSync();
    await testGearChangeDirtyStatsStillAllowPlayerRegen();
    testIdleWindowBlocksRegen();
    await testDeadPlayerArmsBossRegenForNextOriginalTick();
    await testClientDeadStateArmsBossRegenForNextOriginalTick();
    await testRespawnRequestMarksDeadBeforeArmingBossRegen();
    await testRespawnDoesNotFullHealBoss();
    await testKnownOverworldBossNameDoesNotUseDungeonBossRegen();
    await testDungeonBossRegenUsesFetchedBossList();
    await testClientOnlyBossRegenDoesNotHealNormalEnemies();
    await testAuthoritativeDeadPlayerStateAllowsBossRegen();
    console.log('combat_regen_regression: ok');
}

void run();
