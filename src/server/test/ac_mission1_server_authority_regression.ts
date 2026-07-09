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
import { LootDepthRewardHandler } from '../handlers/LootDepthRewardHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { getLevelScopeKey } from '../core/LevelScope';
import { getSharedDungeonProgressTotals, recomputeSharedDungeonProgress } from '../core/SharedDungeonProgress';

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
    worldEnteredAt: number;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    authoritativeMaxHp: number;
    authoritativeCurrentHp: number;
    processedRewardSources: Set<string>;
    pendingLoot: Map<number, any>;
    startedRoomEvents: Set<string>;
    triggeredLevelStates: Set<string>;
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
        worldEnteredAt: token,
        currentRoomId: roomId,
        playerSpawned: true,
        clientEntID: token,
        authoritativeMaxHp: 5000,
        authoritativeCurrentHp: 5000,
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        startedRoomEvents: new Set<string>(),
        triggeredLevelStates: new Set<string>(),
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

function getCanonicalHostile(scope: string, name: string, ordinal: number = 0): any | null {
    const matches = Array.from(GlobalState.levelEntities.get(scope)?.values() ?? [])
        .filter((entity) =>
            entity &&
            !entity.isPlayer &&
            !entity.clientSpawned &&
            Number(entity.team ?? 0) === EntityTeam.ENEMY &&
            String(entity.name ?? '') === name
        )
        .sort((a, b) => Number(a.id ?? 0) - Number(b.id ?? 0));
    return matches[ordinal] ?? null;
}

