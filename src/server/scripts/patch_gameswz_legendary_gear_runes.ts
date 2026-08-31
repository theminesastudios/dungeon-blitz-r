import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";
import { ROGUE_GEAR_EFFECT_PROPERTY, ROGUE_GEAR_RUNE_EFFECTS } from "./rogueGearRuneEffects";

type PatchResult = { xml: string; changes: number; matchedGearIds: Set<string> };
interface LegendarySkillPair { primaryRune: string; secondaryPower: string; secondaryName: string }

/** Issue #765's Rare -> Legendary distribution. Rare gear keeps its original single-skill rune. */
const LEGENDARY_SKILL_PAIRS: LegendarySkillPair[] = [
  // Mage
  { primaryRune: "IceSpike", secondaryPower: "FrozenWard", secondaryName: "Frozen Ward" },
  { primaryRune: "FireBlast", secondaryPower: "FlameSpout", secondaryName: "Inferno" },
  { primaryRune: "VineLance", secondaryPower: "Desecrate", secondaryName: "Desecrate" },
  { primaryRune: "IceNova", secondaryPower: "FrigidComet", secondaryName: "Frigid Comet" },
  { primaryRune: "FirePillar", secondaryPower: "FireStorm", secondaryName: "Conflagration" },
  { primaryRune: "PoisonCloud", secondaryPower: "SpectralGrasp", secondaryName: "Spectral Grasp" },
  { primaryRune: "HailstoneEmbrace", secondaryPower: "GlacialSpear", secondaryName: "Glacial Spear" },
  { primaryRune: "SummonDragonSoul", secondaryPower: "FireBrandShot", secondaryName: "Firebrand" },
  { primaryRune: "PlagueBattalion", secondaryPower: "DeathMark", secondaryName: "Death Mark" },
  { primaryRune: "IceStorm", secondaryPower: "Avalanche", secondaryName: "Frost Spire" },
  { primaryRune: "Meteor", secondaryPower: "MoltenFistExplode", secondaryName: "Molten Fist" },
  { primaryRune: "SummonGuard", secondaryPower: "BansheeWail", secondaryName: "Wail of the Banshee" },
  { primaryRune: "PermafrostClone", secondaryPower: "FrostBlast", secondaryName: "Arctic Blast" },
  { primaryRune: "WildFire", secondaryPower: "IridescentBurst", secondaryName: "Iridescent Burst" },
  { primaryRune: "SummonGhoul", secondaryPower: "Lifethirst", secondaryName: "Lifethirst" },
  { primaryRune: "PolarSentry", secondaryPower: "BitterBlade", secondaryName: "Bitter Blade" },
  { primaryRune: "Pyromania", secondaryPower: "FlameStrike", secondaryName: "Molten Rain" },
  { primaryRune: "SummonRangedGhoul", secondaryPower: "Infestation", secondaryName: "Infestation" },
  // Rogue
  { primaryRune: "PoisonStrike", secondaryPower: "FatiguingStrike", secondaryName: "Hex Blade" },
  { primaryRune: "QuickStrike", secondaryPower: "SeverStrike", secondaryName: "Severing Strike" },
  { primaryRune: "StunStrike", secondaryPower: "CrippleStrike", secondaryName: "Scorpion Sting" },
  { primaryRune: "RootStrike", secondaryPower: "ChaosArmor", secondaryName: "Chaos Wave" },
  { primaryRune: "SteelCyclone", secondaryPower: "VitalStrike", secondaryName: "Shadow Rend" },
  { primaryRune: "Enfeeble", secondaryPower: "WhitheringMist", secondaryName: "Withering Mist" },
  { primaryRune: "GhostBlade", secondaryPower: "PoisonLance", secondaryName: "Necrotic Surge" },
  { primaryRune: "SeekingBlades", secondaryPower: "AssassinateClose", secondaryName: "Vicious Assault" },
  { primaryRune: "ShadowStep", secondaryPower: "DarkChi", secondaryName: "Dark Chi" },
  { primaryRune: "HawkStrike", secondaryPower: "Reaper", secondaryName: "Shadow Scythe" },
  { primaryRune: "Decoy", secondaryPower: "DeathBlowOld", secondaryName: "Assassinate" },
  { primaryRune: "ReduceArmor", secondaryPower: "BlackStorm", secondaryName: "Black Storm" },
  { primaryRune: "ShadowBlade", secondaryPower: "DaggerFlurry", secondaryName: "Flurry of Daggers" },
  { primaryRune: "MistWalk", secondaryPower: "WitherStrike", secondaryName: "Withering Impact" },
  { primaryRune: "ShadowArmor", secondaryPower: "HeartSeeker", secondaryName: "Heart Seeker" },
  { primaryRune: "SoulReaver", secondaryPower: "PainBender", secondaryName: "Butcher's Boon" },
  { primaryRune: "SoulShatter", secondaryPower: "Devour", secondaryName: "Devour" },
  { primaryRune: "ShadowLegion", secondaryPower: "ShadowTendrilDash", secondaryName: "Black Miasma" },
  // Paladin
  { primaryRune: "Skewer", secondaryPower: "Subjugate", secondaryName: "Subjugate" },
  { primaryRune: "Cleave", secondaryPower: "RollingSmash", secondaryName: "Holy Smash" },
  { primaryRune: "Smash", secondaryPower: "FlameAxe", secondaryName: "Flame Axe" },
  { primaryRune: "Warcry", secondaryPower: "Harm", secondaryName: "Harm" },
  { primaryRune: "ShieldStun", secondaryPower: "JuggernautCharge", secondaryName: "Juggernaut" },
  { primaryRune: "TouchHeal", secondaryPower: "Penance", secondaryName: "Penance" },
  { primaryRune: "Berserker", secondaryPower: "CleavingBlows", secondaryName: "Cleaving Blows" },
  { primaryRune: "SentinelForm", secondaryPower: "Retribution", secondaryName: "Retribution" },
  { primaryRune: "LeoneanAura", secondaryPower: "CelestialLance", secondaryName: "Celestial Lance" },
  { primaryRune: "JumpSlam", secondaryPower: "LightningStorm", secondaryName: "Lightning Storm" },
  { primaryRune: "ToughShout", secondaryPower: "Shockwave", secondaryName: "Shockwave" },
  { primaryRune: "GroupHoT", secondaryPower: "VerdictROR", secondaryName: "Verdict" },
  { primaryRune: "LeapStrike", secondaryPower: "FuriousAssault", secondaryName: "Furious Assault" },
  { primaryRune: "Defiance", secondaryPower: "ShieldFlurryStrike", secondaryName: "Shield Flurry" },
  { primaryRune: "Sanctum", secondaryPower: "DivineWord", secondaryName: "Divine Word" },
  { primaryRune: "LightningBomb", secondaryPower: "JusticeFist", secondaryName: "Justice Fist" },
  { primaryRune: "Barrier", secondaryPower: "SecondWind", secondaryName: "Second Wind" },
  { primaryRune: "CleansingLight", secondaryPower: "FountainOfLife", secondaryName: "Hallowed Reckoning" },
];

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CLIENT_DIR = path.resolve(__dirname, "..", "..", "client", "content");
const GAME_SWZ = path.join(CLIENT_DIR, "localhost", "p", "cbq", "Game.swz");
const LOGIN_SWZ_FILES = [
  path.join(CLIENT_DIR, "localhost", "p", "cbp", "Login.swz"),
  path.join(CLIENT_DIR, "localhost", "p", "cbq", "Login.swz"),
].filter(fs.existsSync);
const LOOSE_POWER_MODS = path.join(XML_DIR, "PowerModTypes.xml");
const LOOSE_POWERS = path.join(XML_DIR, "PlayerPowerTypes.xml");
const LOOSE_BUFFS = path.join(XML_DIR, "PlayerBuffTypes.xml");
const LOOSE_GEAR = path.join(XML_DIR, "GearTypes.xml");
const PROC_RUNE_TARGET_GEAR_IDS = new Set(["1162", "1163", "1164"]);
const DAMAGE_BONUS = 0.1;
const FIRST_MOD_ID = 2000;
const FIRST_PSEUDO_POWER_ID = 8001;
const LINE_SEPARATOR = "&#10;";

