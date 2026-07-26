import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

/**
 * Gives the six Mystic Rogue items their ability bonuses.
 *
 * Gear carries a single `<PowerRune>X</PowerRune>`, which the client resolves to the PowerModType
 * named `RuneX` (`class_44`: `"Rune" + gearType.var_1062` -> `class_14.var_274[...]`). One rune is
 * therefore one mod — but a PowerModType may name a `<ComboMod>`, and `class_44` applies that chain
 * recursively, so a single rune can carry an arbitrary number of effects.
 *
 * Each item gets a head mod that is a verbatim clone of `RuneSwordMelee` — so the item keeps its
 * "+2.5% Basic Attack damage" line exactly as before — with a `<ComboMod>` into a chain of one mod
 * per ability.
 *
 * The abilities that already exist as `Rune*` mods (Mist Walk, Midnight Shroud, Carnifex, Crimson
 * Butterfly, Shadow Legion, Soul Reaver, Ghost Blade) are **cloned rather than reused**: those mods
 * are already the PowerRune of 26-36 other items, so hanging a ComboMod on them would leak this
 * chain onto all of them. Cloning also means the description text and icon come across unchanged, in
 * whichever language the file being patched is written in.
 *
 * Calibration: for `BaseDamageMult`, `PowerValue` is an absolute addend, not a ratio. The stock mods
 * are inconsistent about which rank their advertised percentage refers to, so this script picks one
 * convention and applies it uniformly — `PowerValue = pct * maxRankBaseDamageMult`, i.e. the printed
 * percentage is correct for a fully ranked ability. Retuning means changing `pct` here and re-running.
 */

type Ability =
  /** +pct damage on every rank of `base`, sized against the ability's max-rank BaseDamageMult. */
  | { kind: "damage"; base: string; pct: number; en: string; tr: string }
  /** Copy an existing mod verbatim under a new name, so the stock one keeps no ComboMod. */
  | { kind: "clone"; from: string }
  /** Add to a numeric buff property, on the ranks that already declare it. */
  | { kind: "buff"; buffPrefix: string; property: string; value: number; en: string; tr: string };

interface Item {
  gearId: number;
  /** Gear `<PowerRune>` value; the head mod is named `Rune` + this. */
  rune: string;
  abilities: Ability[];
}

