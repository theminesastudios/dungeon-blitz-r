import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

/**
 * Paladin mastery retune -- Templar mostly, with the Justicar and Sentinel items that
 * turned out to be expressible in data.
 *
 * Screen names and data names disagree here the same way they do for the Rogue, so for the
 * record: Hallowed Reckoning is FountainOfLife, Sacred Light is CleansingLight, Empyrean
 * Aura is LeoneanAura, Meteor Smash is LeapStrike, and Midnight Shroud (Rogue, mentioned
 * only because it comes up in the same request) is ShadowArmor. Getting one of those wrong
 * retunes a different class's skill.
 *
 * Templar:
 *   Subjugate          rank 4 blinds instead of a second Cripple, rank 7 adds Armor Bane,
 *                      rank 10 goes back to a Cripple stack on top of both
 *   Divine Word        carries Holy Fire from rank 3, scaling with rank
 *   Penance            blinds from rank 4
 *   Hallowed Reckoning Holy Fire on the half that hits enemies, faster windup at rank 7,
 *                      -5 mana at rank 10
 *   Celestial Lance    the lance itself splashes from rank 6
 *   Verdict            every shot blinds, ranks 9 and 10 return mana per shot and the
 *                      stance lasts longer
 *   Sanctum            the enemy-side pulse adds Holy Fire
 *   Empyrean Aura      the boost outlives the channel -- 8 seconds at rank 10
 *
 * Justicar:
 *   Lightning Bomb     the bomb you never reach is folded into the opening stab, and the
 *                      stab lands two stacks of Armor Bane. The spread chain is gone -- one
 *                      bomb, and its blast Ignites twice and shreds Armor
 *
 * Sentinel:
 *   Sentinel Form      more damage at every rank, and ranks 1-3 get a damage bonus at all
 *
 * Templar base attacks:
 *   Cleave             rank 10 hits for what Skewer rank 10 totals
 *   Smash              rank 10 hits for what Skewer rank 10 totals, split over its two
 *                      blows; the second blow shreds Armor at every rank; faster from rank 7
 *   Warcry             30 mana -> 25
 *   Shockwave          +20% damage at every rank
 *
 * Talentstones:
 *   Daybreak           blind duration    .1/.2/.3/.5/.75  -> .1/.25/.5/.75/1
 *   Blinding Light     blind miss chance 1-5%             -> 2-10%
 *   Clutch Heal        healing boost     1-5%             -> 2-10%
 *   Fortify            repurposed: Holy Fire damage 5/10/15/20/25%
 *   Rapid Recovery     repurposed: Holy Fire damage 5/10/15/20/25%
 *   Sanctify           repurposed: a percent of Expertise becomes Defense, 1-5%
 *   Heavy Blows        crit damage       1/2/4/7/10%      -> 2/5/8/11/15%
 *   Immolation         Ignite damage     1/2/3/5/8%       -> 2/4/6/10/16%
 *   Taunt -> Taunter   keeps its Hate, and gains 1-5% attack speed (the attack speed half is
 *                      bytecode -- patch-dungeonblitz-templar-talent-effects)
 *   Dominate           repurposed: damage against Demoralized/Staggered/Stunned targets,
 *                      10-50%, doubled to at most +100% on Staggered or Stunned (bytecode)
 *   Pain Eater         the 5-second proc now grants Defense as well, on the same
 *                      1/2/4/6/10% curve its attack speed already uses
 *
 * Why several asked-for items are not here, so they are not looked for and assumed broken:
 *
 *   Sacred Light's party recovery bonus. A BuffType has no Recovery field -- the whole set
 *   is AggroChange/DoTDamage/Duration/MagicDamage/MagicDefense/MeleeDamage/MeleeDefense/
 *   SpeedChange/StackCount and the override slots. Recovery exists only as a talentstone
 *   StatProperty, which applies to its owner, never to a party. There is no data shape that
 *   hands a party a recovery bonus.
 *
 *   Clutch Heal's 20% -> 30% threshold, and Pain Eater's defense boost. Both mods are
 *   ModType "WTF", which is the file's own word for "the client hardcodes this" -- the XML
 *   carries a single SelfValue and nothing else. The magnitude is data and is retuned here;
 *   the threshold and the shape of the effect are bytecode.
 *
 *   Flame Axe priming the next Meteor Smash, either as +30% for 5 seconds or as cooldown
 *   taken off. Neither exists in data: a buff cannot name the powers it boosts, and nothing
 *   in PlayerPowerTypes reduces another power's cooldown on hit.
 *
 *   Verdict rank 10's attack speed stacking while undisturbed, Sentinel crit scaled off
 *   defense, Retribution reflecting crits, and a longer Sentinel Form. Sentinel Form's buff
 *   authors Duration 0 -- the timer is not in the data at all.
 *
 * Absolute values throughout, because this runs on every prebuild and a multiplier would
 * compound on the second pass. The comment on each row is the authored value it replaces.
 */

type PatchStats = {
  powerBlocks: number;
  buffBlocks: number;
  modBlocks: number;
  changes: number;
};

const EMPTY_STATS: PatchStats = { powerBlocks: 0, buffBlocks: 0, modBlocks: 0, changes: 0 };

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
const POWER_XML = path.join(XML_DIR, "PlayerPowerTypes.xml");
const BUFF_XML = path.join(XML_DIR, "PlayerBuffTypes.xml");
const MOD_XML = path.join(XML_DIR, "PowerModTypes.xml");

/**
 * AddTargetBuff, absolute. Holy Fire is ranked (HolyFire1..5, 1.0 to 2.5 damage a tick) so
 * the rank a power hands out climbs with the power's own rank rather than being flat.
 */
