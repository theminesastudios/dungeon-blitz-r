import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { Entity, EntityState, EntityTeam } from '../core/Entity';
import { NpcLoader } from '../data/NpcLoader';
import { EntityHandler } from '../handlers/EntityHandler';
import { CombatHandler } from '../handlers/CombatHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { getLevelScopeKey } from '../core/LevelScope';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    userId: number;
    character: { name: string; level: number; class?: string; MasterClass?: number; CurrentLevel?: { name: string; x: number; y: number } };
    currentLevel: string;
    levelInstanceId: string;
    syncAnchorStartedAt: number;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    authoritativeMaxHp: number;
    authoritativeCurrentHp: number;
    processedRewardSources: Set<string>;
    pendingLoot: Map<number, any>;
    startedRoomEvents: Set<string>;
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
    if (!LevelConfig.has('AC_Mission1')) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
    if (NpcLoader.getRawNpcsForLevel('JC_Mini1Hard').length === 0) {
        NpcLoader.load(dataDir);
    }
}

function createFakeClient(name: string, token: number, roomId: number): FakeClient {
    const sentPackets: SentPacket[] = [];
    return {
        token,
        userId: token,
        character: {
            name,
            level: 50,
            class: name === 'Neodevils' ? 'mage' : 'rogue',
            MasterClass: 0,
            CurrentLevel: { name: 'AC_Mission1', x: 1000, y: 1000 }
        },
        currentLevel: 'AC_Mission1',
        levelInstanceId: '59395',
        syncAnchorStartedAt: 59395,
        currentRoomId: roomId,
        playerSpawned: true,
        clientEntID: token,
        authoritativeMaxHp: 5000,
        authoritativeCurrentHp: 5000,
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        startedRoomEvents: new Set<string>(),
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

function setParty(...clients: FakeClient[]): void {
    const partyId = 59395;
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

function attachPlayer(client: FakeClient): void {
    const scope = getLevelScopeKey(client.currentLevel, client.levelInstanceId);
    const player = {
        ...Entity.fromCharacter(client.clientEntID, client.character as any, {
            x: 1000,
            y: 1000,
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

function buildClientHostileFullUpdate(entityId: number, name: string, x: number, y: number, roomId: number): Buffer {
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

function attachProxy(client: FakeClient, localId: number, name: string, x: number, y: number, roomId: number): void {
    EntityHandler.handleEntityFullUpdate(client as never, buildClientHostileFullUpdate(localId, name, x, y, roomId));
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

function buildHpDeltaPayload(entityId: number, delta: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod24(delta);
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

function parseHpDelta(payload: Buffer): { entityId: number; delta: number } {
    const br = new BitReader(payload);
    return {
        entityId: br.readMethod4(),
        delta: br.readMethod45()
    };
}

function parseUntargetable(payload: Buffer): { entityId: number; untargetable: boolean } {
    const br = new BitReader(payload);
    return {
        entityId: br.readMethod4(),
        untargetable: br.readMethod15()
    };
}

function parseEntityState(payload: Buffer): { entityId: number; entState: number } {
    const br = new BitReader(payload);
    const entityId = br.readMethod4();
    br.readMethod45();
    br.readMethod45();
    br.readMethod45();
    return {
        entityId,
        entState: br.readMethod6(2)
    };
}

function parseDestroyEntity(payload: Buffer): number {
    const br = new BitReader(payload);
    return br.readMethod4();
}

function parseSpawnEntityId(payload: Buffer): number {
    const br = new BitReader(payload);
    return br.readMethod4();
}

async function testAcMission1FirstSightAuthorityConvergesDragon(): Promise<void> {
    const rogue = createFakeClient('AlexMercer', 59395, 2);
    const mage = createFakeClient('Neodevils', 45890, 2);
    setParty(rogue, mage);
    attachPlayer(rogue);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    EntityHandler.sendInitialLevelEntities(rogue as never, rogue.currentLevel);
    assert.equal(
        Array.from(GlobalState.levelEntities.get(scope)?.values() ?? []).filter((entity) => !entity.isPlayer && Number(entity.team ?? 0) === EntityTeam.ENEMY).length,
        0,
        'AC_Mission1 should not require pre-authored server hostile seed data'
    );

    attachProxy(rogue, 4712451, 'AncientDragonGoldMini', 3000, 1200, 2);
    const canonical = GlobalState.levelEntities.get(scope)?.get(4712451);
    assert.ok(canonical, 'first AC_Mission1 dragon proxy should promote into a canonical server hostile');
    assert.equal(canonical.clientSpawned, false, 'promoted AC_Mission1 dragon should be server canonical');
    assert.equal(canonical.hp, canonical.maxHp, 'promoted AC_Mission1 dragon should start at canonical full HP');
    assert.ok(Number(canonical.maxHp ?? 0) > 100000, 'promoted dragon should use server-side level-50 HP scaling');
    assert.equal(rogue.entities.has(4712451), true, 'first viewer should keep the canonical server dragon in its cache');
    assert.equal(rogue.entities.get(4712451)?.clientSpawned, false, 'first viewer must not keep the authored local dragon as client-spawned');
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0x0F && parseSpawnEntityId(packet.payload) === 4712451),
        true,
        'first viewer should receive a server canonical dragon spawn'
    );

    attachProxy(mage, 10859330, 'AncientDragonGoldMini', 3010, 1200, 2);
    assert.equal(EntityHandler.resolveEntityAlias(mage as never, 10859330), 4712451, 'second client dragon id should alias to first canonical dragon');
    assert.equal(GlobalState.levelEntities.get(scope)?.has(10859330), false, 'second client dragon must not create a second server enemy');
    assert.equal(mage.entities.has(10859330), false, 'second client local authored dragon should be destroyed');
    assert.equal(mage.knownEntityIds.has(10859330), false, 'second client should not keep the authored local dragon id as known');
    assert.equal(mage.entities.get(4712451)?.clientSpawned, false, 'second client should render the canonical server dragon');
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntity(packet.payload) === 10859330),
        true,
        'second client should receive a destroy for its authored local dragon'
    );
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0F && parseSpawnEntityId(packet.payload) === 4712451),
        true,
        'second client should receive the canonical server dragon spawn'
    );

    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    await CombatHandler.handlePowerHit(rogue as never, buildPowerHitPayload(4712451, rogue.clientEntID, 16282));
    assert.equal(canonical.hp, canonical.maxHp - 16282, 'non-lethal hit should reduce only the canonical dragon HP');
    assert.equal(mage.entities.get(4712451)?.hp, canonical.hp, 'mage canonical dragon should converge to server HP');
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 4712451 && parseHpDelta(packet.payload).delta < 0),
        true,
        'mage should receive HP correction on the canonical server dragon id when server HP changes'
    );

    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    await CombatHandler.handlePowerHit(mage as never, buildPowerHitPayload(10859330, mage.clientEntID, Math.round(Number(canonical.hp ?? 0)) + 999));
    assert.equal(canonical.hp, 0, 'lethal mage hit should kill the same canonical dragon');
    assert.equal(canonical.dead, true, 'lethal mage hit should mark canonical dragon dead');
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 4712451 && parseEntityState(packet.payload).entState === EntityState.DEAD),
        true,
        'rogue should receive canonical DEAD state on its local dragon id'
    );
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 4712451 && parseEntityState(packet.payload).entState === EntityState.DEAD),
        true,
        'mage should receive canonical DEAD state on the server dragon id'
    );
}

