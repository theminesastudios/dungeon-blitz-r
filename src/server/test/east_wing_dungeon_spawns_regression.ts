import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { Entity, EntityState, EntityTeam } from '../core/Entity';
import { getLevelScopeKey } from '../core/LevelScope';
import {
    getOrCreateSharedDungeonProgressState,
    getSharedDungeonProgressTotals,
    recomputeSharedDungeonProgress,
    usesSharedDungeonProgress
} from '../core/SharedDungeonProgress';
import { DungeonSpawnLoader, DungeonSpawnConfig } from '../data/DungeonSpawnLoader';
import { NpcLoader } from '../data/NpcLoader';
import { CombatHandler } from '../handlers/CombatHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { RewardHandler } from '../handlers/RewardHandler';
import { EntityHandler } from '../handlers/EntityHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

// The East Wing's four rooms author 34 hostiles plus the room-3 boss. This was 5 for as
// long as the extractor discovered enemies from each room's declared ActionScript fields,
// which only see a cue the level author bothered to name -- 30 of the 35 are unnamed
// timeline instances. If this number moves, regenerate the registry and check why.
const EAST_WING_ENEMY_COUNT = 35;

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

function buildIncrementalUpdatePayload(entityId: number, deltaX: number, deltaY: number, entState: number): Buffer {
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

function buildDestroyEntityPayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod15(true);
    return bb.toBuffer();
}

function buildGrantRewardPayload(receiverId: number, sourceId: number, gold: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(receiverId);
    bb.writeMethod9(sourceId);
    bb.writeMethod15(false);
    bb.writeMethod309(0);
    bb.writeMethod15(false);
    bb.writeMethod309(0);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(gold);
    bb.writeMethod24(0);
    bb.writeMethod24(0);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildHpDeltaPayload(entityId: number, delta: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod45(delta);
    return bb.toBuffer();
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

function assertAllCanonicalHostiles(scope: string): void {
    const hostiles = getHostiles(scope);
    assert.equal(hostiles.length, EAST_WING_ENEMY_COUNT, 'JC_Mini2 should seed every authored cue as a canonical hostile');
    // The run is fought at the dungeon's AUTHORED tier, and every member sees the same pool.
    //
    // It used to scale to the highest player level in the party, which reads well and is
    // unenforceable: these hostiles are spawned by the client from the level's own cues and
    // sized from the authored tier, so a ShadeWarrior copy holds 7380 while the canonical
    // carried 26912. The player killed what was on their screen after a fifth of the damage
    // the server was waiting for, and the canonical stayed standing with the rest -- dead for
    // them, alive for everyone else, alive again for whoever joined later. The bigger pool
    // never bought any difficulty, because the client decides when the enemy dies.
    // Which tier this is depends on EntityHandler.CLIENT_OWNED_HOSTILE_TIER, and both answers
    // are legitimate -- 'authored' keeps the server's pool equal to the one the client uses,
    // 'party' scales the run to its highest member and accepts that the two disagree. Assert
    // the rule rather than a number, so switching the mode does not read as a broken test.
    const enemyLevel = EntityHandler.resolveServerAuthorityEntityLevel(scope);
    const expectedLevel = EntityHandler.CLIENT_OWNED_HOSTILE_TIER === 'authored'
        ? LevelConfig.getAuthoredDungeonEnemyLevel('JC_Mini2')
        : 50;
    assert.equal(enemyLevel, expectedLevel, 'the run sizes its hostiles from the configured tier');
    for (const hostile of hostiles) {
        assert.equal(hostile.clientSpawned, false, `${hostile.name} should be server canonical`);
        assert.equal(hostile.level, enemyLevel, `${hostile.name} should carry the run's tier`);
        assert.equal(hostile.requiredForClear, true, `${hostile.name} should be required for clear`);
        assert.equal(hostile.generatedFromScript, true, `${hostile.name} should be marked as script-generated`);
        assert.ok(String(hostile.spawnKey ?? '').includes('the_east_wing'), `${hostile.name} should keep a stable East Wing spawn key`);
        assert.equal(
            Number(hostile.maxHp ?? 0),
            EntityHandler.estimateServerAuthorityHostileMaxHp(hostile, scope),
            `${hostile.name} should be sized from the dungeon tier`
        );
        // Not a floor of 100: some of the roster is authored to die instantly. A PortalFiend
        // carries a HitPoints scale near zero and lands around 37 at the authored tier -- it is
        // a spawner prop, not a fight -- and the client sizes its own copy from the same two
        // numbers, so the two agree. What matters is that every hostile has SOME pool.
        assert.ok(Number(hostile.maxHp ?? 0) > 0, `${hostile.name} should have a health pool`);
    }

    const boss = GlobalState.levelEntities.get(scope)?.get(920004);
    assert.equal(Boolean(boss?.roomBoss), true, 'TowerGuard2 should be marked as a room boss');
    assert.equal(boss?.displayName, 'Tanja, The 2nd Daughter', 'TowerGuard2 display name should come from InitRoom');
}

function testRegistryLoad(): void {
    const config = getConfig();
    assert.equal(config.source?.swf, 'src/client/content/localhost/p/cbp/LevelsJC.swf', 'registry should identify the source SWF');
    assert.equal(config.enemies.length, EAST_WING_ENEMY_COUNT, 'registry should contain every authored enemy');
    assert.equal(config.enemies.filter((enemy) => enemy.requiredForClear).length, EAST_WING_ENEMY_COUNT, 'all East Wing enemies should be required for clear');
    assert.equal(config.enemies.filter((enemy) => enemy.boss || enemy.miniboss).length, 1, 'registry should identify one boss/miniboss');

    const npcs = NpcLoader.getNpcsForLevel('JC_Mini2');
    assert.equal(npcs.length, EAST_WING_ENEMY_COUNT, 'NpcLoader should expose the generated East Wing enemies');
    assert.equal(npcs[0].id, 920001, 'generated canonical ids should be stable');
    assert.equal(usesSharedDungeonProgress('JC_Mini2'), true, 'generated required-for-clear dungeon should use shared progress');
}

// Drawing them once is not enough. sendInitialLevelEntities fires once per level entry, so a
// hostile a client misses in that burst is gone for the rest of the run -- reported live as
// "some enemies are missing", and as one player seeing an enemy the other does not.
//
// The retry must not be gated on the server's own bookkeeping: the send path fills
// viewer.entities itself, so the server always believes it drew the entity. That is why this
// asserts a re-send for a hostile the viewer is still recorded as holding.
// A dungeon must open at 0%. The tracked/defeated sets only ever grew, so a scope seeded more
// than once kept counting hostiles that no longer exist with the old ones still marked defeated
// -- reported live as a run opening at 50% with nothing killed, then diverging to 75%.
function testStaleTrackedHostilesDoNotInflateProgress(): void {
    const zeus = createFakeClient('Zeus', 'east-wing-stale', 13991, 1);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    // Seed the state the way a previous run left it: ids that are gone, all "defeated".
    const state = getOrCreateSharedDungeonProgressState(scope);
    assert.ok(state, 'shared progress state should exist');
    for (let index = 0; index < EAST_WING_ENEMY_COUNT; index += 1) {
        const staleId = 990_000 + index;
        state.trackedHostileIds?.add(staleId);
        state.defeatedHostileIds?.add(staleId);
    }

    const totals = getSharedDungeonProgressTotals(scope);
    assert.equal(totals.total, EAST_WING_ENEMY_COUNT, 'only the hostiles this run actually has should be tracked');
    assert.equal(totals.defeated, 0, 'stale ids from an earlier seeding must not count as defeats');
    assert.equal(recomputeSharedDungeonProgress(scope)?.progress, 0, 'a fresh East Wing run must open at 0%');
}

function testMissingDrawnHostilesAreRedrawn(): void {
    // Inert while the server does not draw these hostiles: reconcileDrawnHostilesForScope
    // returns immediately for any level that is not canonical-visible. Asserting that keeps
    // the guard honest -- re-enabling server-drawn hostiles must not silently start
    // duplicating the client's own copies.
    const zeus = createFakeClient('Zeus', 'east-wing-redraw', 13977, 1);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    zeus.sentPackets.length = 0;
    EntityHandler.reconcileDrawnHostilesForScope(scope, [zeus as never]);
    assert.equal(zeus.sentPackets.length, 0, 'the redraw must stay off while the client spawns the hostiles');
}

function testEntryDoesNotPushCarriedQuestProgress(): void {
    const leader = createFakeClient('Zeus', 'east-wing-carried', 14011, 1);
    const joiner = createFakeClient('Telahair', 'east-wing-carried', 14012, 1);
    // Whatever each was showing in their own town.
    (leader.character as any).questTrackerState = 75;
    (joiner.character as any).questTrackerState = 50;

    attachPlayer(leader);
    attachPlayer(joiner);
    GlobalState.sessionsByToken.set(leader.token, leader as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);

    MissionHandler.syncMissionStateToClient(leader as never);
    MissionHandler.syncMissionStateToClient(joiner as never);

    const lastPercent = (client: FakeClient): number => {
        const packets = client.sentPackets.filter((packet) => packet.id === 0xB7);
        assert.ok(packets.length > 0, 'entry should send a quest progress packet');
        return new BitReader(packets[packets.length - 1].payload).readMethod4();
    };

    assert.equal(lastPercent(leader), 0, 'entry must not push the value carried in from a town');
    assert.equal(lastPercent(joiner), 0, 'entry must not push the value carried in from a town');
    assert.equal(
        Number((leader.character as any).questTrackerState),
        Number((joiner.character as any).questTrackerState),
        'both members of one run must open on the same tracker value'
    );

    GlobalState.sessionsByToken.delete(leader.token);
    GlobalState.sessionsByToken.delete(joiner.token);
}

function testInitialCanonicalSendsNoVisibleServerHostiles(): void {
    const zeus = createFakeClient('Zeus', 'east-wing-initial', 13933, 1);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    assertAllCanonicalHostiles(scope);

    // The server seeds the canonical roster but does NOT draw it: the client spawns these
    // hostiles from the level's own cues, and the server binds to those copies.
    //
    // Drawing them here would mean suppressing the cues, and the client's dungeon progress
    // cannot survive that -- Room.var_802 is accumulated only inside Room.SpawnCue, so held
    // cues leave every room reading as fully cleared. See the comment on
    // FIRST_SIGHT_SERVER_AUTHORITY_HOSTILE_LEVELS.
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x0F),
        false,
        'initial sync must not draw server hostiles; the client spawns them from its own cues'
    );
}

