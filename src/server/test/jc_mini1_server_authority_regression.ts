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
    if (!LevelConfig.has('JC_Mini1Hard')) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
    if (NpcLoader.getRawNpcsForLevel('JC_Mini1Hard').length === 0) {
        NpcLoader.load(dataDir);
    }
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
            CurrentLevel: { name: 'JC_Mini1Hard', x: 100, y: 200 }
        },
        currentLevel: 'JC_Mini1Hard',
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
    const partyId = 7701;
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

function buildDestroyEntityPayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod15(true);
    return bb.toBuffer();
}

function buildHpDeltaPayload(entityId: number, amount: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod24(amount);
    return bb.toBuffer();
}

function buildBuffTickDotPayload(targetId: number, sourceId: number, damage: number, powerId: number = 77): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(targetId);
    bb.writeMethod4(sourceId);
    bb.writeMethod4(powerId);
    bb.writeMethod45(-Math.max(0, Math.round(damage)));
    bb.writeMethod20(5, 0);
    return bb.toBuffer();
}

function buildRespawnBroadcastPayload(entityId: number, healAmount: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod24(healAmount);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildIncrementalUpdatePayload(entityId: number, deltaX: number, deltaY: number, entState: number = EntityState.ACTIVE): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod45(deltaX);
    bb.writeMethod45(deltaY);
    bb.writeMethod45(0);
    bb.writeMethod6(entState, 2);
    bb.writeMethod15(false);
    bb.writeMethod15(true);
    bb.writeMethod15(false);
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

function parsePowerHit(payload: Buffer): { targetId: number; sourceId: number; damage: number } {
    const br = new BitReader(payload);
    return {
        targetId: br.readMethod4(),
        sourceId: br.readMethod4(),
        damage: br.readMethod24()
    };
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

function setupTwoPlayers(instanceId: string): { zeus: FakeClient; telahair: FakeClient; scope: string } {
    const zeus = createFakeClient('Zeus', instanceId, 13933, 1);
    const telahair = createFakeClient('Telahair', instanceId, 63188, 4);
    setParty(zeus, telahair);
    attachPlayer(zeus);
    attachPlayer(telahair);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    GlobalState.sessionsByToken.set(telahair.token, telahair as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    EntityHandler.sendInitialLevelEntities(telahair as never, telahair.currentLevel);
    return { zeus, telahair, scope: getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId) };
}

function attachProxy(client: FakeClient, localId: number, name: string, x: number, y: number, roomId: number): void {
    EntityHandler.handleEntityFullUpdate(client as never, buildClientHostileFullUpdate(localId, name, x, y, roomId));
}

function assertSevenCanonicalHostiles(scope: string): void {
    const hostiles = getHostiles(scope);
    assert.equal(hostiles.length, 7, 'JC_Mini1Hard should seed exactly seven canonical hostiles');
    for (const hostile of hostiles) {
        assert.equal(hostile.clientSpawned, false, `${hostile.name} should be server canonical`);
        assert.equal(hostile.level, 50, `${hostile.name} should be level 50`);
        assert.ok(Number(hostile.maxHp ?? 0) > 100, `${hostile.name} should have level-50 maxHp`);
        assert.equal(hostile.hp, hostile.maxHp, `${hostile.name} should start at full canonical HP`);
    }
    const boss = GlobalState.levelEntities.get(scope)?.get(910005);
    assert.equal(Boolean(boss?.roomBoss), true, 'TowerGuard1Hard boss metadata should be preserved');
    assert.equal(Boolean(boss?.isRoomBoss), true, 'TowerGuard1Hard should be marked as room boss');
}

function testInitialCanonicalNoVisibleServerSnapshots(): void {
    const { zeus, telahair, scope } = setupTwoPlayers('jc-mini1-client-proxy-initial');
    assertSevenCanonicalHostiles(scope);
    assert.equal(zeus.sentPackets.some((packet) => packet.id === 0x0F), false, 'first player should not receive visible server hostile snapshots');
    assert.equal(telahair.sentPackets.some((packet) => packet.id === 0x0F), false, 'joiner should not receive visible server hostile snapshots');
}

async function testPartyJoinerAdoptsStarterScope(): Promise<void> {
    const zeus = createFakeClient('Zeus', 'jc-mini1-party-starter', 13933, 1);
    const telahair = createFakeClient('Telahair', 'jc-mini1-party-joiner', 63188, 4);
    setParty(zeus, telahair);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);

    const starterScope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);
    assertSevenCanonicalHostiles(starterScope);
    attachProxy(zeus, 500001, 'ImperialMagus', 12855, 4551, 1);
    const starterTarget = GlobalState.levelEntities.get(starterScope)?.get(910001);
    assert.ok(starterTarget, 'starter canonical enemy should exist before joiner adopts scope');
    await CombatHandler.handlePowerHit(zeus as never, buildPowerHitPayload(500001, zeus.clientEntID, Math.round(Number(starterTarget.hp ?? 0)) + 999));
    assert.equal(starterTarget.dead, true, 'starter should kill canonical enemy before joiner enters');

    const joinerOriginalScope = getLevelScopeKey(telahair.currentLevel, telahair.levelInstanceId);
    attachPlayer(telahair);
    GlobalState.sessionsByToken.set(telahair.token, telahair as never);
    EntityHandler.sendInitialLevelEntities(telahair as never, telahair.currentLevel);

    assert.equal(telahair.levelInstanceId, zeus.levelInstanceId, 'party joiner should adopt starter JC_Mini1Hard instance id');
    assert.equal(getLevelScopeKey(telahair.currentLevel, telahair.levelInstanceId), starterScope, 'party joiner should share starter canonical scope');
    assert.equal(GlobalState.levelEntities.get(starterScope)?.has(telahair.clientEntID), true, 'joiner player entity should migrate into shared scope');
    assert.equal(GlobalState.levelEntities.get(joinerOriginalScope)?.has(telahair.clientEntID) ?? false, false, 'joiner player entity should leave its stale private scope');
    assert.equal(getHostiles(joinerOriginalScope).length, 0, 'joiner stale private scope should not seed a duplicate hostile set');

    telahair.sentPackets.length = 0;
    attachProxy(telahair, 600001, 'ImperialMagus', 12855, 4551, 99);
    assert.equal(EntityHandler.resolveEntityAlias(telahair as never, 600001), 910001, 'late joiner proxy should map to starter canonical id');
    assertLocalDeadPacket(telahair, 600001, 'late joiner should receive DEAD for enemy killed before entry');
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === 600001),
        true,
        'late joiner dead proxy should be destroyed instead of respawning alive'
    );

    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    attachProxy(zeus, 500002, 'PortalFiend2', 12830, 3732, 1);
    attachProxy(telahair, 600002, 'PortalFiend2', 12830, 3732, 99);
    const joinerTarget = GlobalState.levelEntities.get(starterScope)?.get(910002);
    assert.ok(joinerTarget, 'shared canonical target should exist after joiner adopts scope');
    await CombatHandler.handlePowerHit(telahair as never, buildPowerHitPayload(600002, telahair.clientEntID, Math.round(Number(joinerTarget.hp ?? 0)) + 999));
    assert.equal(joinerTarget.dead, true, 'joiner hit should kill shared canonical target');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 500002 && parseHpDelta(packet.payload).delta < 0),
        true,
        'starter should receive HP zero correction when joiner kills in adopted scope'
    );
    assertLocalDeadPacket(zeus, 500002, 'starter should receive DEAD when joiner kills in adopted scope');
}

