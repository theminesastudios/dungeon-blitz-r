/**
 * Which enemies a Legends' Inn stage is populated with.
 *
 * Legends' Inn is the Dread tour: every stage is a shipped dungeon kept whole, but
 * the things standing in it are replaced. The rule the dungeon is built around is
 * a single one - **every hostile is a Rogue, a Paladin or a Mage, and every one of
 * them is the Dread (`*Hard`) variant of its EntType.**
 *
 * "Rogue/Paladin/Mage" is not a naming convention here, it is the entity's body:
 * an EntType whose `parent` chain reaches `RogueBase`, `PaladinBase` or `MageBase`
 * is drawn on the player skeleton out of `Gfx_<Class>_1.swf`, which every client
 * has loaded in every level. That is what makes the swap safe in nine different
 * region SWFs - nothing has to be imported, because the art was already there.
 *
 * A level SWF names its hostiles by binding an empty marker sprite to a class
 * called `ac_<EntName>`; the client reads the EntType straight off that name. So
 * swapping an enemy is a *string* edit - see `renameAbcStrings` - and everything
 * else about the level (rooms, waves, room directors, boss cutscenes, spawn
 * counts, patrol paths) is untouched. This module decides those strings.
 *
 * Selection is deterministic: same EntTypes in, same roster out, so a rebuild
 * never silently reshuffles a dungeon that players have already learned.
 */
import * as fs from "fs";
import * as path from "path";
import { SwfLevelError } from "./swfLevelUtils";

export type MobClass = "Rogue" | "Paladin" | "Mage";
export type MobRank = "Minion" | "Lieutenant" | "MiniBoss" | "Boss";

export interface PoolEntry {
  /** The Dread EntType, i.e. what actually fights and what the server is told about. */
  entName: string;
  /**
   * The same EntType without `Hard`, which is the name that goes in the SWF.
   *
   * A Dread level does not carry Dread cue classes. `Level.as` appends `"Hard"` to
   * a cue's entType itself whenever the map's alterParams are `"Hard"`, which is
   * how every shipped Dread dungeon reuses the normal dungeon's SWF unchanged.
   * Writing `ac_<X>Hard` into the SWF therefore asks the client for `<X>HardHard`,
   * which exists for nothing - and a Legends' Inn stage came up completely empty.
   */
  baseEntName: string;
  mobClass: MobClass;
  rank: MobRank;
  /** The EntType's authored level, which is what sizes it in a Dread run. */
  level: number;
  displayName: string;
  /**
   * What the thing looks like.
   *
   * `Realm` is the field that decides which body a player-skeleton hostile is
   * dressed as - Human, Skeleton, Lizard, Spirit, Wolf, Lion, Imperial, Shade,
   * Dryad, Demon, Scarab - so two EntTypes sharing a realm are two names for the
   * same silhouette. The tour is nine dungeons long and was drawing the same
   * handful of silhouettes over and over; `scoreCandidate` spends this to stop it.
   */
  realm: string;
}

const RANKS: MobRank[] = ["Minion", "Lieutenant", "MiniBoss", "Boss"];

/**
 * Cue classes that name scenery rather than a creature.
 *
 * Every one of these is placed like an enemy and has an EntType with an EntRank,
 * but it is a chest, a fire trap, a spawner spire or a disguised prop that room
 * scripts drive by name. Renaming one either breaks the room or drops a Rogue
 * into a torch bracket, so they keep the identity the level authored.
 *
 * Wisps are *not* on this list even though they float and glow: they are real
 * hostiles with a rank and a health pool, and groundAirborneCues puts their
 * replacement somewhere it can stand.
 */
const PROP_CUES = /^(TreasureChest|Vigil|CaveVigil|EmberBush|DoorPortal|NephitSpireMarker|DesertMimicSpire|Mimic$)/;

