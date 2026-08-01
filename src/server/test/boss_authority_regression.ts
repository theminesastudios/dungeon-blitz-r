import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { EntityState, EntityTeam } from '../core/Entity';
import { getLevelScopeKey } from '../core/LevelScope';
import { getScopeRuntimeLevel, clearScopeRuntimeLevel } from '../core/RuntimeLevel';
import {
    clearBossAuthority,
    getBossAuthorityKey,
    getBossAuthorityRecord,
    noteBossEntity,
    reportBossDamage,
    syncBossAuthorityCopies
} from '../core/BossAuthority';

const LEVEL_NAME = 'JC_Mission3';
const BOSS_NAME = 'DefectorMage';
const INSTANCE_ID = 'boss-authority';

type FakeClient = {
    token: number;
    userId: number;
    character: { name: string; level: number; xp: number; CurrentLevel: { name: string; x: number; y: number } };
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    entities: Map<number, any>;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has(LEVEL_NAME)) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
}

function createFakeClient(name: string, token: number, level: number): FakeClient {
    return {
        token,
        userId: token,
        character: {
            name,
            level,
            // Keep xp at 0 so the runtime level resolves from character.level.
            xp: 0,
            CurrentLevel: { name: LEVEL_NAME, x: 1000, y: 1000 }
        },
        currentLevel: LEVEL_NAME,
        levelInstanceId: INSTANCE_ID,
        currentRoomId: 2,
        playerSpawned: true,
        clientEntID: token + 1000,
        entities: new Map<number, any>()
    };
}

function createBossCopy(id: number, roomId: number = 2): any {
    return {
        id,
        name: BOSS_NAME,
        EntName: BOSS_NAME,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entState: EntityState.ACTIVE,
        roomId,
        clientSpawned: true,
        hp: 10000,
        maxHp: 10000,
        healthDelta: 0,
        health_delta: 0,
        dead: false,
        destroyed: false
    };
}

// The pool is sized from EntTypes on first sight; every assertion below is about
// agreement between copies, never about a specific number.
function estimateMaxHp(entity: any): number {
    return Math.max(1, Math.round(Number(entity?.maxHp ?? 0)) || 1);
}

function registerBossCopy(scope: string, client: FakeClient, entityId: number): any {
    const copy = createBossCopy(entityId);
    client.entities.set(entityId, copy);
    noteBossEntity(scope, copy, estimateMaxHp);
    return copy;
}

function resetScope(scope: string, clients: FakeClient[]): void {
    clearBossAuthority(scope);
    clearScopeRuntimeLevel(scope);
    GlobalState.levelEntities.delete(scope);
    for (const client of clients) {
        GlobalState.sessionsByToken.delete(client.token);
    }
    GlobalState.partyGroups.clear();
    GlobalState.partyByMember.clear();
}

// The defect this whole module exists for: enemy scaling used to be derived from
// the asking client's own party, so two ungrouped players in one dungeon
// instance watched the same boss at two different levels — and therefore two
// different health bars.
function testScopeRuntimeLevelIgnoresPartyBoundaries(): void {
    const veteran = createFakeClient('Veteran', 41001, 50);
    const rookie = createFakeClient('Rookie', 41002, 12);
    const scope = getLevelScopeKey(LEVEL_NAME, INSTANCE_ID);
    GlobalState.sessionsByToken.set(veteran.token, veteran as never);
    GlobalState.sessionsByToken.set(rookie.token, rookie as never);

    const veteranView = getScopeRuntimeLevel(scope, veteran as never, 1);
    const rookieView = getScopeRuntimeLevel(scope, rookie as never, 1);

    assert.equal(veteranView, rookieView, 'ungrouped players in one dungeon instance must scale it identically');
    assert.equal(veteranView, 50, 'scope scaling should follow the highest level player in the instance');

    resetScope(scope, [veteran, rookie]);
}

