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
import { MissionHandler } from '../handlers/MissionHandler';
import { RewardHandler } from '../handlers/RewardHandler';
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
    character: { name: string; level: number; gold?: number; class?: string; MasterClass?: number; CurrentLevel?: { name: string; x: number; y: number } };
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
    if (NpcLoader.getRawNpcsForLevel('AC_Mission1').length === 0) {
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
            gold: 0,
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

function buildBuffStatePayload(entityId: number, buffId: number = 17): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod4(buffId);
    return bb.toBuffer();
}

function buildPickupLootdropPayload(lootdropId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(lootdropId);
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

function parseRoomUnlock(payload: Buffer): number {
    const br = new BitReader(payload);
    return br.readMethod9();
}

function parseSpawnEntityId(payload: Buffer): number {
    const br = new BitReader(payload);
    return br.readMethod4();
}

function parseBuffTargetId(payload: Buffer): number {
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
    assert.equal(rogue.entities.has(4712451), true, 'first viewer should keep its local authored dragon in its cache');
    assert.equal(rogue.entities.get(4712451)?.clientSpawned, true, 'first viewer should keep the authored local dragon logic alive');
    assert.equal(rogue.entities.get(4712451)?.canonicalEntityId, 4712451, 'first viewer local dragon should bridge to the canonical id');
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntity(packet.payload) === 4712451),
        false,
        'first viewer should not receive a destroy for its authored local dragon'
    );
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0x0F && parseSpawnEntityId(packet.payload) === 4712451),
        false,
        'first viewer should not receive a replacement server canonical dragon spawn'
    );

    attachProxy(mage, 10859330, 'AncientDragonGoldMini', 3010, 1200, 2);
    assert.equal(EntityHandler.resolveEntityAlias(mage as never, 10859330), 4712451, 'second client dragon id should alias to first canonical dragon');
    assert.equal(GlobalState.levelEntities.get(scope)?.has(10859330), false, 'second client dragon must not create a second server enemy');
    assert.equal(mage.entities.has(10859330), true, 'second client local authored dragon should stay alive for client logic');
    assert.equal(mage.knownEntityIds.has(10859330), true, 'second client should keep the authored local dragon id as known');
    assert.equal(mage.entities.get(10859330)?.clientSpawned, true, 'second client should keep the authored local dragon as client-spawned');
    assert.equal(mage.entities.get(10859330)?.canonicalEntityId, 4712451, 'second client local dragon should bridge to the canonical server dragon');
    assert.equal(mage.entities.has(4712451), false, 'second client should not render a separate canonical server dragon');
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntity(packet.payload) === 10859330),
        false,
        'second client should not receive a destroy for its authored local dragon'
    );
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0F && parseSpawnEntityId(packet.payload) === 4712451),
        false,
        'second client should not receive a replacement canonical server dragon spawn'
    );

    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    await CombatHandler.handlePowerHit(rogue as never, buildPowerHitPayload(4712451, rogue.clientEntID, 16282));
    assert.equal(canonical.hp, canonical.maxHp - 16282, 'non-lethal hit should reduce only the canonical dragon HP');
    assert.equal(mage.entities.get(10859330)?.hp, canonical.hp, 'mage local bridged dragon should converge to server HP');
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 10859330 && parseHpDelta(packet.payload).delta < 0),
        true,
        'mage should receive HP correction on its local bridged dragon id when server HP changes'
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
        false,
        'mage should not receive DEAD state on an unrendered canonical server dragon id'
    );
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 10859330 && parseEntityState(packet.payload).entState === EntityState.DEAD),
        true,
        'mage should receive DEAD state on its local bridged dragon id'
    );
}

