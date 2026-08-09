import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

/**
 * Second Paladin pass (2026-08-04). Everything below the first pass's header still applies;
 * these are the items that moved a second time, and the ones that are new.
 *
 * Templar:
 *   Subjugate          adds 60% of Expertise as damage against a burning target, and
 *   Penance            45% -- both bytecode, see patch-dungeonblitz-templar-talent-effects
 *   Divine Word        healing up 25%
 *   Hallowed Reckoning healing halved
 *   Sacred Light       stops healing twice per cast
 *   Celestial Lance    no rank raises Holy Fire damage any more. Rank 4 only Staggers, rank 8
 *                      lands a second stack of Holy Fire and takes 3 Mana off, rank 10 takes
 *                      another 2 off and keeps the stun and the damage
 *   Empyrean Aura      4 second base boost, extended by Expertise (bytecode), 50s cooldown
 *
 * Talentstones:
 *   Fortify -> Smiting Flames    Holy Fire damage 3/5/10/13/15%, down from 5-25%
 *   Rapid Recovery (Templar)     becomes its own stone, Crusading Flames: +1/2/3/5/8 to the
 *                                maximum number of Holy Fire stacks
 *   Rapid Recovery (Sentinel)    back to the Tenacity stone it always was, 1/3/5/7/10%
 *
 * The two Rapid Recoveries were one stone. NodeTypes node 22 (Templar) and node 25 (Sentinel)
 * both pointed at the RapidRecovery family, so the first pass's repurposing took the
 * Sentinel's Tenacity with it. The fix is a new CrusadingFlames family plus a NodeTypes edit
 * that moves the Templar's node onto it -- which is why this script now patches a fourth
 * resource, and why NodeTypes has no loose-XML counterpart to keep in step.
 */

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
 *                      one bonus on all three, 5-25% (the effect itself is bytecode)
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
 * AddTargetBuff, absolute.
 *
 * HOLY_FIRE_IS_ONE_POOL. Holy Fire is authored as five BuffTypes (HolyFire1..5, 1.0 to 2.5
 * damage a tick) and the earlier passes handed out a different rank per power rank. That is
 * what "Celestial Lance's Holy Fire does not stack with Divine Word / Hallowed Reckoning /
 * Sanctum" was: a target's buff list is keyed by BuffType -- CombatState.method_135 walks it
 * comparing `param1 == _loc2_.type` -- so two ranks of Holy Fire are two independent buffs
 * with two independent stack pools. A Lance filling HolyFire1 while Divine Word filled
 * HolyFire3 read on screen as two competing timers rather than one growing stack, and neither
 * source could ever add to the other's.
 *
 * Every Holy Fire source now hands out HolyFire1 and nothing else, so all four feed one pool
 * and genuinely stack with each other. Rank progression moves to the *number* of stacks a cast
 * applies -- each name in this list is one AddBuff call of one stack (CombatState passes a
 * literal 1 per entry) -- and the cap those stacks fill is what the Crusading Flames stone
 * raises. Tick damage is no longer a rank question at all: it is HolyFire1's authored 1.0,
 * scaled by the Smiting Flames stone.
 *
 * HolyFire2..5 are left in PlayerBuffTypes with nothing pointing at them. BuffIDs are
 * save-data keys, and a target mid-fight when the client updates can still be carrying one.
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
  /**
   * Divine Word -- Holy Fire from rank 3, one stack, at every rank.
   *
   * See HOLY_FIRE_IS_ONE_POOL below for why it is always HolyFire1 and never a hotter rank of
   * the buff: two ranks of Holy Fire are two BuffTypes and two BuffTypes never share a stack
   * pool. What a rank buys is its Weakened count, which is authored and untouched here.
   */
  ["DivineWord3", "Weakened,HolyFire1"], // was Weakened
  ["DivineWord4", "Weakened,HolyFire1"], // was Weakened
  ["DivineWord5", "Weakened,HolyFire1"], // was Weakened
  ["DivineWord6", "Weakened,HolyFire1"], // was Weakened
  ["DivineWord7", "Weakened,HolyFire1"], // was Weakened,HolyFire1,HolyFire1
  ["DivineWord8", "Weakened,Weakened,HolyFire1"], // was Weakened,Weakened,HolyFire1,HolyFire1
  ["DivineWord9", "Weakened,Weakened,HolyFire1"], // was Weakened,Weakened,HolyFire1,HolyFire1
  ["DivineWord10", "Weakened,Weakened,HolyFire1"], // was Weakened,Weakened,HolyFire1 x3
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
  ["FountainOfLifeCombo7", "HolyFire1"], // was HolyFire1,HolyFire1
  ["FountainOfLifeCombo8", "HolyFire1"], // was HolyFire1,HolyFire1
  ["FountainOfLifeCombo9", "HolyFire1"], // was HolyFire1,HolyFire1
  ["FountainOfLifeCombo10", "HolyFire1"], // was HolyFire1 x3
  // Sanctum. Same split: Sanctum1..10 are RangedAoEFriend heals, SanctumCombo is the pulse
  // that hits enemies. It has no ranks, so this is not rank-gated the way rank 4 was asked
  // for -- there is no rank to gate it on.
  ["SanctumCombo", "Blinded,HolyFire1"], // was Blinded,HolyFire1,HolyFire1
  /**
   * Celestial Lance. Every rank band hands out the same HolyFire1 -- it was the first power
   * moved onto the shared pool and is why the others followed -- so the only thing a rank buys
   * is what its own upgrade text says it buys: rank 4 the Stagger, rank 6 the splash, rank 8 a
   * *second* stack plus the mana discount, rank 10 the stun.
   *
   * The Lance is the only source that stacks at all. Divine Word, Hallowed Reckoning and
   * Sanctum each land exactly one at every rank; ranks 1-7 of the Lance land one and 8-10 land
   * two, which moves HolyFire1 toward its base cap of three and gives the Crusading Flames
   * stone something to raise further.
   *
   * The rank bands are the combos, not the ranks: Combo2 is ranks 4-5, Combo3 6-7, Combo4 8-9,
   * Combo5 10. Combo and Combo1 already author a bare HolyFire1 and stay as they are.
   */
  ["CelestialLanceCombo2", "HolyFire1,Staggered"], // was HolyFire2,Staggered
  ["CelestialLanceCombo3", "HolyFire1,Staggered"], // was HolyFire3,Staggered
  ["CelestialLanceCombo4", "HolyFire1,HolyFire1,Staggered"], // was HolyFire1,Staggered
  ["CelestialLanceCombo5", "HolyFire1,HolyFire1,Staggered"], // was HolyFire1,Staggered
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
  // Lightning Bomb -- the opening stab carries one stack of Armor Bane. Each name in the list
  // is one stack, so the second ArmorBane the first pass authored is simply dropped.
  ["LightningBomb", "LightningBomb,ArmorBane"], // was LightningBomb,ArmorBane,ArmorBane
  ["LightningBomb1", "LightningBomb,ArmorBane"], // was LightningBomb,ArmorBane,ArmorBane
  ["LightningBomb2", "LightningBomb,ArmorBane"], // was LightningBomb,ArmorBane,ArmorBane
  ["LightningBomb3", "LightningBomb,ArmorBane"], // was LightningBomb,ArmorBane,ArmorBane
  ["LightningBomb4", "LightningBomb,ArmorBane"], // was LightningBomb,ArmorBane,ArmorBane
  ["LightningBomb5", "LightningBomb,ArmorBane"], // was LightningBomb,ArmorBane,ArmorBane
  ["LightningBomb6", "LightningBomb,ArmorBane"], // was LightningBomb,ArmorBane,ArmorBane
  ["LightningBomb7", "LightningBomb,ArmorBane"], // was LightningBomb,ArmorBane,ArmorBane
  ["LightningBomb8", "LightningBomb,ArmorBane"], // was LightningBomb,ArmorBane,ArmorBane
  ["LightningBomb9", "LightningBomb,ArmorBane"], // was LightningBomb,ArmorBane,ArmorBane
  ["LightningBomb10", "LightningBomb,ArmorBane"], // was LightningBomb,ArmorBane,ArmorBane
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
   * Cleave and Smash, every rank down 25%.
   *
   * Absolute, like everything else in this map, so a second prebuild cannot compound the cut.
   * Each comment is the value being replaced, which for ranks 1-9 is the authored one and for
   * rank 10 is the number the earlier "bring both up to Skewer" pass wrote.
   *
   * Rank 10 stays worth a whole Skewer cast relative to the other two, because all three moved
   * by the same fraction. The shapes behind those numbers still matter and are worth not
   * rediscovering: BaseDamageMult is a per-step list, CombatState reads var_630[step] and falls
   * back to var_630[0], so a single value on a multi-step power is charged once per step.
   *
   *   Skewer 10   1.42,1.92,2.42 over three steps -> 5.76 a cast, untouched here
   *   Cleave 10   one value, and Cleave is one of the target methods that carries a hit-once
   *               dictionary, so an enemy takes it exactly once
   *   Smash 10    one value over two steps, Melee, no dictionary, so both blows land and the
   *               single value is charged twice -> 4.32 a cast
   *
   * Smash 10 is a single value again, where an earlier pass wrote the two-entry list
   * "2.88,2.88". Per-cast damage is identical either way, and the list cost the tooltip its
   * damage line outright: patch_gameswz_power_stat_tooltips reads BaseDamageMult with Number(),
   * a comma makes that NaN, and the "[Stats: ...]" fence simply omitted the figure. The second
   * blow's Armor Bane does not depend on it -- "Last:" keys off the CastTime step index, and
   * Smash authors two steps at every rank.
   */
  ["Cleave", "1.43"], //   1.9
  ["Cleave1", "1.07"], //  1.42
  ["Cleave2", "1.17"], //  1.56
  ["Cleave3", "1.29"], //  1.72
  ["Cleave4", "1.29"], //  1.72
  ["Cleave5", "1.36"], //  1.81
  ["Cleave6", "1.49"], //  1.99
  ["Cleave7", "1.49"], //  1.99
  ["Cleave8", "1.64"], //  2.19
  ["Cleave9", "1.64"], //  2.19
  ["Cleave10", "4.32"], // 5.76
  ["Smash", "1.07"], //       1.42
  ["Smash1", "0.84"], //      1.12
  ["Smash2", "0.91"], //      1.21
  ["Smash3", "0.98"], //      1.31
  ["Smash4", "1.06"], //      1.41
  ["Smash5", "1.06"], //      1.41
  ["Smash6", "1.16"], //      1.55
  ["Smash7", "1.28"], //      1.71
  ["Smash8", "1.35"], //      1.8
  ["Smash9", "1.42"], //      1.89
  ["Smash10", "2.16"], //     2.88,2.88
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
  /**
   * Hallowed Reckoning heals 50% less. The heal is the negative half of the AuraFriend blocks
   * -- a BaseDamageMult below zero is healing, charged per cast step against Expertise -- so
   * every entry of every rank's list is scaled by .5 and rounded to the two decimals the file
   * is authored in. The FountainOfLifeCombo blocks are the enemy-facing half and keep their
   * damage.
   *
   * The unranked block moves with them; it is the pre-talent version of the same power.
   */
  ["FountainOfLife", "-.25,-.25,-.25,-.25,-.25,-.25"], // -.5 x6
  ["FountainOfLife1", "-.29,-.29,-.29,-.29"], // -.58,-.58,-.57,-.57
  ["FountainOfLife2", "-.33,-.33,-.33,-.33"], // -.65 x4
  ["FountainOfLife3", "-.37,-.37,-.36,-.36"], // -.73,-.73,-.72,-.72
  ["FountainOfLife4", "-.42,-.42,-.41,-.41"], // -.83,-.83,-.82,-.82
  ["FountainOfLife5", "-.47,-.47,-.46,-.46"], // -.93,-.93,-.92,-.92
  ["FountainOfLife6", "-.52,-.52,-.51,-.51"], // -1.03,-1.03,-1.02,-1.02
  ["FountainOfLife7", "-.58,-.58,-.58,-.55"], // -1.15,-1.15,-1.15,-1.10
  ["FountainOfLife8", "-.61,-.61,-.61,-.61"], // -1.22,-1.21,-1.21,-1.21
  ["FountainOfLife9", "-.65,-.65,-.65,-.63"], // -1.30,-1.30,-1.30,-1.25
  ["FountainOfLife10", "-.75,-.75,-.75,-.75"], // -1.5 x4
  /**
   * Sacred Light healed twice per cast, and the trailing zero is the whole fix.
   *
   * CastTime is the step list and BaseDamageMult is read against it: CombatState takes
   * var_630[step] and falls back to var_630[0] when the list is shorter. CleansingLight
   * authors "830,0" -- two steps -- against a single multiplier, so the second step fell back
   * to the first and healed the party a second time. Its own upgrade text has always quoted
   * the single value ("90% Heal" against -0.85), so the tooltip was right and the power was
   * wrong.
   *
   * Zeroing the second step rather than dropping it from CastTime keeps the cast timing and
   * the animation exactly as they are -- the step still happens, it just heals nothing.
   */
  ["CleansingLight", "-0.85,0"], // -0.85
  ["CleansingLight1", "-0.85,0"], // -0.85
  ["CleansingLight2", "-1.28,0"], // -1.28
  ["CleansingLight3", "-1.28,0"], // -1.28
  ["CleansingLight4", "-1.71,0"], // -1.71
  ["CleansingLight5", "-1.71,0"], // -1.71
  ["CleansingLight6", "-2.39,0"], // -2.39
  ["CleansingLight7", "-2.39,0"], // -2.39
  ["CleansingLight8", "-2.82,0"], // -2.82
  ["CleansingLight9", "-2.82,0"], // -2.82
  ["CleansingLight10", "-3.21,0"], // -3.21
]);