function testAcMission1DestroyedDragonDoesNotRespawnOnRejoin(): void {
    const rogue = createFakeClient('AlexMercer', 59395, 2);
    const rejoin = createFakeClient('Neodevils', 45890, 2);
    setParty(rogue, rejoin);
    attachPlayer(rogue);
    attachPlayer(rejoin);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.sessionsByToken.set(rejoin.token, rejoin as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    const levelMap = GlobalState.levelEntities.get(scope);
    assert.ok(levelMap, 'test scope should have a level map');

    attachProxy(rogue, 4712451, 'AncientDragonGoldMini', 3000, 1200, 2);
    const canonical = levelMap.get(4712451);
    assert.ok(canonical, 'canonical dragon should exist before destroy tombstone');
    canonical.hp = 0;
    canonical.dead = true;
    canonical.entState = EntityState.DEAD;
    (EntityHandler as any).noteServerAuthorityHostileDestroyed(scope, 4712451, canonical);
    levelMap.delete(4712451);

    rejoin.sentPackets.length = 0;
    attachProxy(rejoin, 10999999, 'AncientDragonGoldMini', 3010, 1200, 2);

    assert.equal(
        Array.from(levelMap.values()).some((entity) => !entity.isPlayer && Number(entity.team ?? 0) === EntityTeam.ENEMY),
        false,
        'rejoined local dragon must not promote a new canonical server enemy after the authored dragon died'
    );
    assert.equal(
        rejoin.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 10999999 && parseEntityState(packet.payload).entState === EntityState.DEAD),
        true,
        'rejoined local dragon should be forced into DEAD state'
    );
    assert.equal(
        rejoin.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntity(packet.payload) === 10999999),
        true,
        'rejoined local dragon should be destroyed locally instead of staying alive'
    );
}