function getCanonicalHostileId(scope: string, name: string, ordinal: number = 0): number {
    return Math.max(0, Math.round(Number(getCanonicalHostile(scope, name, ordinal)?.id ?? 0)));
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

function parseLootdropPacket(payload: Buffer): { kind: string; lootdropId: number; x: number; y: number; amount: number; tier?: number } {
    const br = new BitReader(payload);
    const lootdropId = br.readMethod4();
    const x = br.readMethod45();
    const y = br.readMethod45();

    if (br.readMethod15()) {
        const amount = br.readMethod6(11);
        const tier = br.readMethod6(2);
        return { kind: 'gear', lootdropId, x, y, amount, tier };
    }
    if (br.readMethod15()) {
        return { kind: 'material', lootdropId, x, y, amount: br.readMethod4() };
    }
    if (br.readMethod15()) {
        return { kind: 'gold', lootdropId, x, y, amount: br.readMethod4() };
    }
    if (br.readMethod15()) {
        return { kind: 'health', lootdropId, x, y, amount: br.readMethod4() };
    }

    br.readMethod15();
    return { kind: 'dye', lootdropId, x, y, amount: br.readMethod4() };
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
    const canonicalId = getCanonicalHostileId(scope, 'AncientDragonGoldMini');
    assert.equal(
        Array.from(GlobalState.levelEntities.get(scope)?.values() ?? []).filter((entity) => !entity.isPlayer && Number(entity.team ?? 0) === EntityTeam.ENEMY && !entity.clientSpawned).length > 0,
        true,
        'AC_Mission1 should seed server-owned hostiles before client reports'
    );
    assert.ok(canonicalId > 0, 'AC_Mission1 seeded registry should include the mini dragon');

    attachProxy(rogue, 4712451, 'AncientDragonGoldMini', 3000, 1200, 2);
    const canonical = GlobalState.levelEntities.get(scope)?.get(canonicalId);
    assert.ok(canonical, 'seeded mini dragon canonical should remain in the server registry');
    assert.equal(GlobalState.levelEntities.get(scope)?.has(4712451), false, 'first raw client dragon id must not become canonical');
    assert.equal(canonical.clientSpawned, false, 'seeded mini dragon should be server canonical');
    assert.equal(canonical.hp, canonical.maxHp, 'seeded mini dragon should start at canonical full HP');
    assert.ok(Number(canonical.maxHp ?? 0) > 100000, 'seeded dragon should use server-side level-50 HP scaling');
    assert.equal(rogue.entities.has(canonicalId), true, 'first viewer should cache the server-owned canonical dragon');
    assert.equal(rogue.entities.get(canonicalId)?.clientSpawned, false, 'first viewer should not keep authored local dragon logic alive');
    assert.equal(rogue.entities.get(canonicalId)?.canonicalEntityId, undefined, 'first viewer canonical dragon should not be a bridged local proxy');
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntity(packet.payload) === 4712451),
        true,
        'first viewer should receive a destroy for its authored local dragon before the canonical spawn'
    );

    attachProxy(mage, 10859330, 'AncientDragonGoldMini', 3010, 1200, 2);
    assert.equal(EntityHandler.resolveEntityAlias(mage as never, 10859330), canonicalId, 'second client dragon id should alias to seeded canonical dragon');
    assert.equal(GlobalState.levelEntities.get(scope)?.has(10859330), false, 'second client dragon must not create a second server enemy');
    assert.equal(mage.entities.has(10859330), false, 'second client local authored dragon should be removed from client logic');
    assert.equal(mage.knownEntityIds.has(10859330), false, 'second client should not keep the authored local dragon id as known');
    assert.equal(mage.entities.has(canonicalId), true, 'second client should render the server-owned canonical dragon');
    assert.equal(mage.entities.get(canonicalId)?.clientSpawned, false, 'second client canonical dragon should be server-owned');
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntity(packet.payload) === 10859330),
        true,
        'second client should receive a destroy for its authored local dragon'
    );
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0F && parseSpawnEntityId(packet.payload) === canonicalId),
        true,
        'second client should receive a replacement canonical server dragon spawn'
    );

    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    await CombatHandler.handlePowerHit(rogue as never, buildPowerHitPayload(canonicalId, rogue.clientEntID, 16282));
    assert.equal(canonical.hp, canonical.maxHp - 16282, 'non-lethal hit should reduce only the canonical dragon HP');
    assert.equal(mage.entities.get(canonicalId)?.hp, canonical.hp, 'mage canonical dragon should converge to server HP');
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === canonicalId && parseHpDelta(packet.payload).delta < 0),
        true,
        'mage should receive HP correction on the canonical dragon id when server HP changes'
    );

    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    await CombatHandler.handlePowerHit(mage as never, buildPowerHitPayload(10859330, mage.clientEntID, Math.round(Number(canonical.hp ?? 0)) + 999));
    assert.equal(canonical.hp, 0, 'lethal mage hit should kill the same canonical dragon');
    assert.equal(canonical.dead, true, 'lethal mage hit should mark canonical dragon dead');
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === canonicalId && parseEntityState(packet.payload).entState === EntityState.DEAD),
        true,
        'rogue should receive canonical DEAD state on its local dragon id'
    );
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === canonicalId && parseEntityState(packet.payload).entState === EntityState.DEAD),
        true,
        'mage should receive DEAD state on the rendered canonical server dragon id'
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
    const canonical = getCanonicalHostile(scope, 'AncientDragonGoldMini');
    const canonicalId = Math.max(0, Math.round(Number(canonical?.id ?? 0)));
    assert.ok(canonical, 'canonical dragon should exist before buff bridge');

    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    await CombatHandler.handleAddBuff(mage as never, buildBuffStatePayload(10859330, 17));

    assert.equal(Object.keys(canonical.activeBuffs ?? {}).length, 1, 'server canonical dragon should record active buff state');
    assert.equal(mage.entities.get(canonicalId)?.buffStateVersion, canonical.buffStateVersion, 'mage canonical dragon should mirror canonical buff version');
    assert.equal(rogue.entities.get(canonicalId)?.buffStateVersion, canonical.buffStateVersion, 'rogue canonical dragon should mirror canonical buff version');
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0x0B && parseBuffTargetId(packet.payload) === canonicalId),
        true,
        'rogue should receive add-buff packet on its local bridged dragon id'
    );

    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    await CombatHandler.handleRemoveBuff(mage as never, buildBuffStatePayload(10859330, 17));

    assert.equal(Object.keys(canonical.activeBuffs ?? {}).length, 0, 'server canonical dragon should remove active buff state');
    assert.equal(mage.entities.get(canonicalId)?.buffStateVersion, canonical.buffStateVersion, 'mage canonical dragon should mirror canonical buff removal');
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0x0C && parseBuffTargetId(packet.payload) === canonicalId),
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
    const canonicalId = getCanonicalHostileId(scope, 'AncientDragonGoldMini');
    assert.ok(canonicalId > 0, 'canonical dragon should exist before joiner initial sync');

    GlobalState.sessionsByToken.set(mage.token, mage as never);
    mage.sentPackets.length = 0;
    EntityHandler.sendInitialLevelEntities(mage as never, mage.currentLevel);
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0F && parseSpawnEntityId(packet.payload) === canonicalId),
        true,
        'joiner initial sync should send the existing server canonical dragon before local room cues spawn'
    );
    assert.equal(mage.entities.has(canonicalId), true, 'joiner should cache the server canonical dragon during initial sync');
    assert.equal(mage.entities.get(canonicalId)?.clientSpawned, false, 'joiner initial dragon snapshot should be server-owned');

    mage.sentPackets.length = 0;
    attachProxy(mage, 10859330, 'AncientDragonGoldMini', 3010, 1200, 2);

    assert.equal(mage.entities.has(10859330), false, 'joiner authored local dragon should be removed from cache');
    assert.equal(mage.entities.has(canonicalId), true, 'joiner should keep the server-owned canonical dragon for client logic');
    assert.equal(mage.entities.get(canonicalId)?.clientSpawned, false, 'joiner canonical dragon should be server-owned');
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntity(packet.payload) === 10859330),
        true,
        'joiner local authored dragon should be destroyed when it appears after canonical sync'
    );
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0F && parseSpawnEntityId(packet.payload) === canonicalId),
        false,
        'joiner should not receive a duplicate canonical spawn after initial canonical sync'
    );
}