const ITEMS: Item[] = [
  {
    gearId: 1171,
    rune: "MysticRogueSword",
    abilities: [
      { kind: "damage", base: "WitherStrike", pct: 0.15, en: "+15% Withering Impact damage", tr: "Soldurucu Darbe hasari %15 artar." },
      { kind: "damage", base: "SeverStrike", pct: 0.15, en: "+15% Severing Strike damage", tr: "Koparan Vurus hasari %15 artar." },
      { kind: "damage", base: "CrippleStrike", pct: 0.15, en: "+15% Scorpion's Sting damage", tr: "Akrep Sokmasi hasari %15 artar." },
      { kind: "damage", base: "HeartSeeker", pct: 0.15, en: "+15% Heart Seeker damage", tr: "Kalp Avcisi hasari %15 artar." },
      { kind: "damage", base: "FatiguingStrike", pct: 0.15, en: "+15% Hex Blade damage", tr: "Buyulu Kilic hasari %15 artar." },
      { kind: "damage", base: "Devour", pct: 0.15, en: "+15% Devour damage", tr: "Yutma hasari %15 artar." },
    ],
  },
  {
    gearId: 1172,
    rune: "MysticRogueOffhand",
    abilities: [
      // Chaos Wave is a pure self-buff with BaseDamageMult 0, so a damage mod would do nothing;
      // its MagicDamage ranks run 0.05-0.10, so 0.015 is roughly the same +15% in effect terms.
      { kind: "buff", buffPrefix: "ChaosArmor", property: "MagicDamage", value: 0.015, en: "+15% Chaos Wave power", tr: "Kaos Dalgasi gucu %15 artar." },
      { kind: "damage", base: "PainBender", pct: 0.15, en: "+15% Butcher's Boon damage", tr: "Kasabin Lutfu hasari %15 artar." },
      { kind: "damage", base: "WhitheringMist", pct: 0.15, en: "+15% Withering Mist damage", tr: "Soldurucu Sis hasari %15 artar." },
      { kind: "damage", base: "ShadowTendrilDash", pct: 0.15, en: "+15% Black Miasma damage", tr: "Kara Miyazma hasari %15 artar." },
      { kind: "damage", base: "DaggerFlurry", pct: 0.15, en: "+15% Flurry of Daggers damage", tr: "Hancer Yagmuru hasari %15 artar." },
      { kind: "damage", base: "VitalStrike", pct: 0.15, en: "+15% Shadow Rend damage", tr: "Golge Parcalayis hasari %15 artar." },
    ],
  },
  {
    gearId: 1173,
    rune: "MysticRogueHat",
    abilities: [
      { kind: "damage", base: "SeekingBladesAttack", pct: 0.35, en: "+35% Charon's Blade damage", tr: "Charon'un Kiliclari hasari %35 artar." },
      { kind: "damage", base: "ShadowStepClose", pct: 0.15, en: "+15% Shadow Step damage", tr: "Golge Adimi hasari %15 artar." },
      { kind: "clone", from: "RuneGhostBlade" },
    ],
  },
  {
    gearId: 1174,
    rune: "MysticRogueArmor",
    abilities: [
      { kind: "damage", base: "PoisonLance", pct: 0.1, en: "+10% Necrotic Surge damage", tr: "Nekrotik Dalga hasari %10 artar." },
      { kind: "damage", base: "Reaper", pct: 0.1, en: "+10% Shadow Scythe damage", tr: "Golge Tirpani hasari %10 artar." },
      { kind: "damage", base: "BlackStorm", pct: 0.1, en: "+10% Black Storm damage", tr: "Kara Firtina hasari %10 artar." },
      { kind: "damage", base: "DarkChi", pct: 0.1, en: "+10% Dark Chi damage", tr: "Kara Chi hasari %10 artar." },
      { kind: "damage", base: "AssassinateClose", pct: 0.1, en: "+10% Vicious Assault damage", tr: "Vahsi Saldiri hasari %10 artar." },
      { kind: "damage", base: "DeathBlowOld", pct: 0.1, en: "+10% Assassinate damage", tr: "Suikast hasari %10 artar." },
    ],
  },
  {
    gearId: 1175,
    rune: "MysticRogueGloves",
    abilities: [
      { kind: "clone", from: "RuneMistWalk" },
      { kind: "clone", from: "RuneShadowArmor" },
      { kind: "clone", from: "RuneSoulShatter" },
    ],
  },
  {
    gearId: 1176,
    rune: "MysticRogueBoots",
    abilities: [
      { kind: "clone", from: "RuneShadowBlade" },
      { kind: "clone", from: "RuneShadowLegion" },
      { kind: "clone", from: "RuneSoulReaver" },
    ],
  },
];

/** The head mod is a clone of this, so the item keeps its stock basic-attack line. */
const HEAD_TEMPLATE = "RuneSwordMelee";
/** Stock ModIDs top out at 894. */
const FIRST_MOD_ID = 1000;

const CLIENT = path.resolve(__dirname, "..", "..", "client", "content");
const GAME_SWZ = ["Game.swz", "Game.en.swz", "Game.tr.swz"].map((name) =>
  path.join(CLIENT, "localhost", "p", "cbq", name),
);
const LOOSE_POWER_MODS = path.join(CLIENT, "xml", "PowerModTypes.xml");
const LOOSE_GEAR = path.join(CLIENT, "xml", "GearTypes.xml");
const LOGIN_SWZ = path.join(CLIENT, "localhost", "p", "cbp", "Login.swz");

function parseArgs(argv: string[]): { verify: boolean } {
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npx ts-node src/server/scripts/patch-mystic-rogue-power-mods.ts [--verify]",
        "",
        "Creates the PowerModType chains behind the six Mystic Rogue items and points each item's",
        "PowerRune at its chain. Writes Game.swz / Game.en.swz / Game.tr.swz, the loose",
        "PowerModTypes.xml, Login.swz and the loose GearTypes.xml.",
      ].join("\n"));
      process.exit(0);
    }
    throw new SwzPatchError(`Unknown argument: ${arg}`);
  }
  return { verify };
}

function tag(block: string, name: string): string | null {
  return block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? null;
}

function findMod(xml: string, modName: string): string {
  const pattern = new RegExp(`\\t<PowerModType>\\s*\\r?\\n\\t\\t<ModName>${modName}</ModName>[\\s\\S]*?</PowerModType>`);
  const hit = xml.match(pattern);
  if (!hit) throw new SwzPatchError(`PowerModType ${modName} not found.`);
  return hit[0];
}