function readTag(block: string, tag: string): string | null {
  return block.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1] ?? null;
}

function replaceTag(block: string, tag: string, expectedValue: string): { block: string; changed: boolean } {
  const tagPattern = new RegExp(`<${tag}>[^<]*</${tag}>`);
  const expectedTag = `<${tag}>${expectedValue}</${tag}>`;
  const currentTag = block.match(tagPattern)?.[0];
  if (!currentTag) throw new SwzPatchError(`Legendary target gear is missing <${tag}>.`);
  if (currentTag === expectedTag) return { block, changed: false };
  return { block: block.replace(tagPattern, expectedTag), changed: true };
}

/** Keeps the earlier ProcRune fix for gear 1162-1164. */
export function patchLegendaryGearRunes(xml: string): PatchResult {
  let changes = 0;
  const matchedGearIds = new Set<string>();
  const patchedXml = xml.replace(/<Gear\b[^>]*GearID="([^"]+)"[^>]*>[\s\S]*?<\/Gear>/g, (block: string, gearId: string) => {
    if (!PROC_RUNE_TARGET_GEAR_IDS.has(gearId) || readTag(block, "Rarity") !== "L") return block;
    matchedGearIds.add(gearId);
    const healthRune = replaceTag(block, "ProcRune", "HealthPercent");
    const hasteRune = replaceTag(healthRune.block, "ProcRune2", "Haste");
    changes += Number(healthRune.changed) + Number(hasteRune.changed);
    return hasteRune.block;
  });
  for (const gearId of PROC_RUNE_TARGET_GEAR_IDS) {
    if (!matchedGearIds.has(gearId)) throw new SwzPatchError(`Legendary gear ${gearId} was not found in GearTypes data.`);
  }
  return { xml: patchedXml, changes, matchedGearIds };
}

