import { LevelConfig } from './LevelConfig';
import { WAYBACK_RANKING_DUNGEON_CAPS } from './WaybackDungeonStatCaps';

export type DungeonStatCapSource =
    | 'wayback-2017-rankings'
    | 'original-client-ui-with-inferred-tier'
    | 'custom-fallback';

export type DungeonStatCaps = {
    resultBar: number;
    killCap: number;
    treasureCap: number;
    accuracyCap: number;
    deathCap: number;
    timeBonusCap: number;
    source: DungeonStatCapSource;
    evidence: string;
};

type DungeonTierEvidence = {
    resultBar: number;
    evidence: string;
};

type DungeonCapBreakdown = Omit<DungeonStatCaps, 'resultBar' | 'source' | 'evidence'>;

// Original result bucket weights from the extracted client UI:
// temp/ActionScripts/ScreenLevelComplete.txt lines 160-164.
// The client scales each score bucket by a single per-dungeon multiplier
// (`resultBar`) instead of using the server's old fabricated bucket weights.
const ORIGINAL_RESULT_BUCKETS_PER_BAR = {
    kills: 40_000,
    accuracy: 20_000,
    deaths: 20_000,
    treasure: 10_000,
    timeBonus: 10_000
} as const;

// No dedicated per-dungeon resultBar table was found in the extracted assets.
// For the Wolf's End and Black Rose Mire mission dungeons we therefore use the
// original progression tier values carried by the extracted mission/level
// metadata:
// - temp/ActionScripts/DevSettings.txt
// - temp/swz-scripts/Game.swz.txt / MissionTypes.json
//
// This keeps the original client UI formula while clearly separating the
// per-dungeon multiplier mapping as an inference from original metadata, not a
// proven standalone score-cap table.
const ORIGINAL_TIER_DUNGEON_RESULT_BARS: Record<string, DungeonTierEvidence> = {
    TutorialDungeon: {
        resultBar: 2,
        evidence: 'Original progression tier 2 in extracted DevSettings.txt for LevelsNR.swf/a_Level_NRTutorial.'
    },
    TutorialDungeonHard: {
        resultBar: 2,
        evidence: 'Original progression tier 2 in extracted DevSettings.txt for LevelsNR.swf/a_Level_GoblinBeachHard.'
    },
    GoblinRiverDungeon: {
        resultBar: 3,
        evidence: 'Original progression tier 3 in extracted DevSettings.txt for LevelsNR.swf/a_Level_GoblinRiver.'
    },
    GoblinRiverDungeonHard: {
        resultBar: 3,
        evidence: 'Original progression tier 3 in extracted DevSettings.txt for LevelsNR.swf/a_Level_GoblinRiver Hard.'
    },
    GhostBossDungeon: {
        resultBar: 4,
        evidence: 'Original progression tier 4 in extracted DevSettings.txt for LevelsNR.swf/a_Level_NRGhost.'
    },
    GhostBossDungeonHard: {
        resultBar: 4,
        evidence: 'Original progression tier 4 in extracted DevSettings.txt for LevelsNR.swf/a_Level_NRGhost Hard.'
    },
    DreamDragonDungeon: {
        resultBar: 5,
        evidence: 'Original progression tier 5 in extracted DevSettings.txt for LevelsNR.swf/a_Level_NRDragon.'
    },
    DreamDragonDungeonHard: {
        resultBar: 5,
        evidence: 'Original progression tier 5 in extracted DevSettings.txt for LevelsNR.swf/a_Level_NRDragon Hard.'
    },
    SRN_Mission1: {
        resultBar: 6,
        evidence: 'Original progression tier 6 in extracted DevSettings.txt / MissionTypes.json for a_Level_SRNMission1Castout.'
    },
    SRN_Mission1Hard: {
        resultBar: 6,
        evidence: 'Original progression tier 6 in extracted DevSettings.txt for a_Level_SRNMission1Castout Hard.'
    },
    SRN_Mission2: {
        resultBar: 7,
        evidence: 'Original progression tier 7 in extracted DevSettings.txt / MissionTypes.json for a_Level_SRNMission2Yornak.'
    },
    SRN_Mission2Hard: {
        resultBar: 7,
        evidence: 'Original progression tier 7 in extracted DevSettings.txt for a_Level_SRNMission2Yornak Hard.'
    },
    SRN_Mission3: {
        resultBar: 8,
        evidence: 'Original progression tier 8 in extracted DevSettings.txt / MissionTypes.json for a_Level_SRNMission3Svar.'
    },
    SRN_Mission3Hard: {
        resultBar: 8,
        evidence: 'Original progression tier 8 in extracted DevSettings.txt for a_Level_SRNMission3Svar Hard.'
    },
    SRN_Mission4: {
        resultBar: 8,
        evidence: 'Original progression tier 8 in extracted DevSettings.txt / MissionTypes.json for a_Level_SRNMission4Ooyak.'
    },
    SRN_Mission4Hard: {
        resultBar: 8,
        evidence: 'Original progression tier 8 in extracted DevSettings.txt for a_Level_SRNMission4Ooyak Hard.'
    },
    SRN_Mission5: {
        resultBar: 9,
        evidence: 'Original progression tier 9 in extracted DevSettings.txt / MissionTypes.json for a_Level_SRNMission5Broodvictor.'
    },
    SRN_Mission5Hard: {
        resultBar: 9,
        evidence: 'Original progression tier 9 in extracted DevSettings.txt for a_Level_SRNMission5Broodvictor Hard.'
    },
    SRN_Mission6: {
        resultBar: 8,
        evidence: 'Original progression tier 8 in extracted DevSettings.txt / MissionTypes.json for a_Level_SRNMission6MindlessQueen.'
    },
    SRN_Mission6Hard: {
        resultBar: 8,
        evidence: 'Original progression tier 8 in extracted DevSettings.txt for a_Level_SRNMission6MindlessQueen Hard.'
    },
    SRN_Mission7: {
        resultBar: 9,
        evidence: 'Original progression tier 9 in extracted DevSettings.txt / MissionTypes.json for a_Level_SRNMission7Svath.'
    },
    SRN_Mission7Hard: {
        resultBar: 9,
        evidence: 'Original progression tier 9 in extracted DevSettings.txt for a_Level_SRNMission7Svath Hard.'
    }
};