/**
 * Empyrean Aura's cooldown. Every rank carries its own, and the unranked block is the
 * pre-talent version, so all eleven move together.
 */
const COOLDOWNS = new Map<string, string>(
  ["", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].map((rank) => [`LeoneanAura${rank}`, "50000"]),
);

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
  // Smash keeps its authored swing at every rank. Ranks 7-10 briefly got a faster windup on
  // top of the rank-10 damage raise; the cast speed is gone again and the damage is down 25%
  // with the rest of the power (DAMAGE_MULTS). These rows are written rather than deleted
  // because an earlier prebuild already wrote 400,350 and only an absolute value puts it back.
  ["Smash7", "550,450"], // 400,350
  ["Smash8", "550,450"], // 400,350
  ["Smash9", "550,450"], // 400,350
  ["Smash10", "550,450"], // 400,350
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
  // Celestial Lance gets cheaper where it used to get hotter: ranks 8-9 pay for what the
  // second Holy Fire stack replaced, rank 10 for the Holy Fire rank it no longer buys.
  ["CelestialLance8", "37"], // 40
  ["CelestialLance9", "37"], // 40
  ["CelestialLance10", "35"], // 40
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
  /**
   * Warcry. The discount is a rank-7 upgrade now rather than something every Templar has from
   * the first point: ranks 1-6 pay the authored 30, ranks 7-10 pay 25. The unranked block is
   * the pre-talent version and sits with the low band.
   *
   * These are absolute, so the rows below are what a rank costs, not what is taken off it --
   * the low band is written out even though 30 is also what the file authored, because an
   * earlier pass moved all eleven to 25 and only an absolute value puts them back.
   */
  ["Warcry", "30"], // 25
  ["Warcry1", "30"], // 25
  ["Warcry2", "30"], // 25
  ["Warcry3", "30"], // 25
  ["Warcry4", "30"], // 25
  ["Warcry5", "30"], // 25
  ["Warcry6", "30"], // 25
  ["Warcry7", "25"], // 25
  ["Warcry8", "25"], // 25
  ["Warcry9", "25"], // 25
  ["Warcry10", "25"], // 25
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
  /**
   * Hallowed Reckoning's quoted heal, down 50% with the values it quotes. These are
   * migrations rather than UPGRADE_TEXT rows because every rank carries a percentage and
   * UPGRADE_TEXT holds one pair per power -- and because ranks 4, 7 and 10 have already had
   * their sentence rewritten once, so the percentage is the only part still worth matching.
   */
  ...(
    ([
      [1, [370, 240, 260], 185], [2, [380, 245, 265], 190], [3, [430, 280, 300], 215],
      [4, [460, 300, 320], 230], [5, [500, 325, 350], 250], [6, [510, 330, 355], 255],
      [7, [530, 345, 370], 265], [8, [550, 355, 385], 275], [9, [560, 365, 390], 280],
      [10, [600, 390, 420], 300],
    ] as Array<[number, number[], number]>).flatMap(([rank, sources, after]) => sources
      .filter((before) => before !== after)
      .map((before) => ({
        power: new RegExp(`^FountainOfLife${rank}$`),
        from: `${before}% Heal over 4 sec.`,
        to: `${after}% Heal over 4 sec.`,
      })))
  ),
  // Divine Word's, increased by 25%.
  ...(
    ([
      [1, [113, 75, 38], 94], [4, [1125, 150, 100, 50], 125], [10, [188, 125, 63], 156],
    ] as Array<[number, number[], number]>).flatMap(([rank, sources, after]) => sources.map((before) => ({
      power: new RegExp(`^DivineWord${rank}$`),
      from: `${before}% Heal over 3 sec`,
      to: `${after}% Heal over 3 sec`,
    })))
  ),
  /**
   * Empyrean Aura's boost now says #dur#, which PowerType resolves at read time from the buff
   * the power hands out -- plus the Expertise extension, once
   * patch-dungeonblitz-templar-talent-effects has taught it to. A written number could not
   * say "and however much your Expertise adds"; the token can.
   *
   * One entry per rank band, because the sentence the first pass wrote quotes that band's own
   * length. Every band is rewritten to the same token.
   */
  ...(
    ["2", "3", "5", "8"].map((seconds) => ({
      power: /^LeoneanAura\d*$/,
      from: `The boost lasts ${seconds} seconds.`,
      to: "The boost lasts #dur# seconds.",
    }))
  ),
  /**
   * The same sentence again, in the wording Game.swz carries. The packed copy and the loose
   * XML under src/client/content/xml disagree here -- the swz says "a boost that lingers for
   * N seconds", the loose file says "The boost lasts N seconds." -- and the swz is the one the
   * client reads, so both have to be rewritten or the tooltip keeps quoting a number the aura
   * no longer holds for.
   */
  ...(
    ["2", "3", "5", "8"].map((seconds) => ({
      power: /^LeoneanAura\d*$/,
      from: `lingers for ${seconds} seconds`,
      to: "lingers for #dur# seconds",
    }))
  ),
  /**
   * Celestial Lance rank 4 keeps the Stagger and loses the Holy Fire claim. This is a
   * migration and not an UPGRADE_TEXT row for a mechanical reason: the replacement is a
   * prefix of the text it replaces, and UPGRADE_TEXT skips any row whose "after" is already
   * present -- which it always would be.
   */
  {
    power: /^CelestialLance4$/,
    from: "Staggers. Increased Holy Fire damage",
    to: "Staggers.",
  },
  /**
   * Rank 7 of Smash no longer swings faster, and the promise has already been written once by
   * an earlier prebuild -- so its UPGRADE_TEXT anchor is gone and only a migration off the text
   * that landed can move it.
   */
  {
    power: /^Smash7$/,
    from: "Faster cast animation. Increased Damage #olddmg#",
    to: "Increased Damage #olddmg#",
  },
  /**
   * Rank 8 of the Lance is the one rank that stacks Holy Fire, so its rank-up says so. This is
   * the clean-checkout half of that sentence, off the authored text; the tree that has already
   * been through a pass where rank 8 bought nothing but mana is handled by UPGRADE_TEXT, whose
   * "already present" check makes the two safe to run back to back.
   */
  {
    power: /^CelestialLance8$/,
    from: "Increased Holy Fire Damage",
    to: "Adds a stack of Holy Fire. -3 Mana Cost.",
  },
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
  // The percentages here are the ones POWER_TEXT_MIGRATIONS has already written by the time
  // these run -- a clean checkout walks the migration first, so matching the authored 460 here
  // would never fire.
  ["FountainOfLife4", ["Increased Damage #olddmg#. 230% Heal over 4 sec.", "Adds a stack of Holy Fire. 230% Heal over 4 sec."]],
  ["FountainOfLife7", ["Increased Damage #olddmg#. 265% Heal over 4 sec.", "Faster cast animation. 265% Heal over 4 sec."]],
  ["FountainOfLife10", ["Increased Damage #olddmg#. 300% Heal over 4 sec.", "-5 Mana Cost. 300% Heal over 4 sec."]],
  ["CelestialLance6", ["Increased Holy Fire Damage", "The Lance now strikes every enemy around its target."]],
  // Anchored on what the previous pass left behind, not on the authored text -- the migration
  // above covers the clean checkout, and this covers a tree where rank 8 had lost its stack.
  ["CelestialLance8", ["-3 Mana Cost.", "Adds a stack of Holy Fire. -3 Mana Cost."]],
  [
    "CelestialLance10",
    [
      "Stuns Lance target. Increased Holy Fire Damage. Increased Lance Damage #olddmg#",
      "Stuns Lance target. -2 Mana Cost. Increased Lance Damage #olddmg#",
    ],
  ],
  ["Verdict9", ["+30% Healing per shot", "+30% Healing per shot. Each shot returns 2 Mana."]],
  ["Verdict10", ["+50% Healing per shot", "+50% Healing per shot. +1.5 Second Duration."]],
  ["CleavingBlows2", ["Increased Damage #olddmg#", "Your swings return 5 Mana each. Increased Damage #olddmg#"]],
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
  // Warcry's discount is a rank-7 upgrade, so rank 7 is the rank that has to advertise it.
  ["Warcry7", ["Increased Damage #olddmg#", "-5 Mana Cost. Increased Damage #olddmg#"]],
]);

