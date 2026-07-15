import assert from 'assert';
import path from 'path';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import type { DungeonCompletionCondition } from '../core/DungeonCompletionTypes';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';

type Scenario = {
    levelName: string;
    levelScope: string;
    condition: DungeonCompletionCondition;
    entities: any[];
};

function makeEntity(id: number, name: string, options: { clientSpawned?: boolean } = {}): any {
    return {
        id,
        name,
        hp: 100,
        maxHp: 100,
        dead: false,
        destroyed: false,
        entState: EntityState.ACTIVE,
        team: EntityTeam.ENEMY,
        clientSpawned: Boolean(options.clientSpawned),
        playerDamageContributed: true,
        lifeNonce: 1
    };
}

function createScenario(levelName: string, suffix: string): Scenario {
    const condition = DungeonCompletionConditions.get(levelName);
    assert(condition, `${levelName}: missing completion condition`);
    const levelScope = getLevelScopeKey(levelName, suffix);
    assert(levelScope, `${levelName}: failed to create level scope`);

    const entities: any[] = [];
    let nextEntityId = 1;
    if (condition.mode === 'bosses') {
        for (const group of condition.bossGroups ?? []) {
            const bossName = group[0];
            entities.push(makeEntity(nextEntityId++, bossName, {
                clientSpawned: Boolean(condition.clientAuthorityBosses?.includes(bossName))
            }));
        }
        for (const objective of condition.entityObjectives ?? []) {
            entities.push(makeEntity(nextEntityId++, objective.names[0]));
        }
    } else if (condition.mode === 'full-clear') {
        entities.push(makeEntity(nextEntityId++, 'MatrixHostileA'));
        entities.push(makeEntity(nextEntityId++, 'MatrixHostileB'));
    }

    GlobalState.levelEntities.set(
        levelScope,
        new Map(entities.map((entity) => [entity.id, entity]))
    );
    return { levelName, levelScope, condition, entities };
}

function defeatEntity(scenario: Scenario, entity: any, at: number): void {
    entity.hp = 0;
    entity.dead = true;
    entity.destroyed = true;
    entity.entState = EntityState.DEAD;
    DungeonCompletionSystem.noteEntityDefeated(scenario.levelScope, entity, at);
}