const TARGET_BUFFS = new Map<string, string>([
  // Subjugate -- rank 4 trades its second Cripple for a Blind, rank 7 adds Armor Bane,
  // rank 10 puts the Cripple stack back on top.
  ["Subjugate4", "Crippled,Blinded"], // was Crippled,Crippled
  ["Subjugate5", "Crippled,Blinded"], // was Crippled,Crippled
  ["Subjugate6", "Crippled,Blinded"], // was Crippled,Crippled
  ["Subjugate7", "Crippled,Blinded,ArmorBane"], // was Crippled,Crippled,Crippled
  ["Subjugate8", "Crippled,Blinded,ArmorBane"], // was Crippled,Crippled,Crippled
  ["Subjugate9", "Crippled,Blinded,ArmorBane"], // was Crippled,Crippled,Crippled
  ["Subjugate10", "Crippled,Crippled,Blinded,ArmorBane"], // was Crippled,Crippled,Crippled,Blinded
  // Divine Word -- Holy Fire from rank 3.
  ["DivineWord3", "Weakened,HolyFire1"], // was Weakened
  ["DivineWord4", "Weakened,HolyFire1"], // was Weakened
  ["DivineWord5", "Weakened,HolyFire1"], // was Weakened
  ["DivineWord6", "Weakened,HolyFire1"], // was Weakened
  ["DivineWord7", "Weakened,HolyFire2"], // was Weakened
  ["DivineWord8", "Weakened,Weakened,HolyFire2"], // was Weakened,Weakened
  ["DivineWord9", "Weakened,Weakened,HolyFire2"], // was Weakened,Weakened
  ["DivineWord10", "Weakened,Weakened,HolyFire3"], // was Weakened,Weakened
  // Penance -- blinds from rank 4.
  ["Penance4", "Penance6,Staggered,Blinded"], // was Penance6,Staggered
  ["Penance5", "Penance9,Staggered,Blinded"], // was Penance9,Staggered
  ["Penance6", "Penance9,Staggered,Blinded"], // was Penance9,Staggered
  ["Penance7", "Penance9,Staggered,Blinded"], // was Penance9,Staggered
  ["Penance8", "Penance12,Staggered,Blinded"], // was Penance12,Staggered
  ["Penance9", "Penance12,Staggered,Blinded"], // was Penance12,Staggered
  ["Penance10", "Penance15,Staggered,Blinded"], // was Penance15,Staggered
  // Hallowed Reckoning. The ranked FountainOfLife blocks are AuraFriend and heal the party,
  // so Holy Fire on those would burn teammates. FountainOfLifeCombo is the same power's
  // enemy-facing half -- TargetMethod Aura with a positive BaseDamageMult -- and is the only
  // correct place for it.
  ["FountainOfLifeCombo4", "HolyFire1"], // was absent
  ["FountainOfLifeCombo5", "HolyFire1"], // was absent
  ["FountainOfLifeCombo6", "HolyFire1"], // was absent
  ["FountainOfLifeCombo7", "HolyFire2"], // was absent
  ["FountainOfLifeCombo8", "HolyFire2"], // was absent
  ["FountainOfLifeCombo9", "HolyFire2"], // was absent
  ["FountainOfLifeCombo10", "HolyFire3"], // was absent
  // Sanctum. Same split: Sanctum1..10 are RangedAoEFriend heals, SanctumCombo is the pulse
  // that hits enemies. It has no ranks, so this is not rank-gated the way rank 4 was asked
  // for -- there is no rank to gate it on.
  ["SanctumCombo", "Blinded,HolyFire3"], // was Blinded
  // Verdict -- every shot blinds.
  ["VerdictROR1", "Blinded"], // was absent
  ["VerdictROR2", "Blinded"], // was absent
  ["VerdictROR3", "Blinded"], // was absent
  ["VerdictROR4", "Blinded"], // was absent
  ["VerdictROR5", "Blinded"], // was absent
  ["VerdictROR6", "Blinded"], // was absent
  ["VerdictROR7", "Blinded"], // was absent
  ["VerdictROR8", "Blinded"], // was absent
  ["VerdictROR9", "Blinded"], // was absent
  ["VerdictROR10", "Blinded"], // was absent
  // Lightning Bomb -- the opening stab carries the Armor Bane.
  ["LightningBomb", "LightningBomb,ArmorBane,ArmorBane"], // was LightningBomb
  ["LightningBomb1", "LightningBomb,ArmorBane,ArmorBane"], // was LightningBomb
  ["LightningBomb2", "LightningBomb,ArmorBane,ArmorBane"], // was LightningBomb
  ["LightningBomb3", "LightningBomb,ArmorBane,ArmorBane"], // was LightningBomb
  ["LightningBomb4", "LightningBomb,ArmorBane,ArmorBane"], // was LightningBomb
  ["LightningBomb5", "LightningBomb,ArmorBane,ArmorBane"], // was LightningBomb
  ["LightningBomb6", "LightningBomb,ArmorBane,ArmorBane"], // was LightningBomb
  ["LightningBomb7", "LightningBomb,ArmorBane,ArmorBane"], // was LightningBomb
  ["LightningBomb8", "LightningBomb,ArmorBane,ArmorBane"], // was LightningBomb
  ["LightningBomb9", "LightningBomb,ArmorBane,ArmorBane"], // was LightningBomb
  ["LightningBomb10", "LightningBomb,ArmorBane,ArmorBane"], // was LightningBomb
  /**
   * The bomb itself. Dropping the LightningBomb buff from the explosion is what ends the
   * spread chain -- that buff *is* the bomb, and handing it to the first enemy caught in the
   * blast is how the affliction hopped from corpse to corpse. One bomb now, which is the
   * half of the ask that is expressible here; what the blast leaves behind is the other half.
   *
   * "FirstTarget:" went with it. The prefix is a whole-list flag, so keeping it would have
   * limited the Ignite and Armor Bane to one enemy in the blast rather than all of them.
   */
  ["LightningBombExplode", "Ignite,Ignite,ArmorBane"], // was LightningBomb
  ["LightningBombExplode1", "Ignite,Ignite,ArmorBane"], // was FirstTarget:LightningBomb
  ["LightningBombExplode2", "Ignite,Ignite,ArmorBane"], // was FirstTarget:LightningBomb
  ["LightningBombExplode3", "Ignite,Ignite,ArmorBane"], // was FirstTarget:LightningBomb
  ["LightningBombExplode4", "Ignite,Ignite,ArmorBane"], // was FirstTarget:LightningBomb
  ["LightningBombExplode5", "Ignite,Ignite,ArmorBane"], // was FirstTarget:LightningBomb
  ["LightningBombExplode6", "Ignite,Ignite,ArmorBane"], // was FirstTarget:LightningBomb
  ["LightningBombExplode7", "Ignite,Ignite,ArmorBane"], // was FirstTarget:LightningBomb
  ["LightningBombExplode8", "Ignite,Ignite,ArmorBane"], // was FirstTarget:LightningBomb
  ["LightningBombExplode9", "Ignite,Ignite,ArmorBane"], // was FirstTarget:LightningBomb
  ["LightningBombExplode10", "Ignite,Ignite,ArmorBane"], // was FirstTarget:LightningBomb
  /**
   * Smash's second blow shreds Armor. "Last:" keys off the CastTime step index, and Smash
   * authors two steps at every rank, so this is the second swing and nothing else -- the
   * prefix applies to the whole list, which is why the list is only ever the Armor Bane.
   */
  ["Smash", "Last:ArmorBane"], // was absent
  ["Smash1", "Last:ArmorBane"], // was absent
  ["Smash2", "Last:ArmorBane"], // was absent
  ["Smash3", "Last:ArmorBane"], // was absent
  ["Smash4", "Last:ArmorBane"], // was absent
  ["Smash5", "Last:ArmorBane"], // was absent
  ["Smash6", "Last:ArmorBane"], // was absent
  ["Smash7", "Last:ArmorBane"], // was absent
  ["Smash8", "Last:ArmorBane"], // was absent
  ["Smash9", "Last:ArmorBane"], // was absent
  ["Smash10", "Last:ArmorBane"], // was absent
]);

/**
 * Lightning Bomb's spread chain is a minigame the player loses: the second bomb rarely gets
 * reached, so its damage is folded into the stab that always lands. Each value is the
 * authored stab plus that rank's own LightningBombExplodeTwo multiplier.
 *
 * ponytail: the fold double-counts on the rare cast where the chain does reach the second
 * bomb. Making it exclusive needs the spread counter, which is bytecode -- drop these rows
 * back to the authored values if that ever gets threaded through.
 */
