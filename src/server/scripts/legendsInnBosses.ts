/**
 * The nine guardians Legends' Inn ends its stages on.
 *
 * Every stage used to end on whichever Dread Rogue mini-boss the roster roll
 * happened to reach, which had three consequences the dungeon could not carry:
 *
 *   - **They died like mini-bosses**, because that is what they were. A MiniBoss
 *     EntType carries `HitPoints` 2 against a Boss's 3, and at the top of the
 *     hostile health table that is a fight that ends before it starts.
 *   - **They fought like whatever they were borrowed from.** `ScarabRogueHard`
 *     brings Shazari's four powers with it; the thing at the end of a Legends' Inn
 *     stage should fight with a Rogue's whole book.
 *   - **They repeated.** There are eight Dread Rogue mini-bosses in the game and
 *     ten boss cues across the nine stages, so three stages ended on a face - and a
 *     health-bar caption - the tour had already used.
 *
 * So the boss slots no longer come out of the roster at all. Each one is its own
 * EntType, minted by `patch_swz_legends_inn_bosses.ts`, and this table is the one
 * description of it: which shipped body it wears, what it is called, how much
 * health it has and what it fights with. The SWF build renames the stage's boss
 * cue onto it (`ac_LegendsInnBoss<key>`), the patch script writes the EntType, and
 * `core/LegendsInnDialogue.ts` gives the same guardian its half of the story.
 *
 * ## Why a body rather than new artwork
 *
 * The same reason the rest of the bestiary is a rename: an EntType whose `parent`
 * chain reaches `RogueBase` is drawn on the player skeleton every client already
 * has loaded. Inheriting from a shipped Dread Rogue brings its artwork, its realm,
 * its sounds and its proportions across untouched, and leaves only the four things
 * this table actually wants to change.
 *
 * Bodies are picked for *variety* first: ten slots across eight realms - Wolf,
 * Skeleton, Human, Scarab, Spirit, Imperial, Shade, Demon - so no two holds in a
 * row are guarded by the same-looking thing. The Human repeats are deliberate:
 * Bridgetown's pair are the twins who held Telahair down and are meant to look like
 * brothers, and Cemetery Hill's is his own captain.
 *
 * Every body here has `Behavior Basic`, and that is a requirement rather than a
 * coincidence. The two `Revivable` bandits would have made better-looking twins and
 * cannot be used: a guardian that stands back up never finishes dying, and the exit
 * portal is opened by the boss's *body being removed* (see `core/LegendsInn.ts`).
 */

/** The rogue power book a Legends' Inn guardian fights with. */
export interface LegendsInnBoss {
  /** Stage, 1-based. Two entries share stage 3 - Bridgetown places two boss cues. */
  stage: number;
  /**
   * Suffix of the EntType and of the cue class: `LegendsInnBoss<key>`.
   *
   * The stage number, with a letter for a stage that ends on more than one, so
   * the names stay readable in a SymbolClass dump and in the stage data file.
   */
  key: string;
  /** The shipped Dread Rogue whose body, realm and sounds it wears. */
  body: string;
  /** What its health bar says. Not a Dread-prefixed borrowed name any more. */
  displayName: string;
}