/**
 * Behaviours that mean "machinery", not "creature".
 *
 * The name list above only ever caught the props somebody had already tripped
 * over, and it missed the ones that matter most: **spawners and traps**. Shazari's
 * boss room is the case that made this a rule rather than a list. Its four
 * `am_Adds` markers are `RageGuardianServant` - `Behavior ServantSpawner`, a
 * floating totem that summons pucks - and the boss script kills all four when the
 * fight starts, then revives one every twelve seconds to call another wave.
 *
 * Swapped for a walking Rogue, that fight stopped making sense: the traps were
 * gone, and what the player saw instead was four rogues lying dead on the floor
 * from the first second, standing back up one at a time. Left alone, the totems
 * are traps again and the small rogues they summon are the ones the stage's own
 * bestiary swap already provides.
 *
 * The same is true of every other entry here - spike traps, vigil emitters, power
 * markers, cannonballs, summoned pets. They have an `EntRank` and are placed like
 * enemies, but a room script drives them by name and by what they *do*, and there
 * is no body to put a Rogue's skeleton on.
 *
 * Deliberately **not** listed: `Wisp`, `Poltergeist`, `BannerBearer`, `SandWorm`,
 * `PolarSentry`, `Revivable*` and the `DramaTargetable*` pair. Those float, burrow
 * or rise from the dead, but each is a real hostile with a health pool that a
 * player fights, so each is fair game for the swap.
 */
const PROP_BEHAVIORS = new Set([
  "Aura",
  "BeehiveSpawner",
  "Bush",
  "CombatSwitch",
  "DarkOrbType",
  "Decoy",
  "DesertLarva",
  "DragonPortal",
  "DragonSoul",
  "Dummy",
  "Ember",
  "FollowPet",
  "GoblinCannon",
  "HomeDummy",
  "Homing",
  "Kraken",
  "LarvaSpawner",
  "Mushroom",
  "NephitEye",
  "Parrot",
  "PermafrostClone",
  "PowerMarker",
  "PowerMarkerCombat",
  "ScalingFollowPet",
  "ServantSpawner",
  "Spark",
  "Spawner",
  "SpawnerNephit",
  "SpikeTrap",
  "TreasureChest",
  "UndeadPet",
  "UndeadPetRanged",
  "VigilFountain",
  "VigilStraight",
  "VigilTarget",
  "VigilWaterfall",
]);

/**
 * Where a slot may look when its own rank is empty.
 *
 * A boss slot only ever takes a boss: a boss room's script, its health bar and
 * its ending cutscene are all authored against something that fights like one.
 * The other three may borrow from a neighbour, because the Rogue side of the
 * roster is thin at Minion rank (the game only ever shipped three) and a run of
 * nine dungeons would otherwise repeat the same three lizards all night.
 */
const RANK_FALLBACKS: Record<MobRank, MobRank[]> = {
  Minion: ["Minion", "Lieutenant"],
  Lieutenant: ["Lieutenant", "MiniBoss", "Minion"],
  MiniBoss: ["MiniBoss", "Lieutenant"],
  Boss: ["Boss"],
};

/**
 * What a Legends' Inn hostile is called on screen.
 *
 * A Dread EntType carries the same `DisplayName` as the one it was cloned from -
 * `BanditBossHard` is "Svagg" exactly as `BanditBoss` is - so there is no "Dread
 * name" sitting in the data to read. The Dread prefix is the label the rest of the
 * game already uses for a Dread thing ("Dread Legends' Inn" in presence), so the
 * stage's bosses wear it too: a boss plate that says "Dread Hive Guardian" reads
 * as this dungeon's, where a bare "Hive Guardian" reads as Shazari's.
 */
export function dreadDisplayName(displayName: string): string {
  const name = String(displayName ?? "").trim();
  if (!name) return "";
  return /^dread\b/i.test(name) ? name : `Dread ${name}`;
}

function readEntTypes(dataDir: string): Map<string, Record<string, string>> {
  const raw = fs.readFileSync(path.join(dataDir, "EntTypes.json"), "utf8").replace(/^﻿/, "");
  const parsed = JSON.parse(raw) as { EntTypes: { EntType: Array<Record<string, string>> } };
  const byName = new Map<string, Record<string, string>>();
  for (const ent of parsed.EntTypes.EntType) {
    const name = String(ent.EntName ?? "");
    if (name) byName.set(name, ent);
  }
  return byName;
}

