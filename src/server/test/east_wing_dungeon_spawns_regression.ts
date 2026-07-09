import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { Entity, EntityState, EntityTeam } from '../core/Entity';
import { getLevelScopeKey } from '../core/LevelScope';
import {
    getSharedDungeonProgressTotals,
    recomputeSharedDungeonProgress,
    usesSharedDungeonProgress
} from '../core/SharedDungeonProgress';
import { DungeonSpawnLoader, DungeonSpawnConfig } from '../data/DungeonSpawnLoader';
import { NpcLoader } from '../data/NpcLoader';
import { CombatHandler } from '../handlers/CombatHandler';
import { EntityHandler } from '../handlers/EntityHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { RewardHandler } from '../handlers/RewardHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    character: { name: string; level: number; class?: string; MasterClass?: number; CurrentLevel?: { name: string; x: number; y: number } };
    currentLevel: string;
    levelInstanceId: string;
    syncAnchorStartedAt: number;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    userId: number;
    authoritativeMaxHp: number;
    authoritativeCurrentHp: number;
    processedRewardSources: Set<string>;
    pendingLoot: Map<number, any>;
    knownEntityIds: Set<number>;
    entityIdAliases: Map<number, number>;
    sharedEntityRemoteUpdateDeferredIds: Set<number>;
    entities: Map<number, any>;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('JC_Mini2')) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
    if (NpcLoader.getRawNpcsForLevel('JC_Mini2').length === 0) {
        NpcLoader.load(dataDir);
    }
}

function getConfig(): DungeonSpawnConfig {
    const config = DungeonSpawnLoader.getSpawnConfigForLevel('JC_Mini2');
    assert.ok(config, 'East Wing generated dungeon spawn config should load');
    return config as DungeonSpawnConfig;
}

function createFakeClient(name: string, instanceId: string, token: number, roomId: number): FakeClient {
    const sentPackets: SentPacket[] = [];
    return {
        token,
        character: {
            name,
            level: 50,
            class: 'mage',
            MasterClass: 0,
            CurrentLevel: { name: 'JC_Mini2', x: 100, y: 200 }
        },
        currentLevel: 'JC_Mini2',
        levelInstanceId: instanceId,
        syncAnchorStartedAt: token,
        currentRoomId: roomId,
        playerSpawned: true,
        clientEntID: token + 1000,
        userId: token,
        authoritativeMaxHp: 5000,
        authoritativeCurrentHp: 5000,
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        sharedEntityRemoteUpdateDeferredIds: new Set<number>(),
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

function attachPlayer(client: FakeClient): void {
    const scope = getLevelScopeKey(client.currentLevel, client.levelInstanceId);
    const player = {
        ...Entity.fromCharacter(client.clientEntID, client.character as any, {
            x: 100,
            y: 200,
            team: EntityTeam.PLAYER,
            entState: EntityState.ACTIVE,
            roomId: client.currentRoomId
        }),
        ownerToken: client.token,
        ownerUserId: client.userId,
        hp: client.authoritativeCurrentHp,
        maxHp: client.authoritativeMaxHp
    };
    client.entities.set(client.clientEntID, player);
    client.knownEntityIds.add(client.clientEntID);

    let levelMap = GlobalState.levelEntities.get(scope);
    if (!levelMap) {
        levelMap = new Map<number, any>();
        GlobalState.levelEntities.set(scope, levelMap);
    }
    levelMap.set(client.clientEntID, player);
}

function setParty(...clients: FakeClient[]): void {
    const partyId = 8802;
    const members = clients.map((client) => client.character.name);
    for (const client of clients) {
        GlobalState.partyByMember.set(client.character.name.toLowerCase(), partyId);
    }
    GlobalState.partyGroups.set(partyId, {
        id: partyId,
        leader: members[0],
        members,
        locked: false
    });
}

function buildPowerHitPayload(targetId: number, sourceId: number, damage: number, powerId: number = 77): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(targetId);
    bb.writeMethod4(sourceId);
    bb.writeMethod24(damage);
    bb.writeMethod4(powerId);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildPowerCastPayload(sourceId: number, powerId: number = 77): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(sourceId);
    bb.writeMethod4(powerId);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildBuffStatePayload(entityId: number, buffId: number = 17): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod4(buffId);
    return bb.toBuffer();
}

function buildBuffTickDotPayload(targetId: number, sourceId: number, damage: number, powerId: number = 77): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(targetId);
    bb.writeMethod4(sourceId);
    bb.writeMethod4(powerId);
    bb.writeMethod45(-Math.abs(damage));
    bb.writeMethod20(0, 5);
    return bb.toBuffer();
}

