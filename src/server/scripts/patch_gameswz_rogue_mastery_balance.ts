import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

/**
 * Rogue mastery retune, all three trees.
 *
 * Names on screen and names in the data disagree badly here, so for the record:
 * Executioner is the "Viper" tree, and Shadow Rend is VitalStrike, Withering Impact is
 * WitherStrike, Assassinate is DeathBlowOld, Butcher's Boon is PainBender, Shadow Scythe
 * is Reaper, Carnifex is SoulShatter, Hemorrhage is ProcMassiveTime, Slapdash Decoy is
 * Decoy. Getting one of those wrong retunes a different class's skill.
 *
 * Executioner:
 *   Shadow Rend        more bleed, and armor bane it never had
 *   Assassinate        Melee -> Cleave with a 150 radius, so it is an AoE
 *   Mist Walk          armor bane from the first rank, two stacks at rank 8
 *   Withering Impact   rank 3's armor bane becomes poison; rank 10's two banes
 *                      become six stacks of bleed
 *
 * Soulthief:
 *   Soul Reaver        self-heal halved
 *   Butcher's Boon     damage x1.25
 *   Shadow Scythe      damage x1.25
 *   Carnifex           adds Stagger
 *   Insidious Poison   trimmed at the top ranks
 *
 * Rogue:
 *   Slapdash Decoy     armor bane removed from the explosion
 *
 * Viperblade, the Executioner discipline passive, is data rather than code because the
 * player's basic attacks turned out not to exist: the Rogue EntType authors no MeleePower
 * or RangedPower, so Entity.GetMeleePower returns null and a rogue's "attacks" are simply
 * the powers in their kit. That makes the passive expressible as an extra stack on every
 * Executioner power -- Bleed on the close ones, Poison on the ranged two -- and scoped to
 * the tree by construction, which a buff on a shared basic attack could never be.
 *
 * Hemorrhage gets a small defense debuff on top of its damage, which needed checking
 * rather than assuming: PowerModType parses BuffProperty and BuffValue as parallel
 * comma lists (class_17 rejects the pair when the lengths disagree), and CombatState adds
 * the mod on top of the BuffType's own field rather than scaling it -- so a property the
 * buff never authored still lands, because BuffType defaults it to 0 rather than NaN.
 * method_59 then sums across every mod the player owns, which is why per-rank values of
 * 0.5/0.75/1/1.5/2 add up to the ~6% at 15 points that was asked for.
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

// Generated from the authored values; comments show what each replaces.
const TARGET_BUFFS = new Map<string, string>([
  // Shadow Rend
  ["VitalStrike", "Bleeding,Bleeding,Bleeding,ArmorBane"], // was Bleeding,Bleeding
  ["VitalStrike1", "Bleeding,Bleeding,Bleeding,ArmorBane"], // was Bleeding,Bleeding
  ["VitalStrike2", "Bleeding,Bleeding,Bleeding,ArmorBane,Crippled"], // was Bleeding,Bleeding,Crippled
  ["VitalStrike3", "Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,Crippled"], // was Bleeding,Bleeding,Crippled
  ["VitalStrike4", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,Crippled"], // was Bleeding,Bleeding,Bleeding,Bleeding,Crippled
  ["VitalStrike5", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled"], // was Bleeding,Bleeding,Bleeding,Bleeding,Crippled
  ["VitalStrike6", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled,Crippled"], // was Bleeding,Bleeding,Bleeding,Bleeding,Crippled,Crippled
  ["VitalStrike7", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled,Crippled"], // was Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Crippled,Crippled
  ["VitalStrike8", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled,Crippled"], // was Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Crippled,Crippled
  ["VitalStrike9", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,ArmorBane,Crippled,Crippled"], // was Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Crippled,Crippled
  ["VitalStrike10", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,ArmorBane,Crippled,Crippled"], // was Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Crippled,Crippled
  // Withering Impact
  ["WitherStrike3", "First:PoisonStrike,Weakened,Bleeding,Bleeding"], // was First:ArmorBane,Weakened,Bleeding,Bleeding
  ["WitherStrike4", "First:PoisonStrike,Weakened,Bleeding,Bleeding,Bleeding"], // was First:ArmorBane,Weakened,Bleeding,Bleeding,Bleeding
  ["WitherStrike5", "First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding"], // was First:ArmorBane,Weakened,Weakened,Bleeding,Bleeding,Bleeding
  ["WitherStrike6", "First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding"], // was First:ArmorBane,Weakened,Weakened,Bleeding,Bleeding,Bleeding
  ["WitherStrike7", "First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding"], // was First:ArmorBane,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding
  ["WitherStrike8", "First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding"], // was First:ArmorBane,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding
  ["WitherStrike9", "First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding"], // was First:ArmorBane,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding
  ["WitherStrike10", "First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding"], // was First:ArmorBane,ArmorBane,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding
  // Mist Walk
  ["MistWalkClose", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate,ArmorBane"], // was Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate
  ["MistWalkClose1", "Bleeding,Bleeding,Bleeding,Intimidate45,ArmorBane"], // was Bleeding,Bleeding,Bleeding,Intimidate45
  ["MistWalkClose2", "Bleeding,Bleeding,Bleeding,Bleeding,Intimidate45,ArmorBane"], // was Bleeding,Bleeding,Bleeding,Bleeding,Intimidate45
  ["MistWalkClose3", "Bleeding,Bleeding,Bleeding,Bleeding,Intimidate45,ArmorBane"], // was Bleeding,Bleeding,Bleeding,Bleeding,Intimidate45
  ["MistWalkClose4", "Bleeding,Bleeding,Bleeding,Bleeding,Intimidate50,ArmorBane"], // was Bleeding,Bleeding,Bleeding,Bleeding,Intimidate50
  ["MistWalkClose5", "Bleeding,Bleeding,Bleeding,Bleeding,Intimidate50,ArmorBane"], // was Bleeding,Bleeding,Bleeding,Bleeding,Intimidate50
  ["MistWalkClose6", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate50,ArmorBane"], // was Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate50
  ["MistWalkClose7", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate55,ArmorBane"], // was Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate55
  ["MistWalkClose8", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate55,ArmorBane,ArmorBane"], // was Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate55
  ["MistWalkClose9", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate60,ArmorBane,ArmorBane"], // was Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate60
  ["MistWalkClose10", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate,ArmorBane,ArmorBane"], // was Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate
  // Slapdash Decoy
  ["DecoyExplode10", "PoisonStrike,Crippled,Crippled,Bleeding,Bleeding,Bleeding,Blinded,Weakened"], // was PoisonStrike,Crippled,Crippled,Bleeding,Bleeding,Bleeding,Blinded,Weakened,ArmorBane
  // Carnifex
  ["SoulShatter", "First:Bound,Staggered"], // was First:Bound
  ["SoulShatter1", "First:Bound,Staggered"], // was First:Bound
  ["SoulShatter2", "First:Bound,Staggered"], // was First:Bound
  ["SoulShatter3", "First:Bound,Staggered"], // was First:Bound
  ["SoulShatter4", "First:Bound,Staggered"], // was First:Bound
  ["SoulShatter5", "First:Bound,Staggered"], // was First:Bound
  ["SoulShatter6", "First:Bound,Staggered"], // was First:Bound
  ["SoulShatter7", "First:Bound,Staggered"], // was First:Bound
  ["SoulShatter8", "First:Bound,Staggered"], // was First:Bound
  ["SoulShatter9", "First:Bound,Staggered"], // was First:Bound
  ["SoulShatter10", "First:Bound,Staggered"], // was First:Bound
]);

// Viperblade: the Executioner discipline passive. Close attacks carry one extra
// stack of Bleed, ranged attacks one extra stack of Poison. Folded into the absolute
// value rather than appended at runtime, so re-running cannot stack it again.
const VIPERBLADE_BUFFS = new Map<string, string>([
  // SeverStrike (Melee) +Bleeding
  ["SeverStrike", "Bleeding,Bleeding"], // was 'Bleeding'
  ["SeverStrike1", "Bleeding,Bleeding"], // was 'Bleeding'
  ["SeverStrike2", "Bleeding,Bleeding"], // was 'Bleeding'
  ["SeverStrike3", "Bleeding,Bleeding"], // was 'Bleeding'
  ["SeverStrike4", "Bleeding,Bleeding"], // was 'Bleeding'
  ["SeverStrike5", "Bleeding,Bleeding,Bleeding"], // was 'Bleeding,Bleeding'
  ["SeverStrike6", "Bleeding,Bleeding,Bleeding"], // was 'Bleeding,Bleeding'
  ["SeverStrike7", "Bleeding,Bleeding,Bleeding"], // was 'Bleeding,Bleeding'
  ["SeverStrike8", "Bleeding,Bleeding,Bleeding"], // was 'Bleeding,Bleeding'
  ["SeverStrike9", "Bleeding,Bleeding,Bleeding"], // was 'Bleeding,Bleeding'
  ["SeverStrike10", "Bleeding,Bleeding,Bleeding"], // was 'Bleeding,Bleeding'
  // WitherStrike (Melee) +Bleeding
  ["WitherStrike", "First:Weakened,Bleeding,Bleeding,Bleeding"], // was 'First:Weakened,Bleeding,Bleeding'
  ["WitherStrike1", "First:Weakened,Bleeding,Bleeding,Bleeding"], // was 'First:Weakened,Bleeding,Bleeding'
  ["WitherStrike2", "First:Weakened,Bleeding,Bleeding,Bleeding"], // was 'First:Weakened,Bleeding,Bleeding'
  ["WitherStrike3", "First:PoisonStrike,Weakened,Bleeding,Bleeding,Bleeding"], // was 'First:PoisonStrike,Weakened,Bleeding,Bleeding'
  ["WitherStrike4", "First:PoisonStrike,Weakened,Bleeding,Bleeding,Bleeding,Bleeding"], // was 'First:PoisonStrike,Weakened,Bleeding,Bleeding,Bleeding'
  ["WitherStrike5", "First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding"], // was 'First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding'
  ["WitherStrike6", "First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding"], // was 'First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding'
  ["WitherStrike7", "First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding"], // was 'First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding'
  ["WitherStrike8", "First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding"], // was 'First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding'
  ["WitherStrike9", "First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding"], // was 'First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding'
  ["WitherStrike10", "First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding"], // was 'First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding'
  // AssassinateClose (Melee) +Bleeding
  ["AssassinateClose", "Bleeding,Bleeding"], // was 'Bleeding'
  ["AssassinateClose1", "Bleeding,Bleeding"], // was 'Bleeding'
  ["AssassinateClose2", "Bleeding,Bleeding"], // was 'Bleeding'
  ["AssassinateClose3", "Bleeding,Bleeding"], // was 'Bleeding'
  ["AssassinateClose4", "Bleeding,Bleeding"], // was 'Bleeding'
  ["AssassinateClose5", "Bleeding,Bleeding"], // was 'Bleeding'
  ["AssassinateClose6", "Bleeding,Bleeding"], // was 'Bleeding'
  ["AssassinateClose7", "Bleeding,Bleeding"], // was 'Bleeding'
  ["AssassinateClose8", "Bleeding,Bleeding"], // was 'Bleeding'
  ["AssassinateClose9", "Bleeding,Bleeding"], // was 'Bleeding'
  ["AssassinateClose10", "Bleeding,Bleeding,Bleeding"], // was 'Bleeding,Bleeding'
  // ShadowBlade (Melee) +Bleeding
  ["ShadowBlade", "Bleeding"], // was ''
  ["ShadowBlade1", "Bleeding"], // was ''
  ["ShadowBlade2", "Bleeding"], // was ''
  ["ShadowBlade3", "Bleeding"], // was ''
  ["ShadowBlade4", "Bleeding"], // was ''
  ["ShadowBlade5", "Bleeding"], // was ''
  ["ShadowBlade6", "Bleeding"], // was ''
  ["ShadowBlade7", "Bleeding"], // was ''
  ["ShadowBlade8", "Bleeding"], // was ''
  ["ShadowBlade9", "Bleeding"], // was ''
  ["ShadowBlade10", "Bleeding"], // was ''
  // SeekingBladesAttack (Melee) +Bleeding
  ["SeekingBladesAttack", "Bleeding"], // was ''
  ["SeekingBladesAttack1", "Bleeding"], // was ''
  ["SeekingBladesAttack2", "Bleeding"], // was ''
  ["SeekingBladesAttack3", "Bleeding,Bleeding"], // was 'Bleeding'
  ["SeekingBladesAttack4", "Bleeding,Bleeding"], // was 'Bleeding'
  ["SeekingBladesAttack5", "Bleeding,Bleeding"], // was 'Bleeding'
  ["SeekingBladesAttack6", "Bleeding,Bleeding,Bleeding"], // was 'Bleeding,Bleeding'
  ["SeekingBladesAttack7", "Bleeding,Bleeding,Bleeding"], // was 'Bleeding,Bleeding'
  ["SeekingBladesAttack8", "Bleeding,Bleeding,Bleeding,Bleeding"], // was 'Bleeding,Bleeding,Bleeding'
  ["SeekingBladesAttack9", "Bleeding,Bleeding,Bleeding,Bleeding"], // was 'Bleeding,Bleeding,Bleeding'
  ["SeekingBladesAttack10", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Bleeding'
  // VitalStrike (Cleave) +Bleeding
  ["VitalStrike", "Bleeding,Bleeding,Bleeding,ArmorBane,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,ArmorBane'
  ["VitalStrike1", "Bleeding,Bleeding,Bleeding,ArmorBane,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,ArmorBane'
  ["VitalStrike2", "Bleeding,Bleeding,Bleeding,ArmorBane,Crippled,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,ArmorBane,Crippled'
  ["VitalStrike3", "Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,Crippled,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,Crippled'
  ["VitalStrike4", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,Crippled,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,Crippled'
  ["VitalStrike5", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled'
  ["VitalStrike6", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled,Crippled,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled,Crippled'
  ["VitalStrike7", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled,Crippled,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled,Crippled'
  ["VitalStrike8", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled,Crippled,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled,Crippled'
  ["VitalStrike9", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,ArmorBane,Crippled,Crippled,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,ArmorBane,Crippled,Crippled'
  ["VitalStrike10", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,ArmorBane,Crippled,Crippled,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,ArmorBane,Crippled,Crippled'
  // DeathBlowOld (Cleave) +Bleeding
  ["DeathBlowOld", "PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding"], // was 'PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding'
  ["DeathBlowOld1", "PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding"], // was 'PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding'
  ["DeathBlowOld2", "PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding"], // was 'PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding'
  ["DeathBlowOld3", "PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding"], // was 'PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding'
  ["DeathBlowOld4", "PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding"], // was 'PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding'
  ["DeathBlowOld5", "PoisonStrike,PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding"], // was 'PoisonStrike,PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding'
  ["DeathBlowOld6", "PoisonStrike,PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding"], // was 'PoisonStrike,PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding'
  ["DeathBlowOld7", "PoisonStrike,PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding"], // was 'PoisonStrike,PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding'
  ["DeathBlowOld8", "PoisonStrike,PoisonStrike,PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding"], // was 'PoisonStrike,PoisonStrike,PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding'
  ["DeathBlowOld9", "PoisonStrike,PoisonStrike,PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding"], // was 'PoisonStrike,PoisonStrike,PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding'
  ["DeathBlowOld10", "PoisonStrike,PoisonStrike,PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding"], // was 'PoisonStrike,PoisonStrike,PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding'
  // MistWalkClose (PBAoE) +Bleeding
  ["MistWalkClose", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate,ArmorBane,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate,ArmorBane'
  ["MistWalkClose1", "Bleeding,Bleeding,Bleeding,Intimidate45,ArmorBane,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Intimidate45,ArmorBane'
  ["MistWalkClose2", "Bleeding,Bleeding,Bleeding,Bleeding,Intimidate45,ArmorBane,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Intimidate45,ArmorBane'
  ["MistWalkClose3", "Bleeding,Bleeding,Bleeding,Bleeding,Intimidate45,ArmorBane,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Intimidate45,ArmorBane'
  ["MistWalkClose4", "Bleeding,Bleeding,Bleeding,Bleeding,Intimidate50,ArmorBane,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Intimidate50,ArmorBane'
  ["MistWalkClose5", "Bleeding,Bleeding,Bleeding,Bleeding,Intimidate50,ArmorBane,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Intimidate50,ArmorBane'
  ["MistWalkClose6", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate50,ArmorBane,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate50,ArmorBane'
  ["MistWalkClose7", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate55,ArmorBane,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate55,ArmorBane'
  ["MistWalkClose8", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate55,ArmorBane,ArmorBane,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate55,ArmorBane,ArmorBane'
  ["MistWalkClose9", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate60,ArmorBane,ArmorBane,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate60,ArmorBane,ArmorBane'
  ["MistWalkClose10", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate,ArmorBane,ArmorBane,Bleeding"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate,ArmorBane,ArmorBane'
  // DaggerFlurry (RangedAoE) +PoisonStrike
  ["DaggerFlurry", "DaggerPoison,PoisonStrike"], // was 'DaggerPoison'
  ["DaggerFlurry1", "DaggerPoison,PoisonStrike"], // was 'DaggerPoison'
  ["DaggerFlurry2", "DaggerPoison,PoisonStrike"], // was 'DaggerPoison'
  ["DaggerFlurry3", "DaggerPoison,PoisonStrike"], // was 'DaggerPoison'
  ["DaggerFlurry4", "DaggerPoison,PoisonStrike"], // was 'DaggerPoison'
  ["DaggerFlurry5", "DaggerPoison,DaggerPoison,PoisonStrike"], // was 'DaggerPoison,DaggerPoison'
  ["DaggerFlurry6", "DaggerPoison,DaggerPoison,PoisonStrike"], // was 'DaggerPoison,DaggerPoison'
  ["DaggerFlurry7", "DaggerPoison,DaggerPoison,PoisonStrike"], // was 'DaggerPoison,DaggerPoison'
  ["DaggerFlurry8", "DaggerPoison,DaggerPoison,PoisonStrike"], // was 'DaggerPoison,DaggerPoison'
  ["DaggerFlurry9", "DaggerPoison,DaggerPoison,PoisonStrike"], // was 'DaggerPoison,DaggerPoison'
  ["DaggerFlurry10", "DaggerPoison,DaggerPoison,ArmorBane,PoisonStrike"], // was 'DaggerPoison,DaggerPoison,ArmorBane'
  // PoisonDagger (ProjectilePlayer) +PoisonStrike
  ["PoisonDagger", "PoisonStrike"], // was ''
  ["PoisonDagger1", "PoisonStrike"], // was ''
]);

const DAMAGE_MULTS = new Map<string, string>([
  // Butcher's Boon, x1.25
  ["PainBender", "3.12"], // 2.5
  ["PainBender1", "3.12"], // 2.5
  ["PainBender2", "3.25"], // 2.6
  ["PainBender3", "3.38"], // 2.7
  ["PainBender4", "3.38"], // 2.7
  ["PainBender5", "3.56"], // 2.85
  ["PainBender6", "3.75"], // 3.0
  ["PainBender7", "3.75"], // 3.0
  ["PainBender8", "4.0"], // 3.2
  ["PainBender9", "4.35"], // 3.48
  ["PainBender10", "4.35"], // 3.48
  // Shadow Scythe, x1.25
  ["Reaper", "1.62"], // 1.3
  ["Reaper1", "1.62"], // 1.3
  ["Reaper2", "1.75"], // 1.4
  ["Reaper3", "1.94"], // 1.55
  ["Reaper4", "2.12"], // 1.7
  ["Reaper5", "2.12"], // 1.7
  ["Reaper6", "2.31"], // 1.85
  ["Reaper7", "2.31"], // 1.85
  ["Reaper8", "2.5"], // 2.0
  ["Reaper9", "2.5"], // 2.0
  ["Reaper10", "2.5"], // 2.0
]);


// Assassinate becomes an AoE. Cleave is what Shadow Rend already uses, and the radius is
// sized to its own 140 reach rather than invented.
const ASSASSINATE_RANKS = ["DeathBlowOld", ...Array.from({ length: 10 }, (_, i) => `DeathBlowOld${i + 1}`)];
const ASSASSINATE_AOE_RADIUS = "150";

// Soul Reaver heals the caster through a negative DoT. Halved, rounded to the same
// precision the file already uses.
const SOUL_REAVER_SELF_HEAL = new Map<string, string>([
  ["SoulReaverSelf1", "-2.597"], //   -5.194
  ["SoulReaverSelf2", "-2.597"], //   -5.194
  ["SoulReaverSelf3", "-3.117"], //   -6.233
  ["SoulReaverSelf4", "-3.117"], //   -6.233
  ["SoulReaverSelf5", "-3.556"], //   -7.112
  ["SoulReaverSelf6", "-3.556"], //   -7.112
  ["SoulReaverSelf7", "-4.475"], //   -8.95
  ["SoulReaverSelf8", "-4.475"], //   -8.95
  ["SoulReaverSelf9", "-4.875"], //   -9.749
  ["SoulReaverSelf10", "-5.242"], // -10.484
]);

// Rank upgrade text has to move with the effect or it starts lying.
const UPGRADE_TEXT = new Map<string, [string, string]>([
  ["WitherStrike3", ["Adds a stack of Armor Bane.", "Adds a stack of Poison."]],
  // Shadow Rend's stack counts moved, so the ranks that quote them have to move too.
  [
    "VitalStrike1",
    [
      "Dash forward, damaging and applying 2 stacks of Bleed to every enemy in your path.",
      "Dash forward, damaging and applying 3 stacks of Bleed and a stack of Armor Bane to every enemy in your path.",
    ],
  ],
  ["VitalStrike4", ["Deals 4 stacks of Bleed.", "Deals 5 stacks of Bleed."]],
  ["VitalStrike5", ["Grants 45% Dash Armor.", "Grants 45% Dash Armor. Deals 2 stacks of Armor Bane."]],
  ["VitalStrike7", ["Deals 5 stacks of Bleed.", "Deals 6 stacks of Bleed."]],
  ["VitalStrike8", ["Increased Damage", "Deals 7 stacks of Bleed. Increased Damage"]],
  ["VitalStrike9", ["-2 Mana Cost.", "-2 Mana Cost. Deals 3 stacks of Armor Bane."]],
  ["VitalStrike10", ["Deals 5 stacks of Bleed.", "Deals 8 stacks of Bleed."]],
  ["WitherStrike10", ["Deals 2 stacks of Armor Bane.", "Deals 6 stacks of Bleed."]],
  [
    "MistWalk1",
    [
      "Dash and apply an AoE 45% Strength Debuff with 3 stacks of Bleed. Grants 50% Dash Armor.",
      "Dash and apply an AoE 45% Strength Debuff with 3 stacks of Bleed and a stack of Armor Bane. Grants 50% Dash Armor.",
    ],
  ],
]);

// Hemorrhage: keep the authored damage ranks, append the defense debuff as a parallel
// property. Values are per rank and the game sums the ranks a player owns.
const HEMORRHAGE_RANKS: Array<{ mod: string; dot: string; defense: string }> = [
  { mod: "Hemorrhage1", dot: ".01", defense: "-.005" },
  { mod: "Hemorrhage2", dot: ".03", defense: "-.0075" },
  { mod: "Hemorrhage3", dot: ".06", defense: "-.01" },
  { mod: "Hemorrhage4", dot: ".1", defense: "-.015" },
  { mod: "Hemorrhage5", dot: ".15", defense: "-.02" },
];

// Insidious Poison, trimmed where it actually bit: the top three ranks.
const INSIDIOUS_POISON = new Map<string, string>([
  ["InsidiousPoison1", ".02"], // .02
  ["InsidiousPoison2", ".05"], // .06
  ["InsidiousPoison3", ".11"], // .13
  ["InsidiousPoison4", ".19"], // .23
  ["InsidiousPoison5", ".28"], // .35
]);

const MOD_DESCRIPTIONS = new Map<string, [string, string]>([
  [
    "Hemorrhage1",
    [
      "Increases Hemorrhage Critical Effect@Hemorrhage Damage:, +1%, +3%, +6%, 10%, 15%",
      "Increases Hemorrhage Critical Effect and weakens the target's defense@Hemorrhage Damage:, +1%, +3%, +6%, 10%, 15%@Defense Debuff:, 0.5%, 0.75%, 1%, 1.5%, 2%",
    ],
  ],
  [
    "InsidiousPoison1",
    [
      "Increases Poison Damage vs. Bound targets@Poison vs Bound:, +2%, +6%, +13%, +23%, +35%",
      "Increases Poison Damage vs. Bound targets@Poison vs Bound:, +2%, +5%, +11%, +19%, +28%",
    ],
  ],
]);

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

export function patchPlayerPowers(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const patched = xml.replace(/<Power PowerName="([^"]+)">[\s\S]*?<\/Power>/g, (block: string, powerName: string) => {
    let next = block;
    let touched = false;

    // Viperblade is generated on top of the retune, so where both name a power its value
    // is the finished one and wins.
    const targetBuff = VIPERBLADE_BUFFS.get(powerName) ?? TARGET_BUFFS.get(powerName);
    if (targetBuff) {
      touched = true;
      // ShadowBlade and PoisonDagger author no AddTargetBuff at all, and the template puts
      // it after PowerGroup, so it is inserted rather than replaced.
      if (/<AddTargetBuff>[^<]*<\/AddTargetBuff>/.test(next)) {
        next = replaceTag(next, "AddTargetBuff", targetBuff, stats);
      } else {
        next = next.replace(/(<PowerGroup>[^<]*<\/PowerGroup>)/, (match) => {
          stats.changes += 1;
          return `${match}\r\n\t\t<AddTargetBuff>${targetBuff}</AddTargetBuff>`;
        });
      }
    }

    const damageMult = DAMAGE_MULTS.get(powerName);
    if (damageMult) {
      touched = true;
      next = replaceTag(next, "BaseDamageMult", damageMult, stats);
    }

    if (ASSASSINATE_RANKS.includes(powerName)) {
      touched = true;
      next = replaceTag(next, "TargetMethod", "Cleave", stats);
      // The authored block has no AoERadius at all, and the template orders it right after
      // Range, so it is inserted rather than replaced.
      if (/<AoERadius>[^<]*<\/AoERadius>/.test(next)) {
        next = replaceTag(next, "AoERadius", ASSASSINATE_AOE_RADIUS, stats);
      } else {
        next = next.replace(/(<Range>[^<]*<\/Range>)/, (match) => {
          stats.changes += 1;
          return `${match}\r\n\t\t<AoERadius>${ASSASSINATE_AOE_RADIUS}</AoERadius>`;
        });
      }
    }

    // Some replacements append to the text they match ("Increased Damage" ->
    // "Deals 7 stacks of Bleed. Increased Damage"), so matching the old text is not enough
    // to know the edit is still pending -- the second prebuild would stack it again.
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
    const heal = SOUL_REAVER_SELF_HEAL.get(buffName);
    if (!heal) {
      return block;
    }

    stats.buffBlocks += 1;
    return replaceTag(block, "DoTDamage", heal, stats);
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

    const hemorrhage = HEMORRHAGE_RANKS.find((rank) => rank.mod === modName);
    if (hemorrhage) {
      touched = true;
      next = replaceTag(next, "BuffProperty", "DoTDamage,MeleeDefense,MagicDefense", stats);
      next = replaceTag(next, "BuffValue", `${hemorrhage.dot},${hemorrhage.defense},${hemorrhage.defense}`, stats);
    }

    const insidious = INSIDIOUS_POISON.get(modName);
    if (insidious) {
      touched = true;
      next = replaceTag(next, "BuffValue", insidious, stats);
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

export function patchConfiguredRogueMasteryBalance(verifyOnly: boolean): PatchStats {
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
    const stats = patchConfiguredRogueMasteryBalance(verifyOnly);
    console.log(JSON.stringify({ verifyOnly, stats }, null, 2));
    console.log(stats.changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_gameswz_rogue_mastery_balance] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
