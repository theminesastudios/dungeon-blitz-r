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
import { clearRoomBossState } from '../core/RoomBossState';

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
    lastCombatStatsSyncedAt: number;
    pendingRespawnRequest: { usePotion: boolean; requestedAt: number } | null;
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
    clearRoomBossState();
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
        lastCombatStatsSyncedAt: Date.now(),
        pendingRespawnRequest: null,
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

function buildRoomBossInfoPayload(roomId: number, bossId: number, bossName: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(roomId);
    bb.writeMethod9(bossId);
    bb.writeMethod26(bossName);
    bb.writeMethod9(0);
    bb.writeMethod26('');
    return bb.toBuffer();
}

function buildPowerCastPayload(sourceId: number, powerId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(sourceId);
    bb.writeMethod4(powerId);
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

function parseIncrementalMovePacket(payload: Buffer): { entityId: number; deltaX: number; deltaY: number; deltaV: number; entState: number } {
    const br = new BitReader(payload);
    return {
        entityId: br.readMethod4(),
        deltaX: br.readMethod45(),
        deltaY: br.readMethod45(),
        deltaV: br.readMethod45(),
        entState: br.readMethod6(2)
    };
}

function parseRespawnBroadcastPacket(payload: Buffer): { entityId: number; amount: number } {
    const br = new BitReader(payload);
    return {
        entityId: br.readMethod4(),
        amount: br.readMethod24()
    };
}

function parseRespawnRequestPacket(payload: Buffer): { amount: number; usedPotion: boolean } {
    const br = new BitReader(payload);
    return {
        amount: br.readMethod24(),
        usedPotion: br.readMethod15()
    };
}

function buildRespawnRequestPayload(usePotion: boolean = false): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod15(usePotion);
    return bb.toBuffer();
}

