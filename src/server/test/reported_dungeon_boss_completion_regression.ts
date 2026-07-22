/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';

// Every dungeon reported as "the boss dies but the rank plate never appears".
// The Hard variants matter as much as the normal ones: a Hard run whose boss is
// reported under its base name was dropped outright, so the objectives were
// never met and no gate release could save the run.
const REPORTED_LEVELS = [
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
    'JC_Mission5',
    'JC_Mission5Hard',
    'JC_Mission9',
    'JC_Mission9Hard',
    'JC_Mission10',
    'JC_Mission10Hard',
    'EG_Mission1',
    'EG_Mission1Hard',
    'SD_Mission1',
    'SD_Mission1Hard',
    'AC_Mission3',
    'AC_Mission3Hard',
    // Reported as already working, but they carried the same missing base-name
    // alias, so they were one stray client name away from the same silent drop.
    'AC_Mission1',
    'AC_Mission1Hard',
    'GoblinRiverDungeon',
    'GoblinRiverDungeonHard',
    'SwampRoadConnectionMission',
    'SwampRoadConnectionMissionHard',
    'TutorialDungeon',
    'TutorialDungeonHard'
] as const;

// Entities that share a boss name prefix but must never satisfy the objectives:
// minions, portals and projectiles. Widening the boss aliases must not drag them
// in, or a dungeon would end the moment an add died.
const NON_BOSS_LOOKALIKES: Record<string, string[]> = {
    AC_Mission1: ['AncientDragonGoldMini'],
    AC_Mission1Hard: ['AncientDragonGoldMini', 'AncientDragonGoldMiniHard'],
    // The three numbered Phantom Knights are separate earlier fights in Fable of
    // the Lost Temple. Aliasing any of them onto the boss would end the run at
    // the first knight instead of at PhantomKnightMarker.
    JC_Mission5: ['PhantomKnight1', 'PhantomKnight2', 'PhantomKnight3'],
    JC_Mission5Hard: ['PhantomKnight1', 'PhantomKnight2', 'PhantomKnight3'],
    JC_Mission10: ['DragonTempleFlare'],
    JC_Mission10Hard: ['DragonTempleFlare', 'DragonTempleFlareHard']
};

// Bosses the client can report under a name the level's own bossGroups do not
// spell: the authored room-boss marker, and — on Hard — the base entity name.
// Each entry must resolve to the level's canonical boss or the kill is dropped.
const EXTRA_BOSS_NAMES: Record<string, string[]> = {
    // Fable of the Lost Temple's boss is PhantomKnightMarker, not NephitDragon.
    // The numbered knights are earlier encounters and belong in
    // NON_BOSS_LOOKALIKES, not here.
    JC_Mission5Hard: ['PhantomKnightMarker'],
    JC_Mission10: ['DragonTempleMarker'],
    JC_Mission10Hard: ['DragonTemple', 'DragonTempleMarker', 'DragonTempleMarkerHard'],
    // Was ['RaptorHornedGreater'] / ['RaptorHorned', 'RaptorHornedGreaterHard'],
    // which treated ordinary desert raptors (EntRank Minion/Lieutenant) as
    // Unearthing the Past's boss and completed the run on the first trash kill.
    // The boss is RageGuardian, which the client also reports as "Amenrahtep".
    SD_Mission1: ['Amenrahtep'],
    SD_Mission1Hard: ['RageGuardian', 'Amenrahtep']
};

function createBoss(id: number, name: string, roomId: number, defeated: boolean = true): any {
    return {
        id,
        name,
        EntName: name,
        characterName: `,${name}`,
        clientSpawned: false,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        roomId,
        hp: defeated ? 0 : 1000,
        maxHp: 1000,
        dead: defeated,
        destroyed: defeated,
        entState: defeated ? EntityState.DEAD : EntityState.ACTIVE
    };
}

function getCondition(levelName: string) {
    const condition = DungeonCompletionConditions.get(levelName);
    assert(condition, `${levelName}: missing completion condition`);
    assert.equal(condition.mode, 'bosses', `${levelName}: no longer completes on its bosses`);
    return condition;
}

// `bosses` is everything the run must defeat to meet its objectives: the boss of
// each group, plus any authored non-boss objective (Goblin Kidnappers also wants
// Anna's chains broken), so a level with extra objectives is driven to a genuine
// completion rather than stalling short of it.
function createBossScope(levelName: string, suffix: string, ordinal: number): {
    scope: string;
    bosses: any[];
} {
    const condition = getCondition(levelName);
    const scope = getLevelScopeKey(levelName, `${suffix}-${ordinal}`);
    const bosses = [
        ...(condition.bossGroups ?? []).map((group) => group[0]),
        ...(condition.entityObjectives ?? []).map((objective) => objective.names[0])
    ].map((name, index) => createBoss(70_000 + ordinal * 10 + index, name, 7));
    GlobalState.levelEntities.set(scope, new Map(bosses.map((boss) => [boss.id, boss])));
    return { scope, bosses };
}