// A kill must reach the other member as DAMAGE, addressed with that member's own id.
//
// The client drops 0x07 and 0x0D for any entity with no class_122 record, and a hostile it
// spawned from its own level cue never has one -- which is why a server-decided death never
// left the killer's screen. 0x78 has no such gate: its reader calls TakeDamage, so the other
// client kills its own copy and runs its own death path, including the room bookkeeping its
// dungeon percentage is computed from.
async function testKillReachesTheOtherMemberAsLethalDamage(): Promise<void> {
    const zeus = createFakeClient('Zeus', 'east-wing-share', 14101, 1);
    const telahair = createFakeClient('Telahair', 'east-wing-share', 14102, 1);
    setParty(zeus, telahair);
    for (const client of [zeus, telahair]) {
        attachPlayer(client);
        GlobalState.sessionsByToken.set(client.token, client as never);
        EntityHandler.sendInitialLevelEntities(client as never, client.currentLevel);
    }
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    // Each client reports its own copy of the same authored hostile.
    attachProxy(zeus, 510001, 1);
    attachProxy(telahair, 610001, 1);
    const canonicalId = EntityHandler.resolveEntityAlias(zeus as never, 510001);
    assert.ok(canonicalId > 0, 'starter copy should bind to a canonical hostile');
    assert.equal(
        EntityHandler.resolveEntityAlias(telahair as never, 610001),
        canonicalId,
        'both copies of one authored hostile must bind to the same canonical'
    );

    const canonical = GlobalState.levelEntities.get(scope)?.get(canonicalId);
    assert.ok(canonical, 'canonical hostile should exist');
    assert.equal(Boolean(canonical.dead), false, 'the test hostile must start alive');

    // The server tracks the canonical, so by the time a death is broadcast it already
    // believes the other member copy is at zero -- and finalizeHostileDeath only sends an HP
    // correction when it thinks there is health left. Reproduce that, so this can only pass
    // if the destroy broadcast sends its own unconditional lethal damage.
    const telahairCopy = telahair.entities.get(610001);
    if (telahairCopy) { telahairCopy.hp = 0; }

    telahair.sentPackets.length = 0;
    await CombatHandler.handlePowerHit(
        zeus as never,
        buildPowerHitPayload(510001, zeus.clientEntID, Math.round(Number(canonical.hp ?? 0)) + 999)
    );
    assert.equal(canonical.dead, true, 'the hit should kill the canonical hostile');

    const lethal = telahair.sentPackets
        .filter((packet) => packet.id === 0x78)
        .map((packet) => parseHpDelta(packet.payload))
        .filter((hp) => hp.entityId === 610001 && hp.delta < 0);
    assert.ok(lethal.length > 0, 'the other member must be sent damage against their OWN copy id');
    assert.ok(
        Math.abs(lethal[lethal.length - 1].delta) >= Math.round(Number(canonical.maxHp ?? 1)),
        'the damage must be lethal, or the copy survives on the other screen'
    );

    for (const client of [zeus, telahair]) {
        GlobalState.sessionsByToken.delete(client.token);
    }
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
    assert.deepEqual(totals, { total: EAST_WING_ENEMY_COUNT, defeated: 1 }, 'required-for-clear totals should count server canonical enemies');
    assert.equal(progressState?.progress, Math.floor((1 / EAST_WING_ENEMY_COUNT) * 100), 'East Wing progress should be floor(deadRequired / totalRequired * 100)');

    attachPlayer(telahair);
    GlobalState.sessionsByToken.set(telahair.token, telahair as never);
    EntityHandler.sendInitialLevelEntities(telahair as never, telahair.currentLevel);
    assert.equal(telahair.levelInstanceId, zeus.levelInstanceId, 'party joiner should adopt starter East Wing instance id');

    // The joiner arrives to a run with a kill already banked, and their client spawns the
    // whole roster from its own cues -- including the enemy that is already dead.
    telahair.sentPackets.length = 0;
    LevelHandler.syncSharedDungeonQuestProgressState(telahair as never);
    const joinerProgress = telahair.sentPackets
        .filter((packet) => packet.id === 0xB7)
        .map((packet) => new BitReader(packet.payload).readMethod4());
    assert.ok(joinerProgress.length > 0, 'a joiner must be told where the run has got to');
    assert.equal(
        joinerProgress[joinerProgress.length - 1],
        Math.floor((1 / EAST_WING_ENEMY_COUNT) * 100),
        'a joiner must open on the run\'s progress, not on zero'
    );

    telahair.sentPackets.length = 0;
    attachProxy(telahair, 600001, 0);
    assert.equal(EntityHandler.resolveEntityAlias(telahair as never, 600001), 920001, 'late joiner proxy should map to the dead canonical id');
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === 600001),
        true,
        'late joiner dead proxy should be destroyed instead of respawning alive'
    );

    // The destroy above is not what buries it. 0x0D and 0x07 are both dropped by the client
    // for an entity it spawned itself, so for the whole life of this test that assertion
    // passed while the joiner watched a dead enemy get up and fight. The lethal 0x78 is the
    // packet that lands -- its reader calls TakeDamage -- so it is the one worth asserting,
    // and it also feeds the room bookkeeping the joiner's own percentage is computed from.
    const joinerLethal = telahair.sentPackets
        .filter((packet) => packet.id === 0x78)
        .map((packet) => parseHpDelta(packet.payload))
        .filter((hp) => hp.entityId === 600001);
    assert.ok(
        joinerLethal.some((hp) => hp.delta <= -Math.round(Number(canonical.maxHp ?? 1))),
        'a joiner must be sent lethal damage for an enemy the run already killed'
    );
    assert.equal(
        joinerLethal.some((hp) => hp.delta > 0),
        false,
        'a joiner must never be given health for an enemy the run already killed'
    );
    assert.equal(telahair.entities.has(600001), false, 'the joiner\'s copy of a dead enemy must not stay in the session');

    // And the run itself is untouched by the arrival: no reset, no resurrection.
    assert.equal(canonical.dead, true, 'a joiner arriving must not revive an enemy the run has buried');
    assert.deepEqual(
        getSharedDungeonProgressTotals(starterScope),
        { total: EAST_WING_ENEMY_COUNT, defeated: 1 },
        'a joiner arriving must not change the run\'s totals'
    );
}