/** Rewrites a block's ModName/ModID and sets (or clears) its ComboMod. */
function reidentify(block: string, modName: string, modId: number, comboMod: string | null): string {
  let out = block
    .replace(/<ModName>[\s\S]*?<\/ModName>/, `<ModName>${modName}</ModName>`)
    .replace(/<ModID>[\s\S]*?<\/ModID>/, `<ModID>${modId}</ModID>`)
    .replace(/\s*<ComboMod>[\s\S]*?<\/ComboMod>/, "");
  if (comboMod) {
    out = out.replace(/\n(\t*)<\/PowerModType>/, `\n$1\t<ComboMod>${comboMod}</ComboMod>\n$1</PowerModType>`);
  }
  return out;
}

/** Every existing rank of a power family: the unranked entry plus `base1`..`base10`. */
function powerRanks(powerXml: string, base: string): string[] {
  const names: string[] = [];
  for (const candidate of [base, ...Array.from({ length: 10 }, (_, i) => `${base}${i + 1}`)]) {
    if (powerXml.includes(`<Power PowerName="${candidate}">`)) names.push(candidate);
  }
  if (names.length === 0) throw new SwzPatchError(`No powers found for ${base}.`);
  return names;
}

function maxRankDamage(powerXml: string, names: string[]): number {
  let max = 0;
  for (const name of names) {
    const block = powerXml.match(new RegExp(`<Power PowerName="${name}">([\\s\\S]*?)</Power>`))?.[1] ?? "";
    const mult = Number(tag(block, "BaseDamageMult") ?? 0);
    if (Number.isFinite(mult)) max = Math.max(max, mult);
  }
  if (max <= 0) throw new SwzPatchError(`${names[0]} has no positive BaseDamageMult to scale against.`);
  return max;
}

/** Buff ranks of a family that already declare `property`; adding it to ones that lack it is unsafe. */
function buffRanksWith(buffXml: string, prefix: string, property: string): string[] {
  const names: string[] = [];
  const pattern = new RegExp(`<BuffType BuffName="(${prefix}\\d*)">([\\s\\S]*?)</BuffType>`, "g");
  let hit: RegExpExecArray | null;
  while ((hit = pattern.exec(buffXml)) !== null) {
    if (hit[2].includes(`<${property}>`)) names.push(hit[1]);
  }
  if (names.length === 0) throw new SwzPatchError(`No ${prefix} buff ranks declare <${property}>.`);
  return names;
}

function round(value: number): string {
  return String(Number(value.toFixed(4)));
}

/**
 * The ability's own name, recovered from its description ("+15% Heart Seeker damage" -> "Heart
 * Seeker"). Cloned mods keep the DisplayName they came with; only generated ones need this, and
 * deriving it beats carrying a second copy of every ability name that could drift out of step.
 */
function displayFromDescription(description: string): string {
  return description
    .replace(/^\+?\d+(?:\.\d+)?%\s*/, "")
    .replace(/\s+(damage|power|duration|life siphon|attack leech|defense)\.?$/i, "")
    .trim();
}

interface Corpus {
  powerMods: string;
  powers: string;
  buffs: string;
  turkish: boolean;
}

/**
 * The gear tooltip prints exactly one PowerRune line: the head mod's `description[0]` (the text
 * before "@") into `am_PowerTypeName`. That field ships `multiline=false`, which
 * `patch-ui-tooltip-multiline.ts` flips — so the way to show every ability on the card is to join
 * all the lines into the head mod's Description with newline entities. Stock mods stay single-line,
 * so nothing else's tooltip changes.
 */
const LINE_SEPARATOR = "&#10;";

/** Line rows that fit inside the card's fixed-height text block at the patched line pitch. */
const MAX_CARD_LINES = 6;

/**
 * am_ProcTypeName1/2 are separate fields pinned at fixed pixel positions that land on rows 3 and 5
 * of the power field grid, and the proc effects only work under their stock rune names
 * (Entity/CombatState compare the string literally), so the runes stay and their text is drawn.
 *
 * Leading blank rows do NOT push the ability block clear of them: the XML text node trims leading
 * newlines, so the blanks vanish. With the layout splice in class_101.method_1120 the proc rows are
 * pushed below the ability block at runtime, so the budget is the card height instead: 4 ability
 * rows + 2 proc rows fill it exactly. Everything past that still applies — only the printed name is dropped.
 */
const ABILITY_ROWS_ABOVE_PROCS = 6;