function testNonPartyJcMini1PlayerKeepsSeparateScope(): void {
    const zeus = createFakeClient('Zeus', 'jc-mini1-party-owner', 13933, 1);
    const stranger = createFakeClient('Stranger', 'jc-mini1-solo-stranger', 77777, 1);
    setParty(zeus);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const partyScope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    attachPlayer(stranger);
    GlobalState.sessionsByToken.set(stranger.token, stranger as never);
    EntityHandler.sendInitialLevelEntities(stranger as never, stranger.currentLevel);
    const strangerScope = getLevelScopeKey(stranger.currentLevel, stranger.levelInstanceId);

    assert.notEqual(strangerScope, partyScope, 'non-party player should not adopt existing party JC_Mini1Hard scope');
    assertSevenCanonicalHostiles(partyScope);
    assertSevenCanonicalHostiles(strangerScope);
}

async function testProxyAttachHitDeathAndDestroy(): Promise<void> {
    const { zeus, telahair, scope } = setupTwoPlayers('jc-mini1-client-proxy-hit');
    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;

    attachProxy(zeus, 500001, 'ImperialMagus', 12855, 4551, 1);
    attachProxy(telahair, 600001, 'ImperialMagus', 12855, 4551, 99);
    assert.equal(EntityHandler.resolveEntityAlias(zeus as never, 500001), 910001, 'starter local proxy should map to canonical ImperialMagus');
    assert.equal(EntityHandler.resolveEntityAlias(telahair as never, 600001), 910001, 'joiner local proxy should map to same canonical ImperialMagus');
    assert.equal(GlobalState.levelEntities.get(scope)?.has(500001), false, 'local proxy must not enter canonical level map');
    assert.equal(zeus.sentPackets.some((packet) => packet.id === 0x0D), false, 'seed proxy attach should not destroy local actor');
    assert.equal(zeus.entities.get(500001)?.level, 50, 'starter proxy cache should be forced to level 50');
    assert.equal(telahair.entities.get(600001)?.level, 50, 'joiner proxy cache should be forced to level 50');
    const attachCanonical = GlobalState.levelEntities.get(scope)?.get(910001);
    assert.ok(attachCanonical, 'canonical target should exist after proxy attach');
    assert.equal(zeus.entities.get(500001)?.maxHp, attachCanonical.maxHp, 'starter proxy cache maxHp should match canonical level-50 maxHp');
    assert.equal(telahair.entities.get(600001)?.maxHp, attachCanonical.maxHp, 'joiner proxy cache maxHp should match canonical level-50 maxHp');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 500001 && parseHpDelta(packet.payload).delta > 0),
        true,
        'starter proxy attach should receive initial level-50 HP sync'
    );
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 600001 && parseHpDelta(packet.payload).delta > 0),
        true,
        'joiner proxy attach should receive initial level-50 HP sync'
    );

    telahair.entities.set(600001, { ...telahair.entities.get(600001), hp: 1, dead: false, entState: EntityState.ACTIVE });
    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;

    await CombatHandler.handlePowerHit(zeus as never, buildPowerHitPayload(500001, zeus.clientEntID, 1000));
    const canonicalAfterHit = GlobalState.levelEntities.get(scope)?.get(910001);
    assert.ok(canonicalAfterHit, 'canonical target should still exist after non-lethal hit');
    assert.equal(zeus.sentPackets.some((packet) => packet.id === 0x0A), false, 'attacker should not receive echoed hit packet for its own local hit');
    assert.equal(telahair.sentPackets.some((packet) => packet.id === 0x0A), false, 'viewer should not receive echoed hit packet because its client simulates the remote player hit');
    assert.equal(telahair.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 600001 && parseHpDelta(packet.payload).delta > 0), true, 'overpredicted stale viewer HP should receive local-id correction');
    assert.equal(telahair.entities.get(600001)?.hp, canonicalAfterHit.hp, 'viewer proxy cache should converge after hit');

    const hpBeforeDuplicate = Math.round(Number(canonicalAfterHit.hp ?? 0));
    CombatHandler.handleCharRegen(zeus as never, buildHpDeltaPayload(500001, -1000));
    assert.equal(GlobalState.levelEntities.get(scope)?.get(910001)?.hp, hpBeforeDuplicate, 'same-tick local HP report should not double-apply hit damage');

    const remainingHp = Math.round(Number(canonicalAfterHit.hp ?? 0));
    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    await CombatHandler.handlePowerHit(zeus as never, buildPowerHitPayload(500001, zeus.clientEntID, remainingHp + 999));
    assert.equal(zeus.sentPackets.some((packet) => packet.id === 0x0A), false, 'attacker should not receive echoed lethal hit packet');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entState === EntityState.DEAD),
        true,
        'attacker should still receive canonical DEAD state'
    );
    assert.equal(telahair.sentPackets.some((packet) => packet.id === 0x0A), false, 'viewer should not receive echoed lethal hit packet');
    const deathIndex = telahair.sentPackets.findIndex((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entState === EntityState.DEAD);
    assert.ok(deathIndex >= 0, 'viewer should receive DEAD after lethal canonical hit');
    assert.equal(parseEntityState(telahair.sentPackets[deathIndex].payload).entityId, 600001, 'death state should use viewer local proxy id');
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === 600001),
        true,
        'viewer proxy should be destroyed locally after death relay'
    );
    assert.equal(telahair.entities.has(600001), false, 'viewer proxy cache should not stay alive after death relay');

    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    CombatHandler.handleCharRegen(telahair as never, buildHpDeltaPayload(600001, -123));
    const sourceDeadConverge = telahair.sentPackets.find((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 600001);
    const viewerDeadConverge = zeus.sentPackets.find((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 500001);
    assert.equal(parseEntityState(sourceDeadConverge!.payload).entState, EntityState.DEAD, 'post-death duplicate HP report should reconverge source local proxy to DEAD');
    assert.equal(parseEntityState(viewerDeadConverge!.payload).entState, EntityState.DEAD, 'post-death duplicate HP report should reconverge party viewer local proxy to DEAD');

    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    await CombatHandler.handleEntityDestroy(zeus as never, buildDestroyEntityPayload(500001));
    assert.equal(GlobalState.levelEntities.get(scope)?.has(910001), true, 'post-death proxy destroy should not re-finalize or remove canonical dead enemy');
    const sourceDestroy = zeus.sentPackets.find((packet) => packet.id === 0x0D);
    const viewerDestroy = telahair.sentPackets.find((packet) => packet.id === 0x0D);
    assert.equal(parseDestroy(sourceDestroy!.payload).entityId, 500001, 'post-death destroy should correct the source proxy local id');
    assert.equal(Boolean(viewerDestroy), false, 'post-death destroy should not rebroadcast to party viewer');
}

async function testReversePowerHitLethalConvergesStarter(): Promise<void> {
    const { zeus, telahair, scope } = setupTwoPlayers('jc-mini1-client-proxy-hit-reverse');
    attachProxy(zeus, 500002, 'PortalFiend2', 12830, 3732, 1);
    attachProxy(telahair, 600002, 'PortalFiend2', 12830, 3732, 1);
    const canonical = GlobalState.levelEntities.get(scope)?.get(910002);
    assert.ok(canonical, 'PortalFiend2 canonical should exist for reverse power-hit test');

    zeus.entities.set(500002, { ...zeus.entities.get(500002), hp: Math.round(Number(canonical.hp ?? 0)), dead: false, entState: EntityState.ACTIVE });
    telahair.entities.set(600002, { ...telahair.entities.get(600002), hp: Math.round(Number(canonical.hp ?? 0)), dead: false, entState: EntityState.ACTIVE });
    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;

    await CombatHandler.handlePowerHit(telahair as never, buildPowerHitPayload(600002, telahair.clientEntID, 1000));
    const canonicalAfterHit = GlobalState.levelEntities.get(scope)?.get(910002);
    assert.ok(canonicalAfterHit, 'canonical target should survive reverse non-lethal power hit');
    assert.equal(telahair.sentPackets.some((packet) => packet.id === 0x0A), false, 'reverse attacker should not receive echoed non-lethal hit');
    assert.equal(zeus.sentPackets.some((packet) => packet.id === 0x0A), false, 'starter viewer should not receive echoed non-lethal hit');
    assert.equal(zeus.entities.get(500002)?.hp, canonicalAfterHit.hp, 'starter cache should converge after joiner non-lethal power hit');

    const remainingHp = Math.round(Number(canonicalAfterHit.hp ?? 0));
    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    await CombatHandler.handlePowerHit(telahair as never, buildPowerHitPayload(600002, telahair.clientEntID, remainingHp + 999));

    assert.equal(canonicalAfterHit.hp, 0, 'reverse lethal power hit should set canonical HP to zero');
    assert.equal(canonicalAfterHit.dead, true, 'reverse lethal power hit should kill canonical enemy');
    assert.equal(telahair.sentPackets.some((packet) => packet.id === 0x0A), false, 'reverse attacker should not receive echoed lethal hit');
    assert.equal(zeus.sentPackets.some((packet) => packet.id === 0x0A), false, 'starter viewer should not receive echoed lethal hit');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 500002 && parseHpDelta(packet.payload).delta < 0),
        true,
        'starter viewer should receive a local-id HP correction before DEAD when joiner lands lethal hit'
    );
    assertLocalDeadPacket(telahair, 600002, 'reverse lethal power hit should send DEAD to joiner local proxy');
    assertLocalDeadPacket(zeus, 500002, 'reverse lethal power hit should reconverge starter local proxy to DEAD');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === 500002),
        true,
        'starter proxy should be destroyed locally after reverse lethal power hit'
    );
    assert.equal(zeus.entities.has(500002), false, 'starter cache should not keep reverse lethal proxy alive');

    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    await CombatHandler.handleEntityDestroy(telahair as never, buildDestroyEntityPayload(600002));
    assert.equal(GlobalState.levelEntities.get(scope)?.has(910002), true, 'post-death destroy should not remove canonical dead enemy');
    const joinerDestroy = telahair.sentPackets.find((packet) => packet.id === 0x0D);
    const starterDestroy = zeus.sentPackets.find((packet) => packet.id === 0x0D);
    assert.equal(parseDestroy(joinerDestroy!.payload).entityId, 600002, 'post-death destroy should correct joiner source proxy');
    assert.equal(Boolean(starterDestroy), false, 'post-death destroy should not re-finalize starter viewer proxy');
}