// A joiner's fresh copy must bind to the cue it was spawned from, not to whichever same-named
// corpse is nearest. Two BoneFiends share room 1; kill one, drag its body over to the other's
// spawn point, and a name-and-distance match hands the joiner the dead one -- which stands the
// dead enemy back up and buries the live one in its place.
function testJoinerBindsBySpawnKeyNotByDistance(): void {
    const zeus = createFakeClient('Zeus', 'east-wing-spawnkey', 13955, 1);
    const telahair = createFakeClient('Telahair', 'east-wing-spawnkey-joiner', 63199, 1);
    setParty(zeus, telahair);
    for (const client of [zeus, telahair]) {
        attachPlayer(client);
        GlobalState.sessionsByToken.set(client.token, client as never);
        EntityHandler.sendInitialLevelEntities(client as never, client.currentLevel);
    }
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    // Any two hostiles of the same name in the same room will do; the roster has several.
    const byName = new Map<string, any[]>();
    for (const hostile of getHostiles(scope)) {
        const key = `${String(hostile.name)}:${Number(hostile.roomId ?? -1)}`;
        byName.set(key, [...(byName.get(key) ?? []), hostile]);
    }
    const pair = Array.from(byName.values()).find((group) => group.length >= 2);
    assert.ok(pair, 'the East Wing roster should hold two same-named hostiles in one room');
    // Deliberately the earlier-seeded one that dies: the old name-and-distance matcher walks
    // the roster in seed order and keeps the first candidate at the shortest distance, so with
    // the corpse sitting exactly on the live one's spawn point it is the corpse that wins.
    const [dead, live] = pair!;

    const liveId = Math.round(Number(live.id));
    const liveX = Number(live.x);
    const liveY = Number(live.y);

    // The other one dies and its corpse ends up sitting on the live one's spawn point.
    dead.hp = 0;
    dead.dead = true;
    dead.destroyed = true;
    dead.entState = EntityState.DEAD;
    dead.x = liveX;
    dead.y = liveY;

    // The joiner's client spawns its copy from the live one's cue, so it arrives carrying that
    // cue's position -- the same one the corpse is now sitting on.
    EntityHandler.handleEntityFullUpdate(
        telahair as never,
        buildClientHostileFullUpdate(
            700012,
            String(live.entType ?? live.name),
            liveX,
            liveY,
            Number(live.roomId ?? 0)
        )
    );
    assert.equal(
        EntityHandler.resolveEntityAlias(telahair as never, 700012),
        liveId,
        'a joiner copy must bind to the cue it spawned from, not to the nearest corpse'
    );
    assert.equal(Boolean(dead.dead), true, 'the corpse must stay a corpse');
    assert.equal(Boolean(live.dead), false, 'the live enemy must not be buried by a mismatched bind');

    for (const client of [zeus, telahair]) {
        GlobalState.sessionsByToken.delete(client.token);
    }
}

// A copy the server refuses must actually die on the screen that spawned it.
//
// The client replays a room's cues more than once, so the server regularly gets a second copy
// of a hostile it has already bound and answers it with `destroyClientLocalEntity`. That used
// to send only the dead state and the destroy -- both dropped for a self-spawned hostile -- so
// the refusal removed the copy from the SERVER and left it standing at full health on the
// player's screen: an enemy nobody else can see, which they then fight and kill.
function testRefusedDuplicateCopyIsKilledOnTheClient(): void {
    const zeus = createFakeClient('Zeus', 'east-wing-duplicate', 13966, 1);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);

    attachProxy(zeus, 500001, 0);
    const canonicalId = EntityHandler.resolveEntityAlias(zeus as never, 500001);
    assert.ok(canonicalId > 0, 'the first copy should bind to a canonical');

    // The same cue fires again under a new local id.
    zeus.sentPackets.length = 0;
    attachProxy(zeus, 500099, 0);
    assert.equal(zeus.entities.has(500099), false, 'the duplicate copy must not be kept by the server');

    const lethal = zeus.sentPackets
        .filter((packet) => packet.id === 0x78)
        .map((packet) => parseHpDelta(packet.payload))
        .filter((hp) => hp.entityId === 500099 && hp.delta < 0);
    assert.ok(
        lethal.length > 0,
        'a refused duplicate must be killed on the client, not just dropped by the server'
    );

    GlobalState.sessionsByToken.delete(zeus.token);
}

