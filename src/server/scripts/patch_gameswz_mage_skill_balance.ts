import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

type PatchStats = {
  powerBlocks: number;
  buffBlocks: number;
  modBlocks: number;
  entBlocks: number;
  changes: number;
};

const EMPTY_STATS: PatchStats = {
  powerBlocks: 0,
  buffBlocks: 0,
  modBlocks: 0,
  entBlocks: 0,
  changes: 0,
};

const POWER_XML = path.resolve(__dirname, "..", "..", "client", "content", "xml", "PlayerPowerTypes.xml");
const BUFF_XML = path.resolve(__dirname, "..", "..", "client", "content", "xml", "PlayerBuffTypes.xml");
const POWER_MOD_XML = path.resolve(__dirname, "..", "..", "client", "content", "xml", "PowerModTypes.xml");
const ENT_XML = path.resolve(__dirname, "..", "..", "client", "content", "xml", "EntTypes.xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");

type FireBrandShotDef = {
  name: string;
  powerID: number;
  targetMethod: "ProjectileCombo" | "Piercing";
  range?: number;
  aoeRadius?: number;
  baseDamageMult: string;
  addTargetBuff: string;
};

const FIREBRAND_SHOTS: FireBrandShotDef[] = [
  { name: "FireBrandShot1", powerID: 6143, targetMethod: "ProjectileCombo", aoeRadius: 90, baseDamageMult: "1", addTargetBuff: "Scorched" },
  { name: "FireBrandShot3", powerID: 6144, targetMethod: "ProjectileCombo", aoeRadius: 105, baseDamageMult: "1", addTargetBuff: "Scorched" },
  { name: "FireBrandShot6", powerID: 6145, targetMethod: "ProjectileCombo", aoeRadius: 120, baseDamageMult: "0.5", addTargetBuff: "Scorched,Burned" },
  { name: "FlameAxeFireBrandShot8", powerID: 6146, targetMethod: "ProjectileCombo", range: 800, baseDamageMult: "1", addTargetBuff: "Scorched" },
];

const DRAGON_SOUL_DESCRIPTION =
  "Summon a Spirit of Flame that copies your Fire Brand shots and shoots at your targets. Gain increased damage for the duration.";
const FIREBRAND_BASE_DURATION_MS = "7813";
const MINION_MASTER_SUMMON_POWERS = [
  "SummonGhoul",
  ...Array.from({ length: 10 }, (_, index) => `SummonGhoul${index + 1}`),
  "SummonRangedGhoul",
  ...Array.from({ length: 10 }, (_, index) => `SummonRangedGhoul${index + 1}`),
  "InfestationSpawn",
  ...Array.from({ length: 10 }, (_, index) => `InfestationSpawn${index + 1}`),
  "InfestationSpawnKing",
].join(",");

function cloneStats(): PatchStats {
  return { ...EMPTY_STATS };
}

function mergeStats(...stats: PatchStats[]): PatchStats {
  return stats.reduce(
    (merged, item) => ({
      powerBlocks: merged.powerBlocks + item.powerBlocks,
      buffBlocks: merged.buffBlocks + item.buffBlocks,
      modBlocks: merged.modBlocks + item.modBlocks,
      entBlocks: merged.entBlocks + item.entBlocks,
      changes: merged.changes + item.changes,
    }),
    cloneStats(),
  );
}

function rankOf(name: string, baseName: string): number {
  if (name === baseName) {
    return 10;
  }
  const suffix = name.slice(baseName.length);
  return suffix ? Math.max(1, Number(suffix) || 1) : 1;
}

