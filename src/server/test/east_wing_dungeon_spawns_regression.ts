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
    assert.equal(hostiles.length, 5, 'JC_Mini2 should seed exactly five canonical hostiles');
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
    assert.equal(config.enemies.length, 5, 'registry should contain five enemies');
    assert.equal(config.enemies.filter((enemy) => enemy.requiredForClear).length, 5, 'all East Wing enemies should be required for clear');
    assert.equal(config.enemies.filter((enemy) => enemy.boss || enemy.miniboss).length, 1, 'registry should identify one boss/miniboss');

    const npcs = NpcLoader.getNpcsForLevel('JC_Mini2');
    assert.equal(npcs.length, 5, 'NpcLoader should expose the generated East Wing enemies');
    assert.equal(npcs[0].id, 920001, 'generated canonical ids should be stable');
    assert.equal(usesSharedDungeonProgress('JC_Mini2'), true, 'generated required-for-clear dungeon should use shared progress');
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

    await CombatHandler.handlePowerHit(
        zeus as never,
        buildPowerHitPayload(500001, zeus.clientEntID, Math.round(Number(canonical.hp ?? 0)) + 999)
    );
    assert.equal(canonical.dead, true, 'starter should kill canonical GreaterDemonMaligner');

    const totals = getSharedDungeonProgressTotals(starterScope);
    const progressState = recomputeSharedDungeonProgress(starterScope);
    assert.equal(totals.total, 5, 'required-for-clear totals should count all server canonical enemies');
    assert.equal(totals.defeated, 1, 'required-for-clear totals should count defeated server canonical enemies');
    assert.equal(progressState?.progress, 20, 'East Wing progress should be floor(deadRequired / totalRequired * 100)');

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
