import { strict as assert } from 'assert';
import * as path from 'path';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';

const OPEN_COMPLETION_ISSUE_LEVELS: Readonly<Record<number, readonly string[]>> = {
    601: ['SD_Mission1Hard', 'SD_Mission6Hard'],
    595: ['GhostBossDungeon'],
    594: ['AC_Mission3Hard', 'AC_Mission4Hard', 'AC_Mission5Hard', 'AC_Mission6Hard'],
    591: ['OMM_Mission2Hard'],
    583: ['SD_Mission4', 'SD_Mission4Hard'],
    576: ['CH_Mission3Hard'],
    573: ['AC_Mission1'],
    572: ['JC_Mission1Hard'],
    571: ['JC_Mission2Hard'],
    570: ['AC_Mission5Hard'],
    569: ['BT_Mission2'],
    567: ['EG_Mission3Hard', 'EG_Mission4Hard', 'EG_Mission5Hard', 'OMM_Mission12Hard'],
    562: ['BT_Mission1'],
    552: ['OMM_Mission1Hard', 'OMM_Mission3Hard', 'OMM_Mission4Hard', 'OMM_Mission5Hard', 'OMM_Mission6Hard', 'OMM_Mission7Hard'],
    548: ['CH_Mission1Hard', 'CH_Mission3Hard', 'CH_Mission4Hard', 'CH_Mission5Hard', 'CH_Mission6Hard', 'CH_Mission7Hard', 'CH_Mission8Hard'],
    544: ['BT_Mission1Hard', 'BT_Mission2Hard', 'BT_Mission4Hard'],
    543: ['SwampRoadConnectionMissionHard'],
    540: ['SRN_Mission5Hard'],
    538: ['SRN_Mission3Hard'],
    537: ['SRN_Mission2Hard'],
    536: ['SRN_Mission1Hard'],
    535: ['DreamDragonDungeonHard'],
    533: ['GoblinRiverDungeonHard'],
    532: ['TutorialDungeonHard'],
    531: ['SRN_Mission4Hard', 'SRN_Mission6Hard', 'SRN_Mission7Hard'],
    528: ['OMM_Mission5', 'OMM_Mission9'],
    525: ['JC_Mission11'],
    523: ['OMM_Mission9'],
    522: ['CH_Mission2Hard'],
    520: ['SD_Mission3Hard']
};

function makeHostile(id: number, name: string, roomBoss: boolean = false): any {
    return {
        id,
        name,
        EntName: name,
        team: EntityTeam.ENEMY,
        clientSpawned: true,
        isRoomBoss: roomBoss,
        roomBoss,
        roomBossRoomId: roomBoss ? 99 : undefined,
        roomBossName: roomBoss ? name : undefined,
        playerDamageContributed: true,
        hp: 100,
        maxHp: 100,
        dead: false,
        destroyed: false,
        entState: EntityState.ACTIVE
    };
}

function verifyIssueLevel(issue: number, levelName: string, ordinal: number): void {
    const condition = DungeonCompletionConditions.get(levelName);
    assert.ok(condition, `#${issue} ${levelName}: missing completion condition`);
    assert.notEqual(condition.mode, 'disabled', `#${issue} ${levelName}: completion is disabled`);

    const levelScope = `${levelName}#open-issue-${issue}-${ordinal}`;
    const participantKey = `issue-${issue}-player`;
    const levelMap = new Map<number, any>();
    let nextId = 10_000 + ordinal * 100;

    if (condition.mode === 'bosses') {
        for (const group of condition.bossGroups ?? []) {
            levelMap.set(nextId, makeHostile(nextId, group[0], Boolean(condition.requireRoomBossMarker)));
            nextId += 1;
        }
        // A boss-mode level can also gate on authored objects (Anna's chains in
        // the tutorial dungeons). Those have to be destroyed for the run to be
        // ready, so the harness must place them alongside the bosses.
        for (const objective of condition.entityObjectives ?? []) {
            const requiredCount = Math.max(1, Math.round(Number(objective.requiredCount ?? 1)));
            for (let copy = 0; copy < requiredCount; copy++) {
                levelMap.set(nextId, makeHostile(nextId, objective.names[0]));
                nextId += 1;
            }
        }
    } else if (condition.mode === 'full-clear') {
        levelMap.set(nextId, makeHostile(nextId, `${levelName}HostileA`));
        nextId += 1;
        levelMap.set(nextId, makeHostile(nextId, `${levelName}HostileB`));
    }
    GlobalState.levelEntities.set(levelScope, levelMap);

    DungeonCompletionSystem.noteClientCompletionSignal(levelScope, participantKey, 100, 1000);
    assert.equal(
        DungeonCompletionSystem.evaluate(levelScope, 1001).ready,
        false,
        `#${issue} ${levelName}: accepted an early completion signal before objectives`
    );

    let now = 1002;
    for (const entity of levelMap.values()) {
        entity.hp = 0;
        entity.dead = true;
        entity.entState = EntityState.DEAD;
        DungeonCompletionSystem.noteEntityDefeated(levelScope, entity, now++);
    }

    if (condition.mode === 'full-clear' || condition.autoCompleteOnObjectives === false) {
        DungeonCompletionSystem.noteClientCompletionSignal(levelScope, participantKey, 100, now++);
    }
    if (condition.cutscene?.requiredAfterObjectives) {
        assert.equal(
            DungeonCompletionSystem.evaluate(levelScope, now).ready,
            false,
            `#${issue} ${levelName}: completed before its required end cutscene`
        );
        DungeonCompletionSystem.noteCutsceneStart(levelScope, 99, now++);
        DungeonCompletionSystem.noteCutsceneEnd(levelScope, 99, now++);
    }

    assert.equal(
        DungeonCompletionSystem.evaluate(levelScope, now).ready,
        true,
        `#${issue} ${levelName}: never became ready after its authored objectives`
    );

    DungeonCompletionSystem.reset(levelScope);
    GlobalState.levelEntities.delete(levelScope);
    GlobalState.levelQuestProgress.delete(levelScope);
}

function main(): void {
    LevelConfig.load(path.resolve(__dirname, '../data'));
    const issueEntries = Object.entries(OPEN_COMPLETION_ISSUE_LEVELS);
    let checkedLevels = 0;
    issueEntries.forEach(([issue, levels], issueIndex) => {
        levels.forEach((levelName, levelIndex) => {
            verifyIssueLevel(Number(issue), levelName, issueIndex * 10 + levelIndex);
            checkedLevels += 1;
        });
    });
    assert.equal(GlobalState.dungeonCompletions.size, 0, 'open-issue regression leaked completion state');
    console.log(`dungeon_completion_open_issues_regression: ok (${issueEntries.length} issues, ${checkedLevels} levels)`);
}

main();