function cleanup(scope: string): void {
    DungeonCompletionSystem.reset(scope);
    GlobalState.levelEntities.delete(scope);
}

// A Hard run whose boss arrives under its base name, and any run whose boss
// arrives as the authored room-boss marker, must still resolve to the level's
// canonical boss. An unresolved name is a silently dropped kill: the objectives
// never complete and the dungeon can never hand out its rank plate.
function verifyReportedBossNamesResolve(levelName: string): void {
    const condition = getCondition(levelName);
    const canonicalBosses = new Set((condition.bossGroups ?? []).flat());

    for (const canonical of canonicalBosses) {
        assert.equal(
            DungeonCompletionConditions.getCanonicalBossName(levelName, createBoss(1, canonical, 7), ''),
            canonical,
            `${levelName}: its own boss ${canonical} is no longer recognized`
        );
    }

    if (levelName.endsWith('Hard')) {
        for (const canonical of canonicalBosses) {
            const baseName = canonical.replace(/Hard$/, '');
            if (baseName === canonical) {
                continue;
            }
            assert.equal(
                DungeonCompletionConditions.getCanonicalBossName(levelName, createBoss(1, baseName, 7), ''),
                canonical,
                `${levelName}: a boss reported as ${baseName} is dropped instead of counting as ${canonical}`
            );
        }
    }

    for (const name of EXTRA_BOSS_NAMES[levelName] ?? []) {
        const resolved = DungeonCompletionConditions.getCanonicalBossName(levelName, createBoss(1, name, 7), '');
        assert(
            canonicalBosses.has(resolved),
            `${levelName}: boss reported as ${name} is dropped instead of counting as a required boss`
        );
    }

    for (const name of NON_BOSS_LOOKALIKES[levelName] ?? []) {
        assert.equal(
            DungeonCompletionConditions.getCanonicalBossName(levelName, createBoss(1, name, 7), ''),
            '',
            `${levelName}: ${name} counts as the boss, so an add can end the run`
        );
    }
}

// With the bosses down, the client's cutscene close is the "skit finished and
// the cinematic is gone" signal, so the rank plate is what comes next — even
// when the close cannot be matched back to the room it was opened against.
function verifyCutsceneCloseShowsTheRankScreen(levelName: string, ordinal: number): void {
    const { scope, bosses } = createBossScope(levelName, 'ending-close', ordinal);

    // A mid-dungeon skit that never reports its own close, so the ending close
    // lands against a gate that cannot open on its own.
    DungeonCompletionSystem.noteCutsceneStart(scope, 3, 1000);

    bosses.forEach((boss, index) => DungeonCompletionSystem.noteEntityDefeated(scope, boss, 1010 + index));
    assert.equal(
        DungeonCompletionSystem.evaluate(scope, 1020).objectivesMet,
        true,
        `${levelName}: the authored bosses did not satisfy the objectives`
    );

    DungeonCompletionSystem.noteCutsceneStart(scope, 7, 1030, true);
    assert.equal(
        DungeonCompletionSystem.evaluate(scope, 1031).reason,
        'cutscene_gate_pending',
        `${levelName}: the run stalled on something other than the cutscene gate`
    );

    DungeonCompletionSystem.noteCutsceneEnd(scope, 7, 1040);
    assert.equal(
        DungeonCompletionSystem.releaseCutsceneGateOnClose(scope, 1041),
        true,
        `${levelName}: the ending cutscene close did not release the rank screen`
    );

    cleanup(scope);
}

// The plate is released by an observed close, never by the gate itself: a
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

// The widened boss names must not end a run early: a boss that is still alive
// cannot complete the dungeon, however it is named.
function verifyLiveBossCannotCompleteTheRun(levelName: string, ordinal: number): void {
    const condition = getCondition(levelName);
    const scope = getLevelScopeKey(levelName, `live-boss-${ordinal}`);
    const liveBosses = (condition.bossGroups ?? []).map((group, index) =>
        createBoss(75_000 + ordinal * 10 + index, group[0].replace(/Hard$/, ''), 7, false)
    );
    GlobalState.levelEntities.set(scope, new Map(liveBosses.map((boss) => [boss.id, boss])));

    assert.equal(
        DungeonCompletionSystem.evaluate(scope, 3000).objectivesMet,
        false,
        `${levelName}: a live boss satisfied the objectives`
    );
    assert.equal(
        DungeonCompletionSystem.releaseCutsceneGateOnClose(scope, 3010),
        false,
        `${levelName}: a cutscene close completed a run whose bosses were still alive`
    );

    cleanup(scope);
}

function main(): void {
    LevelConfig.load(path.resolve(__dirname, '../data'));
    REPORTED_LEVELS.forEach((levelName, ordinal) => {
        verifyReportedBossNamesResolve(levelName);
        verifyCutsceneCloseShowsTheRankScreen(levelName, ordinal + 1);
        verifyActiveCinematicStillGatesTheSummary(levelName, ordinal + 101);
        verifyLiveBossCannotCompleteTheRun(levelName, ordinal + 201);
    });
    console.log('reported_dungeon_boss_completion_regression: ok');
}

main();
