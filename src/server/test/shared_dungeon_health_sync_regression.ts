import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { Entity, EntityState, EntityTeam } from '../core/Entity';
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
    if (!LevelConfig.has('JC_Mission3')) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
}

function createFakeClient(name: string, token: number, roomId: number): FakeClient {
    const sentPackets: SentPacket[] = [];
    return {
        token,
        character: {
            name,
            level: 50,
            class: 'mage',
            MasterClass: 0,
            CurrentLevel: { name: 'JC_Mission3', x: 1000, y: 1000 }
        },
        currentLevel: 'JC_Mission3',
        levelInstanceId: 'shared-health-sync',
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

function setParty(...clients: FakeClient[]): void {
    const partyId = 8811;
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

function buildHostileFullUpdate(entityId: number, name: string, x: number, y: number, roomId: number): Buffer {
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

function attachHostile(client: FakeClient, localId: number, name: string, x: number, y: number, roomId: number): void {
    EntityHandler.handleEntityFullUpdate(client as never, buildHostileFullUpdate(localId, name, x, y, roomId));
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

function buildHpDeltaPayload(entityId: number, amount: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod24(amount);
    return bb.toBuffer();
}

function buildDestroyEntityPayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod15(true);
    return bb.toBuffer();
}

function buildEntityStatePayload(entityId: number, entState: number): Buffer {
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

function buildBuffStatePayload(entityId: number, buffId: number = 17, durationMs: number = 0): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod4(buffId);
    if (durationMs > 0) {
        bb.writeMethod24(durationMs);
    }
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

function parseHpDelta(payload: Buffer): { entityId: number; delta: number } {
    const br = new BitReader(payload);
    return {
        entityId: br.readMethod4(),
        delta: br.readMethod45()
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

function parseDestroyEntity(payload: Buffer): { entityId: number; immediate: boolean } {
    const br = new BitReader(payload);
    return {
        entityId: br.readMethod4(),
        immediate: br.readMethod15()
    };
}

function parseBuffTargetId(payload: Buffer): number {
    return new BitReader(payload).readMethod4();
}

async function testSharedHostileHpConvergesAcrossLocalIds(): Promise<void> {
    const rogue = createFakeClient('Rogue', 11001, 2);
    const mage = createFakeClient('Mage', 22002, 2);
    setParty(rogue, mage);
    attachPlayer(rogue);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachHostile(rogue, 500001, 'DefectorMage', 2000, 1200, 2);
    const canonical = GlobalState.levelEntities.get(scope)?.get(500001);
    assert.ok(canonical, 'starter hostile should become canonical');
    assert.equal(canonical.hybridCanonicalHostile, true, 'starter hostile should be promoted into the hybrid canonical registry');
    assert.equal(canonical.clientSpawned, false, 'canonical hostile should not remain a client-owned spawn');
    assert.equal(canonical.aiOwnerToken, rogue.token, 'canonical hostile should remember the AI owner token');
    assert.equal(canonical.ownerPartyId, 8811, 'canonical hostile should remember the owner party');
    canonical.maxHp = 10000;
    canonical.hp = 10000;
    canonical.healthDelta = 0;
    canonical.health_delta = 0;

    attachHostile(mage, 600001, 'DefectorMage', 2000, 1200, 2);
    assert.equal(EntityHandler.resolveEntityAlias(mage as never, 600001), 500001, 'joiner local hostile id should alias to canonical');
    assert.equal(GlobalState.levelEntities.get(scope)?.has(600001), false, 'joiner duplicate must not create a second server enemy');

    rogue.entities.set(500001, { ...rogue.entities.get(500001), maxHp: 10000, hp: 10000 });
    mage.entities.set(600001, { ...mage.entities.get(600001), maxHp: 10000, hp: 10000 });
    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;

    await CombatHandler.handlePowerHit(rogue as never, buildPowerHitPayload(500001, rogue.clientEntID, 2500));
    assert.equal(canonical.hp, 7500, 'rogue hit should update canonical HP');
    assert.equal(mage.entities.get(600001)?.hp, 7500, 'mage local proxy cache should converge to canonical HP');

    mage.entities.set(600001, { ...mage.entities.get(600001), hp: 9000, maxHp: 10000 });
    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    await CombatHandler.handlePowerHit(rogue as never, buildPowerHitPayload(500001, rogue.clientEntID, 1000));
    assert.equal(canonical.hp, 6500, 'second hit should keep canonical HP authoritative');
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 600001 && parseHpDelta(packet.payload).delta === -1500),
        true,
        'stale mage local HP should receive pre-hit correction on its local enemy id'
    );

    mage.sentPackets.length = 0;
    await CombatHandler.handlePowerHit(rogue as never, buildPowerHitPayload(500001, rogue.clientEntID, 7000));
    assert.equal(canonical.hp, 0, 'lethal shared hostile hit should be server-authoritative');
    assert.equal(canonical.dead, true, 'lethal shared hostile hit should mark canonical dead');
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 600001 && parseEntityState(packet.payload).entState === EntityState.DEAD),
        true,
        'lethal shared hostile hit should send DEAD state to the party viewer local id'
    );
}

function testLeaderFlagDoesNotCreateSecondSharedHostile(): void {
    const rogue = createFakeClient('Rogue', 12001, 2);
    const mage = createFakeClient('Mage', 23002, 2);
    setParty(rogue, mage);
    attachPlayer(rogue);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachHostile(rogue, 510001, 'AncientDragonGoldMini', 2400, 1200, 2);
    const canonical = GlobalState.levelEntities.get(scope)?.get(510001);
    assert.ok(canonical, 'first dragon spawn should become canonical');

    const party = GlobalState.partyGroups.get(8811);
    assert.ok(party, 'test party should exist');
    party.leader = mage.character.name;

    attachHostile(mage, 610001, 'AncientDragonGoldMini', 2410, 1200, 2);

    assert.equal(
        EntityHandler.resolveEntityAlias(mage as never, 610001),
        510001,
        'later leader-side local dragon should alias to the existing canonical dragon'
    );
    assert.equal(
        GlobalState.levelEntities.get(scope)?.has(610001),
        false,
        'later leader-side local dragon must not create a second server enemy'
    );
    assert.equal(
        mage.entities.get(610001)?.sharedCanonicalId,
        510001,
        'leader-side local dragon should be retained only as a proxy to canonical HP'
    );
}

async function testUnaliasedSharedHostileDestroyRelaysDeadState(): Promise<void> {
    const rogue = createFakeClient('Rogue', 55005, 2);
    const mage = createFakeClient('Mage', 66006, 2);
    setParty(rogue, mage);
    attachPlayer(rogue);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachHostile(mage, 600010, 'AncientDragonSilver', 2400, 1200, 2);
    const canonical = GlobalState.levelEntities.get(scope)?.get(600010);
    assert.ok(canonical, 'mage dragon should become the canonical shared hostile');
    canonical.maxHp = 50000;
    canonical.hp = 0;
    canonical.dead = true;
    canonical.entState = EntityState.DEAD;
    canonical.healthDelta = -50000;
    canonical.health_delta = -50000;
    mage.entities.set(600010, { ...mage.entities.get(600010), ...canonical });

    attachHostile(rogue, 500010, 'AncientDragonSilver', 2400, 1200, 2);
    GlobalState.levelEntities.get(scope)?.delete(500010);
    rogue.entityIdAliases.delete(500010);
    rogue.knownEntityIds.delete(600010);
    rogue.knownEntityIds.add(500010);
    rogue.entities.set(500010, {
        ...canonical,
        id: 500010,
        hp: 50000,
        maxHp: 50000,
        dead: false,
        entState: EntityState.ACTIVE,
        healthDelta: 0,
        health_delta: 0,
        canonicalEntityId: undefined,
        sharedCanonicalId: undefined
    });

    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    await CombatHandler.handleEntityDestroy(mage as never, buildDestroyEntityPayload(600010));

    assert.equal(EntityHandler.resolveEntityAlias(rogue as never, 500010), 600010, 'destroy relay should bind stale rogue local dragon to canonical');
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 500010 && parseEntityState(packet.payload).entState === EntityState.DEAD),
        true,
        'destroy of an unaliased shared hostile should relay DEAD state to the viewer local id'
    );
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntity(packet.payload).entityId === 500010),
        true,
        'destroy of an unaliased shared hostile should remove the viewer local id'
    );
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 600010 && parseEntityState(packet.payload).entState === EntityState.DEAD),
        true,
        'destroy of a shared hostile should echo DEAD state back to the source local id'
    );
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntity(packet.payload).entityId === 600010),
        true,
        'destroy of a shared hostile should echo removal back to the source local id'
    );
}