// Explicit custom benchmark tiers kept separate from the asset-backed path.
// These are not claimed as original client data.
const CUSTOM_BENCHMARK_RESULT_BARS: Record<string, number> = {
    CraftTownTutorial: 3
};

function buildOriginalBucketCaps(resultBar: number): DungeonCapBreakdown {
    const safeBar = Math.max(0, Math.round(Number(resultBar) || 0));
    return {
        killCap: ORIGINAL_RESULT_BUCKETS_PER_BAR.kills * safeBar,
        treasureCap: ORIGINAL_RESULT_BUCKETS_PER_BAR.treasure * safeBar,
        accuracyCap: ORIGINAL_RESULT_BUCKETS_PER_BAR.accuracy * safeBar,
        deathCap: ORIGINAL_RESULT_BUCKETS_PER_BAR.deaths * safeBar,
        timeBonusCap: ORIGINAL_RESULT_BUCKETS_PER_BAR.timeBonus * safeBar
    };
}

export function getDungeonStatCaps(levelName: string): DungeonStatCaps | null {
    const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
    if (!normalizedLevel) {
        return null;
    }

    const waybackCaps = WAYBACK_RANKING_DUNGEON_CAPS[normalizedLevel];
    if (waybackCaps) {
        return {
            ...waybackCaps,
            source: 'wayback-2017-rankings'
        };
    }

    const tierEvidence = ORIGINAL_TIER_DUNGEON_RESULT_BARS[normalizedLevel];
    if (!tierEvidence) {
        return null;
    }

    return {
        resultBar: tierEvidence.resultBar,
        ...buildOriginalBucketCaps(tierEvidence.resultBar),
        source: 'original-client-ui-with-inferred-tier',
        evidence: `Original result bucket weights come from extracted ScreenLevelComplete.txt; ${tierEvidence.evidence}`
    };
}

export function buildCustomFallbackDungeonStatCaps(levelName: string): DungeonStatCaps {
    const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
    const isHard = LevelConfig.get(normalizedLevel).isHard;
    const baseLevelName = normalizedLevel.replace(/Hard$/, '');
    const benchmarkResultBar = CUSTOM_BENCHMARK_RESULT_BARS[normalizedLevel]
        ?? CUSTOM_BENCHMARK_RESULT_BARS[baseLevelName];
    const resultBar = benchmarkResultBar ?? (isHard ? 2 : 1);

    return {
        resultBar,
        ...buildOriginalBucketCaps(resultBar),
        source: 'custom-fallback',
        evidence: benchmarkResultBar
            ? 'Explicit custom benchmark used because this tier is validated locally but was not proven from extracted original score-cap assets.'
            : 'Explicit custom fallback used because no original or inferred per-dungeon tier mapping was proven for this level.'
    };
}

export function getDungeonStatTotalCap(profile: Pick<DungeonStatCaps, 'killCap' | 'treasureCap' | 'accuracyCap' | 'deathCap' | 'timeBonusCap'>): number {
    return profile.killCap
        + profile.treasureCap
        + profile.accuracyCap
        + profile.deathCap
        + profile.timeBonusCap;
}