/** Builds every new PowerModType block for one file, in chain order. */
function buildMods(corpus: Corpus): { blocks: string[]; runeByGearId: Map<number, string> } {
  const blocks: string[] = [];
  const runeByGearId = new Map<number, string>();
  let modId = FIRST_MOD_ID;

  for (const item of ITEMS) {
    const headName = `Rune${item.rune}`;
    const abilityNames = item.abilities.map((_, index) => `${headName}${index + 1}`);
    runeByGearId.set(item.gearId, item.rune);
    const itemStart = blocks.length;

    blocks.push(reidentify(findMod(corpus.powerMods, HEAD_TEMPLATE), headName, modId++, abilityNames[0] ?? null));

    item.abilities.forEach((ability, index) => {
      const name = abilityNames[index];
      const next = abilityNames[index + 1] ?? null;

      if (ability.kind === "clone") {
        blocks.push(reidentify(findMod(corpus.powerMods, ability.from), name, modId++, next));
        return;
      }

      const description = corpus.turkish ? ability.tr : ability.en;
      // Always name the mod after the English ability, so the Turkish file stays diff-comparable.
      const displayName = displayFromDescription(ability.en);

      if (ability.kind === "damage") {
        const names = powerRanks(corpus.powers, ability.base);
        const value = round(ability.pct * maxRankDamage(corpus.powers, names));
        blocks.push(
          [
            "\t<PowerModType>",
            `\t\t<ModName>${name}</ModName>`,
            `\t\t<ModID>${modId++}</ModID>`,
            `\t\t<DisplayName>${displayName}</DisplayName>`,
            `\t\t<Description>${description}</Description>`,
            "\t\t<ModType>Power</ModType>",
            `\t\t<PowerName>${names.join(",")}</PowerName>`,
            "\t\t<PowerProperty>BaseDamageMult</PowerProperty>",
            `\t\t<PowerValue>${value}</PowerValue>`,
            "\t\t<IconName>a_Signet_Empty</IconName>",
            ...(next ? [`\t\t<ComboMod>${next}</ComboMod>`] : []),
            "\t</PowerModType>",
          ].join("\r\n"),
        );
        return;
      }

      const names = buffRanksWith(corpus.buffs, ability.buffPrefix, ability.property);
      blocks.push(
        [
          "\t<PowerModType>",
          `\t\t<ModName>${name}</ModName>`,
          `\t\t<ModID>${modId++}</ModID>`,
          `\t\t<DisplayName>${displayName}</DisplayName>`,
          `\t\t<Description>${description}</Description>`,
          "\t\t<ModType>Buff</ModType>",
          `\t\t<BuffName>${names.join(",")}</BuffName>`,
          `\t\t<BuffProperty>${names.map(() => ability.property).join(",")}</BuffProperty>`,
          `\t\t<BuffValue>${names.map(() => round(ability.value)).join(",")}</BuffValue>`,
          "\t\t<IconName>a_Signet_Empty</IconName>",
          ...(next ? [`\t\t<ComboMod>${next}</ComboMod>`] : []),
          "\t</PowerModType>",
        ].join("\r\n"),
      );
    });

    // Fold every line of the chain into the head's Description so the tooltip shows them all.
    const lines = blocks.slice(itemStart).map((block) => {
      const description = tag(block, "Description");
      if (!description) throw new SwzPatchError(`A block of Rune${item.rune} has no Description.`);
      return description.split("@")[0];
    });

    // The card's text block is a fixed height (its size comes from a "Single"/"Double" animation
    // state, not from content), so past MAX_CARD_LINES the text runs off the bottom edge. The head
    // mod's own "+2.5% Basic Attack damage" line is the one worth dropping: it is the least
    // interesting line on a Mystic item, and dropping the *text* does not drop the effect — that
    // comes from the mod's PowerName/PowerValue, which stay untouched.
    const budget = ABILITY_ROWS_ABOVE_PROCS;
    const body = lines.length > budget ? lines.slice(1) : lines; // drop the basic-attack line first
    const shown = body.slice(0, budget);

    blocks[itemStart] = blocks[itemStart].replace(
      /<Description>[\s\S]*?<\/Description>/,
      `<Description>${shown.join(LINE_SEPARATOR)}</Description>`,
    );
  }

  return { blocks, runeByGearId };
}

