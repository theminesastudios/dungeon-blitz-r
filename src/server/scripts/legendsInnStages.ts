/**
 * The Legends' Inn stage list.
 *
 * Legends' Inn is a tour of Ellyria: one authored dungeon from each region, kept
 * whole, chained end to end. Two tools need the same list - the SWF build and the
 * Game.swz registration - so it lives here rather than in either of them.
 *
 * Stage order is the order the regions unlock in the campaign.
 *
 * Every stage is a Dread level - the `Hard` in the name is what puts the run on
 * the Dread reward tables, the Dread stat caps and the "Dread Legends' Inn"
 * presence label.
 *
 * ## How hard a hostile actually is
 *
 * Not from anything the server computes. A client-spawned hostile's health pool
 * is decided on the client, by `Entity.method_986`:
 *
 *     maxHp = HOSTILE_BASE_HP[ entType.Level + game.mBonusLevels ] * entType.HitPoints
 *
 * `mBonusLevels` arrives in the player-data packet and is the only lever there
 * is - the server's own `getHostileHpTier` is a *model* of the same arithmetic,
 * used for boss authority, and changing it alone moves nothing on screen.
 *
 * That matters here more than in any shipped dungeon. A normal Dread dungeon's
 * enemies were all authored for one region's tier, so the region's fixed jump
 * lifts them together. Legends' Inn draws from the whole game at once: without a
 * bonus a stage-1 Dog Packmate fights at its authored level 10 - 2,036 hit
 * points against a level-50 player - and dies to a stray swing.
 *
 * So each stage carries its own `mapId - baseId` gap, computed by the build from
 * the roster it actually rolled: enough to lift the *weakest* mob in the stage
 * onto row 50. Everything above it clamps there, so the whole dungeon fights at
 * the top of the table, which is what "Dungeon Level: 50" already claims.
 *
 * `enemyLevelBand` therefore only decides *which* Dread mobs a stage may draw, so
 * the tour still walks from skeletons and lizards to shades and brigands.
 */
import { MobClass, MobRank } from "./legendsInnEnemies";

export interface LegendsInnStage {
  /** Region the dungeon belongs to, and the second half of the display name. */
  region: string;
  /** Server map name. */
  levelName: string;
  /** Region SWF the stage is trimmed out of. */
  swf: string;
  levelClass: string;
  outFile: string;
  /**
   * The shipped dungeon this stage is a copy of. Its enemy catalog, completion
   * condition and LevelType are reused rather than re-derived - it is the same
   * rooms, the same enemies and the same region.
   */
  sourceLevelName: string;
  /**
   * Room the exit portal is placed in. Defaults to the room holding am_Boss,
   * which is where a dungeon's fight ends.
   */
  bossRoom?: string;
  /** Nudges the portal off the boss's own anchor, in room-local pixels. */
  exitOffset?: { x: number; y: number };
  /**
   * Which of the three classes the stage leans on, cycled across its hostiles.
   * A class named twice is placed twice as often.
   */
  classWeights: MobClass[];
  /** What the stage's boss fights as. */
  bossClass: MobClass;
  /**
   * The rank the boss slot is filled from. `MiniBoss` for every stage: the tour
   * ends each leg on a Dread Rogue mini-boss rather than on the shipped dungeon
   * boss it replaced. See `StageEnemyPlan.bossRank`.
   */
  bossRank?: MobRank;
  /** Ranks the ordinary hostiles are drawn from; see `StageEnemyPlan.rankPlan`. */
  rankPlan?: MobRank[];
  /**
   * Cue classes to rename by hand, on top of the bestiary swap.
   *
   * `PROP_BEHAVIORS` deliberately keeps spawners and traps out of the swap, so a
   * stage whose fight is *built* on one needs a way to say "that trap, but the
   * Legends' Inn version of it". Shazari is the only such stage: its boss room's
   * four summoning totems now call a Dread Rogue instead of a shadow puck, which
   * is a different EntType and therefore a different cue class.
   */
  cueRenames?: Record<string, string>;
  /**
   * The EntType levels the stage may draw from - which mobs show up, not how hard
   * they hit. Every hostile is sized from the party's tier; see the file comment.
   */
  enemyLevelBand: { min: number; max: number };
}

/**
 * What fills a boss cue when the stage does not name a guardian for it.
 *
 * Every stage names its guardians now - see `legendsInnBosses.ts`, which the SWF
 * build reads directly - so in practice nothing reaches these any more. They stay
 * as the fallback for a stage that grows a boss cue the guardian table has not
 * caught up with: a Dread Rogue mini-boss, which is what the tour ended on before
 * the guardians existed. The cue itself is untouched either way - the boss room's
 * script, its intro and the portal that opens when it falls are all unchanged.
 */