const DAMAGE_MULTS = new Map<string, string>([
  ["LightningBomb", "2.03"], // 1     + 1.034
  ["LightningBomb1", "3.68"], // 2.18 + 1.5
  ["LightningBomb2", "3.9"], //  2.4  + 1.5
  ["LightningBomb3", "3.9"], //  2.4  + 1.5
  ["LightningBomb4", "4"], //    2.4  + 1.6
  ["LightningBomb5", "4"], //    2.4  + 1.6
  ["LightningBomb6", "4.36"], // 2.76 + 1.6
  ["LightningBomb7", "4.77"], // 2.97 + 1.8
  ["LightningBomb8", "4.87"], // 2.97 + 1.9
  ["LightningBomb9", "4.97"], // 2.97 + 2
  ["LightningBomb10", "4.97"], // 2.97 + 2
  /**
   * Cleave and Smash brought up to Skewer at rank 10.
   *
   * "Same damage" is per cast, not per authored number, and the three powers count hits
   * differently -- so the numbers below are not equal to each other and that is the point.
   * BaseDamageMult is a per-step list: CombatState reads var_630[step] and falls back to
   * var_630[0], so a single value on a multi-step power is charged once per step.
   *
   *   Skewer 10   1.42,1.92,2.42 over three steps  -> 5.76 a cast
   *   Cleave 10   one value, and Cleave is one of the target methods that carries a
   *               hit-once dictionary, so an enemy takes it exactly once -> 5.76
   *   Smash 10    one value over two steps, Melee, no dictionary, so both blows land
   *               -> split as 2.88,2.88 for 5.76
   *
   * Smash's split is also what makes its own tooltip honest: a two-entry list is what the
   * second blow's Armor Bane is keyed against, and x2 damage printed against a power that
   * swung twice was already understating it.
   */
  ["Cleave10", "5.76"], // 2.42
  ["Smash10", "2.88,2.88"], // 2
  // Shockwave, +20% at every rank. Absolute, so a second prebuild does not compound it.
  ["Shockwave", "0.8"], //   0.67
  ["Shockwave1", "0.9"], //  0.75
  ["Shockwave2", "1.02"], // 0.85
  ["Shockwave3", "1.02"], // 0.85
  ["Shockwave4", "1.2"], //  1
  ["Shockwave5", "1.2"], //  1
  ["Shockwave6", "1.32"], // 1.1
  ["Shockwave7", "1.32"], // 1.1
  ["Shockwave8", "1.32"], // 1.1
  ["Shockwave9", "1.38"], // 1.15
  ["Shockwave10", "1.45"], // 1.21
]);

/**
 * Celestial Lance already authors an AoERadius on a RangedStrike, so the splash is real and
 * only ever needed widening. Changing TargetMethod would have thrown away the lance's own
 * targeting and its projectile art with it.
 */
const AOE_RADII = new Map<string, string>([
  ["CelestialLance6", "250"], // 100
  ["CelestialLance7", "250"], // 100
  ["CelestialLance8", "250"], // 100
  ["CelestialLance9", "250"], // 100
  ["CelestialLance10", "250"], // 100
]);

// Hallowed Reckoning's rank 7 "faster cast animation": only the windup step moves, the three
// 1000ms heal ticks after it are the heal itself and shortening those would cut the healing.
const CAST_TIMES = new Map<string, string>([
  ["FountainOfLife7", "500,1000,1000,1000"], // 790,1000,1000,1000
  ["FountainOfLife8", "500,1000,1000,1000"], // 790,1000,1000,1000
  ["FountainOfLife9", "500,1000,1000,1000"], // 790,1000,1000,1000
  ["FountainOfLife10", "500,1000,1000,1000"], // 790,1000,1000,1000
  ["FountainOfLifeCombo7", "505,1000,1000,1000"], // 795,1000,1000,1000
  ["FountainOfLifeCombo8", "505,1000,1000,1000"], // 795,1000,1000,1000
  ["FountainOfLifeCombo9", "505,1000,1000,1000"], // 795,1000,1000,1000
  ["FountainOfLifeCombo10", "505,1000,1000,1000"], // 795,1000,1000,1000
  // Smash swings faster from rank 7. Both steps move, because both are windup for a blow --
  // unlike Hallowed Reckoning there is no heal tick hiding in the list to protect.
  ["Smash7", "400,350"], // 550,450
  ["Smash8", "400,350"], // 550,450
  ["Smash9", "400,350"], // 550,450
  ["Smash10", "400,350"], // 550,450
]);

/**
 * "X,Y" is cost-then-restore: the power charges X and gives Y back, which is how DivineBolt
 * authors its 0,5. PowerType parses exactly two scalars -- manaCost = uint(parts[0]) and the
 * restore = uint(parts[1]) -- so this is not a per-step list the way CastTime is, and uint
 * means a negative restore is not expressible either.
 *
 * The restore lands once per swing, not once per enemy: CombatState gates it on param5,
 * which the caller passes as `_loc13_ == 1`, the first target of the swing. So an AoE cleave
 * that catches five enemies still returns the value once.
 *
 * Verdict's shots cost nothing already, so 0,2 is purely the two mana a shot that rank 9 was
 * asked for -- on the melee override too, since Verdict replaces both attacks while the
 * stance is up.
 *
 * ponytail: Cleaving Blows was asked for as 5 mana on every *second* swing, and the second
 * swing is a real addressable thing here -- MeleeAoE authors CastTime 330,410 with a sound
 * cue at each, and "Last:Ignite" is exactly "second swing only" (rank 5 drops the Last: for
 * its "Ignites on both hits" upgrade). ManaCost has no such prefix, so the restore fires on
 * both swings and the per-swing number carries the whole cadence instead: 3 a swing, 6 over
 * the pair, against the 5 that was asked for. Step-indexed mana needs the same var_54 plumbing
 * that AddTargetBuff already has, which is bytecode. Change these to 0,5 for a flat 5 a swing
 * (10 over the pair) if the sustain should be the headline instead.
 */