// Re-keying a scope must carry the run, not abandon it.
//
// `moveClientOwnedEntitiesBetweenScopes` moved only entities carrying the client's own
// `ownerToken`. A canonical hostile carries none, so the whole shared roster -- and every death
// recorded on it -- stayed behind under the old key, and the next entry seeded a fresh one with
// all 35 enemies alive. No reset, no log line, and from the server's side simply a scope that
// had never been played: `live=34` on a run whose first member had already cleared a room, with
// their 25% against the run's 2%.
function testScopeRekeyCarriesTheRun(): void {
    const telahair = createFakeClient('Telahair', '62242', 62242, 1);
    attachPlayer(telahair);
    GlobalState.sessionsByToken.set(telahair.token, telahair as never);
    EntityHandler.sendInitialLevelEntities(telahair as never, telahair.currentLevel);

    // The second member anchors the party's scope, so it is the first member -- the one holding
    // the run -- that gets re-keyed onto it.
    const lanorut = createFakeClient('Lanorut', '36754', 36754, 1);
    setParty(telahair, lanorut);
    attachPlayer(lanorut);
    GlobalState.sessionsByToken.set(lanorut.token, lanorut as never);

    const oldScope = getLevelScopeKey(telahair.currentLevel, telahair.levelInstanceId);
    const killed = getHostiles(oldScope)[0];
    assert.ok(killed, 'the solo run should have a roster to kill from');
    killed.hp = 0;
    killed.dead = true;
    killed.destroyed = true;
    killed.entState = EntityState.DEAD;
    const killedId = Math.round(Number(killed.id));

    const newScope = EntityHandler.ensureJcMini1PartySharedScope(
        telahair as never,
        telahair.currentLevel,
        'test_rekey'
    );
    assert.notEqual(newScope, oldScope, 'this test needs the scope to actually be re-keyed');

    const carried = getHostiles(newScope);
    assert.equal(carried.length, EAST_WING_ENEMY_COUNT, 'the whole roster must move with the run');
    assert.equal(
        carried.filter((hostile) => Math.round(Number(hostile.hp)) < Math.round(Number(hostile.maxHp))).length +
            carried.filter((hostile) => Boolean(hostile.dead)).length > 0,
        true,
        'the run that arrives is the one with a history, not a fresh copy of the roster'
    );
    assert.equal(
        Boolean(carried.find((hostile) => Math.round(Number(hostile.id)) === killedId)?.dead),
        true,
        'an enemy the run had killed must still be dead under the new key'
    );
    assert.deepEqual(
        getSharedDungeonProgressTotals(newScope),
        { total: EAST_WING_ENEMY_COUNT, defeated: 1 },
        're-keying must not reopen the run at zero'
    );

    GlobalState.sessionsByToken.delete(telahair.token);
    GlobalState.sessionsByToken.delete(lanorut.token);
}

// You cannot be hit by something that is not on your screen.
//
// An enemy one client spawned privately -- one the server never bound to a canonical -- has an
// id the other member has never heard of. The id translation passes such an id straight through
// (players, projectiles and region actors all depend on that), so the attack was relayed as-is:
// the receiving client cannot place the attacker, but it can place the TARGET, and the target
// is that player, so they took the hit and saw the effect land on themselves out of thin air.
async function testHitsFromAnUnseenAttackerAreNotRelayed(): Promise<void> {
    const telahair = createFakeClient('Telahair', 'east-wing-phantom', 62400, 1);
    const lanorut = createFakeClient('Lanorut', 'east-wing-phantom', 36900, 1);
    setParty(telahair, lanorut);
    for (const client of [telahair, lanorut]) {
        attachPlayer(client);
        GlobalState.sessionsByToken.set(client.token, client as never);
        EntityHandler.sendInitialLevelEntities(client as never, client.currentLevel);
    }

    // An enemy that exists only in Lanorut's session, under an id nobody else knows.
    const phantomId = 7_654_321;
    lanorut.entities.set(phantomId, {
        id: phantomId,
        name: 'Ghoul',
        team: EntityTeam.ENEMY,
        isPlayer: false,
        clientSpawned: true,
        ownerToken: lanorut.token,
        hp: 5000,
        maxHp: 5000,
        roomId: 1
    });
    lanorut.knownEntityIds.add(phantomId);

    telahair.sentPackets.length = 0;
    await CombatHandler.handlePowerHit(
        lanorut as never,
        buildPowerHitPayload(telahair.clientEntID, phantomId, 500)
    );

    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0x0A),
        false,
        'a hit from an attacker the viewer cannot place must not be relayed to them'
    );

    for (const client of [telahair, lanorut]) {
        GlobalState.sessionsByToken.delete(client.token);
    }
}

// A corpse correction must stay deliverable, however many times the client asks.
//
// The correction used to delete the viewer's copy from `entities` and `knownEntityIds` right
// after sending. `resolveHostileLocalIdForViewer` only returns a registered local id while one
// of those still holds it, so the first correction was also the last: every later attempt
// resolved to nothing and returned in silence, and the enemy stood on that screen for the rest
// of the run. The live shape was `Lanorut:32/33 missing=[920013]` beside that same client
// reporting a full pool of damage to 920013 -- the server had forgotten how to address the
// enemy the player was standing in front of.
async function testCorpseCorrectionSurvivesRepeatedReports(): Promise<void> {
    const zeus = createFakeClient('Zeus', 'east-wing-corpse', 14201, 1);
    const telahair = createFakeClient('Telahair', 'east-wing-corpse', 14202, 1);
    setParty(zeus, telahair);
    for (const client of [zeus, telahair]) {
        attachPlayer(client);
        GlobalState.sessionsByToken.set(client.token, client as never);
        EntityHandler.sendInitialLevelEntities(client as never, client.currentLevel);
    }
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    attachProxy(zeus, 510001, 1);
    attachProxy(telahair, 610001, 1);
    const canonicalId = EntityHandler.resolveEntityAlias(zeus as never, 510001);
    assert.ok(canonicalId > 0, 'both copies should bind to a canonical');
    const canonical = GlobalState.levelEntities.get(scope)?.get(canonicalId);
    assert.ok(canonical, 'the canonical should exist');

    await CombatHandler.handlePowerHit(
        zeus as never,
        buildPowerHitPayload(510001, zeus.clientEntID, Math.round(Number(canonical.hp ?? 0)) + 999)
    );
    assert.equal(canonical.dead, true, 'the hit should bury the canonical');

    const lethalCount = (): number => telahair.sentPackets
        .filter((packet) => packet.id === 0x78)
        .map((packet) => parseHpDelta(packet.payload))
        .filter((hp) => hp.entityId === 610001 && hp.delta < 0)
        .length;

    // The client is still swinging at what it can see, and says so.
    telahair.sentPackets.length = 0;
    CombatHandler.handleCharRegen(telahair as never, buildHpDeltaPayload(610001, -100));
    assert.ok(lethalCount() > 0, 'a client fighting a corpse must be sent lethal damage');

    // The lethal damage makes that client report the loss straight back -- Entity.TakeDamage is
    // patched to do exactly that -- so answering every report is answering our own echo. A live
    // capture ran to 19840 reports for two corpses in one session.
    telahair.sentPackets.length = 0;
    CombatHandler.handleCharRegen(telahair as never, buildHpDeltaPayload(610001, -100));
    assert.equal(lethalCount(), 0, 'the echo of a correction must not be answered with another');

    // But the correction has to stay DELIVERABLE. It used to delete the viewer's copy from
    // `entities`/`knownEntityIds` as it sent, and `resolveHostileLocalIdForViewer` only returns
    // a registered local id while one of those still holds it -- so the first correction was
    // also the last, and a client that missed it kept the body for the rest of the run. That is
    // `Lanorut:32/33 missing=[920013]` beside that same client reporting damage to 920013.
    const realNow = Date.now;
    Date.now = () => realNow() + 5000;
    try {
        telahair.sentPackets.length = 0;
        CombatHandler.handleCharRegen(telahair as never, buildHpDeltaPayload(610001, -100));
        assert.ok(
            lethalCount() > 0,
            'once the echo window has passed, a client still holding the corpse is corrected again'
        );
    } finally {
        Date.now = realNow;
    }

    for (const client of [zeus, telahair]) {
        GlobalState.sessionsByToken.delete(client.token);
    }
}