function findMod(xml: string, modName: string): string {
  const hit = xml.match(new RegExp(`\\t<PowerModType>\\s*\\r?\\n\\t\\t<ModName>${modName}</ModName>[\\s\\S]*?</PowerModType>`));
  if (!hit) throw new SwzPatchError(`PowerModType ${modName} not found.`);
  return hit[0];
}

function reidentify(block: string, modName: string, modId: number, comboMod: string | null): string {
  let out = block.replace(/<ModName>[\s\S]*?<\/ModName>/, `<ModName>${modName}</ModName>`)
    .replace(/<ModID>[\s\S]*?<\/ModID>/, `<ModID>${modId}</ModID>`)
    .replace(/\s*<ComboMod>[\s\S]*?<\/ComboMod>/, "");
  if (comboMod) out = out.replace(/\n(\t*)<\/PowerModType>/, `\n$1\t<ComboMod>${comboMod}</ComboMod>\n$1</PowerModType>`);
  return out;
}

function powerRanks(powerXml: string, base: string): string[] {
  const names = [base, ...Array.from({ length: 10 }, (_, index) => `${base}${index + 1}`)]
    .filter((candidate) => powerXml.includes(`<Power PowerName="${candidate}">`));
  if (names.length === 0) throw new SwzPatchError(`No powers found for ${base}.`);
  return names;
}

function strongestDamage(powerXml: string, names: string[]): number {
  let strongest = 0;
  for (const name of names) {
    const block = powerXml.match(new RegExp(`<Power PowerName="${name}">([\\s\\S]*?)</Power>`))?.[1] ?? "";
    const total = (readTag(block, "BaseDamageMult") ?? "").split(",")
      .reduce((sum, part) => sum + (Number.isFinite(Number(part)) ? Number(part) : 0), 0);
    if (Math.abs(total) > Math.abs(strongest)) strongest = total;
  }
  return strongest;
}

function round(value: number): string { return String(Number(value.toFixed(4))); }
function legendaryRune(primaryRune: string): string { return `Legendary${primaryRune}`; }