function testPrematureDeadHpReportDoesNotFinalizeDeath(): void {
    const rogue = createFakeClient('Rogue', 99009, 2);
    const mage = createFakeClient('Mage', 99110, 2);
    setParty(rogue, mage);
    attachPlayer(rogue);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachHostile(rogue, 500030, 'SharedBandit', 2800, 1200, 2);
    const canonical = GlobalState.levelEntities.get(scope)?.get(500030);
    assert.ok(canonical, 'rogue hostile should become the canonical shared hostile');
    canonical.maxHp = 10000;
    canonical.hp = 1000;
    canonical.dead = true;
    canonical.entState = EntityState.DEAD;

    attachHostile(mage, 600030, 'SharedBandit', 2800, 1200, 2);
    mage.entities.set(600030, {
        ...mage.entities.get(600030),
        hp: 1000,
        maxHp: 10000,
        dead: false,
        entState: EntityState.ACTIVE
    });
    rogue.entities.set(500030, {
        ...rogue.entities.get(500030),
        hp: 1000,
        maxHp: 10000,
        dead: true,
        entState: EntityState.DEAD
    });

    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    CombatHandler.handleCharRegen(rogue as never, buildHpDeltaPayload(500030, -1000));

    assert.equal(canonical.hp, 1000, 'HP report must not clamp a positive-HP canonical hostile to zero');
    assert.equal(canonical.dead, false, 'positive canonical HP should clear premature dead state');
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntity(packet.payload).entityId === 600030),
        false,
        'positive-HP HP report must not destroy the viewer local id'
    );
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 600030 && parseEntityState(packet.payload).entState === EntityState.DEAD),
        false,
        'positive-HP HP report must not send DEAD state to the viewer local id'
    );
}