/**
 * Descriptions written outright instead of by substring.
 *
 * The substring maps above cannot express a sentence that has already been rewritten twice
 * and is worded differently in the two copies of the file -- Empyrean Aura is exactly that:
 * Game.swz says "a boost that lingers for N seconds" where the loose XML says "The boost
 * lasts N seconds.", and both have been through the #dur# migration. Writing the whole tag
 * settles both copies in one step and is idempotent by construction, because replaceTag
 * no-ops when the value already matches.
 *
 * The trailing "[Stats: ...]" block is carried across rather than written here.
 * patch_gameswz_power_stat_tooltips owns that fence and regenerates it from the power's own
 * fields; dropping it would make every prebuild report a change forever.
 */
const POWER_DESCRIPTIONS = new Map<string, string>();

/**
 * Empyrean Aura, in the wording that was asked for. The percentage is the rank's own
 * MeleeDamage/MagicDamage, and "4 seconds" is now literally true at every rank rather than a
 * rank-band number -- see BUFF_DURATIONS, which flattens all ten to the 4-second base the
 * Expertise extension is measured against.
 *
 * The #dur# token is deliberately gone. It resolved to base + Expertise, which is a different
 * claim from the one being made here: the sentence names the base and says Expertise extends
 * it, which is what the effect actually does.
 */