function satisfyCondition(scenario: Scenario, participantKey: string, baseTime: number): void {
    const { condition, entities, levelScope, levelName } = scenario;
    const initial = DungeonCompletionSystem.evaluate(levelScope, baseTime);
    assert.strictEqual(initial.ready, false, `${levelName}: completed before any condition was met`);

    if (condition.mode === 'disabled') {
        DungeonCompletionSystem.noteClientCompletionSignal(levelScope, participantKey, 100, baseTime + 1);
        assert.strictEqual(
            DungeonCompletionSystem.evaluate(levelScope, baseTime + 2).ready,
            false,
            `${levelName}: disabled dungeon completed`
        );
        return;
    }

    if (condition.mode === 'client-signal') {
        DungeonCompletionSystem.noteClientCompletionSignal(levelScope, participantKey, 100, baseTime + 1);
        assert.strictEqual(
            DungeonCompletionSystem.evaluate(levelScope, baseTime + 2).ready,
            true,
            `${levelName}: client completion signal was not accepted`
        );
        return;
    }

    if (condition.mode === 'full-clear') {
        DungeonCompletionSystem.noteClientCompletionSignal(levelScope, participantKey, 100, baseTime + 1);
        assert.strictEqual(
            DungeonCompletionSystem.evaluate(levelScope, baseTime + 2).ready,
            false,
            `${levelName}: full-clear completed while hostiles remained`
        );
        defeatEntity(scenario, entities[0], baseTime + 3);
        assert.strictEqual(
            DungeonCompletionSystem.evaluate(levelScope, baseTime + 4).ready,
            false,
            `${levelName}: full-clear completed after only one hostile`
        );
        defeatEntity(scenario, entities[1], baseTime + 5);
        assert.strictEqual(
            DungeonCompletionSystem.evaluate(levelScope, baseTime + 6).ready,
            true,
            `${levelName}: full-clear never completed`
        );
        return;
    }

    const bossCount = condition.bossGroups?.length ?? 0;
    const objectiveCount = condition.entityObjectives?.length ?? 0;
    const objectiveEntities = entities.slice(bossCount, bossCount + objectiveCount);
    const simultaneousWindowMs = Math.max(0, Number(condition.simultaneousBossWindowMs ?? 0));
    if (simultaneousWindowMs > 0 && bossCount > 1) {
        defeatEntity(scenario, entities[0], baseTime + 10);
        defeatEntity(scenario, entities[1], baseTime + 11 + simultaneousWindowMs);
        assert.strictEqual(
            DungeonCompletionSystem.evaluate(levelScope, baseTime + 12 + simultaneousWindowMs).objectivesMet,
            false,
            `${levelName}: accepted boss deaths outside the simultaneous window`
        );
        for (let index = 0; index < bossCount; index++) {
            entities[index].hp = 100;
            entities[index].dead = false;
            entities[index].destroyed = false;
            entities[index].entState = EntityState.ACTIVE;
            entities[index].lifeNonce += 1;
        }
        DungeonCompletionSystem.evaluate(levelScope, baseTime + 20 + simultaneousWindowMs);
    }
    for (let index = 0; index < bossCount; index++) {
        defeatEntity(scenario, entities[index], baseTime + 100 + simultaneousWindowMs + index * 10);
        if (index < bossCount - 1 || objectiveCount > 0) {
            assert.strictEqual(
                DungeonCompletionSystem.evaluate(levelScope, baseTime + 101 + simultaneousWindowMs + index * 10).ready,
                false,
                `${levelName}: completed before every boss/objective group`
            );
        }
    }
    for (let index = 0; index < objectiveEntities.length; index++) {
        defeatEntity(scenario, objectiveEntities[index], baseTime + 300 + simultaneousWindowMs + index);
        if (index < objectiveEntities.length - 1) {
            assert.strictEqual(
                DungeonCompletionSystem.evaluate(levelScope, baseTime + 301 + simultaneousWindowMs + index).ready,
                false,
                `${levelName}: completed before every entity objective`
            );
        }
    }

    const gateBaseTime = baseTime + 500 + simultaneousWindowMs;
    if (condition.autoCompleteOnObjectives === false) {
        assert.strictEqual(
            DungeonCompletionSystem.evaluate(levelScope, gateBaseTime).ready,
            false,
            `${levelName}: ignored its client-signal gate`
        );
        DungeonCompletionSystem.noteClientCompletionSignal(levelScope, participantKey, 100, gateBaseTime + 1);
    }

    if (condition.cutscene?.requiredAfterObjectives) {
        assert.strictEqual(
            DungeonCompletionSystem.evaluate(levelScope, gateBaseTime + 10).ready,
            false,
            `${levelName}: ignored its cutscene gate`
        );
    }

    DungeonCompletionSystem.noteCutsceneStart(levelScope, 7, gateBaseTime + 11);
    assert.strictEqual(
        DungeonCompletionSystem.noteCutsceneEnd(levelScope, 8, gateBaseTime + 12),
        false,
        `${levelName}: accepted the wrong cutscene room`
    );
    DungeonCompletionSystem.noteClientCompletionSignal(levelScope, participantKey, 100, gateBaseTime + 13);
    assert.strictEqual(
        DungeonCompletionSystem.evaluate(levelScope, gateBaseTime + 14).ready,
        false,
        `${levelName}: client signal bypassed an active authoritative cutscene`
    );
    assert.strictEqual(
        DungeonCompletionSystem.noteCutsceneEnd(levelScope, 7, gateBaseTime + 15),
        true,
        `${levelName}: did not release after the authoritative cutscene ended`
    );

    assert.strictEqual(
        DungeonCompletionSystem.evaluate(levelScope, gateBaseTime + 20).ready,
        true,
        `${levelName}: valid completion flow never became ready`
    );
}

const NEVER_ENDING_DUNGEON_LEVELS = [
    'TutorialDungeon',
    'TutorialDungeonHard',
    'SwampRoadConnectionMission',
    'SwampRoadConnectionMissionHard',
    'OMM_Mission2',
    'OMM_Mission2Hard',
    'OMM_Mission5',
    'OMM_Mission5Hard',
    'AC_Mission1',
    'AC_Mission1Hard',
    'OMM_Mission8',
    'OMM_Mission8Hard',
    'JC_Mission9',
    'JC_Mission9Hard'
] as const;

function satisfyObjectivesAfterIntroCutscene(
    scenario: Scenario,
    participantKey: string,
    baseTime: number
): void {
    const { condition, entities, levelScope } = scenario;
    DungeonCompletionSystem.noteCutsceneStart(levelScope, 7, baseTime);

    if (condition.mode === 'client-signal') {
        DungeonCompletionSystem.noteClientCompletionSignal(levelScope, participantKey, 100, baseTime + 1);
        return;
    }

    entities.forEach((entity, index) => defeatEntity(scenario, entity, baseTime + 1 + index));
    if (condition.mode === 'full-clear' || condition.autoCompleteOnObjectives === false) {
        DungeonCompletionSystem.noteClientCompletionSignal(
            levelScope,
            participantKey,
            100,
            baseTime + entities.length + 1
        );
    }
}

