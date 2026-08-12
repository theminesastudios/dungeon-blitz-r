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
 *   Assassinate        Melee -> Cleave with a 200 radius, so it is an AoE
 *   Mist Walk          armor bane from the first rank, two stacks at rank 8
 *   Withering Impact   rank 3's armor bane becomes poison; rank 10's two banes
 *                      become six stacks of bleed
 *
 * Soulthief:
 *   Soul Reaver        self-heal halved
 *   Butcher's Boon     damage x1.25, Bound-target Expertise bonus x3
 *   Shadow Scythe      damage x1.25, Bound-target Expertise bonus x6,
 *                      Armor Bane from rank 4
 *   Carnifex           adds Stagger
 *   Insidious Poison   trimmed at the top ranks
 *
 * Rogue:
 *   Slapdash Decoy     armor bane removed from the explosion
 *
 * Viperblade's Bone Daggers keep their Poison DoT as the discipline's ranged basic attack.
 * The former blanket passive is removed from actual skills: melee skills gain no extra
 * Bleed and ranged skills gain no extra Poison.
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
  // Assassinate. Ranks 7 and 9 inherit the preceding rank's status effects.
  ["DeathBlowOld1", "PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding"],
  ["DeathBlowOld2", "PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding"],
  ["DeathBlowOld3", "PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding"],
  ["DeathBlowOld4", "PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding"],
  ["DeathBlowOld5", "PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding"],
  ["DeathBlowOld6", "PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding"],
  ["DeathBlowOld7", "PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding"],
  ["DeathBlowOld8", "PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding"],
  ["DeathBlowOld9", "PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding"],
  ["DeathBlowOld10", "PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding"],
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
  // Chaos Wave -- the poison comes off. ChaosArmor is Chaos Wave on screen; rank 4 was the
  // rank that added it and every rank above inherited it.
  ["ChaosArmor4", "Bound,ChaosWeaken"], // was Bound,ChaosWeaken,ChaosPoison
  ["ChaosArmor5", "Bound,ChaosWeaken"], // was Bound,ChaosWeaken,ChaosPoison
  ["ChaosArmor6", "Bound,ChaosWeaken"], // was Bound,ChaosWeaken,ChaosPoison
  ["ChaosArmor7", "Bound,ChaosWeaken"], // was Bound,ChaosWeaken,ChaosPoison
  ["ChaosArmor8", "Bound,ChaosWeaken"], // was Bound,ChaosWeaken,ChaosPoison
  ["ChaosArmor9", "Bound,ChaosWeaken"], // was Bound,ChaosWeaken,ChaosPoison
  ["ChaosArmor10", "Bound,ChaosWeaken"], // was Bound,ChaosWeaken,ChaosPoison
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
  // Shadow Scythe gains Armor Bane at rank 4 and retains it at later ranks.
  ["Reaper4", "ArmorBane"],
  ["Reaper5", "ArmorBane"],
  ["Reaper6", "ArmorBane"],
  ["Reaper7", "ArmorBane"],
  ["Reaper8", "ArmorBane"],
  ["Reaper9", "ArmorBane"],
  ["Reaper10", "ArmorBane"],
]);

