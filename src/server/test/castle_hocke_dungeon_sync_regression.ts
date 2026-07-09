import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { Entity, EntityState, EntityTeam } from '../core/Entity';
import { NpcLoader } from '../data/NpcLoader';
import { EntityHandler } from '../handlers/EntityHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { CombatHandler } from '../handlers/CombatHandler';
import { RewardHandler } from '../handlers/RewardHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { getLevelScopeKey } from '../core/LevelScope';

type SentPacket = { id: number; payload: Buffer };

type FakeClient = {
    token: number;
    character: { name: string; level: number; xp: number; gold?: number; CurrentLevel?: { name: string; x: number; y: number } };
    currentLevel: string;
    levelInstanceId: string;
    syncAnchorStartedAt: number;
    worldEnteredAt: number;
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
    if (NpcLoader.getRawNpcsForLevel('Castle').length === 0) {
        NpcLoader.load(dataDir);
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
            gold: 0,
            CurrentLevel: { name: 'Castle', x: 1000, y: 1000 }
        },
        currentLevel: 'Castle',
        levelInstanceId: 'castle-hocke-sync-test',
        syncAnchorStartedAt: token,
        worldEnteredAt: token,
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

function resetServerAuthorityTestState(): void {
    (EntityHandler as any).serverAuthoritySeededScopes?.clear?.();
    (EntityHandler as any).serverAuthorityDestroyedIdsByScope?.clear?.();
    (EntityHandler as any).serverAuthorityDestroyedFingerprintsByScope?.clear?.();
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

function parseDestroyEntity(payload: Buffer): number {
    const br = new BitReader(payload);
    return br.readMethod4();
}

function testCastleIsNowADungeonLevel(): void {
    assert.equal(LevelConfig.isDungeonLevel('Castle'), true, 'Castle must be classified as a dungeon so the party-instance/hybrid sync bridge activates');
    assert.equal(LevelConfig.isDungeonLevel('CastleHard'), true, 'CastleHard must be classified as a dungeon too');
    assert.equal(EntityHandler.usesServerAuthorityHostiles('Castle'), true, 'Castle hostiles must use server-authoritative lifecycle state');
    assert.equal(EntityHandler.usesServerAuthorityHostiles('CastleHard'), true, 'CastleHard hostiles must use server-authoritative lifecycle state');
    assert.equal(EntityHandler.isClientSpawnLevel('Castle'), false, 'Castle must not be treated as a client-spawn authority level anymore');
    assert.equal(EntityHandler.isClientSpawnLevel('CastleHard'), false, 'CastleHard must not be treated as a client-spawn authority level anymore');
}

function testCastleSeedsAllHostilesFromServerData(): void {
    const knight = createFakeClient('Knight', 31001, 3);
    setParty(knight);
    attachPlayer(knight);
    GlobalState.sessionsByToken.set(knight.token, knight as never);

    EntityHandler.sendInitialLevelEntities(knight as never, knight.currentLevel);
    const scope = getLevelScopeKey(knight.currentLevel, knight.levelInstanceId);
    const levelMap = GlobalState.levelEntities.get(scope);
    assert.ok(levelMap, 'Castle scope should have a server level map after initial sync');

    const expectedEnemyCount = NpcLoader.getNpcsForLevel('Castle')
        .filter((npc) => Number(npc.team ?? 0) === EntityTeam.ENEMY)
        .length;
    const serverEnemies = Array.from(levelMap!.values())
        .filter((entity) => !entity.isPlayer && Number(entity.team ?? 0) === EntityTeam.ENEMY);
    assert.equal(expectedEnemyCount, 46, 'Castle NPC data should expose all authored enemies to the server');
    assert.equal(serverEnemies.length, expectedEnemyCount, 'Castle should seed every authored enemy into the shared server instance');
    assert.ok(
        serverEnemies.every((entity) => EntityHandler.isServerAuthorityHostileEntity(knight.currentLevel, entity)),
        'every seeded Castle enemy must be a non-clientSpawned server-authority hostile'
    );
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
    EntityHandler.sendInitialLevelEntities(knight as never, knight.currentLevel);

    // Knight sees a client-local proxy for an already seeded server hostile.
    attachHostile(knight, 700001, 'CastleLizard1', 3100, -1881, 3);
    const canonical = GlobalState.levelEntities.get(scope)?.get(1658605);
    assert.ok(canonical, 'authored Castle hostile should be seeded into the canonical shared registry');
    assert.equal(canonical.clientSpawned, false, 'Castle hostile canonical must be server-owned');
    assert.equal(
        EntityHandler.resolveEntityAlias(knight as never, 700001),
        1658605,
        'Knight local Castle hostile should alias to the seeded server canonical entity'
    );
    const maxHp = Math.max(1, Math.round(Number(canonical.maxHp ?? 0)));
    const firstDamage = Math.min(3000, maxHp - 1);

    // Cleric's client independently spawns its own local copy of the same lizard at
    // roughly the same spot (as Flash would); it must alias to the same canonical
    // entity instead of creating an invisible, unsynced duplicate.
    attachHostile(cleric, 800001, 'CastleLizard1', 3110, -1881, 3);
    assert.equal(
        EntityHandler.resolveEntityAlias(cleric as never, 800001),
        1658605,
        'Cleric local Castle hostile should alias to the seeded canonical entity (position-matched dedup)'
    );
    assert.equal(
        GlobalState.levelEntities.get(scope)?.has(800001),
        false,
        'Castle must not end up with two canonical copies of the same enemy'
    );

    cleric.entities.set(800001, { ...cleric.entities.get(800001), maxHp, hp: maxHp });
    knight.sentPackets.length = 0;
    cleric.sentPackets.length = 0;

    await CombatHandler.handlePowerHit(knight as never, buildPowerHitPayload(700001, knight.clientEntID, firstDamage));
    assert.equal(canonical.hp, maxHp - firstDamage, 'Knight damaging the Castle hostile should update canonical HP');
    assert.equal(
        cleric.entities.get(800001)?.hp,
        maxHp - firstDamage,
        'Cleric local proxy HP must converge to the canonical HP after a party member damages the enemy'
    );

    await CombatHandler.handlePowerHit(knight as never, buildPowerHitPayload(700001, knight.clientEntID, maxHp - firstDamage));
    assert.equal(canonical.hp, 0, 'lethal hit on the Castle hostile should be server-authoritative');
    assert.equal(canonical.dead, true, 'canonical Castle hostile should be marked dead');
    assert.equal(
        cleric.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 800001 && parseEntityState(packet.payload).entState === EntityState.DEAD),
        true,
        'Cleric should receive the DEAD state for the shared Castle hostile on her own local entity id'
    );
}

function testCastleDeadHostileRejoinCleanupIsSilent(): void {
    const knight = createFakeClient('Knight', 81001, 3);
    const lateJoiner = createFakeClient('LateJoiner', 82002, 5);
    setParty(knight, lateJoiner);
    attachPlayer(knight);
    attachPlayer(lateJoiner);
    GlobalState.sessionsByToken.set(knight.token, knight as never);
    GlobalState.sessionsByToken.set(lateJoiner.token, lateJoiner as never);

    EntityHandler.sendInitialLevelEntities(knight as never, knight.currentLevel);
    const scope = getLevelScopeKey(knight.currentLevel, knight.levelInstanceId);
    const levelMap = GlobalState.levelEntities.get(scope);
    const canonical = levelMap?.get(1658605);
    assert.ok(canonical, 'seeded Castle hostile should exist before tombstone');
    canonical.hp = 0;
    canonical.dead = true;
    canonical.destroyed = true;
    canonical.entState = EntityState.DEAD;
    (EntityHandler as any).noteServerAuthorityHostileDestroyed(scope, 1658605, canonical, knight.token);
    levelMap?.delete(1658605);

    lateJoiner.sentPackets.length = 0;
    attachHostile(lateJoiner, 900001, 'CastleLizard1', 3110, -1881, 5);

    assert.equal(levelMap?.has(900001), false, 'late joiner local Castle copy must not resurrect a canonical enemy');
    assert.equal(
        lateJoiner.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 900001),
        false,
        'late joiner should not receive HP death correction for an already-dead Castle hostile'
    );
    assert.equal(
        lateJoiner.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 900001),
        false,
        'late joiner should not receive a DEAD state that can play a death animation'
    );
    assert.equal(
        lateJoiner.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntity(packet.payload) === 900001),
        true,
        'late joiner local Castle copy should be silently destroyed'
    );
    assert.equal(
        lateJoiner.sentPackets.some((packet) => packet.id === 0x32),
        false,
        'late joiner cleanup must not spawn loot for an enemy that died before they joined'
    );
}