async function testAcMission1BuffStateBridgesThroughCanonicalEnemy(): Promise<void> {
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
    assert.ok(canonical, 'canonical dragon should exist before buff bridge');

    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    await CombatHandler.handleAddBuff(mage as never, buildBuffStatePayload(10859330, 17));

    assert.equal(Object.keys(canonical.activeBuffs ?? {}).length, 1, 'server canonical dragon should record active buff state');
    assert.equal(mage.entities.get(10859330)?.buffStateVersion, canonical.buffStateVersion, 'mage local bridged dragon should mirror canonical buff version');
    assert.equal(rogue.entities.get(4712451)?.buffStateVersion, canonical.buffStateVersion, 'rogue local bridged dragon should mirror canonical buff version');
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0x0B && parseBuffTargetId(packet.payload) === 4712451),
        true,
        'rogue should receive add-buff packet on its local bridged dragon id'
    );

    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    await CombatHandler.handleRemoveBuff(mage as never, buildBuffStatePayload(10859330, 17));

    assert.equal(Object.keys(canonical.activeBuffs ?? {}).length, 0, 'server canonical dragon should remove active buff state');
    assert.equal(mage.entities.get(10859330)?.buffStateVersion, canonical.buffStateVersion, 'mage local bridged dragon should mirror canonical buff removal');
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0x0C && parseBuffTargetId(packet.payload) === 4712451),
        true,
        'rogue should receive remove-buff packet on its local bridged dragon id'
    );
}

function testAcMission1JoinerLocalSpawnBridgesAfterInitialCanonical(): void {
    const rogue = createFakeClient('AlexMercer', 59395, 2);
    const mage = createFakeClient('Neodevils', 45890, 2);
    setParty(rogue, mage);
    attachPlayer(rogue);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachProxy(rogue, 4712451, 'AncientDragonGoldMini', 3000, 1200, 2);
    assert.ok(GlobalState.levelEntities.get(scope)?.get(4712451), 'canonical dragon should exist before joiner initial sync');

    GlobalState.sessionsByToken.set(mage.token, mage as never);
    mage.sentPackets.length = 0;
    EntityHandler.sendInitialLevelEntities(mage as never, mage.currentLevel);
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0F && parseSpawnEntityId(packet.payload) === 4712451),
        false,
        'joiner initial sync should wait for the joiner authored dragon instead of spawning a canonical visual'
    );

    mage.sentPackets.length = 0;
    attachProxy(mage, 10859330, 'AncientDragonGoldMini', 3010, 1200, 2);

    assert.equal(mage.entities.has(10859330), true, 'joiner authored local dragon should stay in cache');
    assert.equal(mage.entities.get(10859330)?.clientSpawned, true, 'joiner should keep the authored local dragon for client logic');
    assert.equal(mage.entities.get(10859330)?.canonicalEntityId, 4712451, 'joiner authored local dragon should bridge to the existing canonical dragon');
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntity(packet.payload) === 10859330),
        false,
        'joiner local authored dragon should not be destroyed when it appears after canonical sync'
    );
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0F && parseSpawnEntityId(packet.payload) === 4712451),
        false,
        'joiner should not receive a canonical visual spawn after the local authored enemy is bridged'
    );
}

function testAcMission1JoinerFirstSightPromotesBridgeWithoutDuplicate(): void {
    const rogue = createFakeClient('AlexMercer', 59395, 2);
    const mage = createFakeClient('Neodevils', 45890, 2);
    setParty(rogue, mage);
    attachPlayer(rogue);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    const levelMap = GlobalState.levelEntities.get(scope);
    assert.ok(levelMap, 'test scope should have a level map');

    attachProxy(mage, 10859330, 'AncientDragonGoldMini', 3010, 1200, 2);
    const joinerCanonical = levelMap.get(10859330);
    assert.ok(joinerCanonical, 'joiner first sight should promote a canonical server enemy when none exists yet');
    assert.equal(joinerCanonical.clientSpawned, false, 'joiner-promoted canonical should still be server-owned');
    assert.equal(
        mage.entities.has(10859330),
        true,
        'joiner authored first-sight dragon should stay alive locally'
    );
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntity(packet.payload) === 10859330),
        false,
        'joiner authored first-sight dragon should not receive a local destroy'
    );
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0F),
        false,
        'joiner first sight should not spawn a separate canonical visual'
    );

    mage.sentPackets.length = 0;
    attachProxy(rogue, 4712451, 'AncientDragonGoldMini', 3000, 1200, 2);
    assert.equal(EntityHandler.resolveEntityAlias(rogue as never, 4712451), 10859330, 'owner local dragon should alias to the joiner-promoted canonical dragon');
    assert.equal(levelMap.has(4712451), false, 'owner first sight should not promote a duplicate canonical dragon');
    assert.equal(rogue.entities.get(4712451)?.clientSpawned, true, 'owner should keep its authored local dragon logic alive');
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0F),
        false,
        'owner attach should not fan out a replacement canonical visual to the joiner'
    );
    assert.equal(mage.entities.get(10859330)?.clientSpawned, true, 'waiting joiner should still render its local bridged dragon');
}