function buildGrantRewardPayload(sourceId: number, receiverId: number, gold: number, hpGain: number = 0): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(receiverId);
    bb.writeMethod9(sourceId);
    bb.writeMethod15(true);
    bb.writeMethod309(1);
    bb.writeMethod15(true);
    bb.writeMethod309(1);
    bb.writeMethod15(true);
    bb.writeMethod15(false);
    bb.writeMethod9(1);
    bb.writeMethod9(0);
    bb.writeMethod9(hpGain);
    bb.writeMethod9(gold);
    bb.writeMethod24(3000);
    bb.writeMethod24(1200);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildIncrementalUpdatePayload(entityId: number, entState: number): Buffer {
    return (LevelHandler as any).buildEntityIncrementalUpdatePayload(
        entityId,
        0,
        0,
        0,
        entState,
        {
            bLeft: false,
            bRunning: false,
            bJumping: false,
            bDropping: false,
            bBackpedal: false
        },
        false,
        0
    );
}

function buildDestroyPayload(entityId: number, immediate: boolean = true): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod15(immediate);
    return bb.toBuffer();
}

function buildClientHostileFullUpdate(
    entityId: number,
    name: string,
    x: number,
    y: number,
    roomId: number
): Buffer {
    const payload = (EntityHandler as any).buildEntityFullUpdatePayload({
        id: entityId,
        name,
        isPlayer: false,
        x,
        y,
        v: 0,
        team: EntityTeam.ENEMY,
        renderDepthOffset: 0,
        characterName: '',
        dramaAnim: '',
        sleepAnim: '',
        summonerId: 0,
        powerId: 0,
        entState: EntityState.ACTIVE,
        facingLeft: false,
        running: false,
        jumping: false,
        dropping: false,
        backpedal: false,
        roomId
    });
    return Buffer.concat([payload, Buffer.from([0])]);
}

function parseHpDelta(payload: Buffer): { entityId: number; delta: number } {
    const br = new BitReader(payload);
    return {
        entityId: br.readMethod4(),
        delta: br.readMethod45()
    };
}

function parseDestroy(payload: Buffer): { entityId: number; immediate: boolean } {
    const br = new BitReader(payload);
    return {
        entityId: br.readMethod4(),
        immediate: br.readMethod15()
    };
}

function getHostiles(scope: string): any[] {
    return Array.from(GlobalState.levelEntities.get(scope)?.values() ?? [])
        .filter((entity) => !entity.isPlayer && Number(entity.team ?? 0) === EntityTeam.ENEMY);
}

function attachProxy(client: FakeClient, localId: number, enemyIndex: number): void {
    const enemy = getConfig().enemies[enemyIndex];
    EntityHandler.handleEntityFullUpdate(
        client as never,
        buildClientHostileFullUpdate(
            localId,
            String(enemy.type),
            Number(enemy.x),
            Number(enemy.y),
            Number(enemy.roomId ?? 0)
        )
    );
}