async function testCastleLateJoinerDoesNotReceivePastDeathReplayOrRewards(): Promise<void> {
    const knight = createFakeClient('Knight', 83001, 3);
    const cleric = createFakeClient('Cleric', 84002, 3);
    knight.worldEnteredAt = 1_000;
    cleric.worldEnteredAt = 1_000;
    setParty(knight, cleric);
    attachPlayer(knight);
    attachPlayer(cleric);
    GlobalState.sessionsByToken.set(knight.token, knight as never);
    GlobalState.sessionsByToken.set(cleric.token, cleric as never);

    const scope = getLevelScopeKey(knight.currentLevel, knight.levelInstanceId);
    EntityHandler.sendInitialLevelEntities(knight as never, knight.currentLevel);
    attachHostile(knight, 700001, 'CastleLizard1', 3100, -1881, 3);
    attachHostile(cleric, 800001, 'CastleLizard1', 3110, -1881, 3);
    const canonical = GlobalState.levelEntities.get(scope)?.get(1658605);
    assert.ok(canonical, 'Castle hostile should be canonical before lethal hit');
    const maxHp = Math.max(1, Math.round(Number(canonical.maxHp ?? 1)));

    await CombatHandler.handlePowerHit(knight as never, buildPowerHitPayload(700001, knight.clientEntID, maxHp + 1));
    const deathFinalizedAt = Math.max(1, Math.round(Number(canonical.deathFinalizedAt ?? 0)));
    assert.equal(canonical.dead, true, 'Castle hostile should be dead before late joiner enters');
    assert.ok(deathFinalizedAt > 0, 'canonical death should have a finalized timestamp');

    const lateJoiner = createFakeClient('LateJoiner', 85003, 5);
    lateJoiner.worldEnteredAt = deathFinalizedAt + 1_000;
    setParty(knight, cleric, lateJoiner);
    attachPlayer(lateJoiner);
    GlobalState.sessionsByToken.set(lateJoiner.token, lateJoiner as never);

    lateJoiner.sentPackets.length = 0;
    attachHostile(lateJoiner, 900001, 'CastleLizard1', 3110, -1881, 5);
    assert.equal(
        lateJoiner.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 900001),
        false,
        'late joiner should not receive HP death replay when their proxy attaches after death'
    );
    assert.equal(
        lateJoiner.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 900001),
        false,
        'late joiner should not receive DEAD replay when their proxy attaches after death'
    );
    assert.equal(
        lateJoiner.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntity(packet.payload) === 900001),
        true,
        'late joiner proxy should be destroy-only when the canonical enemy died before entry'
    );
    assert.equal(
        lateJoiner.sentPackets.some((packet) => packet.id === 0x32),
        false,
        'late joiner should not receive lootdrop packets while suppressing past dead proxies'
    );

    lateJoiner.sentPackets.length = 0;
    (CombatHandler as any).runServerAuthorityDeathResweep(knight as never, scope, 1658605, 250);
    assert.equal(
        lateJoiner.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 900001),
        false,
        'death resweep should not replay HP death correction to a late joiner'
    );
    assert.equal(
        lateJoiner.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 900001),
        false,
        'death resweep should not replay DEAD state to a late joiner'
    );

    canonical.lootDropped = false;
    canonical.lootDropNonce = `${scope}:1658605:0`;
    canonical.lootGrantedTokens = new Set<number>();
    canonical.lootCollectedTokens = new Set<string>();
    canonical.lootDrops = new Map<number, unknown>();
    knight.sentPackets.length = 0;
    cleric.sentPackets.length = 0;
    lateJoiner.sentPackets.length = 0;
    lateJoiner.pendingLoot.clear();
    lateJoiner.character.xp = 0;
    lateJoiner.character.gold = 0;

    RewardHandler.grantServerEnemyRewardToEligibleViewers(knight as never, canonical, {
        levelScope: scope,
        lootDropNonce: canonical.lootDropNonce,
        sourceEnemyCanonicalId: 1658605,
        caller: 'castle_late_join_reward_regression'
    });
    assert.equal(lateJoiner.sentPackets.some((packet) => packet.id === 0x32), false, 'late joiner must not get past-death loot packets');
    assert.equal(lateJoiner.pendingLoot.size, 0, 'late joiner must not get pending loot for enemies killed before entry');
    assert.equal(lateJoiner.character.xp, 0, 'late joiner must not get past-death XP');
    assert.equal(lateJoiner.character.gold ?? 0, 0, 'late joiner must not get past-death gold directly');
    assert.ok(
        canonical.lootGrantedTokens.has(knight.token) || canonical.lootGrantedTokens.has(cleric.token),
        'players present before death should remain eligible for canonical hostile rewards'
    );
}