function testAcMission1SharedProgressCountsServerOwnedHostiles(): void {
    const rogue = createFakeClient('AlexMercer', 59395, 2);
    attachPlayer(rogue);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.levelQuestProgress.clear();

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachProxy(rogue, 4712451, 'AncientDragonGoldMini', 3000, 1200, 2);
    const canonical = getCanonicalHostile(scope, 'AncientDragonGoldMini');
    assert.ok(canonical, 'canonical dragon should exist before shared progress recompute');
    assert.equal(canonical.clientSpawned, false, 'progress regression should use the server-owned hostile');

    let state = recomputeSharedDungeonProgress(scope);
    let totals = getSharedDungeonProgressTotals(scope);
    assert.equal(totals.total > 0, true, 'shared progress should count server-owned AC_Mission1 hostiles');
    assert.equal(totals.defeated, 0, 'live server-owned hostile should not count defeated');
    assert.equal(state?.progress, 0, 'live server-owned hostile should keep shared progress at 0%');

    canonical.hp = 0;
    canonical.dead = true;
    canonical.entState = EntityState.DEAD;

    state = recomputeSharedDungeonProgress(scope);
    totals = getSharedDungeonProgressTotals(scope);
    assert.equal(totals.defeated, 1, 'defeated server-owned hostile should count as defeated');
    assert.equal(state?.progress, Math.round((1 / totals.total) * 100), 'progress should be based only on server registry enemies');
    GlobalState.levelQuestProgress.delete(scope);
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
    const joinerCanonical = getCanonicalHostile(scope, 'AncientDragonGoldMini');
    const joinerCanonicalId = Math.max(0, Math.round(Number(joinerCanonical?.id ?? 0)));
    assert.ok(joinerCanonical, 'joiner first sight should attach to a seeded canonical server enemy');
    assert.equal(levelMap.has(10859330), false, 'joiner first sight must not promote the raw client id');
    assert.equal(joinerCanonical.clientSpawned, false, 'joiner-attached canonical should be server-owned');
    assert.equal(
        mage.entities.has(joinerCanonicalId),
        true,
        'joiner first-sight canonical dragon should use the seeded canonical id'
    );
    assert.equal(mage.entities.get(joinerCanonicalId)?.clientSpawned, false, 'joiner first-sight dragon should be server-owned');
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntity(packet.payload) === 10859330),
        true,
        'joiner authored first-sight dragon should receive a local destroy before canonical spawn'
    );
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0F),
        true,
        'joiner first sight should spawn the server-owned canonical visual'
    );

    mage.sentPackets.length = 0;
    attachProxy(rogue, 4712451, 'AncientDragonGoldMini', 3000, 1200, 2);
    assert.equal(EntityHandler.resolveEntityAlias(rogue as never, 4712451), joinerCanonicalId, 'owner local dragon should alias to the seeded canonical dragon');
    assert.equal(levelMap.has(4712451), false, 'owner first sight should not promote a duplicate canonical dragon');
    assert.equal(rogue.entities.has(4712451), false, 'owner should not keep its authored local dragon logic alive');
    assert.equal(rogue.entities.has(joinerCanonicalId), true, 'owner should render the seeded canonical dragon');
    assert.equal(rogue.entities.get(joinerCanonicalId)?.clientSpawned, false, 'owner canonical dragon should be server-owned');
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0F),
        false,
        'owner attach should not fan out a replacement canonical visual to the joiner'
    );
    assert.equal(mage.entities.get(joinerCanonicalId)?.clientSpawned, false, 'waiting joiner should still render its server-owned canonical dragon');
}