function replaceTag(block: string, tag: string, value: string): { block: string; changed: boolean } {
  const next = block.replace(new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`), `<${tag}>${value}</${tag}>`);
  return { block: next, changed: next !== block };
}

function removeTag(block: string, tag: string): { block: string; changed: boolean } {
  const next = block.replace(new RegExp(`\\r?\\n\\t\\t<${tag}>[\\s\\S]*?</${tag}>`, "g"), "");
  return { block: next, changed: next !== block };
}

function upsertTagAfter(block: string, tag: string, value: string, afterTag: string): { block: string; changed: boolean } {
  if (new RegExp(`<${tag}>`).test(block)) {
    return replaceTag(block, tag, value);
  }
  const next = block.replace(
    new RegExp(`(<${afterTag}>[\\s\\S]*?</${afterTag}>)`),
    `$1\r\n\t\t<${tag}>${value}</${tag}>`,
  );
  return { block: next, changed: next !== block };
}

function numberList(value: string): number[] {
  return value.split(",").map((part) => Number(part.trim())).filter((value) => Number.isFinite(value));
}

function formatList(values: Array<number | string>): string {
  return values.map((value) => String(value)).join(",");
}

function addBuffs(list: string, ...buffs: string[]): string {
  const parts = list.split(",").map((part) => part.trim()).filter(Boolean);
  for (const buff of buffs) {
    if (!parts.includes(buff)) {
      parts.push(buff);
    }
  }
  return parts.join(",");
}

function setBuffCount(list: string, buffName: string, count: number): string {
  const parts = list.split(",").map((part) => part.trim()).filter((part) => part && part !== buffName);
  for (let index = 0; index < count; index += 1) {
    parts.push(buffName);
  }
  return parts.join(",");
}

function addTargetBuff(block: string, ...buffs: string[]): { block: string; changed: boolean } {
  const match = block.match(/<AddTargetBuff>([^<]*)<\/AddTargetBuff>/);
  if (match) {
    const nextBuffs = addBuffs(match[1], ...buffs);
    return replaceTag(block, "AddTargetBuff", nextBuffs);
  }
  return upsertTagAfter(block, "AddTargetBuff", buffs.join(","), "PowerGroup");
}

function removeTargetBuff(block: string, ...buffs: string[]): { block: string; changed: boolean } {
  const match = block.match(/<AddTargetBuff>([^<]*)<\/AddTargetBuff>/);
  if (!match) {
    return { block, changed: false };
  }
  const removeSet = new Set(buffs);
  const nextBuffs = match[1].split(",").map((part) => part.trim()).filter((part) => part && !removeSet.has(part)).join(",");
  return replaceTag(block, "AddTargetBuff", nextBuffs);
}

function removeSelfBuff(block: string, ...buffs: string[]): { block: string; changed: boolean } {
  const match = block.match(/<AddSelfBuff>([^<]*)<\/AddSelfBuff>/);
  if (!match) {
    return { block, changed: false };
  }
  const removeSet = new Set(buffs);
  const nextBuffs = match[1].split(",").map((part) => part.trim()).filter((part) => part && !removeSet.has(part)).join(",");
  if (nextBuffs) {
    return replaceTag(block, "AddSelfBuff", nextBuffs);
  }
  return removeTag(block, "AddSelfBuff");
}

function addSelfBuff(block: string, ...buffs: string[]): { block: string; changed: boolean } {
  const match = block.match(/<AddSelfBuff>([^<]*)<\/AddSelfBuff>/);
  if (match) {
    const nextBuffs = addBuffs(match[1], ...buffs);
    return replaceTag(block, "AddSelfBuff", nextBuffs);
  }
  return upsertTagAfter(block, "AddSelfBuff", buffs.join(","), "PowerGroup");
}

function setSelfBuffCount(block: string, buffName: string, count: number): { block: string; changed: boolean } {
  const match = block.match(/<AddSelfBuff>([^<]*)<\/AddSelfBuff>/);
  if (!match) {
    return upsertTagAfter(block, "AddSelfBuff", Array(count).fill(buffName).join(","), "PowerGroup");
  }
  return replaceTag(block, "AddSelfBuff", setBuffCount(match[1], buffName, count));
}

function setTargetBuffCount(block: string, buffName: string, count: number): { block: string; changed: boolean } {
  const match = block.match(/<AddTargetBuff>([^<]*)<\/AddTargetBuff>/);
  if (!match) {
    return upsertTagAfter(block, "AddTargetBuff", Array(count).fill(buffName).join(","), "PowerGroup");
  }
  return replaceTag(block, "AddTargetBuff", setBuffCount(match[1], buffName, count));
}

function apply(block: string, stats: PatchStats, patch: { block: string; changed: boolean }): string {
  if (patch.changed) {
    stats.changes += 1;
  }
  return patch.block;
}

function buildFireBrandShotPower(def: FireBrandShotDef): string {
  const areaTags = [
    def.range ? `\t\t<Range>${def.range}</Range>` : "",
    def.aoeRadius ? `\t\t<AoERadius>${def.aoeRadius}</AoERadius>` : "",
  ].filter(Boolean).join("\r\n");
  const isPiercingBasicShot = def.name === "FlameAxeFireBrandShot8";
  return [
    `\t<Power PowerName="${def.name}">`,
    `\t\t<PowerID>${def.powerID}</PowerID>`,
    `\t\t<TargetMethod>${def.targetMethod}</TargetMethod>`,
    areaTags,
    "\t\t<CastAnim>Shoot</CastAnim>",
    "\t\t<CastTime>0</CastTime>",
    "\t\t<RecoverTime>500</RecoverTime>",
    "\t\t<CoolDownTime>0</CoolDownTime>",
    "\t\t<ManaCost>0,1</ManaCost>",
    `\t\t<BaseDamageMult>${def.baseDamageMult}</BaseDamageMult>`,
    "\t\t<ProcModifier>0</ProcModifier>",
    "\t\t<DamageType>Fire</DamageType>",
    "\t\t<PowerGroup>FireBrandShot</PowerGroup>",
    `\t\t<AddTargetBuff>${def.addTargetBuff}</AddTargetBuff>`,
    isPiercingBasicShot ? "\t\t<DisplayName>Fireball</DisplayName>" : "\t\t<DisplayName>Fire Brand Shot</DisplayName>",
    isPiercingBasicShot
      ? "\t\t<Description>Flameseer basic ranged attack. Pierces through targets instead of stopping on hit.</Description>"
      : "\t\t<Description>Ranged attacks deal fire damage while Fire Brand is active.</Description>",
    isPiercingBasicShot ? "\t\t<IconName>a_PowerIcon_FireBall</IconName>" : "\t\t<IconName>a_PowerIcon_CrimsonShot</IconName>",
    isPiercingBasicShot
      ? "\t\t<CastSound>CHR_FlameSeer_Fireball_Fire_01|CHR_FlameSeer_Fireball_Fire_02|CHR_FlameSeer_Fireball_Fire_03</CastSound>"
      : "\t\t<CastSound>CHR_Flameseer_CrimsonShot_A</CastSound>",
    "\t\t<CastGfx/>",
    "\t\t<CastAnimSource>Feet</CastAnimSource>",
    "\t\t<FireSound>snd_pwr_range_fireball_imp_01</FireSound>",
    "\t\t<FireAnimSource>Center</FireAnimSource>",
    isPiercingBasicShot
      ? "\t\t<FireGfx>\r\n\t\t\t<AnimFile>SFX_1.swf</AnimFile>\r\n\t\t\t<AnimClass>a_CrimsonShotImpact</AnimClass>\r\n\t\t\t<AnimScale>1</AnimScale>\r\n\t\t\t<FireAndForget>true</FireAndForget>\r\n\t\t</FireGfx>"
      : "\t\t<FireGfx/>",
    "\t\t<HitGfx/>",
    "\t\t<ProjGfx>",
    "\t\t\t<AnimFile>SFX_1.swf</AnimFile>",
    "\t\t\t<AnimClass>a_CrimsonShotMolten,a_CrimsonShotSuper</AnimClass>",
    "\t\t\t<AnimScale>1</AnimScale>",
    "\t\t\t<FireAndForget>FALSE</FireAndForget>",
    "\t\t</ProjGfx>",
    "\t</Power>",
  ].filter(Boolean).join("\r\n");
}

function ensureFireBrandShotPowers(xml: string, stats: PatchStats): string {
  const withoutFireBrandShots = xml.replace(
    /\r?\n\t<Power PowerName="(?:FireBrandShot(?:1|3|4|6|7|8)|FlameAxeFireBrandShot8)">[\s\S]*?\r?\n\t<\/Power>/g,
    "",
  );
  const fireBrandShotXml = FIREBRAND_SHOTS.map(buildFireBrandShotPower).join("\r\n");
  const patched = withoutFireBrandShots.replace(
    /(\r?\n\t<Power PowerName="FireBrand10">[\s\S]*?\r?\n\t<\/Power>)/,
    `$1\r\n${fireBrandShotXml}`,
  );
  if (patched !== xml) {
    stats.changes += 1;
  }
  return patched;
}

function fireBrandOverrideForBuff(buffName: string): string | null {
  if (buffName === "FireBrand" || buffName === "FireBrandRank1") {
    return "FireBrandShot1";
  }
  if (buffName === "FireBrandRank3") {
    return "FireBrandShot3";
  }
  if (buffName === "FireBrandRank6") {
    return "FireBrandShot6";
  }
  if (buffName === "FireBrandRank8") {
    return "FlameAxeFireBrandShot8";
  }
  return null;
}

function dragonSoulSpawnDurationForRank(rank: number): string {
  if (rank >= 8) {
    return String(rank >= 9 ? 15000 : 14500);
  }
  if (rank >= 6) {
    return "13500";
  }
  if (rank >= 3) {
    return "13000";
  }
  if (rank >= 2) {
    return "12000";
  }
  return "11000";
}

function dragonSoulBuffDurationForName(buffName: string): string {
  if (buffName === "DragonSoulRank8" || buffName === "DragonSoulEffect") {
    return "15000";
  }
  if (buffName === "DragonSoulRank3") {
    return "13500";
  }
  return "12000";
}

function patchPowerBlock(powerName: string, block: string, stats: PatchStats): string {
  let next = block;

  if (/^FrozenWard(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    const rank = rankOf(powerName, "FrozenWard");
    const castParts = (next.match(/<CastTime>([^<]+)<\/CastTime>/)?.[1] ?? "0,2200")
      .split(",")
      .map((part) => part.trim());
    const normalizedCast = castParts.map((_part, index) => (index === 1 ? "1650" : "0")).join(",");
    next = apply(next, stats, replaceTag(next, "CastTime", normalizedCast));
    if (next.includes("<ReleaseTime>")) {
      next = apply(next, stats, replaceTag(next, "ReleaseTime", "650"));
    }
    const match = next.match(/<AddTargetBuff>([^<]*)<\/AddTargetBuff>/);
    if (match && rank >= 4) {
      next = apply(next, stats, replaceTag(next, "AddTargetBuff", setBuffCount(match[1], "Chilblains", rank >= 8 ? 2 : 1)));
    }
  } else if (/^FrostBlast(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    next = apply(next, stats, addTargetBuff(next, "Weakened"));
  } else if (/^FrigidComet(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    const damage = next.match(/<BaseDamageMult>([^<]+)<\/BaseDamageMult>/)?.[1];
    if (damage && !damage.includes(",")) {
      next = apply(next, stats, replaceTag(next, "BaseDamageMult", `${damage},${damage}`));
    }
    const castTime = next.match(/<CastTime>([^<]+)<\/CastTime>/)?.[1];
    if (castTime && !castTime.includes(",")) {
      next = apply(next, stats, replaceTag(next, "CastTime", `${castTime},150`));
    }
    const aoeRadius = next.match(/<AoERadius>([^<]+)<\/AoERadius>/)?.[1];
    if (aoeRadius && !aoeRadius.includes(",")) {
      next = apply(next, stats, replaceTag(next, "AoERadius", `${aoeRadius},${aoeRadius}`));
    }
  } else if (/^Avalanche(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    const castParts = (next.match(/<CastTime>([^<]+)<\/CastTime>/)?.[1] ?? "520,150").split(",");
    const normalizedCast = castParts.map((_part, index) => (index === 0 ? "364" : "105")).join(",");
    next = apply(next, stats, replaceTag(next, "CastTime", normalizedCast));
    next = apply(next, stats, replaceTag(next, "ManaCost", "35"));
    next = apply(next, stats, addTargetBuff(next, "FreezeSpire10", "Chilled42", "Frigid"));
  } else if (/^PermafrostCloneExplode(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    next = apply(next, stats, removeTargetBuff(next, "Chilblains"));
  } else if (/^IridescentBurst(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    next = apply(next, stats, addTargetBuff(next, "Weakened"));
  } else if (/^FlameStrike(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    next = apply(next, stats, addTargetBuff(next, "Crippled"));
  } else if (/^MoltenFist(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    next = apply(next, stats, removeTargetBuff(next, "StunStrike2000", "MoltenFistStun1000", "MoltenFistStun2000"));
    next = apply(next, stats, addTargetBuff(next, "Crippled", "Dazed"));
  } else if (/^Pyromania(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    next = apply(next, stats, replaceTag(next, "ManaCost", "0"));
    next = apply(next, stats, replaceTag(next, "CoolDownTime", "10000"));
  } else if (/^FireBrand(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    const rank = rankOf(powerName, "FireBrand");
    const buff = rank >= 8 ? "FireBrandRank8" : rank >= 6 ? "FireBrandRank6" : rank >= 3 ? "FireBrandRank3" : "FireBrandRank1";
    next = apply(next, stats, replaceTag(next, "AddTargetBuff", buff));
    next = apply(next, stats, replaceTag(next, "CoolDownTime", "20000"));
  } else if (/^SummonDragonSoul(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    const rank = rankOf(powerName, "SummonDragonSoul");
    next = apply(next, stats, removeSelfBuff(next, "FireBrand", "FireBrandRank1", "FireBrandRank3", "FireBrandRank6", "FireBrandRank8"));
    next = apply(next, stats, replaceTag(next, "SpawnDuration", dragonSoulSpawnDurationForRank(rank)));
    next = apply(next, stats, replaceTag(next, "Description", DRAGON_SOUL_DESCRIPTION));
    if (
      next.includes(
        "<UpgradeDescription>Summon a Spirit of Flame that shoots at your targets. Gain increased Damage but reduced Defense for the duration.</UpgradeDescription>",
      )
    ) {
      next = apply(next, stats, replaceTag(next, "UpgradeDescription", DRAGON_SOUL_DESCRIPTION));
    }
  } else if (/^Lifethirst(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    const rank = rankOf(powerName, "Lifethirst");
    next = apply(next, stats, addSelfBuff(next, rank >= 8 ? "MinionMaster5" : rank >= 4 ? "MinionMaster3" : "MinionMaster1"));
  } else if (/^ProcLifethirstPets(?:4|7|10)$/.test(powerName)) {
    stats.powerBlocks += 1;
    const petBuff = powerName.endsWith("10") ? "MinionMaster5" : powerName.endsWith("7") ? "MinionMaster4" : "MinionMaster3";
    next = apply(next, stats, addTargetBuff(next, petBuff));
  } else if (powerName === "GhoulMelee") {
    stats.powerBlocks += 1;
    next = apply(next, stats, replaceTag(next, "BaseDamageMult", "1.1"));
  } else if (powerName === "GhoulFireball" || powerName === "Ghoul2Melee") {
    stats.powerBlocks += 1;
    next = apply(next, stats, replaceTag(next, "BaseDamageMult", "0.825"));
  } else if (powerName === "Ghoul2Fireball") {
    stats.powerBlocks += 1;
    next = apply(next, stats, replaceTag(next, "BaseDamageMult", "1.1"));
    next = apply(next, stats, next.includes("<AddTargetBuff>") ? addTargetBuff(next, "PoisonCloud") : upsertTagAfter(next, "AddTargetBuff", "PoisonCloud", "DamageType"));
  } else if (/^SpectralGrasp(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    next = apply(next, stats, replaceTag(next, "TargetMethod", "RangedAoE"));
  } else if (/^DeathMark(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    next = apply(next, stats, addTargetBuff(next, "PoisonCloud"));
    next = apply(next, stats, removeTargetBuff(next, "DeathMarkUndeadVulnerability"));
  } else if (/^BansheeWail(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    const rank = powerName === "BansheeWail" ? 1 : rankOf(powerName, "BansheeWail");
    const damageByRank: Record<number, string> = {
      1: "1.99",
      2: "2.185",
      3: "2.357",
      4: "2.53",
      5: "2.702",
      6: "2.875",
      7: "3.047",
      8: "3.22",
      9: "3.45",
      10: "3.818",
    };
    next = apply(next, stats, replaceTag(next, "BaseDamageMult", damageByRank[rank] ?? "1.99"));
  } else if (/^PlagueBattalion(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    const rank = rankOf(powerName, "PlagueBattalion");
    if (rank >= 8) {
      next = apply(next, stats, setTargetBuffCount(next, "PlagueBattalion", 3));
      next = apply(next, stats, setSelfBuffCount(next, "PlagueBattalion", 3));
    } else {
      next = apply(next, stats, addTargetBuff(next, "PlagueBattalion"));
      next = apply(next, stats, addSelfBuff(next, "PlagueBattalion"));
    }
    next = apply(next, stats, addSelfBuff(next, "PlagueStackLimit"));
  } else if (/^VineLance(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    const rank = rankOf(powerName, "VineLance");
    if (rank >= 3) {
      next = apply(next, stats, addTargetBuff(next, "PoisonCloud"));
    }
  } else if (/^IceSpike(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    next = apply(next, stats, replaceTag(next, "ManaCost", "30"));
  } else if (/^Meteor(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    next = apply(next, stats, removeSelfBuff(next, "MeteorChannelSlow"));
  } else if (/^IceStorm(?:\d+)?$/.test(powerName)) {
    stats.powerBlocks += 1;
    next = apply(next, stats, replaceTag(next, "CastTime", "855,503,443"));
    next = apply(next, stats, addTargetBuff(next, "Chilblains"));
  }

  return next;
}

export function patchPlayerPowers(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  let patchedXml = ensureFireBrandShotPowers(xml, stats);

  patchedXml = patchedXml.replace(
    /<Power PowerName="([^"]+)">[\s\S]*?<\/Power>/g,
    (powerBlock: string, powerName: string) => patchPowerBlock(powerName, powerBlock, stats),
  );
  return { xml: patchedXml, stats };
}

function patchBuffBlock(buffName: string, block: string, stats: PatchStats): string {
  let next = block;

  if (/^DragonSoul(?:Effect|Rank\d+)$/.test(buffName)) {
    stats.buffBlocks += 1;
    next = next.replace(/\r?\n\t\t<MagicDefense>[^<]+<\/MagicDefense>/, "");
    next = next.replace(/\r?\n\t\t<MeleeDefense>[^<]+<\/MeleeDefense>/, "");
    next = apply(next, stats, replaceTag(next, "Duration", dragonSoulBuffDurationForName(buffName)));
  } else if (/^Pyromania(?:\d+)?$/.test(buffName)) {
    stats.buffBlocks += 1;
    next = apply(next, stats, replaceTag(next, "Duration", "8000"));
  } else if (/^Flamethrower(?:Rank\d+)?$/.test(buffName)) {
    stats.buffBlocks += 1;
    next = apply(next, stats, replaceTag(next, "Duration", "1000"));
  } else if (/^MinionMaster\d+$/.test(buffName)) {
    stats.buffBlocks += 1;
    next = apply(next, stats, replaceTag(next, "Duration", "5000"));
    const rank = Number(buffName.match(/\d+$/)?.[0] ?? 1);
    next = apply(next, stats, upsertTagAfter(next, "MeleeDamage", String((rank * 0.01).toFixed(2)), "MagicDamage"));
  } else if (/^FireBrand(?:Rank\d+)?$/.test(buffName)) {
    stats.buffBlocks += 1;
    next = apply(next, stats, replaceTag(next, "Duration", FIREBRAND_BASE_DURATION_MS));
    next = apply(next, stats, replaceTag(next, "BuffLoc", "FeetBack"));
    const rangedOverride = fireBrandOverrideForBuff(buffName);
    if (rangedOverride) {
      next = apply(next, stats, upsertTagAfter(next, "RangedOverride", rangedOverride, "Duration"));
    }
  }

  return next;
}

export function patchPlayerBuffs(xml: string): { xml: string; stats: PatchStats } {
  let patchedXml = xml;
  const stats = cloneStats();

  const cleanedXml = patchedXml.replace(
    /\r?\n\t<BuffType BuffName="(?:MeteorChannelSlow|FireBrandRank4|FireBrandRank7|DeathMarkUndeadVulnerability|MoltenFistStun1000|MoltenFistStun2000)">[\s\S]*?\r?\n\t<\/BuffType>/g,
    "",
  );
  if (cleanedXml !== patchedXml) {
    patchedXml = cleanedXml;
    stats.changes += 1;
  }

  const patchedBlocks = patchedXml.replace(
    /<BuffType BuffName="([^"]+)">[\s\S]*?<\/BuffType>/g,
    (buffBlock: string, buffName: string) => patchBuffBlock(buffName, buffBlock, stats),
  );
  return { xml: patchedBlocks, stats };
}

function patchPowerModBlock(modName: string, block: string, stats: PatchStats): string {
  let next = block;
  const valueByMod: Record<string, string[]> = {
    BurnDmg: [".07", ".14", ".21", ".28", ".35"],
    ChilblainsDmg: [".02", ".06", ".12", ".2", ".25"],
    DryIce: [".75", "1.5", "2.5", "3.75", "5"],
    IceCasket: ["1", "2", "3", "4", "5"],
    ColdHeart: ["-100", "-200", "-300", "-400", "-500"],
    IgniteCrit: [".02", ".04", ".06", ".08", ".1"],
    PoisonDmg: [".07", ".14", ".21", ".28", ".35"],
    CurseCrit: [".02", ".04", ".06", ".08", ".1"],
  };
  const descriptions: Record<string, string> = {
    BurnDmg: "Increases Burn Damage@Burn Damage:, +7%, +14%, +21%, +28%, +35%",
    ChilblainsDmg: "Increases Chilblains Damage@Chilblains Damage:, +4%, +12%, +24%, +40%, +50%",
    DryIce: "Increases Ice damage based on your Expertise.@Damage (%Expertise):, 75%, 150%, 250%, 375%, 500%",
    IceCasket: "Increases Freeze Durability based on your Expertise.@Durability (%Expertise):, 100%, 200%, 300%, 400%, 500%",
    ColdHeart: "Reduces the target's healing effects.@Healing Reduction:, 10%, 20%, 30%, 40%, 50%",
    IgniteCrit: "Gain a Poison Damage bonus against Cursed targets.@Poison Damage Bonus:, 2%, 4%, 6%, 8%, 10%",
    PoisonDmg: "Increases Poison Damage@Poison Damage:, +7%, +14%, +21%, +28%, +35%",
    CurseCrit: "Gain a Critical Chance bonus vs. Cursed Targets@Critical Chance Bonus:, 2%, 4%, 6%, 8%, 10%",
  };

  const rankMatch = modName.match(/^(BurnDmg|ChilblainsDmg|DryIce|IceCasket|ColdHeart|IgniteCrit|PoisonDmg|CurseCrit)([1-5])$/);
  if (rankMatch) {
    stats.modBlocks += 1;
    const [, group, rankText] = rankMatch;
    const value = valueByMod[group][Number(rankText) - 1];
    const valueTag = group === "ColdHeart" ? "StatValue" : group === "IgniteCrit" || group === "CurseCrit" ? "SelfValue" : "BuffValue";
    next = apply(next, stats, replaceTag(next, valueTag, value));
    if (rankText === "1" && descriptions[group]) {
      next = apply(next, stats, replaceTag(next, "Description", descriptions[group]));
    }
    if (group === "IgniteCrit") {
      next = apply(next, stats, upsertTagAfter(next, "BuffName", "Cursed", "ModType"));
      next = apply(next, stats, upsertTagAfter(next, "BuffProperty", "PoisonMultiplier", "BuffName"));
    }
  }

  const minionMasterMatch = modName.match(/^MinionMaster([1-5])$/);
  if (minionMasterMatch) {
    stats.modBlocks += 1;
    next = apply(next, stats, replaceTag(next, "ModType", "Power"));
    next = apply(next, stats, removeTag(next, "SelfValue"));
    next = apply(next, stats, upsertTagAfter(next, "PowerName", MINION_MASTER_SUMMON_POWERS, "ModType"));
    next = apply(next, stats, upsertTagAfter(next, "PowerProperty", "AddSelfBuff", "PowerName"));
    next = apply(next, stats, upsertTagAfter(next, "PowerValue", `Append:${modName}`, "PowerProperty"));
    if (minionMasterMatch[1] === "1") {
      next = apply(
        next,
        stats,
        replaceTag(next, "Description", "Increased Expertise for 5 sec whenever you summon an Undead Minion@Expertise Bonus:, 1%, 2%, 3%, 4%, 5%"),
      );
    }
  }

  if (modName === "RuneSummonGhoul") {
    stats.modBlocks += 1;
    next = apply(next, stats, replaceTag(next, "Description", "+10% Call the Horde ghoul damage"));
    next = apply(next, stats, replaceTag(next, "PowerValue", ".1"));
  } else if (modName === "RuneSummonRangedGhoul") {
    stats.modBlocks += 1;
    next = apply(next, stats, replaceTag(next, "Description", "Bolster ghoul ranged attacks inflict Poison"));
    next = apply(next, stats, replaceTag(next, "PowerName", "Ghoul2Fireball"));
    next = apply(next, stats, replaceTag(next, "PowerValue", "Append:PoisonCloud"));
  }

  const maxMatch = modName.match(/^ChilblainsMax([1-5])$/);
  if (maxMatch) {
    stats.modBlocks += 1;
    const values = ["2", "4", "6", "7", "8"];
    next = apply(next, stats, replaceTag(next, "BuffValue", values[Number(maxMatch[1]) - 1]));
  }

  return next;
}

export function patchPowerMods(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const patchedXml = xml.replace(
    /<PowerModType>\s*<ModName>([^<]+)<\/ModName>[\s\S]*?<\/PowerModType>/g,
    (modBlock: string, modName: string) => patchPowerModBlock(modName.trim(), modBlock, stats),
  );
  return { xml: patchedXml, stats };
}

function patchEntBlock(entName: string, block: string, stats: PatchStats): string {
  let next = block;
  const guardRank = entName.match(/^SummonGuard(?:([1-9]|10))?$/);
  const polarRank = entName.match(/^PolarSentry(?:([1-9]|10))?$/);
  const ghoulRank = entName.match(/^GhoulGuard([1-9]|10)$/);
  const rangedGhoulRank = entName.match(/^Ghoul2Guard([1-9]|10)$/);
  const infestationSpawn = entName.match(/^InfestationSpawn(?:[1-3]|King)$/);

  if (guardRank) {
    stats.entBlocks += 1;
    const rank = Number(guardRank[1] ?? 10);
    const hitPointsByRank = ["0", "0.9", "1.03", "1.03", "1.03", "1.2", "1.2", "1.2", "1.44", "1.44", "1.44"];
    const armorByRank = ["0", "1.2", "1.2", "1.38", "1.38", "1.38", "1.56", "1.56", "1.56", "1.92", "1.92"];
    next = apply(next, stats, replaceTag(next, "HitPoints", hitPointsByRank[rank] ?? "1.44"));
    next = apply(next, stats, replaceTag(next, "ArmorClass", armorByRank[rank] ?? "1.92"));
    if (!next.includes("<Powers>")) {
      next = apply(next, stats, upsertTagAfter(next, "Powers", "MagePetUber", "MeleePower"));
    }
    if (rank >= 7 && next.includes("<Powers>")) {
      const powers = next.match(/<Powers>([^<]*)<\/Powers>/)?.[1] ?? "";
      next = apply(next, stats, replaceTag(next, "Powers", addBuffs(powers, "MagePetUber")));
    }
  } else if (polarRank) {
    stats.entBlocks += 1;
    const rank = Number(polarRank[1] ?? 10);
    if (!next.includes("<Duration>")) {
      next = apply(next, stats, upsertTagAfter(next, "Duration", String(rank >= 8 ? 5000 : rank >= 4 ? 4000 : 3000), "Behavior"));
    } else {
      next = apply(next, stats, replaceTag(next, "Duration", String(rank >= 8 ? 5000 : rank >= 4 ? 4000 : 3000)));
    }
  } else if (entName === "DragonSoul") {
    stats.entBlocks += 1;
    if (!next.includes("<Duration>")) {
      next = apply(next, stats, upsertTagAfter(next, "Duration", "15000", "Behavior"));
    } else {
      next = apply(next, stats, replaceTag(next, "Duration", "15000"));
    }
  } else if (ghoulRank || rangedGhoulRank || infestationSpawn) {
    stats.entBlocks += 1;
    next = apply(next, stats, replaceTag(next, "HitPoints", "0.1"));
    next = apply(next, stats, replaceTag(next, "MeleeDamage", "0.1"));
    next = apply(next, stats, replaceTag(next, "MagicDamage", "0.1"));
    next = apply(next, stats, replaceTag(next, "ArmorClass", "0.1"));
  }

  return next;
}

export function patchEntTypes(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const patchedXml = xml.replace(
    /<EntType EntName="([^"]+)"[^>]*>[\s\S]*?<\/EntType>/g,
    (entBlock: string, entName: string) => patchEntBlock(entName, entBlock, stats),
  );
  return { xml: patchedXml, stats };
}

function patchFile(filePath: string, patcher: (xml: string) => { xml: string; stats: PatchStats }, verifyOnly: boolean): PatchStats {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = patcher(original);
  if (patched.xml === original) {
    return { ...patched.stats, changes: 0 };
  }
  if (!verifyOnly && patched.xml !== original) {
    fs.writeFileSync(filePath, patched.xml, "utf8");
  }
  return patched.stats;
}

function patchSwz(swzPath: string, verifyOnly: boolean): PatchStats {
  const ctx = parseSwz(swzPath);
  const stats: PatchStats[] = [];
  const resources = [
    { marker: "<PlayerPowerTypes", patcher: patchPlayerPowers },
    { marker: "<PlayerBuffTypes", patcher: patchPlayerBuffs },
    { marker: "<PowerModTypes", patcher: patchPowerMods },
    { marker: "<EntTypes", patcher: patchEntTypes },
  ];

  let changed = false;
  for (const resource of resources) {
    const chunk = ctx.chunks.find((entry) => entry.xml.includes(resource.marker));
    if (!chunk) {
      continue;
    }
    const original = chunk.xml;
    const patched = resource.patcher(original);
    if (patched.xml !== original) {
      stats.push(patched.stats);
      chunk.xml = patched.xml;
      changed = true;
    } else {
      stats.push({ ...patched.stats, changes: 0 });
    }
  }

  if (!verifyOnly && changed) {
    ensureBackup(swzPath);
    writeSwz(ctx);
  }

  return mergeStats(...stats);
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function main(): number {
  const args = process.argv.slice(2);
  const verifyOnly = hasFlag(args, "--verify") || hasFlag(args, "--dry-run");
  const swzPaths = ["Game.swz", "Game.en.swz", "Game.tr.swz"].map((file) => path.join(CBQ_DIR, file)).filter(fs.existsSync);

  try {
    const xmlStats = mergeStats(
      patchFile(POWER_XML, patchPlayerPowers, verifyOnly),
      patchFile(BUFF_XML, patchPlayerBuffs, verifyOnly),
      patchFile(POWER_MOD_XML, patchPowerMods, verifyOnly),
      patchFile(ENT_XML, patchEntTypes, verifyOnly),
    );
    const swzStats = mergeStats(...swzPaths.map((swzPath) => patchSwz(swzPath, verifyOnly)));
    const stats = mergeStats(xmlStats, swzStats);
    console.log(JSON.stringify({ verifyOnly, swzPaths, stats }, null, 2));
    console.log(stats.changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_gameswz_mage_skill_balance] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
