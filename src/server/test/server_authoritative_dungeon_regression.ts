import { strict as assert } from 'assert';
import * as path from 'path';
import { DungeonInstance } from '../core/DungeonInstance';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { EntityHandler } from '../handlers/EntityHandler';
import { CombatHandler } from '../handlers/CombatHandler';
import { NpcLoader } from '../data/NpcLoader';
import { BitBuffer } from '../network/protocol/bitBuffer';

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
    clientEntID: number;
    character: {
        name: string;
        level: number;
        CurrentLevel: { name: string; x: number; y: number };
        PreviousLevel: { name: string; x: number; y: number };
    };
    entities: Map<number, any>;
    knownEntityIds: Set<number>;
    authoritativeMaxHp: number;
    authoritativeCurrentHp: number;
    combatStatsDirty: boolean;
    lastCombatStatsRefreshRequestAt: number;
    lastCombatActivityAt: number;
    lastCombatRegenTickAt: number;
    enemyDeathRegenArmed: boolean;
    sentPackets: SentPacket[];
    socket: { destroyed: boolean };
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('GoblinRiverDungeon')) {
        LevelConfig.load(dataDir);
    }
    if (!GameData.getEntType('GoblinClub')) {
        GameData.load(dataDir);
    }
    NpcLoader.load(dataDir);
}

function resetGlobalState(): void {
    GlobalState.pendingWorld.clear();
    GlobalState.pendingExtended.clear();
    GlobalState.usedTransferTokens.clear();
    GlobalState.sessionsByToken.clear();
    GlobalState.sessionsByUserId.clear();
    GlobalState.sessionsByCharacterName.clear();
    GlobalState.partyGroups.clear();
    GlobalState.partyByMember.clear();
    GlobalState.pendingTeleports.clear();
    GlobalState.levelEntities.clear();
    GlobalState.levelQuestProgress.clear();
    GlobalState.dungeonInstances.clear();
    GlobalState.activeDungeonByCharacter.clear();
    GlobalState.combatContributions.clear();
    GlobalState.entityLifeNonces.clear();
    GlobalState.entityLastRewardNonces.clear();
}

function createClient(token: number, name: string, instanceId: string = 'server-auth-shared'): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = {
        name,
        level: 10,
        CurrentLevel: { name: 'GoblinRiverDungeon', x: 0, y: 0 },
        PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 }
    };

    return {
        token,
        userId: token,
        playerSpawned: true,
        currentLevel: 'GoblinRiverDungeon',
        levelInstanceId: instanceId,
        currentRoomId: 1,
        clientEntID: token + 9000,
        character,
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        authoritativeMaxHp: 1000,
        authoritativeCurrentHp: 1000,
        combatStatsDirty: false,
        lastCombatStatsRefreshRequestAt: 0,
        lastCombatActivityAt: 0,
        lastCombatRegenTickAt: 0,
        enemyDeathRegenArmed: false,
        sentPackets,
        socket: { destroyed: false },
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function buildEntityFullUpdatePayload(entity: {
    id: number;
    name: string;
    x: number;
    y: number;
    team: number;
    isPlayer?: boolean;
}): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entity.id);
    bb.writeMethod24(entity.x);
    bb.writeMethod24(entity.y);
    bb.writeMethod24(0);
    bb.writeMethod26(entity.name);
    bb.writeMethod6(entity.team, 2);
    bb.writeMethod15(Boolean(entity.isPlayer));
    bb.writeMethod706(0);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod6(0, 2);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildPowerHitPayload(targetId: number, sourceId: number, damage: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(targetId);
    bb.writeMethod4(sourceId);
    bb.writeMethod24(damage);
    bb.writeMethod4(1693);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildDestroyPayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod15(true);
    return bb.toBuffer();
}

function firstAuthoritativeEnemy(scope: string): any {
    const levelMap = GlobalState.levelEntities.get(scope);
    assert.ok(levelMap, 'level map should exist');
    const enemy = Array.from(levelMap.values()).find((entity) => entity.serverAuthoritativeDungeon);
    assert.ok(enemy, 'authoritative enemy should exist');
    return enemy;
}

async function testServerCreatesStableDungeonEnemiesOnce(): Promise<void> {
    const leader = createClient(4101, 'Leader');
    const joiner = createClient(4102, 'Joiner', leader.levelInstanceId);
    const scope = getClientLevelScope(leader as never);

    EntityHandler.sendInitialLevelEntities(leader as never, leader.currentLevel);
    const firstIds = Array.from(GlobalState.levelEntities.get(scope)?.keys() ?? []);
    assert.ok(firstIds.length > 0, 'server should seed dungeon enemies from NPC data');
    assert.equal(
        Array.from(GlobalState.levelEntities.get(scope)?.values() ?? []).every((entity) => !entity.clientSpawned),
        true,
        'canonical dungeon enemies should not be client-spawned'
    );

    EntityHandler.sendInitialLevelEntities(joiner as never, joiner.currentLevel);
    const secondIds = Array.from(GlobalState.levelEntities.get(scope)?.keys() ?? []);
    assert.deepEqual(secondIds, firstIds, 'joiner should receive the same stable instance enemy IDs');
    assert.equal(
        GlobalState.dungeonInstances.get(scope)?.enemyIds.size,
        firstIds.length,
        'DungeonInstance should track exactly the server-seeded enemies'
    );
}