/**
 * The gear tooltip only renders the PowerRune line when the rune name is ALSO a PowerType name
 * (stock runes like SwordMelee are both; the line's icon comes from the PowerType). The Mystic rune
 * names are not, so without these pseudo-power entries the whole ability-line block is hidden.
 * Cloned from SwordMelee — the PowerRune these items originally carried — NOT from a proc power.
 * The armory slot renderer reads fields off the PowerRune's PowerType that a proc power never
 * declares (CastAnim, IconName, PowerGroup, Range, HitGfx). The first version cloned ProcMassive,
 * left all of those null, and the six items rendered with an empty equipment slot while every other
 * Legendary on the same character drew fine. IDs sit far above the stock maximum.
 */
const FIRST_PSEUDO_POWER_ID = 7001;

function addPseudoPowers(powersXml: string, turkish: boolean): { xml: string; added: number } {
  const template = powersXml.match(/\t<Power PowerName="SwordMelee">[\s\S]*?<\/Power>/)?.[0];
  if (!template) throw new SwzPatchError("SwordMelee pseudo-power template not found.");

  const additions: string[] = [];
  let powerId = FIRST_PSEUDO_POWER_ID;
  for (const item of ITEMS) {
    const name = item.rune;
    if (powersXml.includes(`<Power PowerName="${name}">`)) {
      powerId += 1;
      continue;
    }
    additions.push(
      template
        .replace('PowerName="SwordMelee"', `PowerName="${name}"`)
        .replace(/<PowerID>[\s\S]*?<\/PowerID>/, `<PowerID>${powerId++}</PowerID>`)
        .replace(/<DisplayName>[\s\S]*?<\/DisplayName>/, `<DisplayName>${turkish ? "Mistik" : "Mystic"}</DisplayName>`)
        .replace(/<Description>[\s\S]*?<\/Description>/, `<Description>${turkish ? "Mistik guc" : "Mystic power"}</Description>`),
    );
  }

  if (additions.length === 0) return { xml: powersXml, added: 0 };
  const close = powersXml.lastIndexOf("</PlayerPowerTypes>");
  if (close === -1) throw new SwzPatchError("No </PlayerPowerTypes> close tag.");
  const eol = powersXml.includes("\r\n") ? "\r\n" : "\n";
  return { xml: `${powersXml.slice(0, close)}${additions.join(eol)}${eol}${powersXml.slice(close)}`, added: additions.length };
}

function insertMods(powerModsXml: string, blocks: string[]): { xml: string; added: number } {
  const missing = blocks.filter((block) => {
    const name = tag(block, "ModName");
    return name !== null && !powerModsXml.includes(`<ModName>${name}</ModName>`);
  });
  if (missing.length === 0) return { xml: powerModsXml, added: 0 };
  if (missing.length !== blocks.length) {
    throw new SwzPatchError(`PowerModTypes is partially patched (${blocks.length - missing.length} of ${blocks.length} present); revert and re-run.`);
  }

  const close = powerModsXml.lastIndexOf("</PowerModTypes>");
  if (close === -1) throw new SwzPatchError("No </PowerModTypes> close tag.");
  const eol = powerModsXml.includes("\r\n") ? "\r\n" : "\n";
  return {
    xml: `${powerModsXml.slice(0, close)}${missing.join(eol)}${eol}${powerModsXml.slice(close)}`,
    added: missing.length,
  };
}

/** Points each Mystic gear entry's PowerRune at its head mod. */
function retargetGearRunes(gearXml: string, runeByGearId: Map<number, string>): { xml: string; changed: number } {
  let out = gearXml;
  let changed = 0;

  for (const [gearId, rune] of runeByGearId) {
    const pattern = new RegExp(`(<Gear GearName="[^"]*30Y" GearID="${gearId}"[\\s\\S]*?)<PowerRune>([^<]*)</PowerRune>`);
    const hit = out.match(pattern);
    if (!hit) throw new SwzPatchError(`No Mystic gear entry with a PowerRune for GearID ${gearId}.`);
    if (hit[2] === rune) continue;
    out = out.replace(pattern, `$1<PowerRune>${rune}</PowerRune>`);
    changed += 1;
  }

  return { xml: out, changed };
}