function testCastleServerAuthorityEntityLevelIsNormalized(): void {
    const knight = createFakeClient('Knight', 51001, 3);
    const cleric = createFakeClient('Cleric', 52002, 3);
    knight.character.level = 20;
    cleric.character.level = 32;
    setParty(knight, cleric);
    attachPlayer(knight);
    attachPlayer(cleric);
    GlobalState.sessionsByToken.set(knight.token, knight as never);
    GlobalState.sessionsByToken.set(cleric.token, cleric as never);

    EntityHandler.sendInitialLevelEntities(knight as never, knight.currentLevel);
    const scope = getLevelScopeKey(knight.currentLevel, knight.levelInstanceId);
    const canonical = GlobalState.levelEntities.get(scope)?.get(1593069);
    assert.ok(canonical, 'Castle hostile should exist before rescaling');
    canonical.level = 20;
    canonical.hp = 1000;
    canonical.maxHp = 2000;

    const updated = EntityHandler.rescaleDungeonEntitiesForParty(knight as never);
    assert.ok(updated >= 1, 'rescaling should normalize at least the seeded Castle hostile');
    assert.equal(
        canonical.level,
        EntityHandler.SERVER_AUTHORITY_ENTITY_LEVEL,
        'Castle server-authority hostile should use the shared server-authority enemy level'
    );
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
    const deadServerAuthorityHostilesByScope = new Map(GlobalState.deadServerAuthorityHostilesByScope);

    ensureDataLoaded();
    try {
        testCastleIsNowADungeonLevel();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        resetServerAuthorityTestState();
        testCastleSeedsAllHostilesFromServerData();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        resetServerAuthorityTestState();
        await testCastleHostilePositionAndHpSyncAcrossParty();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        resetServerAuthorityTestState();
        testCastleDeadHostileRejoinCleanupIsSilent();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        resetServerAuthorityTestState();
        await testCastleLateJoinerDoesNotReceivePastDeathReplayOrRewards();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        resetServerAuthorityTestState();
        testCastleServerAuthorityEntityLevelIsNormalized();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.deadServerAuthorityHostilesByScope.clear();
        resetServerAuthorityTestState();
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
        GlobalState.deadServerAuthorityHostilesByScope = deadServerAuthorityHostilesByScope;
    }
}

void main().catch((error) => {
    console.error('castle_hocke_dungeon_sync_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