async function testReverseBuffTickLethalConvergesStarter(): Promise<void> {
    const { zeus, telahair, scope } = setupTwoPlayers('jc-mini1-client-proxy-dot-reverse');
    attachProxy(zeus, 500006, 'DemonReaper', 16824, 4424, 4);
    attachProxy(telahair, 600006, 'DemonReaper', 16824, 4424, 4);
    const canonical = GlobalState.levelEntities.get(scope)?.get(910006);
    assert.ok(canonical, 'DemonReaper canonical should exist for reverse DoT test');

    zeus.entities.set(500006, { ...zeus.entities.get(500006), hp: Math.round(Number(canonical.hp ?? 0)), dead: false, entState: EntityState.ACTIVE });
    telahair.entities.set(600006, { ...telahair.entities.get(600006), hp: Math.round(Number(canonical.hp ?? 0)), dead: false, entState: EntityState.ACTIVE });
    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;

    await CombatHandler.handleBuffTickDot(telahair as never, buildBuffTickDotPayload(600006, telahair.clientEntID, Math.round(Number(canonical.hp ?? 0)) + 99));

    assert.equal(canonical.hp, 0, 'reverse lethal DoT tick should set canonical HP to zero');
    assert.equal(canonical.dead, true, 'reverse lethal DoT tick should kill canonical enemy');
    assert.equal(telahair.sentPackets.some((packet) => packet.id === 0x79), false, 'reverse DoT attacker should not receive echoed DoT tick');
    assert.equal(zeus.sentPackets.some((packet) => packet.id === 0x79), false, 'starter viewer should not receive echoed DoT tick');
    assertLocalDeadPacket(telahair, 600006, 'reverse lethal DoT tick should send DEAD to joiner local proxy');
    assertLocalDeadPacket(zeus, 500006, 'reverse lethal DoT tick should reconverge starter local proxy to DEAD');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === 500006),
        true,
        'starter proxy should be destroyed locally after reverse lethal DoT tick'
    );
    assert.equal(zeus.entities.has(500006), false, 'starter cache should not keep reverse lethal DoT proxy alive');
}