function buildRespawnBroadcastPayload(entityId: number, healAmount: number, usedPotion: boolean = false): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod24(healAmount);
    bb.writeMethod15(usedPotion);
    return bb.toBuffer();
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

    assert.equal(player.authoritativeCurrentHp, 1000, 'player should fully recover after the idle window');
    assert.equal(playerEntity.hp, 1000, 'player entity snapshot should track regenerated HP');
    assert.equal(hostile.hp, 640, 'dungeon bosses should regenerate every 500ms at 2% max HP');

    const regenPackets = player.sentPackets.filter((packet) => packet.id === 0x3B);
    assert.equal(regenPackets.length, 2, 'player should receive self and boss regen while both are idle');

    const parsedRegenPackets = regenPackets.map((packet) => parseRegenPacket(packet.payload));
    assert.deepEqual(parsedRegenPackets.filter((packet) => packet.entityId === player.clientEntID), [
        { entityId: player.clientEntID, amount: 400 }
    ]);
    assert.deepEqual(parsedRegenPackets.filter((packet) => packet.entityId === hostileId), [
        { entityId: hostileId, amount: 240 }
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

    assert.equal(player.authoritativeCurrentHp, 8031, 'player should recover to full HP after the idle window');

    const regenPacket = player.sentPackets.find((packet) => packet.id === 0x3B);
    assert.ok(regenPacket, 'player regen should emit the heal packet');
    assert.deepEqual(parseRegenPacket(regenPacket!.payload), {
        entityId: player.clientEntID,
        amount: 1725
    });
}

function testDungeonBossRegenWaitsForAggroTargetDeath(): void {
    resetState();
    ensureOriginalGameDataLoaded();

    const nowMs = 10_000;
    const player = createFakeClient(30, 'AggroDeath', 43);
    moveClientToLevel(player, 'DreamDragonDungeon');
    attachPlayerEntity(player);
    player.authoritativeCurrentHp = 1000;

    const bossId = 900030;
    const boss = {
        id: bossId,
        name: 'YoungDragonDream',
        isPlayer: false,
        clientSpawned: true,
        team: 2,
        roomId: player.currentRoomId,
        x: 900,
        y: -20,
        entState: EntityState.ACTIVE,
        dead: false,
        hp: 400,
        maxHp: 1000,
        lastCombatActivityAt: nowMs - 5_000,
        lastCombatRegenTickAt: 0,
        aggroTargetEntityId: player.clientEntID,
        aggroTargetToken: player.token,
        nextAttack: nowMs
    };

    const levelScope = getClientLevelScope(player as never);
    GlobalState.levelEntities.get(levelScope)!.set(bossId, boss);
    player.knownEntityIds.add(bossId);
    GlobalState.sessionsByToken.set(player.token, player as never);

    CombatHandler.processOutOfCombatRegen(levelScope, nowMs);
    assert.equal(boss.hp, 400, 'boss should not regenerate while its aggro target is still alive');

    CombatHandler.notePlayerDeathState(player as never, nowMs);
    assert.equal(Number(boss.aggroTargetEntityId ?? 0), 0, 'dead aggro target should be cleared');
    assert.equal(Number(boss.nextAttack ?? 0), 0, 'pending boss attack should be cleared when the aggro target dies');

    CombatHandler.processOutOfCombatRegen(levelScope, nowMs + 500);
    assert.equal(boss.hp, 420, 'boss should regenerate once the aggro target is dead and the 500ms tick matures');
    const bossRegenPackets = player.sentPackets
        .filter((packet) => packet.id === 0x3B)
        .map((packet) => parseRegenPacket(packet.payload))
        .filter((packet) => packet.entityId === bossId);
    assert.deepEqual(bossRegenPackets, [{ entityId: bossId, amount: 20 }]);
}

async function testRoomBossInfoAllowsTanjaRegenAfterPlayerDeath(): Promise<void> {
    resetState();
    ensureOriginalGameDataLoaded();

    const nowMs = 20_000;
    const player = createFakeClient(31, 'TanjaDeath', 3);
    moveClientToLevel(player, 'JC_Mini2');
    attachPlayerEntity(player);
    player.authoritativeCurrentHp = 1000;

    const bossId = 900031;
    const boss = {
        id: bossId,
        name: 'TowerGuard2',
        displayName: 'Tanja, The 2nd Daughter',
        isPlayer: false,
        clientSpawned: true,
        team: 2,
        roomId: player.currentRoomId,
        x: 900,
        y: -20,
        entState: EntityState.ACTIVE,
        dead: false,
        hp: 400,
        maxHp: 1000,
        lastCombatActivityAt: nowMs - 5_000,
        lastCombatRegenTickAt: 0,
        aggroTargetEntityId: player.clientEntID,
        aggroTargetToken: player.token,
        nextAttack: nowMs
    };

    const levelScope = getClientLevelScope(player as never);
    GlobalState.levelEntities.get(levelScope)!.set(bossId, boss);
    player.knownEntityIds.add(bossId);
    GlobalState.sessionsByToken.set(player.token, player as never);

    CombatHandler.processOutOfCombatRegen(levelScope, nowMs);
    assert.equal(boss.hp, 400, 'Tanja should not regenerate while the player is still alive and targeted');

    LevelHandler.handleRoomBossInfo(
        player as never,
        buildRoomBossInfoPayload(player.currentRoomId, bossId, 'Tanja, The 2nd Daughter')
    );
    assert.equal((boss as any).isRoomBoss, true, 'room boss info should mark the Tanja entity as the active boss');
    assert.equal((boss as any).roomBossHomeX, 900, 'room boss info should capture Tanja home X');
    assert.equal((boss as any).roomBossHomeY, -20, 'room boss info should capture Tanja home Y');

    boss.x = 1120;
    boss.y = -20;

    CombatHandler.notePlayerDeathState(player as never, nowMs);
    assert.equal(Number(boss.aggroTargetEntityId ?? 0), 0, 'Tanja should clear the dead player as aggro target');
    assert.equal(Number(boss.nextAttack ?? 0), 0, 'Tanja should stop attacking once the player is dead');
    assert.equal(Number(boss.x ?? 0), 900, 'Tanja should return to the saved room-boss home X when the player dies');
    assert.equal(Number(boss.y ?? 0), -20, 'Tanja should return to the saved room-boss home Y when the player dies');

    const returnHomePacket = player.sentPackets
        .filter((packet) => packet.id === 0x07)
        .map((packet) => parseIncrementalMovePacket(packet.payload))
        .find((packet) => packet.entityId === bossId && packet.deltaX === -220);
    assert.deepEqual(returnHomePacket, {
        entityId: bossId,
        deltaX: -220,
        deltaY: 0,
        deltaV: 0,
        entState: EntityState.ACTIVE
    });

    const sentBeforeSuppressedCast = player.sentPackets.length;
    await CombatHandler.handlePowerCast(player as never, buildPowerCastPayload(bossId, 1234));
    assert.equal(player.sentPackets.length, sentBeforeSuppressedCast, 'dead-player room boss power casts should not be relayed');

    CombatHandler.processOutOfCombatRegen(levelScope, nowMs + 500);
    assert.equal(boss.hp, 420, 'room-boss-marked Tanja should regenerate 2% after the 500ms death tick');
    const bossRegenPackets = player.sentPackets
        .filter((packet) => packet.id === 0x3B)
        .map((packet) => parseRegenPacket(packet.payload))
        .filter((packet) => packet.entityId === bossId);
    assert.deepEqual(bossRegenPackets, [{ entityId: bossId, amount: 20 }]);
}

async function testKnownTanjaBossRegenWithoutRoomBossPacket(): Promise<void> {
    resetState();
    ensureOriginalGameDataLoaded();

    const nowMs = 35_000;
    const player = createFakeClient(33, 'TanjaNoRoomBossInfo', 3);
    moveClientToLevel(player, 'JC_Mini2');
    attachPlayerEntity(player);
    player.authoritativeCurrentHp = 1000;

    const bossId = 900033;
    const boss = {
        id: bossId,
        name: 'TowerGuard2',
        displayName: 'Tanja, The 2nd Daughter',
        isPlayer: false,
        clientSpawned: true,
        team: 2,
        roomId: player.currentRoomId,
        x: 1120,
        y: -20,
        entState: EntityState.ACTIVE,
        dead: false,
        hp: 400,
        maxHp: 1000,
        lastCombatActivityAt: nowMs - 5_000,
        lastCombatRegenTickAt: 0,
        aggroTargetEntityId: player.clientEntID,
        aggroTargetToken: player.token,
        nextAttack: nowMs
    };

    const levelScope = getClientLevelScope(player as never);
    GlobalState.levelEntities.get(levelScope)!.set(bossId, boss);
    player.knownEntityIds.add(bossId);
    GlobalState.sessionsByToken.set(player.token, player as never);

    CombatHandler.processOutOfCombatRegen(levelScope, nowMs);
    assert.equal(boss.hp, 400, 'known Tanja should not regenerate while the targeted player is alive');

    CombatHandler.notePlayerDeathState(player as never, nowMs);
    assert.equal(Number(boss.aggroTargetEntityId ?? 0), 0, 'known Tanja should clear the dead player as aggro target');
    assert.equal(Number(boss.nextAttack ?? 0), 0, 'known Tanja should clear queued attacks when the player dies');
    assert.equal(Number(boss.x ?? 0), 900, 'known Tanja should return to default home X without room boss info');
    assert.equal(Number(boss.y ?? 0), -20, 'known Tanja should return to default home Y without room boss info');

    const sentBeforeSuppressedCast = player.sentPackets.length;
    await CombatHandler.handlePowerCast(player as never, buildPowerCastPayload(bossId, 1234));
    assert.equal(player.sentPackets.length, sentBeforeSuppressedCast, 'known Tanja power casts should be suppressed after player death');

    CombatHandler.processOutOfCombatRegen(levelScope, nowMs + 500);
    assert.equal(boss.hp, 420, 'known Tanja should regenerate 2% after the 500ms death tick without room boss info');
    const bossRegenPackets = player.sentPackets
        .filter((packet) => packet.id === 0x3B)
        .map((packet) => parseRegenPacket(packet.payload))
        .filter((packet) => packet.entityId === bossId);
    assert.deepEqual(bossRegenPackets, [{ entityId: bossId, amount: 20 }]);
}

async function testRoomBossInfoBeforeSpawnStillAllowsTanjaRegenAfterPlayerDeath(): Promise<void> {
    resetState();
    ensureOriginalGameDataLoaded();

    const nowMs = 30_000;
    const player = createFakeClient(32, 'TanjaLateSpawn', 3);
    moveClientToLevel(player, 'JC_Mini2');
    attachPlayerEntity(player);
    GlobalState.sessionsByToken.set(player.token, player as never);

    const bossId = 900032;
    const levelScope = getClientLevelScope(player as never);
    LevelHandler.handleRoomBossInfo(
        player as never,
        buildRoomBossInfoPayload(player.currentRoomId, bossId, 'Tanja, The 2nd Daughter')
    );

    const boss = {
        id: bossId,
        name: 'TowerGuard2',
        displayName: 'Tanja, The 2nd Daughter',
        isPlayer: false,
        clientSpawned: true,
        team: 2,
        roomId: player.currentRoomId,
        x: 900,
        y: -20,
        entState: EntityState.ACTIVE,
        dead: false,
        hp: 400,
        maxHp: 1000,
        lastCombatActivityAt: nowMs - 5_000,
        lastCombatRegenTickAt: 0,
        aggroTargetEntityId: player.clientEntID,
        aggroTargetToken: player.token,
        nextAttack: nowMs
    };

    GlobalState.levelEntities.get(levelScope)!.set(bossId, boss);
    player.knownEntityIds.add(bossId);

    CombatHandler.processOutOfCombatRegen(levelScope, nowMs);
    assert.equal((boss as any).isRoomBoss, true, 'stored room boss info should mark Tanja after the entity spawns');
    assert.equal((boss as any).roomBossHomeX, 900, 'late-spawned Tanja should capture home X when the stored marker is applied');
    assert.equal((boss as any).roomBossHomeY, -20, 'late-spawned Tanja should capture home Y when the stored marker is applied');
    assert.equal(boss.hp, 400, 'late-spawned room boss should not regenerate while the player is alive');

    boss.x = 1120;
    boss.y = -20;
    CombatHandler.notePlayerDeathState(player as never, nowMs);

    assert.equal(Number(boss.aggroTargetEntityId ?? 0), 0, 'late-spawned Tanja should clear the dead player as aggro target');
    assert.equal(Number(boss.nextAttack ?? 0), 0, 'late-spawned Tanja should stop queued attacks when the player dies');
    assert.equal(Number(boss.x ?? 0), 900, 'late-spawned Tanja should return to the saved home X');
    assert.equal(Number(boss.y ?? 0), -20, 'late-spawned Tanja should return to the saved home Y');

    CombatHandler.processOutOfCombatRegen(levelScope, nowMs + 500);
    assert.equal(boss.hp, 420, 'late-spawned room-boss-marked Tanja should regenerate 2% after the 500ms death tick');
    const bossRegenPackets = player.sentPackets
        .filter((packet) => packet.id === 0x3B)
        .map((packet) => parseRegenPacket(packet.payload))
        .filter((packet) => packet.entityId === bossId);
    assert.deepEqual(bossRegenPackets, [{ entityId: bossId, amount: 20 }]);
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

    assert.equal(player.authoritativeCurrentHp, 1000, 'player regen should use authoritative HP when entity snapshots are stale full');
    assert.equal(playerEntity.hp, 1000, 'stale player entity HP should be corrected by regen');
    const regenPacket = player.sentPackets.find((packet) => packet.id === 0x3B);
    assert.ok(regenPacket, 'seeded player regen should emit the heal packet on the next tick');
    assert.deepEqual(parseRegenPacket(regenPacket!.payload), {
        entityId: player.clientEntID,
        amount: 400
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
        assert.equal(player.authoritativeCurrentHp, 8031, 'first server heartbeat tick should carry the player to full HP');

        Date.now = () => 10_500;
        AILogic.updateLevel(levelScope);
        assert.equal(player.authoritativeCurrentHp, 8031, 'player should remain full after out-of-combat regen');

        Date.now = () => 11_000;
        AILogic.updateLevel(levelScope);
        assert.equal(player.authoritativeCurrentHp, 8031, 'subsequent heartbeat ticks should not over-heal');

        Date.now = () => 12_000;
        AILogic.updateLevel(levelScope);
        assert.equal(player.authoritativeCurrentHp, 8031, 'subsequent heartbeat ticks should keep the player at full HP');
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
        amount: 7990
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

        assert.equal(player.authoritativeCurrentHp, 8031, 'player regen should continue after changing gear and fill HP');
        const regenPacket = player.sentPackets.find((packet) => packet.id === 0x3B);
        assert.ok(regenPacket, 'gear change should not prevent the regen packet');
        assert.deepEqual(parseRegenPacket(regenPacket!.payload), {
            entityId: player.clientEntID,
            amount: 1725
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
    player.lastCombatActivityAt = nowMs - 4_750;

    attachPlayerEntity(player);
    const playerEntity = player.entities.get(player.clientEntID)!;
    playerEntity.hp = 600;
    playerEntity.maxHp = 1000;

    const levelScope = getClientLevelScope(player as never);
    GlobalState.sessionsByToken.set(player.token, player as never);

    CombatHandler.processOutOfCombatRegen(levelScope, nowMs);

    assert.equal(player.authoritativeCurrentHp, 600, 'regen should not start before the five-second idle timer matures');
    assert.equal(player.sentPackets.length, 0, 'no regen packet should be emitted before the idle timer matures');
}

async function testSelfRespawnBroadcastRestoresFullHp(): Promise<void> {
    resetState();

    const player = createFakeClient(17, 'Rho', 35);
    const watcher = createFakeClient(18, 'Sigma', 35);
    player.character!.level = 2;
    player.authoritativeMaxHp = 8031;
    player.authoritativeCurrentHp = 0;

    attachPlayerEntity(player);
    attachPlayerEntity(watcher);
    const playerEntity = player.entities.get(player.clientEntID)!;
    playerEntity.hp = 0;
    playerEntity.maxHp = 8031;
    playerEntity.dead = true;
    playerEntity.entState = EntityState.DEAD;
    watcher.knownEntityIds.add(player.clientEntID);

    GlobalState.sessionsByToken.set(player.token, player as never);
    GlobalState.sessionsByToken.set(watcher.token, watcher as never);

    await CombatHandler.handleRespawnBroadcast(
        player as never,
        buildRespawnBroadcastPayload(player.clientEntID, 1, false)
    );

    assert.equal(player.authoritativeCurrentHp, 8031, 'self respawn should restore full server-known HP');
    assert.equal(playerEntity.hp, 8031, 'self respawn entity state should not keep the low client revive HP');
    assert.equal(playerEntity.dead, false, 'self respawn should clear local dead state');

    const respawnPacket = watcher.sentPackets
        .filter((packet) => packet.id === 0x82)
        .map((packet) => parseRespawnBroadcastPacket(packet.payload))
        .find((packet) => packet.entityId === player.clientEntID);
    assert.deepEqual(respawnPacket, {
        entityId: player.clientEntID,
        amount: 8031
    });
}

async function testRespawnRequestWaitsForFreshFullKnownPlayerHp(): Promise<void> {
    resetState();

    const player = createFakeClient(19, 'Tau', 39);
    player.character!.level = 50;
    player.authoritativeMaxHp = 67_582;
    player.authoritativeCurrentHp = 0;
    player.lastCombatStatsSyncedAt = Date.now() - 5_000;

    attachPlayerEntity(player);
    const playerEntity = player.entities.get(player.clientEntID)!;
    playerEntity.hp = 0;
    playerEntity.maxHp = 67_582;
    playerEntity.dead = true;
    playerEntity.entState = EntityState.DEAD;

    GlobalState.sessionsByToken.set(player.token, player as never);

    await CombatHandler.handleRequestRespawn(player as never, buildRespawnRequestPayload(false));

    assert.equal(
        player.sentPackets.some((packet) => packet.id === 0x80),
        false,
        'stale respawn requests should wait for fresh combat stats before sending revive HP'
    );
    assert.equal(
        player.sentPackets.some((packet) => packet.id === 0xFB),
        true,
        'stale respawn requests should ask the client for current combat stats'
    );
    assert.ok(player.pendingRespawnRequest, 'respawn request should be remembered until combat stats arrive');

    CommandHandler.handleSendCombatStats(player as never, buildCombatStatsPayload(123, 234, 88_541, 3, 12));

    const respawnPacket = player.sentPackets.find((packet) => packet.id === 0x80);
    assert.ok(respawnPacket, 'respawn request should emit the revive response packet');
    assert.deepEqual(parseRespawnRequestPacket(respawnPacket!.payload), {
        amount: 88_541,
        usedPotion: false
    });
    assert.equal(player.pendingRespawnRequest, null, 'fresh combat stats should complete the pending respawn request');
}

async function testDeadPlayerArmsBossRegenForNextBossTick(): Promise<void> {
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
        lastCombatRegenTickAt: 0,
        aggroTargetEntityId: player.clientEntID,
        aggroTargetToken: player.token,
        nextAttack: nowMs
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
        assert.equal(Number(boss.aggroTargetEntityId ?? 0), 0, 'boss should clear the dead player as its aggro target');
        assert.equal(Number(boss.nextAttack ?? 0), 0, 'boss should stop queued attacks when its target dies');

        Date.now = () => nowMs + 500;
        CombatHandler.processOutOfCombatRegen(levelScope, Date.now());

        assert.equal(boss.hp, 420, 'boss should receive the first regen tick 500ms after death is processed');
        const bossRegenPackets = player.sentPackets
            .filter((packet) => packet.id === 0x3B)
            .map((packet) => parseRegenPacket(packet.payload))
            .filter((packet) => packet.entityId === bossId);
        assert.deepEqual(bossRegenPackets, [{ entityId: bossId, amount: 20 }]);
    } finally {
        Date.now = originalDateNow;
    }
}

async function testClientDeadStateArmsBossRegenForNextBossTick(): Promise<void> {
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

        assert.equal(boss.hp, 420, 'client-reported player death should allow the first regen tick after 500ms');
        const bossRegenPackets = player.sentPackets
            .filter((packet) => packet.id === 0x3B)
            .map((packet) => parseRegenPacket(packet.payload))
            .filter((packet) => packet.entityId === bossId);
        assert.deepEqual(bossRegenPackets, [{ entityId: bossId, amount: 20 }]);
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

        assert.equal(boss.hp, 420, 'respawn request should let the boss heal on the first 500ms regen tick');
        const bossRegenPackets = player.sentPackets
            .filter((packet) => packet.id === 0x3B)
            .map((packet) => parseRegenPacket(packet.payload))
            .filter((packet) => packet.entityId === bossId);
        assert.deepEqual(bossRegenPackets, [{ entityId: bossId, amount: 20 }]);
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

        assert.equal(boss.hp, 420, 'respawn should only apply the first boss regen tick after 500ms');
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
        lastCombatActivityAt: 9_500,
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
        },
        {
            levelName: 'JC_Mini2',
            bossName: 'TowerGuard2',
            blocked: [
                { name: 'ImperialGuard', entRank: 'Minion' },
                { name: 'UnlistedDungeonBoss', entRank: 'Boss' }
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

        CombatHandler.processOutOfCombatRegen(levelScope, 9_999);
        assert.equal(boss.hp, 400, `${scenario.levelName} listed boss should not regenerate before 500ms out of combat`);
        assert.equal(
            player.sentPackets.some((packet) => packet.id === 0x3B),
            false,
            `${scenario.levelName} listed boss should not emit regen before 500ms out of combat`
        );

        CombatHandler.processOutOfCombatRegen(levelScope, 10_000);

        assert.equal(boss.hp, 420, `${scenario.levelName} listed boss should regenerate after 500ms out of combat`);
        for (const entity of blockedEntities) {
            assert.equal(entity.hp, 400, `${scenario.levelName} unlisted ${entity.name} should not regenerate`);
        }

        const regenPackets = player.sentPackets
            .filter((packet) => packet.id === 0x3B)
            .map((packet) => parseRegenPacket(packet.payload));
        assert.deepEqual(regenPackets.filter((packet) => packet.entityId === boss.id), [{ entityId: boss.id, amount: 20 }]);
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

        assert.equal(boss.hp, 420, 'client-only dungeon bosses should regenerate 500ms after player death');
        assert.equal(normal.hp, 400, 'normal enemies should not receive boss regen');
        assert.equal(unlistedBoss.hp, 400, 'generic boss-ranked enemies should not regen unless listed for that dungeon');
        const regenPackets = player.sentPackets
            .filter((packet) => packet.id === 0x3B)
            .map((packet) => parseRegenPacket(packet.payload));
        assert.deepEqual(regenPackets.filter((packet) => packet.entityId === bossId), [{ entityId: bossId, amount: 20 }]);
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
        lastCombatActivityAt: nowMs,
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
        lastCombatActivityAt: nowMs,
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

    assert.equal(boss.hp, 420, 'authoritative dead player state should allow boss regen after 500ms');
    assert.equal(normal.hp, 400, 'authoritative dead player state should still not heal normal enemies');
    const regenPackets = player.sentPackets
        .filter((packet) => packet.id === 0x3B)
        .map((packet) => parseRegenPacket(packet.payload));
    assert.deepEqual(regenPackets.filter((packet) => packet.entityId === bossId), [{ entityId: bossId, amount: 20 }]);
    assert.deepEqual(regenPackets.filter((packet) => packet.entityId === normalId), []);
}

async function run(): Promise<void> {
    testPlayerAndDungeonBossRegenAfterIdle();
    testPlayerRegenUsesEntityHealEncoding();
    testDungeonBossRegenWaitsForAggroTargetDeath();
    await testRoomBossInfoAllowsTanjaRegenAfterPlayerDeath();
    await testKnownTanjaBossRegenWithoutRoomBossPacket();
    await testRoomBossInfoBeforeSpawnStillAllowsTanjaRegenAfterPlayerDeath();
    testPlayerRegenSeedsMissingActivityAndTrustsAuthoritativeHp();
    testAiHeartbeatContinuesPlayerRegenUntilFull();
    testDeadPlayerDoesNotRegen();
    testStaleHundredHpSnapshotDoesNotShrinkPlayerRegen();
    testDirtyCombatStatsBlockRegenUntilFreshSync();
    await testGearChangeDirtyStatsStillAllowPlayerRegen();
    testIdleWindowBlocksRegen();
    await testSelfRespawnBroadcastRestoresFullHp();
    await testRespawnRequestWaitsForFreshFullKnownPlayerHp();
    await testDeadPlayerArmsBossRegenForNextBossTick();
    await testClientDeadStateArmsBossRegenForNextBossTick();
    await testRespawnRequestMarksDeadBeforeArmingBossRegen();
    await testRespawnDoesNotFullHealBoss();
    await testKnownOverworldBossNameDoesNotUseDungeonBossRegen();
    await testDungeonBossRegenUsesFetchedBossList();
    await testClientOnlyBossRegenDoesNotHealNormalEnemies();
    await testAuthoritativeDeadPlayerStateAllowsBossRegen();
    console.log('combat_regen_regression: ok');
}

void run();