const MANA_COSTS = new Map<string, string>([
  ["FountainOfLife10", "25"], // 30
  ["VerdictROR9", "0,2"], // 0
  ["VerdictROR10", "0,2"], // 0
  ["VerdictMelee9", "0,2"], // 0
  ["VerdictMelee10", "0,2"], // 0
  /**
   * Sentinel Form lasts longer -- and "longer" turned out to be a data question after all.
   * The form authors Duration 0 on its buff because it is not on a timer at all: CombatState
   * drops it when the next attack costs more mana than the Sentinel has left, so its length
   * is exactly how far a mana bar stretches at 4-7 a swing. Cutting the per-attack cost by
   * roughly a third is the duration increase.
   *
   * The damage half of the same ask is already paid for by the form's own buff, which now
   * grants 10-20% Melee and Magic damage where ranks 1-3 granted nothing (SENTINEL_FORM_DAMAGE
   * below). That bonus multiplies these attacks, so raising the multipliers here as well would
   * be counting it twice.
   *
   * Only ranks 1/2/3/6/8/9/10 exist -- the others reuse the rank below.
   */
  ["SFMelee1", "5"], // 7
  ["SFMelee2", "5"], // 7
  ["SFMelee3", "4"], // 5
  ["SFMelee6", "4"], // 5
  ["SFMelee8", "3"], // 4
  ["SFMelee9", "3"], // 4
  ["SFMelee10", "3"], // 4
  ["SFMeleeCombo1", "5"], // 7
  ["SFMeleeCombo2", "5"], // 7
  ["SFMeleeCombo3", "4"], // 5
  ["SFMeleeCombo6", "4"], // 5
  ["SFMeleeCombo8", "3"], // 4
  ["SFMeleeCombo9", "3"], // 4
  ["SFMeleeCombo10", "3"], // 4
  ["SFRanged1", "5"], // 7
  ["SFRanged2", "5"], // 7
  ["SFRanged3", "4"], // 5
  ["SFRanged6", "4"], // 5
  ["SFRanged8", "3"], // 4
  ["SFRanged9", "3"], // 4
  ["SFRanged10", "3"], // 4
  // Cleaving Blows, from rank 2. The mana rides MeleeAoE, not CleavingBlows: the
  // CleavingBlows blocks are a Self cast with BaseDamageMult 0 that only hangs the
  // MeleeAoE* buff, and the buff's MeleeOverride is what actually swings.
  ["MeleeAoE2", "0,5"], // 0
  ["MeleeAoE3", "0,5"], // 0
  ["MeleeAoE4", "0,5"], // 0
  ["MeleeAoE5", "0,5"], // 0
  ["MeleeAoE6", "0,5"], // 0
  ["MeleeAoE7", "0,5"], // 0
  ["MeleeAoE8", "0,5"], // 0
  ["MeleeAoE9", "0,5"], // 0
  ["MeleeAoE10", "0,5"], // 0
  // Warcry, every rank. The unranked block is the pre-talent version and moves with them.
  ["Warcry", "25"], // 30
  ["Warcry1", "25"], // 30
  ["Warcry2", "25"], // 30
  ["Warcry3", "25"], // 30
  ["Warcry4", "25"], // 30
  ["Warcry5", "25"], // 30
  ["Warcry6", "25"], // 30
  ["Warcry7", "25"], // 30
  ["Warcry8", "25"], // 30
  ["Warcry9", "25"], // 30
  ["Warcry10", "25"], // 30
]);

// Rank upgrade text has to move with the effect or it starts lying.
/**
 * Power text that has to move a second time, after an earlier run already rewrote it. Runs
 * before DESCRIPTIONS and UPGRADE_TEXT, whose anchors are substrings of the sentence being
 * replaced -- without this the old sentence survives and the new one lands beside it.
 */
const POWER_TEXT_MIGRATIONS: Array<{ power: RegExp; from: string; to: string }> = [
  { power: /^CleavingBlows\d*$/, from: "Your swings return 3 Mana each.", to: "Your swings return 5 Mana each." },
  /**
   * The four sentences the spread chain left behind -- each Lightning Bomb rank band authored
   * its own wording for it. They live here rather than in DESCRIPTIONS because that map is
   * keyed by power name and holds one pair per power, so four replacements against the same
   * rank would overwrite each other and only the last would ever land.
   */
  ...(
    [
      "Spreads a similar effect to damaged enemies.",
      "Bomb effect spreads to one affected target.",
      "Bomb effect can spread three times",
      "Bomb effect can spread twice",
    ].map((from) => ({
      power: /^LightningBomb\d*$/,
      from,
      to: "The blast leaves 2 stacks of Ignite and Armor Bane on everything caught in it.",
    }))
  ),
];

for (const migration of POWER_TEXT_MIGRATIONS) {
  if (migration.to.includes(migration.from)) {
    throw new Error(`POWER_TEXT_MIGRATIONS entry for ${migration.power} would re-apply forever.`);
  }
}

const UPGRADE_TEXT = new Map<string, [string, string]>([
  ["Subjugate4", ["Adds a stack of Cripple.", "Adds Blind."]],
  ["Subjugate7", ["Adds a stack of Cripple.", "Adds a stack of Armor Bane."]],
  ["Subjugate10", ["Adds Blind", "Adds a stack of Cripple."]],
  ["DivineWord3", ["Increased Damage #olddmg#", "Adds a stack of Holy Fire."]],
  ["Penance4", ["Increased Damage #olddmg#", "Adds Blind. Increased Damage #olddmg#"]],
  ["FountainOfLife4", ["Increased Damage #olddmg#. 460% Heal over 4 sec.", "Adds a stack of Holy Fire. 460% Heal over 4 sec."]],
  ["FountainOfLife7", ["Increased Damage #olddmg#. 530% Heal over 4 sec.", "Faster cast animation. 530% Heal over 4 sec."]],
  ["FountainOfLife10", ["Increased Damage #olddmg#. 600% Heal over 4 sec.", "-5 Mana Cost. 600% Heal over 4 sec."]],
  ["CelestialLance6", ["Increased Holy Fire Damage", "The Lance now strikes every enemy around its target."]],
  ["Verdict9", ["+30% Healing per shot", "+30% Healing per shot. Each shot returns 2 Mana."]],
  ["Verdict10", ["+50% Healing per shot", "+50% Healing per shot. +1.5 Second Duration."]],
  ["CleavingBlows2", ["Increased Damage #olddmg#", "Your swings return 5 Mana each. Increased Damage #olddmg#"]],
  ["Smash7", ["Increased Damage #olddmg#", "Faster cast animation. Increased Damage #olddmg#"]],
  /**
   * Lightning Bomb's rank-up text still sold the spread chain that is gone now. Ranks 4 and
   * 7-10 were selling the second bomb's damage as well, which the earlier fold already moved
   * into the stab -- so what every one of them buys now really is just damage.
   */
  ["LightningBomb4", ["Increased Damage to final bomb.", "Increased Damage #olddmg#"]],
  ["LightningBomb5", ["Bomb affliction spreads one additional time.", "Increased Damage #olddmg#"]],
  [
    "LightningBomb7",
    ["Increased Damage to final bomb and Increased Damage to intial attack  #olddmg#", "Increased Damage #olddmg#"],
  ],
  ["LightningBomb8", ["-5 Second Cooldown. Increased Damage to final bomb.", "-5 Second Cooldown."]],
  ["LightningBomb9", ["Increased Damage to final bomb.", "Increased Damage #olddmg#"]],
  ["LightningBomb10", ["Bomb affliction spreads one additional time.", "Increased Damage #olddmg#"]],
]);

/**
 * The prose half of a Description, which patch_gameswz_power_stat_tooltips does not touch --
 * it regenerates the trailing "[Stats: ...]" block and leaves the sentence alone. A power
 * that blinds now and does not say so is a power players will not use.
 *
 * Keyed per rank rather than per family because the lower ranks of these powers are
 * unchanged and their authored sentence is still correct.
 */
/**
 * Description prose, kept to the wording the game already uses for the same effects --
 * "Cripples and Blinds enemies in AoE" is the authored rank-10 Subjugate sentence, and
 * "bathing enemies in the area with Holy Fire" is Celestial Lance's own. Each entry states
 * an effect the power really has; the trailing "[Stats: ...]" block is regenerated by
 * patch_gameswz_power_stat_tooltips and carries the figures.
 */