function assertFiveCanonicalHostiles(scope: string): void {
    const hostiles = getHostiles(scope);
    assert.equal(hostiles.length, 5, 'JC_Mini2 should seed exactly five required canonical hostiles');
    for (const hostile of hostiles) {
        assert.equal(hostile.clientSpawned, false, `${hostile.name} should be server canonical`);
        assert.equal(hostile.level, 50, `${hostile.name} should be normalized to level 50`);
        assert.equal(hostile.requiredForClear, true, `${hostile.name} should be required for clear`);
        assert.equal(hostile.generatedFromScript, true, `${hostile.name} should be marked as script-generated`);
        assert.ok(String(hostile.spawnKey ?? '').includes('the_east_wing'), `${hostile.name} should keep a stable East Wing spawn key`);
        assert.ok(Number(hostile.maxHp ?? 0) > 100, `${hostile.name} should have level-50 maxHp`);
    }

    const boss = GlobalState.levelEntities.get(scope)?.get(920004);
    assert.equal(Boolean(boss?.roomBoss), true, 'TowerGuard2 should be marked as a room boss');
    assert.equal(boss?.displayName, 'Tanja, The 2nd Daughter', 'TowerGuard2 display name should come from InitRoom');
}

function testRegistryLoad(): void {
    const config = getConfig();
    assert.equal(config.source?.swf, 'src/client/content/localhost/p/cbp/LevelsJC.swf', 'registry should identify the source SWF');
    assert.equal(config.enemies.length, 7, 'registry should contain all exported East Wing script spawns');
    assert.equal(config.enemies.filter((enemy) => enemy.requiredForClear).length, 5, 'only scripted hostiles should be required for clear');
    assert.equal(config.enemies.filter((enemy: any) => enemy.hostile === false && enemy.serverSpawn === false).length, 2, 'treasure chests should be exported as non-server non-hostiles');
    assert.equal(config.enemies.filter((enemy) => enemy.boss || enemy.miniboss).length, 1, 'registry should identify one boss/miniboss');

    const npcs = NpcLoader.getNpcsForLevel('JC_Mini2');
    assert.equal(npcs.length, 5, 'NpcLoader should expose only generated East Wing server hostiles');
    assert.equal(npcs[0].id, 920001, 'generated canonical ids should be stable');
    assert.equal(usesSharedDungeonProgress('JC_Mini2'), true, 'generated required-for-clear dungeon should use shared progress');
}

function testNonExportedClientHostileIsDestroyed(): void {
    const zeus = createFakeClient('Zeus', 'east-wing-non-exported-hostile', 13933, 0);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    zeus.sentPackets.length = 0;
    EntityHandler.handleEntityFullUpdate(
        zeus as never,
        buildClientHostileFullUpdate(500777, 'ShadeSummoner2', 14000, 4800, 0)
    );

    assert.equal(EntityHandler.resolveEntityAlias(zeus as never, 500777), 500777, 'non-exported hostile should not alias to a random canonical enemy');
    assert.equal(GlobalState.levelEntities.get(scope)?.has(500777), false, 'non-exported local hostile must not enter canonical level map');
    assert.equal(zeus.entities.has(500777), false, 'non-exported local hostile should be removed from viewer cache');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === 500777),
        true,
        'non-exported local hostile should receive immediate destroy'
    );
    assert.equal(getSharedDungeonProgressTotals(scope).defeated, 0, 'non-exported local hostile must not count progress');
}

