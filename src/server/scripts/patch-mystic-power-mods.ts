import * as fs from "fs";
import * as path from "path";
import { defaultLoginSwzPath, ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";
import { ROGUE_GEAR_EFFECT_PROPERTY, rogueGearRuneEffect } from "./rogueGearRuneEffects";

/**
 * Gives the eighteen Mystic lockbox items their ability bonuses.
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

/**
 * `en`/`tr` are optional: with neither, the description is generated from the ability's own
 * DisplayName *in the file being written*, so the Turkish swz gets the Turkish ability name for
 * free. Spell them out only when the generated "+N% X damage" phrasing is wrong for the effect —
 * a heal, a debuff, a duration.
 *
 * `named` is the power to take that DisplayName from, for abilities whose damage lives in a
 * differently named power (Verdict casts VerdictROR, and only "Verdict" carries a DisplayName).
 */
type Ability =
  /** +pct damage on every rank of `base`, sized against the ability's max-rank BaseDamageMult. */
  | { kind: "damage"; base: string; pct: number; named?: string; en?: string; tr?: string }
  /** Copy an existing mod verbatim under a new name, so the stock one keeps no ComboMod. */
  | { kind: "clone"; from: string }
  /** Discipline-specific Rogue effect shared with Legendary gear. */
  | { kind: "rogue"; base: string; named?: string }
  /** Add to a numeric buff property, on the ranks that already declare it. */
  | { kind: "buff"; buffPrefix: string; property: string; value: number; named?: string; en: string; tr: string };

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
      { kind: "rogue", base: "WitherStrike" },
      { kind: "rogue", base: "SeverStrike" },
      { kind: "rogue", base: "CrippleStrike" },
      { kind: "rogue", base: "HeartSeeker" },
      { kind: "rogue", base: "FatiguingStrike" },
      { kind: "rogue", base: "Devour" },
    ],
  },
  {
    gearId: 1172,
    rune: "MysticRogueOffhand",
    abilities: [
      { kind: "rogue", base: "ChaosArmor" },
      { kind: "rogue", base: "PainBender" },
      { kind: "rogue", base: "WhitheringMist" },
      { kind: "rogue", base: "ShadowTendrilDash" },
      { kind: "rogue", base: "DaggerFlurry" },
      { kind: "rogue", base: "VitalStrike" },
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
      { kind: "rogue", base: "PoisonLance" },
      { kind: "rogue", base: "Reaper" },
      { kind: "rogue", base: "BlackStorm" },
      { kind: "rogue", base: "DarkChi" },
      { kind: "rogue", base: "AssassinateClose", named: "Assassinate" },
      { kind: "rogue", base: "DeathBlowOld" },
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

  // Mage and Paladin follow the layout the Rogue set established: one slot per hotbar row of the
  // three advanced classes, so a full set covers every ability the character can train. Sword = row
  // 1, Shield = row 2, Armor = row 3, Gloves = row 4, Boots = row 5, Hat = row 6 (the ultimates).
  //
  // They are appended rather than sorted into gearID order on purpose: ModIDs are handed out in list
  // order, and the Rogue mods are already written into the shipped XML with the IDs this order
  // produces. Re-sorting would renumber them.
  {
    gearId: 1165,
    rune: "MysticMageSword",
    abilities: [
      { kind: "damage", base: "FrostBlast", pct: 0.15 },
      { kind: "damage", base: "FrozenWard", pct: 0.15 },
      { kind: "damage", base: "FlameSpout", pct: 0.15 },
      { kind: "damage", base: "IridescentBurst", pct: 0.15 },
      { kind: "damage", base: "Lifethirst", pct: 0.15 },
      { kind: "damage", base: "Desecrate", pct: 0.15 },
    ],
  },
  {
    gearId: 1166,
    rune: "MysticMageOffhand",
    abilities: [
      { kind: "damage", base: "FrigidComet", pct: 0.15 },
      { kind: "damage", base: "BitterBlade", pct: 0.15 },
      { kind: "damage", base: "FireStorm", pct: 0.15 },
      { kind: "damage", base: "FlameStrike", pct: 0.15 },
      { kind: "damage", base: "Infestation", pct: 0.15 },
      { kind: "damage", base: "SpectralGrasp", pct: 0.15 },
    ],
  },
  {
    gearId: 1168,
    rune: "MysticMageArmor",
    abilities: [
      { kind: "damage", base: "Avalanche", pct: 0.1 },
      { kind: "damage", base: "GlacialSpear", pct: 0.1 },
      { kind: "damage", base: "MoltenFistExplode", named: "MoltenFist", pct: 0.1 },
      { kind: "damage", base: "FireBrandShot", named: "FireBrand", pct: 0.1 },
      { kind: "damage", base: "BansheeWail", pct: 0.1 },
      // Death Mark deals no damage of its own; it stacks an attack-down debuff, so the mod deepens
      // that instead. MeleeDamage is negative on every rank, hence a negative addend.
      {
        kind: "buff",
        buffPrefix: "DeathMarkStrength",
        property: "MeleeDamage",
        value: -0.05,
        named: "DeathMark",
        en: "Death Mark weakens 5% more",
        tr: "Olum Isareti %5 daha cok zayiflatir.",
      },
    ],
  },
  {
    gearId: 1169,
    rune: "MysticMageGloves",
    abilities: [
      { kind: "clone", from: "RunePermafrostClone" },
      { kind: "clone", from: "RuneWildFire" },
      { kind: "clone", from: "RuneSummonGhoul" },
    ],
  },
  {
    gearId: 1170,
    rune: "MysticMageBoots",
    abilities: [
      { kind: "clone", from: "RunePolarSentry" },
      { kind: "clone", from: "RunePyromania" },
      { kind: "clone", from: "RuneSummonRangedGhoul" },
    ],
  },
  {
    gearId: 1167,
    rune: "MysticMageHat",
    abilities: [
      { kind: "clone", from: "RuneHailstoneEmbrace" },
      { kind: "clone", from: "RuneSummonDragonSoul" },
      { kind: "clone", from: "RunePlagueBattalion" },
    ],
  },
  {
    gearId: 1177,
    rune: "MysticPaladinSword",
    abilities: [
      { kind: "damage", base: "RollingSmash", pct: 0.15 },
      { kind: "damage", base: "ShieldFlurryStrike", named: "ShieldFlurry", pct: 0.15 },
      { kind: "damage", base: "FlameAxe", pct: 0.15 },
      { kind: "damage", base: "FuriousAssault", pct: 0.15 },
      { kind: "damage", base: "DivineWord", pct: 0.15 },
      { kind: "damage", base: "Subjugate", pct: 0.15 },
    ],
  },
  {
    gearId: 1178,
    rune: "MysticPaladinOffhand",
    abilities: [
      { kind: "damage", base: "JuggernautCharge", named: "Juggernaut", pct: 0.15 },
      // Second Wind heals over time through a self buff; DoTDamage is negative there, so a negative
      // addend heals harder.
      {
        kind: "buff",
        buffPrefix: "SecondWind",
        property: "DoTDamage",
        value: -1.5,
        named: "SecondWind",
        en: "Second Wind heals more",
        tr: "Ikinci Nefes daha cok iyilestirir.",
      },
      { kind: "damage", base: "Harm", pct: 0.15 },
      { kind: "damage", base: "JusticeFist", pct: 0.15 },
      // Hallowed Reckoning's BaseDamageMult is negative (a heal), so the same +15% scaling lands as
      // 15% more healing — only the wording has to change.
      {
        kind: "damage",
        base: "FountainOfLife",
        pct: 0.15,
        en: "+15% Hallowed Reckoning healing",
        tr: "Kutsal Hesaplasma iyilestirmesi %15 artar.",
      },
      { kind: "damage", base: "Penance", pct: 0.15 },
    ],
  },
  {
    gearId: 1180,
    rune: "MysticPaladinArmor",
    abilities: [
      { kind: "damage", base: "Shockwave", pct: 0.1 },
      { kind: "damage", base: "Retribution", pct: 0.1 },
      { kind: "damage", base: "LightningStorm", pct: 0.1 },
      // Cleaving Blows just turns the basic attack into a cleave for a while; there is nothing to
      // scale but the window it lasts.
      {
        kind: "buff",
        buffPrefix: "HeavyBlows",
        property: "Duration",
        value: 2000,
        named: "CleavingBlows",
        en: "+2s Cleaving Blows duration",
        tr: "Yaran Darbeler suresi 2sn artar.",
      },
      { kind: "damage", base: "CelestialLance", pct: 0.1 },
      { kind: "damage", base: "VerdictROR", named: "Verdict", pct: 0.1 },
    ],
  },
  {
    gearId: 1181,
    rune: "MysticPaladinGloves",
    abilities: [
      { kind: "clone", from: "RuneDefiance" },
      { kind: "clone", from: "RuneLeapStrike" },
      { kind: "clone", from: "RuneSanctum" },
    ],
  },
  {
    gearId: 1182,
    rune: "MysticPaladinBoots",
    abilities: [
      { kind: "clone", from: "RuneBarrier" },
      { kind: "clone", from: "RuneLightningBomb" },
      { kind: "clone", from: "RuneCleansingLight" },
    ],
  },
  {
    gearId: 1179,
    rune: "MysticPaladinHat",
    abilities: [
      { kind: "clone", from: "RuneSentinelForm" },
      { kind: "clone", from: "RuneBerserker" },
      { kind: "clone", from: "RuneLeoneanAura" },
    ],
  },
];

/** The head mod is a clone of this, so the item keeps its stock basic-attack line. */
const HEAD_TEMPLATE = "RuneSwordMelee";
/** Stock ModIDs top out at 894. */
const FIRST_MOD_ID = 1000;

const CLIENT = path.resolve(__dirname, "..", "..", "client", "content");
/**
 * One archive, not three: release/v1.13.0 made the game English-only and deleted Game.en.swz and
 * Game.tr.swz, and StaticServer now serves p/cbq/Game.swz to every client. The `tr` strings on the
 * ability table stay — they cost nothing and are the translation to reuse if localisation returns —
 * but nothing writes a Turkish archive any more.
 */
const GAME_SWZ = [path.join(CLIENT, "localhost", "p", "cbq", "Game.swz")];
const LOOSE_POWER_MODS = path.join(CLIENT, "xml", "PowerModTypes.xml");
const LOOSE_GEAR = path.join(CLIENT, "xml", "GearTypes.xml");
/**
 * Login.swz exists in both p/cbp and p/cbq, and which one the client downloads has flipped
 * historically: masterFileList.xml pins it to cbq, while the served DungeonBlitz.swf (and the
 * default below) lives in cbp. Patch both so the Mystic power runes can never drift out of the
 * copy a player actually loads.
 */
const LOGIN_SWZ_FILES = [defaultLoginSwzPath(), path.join(CLIENT, "localhost", "p", "cbq", "Login.swz")];

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
        "  npx ts-node src/server/scripts/patch-mystic-power-mods.ts [--verify]",
        "",
        "Creates the PowerModType chains behind the eighteen Mystic items and points each item's",
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

/**
 * The strongest rank's total damage multiplier, keeping its sign.
 *
 * BaseDamageMult is a comma list on multi-hit powers ("2.44,2.44") and the client sums it into one
 * `damageMultFull`, which is also what a mod's flat PowerValue is added to — so the rank's weight is
 * the sum, not any single hit. Healing powers carry a negative multiplier; returning it signed means
 * `pct * value` scales a heal by the same percentage it would scale damage.
 */
function maxRankDamage(powerXml: string, names: string[]): number {
  let best = 0;
  for (const name of names) {
    const block = powerXml.match(new RegExp(`<Power PowerName="${name}">([\\s\\S]*?)</Power>`))?.[1] ?? "";
    const total = (tag(block, "BaseDamageMult") ?? "")
      .split(",")
      .reduce((sum, part) => sum + (Number.isFinite(Number(part)) ? Number(part) : 0), 0);
    if (Math.abs(total) > Math.abs(best)) best = total;
  }
  if (best === 0) throw new SwzPatchError(`${names[0]} has no BaseDamageMult to scale against.`);
  return best;
}

/** An ability's own DisplayName in the file being written, so generated text follows its language. */
function powerDisplayName(powerXml: string, name: string): string {
  for (const candidate of [name, `${name}1`]) {
    const block = powerXml.match(new RegExp(`<Power PowerName="${candidate}">([\\s\\S]*?)</Power>`))?.[1];
    const display = block ? tag(block, "DisplayName") : null;
    if (display) return display;
  }
  throw new SwzPatchError(`No DisplayName to describe ${name} with; give the ability an explicit en/tr.`);
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

/** Builds every new PowerModType block for one file, in chain order, grouped per item. */
function buildMods(corpus: Corpus): { chains: string[][]; runeByGearId: Map<number, string> } {
  const blocks: string[] = [];
  const chains: string[][] = [];
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

      if (ability.kind === "rogue") {
        const effect = rogueGearRuneEffect(ability.base);
        if (!effect) throw new SwzPatchError(`No staged Rogue gear effect is defined for ${ability.base}.`);
        const description = corpus.turkish ? effect.tr : effect.description;
        const displayName = powerDisplayName(corpus.powers, ability.named ?? ability.base);

        if (effect.kind === "buff") {
          const entries = effect.buffNames.flatMap((buffName) => effect.properties.map((property) => ({ buffName, ...property })));
          for (const entry of entries) {
            const block = corpus.buffs.match(new RegExp(`<BuffType BuffName="${entry.buffName}">([\\s\\S]*?)</BuffType>`))?.[1];
            if (!block?.includes(`<${entry.name}>`)) {
              throw new SwzPatchError(`${entry.buffName} does not declare <${entry.name}>.`);
            }
          }
          blocks.push(
            [
              "\t<PowerModType>",
              `\t\t<ModName>${name}</ModName>`,
              `\t\t<ModID>${modId++}</ModID>`,
              `\t\t<DisplayName>${displayName}</DisplayName>`,
              `\t\t<Description>${description}</Description>`,
              "\t\t<ModType>Buff</ModType>",
              `\t\t<BuffName>${entries.map((entry) => entry.buffName).join(",")}</BuffName>`,
              `\t\t<BuffProperty>${entries.map((entry) => entry.name).join(",")}</BuffProperty>`,
              `\t\t<BuffValue>${entries.map((entry) => round(entry.value)).join(",")}</BuffValue>`,
              "\t\t<IconName>a_Signet_Empty</IconName>",
              ...(next ? [`\t\t<ComboMod>${next}</ComboMod>`] : []),
              "\t</PowerModType>",
            ].join("\r\n"),
          );
          return;
        }

        const names = powerRanks(corpus.powers, ability.base);
        const property = effect.kind === "conditional"
          ? ROGUE_GEAR_EFFECT_PROPERTY
          : effect.kind === "damage" ? "BaseDamageMult" : effect.property;
        const value = effect.kind === "conditional"
          ? String(effect.marker)
          : effect.kind === "damage" ? round(effect.pct * maxRankDamage(corpus.powers, names)) : effect.value;
        blocks.push(
          [
            "\t<PowerModType>",
            `\t\t<ModName>${name}</ModName>`,
            `\t\t<ModID>${modId++}</ModID>`,
            `\t\t<DisplayName>${displayName}</DisplayName>`,
            `\t\t<Description>${description}</Description>`,
            "\t\t<ModType>Power</ModType>",
            `\t\t<PowerName>${names.join(",")}</PowerName>`,
            `\t\t<PowerProperty>${property}</PowerProperty>`,
            `\t\t<PowerValue>${value}</PowerValue>`,
            "\t\t<IconName>a_Signet_Empty</IconName>",
            ...(next ? [`\t\t<ComboMod>${next}</ComboMod>`] : []),
            "\t</PowerModType>",
          ].join("\r\n"),
        );
        return;
      }

      // An ability with no spelled-out text describes itself: "+15% <its DisplayName> damage", read
      // out of the file being written, so the Turkish swz says it in Turkish without a second table
      // here to keep in step.
      // Lazy: an ability that spells its text out never needs a DisplayName to exist for the power
      // it targets, and several of them (SeekingBladesAttack, VerdictROR) genuinely have none.
      const localName = (): string =>
        powerDisplayName(corpus.powers, ability.named ?? (ability.kind === "damage" ? ability.base : ability.buffPrefix));
      const percent = ability.kind === "damage" ? Math.round(ability.pct * 100) : 0;
      const description =
        (corpus.turkish ? ability.tr : ability.en) ??
        (corpus.turkish ? `${localName()} hasari %${percent} artar.` : `+${percent}% ${localName()} damage`);
      // Spelled-out entries keep naming the mod after their English text; generated ones take the
      // ability's own name in the file's language, exactly as a cloned mod's DisplayName does.
      const displayName = ability.en ? displayFromDescription(ability.en) : localName();

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
    chains.push(blocks.slice(itemStart));
  }

  return { chains, runeByGearId };
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

/**
 * Adds whole chains only. An item whose chain is already in the file is skipped, so a run that adds
 * a new class does not touch the classes already shipped; a chain that is *half* present is a
 * genuinely broken file and still refuses to be patched over.
 */
function insertMods(powerModsXml: string, chains: string[][]): { xml: string; added: number } {
  let out = powerModsXml;
  const missing: string[] = [];
  for (const chain of chains) {
    const absent = chain.filter((block) => {
      const name = tag(block, "ModName");
      return name !== null && !out.includes(`<ModName>${name}</ModName>`);
    });
    if (absent.length === 0) continue;
    if (absent.length !== chain.length) {
      const head = tag(chain[0], "ModName");
      throw new SwzPatchError(`PowerModTypes has a partial ${head} chain (${chain.length - absent.length} of ${chain.length} present); revert and re-run.`);
    }
    missing.push(...absent);
  }

  let updated = 0;
  for (const chain of chains) {
    if (chain.some((block) => missing.includes(block))) continue;
    for (const expected of chain) {
      const name = tag(expected, "ModName");
      if (!name) throw new SwzPatchError("Generated PowerModType has no ModName.");
      const current = findMod(out, name);
      if (current.replace(/\r\n/g, "\n") === expected.replace(/\r\n/g, "\n")) continue;
      out = out.replace(current, expected);
      updated += 1;
    }
  }
  if (missing.length === 0) return { xml: out, added: updated };

  const close = out.lastIndexOf("</PowerModTypes>");
  if (close === -1) throw new SwzPatchError("No </PowerModTypes> close tag.");
  const eol = powerModsXml.includes("\r\n") ? "\r\n" : "\n";
  return {
    xml: `${out.slice(0, close)}${missing.join(eol)}${eol}${out.slice(close)}`,
    added: missing.length + updated,
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

    const { chains } = buildMods({
      powerMods: mods.xml,
      powers: powers.xml,
      buffs: buffs.xml,
      turkish: swzPath.endsWith("Game.tr.swz"),
    });
    const result = insertMods(mods.xml, chains);
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
  const referenceSwz = parseSwz(GAME_SWZ[0]);
  const referencePowers = referenceSwz.chunks.find((chunk) => chunk.xml.includes("<PlayerPowerTypes"))!.xml;
  const referenceBuffs = referenceSwz.chunks.find((chunk) => chunk.xml.includes("<PlayerBuffTypes"))!.xml;

  const loosePowerMods = fs.readFileSync(LOOSE_POWER_MODS, "utf8");
  const { chains, runeByGearId } = buildMods({
    powerMods: loosePowerMods,
    powers: referencePowers,
    buffs: referenceBuffs,
    turkish: false,
  });
  const looseResult = insertMods(loosePowerMods, chains);
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

  let loginChanged = 0;
  for (const loginPath of LOGIN_SWZ_FILES) {
    const loginSwz = parseSwz(loginPath);
    const gearChunk = loginSwz.chunks.find((chunk) => chunk.xml.includes("<GearTypes"));
    if (!gearChunk) throw new SwzPatchError(`${path.basename(loginPath)} has no GearTypes chunk.`);
    const swzGear = retargetGearRunes(gearChunk.xml, runeByGearId);
    loginChanged += swzGear.changed;
    if (swzGear.changed > 0 && !verify) {
      pending.push(() => {
        ensureBackup(loginPath);
        gearChunk.xml = swzGear.xml;
        writeSwz(loginSwz);
      });
    }
  }
  summary.push(`Login.swz (cbp+cbq) gear runes: ${loginChanged} retargeted`);
  changes += loginChanged;

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
