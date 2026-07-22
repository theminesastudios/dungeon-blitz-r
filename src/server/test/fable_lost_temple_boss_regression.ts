/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';

// Fable of the Lost Temple: the boss dies, the ending skit plays, and the rank
// screen never appears. A live trace showed the run sitting on
// objectives_pending — the gate was never the problem, the boss kill simply
// never registered:
//
//   bossHpReportRejected {"level":"JC_Mission5","entityName":"PhantomKnight1",
//                         "currentHp":269120,"amount":-269120}
//
// JC_Mission5 was configured with NephitDragon as its boss, so every kill report
// for the real boss failed isRequiredBoss and was dropped silently by
// completeRequiredBossFromClientHpReport with no log line at all.
//
// The level's manifest in dungeon_enemy_elements.json is unusable here: it lists
// Dream* wisps and NephitDragon, while the level actually spawns Valhaven undead
// (Ghoul2, AbyssalStinger, ShadeSummoner, PhantomKnight1) — none of which appear
// in ANY level's manifest. LevelsJC.swf has no am_Boss in a_Room_JCMission5_*,
// only am_MiniBoss, and defines ac_PhantomKnight1..3 + ac_PhantomKnightMarker.

// Names observed dying in JC_Mission5 during the reported run. None may complete
// the dungeon: doing so is what made Unearthing the Past plate at 7%.
//
// PhantomKnight1/2/3 are in this list deliberately. A full trace showed four
// distinct entity ids, each at 269120 HP, dying in order: PhantomKnight1,
// PhantomKnight3, PhantomKnight2, then PhantomKnightMarker — which the client
// then re-reported ~20 times because the server kept rejecting it. They are four
// separate encounters, not variants of one boss, and the Marker is the last.
// Aliasing 1/2/3 onto the boss would end the dungeon at the first knight.
const OBSERVED_TRASH = [
    'Ghoul2',
    'AbyssalStinger',
    'ShadeSummoner',
    'PhantomKnight1',
    'PhantomKnight2',
    'PhantomKnight3'
];

function createDead(id: number, name: string): any {
    return {
        id,
        name,
        EntName: name,
        characterName: `,${name}`,
        isPlayer: false,
        clientSpawned: false,
        team: EntityTeam.ENEMY,
        roomId: 12,
        hp: 0,
        maxHp: 269_120,
        dead: true,
        destroyed: true,
        entState: EntityState.DEAD
    };
}

function cleanup(scope: string): void {
    DungeonCompletionSystem.reset(scope);
    GlobalState.levelEntities.delete(scope);
}

function verifyPhantomKnightCompletesTheRun(levelName: string, bossName: string, ordinal: number): void {
    const scope = getLevelScopeKey(levelName, `fable-boss-${ordinal}`);
    const boss = createDead(80_000 + ordinal, bossName);

    GlobalState.levelEntities.set(scope, new Map([[boss.id, boss]]));
    DungeonCompletionSystem.noteEntityDefeated(scope, boss);

    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        true,
        `${levelName}: defeating ${bossName} does not satisfy the objectives, so the ` +
        `kill is dropped and the run stays on objectives_pending`
    );

    cleanup(scope);
}

// Every name the client reported for the boss must resolve, or the HP-report
// path silently drops the kill again.
function verifyReportedBossNamesResolve(levelName: string, canonical: string): void {
    const reported = levelName.endsWith('Hard')
        ? ['PhantomKnightMarker', 'PhantomKnightMarkerHard']
        : ['PhantomKnightMarker'];

    for (const name of reported) {
        assert.equal(
            DungeonCompletionConditions.getCanonicalBossName(levelName, {
                id: 1,
                name,
                characterName: `,${name}`
            }),
            canonical,
            `${levelName}: boss reported as ${name} does not resolve to ${canonical}, ` +
            `so completeRequiredBossFromClientHpReport drops the kill`
        );
    }
}

// The trash the player clears on the way must never end the dungeon.
function verifyObservedTrashDoesNotComplete(levelName: string, ordinal: number): void {
    for (const [index, name] of OBSERVED_TRASH.entries()) {
        const scope = getLevelScopeKey(levelName, `fable-trash-${ordinal}-${index}`);
        const mob = createDead(81_000 + ordinal * 10 + index, name);

        GlobalState.levelEntities.set(scope, new Map([[mob.id, mob]]));
        DungeonCompletionSystem.noteEntityDefeated(scope, mob);

        assert.equal(
            DungeonCompletionSystem.evaluate(scope).objectivesMet,
            false,
            `${levelName}: killing ${name} completed the dungeon`
        );

        cleanup(scope);
    }
}

// NephitDragon belongs to a different dungeon; it must no longer gate this one.
function verifyNephitDragonNoLongerGatesTheRun(levelName: string): void {
    const condition = DungeonCompletionConditions.get(levelName);
    const configured = JSON.stringify([
        ...(condition?.bossGroups ?? []).flat(),
        ...Object.keys(condition?.bossAliases ?? {})
    ]);

    assert.ok(
        !/NephitDragon/.test(configured),
        `${levelName}: still expects a NephitDragon, which this level never spawns`
    );
}

function main(): void {
    LevelConfig.load(path.resolve(__dirname, '../data'));

    verifyPhantomKnightCompletesTheRun('JC_Mission5', 'PhantomKnightMarker', 1);
    verifyPhantomKnightCompletesTheRun('JC_Mission5Hard', 'PhantomKnightMarkerHard', 2);
    verifyReportedBossNamesResolve('JC_Mission5', 'PhantomKnightMarker');
    verifyReportedBossNamesResolve('JC_Mission5Hard', 'PhantomKnightMarkerHard');
    verifyObservedTrashDoesNotComplete('JC_Mission5', 1);
    verifyObservedTrashDoesNotComplete('JC_Mission5Hard', 2);
    verifyNephitDragonNoLongerGatesTheRun('JC_Mission5');
    verifyNephitDragonNoLongerGatesTheRun('JC_Mission5Hard');

    console.log('fable_lost_temple_boss_regression: ok');
}

main();