function patch(verify: boolean): void {
  const summary: string[] = [];
  const pending: Array<() => void> = [];
  let changes = 0;

  // Every Game*.swz carries its own PowerModTypes in its own language; the loose copy is English.
  for (const swzPath of GAME_SWZ) {
    const swz = parseSwz(swzPath);
    const mods = swz.chunks.find((chunk) => chunk.xml.includes("<PowerModTypes"));
    const powers = swz.chunks.find((chunk) => chunk.xml.includes("<PlayerPowerTypes"));
    const buffs = swz.chunks.find((chunk) => chunk.xml.includes("<PlayerBuffTypes"));
    if (!mods || !powers || !buffs) throw new SwzPatchError(`${path.basename(swzPath)} is missing PowerModTypes/PlayerPowerTypes/PlayerBuffTypes.`);

    const { blocks } = buildMods({
      powerMods: mods.xml,
      powers: powers.xml,
      buffs: buffs.xml,
      turkish: swzPath.endsWith("Game.tr.swz"),
    });
    const result = insertMods(mods.xml, blocks);
    const powerResult = addPseudoPowers(powers.xml, swzPath.endsWith("Game.tr.swz"));
    summary.push(`${path.basename(swzPath)}: +${result.added} mods, +${powerResult.added} pseudo-powers`);
    changes += result.added + powerResult.added;
    if ((result.added > 0 || powerResult.added > 0) && !verify) {
      pending.push(() => {
        ensureBackup(swzPath);
        mods.xml = result.xml;
        powers.xml = powerResult.xml;
        writeSwz(swz);
      });
    }
  }

  // The loose copies are what GameData and GearGoldBonuses read server-side.
  const referenceSwz = parseSwz(GAME_SWZ[1]);
  const referencePowers = referenceSwz.chunks.find((chunk) => chunk.xml.includes("<PlayerPowerTypes"))!.xml;
  const referenceBuffs = referenceSwz.chunks.find((chunk) => chunk.xml.includes("<PlayerBuffTypes"))!.xml;

  const loosePowerMods = fs.readFileSync(LOOSE_POWER_MODS, "utf8");
  const { blocks, runeByGearId } = buildMods({
    powerMods: loosePowerMods,
    powers: referencePowers,
    buffs: referenceBuffs,
    turkish: false,
  });
  const looseResult = insertMods(loosePowerMods, blocks);
  summary.push(`PowerModTypes.xml: +${looseResult.added} mods`);
  changes += looseResult.added;
  if (looseResult.added > 0 && !verify) {
    pending.push(() => fs.writeFileSync(LOOSE_POWER_MODS, looseResult.xml, "utf8"));
  }

  const loosePowersPath = path.join(CLIENT, "xml", "PlayerPowerTypes.xml");
  const loosePowers = fs.readFileSync(loosePowersPath, "utf8");
  const loosePowersResult = addPseudoPowers(loosePowers, false);
  summary.push(`PlayerPowerTypes.xml: +${loosePowersResult.added} pseudo-powers`);
  changes += loosePowersResult.added;
  if (loosePowersResult.added > 0 && !verify) {
    pending.push(() => fs.writeFileSync(loosePowersPath, loosePowersResult.xml, "utf8"));
  }

  const loginSwz = parseSwz(LOGIN_SWZ);
  const gearChunk = loginSwz.chunks.find((chunk) => chunk.xml.includes("<GearTypes"));
  if (!gearChunk) throw new SwzPatchError("Login.swz has no GearTypes chunk.");
  const swzGear = retargetGearRunes(gearChunk.xml, runeByGearId);
  summary.push(`Login.swz gear runes: ${swzGear.changed} retargeted`);
  changes += swzGear.changed;
  if (swzGear.changed > 0 && !verify) {
    pending.push(() => {
      ensureBackup(LOGIN_SWZ);
      gearChunk.xml = swzGear.xml;
      writeSwz(loginSwz);
    });
  }

  const looseGear = fs.readFileSync(LOOSE_GEAR, "utf8");
  const looseGearResult = retargetGearRunes(looseGear, runeByGearId);
  summary.push(`GearTypes.xml gear runes: ${looseGearResult.changed} retargeted`);
  changes += looseGearResult.changed;
  if (looseGearResult.changed > 0 && !verify) {
    pending.push(() => fs.writeFileSync(LOOSE_GEAR, looseGearResult.xml, "utf8"));
  }

  if (changes === 0) {
    console.log(`Already patched — ${summary.join("; ")}.`);
    return;
  }
  if (verify) {
    console.log(`WOULD PATCH — ${summary.join("; ")}.`);
    return;
  }

  for (const write of pending) write();
  console.log(`Patched — ${summary.join("; ")}.`);
}

const { verify } = parseArgs(process.argv);
patch(verify);