/** Walks `parent` until it hits one of the three player bases, or runs out. */
function mobClassOf(byName: Map<string, Record<string, string>>, entName: string): MobClass | null {
  let current = byName.get(entName);
  for (let depth = 0; current && depth < 12; depth += 1) {
    if (current.EntName === "RogueBase") return "Rogue";
    if (current.EntName === "PaladinBase") return "Paladin";
    if (current.EntName === "MageBase") return "Mage";
    const parent = String(current.parent ?? "");
    if (!parent) return null;
    current = byName.get(parent);
  }
  return null;
}

/** Reads a field through the `parent` chain, the way the client resolves one. */
function inheritedField(byName: Map<string, Record<string, string>>, entName: string, field: string): string {
  let current = byName.get(entName);
  for (let depth = 0; current && depth < 12; depth += 1) {
    if (current[field] !== undefined) return String(current[field]);
    current = byName.get(String(current.parent ?? ""));
  }
  return "";
}

function rankOf(ent: Record<string, string> | undefined): MobRank | null {
  const rank = String(ent?.EntRank ?? "");
  return (RANKS as string[]).includes(rank) ? (rank as MobRank) : null;
}

/**
 * Every Dread Rogue/Paladin/Mage the game has.
 *
 * Excluded by name: summoned clones and pets (they belong to a power, not a
 * room), the two `*Marker` stand-ins a boss encounter spawns itself, the Home
 * training dummies, and the Spy set, whose EntTypes carry no display name and
 * exist only for one scripted Shazari scene.
 *
 * Also excluded: any `XHard` with no plain `X`. The SWF can only name the base
 * (see `baseEntName`), so a Dread EntType whose base was never authored - the
 * game has a few, `ShadeInquisitor2Hard` among them - is unreachable however
 * good a fit it looks.
 *
 * And excluded by prefix: `LegendsInn*`. The dungeon's own EntTypes - the ten
 * guardians and the stage-8 summoning totem - satisfy every test here and would
 * happily be rolled into a corridor, which would put a stage's boss in it twice
 * over. They are placed by name or not at all.
 */
function buildPoolEntry(
  byName: Map<string, Record<string, string>>,
  entName: string,
): PoolEntry | null {
  const ent = byName.get(entName);
  if (!ent) return null;
  const baseEntName = /Hard$/.test(entName) ? entName.slice(0, -4) : entName;
  if (!byName.has(baseEntName)) return null;

  const mobClass = mobClassOf(byName, entName);
  const rank = rankOf(ent) ?? (rankOf(byName.get(baseEntName)) as MobRank | null);
  if (!mobClass || !rank) return null;

  return {
    entName,
    baseEntName,
    mobClass,
    rank,
    level: Math.max(1, Math.round(Number(inheritedField(byName, entName, "Level"))) || 1),
    // Through the parent chain: the name a boss fights under is the one the
    // client would show, and a few EntTypes inherit theirs rather than declare it.
    displayName: inheritedField(byName, entName, "DisplayName"),
    realm: inheritedField(byName, entName, "Realm"),
  };
}

export function loadDreadClassMobPool(dataDir: string): PoolEntry[] {
  const byName = readEntTypes(dataDir);
  const pool: PoolEntry[] = [];

  for (const ent of byName.values()) {
    const entName = String(ent.EntName ?? "");
    if (!/Hard$/.test(entName)) continue;
    if (/Marker|Dummy|Clone|ShadowLegion|GreenKnight|Emperor|^Spy|^LegendsInn/.test(entName)) continue;

    const entry = buildPoolEntry(byName, entName);
    if (entry) pool.push(entry);
  }

  pool.sort((left, right) => left.entName.localeCompare(right.entName));
  if (pool.length === 0) throw new SwfLevelError("EntTypes.json has no Dread Rogue/Paladin/Mage entries");
  return pool;
}

/**
 * Pool entries for EntTypes named outright, rather than rolled for.
 *
 * The ten guardians are placed by name (`StageEnemyPlan.bossOverrides`), and the
 * assignment still wants everything it knows about an ordinary pick - the rank the
 * roster row reports, the level `monsterBonusLevels` is derived from, the display
 * name the boss plate is rewritten to. This builds exactly that, for names the
 * pool deliberately does not carry.
 */
