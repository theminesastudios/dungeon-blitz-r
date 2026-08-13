import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..", "..");
const XML_DIR = path.join(ROOT, "client", "content", "xml");

function block(xml: string, element: string, attribute: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<${element} ${attribute}="${escaped}">[\\s\\S]*?<\\/${element}>`));
  assert.ok(match, `${element} ${name} must exist`);
  return match[0];
}

function tag(xml: string, name: string): string {
  return xml.match(new RegExp(`<${name}>([^<]*)<\\/${name}>`))?.[1] ?? "";
}

function entity(xml: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`<EntType EntName="${escaped}"(?: [^>]*)?>[\\s\\S]*?<\\/EntType>`));
  assert.ok(match, `EntType ${name} must exist`);
  return match[0];
}

function powerMod(xml: string, name: string): string {
  const match = (xml.match(/<PowerModType>[\s\S]*?<\/PowerModType>/g) ?? [])
    .find((candidate) => tag(candidate, "ModName") === name);
  assert.ok(match, `PowerModType ${name} must exist`);
  return match;
}

const powers = fs.readFileSync(path.join(XML_DIR, "PlayerPowerTypes.xml"), "utf8");
const buffs = fs.readFileSync(path.join(XML_DIR, "PlayerBuffTypes.xml"), "utf8");
const entities = fs.readFileSync(path.join(XML_DIR, "EntTypes.xml"), "utf8");
const mods = fs.readFileSync(path.join(XML_DIR, "PowerModTypes.xml"), "utf8");
const runtimePatch = fs.readFileSync(path.join(ROOT, "server", "scripts", "patch-dungeonblitz-shadowstalker-expertise.js"), "utf8");
const equippedSkillPatch = fs.readFileSync(path.join(ROOT, "server", "scripts", "patch-dungeonblitz-shadow-legion-equipped-skills.ts"), "utf8");
const talentstoneRuntimePatch = fs.readFileSync(
  path.join(ROOT, "server", "scripts", "patch-dungeonblitz-talentstone-rework.js"),
  "utf8",
);

// Every clone runs Scorpion's Sting -> Black Miasma -> Dark Chi; they differ only in where they
// enter it. Brain fires the first entry in this list whose cooldown has expired, so at spawn --
// when nothing is on cooldown -- the head decides which skill a clone opens with. The spacing
// between them is stamped by patch-dungeonblitz-shadow-legion-rotation, not authored here.
const CLONE_ROTATION_STARTS: ReadonlyArray<readonly [string, string]> = [
  ["ShadowLegionClone", "FalseScorpionSting,FalseTendrilDash,FalseChi"],
  ["ShadowLegionCloneTwo", "FalseTendrilDash,FalseChi,FalseScorpionSting"],
  ["ShadowLegionCloneThree", "FalseChi,FalseScorpionSting,FalseTendrilDash"],
];

for (const [family, powers] of CLONE_ROTATION_STARTS) {
  for (let rank = 1; rank <= 10; rank += 1) {
    const block = entity(entities, `${family}${rank}`);
    assert.equal(tag(block, "MeleeDamage"), "0.3", `${family}${rank} base damage`);
    assert.equal(tag(block, "Powers"), powers, `${family}${rank} rotation order`);
    assert.equal(tag(block, "MeleePower"), "FalseSaberMelee", `${family}${rank} basic attack`);
  }
}

// The rotation is worthless without the schedule that spaces it: without this hook all three
// skills come off cooldown together and fire back to back.
const rotationPatch = fs.readFileSync(
  path.join(ROOT, "server", "scripts", "patch-dungeonblitz-shadow-legion-rotation.js"),
  "utf8",
);
for (const base of ["FalseScorpionSting", "FalseTendrilDash", "FalseChi"]) {
  assert.ok(rotationPatch.includes(`base: '${base}'`), `rotation patch must schedule ${base}`);
}
assert.ok(
  rotationPatch.includes("this.var_114[_slPower.powerID] = _slReadyAt;"),
  "rotation patch must stamp the cooldown table",
);

assert.deepEqual(
  [1, 2, 3, 4, 5].map((rank) => tag(powerMod(mods, `Pounce${rank}`), "SelfValue")),
  [".01", ".02", ".03", ".05", ".07"]
);
assert.match(powerMod(mods, "Pounce1"), /1%, 2%, 3%, 5%, 7%/);

for (const [family, expected, description] of [
  ["ContactPoison", [".05", ".10", ".15", ".20", ".30"], /\+5%, \+10%, \+15%, \+20%, \+30%/],
  ["WindCloak", [".01", ".03", ".05", ".07", ".10"], /Defense vs Bound Enemies/],
  ["CurseSword", [".01", ".03", ".05", ".07", ".10"], /Minions gain Bonus Damage vs Cursed Enemies/],
  ["CurseArmor", [".03", ".05", ".10", ".15", ".20"], /Minions gain Bonus Defense and Expertise vs Cursed Enemies/],
] as const) {
  const valueTag = family === "ContactPoison" ? "BuffValue" : "SelfValue";
  assert.deepEqual(
    [1, 2, 3, 4, 5].map((rank) => tag(powerMod(mods, `${family}${rank}`), valueTag)),
    expected,
  );
  assert.match(tag(powerMod(mods, `${family}1`), "Description"), description);
}

// Contact Poison multiplies a poison DoT only when the DoT's own BuffName is listed on the
// mod, so every poison a rogue can apply has to be here -- Bone Daggers (ViperbladePoison)
// and Poison Cloud were outside the talent while it read as a blanket poison bonus.
for (let rank = 1; rank <= 5; rank += 1) {
  const buffNames = tag(powerMod(mods, `ContactPoison${rank}`), "BuffName").split(",");
  for (const buffName of ["PoisonStrike", "DaggerPoison", "PoisonCloud", "ViperbladePoison"]) {
    assert.ok(
      buffNames.includes(buffName),
      `ContactPoison${rank} must cover ${buffName}`,
    );
  }
}

for (const [name, expected] of [
  ["ShadowTendrilDamage", "-0.06"],
  ["ShadowTendrilRank1", "-0.06"],
  ["ShadowTendrilRank4", "-0.06"],
  ["ShadowTendrilRank6", "-0.08"],
  ["ShadowTendrilRank8", "-0.08"],
  ["ShadowTendrilRank10", "-0.1"],
] as const) {
  const buff = block(buffs, "BuffType", "BuffName", name);
  assert.equal(tag(buff, "MeleeDefense"), expected, `${name} melee defense`);
  assert.equal(tag(buff, "MagicDefense"), expected, `${name} magic defense`);
}

for (const [rank, expected] of [[1, "6"], [6, "8"], [10, "10"]] as const) {
  assert.equal(
    tag(block(powers, "Power", "PowerName", `ShadowTendrilDash${rank}`), "UpgradeDescription"),
    `Tendril Defense reduction is ${expected}%.`
  );
}

assert.match(tag(block(powers, "Power", "PowerName", "HeartSeeker10"), "Description"), /40% bonus damage.*Black Miasma/);
assert.match(tag(block(powers, "Power", "PowerName", "BlackStorm10"), "Description"), /90% bonus damage.*Black Miasma/);
assert.match(tag(block(powers, "Power", "PowerName", "Assassinate3"), "Description"), /1% more damage per Bleed stack/);
assert.match(tag(block(powers, "Power", "PowerName", "Assassinate7"), "Description"), /1\.5% more damage per Bleed stack/);
assert.match(tag(block(powers, "Power", "PowerName", "Assassinate10"), "UpgradeDescription"), /2% damage per Bleed stack/);
assert.match(tag(block(powers, "Power", "PowerName", "AssassinateClose10"), "Description"), /2% more damage per Bleed stack/);

for (const [rank, targetBuff, upgrade] of [
  [5, "PoisonStrike,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding", /4 stacks of Bleed/],
  [6, "PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding", /2 stacks of Armor Bane and 6 stacks of Bleed/],
  [8, "PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding", /7 stacks of Bleed/],
  [10, "PoisonStrike,ArmorBane,ArmorBane,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding,Bleeding", /8 stacks of Bleed/],
] as const) {
  const assassinate = block(powers, "Power", "PowerName", `DeathBlowOld${rank}`);
  assert.equal(tag(assassinate, "AddTargetBuff"), targetBuff);
  assert.match(tag(assassinate, "UpgradeDescription"), upgrade);
  assert.match(tag(assassinate, "Description"), /one stack of Poison/);
}

for (let rank = 1; rank <= 10; rank += 1) {
  const assassinate = block(powers, "Power", "PowerName", `DeathBlowOld${rank}`);
  const targetBuff = tag(assassinate, "AddTargetBuff");
  assert.equal(targetBuff.split(",").filter((buff) => buff === "PoisonStrike").length, 1, `Assassinate rank ${rank} must apply exactly one Poison stack`);
  assert.equal(tag(assassinate, "AoERadius"), "200", `Assassinate rank ${rank} AoE radius`);
}

const reaper4 = block(powers, "Power", "PowerName", "Reaper4");
assert.equal(tag(reaper4, "AddTargetBuff"), "ArmorBane");
assert.match(tag(reaper4, "UpgradeDescription"), /Inflicts Armor Bane/);
assert.match(tag(block(powers, "Power", "PowerName", "Reaper10"), "Description"), /120% of Expertise/);
assert.match(tag(block(powers, "Power", "PowerName", "PainBender10"), "Description"), /225% of Expertise/);

assert.equal(tag(block(powers, "Power", "PowerName", "FalseTendrilDash10"), "BasePowerName"), "FalseTendrilDash");
assert.equal(tag(block(powers, "Power", "PowerName", "FalseChi10"), "BasePowerName"), "FalseChi");
const cloneScorpion = block(powers, "Power", "PowerName", "FalseScorpionSting10");
assert.equal(tag(cloneScorpion, "BasePowerName"), "FalseScorpionSting");
assert.match(tag(cloneScorpion, "AddTargetBuff"), /(?:^|,)ShadowLegionPoisonStrike(?:,|$)/);
assert.doesNotMatch(tag(cloneScorpion, "AddTargetBuff"), /(?:^|,)PoisonStrike(?:,|$)/);
const cloneMiasma = block(powers, "Power", "PowerName", "FalseTendrilDash10");
assert.match(cloneMiasma, /<AnimClass>a_ShadowCloud_Random_1_3<\/AnimClass>/);
const clonePoison = block(buffs, "BuffType", "BuffName", "ShadowLegionPoisonStrike");
assert.equal(tag(clonePoison, "BuffID"), "743");
assert.equal(tag(clonePoison, "DoTDamage"), "2");
assert.equal(tag(clonePoison, "DoTTickLength"), "1000");
assert.equal(tag(clonePoison, "StackCount"), "1");
for (const [name, id] of [
  ["ShadowLegionArmorBane", "744"],
  ["ShadowLegionBound", "745"],
  ["ShadowLegionCrippled", "746"],
  ["ShadowLegionWeakened", "747"],
] as const) {
  const cloneDebuff = block(buffs, "BuffType", "BuffName", name);
  assert.equal(tag(cloneDebuff, "BuffID"), id);
  assert.equal(tag(cloneDebuff, "StackCount"), "1");
}
for (const power of powers.match(/<Power PowerName="False(?:Chi|TendrilDash|ScorpionSting)(?:[1-9]|10)?">[\s\S]*?<\/Power>/g) ?? []) {
  const targetBuffs = tag(power, "AddTargetBuff").split(",").filter(Boolean);
  assert.equal(new Set(targetBuffs).size, targetBuffs.length, "clone debuffs must not repeat within one attack");
  assert.doesNotMatch(targetBuffs.join(","), /(?:^|,)(?:ArmorBane|Bound|Crippled|Weakened)(?:,|$)/);
}

for (const [sourceFamily, cloneFamily] of [
  ["DarkChi", "FalseChi"],
  ["ShadowTendrilDash", "FalseTendrilDash"],
  ["CrippleStrike", "FalseScorpionSting"],
] as const) {
  for (let rank = 0; rank <= 10; rank += 1) {
    const suffix = rank === 0 ? "" : String(rank);
    const source = block(powers, "Power", "PowerName", `${sourceFamily}${suffix}`);
    const clone = block(powers, "Power", "PowerName", `${cloneFamily}${suffix}`);
    assert.equal(tag(clone, "BasePowerName"), cloneFamily, `${cloneFamily}${suffix} loader-safe family`);
    for (const field of ["TargetMethod", "Range", "AoERadius", "CenterOffset", "FireImpulse", "CastAnim", "CastTime", "RecoverTime", "BaseDamageMult", "ProcModifier", "DamageType"] as const) {
      assert.equal(tag(clone, field), tag(source, field), `${cloneFamily}${suffix} ${field}`);
    }
  }
}
const cloneBasicAttack = block(powers, "Power", "PowerName", "FalseSaberMelee");
assert.doesNotMatch(tag(cloneBasicAttack, "AddTargetBuff"), /(?:^|,)Bound(?:,|$)/);
assert.match(tag(block(powers, "Power", "PowerName", "ShadowLegion10"), "Description"), /Bind with their special attacks/);

for (const name of ["PoisonDagger", "PoisonDagger1"]) {
  const basicRanged = block(powers, "Power", "PowerName", name);
  assert.equal(tag(basicRanged, "AddTargetBuff"), "ViperbladePoison", `${name} must retain its basic-attack Poison`);
  assert.match(tag(basicRanged, "Description"), /Ranged basic attacks leave Poison/);
}
assert.equal(
  tag(block(powers, "Power", "PowerName", "DaggerFlurry10"), "AddTargetBuff"),
  "DaggerPoison,DaggerPoison,ArmorBane",
  "ranged skills must not gain Viperblade Poison",
);
assert.equal(
  tag(block(powers, "Power", "PowerName", "SeverStrike10"), "AddTargetBuff"),
  "Bleeding,Bleeding",
  "melee skills must not gain Viperblade Bleed",
);
for (const power of powers.match(/<Power PowerName="[^"]+">[\s\S]*?<\/Power>/g) ?? []) {
  const name = power.match(/<Power PowerName="([^"]+)">/)?.[1] ?? "";
  const targetBuff = tag(power, "AddTargetBuff");
  assert.doesNotMatch(targetBuff, /(?:^|,)ViperbladeBleed(?:,|$)/, `${name} must not apply Viperblade Bleed`);
  if (name !== "PoisonDagger" && name !== "PoisonDagger1") {
    assert.doesNotMatch(targetBuff, /(?:^|,)ViperbladePoison(?:,|$)/, `${name} must not apply Viperblade Poison`);
  }
}
assert.doesNotMatch(buffs, /<BuffType BuffName="ViperbladeBleed">/);
assert.match(buffs, /<BuffType BuffName="ViperbladePoison">/);

assert.match(runtimePatch, /BlackStorm" \? 0\.9 : 0\.4/);
assert.match(runtimePatch, />= 10 \? 0\.02 : param2\.var_7 >= 7 \? 0\.015 : 0\.01/);
assert.match(runtimePatch, /_loc56_ > 0 \? "FalseTendrilDash" \+ String\(_loc56_\) : "FalseSaberMelee"/);
assert.match(runtimePatch, /_loc55_ > 0 \? "FalseChi" \+ String\(_loc55_\) : "FalseSaberMelee"/);
assert.match(runtimePatch, /_loc57_ > 0 \? "FalseScorpionSting" \+ String\(_loc57_\) : "FalseSaberMelee"/);
assert.match(runtimePatch, /_loc55_ = 0;\\n                     _loc56_ = 0;\\n                     _loc57_ = 0;/);
assert.match(runtimePatch, /const CLONE_SPAWN_REPLACEMENT = EQUIPPED_ONLY_CLONE_SPAWN_REPLACEMENT;/);
// Locals 55/56/57 were the numbering in one particular build of FireThisPower. Recompiling
// CombatState renumbers them, so the patch scans every local for the rank read instead of naming
// three, and caps the result at the three clone skills.
assert.match(equippedSkillPatch, /for \(let local = 0; local <= MAX_LOCAL; local \+= 1\)/);
assert.match(equippedSkillPatch, /patches\.length > 3/);
assert.doesNotMatch(equippedSkillPatch, /CLONE_SKILL_RANK_LOCALS = \[55, 56, 57\]/);
assert.match(equippedSkillPatch, /pushbyte 0; convert_i; setlocal/);
assert.match(runtimePatch, /"FalseTendrilDash" \+ \(_loc56_ > 0 \? String\(_loc56_\) : ""\),"FalseSaberMelee","FalseSaberMelee","FalseSaberMelee"/);
assert.match(runtimePatch, /"FalseChi" \+ \(_loc55_ > 0 \? String\(_loc55_\) : ""\),"FalseSaberMelee","FalseSaberMelee","FalseSaberMelee"/);
assert.match(runtimePatch, /"FalseScorpionSting" \+ \(_loc57_ > 0 \? String\(_loc57_\) : ""\),"FalseSaberMelee","FalseSaberMelee","FalseSaberMelee"/);
assert.match(runtimePatch, /_loc27_ = 1\.2/);
assert.match(runtimePatch, /_loc28_ = 2\.25/);
assert.match(talentstoneRuntimePatch, /param1\.var_1033/);
assert.match(talentstoneRuntimePatch, /var_971 \+ _loc37_\.combatState\.var_923/);
assert.match(talentstoneRuntimePatch, /_loc6_ -= this\.var_963 \?/);

console.log("Rogue follow-up balance regression tests passed.");