function testAcMission1FarSameNameHostilesPromoteSeparately(): void {
    const rogue = createFakeClient('AlexMercer', 59395, 2);
    attachPlayer(rogue);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachProxy(rogue, 700001, 'CastleLizard1', 1000, 1200, 2);
    attachProxy(rogue, 700002, 'CastleLizard1', 2200, 1200, 2);

    const levelMap = GlobalState.levelEntities.get(scope);
    assert.ok(levelMap?.get(700001), 'first same-name hostile should promote into a canonical enemy');
    assert.ok(levelMap?.get(700002), 'far same-name hostile should promote into a separate canonical enemy');
    assert.equal(
        EntityHandler.resolveEntityAlias(rogue as never, 700002),
        700002,
        'far same-name hostile should not alias to the first canonical enemy'
    );
}

function testAcMission1ServerOwnedDragonKillDoesNotForceDungeonCompletion(): void {
    const rogue = createFakeClient('AlexMercer', 59395, 2);
    attachPlayer(rogue);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachProxy(rogue, 4712451, 'AncientDragonGoldMini', 3000, 1200, 2);
    const canonical = GlobalState.levelEntities.get(scope)?.get(4712451);
    assert.ok(canonical, 'canonical dragon should exist before boss defeat check');

    canonical.hp = 0;
    canonical.dead = true;
    canonical.entState = EntityState.DEAD;

    assert.equal(
        MissionHandler.shouldProcessEnemyKillStateDungeonCompletion(rogue as never, canonical),
        false,
        'server-owned AC_Mission1 dragon kill should not wait for a client-authored kill-state packet'
    );
    assert.equal(
        (MissionHandler as any).shouldForceCompleteDungeonOnEnemyDefeat(scope, canonical),
        false,
        'server-owned AC_Mission1 dragon at zero HP should not force dungeon completion'
    );
}

async function testAcMission1GoldDragonDeathRewardsUnlocksWithoutCompleting(): Promise<void> {
    const rogue = createFakeClient('AlexMercer', 59395, 2);
    attachPlayer(rogue);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachProxy(rogue, 3812092, 'AncientDragonGold', 3000, 1200, 2);
    attachProxy(rogue, 4664060, 'AncientDragonGoldMini', 3050, 1200, 2);
    const levelMap = GlobalState.levelEntities.get(scope);
    const gold = levelMap?.get(3812092);
    const mini = levelMap?.get(4664060);
    assert.ok(gold, 'gold dragon should be promoted before lethal hit');
    assert.ok(mini, 'mini proxy copy should remain present before lethal hit');

    rogue.sentPackets.length = 0;
    await CombatHandler.handlePowerHit(
        rogue as never,
        buildPowerHitPayload(3812092, rogue.clientEntID, Math.round(Number(gold.maxHp ?? 0)) + 999)
    );

    assert.equal(gold.hp, 0, 'server-owned gold dragon should be killed by the lethal hit');
    assert.equal(gold.dead, true, 'server-owned gold dragon should be marked dead');
    assert.equal(mini.dead, false, 'the separate mini proxy copy should not need to die for AC_Mission1 dragon side effects');
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0x32),
        true,
        'server-owned AC_Mission1 dragon death should spawn lootdrop packets'
    );
    assert.equal(
        Array.from(rogue.pendingLoot.values()).some((loot) => Number(loot?.gold ?? 0) > 0),
        true,
        'server-owned AC_Mission1 dragon death should create a gold lootdrop'
    );
    assert.equal(
        Array.from(rogue.pendingLoot.values()).some((loot) => Number(loot?.health ?? 0) > 0),
        true,
        'server-owned AC_Mission1 dragon death should create a health lootdrop'
    );
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0xAD && parseRoomUnlock(packet.payload) === 2),
        true,
        'server-owned AC_Mission1 dragon death should unlock its room door'
    );
    assert.equal(
        String((rogue as any).pendingDungeonCompletionScope ?? ''),
        '',
        'server-owned AC_Mission1 dragon death should not schedule dungeon completion'
    );
    assert.equal(
        String((rogue as any).pendingDungeonCompletionForceSharedScope ?? ''),
        '',
        'server-owned AC_Mission1 dragon death should not force shared dungeon completion for the instance'
    );
}