function testAcMission1FarSameNameHostilesPromoteSeparately(): void {
    const rogue = createFakeClient('AlexMercer', 59395, 2);
    attachPlayer(rogue);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachProxy(rogue, 700001, 'CastleLizardHeavy2', 1000, 1200, 2);
    attachProxy(rogue, 700002, 'CastleLizardHeavy2', 2200, 1200, 2);

    const levelMap = GlobalState.levelEntities.get(scope);
    assert.equal(levelMap?.has(700001), false, 'first same-name raw hostile must not promote into a canonical enemy');
    assert.equal(levelMap?.has(700002), false, 'far same-name raw hostile must not promote into a canonical enemy');
    assert.notEqual(EntityHandler.resolveEntityAlias(rogue as never, 700001), 700001, 'first same-name raw hostile should alias to a seeded canonical');
    assert.notEqual(EntityHandler.resolveEntityAlias(rogue as never, 700002), 700002, 'second same-name raw hostile should alias to a seeded canonical');
    assert.notEqual(
        EntityHandler.resolveEntityAlias(rogue as never, 700001),
        EntityHandler.resolveEntityAlias(rogue as never, 700002),
        'distinct same-name raw hostiles should attach to distinct seeded canonical enemies'
    );
}

function testAcMission1ServerOwnedDragonKillDoesNotForceDungeonCompletion(): void {
    const rogue = createFakeClient('AlexMercer', 59395, 2);
    attachPlayer(rogue);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachProxy(rogue, 4712451, 'AncientDragonGoldMini', 3000, 1200, 2);
    const canonical = getCanonicalHostile(scope, 'AncientDragonGoldMini');
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
    const gold = getCanonicalHostile(scope, 'AncientDragonGold');
    const mini = getCanonicalHostile(scope, 'AncientDragonGoldMini');
    const goldId = Math.max(0, Math.round(Number(gold?.id ?? 0)));
    assert.ok(gold, 'gold dragon should be seeded before lethal hit');
    assert.ok(mini, 'mini dragon should remain present before lethal hit');

    rogue.sentPackets.length = 0;
    await CombatHandler.handlePowerHit(
        rogue as never,
        buildPowerHitPayload(goldId, rogue.clientEntID, Math.round(Number(gold.maxHp ?? 0)) + 999)
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
        rogue.sentPackets.some((packet) =>
            packet.id === 0xAD &&
            parseRoomUnlock(packet.payload) === Math.round(Number(gold.roomId ?? 0))
        ),
        true,
        'server-owned AC_Mission1 dragon death should unlock its server registry room door'
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
    const gold = getCanonicalHostile(scope, 'AncientDragonGold');
    const goldId = Math.max(0, Math.round(Number(gold?.id ?? 0)));
    assert.ok(gold, 'gold dragon should be canonical before lethal hit');

    await CombatHandler.handlePowerHit(
        rogue as never,
        buildPowerHitPayload(goldId, rogue.clientEntID, Math.round(Number(gold.maxHp ?? 0)) + 999)
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
        sourceEnemyCanonicalId: goldId,
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
    const canonical = getCanonicalHostile(scope, 'AncientDragonGoldMini');
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

function testLootDepthOrderingPreservesGearPickupFloorY(): void {
    const rogue = createFakeClient('AlexMercer', 59395, 2);
    rogue.currentLevel = 'TutorialDungeon';
    rogue.character.CurrentLevel = { name: 'TutorialDungeon', x: 3000, y: 1200 };
    attachPlayer(rogue);
    rogue.entities.set(7001, {
        id: 7001,
        name: 'GoblinBoss1',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        x: 3000,
        y: 1200,
        entState: EntityState.DEAD
    });

    const originalRandom = Math.random;
    Math.random = () => 0.5;
    try {
        LootDepthRewardHandler.handleGrantReward(rogue as never, buildGrantRewardPayload(7001, rogue.clientEntID, 4, 0));
    } finally {
        Math.random = originalRandom;
    }

    const lootdrops = rogue.sentPackets
        .filter((packet) => packet.id === 0x32)
        .map((packet) => parseLootdropPacket(packet.payload));
    const gearDrop = lootdrops.find((drop) => drop.kind === 'gear');

    assert.ok(gearDrop, 'deterministic GoblinBoss1 reward should create a gear lootdrop');
    assert.equal(
        gearDrop!.y,
        1200,
        'loot depth ordering must not move gear below its pickup floor Y'
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
    const canonical = getCanonicalHostile(scope, 'AncientDragonGoldMini');
    const canonicalId = Math.max(0, Math.round(Number(canonical?.id ?? 0)));
    assert.ok(canonical, 'canonical dragon should exist before destroy tombstone');
    canonical.hp = 0;
    canonical.dead = true;
    canonical.entState = EntityState.DEAD;
    (EntityHandler as any).noteServerAuthorityHostileDestroyed(scope, canonicalId, canonical);
    assert.ok(
        GlobalState.deadServerAuthorityHostilesByScope.get(scope)?.size,
        'canonical server hostile death should create a rejoin tombstone'
    );
    levelMap.delete(canonicalId);

    rejoin.sentPackets.length = 0;
    attachProxy(rejoin, 10999999, 'AncientDragonGoldMini', 3010, 1200, 2);

    assert.equal(
        levelMap.has(10999999),
        false,
        'rejoined local dragon must not promote a new canonical server enemy after the authored dragon died'
    );
    assert.equal(
        rejoin.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 10999999 && parseHpDelta(packet.payload).delta < 0),
        false,
        'rejoined local dragon should not receive a HP death correction that can replay death presentation'
    );
    assert.equal(
        rejoin.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 10999999 && parseEntityState(packet.payload).entState === EntityState.DEAD),
        false,
        'rejoined local dragon should not be forced into DEAD state after it was already dead before join'
    );
    assert.equal(
        rejoin.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntity(packet.payload) === 10999999),
        true,
        'rejoined local dragon should be destroyed locally instead of staying alive'
    );

    // A player who joins the party mid-run reports a different currentRoomId,
    // so their spawnKey differs from the tombstone's in the room component.
    // The dead enemy must still stay dead for the whole instance.
    const lateJoiner = createFakeClient('LateJoiner', 77777, 5);
    setParty(rogue, rejoin, lateJoiner);
    attachPlayer(lateJoiner);
    GlobalState.sessionsByToken.set(lateJoiner.token, lateJoiner as never);
    lateJoiner.sentPackets.length = 0;
    attachProxy(lateJoiner, 11999999, 'AncientDragonGoldMini', 3010, 1200, 5);

    assert.equal(
        levelMap.has(11999999),
        false,
        'mid-run party joiner in another room must not resurrect the dead dragon as a new canonical'
    );
    assert.equal(
        lateJoiner.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 11999999 && parseHpDelta(packet.payload).delta < 0),
        false,
        'mid-run party joiner should not receive HP death correction for a pre-dead dragon'
    );
    assert.equal(
        lateJoiner.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 11999999 && parseEntityState(packet.payload).entState === EntityState.DEAD),
        false,
        'mid-run party joiner should not see a DEAD state replay for the pre-dead dragon'
    );
    assert.equal(
        lateJoiner.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntity(packet.payload) === 11999999),
        true,
        'mid-run party joiner local dragon copy should be cleaned up instead of staying alive'
    );
    GlobalState.sessionsByToken.delete(lateJoiner.token);
}