// Legacy Viperblade payloads. Bone Daggers retain ViperbladePoison; every other entry is
// migration input used to restore each skill's normal authored/retuned buff list.
const VIPERBLADE_BUFFS = new Map<string, string>([
  // SeverStrike (Melee) +Bleeding
  ["SeverStrike", "Bleeding,ViperbladeBleed"], // was 'Bleeding'
  ["SeverStrike1", "Bleeding,ViperbladeBleed"], // was 'Bleeding'
  ["SeverStrike2", "Bleeding,ViperbladeBleed"], // was 'Bleeding'
  ["SeverStrike3", "Bleeding,ViperbladeBleed"], // was 'Bleeding'
  ["SeverStrike4", "Bleeding,ViperbladeBleed"], // was 'Bleeding'
  ["SeverStrike5", "Bleeding,Bleeding,ViperbladeBleed"], // was 'Bleeding,Bleeding'
  ["SeverStrike6", "Bleeding,Bleeding,ViperbladeBleed"], // was 'Bleeding,Bleeding'
  ["SeverStrike7", "Bleeding,Bleeding,ViperbladeBleed"], // was 'Bleeding,Bleeding'
  ["SeverStrike8", "Bleeding,Bleeding,ViperbladeBleed"], // was 'Bleeding,Bleeding'
  ["SeverStrike9", "Bleeding,Bleeding,ViperbladeBleed"], // was 'Bleeding,Bleeding'
  ["SeverStrike10", "Bleeding,Bleeding,ViperbladeBleed"], // was 'Bleeding,Bleeding'
  // WitherStrike (Melee) +Bleeding
  ["WitherStrike", "First:Weakened,Bleeding,Bleeding,ViperbladeBleed"], // was 'First:Weakened,Bleeding,Bleeding'
  ["WitherStrike1", "First:Weakened,Bleeding,Bleeding,ViperbladeBleed"], // was 'First:Weakened,Bleeding,Bleeding'
  ["WitherStrike2", "First:Weakened,Bleeding,Bleeding,ViperbladeBleed"], // was 'First:Weakened,Bleeding,Bleeding'
  ["WitherStrike3", "First:PoisonStrike,Weakened,Bleeding,Bleeding,ViperbladeBleed"], // was 'First:PoisonStrike,Weakened,Bleeding,Bleeding'
  ["WitherStrike4", "First:PoisonStrike,Weakened,Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // was 'First:PoisonStrike,Weakened,Bleeding,Bleeding,Bleeding'
  ["WitherStrike5", "First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // was 'First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding'
  ["WitherStrike6", "First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // was 'First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding'
  ["WitherStrike7", "First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // was 'First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding'
  ["WitherStrike8", "First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // was 'First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding'
  ["WitherStrike9", "First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // was 'First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding'
  ["WitherStrike10", "First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // was 'First:PoisonStrike,Weakened,Weakened,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding'
  // AssassinateClose (Melee) +Bleeding
  ["AssassinateClose", "Bleeding,ViperbladeBleed"], // was 'Bleeding'
  ["AssassinateClose1", "Bleeding,ViperbladeBleed"], // was 'Bleeding'
  ["AssassinateClose2", "Bleeding,ViperbladeBleed"], // was 'Bleeding'
  ["AssassinateClose3", "Bleeding,ViperbladeBleed"], // was 'Bleeding'
  ["AssassinateClose4", "Bleeding,ViperbladeBleed"], // was 'Bleeding'
  ["AssassinateClose5", "Bleeding,ViperbladeBleed"], // was 'Bleeding'
  ["AssassinateClose6", "Bleeding,ViperbladeBleed"], // was 'Bleeding'
  ["AssassinateClose7", "Bleeding,ViperbladeBleed"], // was 'Bleeding'
  ["AssassinateClose8", "Bleeding,ViperbladeBleed"], // was 'Bleeding'
  ["AssassinateClose9", "Bleeding,ViperbladeBleed"], // was 'Bleeding'
  ["AssassinateClose10", "Bleeding,Bleeding,ViperbladeBleed"], // was 'Bleeding,Bleeding'
  // ShadowBlade (Melee) +Bleeding
  ["ShadowBlade", "ViperbladeBleed"], // was ''
  ["ShadowBlade1", "ViperbladeBleed"], // was ''
  ["ShadowBlade2", "ViperbladeBleed"], // was ''
  ["ShadowBlade3", "ViperbladeBleed"], // was ''
  ["ShadowBlade4", "ViperbladeBleed"], // was ''
  ["ShadowBlade5", "ViperbladeBleed"], // was ''
  ["ShadowBlade6", "ViperbladeBleed"], // was ''
  ["ShadowBlade7", "ViperbladeBleed"], // was ''
  ["ShadowBlade8", "ViperbladeBleed"], // was ''
  ["ShadowBlade9", "ViperbladeBleed"], // was ''
  ["ShadowBlade10", "ViperbladeBleed"], // was ''
  // SeekingBladesAttack (Melee) +Bleeding
  ["SeekingBladesAttack", "ViperbladeBleed"], // was ''
  ["SeekingBladesAttack1", "ViperbladeBleed"], // was ''
  ["SeekingBladesAttack2", "ViperbladeBleed"], // was ''
  ["SeekingBladesAttack3", "Bleeding,ViperbladeBleed"], // was 'Bleeding'
  ["SeekingBladesAttack4", "Bleeding,ViperbladeBleed"], // was 'Bleeding'
  ["SeekingBladesAttack5", "Bleeding,ViperbladeBleed"], // was 'Bleeding'
  ["SeekingBladesAttack6", "Bleeding,Bleeding,ViperbladeBleed"], // was 'Bleeding,Bleeding'
  ["SeekingBladesAttack7", "Bleeding,Bleeding,ViperbladeBleed"], // was 'Bleeding,Bleeding'
  ["SeekingBladesAttack8", "Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding'
  ["SeekingBladesAttack9", "Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding'
  ["SeekingBladesAttack10", "Bleeding,Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Bleeding'
  // VitalStrike (Cleave) +Bleeding
  ["VitalStrike", "Bleeding,Bleeding,Bleeding,ArmorBane,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,ArmorBane'
  ["VitalStrike1", "Bleeding,Bleeding,Bleeding,ArmorBane,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,ArmorBane'
  ["VitalStrike2", "Bleeding,Bleeding,Bleeding,ArmorBane,Crippled,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,ArmorBane,Crippled'
  ["VitalStrike3", "Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,Crippled,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,Crippled'
  ["VitalStrike4", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,Crippled,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,Crippled'
  ["VitalStrike5", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled'
  ["VitalStrike6", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled,Crippled,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled,Crippled'
  ["VitalStrike7", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled,Crippled,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled,Crippled'
  ["VitalStrike8", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled,Crippled,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,Crippled,Crippled'
  ["VitalStrike9", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,ArmorBane,Crippled,Crippled,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,ArmorBane,Crippled,Crippled'
  ["VitalStrike10", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,ArmorBane,Crippled,Crippled,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ArmorBane,ArmorBane,ArmorBane,Crippled,Crippled'
  // DeathBlowOld (Cleave) +Bleeding
  ["DeathBlowOld", "PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // was 'PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding'
  ["DeathBlowOld1", "PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // was 'PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding'
  ["DeathBlowOld2", "PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // was 'PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding'
  ["DeathBlowOld3", "PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // was 'PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding'
  ["DeathBlowOld4", "PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // was 'PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding'
  ["DeathBlowOld5", "PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // one Poison, 1 Armor Bane, 4 Bleed
  ["DeathBlowOld6", "PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // one Poison, 2 Armor Bane, 6 Bleed
  ["DeathBlowOld7", "PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // inherits rank 6
  ["DeathBlowOld8", "PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // one Poison, 2 Armor Bane, 7 Bleed
  ["DeathBlowOld9", "PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // inherits rank 8
  ["DeathBlowOld10", "PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,ViperbladeBleed"], // one Poison, 2 Armor Bane, 8 Bleed
  // MistWalkClose (PBAoE) +Bleeding
  ["MistWalkClose", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate,ArmorBane,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate,ArmorBane'
  ["MistWalkClose1", "Bleeding,Bleeding,Bleeding,Intimidate45,ArmorBane,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Intimidate45,ArmorBane'
  ["MistWalkClose2", "Bleeding,Bleeding,Bleeding,Bleeding,Intimidate45,ArmorBane,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Intimidate45,ArmorBane'
  ["MistWalkClose3", "Bleeding,Bleeding,Bleeding,Bleeding,Intimidate45,ArmorBane,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Intimidate45,ArmorBane'
  ["MistWalkClose4", "Bleeding,Bleeding,Bleeding,Bleeding,Intimidate50,ArmorBane,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Intimidate50,ArmorBane'
  ["MistWalkClose5", "Bleeding,Bleeding,Bleeding,Bleeding,Intimidate50,ArmorBane,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Intimidate50,ArmorBane'
  ["MistWalkClose6", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate50,ArmorBane,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate50,ArmorBane'
  ["MistWalkClose7", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate55,ArmorBane,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate55,ArmorBane'
  ["MistWalkClose8", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate55,ArmorBane,ArmorBane,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate55,ArmorBane,ArmorBane'
  ["MistWalkClose9", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate60,ArmorBane,ArmorBane,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate60,ArmorBane,ArmorBane'
  ["MistWalkClose10", "Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate,ArmorBane,ArmorBane,ViperbladeBleed"], // was 'Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Intimidate,ArmorBane,ArmorBane'
  // DaggerFlurry (RangedAoE) +PoisonStrike
  ["DaggerFlurry", "DaggerPoison,ViperbladePoison"], // was 'DaggerPoison'
  ["DaggerFlurry1", "DaggerPoison,ViperbladePoison"], // was 'DaggerPoison'
  ["DaggerFlurry2", "DaggerPoison,ViperbladePoison"], // was 'DaggerPoison'
  ["DaggerFlurry3", "DaggerPoison,ViperbladePoison"], // was 'DaggerPoison'
  ["DaggerFlurry4", "DaggerPoison,ViperbladePoison"], // was 'DaggerPoison'
  ["DaggerFlurry5", "DaggerPoison,DaggerPoison,ViperbladePoison"], // was 'DaggerPoison,DaggerPoison'
  ["DaggerFlurry6", "DaggerPoison,DaggerPoison,ViperbladePoison"], // was 'DaggerPoison,DaggerPoison'
  ["DaggerFlurry7", "DaggerPoison,DaggerPoison,ViperbladePoison"], // was 'DaggerPoison,DaggerPoison'
  ["DaggerFlurry8", "DaggerPoison,DaggerPoison,ViperbladePoison"], // was 'DaggerPoison,DaggerPoison'
  ["DaggerFlurry9", "DaggerPoison,DaggerPoison,ViperbladePoison"], // was 'DaggerPoison,DaggerPoison'
  ["DaggerFlurry10", "DaggerPoison,DaggerPoison,ArmorBane,ViperbladePoison"], // was 'DaggerPoison,DaggerPoison,ArmorBane'
  // PoisonDagger (ProjectilePlayer) +PoisonStrike
  ["PoisonDagger", "ViperbladePoison"], // was ''
  ["PoisonDagger1", "ViperbladePoison"], // was ''
]);




// The discipline signature powers -- AbilityTypes HotbarLocation 0, one per discipline.
// This is the slot that is actually per-discipline, which the weapon-driven basic attacks
// never were: PoisonDagger's own description calls it "favored by the Viperblade". Passives
// belong here because putting them here scopes them by construction.
//
//   Sentinel  ConcussionBolt   Justicar  AxeFlurry     Templar   DivineBolt
//   Viper     PoisonDagger     Soulthief HeavyDagger   Shadow    CorrosiveDagger
// What each discipline's signature power says it does. Only passives that actually work are
// written here: Shadowstalker's auto-shroud is not implemented, so CorrosiveDagger keeps its
// authored text rather than promising something the game will not do.
//
// The Sentinel's sentence describes the melee swing rather than the bolt it is attached to,
// and that is deliberate (issue #670). The passive moved onto the melee attacks -- see
// CombatHandler.getSentinelMaxHpBonus -- but the weapon melee powers author no Description at
// all, and ConcussionBolt is the discipline's one power with a tooltip a player reliably
// reads. Saying it here is the only place it can be said.
//
// The Justicar's is new: the discipline had no passive, and the Ignited bonus this slot once
// promised was never implemented. 10% of Expertise on Attack is, in the same issue --
// CombatHandler.getJusticarExpertiseBonus.
//
// The authored sentence is replaced and any trailing "[Stats: ...]" is left alone --
// patch_gameswz_power_stat_tooltips regenerates that block afterwards.
// The Bleed that used to sit on SaberMelee/RapierMelee is gone, and the strip below puts
// those two powers back to authoring no AddTargetBuff at all.
//
// It was there to give Viperblade a basic-attack passive, and it could never be that. These
// are weapon powers and weapons carry <UsedBy>Rogue</UsedBy>, a class and never a mastery,
// so a Soulthief or a Shadowstalker bled targets exactly as hard as an Executioner did --
// which is what switching discipline away from Viperblade and still applying Bleed looks
// like from inside the game.
//
// Gating it to the combo finisher would not have helped either, and the reason is worth
// keeping so it is not tried a third time. "Sequence:" and "Last:" index the buff list by
// ActivePower.var_54, the power's own CastTime step, not the melee combo counter; SaberMelee
// authors one CastTime value, so var_54 is always 0. The real combo index exists --
// ActivePower.meleeCombo, counted 0/1/2 by CombatState -- but it drives the swing animation
// and the finisher's cooldown and never reaches the buff path. Per-swing scoping needs
// meleeCombo threaded into method_1192, which is bytecode, and it would still be class-wide.
//
// Viperblade keeps working where the scoping is real: on the Executioner tree's own powers,
// below.

const SIGNATURE_DESCRIPTIONS = new Map<string, [string, string]>([
  [
    "ConcussionBolt",
    [
      "The Sentinel's ranged energy attacks.",
      "The Sentinel's ranged energy attacks. Sentinel passive: your melee attacks also strike for 0.3% of your maximum Health and 30% of your Defense.",
    ],
  ],
  [
    "AxeFlurry",
    [
      "The Justicar's signature throwing axes.",
      "The Justicar's signature throwing axes. Justicar passive: 10% of your Expertise is added to your Attack.",
    ],
  ],
  [
    "DivineBolt",
    [
      "Bolts of divine punishment granted to the Templar",
      "Bolts of divine punishment granted to the Templar. Templar passive: your ranged attacks arc to up to 3 more enemies.",
    ],
  ],
  [
    "PoisonDagger",
    [
      "Bone-shaped daggers favored by the Viperblade. Viperblade passive: your close attacks draw Bleed and your ranged attacks leave Poison.",
      "Bone-shaped daggers favored by the Viperblade. Ranged basic attacks leave Poison.",
    ],
  ],
  [
    "HeavyDagger",
    [
      "Forked blades carried by the Soulthief",
      "Forked blades carried by the Soulthief. Soulthieft passive: your strikes carve away a share of the target's maximum Health.",
    ],
  ],
]);

const SIGNATURE_AOE = new Map<string, string>([
  ["DivineBolt", "90"], // Templar: the small splash, and only Templars get it
]);

const DAMAGE_MULTS = new Map<string, string>([
  /**
   * Chaos Wave hits for something now. Every rank authored BaseDamageMult 0 -- all of its
   * output was the Bound and Poison ticks, so taking the poison off left a 30-mana melee AoE
   * that dealt no damage at all.
   *
   * Sized against the Soulthief's own melee powers rather than picked from nothing:
   * Fatiguing Strike runs 0.75 to 1.71 single-target for 20 mana and Carnifex 1.43 to 2.39.
   * Chaos Wave lands between them, which is where a power that also Binds, Weakens and buffs
   * its own Expertise belongs.
   *
   * Rank 4 takes the biggest single step. It is the rank the poison used to occupy, so it
   * had nothing left to give.
   */
  ["ChaosArmor", "0.9"], // 0
  ["ChaosArmor1", "0.9"], // 0
  ["ChaosArmor2", "1"], // 0
  ["ChaosArmor3", "1"], // 0
  ["ChaosArmor4", "1.35"], // 0 -- the rank the poison vacated
  ["ChaosArmor5", "1.35"], // 0
  ["ChaosArmor6", "1.5"], // 0
  ["ChaosArmor7", "1.6"], // 0
  ["ChaosArmor8", "1.75"], // 0
  ["ChaosArmor9", "1.9"], // 0
  ["ChaosArmor10", "2.1"], // 0
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

const BLACK_MIASMA_DEFENSE = new Map<string, string>([
  ["ShadowTendrilDamage", "-0.06"],
  ["ShadowTendrilRank1", "-0.06"],
  ["ShadowTendrilRank4", "-0.06"],
  ["ShadowTendrilRank6", "-0.08"],
  ["ShadowTendrilRank8", "-0.08"],
  ["ShadowTendrilRank10", "-0.1"],
]);

const REAPER_EXPERTISE_BY_RANK = [0.12, 0.12, 0.12, 0.12, 0.12, 0.3, 0.3, 0.6, 0.6, 0.9, 1.2] as const;
const PAIN_BENDER_EXPERTISE_BY_RANK = [0.45, 0.45, 0.45, 0.45, 0.9, 0.9, 0.9, 1.35, 1.35, 1.8, 2.25] as const;


// Assassinate becomes an AoE using the same Cleave target method as Shadow Rend.
const ASSASSINATE_RANKS = ["DeathBlowOld", ...Array.from({ length: 10 }, (_, i) => `DeathBlowOld${i + 1}`)];
const ASSASSINATE_AOE_RADIUS = "200";

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
/**
 * Description prose, which patch_gameswz_power_stat_tooltips leaves alone -- it regenerates
 * only the trailing "[Stats: ...]" block. A Chaos Wave that still advertises Poison is a
 * Chaos Wave players will keep expecting Poison from.
 */
/**
 * Description prose. Only where an effect actually moved -- Chaos Wave lost its poison and
 * gained damage, Ghost Blade's steal now covers Expertise.
 */
const DESCRIPTIONS = new Map<string, [string, string]>();

for (let rank = 4; rank <= 10; rank += 1) {
  DESCRIPTIONS.set(`ChaosArmor${rank}`, [
    "Release Chaotic energy, Binding, Poisoning and reducing the Attack of nearby foes.",
    "Release Chaotic energy that damages, Binds and reduces the Attack of nearby foes.",
  ]);
}
for (const rank of ["", "1", "2", "3"]) {
  DESCRIPTIONS.set(`ChaosArmor${rank}`, [
    "Release Chaotic energy, Binding and reducing the Attack of nearby foes.",
    "Release Chaotic energy that damages, Binds and reduces the Attack of nearby foes.",
  ]);
}
for (const rank of ["", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]) {
  DESCRIPTIONS.set(`GhostBlade${rank}`, [
    "Steal your foe's strength while it lives.",
    "Steal your foe's Attack and Expertise while it lives.",
  ]);
}

/**
 * Text that has to move a second time, after an earlier run already rewrote it. Runs before
 * the signature rewrite below, because SIGNATURE_DESCRIPTIONS keys off a prefix of the same
 * sentence -- with stale text still present the prefix matches, the "already done" guard
 * misses, and the new sentence gets spliced in alongside the old one.
 */
const TEXT_MIGRATIONS: Array<{ power: RegExp; from: string; to: string }> = [
  {
    power: /^ChaosArmor\d*$/,
    from: ". Grants an Expertise buff",
    to: ".",
  },
  {
    power: /^ChaosArmor\d*$/,
    from: "foes [Stats:",
    to: "foes. [Stats:",
  },
  {
    power: /^DivineBolt\d*$/,
    from: "Templar passive: every bolt bursts in a small area.",
    to: "Templar passive: your ranged attacks arc to up to 3 more enemies.",
  },
  {
    // The Sentinel passive moved off the bolt and onto the melee swing, and its rates moved
    // with it: 0.1% of max HP became 0.01%, plus a Defense term the old one did not have
    // (issue #670).
    power: /^ConcussionBolt\d*$/,
    from: "Sentinel passive: every bolt also strikes for 0.1% of your maximum Health.",
    to: "Sentinel passive: your melee attacks also strike for 0.3% of your maximum Health and 30% of your Defense.",
  },
  {
    // The rates the issue opened with, shipped and then measured: 0.01% of max HP and
    // 0.1% of Defense came to 14 damage on a 5,264 basic swing at level 50. See
    // CombatHandler.getSentinelMaxHpBonus for where the replacements come from.
    power: /^ConcussionBolt\d*$/,
    from: "Sentinel passive: your melee attacks also strike for 0.01% of your maximum Health and 0.1% of your Defense.",
    to: "Sentinel passive: your melee attacks also strike for 0.3% of your maximum Health and 30% of your Defense.",
  },
];

// Chaos Wave's authored Expertise upgrades do not work. Describe only the changes that the
// power actually receives at each rank: its damage multiplier and mana cost.
const CHAOS_WAVE_UPGRADES = new Map<string, string>([
  ["ChaosArmor2", "Increased Damage #olddmg#"],
  ["ChaosArmor3", "-1 Mana"],
  ["ChaosArmor4", "Increased Damage #olddmg#"],
  ["ChaosArmor5", "-1 Mana"],
  ["ChaosArmor6", "Increased Damage #olddmg#"],
  ["ChaosArmor7", "-1 Mana. Increased Damage #olddmg#"],
  ["ChaosArmor8", "Increased Damage #olddmg#"],
  ["ChaosArmor9", "-2 Mana. Increased Damage #olddmg#"],
  ["ChaosArmor10", "Increased Damage #olddmg#"],
]);


for (const migration of TEXT_MIGRATIONS) {
  if (migration.to.includes(migration.from)) {
    throw new Error(`TEXT_MIGRATIONS entry for ${migration.power} would re-apply forever: "to" contains "from".`);
  }
}

const UPGRADE_TEXT = new Map<string, [string, string]>([
  ["ChaosArmor4", ["Adds Chaos Poison", "Increased Damage #olddmg#"]],
  ["GhostBlade1", ["-35% target Attack, +20% Attack for 4 seconds", "-35% target Attack, +20% Attack and Expertise for 4 seconds"]],
  ["GhostBlade4", ["-40% target Attack, +25% Attack for 4 seconds", "-40% target Attack, +25% Attack and Expertise for 4 seconds"]],
  ["GhostBlade7", ["-45% target Attack, +30% Attack for 5 seconds", "-45% target Attack, +30% Attack and Expertise for 5 seconds"]],
  ["GhostBlade10", ["-50% target Attack, +35% Attack for 6 seconds", "-50% target Attack, +35% Attack and Expertise for 6 seconds"]],
  ["WitherStrike3", ["Adds a stack of Armor Bane.", "Adds a stack of Poison."]],
  // Chaos Wave rank 4's only upgrade was the poison, so with it gone the rank grants
  // nothing. Saying so is better than leaving text that promises an effect the power no
  // longer has -- it wants a replacement upgrade, which is a balance call, not a text fix.
  // Ghost Blade's steal now covers Expertise as well as Attack.
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
  ["DeathBlowOld5", ["Deals 2 stacks of Poison", "Deals 4 stacks of Bleed"]],
  ["DeathBlowOld6", ["Deals 2 stacks of ArmorBane and 4 stacks of Bleed.", "Deals 2 stacks of Armor Bane and 6 stacks of Bleed."]],
  ["DeathBlowOld8", ["Deals 3 stacks of Poison", "Deals 7 stacks of Bleed"]],
  ["DeathBlowOld10", ["Deals 6 Stacks of Bleed, Increased bonus damage. Increased Damage #olddmg#", "Deals 8 stacks of Bleed. Increased bonus damage. Increased Damage #olddmg#"]],
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

const TALENTSTONE_VALUES = {
  ArmorDmgTime: ["200", "500", "1000", "1500", "2000"],
  StrengthDmgTime: ["500", "1000", "1500", "2000", "3000"],
  StrengthDmg: ["-.003,-.003", "-.005,-.005", "-.01,-.01", "-.015,-.015", "-.02,-.02"],
  Pounce: [".01", ".02", ".03", ".05", ".07"],
  ContactPoison: [".10", ".20", ".30", ".40", ".60"],
  WindCloak: [".01", ".03", ".05", ".07", ".10"],
  CurseSword: [".01", ".03", ".05", ".07", ".10"],
  CurseArmor: [".03", ".05", ".10", ".15", ".20"],
} as const;

const ETHEREAL_EXPERTISE_VALUES = [".01", ".03", ".05", ".07", ".10"] as const;
const ORIGINAL_SHADOW_REFUGE_VALUES = [".05", ".10", ".2", ".35", ".6"] as const;

const TALENTSTONE_DESCRIPTIONS = new Map<string, string>([
  ["ArmorDmgTime1", "Increases Armor Bane and Armor Break durations@Duration (seconds):, +.2, +.5, +1, +1.5, +2"],
  ["StrengthDmgTime1", "Increases Enfeeble and Weaken durations@Duration (seconds):, +.5, +1, +1.5, +2, +3"],
  ["StrengthDmg1", "Increases Enfeeble and Weaken effectiveness@Effect:, +3%, +5%, +10%, +15%, +20%"],
  ["Pounce1", "Deal extra damage to slowed and immobilized enemies@Bonus Damage:, 1%, 2%, 3%, 5%, 7%"],
  ["ContactPoison1", "Increases Poison Damage vs. Bleeding targets@Poison vs Bleeding:, +5%, +10%, +15%, +20%, +30%"],
  ["WindCloak1", "Gain Bonus Defense vs Bound Enemies@Defense:, +1%, +3%, +5%, +7%, +10%"],
  ["CurseSword1", "Minions gain Bonus Damage vs Cursed Enemies@Damage:, +1%, +3%, +5%, +7%, +10%"],
  ["CurseArmor1", "Minions gain Bonus Defense and Expertise vs Cursed Enemies@Defense and Expertise:, +3%, +5%, +10%, +15%, +20%"],
  ["Ethereal1", "Gain an Expertise bonus while in Stealth@Expertise Bonus:, 1%, 3%, 5%, 7%, 10%"],
  ["ShadowRefuge1", "Heal for a percent of your Expertise when entering Stealth@Healing (% Expertise):, 5%, 10%, 20%, 35%, 60%"],
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

/**
 * Ghost Blade steals the target's Attack and hands the Soulthief the same amount back -- but
 * only as Attack, so the half of a Soulthief's sheet that Chaos Wave buffs went untouched.
 * Mirroring MeleeDamage into MagicDamage makes the steal cover Expertise too, which is the
 * shape Chaos Wave's own buff already uses (ChaosArmor5/10/15/30 are MagicDamage-only).
 *
 * The values match the Attack bonus rank for rank rather than inventing a second curve, so
 * the upgrade text that already quotes them stays true with one word added.
 */
const GHOST_BLADE_EXPERTISE = new Map<string, string>([
  ["GhostBlade1", "0.2"], // MeleeDamage 0.2, no MagicDamage
  ["GhostBlade4", "0.25"], // MeleeDamage 0.25, no MagicDamage
  ["GhostBlade6", "0.25"], // MeleeDamage 0.25, no MagicDamage
  ["GhostBlade7", "0.3"], // MeleeDamage 0.3, no MagicDamage
  ["GhostBlade9", "0.3"], // MeleeDamage 0.3, no MagicDamage
  ["GhostBlade10", "0.35"], // MeleeDamage 0.35, no MagicDamage
]);

const VIPERBLADE_BASIC_RANGED = new Set(["PoisonDagger", "PoisonDagger1"]);
const VIPERBLADE_POISON_BUFF = {
  name: "ViperbladePoison",
  xml: [
    '<BuffType BuffName="ViperbladePoison">',
    "\t\t<BuffID>741</BuffID>",
    "\t\t<Attack>true</Attack>",
    "\t\t<Duration>5000</Duration>",
    "\t\t<DoTDamage>1.5</DoTDamage>",
    "\t\t<DoTTickLength>1000</DoTTickLength>",
    "\t\t<Effect>Poisoned</Effect>",
    "\t\t<StackCount>1</StackCount>",
    "\t\t<BuffLoc>Head</BuffLoc>",
    "\t\t<BuffIcon>a_StatusIcon_Poisoned</BuffIcon>",
    "\t</BuffType>",
  ].join("\r\n\t"),
};

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

function formatPercent(value: number): string {
  return Number.isInteger(value * 100) ? String(value * 100) : String(Math.round(value * 1000) / 10);
}

function replaceDescriptionProse(block: string, prose: string, stats: PatchStats): string {
  const match = block.match(/<Description>([\s\S]*?)<\/Description>/);
  if (!match) return block;
  const statsSuffix = match[1].match(/\s*\[Stats:[\s\S]*$/)?.[0] ?? "";
  return replaceTag(block, "Description", `${prose}${statsSuffix}`, stats);
}

/**
 * Basic attacks come from the equipped weapon, and weapons are per class -- so putting the
 * Viperblade bleed on SaberMelee gave it to every rogue, Soulthief and Shadowwalker
 * included, and the Templar splash went to every paladin. A mastery passive that fires for
 * the other two masteries is not the passive.
 *
 * These strip what that attempt wrote, so the source XML and the served archive converge
 * back to the authored shape whichever one a build starts from. Viperblade keeps working
 * where it is correctly scoped: on the Executioner tree's own powers.
 */
const REMOVE_TAGS: Array<{ power: string; tag: string }> = [
  { power: "Lightningball", tag: "AoERadius" },
  { power: "Energyball", tag: "AoERadius" },
  { power: "SaberMelee", tag: "AddTargetBuff" },
  { power: "RapierMelee", tag: "AddTargetBuff" },
];

export function patchPlayerPowers(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const patched = xml.replace(/<Power PowerName="([^"]+)">[\s\S]*?<\/Power>/g, (block: string, powerName: string) => {
    let next = block;
    let touched = false;

    const targetBuff = VIPERBLADE_BASIC_RANGED.has(powerName)
      ? VIPERBLADE_BUFFS.get(powerName)
      : TARGET_BUFFS.get(powerName);
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
    for (const removal of REMOVE_TAGS) {
      if (removal.power !== powerName) {
        continue;
      }
      const pattern = new RegExp(`\\r?\\n\\t*<${removal.tag}>[^<]*</${removal.tag}>`);
      if (pattern.test(next)) {
        touched = true;
        stats.changes += 1;
        next = next.replace(pattern, "");
      }
    }

    const signatureAoe = SIGNATURE_AOE.get(powerName.replace(/\d+$/, ""));
    if (signatureAoe) {
      touched = true;
      if (/<AoERadius>[^<]*<\/AoERadius>/.test(next)) {
        next = replaceTag(next, "AoERadius", signatureAoe, stats);
      } else {
        next = next.replace(/(<TargetMethod>[^<]*<\/TargetMethod>)/, (match) => {
          stats.changes += 1;
          return `${match}\r\n\t\t<AoERadius>${signatureAoe}</AoERadius>`;
        });
      }
    }

    for (const migration of TEXT_MIGRATIONS) {
      if (!migration.power.test(powerName)) continue;
      // Guarded on `from` alone, not on `to`. A repair entry rewrites text that *contains*
      // its own replacement, so an "already has the target string" guard would refuse to run
      // it. Idempotence comes from `to` never containing `from`, asserted at load.
      if (!next.includes(migration.from)) continue;
      touched = true;
      stats.changes += 1;
      next = next.split(migration.from).join(migration.to);
    }

    const chaosWaveUpgrade = CHAOS_WAVE_UPGRADES.get(powerName);
    if (chaosWaveUpgrade) {
      const before = next;
      if (/<UpgradeDescription>[^<]*<\/UpgradeDescription>/.test(next)) {
        next = replaceTag(next, "UpgradeDescription", chaosWaveUpgrade, stats);
      } else {
        next = next.replace(/(<Description>[^<]*<\/Description>)/, (match) => {
          stats.changes += 1;
          return `${match}\r\n\t\t<UpgradeDescription>${chaosWaveUpgrade}</UpgradeDescription>`;
        });
      }
      next = next.replace(/(<UpgradeDescription>[^<]*<\/UpgradeDescription>)\r\n/g, "$1\n");
      touched = touched || next !== before;
    }

    const signatureText = SIGNATURE_DESCRIPTIONS.get(powerName.replace(/\d+$/, ""));
    if (signatureText && next.includes(signatureText[0]) && !next.includes(signatureText[1])) {
      touched = true;
      stats.changes += 1;
      next = next.split(signatureText[0]).join(signatureText[1]);
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

    if (VIPERBLADE_BUFFS.has(powerName) || next.includes("ViperbladeBleed") || next.includes("ViperbladePoison")) {
      const match = next.match(/<AddTargetBuff>([^<]*)<\/AddTargetBuff>/);
      if (match) {
        const filtered = match[1]
          .split(",")
          .filter((entry) => {
            if (entry === "ViperbladeBleed") return false;
            if (entry === "ViperbladePoison" && !VIPERBLADE_BASIC_RANGED.has(powerName)) return false;
            return true;
          })
          .join(",");
        if (filtered !== match[1]) {
          touched = true;
          stats.changes += 1;
          next = filtered
            ? next.replace(match[0], `<AddTargetBuff>${filtered}</AddTargetBuff>`)
            : next.replace(/\r?\n\t*<AddTargetBuff>[^<]*<\/AddTargetBuff>/, "");
        }
      }
      next = next.replace(
        /(<AddTargetBuff>[^\r\n]*<\/AddTargetBuff>)\r\n/g,
        "$1\n",
      );
    }

    const rankedName = powerName.match(/^(HeartSeeker|BlackStorm|Assassinate|AssassinateClose|DeathBlowOld|PainBender|Reaper)(\d*)$/);
    if (rankedName) {
      const family = rankedName[1];
      const rank = Number(rankedName[2] || 0);
      let prose = "";
      if (family === "HeartSeeker") {
        const effect = rank >= 8
          ? "Deliver a single, penetrating, Staggering strike. Dazes if cast out of Stealth."
          : rank >= 5
            ? "Deliver a single, penetrating, Staggering strike."
            : "Deliver a single, penetrating strike.";
        prose = `${effect} Deals 40% bonus damage to enemies affected by Black Miasma.`;
      } else if (family === "BlackStorm") {
        const attack = rank >= 7 ? "launches a Staggering attack" : "launches an attack";
        prose = `Create a Shadow Clone that ${attack} on foes around it. You use the distraction to become elusive. Deals 90% bonus damage to enemies affected by Black Miasma.`;
      } else if (family === "Assassinate" && rank >= 3) {
        prose = `Dash to a target and unleash a multi-hit combo that applies Bleed with every blow. Each hit deals ${rank >= 10 ? "2" : rank >= 7 ? "1.5" : "1"}% more damage per Bleed stack on the target.`;
      } else if (family === "AssassinateClose" && rank >= 3) {
        prose = `Vicious Assault combo. Deals ${rank >= 10 ? "2" : rank >= 7 ? "1.5" : "1"}% more damage per Bleed stack on the target.`;
      } else if (family === "DeathBlowOld" && rank >= 5) {
        prose = "Applies one stack of Poison, Armor Bane, and Bleed. Deals bonus damage to target based on missing health.";
      } else if (family === "PainBender") {
        prose = `Strike your opponent with a powerful blow, gaining ${formatPercent(PAIN_BENDER_EXPERTISE_BY_RANK[rank])}% of Expertise as bonus damage against Bound targets.`;
      } else if (family === "Reaper") {
        const armorBane = rank >= 4 ? " Inflicts Armor Bane." : "";
        prose = `Vampiric AoE attack that gains ${formatPercent(REAPER_EXPERTISE_BY_RANK[rank])}% of Expertise as bonus damage against Bound targets.${armorBane}`;
      }
      if (prose) {
        const before = next;
        next = replaceDescriptionProse(next, prose, stats);
        touched = touched || next !== before;
      }
      if (family === "HeartSeeker" || family === "BlackStorm") {
        const before = next;
        next = next.replace(
          /(<Description>[^\r\n]*Black Miasma\.[^\r\n]*<\/Description>)\r\n/g,
          "$1\n",
        );
        touched = touched || next !== before;
      }
    }

    const absoluteUpgrade = new Map<string, string>([
      ["Assassinate3", "Gains 1% damage per Bleed stack. Increased Damage #olddmg#"],
      ["Assassinate7", "Gains 1.5% damage per Bleed stack. Increased Damage #olddmg#"],
      ["Assassinate10", "Gains 2% damage per Bleed stack. Each hit deals 2 stacks of Bleed. Grants 60% Dash Armor."],
      ["DeathBlowOld8", "Deals 7 stacks of Bleed"],
      ["DeathBlowOld10", "Deals 8 stacks of Bleed. Increased bonus damage. Increased Damage #olddmg#"],
      ["PainBender1", "45% Expertise bonus damage vs Bound"],
      ["PainBender4", "90% Expertise bonus damage vs Bound"],
      ["PainBender7", "-1 Mana, 135% Expertise bonus damage vs Bound"],
      ["PainBender9", "-1 Mana, 180% Expertise bonus damage vs Bound, Increased Damage #olddmg#"],
      ["PainBender10", "-1 Mana, 225% Expertise bonus damage vs Bound"],
      ["Reaper4", "Inflicts Armor Bane. Increased Damage #olddmg#"],
      ["Reaper5", "Deals 30% Expertise damage bonus vs Bound targets."],
      ["Reaper7", "Deals 60% Expertise damage bonus vs Bound targets"],
      ["Reaper9", "-1 Mana. Deals 90% Expertise damage bonus vs Bound targets."],
      ["Reaper10", "-1 Mana. Deals 120% Expertise damage bonus vs Bound targets."],
      ["ShadowTendrilDash1", "Tendril Defense reduction is 6%."],
      ["ShadowTendrilDash6", "Tendril Defense reduction is 8%."],
      ["ShadowTendrilDash10", "Tendril Defense reduction is 10%."],
    ]).get(powerName);
    if (absoluteUpgrade) {
      const before = next;
      next = replaceTag(next, "UpgradeDescription", absoluteUpgrade, stats);
      touched = touched || next !== before;
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

    const heal = SOUL_REAVER_SELF_HEAL.get(buffName);
    if (heal) {
      touched = true;
      next = replaceTag(next, "DoTDamage", heal, stats);
    }

    const miasmaDefense = BLACK_MIASMA_DEFENSE.get(buffName);
    if (miasmaDefense) {
      touched = true;
      next = replaceTag(next, "MagicDefense", miasmaDefense, stats);
      next = replaceTag(next, "MeleeDefense", miasmaDefense, stats);
    }

    const expertise = GHOST_BLADE_EXPERTISE.get(buffName);
    if (expertise) {
      touched = true;
      // These buffs author MeleeDamage and no MagicDamage, and the template orders the pair
      // MagicDamage-then-MeleeDamage, so it is inserted ahead of the tag that is there.
      if (/<MagicDamage>[^<]*<\/MagicDamage>/.test(next)) {
        next = replaceTag(next, "MagicDamage", expertise, stats);
      } else {
        next = next.replace(/<MeleeDamage>[^<]*<\/MeleeDamage>/, (match) => {
          stats.changes += 1;
          return `<MagicDamage>${expertise}</MagicDamage>\r\n\t\t${match}`;
        });
      }
    }

    if (touched) {
      stats.buffBlocks += 1;
    }
    return next;
  });

  let withoutViperbladePassive = patched.replace(
    /\r?\n\t*<BuffType BuffName="ViperbladeBleed">[\s\S]*?<\/BuffType>/g,
    () => {
      stats.buffBlocks += 1;
      stats.changes += 1;
      return "";
    },
  );

  if (!withoutViperbladePassive.includes(`<BuffType BuffName="${VIPERBLADE_POISON_BUFF.name}">`)) {
    const closing = withoutViperbladePassive.lastIndexOf("</PlayerBuffTypes>");
    if (closing >= 0) {
      stats.buffBlocks += 1;
      stats.changes += 1;
      withoutViperbladePassive =
        `${withoutViperbladePassive.slice(0, closing)}\t${VIPERBLADE_POISON_BUFF.xml}\r\n` +
        withoutViperbladePassive.slice(closing);
    }
  }

  return { xml: withoutViperbladePassive, stats };
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

    const talentMatch = modName.match(/^(ArmorDmgTime|StrengthDmgTime|StrengthDmg|Pounce|ContactPoison|WindCloak|CurseSword|CurseArmor)([1-5])$/);
    if (talentMatch) {
      const family = talentMatch[1] as keyof typeof TALENTSTONE_VALUES;
      const rank = Number(talentMatch[2]);
      const value = TALENTSTONE_VALUES[family][rank - 1];
      touched = true;
      if (
        family === "ArmorDmgTime" ||
        family === "StrengthDmgTime" ||
        family === "StrengthDmg" ||
        family === "ContactPoison"
      ) {
        next = replaceTag(next, "BuffValue", value, stats);
      } else {
        next = replaceTag(next, "SelfValue", value, stats);
      }
      const talentDescription = TALENTSTONE_DESCRIPTIONS.get(modName);
      if (talentDescription) next = replaceTag(next, "Description", talentDescription, stats);
      if (
        family === "ContactPoison" ||
        family === "WindCloak" ||
        family === "CurseSword" ||
        family === "CurseArmor"
      ) {
        const before = next;
        next = next.replace(
          /(<(?:Description|BuffValue|SelfValue)>[^\r\n]*<\/(?:Description|BuffValue|SelfValue)>)\r\n/g,
          "$1\n",
        );
        touched = touched || next !== before;
      }
    }

    const etherealMatch = modName.match(/^Ethereal([1-5])$/);
    if (etherealMatch) {
      const rank = Number(etherealMatch[1]);
      touched = true;
      next = replaceTag(next, "BuffProperty", "MagicDamage", stats);
      next = replaceTag(next, "BuffValue", ETHEREAL_EXPERTISE_VALUES[rank - 1], stats);
      const talentDescription = TALENTSTONE_DESCRIPTIONS.get(modName);
      if (talentDescription) next = replaceTag(next, "Description", talentDescription, stats);
    }

    const refugeMatch = modName.match(/^ShadowRefuge([1-5])$/);
    if (refugeMatch) {
      const rank = Number(refugeMatch[1]);
      touched = true;
      next = replaceTag(next, "SelfValue", ORIGINAL_SHADOW_REFUGE_VALUES[rank - 1], stats);
      const talentDescription = TALENTSTONE_DESCRIPTIONS.get(modName);
      if (talentDescription) next = replaceTag(next, "Description", talentDescription, stats);
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
