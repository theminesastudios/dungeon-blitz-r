/**
 * Regression tests for issue #663 ("Don't let pass the level" — The Growing
 * Flame) and issue #683 ("Dungeon 'The Capstone' is bugged and i cant get out").
 *
 * Both dungeons' final bosses are cue-owned and client-driven: the client's
 * BossFight drives their HP locally and only ever reports the outcome to the
 * server. For The Growing Flame the room authors two bosses (GriffonMoon and
 * BlackGoblinMiniBoss); The Capstone's Nephit fight has an intermediate body
 * (room 6) and a final body (room 7). Per-entity kill reports can be dropped or
 * rejected for these cue-owned bosses, so completion must also accept the
 * client's authoritative boss-clear signal (0xAD, emitted by BossFight when
 * every boss slot is at zero HP and the boss UI closes).
 *
 * The Growing Flame accepts that signal outright. The Capstone scopes it to the
 * final fight room so the intermediate Nephit body cannot finish the dungeon
 * early.
 */
import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';
import { LevelHandler } from '../handlers/LevelHandler';

function ensureDataLoaded(): void {
    if (!LevelConfig.has('OMM_Mission9')) {
        LevelConfig.load(path.resolve(__dirname, '../data'));
    }
}

function createScope(level: string, tag: string): string {
    const scope = getLevelScopeKey(level, tag);
    GlobalState.levelEntities.set(scope, new Map<number, any>());
    return scope;
}

function createBossEntity(id: number, name: string, roomId: number): any {
    return {
        id,
        name,
        EntName: name,
        entName: name,
        characterName: `,${name}`,
        displayName: name,
        isPlayer: false,
        clientSpawned: true,
        team: EntityTeam.ENEMY,
        roomId,
        hp: 100,
        maxHp: 100,
        dead: false,
        destroyed: false,
        entState: EntityState.ACTIVE
    };
}

function cleanup(scope: string): void {
    DungeonCompletionSystem.reset(scope);
    GlobalState.levelEntities.delete(scope);
}

// The Growing Flame: the boss room's 0xAD must mark both required bosses
// defeated and release the run, even when no per-boss kill report ever reaches
// the server (the failure mode behind issue #663).
function verifyGrowingFlameBossClearCompletes(): void {
    const condition = DungeonCompletionConditions.get('OMM_Mission9');
    assert.equal(condition?.acceptRoomBossClearSignal, true, 'OMM_Mission9 must accept the boss-clear signal');
    assert.deepEqual(
        condition?.bossGroups,
        [['GriffonMoon'], ['BlackGoblinMiniBoss']],
        'OMM_Mission9 must require both bosses'
    );

    const scope = createScope('OMM_Mission9', 'boss-clear-omm9');
    const levelMap = GlobalState.levelEntities.get(scope)!;
    levelMap.set(101, createBossEntity(101, 'GriffonMoon', 11));
    levelMap.set(102, createBossEntity(102, 'BlackGoblinMiniBoss', 11));

    const accepted = DungeonCompletionSystem.noteRoomBossClear(scope, 11);
    const evaluation = DungeonCompletionSystem.evaluate(scope);

    assert.equal(accepted, true, 'the boss-room 0xAD must be accepted for OMM_Mission9');
    assert.equal(evaluation.objectivesMet, true, 'the boss-clear must satisfy both boss groups');
    assert.deepEqual(
        [...(DungeonCompletionSystem.getState(scope)?.defeatedBosses ?? [])].sort(),
        ['BlackGoblinMiniBoss', 'GriffonMoon'],
        'both Growing Flame bosses must be registered defeated'
    );
    cleanup(scope);
}

// The Growing Flame hard difficulty carries the same requirement.
function verifyGrowingFlameHardBossClearCompletes(): void {
    const condition = DungeonCompletionConditions.get('OMM_Mission9Hard');
    assert.equal(condition?.acceptRoomBossClearSignal, true, 'OMM_Mission9Hard must accept the boss-clear signal');

    const scope = createScope('OMM_Mission9Hard', 'boss-clear-omm9-hard');
    const levelMap = GlobalState.levelEntities.get(scope)!;
    levelMap.set(201, createBossEntity(201, 'GriffonMoonHard', 11));
    levelMap.set(202, createBossEntity(202, 'BlackGoblinMiniBossHard', 11));

    assert.equal(DungeonCompletionSystem.noteRoomBossClear(scope, 11), true);
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        true,
        'OMM_Mission9Hard boss-clear must satisfy the objectives'
    );
    cleanup(scope);
}

// The Capstone: the 0xAD must be accepted only from the final fight room (7),
// never from the intermediate Nephit body's room (6).
function verifyCapstoneBossClearRoomScoping(): void {
    for (const [level, bossName, tag] of [
        ['AC_Mission6', 'NephitSpireMarker', 'boss-clear-ac6'],
        ['AC_Mission6Hard', 'NephitSpireMarkerHard', 'boss-clear-ac6-hard']
    ] as Array<[string, string, string]>) {
        const condition = DungeonCompletionConditions.get(level);
        assert.equal(condition?.acceptRoomBossClearSignal, true, `${level} must accept the boss-clear signal`);
        assert.deepEqual(condition?.acceptRoomBossClearRooms, [7], `${level} must scope the clear to the final room`);

        const scope = createScope(level, tag);
        GlobalState.levelEntities.get(scope)!.set(301, createBossEntity(301, bossName, 7));

        // The intermediate Nephit body fight must not complete the dungeon.
        assert.equal(
            DungeonCompletionSystem.noteRoomBossClear(scope, 6),
            false,
            `${level}: the intermediate room's boss-clear must be ignored`
        );
        assert.equal(
            DungeonCompletionSystem.evaluate(scope).objectivesMet,
            false,
            `${level}: the intermediate fight must not satisfy the objectives`
        );

        // The final Nephit fight must complete it.
        assert.equal(
            DungeonCompletionSystem.noteRoomBossClear(scope, 7),
            true,
            `${level}: the final room's boss-clear must be accepted`
        );
        assert.equal(
            DungeonCompletionSystem.evaluate(scope).objectivesMet,
            true,
            `${level}: the final fight must satisfy the objectives`
        );
        cleanup(scope);
    }
}

// The config stays coherent: the scoped field is only valid alongside the
// enabling flag, and the conditions validator accepts the new field.
function verifyConditionValidation(): void {
    const errors = DungeonCompletionConditions.validate(['OMM_Mission9', 'AC_Mission6']);
    assert.deepEqual(errors, [], `completion condition validation must pass: ${JSON.stringify(errors)}`);
}

function main(): void {
    ensureDataLoaded();
    verifyGrowingFlameBossClearCompletes();
    verifyGrowingFlameHardBossClearCompletes();
    verifyCapstoneBossClearRoomScoping();
    verifyConditionValidation();
    console.log('dungeon_boss_clear_completion_regression: ok');
}

main();
