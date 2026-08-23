/// <reference types="node" />

import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as path from 'path';
import { Client } from '../core/Client';
import { EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';
import { DungeonSpawnLoader } from '../data/DungeonSpawnLoader';
import { NpcLoader } from '../data/NpcLoader';
import { EntityHandler } from '../handlers/EntityHandler';
import { PacketRouter } from '../network/packetRouter';

// Tanja's clones are one enemy on two screens.
//
// A summon is not in the spawn registry, so no canonical is waiting for it and the roster matcher
// can never find one. Every client therefore kept a private clone: the death did not cross, the
// two health pools drained independently, and the server sat on a body it never sent anyone.
//
// The clone still has to be CLIENT-drawn -- each client's own boss animates it with its authored
// script, which is the only thing that gives it a brain -- so what is shared is the canonical
// behind it. The first client to report a clone mints one; the others bind to it in ARRIVAL
// ORDER. Never by position: two clones dropped at one point in one tick are identical to every
// test there is, and pairing them by where they stand is what once collapsed a whole wave onto a
// single canonical and buried it on the spot.
const DUNGEON_LEVEL = 'JC_Mini2';
// Each case gets an instance of its own: a scope is seeded with the level's roster exactly once,
// so reusing one would leave every case after the first with no authored enemies at all.
let instanceId = '';
function scope(): string {
    return getLevelScopeKey(DUNGEON_LEVEL, instanceId);
}
const BOSS_ROOM_ID = 3;
const ROSTER_CANONICAL_ID_CEILING = 925_000;

class FakeSocket extends EventEmitter {
    destroyed = false;
    readyState = 'open';
    remoteAddress = '127.0.0.1';
    remotePort = 12345;
    cork(): void {}
    uncork(): void {}
    write(): boolean { return true; }
    end(): void { this.readyState = 'closed'; }
}

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has(DUNGEON_LEVEL)) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
    if (!DungeonSpawnLoader.hasLevel(DUNGEON_LEVEL)) {
        DungeonSpawnLoader.load(dataDir);
    }
    NpcLoader.load(dataDir);
}

function createClient(name: string, token: number): Client {
    const client = new Client(new FakeSocket() as never, new PacketRouter());
    client.userId = token;
    client.character = {
        name,
        level: 50,
        xp: 0,
        CurrentLevel: { name: DUNGEON_LEVEL, x: 1000, y: 1000 }
    } as never;
    client.token = token;
    client.currentLevel = DUNGEON_LEVEL;
    client.levelInstanceId = instanceId;
    client.currentRoomId = BOSS_ROOM_ID;
    client.clientEntID = token + 1000;
    client.playerSpawned = true;
    (client as any).send = () => { /* the wire is not what this test is about */ };

    GlobalState.sessionsByToken.set(token, client);
    GlobalState.refreshSessionIndexes(client);
    return client;
}

// What the client hands the server when its own boss conjures a clone: a position, a name, and
// no health at all.
function spawnClientHostile(client: Client, localId: number, name: string, x: number, summonerId: number = 0): any {
    const entity = {
        id: localId,
        name,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        roomId: BOSS_ROOM_ID,
        x,
        y: 4756,
        clientSpawned: true,
        ownerToken: client.token,
        // What `CombatState` puts in the tenth constructor slot: the caster's id.
        summonerId: summonerId
    };
    EntityHandler.suppressServerAuthorityClientHostileSpawn(client, DUNGEON_LEVEL, entity, localId);
    return entity;
}

function boundCanonicalId(client: Client, localId: number): number {
    const local = client.entities.get(localId);
    return Math.max(0, Math.round(Number(local?.canonicalEntityId ?? local?.sharedCanonicalId ?? 0)));
}

function reset(name: string): void {
    GlobalState.sessionsByToken.clear();
    instanceId = `summon-shared-death-${name}`;
}

// The two clients' copies of one clone are one enemy on the server.
function testBothClientsBindToOneCanonical(): void {
    reset('one-canonical');
    const telahair = createClient('Telahair', 41001);
    const lanorut = createClient('Lanorut', 41002);

    spawnClientHostile(telahair, 17554009, 'ShadowPuppet', 11900);
    spawnClientHostile(lanorut, 8779412, 'ShadowPuppet', 11900);

    const telahairCanonical = boundCanonicalId(telahair, 17554009);
    const lanorutCanonical = boundCanonicalId(lanorut, 8779412);

    assert.ok(telahairCanonical > 0, 'the first client to report a clone must mint a canonical for it');
    assert.equal(
        lanorutCanonical,
        telahairCanonical,
        'the second client must bind to the canonical that already exists, not mint its own'
    );

    const canonical = GlobalState.levelEntities.get(scope())?.get(telahairCanonical);
    assert.ok(canonical, 'the canonical must live in the level map like any other shared hostile');
    assert.equal(Boolean(canonical.clientSpawned), false, 'the shared body is the server\'s, not a client\'s');
    assert.ok(
        Math.round(Number(canonical.maxHp ?? 0)) > 1,
        'the canonical must carry a real pool, or the first hit empties it'
    );
}