function testScopeRuntimeLevelDoesNotFallWhenTheTopPlayerLeaves(): void {
    const veteran = createFakeClient('Veteran', 42001, 50);
    const rookie = createFakeClient('Rookie', 42002, 12);
    const scope = getLevelScopeKey(LEVEL_NAME, INSTANCE_ID);
    GlobalState.sessionsByToken.set(veteran.token, veteran as never);
    GlobalState.sessionsByToken.set(rookie.token, rookie as never);
    assert.equal(getScopeRuntimeLevel(scope, null, 1), 50, 'scope should scale to the veteran while they are present');

    GlobalState.sessionsByToken.delete(veteran.token);

    assert.equal(
        getScopeRuntimeLevel(scope, rookie as never, 1),
        50,
        'a boss must not heal mid-fight because the highest level player disconnected'
    );

    resetScope(scope, [veteran, rookie]);
}

function testEveryBossCopyLandsOnOneRecord(): void {
    const first = createFakeClient('First', 43001, 50);
    const second = createFakeClient('Second', 43002, 30);
    const scope = getLevelScopeKey(LEVEL_NAME, INSTANCE_ID);
    GlobalState.sessionsByToken.set(first.token, first as never);
    GlobalState.sessionsByToken.set(second.token, second as never);

    // Each client spawns the boss under its own local entity id.
    const firstCopy = registerBossCopy(scope, first, 500001);
    const secondCopy = registerBossCopy(scope, second, 600001);

    assert.equal(
        getBossAuthorityKey(scope, firstCopy),
        BOSS_NAME,
        'a catalogued boss should key its record by canonical name'
    );
    assert.equal(
        getBossAuthorityRecord(scope, firstCopy),
        getBossAuthorityRecord(scope, secondCopy),
        'differently numbered copies of one boss must resolve to a single record'
    );
    assert.equal(
        firstCopy.level,
        secondCopy.level,
        'every copy of a boss must be scaled at the level its dungeon instance agreed on'
    );

    resetScope(scope, [first, second]);
}

// The ledger used to live on the entity copy, so it reset every time a client
// re-registered its boss — which is what walking out of the boss room and back
// in does. The boss silently regained everything the party had taken off it.
function testDamageLedgerSurvivesCopyReregistration(): void {
    const first = createFakeClient('First', 44001, 50);
    const second = createFakeClient('Second', 44002, 50);
    const scope = getLevelScopeKey(LEVEL_NAME, INSTANCE_ID);
    GlobalState.sessionsByToken.set(first.token, first as never);
    GlobalState.sessionsByToken.set(second.token, second as never);

    const firstCopy = registerBossCopy(scope, first, 500001);
    const record = getBossAuthorityRecord(scope, firstCopy);
    assert.ok(record, 'boss record should exist after first sight');
    const maxHp = record.maxHp;

    reportBossDamage(scope, firstCopy, first.token, Math.round(maxHp * 0.4));
    assert.equal(record.hp, maxHp - Math.round(maxHp * 0.4), 'reported damage should come off the shared pool');

    // Second player walks in and registers their own copy of the same boss.
    const secondCopy = registerBossCopy(scope, second, 600001);
    assert.equal(
        getBossAuthorityRecord(scope, secondCopy)?.hp,
        maxHp - Math.round(maxHp * 0.4),
        'a copy registered mid-fight must join the run at the damage already dealt'
    );

    // And the original client re-registers after a room round trip.
    registerBossCopy(scope, first, 500001);
    assert.equal(
        record.hp,
        maxHp - Math.round(maxHp * 0.4),
        're-registering a boss copy must not restore the health the party already removed'
    );

    resetScope(scope, [first, second]);
}

function testDamageFromEveryParticipantAggregatesOnce(): void {
    const first = createFakeClient('First', 45001, 50);
    const second = createFakeClient('Second', 45002, 50);
    const scope = getLevelScopeKey(LEVEL_NAME, INSTANCE_ID);
    GlobalState.sessionsByToken.set(first.token, first as never);
    GlobalState.sessionsByToken.set(second.token, second as never);

    const firstCopy = registerBossCopy(scope, first, 500001);
    const secondCopy = registerBossCopy(scope, second, 600001);
    const record = getBossAuthorityRecord(scope, firstCopy);
    assert.ok(record, 'boss record should exist after first sight');
    const maxHp = record.maxHp;

    const firstResult = reportBossDamage(scope, firstCopy, first.token, Math.floor(maxHp / 2));
    assert.equal(firstResult?.killed, false, 'half the pool from one player must not finish the boss');

    const secondResult = reportBossDamage(scope, secondCopy, second.token, maxHp);
    assert.equal(secondResult?.killed, true, 'the pool emptying should be reported as the kill exactly once');
    assert.equal(record.hp, 0, 'an emptied pool leaves the boss at zero for the whole instance');

    const repeatResult = reportBossDamage(scope, firstCopy, first.token, maxHp);
    assert.equal(repeatResult?.killed, false, 'a boss must only be killed once, however many reports arrive after');

    resetScope(scope, [first, second]);
}

