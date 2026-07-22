/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';

// The Capstone: the boss dies, the ending skit plays, and the rank screen never
// appears. A live trace showed the run stuck on objectives_pending with the kill
// being rejected 28 times in a row:
//
//   bossHpReportRejected {"level":"AC_Mission6","entityName":"NephitSpireMarker",
//                         "currentHp":134560,"amount":-134560}
//
// AC_Mission6 was configured with NephitLargeEye. That name never appeared in the
// trace at all — the boss the client actually fights and reports is
// NephitSpireMarker, so every kill report failed isRequiredBoss and was dropped
// silently by completeRequiredBossFromClientHpReport.
//
// EntTypes lists NephitSpireMarker as EntRank Minion with HitPoints 1, which is
// nominal: it fights with 134560 HP. Marker entities are script-driven boss
// proxies, the same convention as NephitDragonMarker/DragonTempleMarker/
// PhantomKnightMarker. trash_mob_boss_alias_regression skips "*Marker" for
// exactly this reason.

const BOSS_MAX_HP = 134_560;

// The Nephit fight is multi-part and every part shares the display name "Nephit".
// NephitLargeEye is EntRank Boss, the eyes are Lieutenant and the crown is Minion.
// None of them may complete the run: the eyes die during the fight, so aliasing
// any of them would plate the summary mid-encounter.
const NEPHIT_PARTS_THAT_MUST_NOT_COMPLETE = [
    'NephitLargeEye',
    'NephitLeftEye',
    'NephitRightEye',
    'NephitCrownEye'
];

// Trash observed dying in AC_Mission6 during the reported run.
const OBSERVED_TRASH = ['SpiritDogPackmate', 'SpiritPyrFiendMini2'];

function createDead(id: number, name: string): any {
    return {
        id,
        name,
        EntName: name,
        characterName: `,${name}`,
        // Every Nephit part reports this display name.
        displayName: /^Nephit/.test(name) ? 'Nephit' : undefined,
        isPlayer: false,
        clientSpawned: false,
        team: EntityTeam.ENEMY,
        roomId: 6,
        hp: 0,
        maxHp: BOSS_MAX_HP,
        dead: true,
        destroyed: true,
        entState: EntityState.DEAD
    };
}

function cleanup(scope: string): void {
    DungeonCompletionSystem.reset(scope);
    GlobalState.levelEntities.delete(scope);
}

function defeat(levelName: string, name: string, tag: string, id: number): boolean {
    const scope = getLevelScopeKey(levelName, tag);
    const entity = createDead(id, name);
    GlobalState.levelEntities.set(scope, new Map([[entity.id, entity]]));
    DungeonCompletionSystem.noteEntityDefeated(scope, entity);
    const objectivesMet = DungeonCompletionSystem.evaluate(scope).objectivesMet;
    cleanup(scope);
    return objectivesMet;
}

function verifySpireMarkerCompletesTheRun(levelName: string, bossName: string, ordinal: number): void {
    assert.equal(
        defeat(levelName, bossName, `capstone-boss-${ordinal}`, 90_000 + ordinal),
        true,
        `${levelName}: defeating ${bossName} does not satisfy the objectives, so the ` +
        `client's kill report is dropped and the run stays on objectives_pending`
    );
}

// The Capstone gates its summary on the authored ending cinematic; the boss kill
// alone must not plate it.
function verifyEndingCutsceneStillGates(levelName: string, ordinal: number): void {
    const condition = DungeonCompletionConditions.get(levelName);
    assert.equal(
        condition?.cutscene?.requiredAfterObjectives,
        true,
        `${levelName}: no longer gates completion on its authored ending cinematic`
    );

    const scope = getLevelScopeKey(levelName, `capstone-gate-${ordinal}`);
    const boss = createDead(91_000 + ordinal, (condition?.bossGroups ?? [])[0][0]);
    GlobalState.levelEntities.set(scope, new Map([[boss.id, boss]]));
    DungeonCompletionSystem.noteEntityDefeated(scope, boss);

    const evaluation = DungeonCompletionSystem.evaluate(scope);
    assert.equal(evaluation.objectivesMet, true, `${levelName}: the boss kill did not register`);
    assert.equal(
        evaluation.ready,
        false,
        `${levelName}: the rank plate appeared before the authored ending skit ran`
    );

    cleanup(scope);
}

function verifyNephitPartsDoNotComplete(levelName: string, ordinal: number): void {
    for (const [index, name] of NEPHIT_PARTS_THAT_MUST_NOT_COMPLETE.entries()) {
        assert.equal(
            defeat(levelName, name, `capstone-part-${ordinal}-${index}`, 92_000 + ordinal * 10 + index),
            false,
            `${levelName}: killing ${name} completed the dungeon — the Nephit's eyes die ` +
            `during the fight, so this plates the summary mid-encounter`
        );
    }
}

function verifyObservedTrashDoesNotComplete(levelName: string, ordinal: number): void {
    for (const [index, name] of OBSERVED_TRASH.entries()) {
        assert.equal(
            defeat(levelName, name, `capstone-trash-${ordinal}-${index}`, 93_000 + ordinal * 10 + index),
            false,
            `${levelName}: killing ${name} completed the dungeon`
        );
    }
}

function main(): void {
    LevelConfig.load(path.resolve(__dirname, '../data'));

    verifySpireMarkerCompletesTheRun('AC_Mission6', 'NephitSpireMarker', 1);
    verifySpireMarkerCompletesTheRun('AC_Mission6Hard', 'NephitSpireMarkerHard', 2);
    // On Hard the client still reports the base name.
    verifySpireMarkerCompletesTheRun('AC_Mission6Hard', 'NephitSpireMarker', 3);

    verifyEndingCutsceneStillGates('AC_Mission6', 1);
    verifyEndingCutsceneStillGates('AC_Mission6Hard', 2);

    verifyNephitPartsDoNotComplete('AC_Mission6', 1);
    verifyNephitPartsDoNotComplete('AC_Mission6Hard', 2);

    verifyObservedTrashDoesNotComplete('AC_Mission6', 1);
    verifyObservedTrashDoesNotComplete('AC_Mission6Hard', 2);

    console.log('capstone_boss_regression: ok');
}

main();