const EMPYREAN_AURA_BOOST = [15, 16, 18, 19, 20, 25, 26, 28, 30, 33];

for (let rank = 0; rank <= 10; rank += 1) {
  const boost = EMPYREAN_AURA_BOOST[Math.max(rank, 1) - 1];
  POWER_DESCRIPTIONS.set(
    rank === 0 ? "LeoneanAura" : `LeoneanAura${rank}`,
    `Create an aura that grants nearby allies a ${boost}% attack and expertise boost, duration is increased by expertise.`,
  );
}

/**
 * Lightning Bomb. The stab lands one stack of Armor Bane rather than two, and the blast's
 * one stack is now said out loud instead of being left as a bare "and Armor Bane".
 *
 * Written outright for the same reason as Empyrean Aura: ranks 0-1 still carry the original
 * "Turns a foe into a Lightning Bomb" opening while ranks 2-10 carry the stab wording, and
 * every one of them has already been through the spread-chain migration.
 */
for (let rank = 0; rank <= 10; rank += 1) {
  POWER_DESCRIPTIONS.set(
    rank === 0 ? "LightningBomb" : `LightningBomb${rank}`,
    "Stab a foe, applying 1 stack of Armor Bane and turning them into a Lightning Bomb that " +
      "explodes when killed. The blast leaves 2 stacks of Ignite and 1 stack of Armor Bane on " +
      "everything caught in it.",
  );
}

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
/**
 * The second pass halves the whole curve: what a rank-10 Templar held for 8 seconds is a
 * 4-second base now, and Expertise buys the rest of it back
 * (patch-dungeonblitz-templar-talent-effects). Halving rather than flattening every rank to 4
 * keeps the rank progression the first pass authored -- a rank-1 aura was never meant to hold
 * as long as a rank-10 one.
 */