const DESCRIPTIONS = new Map<string, [string, string]>();

function describeRanks(base: string, from: number, to: number, before: string, after: string): void {
  for (let rank = from; rank <= to; rank += 1) {
    DESCRIPTIONS.set(`${base}${rank}`, [before, after]);
  }
}

// Subjugate blinds from rank 4 and shreds Armor from rank 7. Rank 10 already said "Cripples
// and Blinds", so ranks 4-9 borrow that wording rather than inventing another.
describeRanks("Subjugate", 4, 6,
  "Deals damage and Cripples enemies in AoE",
  "Deals damage, Cripples and Blinds enemies in AoE");
describeRanks("Subjugate", 7, 9,
  "Deals damage and Cripples enemies in AoE",
  "Deals damage, Cripples, Blinds and applies Armor Bane to enemies in AoE");
describeRanks("Subjugate", 10, 10,
  "Deals damage, Cripples and Blinds enemies in AoE",
  "Deals damage, Cripples, Blinds and applies Armor Bane to enemies in AoE");
describeRanks("DivineWord", 3, 10,
  "Grant your allies a small healing surge and Weaken your enemies in an AoE",
  "Grant your allies a small healing surge, Weaken your enemies in an AoE and bathe them in Holy Fire");
describeRanks("Penance", 4, 10,
  "Shake your foes to their core, Staggering them and leaving them vulnerable to subsequent attacks.",
  "Shake your foes to their core, Blinding and Staggering them and leaving them vulnerable to subsequent attacks.");
describeRanks("CelestialLance", 6, 9,
  "Strike a foe with an explosive lance, Staggering and bathing enemies in the area with Holy Fire",
  "Strike every foe around your target with an explosive lance, Staggering and bathing them in Holy Fire");
describeRanks("CelestialLance", 10, 10,
  "Stun a foe with an explosive lance, Staggering and bathing enemies in the area with Holy Fire",
  "Stun your target and strike every foe around it with an explosive lance, Staggering and bathing them in Holy Fire");
describeRanks("Sanctum", 1, 10,
  "Heals allies in an area and Blinds foes",
  "Heals allies in an area, Blinds foes and bathes them in Holy Fire");
describeRanks("Verdict", 1, 10,
  "Your basic attacks channel divine energy, healing allies and harming foes",
  "Your basic attacks channel divine energy, healing allies and harming and Blinding foes");
describeRanks("CleavingBlows", 2, 10,
  "For 5 seconds your basic melee attacks deal AoE damage and Ignite targets.",
  "For 5 seconds your basic melee attacks deal AoE damage, Ignite targets and return Mana.");
describeRanks("LightningBomb", 2, 10,
  "Turns a foe into a Lightning Bomb causing them to explode when killed.",
  "Stab a foe, applying 2 stacks of Armor Bane and turning them into a Lightning Bomb that explodes when killed.");

// Smash's second blow. The unranked block words the same attack differently, so it gets its
// own sentence rather than being folded into the ranked one.
describeRanks("Smash", 1, 10,
  "Deliver a multi-hit melee combo that damages nearby foes",
  "Deliver a multi-hit melee combo that damages nearby foes, the second blow shredding their Armor");
DESCRIPTIONS.set("Smash", [
  "Deliver two bonecrushing blows that total #dmg# damage to every foe within reach of your swing.",
  "Deliver two bonecrushing blows that total #dmg# damage to every foe within reach of your swing, the second shredding their Armor.",
]);


/**
 * Empyrean Aura is a channel that reapplies its buff every 500ms with a 750ms lifetime, so
 * the boost has always died with the channel. Extending the buff instead of the channel is
 * what "increase duration" means to a player: the party keeps the boost after the Templar
 * moves on.
 *
 * Verdict's stance duration rides its own self-buff, which is why rank 10 is here as well.
 */
const BUFF_DURATIONS = new Map<string, string>([
  ["LeoneanAura1", "2000"], // 750
  ["LeoneanAura2", "2000"], // 750
  ["LeoneanAura3", "2000"], // 750
  ["LeoneanAura4", "3000"], // 750
  ["LeoneanAura5", "3000"], // 750
  ["LeoneanAura6", "3000"], // 750
  ["LeoneanAura7", "5000"], // 750
  ["LeoneanAura8", "5000"], // 750
  ["LeoneanAura9", "5000"], // 750
  ["LeoneanAura10", "8000"], // 750
  ["Verdict9", "7000"], // 5500
  ["Verdict10", "7000"], // 5500
]);

// Empyrean Aura's number comes from BUFF_DURATIONS rather than being written twice, so the
// sentence cannot drift away from the value it quotes.
for (let rank = 1; rank <= 10; rank += 1) {
  const seconds = Number(BUFF_DURATIONS.get(`LeoneanAura${rank}`)) / 1000;
  DESCRIPTIONS.set(`LeoneanAura${rank}`, [
    "Attack and Expertise boost.",
    `Attack and Expertise boost. The boost lasts ${seconds} seconds.`,
  ]);
}

/**
 * Sentinel Form's damage bonus. Ranks 1-3 authored none at all, which is why a fresh
 * Sentinel felt like it was trading damage for defense and getting nothing back.
 * MagicDamage moves with MeleeDamage so the form's ranged override scales too.
 */
const SENTINEL_FORM_DAMAGE = new Map<string, string>([
  ["SentinelForm1", "0.1"], // absent
  ["SentinelForm2", "0.1"], // absent
  ["SentinelForm3", "0.1"], // absent
  ["SentinelForm4", "0.15"], // 0.05
  ["SentinelForm5", "0.15"], // 0.05
  ["SentinelForm6", "0.15"], // 0.05
  ["SentinelForm7", "0.2"], // 0.1
  ["SentinelForm8", "0.2"], // 0.1
  ["SentinelForm9", "0.2"], // 0.1
  ["SentinelForm10", "0.2"], // 0.1
]);

/**
 * Pain Eater grants Defense as well as attack speed.
 *
 * The talentstone itself is a "WTF" mod -- its SelfValue is a rank, not a magnitude, and
 * CombatState turns it into a cast of the ranked PainEater power when the Sentinel drops
 * below 20% health. That power's only payload is the PainEaterRank buff, and *that* is data,
 * so the extra effect belongs here rather than in bytecode.
 *
 * The numbers are the attack speed the buff already grants, which is not the curve the
 * tooltip advertises: BuffType hardcodes .01/.02/.04/.06/.1 against PainEaterRank1..5 while
 * the stone's description has always claimed 1/2/4/7/10%. Matching the code rather than the
 * description is what "same scaling as the attack speed" means, and the two halves stay in
 * step if that hardcoded curve is ever retuned to match its own text.
 *
 * MeleeDefense and MagicDefense move together so the boost covers both damage schools, which
 * is how every other defensive buff in the file is authored.
 */
