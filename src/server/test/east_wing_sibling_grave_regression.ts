import { strict as assert } from 'assert';
import path from 'path';
import { LevelConfig } from '../core/LevelConfig';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { EntityHandler } from '../handlers/EntityHandler';
import { EntityTeam } from '../core/Entity';

// One enemy dying must not bury the identical enemy standing next to it.
//
// The East Wing rooms hold several copies of the same type and they walk around. Tombstones
// were matched by `name:roomId:x/100:y/100` computed from where a body is standing right now,
// so a living ShadeWarrior that wandered into the box where another ShadeWarrior had died
// inherited that grave: `isCanonicalHostileTerminal` called it dead and the proxy correction
// destroyed it with `dealt=0` -- never hit, never fought. Reported from the live server as
// enemies executing themselves without the player landing the last hit.

const SCOPE = 'JC_Mini2#sibling-grave';

function makeHostile(id: number, name: string, x: number, y: number): any {
    return {
        id,
        name,
        team: EntityTeam.ENEMY,
        roomId: 3,
        x,
        y,
        hp: 6076,
        maxHp: 6076,
        clientSpawned: false,
        isPlayer: false
    };
}

function seedScope(entities: any[]): void {
    const map = new Map<number, any>();
    for (const entity of entities) {
        map.set(entity.id, entity);
    }
    GlobalState.levelEntities.set(SCOPE, map);
}

function testSiblingGraveDoesNotBuryLivingEnemy(): void {
    const killed = makeHostile(920011, 'ShadeWarrior', 1200, 400);
    // The survivor has walked onto almost the same spot: same name, same room, same 100px box.
    const survivor = makeHostile(920007, 'ShadeWarrior', 1240, 430);
    seedScope([killed, survivor]);

    killed.hp = 0;
    killed.dead = true;
    killed.destroyed = true;
    EntityHandler.noteServerAuthorityHostileDestroyed(SCOPE, killed.id, killed, 0);

    assert.ok(
        EntityHandler.findDeadServerAuthorityHostileTombstone(SCOPE, killed),
        'the enemy that actually died must still resolve to its own grave'
    );
    assert.equal(
        EntityHandler.findDeadServerAuthorityHostileTombstone(SCOPE, survivor),
        null,
        'a living enemy standing where its twin died must not inherit that grave'
    );
    assert.equal(
        Math.round(Number(survivor.hp)),
        6076,
        'the survivor must be untouched'
    );
}

function testOwnGraveStillResolvesAfterTheBodyMoves(): void {
    const hostile = makeHostile(920020, 'Ghoul', 800, 200);
    seedScope([hostile]);

    hostile.hp = 0;
    hostile.dead = true;
    hostile.destroyed = true;
    EntityHandler.noteServerAuthorityHostileDestroyed(SCOPE, hostile.id, hostile, 0);

    // Its recorded position drifts, so the positional fingerprint no longer matches. Identity
    // still does, which is the whole point of matching on the canonical id.
    hostile.x = 2400;
    hostile.y = 900;
    const tombstone = EntityHandler.findDeadServerAuthorityHostileTombstone(SCOPE, hostile);
    assert.ok(tombstone, 'an enemy must keep resolving to its own grave after its position moves');
    assert.equal(
        Math.max(0, Math.round(Number(tombstone?.canonicalId ?? 0))),
        920020,
        'the grave found must be the one belonging to this enemy'
    );
}

function testUnknownProxyStillMatchesPositionally(): void {
    const canonical = makeHostile(920030, 'BoneFiend', 500, 100);
    seedScope([canonical]);

    canonical.hp = 0;
    canonical.dead = true;
    canonical.destroyed = true;
    EntityHandler.noteServerAuthorityHostileDestroyed(SCOPE, canonical.id, canonical, 0);

    // A client's own copy of that same body: an id the scope has never heard of. Nothing
    // identifies it, so the positional fallback is the only thing that can, and it must stay.
    const clientProxy = makeHostile(14791768, 'BoneFiend', 500, 100);
    assert.ok(
        EntityHandler.findDeadServerAuthorityHostileTombstone(SCOPE, clientProxy),
        'a client copy the scope cannot identify must still be matched to the grave by position'
    );
}

function main(): void {
    const dataDir = path.resolve(__dirname, '../data');
    LevelConfig.load(dataDir);
    GameData.load(dataDir);

    const levelEntities = new Map(GlobalState.levelEntities);
    try {
        testSiblingGraveDoesNotBuryLivingEnemy();
        GlobalState.deadServerAuthorityHostilesByScope.delete(SCOPE);
        testOwnGraveStillResolvesAfterTheBodyMoves();
        GlobalState.deadServerAuthorityHostilesByScope.delete(SCOPE);
        testUnknownProxyStillMatchesPositionally();
        console.log('east_wing_sibling_grave_regression: ok');
    } finally {
        GlobalState.levelEntities.clear();
        for (const [key, value] of levelEntities) {
            GlobalState.levelEntities.set(key, value);
        }
        GlobalState.deadServerAuthorityHostilesByScope.delete(SCOPE);
    }
}

main();