async function testClientEnemySpawnIsSuppressedInServerDungeon(): Promise<void> {
    const leader = createClient(4201, 'Leader');
    const joiner = createClient(4202, 'Joiner', leader.levelInstanceId);
    const scope = getClientLevelScope(leader as never);

    EntityHandler.sendInitialLevelEntities(leader as never, leader.currentLevel);
    const canonical = firstAuthoritativeEnemy(scope);
    const beforeSize = GlobalState.levelEntities.get(scope)?.size ?? 0;

    EntityHandler.handleEntityFullUpdate(joiner as never, buildEntityFullUpdatePayload({
        id: 777777,
        name: canonical.name,
        x: canonical.x + 10,
        y: canonical.y,
        team: 2
    }));

    assert.equal(GlobalState.levelEntities.get(scope)?.size, beforeSize, 'duplicate client enemy should not enter canonical level state');
    assert.equal(GlobalState.levelEntities.get(scope)?.has(777777), false, 'duplicate client enemy ID should be rejected');
    assert.equal(joiner.sentPackets.some((packet) => packet.id === 0x0D), true, 'joiner should be told to destroy the duplicate local enemy');
}

async function testEnemyAttackReportsAreValidatedAndCooldowned(): Promise<void> {
    const player = createClient(4301, 'Victim');
    const scope = getClientLevelScope(player as never);
    GlobalState.sessionsByToken.set(player.token, player as never);
    EntityHandler.sendInitialLevelEntities(player as never, player.currentLevel);

    const enemy = firstAuthoritativeEnemy(scope);
    enemy.x = 100;
    enemy.y = 100;
    enemy.nextAuthoritativeAttackAt = 0;

    const playerEntity = {
        id: player.clientEntID,
        name: player.character.name,
        isPlayer: true,
        team: 1,
        x: 150,
        y: 100,
        hp: 1000,
        maxHp: 1000,
        ownerToken: player.token
    };
    player.entities.set(player.clientEntID, playerEntity);
    GlobalState.levelEntities.get(scope)?.set(player.clientEntID, playerEntity);

    await CombatHandler.handlePowerHit(player as never, buildPowerHitPayload(player.clientEntID, enemy.id, 999999));
    const hpAfterFirstHit = player.authoritativeCurrentHp;
    assert.ok(hpAfterFirstHit < 1000, 'valid enemy report should apply damage');
    assert.ok(hpAfterFirstHit > 1, 'enemy damage should be clamped below the forged packet value');

    await CombatHandler.handlePowerHit(player as never, buildPowerHitPayload(player.clientEntID, enemy.id, 999999));
    assert.equal(player.authoritativeCurrentHp, hpAfterFirstHit, 'second immediate enemy hit should be rejected by cooldown');
}

async function testAliveAuthoritativeEnemyDestroyIsRejected(): Promise<void> {
    const player = createClient(4401, 'Player');
    const scope = getClientLevelScope(player as never);
    GlobalState.sessionsByToken.set(player.token, player as never);
    EntityHandler.sendInitialLevelEntities(player as never, player.currentLevel);
    const enemy = firstAuthoritativeEnemy(scope);

    await CombatHandler.handleEntityDestroy(player as never, buildDestroyPayload(enemy.id));

    const canonical = GlobalState.levelEntities.get(scope)?.get(enemy.id);
    assert.ok(canonical, 'alive authoritative enemy should remain in canonical state');
    assert.equal(DungeonInstance.isEnemyAlive(canonical), true, 'alive authoritative enemy destroy should be ignored');
}

async function testRefreshSnapshotKeepsDeadEnemiesDead(): Promise<void> {
    const firstSession = createClient(4501, 'Refresher');
    const refreshedSession = createClient(4502, 'Refresher', firstSession.levelInstanceId);
    const scope = getClientLevelScope(firstSession as never);

    EntityHandler.sendInitialLevelEntities(firstSession as never, firstSession.currentLevel);
    const enemy = firstAuthoritativeEnemy(scope);
    enemy.hp = 0;
    enemy.dead = true;
    DungeonInstance.noteEnemyState(scope, enemy.id, enemy);
    const progressAfterDeath = DungeonInstance.getCompletionProgress(scope);
    const sentBeforeRefresh = refreshedSession.sentPackets.length;

    EntityHandler.sendInitialLevelEntities(refreshedSession as never, refreshedSession.currentLevel);

    assert.equal(DungeonInstance.getCompletionProgress(scope), progressAfterDeath, 'refresh should preserve server dungeon progress');
    assert.ok(progressAfterDeath > 0, 'dead enemy should advance server dungeon progress');
    assert.equal(
        refreshedSession.sentPackets.slice(sentBeforeRefresh).some((packet) => packet.id === 0x0F),
        true,
        'refresh should still send living server enemies from the snapshot'
    );
    assert.equal(refreshedSession.knownEntityIds.has(enemy.id), true, 'dead enemy should be remembered but not respawned');
}

async function main(): Promise<void> {
    ensureDataLoaded();
    resetGlobalState();
    await testServerCreatesStableDungeonEnemiesOnce();
    resetGlobalState();
    await testClientEnemySpawnIsSuppressedInServerDungeon();
    resetGlobalState();
    await testEnemyAttackReportsAreValidatedAndCooldowned();
    resetGlobalState();
    await testAliveAuthoritativeEnemyDestroyIsRejected();
    resetGlobalState();
    await testRefreshSnapshotKeepsDeadEnemiesDead();
    console.log('server_authoritative_dungeon_regression: ok');
}

main().catch((error) => {
    console.error('server_authoritative_dungeon_regression: failed');
    console.error(error);
    process.exit(1);
});