const PAIN_EATER_DEFENSE = new Map<string, string>([
  ["PainEaterRank1", "0.01"], // absent
  ["PainEaterRank2", "0.02"], // absent
  ["PainEaterRank3", "0.04"], // absent
  ["PainEaterRank4", "0.06"], // absent
  ["PainEaterRank5", "0.1"], // absent
]);

// Talentstone values that only needed renumbering.
const MOD_BUFF_VALUES = new Map<string, string>([
  ["BlindTime1", "100"], // 100
  ["BlindTime2", "250"], // 200
  ["BlindTime3", "500"], // 300
  ["BlindTime4", "750"], // 500
  ["BlindTime5", "1000"], // 750
  ["BlindPct1", ".02"], // .01
  ["BlindPct2", ".04"], // .02
  ["BlindPct3", ".06"], // .03
  ["BlindPct4", ".08"], // .04
  ["BlindPct5", ".1"], // .05
  // Immolation. The stone's own description doubles what it authors, because Ignite is
  // applied in stacks -- so .02 reads as "+4%" on the tooltip, and the rewritten description
  // below is written in those doubled terms to stay consistent with the authored one.
  ["IgniteDmg1", "0.02"], // 0.01
  ["IgniteDmg2", "0.04"], // 0.02
  ["IgniteDmg3", "0.06"], // 0.03
  ["IgniteDmg4", "0.1"], // 0.05
  ["IgniteDmg5", "0.16"], // 0.08
]);

const MOD_SELF_VALUES = new Map<string, string>([
  ["ClutchHeal1", ".02"], // .01
  ["ClutchHeal2", ".04"], // .02
  ["ClutchHeal3", ".06"], // .03
  ["ClutchHeal4", ".08"], // .04
  ["ClutchHeal5", ".1"], // .05
  /**
   * Dominate stops being a crit stone and becomes a damage stone. The magnitudes are the ask
   * -- 10 to 50% -- and the doubling against Staggered and Stunned targets that takes it to
   * +100% is in patch-dungeonblitz-templar-talent-effects, because what the number means is
   * bytecode: CombatState reads this value straight into a crit-chance term today.
   *
   * The stone stays ModType WTF and keeps its ModID. Both matter: WTF is the file's own word
   * for "the client hardcodes this", which is still true, and the ModID is the save-data key
   * for every Sentinel who already owns the stone.
   */
  ["Dominate1", ".1"], // .01
  ["Dominate2", ".2"], // .02
  ["Dominate3", ".3"], // .03
  ["Dominate4", ".4"], // .05
  ["Dominate5", ".5"], // .08
]);

/**
 * Heavy Blows. A "Power" mod, so the magnitude is PowerValue rather than SelfValue -- it is
 * added to ProcMassive's BaseDamageMult, which is the critical-hit proc every class shares.
 */
const MOD_POWER_VALUES = new Map<string, string>([
  ["HeavyBlow1", ".02"], // .01
  ["HeavyBlow2", ".05"], // .02
  ["HeavyBlow3", ".08"], // .04
  ["HeavyBlow4", ".11"], // .07
  ["HeavyBlow5", ".15"], // .1
]);

/**
 * Taunt becomes Taunter. Every rank carries its own DisplayName, so all five are renamed --
 * the screen reads the rank the player owns, not rank 1. The attack speed the new name is
 * paying for is bytecode; see patch-dungeonblitz-templar-talent-effects.
 */
const MOD_DISPLAY_NAMES = new Map<string, string>([
  ["Taunt1", "Taunter"],
  ["Taunt2", "Taunter"],
  ["Taunt3", "Taunter"],
  ["Taunt4", "Taunter"],
  ["Taunt5", "Taunter"],
]);

/**
 * Three talentstones change what kind of mod they are, so their bodies are rewritten rather
 * than edited tag by tag -- Sanctify goes from a Buff mod to a Stat mod and Rapid Recovery
 * goes the other way, and each shape authors tags the other does not have.
 *
 * ModID is preserved from the file rather than written here: it is the save-data key, and a
 * wrong one would silently turn a player's stone into a different stone.
 *
 * Fortify and Rapid Recovery land on the same effect on purpose -- both were asked for as
 * Holy Fire damage. HolyFire1..5 are all named because a mod applies only to the buffs it
 * lists, and Celestial Lance hands out a different rank at each of its own ranks.
 */
const HOLY_FIRE_BUFFS = "HolyFire1,HolyFire2,HolyFire3,HolyFire4,HolyFire5";
const HOLY_FIRE_STEPS = [".05", ".1", ".15", ".2", ".25"];

type ModRewrite = { display?: string; description?: string; body: string[] };

function holyFireMod(modName: string, icon: string, rank: number, display: string): ModRewrite {
  return {
    display,
    description:
      rank === 1
        ? "Increases Holy Fire Damage@Holy Fire Damage:, +5%, +10%, +15%, +20%, +25%"
        : undefined,
    body: [
      "<ModType>Buff</ModType>",
      `<BuffName>${HOLY_FIRE_BUFFS}</BuffName>`,
      "<BuffProperty>DoTDamage</BuffProperty>",
      `<BuffValue>${HOLY_FIRE_STEPS[rank - 1]}</BuffValue>`,
      `<IconName>${icon}</IconName>`,
    ],
  };
}

const SANCTIFY_STEPS = [".01", ".02", ".03", ".04", ".05"];

const MOD_REWRITES = new Map<string, ModRewrite>([
  ...([1, 2, 3, 4, 5].map(
    (rank) => [`Fortify${rank}`, holyFireMod(`Fortify${rank}`, "a_Signet_Fortify", rank, "Fortify")] as const,
  ) as Array<[string, ModRewrite]>),
  ...([1, 2, 3, 4, 5].map(
    (rank) =>
      [
        `RapidRecovery${rank}`,
        holyFireMod(`RapidRecovery${rank}`, "a_Signet_RapidRecover", rank, "Rapid Recovery"),
      ] as const,
  ) as Array<[string, ModRewrite]>),
  ...([1, 2, 3, 4, 5].map(
    (rank) =>
      [
        `Sanctify${rank}`,
        {
          display: "Sanctify",
          description:
            rank === 1
              ? "Add a percent of your Expertise to your Defense@Defense (% Expertise):, +1%, +2%, +3%, +4%, +5%"
              : undefined,
          body: [
            "<ModType>Stat</ModType>",
            "<IconName>a_Signet_Sanctify</IconName>",
            "<StatProperty>ArmorFromWis</StatProperty>",
            `<StatValue>${SANCTIFY_STEPS[rank - 1]}</StatValue>`,
          ],
        },
      ] as const,
  ) as Array<[string, ModRewrite]>),
  /**
   * ComboFortify was what carried the Fortify buff onto the heal powers so the Fortify stone
   * could put defense on it. The stone boosts Holy Fire now, so all this did was hang a
   * property-less buff on every heal in the game.
   *
   * Neutered rather than deleted, and that distinction matters: class_17 hardcodes the link
   * by name -- any mod whose name starts with "Fortify" gets var_593 = "ComboFortify" -- so
   * the rewritten Fortify1..5 still look this up at load. Deleting the block would leave that
   * lookup dangling. "Other" is the parser's own no-op ModType, accepted with no complaint,
   * where a "Power" mod stripped of its PowerProperty logs an error on every load instead.
   *
   * The Fortify BuffType itself stays. Nothing applies it now, but BuffIDs are save-data keys.
   */
  [
    "ComboFortify",
    {
      body: ["<ModType>Other</ModType>"],
    },
  ],
]);