/**
 * The rogue abilities a guardian carries.
 *
 * The player's Rogue book, minus abilities 4, 5 and 6 - Enfeeble, Root Strike and
 * Steel Cyclone - which are the discipline picks and belong to the player's own
 * build rather than to a monster. Everything else the class has is here, in its
 * monster form:
 *
 *   1 Stun Strike   -> HumanMaceStrike     (cast sound: snd_pwr_rogue_openStun_*)
 *   2 Poison Strike -> HumanPoisonStrike    (snd_pwr_rogue_openDot_*)
 *   3 Quick Strike  -> HumanQuickStrike     (anim SaberUber)
 *   7 Hawk Strike   -> HumanHawkStrike      (snd_pwr_rogue_hawkAttack_*)
 *   8 Decoy         -> HumanStealth         (snd_pwr_rogue_stealth)
 *
 * plus the two ordinary rogue strikes the shipped human rogues open with, so a
 * guardian still has something to do while the book is on cooldown.
 *
 * Every one of these is a *rogue* power, and the sounds and cast animations above
 * are how each was identified rather than the name. `HumanStaggerStrike` looks like
 * the obvious Stun Strike and is not one: it animates `ShieldUber1` and shouts
 * `snd_pwr_paladin_shieldstun`, so a guardian casting it would raise a shield it is
 * not holding. The excluded three are rogue powers too - `HumanEnfeebleStrike`,
 * `HumanSnare` and `HumanCyclone` - and are excluded on the brief, not on fit.
 *
 * Nothing else in the game carries this set: it exists on these ten EntTypes and
 * nowhere else, which is what makes it the bosses' own.
 */
export const LEGENDS_INN_BOSS_POWERS = [
  "HumanMaceStrike",
  "HumanPoisonStrike",
  "HumanQuickStrike",
  "HumanHawkStrike",
  "HumanStealth",
  "HumanSpinStrike",
  "HumanRapierStrike",
].join(",");

/** The long-reach rogue melee the shipped Dread Rogue mini-bosses swing. */
export const LEGENDS_INN_BOSS_MELEE_POWER = "HumanMeleeLR";

/**
 * How much health a stage's guardian has, as an EntType `HitPoints` multiplier.
 *
 * The client sizes a hostile as `HOSTILE_BASE_HP[Level + mBonusLevels] * HitPoints`
 * and every Legends' Inn hostile is lifted to row 50, so this multiplier is the
 * whole of the difference between one guardian and the next. Six at Wolf's End
 * rising to fourteen at Valhaven: twice the sturdiest boss the game shipped at the
 * start of the road, and a real wall at the end of it, with the climb spread evenly
 * so a party can feel the road getting harder rather than hitting one step.
 *
 * The mini-bosses these replaced were on 2.
 */
export function getBossHitPoints(stage: number): number {
  return 6 + Math.max(0, Math.min(8, Math.round(Number(stage) || 1) - 1));
}

/** The ten slots, in the order the road runs. */
export const LEGENDS_INN_BOSSES: LegendsInnBoss[] = [
  { stage: 1, key: "1", body: "JackalChieftainHard", displayName: "Vehr the Courier" },
  { stage: 2, key: "2", body: "GreaterSkeletonRogueHard", displayName: "Osk the Witness" },
  { stage: 3, key: "3A", body: "BanditTwinAHard", displayName: "Sarn, the Left Hand" },
  { stage: 3, key: "3B", body: "BanditTwinBHard", displayName: "Vael, the Right Hand" },
  { stage: 4, key: "4", body: "MeylourEnthralledRogueHard", displayName: "Elsyn the Bought" },
  { stage: 5, key: "5", body: "ScarabRogueHard", displayName: "Karrog the Forgemaster" },
  { stage: 6, key: "6", body: "SpiritJackalRogueHard", displayName: "Ysel the Keeper" },
  { stage: 7, key: "7", body: "TowerGuard2Hard", displayName: "Arden Hollowhelm" },
  { stage: 8, key: "8", body: "DemonMalignerHard", displayName: "Nekhet the Warden" },
  { stage: 9, key: "9", body: "GreaterDemonMalignerHard", displayName: "Maugrim, the Last Lock" },
];

/** The EntType a guardian is, without the `Hard` a Dread level appends itself. */
export function bossEntName(boss: LegendsInnBoss): string {
  return `LegendsInnBoss${boss.key}`;
}

/** The guardians a stage ends on, in the order its boss cues are exported. */
export function bossesForStage(stage: number): LegendsInnBoss[] {
  return LEGENDS_INN_BOSSES.filter((boss) => boss.stage === stage);
}