function buildLegendaryMods(powerModsXml: string, powersXml: string, buffsXml: string): string[][] {
  let modId = FIRST_MOD_ID;
  const eol = powerModsXml.includes("\r\n") ? "\r\n" : "\n";
  return LEGENDARY_SKILL_PAIRS.map((pair) => {
    const rune = legendaryRune(pair.primaryRune);
    const headName = `Rune${rune}`;
    const bonusName = `${headName}Bonus`;
    const originalHead = findMod(powerModsXml, `Rune${pair.primaryRune}`);
    const originalLine = readTag(originalHead, "Description")?.split("@")[0];
    if (!originalLine) throw new SwzPatchError(`Rune${pair.primaryRune} has no Description.`);
    const rogueEffect = ROGUE_GEAR_RUNE_EFFECTS[pair.secondaryPower];
    const bonusDescription = rogueEffect?.description ?? `+10% ${pair.secondaryName} damage`;
    const head = reidentify(originalHead, headName, modId++, bonusName).replace(
      /<Description>[\s\S]*?<\/Description>/,
      `<Description>${originalLine}${LINE_SEPARATOR}${bonusDescription}</Description>`,
    );
    const names = powerRanks(powersXml, pair.secondaryPower);
    let bonus: string;
    if (rogueEffect?.kind === "buff") {
      const entries = rogueEffect.buffNames.flatMap((buffName) => rogueEffect.properties.map((property) => ({ buffName, ...property })));
      for (const entry of entries) {
        const block = buffsXml.match(new RegExp(`<BuffType BuffName="${entry.buffName}">([\\s\\S]*?)</BuffType>`))?.[1];
        if (!block?.includes(`<${entry.name}>`)) throw new SwzPatchError(`${entry.buffName} does not declare <${entry.name}>.`);
      }
      bonus = [
        "\t<PowerModType>", `\t\t<ModName>${bonusName}</ModName>`, `\t\t<ModID>${modId++}</ModID>`,
        `\t\t<DisplayName>${pair.secondaryName}</DisplayName>`, `\t\t<Description>${bonusDescription}</Description>`,
        "\t\t<ModType>Buff</ModType>", `\t\t<BuffName>${entries.map((entry) => entry.buffName).join(",")}</BuffName>`,
        `\t\t<BuffProperty>${entries.map((entry) => entry.name).join(",")}</BuffProperty>`,
        `\t\t<BuffValue>${entries.map((entry) => round(entry.value)).join(",")}</BuffValue>`,
        "\t\t<IconName>a_Signet_Empty</IconName>", "\t</PowerModType>",
      ].join(eol);
    } else {
      const property = rogueEffect?.kind === "conditional"
        ? ROGUE_GEAR_EFFECT_PROPERTY
        : rogueEffect?.kind === "damage" ? "BaseDamageMult"
        : rogueEffect?.kind === "power" ? rogueEffect.property : "BaseDamageMult";
      const value = rogueEffect?.kind === "conditional"
        ? String(rogueEffect.marker)
        : rogueEffect?.kind === "damage" ? round(rogueEffect.pct * strongestDamage(powersXml, names))
        : rogueEffect?.kind === "power" ? rogueEffect.value : round(DAMAGE_BONUS * strongestDamage(powersXml, names));
      bonus = [
        "\t<PowerModType>", `\t\t<ModName>${bonusName}</ModName>`, `\t\t<ModID>${modId++}</ModID>`,
        `\t\t<DisplayName>${pair.secondaryName}</DisplayName>`, `\t\t<Description>${bonusDescription}</Description>`,
        "\t\t<ModType>Power</ModType>", `\t\t<PowerName>${names.join(",")}</PowerName>`,
        `\t\t<PowerProperty>${property}</PowerProperty>`, `\t\t<PowerValue>${value}</PowerValue>`,
        "\t\t<IconName>a_Signet_Empty</IconName>", "\t</PowerModType>",
      ].join(eol);
    }
    return [head, bonus];
  });
}

