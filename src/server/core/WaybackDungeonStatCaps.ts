export type WaybackDungeonStatCapEntry = {
    resultBar: number;
    killCap: number;
    treasureCap: number;
    accuracyCap: number;
    deathCap: number;
    timeBonusCap: number;
    evidence: string;
};

// Generated from the archived Dungeon Blitz ranking pages captured by the
// Internet Archive in 2017. Values are the maximum observed value for each
// score column on the corresponding Normal or Dread ranking table.
export const WAYBACK_RANKING_DUNGEON_CAPS: Record<string, WaybackDungeonStatCapEntry> = {
    AC_Mission1: {
        resultBar: 21,
        killCap: 840_000,
        treasureCap: 210_000,
        accuracyCap: 420_000,
        deathCap: 420_000,
        timeBonusCap: 389_568,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/deepgard (Castle Hocke); maximum per-column values.'
    },
    AC_Mission1Hard: {
        resultBar: 36,
        killCap: 1_440_000,
        treasureCap: 360_000,
        accuracyCap: 720_000,
        deathCap: 720_000,
        timeBonusCap: 672_987,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/deepgard (Castle Hocke); maximum per-column values.'
    },
    AC_Mission2: {
        resultBar: 21,
        killCap: 840_000,
        treasureCap: 210_000,
        accuracyCap: 420_000,
        deathCap: 420_000,
        timeBonusCap: 396_978,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/throne (The Emerald Throne); maximum per-column values.'
    },
    AC_Mission2Hard: {
        resultBar: 36,
        killCap: 1_440_000,
        treasureCap: 360_000,
        accuracyCap: 720_000,
        deathCap: 720_000,
        timeBonusCap: 682_103,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/throne (The Emerald Throne); maximum per-column values.'
    },
    AC_Mission3: {
        resultBar: 21,
        killCap: 840_000,
        treasureCap: 210_000,
        accuracyCap: 420_000,
        deathCap: 420_000,
        timeBonusCap: 391_256,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/battlefield (Battles Lost and Won); maximum per-column values.'
    },
    AC_Mission3Hard: {
        resultBar: 36,
        killCap: 1_440_000,
        treasureCap: 360_000,
        accuracyCap: 720_000,
        deathCap: 720_000,
        timeBonusCap: 677_581,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/battlefield (Battles Lost and Won); maximum per-column values.'
    },
    AC_Mission4: {
        resultBar: 22,
        killCap: 880_000,
        treasureCap: 220_000,
        accuracyCap: 440_000,
        deathCap: 440_000,
        timeBonusCap: 407_389,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/observatory (Aetheric Observatory); maximum per-column values.'
    },
    AC_Mission4Hard: {
        resultBar: 37,
        killCap: 1_480_000,
        treasureCap: 370_000,
        accuracyCap: 740_000,
        deathCap: 740_000,
        timeBonusCap: 700_356,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/observatory (Aetheric Observatory); maximum per-column values.'
    },
    AC_Mission5: {
        resultBar: 22,
        killCap: 880_000,
        treasureCap: 220_000,
        accuracyCap: 440_000,
        deathCap: 440_000,
        timeBonusCap: 411_238,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/ramparts (Last Stand); maximum per-column values.'
    },
    AC_Mission5Hard: {
        resultBar: 37,
        killCap: 1_480_000,
        treasureCap: 370_000,
        accuracyCap: 740_000,
        deathCap: 740_000,
        timeBonusCap: 698_712,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/ramparts (Last Stand); maximum per-column values.'
    },
    AC_Mission6: {
        resultBar: 22,
        killCap: 880_000,
        treasureCap: 220_000,
        accuracyCap: 440_000,
        deathCap: 440_000,
        timeBonusCap: 402_791,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/capstone (The Capstone); maximum per-column values.'
    },
    AC_Mission6Hard: {
        resultBar: 37,
        killCap: 1_480_000,
        treasureCap: 370_000,
        accuracyCap: 740_000,
        deathCap: 740_000,
        timeBonusCap: 687_727,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/capstone (The Capstone); maximum per-column values.'
    },
    BT_Mission1: {
        resultBar: 11,
        killCap: 440_000,
        treasureCap: 110_000,
        accuracyCap: 220_000,
        deathCap: 220_000,
        timeBonusCap: 208_336,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/bandit (Bandit Camp); maximum per-column values.'
    },
    BT_Mission1Hard: {
        resultBar: 26,
        killCap: 1_040_000,
        treasureCap: 260_000,
        accuracyCap: 520_000,
        deathCap: 520_000,
        timeBonusCap: 484_378,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/bandit (Bandit Camp); maximum per-column values.'
    },
    BT_Mission2: {
        resultBar: 12,
        killCap: 480_000,
        treasureCap: 120_000,
        accuracyCap: 240_000,
        deathCap: 240_000,
        timeBonusCap: 226_787,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/svagg (Svagg\'s Last Stand); maximum per-column values.'
    },
    BT_Mission2Hard: {
        resultBar: 27,
        killCap: 1_080_000,
        treasureCap: 270_000,
        accuracyCap: 540_000,
        deathCap: 540_000,
        timeBonusCap: 510_590,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/svagg (Svagg\'s Last Stand); maximum per-column values.'
    },
    BT_Mission3: {
        resultBar: 14,
        killCap: 560_000,
        treasureCap: 140_000,
        accuracyCap: 280_000,
        deathCap: 280_000,
        timeBonusCap: 265_163,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/mouth (The Mouth of Meylour); maximum per-column values.'
    },
    BT_Mission4: {
        resultBar: 15,
        killCap: 600_000,
        treasureCap: 150_000,
        accuracyCap: 300_000,
        deathCap: 300_000,
        timeBonusCap: 277_588,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/dereliction (Dereliction of Duty); maximum per-column values.'
    },
    BT_Mission4Hard: {
        resultBar: 30,
        killCap: 1_200_000,
        treasureCap: 300_000,
        accuracyCap: 600_000,
        deathCap: 600_000,
        timeBonusCap: 527_105,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/dereliction (Dereliction of Duty); maximum per-column values.'
    },
    CH_MiniMission1: {
        resultBar: 11,
        killCap: 440_000,
        treasureCap: 110_000,
        accuracyCap: 220_000,
        deathCap: 220_000,
        timeBonusCap: 208_210,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/kyra (Lady Ellen Tilly\'s Tomb); maximum per-column values.'
    },
    CH_MiniMission2: {
        resultBar: 11,
        killCap: 440_000,
        treasureCap: 110_000,
        accuracyCap: 220_000,
        deathCap: 220_000,
        timeBonusCap: 203_585,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/dwarfkin (Sir Edmund Tilly\'s Tomb); maximum per-column values.'
    },
    CH_MiniMission2Hard: {
        resultBar: 26,
        killCap: 1_040_000,
        treasureCap: 260_000,
        accuracyCap: 520_000,
        deathCap: 520_000,
        timeBonusCap: 463_956,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/dwarfkin (Sir Edmund Tilly\'s Tomb); maximum per-column values.'
    },
    CH_MiniMission3: {
        resultBar: 12,
        killCap: 480_000,
        treasureCap: 120_000,
        accuracyCap: 240_000,
        deathCap: 240_000,
        timeBonusCap: 226_095,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/zed (Lord Hugh Tilly\'s Tomb); maximum per-column values.'
    },
    CH_MiniMission4: {
        resultBar: 12,
        killCap: 480_000,
        treasureCap: 120_000,
        accuracyCap: 240_000,
        deathCap: 240_000,
        timeBonusCap: 224_691,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/warik (Lord Peter Tilly\'s Tomb); maximum per-column values.'
    },
    CH_MiniMission5: {
        resultBar: 13,
        killCap: 520_000,
        treasureCap: 130_000,
        accuracyCap: 260_000,
        deathCap: 260_000,
        timeBonusCap: 242_652,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/hal (Baroness Julia Hocke); maximum per-column values.'
    },
    CH_MiniMission6: {
        resultBar: 13,
        killCap: 520_000,
        treasureCap: 130_000,
        accuracyCap: 260_000,
        deathCap: 260_000,
        timeBonusCap: 243_980,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/xal (Baron Karl Hocke); maximum per-column values.'
    },
    CH_MiniMission6Hard: {
        resultBar: 28,
        killCap: 1_120_000,
        treasureCap: 280_000,
        accuracyCap: 560_000,
        deathCap: 560_000,
        timeBonusCap: 517_659,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/xal (Baron Karl Hocke); maximum per-column values.'
    },
    CH_MiniMission7: {
        resultBar: 14,
        killCap: 560_000,
        treasureCap: 140_000,
        accuracyCap: 280_000,
        deathCap: 280_000,
        timeBonusCap: 260_449,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/ariston (Baron Symon Hocke); maximum per-column values.'
    },
    CH_MiniMission9: {
        resultBar: 15,
        killCap: 600_000,
        treasureCap: 150_000,
        accuracyCap: 300_000,
        deathCap: 300_000,
        timeBonusCap: 279_396,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/naj (General Sven Hocke); maximum per-column values.'
    },
    CH_Mission1: {
        resultBar: 11,
        killCap: 440_000,
        treasureCap: 110_000,
        accuracyCap: 220_000,
        deathCap: 220_000,
        timeBonusCap: 208_791,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/yagaga (Wither the Witch?); maximum per-column values.'
    },
    CH_Mission1Hard: {
        resultBar: 26,
        killCap: 1_040_000,
        treasureCap: 260_000,
        accuracyCap: 518_729,
        deathCap: 520_000,
        timeBonusCap: 482_887,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/yagaga (Wither the Witch?); maximum per-column values.'
    },
    CH_Mission2: {
        resultBar: 11,
        killCap: 440_000,
        treasureCap: 110_000,
        accuracyCap: 220_000,
        deathCap: 220_000,
        timeBonusCap: 174_786,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/storehouse (Gnole\'s Storehouse); maximum per-column values.'
    },
    CH_Mission2Hard: {
        resultBar: 26,
        killCap: 1_040_000,
        treasureCap: 260_000,
        accuracyCap: 519_082,
        deathCap: 520_000,
        timeBonusCap: 465_271,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/storehouse (Gnole\'s Storehouse); maximum per-column values.'
    },
    CH_Mission3: {
        resultBar: 13,
        killCap: 520_000,
        treasureCap: 130_000,
        accuracyCap: 260_000,
        deathCap: 260_000,
        timeBonusCap: 237_227,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/warslain (Undying Vendetta); maximum per-column values.'
    },
    CH_Mission3Hard: {
        resultBar: 28,
        killCap: 1_120_000,
        treasureCap: 280_000,
        accuracyCap: 560_000,
        deathCap: 560_000,
        timeBonusCap: 513_315,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/warslain (Undying Vendetta); maximum per-column values.'
    },
    CH_Mission4: {
        resultBar: 12,
        killCap: 480_000,
        treasureCap: 120_000,
        accuracyCap: 240_000,
        deathCap: 240_000,
        timeBonusCap: 220_207,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/pappy (Lord Tilly\'s Rest); maximum per-column values.'
    },
    CH_Mission4Hard: {
        resultBar: 27,
        killCap: 1_080_000,
        treasureCap: 270_000,
        accuracyCap: 537_879,
        deathCap: 540_000,
        timeBonusCap: 492_383,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/pappy (Lord Tilly\'s Rest); maximum per-column values.'
    },
    CH_Mission5: {
        resultBar: 12,
        killCap: 480_000,
        treasureCap: 120_000,
        accuracyCap: 240_000,
        deathCap: 240_000,
        timeBonusCap: 217_421,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/kamak (Embodiment of Evil); maximum per-column values.'
    },
    CH_Mission6: {
        resultBar: 14,
        killCap: 560_000,
        treasureCap: 140_000,
        accuracyCap: 280_000,
        deathCap: 280_000,
        timeBonusCap: 254_716,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/secret (Mausoleum of the Wise); maximum per-column values.'
    },
    CH_Mission7: {
        resultBar: 15,
        killCap: 600_000,
        treasureCap: 150_000,
        accuracyCap: 300_000,
        deathCap: 300_000,
        timeBonusCap: 271_884,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/glimpse (Rising Damned); maximum per-column values.'
    },
    CH_Mission7Hard: {
        resultBar: 30,
        killCap: 1_200_000,
        treasureCap: 300_000,
        accuracyCap: 597_351,
        deathCap: 600_000,
        timeBonusCap: 517_694,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/glimpse (Rising Damned); maximum per-column values.'
    },
    CH_Mission8: {
        resultBar: 15,
        killCap: 600_000,
        treasureCap: 150_000,
        accuracyCap: 300_000,
        deathCap: 300_000,
        timeBonusCap: 275_500,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/dogfather (Gnole\'s Last Stand); maximum per-column values.'
    },
    CH_Mission8Hard: {
        resultBar: 30,
        killCap: 1_200_000,
        treasureCap: 300_000,
        accuracyCap: 595_967,
        deathCap: 600_000,
        timeBonusCap: 535_039,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/dogfather (Gnole\'s Last Stand); maximum per-column values.'
    },
    DreamDragonDungeon: {
        resultBar: 5,
        killCap: 200_000,
        treasureCap: 50_000,
        accuracyCap: 100_000,
        deathCap: 100_000,
        timeBonusCap: 94_637,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/dragonkey (The Dragon\'s Dream); maximum per-column values.'
    },
    DreamDragonDungeonHard: {
        resultBar: 40,
        killCap: 1_600_000,
        treasureCap: 400_000,
        accuracyCap: 800_000,
        deathCap: 800_000,
        timeBonusCap: 749_088,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/dragonkey (The Dragon\'s Dream); maximum per-column values.'
    },
    EG_Mission1: {
        resultBar: 19,
        killCap: 760_000,
        treasureCap: 190_000,
        accuracyCap: 380_000,
        deathCap: 380_000,
        timeBonusCap: 352_871,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/ashen (The Ashen Dryad); maximum per-column values.'
    },
    EG_Mission2: {
        resultBar: 19,
        killCap: 760_000,
        treasureCap: 190_000,
        accuracyCap: 380_000,
        deathCap: 380_000,
        timeBonusCap: 339_000,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/limb (Out on a Limb); maximum per-column values.'
    },
    EG_Mission3: {
        resultBar: 20,
        killCap: 800_000,
        treasureCap: 200_000,
        accuracyCap: 400_000,
        deathCap: 400_000,
        timeBonusCap: 367_800,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/rotten (Rotten to the Roots); maximum per-column values.'
    },
    EG_Mission3Hard: {
        resultBar: 35,
        killCap: 1_400_000,
        treasureCap: 350_000,
        accuracyCap: 700_000,
        deathCap: 700_000,
        timeBonusCap: 656_101,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/rotten (Rotten to the Roots); maximum per-column values.'
    },
    EG_Mission4: {
        resultBar: 20,
        killCap: 800_000,
        treasureCap: 200_000,
        accuracyCap: 400_000,
        deathCap: 400_000,
        timeBonusCap: 378_870,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/hope (Hope Springs Eternal); maximum per-column values.'
    },
    EG_Mission4Hard: {
        resultBar: 35,
        killCap: 1_400_000,
        treasureCap: 350_000,
        accuracyCap: 700_000,
        deathCap: 700_000,
        timeBonusCap: 647_401,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/hope (Hope Springs Eternal); maximum per-column values.'
    },
    EG_Mission5: {
        resultBar: 20,
        killCap: 800_000,
        treasureCap: 200_000,
        accuracyCap: 399_547,
        deathCap: 400_000,
        timeBonusCap: 359_164,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/refuge (Refuge of the Damned); maximum per-column values.'
    },
    EG_Mission5Hard: {
        resultBar: 35,
        killCap: 1_400_000,
        treasureCap: 350_000,
        accuracyCap: 700_000,
        deathCap: 700_000,
        timeBonusCap: 641_798,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/refuge (Refuge of the Damned); maximum per-column values.'
    },
    GhostBossDungeon: {
        resultBar: 4,
        killCap: 160_000,
        treasureCap: 40_000,
        accuracyCap: 80_000,
        deathCap: 80_000,
        timeBonusCap: 75_400,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/nephit (Nephit\'s Quest); maximum per-column values.'
    },
    GhostBossDungeonHard: {
        resultBar: 39,
        killCap: 1_560_000,
        treasureCap: 390_000,
        accuracyCap: 780_000,
        deathCap: 780_000,
        timeBonusCap: 728_749,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/nephit (Nephit\'s Quest); maximum per-column values.'
    },
    GoblinRiverDungeon: {
        resultBar: 3,
        killCap: 120_000,
        treasureCap: 30_000,
        accuracyCap: 60_000,
        deathCap: 60_000,
        timeBonusCap: 57_260,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/river (Goblin Camp); maximum per-column values.'
    },
    GoblinRiverDungeonHard: {
        resultBar: 38,
        killCap: 1_520_000,
        treasureCap: 380_000,
        accuracyCap: 760_000,
        deathCap: 760_000,
        timeBonusCap: 712_725,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/river (Goblin Camp); maximum per-column values.'
    },
    JC_Mini1: {
        resultBar: 29,
        killCap: 1_160_000,
        treasureCap: 290_000,
        accuracyCap: 580_000,
        deathCap: 580_000,
        timeBonusCap: 490_165,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/westwing (The West Wing); maximum per-column values.'
    },
    JC_Mini1Hard: {
        resultBar: 44,
        killCap: 1_760_000,
        treasureCap: 440_000,
        accuracyCap: 880_000,
        deathCap: 880_000,
        timeBonusCap: 777_421,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/westwing (The West Wing); maximum per-column values.'
    },
    JC_Mini2: {
        resultBar: 29,
        killCap: 1_160_000,
        treasureCap: 290_000,
        accuracyCap: 580_000,
        deathCap: 580_000,
        timeBonusCap: 480_615,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/eastwing (The East Wing); maximum per-column values.'
    },
    JC_Mini2Hard: {
        resultBar: 44,
        killCap: 1_760_000,
        treasureCap: 440_000,
        accuracyCap: 880_000,
        deathCap: 880_000,
        timeBonusCap: 816_980,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/eastwing (The East Wing); maximum per-column values.'
    },
    JC_Mission1: {
        resultBar: 26,
        killCap: 1_040_000,
        treasureCap: 260_000,
        accuracyCap: 520_000,
        deathCap: 520_000,
        timeBonusCap: 476_156,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/welcome (The Welcome Party); maximum per-column values.'
    },
    JC_Mission10: {
        resultBar: 28,
        killCap: 1_120_000,
        treasureCap: 280_000,
        accuracyCap: 560_000,
        deathCap: 560_000,
        timeBonusCap: 531_433,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/vault (Ancient Vault); maximum per-column values.'
    },
    JC_Mission10Hard: {
        resultBar: 43,
        killCap: 1_720_000,
        treasureCap: 430_000,
        accuracyCap: 858_486,
        deathCap: 860_000,
        timeBonusCap: 797_190,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/vault (Ancient Vault); maximum per-column values.'
    },
    JC_Mission11: {
        resultBar: 27,
        killCap: 1_080_000,
        treasureCap: 270_000,
        accuracyCap: 540_000,
        deathCap: 540_000,
        timeBonusCap: 412_834,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/ringoffire (Ring of Fire); maximum per-column values.'
    },
    JC_Mission11Hard: {
        resultBar: 42,
        killCap: 1_680_000,
        treasureCap: 420_000,
        accuracyCap: 834_756,
        deathCap: 840_000,
        timeBonusCap: 707_992,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/ringoffire (Ring of Fire); maximum per-column values.'
    },
    JC_Mission1Hard: {
        resultBar: 41,
        killCap: 1_640_000,
        treasureCap: 410_000,
        accuracyCap: 820_000,
        deathCap: 820_000,
        timeBonusCap: 776_176,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/welcome (The Welcome Party); maximum per-column values.'
    },
    JC_Mission2: {
        resultBar: 27,
        killCap: 1_080_000,
        treasureCap: 270_000,
        accuracyCap: 540_000,
        deathCap: 540_000,
        timeBonusCap: 516_912,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/alley (Back Alley Deals); maximum per-column values.'
    },
    JC_Mission2Hard: {
        resultBar: 42,
        killCap: 1_680_000,
        treasureCap: 420_000,
        accuracyCap: 840_000,
        deathCap: 840_000,
        timeBonusCap: 780_264,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/alley (Back Alley Deals); maximum per-column values.'
    },
    JC_Mission3: {
        resultBar: 28,
        killCap: 1_120_000,
        treasureCap: 280_000,
        accuracyCap: 560_000,
        deathCap: 560_000,
        timeBonusCap: 502_441,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/prodigal (The Prodigal Son); maximum per-column values.'
    },
    JC_Mission3Hard: {
        resultBar: 43,
        killCap: 1_720_000,
        treasureCap: 430_000,
        accuracyCap: 860_000,
        deathCap: 860_000,
        timeBonusCap: 800_875,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/prodigal (The Prodigal Son); maximum per-column values.'
    },
    JC_Mission4: {
        resultBar: 29,
        killCap: 1_160_000,
        treasureCap: 290_000,
        accuracyCap: 580_000,
        deathCap: 580_000,
        timeBonusCap: 552_067,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/sewer (Sewer Suffering); maximum per-column values.'
    },
    JC_Mission4Hard: {
        resultBar: 44,
        killCap: 1_760_000,
        treasureCap: 440_000,
        accuracyCap: 880_000,
        deathCap: 880_000,
        timeBonusCap: 836_365,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/sewer (Sewer Suffering); maximum per-column values.'
    },
    JC_Mission6: {
        resultBar: 29,
        killCap: 1_160_000,
        treasureCap: 290_000,
        accuracyCap: 580_000,
        deathCap: 580_000,
        timeBonusCap: 520_985,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/dream (Dream Within a Dream); maximum per-column values.'
    },
    JC_Mission7: {
        resultBar: 30,
        killCap: 1_200_000,
        treasureCap: 300_000,
        accuracyCap: 600_000,
        deathCap: 600_000,
        timeBonusCap: 580_607,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/intervention (Royal Intervention); maximum per-column values.'
    },
    JC_Mission7Hard: {
        resultBar: 45,
        killCap: 1_800_000,
        treasureCap: 450_000,
        accuracyCap: 900_000,
        deathCap: 900_000,
        timeBonusCap: 854_809,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/intervention (Royal Intervention); maximum per-column values.'
    },
    JC_Mission8: {
        resultBar: 29,
        killCap: 1_160_000,
        treasureCap: 290_000,
        accuracyCap: 580_000,
        deathCap: 580_000,
        timeBonusCap: 484_095,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/attack (Attack of Opportunity); maximum per-column values.'
    },
    JC_Mission8Hard: {
        resultBar: 44,
        killCap: 1_760_000,
        treasureCap: 440_000,
        accuracyCap: 880_000,
        deathCap: 880_000,
        timeBonusCap: 721_578,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/attack (Attack of Opportunity); maximum per-column values.'
    },
    JC_Mission9: {
        resultBar: 28,
        killCap: 1_120_000,
        treasureCap: 280_000,
        accuracyCap: 560_000,
        deathCap: 560_000,
        timeBonusCap: 503_605,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/shadows (Hiding Out); maximum per-column values.'
    },
    JC_Mission9Hard: {
        resultBar: 43,
        killCap: 1_720_000,
        treasureCap: 430_000,
        accuracyCap: 854_530,
        deathCap: 860_000,
        timeBonusCap: 796_226,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/shadows (Hiding Out); maximum per-column values.'
    },
    OMM_Mission1: {
        resultBar: 16,
        killCap: 640_000,
        treasureCap: 160_000,
        accuracyCap: 320_000,
        deathCap: 320_000,
        timeBonusCap: 294_564,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/voice (Give Voice to Stone); maximum per-column values.'
    },
    OMM_Mission10: {
        resultBar: 18,
        killCap: 720_000,
        treasureCap: 180_000,
        accuracyCap: 360_000,
        deathCap: 360_000,
        timeBonusCap: 329_865,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/quary (All Shall be Ashes); maximum per-column values.'
    },
    OMM_Mission10Hard: {
        resultBar: 33,
        killCap: 1_320_000,
        treasureCap: 330_000,
        accuracyCap: 658_813,
        deathCap: 660_000,
        timeBonusCap: 603_818,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/quary (All Shall be Ashes); maximum per-column values.'
    },
    OMM_Mission11: {
        resultBar: 18,
        killCap: 720_000,
        treasureCap: 180_000,
        accuracyCap: 360_000,
        deathCap: 360_000,
        timeBonusCap: 335_103,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/heart (Meylour\'s Embers); maximum per-column values.'
    },
    OMM_Mission11Hard: {
        resultBar: 33,
        killCap: 1_320_000,
        treasureCap: 330_000,
        accuracyCap: 658_691,
        deathCap: 660_000,
        timeBonusCap: 604_111,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/heart (Meylour\'s Embers); maximum per-column values.'
    },
    OMM_Mission12: {
        resultBar: 14,
        killCap: 560_000,
        treasureCap: 140_000,
        accuracyCap: 280_000,
        deathCap: 280_000,
        timeBonusCap: 252_127,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/meylour (Death to Meylour); maximum per-column values.'
    },
    OMM_Mission12Hard: {
        resultBar: 36,
        killCap: 1_440_000,
        treasureCap: 360_000,
        accuracyCap: 720_000,
        deathCap: 720_000,
        timeBonusCap: 661_811,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/meylour (Death to Meylour); maximum per-column values.'
    },
    OMM_Mission2: {
        resultBar: 16,
        killCap: 640_000,
        treasureCap: 160_000,
        accuracyCap: 320_000,
        deathCap: 320_000,
        timeBonusCap: 296_193,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/garden (Rock Hulk Garden); maximum per-column values.'
    },
    OMM_Mission2Hard: {
        resultBar: 31,
        killCap: 1_240_000,
        treasureCap: 310_000,
        accuracyCap: 620_000,
        deathCap: 620_000,
        timeBonusCap: 572_092,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/garden (Rock Hulk Garden); maximum per-column values.'
    },
    OMM_Mission3: {
        resultBar: 16,
        killCap: 640_000,
        treasureCap: 160_000,
        accuracyCap: 320_000,
        deathCap: 320_000,
        timeBonusCap: 294_316,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/tyrant (Eye of the Tyrant); maximum per-column values.'
    },
    OMM_Mission4: {
        resultBar: 17,
        killCap: 680_000,
        treasureCap: 170_000,
        accuracyCap: 340_000,
        deathCap: 340_000,
        timeBonusCap: 315_078,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/armory (Abandoned Armory); maximum per-column values.'
    },
    OMM_Mission4Hard: {
        resultBar: 32,
        killCap: 1_280_000,
        treasureCap: 320_000,
        accuracyCap: 640_000,
        deathCap: 640_000,
        timeBonusCap: 582_169,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/armory (Abandoned Armory); maximum per-column values.'
    },
    OMM_Mission5: {
        resultBar: 17,
        killCap: 680_000,
        treasureCap: 170_000,
        accuracyCap: 340_000,
        deathCap: 340_000,
        timeBonusCap: 312_520,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/hunted (Hunted to the Edge); maximum per-column values.'
    },
    OMM_Mission5Hard: {
        resultBar: 32,
        killCap: 1_280_000,
        treasureCap: 320_000,
        accuracyCap: 638_728,
        deathCap: 640_000,
        timeBonusCap: 593_604,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/hunted (Hunted to the Edge); maximum per-column values.'
    },
    OMM_Mission6: {
        resultBar: 17,
        killCap: 680_000,
        treasureCap: 170_000,
        accuracyCap: 340_000,
        deathCap: 340_000,
        timeBonusCap: 284_990,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/forge (Forgotten Forge); maximum per-column values.'
    },
    OMM_Mission6Hard: {
        resultBar: 32,
        killCap: 1_280_000,
        treasureCap: 320_000,
        accuracyCap: 639_160,
        deathCap: 640_000,
        timeBonusCap: 577_431,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/forge (Forgotten Forge); maximum per-column values.'
    },
    OMM_Mission7: {
        resultBar: 17,
        killCap: 680_000,
        treasureCap: 170_000,
        accuracyCap: 340_000,
        deathCap: 340_000,
        timeBonusCap: 315_021,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/redoubt (Gnole\'s Roost); maximum per-column values.'
    },
    OMM_Mission7Hard: {
        resultBar: 32,
        killCap: 1_280_000,
        treasureCap: 320_000,
        accuracyCap: 640_000,
        deathCap: 640_000,
        timeBonusCap: 598_368,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/redoubt (Gnole\'s Roost); maximum per-column values.'
    },
    OMM_Mission8: {
        resultBar: 18,
        killCap: 720_000,
        treasureCap: 180_000,
        accuracyCap: 360_000,
        deathCap: 360_000,
        timeBonusCap: 338_067,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/veins (Veins of Meylour); maximum per-column values.'
    },
    OMM_Mission9: {
        resultBar: 18,
        killCap: 720_000,
        treasureCap: 180_000,
        accuracyCap: 360_000,
        deathCap: 360_000,
        timeBonusCap: 338_997,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/rebellion (The Growing Flame); maximum per-column values.'
    },
    OMM_Mission9Hard: {
        resultBar: 33,
        killCap: 1_320_000,
        treasureCap: 330_000,
        accuracyCap: 657_118,
        deathCap: 660_000,
        timeBonusCap: 610_692,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/rebellion (The Growing Flame); maximum per-column values.'
    },
    SD_Mission2: {
        resultBar: 23,
        killCap: 920_000,
        treasureCap: 230_000,
        accuracyCap: 451_930,
        deathCap: 460_000,
        timeBonusCap: 405_314,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/scarab (Scarab Invasion); maximum per-column values.'
    },
    SD_Mission2Hard: {
        resultBar: 38,
        killCap: 1_520_000,
        treasureCap: 380_000,
        accuracyCap: 757_212,
        deathCap: 760_000,
        timeBonusCap: 688_020,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/scarab (Scarab Invasion); maximum per-column values.'
    },
    SD_Mission3: {
        resultBar: 24,
        killCap: 960_000,
        treasureCap: 240_000,
        accuracyCap: 480_000,
        deathCap: 480_000,
        timeBonusCap: 418_163,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/gladiator (Blood and Sand); maximum per-column values.'
    },
    SD_Mission3Hard: {
        resultBar: 39,
        killCap: 1_560_000,
        treasureCap: 390_000,
        accuracyCap: 780_000,
        deathCap: 780_000,
        timeBonusCap: 688_650,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/gladiator (Blood and Sand); maximum per-column values.'
    },
    SD_Mission4: {
        resultBar: 24,
        killCap: 960_000,
        treasureCap: 240_000,
        accuracyCap: 480_000,
        deathCap: 480_000,
        timeBonusCap: 441_997,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/oasis (Goblin Diplomacy); maximum per-column values.'
    },
    SD_Mission4Hard: {
        resultBar: 39,
        killCap: 1_560_000,
        treasureCap: 390_000,
        accuracyCap: 780_000,
        deathCap: 780_000,
        timeBonusCap: 678_273,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/oasis (Goblin Diplomacy); maximum per-column values.'
    },
    SD_Mission5: {
        resultBar: 25,
        killCap: 1_000_000,
        treasureCap: 250_000,
        accuracyCap: 500_000,
        deathCap: 500_000,
        timeBonusCap: 463_586,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/sandworm (Ancient Unrest); maximum per-column values.'
    },
    SD_Mission5Hard: {
        resultBar: 40,
        killCap: 1_600_000,
        treasureCap: 400_000,
        accuracyCap: 793_867,
        deathCap: 800_000,
        timeBonusCap: 731_081,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/sandworm (Ancient Unrest); maximum per-column values.'
    },
    SD_Mission6: {
        resultBar: 25,
        killCap: 1_000_000,
        treasureCap: 250_000,
        accuracyCap: 500_000,
        deathCap: 500_000,
        timeBonusCap: 448_757,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/anchor (Legacy of the Magi); maximum per-column values.'
    },
    SD_Mission6Hard: {
        resultBar: 40,
        killCap: 1_600_000,
        treasureCap: 400_000,
        accuracyCap: 800_000,
        deathCap: 800_000,
        timeBonusCap: 758_107,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/anchor (Legacy of the Magi); maximum per-column values.'
    },
    SRN_Mission1: {
        resultBar: 6,
        killCap: 240_000,
        treasureCap: 60_000,
        accuracyCap: 120_000,
        deathCap: 120_000,
        timeBonusCap: 112_809,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/castout (Tower of the Tuatara); maximum per-column values.'
    },
    SRN_Mission2: {
        resultBar: 7,
        killCap: 280_000,
        treasureCap: 70_000,
        accuracyCap: 140_000,
        deathCap: 140_000,
        timeBonusCap: 132_769,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/yornak (Mystery of the Yornak); maximum per-column values.'
    },
    SRN_Mission2Hard: {
        resultBar: 32,
        killCap: 1_280_000,
        treasureCap: 320_000,
        accuracyCap: 640_000,
        deathCap: 640_000,
        timeBonusCap: 601_385,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/yornak (Mystery of the Yornak); maximum per-column values.'
    },
    SRN_Mission3: {
        resultBar: 8,
        killCap: 320_000,
        treasureCap: 80_000,
        accuracyCap: 160_000,
        deathCap: 160_000,
        timeBonusCap: 150_768,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/svar (Svar\'s Spite); maximum per-column values.'
    },
    SRN_Mission3Hard: {
        resultBar: 33,
        killCap: 1_320_000,
        treasureCap: 330_000,
        accuracyCap: 660_000,
        deathCap: 660_000,
        timeBonusCap: 601_234,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/svar (Svar\'s Spite); maximum per-column values.'
    },
    SRN_Mission4: {
        resultBar: 8,
        killCap: 320_000,
        treasureCap: 80_000,
        accuracyCap: 160_000,
        deathCap: 160_000,
        timeBonusCap: 151_400,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/ooyak (Lair of the Ooyak); maximum per-column values.'
    },
    SRN_Mission5: {
        resultBar: 9,
        killCap: 360_000,
        treasureCap: 90_000,
        accuracyCap: 180_000,
        deathCap: 180_000,
        timeBonusCap: 170_096,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/broodvictor (Citadel of the Vizier); maximum per-column values.'
    },
    SRN_Mission5Hard: {
        resultBar: 34,
        killCap: 1_360_000,
        treasureCap: 340_000,
        accuracyCap: 680_000,
        deathCap: 680_000,
        timeBonusCap: 634_985,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/broodvictor (Citadel of the Vizier); maximum per-column values.'
    },
    SRN_Mission6: {
        resultBar: 8,
        killCap: 320_000,
        treasureCap: 80_000,
        accuracyCap: 160_000,
        deathCap: 160_000,
        timeBonusCap: 150_319,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/mindless (Mindless Queen\'s Glade); maximum per-column values.'
    },
    SRN_Mission6Hard: {
        resultBar: 33,
        killCap: 1_320_000,
        treasureCap: 330_000,
        accuracyCap: 660_000,
        deathCap: 660_000,
        timeBonusCap: 619_353,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/mindless (Mindless Queen\'s Glade); maximum per-column values.'
    },
    SRN_Mission7: {
        resultBar: 9,
        killCap: 360_000,
        treasureCap: 90_000,
        accuracyCap: 180_000,
        deathCap: 180_000,
        timeBonusCap: 171_162,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/svath (The Great Green Svath); maximum per-column values.'
    },
    SRN_Mission7Hard: {
        resultBar: 34,
        killCap: 1_360_000,
        treasureCap: 340_000,
        accuracyCap: 680_000,
        deathCap: 680_000,
        timeBonusCap: 644_172,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/svath (The Great Green Svath); maximum per-column values.'
    },
    SwampRoadConnectionMission: {
        resultBar: 10,
        killCap: 400_000,
        treasureCap: 100_000,
        accuracyCap: 200_000,
        deathCap: 200_000,
        timeBonusCap: 187_760,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/arachnae (Arachnae\'s Swamp); maximum per-column values.'
    },
    SwampRoadConnectionMissionHard: {
        resultBar: 35,
        killCap: 1_400_000,
        treasureCap: 350_000,
        accuracyCap: 700_000,
        deathCap: 700_000,
        timeBonusCap: 636_380,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/arachnae (Arachnae\'s Swamp); maximum per-column values.'
    },
    TutorialBoat: {
        resultBar: 1,
        killCap: 40_000,
        treasureCap: 10_000,
        accuracyCap: 20_000,
        deathCap: 20_000,
        timeBonusCap: 17_561,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/assault (Lost at Sea); maximum per-column values.'
    },
    TutorialDungeon: {
        resultBar: 2,
        killCap: 80_000,
        treasureCap: 20_000,
        accuracyCap: 40_000,
        deathCap: 40_000,
        timeBonusCap: 36_992,
        evidence: 'Wayback 2017 Dungeon Blitz normal ranking table rankings/kidnap (Goblin Kidnappers); maximum per-column values.'
    },
    TutorialDungeonHard: {
        resultBar: 37,
        killCap: 1_480_000,
        treasureCap: 370_000,
        accuracyCap: 738_078,
        deathCap: 740_000,
        timeBonusCap: 674_998,
        evidence: 'Wayback 2017 Dungeon Blitz dread ranking table rankings/dread/kidnap (Goblin Kidnappers); maximum per-column values.'
    },
};