async function testAcMission1CanonicalLootIsPersonalAndIdempotent(): Promise<void> {
    const rogue = createFakeClient('AlexMercer', 59395, 2);
    const mage = createFakeClient('Neodevils', 45890, 2);
    setParty(rogue, mage);
    attachPlayer(rogue);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachProxy(rogue, 3812092, 'AncientDragonGold', 3000, 1200, 2);
    const gold = GlobalState.levelEntities.get(scope)?.get(3812092);
    assert.ok(gold, 'gold dragon should be canonical before lethal hit');

    await CombatHandler.handlePowerHit(
        rogue as never,
        buildPowerHitPayload(3812092, rogue.clientEntID, Math.round(Number(gold.maxHp ?? 0)) + 999)
    );

    assert.equal(gold.lootDropped, true, 'canonical enemy should record that loot was dropped');
    assert.equal(typeof gold.lootDropNonce, 'string', 'canonical enemy should record a loot nonce');
    assert.equal(gold.lootGrantedTokens.has(rogue.token), true, 'killer should receive one personal loot grant');
    assert.equal(gold.lootGrantedTokens.has(mage.token), true, 'eligible party member should receive one personal loot grant');
    assert.equal(
        Array.from(rogue.pendingLoot.values()).some((loot) => Number(loot?.gold ?? 0) > 0),
        true,
        'killer should receive personal gold loot'
    );
    assert.equal(
        Array.from(mage.pendingLoot.values()).some((loot) => Number(loot?.gold ?? 0) > 0),
        true,
        'eligible party member should receive personal gold loot'
    );

    const rogueLootCount = rogue.pendingLoot.size;
    const mageLootCount = mage.pendingLoot.size;
    RewardHandler.grantServerEnemyRewardToEligibleViewers(rogue as never, gold, {
        levelScope: scope,
        lootDropNonce: gold.lootDropNonce,
        sourceEnemyCanonicalId: 3812092,
        caller: 'test_duplicate_canonical_reward'
    });
    assert.equal(rogue.pendingLoot.size, rogueLootCount, 'duplicate reward grant should not spawn extra killer loot');
    assert.equal(mage.pendingLoot.size, mageLootCount, 'duplicate reward grant should not spawn extra party loot');

    const goldEntry = Array.from(rogue.pendingLoot.entries()).find(([, loot]) => Number(loot?.gold ?? 0) > 0);
    assert.ok(goldEntry, 'killer should have a gold lootdrop to pick up');
    const [lootdropId, lootdrop] = goldEntry;
    const goldBeforePickup = Number(rogue.character.gold ?? 0);
    RewardHandler.handlePickupLootdrop(rogue as never, buildPickupLootdropPayload(lootdropId));
    const goldAfterPickup = Number(rogue.character.gold ?? 0);
    assert.ok(goldAfterPickup > goldBeforePickup, 'first pickup should grant gold');

    rogue.pendingLoot.set(lootdropId, lootdrop);
    RewardHandler.handlePickupLootdrop(rogue as never, buildPickupLootdropPayload(lootdropId));
    assert.equal(Number(rogue.character.gold ?? 0), goldAfterPickup, 'duplicate pickup should not grant gold twice');
}

