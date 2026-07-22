/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';

// Every level here was reported as "the boss dies but the rank screen never
// appears". They all gate the summary on an authored ending cinematic, which is
// where the run stalled.
const REPORTED_ENDING_GATE_LEVELS = [
    'DreamDragonDungeon',
    'DreamDragonDungeonHard',
    'OMM_Mission2',
    'OMM_Mission2Hard',
    'OMM_Mission5',
    'OMM_Mission5Hard',
    'OMM_Mission7',
    'OMM_Mission7Hard',
    'OMM_Mission8',
    'OMM_Mission8Hard',
    'BT_Mission3',
    'BT_Mission3Hard',
    'JC_Mission9',
    'JC_Mission9Hard',
    'EG_Mission1',
    'EG_Mission1Hard'
] as const;

function createBoss(id: number, name: string, roomId: number): any {
    return {
        id,
        name,
        EntName: name,
        characterName: `,${name}`,
        clientSpawned: false,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        roomId,
        hp: 0,
        maxHp: 1000,
        dead: true,
        destroyed: true,
        entState: EntityState.DEAD
    };
}

function createBossScope(levelName: string, suffix: string, ordinal: number): {
    scope: string;
    bosses: any[];
} {
    const condition = DungeonCompletionConditions.get(levelName);
    assert(condition, `${levelName}: missing completion condition`);
    assert.equal(
        condition.cutscene?.requiredAfterObjectives,
        true,
        `${levelName}: no longer gates completion on its authored ending cinematic`
    );

    const scope = getLevelScopeKey(levelName, `${suffix}-${ordinal}`);
    const bosses = (condition.bossGroups ?? []).map((group, index) =>
        createBoss(80_000 + ordinal * 10 + index, group[0], 7)
    );
    GlobalState.levelEntities.set(scope, new Map(bosses.map((boss) => [boss.id, boss])));
    return { scope, bosses };
}

function cleanup(scope: string): void {
    DungeonCompletionSystem.reset(scope);
    GlobalState.levelEntities.delete(scope);
}

// A skit whose close was never matched back to its own room stays marked active
// in the shared run state forever. The ending cinematic then closes against a
// gate that can never open on its own, and the run used to sit there until its
// completion was dropped outright. The observed close is proof the cinematic is
// gone, so it must release the summary.
function verifyStaleCutsceneDoesNotStrandTheRankScreen(levelName: string, ordinal: number): void {
    const { scope, bosses } = createBossScope(levelName, 'stale-cutscene', ordinal);
    const simultaneousWindowMs = DungeonCompletionConditions.getSimultaneousBossWindowMs(levelName);

    // A mid-dungeon skit that never reports its own close.
    DungeonCompletionSystem.noteCutsceneStart(scope, 3, 1000);

    bosses.forEach((boss, index) => DungeonCompletionSystem.noteEntityDefeated(scope, boss, 1010 + index));
    const afterBosses = DungeonCompletionSystem.evaluate(scope, 1020);
    assert.equal(
        afterBosses.objectivesMet,
        true,
        `${levelName}: the authored bosses did not satisfy the objectives (window ${simultaneousWindowMs}ms)`
    );

    DungeonCompletionSystem.noteCutsceneStart(scope, 7, 1030, true);
    assert.equal(
        DungeonCompletionSystem.noteCutsceneEnd(scope, 7, 1040),
        false,
        `${levelName}: the stranded-cutscene scenario no longer reproduces`
    );
    assert.equal(
        DungeonCompletionSystem.evaluate(scope, 1041).reason,
        'cutscene_gate_pending',
        `${levelName}: the run stalled on something other than the cutscene gate`
    );

    assert.equal(
        DungeonCompletionSystem.releaseCutsceneGateOnClose(scope, 1042),
        true,
        `${levelName}: the ending cutscene close did not release the rank screen`
    );
    assert.equal(
        DungeonCompletionSystem.getState(scope)?.cutsceneFallbackReason,
        'close-observed',
        `${levelName}: the close release was not recorded`
    );

    cleanup(scope);
}

// The release is driven by an observed close, never by the gate itself: a
// cinematic still on screen must keep gating the summary.
function verifyActiveCinematicStillGatesTheSummary(levelName: string, ordinal: number): void {
    const { scope, bosses } = createBossScope(levelName, 'active-cinematic', ordinal);

    bosses.forEach((boss, index) => DungeonCompletionSystem.noteEntityDefeated(scope, boss, 2000 + index));
    DungeonCompletionSystem.noteCutsceneStart(scope, 7, 2100, true);
    assert.equal(
        DungeonCompletionSystem.evaluate(scope, 2101).ready,
        false,
        `${levelName}: the rank plate appeared underneath a running ending cinematic`
    );

    cleanup(scope);
}

// An unfinished dungeon must not be completed by a closing skit.
function verifyCloseCannotCompleteAnUnfinishedRun(levelName: string, ordinal: number): void {
    const { scope } = createBossScope(levelName, 'unfinished-run', ordinal);
    GlobalState.levelEntities.set(scope, new Map());

    DungeonCompletionSystem.noteCutsceneStart(scope, 7, 3000);
    assert.equal(
        DungeonCompletionSystem.releaseCutsceneGateOnClose(scope, 3010),
        false,
        `${levelName}: a cutscene close completed a run whose bosses were still alive`
    );
    assert.equal(
        DungeonCompletionSystem.getState(scope)?.cutsceneFallbackReason,
        '',
        `${levelName}: a pre-objective cutscene close armed the gate release`
    );

    cleanup(scope);
}

function main(): void {
    LevelConfig.load(path.resolve(__dirname, '../data'));
    REPORTED_ENDING_GATE_LEVELS.forEach((levelName, ordinal) => {
        verifyStaleCutsceneDoesNotStrandTheRankScreen(levelName, ordinal + 1);
        verifyActiveCinematicStillGatesTheSummary(levelName, ordinal + 101);
        verifyCloseCannotCompleteAnUnfinishedRun(levelName, ordinal + 201);
    });
    console.log('dungeon_ending_cutscene_close_completion_regression: ok');
}

main();