async function testAcMission1LateDeadDragonSourcePacketsStayLocal(): Promise<void> {
    const rogue = createFakeClient('AlexMercer', 12704, 0);
    const mage = createFakeClient('Neodevils', 38895, 0);
    setParty(rogue, mage);
    attachPlayer(rogue);
    attachPlayer(mage);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachProxy(rogue, 10432928, 'AncientDragonGoldMini', -1475, -1875, 0);
    attachProxy(mage, 15374319, 'AncientDragonGoldMini', -1475, -1875, 0);
    const canonical = getCanonicalHostile(scope, 'AncientDragonGoldMini');
    const canonicalId = Math.max(0, Math.round(Number(canonical?.id ?? 0)));
    assert.ok(canonical, 'canonical dragon should exist before lethal hit');

    await CombatHandler.handlePowerHit(mage as never, buildPowerHitPayload(15374319, mage.clientEntID, Math.round(Number(canonical.hp ?? 0)) + 1));
    const deathFinalizedAt = Math.max(1, Math.round(Number(canonical.deathFinalizedAt ?? 0)));
    assert.equal(canonical.dead, true, 'canonical dragon should be dead before stale source packets arrive');

    const late = createFakeClient('LateJoiner', 77777, 5);
    late.worldEnteredAt = deathFinalizedAt + 1_000;
    setParty(rogue, mage, late);
    attachPlayer(late);
    GlobalState.sessionsByToken.set(late.token, late as never);
    attachProxy(late, 15374319, 'AncientDragonGoldMini', -1475, -1875, 5);
    assert.equal(
        EntityHandler.resolveEntityAlias(late as never, 15374319),
        canonicalId,
        'late local dragon source id should still alias to the dead canonical dragon'
    );

    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    late.sentPackets.length = 0;
    await new Promise((resolve) => setTimeout(resolve, 1_050));

    await CombatHandler.handlePowerCast(late as never, buildPowerCastPayload(15374319, 77));
    await CombatHandler.handlePowerHit(late as never, buildPowerHitPayload(rogue.clientEntID, 15374319, 5188));
    LevelHandler.handleEntityIncrementalUpdate(late as never, buildEntityStatePayload(15374319, EntityState.DEAD));

    assert.equal(rogue.sentPackets.some((packet) => packet.id === 0x09), false, 'dead late hostile source must not relay power-cast to owner');
    assert.equal(rogue.sentPackets.some((packet) => packet.id === 0x0A), false, 'dead late hostile source must not relay power-hit to owner');
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === canonicalId),
        false,
        'dead late hostile state packet must not replay owner death state or resweep'
    );
    assert.equal(
        late.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntity(packet.payload) === 15374319),
        true,
        'late stale hostile source should receive destroy-only cleanup'
    );
    assert.equal(
        late.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 15374319),
        false,
        'late stale hostile source cleanup must not replay HP death animation'
    );
    assert.equal(
        late.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 15374319),
        false,
        'late stale hostile source cleanup must not replay DEAD state animation'
    );
}