const STAGE_BOSS_CLASS: MobClass = "Rogue";
const STAGE_BOSS_RANK: MobRank = "MiniBoss";

/**
 * What the last two stages are populated with.
 *
 * Shazari and Valhaven are the end of the road, so nothing in them fights at
 * Minion strength: every cue is filled from the Dread Rogue Lieutenant and
 * MiniBoss shelves, alternating, which is 20 distinct EntTypes against the 28
 * cues the two stages place between them.
 */
const ELITE_ROGUE_RANKS: MobRank[] = ["Lieutenant", "MiniBoss"];

/**
 * The dungeon's own tier - the `baseId` half of the level_config entry, and the
 * row of the hostile health table every stage is pulled up to. Fifty because
 * Legends' Inn is endgame: the entry plate says so and the roster is sized to it.
 */
export const STAGE_TIER = 50;

/**
 * The infix that marks a Legends' Inn flier.
 *
 * Nothing built on the Rogue, Paladin or Mage skeleton flies, but several cues in
 * these dungeons were authored for something that does - psychophage swarms, wisps,
 * embers, imps, ghost servants - and their placements hang over chasms and water
 * on purpose. Dropping a walking mob onto one leaves it standing in mid-air.
 *
 * So those cues get a Dread Mage that has been cloned with `Flying`: a levitating
 * sorcerer, which is what the authored position was always drawing. The clones are
 * minted by patch_swz_legends_inn_ents.ts from the list the build writes.
 */
export const LEGENDS_INN_FLIER_SUFFIX = "Aloft";

/**
 * The EntType the exit portal is drawn as.
 *
 * The portal is a *server-spawned entity*, not level art, and that is the whole
 * reason it can appear when the boss dies: a level SWF has no way to reveal a
 * child of a room part-way through a run, but the server can push an entity into
 * a level scope whenever it likes. It also settles the name plate - a door with
 * artwork on it would carry the target level's plate, and an entity carries only
 * its EntType's DisplayName, which this one deliberately does not have.
 *
 * See patch_swz_legends_inn_portal_ent.ts for the EntType itself.
 */
export const LEGENDS_INN_PORTAL_ENT = "LegendsInnPortal";

/** The build writes what it placed here; the server reads it back. */
export const LEGENDS_INN_STAGE_DATA_FILE = "legends_inn_stages.json";

/**
 * The track that plays for the whole dungeon, in `content/localhost/p/mp3/`.
 *
 * All nine stages name the same file on purpose, and that is what makes the music
 * survive the portals. `SoundManager.method_103` stops the music slot, keeps the
 * playhead in `class_149.var_2982`, and restarts from it *only when the incoming
 * track name is the same string* - a different name resets to zero. The `Sound`
 * itself is cached by filename in `SoundManager.method_311`, so the stage change
 * does not re-download it either: the run hears one continuous piece from the
 * first room of stage 1 to the last of stage 9.
 *
 * Nothing has to list the file anywhere. `ResourceManager.method_466` builds the
 * URL as `mp3/<name>` and StaticServer serves the whole content directory, which
 * is how every other track in the library is reached.
 */
export const LEGENDS_INN_MUSIC_LOOP = "LegendsInn_Theme.mp3";

/** Where the dungeon is entered from, and where the last stage lets out. */
export const ENTRY_LEVEL = "CraftTown";
export const ENTRY_DOOR_ID = 101;
/** Every stage keeps a way straight back out, on the door the dungeon shipped with. */
export const RETURN_DOOR_ID = 1;