const MOD_DESCRIPTIONS = new Map<string, [string, string]>([
  [
    "BlindTime1",
    [
      "Increases Blinded Duration@Duration (seconds):, +.1, +.2, +.3, +.5, +.75",
      "Increases Blinded Duration@Duration (seconds):, +.1, +.25, +.5, +.75, +1",
    ],
  ],
  [
    "BlindPct1",
    [
      "Increases Blinded Miss Chance@Miss Chance:, +1%, +2%, +3%, +4%, +5%",
      "Increases Blinded Miss Chance@Miss Chance:, +2%, +4%, +6%, +8%, +10%",
    ],
  ],
  [
    "ClutchHeal1",
    [
      "Increased Healing on targets with less than 20% Health@Healing Boost:, 1%, 2%, 3%, 4%, 5%",
      "Increased Healing on targets with less than 30% Health@Healing Boost:, 2%, 4%, 6%, 8%, 10%",
    ],
  ],
  [
    "HeavyBlow1",
    [
      "Increases Heavy Blow Critical Effect@Heavy Blow Damage:, +1%, +2%, +4%, +7%, +10%",
      "Increases Heavy Blow Critical Effect@Heavy Blow Damage:, +2%, +5%, +8%, +11%, +15%",
    ],
  ],
  [
    "IgniteDmg1",
    [
      "Increases Ignite Damage@Ignite Damage:, +2%, +4%, +6%, +10%, +16%",
      "Increases Ignite Damage@Ignite Damage:, +4%, +8%, +12%, +20%, +32%",
    ],
  ],
  [
    "Taunt1",
    [
      "Increases Hate Generation@Hate:, +10%, +20%, +35%, +50%, +75%",
      "Increases Hate Generation and Attack Speed@Hate:, +10%, +20%, +35%, +50%, +75%@Attack Speed:, +1%, +2%, +3%, +4%, +5%",
    ],
  ],
  [
    "Dominate1",
    [
      "Gain a Critical Chance bonus vs. Staggered and Stunned targets@Critical Chance Bonus:, 0.15%, 0.3%, 0.45%, 0.75%, 1.2%",
      "Deal more damage to Demoralized targets, and twice as much to Staggered or Stunned ones@Damage Bonus:, 10%, 20%, 30%, 40%, 50%",
    ],
  ],
  [
    "PainEater1",
    [
      "Gain an Attack Speed bonus for 5 seconds when you fall below 20% HP. 15 second cooldown.@Attack Speed Bonus:, 1%, 2%, 4%, 7%, 10%",
      "Gain an Attack Speed and Defense bonus for 5 seconds when you fall below 20% HP. 15 second cooldown.@Attack Speed Bonus:, 1%, 2%, 4%, 6%, 10%@Defense Bonus:, 1%, 2%, 4%, 6%, 10%",
    ],
  ],
]);

/**
 * Text that has to move a second time, after an earlier run of this script already rewrote
 * it -- a single from/to pair cannot express that, because once the first rewrite lands the
 * original string is gone and the mapping silently stops matching.
 *
 * Clutch Heal is the case: the magnitudes moved first, and the 20% -> 30% threshold followed
 * only once patch-dungeonblitz-clutch-heal-threshold made the client actually use 30%. A
 * clean checkout walks both steps; an already-patched tree picks up just this one.
 */
const MOD_TEXT_MIGRATIONS: Array<{ mod: string; from: string; to: string }> = [
  {
    mod: "ClutchHeal1",
    from: "Increased Healing on targets with less than 20% Health@Healing Boost:, 2%, 4%, 6%, 8%, 10%",
    to: "Increased Healing on targets with less than 30% Health@Healing Boost:, 2%, 4%, 6%, 8%, 10%",
  },
];

function cloneStats(): PatchStats {
  return { ...EMPTY_STATS };
}

function mergeStats(...stats: PatchStats[]): PatchStats {
  return stats.reduce(
    (merged, item) => ({
      powerBlocks: merged.powerBlocks + item.powerBlocks,
      buffBlocks: merged.buffBlocks + item.buffBlocks,
      modBlocks: merged.modBlocks + item.modBlocks,
      changes: merged.changes + item.changes,
    }),
    cloneStats(),
  );
}

function replaceTag(block: string, tag: string, value: string, stats: PatchStats): string {
  const pattern = new RegExp(`<${tag}>[^<]*</${tag}>`);
  if (!pattern.test(block)) {
    return block;
  }

  const expected = `<${tag}>${value}</${tag}>`;
  return block.replace(pattern, (match: string) => {
    if (match === expected) {
      return match;
    }
    stats.changes += 1;
    return expected;
  });
}

/**
 * Several of these powers author no AddTargetBuff at all, so the tag has to be created. The
 * template orders it right after PowerGroup, and where a block has no PowerGroup either
 * (the Combo blocks), after BaseDamageMult.
 */
function setOrInsertTag(
  block: string,
  tag: string,
  value: string,
  afterTags: string[],
  stats: PatchStats,
): string {
  if (new RegExp(`<${tag}>[^<]*</${tag}>`).test(block)) {
    return replaceTag(block, tag, value, stats);
  }

  for (const anchor of afterTags) {
    const pattern = new RegExp(`<${anchor}>[^<]*</${anchor}>`);
    if (!pattern.test(block)) {
      continue;
    }
    stats.changes += 1;
    return block.replace(pattern, (match) => `${match}\r\n\t\t<${tag}>${value}</${tag}>`);
  }

  return block;
}

export function patchPlayerPowers(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const patched = xml.replace(/<Power PowerName="([^"]+)">[\s\S]*?<\/Power>/g, (block: string, powerName: string) => {
    let next = block;
    let touched = false;

    const targetBuff = TARGET_BUFFS.get(powerName);
    if (targetBuff) {
      touched = true;
      next = setOrInsertTag(next, "AddTargetBuff", targetBuff, ["PowerGroup", "BaseDamageMult"], stats);
    }

    const damageMult = DAMAGE_MULTS.get(powerName);
    if (damageMult) {
      touched = true;
      next = replaceTag(next, "BaseDamageMult", damageMult, stats);
    }

    const aoeRadius = AOE_RADII.get(powerName);
    if (aoeRadius) {
      touched = true;
      next = replaceTag(next, "AoERadius", aoeRadius, stats);
    }

    const castTime = CAST_TIMES.get(powerName);
    if (castTime) {
      touched = true;
      next = replaceTag(next, "CastTime", castTime, stats);
    }

    const manaCost = MANA_COSTS.get(powerName);
    if (manaCost) {
      touched = true;
      next = replaceTag(next, "ManaCost", manaCost, stats);
    }

    // Some replacements append to the text they match, so matching the old text is not
    // enough to know the edit is still pending -- the second prebuild would stack it again.
    for (const migration of POWER_TEXT_MIGRATIONS) {
      if (!migration.power.test(powerName)) continue;
      if (!next.includes(migration.from)) continue;
      touched = true;
      stats.changes += 1;
      next = next.split(migration.from).join(migration.to);
    }

    const description = DESCRIPTIONS.get(powerName);
    if (description && next.includes(description[0]) && !next.includes(description[1])) {
      touched = true;
      stats.changes += 1;
      next = next.split(description[0]).join(description[1]);
    }

    const upgrade = UPGRADE_TEXT.get(powerName);
    if (upgrade && next.includes(upgrade[0]) && !next.includes(upgrade[1])) {
      touched = true;
      stats.changes += 1;
      next = next.split(upgrade[0]).join(upgrade[1]);
    }

    if (touched) {
      stats.powerBlocks += 1;
    }
    return next;
  });

  return { xml: patched, stats };
}