function testAcMission1ReconnectDoesNotResetLiveCanonicalScope(): void {
    const rogue = createFakeClient('AlexMercer', 59395, 2);
    attachPlayer(rogue);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    attachProxy(rogue, 4712451, 'AncientDragonGoldMini', 3000, 1200, 2);
    const levelMap = GlobalState.levelEntities.get(scope);
    const canonicalId = getCanonicalHostileId(scope, 'AncientDragonGoldMini');
    assert.ok(levelMap?.get(canonicalId), 'canonical dragon should exist before reconnect init');
    const liveLevelMap = levelMap as Map<number, any>;

    rogue.knownEntityIds.clear();
    rogue.entities.clear();
    rogue.sentPackets.length = 0;
    EntityHandler.sendInitialLevelEntities(rogue as never, rogue.currentLevel);

    assert.ok(
        liveLevelMap.get(canonicalId),
        'reconnect initial entity sync must not reset live canonical hostiles for the same dungeon instance'
    );
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0x0F && parseSpawnEntityId(packet.payload) === canonicalId),
        true,
        'reconnect initial entity sync should send the live canonical server hostile before local room cues respawn'
    );
    assert.equal(rogue.entities.get(canonicalId)?.clientSpawned, false, 'reconnect canonical hostile should remain server-owned');
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
    const canonical = getCanonicalHostile(scope, 'AncientDragonGoldMini');
    const canonicalId = Math.max(0, Math.round(Number(canonical?.id ?? 0)));
    assert.ok(canonical, 'canonical dragon should exist before cutscene lock');
    const hpBefore = Math.round(Number(canonical.hp ?? 0));

    rogue.sentPackets.length = 0;
    mage.sentPackets.length = 0;
    LevelHandler.handleRoomBossInfo(rogue as never, buildRoomBossInfoPayload(2, 4712451, 'AncientDragonGoldMini'));

    assert.equal(canonical.untargetable, true, 'canonical dragon should become untargetable during cutscene');
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0xAE && parseUntargetable(packet.payload).entityId === canonicalId && parseUntargetable(packet.payload).untargetable),
        true,
        'source should receive untargetable for its canonical/local dragon id'
    );
    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0xAE && parseUntargetable(packet.payload).entityId === canonicalId && parseUntargetable(packet.payload).untargetable),
        true,
        'party viewer should receive untargetable for its canonical server dragon id'
    );

    CombatHandler.handleCharRegen(mage as never, buildHpDeltaPayload(10859330, -50000));
    assert.equal(canonical.hp, hpBefore, 'HP report from a targetable-looking local proxy must not damage untargetable canonical dragon');
}