export function loadNamedPoolEntries(dataDir: string, entNames: string[]): PoolEntry[] {
  const byName = readEntTypes(dataDir);
  return entNames.map((entName) => {
    const entry = buildPoolEntry(byName, entName);
    if (!entry) throw new SwfLevelError(`EntTypes.json has no usable ${entName}`);
    return entry;
  });
}

/** The elements the dungeon entry screen shows, most common first. */
const ELEMENT_ORDER = ["Fire", "Ice", "Air", "Earth", "Life", "Death"];
const KINGDOM_TO_ELEMENT: Record<string, string> = {
  Draconic: "Fire",
  Infernal: "Air",
  Mythic: "Ice",
  Sylvan: "Life",
  Trog: "Earth",
  Undead: "Death",
};

function normalizeElement(value: unknown): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const normalized = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  return ELEMENT_ORDER.includes(normalized) ? normalized : "";
}

/**
 * The elements a roster reads as, ranked the way generate-dungeon-enemy-elements.js
 * ranks them: by how many of the level's enemies carry each, ties broken by the
 * screen's own element order. An EntType with no `Element` falls back to its
 * Kingdom, which is where most of these humanoids get theirs.
 */
export function resolveRosterElements(dataDir: string, entNames: Iterable<string>): string[] {
  const byName = readEntTypes(dataDir);
  const counts = new Map<string, number>();

  for (const entName of entNames) {
    // Through the parent chain, the way the client resolves one: the ten
    // guardians declare neither field and inherit both from the body they wear,
    // and reading them flat would drop a stage's boss out of its own catalog.
    const element =
      normalizeElement(inheritedField(byName, entName, "Element")) ||
      normalizeElement(KINGDOM_TO_ELEMENT[inheritedField(byName, entName, "Kingdom")]);
    if (!element) continue;
    counts.set(element, (counts.get(element) ?? 0) + 1);
  }

  return [...counts.entries()]
    .sort((left, right) =>
      right[1] !== left[1] ? right[1] - left[1] : ELEMENT_ORDER.indexOf(left[0]) - ELEMENT_ORDER.indexOf(right[0]),
    )
    .map(([element]) => element);
}

export interface EnemyCue {
  /** The `ac_` class as the level SWF exports it. */
  className: string;
  /** The EntType it names, i.e. the class without the `ac_` prefix. */
  entName: string;
  rank: MobRank;
  /**
   * Whether the cue was authored for something airborne. Those placements sit
   * over chasms and water deliberately, so their replacement has to fly too.
   */
  flying: boolean;
}


/** The hostiles a stage places, in the order the SWF exports them. */
export function readEnemyCues(dataDir: string, classNames: string[]): EnemyCue[] {
  const byName = readEntTypes(dataDir);
  const cues: EnemyCue[] = [];

  for (const className of classNames) {
    if (!className.startsWith("ac_")) continue;
    const entName = className.slice(3);
    if (PROP_CUES.test(entName)) continue;

    const ent = byName.get(entName);
    const rank = rankOf(ent);
    // No EntType, or an EntType with no rank, means the cue is not a creature the
    // client will build a hostile out of - a door target, a group anchor, an
    // effect. Those are left alone for the same reason the props above are.
    if (!ent || !rank) continue;
    if (PROP_BEHAVIORS.has(inheritedField(byName, entName, "Behavior"))) continue;
    cues.push({ className, entName, rank, flying: /true/i.test(inheritedField(byName, entName, "Flying")) });
  }

  return cues;
}

export interface StageEnemyPlan {
  /** Cycled across the stage's hostiles, so a weight repeated twice is twice as common. */
  classWeights: MobClass[];
  /** The Dread tier the stage should land on, as an EntType level band. */
  levelBand: { min: number; max: number };
  /** What the stage's boss fights as. */
  bossClass: MobClass;
  /**
   * The rank the stage's boss slot is filled from.
   *
   * Legends' Inn ends every stage on a Dread Rogue mini-boss rather than on a
   * shipped dungeon boss, so this is `MiniBoss` throughout. The boss *cue* is
   * unchanged - it is still the room's boss, still drives the boss room's script
   * and still opens the portal - only what stands in it is drawn from a different
   * shelf of the roster.
   */
  bossRank?: MobRank;
  /**
   * Ranks the stage's ordinary hostiles are drawn from, cycled the way
   * `classWeights` is, instead of the rank each cue was authored at.
   *
   * The last two stages of the tour are meant to be wall-to-wall elites, so their
   * minion cues are filled from the Lieutenant and MiniBoss shelves and nothing in
   * them fights at Minion strength.
   */
  rankPlan?: MobRank[];
  /**
   * The EntTypes the stage's boss cues are filled with, in cue order, instead of
   * anything out of the pool.
   *
   * Legends' Inn ends each leg on a named guardian with its own EntType - see
   * `legendsInnBosses.ts` - so a boss slot is not a roll at all any more. Resolve
   * them with `loadNamedPoolEntries`: the pool itself does not carry them, exactly
   * so that nothing can roll one into a corridor.
   *
   * A stage with more boss cues than overrides falls back to the roll for the
   * extras rather than failing the build.
   */
  bossOverrides?: PoolEntry[];
}