// The client that owns the body is believed when it says the body died.
//
// These hostiles are spawned, animated and killed by the client; the server only hears the
// damage the client chooses to report, and the moment its own copy dies it stops reporting. So
// the last slice of the pool never arrives and the canonical can never reach zero on its own.
// The live capture is the proof: after one member cleared a room, every canonical they had
// fought sat short of zero -- Ghoul 3483/26912, BoneFiend 5072/26912, ShadeWarrior 6998/26912 --
// with live=35 and not one death recorded, while their own screen showed the room empty at 25%.
// Refusing that report left the enemy alive for everybody and stood the killer's copy back up.
function testClientReportedDeathIsAcceptedWithHealthRemaining(): void {
    const zeus = createFakeClient('Zeus', 'east-wing-remainder', 14301, 1);
    const telahair = createFakeClient('Telahair', 'east-wing-remainder', 14302, 1);
    setParty(zeus, telahair);
    for (const client of [zeus, telahair]) {
        attachPlayer(client);
        GlobalState.sessionsByToken.set(client.token, client as never);
        EntityHandler.sendInitialLevelEntities(client as never, client.currentLevel);
    }
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    attachProxy(zeus, 520001, 1);
    attachProxy(telahair, 620001, 1);
    const canonicalId = EntityHandler.resolveEntityAlias(zeus as never, 520001);
    const canonical = GlobalState.levelEntities.get(scope)?.get(canonicalId);
    assert.ok(canonical, 'the copies should bind to a canonical');

    // The killer's client got it most of the way down and then killed its own copy -- which is
    // all the server ever sees of the last slice.
    canonical.hp = Math.max(1, Math.round(Number(canonical.maxHp) * 0.2));
    canonical.dead = false;
    canonical.entState = EntityState.ACTIVE;

    telahair.sentPackets.length = 0;
    LevelHandler.handleEntityIncrementalUpdate(
        zeus as never,
        buildIncrementalUpdatePayload(520001, 0, 0, EntityState.DEAD)
    );

    assert.equal(Boolean(canonical.dead), true, 'a report of death from the body\'s owner must bury the canonical');
    assert.equal(Math.round(Number(canonical.hp)), 0, 'the remainder must not keep the enemy standing');
    assert.deepEqual(
        getSharedDungeonProgressTotals(scope),
        { total: EAST_WING_ENEMY_COUNT, defeated: 1 },
        'the run must count the kill'
    );
    assert.ok(
        telahair.sentPackets
            .filter((packet) => packet.id === 0x78)
            .map((packet) => parseHpDelta(packet.payload))
            .some((hp) => hp.entityId === 620001 && hp.delta < 0),
        'the other member must be sent the death for their own copy'
    );

    for (const client of [zeus, telahair]) {
        GlobalState.sessionsByToken.delete(client.token);
    }
}

// Some kills only ever arrive as a destroy, and those must count too.
//
// A client does not always announce a kill as a terminal state update; sometimes the only
// signal is its 0x0D. That path still refused a destroy whose canonical had health left AND
// revived the enemy, so a handful survived every clear -- the run that reached 75% against a
// joiner's 70% had exactly two of them left standing.
//
// A destroy is not automatically a kill, though: clients throw copies away when they tear a
// room down. Two things together make it one -- the client reporting its own copy dead, and the
// run's record showing the enemy most of the way down.
async function testOwnerDestroyCountsAsAKillOnlyWhenTheEnemyWasFought(): Promise<void> {
    const zeus = createFakeClient('Zeus', 'east-wing-destroy', 14401, 1);
    const telahair = createFakeClient('Telahair', 'east-wing-destroy', 14402, 1);
    setParty(zeus, telahair);
    for (const client of [zeus, telahair]) {
        attachPlayer(client);
        GlobalState.sessionsByToken.set(client.token, client as never);
        EntityHandler.sendInitialLevelEntities(client as never, client.currentLevel);
    }
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    attachProxy(zeus, 530001, 1);
    attachProxy(telahair, 630001, 1);
    const canonicalId = EntityHandler.resolveEntityAlias(zeus as never, 530001);
    const canonical = GlobalState.levelEntities.get(scope)?.get(canonicalId);
    assert.ok(canonical, 'the copies should bind to a canonical');

    // Walking away from an untouched enemy is not a kill.
    zeus.entities.set(530001, { ...zeus.entities.get(530001), hp: 0, dead: true, entState: EntityState.DEAD });
    await CombatHandler.handleEntityDestroy(zeus as never, buildDestroyEntityPayload(530001));
    assert.equal(Boolean(canonical.dead), false, 'a destroy of an enemy at full health must not bury it');

    // Fought most of the way down and then destroyed by its owner: that is the kill.
    canonical.hp = Math.max(1, Math.round(Number(canonical.maxHp) * 0.15));
    canonical.dead = false;
    canonical.entState = EntityState.ACTIVE;
    zeus.entities.set(530001, { ...zeus.entities.get(530001), hp: 0, dead: true, entState: EntityState.DEAD });
    telahair.sentPackets.length = 0;
    await CombatHandler.handleEntityDestroy(zeus as never, buildDestroyEntityPayload(530001));

    assert.equal(Boolean(canonical.dead), true, 'an owner destroying a copy it fought down must bury the canonical');
    assert.equal(Math.round(Number(canonical.hp)), 0, 'the remainder must not keep it standing');
    assert.ok(
        telahair.sentPackets
            .filter((packet) => packet.id === 0x78)
            .map((packet) => parseHpDelta(packet.payload))
            .some((hp) => hp.entityId === 630001 && hp.delta < 0),
        'the other member must be sent the death for their own copy'
    );

    for (const client of [zeus, telahair]) {
        GlobalState.sessionsByToken.delete(client.token);
    }
}

// A burial has to be lethal to the copy the CLIENT has, not to the one the server holds.
//
// The East Wing roster carries 'PortalFiend canonicalHp=135/135' next to ShadeWarrior 26912 and
// GreaterDemonMaligner 161472. Sizing the burial from the canonical sent 135 damage at a client
// copy holding the real pool, so those enemies stayed alive on a joiner's screen while being
// long dead for the run and for the member who killed them.
function testBurialIsLethalToATinyPoolCanonical(): void {
    const zeus = createFakeClient('Zeus', 'east-wing-tinypool', 14501, 1);
    const telahair = createFakeClient('Telahair', 'east-wing-tinypool', 14502, 1);
    setParty(zeus, telahair);
    for (const client of [zeus, telahair]) {
        attachPlayer(client);
        GlobalState.sessionsByToken.set(client.token, client as never);
        EntityHandler.sendInitialLevelEntities(client as never, client.currentLevel);
    }
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    const tiny = getHostiles(scope).find((hostile) => Math.round(Number(hostile.maxHp)) <= 1000);
    assert.ok(tiny, 'the roster should hold a hostile with a tiny authored pool');
    const tinyIndex = getConfig().enemies.findIndex(
        (enemy: any) => String(enemy.type) === String(tiny.entType ?? tiny.name)
    );
    assert.ok(tinyIndex >= 0, 'the tiny-pool hostile should be in the spawn config');

    tiny.hp = 0;
    tiny.dead = true;
    tiny.destroyed = true;
    tiny.entState = EntityState.DEAD;

    telahair.sentPackets.length = 0;
    EntityHandler.handleEntityFullUpdate(
        telahair as never,
        buildClientHostileFullUpdate(
            660001,
            String(tiny.entType ?? tiny.name),
            Number(tiny.x),
            Number(tiny.y),
            Number(tiny.roomId ?? 0)
        )
    );

    const lethal = telahair.sentPackets
        .filter((packet) => packet.id === 0x78)
        .map((packet) => parseHpDelta(packet.payload))
        .filter((hp) => hp.entityId === 660001 && hp.delta < 0);
    assert.ok(lethal.length > 0, 'a joiner meeting a buried hostile must be sent damage for it');
    // Not merely bigger than the canonical: bigger than anything the health table can express.
    // Every pool the server knows is the server's idea of one, and the body being buried is the
    // client's. They are supposed to agree, but the run's tier travels in a packet now, and
    // anything that arrives late or out of order puts them out of step -- at which point a
    // burial sized from the server's number is too small and the enemy stands on that screen
    // for the rest of the run. This is the one number that cannot be wrong.
    const largestPossiblePool = 134560 * 3;
    assert.ok(
        Math.abs(lethal[lethal.length - 1].delta) > largestPossiblePool,
        'a burial must kill any body the client could have spawned, whatever tier it used'
    );

    for (const client of [zeus, telahair]) {
        GlobalState.sessionsByToken.delete(client.token);
    }
}