async function testRejectedClientHostilePacketsStayInert(): Promise<void> {
    const zeus = createFakeClient('Zeus', 'east-wing-rejected-local-inert', 13933, 0);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);
    const rejectedLocalId = 500778;

    EntityHandler.handleEntityFullUpdate(
        zeus as never,
        buildClientHostileFullUpdate(rejectedLocalId, 'ShadeSummoner2', 14000, 4800, 0)
    );
    assert.equal(EntityHandler.isRejectedServerAuthorityLocalEntityId(zeus as never, scope, rejectedLocalId), true, 'non-exported hostile should be tombstoned as rejected for the viewer');

    zeus.sentPackets.length = 0;
    const progressBefore = getSharedDungeonProgressTotals(scope);
    await CombatHandler.handlePowerHit(zeus as never, buildPowerHitPayload(rejectedLocalId, zeus.clientEntID, 999999));
    await CombatHandler.handleBuffTickDot(zeus as never, buildBuffTickDotPayload(rejectedLocalId, zeus.clientEntID, 999999));
    await CombatHandler.handleAddBuff(zeus as never, buildBuffStatePayload(rejectedLocalId, 99));
    await CombatHandler.handleRemoveBuff(zeus as never, buildBuffStatePayload(rejectedLocalId, 99));
    LevelHandler.handleEntityIncrementalUpdate(zeus as never, buildIncrementalUpdatePayload(rejectedLocalId, EntityState.DEAD));
    RewardHandler.handleGrantReward(zeus as never, buildGrantRewardPayload(rejectedLocalId, zeus.clientEntID, 5000, 500));

    assert.deepEqual(getSharedDungeonProgressTotals(scope), progressBefore, 'rejected local packets must not mutate progress');
    assert.equal(zeus.pendingLoot.size, 0, 'rejected local reward packet must not create pending loot');
    assert.equal(zeus.sentPackets.some((packet) => packet.id === 0x32), false, 'rejected local reward packet must not emit loot');
    assert.equal(zeus.sentPackets.some((packet) => packet.id === 0x0B || packet.id === 0x0C || packet.id === 0x79), false, 'rejected local buff packets must not relay');
}

function testDistantImperialGuardDoesNotAliasToCanonical(): void {
    const zeus = createFakeClient('Zeus', 'east-wing-imperialguard-distance', 13933, 4);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    const distantLocalId = 501111;
    EntityHandler.handleEntityFullUpdate(
        zeus as never,
        buildClientHostileFullUpdate(distantLocalId, 'ImperialGuard', 16545, 5259, 4)
    );
    assert.equal(EntityHandler.resolveEntityAlias(zeus as never, distantLocalId), distantLocalId, 'distant ImperialGuard must not alias to canonical 920005');
    assert.equal(EntityHandler.isRejectedServerAuthorityLocalEntityId(zeus as never, scope, distantLocalId), true, 'distant ImperialGuard should be rejected as non-exported/mismatched');
    assert.equal(GlobalState.levelEntities.get(scope)?.has(distantLocalId), false, 'distant ImperialGuard must not become canonical');

    const closeLocalId = 501112;
    EntityHandler.handleEntityFullUpdate(
        zeus as never,
        buildClientHostileFullUpdate(closeLocalId, 'ImperialGuard', 15358, 6619, 4)
    );
    assert.equal(EntityHandler.resolveEntityAlias(zeus as never, closeLocalId), 920005, 'close ImperialGuard should alias to exported canonical 920005');
}

function testInitialCanonicalNoVisibleServerSnapshots(): void {
    const zeus = createFakeClient('Zeus', 'east-wing-initial', 13933, 1);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    assertFiveCanonicalHostiles(scope);
    assert.equal(zeus.sentPackets.some((packet) => packet.id === 0x0F), false, 'initial sync should not send visible server hostile snapshots');
}