export interface AssignmentContext {
  /** EntTypes already handed out in earlier stages, so the tour keeps introducing new faces. */
  usedGlobally: Set<string>;
  /**
   * EntTypes that have already ended a stage.
   *
   * Kept apart from `usedGlobally` because a boss slot needs a much stronger
   * preference than an ordinary one. There are eight Dread Rogue mini-bosses in
   * the game and ten boss cues across the nine stages, and the last two stages
   * spend several of those eight on their own rank-and-file; without this, three
   * different stages ended on the same face.
   */
  usedAsBoss: Set<string>;
  /**
   * How many hostiles the tour has already placed of each `Realm`.
   *
   * The complaint this answers is about *looks*, not about names: a stage could
   * introduce twelve EntTypes the tour had never used and still be the fifth hold
   * in a row full of castle lizards, because `Realm` is what decides the body and
   * several EntTypes share one. Counting realms across the whole tour is what lets
   * `scoreCandidate` push a stage towards silhouettes the run has not shown much
   * of yet.
   */
  realmsUsedGlobally: Map<string, number>;
}

export function createAssignmentContext(): AssignmentContext {
  return {
    usedGlobally: new Set<string>(),
    usedAsBoss: new Set<string>(),
    realmsUsedGlobally: new Map<string, number>(),
  };
}

/**
 * Scores how well a pool entry fits a slot; lowest wins, name breaks ties.
 *
 * The weights encode the brief, in order of how much they matter:
 *   - never reuse an EntType inside one stage (a stage with two rooms of the same
 *     bandit reads as a bug, and the level already varies its own cues);
 *   - stay in the class the stage is leaning on;
 *   - stay in the slot's rank family, so a minion wave stays a minion wave;
 *   - sit inside the stage's level band, because a Dread hostile is sized from
 *     its authored level plus the level's jump - a level-3 skeleton in the last
 *     dungeon would be free experience;
 *   - prefer a *silhouette* the stage, and then the tour, has not leaned on;
 *   - and, all else equal, prefer a face the tour has not used yet.
 *
 * The last two are what stops nine dungeons reading as one. `usedGlobally` alone
 * was too weak to do it - at 90 it lost to a two-level band miss - and it was
 * answering the wrong question anyway: a stage full of EntTypes the tour had never
 * placed is still the fifth hold of castle lizards if they all share a `Realm`. So
 * the realm terms are the heavy ones now and the name term was raised to match.
 */