// A wave of two is two enemies, not one -- and the pairing across screens follows arrival order.
function testWaveIsPairedByArrivalOrder(): void {
    reset('wave-order');
    const telahair = createClient('Telahair', 42001);
    const lanorut = createClient('Lanorut', 42002);

    // Both clones land on the same spot in the same tick, which is exactly the case that used to
    // collapse them: the spawn key buckets position and a summon carries no spawn index.
    spawnClientHostile(telahair, 17554009, 'ShadowPuppet', 11900);
    spawnClientHostile(telahair, 17619545, 'ShadowPuppet', 11900);
    spawnClientHostile(lanorut, 8779412, 'ShadowPuppet', 11900);
    spawnClientHostile(lanorut, 8844948, 'ShadowPuppet', 11900);

    const first = boundCanonicalId(telahair, 17554009);
    const second = boundCanonicalId(telahair, 17619545);
    assert.ok(first > 0 && second > 0, 'both clones must be bound');
    assert.notEqual(first, second, 'two clones in one wave must never share a canonical');

    assert.equal(boundCanonicalId(lanorut, 8779412), first, 'the first clone pairs with the first');
    assert.equal(boundCanonicalId(lanorut, 8844948), second, 'the second clone pairs with the second');
}

// A second wave gets canonicals of its own rather than inheriting the first wave's.
function testSecondWaveMintsAgain(): void {
    reset('second-wave');
    const telahair = createClient('Telahair', 43001);

    spawnClientHostile(telahair, 17554009, 'ShadowPuppet', 11900);
    const firstWave = boundCanonicalId(telahair, 17554009);
    spawnClientHostile(telahair, 17619545, 'ShadowPuppet', 11900);
    const secondWave = boundCanonicalId(telahair, 17619545);

    assert.ok(firstWave > 0 && secondWave > 0, 'both waves must be bound');
    assert.notEqual(
        secondWave,
        firstWave,
        'a later clone must not be handed the canonical this client is already holding'
    );
}

// A rostered enemy still binds to the enemy the level authored, not to a minted one.
function testRosteredEnemyStillUsesItsRosterCanonical(): void {
    reset('rostered');
    const telahair = createClient('Telahair', 44001);

    spawnClientHostile(telahair, 17554009, 'ShadeWarrior', 11900);
    const canonicalId = boundCanonicalId(telahair, 17554009);

    assert.ok(canonicalId > 0, 'a rostered hostile must still bind');
    assert.ok(
        canonicalId < ROSTER_CANONICAL_ID_CEILING,
        `a rostered hostile must bind to its authored canonical, not a minted one (got ${canonicalId})`
    );
}

// The server must never DRAW a summon, or the other member gets a second, brainless clone.
//
// Reported live: one clone on Telahair's screen and two on Lanorut's. A relay from the client
// that minted the canonical lands before the other client's boss has summoned at all, and the
// relay used to answer "this viewer cannot resolve the entity" by sending it -- so Lanorut was
// handed a server-drawn body, and his own clone then bound to the same canonical beside it.
function testSummonCanonicalIsNeverDrawnToAViewer(): void {
    reset('never-drawn');
    const telahair = createClient('Telahair', 45001);
    const lanorut = createClient('Lanorut', 45002);
    const drawn: number[] = [];
    (lanorut as any).send = (id: number) => { drawn.push(id); };

    spawnClientHostile(telahair, 17554009, 'ShadowPuppet', 11900);
    const canonicalId = boundCanonicalId(telahair, 17554009);
    assert.ok(canonicalId > 0, 'the clone must have minted a canonical');

    assert.equal(
        EntityHandler.ensureEntityKnown(lanorut, DUNGEON_LEVEL, canonicalId),
        false,
        'a viewer with no copy yet must be skipped, not handed a server-drawn clone'
    );
    assert.equal(
        drawn.filter((id) => id === 0x0F).length,
        0,
        'no entity spawn may be sent for a summon canonical'
    );
    assert.equal(lanorut.entities.size, 0, 'nothing may be placed on that screen yet');

    // And once his own boss does summon, he ends up with exactly one body, bound to the same
    // canonical.
    spawnClientHostile(lanorut, 8779412, 'ShadowPuppet', 11900);
    assert.equal(boundCanonicalId(lanorut, 8779412), canonicalId, 'his own clone binds to the shared canonical');
    assert.equal(lanorut.entities.size, 1, 'one clone on his screen, not two');
}

// A summon is recognised by the caster id the client sends, not only by the roster.
//
// The roster is the weaker test in both directions: a registry that failed to load answers
// "rostered" for everything and turns every guard built on it into dead code, and a boss that
// conjures a copy of an enemy the level already lists would be merged into that enemy's canonical.
function testSummonerIdAloneMarksATransientSummon(): void {
    reset('summoner-id');
    const telahair = createClient('Telahair', 46001);

    // A name the level's own roster DOES list, conjured mid-fight by the boss.
    spawnClientHostile(telahair, 17554009, 'ShadeWarrior', 11900, 920004);
    const canonicalId = boundCanonicalId(telahair, 17554009);

    assert.ok(canonicalId > 0, 'the conjured copy must still bind to something');
    assert.ok(
        canonicalId >= ROSTER_CANONICAL_ID_CEILING,
        `a conjured body must get a minted canonical, not the roster's (got ${canonicalId})`,
    );
}

function main(): void {
    ensureDataLoaded();
    testBothClientsBindToOneCanonical();
    testWaveIsPairedByArrivalOrder();
    testSecondWaveMintsAgain();
    testRosteredEnemyStillUsesItsRosterCanonical();
    testSummonCanonicalIsNeverDrawnToAViewer();
    testSummonerIdAloneMarksATransientSummon();
    GlobalState.sessionsByToken.clear();
    console.log('east_wing_summon_shared_death_regression: ok');
}

main();