// "It ends for everyone": the death is a property of the run, so it reaches
// viewers whose copy nobody hit and whose local id nothing matched.
function testDeathReachesEveryViewerCopy(): void {
    const killer = createFakeClient('Killer', 46001, 50);
    const bystander = createFakeClient('Bystander', 46002, 50);
    const scope = getLevelScopeKey(LEVEL_NAME, INSTANCE_ID);
    GlobalState.sessionsByToken.set(killer.token, killer as never);
    GlobalState.sessionsByToken.set(bystander.token, bystander as never);

    const killerCopy = registerBossCopy(scope, killer, 500001);
    // The bystander's copy sits in a different room at a different id, so the
    // position-and-name copy sweep would not match it.
    const bystanderCopy = createBossCopy(600001, 9);
    bystander.entities.set(600001, bystanderCopy);
    noteBossEntity(scope, bystanderCopy, estimateMaxHp);

    const record = getBossAuthorityRecord(scope, killerCopy);
    assert.ok(record, 'boss record should exist after first sight');
    reportBossDamage(scope, killerCopy, killer.token, record.maxHp);
    syncBossAuthorityCopies(scope, record);

    assert.equal(killerCopy.dead, true, "the killer's copy should be dead");
    assert.equal(bystanderCopy.dead, true, 'a boss death must reach every viewer, not just the room that landed the hit');

    resetScope(scope, [killer, bystander]);
}

function testFreshRunClearsTheRecord(): void {
    const player = createFakeClient('Player', 47001, 50);
    const scope = getLevelScopeKey(LEVEL_NAME, INSTANCE_ID);
    GlobalState.sessionsByToken.set(player.token, player as never);

    const copy = registerBossCopy(scope, player, 500001);
    const record = getBossAuthorityRecord(scope, copy);
    assert.ok(record, 'boss record should exist after first sight');
    reportBossDamage(scope, copy, player.token, record.maxHp);
    assert.equal(record.dead, true, 'boss should be dead before the run is reset');

    clearBossAuthority(scope);
    assert.equal(getBossAuthorityRecord(scope, copy), null, 'a reset run must not inherit the previous run boss record');

    const freshCopy = registerBossCopy(scope, player, 500001);
    assert.equal(
        getBossAuthorityRecord(scope, freshCopy)?.dead,
        false,
        'a fresh run should start its boss alive at full health'
    );

    resetScope(scope, [player]);
}

function main(): void {
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const partyGroups = new Map(GlobalState.partyGroups);
    const partyByMember = new Map(GlobalState.partyByMember);
    const levelEntities = new Map(GlobalState.levelEntities);

    ensureDataLoaded();
    try {
        GlobalState.sessionsByToken.clear();
        GlobalState.partyGroups.clear();
        GlobalState.partyByMember.clear();
        GlobalState.levelEntities.clear();

        testScopeRuntimeLevelIgnoresPartyBoundaries();
        testScopeRuntimeLevelDoesNotFallWhenTheTopPlayerLeaves();
        testEveryBossCopyLandsOnOneRecord();
        testDamageLedgerSurvivesCopyReregistration();
        testDamageFromEveryParticipantAggregatesOnce();
        testDeathReachesEveryViewerCopy();
        testFreshRunClearsTheRecord();
        console.log('boss_authority_regression: ok');
    } finally {
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.partyGroups = partyGroups;
        GlobalState.partyByMember = partyByMember;
        GlobalState.levelEntities = levelEntities;
    }
}

main();