function testLethalHpReportDoesNotMutateCanonicalHostile(): void {
    const rogue = createFakeClient('Rogue', 99220, 2);
    const mage = createFakeClient('Mage', 99330, 2);
    setParty(rogue, mage);
    attachPlayer(rogue);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachHostile(rogue, 500040, 'SharedDragon', 3000, 1200, 2);
    const canonical = GlobalState.levelEntities.get(scope)?.get(500040);
    assert.ok(canonical, 'source hostile should become the canonical shared hostile');
    canonical.maxHp = 10000;
    canonical.hp = 1640;
    canonical.dead = false;
    canonical.entState = EntityState.ACTIVE;

    attachHostile(mage, 600040, 'SharedDragon', 3000, 1200, 2);
    rogue.entities.set(500040, {
        ...rogue.entities.get(500040),
        hp: 1640,
        maxHp: 10000,
        dead: false,
        entState: EntityState.ACTIVE
    });
    mage.entities.set(600040, {
        ...mage.entities.get(600040),
        hp: 1640,
        maxHp: 10000,
        dead: false,
        entState: EntityState.ACTIVE
    });

    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    CombatHandler.handleCharRegen(rogue as never, buildHpDeltaPayload(500040, -4212));

    assert.equal(canonical.hp, 1640, 'lethal-looking HP report must not mutate canonical shared hostile HP');
    assert.equal(canonical.dead, false, 'lethal-looking HP report must not kill canonical shared hostile');
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entState === EntityState.DEAD),
        false,
        'lethal-looking HP report must not echo DEAD state back to the source local id'
    );
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entState === EntityState.DEAD),
        false,
        'lethal-looking HP report must not relay DEAD state to the party viewer local id'
    );
}

