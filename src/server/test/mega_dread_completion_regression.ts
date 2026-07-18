import assert from 'assert';
import path from 'path';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';

function makeBoss(id: number, name: string): any {
    return {
        id,
        name,
        hp: 100,
        maxHp: 100,
        dead: false,
        destroyed: false,
        entState: EntityState.ACTIVE,
        team: EntityTeam.ENEMY,
        lifeNonce: 1
    };
}

function defeat(levelScope: string, boss: any, now: number): void {
    boss.hp = 0;
    boss.dead = true;
    boss.destroyed = true;
    boss.entState = EntityState.DEAD;
    DungeonCompletionSystem.noteEntityDefeated(levelScope, boss, now);
}

function revive(boss: any): void {
    boss.hp = boss.maxHp;
    boss.dead = false;
    boss.destroyed = false;
    boss.entState = EntityState.ACTIVE;
    boss.lifeNonce += 1;
}

function testAuthoredMegaDreadConditions(): void {
    for (const levelName of ['CH_Mission8', 'CH_Mission8Hard', 'OMM_Mission6', 'OMM_Mission6Hard']) {
        assert.equal(
            DungeonCompletionConditions.hasPostObjectiveCutscene(levelName),
            true,
            `${levelName} must wait for its ending cutscene`
        );
    }

    assert.deepEqual(
        DungeonCompletionConditions.get('OMM_Mission5Hard')?.bossGroups,
        [['DragonWhiteHard'], ['LionLordHard']],
        'Dread Hunted to the Edge must require both bosses'
    );
}

function testHuntedToTheEdgeRequiresBothBossesAndCutscene(): void {
    const levelScope = getLevelScopeKey('OMM_Mission5Hard', 'mega-dread-double-boss');
    const dragon = makeBoss(1, 'DragonWhiteHard');
    const lion = makeBoss(2, 'LionLordHard');
    GlobalState.levelEntities.set(levelScope, new Map([[dragon.id, dragon], [lion.id, lion]]));

    defeat(levelScope, dragon, 100);
    assert.equal(DungeonCompletionSystem.evaluate(levelScope, 101).objectivesMet, false);

    defeat(levelScope, lion, 102);
    assert.equal(DungeonCompletionSystem.evaluate(levelScope, 103).ready, false);
    DungeonCompletionSystem.noteCutsceneStart(levelScope, 12, 104);
    assert.equal(DungeonCompletionSystem.noteCutsceneEnd(levelScope, 12, 105), true);
}

function testMeylourPhaseReviveRequiresFinalClientSignalAndCutscene(): void {
    const levelScope = getLevelScopeKey('BT_Mission3Hard', 'mega-dread-meylour');
    const boss = makeBoss(3, 'MeylourBossMageHard');
    GlobalState.levelEntities.set(levelScope, new Map([[boss.id, boss]]));

    defeat(levelScope, boss, 200);
    revive(boss);
    assert.equal(
        DungeonCompletionSystem.evaluate(levelScope, 201).objectivesMet,
        false,
        'a scripted Meylour phase revive must revoke the earlier defeat'
    );

    defeat(levelScope, boss, 202);
    assert.equal(DungeonCompletionSystem.evaluate(levelScope, 203).reason, 'client_completion_signal_pending');
    DungeonCompletionSystem.noteClientCompletionSignal(levelScope, 'mega-dread-player', 100, 204);
    assert.equal(DungeonCompletionSystem.evaluate(levelScope, 205).reason, 'cutscene_gate_pending');
    DungeonCompletionSystem.noteCutsceneStart(levelScope, 27, 206);
    assert.equal(DungeonCompletionSystem.noteCutsceneEnd(levelScope, 27, 207), true);
}

function main(): void {
    LevelConfig.load(path.resolve(__dirname, '../data'));
    try {
        testAuthoredMegaDreadConditions();
        testHuntedToTheEdgeRequiresBothBossesAndCutscene();
        testMeylourPhaseReviveRequiresFinalClientSignalAndCutscene();
        console.log('mega_dread_completion_regression: ok');
    } finally {
        for (const scope of [...GlobalState.levelEntities.keys()]) {
            if (scope.includes('mega-dread-')) {
                GlobalState.levelEntities.delete(scope);
                DungeonCompletionSystem.reset(scope);
            }
        }
    }
}

main();
