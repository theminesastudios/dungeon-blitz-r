/// <reference types="node" />

import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as path from 'path';
import { Client } from '../core/Client';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';
import { DungeonSpawnLoader } from '../data/DungeonSpawnLoader';
import { CombatHandler } from '../handlers/CombatHandler';
import { PacketRouter } from '../network/packetRouter';

// A dead player must not keep hold of a shared hostile's action authority.
//
// The authority is latched on the first hit and never moves, and every cast or action from any
// other client is dropped server-side. That is right while the holder is fighting. It is wrong the
// moment they die: their client stops driving the boss -- there is no living target on that screen
// -- so no casts come from the only session allowed to send them, while the survivor's are refused.
// The boss then acts on exactly one screen and the two stop sharing anything.
//
// Reported live in The East Wing: the two members' clones tracked each other until Lanorut died,
// and diverged from that moment.
const DUNGEON_LEVEL = 'JC_Mini2';
const INSTANCE_ID = 'authority-release';
const SCOPE = getLevelScopeKey(DUNGEON_LEVEL, INSTANCE_ID);
const BOSS_ROOM_ID = 3;

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
    client.levelInstanceId = INSTANCE_ID;
    client.currentRoomId = BOSS_ROOM_ID;
    client.clientEntID = token + 1000;
    client.playerSpawned = true;
    (client as any).send = () => { /* the wire is not what this test is about */ };

    // A living body, so `isPlayerDeadForCombat` says no.
    client.entities.set(client.clientEntID, {
        id: client.clientEntID,
        isPlayer: true,
        name,
        team: 1,
        hp: 91040,
        maxHp: 91040,
        entState: EntityState.ACTIVE,
        roomId: BOSS_ROOM_ID
    });

    GlobalState.sessionsByToken.set(token, client);
    GlobalState.refreshSessionIndexes(client);
    return client;
}

function kill(client: Client): void {
    const body = client.entities.get(client.clientEntID);
    body.hp = 0;
    body.dead = true;
    body.entState = EntityState.DEAD;
}

// The room boss, as the run holds it: server-owned, party-shared, no owner token of its own.
function makeBoss(): any {
    return {
        id: 920004,
        name: 'TowerGuard2',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        roomId: BOSS_ROOM_ID,
        x: 11977,
        y: 4756,
        hp: 110700,
        maxHp: 110700,
        clientSpawned: true,
        boss: true,
        roomBoss: true,
        isRoomBoss: true
    };
}

function seed(boss: any): void {
    GlobalState.levelEntities.set(SCOPE, new Map<number, any>([[boss.id, boss]]));
}

function suppressed(client: Client, boss: any): boolean {
    return (CombatHandler as any).shouldSuppressNonAuthorityPartySharedHostileAction(client, SCOPE, boss);
}

function assign(boss: any, client: Client): void {
    (CombatHandler as any).assignPartySharedHostileCombatAuthority(SCOPE, boss, client);
}

function reset(): void {
    GlobalState.sessionsByToken.clear();
    GlobalState.levelEntities.delete(SCOPE);
}

// While the holder is alive the latch does its job: one client speaks for the boss.
function testLivingAuthorityStillSilencesTheOther(): void {
    reset();
    const lanorut = createClient('Lanorut', 51001);
    const telahair = createClient('Telahair', 51002);
    const boss = makeBoss();
    seed(boss);

    assign(boss, lanorut);

    assert.equal(suppressed(lanorut, boss), false, 'the holder always speaks');
    assert.equal(suppressed(telahair, boss), true, 'while the holder is fighting, the other is silent');
}

// The latch is sticky on purpose, so a second member hitting the boss must not steal it.
function testAuthorityDoesNotFlapBetweenLivingMembers(): void {
    reset();
    const lanorut = createClient('Lanorut', 52001);
    const telahair = createClient('Telahair', 52002);
    const boss = makeBoss();
    seed(boss);

    assign(boss, lanorut);
    assign(boss, telahair);

    assert.equal(suppressed(telahair, boss), true, 'a later hit must not take the latch off a living holder');
}

// ...and it must let go the moment the holder cannot act.
function testDeadAuthorityStopsSilencingTheSurvivor(): void {
    reset();
    const lanorut = createClient('Lanorut', 53001);
    const telahair = createClient('Telahair', 53002);
    const boss = makeBoss();
    seed(boss);

    assign(boss, lanorut);
    assert.equal(suppressed(telahair, boss), true, 'precondition: Lanorut holds it');

    kill(lanorut);

    assert.equal(
        suppressed(telahair, boss),
        false,
        "a dead holder must not silence the member who is still fighting"
    );

    // And the next hit re-latches onto the survivor, so the boss has a real owner again.
    assign(boss, telahair);
    assert.equal(
        Math.round(Number(boss.combatAuthorityToken)),
        telahair.token,
        'the survivor takes the latch once the dead holder has released it'
    );
}

// A holder who left the scope entirely is just as unable to drive it.
function testAuthorityFromAnotherScopeIsReleased(): void {
    reset();
    const lanorut = createClient('Lanorut', 54001);
    const telahair = createClient('Telahair', 54002);
    const boss = makeBoss();
    seed(boss);

    assign(boss, lanorut);
    lanorut.levelInstanceId = 'somewhere-else';
    GlobalState.refreshSessionIndexes(lanorut);

    assert.equal(
        suppressed(telahair, boss),
        false,
        'a holder who walked out of the run must not silence the one still in it'
    );
}

function main(): void {
    ensureDataLoaded();
    testLivingAuthorityStillSilencesTheOther();
    testAuthorityDoesNotFlapBetweenLivingMembers();
    testDeadAuthorityStopsSilencingTheSurvivor();
    testAuthorityFromAnotherScopeIsReleased();
    reset();
    console.log('shared_hostile_authority_release_regression: ok');
}

main();