function verifyIntroCutsceneDoesNotPermanentlyBlockCompletion(
    levelName: string,
    ordinal: number
): void {
    const scenario = createScenario(levelName, `intro-cutscene-${ordinal}`);
    const participantKey = 'intro-cutscene-player';
    const baseTime = 5_000_000 + ordinal * 1_000;
    satisfyObjectivesAfterIntroCutscene(scenario, participantKey, baseTime);

    const beforeClose = DungeonCompletionSystem.evaluate(
        scenario.levelScope,
        baseTime + scenario.entities.length + 10
    );
    if (scenario.condition.cutscene?.requiredAfterObjectives) {
        assert.strictEqual(
            beforeClose.ready,
            false,
            `${levelName}: explicit post-objective cutscene gate was bypassed`
        );
        assert.strictEqual(
            DungeonCompletionSystem.noteCutsceneEnd(
                scenario.levelScope,
                7,
                baseTime + scenario.entities.length + 11
            ),
            true,
            `${levelName}: pre-objective intro close after objectives did not release the explicit gate`
        );
    } else {
        assert.strictEqual(
            beforeClose.ready,
            true,
            `${levelName}: unmatched pre-objective intro cutscene permanently blocked completion`
        );
    }

    cleanupScenario(scenario);
}

function verifyIdempotentFinalization(scenario: Scenario, participantCount: 1 | 2): void {
    if (scenario.condition.mode === 'disabled') {
        return;
    }
    const state = DungeonCompletionSystem.getState(scenario.levelScope);
    assert(state, `${scenario.levelName}: missing run state`);

    const deathEventCount = state.processedDeathEvents.size;
    const firstEntity = scenario.entities[0];
    if (firstEntity?.dead) {
        DungeonCompletionSystem.noteEntityDefeated(scenario.levelScope, firstEntity, state.updatedAt + 1);
        assert.strictEqual(
            state.processedDeathEvents.size,
            deathEventCount,
            `${scenario.levelName}: duplicate death event was recorded twice`
        );
    }

    const participants = Array.from({ length: participantCount }, (_, index) => `matrix-player-${index + 1}`);
    for (const participant of participants) {
        assert.strictEqual(
            DungeonCompletionSystem.tryReserveFinalization(scenario.levelScope, participant),
            true,
            `${scenario.levelName}: ${participant} could not reserve finalization`
        );
        assert.strictEqual(
            DungeonCompletionSystem.tryReserveFinalization(scenario.levelScope, participant),
            false,
            `${scenario.levelName}: ${participant} reserved duplicate rewards`
        );
    }
    assert.strictEqual(
        state.completionRequestCount,
        participantCount,
        `${scenario.levelName}: completion request ledger diverged`
    );
    for (const participant of participants) {
        DungeonCompletionSystem.markFinalized(scenario.levelScope, participant);
    }
    assert.strictEqual(
        state.completedParticipants.size,
        participantCount,
        `${scenario.levelName}: not every party member finalized exactly once`
    );
}

function cleanupScenario(scenario: Scenario): void {
    DungeonCompletionSystem.reset(scenario.levelScope);
    GlobalState.levelEntities.delete(scenario.levelScope);
    GlobalState.levelQuestProgress.delete(scenario.levelScope);
}

function runScenario(levelName: string, participantCount: 1 | 2, ordinal: number): void {
    const scenario = createScenario(levelName, `matrix-${participantCount}-${ordinal}`);
    const participantKey = 'matrix-player-1';
    satisfyCondition(scenario, participantKey, 1_000_000 + ordinal * 1_000);
    verifyIdempotentFinalization(scenario, participantCount);
    cleanupScenario(scenario);
}

function main(): void {
    const dataDir = path.resolve(__dirname, '..', 'data');
    LevelConfig.load(dataDir);
    const dungeonLevels = LevelConfig.getDungeonLevelNames();
    assert(dungeonLevels.length > 0, 'No runtime dungeons were loaded');

    assert.deepStrictEqual(
        DungeonCompletionConditions.validate(dungeonLevels),
        [],
        'Dungeon completion catalog failed runtime coverage validation'
    );

    dungeonLevels.forEach((levelName, index) => {
        runScenario(levelName, 1, index);
        runScenario(levelName, 2, index);
    });
    NEVER_ENDING_DUNGEON_LEVELS.forEach((levelName, index) => {
        verifyIntroCutsceneDoesNotPermanentlyBlockCompletion(levelName, index);
    });

    assert.strictEqual(GlobalState.dungeonCompletions.size, 0, 'Matrix leaked dungeon completion states');
    console.log(
        `Dungeon completion condition matrix regression passed (${dungeonLevels.length} dungeons, singleplayer + multiplayer).`
    );
}

main();