async function testPostDeathPacketsAreDropped(): Promise<void> {
    const rogue = createFakeClient('Rogue', 99221, 2);
    const mage = createFakeClient('Mage', 99331, 2);
    setParty(rogue, mage);
    attachPlayer(rogue);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachHostile(rogue, 500041, 'SharedDeadLock', 3000, 1200, 2);
    const canonical = GlobalState.levelEntities.get(scope)?.get(500041);
    assert.ok(canonical, 'source hostile should become the canonical shared hostile');
    canonical.maxHp = 10000;
    canonical.hp = 0;
    canonical.dead = true;
    canonical.destroyed = true;
    canonical.entState = EntityState.DEAD;

    attachHostile(mage, 600041, 'SharedDeadLock', 3000, 1200, 2);
    mage.sentPackets.length = 0;
    CombatHandler.handleCharRegen(mage as never, buildHpDeltaPayload(600041, -5000));
    await CombatHandler.handleAddBuff(mage as never, buildBuffStatePayload(600041, 99, 5000));
    await CombatHandler.handleBuffTickDot(mage as never, buildBuffTickDotPayload(600041, mage.clientEntID, 5000));
    await CombatHandler.handlePowerHit(mage as never, buildPowerHitPayload(600041, mage.clientEntID, 5000));
    await CombatHandler.handleEntityDestroy(mage as never, buildDestroyEntityPayload(600041));
    LevelHandler.handleEntityIncrementalUpdate(mage as never, buildEntityStatePayload(600041, EntityState.ACTIVE));

    assert.equal(canonical.hp, 0, 'post-death HP report must not change canonical HP');
    assert.equal(canonical.destroyed, true, 'post-death HP report must keep destroyed terminal state');
    assert.equal(Object.keys(canonical.activeBuffs ?? {}).length, 0, 'post-death AddBuff must not attach new canonical buffs');
    assert.equal(canonical.entState, EntityState.DEAD, 'post-death incremental update must not revive canonical state');
}

/*
 * 0x0B payload parsing is uncertain beyond targetId + buffId. Duration is only
 * honored when a following method24 value is present; otherwise no fallback TTL
 * is assigned.
 */
function testDeadCanonicalHpReportDestroysLiveViewerProxy(): void {
    testPrematureDeadHpReportDoesNotFinalizeDeath();
}

async function testLethalHpReportEchoesSourceSharedHostileProxy(): Promise<void> {
    testLethalHpReportDoesNotMutateCanonicalHostile();
    await testPostDeathPacketsAreDropped();
}

async function testDeadSharedHostilePowerHitCannotKillPlayer(): Promise<void> {
    const rogue = createFakeClient('Rogue', 99440, 2);
    const mage = createFakeClient('Mage', 99550, 2);
    setParty(rogue, mage);
    attachPlayer(rogue);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachHostile(rogue, 500050, 'SharedDeadDragon', 3200, 1200, 2);
    const canonical = GlobalState.levelEntities.get(scope)?.get(500050);
    assert.ok(canonical, 'source hostile should become canonical before death');
    canonical.maxHp = 10000;
    canonical.hp = 0;
    canonical.dead = true;
    canonical.entState = EntityState.DEAD;

    attachHostile(mage, 600050, 'SharedDeadDragon', 3200, 1200, 2);
    mage.entities.set(600050, {
        ...mage.entities.get(600050),
        hp: 10000,
        maxHp: 10000,
        dead: false,
        entState: EntityState.ACTIVE
    });
    mage.authoritativeCurrentHp = 5000;
    mage.entities.set(mage.clientEntID, {
        ...mage.entities.get(mage.clientEntID),
        hp: 5000,
        maxHp: 5000,
        dead: false,
        entState: EntityState.ACTIVE
    });

    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    await CombatHandler.handlePowerHit(mage as never, buildPowerHitPayload(mage.clientEntID, 600050, 6000));

    assert.equal(mage.authoritativeCurrentHp, 5000, 'dead shared hostile power hit must not damage the player');
    assert.equal(mage.entities.get(mage.clientEntID)?.dead, false, 'dead shared hostile power hit must not mark player dead');
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 600050 && parseEntityState(packet.payload).entState === EntityState.DEAD),
        true,
        'dead shared hostile action should echo DEAD state for the stale local hostile id'
    );
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntity(packet.payload).entityId === 600050),
        true,
        'dead shared hostile action should destroy the stale local hostile id'
    );
}