function testAcMission1ReconnectDoesNotResetLiveCanonicalScope(): void {
    const rogue = createFakeClient('AlexMercer', 59395, 2);
    attachPlayer(rogue);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachProxy(rogue, 4712451, 'AncientDragonGoldMini', 3000, 1200, 2);
    const levelMap = GlobalState.levelEntities.get(scope);
    assert.ok(levelMap?.get(4712451), 'canonical dragon should exist before reconnect init');
    const liveLevelMap = levelMap as Map<number, any>;

    rogue.knownEntityIds.clear();
    rogue.entities.clear();
    rogue.sentPackets.length = 0;
    EntityHandler.sendInitialLevelEntities(rogue as never, rogue.currentLevel);

    assert.ok(
        liveLevelMap.get(4712451),
        'reconnect initial entity sync must not reset live canonical hostiles for the same dungeon instance'
    );
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0x0F && parseSpawnEntityId(packet.payload) === 4712451),
        true,
        'reconnect initial entity sync should send the canonical server hostile even on AC_Mission1'
    );
}

function testAcMission1CutsceneLocksServerAuthorityHostiles(): void {
    const rogue = createFakeClient('AlexMercer', 59395, 2);
    const mage = createFakeClient('Neodevils', 45890, 2);
    setParty(rogue, mage);
    attachPlayer(rogue);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachProxy(rogue, 4712451, 'AncientDragonGoldMini', 3000, 1200, 2);
    attachProxy(mage, 10859330, 'AncientDragonGoldMini', 3010, 1200, 2);
    const canonical = GlobalState.levelEntities.get(scope)?.get(4712451);
    assert.ok(canonical, 'canonical dragon should exist before cutscene lock');
    const hpBefore = Math.round(Number(canonical.hp ?? 0));

    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    LevelHandler.handleRoomBossInfo(rogue as never, buildRoomBossInfoPayload(2, 4712451, 'AncientDragonGoldMini'));

    assert.equal(canonical.untargetable, true, 'canonical dragon should become untargetable during cutscene');
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0xAE && parseUntargetable(packet.payload).entityId === 4712451 && parseUntargetable(packet.payload).untargetable),
        true,
        'source should receive untargetable for its canonical/local dragon id'
    );
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0xAE && parseUntargetable(packet.payload).entityId === 4712451 && parseUntargetable(packet.payload).untargetable),
        true,
        'party viewer should receive untargetable for the canonical server dragon id'
    );

    CombatHandler.handleCharRegen(mage as never, buildHpDeltaPayload(10859330, -50000));
    assert.equal(canonical.hp, hpBefore, 'HP report from a targetable-looking local proxy must not damage untargetable canonical dragon');
}

async function main(): Promise<void> {
    const levelEntities = new Map(GlobalState.levelEntities);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const partyByMember = new Map(GlobalState.partyByMember);
    const partyGroups = new Map(GlobalState.partyGroups);
    const serverAuthorityDestroyedIdsByScope = new Map((EntityHandler as any).serverAuthorityDestroyedIdsByScope);
    const serverAuthorityDestroyedFingerprintsByScope = new Map((EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope);

    ensureDataLoaded();
    try {
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testAcMission1FirstSightAuthorityConvergesDragon();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testAcMission1DestroyedDragonDoesNotRespawnOnRejoin();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testAcMission1ReconnectDoesNotResetLiveCanonicalScope();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testAcMission1CutsceneLocksServerAuthorityHostiles();
        console.log('ac_mission1_server_authority_regression: ok');
    } finally {
        GlobalState.levelEntities = levelEntities;
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.partyByMember = partyByMember;
        GlobalState.partyGroups = partyGroups;
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope = serverAuthorityDestroyedIdsByScope;
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope = serverAuthorityDestroyedFingerprintsByScope;
    }
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