function scoreCandidate(
  entry: PoolEntry,
  desiredClass: MobClass,
  desiredRank: MobRank,
  plan: StageEnemyPlan,
  context: AssignmentContext,
  usedInStage: Set<string>,
  reservedBaseNames: Set<string>,
  bossSlot: boolean,
  bossDisplayNamesInStage: Set<string>,
  realmsInStage: Map<string, number>,
): number {
  if (usedInStage.has(entry.entName)) return Number.POSITIVE_INFINITY;
  // Two boss cues in one room - Bridgetown's twins - must not answer to the same
  // plate. `InfusedSkeletonRogue` and `InfusedSkeletonRogue2` are different
  // EntTypes with one display name between them, and picking both left the second
  // twin fighting under the shipped dungeon's name, because a rename target the
  // ABC pool already holds is refused rather than duplicated.
  if (bossSlot && bossDisplayNamesInStage.has(entry.displayName)) return Number.POSITIVE_INFINITY;
  // A name the stage already exports cannot be a rename target: the ABC pool
  // would hold it twice, and renameAbcStrings refuses that outright rather than
  // let two classes answer to one name.
  if (reservedBaseNames.has(entry.baseEntName)) return Number.POSITIVE_INFINITY;

  // A boss slot takes its rank exactly. Every other slot may borrow from a
  // neighbouring rank because the roster is thin in places, but "the stage ends on
  // a Dread Rogue mini-boss" is the rule the dungeon is built around, and there are
  // ten boss cues against eight mini-bosses: without this the last two stages ran
  // out of unused faces and quietly ended on a Lieutenant instead. Repeating a
  // mini-boss is the right trade - see the reuse penalty below, which keeps the
  // repeats to the two the arithmetic forces.
  const allowedRanks = bossSlot ? [desiredRank] : RANK_FALLBACKS[desiredRank];
  const rankIndex = allowedRanks.indexOf(entry.rank);
  // Class is exact for a boss slot too, for the same reason the rank is: given the
  // choice between a Rogue mini-boss the tour has already used and an unused
  // *Paladin* one, the score alone picks the Paladin, and the stage stops being
  // the Rogue fight the dungeon's story is about.
  if (bossSlot && entry.mobClass !== desiredClass) return Number.POSITIVE_INFINITY;
  if (rankIndex === -1) return Number.POSITIVE_INFINITY;

  const bandMiss =
    entry.level < plan.levelBand.min
      ? plan.levelBand.min - entry.level
      : entry.level > plan.levelBand.max
        ? entry.level - plan.levelBand.max
        : 0;

  // Both realm terms are per *extra* body of that realm, so the first Skeleton in
  // a stage is free, the second costs a little and the sixth costs more than
  // stepping a rank sideways. Growing rather than flat, because the goal is not to
  // ban a repeat - a hold does want a theme - but to stop one silhouette filling
  // it, and then filling the next stage as well.
  const realmInStage = entry.realm ? (realmsInStage.get(entry.realm) ?? 0) : 0;
  const realmOnTour = entry.realm ? (context.realmsUsedGlobally.get(entry.realm) ?? 0) : 0;

  return (
    // Bigger than every other term put together. It used to be 400, which was
    // comfortably ahead of the reuse penalty it shared the formula with - and is
    // not ahead of the realm terms below, which pushed a Paladin into the last two
    // stages the moment the Rogue shelf started repeating itself. Those two stages
    // are the Rogue leg of Telahair's story; variety is never worth breaking them.
    (entry.mobClass === desiredClass ? 0 : 2_500) +
    rankIndex * 120 +
    bandMiss * 6 +
    realmInStage * 55 +
    realmOnTour * 12 +
    (context.usedGlobally.has(entry.entName) ? 260 : 0) +
    // Bigger than every other term put together, so a stage ends on a face the
    // tour has not ended on before whenever one is left - but a penalty rather
    // than a bar, because there are fewer Dread Rogue mini-bosses than boss cues.
    (bossSlot && context.usedAsBoss.has(entry.entName) ? 5_000 : 0)
  );
}

function pick(
  pool: PoolEntry[],
  desiredClass: MobClass,
  desiredRank: MobRank,
  plan: StageEnemyPlan,
  context: AssignmentContext,
  usedInStage: Set<string>,
  reservedBaseNames: Set<string>,
  bossSlot: boolean,
  bossDisplayNamesInStage: Set<string>,
  realmsInStage: Map<string, number>,
): PoolEntry {
  let best: PoolEntry | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const entry of pool) {
    const score = scoreCandidate(entry, desiredClass, desiredRank, plan, context, usedInStage, reservedBaseNames, bossSlot, bossDisplayNamesInStage, realmsInStage);
    if (score < bestScore) {
      best = entry;
      bestScore = score;
    }
  }

  if (!best) throw new SwfLevelError(`no Dread ${desiredClass} ${desiredRank} left to place`);
  return best;
}