async function testPredictedDestroyLateDeadProxyAndSummonPassthrough(): Promise<void> {
    const { zeus, telahair, scope } = setupTwoPlayers('jc-mini1-client-proxy-edge');
    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;

    attachProxy(zeus, 500003, 'DemonReaper', 13343, 2256, 2);
    attachProxy(telahair, 600003, 'DemonReaper', 13343, 2256, 2);
    const liveTarget = GlobalState.levelEntities.get(scope)?.get(910003);
    assert.ok(liveTarget, 'DemonReaper canonical should exist');
    zeus.entities.set(500003, { ...zeus.entities.get(500003), hp: 0, dead: true, entState: EntityState.DEAD });
    zeus.sentPackets.length = 0;
    await CombatHandler.handleEntityDestroy(zeus as never, buildDestroyEntityPayload(500003));
    assert.equal(GlobalState.levelEntities.get(scope)?.has(910003), true, 'early local destroy must not remove live canonical enemy');
    assert.equal(zeus.entities.get(500003)?.dead, false, 'attacker proxy cache should be revived to canonical live state');
    assert.equal(zeus.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 500003), true, 'attacker should receive local-id active correction');

    const boss = GlobalState.levelEntities.get(scope)?.get(910005);
    assert.ok(boss, 'boss canonical should exist');
    attachProxy(zeus, 500005, 'TowerGuard1', 16661, 2586, 3);
    await CombatHandler.handlePowerHit(zeus as never, buildPowerHitPayload(500005, zeus.clientEntID, Math.round(Number(boss.hp ?? 1)) + 100));
    zeus.sentPackets.length = 0;
    CombatHandler.handleRespawnBroadcast(zeus as never, buildRespawnBroadcastPayload(500005, 1234));
    assert.equal(boss.dead, true, 'hostile respawn broadcast must not revive dead canonical boss');
    assert.equal(boss.hp, 0, 'hostile respawn broadcast must keep dead canonical boss HP at zero');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 500005 && parseEntityState(packet.payload).entState === EntityState.DEAD),
        true,
        'hostile respawn broadcast should return local DEAD correction'
    );
    const late = createFakeClient('LateJoiner', zeus.levelInstanceId, 77777, 3);
    setParty(zeus, telahair, late);
    attachPlayer(late);
    GlobalState.sessionsByToken.set(late.token, late as never);
    EntityHandler.sendInitialLevelEntities(late as never, late.currentLevel);
    late.sentPackets.length = 0;
    attachProxy(late, 700005, 'TowerGuard1', 16661, 2586, 3);
    assert.equal(late.entities.has(700005), false, 'late dead boss proxy should not stay alive locally');
    assert.equal(
        late.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 700005 && parseHpDelta(packet.payload).delta < 0),
        true,
        'late dead proxy should receive HP zero correction before local cleanup'
    );
    assert.equal(late.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entState === EntityState.DEAD), true, 'late dead proxy should receive DEAD state');
    assert.equal(late.sentPackets.some((packet) => packet.id === 0x0D), true, 'late dead proxy should be destroyed locally');

    const beforeFireBombPackets = zeus.sentPackets.length;
    attachProxy(zeus, 501000, 'FireBombHard', 17000, 2600, 3);
    assert.equal(zeus.entities.has(501000), true, 'seed-outside summon/proxy actor should stay client-spawned');
    assert.equal(GlobalState.levelEntities.get(scope)?.has(501000), true, 'seed-outside summon/proxy actor should use existing client-spawn mirror path');
    assert.equal(zeus.sentPackets.slice(beforeFireBombPackets).some((packet) => packet.id === 0x0D), false, 'seed-outside summon/proxy actor should not be locally destroyed');
    telahair.knownEntityIds.add(501000);
    telahair.knownEntityIds.add(zeus.clientEntID);
    telahair.sentPackets.length = 0;
    await CombatHandler.handlePowerHit(zeus as never, buildPowerHitPayload(501000, zeus.clientEntID, 6641));
    assert.equal(telahair.sentPackets.some((packet) => packet.id === 0x0A), false, 'seed-outside JC_Mini1Hard hostile hit should not be echoed to viewer and double displayed');
    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    await CombatHandler.handleEntityDestroy(zeus as never, buildDestroyEntityPayload(501000));
    assert.equal(GlobalState.levelEntities.get(scope)?.has(501000), false, 'seed-outside summon destroy should remove the mirrored client-spawn actor');
    assert.equal(zeus.sentPackets.some((packet) => packet.id === 0x0D), false, 'seed-outside summon destroy must not send local forced destroy to the source client');
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 501000),
        false,
        'seed-outside summon destroy must not send canonical DEAD to viewer without a registered local alias'
    );
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === 501000),
        false,
        'seed-outside summon destroy must not send canonical destroy to viewer without a registered local alias'
    );
    assert.equal(telahair.entities.has(501000), false, 'seed-outside party viewer cache should stay absent without local alias');

    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    LevelHandler.handleEntityIncrementalUpdate(telahair as never, buildIncrementalUpdatePayload(501000, 9, 0, EntityState.ACTIVE));
    assert.equal(telahair.sentPackets.some((packet) => packet.id === 0x07), false, 'seed-outside delayed active update after destroy should be ignored once local cache is gone');
    assert.equal(telahair.entities.has(501000), false, 'seed-outside delayed active update must not recreate local proxy');
    assert.equal(zeus.sentPackets.some((packet) => packet.id === 0x07), false, 'seed-outside delayed active update after destroy must not relay active state to party');
}