export const LEGENDS_INN_STAGES: LegendsInnStage[] = [
  {
    region: "Wolf's End",
    levelName: "LegendsInn1Hard",
    swf: "cbp/LevelsNR.swf",
    levelClass: "a_Level_GoblinRiver",
    outFile: "LevelsLI01.swf",
    sourceLevelName: "GoblinRiverDungeon",
    classWeights: ["Paladin", "Mage", "Rogue"],
    bossClass: STAGE_BOSS_CLASS,
    bossRank: STAGE_BOSS_RANK,
    enemyLevelBand: { min: 3, max: 11 },
  },
  {
    region: "Blackrose Mire",
    levelName: "LegendsInn2Hard",
    swf: "cbp/LevelsSRN.swf",
    levelClass: "a_Level_SRNMission7Svath",
    outFile: "LevelsLI02.swf",
    sourceLevelName: "SRN_Mission7",
    classWeights: ["Mage", "Paladin", "Rogue"],
    bossClass: STAGE_BOSS_CLASS,
    bossRank: STAGE_BOSS_RANK,
    enemyLevelBand: { min: 9, max: 13 },
  },
  {
    region: "Bridgetown",
    levelName: "LegendsInn3Hard",
    swf: "cam/LevelsBT.swf",
    levelClass: "a_Level_BTMission1",
    outFile: "LevelsLI03.swf",
    sourceLevelName: "BT_Mission1",
    classWeights: ["Rogue", "Paladin", "Mage"],
    bossClass: STAGE_BOSS_CLASS,
    bossRank: STAGE_BOSS_RANK,
    enemyLevelBand: { min: 11, max: 15 },
  },
  {
    region: "Cemetery Hill",
    levelName: "LegendsInn4Hard",
    swf: "cam/LevelsCH.swf",
    levelClass: "a_Level_CHMission3",
    outFile: "LevelsLI04.swf",
    sourceLevelName: "CH_Mission3",
    classWeights: ["Paladin", "Rogue", "Mage"],
    bossClass: STAGE_BOSS_CLASS,
    bossRank: STAGE_BOSS_RANK,
    enemyLevelBand: { min: 12, max: 17 },
  },
  {
    region: "Stormshard",
    levelName: "LegendsInn5Hard",
    swf: "cbp/LevelsOMM.swf",
    levelClass: "a_Level_OMMMission06ForgottenForge",
    outFile: "LevelsLI05.swf",
    sourceLevelName: "OMM_Mission6",
    classWeights: ["Mage", "Rogue", "Paladin"],
    bossClass: STAGE_BOSS_CLASS,
    bossRank: STAGE_BOSS_RANK,
    enemyLevelBand: { min: 14, max: 19 },
  },
  {
    region: "Emerald Glades",
    levelName: "LegendsInn6Hard",
    swf: "cam/LevelsEG.swf",
    levelClass: "a_Level_EGMission5",
    outFile: "LevelsLI06.swf",
    sourceLevelName: "EG_Mission5",
    classWeights: ["Paladin", "Mage", "Rogue"],
    bossClass: STAGE_BOSS_CLASS,
    bossRank: STAGE_BOSS_RANK,
    enemyLevelBand: { min: 16, max: 22 },
  },
  {
    region: "Deepgard Castle",
    levelName: "LegendsInn7Hard",
    swf: "cbp/LevelsAC.swf",
    levelClass: "a_Level_TheEmeraldThrone",
    outFile: "LevelsLI07.swf",
    sourceLevelName: "AC_Mission2",
    classWeights: ["Mage", "Paladin", "Rogue"],
    bossClass: STAGE_BOSS_CLASS,
    bossRank: STAGE_BOSS_RANK,
    enemyLevelBand: { min: 18, max: 24 },
  },
  // The last two stages are the Rogue leg of the tour: three hostiles in four are
  // Rogues, and both bosses are. Rogue Minions are the thinnest corner of the
  // roster - the game shipped three - so those slots fall through to Rogue
  // Lieutenants rather than to another class, which is what RANK_FALLBACKS is for.
  {
    region: "Shazari Desert",
    levelName: "LegendsInn8Hard",
    swf: "cam/LevelsSD.swf",
    levelClass: "a_Level_SDMission1",
    outFile: "LevelsLI08.swf",
    sourceLevelName: "SD_Mission1",
    classWeights: ["Rogue"],
    bossClass: STAGE_BOSS_CLASS,
    bossRank: STAGE_BOSS_RANK,
    rankPlan: ELITE_ROGUE_RANKS,
    // The boss room's four summoning totems. See patch_swz_legends_inn_servant.ts.
    cueRenames: { ac_RageGuardianServant: "ac_LegendsInnServant" },
    enemyLevelBand: { min: 21, max: 28 },
  },
  {
    region: "Valhaven",
    levelName: "LegendsInn9Hard",
    swf: "cbp/LevelsJC.swf",
    levelClass: "a_Level_JCMini1",
    outFile: "LevelsLI09.swf",
    sourceLevelName: "JC_Mini1",
    classWeights: ["Rogue"],
    bossClass: STAGE_BOSS_CLASS,
    bossRank: STAGE_BOSS_RANK,
    rankPlan: ELITE_ROGUE_RANKS,
    enemyLevelBand: { min: 22, max: 50 },
  },
];

/**
 * Matches every level name this feature owns, so a rebuild replaces its own
 * entries. The optional `Hard` is what lets a rebuild clean up the pre-Dread
 * names as well as write the current ones.
 */
export const LEGENDS_INN_LEVEL = /^LegendsInn\d*(Hard)?$/;

/**
 * What every stage is called in game.
 *
 * All nine share one name on purpose: the stages are one dungeon to the player,
 * walked end to end through the portals, not nine dungeons in a row. Naming the
 * borrowed dungeon or its region on the plate would give that away.
 */
export function legendsInnDisplayName(): string {
  // A literal apostrophe, matching how "Wolf's End" is already stored in Game.swz.
  return "Legends' Inn";
}