/**
 * Third pass: the rank bands are gone and every rank holds the same 4-second base, because
 * that is what Empyrean Aura's sentence now promises at every rank. What a rank buys is the
 * size of the boost (MeleeDamage/MagicDamage, 15% to 33%) and what Expertise buys is the time
 * on top -- the extension in patch-dungeonblitz-templar-talent-effects is capped at the
 * authored duration, so flattening the base flattens the cap with it.
 */
const BUFF_DURATIONS = new Map<string, string>([
  ["LeoneanAura1", "4000"], // 1000
  ["LeoneanAura2", "4000"], // 1000
  ["LeoneanAura3", "4000"], // 1000
  ["LeoneanAura4", "4000"], // 1500
  ["LeoneanAura5", "4000"], // 1500
  ["LeoneanAura6", "4000"], // 1500
  ["LeoneanAura7", "4000"], // 2500
  ["LeoneanAura8", "4000"], // 2500
  ["LeoneanAura9", "4000"], // 2500
  ["LeoneanAura10", "4000"], // 4000
  ["Verdict9", "7000"], // 5500
  ["Verdict10", "7000"], // 5500
]);

// Empyrean Aura's sentence is written outright now -- see POWER_DESCRIPTIONS.

/**
 * Divine Word heals 25% more. The heal is not on the power at all -- DivineWordCombo is a
 * RangedAoEFriend cast with no damage of its own whose only payload is one of these three
 * buffs, and the buff's negative DoTDamage is the healing tick. Rank bands: Buff10 is ranks
 * 1-3, Buff15 is 4-9, Buff20 is 10.
 */
const BUFF_DOT_DAMAGE = new Map<string, string>([
  ["DivineWordBuff10", "-0.9375"], // -0.75
  ["DivineWordBuff15", "-1.25"], // -1
  ["DivineWordBuff20", "-1.5625"], // -1.25
]);

/** Holy Fire starts at three stacks; Crusading Flames adds up to five more for a cap of eight. */
const HOLY_FIRE_STACK_COUNTS = new Map<string, string>(
  [1, 2, 3, 4, 5].map((rank) => [`HolyFire${rank}`, "3"]),
);

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