function assertLocalDeadPacket(client: FakeClient, localEntityId: number, message: string): void {
    const packet = client.sentPackets.find((candidate) => {
        if (candidate.id !== 0x07) {
            return false;
        }
        const state = parseEntityState(candidate.payload);
        return state.entityId === localEntityId && state.entState === EntityState.DEAD;
    });
    assert.ok(packet, message);
}

function testProxyHpReportLethalConvergesParty(): void {
    {
        const { zeus, telahair, scope } = setupTwoPlayers('jc-mini1-client-proxy-hp-kill-joiner');
        attachProxy(zeus, 500002, 'PortalFiend2', 12830, 3732, 1);
        attachProxy(telahair, 600002, 'PortalFiend2', 12830, 3732, 1);
        const canonical = GlobalState.levelEntities.get(scope)?.get(910002);
        assert.ok(canonical, 'PortalFiend2 canonical should exist');

        zeus.entities.set(500002, { ...zeus.entities.get(500002), hp: Math.round(Number(canonical.hp ?? 0)), dead: false, entState: EntityState.ACTIVE });
        telahair.entities.set(600002, { ...telahair.entities.get(600002), hp: Math.round(Number(canonical.hp ?? 0)), dead: false, entState: EntityState.ACTIVE });
        zeus.sentPackets.length = 0;
        telahair.sentPackets.length = 0;

        const hpBefore = Math.round(Number(canonical.hp ?? 0));
        CombatHandler.handleCharRegen(telahair as never, buildHpDeltaPayload(600002, -hpBefore - 1));
        assert.equal(canonical.hp, hpBefore, 'joiner HP report should not mutate canonical HP');
        assert.equal(canonical.dead, false, 'joiner HP report should not kill canonical enemy');
        assert.equal(telahair.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entState === EntityState.DEAD), false, 'joiner HP report should not receive local DEAD packet');
        assert.equal(zeus.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entState === EntityState.DEAD), false, 'joiner HP report should not reconverge starter proxy to DEAD');
    }

    {
        const { zeus, telahair, scope } = setupTwoPlayers('jc-mini1-client-proxy-hp-kill-starter');
        attachProxy(zeus, 500003, 'DemonReaper', 13343, 2256, 2);
        attachProxy(telahair, 600003, 'DemonReaper', 13343, 2256, 2);
        const canonical = GlobalState.levelEntities.get(scope)?.get(910003);
        assert.ok(canonical, 'DemonReaper canonical should exist');

        zeus.entities.set(500003, { ...zeus.entities.get(500003), hp: Math.round(Number(canonical.hp ?? 0)), dead: false, entState: EntityState.ACTIVE });
        telahair.entities.set(600003, { ...telahair.entities.get(600003), hp: Math.round(Number(canonical.hp ?? 0)), dead: false, entState: EntityState.ACTIVE });
        zeus.sentPackets.length = 0;
        telahair.sentPackets.length = 0;

        const hpBefore = Math.round(Number(canonical.hp ?? 0));
        CombatHandler.handleCharRegen(zeus as never, buildHpDeltaPayload(500003, -hpBefore - 1));
        assert.equal(canonical.hp, hpBefore, 'starter HP report should not mutate canonical HP');
        assert.equal(canonical.dead, false, 'starter HP report should not kill canonical enemy');
        assert.equal(zeus.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entState === EntityState.DEAD), false, 'starter HP report should not receive local DEAD packet');
        assert.equal(telahair.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entState === EntityState.DEAD), false, 'starter HP report should not reconverge joiner proxy to DEAD');
    }
}

