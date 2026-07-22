/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';

// A live trace from The Mouth of Meylour showed the rank screen appearing before
// the boss had even spawned: an ordinary trash mob died and the run already read
// objectivesMet: true, reason: cutscene_gate_pending.
//
// Cause: a solo dungeon scope key is `levelName#sessionToken`, so re-entering the
// same dungeon in one session lands on the identical scope. Nothing cleared it —
// the only DungeonCompletionSystem.reset call in the server sits behind
// usesServerAuthorityHostiles, which covers three levels and no ordinary dungeon.
// The second run therefore inherited the first run's defeatedBosses.
const LEVEL_NAME = 'BT_Mission3Hard';
const BOSS_NAME = 'MeylourBossMageHard';
const SESSION_TOKEN = '40279';

function createBoss(defeated: boolean): any {
    return {
        id: 555,
        name: BOSS_NAME,
        EntName: BOSS_NAME,
        characterName: `,${BOSS_NAME}`,
        isPlayer: false,
        clientSpawned: false,
        team: EntityTeam.ENEMY,
        roomId: 7,
        hp: defeated ? 0 : 1000,
        maxHp: 1000,
        dead: defeated,
        destroyed: defeated,
        entState: defeated ? EntityState.DEAD : EntityState.ACTIVE
    };
}

function scopeKey(): string {
    return getLevelScopeKey(LEVEL_NAME, SESSION_TOKEN);
}

function playFullRun(scope: string): void {
    const boss = createBoss(true);
    GlobalState.levelEntities.set(scope, new Map([[boss.id, boss]]));
    DungeonCompletionSystem.noteEntityDefeated(scope, boss);
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        true,
        'the first run did not register its boss kill, so the scenario cannot reproduce'
    );
}

// What resetFinishedDungeonRunScope does for an ordinary dungeon on re-entry.
function clearFinishedRunScope(scope: string): void {
    GlobalState.levelEntities.delete(scope);
    GlobalState.levelQuestProgress.delete(scope);
    DungeonCompletionSystem.reset(scope);
}

// The reported failure: re-enter, kill nothing, and the run is already complete.
function verifyReEntryStartsFromZero(): void {
    const scope = scopeKey();
    playFullRun(scope);

    clearFinishedRunScope(scope);

    // The new run: the boss is alive again and the player has killed nothing.
    const boss = createBoss(false);
    GlobalState.levelEntities.set(scope, new Map([[boss.id, boss]]));

    const evaluation = DungeonCompletionSystem.evaluate(scope);
    assert.equal(
        evaluation.objectivesMet,
        false,
        'a re-entered dungeon inherited the previous run\'s boss kill, so the rank ' +
        'screen fires before the boss is fought'
    );
    assert.equal(
        evaluation.reason,
        'objectives_pending',
        'the fresh run did not start with its objectives outstanding'
    );

    DungeonCompletionSystem.reset(scope);
    GlobalState.levelEntities.delete(scope);
}

// Clearing the completion state on its own is not enough: the recovery pass
// re-derives defeatedBosses from defeated entities still present in the scope,
// which is why the fix drops the scope's entity map too.
function verifyStateResetAloneIsInsufficient(): void {
    const scope = scopeKey();
    playFullRun(scope);

    // Reset the state but leave the previous run's corpse in the scope.
    DungeonCompletionSystem.reset(scope);

    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        true,
        'a stale defeated boss no longer resurrects the completion state — if this ' +
        'assertion fails the entity-map clear in resetFinishedDungeonRunScope may ' +
        'no longer be load-bearing, but do not drop it without re-checking'
    );

    DungeonCompletionSystem.reset(scope);
    GlobalState.levelEntities.delete(scope);
}

// A finished run must still be able to complete normally after the clear.
function verifyFreshRunStillCompletes(): void {
    const scope = scopeKey();
    clearFinishedRunScope(scope);

    const boss = createBoss(true);
    GlobalState.levelEntities.set(scope, new Map([[boss.id, boss]]));
    DungeonCompletionSystem.noteEntityDefeated(scope, boss);

    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        true,
        'the fresh run could no longer complete after its scope was cleared'
    );

    DungeonCompletionSystem.reset(scope);
    GlobalState.levelEntities.delete(scope);
}

function main(): void {
    LevelConfig.load(path.resolve(__dirname, '../data'));
    assert.equal(
        LevelConfig.isDungeonLevel(LEVEL_NAME),
        true,
        `${LEVEL_NAME} is no longer a dungeon level, so the fresh-run clear would skip it`
    );

    verifyReEntryStartsFromZero();
    verifyStateResetAloneIsInsufficient();
    verifyFreshRunStillCompletes();
    console.log('dungeon_stale_run_scope_regression: ok');
}

main();