async function testFollowerHostileSourcePowerHitDoesNotDamagePlayer(): Promise<void> {
    const rogue = createFakeClient('Rogue', 99660, 2);
    const mage = createFakeClient('Mage', 99770, 2);
    setParty(rogue, mage);
    attachPlayer(rogue);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachHostile(rogue, 500060, 'SharedOwnerDragon', 3400, 1200, 2);
    const canonical = GlobalState.levelEntities.get(scope)?.get(500060);
    assert.ok(canonical, 'owner hostile should become canonical');
    canonical.maxHp = 10000;
    canonical.hp = 10000;
    canonical.dead = false;
    canonical.entState = EntityState.ACTIVE;

    attachHostile(mage, 600060, 'SharedOwnerDragon', 3400, 1200, 2);
    mage.authoritativeCurrentHp = 5000;
    mage.entities.set(mage.clientEntID, {
        ...mage.entities.get(mage.clientEntID),
        hp: 5000,
        maxHp: 5000,
        dead: false,
        entState: EntityState.ACTIVE
    });

    await CombatHandler.handlePowerHit(mage as never, buildPowerHitPayload(mage.clientEntID, 600060, 2000));

    assert.equal(mage.authoritativeCurrentHp, 5000, 'follower hostile-source hit must not damage the player');
    assert.equal(canonical.hp, 10000, 'follower hostile-source hit must not mutate canonical hostile HP');
}

async function testTimedBuffExpiresWithoutClientRemoveBuff(): Promise<void> {
    const rogue = createFakeClient('Rogue', 99880, 2);
    const mage = createFakeClient('Mage', 99990, 2);
    setParty(rogue, mage);
    attachPlayer(rogue);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachHostile(rogue, 500070, 'SharedBuffDragon', 3600, 1200, 2);
    const canonical = GlobalState.levelEntities.get(scope)?.get(500070);
    assert.ok(canonical, 'buff target hostile should become canonical');
    attachHostile(mage, 600070, 'SharedBuffDragon', 3600, 1200, 2);

    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    await CombatHandler.handleAddBuff(rogue as never, buildBuffStatePayload(500070, 23, 1200));
    assert.equal(Object.keys(canonical.activeBuffs ?? {}).length, 1, 'canonical hostile should record timed buff state');

    const snapshot = Object.values(canonical.activeBuffs ?? {})[0] as any;
    CombatHandler.processBuffExpirations(scope, Number(snapshot.expiresAt ?? 0) + 1);

    assert.equal(Object.keys(canonical.activeBuffs ?? {}).length, 0, 'expired buff should be removed from canonical state');
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0C && parseBuffTargetId(packet.payload) === 600070),
        true,
        'buff expiration should broadcast RemoveBuff on the viewer local hostile id'
    );
}

