import { Client } from '../core/Client';
import {
    buildDefaultDungeonScoreProfile,
    getDungeonScoreProfile,
    getDungeonScoreTotalCap,
    type ResolvedDungeonScoreProfile
} from '../core/DungeonScoreProfiles';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { isWolfsEndDungeonLevel } from '../core/WolfsEndDungeonStatsPolicy';
import {
    finalizeDungeonRun,
    getActiveDungeonRunStats,
    noteDungeonRunBossCutscene,
    noteDungeonRunCompletionProgress
} from '../core/DungeonRunStats';
import { buildDungeonRunScoreSummary } from '../core/DungeonRunStats';
import { EntityState } from '../core/Entity';
import { BuildingID } from '../core/Enums';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope, getScopeLevelName } from '../core/LevelScope';
import {
    getOrCreateSharedDungeonProgressState,
    usesSharedDungeonProgress
} from '../core/SharedDungeonProgress';
import { TutorialDungeonMechanics } from '../core/TutorialDungeonMechanics';
import { Character } from '../database/Database';
import { MissionDef, MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { RewardHandler } from './RewardHandler';

type MissionEntry = Record<string, any>;
type DungeonCompletionResult = {
    actualKills: number;
    totalScore: number;
    stars: number;
    resultBar: number;
    rank: number;
    killsScore: number;
    accuracyScore: number;
    deathsScore: number;
    treasureScore: number;
    timeBonusScore: number;
};

type DungeonMissionUpdateResult = {
    missionId: number;
    state: number;
    newlyCompleted: boolean;
    persistedStars: number;
    persistedScore: number;
};

type AggregateMissionReconcileResult = {
    missionId: number;
    changed: boolean;
    progressDelta: number;
    becameReadyToTurnIn: boolean;
};

type CollectibleKillProgressRule = {
    progressText: string;
    realm?: string;
    realms?: ReadonlySet<string>;
    ranks?: ReadonlySet<string>;
    names?: ReadonlySet<string>;
    namePrefixes?: readonly string[];
    parents?: ReadonlySet<string>;
};

export class MissionHandler {
    private static readonly MISSION_NOT_STARTED = 0;
    private static readonly MISSION_IN_PROGRESS = 1;
    private static readonly MISSION_READY_TO_TURN_IN = 2;
    private static readonly MISSION_CLAIMED = 3;
    private static readonly ATTACK_OF_OPPORTUNITY_MISSION_ID = 233;
    private static readonly ATTACK_OF_OPPORTUNITY_HARD_MISSION_ID = 254;
    private static readonly ATTACK_OF_OPPORTUNITY_SATELLITE_IDS = new Set([234, 235, 236]);
    private static readonly ATTACK_OF_OPPORTUNITY_HARD_SATELLITE_IDS = new Set([255, 256, 257]);
    static readonly DUNGEON_COMPLETION_SKIT_SETTLE_MS = 1500;
    static readonly DUNGEON_COMPLETION_MAX_DEFER_MS = 15000;
    static readonly CRAFT_TOWN_TUTORIAL_COMPLETION_DELAY_MS = 43 * 250;
    private static readonly PRIMED_CONTACT_DIALOGUE_COUNT = -1;
    private static readonly ACHIEVEMENT_MAMMOTH_IDOL_REWARD = 10;
    private static readonly CRAFT_TOWN_REPAIRED_KEEP_RANK = 5;
    private static readonly FLASH_DEFEATED_ENTITY_STATE = 6;
    private static readonly NEWBIE_ROAD_GOBLIN_KILL_NAMES = new Set([
        'GoblinArmorSword',
        'GoblinBrute',
        'GoblinClub',
        'GoblinDagger',
        'GoblinHatchet',
        'GoblinMiniBoss',
        'GoblinShamanHood',
        'GoblinShamanSkullHat'
    ]);
    private static readonly NEWBIE_ROAD_HARD_GOBLIN_KILL_NAMES = new Set([
        'GoblinArmorSwordHard',
        'GoblinBruteHard',
        'GoblinClubHard',
        'GoblinDaggerHard',
        'GoblinHatchetHard',
        'GoblinMiniBossHard',
        'GoblinShamanHoodHard',
        'GoblinShamanSkullHatHard'
    ]);
    private static readonly SWAMP_SPIDER_KILL_NAMES = new Set([
        'SwampSpider',
        'SwampSpider2',
        'SwampSpiderGiant',
        'SwampSpiderSuperGiant',
        'SwampSpiderQueen'
    ]);
    private static readonly SWAMP_SPIDER_HARD_KILL_NAMES = new Set([
        'SwampSpiderHard',
        'SwampSpider2Hard',
        'SwampSpiderGiantHard',
        'SwampSpiderSuperGiantHard',
        'SwampSpiderQueenHard'
    ]);
    private static readonly SWAMP_LIZARD_BANNER_KILL_NAMES = new Set([
        'LizardBanner'
    ]);
    private static readonly SWAMP_LIZARD_BANNER_HARD_KILL_NAMES = new Set([
        'LizardBannerHard'
    ]);
    private static readonly SWAMP_LIZARD_HELM_KILL_NAMES = new Set([
        'LizardHeavy'
    ]);
    private static readonly SWAMP_LIZARD_HELM_HARD_KILL_NAMES = new Set([
        'LizardHeavyHard'
    ]);
    private static readonly SWAMP_DEVOURER_TOOTH_KILL_NAMES = new Set([
        'DevourerShooting',
        'DevourerHeavy',
        'DevourerMiniBoss',
        'DevourerGreat'
    ]);
    private static readonly SWAMP_DEVOURER_TOOTH_HARD_KILL_NAMES = new Set([
        'DevourerShootingHard',
        'DevourerHeavyHard',
        'DevourerMiniBossHard',
        'DevourerGreatHard'
    ]);
    private static readonly CASTLE_LIZARD_PROBLEM_KILL_NAMES = new Set([
        'CastleLizard1',
        'CastleLizard2',
        'CastleLizard3',
        'CastleLizardBanner1',
        'CastleLizardCarnisaur1',
        'CastleLizardHeavy1',
        'CastleLizardHeavy2'
    ]);
    private static readonly CASTLE_LIZARD_PROBLEM_HARD_KILL_NAMES = new Set([
        'CastleLizard1Hard',
        'CastleLizard2Hard',
        'CastleLizard3Hard',
        'CastleLizardBanner1Hard',
        'CastleLizardCarnisaur1Hard',
        'CastleLizardHeavy1Hard',
        'CastleLizardHeavy2Hard'
    ]);
    private static readonly CEMETERY_HEIRLOOM_KILL_NAMES = new Set([
        'DogPackmate',
        'DogPackmate2',
        'DogAlpha',
        'DogRogue',
        'DogChieftain',
        'JackalPackmate',
        'JackalPackmate2',
        'JackalAlpha',
        'JackalRogue',
        'JackalChieftain'
    ]);
    private static readonly CEMETERY_HEIRLOOM_HARD_KILL_NAMES = new Set([
        'DogPackmateHard',
        'DogPackmate2Hard',
        'DogAlphaHard',
        'DogRogueHard',
        'DogChieftainHard',
        'JackalPackmateHard',
        'JackalPackmate2Hard',
        'JackalAlphaHard',
        'JackalRogueHard',
        'JackalChieftainHard'
    ]);
    private static readonly STORMSHARD_GNOME_KILL_NAMES = new Set([
        'CaveGnome',
        'PuckShadow',
        'PuckShadow2',
        'PuckShadowServant'
    ]);
    private static readonly STORMSHARD_GNOME_HARD_KILL_NAMES = new Set([
        'CaveGnomeHard',
        'PuckShadowHard',
        'PuckShadow2Hard',
        'PuckShadowServantHard'
    ]);
    private static readonly STORMSHARD_CYCLOPS_KILL_NAMES = new Set([
        'Cyclops',
        'CyclopsCoward',
        'CyclopsBerserker',
        'CyclopsChieftain',
        'StormCyclops',
        'StormCyclopsCoward',
        'StormCyclopsBerserker',
        'StormCyclopsChieftain',
        'RockCyclops',
        'RockCyclopsCoward',
        'RockCyclopsBerserker',
        'RockCyclopsChieftain',
        'MagmaCyclopsLt01',
        'MagmaCyclopsLt02',
        'MagmaCyclopsLt03',
        'MagmaCyclopsLt04',
        'MagmaCyclopsMiniBoss',
        'MagmaCyclopsBoss'
    ]);
    private static readonly STORMSHARD_CYCLOPS_HARD_KILL_NAMES = new Set([
        'CyclopsHard',
        'CyclopsCowardHard',
        'CyclopsBerserkerHard',
        'CyclopsChieftainHard',
        'StormCyclopsHard',
        'StormCyclopsCowardHard',
        'StormCyclopsBerserkerHard',
        'StormCyclopsChieftainHard',
        'RockCyclopsHard',
        'RockCyclopsCowardHard',
        'RockCyclopsBerserkerHard',
        'RockCyclopsChieftainHard',
        'MagmaCyclopsLt01Hard',
        'MagmaCyclopsLt02Hard',
        'MagmaCyclopsLt03Hard',
        'MagmaCyclopsLt04Hard',
        'MagmaCyclopsMiniBossHard',
        'MagmaCyclopsBossHard'
    ]);
    private static readonly STORMSHARD_SPIDER_KILL_NAMES = new Set([
        'CaveSpider',
        'CaveSpider2',
        'AbominationSpider',
        'LeapingSpider',
        'LeapingSpider2'
    ]);
    private static readonly STORMSHARD_SPIDER_HARD_KILL_NAMES = new Set([
        'CaveSpiderHard',
        'CaveSpider2Hard',
        'AbominationSpiderHard',
        'LeapingSpiderHard',
        'LeapingSpider2Hard'
    ]);
    private static readonly STORMSHARD_ROCK_HULK_KILL_NAMES = new Set([
        'MeylourHulk',
        'RockHulkMini',
        'GraniteRockHulkMini',
        'MarbleRockHulkMini',
        'RockHulk',
        'GraniteRockHulk',
        'MarbleRockHulk',
        'RockHulkGreater',
        'RockHulkKing',
        'MagmaRockHulkMini',
        'MagmaRockHulk'
    ]);
    private static readonly STORMSHARD_ROCK_HULK_HARD_KILL_NAMES = new Set([
        'MeylourHulkHard',
        'RockHulkMiniHard',
        'GraniteRockHulkMiniHard',
        'MarbleRockHulkMiniHard',
        'RockHulkHard',
        'GraniteRockHulkHard',
        'MarbleRockHulkHard',
        'RockHulkGreaterHard',
        'RockHulkKingHard',
        'MagmaRockHulkMiniHard',
        'MagmaRockHulkHard'
    ]);
    private static readonly STORMSHARD_LION_JEWELRY_KILL_NAMES = new Set([
        'LionPridemate',
        'LionPridemate2',
        'LionAlpha',
        'LionAlpha2',
        'LionGreater',
        'LionLord',
        'CougarWarrior',
        'CougarWarrior2',
        'CougarGreater',
        'CougarGreater2'
    ]);
    private static readonly STORMSHARD_LION_JEWELRY_HARD_KILL_NAMES = new Set([
        'LionPridemateHard',
        'LionPridemate2Hard',
        'LionAlphaHard',
        'LionAlpha2Hard',
        'LionGreaterHard',
        'LionLordHard',
        'CougarWarriorHard',
        'CougarWarrior2Hard',
        'CougarGreaterHard',
        'CougarGreater2Hard'
    ]);
    private static readonly GLADE_EMBER_KILL_NAMES = new Set([
        'Ember',
        'Ember2'
    ]);
    private static readonly GLADE_EMBER_HARD_KILL_NAMES = new Set([
        'EmberHard',
        'Ember2Hard'
    ]);
    private static readonly GLADE_DARK_TOTEM_KILL_NAMES = new Set([
        'AshenDryad',
        'AshenDryad2',
        'AshenDryadWizard',
        'AshenDryadHero'
    ]);
    private static readonly GLADE_DARK_TOTEM_HARD_KILL_NAMES = new Set([
        'AshenDryadHard',
        'AshenDryad2Hard',
        'AshenDryadWizardHard',
        'AshenDryadHeroHard'
    ]);
    private static readonly GLADE_PRIEST_MASK_KILL_NAMES = new Set([
        'FirePriest',
        'FirePriest2',
        'FirePriestWizard',
        'FirePriestBoss'
    ]);
    private static readonly GLADE_PRIEST_MASK_HARD_KILL_NAMES = new Set([
        'FirePriestHard',
        'FirePriest2Hard',
        'FirePriestWizardHard',
        'FirePriestBossHard'
    ]);
    private static readonly CASTLE_DREAD_MASK_KILL_NAMES = new Set([
        'DreadPaladin',
        'DreadPaladin2',
        'DreadPaladin3',
        'DreadChampion',
        'DreadChampion2',
        'DreadChampion3',
        'DreadLord'
    ]);
    private static readonly CASTLE_DREAD_MASK_HARD_KILL_NAMES = new Set([
        'DreadPaladinHard',
        'DreadPaladin2Hard',
        'DreadPaladin3Hard',
        'DreadChampionHard',
        'DreadChampion2Hard',
        'DreadChampion3Hard',
        'DreadLordHard'
    ]);
    private static readonly SHAZARI_SCORPION_STINGER_KILL_NAMES = new Set([
        'ScarabPredator',
        'ScarabPredator2',
        'ScarabScorpion'
    ]);
    private static readonly SHAZARI_SCORPION_STINGER_HARD_KILL_NAMES = new Set([
        'ScarabPredatorHard',
        'ScarabPredator2Hard',
        'ScarabScorpionHard'
    ]);
    private static readonly SHAZARI_WASP_HIVE_KILL_NAMES = new Set([
        'TreeHiveSpawner'
    ]);
    private static readonly SHAZARI_WASP_HIVE_HARD_KILL_NAMES = new Set([
        'TreeHiveSpawnerHard'
    ]);
    private static readonly SHAZARI_OUTLANDER_KILL_NAMES = new Set([
        'OutlanderGladiator',
        'OutlanderRogue',
        'OutlanderMinotaur',
        'OutlanderMinotaur2',
        'OutlanderWyrm',
        'OutlanderBoss'
    ]);
    private static readonly SHAZARI_OUTLANDER_HARD_KILL_NAMES = new Set([
        'OutlanderGladiatorHard',
        'OutlanderRogueHard',
        'OutlanderMinotaurHard',
        'OutlanderMinotaur2Hard',
        'OutlanderWyrmHard',
        'OutlanderBossHard'
    ]);
    private static readonly SHAZARI_GIANT_KILL_NAMES = new Set([
        'OasisGiant',
        'OasisGiant2',
        'OasisWarlock',
        'OasisColossus',
        'OasisVizierYellow',
        'OasisVizierGreen',
        'OasisVizierRed',
        'OasisVizier'
    ]);
    private static readonly SHAZARI_GIANT_HARD_KILL_NAMES = new Set([
        'OasisGiantHard',
        'OasisGiant2Hard',
        'OasisWarlockHard',
        'OasisColossusHard',
        'OasisVizierYellowHard',
        'OasisVizierGreenHard',
        'OasisVizierRedHard',
        'OasisVizierHard'
    ]);
    private static readonly SHAZARI_SANDWORM_KILL_NAMES = new Set([
        'SandWorm',
        'SandWorm2',
        'SandWormGreater'
    ]);
    private static readonly SHAZARI_SANDWORM_HARD_KILL_NAMES = new Set([
        'SandWormHard',
        'SandWorm2Hard',
        'SandWormGreaterHard'
    ]);
    private static readonly JADE_IMPERIAL_INSIGNIA_KILL_NAMES = new Set([
        'ImperialMagus',
        'ImperialGuard',
        'ImperialMagi',
        'ImperialMagi2',
        'GuardCaptain',
        'ImperialChampion',
        'DefectorMage',
        'TowerGuard1',
        'TowerGuard2',
        'ShadowPuppet'
    ]);
    private static readonly JADE_IMPERIAL_INSIGNIA_HARD_KILL_NAMES = new Set([
        'ImperialMagusHard',
        'ImperialGuardHard',
        'ImperialMagiHard',
        'ImperialMagi2Hard',
        'GuardCaptainHard',
        'ImperialChampionHard',
        'DefectorMageHard',
        'TowerGuard1Hard',
        'TowerGuard2Hard',
        'ShadowPuppetHard'
    ]);
    private static readonly JADE_RATLING_MUSHROOM_KILL_NAMES = new Set([
        'RatlingSword',
        'RatlingMace',
        'RatlingArmor',
        'RatlingShaman',
        'RatlingShamanHood',
        'RatlingKing'
    ]);
    private static readonly JADE_RATLING_MUSHROOM_HARD_KILL_NAMES = new Set([
        'RatlingSwordHard',
        'RatlingMaceHard',
        'RatlingArmorHard',
        'RatlingShamanHard',
        'RatlingShamanHoodHard',
        'RatlingKingHard'
    ]);
    private static readonly JADE_BRIGAND_NECKLACE_KILL_NAMES = new Set([
        'BrigandBrawler',
        'BrigandBrawler2',
        'BrigandCutthroat',
        'BrigandCutthroat2',
        'BrigandCryomancer',
        'BrigandChamp'
    ]);
    private static readonly JADE_BRIGAND_NECKLACE_HARD_KILL_NAMES = new Set([
        'BrigandBrawlerHard',
        'BrigandBrawler2Hard',
        'BrigandCutthroatHard',
        'BrigandCutthroat2Hard',
        'BrigandCryomancerHard',
        'BrigandChampHard'
    ]);
    private static readonly JADE_DEMON_TEAR_KILL_NAMES = new Set([
        'AbyssalStinger',
        'GreaterAbyssalStinger',
        'GreaterDemonMaligner',
        'DemonReaper',
        'DemonReaver',
        'Ghoul',
        'Ghoul2',
        'ShadeWarrior',
        'ShadeMage',
        'ShadeMage2',
        'ShadeSummoner',
        'ShadeSummoner2',
        'ShadeInquisitor',
        'DemonMaligner'
    ]);
    private static readonly JADE_DEMON_TEAR_HARD_KILL_NAMES = new Set([
        'AbyssalStingerHard',
        'GreaterAbyssalStingerHard',
        'GreaterDemonMalignerHard',
        'DemonReaperHard',
        'DemonReaverHard',
        'GhoulHard',
        'Ghoul2Hard',
        'ShadeWarriorHard',
        'ShadeMageHard',
        'ShadeMage2Hard',
        'ShadeSummonerHard',
        'ShadeSummoner2Hard',
        'ShadeInquisitor2Hard',
        'DemonMalignerHard'
    ]);
    private static readonly KILL_PROGRESS_TARGETS: Readonly<Record<number, ReadonlySet<string>>> = {
        [MissionID.GetGoblinNoserings]: new Set(['GoblinBrute']),
        [MissionID.GetGoblinWands]: new Set(['GoblinShamanHood', 'GoblinShamanSkullHat']),
        [MissionID.GetGoblinNoseringsHard]: new Set(['GoblinBruteHard']),
        [MissionID.GetGoblinWandsHard]: new Set(['GoblinShamanHoodHard', 'GoblinShamanSkullHatHard']),
        [MissionID.KillGoblins]: MissionHandler.NEWBIE_ROAD_GOBLIN_KILL_NAMES,
        [MissionID.KillGoblinsHard]: MissionHandler.NEWBIE_ROAD_HARD_GOBLIN_KILL_NAMES,
        [MissionID.GetLizardBanners]: MissionHandler.SWAMP_LIZARD_BANNER_KILL_NAMES,
        [MissionID.GetLizardBannersHard]: MissionHandler.SWAMP_LIZARD_BANNER_HARD_KILL_NAMES,
        [MissionID.GetSpiderFangs]: MissionHandler.SWAMP_SPIDER_KILL_NAMES,
        [MissionID.GetSpiderFangsHard]: MissionHandler.SWAMP_SPIDER_HARD_KILL_NAMES,
        [MissionID.GetDevourerTeeth]: MissionHandler.SWAMP_DEVOURER_TOOTH_KILL_NAMES,
        [MissionID.GetDevourerTeethHard]: MissionHandler.SWAMP_DEVOURER_TOOTH_HARD_KILL_NAMES,
        [MissionID.GetLizardGreatHelm]: MissionHandler.SWAMP_LIZARD_HELM_KILL_NAMES,
        [MissionID.GetLizardGreatHelmHard]: MissionHandler.SWAMP_LIZARD_HELM_HARD_KILL_NAMES,
        [MissionID.RetrieveHeirlooms]: MissionHandler.CEMETERY_HEIRLOOM_KILL_NAMES,
        [MissionID.RetrieveHeirloomsHard]: MissionHandler.CEMETERY_HEIRLOOM_HARD_KILL_NAMES,
        [MissionID.SpiritProblem]: MissionHandler.CASTLE_LIZARD_PROBLEM_KILL_NAMES,
        [MissionID.SpiritProblemHard]: MissionHandler.CASTLE_LIZARD_PROBLEM_HARD_KILL_NAMES,
        [MissionID.GetHobgoblinNoserings]: new Set(['BlackGoblinBrute']),
        [MissionID.GetHobgoblinNoseringsHard]: new Set(['BlackGoblinBruteHard']),
        [MissionID.CollectRockShards]: MissionHandler.STORMSHARD_ROCK_HULK_KILL_NAMES,
        [MissionID.CollectRockShardsHard]: MissionHandler.STORMSHARD_ROCK_HULK_HARD_KILL_NAMES,
        [MissionID.DriveAwayGnomes]: MissionHandler.STORMSHARD_GNOME_KILL_NAMES,
        [MissionID.DriveAwayGnomesHard]: MissionHandler.STORMSHARD_GNOME_HARD_KILL_NAMES,
        [MissionID.SquashSomeSpiders]: MissionHandler.STORMSHARD_SPIDER_KILL_NAMES,
        [MissionID.SquashSomeSpidersHard]: MissionHandler.STORMSHARD_SPIDER_HARD_KILL_NAMES,
        [MissionID.SlayCyclops]: MissionHandler.STORMSHARD_CYCLOPS_KILL_NAMES,
        [MissionID.SlayCyclopsHard]: MissionHandler.STORMSHARD_CYCLOPS_HARD_KILL_NAMES,
        [MissionID.GatherLionJewelry]: MissionHandler.STORMSHARD_LION_JEWELRY_KILL_NAMES,
        [MissionID.GatherLionJewelryHard]: MissionHandler.STORMSHARD_LION_JEWELRY_HARD_KILL_NAMES,
        [MissionID.GatherDarkTotems]: MissionHandler.GLADE_DARK_TOTEM_KILL_NAMES,
        [MissionID.GatherDarkTotemsHard]: MissionHandler.GLADE_DARK_TOTEM_HARD_KILL_NAMES,
        [MissionID.GatherPriestMasks]: MissionHandler.GLADE_PRIEST_MASK_KILL_NAMES,
        [MissionID.GatherPriestMasksHard]: MissionHandler.GLADE_PRIEST_MASK_HARD_KILL_NAMES,
        [MissionID.KillGladeEmbers]: MissionHandler.GLADE_EMBER_KILL_NAMES,
        [MissionID.KillGladeEmbersHard]: MissionHandler.GLADE_EMBER_HARD_KILL_NAMES,
        [MissionID.GatherDreadMasks]: MissionHandler.CASTLE_DREAD_MASK_KILL_NAMES,
        [MissionID.GatherDreadMasksHard]: MissionHandler.CASTLE_DREAD_MASK_HARD_KILL_NAMES,
        [MissionID.GatherScorpionStingers]: MissionHandler.SHAZARI_SCORPION_STINGER_KILL_NAMES,
        [MissionID.GatherScorpionStingersHard]: MissionHandler.SHAZARI_SCORPION_STINGER_HARD_KILL_NAMES,
        [MissionID.DestroyWaspHives]: MissionHandler.SHAZARI_WASP_HIVE_KILL_NAMES,
        [MissionID.DestroyWaspHivesHard]: MissionHandler.SHAZARI_WASP_HIVE_HARD_KILL_NAMES,
        [MissionID.CollectGoblinCharms]: MissionHandler.SHAZARI_OUTLANDER_KILL_NAMES,
        [MissionID.CollectGoblinCharmsHard]: MissionHandler.SHAZARI_OUTLANDER_HARD_KILL_NAMES,
        [MissionID.CollectGiantBracers]: MissionHandler.SHAZARI_GIANT_KILL_NAMES,
        [MissionID.CollectGiantBracersHard]: MissionHandler.SHAZARI_GIANT_HARD_KILL_NAMES,
        [MissionID.CollectWormGlands]: MissionHandler.SHAZARI_SANDWORM_KILL_NAMES,
        [MissionID.CollectWormGlandsHard]: MissionHandler.SHAZARI_SANDWORM_HARD_KILL_NAMES,
        [MissionID.CollectImperialInsignias]: MissionHandler.JADE_IMPERIAL_INSIGNIA_KILL_NAMES,
        [MissionID.CollectImperialInsigniasHard]: MissionHandler.JADE_IMPERIAL_INSIGNIA_HARD_KILL_NAMES,
        [MissionID.CollectStolenMushrooms]: MissionHandler.JADE_RATLING_MUSHROOM_KILL_NAMES,
        [MissionID.CollectStolenMushroomsHard]: MissionHandler.JADE_RATLING_MUSHROOM_HARD_KILL_NAMES,
        [MissionID.CollectBrigandNecklaces]: MissionHandler.JADE_BRIGAND_NECKLACE_KILL_NAMES,
        [MissionID.CollectBrigandNecklacesHard]: MissionHandler.JADE_BRIGAND_NECKLACE_HARD_KILL_NAMES,
        [MissionID.CollectDemonTears]: MissionHandler.JADE_DEMON_TEAR_KILL_NAMES,
        [MissionID.CollectDemonTearsHard]: MissionHandler.JADE_DEMON_TEAR_HARD_KILL_NAMES
    };
    private static readonly SETTLE_THE_DEAD_MISSION_IDS = new Set([
        MissionID.SettleTheDead,
        MissionID.SettleTheDeadHard
    ]);
    private static readonly COLLECTIBLE_KILL_PROGRESS_RULES: readonly CollectibleKillProgressRule[] = [
        {
            progressText: 'Devourer Tooth',
            realm: 'Devourer',
            ranks: new Set(['Lieutenant', 'MiniBoss', 'Boss'])
        },
        {
            progressText: 'Spider Fang',
            realm: 'Spider',
            names: new Set([
                ...MissionHandler.SWAMP_SPIDER_KILL_NAMES,
                ...MissionHandler.SWAMP_SPIDER_HARD_KILL_NAMES
            ])
        },
        {
            progressText: 'Lizard Banner',
            names: new Set([
                ...MissionHandler.SWAMP_LIZARD_BANNER_KILL_NAMES,
                ...MissionHandler.SWAMP_LIZARD_BANNER_HARD_KILL_NAMES
            ])
        },
        {
            progressText: 'Great Helm',
            names: new Set([
                ...MissionHandler.SWAMP_LIZARD_HELM_KILL_NAMES,
                ...MissionHandler.SWAMP_LIZARD_HELM_HARD_KILL_NAMES
            ])
        },
        {
            progressText: 'Heirloom',
            realms: new Set(['Wolf'])
        },
        {
            progressText: 'Alurite',
            realms: new Set(['RockHulk'])
        },
        {
            progressText: 'Stolen Jewelry',
            realms: new Set(['Lion'])
        },
        {
            progressText: 'Dark Totem',
            realms: new Set(['Dryad'])
        },
        {
            progressText: 'Mask of Meylour',
            namePrefixes: ['FirePriest', 'Meylour']
        },
        {
            progressText: 'Dread Mask',
            realms: new Set(['Dread'])
        },
        {
            progressText: 'Scorpion Stinger',
            parents: new Set(['ScorpionBase'])
        },
        {
            progressText: 'Goblin Memory Charm',
            namePrefixes: ['Outlander']
        },
        {
            progressText: 'Seelie Bracer',
            realms: new Set(['Giant'])
        },
        {
            progressText: 'Sandworm Mucus Gland',
            namePrefixes: ['SandWorm']
        },
        {
            progressText: 'Imperial Insignia',
            realms: new Set(['Imperial'])
        },
        {
            progressText: 'Mokie Shrooms',
            realms: new Set(['Ratling'])
        },
        {
            progressText: 'Brigand Necklace',
            namePrefixes: ['Brigand']
        },
        {
            progressText: 'Demon Tear',
            realms: new Set(['Demon', 'Shade'])
        }
    ];

    static repairEarlyStoryOnLogin(
        character: Character,
        currentLevelRaw: string
    ): { didMutate: boolean; addedMissionId: number } {
        const currentLevel = String(currentLevelRaw || character.CurrentLevel?.name || '');
        const questProgress = Number(character.questTrackerState ?? 0);
        let didMutate = false;
        let addedMissionId = 0;

        const mission1State = MissionHandler.getMissionState(character, MissionID.DefendTheShip);
        const mission2State = MissionHandler.getMissionState(character, MissionID.MeetTheTown);

        const shouldBootstrapMission1 =
            mission1State === MissionHandler.MISSION_NOT_STARTED &&
            mission2State === MissionHandler.MISSION_NOT_STARTED &&
            (
                questProgress >= 100 ||
                currentLevel === 'TutorialBoat' ||
                (
                    currentLevel === 'NewbieRoad' &&
                    Number(character.level ?? 1) <= 2
                )
            );

        if (shouldBootstrapMission1) {
            const initialMission1State =
                questProgress >= 100
                    ? MissionHandler.MISSION_READY_TO_TURN_IN
                    : MissionHandler.MISSION_IN_PROGRESS;
            MissionHandler.setMissionState(
                character,
                MissionID.DefendTheShip,
                initialMission1State,
                MissionLoader.getMissionDef(MissionID.DefendTheShip),
                { currCount: initialMission1State >= MissionHandler.MISSION_READY_TO_TURN_IN ? 1 : 0 }
            );
            if (character.questTrackerState == null) {
                character.questTrackerState = 0;
            }
            didMutate = true;
            addedMissionId = MissionID.DefendTheShip;
        }

        const repairedMission1State = MissionHandler.getMissionState(character, MissionID.DefendTheShip);
        if (
            mission2State === MissionHandler.MISSION_NOT_STARTED &&
            questProgress >= 100 &&
            repairedMission1State === MissionHandler.MISSION_IN_PROGRESS
        ) {
            MissionHandler.setMissionState(
                character,
                MissionID.DefendTheShip,
                MissionHandler.MISSION_READY_TO_TURN_IN,
                MissionLoader.getMissionDef(MissionID.DefendTheShip),
                { currCount: 1 }
            );
            didMutate = true;
        }

        if (
            currentLevel !== 'TutorialBoat' &&
            mission2State === MissionHandler.MISSION_NOT_STARTED &&
            MissionHandler.getMissionState(character, MissionID.DefendTheShip) >= MissionHandler.MISSION_CLAIMED
        ) {
            const mission2Def = MissionLoader.getMissionDef(MissionID.MeetTheTown);
            if (mission2Def && MissionHandler.canStartMission(character, mission2Def)) {
                MissionHandler.setMissionState(
                    character,
                    MissionID.MeetTheTown,
                    MissionHandler.getInitialMissionState(mission2Def),
                    mission2Def,
                    { currCount: 0 }
                );
                didMutate = true;
                if (addedMissionId === 0) {
                    addedMissionId = MissionID.MeetTheTown;
                }
            }
        }

        const instantReturnMissionId = MissionHandler.primeZoneInstantReturnMission(character);
        if (instantReturnMissionId > 0) {
            didMutate = true;
            if (addedMissionId === 0) {
                addedMissionId = instantReturnMissionId;
            }
        }

        if (MissionHandler.normalizeInstantReturnMissionStates(character)) {
            didMutate = true;
        }

        const chainedDungeonMissionId = MissionHandler.primeMissingChainedDungeonFollowup(character);
        if (chainedDungeonMissionId > 0) {
            didMutate = true;
            if (addedMissionId === 0) {
                addedMissionId = chainedDungeonMissionId;
            }
        }

        if (MissionHandler.reconcileAttackOfOpportunityAggregateProgress(character).changed) {
            didMutate = true;
        }

        if (
            currentLevel === 'CraftTown' &&
            questProgress >= 100 &&
            MissionHandler.getMissionState(character, MissionID.ClearYourHouse) === MissionHandler.MISSION_IN_PROGRESS
        ) {
            const keepMissionDef = MissionLoader.getMissionDef(MissionID.ClearYourHouse);
            MissionHandler.setMissionState(
                character,
                MissionID.ClearYourHouse,
                MissionHandler.MISSION_READY_TO_TURN_IN,
                keepMissionDef,
                { currCount: Math.max(1, Number(keepMissionDef?.CompleteCount ?? 1)) }
            );
            MissionHandler.ensureCraftTownKeepRepaired(character);
            didMutate = true;
        }

        if (
            MissionHandler.getMissionState(character, MissionID.ClearYourHouse) >= MissionHandler.MISSION_CLAIMED &&
            Number(character.questTrackerState ?? 0) < 100
        ) {
            character.questTrackerState = 100;
            didMutate = true;
        }

        if (
            MissionHandler.getMissionState(character, MissionID.ClearYourHouse) >= MissionHandler.MISSION_CLAIMED &&
            MissionHandler.ensureCraftTownKeepRepaired(character)
        ) {
            didMutate = true;
        }

        return { didMutate, addedMissionId };
    }

    private static primeZoneInstantReturnMission(character: Character): number {
        for (let missionId = 1; missionId <= MissionLoader.getTotalMissions(); missionId++) {
            if (MissionHandler.getMissionState(character, missionId) !== MissionHandler.MISSION_NOT_STARTED) {
                continue;
            }

            const missionDef = MissionLoader.getMissionDef(missionId);
            if (!missionDef || !MissionHandler.canStartMission(character, missionDef)) {
                continue;
            }

            if (!MissionHandler.missionStartsReadyToTurnIn(missionDef)) {
                continue;
            }

            if (String(missionDef.ContactName ?? '').trim()) {
                continue;
            }

            const initialState = MissionHandler.getInitialMissionState(missionDef);
            MissionHandler.setMissionState(character, missionId, initialState, missionDef, { currCount: 0 });
            return missionId;
        }

        return 0;
    }

    private static primeMissingChainedDungeonFollowup(character: Character): number {
        for (let missionId = 1; missionId <= MissionLoader.getTotalMissions(); missionId++) {
            const completedMissionDef = MissionLoader.getMissionDef(missionId);
            if (!completedMissionDef || MissionHandler.getMissionState(character, missionId) < MissionHandler.MISSION_CLAIMED) {
                continue;
            }

            const completedDungeon = LevelConfig.normalizeLevelName(completedMissionDef.Dungeon);
            if (!completedDungeon || !LevelConfig.isDungeonLevel(completedDungeon)) {
                continue;
            }

            const nextDungeon = LevelConfig.normalizeLevelName(LevelConfig.getDoorTarget(completedDungeon, 2));
            if (!nextDungeon || !LevelConfig.isDungeonLevel(nextDungeon)) {
                continue;
            }

            const followupMissionDef = MissionLoader.findPrimaryMissionByDungeon(nextDungeon);
            if (!followupMissionDef || MissionHandler.getMissionState(character, followupMissionDef.MissionID) !== MissionHandler.MISSION_NOT_STARTED) {
                continue;
            }

            const completedMissionName = String(completedMissionDef.MissionName ?? '').trim();
            const requiresCompletedMission = (followupMissionDef.PreReqMissions ?? [])
                .some((missionName) => String(missionName ?? '').trim() === completedMissionName);
            if (!requiresCompletedMission || !MissionHandler.canStartMission(character, followupMissionDef)) {
                continue;
            }

            const initialState = MissionHandler.getInitialMissionState(followupMissionDef);
            MissionHandler.setMissionState(
                character,
                followupMissionDef.MissionID,
                initialState,
                followupMissionDef,
                { currCount: 0 }
            );
            return followupMissionDef.MissionID;
        }

        return 0;
    }

    static syncMissionStateToClient(client: Client): void {
        if (!client.character) {
            return;
        }

        MissionHandler.sendQuestProgress(client, Math.max(0, Number(client.character.questTrackerState ?? 0)));
    }

    static async prepareFullClearDungeonEntry(client: Client): Promise<void> {
        if (!client.character) {
            return;
        }

        const currentLevel =
            LevelConfig.normalizeLevelName(client.currentLevel || String(client.character.CurrentLevel?.name ?? '')) ||
            client.currentLevel ||
            String(client.character.CurrentLevel?.name ?? '');
        if (!MissionHandler.isFullClearOnlyDungeon(currentLevel)) {
            return;
        }

        const missionDef = MissionLoader.findPrimaryMissionByDungeon(currentLevel);
        if (!missionDef) {
            return;
        }

        const missionEntry = MissionHandler.asMissionEntry(
            MissionHandler.getMissionStateMap(client.character)[String(missionDef.MissionID)]
        );
        const existingState = MissionHandler.getMissionState(client.character, missionDef.MissionID);
        if (existingState > MissionHandler.MISSION_NOT_STARTED) {
            if (Number(client.character.questTrackerState ?? 0) !== 0) {
                client.character.questTrackerState = 0;
                if (client.playerSpawned) {
                    MissionHandler.sendQuestProgress(client, 0);
                }
                if (client.userId) {
                    MissionHandler.saveCharacter(client, 'full-clear mission entry reset');
                }
            }
            return;
        }

        const hasHistoricalCompletion =
            Number(missionEntry.Time ?? 0) > 0 ||
            Number(missionEntry.highscore ?? 0) > 0 ||
            Number(missionEntry.Tier ?? 0) > 0;
        if (hasHistoricalCompletion) {
            return;
        }

        if (!MissionHandler.canStartMission(client.character, missionDef)) {
            return;
        }

        MissionHandler.setMissionState(
            client.character,
            missionDef.MissionID,
            MissionHandler.MISSION_IN_PROGRESS,
            missionDef,
            { currCount: 0 }
        );
        client.character.questTrackerState = 0;

        if (client.playerSpawned) {
            MissionHandler.sendMissionAdded(client, missionDef.MissionID, MissionHandler.MISSION_IN_PROGRESS);
            MissionHandler.sendQuestProgress(client, 0);
        }

        if (client.userId) {
            MissionHandler.saveCharacter(client, 'full-clear mission start');
        }
    }

    static isFullClearOnlyDungeon(levelName: string | null | undefined): boolean {
        return DungeonCompletionConditions.isFullClear(levelName);
    }

    static syncFullClearDungeonEntryMissionToClient(client: Client): void {
        if (!client.character) {
            return;
        }

        const currentLevel =
            LevelConfig.normalizeLevelName(client.currentLevel || String(client.character.CurrentLevel?.name ?? '')) ||
            client.currentLevel ||
            String(client.character.CurrentLevel?.name ?? '');
        if (!MissionHandler.isFullClearOnlyDungeon(currentLevel)) {
            return;
        }

        const missionDef = MissionLoader.findPrimaryMissionByDungeon(currentLevel);
        if (!missionDef) {
            return;
        }

        if (MissionHandler.getMissionState(client.character, missionDef.MissionID) !== MissionHandler.MISSION_IN_PROGRESS) {
            return;
        }

        MissionHandler.sendMissionAdded(client, missionDef.MissionID, MissionHandler.MISSION_IN_PROGRESS);
    }

    static maybeScheduleFullClearDungeonCompletionFromProgress(client: Client, progress: number): void {
        if (!client.character || Math.max(0, Number(progress ?? 0)) < 100) {
            return;
        }

        const currentLevel =
            LevelConfig.normalizeLevelName(client.currentLevel || String(client.character.CurrentLevel?.name ?? '')) ||
            client.currentLevel ||
            String(client.character.CurrentLevel?.name ?? '');
        if (!MissionHandler.isFullClearOnlyDungeon(currentLevel)) {
            return;
        }

        const levelScope = getClientLevelScope(client);
        if (!levelScope || MissionHandler.hasFinalizedDungeonCompletion(client, levelScope)) {
            return;
        }
        DungeonCompletionSystem.noteClientCompletionSignal(
            levelScope,
            DungeonCompletionSystem.getParticipantKey(client),
            progress
        );
        if (DungeonCompletionSystem.evaluate(levelScope).ready) {
            MissionHandler.scheduleDungeonCompletionForScope(levelScope, client);
        }
    }

    static shouldWaitForEnemyKillStateMissionProgress(client: Client, destroyedEntity: any): boolean {
        if (MissionHandler.hasActiveEnemyKillMissionProgress(client, destroyedEntity)) {
            return true;
        }

        const levelScope = getClientLevelScope(client);
        if (!levelScope || !LevelConfig.isDungeonLevel(getScopeLevelName(levelScope))) {
            return false;
        }

        for (const other of GlobalState.sessionsByToken.values()) {
            if (
                other === client ||
                !other.playerSpawned ||
                !other.character ||
                getClientLevelScope(other) !== levelScope
            ) {
                continue;
            }

            if (MissionHandler.hasActiveEnemyKillMissionProgress(other, destroyedEntity)) {
                return true;
            }
        }

        return false;
    }

    private static hasActiveEnemyKillMissionProgress(client: Client, destroyedEntity: any): boolean {
        if (!client.character) {
            return false;
        }

        const defeatedNames = MissionHandler.getDefeatedEnemyNames(destroyedEntity);
        if (!defeatedNames.length) {
            return false;
        }

        const currentLevel =
            LevelConfig.normalizeLevelName(client.currentLevel || String(client.character.CurrentLevel?.name ?? '')) ||
            client.currentLevel ||
            String(client.character.CurrentLevel?.name ?? '');
        if (!currentLevel) {
            return false;
        }

        const missions = MissionHandler.getMissionStateMap(client.character);
        for (const [missionIdText, rawEntry] of Object.entries(missions)) {
            const missionId = Number(missionIdText);
            if (!Number.isFinite(missionId)) {
                continue;
            }

            const entry = MissionHandler.asMissionEntry(rawEntry);
            if (Number(entry.state ?? MissionHandler.MISSION_NOT_STARTED) !== MissionHandler.MISSION_IN_PROGRESS) {
                continue;
            }

            const missionDef = MissionLoader.getMissionDef(missionId);
            const allowDungeonEnemyProgress =
                LevelConfig.isDungeonLevel(currentLevel) &&
                !String(missionDef?.Dungeon ?? '').trim();
            if (!missionDef || (!allowDungeonEnemyProgress && !MissionHandler.isMissionAvailableInCurrentLevel(missionDef, currentLevel))) {
                continue;
            }

            if (MissionHandler.matchesEnemyKillProgress(missionId, missionDef, defeatedNames, currentLevel)) {
                return true;
            }
        }

        return false;
    }

    static async handleEnemyDefeatMissionProgressForScope(
        client: Client,
        levelScope: string,
        destroyedEntity: any
    ): Promise<void> {
        if (!levelScope || !LevelConfig.isDungeonLevel(getScopeLevelName(levelScope))) {
            await MissionHandler.handleEnemyDefeatMissionProgress(client, destroyedEntity);
            return;
        }

        const recipients = new Set<Client>();
        if (client.character && client.playerSpawned && getClientLevelScope(client) === levelScope) {
            recipients.add(client);
        }
        for (const other of GlobalState.sessionsByToken.values()) {
            if (
                !other.playerSpawned ||
                !other.character ||
                getClientLevelScope(other) !== levelScope
            ) {
                continue;
            }
            recipients.add(other);
        }

        await Promise.all(
            [...recipients].map((recipient) =>
                MissionHandler.handleEnemyDefeatMissionProgress(recipient, destroyedEntity)
            )
        );
    }

    static async handleEnemyDefeatMissionProgress(client: Client, destroyedEntity: any): Promise<void> {
        if (!client.character) {
            return;
        }

        const defeatedNames = MissionHandler.getDefeatedEnemyNames(destroyedEntity);
        if (!defeatedNames.length) {
            return;
        }

        const currentLevel =
            LevelConfig.normalizeLevelName(client.currentLevel || String(client.character.CurrentLevel?.name ?? '')) ||
            client.currentLevel ||
            String(client.character.CurrentLevel?.name ?? '');
        if (!currentLevel) {
            return;
        }

        const missions = MissionHandler.getMissionStateMap(client.character);
        let didMutate = false;

        for (const [missionIdText, rawEntry] of Object.entries(missions)) {
            const missionId = Number(missionIdText);
            if (!Number.isFinite(missionId)) {
                continue;
            }

            const missionDef = MissionLoader.getMissionDef(missionId);
            const allowDungeonEnemyProgress =
                LevelConfig.isDungeonLevel(currentLevel) &&
                !String(missionDef?.Dungeon ?? '').trim();
            if (!missionDef || (!allowDungeonEnemyProgress && !MissionHandler.isMissionAvailableInCurrentLevel(missionDef, currentLevel))) {
                continue;
            }

            if (!MissionHandler.matchesEnemyKillProgress(missionId, missionDef, defeatedNames, currentLevel)) {
                continue;
            }

            const entry = MissionHandler.asMissionEntry(rawEntry);
            if (Number(entry.state ?? MissionHandler.MISSION_NOT_STARTED) !== MissionHandler.MISSION_IN_PROGRESS) {
                continue;
            }

            const currentCount = Math.max(0, Number(entry.currCount ?? 0));
            const completeCount = Math.max(1, Number(missionDef.CompleteCount ?? 1));
            if (currentCount >= completeCount) {
                continue;
            }

            const nextCount = Math.min(completeCount, currentCount + 1);
            const nextState =
                nextCount >= completeCount
                    ? MissionHandler.MISSION_READY_TO_TURN_IN
                    : MissionHandler.MISSION_IN_PROGRESS;

            MissionHandler.setMissionState(client.character, missionId, nextState, missionDef, {
                currCount: nextCount
            });
            MissionHandler.sendMissionProgress(client, missionId, 1);
            if (nextState === MissionHandler.MISSION_READY_TO_TURN_IN) {
                MissionHandler.sendMissionComplete(client, missionId);
            }
            didMutate = true;
        }

        if (didMutate) {
            MissionHandler.saveCharacter(client, 'enemy kill mission progress');
        }
    }

    static async handleSetLevelComplete(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const currentLevel =
            LevelConfig.normalizeLevelName(client.currentLevel || String(client.character.CurrentLevel?.name ?? '')) ||
            client.currentLevel ||
            String(client.character.CurrentLevel?.name ?? '');
        const levelScope = getClientLevelScope(client);
        if (MissionHandler.hasFinalizedDungeonCompletion(client, levelScope)) {
            return;
        }

        const br = new BitReader(data);
        const completionPercent = br.readMethod9();
        const bonusScoreTotal = br.readMethod9();
        const goldReward = br.readMethod9();
        br.readMethod9(); // material reward
        br.readMethod9(); // gear count
        const remainingKills = br.readMethod9();
        const requiredKills = br.readMethod9();
        const levelWidthScore = br.readMethod9();

        const trackerCompletionPercent = Math.max(
            0,
            Math.min(100, Math.round(Number(client.character.questTrackerState ?? 0) || 0))
        );
        let effectiveCompletionPercent = isWolfsEndDungeonLevel(currentLevel)
            ? Math.max(completionPercent, trackerCompletionPercent)
            : completionPercent;
        let scoringCompletionPercent = effectiveCompletionPercent;
        let actualKills = Math.max(requiredKills - remainingKills, 0);
        let clearedDungeon =
            effectiveCompletionPercent >= 100 ||
            (requiredKills > 0 && remainingKills <= 0);
        const completionCondition = DungeonCompletionConditions.get(currentLevel);
        const participantKey = DungeonCompletionSystem.getParticipantKey(client);
        if (completionCondition?.mode === 'disabled') {
            return;
        }
        if (completionCondition && levelScope) {
            if (clearedDungeon) {
                DungeonCompletionSystem.noteClientCompletionSignal(levelScope, participantKey, 100);
            }
            const evaluation = DungeonCompletionSystem.evaluate(levelScope);
            if (!evaluation.ready) {
                return;
            }
            clearedDungeon = true;
        } else if (LevelConfig.isDungeonLevel(currentLevel)) {
            // Runtime validation should make this impossible. Never fall back to trusting
            // a client packet for an unconfigured dungeon.
            return;
        }
        const serverValidatedDungeonCompletion = Boolean(completionCondition && levelScope && clearedDungeon);
        if (
            serverValidatedDungeonCompletion &&
            trackerCompletionPercent > 0 &&
            trackerCompletionPercent < 100
        ) {
            scoringCompletionPercent = trackerCompletionPercent;
        }

        if (serverValidatedDungeonCompletion) {
            effectiveCompletionPercent = 100;
            clearedDungeon = true;
            const sharedState = usesSharedDungeonProgress(currentLevel) && levelScope
                ? getOrCreateSharedDungeonProgressState(levelScope)
                : null;
            if (sharedState) {
                sharedState.progress = 100;
                MissionHandler.broadcastSharedDungeonQuestProgress(levelScope, 100);
            }
        }
        noteDungeonRunCompletionProgress(client, effectiveCompletionPercent);

        if (
            clearedDungeon &&
            levelScope &&
            !MissionHandler.tryReserveDungeonCompletionFinalization(client, levelScope)
        ) {
            return;
        }

        const reservedParticipantKey = clearedDungeon && levelScope
            ? DungeonCompletionSystem.getParticipantKey(client)
            : '';
        try {
        let didMutate = false;
        if (currentLevel === 'TutorialBoat' || MissionHandler.isTutorialRescueDungeon(currentLevel)) {
            clearedDungeon = true;
            if (currentLevel === 'TutorialBoat') {
                actualKills = Math.max(actualKills, requiredKills, 1);
            }
            if (Number(client.character.questTrackerState ?? 0) !== 100) {
                client.character.questTrackerState = 100;
                didMutate = true;
            }
            MissionHandler.sendQuestProgress(client, 100);
        }

        if (
            clearedDungeon &&
            currentLevel !== 'TutorialBoat' &&
            !MissionHandler.isTutorialRescueDungeon(currentLevel)
        ) {
            const previousProgress = Number(client.character.questTrackerState ?? 0);
            if (Number(client.character.questTrackerState ?? 0) !== 100) {
                client.character.questTrackerState = 100;
                didMutate = true;
            }
            MissionHandler.sendQuestProgress(client, 100);
            if (currentLevel === 'CraftTownTutorial') {
                MissionHandler.logKeepCompletionProgress('questObjectiveUpdated', client, {
                    levelScope,
                    from: previousProgress,
                    to: 100
                });
            }
        }

        if (
            clearedDungeon &&
            currentLevel === 'TutorialBoat' &&
            MissionHandler.getMissionState(client.character, MissionID.DefendTheShip) === MissionHandler.MISSION_NOT_STARTED &&
            MissionHandler.getMissionState(client.character, MissionID.MeetTheTown) === MissionHandler.MISSION_NOT_STARTED
        ) {
            MissionHandler.setMissionState(
                client.character,
                MissionID.DefendTheShip,
                MissionHandler.MISSION_IN_PROGRESS,
                MissionLoader.getMissionDef(MissionID.DefendTheShip),
                { currCount: 0 }
            );
            didMutate = true;
        }

        const completionResult = MissionHandler.buildDungeonCompletionResult(
            client,
            currentLevel,
            levelScope,
            {
                completionPercent: effectiveCompletionPercent,
                bonusScoreTotal,
                goldReward,
                requiredKills,
                actualKills,
                dungeonCompleted: clearedDungeon,
                scoringCompletionPercent
            }
        );

        let completedMissionId = 0;
        let completedMissionUpdate: DungeonMissionUpdateResult | null = null;
        if (clearedDungeon) {
            const missionUpdate = MissionHandler.updateDungeonMissionResult(client.character, currentLevel, {
                stars: completionResult.stars,
                score: completionResult.totalScore,
                completedAt: Math.floor(Date.now() / 1000)
            });
            completedMissionUpdate = missionUpdate;
            completedMissionId = missionUpdate.missionId;
            if (completedMissionId) {
                didMutate = true;
                if (missionUpdate.newlyCompleted) {
                    MissionHandler.sendMissionAdded(client, completedMissionId, missionUpdate.state);
                    MissionHandler.sendMissionComplete(client, completedMissionId);
                }

                const completedMissionDef = MissionLoader.getMissionDef(completedMissionId);

                if (
                    missionUpdate.newlyCompleted &&
                    completedMissionId !== MissionID.DefendTheShip &&
                    completedMissionId !== MissionID.ClearYourHouse &&
                    completedMissionDef &&
                    missionUpdate.state >= MissionHandler.MISSION_CLAIMED
                ) {
                    MissionHandler.sendMissionCompleteUi(
                        client,
                        completedMissionId,
                        missionUpdate.persistedStars,
                        missionUpdate.persistedScore
                    );
                }

                const primedMissionId = MissionHandler.primeRescueAnnaFollowup(client, completedMissionId);
                if (primedMissionId > 0) {
                    didMutate = true;
                }

                const chainedDungeonMissionId = MissionHandler.primeChainedDungeonFollowupMission(
                    client,
                    currentLevel,
                    completedMissionId
                );
                if (chainedDungeonMissionId > 0) {
                    didMutate = true;
                }

                const aggregateReconcile = MissionHandler.reconcileAttackOfOpportunityAggregateProgress(client.character);
                if (aggregateReconcile.changed) {
                    didMutate = true;
                    if (aggregateReconcile.progressDelta > 0) {
                        MissionHandler.sendMissionProgress(client, aggregateReconcile.missionId, aggregateReconcile.progressDelta);
                    }
                    if (aggregateReconcile.becameReadyToTurnIn) {
                        MissionHandler.sendMissionComplete(client, aggregateReconcile.missionId);
                    }
                }

                if (
                    currentLevel === 'CraftTownTutorial' &&
                    completedMissionId === MissionID.ClearYourHouse &&
                    MissionHandler.ensureCraftTownKeepRepaired(client.character)
                ) {
                    didMutate = true;
                    MissionHandler.logKeepCompletionProgress('keepRebuildStateApplied', client, {
                        levelScope,
                        keepRank: MissionHandler.CRAFT_TOWN_REPAIRED_KEEP_RANK
                    });
                }

                if (
                    missionUpdate.newlyCompleted &&
                    completedMissionId === MissionID.ClearYourHouse &&
                    MissionHandler.claimKeepQuestCompletionReward(client, missionUpdate)
                ) {
                    didMutate = true;
                    MissionHandler.logKeepCompletionProgress('questCompletionRewardClaimed', client, {
                        levelScope,
                        missionId: completedMissionId
                    });
                }

                if (
                    missionUpdate.newlyCompleted &&
                    MissionHandler.claimMeyloursEmbersRewardAndPrimeGlades(client, missionUpdate)
                ) {
                    didMutate = true;
                }
            }

            if (
                currentLevel !== 'CraftTownTutorial' &&
                currentLevel !== 'TutorialBoat' &&
                MissionHandler.moveCharacterBackToSafeLevel(client.character, currentLevel)
            ) {
                didMutate = true;
            }
        }

        if (didMutate) {
            MissionHandler.saveCharacter(client, 'level completion mission update');
            if (currentLevel === 'CraftTownTutorial' && completedMissionId === MissionID.ClearYourHouse) {
                MissionHandler.logKeepCompletionProgress('keepRebuildStatePersisted', client, {
                    levelScope,
                    missionId: completedMissionId
                });
            }
        }

        if (clearedDungeon) {
            MissionHandler.markDungeonCompletionFinalized(client, levelScope);
        }

        if (
            currentLevel === 'CraftTownTutorial' &&
            completedMissionId === MissionID.ClearYourHouse
        ) {
            MissionHandler.sendCraftTownTutorialHomeDoorTarget(client);
            MissionHandler.logKeepCompletionProgress('tutorialTriggerFired', client, {
                levelScope,
                trigger: 'homeDoorTargetAfterCutscene'
            });
        } else {
            MissionHandler.sendDungeonComplete(client, {
                stars: completionResult.stars,
                resultBar: completionResult.resultBar,
                rank: completionResult.rank,
                kills: completionResult.killsScore,
                accuracy: completionResult.accuracyScore,
                deaths: completionResult.deathsScore,
                treasure: completionResult.treasureScore,
                timeBonus: completionResult.timeBonusScore
            });
        }
        if (clearedDungeon && levelScope) {
            MissionHandler.scheduleDungeonCompletionForScope(levelScope, client);
        }
        } catch (error) {
            if (levelScope && reservedParticipantKey) {
                DungeonCompletionSystem.cancelFinalization(levelScope, reservedParticipantKey);
            }
            throw error;
        }
    }

    private static reconcileAttackOfOpportunityAggregateProgress(character: Character): AggregateMissionReconcileResult {
        const pairs: Array<{ aggregateId: number; satelliteIds: ReadonlySet<number> }> = [
            {
                aggregateId: MissionHandler.ATTACK_OF_OPPORTUNITY_MISSION_ID,
                satelliteIds: MissionHandler.ATTACK_OF_OPPORTUNITY_SATELLITE_IDS
            },
            {
                aggregateId: MissionHandler.ATTACK_OF_OPPORTUNITY_HARD_MISSION_ID,
                satelliteIds: MissionHandler.ATTACK_OF_OPPORTUNITY_HARD_SATELLITE_IDS
            }
        ];

        for (const pair of pairs) {
            const aggregateDef = MissionLoader.getMissionDef(pair.aggregateId);
            if (!aggregateDef) {
                continue;
            }

            const aggregateState = MissionHandler.getMissionState(character, pair.aggregateId);
            if (aggregateState !== MissionHandler.MISSION_IN_PROGRESS) {
                continue;
            }

            const completeCount = Math.max(1, Number(aggregateDef.CompleteCount ?? 1));
            const completedSatellites = Array.from(pair.satelliteIds).reduce((count, missionId) => {
                return count + (MissionHandler.getMissionState(character, missionId) >= MissionHandler.MISSION_CLAIMED ? 1 : 0);
            }, 0);
            const nextCount = Math.min(completeCount, completedSatellites);
            const currentEntry = MissionHandler.asMissionEntry(
                MissionHandler.getMissionStateMap(character)[String(pair.aggregateId)]
            );
            const currentCount = Math.max(0, Number(currentEntry.currCount ?? 0));
            const becameReadyToTurnIn = nextCount >= completeCount;
            const nextState = becameReadyToTurnIn
                ? MissionHandler.MISSION_READY_TO_TURN_IN
                : MissionHandler.MISSION_IN_PROGRESS;
            const progressDelta = Math.max(0, nextCount - currentCount);

            if (currentCount === nextCount && aggregateState === nextState) {
                continue;
            }

            MissionHandler.setMissionState(character, pair.aggregateId, nextState, aggregateDef, {
                currCount: nextCount
            });
            return {
                missionId: pair.aggregateId,
                changed: true,
                progressDelta,
                becameReadyToTurnIn
            };
        }

        return {
            missionId: 0,
            changed: false,
            progressDelta: 0,
            becameReadyToTurnIn: false
        };
    }

    static async handleForcedDungeonBossCompletion(client: Client, destroyedEntity: any): Promise<void> {
        if (!client.character) {
            return;
        }

        const currentLevel =
            LevelConfig.normalizeLevelName(client.currentLevel || String(client.character.CurrentLevel?.name ?? '')) ||
            client.currentLevel ||
            String(client.character.CurrentLevel?.name ?? '');
        if (!currentLevel) {
            return;
        }

        const levelScope = getClientLevelScope(client);
        if (!levelScope || !LevelConfig.isDungeonLevel(currentLevel)) {
            return;
        }

        if (currentLevel === 'TutorialDungeon') {
            TutorialDungeonMechanics.noteEntityDefeated(client, destroyedEntity);
        }

        DungeonCompletionSystem.noteEntityDefeated(levelScope, destroyedEntity);

        if (
            currentLevel === 'CraftTownTutorial' &&
            DungeonCompletionConditions.isRequiredBoss(currentLevel, destroyedEntity)
        ) {
            if (client.keepTutorialState) {
                client.keepTutorialState.bossDefeated = true;
            }
            if (destroyedEntity && typeof destroyedEntity === 'object') {
                destroyedEntity.dead = true;
                destroyedEntity.hp = 0;
                destroyedEntity.entState = EntityState.DEAD;
            }
            MissionHandler.logKeepCompletionProgress('bossDeathDetected', client, {
                levelScope,
                entityId: Math.max(0, Math.round(Number(destroyedEntity?.id ?? 0))),
                entityName: MissionHandler.getEntityName(destroyedEntity)
            });
        }

        const evaluation = DungeonCompletionSystem.evaluate(levelScope);
        if (!evaluation.ready) {
            return;
        }

        if (DungeonCompletionConditions.isRequiredBoss(currentLevel, destroyedEntity)) {
            const bossRoomId = MissionHandler.getEntityRoomId(destroyedEntity);
            if (bossRoomId > 0) {
                noteDungeonRunBossCutscene(
                    levelScope,
                    bossRoomId,
                    Math.max(0, Math.round(Number(destroyedEntity?.id ?? 0)))
                );
            }
        }
        MissionHandler.scheduleDungeonCompletionForScope(levelScope, client);
    }

    static async handleForcedDungeonObjectiveCompletion(client: Client, destroyedEntity: any): Promise<void> {
        await MissionHandler.handleForcedDungeonBossCompletion(client, destroyedEntity);
    }

    private static scheduleDungeonCompletionForScope(levelScope: string, sourceClient?: Client): void {
        if (!levelScope || !DungeonCompletionSystem.evaluate(levelScope).ready) {
            return;
        }

        const payload = MissionHandler.buildSyntheticLevelCompletePacket(100);
        for (const session of GlobalState.sessionsByToken.values()) {
            if (
                !session.playerSpawned ||
                !session.character ||
                getClientLevelScope(session) !== levelScope ||
                MissionHandler.hasFinalizedDungeonCompletion(session, levelScope)
            ) {
                continue;
            }
            MissionHandler.scheduleDungeonCompletion(session, payload, {
                initialDelayMs: 0,
                settleDelayMs: 0
            });
        }
    }

    static tryRestoreDungeonCompletionAfterReentry(client: Client): void {
        const levelScope = getClientLevelScope(client);
        if (!TutorialDungeonMechanics.isTutorialDungeon(levelScope)) {
            return;
        }
        const completionState = DungeonCompletionSystem.getState(levelScope);
        if (!completionState) {
            return;
        }
        const participantKey = DungeonCompletionSystem.getParticipantKey(client);
        if (DungeonCompletionSystem.hasFinalized(levelScope, participantKey)) {
            TutorialDungeonMechanics.noteCompletionPhase(levelScope, 'completed', client.token);
            return;
        }
        const evaluation = DungeonCompletionSystem.evaluate(levelScope);
        TutorialDungeonMechanics.noteCompletionPhase(
            levelScope,
            evaluation.ready ? 'ready' : evaluation.phase === 'waiting-gates' ? 'waiting-gates' : 'running',
            client.token
        );
        if (evaluation.ready) {
            MissionHandler.scheduleDungeonCompletionForScope(levelScope, client);
        }
    }

    private static hasFinalizedDungeonCompletion(client: Client, levelScope: string | null | undefined): boolean {
        const scopeKey = String(levelScope ?? '').trim();
        return Boolean(scopeKey && DungeonCompletionSystem.hasFinalized(
            scopeKey,
            DungeonCompletionSystem.getParticipantKey(client)
        ));
    }

    private static tryReserveDungeonCompletionFinalization(client: Client, levelScope: string | null | undefined): boolean {
        const scopeKey = String(levelScope ?? '').trim();
        return Boolean(scopeKey && DungeonCompletionSystem.tryReserveFinalization(
            scopeKey,
            DungeonCompletionSystem.getParticipantKey(client)
        ));
    }

    private static markDungeonCompletionFinalized(client: Client, levelScope: string | null | undefined): void {
        const scopeKey = String(levelScope ?? '').trim();
        if (!scopeKey) {
            return;
        }

        const participantKey = DungeonCompletionSystem.getParticipantKey(client);
        DungeonCompletionSystem.markFinalized(scopeKey, participantKey);
        const completionState = DungeonCompletionSystem.getState(scopeKey);
        TutorialDungeonMechanics.noteCompletionPhase(
            scopeKey,
            completionState?.phase === 'completed' ? 'completed' : 'ready',
            client.token
        );
        const sharedState = GlobalState.levelQuestProgress.get(scopeKey);
        if (sharedState) {
            sharedState.progress = 100;
            sharedState.defeatedHostileIds = new Set(sharedState.trackedHostileIds ?? sharedState.defeatedHostileIds ?? []);
        }
    }

    private static getPendingDungeonCompletionNextDelayMs(client: Client): number {
        const now = Date.now();
        const notBeforeAt = Math.max(0, Number(client.pendingDungeonCompletionNotBeforeAt ?? 0));
        return Math.max(0, notBeforeAt - now);
    }

    private static dispatchOrArmPendingDungeonCompletion(client: Client): void {
        const delayMs = MissionHandler.getPendingDungeonCompletionNextDelayMs(client);
        const settleDelayMs = Math.max(0, Number(client.pendingDungeonCompletionSettleMs ?? 0));
        if (delayMs <= 0 && settleDelayMs <= 0) {
            // A zero-delay completion is already protected by the authoritative
            // condition gate and participant reservation. Dispatch inline so a
            // movement-packet backlog cannot starve a setTimeout(0) callback.
            void MissionHandler.flushPendingDungeonCompletion(client);
            return;
        }
        MissionHandler.armPendingDungeonCompletionTimer(client, delayMs);
    }

    static scheduleDungeonCompletion(
        client: Client,
        payload: Buffer,
        options: {
            initialDelayMs?: number;
            settleDelayMs?: number;
        } = {}
    ): void {
        const levelScope = getClientLevelScope(client);
        if (!client.character || !levelScope) {
            return;
        }

        if (MissionHandler.hasFinalizedDungeonCompletion(client, levelScope)) {
            return;
        }
        const condition = DungeonCompletionConditions.get(getScopeLevelName(levelScope));
        if (condition && !DungeonCompletionSystem.evaluate(levelScope).ready) {
            return;
        }

        const now = Date.now();
        const initialDelayMs = Math.max(
            0,
            Math.round(Number(options.initialDelayMs ?? MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS))
        );
        const settleDelayMs = Math.max(
            0,
            Math.round(Number(options.settleDelayMs ?? MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS))
        );
        const pendingScope = String(client.pendingDungeonCompletionScope ?? '').trim();
        if (pendingScope === levelScope) {
            const requestedAt = Math.max(0, Number(client.pendingDungeonCompletionRequestedAt ?? 0)) || now;
            const existingNotBeforeAt = Math.max(0, Number(client.pendingDungeonCompletionNotBeforeAt ?? 0));
            const nextNotBeforeAt = now + initialDelayMs;
            const existingSettleMs = Math.max(0, Number(client.pendingDungeonCompletionSettleMs ?? 0));
            client.pendingDungeonCompletionRequestedAt = requestedAt;
            client.pendingDungeonCompletionLastSkitAt = Math.max(
                requestedAt,
                Number(client.pendingDungeonCompletionLastSkitAt ?? requestedAt)
            );
            client.pendingDungeonCompletionNotBeforeAt = existingNotBeforeAt > 0
                ? Math.min(existingNotBeforeAt, nextNotBeforeAt)
                : nextNotBeforeAt;
            client.pendingDungeonCompletionSettleMs = Math.max(existingSettleMs, settleDelayMs);
            client.pendingDungeonCompletionPayload = Buffer.from(payload);
            MissionHandler.dispatchOrArmPendingDungeonCompletion(client);
            return;
        }

        client.pendingDungeonCompletionScope = levelScope;
        client.pendingDungeonCompletionRequestedAt = now;
        client.pendingDungeonCompletionLastSkitAt = now;
        client.pendingDungeonCompletionNotBeforeAt = now + initialDelayMs;
        client.pendingDungeonCompletionSettleMs = settleDelayMs;
        client.pendingDungeonCompletionPayload = Buffer.from(payload);
        MissionHandler.dispatchOrArmPendingDungeonCompletion(client);
    }

    static noteDungeonSkitActivity(client: Client): void {
        const pendingScope = String(client.pendingDungeonCompletionScope ?? '').trim();
        if (!pendingScope || getClientLevelScope(client) !== pendingScope) {
            return;
        }

        const now = Date.now();
        const requestedAt = Math.max(0, Number(client.pendingDungeonCompletionRequestedAt ?? 0));
        client.pendingDungeonCompletionLastSkitAt = Math.max(
            now,
            requestedAt > 0 ? requestedAt + 1 : 0
        );

        const settleDelayMs = Math.max(0, Number(client.pendingDungeonCompletionSettleMs ?? MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS));
        const remainingNotBeforeMs = Math.max(
            0,
            Number(client.pendingDungeonCompletionNotBeforeAt ?? 0) - Date.now()
        );
        MissionHandler.armPendingDungeonCompletionTimer(
            client,
            Math.max(remainingNotBeforeMs, settleDelayMs)
        );
    }

    static isWaitingForDungeonCompletionCutscene(client: Client): boolean {
        const levelScope = getClientLevelScope(client);
        if (!levelScope) {
            return false;
        }
        const evaluation = DungeonCompletionSystem.evaluate(levelScope);
        return evaluation.phase === 'waiting-gates' && evaluation.reason === 'cutscene_gate_pending';
    }

    static noteDungeonCutsceneStart(client: Client, roomId: number): void {
        const scope = getClientLevelScope(client);
        if (!scope) {
            return;
        }

        client.activeDungeonCutsceneScope = scope;
        client.activeDungeonCutsceneRoomId = Math.max(0, Math.round(Number(roomId ?? 0)));
        client.lastDungeonCutsceneStartScope = scope;
        client.lastDungeonCutsceneStartAt = Date.now();
        DungeonCompletionSystem.noteCutsceneStart(scope, roomId, client.lastDungeonCutsceneStartAt);
        TutorialDungeonMechanics.noteCutscenePhase(scope, roomId, 'active', client.token);
        MissionHandler.activateBossRunStatsForCutsceneRoom(client, scope, client.activeDungeonCutsceneRoomId);
    }

    static noteDungeonCutsceneEnd(client: Client, roomId: number): void {
        const scope = getClientLevelScope(client);
        if (!scope) {
            return;
        }

        const endedRoomId = Math.max(0, Math.round(Number(roomId ?? 0)));
        const activeCutsceneScope = String(client.activeDungeonCutsceneScope ?? '').trim();
        const pendingScope = String(client.pendingDungeonCompletionScope ?? '').trim();
        if (
            activeCutsceneScope === scope &&
            client.activeDungeonCutsceneRoomId > 0 &&
            endedRoomId > 0 &&
            client.activeDungeonCutsceneRoomId !== endedRoomId
        ) {
            return;
        }

        client.lastDungeonCutsceneEndScope = scope;
        client.lastDungeonCutsceneEndAt = Date.now();
        const completionReady = DungeonCompletionSystem.noteCutsceneEnd(
            scope,
            endedRoomId,
            client.lastDungeonCutsceneEndAt
        );
        TutorialDungeonMechanics.noteCutscenePhase(scope, endedRoomId, 'completed', client.token);
        if (completionReady) {
            TutorialDungeonMechanics.noteCompletionPhase(scope, 'ready', client.token);
        }
        if (getScopeLevelName(scope) === 'CraftTownTutorial') {
            MissionHandler.logKeepCompletionProgress('cutsceneEndProcessed', client, {
                levelScope: scope,
                roomId: endedRoomId,
                pendingCompletion: pendingScope === scope
            });
        }
        if (!client.lastDungeonCutsceneStartScope) {
            client.lastDungeonCutsceneStartScope = scope;
            client.lastDungeonCutsceneStartAt = client.lastDungeonCutsceneEndAt;
        }

        if (activeCutsceneScope === scope) {
            client.activeDungeonCutsceneScope = '';
            client.activeDungeonCutsceneRoomId = 0;
        }

        if (pendingScope && pendingScope === scope) {
            void MissionHandler.flushPendingDungeonCompletion(client);
        }

        if (completionReady) {
            MissionHandler.scheduleDungeonCompletionForScope(scope, client);
        }
    }

    private static activateBossRunStatsForCutsceneRoom(client: Client, levelScope: string, roomId: number): void {
        if (!client.character || !levelScope || roomId <= 0) {
            return;
        }

        const currentLevel =
            LevelConfig.normalizeLevelName(client.currentLevel || String(client.character.CurrentLevel?.name ?? '')) ||
            getScopeLevelName(levelScope);
        if (!currentLevel || !LevelConfig.isDungeonLevel(currentLevel)) {
            return;
        }

        const bossId = MissionHandler.findDungeonBossCutsceneEntityId(client, levelScope, currentLevel, roomId);
        if (bossId <= 0) {
            return;
        }

        noteDungeonRunBossCutscene(levelScope, roomId, bossId);
    }

    private static findDungeonBossCutsceneEntityId(
        client: Client,
        levelScope: string,
        levelName: string,
        roomId: number
    ): number {
        const candidates: any[] = [
            ...client.entities.values(),
            ...(GlobalState.levelEntities.get(levelScope)?.values() ?? [])
        ];
        let fallbackBossId = 0;

        for (const entity of candidates) {
            if (!entity || entity.isPlayer || MissionHandler.getEntityRoomId(entity) !== roomId) {
                continue;
            }

            const entityId = Math.max(0, Math.round(Number(entity.id ?? entity.entId ?? entity.EntityID ?? 0)));
            if (entityId <= 0 || !DungeonCompletionConditions.isRequiredBoss(levelName, entity)) {
                continue;
            }

            if (MissionHandler.isRequiredDungeonCompletionBossEntity(levelName, entity)) {
                return entityId;
            }

            fallbackBossId ||= entityId;
        }

        return fallbackBossId;
    }

    static shouldCompleteDungeonFromBossHpReport(client: Client, entity: any): boolean {
        if (!client.character) {
            return false;
        }

        const currentLevel =
            LevelConfig.normalizeLevelName(client.currentLevel || String(client.character.CurrentLevel?.name ?? '')) ||
            client.currentLevel ||
            String(client.character.CurrentLevel?.name ?? '');
        return Boolean(
            currentLevel &&
            DungeonCompletionConditions.allowsDefeatedBossProxyCopies(currentLevel) &&
            DungeonCompletionConditions.isRequiredBoss(currentLevel, entity)
        );
    }

    private static armPendingDungeonCompletionTimer(client: Client, delayMs: number): void {
        if (client.pendingDungeonCompletionTimer) {
            clearTimeout(client.pendingDungeonCompletionTimer);
        }

        const safeDelay = Math.max(0, Math.round(Number(delayMs ?? 0)));
        client.pendingDungeonCompletionTimer = setTimeout(() => {
            client.pendingDungeonCompletionTimer = null;
            void MissionHandler.flushPendingDungeonCompletion(client);
        }, safeDelay);
        client.pendingDungeonCompletionTimer.unref?.();
    }

    private static clearPendingDungeonCompletion(client: Client): void {
        if (client.pendingDungeonCompletionTimer) {
            clearTimeout(client.pendingDungeonCompletionTimer);
            client.pendingDungeonCompletionTimer = null;
        }
        client.pendingDungeonCompletionScope = '';
        client.pendingDungeonCompletionRequestedAt = 0;
        client.pendingDungeonCompletionLastSkitAt = 0;
        client.pendingDungeonCompletionNotBeforeAt = 0;
        client.pendingDungeonCompletionSettleMs = 0;
        client.pendingDungeonCompletionPayload = null;
        client.pendingDungeonCompletionFlushActive = false;
    }

    private static async flushPendingDungeonCompletion(client: Client): Promise<void> {
        const pendingScope = String(client.pendingDungeonCompletionScope ?? '').trim();
        const currentScope = getClientLevelScope(client);
        const payload = client.pendingDungeonCompletionPayload;
        if (!client.character || !pendingScope || !payload || currentScope !== pendingScope) {
            MissionHandler.clearPendingDungeonCompletion(client);
            return;
        }
        if (MissionHandler.hasFinalizedDungeonCompletion(client, pendingScope)) {
            MissionHandler.clearPendingDungeonCompletion(client);
            return;
        }

        const now = Date.now();
        const requestedAt = Math.max(0, Number(client.pendingDungeonCompletionRequestedAt ?? 0));
        const lastSkitAt = Math.max(requestedAt, Number(client.pendingDungeonCompletionLastSkitAt ?? 0));
        const notBeforeAt = Math.max(requestedAt, Number(client.pendingDungeonCompletionNotBeforeAt ?? 0));
        const settleDelayMs = Math.max(0, Number(client.pendingDungeonCompletionSettleMs ?? MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS));
        const quietForMs = now - lastSkitAt;
        const maxQuietWaitDeadline = Math.max(
            requestedAt + MissionHandler.DUNGEON_COMPLETION_MAX_DEFER_MS,
            notBeforeAt + settleDelayMs
        );

        if (now < notBeforeAt) {
            MissionHandler.armPendingDungeonCompletionTimer(client, notBeforeAt - now);
            return;
        }

        if (
            quietForMs < settleDelayMs &&
            now < maxQuietWaitDeadline
        ) {
            MissionHandler.armPendingDungeonCompletionTimer(
                client,
                settleDelayMs - quietForMs
            );
            return;
        }

        if (!DungeonCompletionSystem.evaluate(pendingScope).ready) {
            MissionHandler.clearPendingDungeonCompletion(client);
            return;
        }

        MissionHandler.clearPendingDungeonCompletion(client);

        try {
            client.pendingDungeonCompletionFlushActive = true;
            await MissionHandler.handleSetLevelComplete(client, payload);
        } finally {
            client.pendingDungeonCompletionFlushActive = false;
        }
    }

    static async handleBadgeRequest(client: Client, data: Buffer): Promise<void> {
        if (!client.character) {
            return;
        }

        const br = new BitReader(data);
        const badgeKey = String(br.readMethod26() ?? '').trim();
        if (!badgeKey) {
            return;
        }

        const missionId = MissionLoader.getMissionIdByName(badgeKey);
        if (!missionId) {
            return;
        }

        const missionDef = MissionLoader.getMissionDef(missionId);
        if (!missionDef?.Tier) {
            return;
        }

        if (MissionHandler.getMissionState(client.character, missionId) >= MissionHandler.MISSION_CLAIMED) {
            return;
        }

        MissionHandler.setMissionState(
            client.character,
            missionId,
            MissionHandler.MISSION_CLAIMED,
            missionDef,
            { currCount: Math.max(1, Number(missionDef.CompleteCount ?? 1)) }
        );

        client.character.mammothIdols = Number(client.character.mammothIdols ?? 0) + MissionHandler.ACHIEVEMENT_MAMMOTH_IDOL_REWARD;

        MissionHandler.sendMissionProgress(client, missionId, 1);
        MissionHandler.sendMammothIdolUpdate(client);
        MissionHandler.sendAchievementCompleteUi(client, missionId);
        MissionHandler.saveCharacter(client, 'badge mission claim');
    }

    private static updateDungeonMissionResult(
        character: Character,
        currentLevel: string,
        completion: {
            stars: number;
            score: number;
            completedAt: number;
        }
    ): DungeonMissionUpdateResult {
        const missions = MissionHandler.getMissionStateMap(character);
        const normalizedCurrentLevel = LevelConfig.normalizeLevelName(currentLevel) || String(currentLevel ?? '').trim();

        for (const [missionIdText, rawEntry] of Object.entries(missions)) {
            const missionId = Number(missionIdText);
            if (!Number.isFinite(missionId)) {
                continue;
            }

            const entry = MissionHandler.asMissionEntry(rawEntry);
            const currentState = Number(entry.state ?? MissionHandler.MISSION_NOT_STARTED);
            if (currentState <= MissionHandler.MISSION_NOT_STARTED) {
                continue;
            }

            const missionDef = MissionLoader.getMissionDef(missionId);
            const missionDungeon = LevelConfig.normalizeLevelName(missionDef?.Dungeon) || String(missionDef?.Dungeon ?? '').trim();
            if (!missionDef || !missionDungeon || missionDungeon !== normalizedCurrentLevel) {
                continue;
            }

            let nextState = currentState;
            let newlyCompleted = false;
            const existingStars = Math.max(0, Number(entry.Tier ?? 0));
            const existingScore = Math.max(0, Number(entry.highscore ?? 0));
            const shouldReplaceBest =
                completion.score > existingScore ||
                (completion.score === existingScore && completion.stars > existingStars);
            const persistedStars = shouldReplaceBest ? completion.stars : existingStars;
            const persistedScore = shouldReplaceBest ? completion.score : existingScore;
            const persistedTime = shouldReplaceBest
                ? completion.completedAt
                : Math.max(0, Number(entry.Time ?? completion.completedAt));

            if (currentState === MissionHandler.MISSION_IN_PROGRESS) {
                nextState = MissionHandler.missionRequiresTurnIn(missionDef)
                    ? MissionHandler.MISSION_READY_TO_TURN_IN
                    : MissionHandler.MISSION_CLAIMED;
                newlyCompleted = true;
            }

            MissionHandler.setMissionState(character, missionId, nextState, missionDef, {
                currCount: nextState >= MissionHandler.MISSION_READY_TO_TURN_IN
                    ? Math.max(1, Number(missionDef.CompleteCount ?? 1))
                    : Number(entry.currCount ?? 0),
                Tier: persistedStars,
                highscore: persistedScore,
                Time: persistedTime
            });
            character.lastCompletedDungeonLevel = normalizedCurrentLevel;
            return {
                missionId,
                state: nextState,
                newlyCompleted,
                persistedStars,
                persistedScore
            };
        }

        return {
            missionId: 0,
            state: MissionHandler.MISSION_NOT_STARTED,
            newlyCompleted: false,
            persistedStars: 0,
            persistedScore: 0
        };
    }

    private static primeRescueAnnaFollowup(client: Client, completedMissionId: number): number {
        if (!client.character || completedMissionId !== MissionID.RescueAnna) {
            return 0;
        }

        if (MissionHandler.getMissionState(client.character, MissionID.FindAnnasFather) !== MissionHandler.MISSION_NOT_STARTED) {
            return 0;
        }

        const missionDef = MissionLoader.getMissionDef(MissionID.FindAnnasFather);
        if (!missionDef || !MissionHandler.canStartMission(client.character, missionDef)) {
            return 0;
        }

        const initialState = MissionHandler.getInitialMissionState(missionDef);
        if (initialState !== MissionHandler.MISSION_READY_TO_TURN_IN) {
            return 0;
        }

        MissionHandler.setMissionState(
            client.character,
            MissionID.FindAnnasFather,
            initialState,
            missionDef,
            { currCount: MissionHandler.PRIMED_CONTACT_DIALOGUE_COUNT }
        );
        MissionHandler.sendMissionAdded(client, MissionID.FindAnnasFather, initialState);
        return MissionID.FindAnnasFather;
    }

    private static primeChainedDungeonFollowupMission(
        client: Client,
        currentLevel: string,
        completedMissionId: number
    ): number {
        if (!client.character || !completedMissionId) {
            return 0;
        }

        const normalizedCurrentLevel = LevelConfig.normalizeLevelName(currentLevel) || String(currentLevel ?? '').trim();
        if (!normalizedCurrentLevel || !LevelConfig.isDungeonLevel(normalizedCurrentLevel)) {
            return 0;
        }

        const nextLevel = LevelConfig.normalizeLevelName(LevelConfig.getDoorTarget(normalizedCurrentLevel, 2));
        if (!nextLevel || !LevelConfig.isDungeonLevel(nextLevel)) {
            return 0;
        }

        const completedMissionDef = MissionLoader.getMissionDef(completedMissionId);
        const followupMissionDef = MissionLoader.findPrimaryMissionByDungeon(nextLevel);
        if (!completedMissionDef || !followupMissionDef) {
            return 0;
        }

        const followupMissionId = Number(followupMissionDef.MissionID ?? 0);
        if (
            !followupMissionId ||
            followupMissionId === completedMissionId ||
            MissionHandler.getMissionState(client.character, followupMissionId) !== MissionHandler.MISSION_NOT_STARTED
        ) {
            return 0;
        }

        const completedMissionName = String(completedMissionDef.MissionName ?? '').trim();
        const requiresCompletedMission = (followupMissionDef.PreReqMissions ?? [])
            .some((missionName) => String(missionName ?? '').trim() === completedMissionName);
        if (!requiresCompletedMission || !MissionHandler.canStartMission(client.character, followupMissionDef)) {
            return 0;
        }

        const initialState = MissionHandler.getInitialMissionState(followupMissionDef);
        MissionHandler.setMissionState(
            client.character,
            followupMissionId,
            initialState,
            followupMissionDef,
            { currCount: 0 }
        );
        MissionHandler.sendMissionAdded(client, followupMissionId, initialState);
        return followupMissionId;
    }

    private static autoAcceptFollowupMission(
        character: Character,
        npcName: string,
        excludeMissionId: number
    ): number {
        const normalizedNpc = MissionHandler.normalizeMissionNpcKey(npcName);
        if (!normalizedNpc) {
            return 0;
        }

        for (let missionId = 1; missionId <= MissionLoader.getTotalMissions(); missionId++) {
            if (missionId === excludeMissionId) {
                continue;
            }

            const missionDef = MissionLoader.getMissionDef(missionId);
            if (!missionDef) {
                continue;
            }

            if (MissionHandler.getMissionState(character, missionId) !== MissionHandler.MISSION_NOT_STARTED) {
                continue;
            }

            const contactKey = MissionHandler.normalizeMissionNpcKey(missionDef.ContactName ?? '');
            const returnKey = MissionHandler.getMissionReturnNpcKey(missionDef);
            const startsAtReturnOnly = !contactKey && Boolean(returnKey) && returnKey === normalizedNpc;
            if (!startsAtReturnOnly) {
                continue;
            }

            if (!MissionHandler.canStartMission(character, missionDef)) {
                continue;
            }

            const initialState = MissionHandler.getInitialMissionState(missionDef);
            MissionHandler.setMissionState(character, missionId, initialState, missionDef, {
                currCount: 0
            });
            return missionId;
        }

        return 0;
    }

    private static getMissionReturnNpcKey(missionDef: MissionDef): string {
        const returnKey = MissionHandler.normalizeMissionNpcKey(missionDef.ReturnName ?? '');
        if (returnKey) {
            return returnKey;
        }

        if (Number(missionDef.MissionID ?? 0) === MissionID.ClearYourHouse) {
            return MissionHandler.normalizeMissionNpcKey(missionDef.ContactName ?? '');
        }

        return '';
    }

    private static claimKeepQuestCompletionReward(
        client: Client,
        missionUpdate: DungeonMissionUpdateResult
    ): boolean {
        if (!client.character || missionUpdate.missionId !== MissionID.ClearYourHouse) {
            return false;
        }

        const missionDef = MissionLoader.getMissionDef(MissionID.ClearYourHouse);
        if (!missionDef) {
            return false;
        }

        MissionHandler.setMissionState(
            client.character,
            MissionID.ClearYourHouse,
            MissionHandler.MISSION_CLAIMED,
            missionDef,
            {
                currCount: Math.max(1, Number(missionDef.CompleteCount ?? 1)),
                Tier: missionUpdate.persistedStars,
                highscore: missionUpdate.persistedScore
            }
        );
        MissionHandler.sendMissionCompleteUi(
            client,
            MissionID.ClearYourHouse,
            missionUpdate.persistedStars,
            missionUpdate.persistedScore
        );
        MissionHandler.grantMissionRewards(client, missionDef);
        return true;
    }

    private static claimMeyloursEmbersRewardAndPrimeGlades(
        client: Client,
        missionUpdate: DungeonMissionUpdateResult
    ): boolean {
        if (!client.character) {
            return false;
        }

        const followupMissionId =
            missionUpdate.missionId === MissionID.CutToTheHeart
                ? MissionID.HeadToTheGlades
                : missionUpdate.missionId === MissionID.CutToTheHeartHard
                    ? MissionID.HeadToTheGladesHard
                    : 0;
        if (!followupMissionId) {
            return false;
        }

        const completedMissionDef = MissionLoader.getMissionDef(missionUpdate.missionId);
        const followupMissionDef = MissionLoader.getMissionDef(followupMissionId);
        if (!completedMissionDef || !followupMissionDef) {
            return false;
        }

        MissionHandler.grantMissionRewards(client, completedMissionDef);

        if (MissionHandler.getMissionState(client.character, followupMissionId) !== MissionHandler.MISSION_NOT_STARTED) {
            return true;
        }
        if (!MissionHandler.canStartMission(client.character, followupMissionDef)) {
            return true;
        }

        const initialState = MissionHandler.getInitialMissionState(followupMissionDef);
        MissionHandler.setMissionState(
            client.character,
            followupMissionId,
            initialState,
            followupMissionDef,
            { currCount: 0 }
        );
        MissionHandler.sendMissionAdded(client, followupMissionId, initialState);
        return true;
    }

    private static grantMissionRewards(client: Client, missionDef: MissionDef): void {
        if (!client.character) {
            return;
        }

        const expReward = Math.max(0, Number(missionDef.ExpRewardValue ?? 0));
        if (expReward > 0) {
            client.character.xp = Number(client.character.xp ?? 0) + expReward;
            client.character.level = GameData.getPlayerLevelFromXp(Number(client.character.xp ?? 0));
            MissionHandler.sendXpReward(client, expReward);
        }

        const goldReward = Math.max(0, Number(missionDef.GoldRewardValue ?? 0));
        if (goldReward > 0) {
            client.character.gold = Number(client.character.gold ?? 0) + goldReward;
            RewardHandler.sendGoldReward(client, goldReward, false);
        }
    }

    static canStartMission(character: Character, missionDef: MissionDef): boolean {
        if (!MissionHandler.isMissionZoneUnlocked(character, missionDef)) {
            return false;
        }

        const prereqs = missionDef.PreReqMissions ?? [];
        for (const prereqName of prereqs) {
            const prereqId = MissionLoader.getMissionIdByName(prereqName);
            if (!prereqId) {
                continue;
            }
            if (MissionHandler.getMissionState(character, prereqId) < MissionHandler.MISSION_CLAIMED) {
                return false;
            }
        }
        return true;
    }

    private static isMissionZoneUnlocked(character: Character, missionDef: MissionDef): boolean {
        const zoneSet = String(missionDef.ZoneSet ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);

        if (!zoneSet.length) {
            return true;
        }

        if (zoneSet.some((zone) => zone.startsWith('NewbieRoad') || zone.startsWith('Tutorial') || zone === 'CraftTownTutorial')) {
            return true;
        }

        return MissionHandler.getMissionState(character, MissionID.DeliverToSwamp) >= MissionHandler.MISSION_CLAIMED;
    }

    private static isMissionAvailableInCurrentLevel(missionDef: MissionDef, currentLevel: string): boolean {
        const zoneSet = String(missionDef.ZoneSet ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);

        return !zoneSet.length || zoneSet.includes(currentLevel);
    }

    private static moveCharacterBackToSafeLevel(character: Character, currentLevel: string): boolean {
        if (!LevelConfig.get(currentLevel).isDungeon) {
            return false;
        }

        const previousLevel = character.PreviousLevel;
        if (previousLevel?.name) {
            const nextName = String(previousLevel.name);
            const nextX = Number(previousLevel.x ?? 0);
            const nextY = Number(previousLevel.y ?? 0);
            const currentName = String(character.CurrentLevel?.name ?? '');
            const currentX = Number(character.CurrentLevel?.x ?? 0);
            const currentY = Number(character.CurrentLevel?.y ?? 0);

            if (currentName === nextName && currentX === nextX && currentY === nextY) {
                return false;
            }

            character.CurrentLevel = { name: nextName, x: nextX, y: nextY };
            return true;
        }

        if (currentLevel === 'TutorialBoat' || MissionHandler.isTutorialRescueDungeon(currentLevel)) {
            const safeLevel = currentLevel === 'TutorialDungeonHard' ? 'NewbieRoadHard' : 'NewbieRoad';
            const spawn = LevelConfig.getSpawn(safeLevel);
            character.CurrentLevel = { name: safeLevel, x: spawn.x, y: spawn.y };
            return true;
        }

        return false;
    }

    private static missionRequiresTurnIn(missionDef: MissionDef): boolean {
        if (Number(missionDef.MissionID ?? 0) === MissionID.ClearYourHouse) {
            return true;
        }

        return Boolean(String(missionDef.ReturnName ?? '').trim());
    }

    private static isTutorialRescueDungeon(levelName: string | null | undefined): boolean {
        const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
        return normalizedLevel === 'TutorialDungeon' || normalizedLevel === 'TutorialDungeonHard';
    }

    private static missionStartsReadyToTurnIn(missionDef: MissionDef): boolean {
        return !String(missionDef.Dungeon ?? '').trim() &&
            MissionHandler.missionRequiresTurnIn(missionDef) &&
            Number(missionDef.CompleteCount ?? 1) <= 0;
    }

    private static getInitialMissionState(missionDef: MissionDef): number {
        return MissionHandler.missionStartsReadyToTurnIn(missionDef)
            ? MissionHandler.MISSION_READY_TO_TURN_IN
            : MissionHandler.MISSION_IN_PROGRESS;
    }

    private static sendQuestProgress(client: Client, percent: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(percent);
        client.sendBitBuffer(0xB7, bb);
        if (client.currentLevel === 'CraftTownTutorial') {
            MissionHandler.logKeepCompletionProgress('questProgressPacketSent', client, {
                percent: Math.max(0, Math.min(100, Math.round(Number(percent ?? 0))))
            });
        }
    }

    private static logKeepCompletionProgress(scope: string, client: Client, extra: Record<string, unknown> = {}): void {
    }

    private static buildQuestProgressPayload(percent: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod4(Math.max(0, Math.min(100, Math.round(Number(percent ?? 0)))));
        return bb.toBuffer();
    }

    private static broadcastSharedDungeonQuestProgress(levelScope: string, progress: number): void {
        const payload = MissionHandler.buildQuestProgressPayload(progress);
        for (const other of GlobalState.sessionsByToken.values()) {
            if (!other.playerSpawned || getClientLevelScope(other) !== levelScope) {
                continue;
            }

            if (other.character) {
                other.character.questTrackerState = progress;
            }
            other.send(0xB7, payload);
        }
    }

    private static sendMissionProgress(client: Client, missionId: number, progress: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(missionId);
        bb.writeMethod4(Math.max(0, progress));
        client.sendBitBuffer(0x83, bb);
    }

    static sendMissionAdded(
        client: Client,
        missionId: number,
        state: number = MissionHandler.MISSION_IN_PROGRESS
    ): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(missionId);
        bb.writeMethod11(state === MissionHandler.MISSION_IN_PROGRESS ? 1 : 0, 1);
        client.sendBitBuffer(0x85, bb);
    }

    private static sendMissionComplete(client: Client, missionId: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(missionId);
        client.sendBitBuffer(0x86, bb);
    }

    private static sendMissionCompleteUi(
        client: Client,
        missionId: number,
        stars: number,
        dungeonScore: number
    ): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(missionId);
        bb.writeMethod11(1, 1);
        bb.writeMethod6(Math.max(0, Math.min(stars, 15)), 4);
        bb.writeMethod4(Math.max(0, dungeonScore));
        client.sendBitBuffer(0x84, bb);
    }

    private static sendXpReward(client: Client, amount: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(amount);
        client.sendBitBuffer(0x2B, bb);
    }

    private static sendAchievementCompleteUi(client: Client, missionId: number): void {
        const bb = new BitBuffer(false);
        bb.writeMethod4(missionId);
        bb.writeMethod11(0, 1);
        client.sendBitBuffer(0x84, bb);
    }

    private static sendMammothIdolUpdate(client: Client): void {
        if (!client.character) {
            return;
        }

        const bb = new BitBuffer(false);
        bb.writeMethod4(Number(client.character.mammothIdols ?? 0));
        bb.writeMethod4(0);
        bb.writeMethod11(client.character.showHigher ? 1 : 0, 1);
        client.sendBitBuffer(0xA1, bb);
    }

    private static clamp(value: number, min: number, max: number): number {
        return Math.max(min, Math.min(max, Math.round(Number(value) || 0)));
    }

    private static getDungeonParTimeMs(levelName: string, killTarget: number): number {
        const normalizedKillTarget = Math.max(1, Math.round(Number(killTarget) || 0));
        const baseMinutes = 8 + (normalizedKillTarget * 0.3);
        const hardMultiplier = LevelConfig.get(levelName).isHard ? 1.1 : 1;
        return Math.max(60_000, Math.round(baseMinutes * hardMultiplier * 60_000));
    }

    private static buildDungeonCompletionResult(
        client: Client,
        currentLevel: string,
        levelScope: string,
        raw: {
            completionPercent: number;
            bonusScoreTotal: number;
            goldReward: number;
            requiredKills: number;
            actualKills: number;
            dungeonCompleted: boolean;
            scoringCompletionPercent?: number;
        }
    ): DungeonCompletionResult {
        const normalizedLevel = LevelConfig.normalizeLevelName(currentLevel) || currentLevel;
        const runStats = getActiveDungeonRunStats(client);
        const finalizedRun = finalizeDungeonRun(
            client,
            raw.dungeonCompleted ? 'success' : 'fail',
            {
                completionPercent: raw.scoringCompletionPercent ?? raw.completionPercent,
                dungeonCompleted: raw.dungeonCompleted
            }
        );
        const scoreSummary = finalizedRun?.scoreSummary ?? (runStats ? buildDungeonRunScoreSummary(runStats) : null);
        const profile: ResolvedDungeonScoreProfile =
            scoreSummary?.profile ?? getDungeonScoreProfile(normalizedLevel) ?? buildDefaultDungeonScoreProfile(normalizedLevel);
        const maxTotalScore = getDungeonScoreTotalCap(profile);
        const killsScore = Math.max(0, Number(scoreSummary?.finalStat.kills ?? 0));
        const accuracyScore = Math.max(0, Number(scoreSummary?.finalStat.accuracy ?? 0));
        const deathsScore = Math.max(0, Number(scoreSummary?.finalStat.deaths ?? 0));
        const treasureScore = Math.max(0, Number(scoreSummary?.finalStat.treasure ?? 0));
        const timeBonusScore = Math.max(0, Number(scoreSummary?.finalStat.timeBonus ?? 0));
        const totalScore = Math.max(0, Number(scoreSummary?.finalStat.total ?? (killsScore + accuracyScore + deathsScore + treasureScore + timeBonusScore)));
        const stars = Math.max(0, Math.min(10, Number(scoreSummary?.stars ?? 0)));
        const rank = Math.max(1, Math.min(10, Number(scoreSummary?.rank ?? 10)));
        const effectiveKillCount = Math.max(
            0,
            Number(finalizedRun?.killedEnemies ?? runStats?.killedEnemies ?? raw.actualKills ?? 0)
        );

        return {
            actualKills: effectiveKillCount,
            totalScore,
            stars,
            resultBar: scoreSummary?.resultBar ?? profile.resultBar,
            rank,
            killsScore,
            accuracyScore,
            deathsScore,
            treasureScore,
            timeBonusScore
        };
    }

    private static sendDungeonComplete(
        client: Client,
        stats: {
            stars: number;
            resultBar: number;
            rank: number;
            kills: number;
            accuracy: number;
            deaths: number;
            treasure: number;
            timeBonus: number;
        }
    ): void {
        const bb = new BitBuffer(false);
        bb.writeMethod6(Math.max(0, Math.min(stats.stars, 15)), 4);
        bb.writeMethod4(Math.max(0, stats.resultBar));
        bb.writeMethod4(Math.max(0, stats.rank));
        bb.writeMethod4(Math.max(0, stats.kills));
        bb.writeMethod4(Math.max(0, stats.accuracy));
        bb.writeMethod4(Math.max(0, stats.deaths));
        bb.writeMethod4(Math.max(0, stats.treasure));
        bb.writeMethod4(Math.max(0, stats.timeBonus));
        client.sendBitBuffer(0x87, bb);
    }

    private static ensureCraftTownKeepRepaired(character: Character): boolean {
        const magicForge = (character.magicForge ??= { stats_by_building: {} } as any);
        if (!magicForge.stats_by_building) {
            magicForge.stats_by_building = {};
        }

        const statsByBuilding = magicForge.stats_by_building as Record<string, unknown>;
        const keepKey = String(BuildingID.Keep);
        const currentRank = Number(statsByBuilding[keepKey] ?? 0);
        if (
            Number.isFinite(currentRank) &&
            currentRank >= MissionHandler.CRAFT_TOWN_REPAIRED_KEEP_RANK
        ) {
            return false;
        }

        statsByBuilding[keepKey] = MissionHandler.CRAFT_TOWN_REPAIRED_KEEP_RANK;
        if (character.buildingUpgrade?.buildingID === BuildingID.Keep) {
            character.buildingUpgrade = { buildingID: 0, rank: 0, ReadyTime: 0 };
        }
        return true;
    }

    private static sendCraftTownTutorialHomeDoorTarget(client: Client): void {
        const doorId = 2;
        const targetLevel = 'CraftTown';

        client.lastDoorId = doorId;
        client.lastDoorTargetLevel = targetLevel;
        client.armPendingTransferGrace?.();

        const bb = new BitBuffer();
        bb.writeMethod4(doorId);
        bb.writeMethod13(targetLevel);
        client.sendBitBuffer(0x2E, bb);
        MissionHandler.logKeepCompletionProgress('homeDoorTargetSent', client, {
            doorId,
            targetLevel
        });
    }

    private static buildSyntheticLevelCompletePacket(completionPercent: number): Buffer {
        const bb = new BitBuffer(false);
        bb.writeMethod9(Math.max(0, Math.min(100, Math.round(Number(completionPercent ?? 0)))));
        bb.writeMethod9(0);
        bb.writeMethod9(0);
        bb.writeMethod9(0);
        bb.writeMethod9(0);
        bb.writeMethod9(0);
        bb.writeMethod9(0);
        bb.writeMethod9(1);
        bb.writeMethod9(3);
        return bb.toBuffer();
    }

    private static getMissionActiveTargetNames(missionDef: MissionDef): string[] {
        return String(missionDef.ActiveTarget ?? '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);
    }

    private static matchesEnemyKillProgress(
        missionId: number,
        missionDef: MissionDef,
        defeatedNames: string[],
        currentLevel: string
    ): boolean {
        const targetNames = MissionHandler.KILL_PROGRESS_TARGETS[missionId];
        if (targetNames) {
            return defeatedNames.some((name) => targetNames.has(name));
        }

        const activeTargetNames = MissionHandler.getMissionActiveTargetNames(missionDef);
        if (activeTargetNames.length) {
            return activeTargetNames.some((name) => defeatedNames.includes(name));
        }

        if (MissionHandler.matchesCollectibleKillProgress(missionDef, defeatedNames)) {
            return true;
        }

        return MissionHandler.matchesSettleTheDeadKillProgress(missionId, defeatedNames, currentLevel);
    }

    private static matchesSettleTheDeadKillProgress(
        missionId: number,
        defeatedNames: string[],
        currentLevel: string
    ): boolean {
        if (
            !MissionHandler.SETTLE_THE_DEAD_MISSION_IDS.has(missionId) ||
            !MissionHandler.isCemeteryHillLevel(currentLevel)
        ) {
            return false;
        }

        return defeatedNames.some((name) => {
            const entType = GameData.getEntType(name);
            return (
                String(entType?.Kingdom ?? '').trim() === 'Undead' &&
                String(entType?.Realm ?? '').trim() !== 'Wisp'
            );
        });
    }

    private static isCemeteryHillLevel(currentLevel: string): boolean {
        const normalized = String(currentLevel ?? '').trim();
        return (
            normalized === 'CemeteryHill' ||
            normalized === 'CemeteryHillHard' ||
            normalized.startsWith('CH_')
        );
    }

    private static matchesCollectibleKillProgress(missionDef: MissionDef, defeatedNames: string[]): boolean {
        const progressText = MissionHandler.normalizeQuestProgressText(missionDef.ProgressText);
        if (!progressText) {
            return false;
        }

        const rule = MissionHandler.COLLECTIBLE_KILL_PROGRESS_RULES.find(
            (entry) => MissionHandler.normalizeQuestProgressText(entry.progressText) === progressText
        );
        if (!rule) {
            return false;
        }

        return defeatedNames.some((name) => MissionHandler.matchesCollectibleRule(rule, name));
    }

    private static matchesCollectibleRule(rule: CollectibleKillProgressRule, rawName: string): boolean {
        const name = String(rawName ?? '').trim();
        if (!name) {
            return false;
        }

        if (rule.names?.has(name)) {
            return true;
        }

        const entType = GameData.getEntType(name);
        if (rule.parents?.has(String(entType?.parent ?? '').trim())) {
            return true;
        }

        if (rule.realm || rule.realms?.size) {
            const realm = String(entType?.Realm ?? '').trim();
            if (
                (realm === rule.realm || Boolean(rule.realms?.has(realm))) &&
                (!rule.ranks || rule.ranks.has(String(entType?.EntRank ?? '').trim()))
            ) {
                return true;
            }
        }

        return Boolean(rule.namePrefixes?.some((prefix) => name.startsWith(prefix)));
    }

    private static normalizeQuestProgressText(value: unknown): string {
        return String(value ?? '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');
    }

    private static getDefeatedEnemyNames(entity: any): string[] {
        const names = new Set<string>();
        for (const raw of [
            entity?.name,
            entity?.characterName,
            entity?.character_name
        ]) {
            const normalized = String(raw ?? '').trim();
            if (normalized) {
                names.add(normalized);
            }
        }
        return [...names];
    }

    static noteSharedDungeonProgressComplete(levelScope: string, authorityClient: Client): void {
        DungeonCompletionSystem.noteClientCompletionSignal(
            levelScope,
            DungeonCompletionSystem.getParticipantKey(authorityClient),
            100
        );
        if (DungeonCompletionSystem.evaluate(levelScope).ready) {
            MissionHandler.scheduleDungeonCompletionForScope(levelScope, authorityClient);
        }
    }

    private static isRequiredDungeonBossEntity(levelName: string | null | undefined, entity: any): boolean {
        return DungeonCompletionConditions.isRequiredBoss(levelName, entity);
    }

    private static isRequiredDungeonCompletionBossEntity(levelName: string | null | undefined, entity: any): boolean {
        return DungeonCompletionConditions.isRequiredBoss(levelName, entity);
    }

    static shouldProcessEnemyKillStateDungeonCompletion(client: Client, entity: any): boolean {
        if (!client.character) {
            return false;
        }

        const currentLevel =
            LevelConfig.normalizeLevelName(client.currentLevel || String(client.character.CurrentLevel?.name ?? '')) ||
            client.currentLevel ||
            String(client.character.CurrentLevel?.name ?? '');
        const levelScope = getClientLevelScope(client);
        if (
            !currentLevel ||
            !levelScope ||
            !LevelConfig.isDungeonLevel(currentLevel) ||
            MissionHandler.hasFinalizedDungeonCompletion(client, levelScope)
        ) {
            return false;
        }

        const condition = DungeonCompletionConditions.get(currentLevel);
        return Boolean(
            condition &&
            condition.mode !== 'disabled' &&
            Boolean(entity?.clientSpawned) &&
            (
                condition.mode === 'full-clear' ||
                DungeonCompletionConditions.isRequiredBoss(currentLevel, entity) ||
                Boolean(DungeonCompletionConditions.getObjectiveRole(currentLevel, entity))
            )
        );
    }

    static isRequiredDungeonCompletionBossForLevel(levelName: string | null | undefined, entity: any): boolean {
        return DungeonCompletionConditions.isRequiredBoss(levelName, entity);
    }

    static shouldIgnoreUnverifiedDungeonBossDefeat(levelName: string | null | undefined, entity: any): boolean {
        if (!DungeonCompletionConditions.isRequiredBoss(levelName, entity)) {
            return false;
        }

        if (!DungeonCompletionConditions.requiresBosses(levelName)) {
            return false;
        }

        if (Boolean(entity?.clientDefeatVerified)) {
            return false;
        }

        const hp = Number(entity?.hp ?? NaN);
        if (Number.isFinite(hp)) {
            if (hp <= 0) {
                return false;
            }

            // Some authored client-owned bosses stay at 1 HP on the server until
            // the Flash client emits its defeat signal. Higher HP is never a
            // verified boss death.
            if (hp <= 1 && DungeonCompletionConditions.isClientAuthorityBoss(levelName, entity)) {
                return false;
            }

            return true;
        }

        return !(
            Boolean(entity?.dead) ||
            MissionHandler.isDefeatedEntityStateValue(Number(entity?.entState ?? EntityState.ACTIVE))
        );
    }

    private static getEntityName(entity: any): string {
        for (const rawName of [
            entity?.name,
            entity?.EntName,
            entity?.entName,
            entity?.characterName,
            entity?.character_name
        ]) {
            const normalizedName = String(rawName ?? '').replace(/^,+/, '').trim();
            if (normalizedName) {
                return normalizedName;
            }
        }

        return '';
    }

    private static isDefeatedEntityStateValue(entState: number): boolean {
        return entState === EntityState.DEAD ||
            entState === MissionHandler.FLASH_DEFEATED_ENTITY_STATE;
    }

    private static getEntityRoomId(entity: any): number {
        const roomId = Number(entity?.roomId ?? entity?.RoomID ?? entity?.room_id ?? 0);
        return Number.isFinite(roomId) && roomId > 0 ? Math.round(roomId) : 0;
    }

    private static getMissionStateMap(character: Character): Record<string, MissionEntry> {
        const raw = character.missions;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
            character.missions = {};
            return character.missions;
        }
        return raw as Record<string, MissionEntry>;
    }

    private static getMissionState(character: Character, missionId: number): number {
        const missions = MissionHandler.getMissionStateMap(character);
        const entry = MissionHandler.asMissionEntry(missions[String(missionId)]);
        return Number(entry.state ?? MissionHandler.MISSION_NOT_STARTED);
    }

    private static normalizeInstantReturnMissionStates(character: Character): boolean {
        let didMutate = false;

        for (let missionId = 1; missionId <= MissionLoader.getTotalMissions(); missionId++) {
            const missionDef = MissionLoader.getMissionDef(missionId);
            if (!missionDef || !MissionHandler.missionStartsReadyToTurnIn(missionDef)) {
                continue;
            }

            if (MissionHandler.getMissionState(character, missionId) !== MissionHandler.MISSION_IN_PROGRESS) {
                continue;
            }

            MissionHandler.setMissionState(
                character,
                missionId,
                MissionHandler.MISSION_READY_TO_TURN_IN,
                missionDef
            );
            didMutate = true;
        }

        return didMutate;
    }

    private static saveCharacter(client: Client, reason: string = 'mission update'): void {
        if (!client.userId || !client.character) {
            return;
        }

        const chars = Array.isArray(client.characters) ? client.characters : [];
        const idx = chars.findIndex((entry) => entry.name === client.character?.name);
        if (idx !== -1) {
            chars[idx] = client.character;
        } else {
            chars.push(client.character);
        }
        client.characters = chars;
        if (typeof client.scheduleCharacterSave === 'function') {
            client.scheduleCharacterSave(reason);
        }
    }

    private static setMissionState(
        character: Character,
        missionId: number,
        state: number,
        missionDef: MissionDef | undefined,
        extra: Partial<MissionEntry> = {}
    ): void {
        const missions = MissionHandler.getMissionStateMap(character);
        const key = String(missionId);
        const next = MissionHandler.asMissionEntry(missions[key]);

        next.state = state;
        if (extra.currCount !== undefined) {
            next.currCount = Number(extra.currCount);
        }

        if ((missionDef?.Time ?? false) && state >= MissionHandler.MISSION_READY_TO_TURN_IN) {
            next.Tier = Number(extra.Tier ?? next.Tier ?? 0);
            next.highscore = Number(extra.highscore ?? next.highscore ?? 0);
            next.Time = Number(extra.Time ?? next.Time ?? Math.floor(Date.now() / 1000));
        }

        if (state >= MissionHandler.MISSION_CLAIMED) {
            next.claimed = 1;
            next.complete = 1;
        } else {
            delete next.claimed;
            delete next.complete;
        }

        missions[key] = next;
    }

    private static asMissionEntry(value: unknown): MissionEntry {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? { ...(value as MissionEntry) }
            : {};
    }

    private static normalizeMissionNpcKey(value: string): string {
        const normalized = String(value ?? '')
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '');

        if (!normalized) {
            return '';
        }

        const aliases: Record<string, string> = {
            mayorristas: 'nrmayor01',
            mayor: 'nrmayor01',
            anna: 'nranna03',
            npcanna: 'nranna03',
            annaoutside: 'nranna03',
            npcannaoutside: 'nranna03',
            nrquestanna01: 'nranna03',
            nrquestanna02: 'nranna03',
            nrquestanna03: 'nranna03',
            annaoutsidehard: 'nranna03hard',
            npcannaoutsidehard: 'nranna03hard',
            nrquestanna01hard: 'nranna03hard',
            nrquestanna02hard: 'nranna03hard',
            nrquestanna03hard: 'nranna03hard',
            pecky: 'nrpecky',
            captainfink: 'nrcaptfink',
            fink: 'nrcaptfink',
            captain: 'nrcaptfink',
            npccaptain: 'nrcaptfink',
            npcorder01: 'vhjackal02',
            npcorder02: 'vhodin01',
            npcorder03: 'vhfabmab01',
            npcorder04: 'vhodin01',
            npcorder01hard: 'vhjackal02hard',
            npcorder02hard: 'vhodin01hard',
            npcorder03hard: 'vhfabmab01hard',
            npcorder04hard: 'vhodin01hard',
            npcrebel01: 'vhrebel01',
            npcrebel02: 'vhrebel02',
            npcrebel01hard: 'vhrebel01hard',
            npcrebel02hard: 'vhrebel02hard',
            npcvagrant02: 'vhskitts01',
            npcvagrant01: 'vhvagrant01',
            npcvagrant02hard: 'vhskitts01hard',
            npcvagrant01hard: 'vhvagrant01hard',
            npcmonk01: 'vhmonk01',
            npcmonk01hard: 'vhmonk01hard'
        };

        return aliases[normalized] ?? normalized;
    }
}