export function patchPlayerBuffs(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const patched = xml.replace(/<BuffType BuffName="([^"]+)">[\s\S]*?<\/BuffType>/g, (block: string, buffName: string) => {
    let next = block;
    let touched = false;

    const duration = BUFF_DURATIONS.get(buffName);
    if (duration) {
      touched = true;
      next = replaceTag(next, "Duration", duration, stats);
    }

    const formDamage = SENTINEL_FORM_DAMAGE.get(buffName);
    if (formDamage) {
      touched = true;
      // Ranks 1-3 author neither field. MagicDefense is the first tag they do have that the
      // template orders after the damage pair, so both are inserted ahead of it.
      next = setOrInsertTag(next, "MeleeDamage", formDamage, ["Duration"], stats);
      next = setOrInsertTag(next, "MagicDamage", formDamage, ["MeleeDamage"], stats);
    }

    const painEaterDefense = PAIN_EATER_DEFENSE.get(buffName);
    if (painEaterDefense) {
      touched = true;
      // The PainEaterRank blocks author neither field, and neither of the tags the template
      // orders after them (StackCount, BuffLoc) exists there either -- Duration is the last
      // tag they do have that the template puts ahead of both.
      next = setOrInsertTag(next, "MagicDefense", painEaterDefense, ["Duration"], stats);
      next = setOrInsertTag(next, "MeleeDefense", painEaterDefense, ["MagicDefense"], stats);
    }

    if (touched) {
      stats.buffBlocks += 1;
    }
    return next;
  });

  return { xml: patched, stats };
}

export function patchPowerMods(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const patched = xml.replace(/<PowerModType>[\s\S]*?<\/PowerModType>/g, (block: string) => {
    const modName = block.match(/<ModName>([^<]*)<\/ModName>/)?.[1] ?? "";
    if (!modName) {
      return block;
    }

    let next = block;
    let touched = false;

    const rewrite = MOD_REWRITES.get(modName);
    if (rewrite) {
      const modId = next.match(/<ModID>([^<]*)<\/ModID>/)?.[1] ?? "";
      const lines = [
        `<ModName>${modName}</ModName>`,
        `<ModID>${modId}</ModID>`,
        ...(rewrite.display ? [`<DisplayName>${rewrite.display}</DisplayName>`] : []),
        ...(rewrite.description ? [`<Description>${rewrite.description}</Description>`] : []),
        ...rewrite.body,
      ];
      const rebuilt = `<PowerModType>\r\n\t\t${lines.join("\r\n\t\t")}\r\n\t</PowerModType>`;
      if (rebuilt !== next) {
        touched = true;
        stats.changes += 1;
        next = rebuilt;
      }
    }

    const buffValue = MOD_BUFF_VALUES.get(modName);
    if (buffValue) {
      touched = true;
      next = replaceTag(next, "BuffValue", buffValue, stats);
    }

    const selfValue = MOD_SELF_VALUES.get(modName);
    if (selfValue) {
      touched = true;
      next = replaceTag(next, "SelfValue", selfValue, stats);
    }

    const powerValue = MOD_POWER_VALUES.get(modName);
    if (powerValue) {
      touched = true;
      next = replaceTag(next, "PowerValue", powerValue, stats);
    }

    const displayName = MOD_DISPLAY_NAMES.get(modName);
    if (displayName) {
      touched = true;
      next = replaceTag(next, "DisplayName", displayName, stats);
    }

    for (const migration of MOD_TEXT_MIGRATIONS) {
      if (migration.mod !== modName) continue;
      if (!next.includes(migration.from) || next.includes(migration.to)) continue;
      touched = true;
      stats.changes += 1;
      next = next.split(migration.from).join(migration.to);
    }

    const description = MOD_DESCRIPTIONS.get(modName);
    if (description && next.includes(description[0]) && !next.includes(description[1])) {
      touched = true;
      stats.changes += 1;
      next = next.split(description[0]).join(description[1]);
    }

    if (touched) {
      stats.modBlocks += 1;
    }
    return next;
  });

  return { xml: patched, stats };
}

function patchFile(
  filePath: string,
  patcher: (xml: string) => { xml: string; stats: PatchStats },
  verifyOnly: boolean,
): PatchStats {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = patcher(original);
  if (!verifyOnly && patched.xml !== original) {
    fs.writeFileSync(filePath, patched.xml, "utf8");
  }
  return patched.stats;
}

function patchSwz(swzPath: string, verifyOnly: boolean): PatchStats {
  const ctx = parseSwz(swzPath);
  const resources: Array<{ marker: string; patcher: (xml: string) => { xml: string; stats: PatchStats } }> = [
    { marker: "<PlayerPowerTypes", patcher: patchPlayerPowers },
    { marker: "<PlayerBuffTypes", patcher: patchPlayerBuffs },
    { marker: "<PowerModTypes", patcher: patchPowerMods },
  ];

  const collected: PatchStats[] = [];
  let changed = false;
  for (const resource of resources) {
    const chunk = ctx.chunks.find((entry) => entry.xml.includes(resource.marker));
    if (!chunk) {
      continue;
    }

    const patched = resource.patcher(chunk.xml);
    collected.push(patched.stats);
    if (patched.xml !== chunk.xml) {
      changed = true;
      if (!verifyOnly) {
        chunk.xml = patched.xml;
      }
    }
  }

  if (!verifyOnly && changed) {
    ensureBackup(swzPath);
    writeSwz(ctx);
  }

  return mergeStats(...collected);
}

export function patchConfiguredPaladinMasteryBalance(verifyOnly: boolean): PatchStats {
  const swzPaths = ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter(fs.existsSync);

  return mergeStats(
    patchFile(POWER_XML, patchPlayerPowers, verifyOnly),
    patchFile(BUFF_XML, patchPlayerBuffs, verifyOnly),
    patchFile(MOD_XML, patchPowerMods, verifyOnly),
    ...swzPaths.map((swzPath) => patchSwz(swzPath, verifyOnly)),
  );
}

function main(): number {
  const verifyOnly = process.argv.includes("--verify") || process.argv.includes("--dry-run");
  try {
    const stats = patchConfiguredPaladinMasteryBalance(verifyOnly);
    console.log(JSON.stringify({ verifyOnly, stats }, null, 2));
    console.log(stats.changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_gameswz_paladin_mastery_balance] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