function insertMods(xml: string, chains: string[][]): { xml: string; added: number } {
  let out = xml;
  const additions: string[] = [];
  let updated = 0;
  for (const chain of chains) {
    const missing = chain.filter((block) => !out.includes(`<ModName>${readTag(block, "ModName")}</ModName>`));
    if (missing.length === 0) continue;
    if (missing.length !== chain.length) throw new SwzPatchError(`PowerModTypes has a partial ${readTag(chain[0], "ModName")} chain; revert and re-run.`);
    additions.push(...missing);
  }
  for (const chain of chains) {
    if (chain.some((block) => additions.includes(block))) continue;
    for (const expected of chain) {
      const name = readTag(expected, "ModName");
      if (!name) throw new SwzPatchError("Generated PowerModType has no ModName.");
      const current = findMod(out, name);
      if (current.replace(/\r\n/g, "\n") === expected.replace(/\r\n/g, "\n")) continue;
      out = out.replace(current, expected);
      updated += 1;
    }
  }
  if (additions.length === 0) return { xml: out, added: updated };
  const close = out.lastIndexOf("</PowerModTypes>");
  if (close === -1) throw new SwzPatchError("No </PowerModTypes> close tag.");
  const eol = out.includes("\r\n") ? "\r\n" : "\n";
  return { xml: `${out.slice(0, close)}${additions.join(eol)}${eol}${out.slice(close)}`, added: additions.length + updated };
}

function addPseudoPowers(xml: string): { xml: string; added: number } {
  const template = xml.match(/\t<Power PowerName="SwordMelee">[\s\S]*?<\/Power>/)?.[0];
  if (!template) throw new SwzPatchError("SwordMelee pseudo-power template not found.");
  const additions: string[] = [];
  let powerId = FIRST_PSEUDO_POWER_ID;
  for (const pair of LEGENDARY_SKILL_PAIRS) {
    const name = legendaryRune(pair.primaryRune);
    if (!xml.includes(`<Power PowerName="${name}">`)) {
      additions.push(template.replace('PowerName="SwordMelee"', `PowerName="${name}"`)
        .replace(/<PowerID>[\s\S]*?<\/PowerID>/, `<PowerID>${powerId}</PowerID>`)
        .replace(/<DisplayName>[\s\S]*?<\/DisplayName>/, "<DisplayName>Legendary</DisplayName>")
        .replace(/<Description>[\s\S]*?<\/Description>/, "<Description>Legendary power</Description>"));
    }
    powerId += 1;
  }
  if (additions.length === 0) return { xml, added: 0 };
  const close = xml.lastIndexOf("</PlayerPowerTypes>");
  if (close === -1) throw new SwzPatchError("No </PlayerPowerTypes> close tag.");
  const eol = xml.includes("\r\n") ? "\r\n" : "\n";
  return { xml: `${xml.slice(0, close)}${additions.join(eol)}${eol}${xml.slice(close)}`, added: additions.length };
}

function retargetLegendaryGear(xml: string): { xml: string; changed: number } {
  const byPrimary = new Map(LEGENDARY_SKILL_PAIRS.map((pair) => [pair.primaryRune, legendaryRune(pair.primaryRune)]));
  const matchedRunes = new Set<string>();
  let changed = 0;
  const patched = xml.replace(/<Gear\b[^>]*>[\s\S]*?<\/Gear>/g, (block: string) => {
    if (readTag(block, "Rarity") !== "L") return block;
    const current = readTag(block, "PowerRune");
    if (!current) return block;
    const primary = current.startsWith("Legendary") ? current.slice("Legendary".length) : current;
    const target = byPrimary.get(primary);
    if (!target) return block;
    matchedRunes.add(primary);
    if (current === target) return block;
    changed += 1;
    return block.replace(`<PowerRune>${current}</PowerRune>`, `<PowerRune>${target}</PowerRune>`);
  });
  for (const pair of LEGENDARY_SKILL_PAIRS) {
    if (!matchedRunes.has(pair.primaryRune)) throw new SwzPatchError(`No Legendary gear uses PowerRune ${pair.primaryRune}.`);
  }
  return { xml: patched, changed };
}

function patchGearXml(xml: string): { xml: string; changes: number } {
  const procResult = patchLegendaryGearRunes(xml);
  const skillResult = retargetLegendaryGear(procResult.xml);
  return { xml: skillResult.xml, changes: procResult.changes + skillResult.changed };
}