function testProxyOwnerStateRelay(): void {
    const { zeus, telahair, scope } = setupTwoPlayers('jc-mini1-client-proxy-state');
    zeus.syncAnchorStartedAt = 1000;
    telahair.syncAnchorStartedAt = 2000;
    attachProxy(telahair, 600004, 'BoneGolem', 12723, 2471, 2);
    const canonical = GlobalState.levelEntities.get(scope)?.get(910004);
    assert.ok(canonical, 'BoneGolem canonical should exist');
    assert.equal(Math.round(Number(canonical.proxyOwnerToken ?? 0)), telahair.token, 'first proxy temporarily owns canonical state relay');
    attachProxy(zeus, 500004, 'BoneGolem', 12723, 2471, 2);
    assert.equal(Math.round(Number(canonical.proxyOwnerToken ?? 0)), zeus.token, 'preferred dungeon anchor should take over canonical state relay');

    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    const oldX = Math.round(Number(canonical.x ?? 0));
    LevelHandler.handleEntityIncrementalUpdate(zeus as never, buildIncrementalUpdatePayload(500004, 10, 0));
    assert.equal(Math.round(Number(canonical.x ?? 0)), oldX + 10, 'owner proxy movement should update canonical position');
    const relayedState = telahair.sentPackets.find((packet) => packet.id === 0x07);
    assert.ok(relayedState, 'owner proxy movement should relay to party viewer');
    assert.equal(parseEntityState(relayedState.payload).entityId, 600004, 'state relay should use viewer local proxy id');

    const afterOwnerX = Math.round(Number(canonical.x ?? 0));
    zeus.sentPackets.length = 0;
    LevelHandler.handleEntityIncrementalUpdate(telahair as never, buildIncrementalUpdatePayload(600004, 99, 0));
    assert.equal(Math.round(Number(canonical.x ?? 0)), afterOwnerX, 'follower proxy movement should not mutate canonical position');
    assert.equal(zeus.sentPackets.some((packet) => packet.id === 0x07), false, 'follower proxy movement should not relay over owner state');

    canonical.hp = 0;
    canonical.dead = true;
    canonical.entState = EntityState.DEAD;
    zeus.entities.set(500004, { ...zeus.entities.get(500004), hp: 1, dead: false, entState: EntityState.ACTIVE });
    telahair.entities.set(600004, { ...telahair.entities.get(600004), hp: 0, dead: true, entState: EntityState.DEAD });
    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    const deadX = Math.round(Number(canonical.x ?? 0));
    LevelHandler.handleEntityIncrementalUpdate(zeus as never, buildIncrementalUpdatePayload(500004, 44, 0, EntityState.ACTIVE));
    assert.equal(Math.round(Number(canonical.x ?? 0)), deadX, 'dead canonical proxy movement should not mutate canonical position');
    assert.equal(canonical.dead, true, 'dead canonical proxy must stay dead after owner active update');
    assert.equal(canonical.entState, EntityState.DEAD, 'dead canonical proxy must keep DEAD entState');
    const ownerDeadCorrection = zeus.sentPackets.find((packet) => packet.id === 0x07);
    assert.ok(ownerDeadCorrection, 'dead owner proxy active update should receive local DEAD correction');
    assert.equal(parseEntityState(ownerDeadCorrection.payload).entityId, 500004, 'owner dead correction should use owner local proxy id');
    assert.equal(parseEntityState(ownerDeadCorrection.payload).entState, EntityState.DEAD, 'owner dead correction should keep DEAD state');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 500004 && parseHpDelta(packet.payload).delta < 0),
        true,
        'dead owner proxy active update should force local HP to canonical zero before DEAD'
    );
    const ownerPartyDeadCorrection = telahair.sentPackets.find((packet) => packet.id === 0x07);
    assert.ok(ownerPartyDeadCorrection, 'dead owner proxy active update should reconverge party viewer to DEAD');
    assert.equal(parseEntityState(ownerPartyDeadCorrection.payload).entityId, 600004, 'party dead correction should use viewer local proxy id');
    assert.equal(parseEntityState(ownerPartyDeadCorrection.payload).entState, EntityState.DEAD, 'party dead correction should keep DEAD state');

    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    zeus.entities.set(500004, { ...zeus.entities.get(500004), hp: 1, dead: false, entState: EntityState.ACTIVE });
    LevelHandler.handleEntityIncrementalUpdate(telahair as never, buildIncrementalUpdatePayload(600004, 55, 0, EntityState.ACTIVE));
    assert.equal(Math.round(Number(canonical.x ?? 0)), deadX, 'dead follower proxy movement should not mutate canonical position');
    const followerDeadCorrection = telahair.sentPackets.find((packet) => packet.id === 0x07);
    assert.ok(followerDeadCorrection, 'dead follower proxy active update should receive local DEAD correction');
    assert.equal(parseEntityState(followerDeadCorrection.payload).entityId, 600004, 'follower dead correction should use follower local proxy id');
    assert.equal(parseEntityState(followerDeadCorrection.payload).entState, EntityState.DEAD, 'follower dead correction should keep DEAD state');
    const followerPartyDeadCorrection = zeus.sentPackets.find((packet) => packet.id === 0x07);
    assert.ok(followerPartyDeadCorrection, 'dead follower proxy active update should reconverge party viewer to DEAD');
    assert.equal(parseEntityState(followerPartyDeadCorrection.payload).entityId, 500004, 'follower party dead correction should use viewer local proxy id');
    assert.equal(parseEntityState(followerPartyDeadCorrection.payload).entState, EntityState.DEAD, 'follower party dead correction should keep DEAD state');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 500004 && parseHpDelta(packet.payload).delta < 0),
        true,
        'dead follower proxy active update should force party viewer HP to canonical zero before DEAD'
    );
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
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        testInitialCanonicalNoVisibleServerSnapshots();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testPartyJoinerAdoptsStarterScope();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        testNonPartyJcMini1PlayerKeepsSeparateScope();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testProxyAttachHitDeathAndDestroy();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testReversePowerHitLethalConvergesStarter();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testReverseBuffTickLethalConvergesStarter();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testPredictedDestroyLateDeadProxyAndSummonPassthrough();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        testProxyHpReportLethalConvergesParty();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        testProxyOwnerStateRelay();

        console.log('jc_mini1_server_authority_regression: ok');
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
    console.error('jc_mini1_server_authority_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