function testAcMission1LegacyEnemyRewardPacketDoesNotSpawnLootBeforeCanonicalDeath(): void {
    const rogue = createFakeClient('AlexMercer', 59395, 2);
    const mage = createFakeClient('Neodevils', 45890, 2);
    setParty(rogue, mage);
    attachPlayer(rogue);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachProxy(rogue, 4669617, 'AncientDragonGoldMini', 3000, 1200, 2);
    attachProxy(mage, 4879, 'AncientDragonGoldMini', 3010, 1200, 2);
    const canonical = GlobalState.levelEntities.get(scope)?.get(4669617);
    assert.ok(canonical, 'canonical dragon should exist before legacy reward packet');
    assert.ok(Math.round(Number(canonical.hp ?? 0)) > 0, 'canonical dragon should still be alive');
    assert.equal(canonical.dead, false, 'canonical dragon should not be marked dead');

    mage.sentPackets.length = 0;
    RewardHandler.handleGrantReward(mage as never, buildGrantRewardPayload(4879, mage.clientEntID, 22635, 65547));

    assert.equal(mage.pendingLoot.size, 0, 'legacy local hostile reward packet must not create personal loot before canonical death');
    assert.equal(rogue.pendingLoot.size, 0, 'legacy local hostile reward packet must not create party loot before canonical death');
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x32),
        false,
        'legacy local hostile reward packet must not send a 0x32 lootdrop before canonical death'
    );
    assert.equal(canonical.dead, false, 'blocking legacy reward should not finalize the canonical dragon');
    assert.equal(Math.round(Number(canonical.hp ?? 0)) > 0, true, 'blocking legacy reward should leave canonical HP above zero');
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
    assert.ok(
        GlobalState.deadServerAuthorityHostilesByScope.get(scope)?.size,
        'canonical server hostile death should create a rejoin tombstone'
    );
    levelMap.delete(4712451);

    rejoin.sentPackets.length = 0;
    attachProxy(rejoin, 10999999, 'AncientDragonGoldMini', 3010, 1200, 2);

    assert.equal(
        Array.from(levelMap.values()).some((entity) => !entity.isPlayer && Number(entity.team ?? 0) === EntityTeam.ENEMY),
        false,
        'rejoined local dragon must not promote a new canonical server enemy after the authored dragon died'
    );
    assert.equal(
        rejoin.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 10999999 && parseHpDelta(packet.payload).delta < 0),
        true,
        'rejoined local dragon should receive authoritative zero HP on its local id'
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
        false,
        'reconnect initial entity sync should not send a canonical visual before the client local proxy respawns'
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
        mage.sentPackets.some((packet) => packet.id === 0xAE && parseUntargetable(packet.payload).entityId === 10859330 && parseUntargetable(packet.payload).untargetable),
        true,
        'party viewer should receive untargetable for its local bridged dragon id'
    );

    CombatHandler.handleCharRegen(mage as never, buildHpDeltaPayload(10859330, -50000));
    assert.equal(canonical.hp, hpBefore, 'HP report from a targetable-looking local proxy must not damage untargetable canonical dragon');
}

async function main(): Promise<void> {
    const levelEntities = new Map(GlobalState.levelEntities);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const partyByMember = new Map(GlobalState.partyByMember);
    const partyGroups = new Map(GlobalState.partyGroups);
    const deadServerAuthorityHostilesByScope = new Map(GlobalState.deadServerAuthorityHostilesByScope);
    const serverAuthorityDestroyedIdsByScope = new Map((EntityHandler as any).serverAuthorityDestroyedIdsByScope);
    const serverAuthorityDestroyedFingerprintsByScope = new Map((EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope);

    ensureDataLoaded();
    try {
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        await testAcMission1FirstSightAuthorityConvergesDragon();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        await testAcMission1BuffStateBridgesThroughCanonicalEnemy();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testAcMission1JoinerLocalSpawnBridgesAfterInitialCanonical();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testAcMission1JoinerFirstSightPromotesBridgeWithoutDuplicate();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testAcMission1FarSameNameHostilesPromoteSeparately();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testAcMission1ServerOwnedDragonKillDoesNotForceDungeonCompletion();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        await testAcMission1GoldDragonDeathRewardsUnlocksWithoutCompleting();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        await testAcMission1CanonicalLootIsPersonalAndIdempotent();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testAcMission1LegacyEnemyRewardPacketDoesNotSpawnLootBeforeCanonicalDeath();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testAcMission1DestroyedDragonDoesNotRespawnOnRejoin();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testAcMission1ReconnectDoesNotResetLiveCanonicalScope();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testAcMission1CutsceneLocksServerAuthorityHostiles();
        console.log('ac_mission1_server_authority_regression: ok');
    } finally {
        GlobalState.levelEntities = levelEntities;
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.partyByMember = partyByMember;
        GlobalState.partyGroups = partyGroups;
        GlobalState.deadServerAuthorityHostilesByScope = deadServerAuthorityHostilesByScope;
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope = serverAuthorityDestroyedIdsByScope;
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope = serverAuthorityDestroyedFingerprintsByScope;
    }
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