async function testProxyAttachKillProgressAndLateJoiner(): Promise<void> {
    const zeus = createFakeClient('Zeus', 'east-wing-starter', 13933, 1);
    const telahair = createFakeClient('Telahair', 'east-wing-joiner', 63188, 1);
    setParty(zeus, telahair);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const starterScope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    zeus.sentPackets.length = 0;
    attachProxy(zeus, 500001, 0);
    assert.equal(EntityHandler.resolveEntityAlias(zeus as never, 500001), 920001, 'starter local proxy should map to canonical GreaterDemonMaligner');
    assert.equal(GlobalState.levelEntities.get(starterScope)?.has(500001), false, 'local proxy must not enter canonical level map');
    const canonical = GlobalState.levelEntities.get(starterScope)?.get(920001);
    assert.ok(canonical, 'canonical GreaterDemonMaligner should exist after proxy attach');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 500001 && parseHpDelta(packet.payload).delta > 0),
        true,
        'proxy attach should receive initial level-50 HP sync'
    );
    const hpBeforeAggro = Math.round(Number(canonical.hp ?? 0));
    (CombatHandler as any).noteHostileAggroTarget(canonical, zeus);
    assert.equal(Math.round(Number(canonical.hp ?? 0)), hpBeforeAggro, 'aggro activation must not change East Wing enemy HP');
    assert.equal(canonical.dead, false, 'aggro activation must not mark East Wing enemy dead');

    await CombatHandler.handlePowerHit(
        zeus as never,
        buildPowerHitPayload(500001, zeus.clientEntID, Math.round(Number(canonical.hp ?? 0)) + 999)
    );
    assert.equal(canonical.dead, false, 'lethal hit without a recent player cast must be rejected for East Wing');
    assert.equal(Math.round(Number(canonical.hp ?? 0)), hpBeforeAggro, 'rejected lethal hit must not change East Wing enemy HP');
    assert.equal(getSharedDungeonProgressTotals(starterScope).defeated, 0, 'rejected lethal hit must not count progress');

    await CombatHandler.handlePowerCast(zeus as never, buildPowerCastPayload(zeus.clientEntID));
    await CombatHandler.handlePowerHit(
        zeus as never,
        buildPowerHitPayload(500001, zeus.clientEntID, Math.round(Number(canonical.hp ?? 0)) + 999)
    );
    assert.equal(canonical.dead, true, 'starter should kill canonical GreaterDemonMaligner');
    assert.equal(canonical.deathCause, 'combat_damage', 'canonical death should record combat damage as cause');
    assert.equal(canonical.combatDeathValidated, true, 'canonical death should have validated combat evidence');
    assert.equal(canonical.lootDropped, true, 'validated East Wing combat death should spawn/drop loot through the reward path');
    const combatDeathEventId = String(canonical.combatDeathEventId ?? '');
    const pendingLootAfterKill = zeus.pendingLoot.size;

    const totals = getSharedDungeonProgressTotals(starterScope);
    const progressState = recomputeSharedDungeonProgress(starterScope);
    assert.equal(totals.total, 5, 'required-for-clear totals should count all server canonical enemies');
    assert.equal(totals.defeated, 1, 'required-for-clear totals should count defeated server canonical enemies');
    assert.equal(progressState?.progress, 20, 'East Wing progress should be floor(deadRequired / totalRequired * 100)');

    await CombatHandler.handlePowerHit(
        zeus as never,
        buildPowerHitPayload(500001, zeus.clientEntID, Math.round(Number(canonical.maxHp ?? 0)) + 999)
    );
    assert.equal(getSharedDungeonProgressTotals(starterScope).defeated, 1, 'duplicate lethal hit must not double-count progress');
    assert.equal(recomputeSharedDungeonProgress(starterScope)?.progress, 20, 'duplicate lethal hit must not advance progress again');
    assert.equal(zeus.pendingLoot.size, pendingLootAfterKill, 'duplicate lethal hit must not spawn duplicate loot');
    assert.equal(String(canonical.combatDeathEventId ?? ''), combatDeathEventId, 'duplicate lethal hit must not replace the original combat death event');

    attachPlayer(telahair);
    GlobalState.sessionsByToken.set(telahair.token, telahair as never);
    EntityHandler.sendInitialLevelEntities(telahair as never, telahair.currentLevel);
    assert.equal(telahair.levelInstanceId, zeus.levelInstanceId, 'party joiner should adopt starter East Wing instance id');

    telahair.sentPackets.length = 0;
    attachProxy(telahair, 600001, 0);
    assert.equal(EntityHandler.resolveEntityAlias(telahair as never, 600001), 920001, 'late joiner proxy should map to the dead canonical id');
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === 600001),
        true,
        'late joiner dead proxy should be destroyed instead of respawning alive'
    );
}

