import { strict as assert } from 'assert';
import * as path from 'path';
import {
    buildCustomFallbackDungeonStatCaps,
    getDungeonStatCaps,
    getDungeonStatTotalCap
} from '../core/DungeonStatCaps';
import { LevelConfig } from '../core/LevelConfig';
import { WAYBACK_RANKING_DUNGEON_CAPS } from '../core/WaybackDungeonStatCaps';

function ensureLevelConfigLoaded(): void {
    if (!LevelConfig.has('GhostBossDungeon')) {
        LevelConfig.load(path.resolve(__dirname, '../data'));
    }
}

function assertWaybackCaps(
    levelName: string,
    expected: {
        resultBar: number;
        killCap: number;
        treasureCap: number;
        accuracyCap: number;
        deathCap: number;
        timeBonusCap: number;
    }
): void {
    const caps = getDungeonStatCaps(levelName);
    assert.ok(caps, `${levelName} should have an archived dungeon cap entry`);
    assert.equal(caps!.source, 'wayback-2017-rankings');
    assert.equal(caps!.resultBar, expected.resultBar);
    assert.equal(caps!.killCap, expected.killCap);
    assert.equal(caps!.treasureCap, expected.treasureCap);
    assert.equal(caps!.accuracyCap, expected.accuracyCap);
    assert.equal(caps!.deathCap, expected.deathCap);
    assert.equal(caps!.timeBonusCap, expected.timeBonusCap);
    assert.equal(
        getDungeonStatTotalCap(caps!),
        expected.killCap + expected.treasureCap + expected.accuracyCap + expected.deathCap + expected.timeBonusCap,
        `${levelName} total cap should match the archived per-column maximums`
    );
}

function testArchivedRankingCapsOverrideInferredBuckets(): void {
    assert.equal(Object.keys(WAYBACK_RANKING_DUNGEON_CAPS).length, 128);
    assertWaybackCaps('SRN_Mission1', {
        resultBar: 6,
        killCap: 240_000,
        treasureCap: 60_000,
        accuracyCap: 120_000,
        deathCap: 120_000,
        timeBonusCap: 112_809
    });
    assertWaybackCaps('TutorialDungeonHard', {
        resultBar: 37,
        killCap: 1_480_000,
        treasureCap: 370_000,
        accuracyCap: 738_078,
        deathCap: 740_000,
        timeBonusCap: 674_998
    });
    assertWaybackCaps('JC_Mission11Hard', {
        resultBar: 42,
        killCap: 1_680_000,
        treasureCap: 420_000,
        accuracyCap: 834_756,
        deathCap: 840_000,
        timeBonusCap: 707_992
    });
}

function testMissingArchiveEntriesStillUseDocumentedInference(): void {
    const caps = getDungeonStatCaps('SRN_Mission1Hard');
    assert.ok(caps, 'SRN_Mission1Hard should keep the documented inference because the archive has no Dread Castout capture');
    assert.equal(caps!.source, 'original-client-ui-with-inferred-tier');
    assert.equal(caps!.resultBar, 6);
}

function testUnknownDungeonFallbackStaysExplicit(): void {
    const caps = buildCustomFallbackDungeonStatCaps('CraftTownTutorial');
    assert.equal(caps.source, 'custom-fallback');
    assert.equal(caps.resultBar, 3, 'validated custom benchmark tiers should stay explicit when no asset-backed mapping was proven');
    assert.equal(getDungeonStatCaps('CraftTownTutorial'), null, 'custom fallback entries should not masquerade as asset-backed caps');
}

function main(): void {
    ensureLevelConfigLoaded();
    testArchivedRankingCapsOverrideInferredBuckets();
    testMissingArchiveEntriesStillUseDocumentedInference();
    testUnknownDungeonFallbackStaysExplicit();
    console.log('dungeon_stat_caps_regression: ok');
}

try {
    main();
} catch (error) {
    console.error('dungeon_stat_caps_regression: failed');
    console.error(error);
    process.exitCode = 1;
}