export function patchConfiguredLegendaryGearRunes(verifyOnly: boolean): number {
  const pending: Array<() => void> = [];
  const summary: string[] = [];
  let changes = 0;
  const game = parseSwz(GAME_SWZ);
  const modsChunk = game.chunks.find((chunk) => chunk.xml.includes("<PowerModTypes"));
  const powersChunk = game.chunks.find((chunk) => chunk.xml.includes("<PlayerPowerTypes"));
  const buffsChunk = game.chunks.find((chunk) => chunk.xml.includes("<PlayerBuffTypes"));
  if (!modsChunk || !powersChunk || !buffsChunk) throw new SwzPatchError("Game.swz is missing PowerModTypes/PlayerPowerTypes/PlayerBuffTypes.");
  const swzMods = insertMods(modsChunk.xml, buildLegendaryMods(modsChunk.xml, powersChunk.xml, buffsChunk.xml));
  const swzPowers = addPseudoPowers(powersChunk.xml);
  summary.push(`Game.swz: +${swzMods.added} mods, +${swzPowers.added} pseudo-powers`);
  changes += swzMods.added + swzPowers.added;
  if ((swzMods.added > 0 || swzPowers.added > 0) && !verifyOnly) pending.push(() => {
    ensureBackup(GAME_SWZ); modsChunk.xml = swzMods.xml; powersChunk.xml = swzPowers.xml; writeSwz(game);
  });

  const looseMods = fs.readFileSync(LOOSE_POWER_MODS, "utf8");
  const loosePowers = fs.readFileSync(LOOSE_POWERS, "utf8");
  const looseBuffs = fs.readFileSync(LOOSE_BUFFS, "utf8");
  const looseModsResult = insertMods(looseMods, buildLegendaryMods(looseMods, loosePowers, looseBuffs));
  const loosePowersResult = addPseudoPowers(loosePowers);
  summary.push(`PowerModTypes.xml: +${looseModsResult.added} mods`);
  summary.push(`PlayerPowerTypes.xml: +${loosePowersResult.added} pseudo-powers`);
  changes += looseModsResult.added + loosePowersResult.added;
  if (looseModsResult.added > 0 && !verifyOnly) pending.push(() => fs.writeFileSync(LOOSE_POWER_MODS, looseModsResult.xml, "utf8"));
  if (loosePowersResult.added > 0 && !verifyOnly) pending.push(() => fs.writeFileSync(LOOSE_POWERS, loosePowersResult.xml, "utf8"));

  const looseGear = fs.readFileSync(LOOSE_GEAR, "utf8");
  const looseGearResult = patchGearXml(looseGear);
  summary.push(`GearTypes.xml: ${looseGearResult.changes} changes`);
  changes += looseGearResult.changes;
  if (looseGearResult.changes > 0 && !verifyOnly) pending.push(() => fs.writeFileSync(LOOSE_GEAR, looseGearResult.xml, "utf8"));

  let loginChanges = 0;
  for (const loginPath of LOGIN_SWZ_FILES) {
    const login = parseSwz(loginPath);
    const gearChunk = login.chunks.find((chunk) => chunk.xml.includes("<GearTypes"));
    if (!gearChunk) throw new SwzPatchError(`${path.basename(loginPath)} has no GearTypes chunk.`);
    const result = patchGearXml(gearChunk.xml);
    loginChanges += result.changes;
    if (result.changes > 0 && !verifyOnly) pending.push(() => {
      ensureBackup(loginPath); gearChunk.xml = result.xml; writeSwz(login);
    });
  }
  summary.push(`Login.swz (cbp+cbq): ${loginChanges} gear changes`);
  changes += loginChanges;
  if (!verifyOnly) pending.forEach((write) => write());
  console.log(summary.join("\n"));
  return changes;
}

function main(): number {
  const verifyOnly = process.argv.includes("--verify") || process.argv.includes("--dry-run");
  const changes = patchConfiguredLegendaryGearRunes(verifyOnly);
  console.log(JSON.stringify({ verifyOnly, changes }, null, 2));
  console.log(changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
  return verifyOnly && changes > 0 ? 1 : 0;
}

if (require.main === module) process.exit(main());