function testAcMission1LateJoinerSkipsMiniBossCutsceneAfterDeath(): void {
    (EntityHandler as any).serverAuthoritySeededScopes?.clear?.();
    (EntityHandler as any).serverAuthorityDestroyedIdsByScope?.clear?.();
    (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope?.clear?.();

    const rogue = createFakeClient('AlexMercer', 59395, 2);
    const mage = createFakeClient('Neodevils', 45890, 2);
    setParty(rogue, mage);
    attachPlayer(rogue);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);

    const scope = getLevelScopeKey(rogue.currentLevel, rogue.levelInstanceId);
    const levelMap = GlobalState.levelEntities.get(scope);
    assert.ok(levelMap, 'test scope should have a level map');

    attachProxy(rogue, 4712451, 'AncientDragonGoldMini', 3000, 1200, 2);
    const canonical = getCanonicalHostile(scope, 'AncientDragonGoldMini');
    const canonicalId = Math.max(0, Math.round(Number(canonical?.id ?? 0)));
    assert.ok(canonical, 'canonical dragon should exist before the late-join sync check');

    rogue.sentPackets.length = 0;
    (LevelHandler as any).maybeSyncDeepgardDragonMiniBossAlreadyDefeated(rogue);
    assert.equal(
        rogue.sentPackets.some((packet) => packet.id === 0x40),
        false,
        'alive mini-boss must not produce the already-defeated room state'
    );

    canonical.hp = 0;
    canonical.dead = true;
    canonical.entState = EntityState.DEAD;
    (EntityHandler as any).noteServerAuthorityHostileDestroyed(scope, canonicalId, canonical);
    levelMap.delete(canonicalId);

    attachPlayer(mage);
    GlobalState.sessionsByToken.set(mage.token, mage as never);
    mage.sentPackets.length = 0;

    // The mage's client reports its locally spawned copy of the dead dragon while the
    // level is still loading (before any movement packet). The tombstone suppression
    // must immediately push the already-defeated room trigger so the room script can
    // skip the cutscene before its first phase tick.
    attachProxy(mage, 10859330, 'AncientDragonGoldMini', 3010, 1200, 2);

    assert.equal(
        mage.sentPackets.some((packet) => packet.id === 0x0D),
        true,
        'late joiner local dragon copy should still be destroy-suppressed'
    );
    const roomStates = mage.sentPackets
        .filter((packet) => packet.id === 0x40)
        .map((packet) => new BitReader(packet.payload).readMethod26());
    assert.deepEqual(
        roomStates,
        ['2003367144^Trigger^am_Trigger_MiniBossDone'],
        'late joiner must receive exactly one already-defeated room trigger state at proxy-report time'
    );
    assert.equal(
        mage.triggeredLevelStates.has('AC_Mission1:2003367144:am_Trigger_MiniBossDone'),
        true,
        'late joiner must remember the already-defeated sync so it is not resent'
    );
    assert.equal(
        mage.triggeredLevelStates.has('AC_Mission1:2003367144:am_Trigger_Cutscene'),
        true,
        'late joiner must be marked as having consumed the mini-boss intro cutscene trigger'
    );

    mage.sentPackets.length = 0;
    (LevelHandler as any).maybeSyncDeepgardDragonMiniBossAlreadyDefeated(mage);
    assert.equal(mage.sentPackets.length, 0, 'already-defeated sync must be idempotent per client');

    (LevelHandler as any).maybeTriggerDeepgardDragonMiniBossIntro(mage, -3000, -2000, -2000);
    assert.equal(
        mage.sentPackets.some(
            (packet) =>
                packet.id === 0x40 &&
                new BitReader(packet.payload).readMethod26().includes('am_Trigger_Cutscene')
        ),
        false,
        'late joiner crossing the gate trigger must not start the mini-boss cutscene after its death'
    );
}