// A reward request is also a death certificate, and a chest pays once.
//
// A client only asks for a kill reward after the thing died on its screen. That signal is the
// most reliable one there is here: the terminal state update and the destroy both go missing
// sometimes, and the canonical can never reach zero on its own to confirm anything. A live
// capture had `BoneFiend 1480/7380` still standing in the roster with its killer's reward
// request sitting in the same log.
//
// Chests go the other way: both members end up breaking the same chest -- one opens it, the
// other's copy is broken for them by the share -- and both clients then ask for the gold. Four
// chest_reward requests for two chests, in that same capture.
async function testRewardRequestBuriesTheEnemyAndChestsPayOnce(): Promise<void> {
    const zeus = createFakeClient('Zeus', 'east-wing-reward', 14701, 1);
    const telahair = createFakeClient('Telahair', 'east-wing-reward', 14702, 1);
    setParty(zeus, telahair);
    for (const client of [zeus, telahair]) {
        attachPlayer(client);
        GlobalState.sessionsByToken.set(client.token, client as never);
        EntityHandler.sendInitialLevelEntities(client as never, client.currentLevel);
    }
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    attachProxy(zeus, 550001, 1);
    attachProxy(telahair, 650001, 1);
    const canonicalId = EntityHandler.resolveEntityAlias(zeus as never, 550001);
    const canonical = GlobalState.levelEntities.get(scope)?.get(canonicalId);
    assert.ok(canonical, 'the copies should bind to a canonical');
    canonical.hp = Math.max(1, Math.round(Number(canonical.maxHp) * 0.2));

    // A reward request on its own is NOT a kill. Taking it as one executed enemies on the
    // first hit: a client asks for a reward in more cases than a death. The corroboration is
    // the state of the copy that asked -- it only reads dead once it died on their screen.
    telahair.sentPackets.length = 0;
    RewardHandler.handleGrantReward(zeus as never, buildGrantRewardPayload(zeus.clientEntID, 550001, 0));
    assert.equal(
        Boolean(canonical.dead),
        false,
        'a reward request from a client whose copy is still standing must not execute the enemy'
    );

    // Once their own copy is dead, the same request is the death certificate.
    zeus.entities.set(550001, { ...zeus.entities.get(550001), hp: 0, dead: true, entState: EntityState.DEAD });
    telahair.sentPackets.length = 0;
    RewardHandler.handleGrantReward(zeus as never, buildGrantRewardPayload(zeus.clientEntID, 550001, 0));
    assert.equal(Boolean(canonical.dead), true, 'asking for the kill reward is asking after a kill');
    assert.ok(
        telahair.sentPackets
            .filter((packet) => packet.id === 0x78)
            .map((packet) => parseHpDelta(packet.payload))
            .some((hp) => hp.entityId === 650001 && hp.delta < 0),
        'the other member must be sent the death for their own copy'
    );

    for (const client of [zeus, telahair]) {
        GlobalState.sessionsByToken.delete(client.token);
    }
}

// The run's tier has to reach the client, or party scaling is a number only the server sees.
//
// Every hostile the client spawns is sized as `const_867[Game.mBonusLevels + level.mapLevel]
// * entType.HitPoints`, and packet 0x5E writes straight into `mBonusLevels`. Without it the
// server holds a level-50 pool while the client fights a level-29 body, and every health
// correction between the two lands as a second helping of damage -- one or two hits executed
// anything, with the bar barely moving.
function testTheRunTellsTheClientItsTier(): void {
    const zeus = createFakeClient('Zeus', 'east-wing-bonus', 14801, 1);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);

    zeus.sentPackets.length = 0;
    LevelHandler.spawnLevelNpcs(zeus as never, zeus.currentLevel);

    const bonus = zeus.sentPackets.find((packet) => packet.id === EntityHandler.DUNGEON_BONUS_LEVELS_PACKET);
    assert.ok(bonus, 'entering a dungeon must tell the client which tier to spawn its hostiles at');

    // Zero, and the packet still sent. `mBonusLevels` only reaches the client's other level
    // branch -- a hostile spawned from a level cue reads `entType.baseLevel` and never sees it
    // -- so a real offset would do nothing for the bodies this dungeon is made of while quietly
    // enlarging anything that does use the branch. What the packet is still good for is clearing
    // an offset left over from wherever the player was before.
    assert.equal(
        new BitReader(bonus!.payload).readMethod4(),
        0,
        'the offset is held at zero while the server mirrors the type level the client uses'
    );

    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);
    const authored = LevelConfig.getAuthoredDungeonEnemyLevel('JC_Mini2');
    const tier = EntityHandler.resolveServerAuthorityEntityLevel(scope);
    assert.equal(
        new BitReader(bonus!.payload).readMethod4(),
        Math.max(0, tier - authored),
        'the value is the OFFSET on the authored map level, not the level itself'
    );

    // The tier is locked for the run: a higher-level member arriving later must not grow the
    // server's pools while every body already on every screen keeps the old one.
    const locked = EntityHandler.resolveServerAuthorityEntityLevel(scope);
    assert.equal(locked, tier, 'the run keeps the tier it started at');

    GlobalState.sessionsByToken.delete(zeus.token);
}