function testIncrementalDeadStateDoesNotKillOrProgress(): void {
    const zeus = createFakeClient('Zeus', 'east-wing-incremental-dead', 13933, 1);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    attachProxy(zeus, 500001, 0);
    const canonical = GlobalState.levelEntities.get(scope)?.get(920001);
    assert.ok(canonical, 'canonical hostile should exist before incremental DEAD test');
    const hpBefore = Math.round(Number(canonical.hp ?? 0));
    zeus.entities.set(920001, canonical);
    zeus.knownEntityIds.add(920001);

    LevelHandler.handleEntityIncrementalUpdate(
        zeus as never,
        buildIncrementalUpdatePayload(920001, EntityState.DEAD)
    );

    assert.equal(canonical.dead, false, 'client incremental DEAD state on canonical id must be rejected');
    assert.equal(canonical.destroyed, false, 'client incremental DEAD state must not destroy canonical enemy');
    assert.equal(Math.round(Number(canonical.hp ?? 0)), hpBefore, 'client incremental DEAD state must not change HP');
    assert.equal(getSharedDungeonProgressTotals(scope).defeated, 0, 'client incremental DEAD state must not count progress');
    assert.equal(recomputeSharedDungeonProgress(scope)?.progress, 0, 'client incremental DEAD state must keep progress at zero');
}

function testNonCombatTerminalStateIsRepairedWithoutProgress(): void {
    const zeus = createFakeClient('Zeus', 'east-wing-terminal-repair', 13933, 1);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    attachProxy(zeus, 500001, 0);
    const canonical = GlobalState.levelEntities.get(scope)?.get(920001);
    assert.ok(canonical, 'canonical hostile should exist before terminal repair test');
    const maxHp = Math.round(Number(canonical.maxHp ?? 0));
    canonical.hp = 0;
    canonical.dead = true;
    canonical.destroyed = true;
    canonical.entState = EntityState.DEAD;
    delete canonical.deathCause;
    delete canonical.combatDeathValidated;
    zeus.entities.set(920001, canonical);
    zeus.knownEntityIds.add(920001);

    LevelHandler.handleEntityIncrementalUpdate(
        zeus as never,
        buildIncrementalUpdatePayload(920001, EntityState.ACTIVE)
    );

    assert.equal(canonical.dead, false, 'non-combat terminal state should be repaired to alive');
    assert.equal(canonical.destroyed, false, 'non-combat terminal state should not stay destroyed');
    assert.equal(Math.round(Number(canonical.hp ?? 0)), maxHp, 'non-combat terminal state should restore HP from maxHp');
    assert.equal(getSharedDungeonProgressTotals(scope).defeated, 0, 'non-combat terminal state must not count progress');
    assert.equal(recomputeSharedDungeonProgress(scope)?.progress, 0, 'non-combat terminal state must keep progress at zero');
}

async function testDestroyOnlyDoesNotKillOrProgress(): Promise<void> {
    const zeus = createFakeClient('Zeus', 'east-wing-destroy-only', 13933, 1);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    attachProxy(zeus, 500001, 0);
    const canonical = GlobalState.levelEntities.get(scope)?.get(920001);
    assert.ok(canonical, 'canonical hostile should exist before destroy-only test');
    const hpBefore = Math.round(Number(canonical.hp ?? 0));

    await CombatHandler.handleEntityDestroy(zeus as never, buildDestroyPayload(500001, true));

    assert.equal(canonical.dead, false, 'destroy-only cleanup must not kill a live East Wing enemy');
    assert.equal(canonical.destroyed, false, 'destroy-only cleanup must not destroy canonical state');
    assert.equal(Math.round(Number(canonical.hp ?? 0)), hpBefore, 'destroy-only cleanup must not change HP');
    assert.equal(getSharedDungeonProgressTotals(scope).defeated, 0, 'destroy-only cleanup must not count progress');
    assert.equal(recomputeSharedDungeonProgress(scope)?.progress, 0, 'destroy-only cleanup must keep progress at zero');
}