export interface EnemyAssignment {
  /**
   * `ac_<old>` -> `ac_<new base name>`, ready for the ABC string pool. The target
   * carries no `Hard`; the level's Dread mode is what adds it at runtime.
   */
  renames: Map<string, string>;
  /**
   * The roster, in placement order, for the dungeon entry screen and the diff.
   * `to` is the *Dread* name, because that is what the client reports and what
   * every server-side lookup - bosses, catalogs, elements - is keyed on.
   */
  roster: Array<{
    from: string;
    to: string;
    displayName: string;
    mobClass: MobClass;
    rank: MobRank;
    level: number;
    /**
     * Whether this row filled the room's *boss* cue. Not the same question as
     * `rank === "Boss"` any more: the stages end on mini-bosses, and the boss
     * plate has to follow the cue rather than the rank.
     */
    bossSlot: boolean;
  }>;
  /** What the stage's boss became, in its Dread name. The portal watches for these. */
  bosses: string[];
}

/**
 * Repopulates one stage.
 *
 * Bosses are assigned first - from `plan.bossOverrides` where the stage names its
 * guardians, and otherwise out of the class the stage was planned around, so the
 * fight at the end is the one the stage is named for rather than whatever the
 * weight cycle happened to land on. Everything else is walked in the SWF's own
 * export order - stable, and unrelated to how the rooms are laid out, so the
 * weights spread across the whole dungeon instead of filling room 1 with Rogues.
 *
 * Doing the bosses first also matters to the realm terms in `scoreCandidate`: the
 * guardian's own silhouette is counted before the stage's rank and file is filled,
 * so a hold ending on a Skeleton is a little less likely to be full of them.
 */
export function assignStageEnemies(
  cues: EnemyCue[],
  plan: StageEnemyPlan,
  pool: PoolEntry[],
  context: AssignmentContext,
  /** Every `ac_` name the stage already exports, so a rename cannot collide. */
  reservedBaseNames: Set<string>,
): EnemyAssignment {
  const renames = new Map<string, string>();
  const roster: EnemyAssignment["roster"] = [];
  const bosses: string[] = [];
  const usedInStage = new Set<string>();
  const bossDisplayNamesInStage = new Set<string>();
  /** Bodies already standing in this stage, by realm. See `scoreCandidate`. */
  const realmsInStage = new Map<string, number>();

  const place = (cue: EnemyCue, entry: PoolEntry): void => {
    const bossSlot = cue.rank === "Boss";
    usedInStage.add(entry.entName);
    context.usedGlobally.add(entry.entName);
    if (entry.realm) {
      realmsInStage.set(entry.realm, (realmsInStage.get(entry.realm) ?? 0) + 1);
      context.realmsUsedGlobally.set(entry.realm, (context.realmsUsedGlobally.get(entry.realm) ?? 0) + 1);
    }
    if (bossSlot) {
      context.usedAsBoss.add(entry.entName);
      bossDisplayNamesInStage.add(entry.displayName);
    }
    renames.set(cue.className, `ac_${entry.baseEntName}`);
    roster.push({
      from: cue.entName,
      to: entry.entName,
      displayName: entry.displayName,
      mobClass: entry.mobClass,
      rank: entry.rank,
      level: entry.level,
      bossSlot,
    });
    if (bossSlot) bosses.push(entry.entName);
  };

  const take = (cue: EnemyCue, desiredClass: MobClass, desiredRank: MobRank): void => {
    const bossSlot = cue.rank === "Boss";
    place(
      cue,
      pick(
        pool,
        desiredClass,
        desiredRank,
        plan,
        context,
        usedInStage,
        reservedBaseNames,
        bossSlot,
        bossDisplayNamesInStage,
        realmsInStage,
      ),
    );
  };

  let bossIndex = 0;
  for (const cue of cues) {
    if (cue.rank !== "Boss") continue;
    const override = plan.bossOverrides?.[bossIndex];
    bossIndex += 1;
    if (override) place(cue, override);
    else take(cue, plan.bossClass, plan.bossRank ?? "Boss");
  }

  let weightIndex = 0;
  for (const cue of cues) {
    if (cue.rank === "Boss") continue;
    const rank = plan.rankPlan?.length
      ? plan.rankPlan[weightIndex % plan.rankPlan.length]
      : cue.rank;
    take(cue, plan.classWeights[weightIndex % plan.classWeights.length], rank);
    weightIndex += 1;
  }

  return { renames, roster, bosses };
}