// A chest is opened once for the run, and it pays once.
//
// Chests are never reported to the server as entities in their own right and are absent from
// the generated roster, so none of the hostile machinery ever sees one -- an earlier attempt
// gave them canonicals so that code could carry them, and it carried everything else too:
// the reconcile swept them and chests vanished before anyone opened them. A chest needs none
// of that. It is opened once, by one person, and every other screen is told.
//
// The reward request is the only moment it exists here, and it carries where the chest stands.
// That is identity enough, and unlike a name it survives opening -- which renames a
// TreasureChestMedium into a TreasureChestEmpty.
function testAnOpenedChestIsOpenedForEveryoneAndPaysOnce(): void {
    const zeus = createFakeClient('Zeus', 'east-wing-chest2', 14901, 1);
    const telahair = createFakeClient('Telahair', 'east-wing-chest2', 14902, 1);
    setParty(zeus, telahair);
    for (const client of [zeus, telahair]) {
        attachPlayer(client);
        GlobalState.sessionsByToken.set(client.token, client as never);
        EntityHandler.sendInitialLevelEntities(client as never, client.currentLevel);
    }
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);
    EntityHandler.forgetOpenedChests(scope);

    // Both members are standing at the same chest, each holding their own copy.
    const chestX = 15000;
    const chestY = 3200;
    zeus.entities.set(560001, { id: 560001, name: 'TreasureChestMedium', team: EntityTeam.ENEMY, x: chestX, y: chestY, hp: 135, maxHp: 135 });
    telahair.entities.set(660001, { id: 660001, name: 'TreasureChestMedium', team: EntityTeam.ENEMY, x: chestX, y: chestY, hp: 135, maxHp: 135 });

    telahair.sentPackets.length = 0;
    RewardHandler.handleGrantReward(zeus as never, buildGrantRewardPayload(zeus.clientEntID, 560001, 500));

    // The mate's chest is emptied for them, with the packet their client acts on.
    assert.ok(
        telahair.sentPackets
            .filter((packet) => packet.id === 0x78)
            .map((packet) => parseHpDelta(packet.payload))
            .some((hp) => hp.entityId === 660001 && hp.delta < 0),
        'opening a chest must break it on every other screen'
    );
    assert.equal(telahair.entities.has(660001), false, 'the broken chest leaves the run record for that screen');

    // Payment is keyed on the chest the client names, not on where it says the chest is.
    //
    // Reward requests were seen arriving with one shared coordinate and four different gold
    // rolls -- four real chests reporting from one spot -- so refusing by position swallowed
    // three of them, and left each unrecorded to stand back up for the joiner. Position still
    // answers the other question, which is whose screen to break.
    assert.equal(
        EntityHandler.claimChestPayout(scope, telahair as never, 660001),
        true,
        'the first request for a chest is paid'
    );
    assert.equal(
        EntityHandler.claimChestPayout(scope, telahair as never, 660001),
        false,
        'the same chest must not pay the same client twice'
    );
    assert.equal(
        EntityHandler.claimChestPayout(scope, telahair as never, 660002),
        true,
        'a different chest is a different payout, whatever coordinate it reports from'
    );

    // Two chests in one room are two chests. The match tolerance used to be 400px, which is
    // not 'the same chest' but 'that side of the room': opening one swallowed the next, so the
    // second paid nothing, was never broken on anyone else's screen, and stood there unopened
    // for the joiner -- the chest that 'respawned'.
    const secondChestX = chestX + 300;
    telahair.entities.set(660002, { id: 660002, name: 'TreasureChestMedium', team: EntityTeam.ENEMY, x: secondChestX, y: chestY, hp: 135, maxHp: 135 });
    zeus.entities.set(560002, { id: 560002, name: 'TreasureChestMedium', team: EntityTeam.ENEMY, x: secondChestX, y: chestY, hp: 135, maxHp: 135 });
    telahair.sentPackets.length = 0;
    RewardHandler.handleGrantReward(zeus as never, buildGrantRewardPayload(zeus.clientEntID, 560002, 500));
    assert.ok(
        telahair.sentPackets
            .filter((packet) => packet.id === 0x78)
            .map((packet) => parseHpDelta(packet.payload))
            .some((hp) => hp.entityId === 660002 && hp.delta < 0),
        'a second chest a few hundred pixels away is its own chest, and opening it must break it too'
    );

    // And a joiner whose client spawns it later walks up to an opened one.
    const late = createFakeClient('Late', 'east-wing-chest2', 14903, 1);
    attachPlayer(late);
    GlobalState.sessionsByToken.set(late.token, late as never);
    late.sentPackets.length = 0;
    EntityHandler.handleEntityFullUpdate(
        late as never,
        buildClientHostileFullUpdate(760001, 'TreasureChestMedium', chestX, chestY, 1)
    );
    assert.ok(
        late.sentPackets
            .filter((packet) => packet.id === 0x78)
            .map((packet) => parseHpDelta(packet.payload))
            .some((hp) => hp.entityId === 760001 && hp.delta < 0),
        'a chest the run already opened must be broken the moment a joiner spawns it'
    );

    EntityHandler.forgetOpenedChests(scope);
    EntityHandler.forgetPaidChestClaims(scope);
    for (const client of [zeus, telahair, late]) {
        GlobalState.sessionsByToken.delete(client.token);
    }
}

// A run must not be lost to a roster that was merely seeded.
//
// The destination scope usually holds hostiles already -- somebody entered and the level was
// populated for them -- and refusing to carry into it looks safe. It is not: the party lands
// on that untouched roster and every enemy they fought stands back up at full health. The
// live capture caught one canonical walked down to 4932/26912 by both members, reporting
// 26912/26912 the moment the scope re-keyed.
function testAPristineRosterDoesNotOutrankARunInProgress(): void {
    const telahair = createFakeClient('Telahair', '70001', 70001, 1);
    attachPlayer(telahair);
    GlobalState.sessionsByToken.set(telahair.token, telahair as never);
    EntityHandler.sendInitialLevelEntities(telahair as never, telahair.currentLevel);
    const oldScope = getLevelScopeKey(telahair.currentLevel, telahair.levelInstanceId);

    // A fight in progress: one enemy down to a fifth, one dead.
    const fought = getHostiles(oldScope)[0];
    const killed = getHostiles(oldScope)[1];
    fought.hp = Math.max(1, Math.round(Number(fought.maxHp) * 0.2));
    killed.hp = 0;
    killed.dead = true;
    const foughtId = Math.round(Number(fought.id));

    // The second member arrives and their entry seeds a fresh, untouched roster of its own.
    // Their scope is seeded BEFORE the party exists, so it holds a full, untouched roster of
    // its own -- which is the live shape: the joiner's own entry populated the scope that the
    // party then anchors on, and the member holding the run is the one that moves onto it.
    const lanorut = createFakeClient('Lanorut', '60002', 60002, 1);
    attachPlayer(lanorut);
    GlobalState.sessionsByToken.set(lanorut.token, lanorut as never);
    EntityHandler.sendInitialLevelEntities(lanorut as never, lanorut.currentLevel);
    assert.equal(
        getHostiles(getLevelScopeKey(lanorut.currentLevel, lanorut.levelInstanceId)).length,
        EAST_WING_ENEMY_COUNT,
        'the joiner own entry seeds a full roster'
    );
    setParty(telahair, lanorut);

    const newScope = EntityHandler.ensureJcMini1PartySharedScope(
        telahair as never,
        telahair.currentLevel,
        'test_pristine'
    );
    assert.notEqual(newScope, oldScope, 'this test needs the scope to be re-keyed');

    const arrived = getHostiles(newScope);
    assert.equal(arrived.length, EAST_WING_ENEMY_COUNT, 'exactly one roster may live in a scope');
    const survivor = arrived.find((hostile) => Math.round(Number(hostile.id)) === foughtId);
    assert.ok(survivor, 'the enemy the party fought must still be there');
    assert.ok(
        Math.round(Number(survivor.hp)) < Math.round(Number(survivor.maxHp)),
        'the damage the party dealt must survive the move, not be replaced by a fresh copy'
    );

    for (const client of [telahair, lanorut]) {
        GlobalState.sessionsByToken.delete(client.token);
    }
}

// The server must size a hostile exactly the way the client does.
//
// The client has six places that set an entity's level, and the one adding the run's
// `mBonusLevels` is not the one a cue-spawned hostile takes -- those read `entType.baseLevel`
// and nothing else. So any tier the server picks for itself is a number only the server has,
// and the gap is the whole bug: the player kills what is on their screen, the canonical keeps
// the difference, and the enemy stands for everyone else. Measured at its worst, a ShadeWarrior
// recorded at 26912 died to 8572 of damage -- the client had been fighting a tier 26 body.
function testTheServerSizesHostilesTheWayTheClientDoes(): void {
    const zeus = createFakeClient('Zeus', 'east-wing-mirror', 15001, 1);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    const table = (EntityHandler as any).HOSTILE_BASE_HITPOINTS as number[];
    for (const hostile of getHostiles(scope)) {
        const entType = GameData.getEntType(String(hostile.name)) ?? {};
        const level = Math.round(Number(entType.Level ?? 0));
        const scale = Number(entType.HitPoints ?? NaN);
        if (!(level > 0) || !Number.isFinite(scale) || scale <= 0) {
            continue;
        }
        const clientPool = Math.max(1, Math.round(table[Math.min(level, table.length - 1)] * scale));
        assert.equal(
            Math.round(Number(hostile.maxHp)),
            clientPool,
            `${hostile.name} must be the same size on the server as it is on the screen`
        );
    }

    GlobalState.sessionsByToken.delete(zeus.token);
}

