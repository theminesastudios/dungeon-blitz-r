import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { Entity, EntityState, EntityTeam } from '../core/Entity';
import { EntityHandler } from '../handlers/EntityHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { CombatHandler } from '../handlers/CombatHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { getLevelScopeKey } from '../core/LevelScope';

type SentPacket = { id: number; payload: Buffer };

type FakeClient = {
    token: number;
    character: { name: string; level: number; xp: number; CurrentLevel?: { name: string; x: number; y: number } };
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
    if (!LevelConfig.has('Castle')) {
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
            level: 20,
            xp: 0,
            CurrentLevel: { name: 'Castle', x: 1000, y: 1000 }
        },
        currentLevel: 'Castle',
        levelInstanceId: 'castle-hocke-sync-test',
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
    const partyId = 9911;
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

function testCastleIsNowADungeonLevel(): void {
    assert.equal(LevelConfig.isDungeonLevel('Castle'), true, 'Castle must be classified as a dungeon so the party-instance/hybrid sync bridge activates');
    assert.equal(LevelConfig.isDungeonLevel('CastleHard'), true, 'CastleHard must be classified as a dungeon too');
}

async function testCastleHostilePositionAndHpSyncAcrossParty(): Promise<void> {
    const knight = createFakeClient('Knight', 41001, 3);
    const cleric = createFakeClient('Cleric', 42002, 3);
    setParty(knight, cleric);
    attachPlayer(knight);
    attachPlayer(cleric);
    GlobalState.sessionsByToken.set(knight.token, knight as never);
    GlobalState.sessionsByToken.set(cleric.token, cleric as never);

    const scope = getLevelScopeKey(knight.currentLevel, knight.levelInstanceId);

    // Knight sees the lizard first; it becomes the one canonical, server-tracked enemy.
    attachHostile(knight, 700001, 'CastleLizard1', 2200, 1300, 3);
    const canonical = GlobalState.levelEntities.get(scope)?.get(700001);
    assert.ok(canonical, 'first-seen Castle hostile should be promoted into the canonical shared registry');
    assert.equal(canonical.hybridCanonicalHostile, true, 'Castle hostile should use the hybrid leader-authoritative bridge');
    canonical.maxHp = 8000;
    canonical.hp = 8000;

    // Cleric's client independently spawns its own local copy of the same lizard at
    // roughly the same spot (as Flash would); it must alias to the same canonical
    // entity instead of creating an invisible, unsynced duplicate.
    attachHostile(cleric, 800001, 'CastleLizard1', 2210, 1300, 3);
    assert.equal(
        EntityHandler.resolveEntityAlias(cleric as never, 800001),
        700001,
        'Cleric local Castle hostile should alias to the Knight-owned canonical entity (position-matched dedup)'
    );
    assert.equal(
        GlobalState.levelEntities.get(scope)?.has(800001),
        false,
        'Castle must not end up with two canonical copies of the same enemy'
    );

    cleric.entities.set(800001, { ...cleric.entities.get(800001), maxHp: 8000, hp: 8000 });
    knight.sentPackets.length = 0;
    cleric.sentPackets.length = 0;

    await CombatHandler.handlePowerHit(knight as never, buildPowerHitPayload(700001, knight.clientEntID, 3000));
    assert.equal(canonical.hp, 5000, 'Knight damaging the Castle hostile should update canonical HP');
    assert.equal(
        cleric.entities.get(800001)?.hp,
        5000,
        'Cleric local proxy HP must converge to the canonical HP after a party member damages the enemy'
    );

    await CombatHandler.handlePowerHit(knight as never, buildPowerHitPayload(700001, knight.clientEntID, 5000));
    assert.equal(canonical.hp, 0, 'lethal hit on the Castle hostile should be server-authoritative');
    assert.equal(canonical.dead, true, 'canonical Castle hostile should be marked dead');
    assert.equal(
        cleric.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 800001 && parseEntityState(packet.payload).entState === EntityState.DEAD),
        true,
        'Cleric should receive the DEAD state for the shared Castle hostile on her own local entity id'
    );
}

function testCastleEntityLevelRescalesWithParty(): void {
    const knight = createFakeClient('Knight', 51001, 3);
    const cleric = createFakeClient('Cleric', 52002, 3);
    knight.character.level = 20;
    cleric.character.level = 32;
    setParty(knight, cleric);
    attachPlayer(knight);
    attachPlayer(cleric);
    GlobalState.sessionsByToken.set(knight.token, knight as never);
    GlobalState.sessionsByToken.set(cleric.token, cleric as never);

    attachHostile(knight, 710001, 'CastleLizard2', 2400, 1300, 3);
    const scope = getLevelScopeKey(knight.currentLevel, knight.levelInstanceId);
    const canonical = GlobalState.levelEntities.get(scope)?.get(710001);
    assert.ok(canonical, 'Castle hostile should exist before rescaling');
    canonical.level = 20;
    knight.entities.set(710001, { ...knight.entities.get(710001), level: 20 });

    const updated = EntityHandler.rescaleDungeonEntitiesForParty(knight as never);
    assert.ok(updated >= 1, 'rescaling should update at least the Castle hostile owned by the party');
    assert.equal(canonical.level, 32, 'Castle hostile level should rescale to the highest party member runtime level');
}

function testCastleNeverTriggersDungeonCompletion(): void {
    const knight = createFakeClient('Knight', 61001, 3);
    setParty(knight);
    attachPlayer(knight);
    GlobalState.sessionsByToken.set(knight.token, knight as never);

    attachHostile(knight, 720001, 'CastleLizardMaster', 2600, 1300, 3);
    const scope = getLevelScopeKey(knight.currentLevel, knight.levelInstanceId);
    const miniBoss = GlobalState.levelEntities.get(scope)?.get(720001);
    assert.ok(miniBoss, 'Castle mini-boss hostile should exist');
    miniBoss.hp = 0;
    miniBoss.dead = true;
    miniBoss.entState = EntityState.DEAD;
    miniBoss.clientSpawned = true;

    assert.equal(
        MissionHandler.shouldProcessEnemyKillStateDungeonCompletion(knight as never, miniBoss),
        false,
        'Castle has no configured dungeon-completion boss/full-clear rule, so defeating any Castle hostile (including the mini-boss) must never schedule dungeon completion'
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
        testCastleIsNowADungeonLevel();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testCastleHostilePositionAndHpSyncAcrossParty();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        testCastleEntityLevelRescalesWithParty();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        testCastleNeverTriggersDungeonCompletion();

        console.log('castle_hocke_dungeon_sync_regression: ok');
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
    console.error('castle_hocke_dungeon_sync_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