function testUnaliasedSharedHostileIncrementalDeathRelaysToViewerLocalId(): void {
    const rogue = createFakeClient('Rogue', 77007, 2);
    const mage = createFakeClient('Mage', 88008, 2);
    setParty(rogue, mage);
    attachPlayer(rogue);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachHostile(mage, 600020, 'SharedSkeleton', 2600, 1200, 2);
    const canonical = GlobalState.levelEntities.get(scope)?.get(600020);
    assert.ok(canonical, 'mage hostile should become the canonical shared hostile');
    canonical.maxHp = 10000;
    canonical.hp = 10000;
    canonical.dead = false;
    canonical.entState = EntityState.ACTIVE;
    mage.entities.set(600020, { ...mage.entities.get(600020), ...canonical });

    attachHostile(rogue, 500020, 'SharedSkeleton', 2600, 1200, 2);
    GlobalState.levelEntities.get(scope)?.delete(500020);
    rogue.entityIdAliases.delete(500020);
    rogue.knownEntityIds.delete(600020);
    rogue.knownEntityIds.add(500020);
    rogue.entities.set(500020, {
        ...canonical,
        id: 500020,
        hp: 10000,
        maxHp: 10000,
        dead: false,
        entState: EntityState.ACTIVE,
        healthDelta: 0,
        health_delta: 0,
        canonicalEntityId: undefined,
        sharedCanonicalId: undefined
    });

    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    LevelHandler.handleEntityIncrementalUpdate(mage as never, buildEntityStatePayload(600020, EntityState.DEAD));

    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 600020 && parseEntityState(packet.payload).entState === EntityState.ACTIVE),
        true,
        'predicted incremental DEAD state should correct the sender local hostile back to ACTIVE while HP is positive'
    );
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 500020 && parseEntityState(packet.payload).entState === EntityState.DEAD),
        false,
        'predicted incremental DEAD state should not relay to a viewer while canonical HP is positive'
    );
}

function testPlayerHpReportsRelayToPartyViewers(): void {
    const rogue = createFakeClient('Rogue', 33003, 2);
    const mage = createFakeClient('Mage', 44004, 2);
    setParty(rogue, mage);
    attachPlayer(rogue);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    CombatHandler.handleCharRegen(rogue as never, buildHpDeltaPayload(rogue.clientEntID, -1200));
    assert.equal(rogue.authoritativeCurrentHp, 3800, 'player damage report should update authoritative HP');
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === rogue.clientEntID && parseHpDelta(packet.payload).delta === -1200),
        true,
        'player damage report should relay negative HP delta to party viewer'
    );

    mage.sentPackets.length = 0;
    CombatHandler.handleCharRegen(rogue as never, buildHpDeltaPayload(rogue.clientEntID, -5000));
    assert.equal(rogue.authoritativeCurrentHp, 0, 'lethal player damage report should clamp authoritative HP to zero');
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === rogue.clientEntID && parseEntityState(packet.payload).entState === EntityState.DEAD),
        true,
        'lethal player damage report should relay DEAD state to party viewer'
    );
}

async function main(): Promise<void> {
    const levelEntities = new Map(GlobalState.levelEntities);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const partyByMember = new Map(GlobalState.partyByMember);
    const partyGroups = new Map(GlobalState.partyGroups);
    const combatContributions = new Map(GlobalState.combatContributions);
    const entityLifeNonces = new Map(GlobalState.entityLifeNonces);
    const entityLastRewardNonces = new Map(GlobalState.entityLastRewardNonces);

    ensureDataLoaded();
    try {
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testSharedHostileHpConvergesAcrossLocalIds();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        testLeaderFlagDoesNotCreateSecondSharedHostile();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testUnaliasedSharedHostileDestroyRelaysDeadState();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        testDeadCanonicalHpReportDestroysLiveViewerProxy();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testLethalHpReportEchoesSourceSharedHostileProxy();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testDeadSharedHostilePowerHitCannotKillPlayer();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testFollowerHostileSourcePowerHitDoesNotDamagePlayer();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testTimedBuffExpiresWithoutClientRemoveBuff();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        testUnaliasedSharedHostileIncrementalDeathRelaysToViewerLocalId();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        testPlayerHpReportsRelayToPartyViewers();

        console.log('shared_dungeon_health_sync_regression: ok');
    } finally {
        GlobalState.levelEntities = levelEntities;
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.partyByMember = partyByMember;
        GlobalState.partyGroups = partyGroups;
        GlobalState.combatContributions = combatContributions;
        GlobalState.entityLifeNonces = entityLifeNonces;
        GlobalState.entityLastRewardNonces = entityLastRewardNonces;
    }
}

void main().catch((error) => {
    console.error('shared_dungeon_health_sync_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