// A chest counts as opened however the client says so.
//
// The reward request was the only signal the run listened to, and it does not always come: a
// live capture had a member break two chests and ask for gold on only one, so the other stayed
// 'unopened' and stood back up for the joiner. A client breaking a chest also destroys it, and
// takes its health off first -- both arrive whether a reward follows or not.
async function testAnyBreakSignalCountsAsOpeningAChest(): Promise<void> {
    const zeus = createFakeClient('Zeus', 'east-wing-signals', 15101, 1);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);
    EntityHandler.forgetOpenedChests(scope);

    // Signal one: the client destroys what it broke.
    const destroyedAt = { x: 16546, y: 6659 };
    zeus.entities.set(570001, { id: 570001, name: 'TreasureChestMedium', team: EntityTeam.ENEMY, x: destroyedAt.x, y: destroyedAt.y, hp: 135, maxHp: 135 });
    await CombatHandler.handleEntityDestroy(zeus as never, buildDestroyEntityPayload(570001));
    assert.equal(
        EntityHandler.isChestOpened(scope, destroyedAt.x, destroyedAt.y),
        true,
        'a chest the client destroyed is an opened chest, reward or no reward'
    );

    // Signal two: the health it took off its own copy.
    const damagedAt = { x: 15104, y: 6619 };
    zeus.entities.set(570002, { id: 570002, name: 'TreasureChestMedium', team: EntityTeam.ENEMY, x: damagedAt.x, y: damagedAt.y, hp: 135, maxHp: 135 });
    CombatHandler.handleCharRegen(zeus as never, buildHpDeltaPayload(570002, -135));
    assert.equal(
        EntityHandler.isChestOpened(scope, damagedAt.x, damagedAt.y),
        true,
        'a chest emptied of its health is an opened chest'
    );

    // And a joiner spawning either of them walks up to an opened one.
    const late = createFakeClient('Late', 'east-wing-signals', 15102, 1);
    attachPlayer(late);
    GlobalState.sessionsByToken.set(late.token, late as never);
    for (const [localId, at] of [[770001, destroyedAt], [770002, damagedAt]] as Array<[number, { x: number; y: number }]>) {
        late.sentPackets.length = 0;
        EntityHandler.handleEntityFullUpdate(
            late as never,
            buildClientHostileFullUpdate(localId, 'TreasureChestMedium', at.x, at.y, 1)
        );
        assert.ok(
            late.sentPackets
                .filter((packet) => packet.id === 0x78)
                .map((packet) => parseHpDelta(packet.payload))
                .some((hp) => hp.entityId === localId && hp.delta < 0),
            `a chest opened at ${at.x},${at.y} must be broken for whoever spawns it later`
        );
    }

    EntityHandler.forgetOpenedChests(scope);
    for (const client of [zeus, late]) {
        GlobalState.sessionsByToken.delete(client.token);
    }
}

// A chest is recorded where it SPAWNED, not where its reward request says it is.
//
// A capture had two chests spawn at 16546,6659 and 15104,6619, and then both of their reward
// requests arrived carrying the first coordinate. The second was recorded on top of the first,
// its own cue was never marked opened, and it stood back up for the joiner -- the chest that
// kept respawning. The spawn is the one report that cannot be confused: it comes from the cue
// that placed the chest and it names the entity.
function testAChestIsRecordedWhereItSpawned(): void {
    const zeus = createFakeClient('Zeus', 'east-wing-spawnpos', 15201, 1);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);
    EntityHandler.forgetOpenedChests(scope);
    EntityHandler.forgetPaidChestClaims(scope);
    EntityHandler.forgetChestSpawnPositions(scope);

    const first = { x: 16546, y: 6659 };
    const second = { x: 15104, y: 6619 };
    EntityHandler.handleEntityFullUpdate(zeus as never, buildClientHostileFullUpdate(580001, 'TreasureChestMedium', first.x, first.y, 1));
    EntityHandler.handleEntityFullUpdate(zeus as never, buildClientHostileFullUpdate(580002, 'TreasureChestMedium', second.x, second.y, 1));

    // Both requests arrive claiming the FIRST chest's coordinate, as they did live.
    RewardHandler.handleGrantReward(zeus as never, buildGrantRewardPayload(zeus.clientEntID, 580001, 500));
    RewardHandler.handleGrantReward(zeus as never, buildGrantRewardPayload(zeus.clientEntID, 580002, 500));

    assert.equal(EntityHandler.isChestOpened(scope, first.x, first.y), true, 'the first chest is opened');
    assert.equal(
        EntityHandler.isChestOpened(scope, second.x, second.y),
        true,
        'the second chest is recorded at its own cue, not on top of the first'
    );

    // So a joiner spawning either one walks up to an opened chest.
    const late = createFakeClient('Late', 'east-wing-spawnpos', 15202, 1);
    attachPlayer(late);
    GlobalState.sessionsByToken.set(late.token, late as never);
    late.sentPackets.length = 0;
    EntityHandler.handleEntityFullUpdate(late as never, buildClientHostileFullUpdate(780002, 'TreasureChestMedium', second.x, second.y, 1));
    assert.ok(
        late.sentPackets
            .filter((packet) => packet.id === 0x78)
            .map((packet) => parseHpDelta(packet.payload))
            .some((hp) => hp.entityId === 780002 && hp.delta < 0),
        'the second chest must be broken for a joiner too'
    );

    EntityHandler.forgetOpenedChests(scope);
    EntityHandler.forgetPaidChestClaims(scope);
    EntityHandler.forgetChestSpawnPositions(scope);
    for (const client of [zeus, late]) {
        GlobalState.sessionsByToken.delete(client.token);
    }
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
        testInitialCanonicalSendsNoVisibleServerHostiles();
    testMissingDrawnHostilesAreRedrawn();
    testStaleTrackedHostilesDoNotInflateProgress();
    testEntryDoesNotPushCarriedQuestProgress();

        resetRuntime();
        await testProxyAttachKillProgressAndLateJoiner();
    await testKillReachesTheOtherMemberAsLethalDamage();

        resetRuntime();
        testJoinerBindsBySpawnKeyNotByDistance();

        resetRuntime();
        testRefusedDuplicateCopyIsKilledOnTheClient();

        resetRuntime();
        testScopeRekeyCarriesTheRun();

        resetRuntime();
        testAPristineRosterDoesNotOutrankARunInProgress();

        resetRuntime();
        await testHitsFromAnUnseenAttackerAreNotRelayed();

        resetRuntime();
        await testCorpseCorrectionSurvivesRepeatedReports();

        resetRuntime();
        testClientReportedDeathIsAcceptedWithHealthRemaining();

        resetRuntime();
        await testOwnerDestroyCountsAsAKillOnlyWhenTheEnemyWasFought();

        resetRuntime();
        testBurialIsLethalToATinyPoolCanonical();

        resetRuntime();
        await testRewardRequestBuriesTheEnemyAndChestsPayOnce();

        resetRuntime();
        testAnOpenedChestIsOpenedForEveryoneAndPaysOnce();

        resetRuntime();
        await testAnyBreakSignalCountsAsOpeningAChest();

        resetRuntime();
        testAChestIsRecordedWhereItSpawned();

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
