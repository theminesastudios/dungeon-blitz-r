/// <reference types="node" />

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

const completionIssueIds = [
    520, 522, 523, 525, 528, 531, 532, 533, 535, 536,
    537, 538, 540, 543, 544, 548, 552, 562, 567, 569,
    570, 571, 572, 573, 576, 583, 591, 594, 595, 601
];

const directCoverage = new Map<number, string>([
    [478, 'open_issue_client_asset_regression.ts'],
    [482, 'goblin_kidnappers_server_authority_regression.ts'],
    [491, 'open_issue_client_asset_regression.ts'],
    [493, 'quest_issue_regression.ts'],
    [494, 'quest_issue_regression.ts'],
    [495, 'quest_issue_regression.ts'],
    [521, 'dungeon_side_quest_material_regression.ts'],
    [558, 'open_issue_client_asset_regression.ts'],
    [563, 'quest_issue_regression.ts'],
    [564, 'dungeon_side_quest_material_regression.ts'],
    [581, 'open_issue_client_asset_regression.ts'],
    [584, 'fable_phase_untargetable_regression.ts'],
    [585, 'open_issue_client_asset_regression.ts'],
    [586, 'boss_lifecycle_reward_regression.ts'],
    [589, 'boss_lifecycle_reward_regression.ts'],
    [592, 'boss_lifecycle_reward_regression.ts'],
    [610, 'justicar_open_issues_regression.ts'],
    [625, 'open_issue_client_asset_regression.ts'],
    [626, 'justicar_open_issues_regression.ts']
]);

const expectedOpenIssueIds = [
    478, 482, 491, 493, 494, 495, 520, 521, 522, 523,
    525, 528, 531, 532, 533, 535, 536, 537, 538, 540,
    543, 544, 548, 552, 558, 562, 563, 564, 567, 569,
    570, 571, 572, 573, 576, 581, 583, 584, 585, 586,
    589, 591, 592, 594, 595, 601, 610, 625, 626
];

const completionTest = fs.readFileSync(
    path.join(__dirname, 'dungeon_completion_open_issues_regression.ts'),
    'utf8'
);
for (const issueId of completionIssueIds) {
    assert.match(completionTest, new RegExp(`\\b${issueId}:`), `completion issue #${issueId} lost its level matrix`);
}
for (const [issueId, testName] of directCoverage) {
    assert.ok(fs.existsSync(path.join(__dirname, testName)), `direct issue #${issueId} test is missing: ${testName}`);
}

const actualCoverage = [...new Set([...completionIssueIds, ...directCoverage.keys()])].sort((a, b) => a - b);
assert.deepEqual(actualCoverage, expectedOpenIssueIds, 'the 49-issue tracker coverage map has a gap or stale entry');
console.log('Open issue coverage regression passed (49/49 tracker issues mapped).');