async function main(): Promise<void> {
    const levelEntities = new Map(GlobalState.levelEntities);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const partyByMember = new Map(GlobalState.partyByMember);
    const partyGroups = new Map(GlobalState.partyGroups);
    const levelQuestProgress = new Map(GlobalState.levelQuestProgress);
    const deadServerAuthorityHostilesByScope = new Map(GlobalState.deadServerAuthorityHostilesByScope);
    const serverAuthoritySeededScopes = new Set((EntityHandler as any).serverAuthoritySeededScopes);
    const serverAuthorityDestroyedIdsByScope = new Map((EntityHandler as any).serverAuthorityDestroyedIdsByScope);
    const serverAuthorityDestroyedFingerprintsByScope = new Map((EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope);

    ensureDataLoaded();
    try {
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthoritySeededScopes.clear();
        await testAcMission1FirstSightAuthorityConvergesDragon();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthoritySeededScopes.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        await testAcMission1BuffStateBridgesThroughCanonicalEnemy();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthoritySeededScopes.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testAcMission1JoinerLocalSpawnBridgesAfterInitialCanonical();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthoritySeededScopes.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testAcMission1SharedProgressCountsServerOwnedHostiles();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthoritySeededScopes.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testAcMission1JoinerFirstSightPromotesBridgeWithoutDuplicate();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthoritySeededScopes.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testAcMission1FarSameNameHostilesPromoteSeparately();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthoritySeededScopes.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testAcMission1ServerOwnedDragonKillDoesNotForceDungeonCompletion();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthoritySeededScopes.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        await testAcMission1GoldDragonDeathRewardsUnlocksWithoutCompleting();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthoritySeededScopes.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        await testAcMission1CanonicalLootIsPersonalAndIdempotent();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthoritySeededScopes.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testAcMission1LegacyEnemyRewardPacketDoesNotSpawnLootBeforeCanonicalDeath();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthoritySeededScopes.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testLootDepthOrderingPreservesGearPickupFloorY();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthoritySeededScopes.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testLootDepthOrderingPreservesGearPickupFloorY();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testLootDepthOrderingPreservesGearPickupFloorY();
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
        (EntityHandler as any).serverAuthoritySeededScopes.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        await testAcMission1LateDeadDragonSourcePacketsStayLocal();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthoritySeededScopes.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        await testAcMission1LateDeadDragonSourcePacketsStayLocal();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthoritySeededScopes.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testAcMission1ReconnectDoesNotResetLiveCanonicalScope();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthoritySeededScopes.clear();
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope.clear();
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope.clear();
        testAcMission1CutsceneLocksServerAuthorityHostiles();
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        (EntityHandler as any).serverAuthoritySeededScopes.clear();
        testAcMission1LateJoinerSkipsMiniBossCutsceneAfterDeath();
        console.log('ac_mission1_server_authority_regression: ok');
    } finally {
        GlobalState.levelEntities = levelEntities;
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.partyByMember = partyByMember;
        GlobalState.partyGroups = partyGroups;
        GlobalState.levelQuestProgress = levelQuestProgress;
        GlobalState.deadServerAuthorityHostilesByScope = deadServerAuthorityHostilesByScope;
        (EntityHandler as any).serverAuthoritySeededScopes = serverAuthoritySeededScopes;
        (EntityHandler as any).serverAuthorityDestroyedIdsByScope = serverAuthorityDestroyedIdsByScope;
        (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope = serverAuthorityDestroyedFingerprintsByScope;
    }
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
