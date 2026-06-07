import * as path from 'path';
import { strict as assert } from 'assert';
import { Config } from '../core/config';
import { DungeonEntryDisplay } from '../core/DungeonEntryDisplay';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { NpcLoader } from '../data/NpcLoader';

function loadRuntimeData(): void {
    const dataDir = path.join(Config.DATA_DIR, 'data');
    if (!LevelConfig.has('TutorialDungeon')) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
    if (NpcLoader.getRawNpcsForLevel('BT_Mission2').length === 0) {
        NpcLoader.load(dataDir);
    }
}

function readElements(momentParams: string): string {
    const token = momentParams
        .split(',')
        .find((item) => item.startsWith(DungeonEntryDisplay.MOMENT_PREFIX));
    assert(token, 'enemy element token should be present');
    return token.slice(DungeonEntryDisplay.MOMENT_PREFIX.length);
}

loadRuntimeData();

const normalParams = DungeonEntryDisplay.buildMomentParams('BT_Mission2', '');
assert(normalParams.startsWith('Normal,EnemyElements='));
assert.notEqual(readElements(normalParams), '');
assert(readElements(normalParams).split('|').length <= 3);

const existingMomentParams = DungeonEntryDisplay.buildMomentParams('BT_Mission2', 'Intro');
assert(existingMomentParams.startsWith('Intro,EnemyElements='));
assert.notEqual(readElements(existingMomentParams), '');
assert(readElements(existingMomentParams).split('|').length <= 3);

const explicitNormalParams = DungeonEntryDisplay.buildMomentParams('BT_Mission2', 'Normal');
assert(explicitNormalParams.startsWith('Normal,EnemyElements='));
assert.notEqual(readElements(explicitNormalParams), '');

const nonDungeonParams = DungeonEntryDisplay.buildMomentParams('CraftTown', 'Normal');
assert.equal(nonDungeonParams, '');

const unknownParams = DungeonEntryDisplay.buildMomentParams('TutorialDungeonHard', 'Hard');
assert(!unknownParams.includes('Unknown'));

const clientAuthoredManifestParams = DungeonEntryDisplay.buildMomentParams('OMM_Mission1Hard', 'Hard');
assert.equal(clientAuthoredManifestParams, 'Hard,EnemyElements=Earth');

const scarabInvasionParams = DungeonEntryDisplay.buildMomentParams('SD_Mission2', '');
assert.equal(scarabInvasionParams, 'Normal,EnemyElements=Life|Air|Earth');

const moreThanThreeElementParams = DungeonEntryDisplay.buildMomentParams('SD_Mission4', '');
assert.equal(moreThanThreeElementParams, 'Normal,EnemyElements=Air|Earth|Fire');

const levelConfig = require('../data/level_config.json') as Record<string, string>;
for (const levelName of Object.keys(levelConfig)) {
    if (!LevelConfig.isDungeonLevel(levelName)) {
        continue;
    }

    const params = DungeonEntryDisplay.buildMomentParams(levelName, levelName.endsWith('Hard') ? 'Hard' : '');
    assert(!params.includes('EnemyElements=Unknown'), `${levelName} should not emit Unknown enemy elements`);
}

console.log('dungeon_entry_display_regression: ok');