function testClientGhostHealthCannotPoisonCanonical(): void {
    const zeus = createFakeClient('Zeus', 'east-wing-health-reconcile', 13933, 1);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    attachProxy(zeus, 500001, 0);
    const canonical = GlobalState.levelEntities.get(scope)?.get(920001);
    assert.ok(canonical, 'canonical hostile should exist before health reconcile test');
    const hpBefore = Math.round(Number(canonical.hp ?? 0));
    const maxHp = Math.round(Number(canonical.maxHp ?? 0));
    zeus.entities.set(500001, {
        ...zeus.entities.get(500001),
        id: 500001,
        canonicalEntityId: 920001,
        sharedCanonicalId: 920001,
        clientSpawned: true,
        team: EntityTeam.ENEMY,
        hp: 0,
        maxHp,
        healthDelta: -maxHp,
        health_delta: -maxHp,
        dead: true,
        destroyed: true,
        entState: EntityState.DEAD
    });

    const healthState = (CombatHandler as any).resolveHostileHealthStateAcrossCopies(scope, canonical);
    assert.equal(Math.round(Number(healthState.currentHp ?? 0)), hpBefore, 'stale client ghost HP must not poison canonical health resolution');
    assert.equal(
        (CombatHandler as any).applyNpcHealthState(canonical, maxHp, 0, true, {
            cause: 'health_reconcile',
            levelScope: scope,
            sourcePath: 'testClientGhostHealthCannotPoisonCanonical'
        }),
        hpBefore,
        'non-combat applyNpcHealthState death attempt must clamp East Wing canonical alive'
    );
    assert.equal(canonical.dead, false, 'health reconciliation must not mark canonical dead');
    assert.equal(canonical.entState, EntityState.ACTIVE, 'health reconciliation must keep canonical active');
    assert.equal(getSharedDungeonProgressTotals(scope).defeated, 0, 'stale client ghost must not count progress');
}

function resetRuntime(): void {
    GlobalState.levelEntities.clear();
    GlobalState.sessionsByToken.clear();
    GlobalState.levelQuestProgress.clear();
    GlobalState.combatContributions.clear();
    GlobalState.entityLifeNonces.clear();
    GlobalState.entityLastRewardNonces.clear();
    GlobalState.partyByMember.clear();
    GlobalState.partyGroups.clear();
}

async function main(): Promise<void> {
    const levelEntities = new Map(GlobalState.levelEntities);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const levelQuestProgress = new Map(GlobalState.levelQuestProgress);
    const combatContributions = new Map(GlobalState.combatContributions);
    const entityLifeNonces = new Map(GlobalState.entityLifeNonces);
    const entityLastRewardNonces = new Map(GlobalState.entityLastRewardNonces);
    const partyByMember = new Map(GlobalState.partyByMember);
    const partyGroups = new Map(GlobalState.partyGroups);

    ensureDataLoaded();
    try {
        resetRuntime();
        testRegistryLoad();

        resetRuntime();
        testInitialCanonicalNoVisibleServerSnapshots();

        resetRuntime();
        testIncrementalDeadStateDoesNotKillOrProgress();

        resetRuntime();
        testNonCombatTerminalStateIsRepairedWithoutProgress();

        resetRuntime();
        await testDestroyOnlyDoesNotKillOrProgress();

        resetRuntime();
        testClientGhostHealthCannotPoisonCanonical();

        resetRuntime();
        testNonExportedClientHostileIsDestroyed();

        resetRuntime();
        await testRejectedClientHostilePacketsStayInert();

        resetRuntime();
        testDistantImperialGuardDoesNotAliasToCanonical();

        resetRuntime();
        await testProxyAttachKillProgressAndLateJoiner();

        console.log('east_wing_dungeon_spawns_regression: ok');
    } finally {
        GlobalState.levelEntities = levelEntities;
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.levelQuestProgress = levelQuestProgress;
        GlobalState.combatContributions = combatContributions;
        GlobalState.entityLifeNonces = entityLifeNonces;
        GlobalState.entityLastRewardNonces = entityLastRewardNonces;
        GlobalState.partyByMember = partyByMember;
        GlobalState.partyGroups = partyGroups;
    }
}

void main().catch((error) => {
    console.error('east_wing_dungeon_spawns_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