/**
 * Crusading Flames' curve. Declared up here rather than beside the family's MOD_INSERTS block
 * because MOD_BUFF_VALUES reads it at module load and a `const` below would still be in its
 * temporal dead zone.
 */
const CRUSADING_FLAMES_STEPS = ["1", "2", "3", "4", "5"];
// Volatile's, for the same reason -- MOD_SELF_VALUES and MOD_REWRITES both read it.
const VOLATILE_STEPS = [".02", ".04", ".06", ".08", ".1"];

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
  /**
   * Crusading Flames, down from +1/2/3/5/8 to +1/2/3/4/5. With the new base cap of three,
   * the old curve would have reached eleven stacks instead of the intended maximum of eight.
   *
   * These are here as well as in MOD_INSERTS because the family only gets inserted on a tree
   * that does not have it yet -- an already-patched PowerModTypes is edited through this map.
   */
  ...CRUSADING_FLAMES_STEPS.map(
    (value, index) => [`CrusadingFlames${index + 1}`, value] as [string, string],
  ),
]);

const MOD_SELF_VALUES = new Map<string, string>([
  ["ClutchHeal1", ".02"], // .01
  ["ClutchHeal2", ".04"], // .02
  ["ClutchHeal3", ".06"], // .03
  ["ClutchHeal4", ".08"], // .04
  ["ClutchHeal5", ".1"], // .05
  /**
   * Dominate stops being a crit stone and becomes a damage stone: one bonus, applied against
   * a Demoralized, Staggered or Stunned target. Which states count, and the fact that none of
   * them stack the bonus, is bytecode -- patch-dungeonblitz-templar-talent-effects -- because
   * what this number *means* is hardcoded; CombatState originally read it straight into a
   * crit-chance term.
   *
   * The stone stays ModType WTF and keeps its ModID. Both matter: WTF is the file's own word
   * for "the client hardcodes this", which is still true, and the ModID is the save-data key
   * for every Sentinel who already owns the stone.
   */
  ["Dominate1", ".05"], // .1
  ["Dominate2", ".1"], // .2
  ["Dominate3", ".15"], // .3
  ["Dominate4", ".2"], // .4
  ["Dominate5", ".25"], // .5
  /**
   * Volatile. The stone's magnitudes were already the 2-10% that was asked for and its
   * bytecode already does the asked-for thing -- CombatState sums every mod whose name starts
   * with "IgniteCrit" into var_1557 and adds it to the critical chance of a hit against a
   * target carrying Ignite (var_1234). Only the authored shape lied about it, describing a
   * Poison bonus against Cursed targets; MOD_REWRITES below drops the Cursed buff tags the
   * client never reads and MOD_DESCRIPTIONS rewrites the sentence.
   *
   * Listed here so a clean checkout still writes the magnitudes even though they are
   * unchanged, because MOD_REWRITES rebuilds the block from scratch and takes its SelfValue
   * from this file rather than from the file being patched.
   */
  ...VOLATILE_STEPS.map((value, index) => [`IgniteCrit${index + 1}`, value] as [string, string]),
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
// Fortify becomes Smiting Flames, and the damage it adds comes down from the first pass's
// 5-25%. Every HolyFire rank is named because a Buff mod applies only to the buffs it lists.
const SMITING_FLAMES_STEPS = [".03", ".05", ".1", ".13", ".15"];

type ModRewrite = { display?: string; description?: string; body: string[] };

const SANCTIFY_STEPS = [".01", ".02", ".03", ".04", ".05"];
// Rapid Recovery, back to the stone it was before the first pass took it: Tenacity, which the
// file calls CCReduction. The Sentinel's node 25 points here and always did.
const TENACITY_STEPS = [".01", ".03", ".05", ".07", ".1"];

const MOD_REWRITES = new Map<string, ModRewrite>([
  ...([1, 2, 3, 4, 5].map(
    (rank) =>
      [
        `Fortify${rank}`,
        {
          display: "Smiting Flames",
          description:
            rank === 1
              ? "Increases Holy Fire Damage@Holy Fire Damage:, +3%, +5%, +10%, +13%, +15%"
              : undefined,
          body: [
            "<ModType>Buff</ModType>",
            `<BuffName>${HOLY_FIRE_BUFFS}</BuffName>`,
            "<BuffProperty>DoTDamage</BuffProperty>",
            `<BuffValue>${SMITING_FLAMES_STEPS[rank - 1]}</BuffValue>`,
            "<IconName>a_Signet_Fortify</IconName>",
          ],
        },
      ] as const,
  ) as Array<[string, ModRewrite]>),
  ...([1, 2, 3, 4, 5].map(
    (rank) =>
      [
        `RapidRecovery${rank}`,
        {
          display: "Rapid Recovery",
          description:
            rank === 1 ? "Increases Tenacity@Tenacity:, +1%, +3%, +5%, +7%, +10%" : undefined,
          body: [
            "<ModType>Stat</ModType>",
            "<IconName>a_Signet_RapidRecover</IconName>",
            "<StatProperty>CCReduction</StatProperty>",
            `<StatValue>${TENACITY_STEPS[rank - 1]}</StatValue>`,
          ],
        },
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
   * Volatile stops claiming to be a Poison stone.
   *
   * Nothing about the effect moves: CombatState already sums every mod named IgniteCrit* into
   * var_1557 and adds it to the proc chance of a hit whose target carries Ignite -- which is
   * what this game calls Critical Chance, the same number ScreenArmory's Critical Chance page
   * reports. The 2-10% curve was already right too.
   *
   * What moves is the authored shape. The block declared BuffName Cursed with BuffProperty
   * PoisonMultiplier under ModType "WTF", and WTF is the file's own word for "the client
   * hardcodes this" -- so those two tags described an effect no code path reads while the
   * description they justified described an effect the stone does not have. Both go, leaving
   * the shape every other WTF stone has: a SelfValue and nothing else.
   *
   * ModID is preserved from the file, as everywhere else here: it is the save-data key.
   */
  ...([1, 2, 3, 4, 5].map(
    (rank) =>
      [
        `IgniteCrit${rank}`,
        {
          display: "Volatile",
          description:
            rank === 1
              ? "Gain a Critical Chance bonus vs. Ignited targets@Critical Chance Bonus:, 2%, 4%, 6%, 8%, 10%"
              : undefined,
          body: [
            "<ModType>WTF</ModType>",
            `<SelfValue>${VOLATILE_STEPS[rank - 1]}</SelfValue>`,
            "<IconName>a_Signet_Critical03</IconName>",
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

/**
 * Crusading Flames: a brand new talentstone family, and it has to be new.
 *
 * The Templar and the Sentinel were sharing one stone. NodeTypes node 22 gives the Templar
 * "RapidRecovery" and node 25 gives the Sentinel the same family, so the first pass's
 * repurposing of RapidRecovery into a Holy Fire stone silently took the Sentinel's Tenacity
 * with it. Restoring Tenacity above and moving the Templar's node onto CrusadingFlames is the
 * only shape that gives each class the stone it is supposed to have.
 *
 * ModIDs 895-899 are the first free ones -- the file authors 0 through 894 with no gaps -- and
 * they are what a Templar's save will key against, so they must not be renumbered later.
 *
 * It raises the *cap*, not the damage: HolyFire1..5 all have a patched StackCount of 3, and
 * the +5 final rank reaches the intended maximum of 8. Deep Cuts and Napalm are the same mod
 * shape against Bleeding and Burned.
 *
 * The icon stays a_Signet_RapidRecover. It is the icon the Templar's node has always shown,
 * and reusing it means the node keeps its face while the Sentinel's stone keeps its own.
 */
const CRUSADING_FLAMES_FIRST_MOD_ID = 895;

const MOD_INSERTS = new Map<string, string[]>(
  [1, 2, 3, 4, 5].map((rank) => [
    `CrusadingFlames${rank}`,
    [
      `<ModName>CrusadingFlames${rank}</ModName>`,
      `<ModID>${CRUSADING_FLAMES_FIRST_MOD_ID + rank - 1}</ModID>`,
      "<DisplayName>Crusading Flames</DisplayName>",
      ...(rank === 1
        ? [
            `<Description>Increases maximum number of Holy Fire Stacks@Holy Fire Stacks:, ${CRUSADING_FLAMES_STEPS.map((step) => `+${step}`).join(", ")}</Description>`,
          ]
        : []),
      "<ModType>Buff</ModType>",
      `<BuffName>${HOLY_FIRE_BUFFS}</BuffName>`,
      "<BuffProperty>StackCount</BuffProperty>",
      `<BuffValue>${CRUSADING_FLAMES_STEPS[rank - 1]}</BuffValue>`,
      "<IconName>a_Signet_RapidRecover</IconName>",
    ],
  ]),
);

/**
 * Empyrean Aura's Expertise extension needs somewhere to live, and a PowerModType is the only
 * shape that reaches a buff's duration.
 *
 * Buff computes its lifetime as the authored Duration plus whatever the mods vector adds, and
 * Buff itself is control-flow obfuscated past recompiling -- so CombatState fabricates a
 * class_140 against this entry at cast time with the milliseconds in place of a magnitude
 * (patch-dungeonblitz-templar-talent-effects). Nothing in NodeTypes offers it, so it is never
 * a stone a player can own, and the authored BuffValue below is never the number that lands.
 *
 * ModID 900 is what the bytecode hardcodes. Renumbering it here silently switches the
 * extension off.
 */
const EMPYREAN_CARRIER_MOD_ID = 900;

MOD_INSERTS.set("EmpyreanExpertise", [
  "<ModName>EmpyreanExpertise</ModName>",
  `<ModID>${EMPYREAN_CARRIER_MOD_ID}</ModID>`,
  "<DisplayName>Empyrean Aura</DisplayName>",
  "<ModType>Buff</ModType>",
  "<BuffName>LeoneanAura1,LeoneanAura2,LeoneanAura3,LeoneanAura4,LeoneanAura5,LeoneanAura6,LeoneanAura7,LeoneanAura8,LeoneanAura9,LeoneanAura10</BuffName>",
  "<BuffProperty>Duration</BuffProperty>",
  "<BuffValue>0</BuffValue>",
  "<IconName>a_Signet_Fortify</IconName>",
]);

/**
 * The talent tree itself. NodeTypes is the map from a tree node to the stone family each
 * master class gets there, and it lives only inside Game.swz -- there is no loose copy under
 * src/client/content/xml, because nothing on the server reads it.
 *
 * Only the Templar's half of node 22 moves. The Sentinel's node 25 still says RapidRecovery
 * and now gets the Tenacity stone that name has always meant.
 */
const NODE_REWIRES: Array<{ nodeId: number; masterClass: string; from: string; to: string }> = [
  { nodeId: 22, masterClass: "Templar", from: "RapidRecovery", to: "CrusadingFlames" },
];

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
      "Deal more damage to Demoralized, Staggered, and Stunned targets@Damage Bonus:, 5%, 10%, 15%, 20%, 25%",
    ],
  ],
  [
    "IgniteCrit1",
    [
      "Gain a Poison Damage bonus against Cursed targets.@Poison Damage Bonus:, 2%, 4%, 6%, 8%, 10%",
      "Gain a Critical Chance bonus vs. Ignited targets@Critical Chance Bonus:, 2%, 4%, 6%, 8%, 10%",
    ],
  ],
  [
    "CrusadingFlames1",
    [
      "Increases maximum number of Holy Fire Stacks@Holy Fire Stacks:, +1, +2, +3, +5, +8",
      "Increases maximum number of Holy Fire Stacks@Holy Fire Stacks:, +1, +2, +3, +4, +5",
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
  // Dominate's magnitudes, halved after the pass that made it a damage stone.
  {
    mod: "Dominate1",
    from: "Deal more damage to Demoralized targets, and twice as much to Staggered or Stunned ones@Damage Bonus:, 10%, 20%, 30%, 40%, 50%",
    to: "Deal more damage to Demoralized, Staggered, and Stunned targets@Damage Bonus:, 5%, 10%, 15%, 20%, 25%",
  },
  // ...and the third pass dropped the doubling itself, so the sentence stops claiming it.
  {
    mod: "Dominate1",
    from: "Deal more damage to Demoralized targets, and twice as much to Staggered or Stunned ones@Damage Bonus:, 5%, 10%, 15%, 20%, 25%",
    to: "Deal more damage to Demoralized, Staggered, and Stunned targets@Damage Bonus:, 5%, 10%, 15%, 20%, 25%",
  },
  // Crusading Flames' top two ranks, brought down to a curve that steps by one.
  {
    mod: "CrusadingFlames1",
    from: "Increases maximum number of Holy Fire Stacks@Holy Fire Stacks:, +1, +2, +3, +5, +8",
    to: "Increases maximum number of Holy Fire Stacks@Holy Fire Stacks:, +1, +2, +3, +4, +5",
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

/**
 * Writes a whole Description, keeping whatever "[Stats: ...]" fence was already on it.
 *
 * The fence belongs to patch_gameswz_power_stat_tooltips, which strips and regenerates it from
 * the power's own fields on every prebuild. Carrying it across rather than dropping it is what
 * keeps this idempotent: drop it and the two scripts would each report a change forever.
 */
function setDescription(block: string, value: string, stats: PatchStats): string {
  const current = block.match(/<Description>([^<]*)<\/Description>/)?.[1];
  if (current === undefined) {
    return block;
  }

  const fence = current.match(/\s*\[Stats:[^\]]*\]\s*$/)?.[0] ?? "";
  return replaceTag(block, "Description", `${value}${fence}`, stats);
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

    const coolDown = COOLDOWNS.get(powerName);
    if (coolDown) {
      touched = true;
      next = replaceTag(next, "CoolDownTime", coolDown, stats);
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

    // Last, so a written-out sentence always wins over the substring maps above whatever
    // state the file was in when this run started.
    const written = POWER_DESCRIPTIONS.get(powerName);
    if (written) {
      touched = true;
      next = setDescription(next, written, stats);
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

    const dotDamage = BUFF_DOT_DAMAGE.get(buffName);
    if (dotDamage) {
      touched = true;
      next = replaceTag(next, "DoTDamage", dotDamage, stats);
    }

    const stackCount = HOLY_FIRE_STACK_COUNTS.get(buffName);
    if (stackCount) {
      touched = true;
      next = replaceTag(next, "StackCount", stackCount, stats);
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

  return { xml: appendNewMods(patched, stats), stats };
}

/**
 * New talentstone families are appended rather than woven in beside their neighbours: the
 * parser walks the list in document order and keys everything by ModName and ModID, so
 * position carries no meaning. Presence is checked by name so a second prebuild is a no-op.
 */
function appendNewMods(xml: string, stats: PatchStats): string {
  const missing = [...MOD_INSERTS.entries()].filter(
    ([modName]) => !xml.includes(`<ModName>${modName}</ModName>`),
  );
  if (!missing.length) {
    return xml;
  }

  const blocks = missing
    .map(([, lines]) => `\t<PowerModType>\r\n\t\t${lines.join("\r\n\t\t")}\r\n\t</PowerModType>\r\n`)
    .join("");

  const closing = xml.lastIndexOf("</PowerModTypes>");
  if (closing < 0) {
    return xml;
  }

  stats.modBlocks += missing.length;
  stats.changes += missing.length;
  return `${xml.slice(0, closing)}${blocks}${xml.slice(closing)}`;
}

/**
 * NodeTypes: which stone family each master class is offered at a given tree node. Matched as
 * a whole element so a rewire cannot land on another class's line, and re-running is a no-op
 * once the new family is in place.
 */
export function patchNodeTypes(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const patched = xml.replace(/<NodeType NodeID="(\d+)">[\s\S]*?<\/NodeType>/g, (block: string, nodeId: string) => {
    let next = block;
    let touched = false;

    for (const rewire of NODE_REWIRES) {
      if (Number(nodeId) !== rewire.nodeId) continue;
      const authored = `<${rewire.masterClass}>${rewire.from}</${rewire.masterClass}>`;
      if (!next.includes(authored)) continue;
      touched = true;
      stats.changes += 1;
      next = next.replace(authored, `<${rewire.masterClass}>${rewire.to}</${rewire.masterClass}>`);
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
    // Only ever in the swz -- there is no src/client/content/xml/NodeTypes.xml to keep in step.
    { marker: "<NodeTypes", patcher: patchNodeTypes },
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
