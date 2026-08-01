import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

/**
 * The English build serves Turkish charm text.
 *
 * CharmTypes never had a per-locale split the way the powers did, so when the three locale
 * archives were consolidated down to one English Game.swz the Turkish CharmTypes chunk is
 * what survived: "Yontuk Ametist", "+0.1% kritik sans". Every charm tooltip and every charm
 * name in the forge reads that way.
 *
 * Restoring the English archive wholesale would have been wrong. Its numbers predate the
 * critical-chance correction -- the old English text reads "+0.5% Critical Chance" for a
 * charm whose ProcChanceUp is 0.006, while the Turkish text reads "+0.1%", which is the
 * corrected figure (crit chance from any source is scaled by 0.15, so 0.6% raw is 0.09%
 * effective). Reverting to English would have quietly undone that fix.
 *
 * So names come from the English archive and descriptions are generated from the charm's
 * own stat fields, which keeps the correction by construction and cannot drift from the
 * data again. Only charms with no stats at all -- the Respec Stone and the Charm Remover --
 * carry authored English prose.
 *
 * Pets have the same origin and a simpler fix: their descriptions survived in English and
 * only DisplayName came through Turkish ("Kirmizi Melek" for Questing Cherub), and no pet
 * name is derived from a stat, so the names are restored from the English archive as-is.
 */

type PatchStats = {
  charmBlocks: number;
  changes: number;
};

const EMPTY_STATS: PatchStats = { charmBlocks: 0, changes: 0 };

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
const CHARM_XML = path.join(XML_DIR, "CharmTypes.xml");
const PET_XML = path.join(XML_DIR, "PetTypes.xml");

// Pet display names as the English archive authored them.
const PET_NAMES = new Map<string, string>([
  ["OwlRed", "Great Horned Owl"],
  ["AngelRed", "Questing Cherub"],
  ["FalconRed", "Hunting Falcon"],
  ["CrowRed", "Acquisitive Rook"],
  ["DjinnRed", "Ravening Djinn"],
  ["Dragon2Red", "Omnivorous Bone Dragon"],
  ["Dragon3Red", "Zhulong"],
  ["DragonetteRed", "Vigilent Whelpling"],
  ["FairyRed", "Flame Fey"],
  ["GhostRed", "Rapacious Specter"],
  ["GhoulRed", "Wailing Phantom"],
  ["MonkeyRed", "Soaring Howler"],
  ["PhoenixRed", "Serendipitous Garuda"],
  ["SpriteRed", "Firebrand Elemental"],
  ["OwlYellow", "Burrowing Owl"],
  ["AngelYellow", "Midas Angel"],
  ["FalconYellow", "Golden Kestrel"],
  ["CrowYellow", "Piping Corvus"],
  ["DjinnYellow", "Extravagant Efrit"],
  ["Dragon2Yellow", "Ivory Draconic Remnant"],
  ["Dragon3Yellow", "Fucanglong"],
  ["DragonetteYellow", "Divulgent  Dragonnette"],
  ["FairyYellow", "Diamond-dust Pixie"],
  ["GhostYellow", "Avaricious Phantom"],
  ["GhoulYellow", "Sinful Specter"],
  ["MonkeyYellow", "Golden Macaque"],
  ["PhoenixYellow", "Fortune-favored Firebird"],
  ["SpriteYellow", "Incandescent Spirit"],
  ["OwlBlue", "Saw-Whet Owl"],
  ["AngelBlue", "Ingenious  Seraph"],
  ["FalconBlue", "Mountain Caracara"],
  ["CrowBlue", "Nightfall Crow"],
  ["DjinnBlue", "Brilliant Genie"],
  ["Dragon2Blue", "Ingenious Skeletal Construct"],
  ["Dragon3Blue", "Shenlong"],
  ["DragonetteBlue", "Savvy Wyrmspawn"],
  ["FairyBlue", "Seafoam Nymph"],
  ["GhostBlue", "Patchwork Apparition"],
  ["GhoulBlue", "Fearsome Banshee"],
  ["MonkeyBlue", "Flying Mangabey"],
  ["PhoenixBlue", "Masterful Benu"],
  ["SpriteBlue", "Coalseared Spirit"],
  ["OwlGreen", "Spectacled Owl"],
  ["AngelGreen", "Battle Cherub"],
  ["FalconGreen", "Cryptic Forest-falcon"],
  ["CrowGreen", "Sylvan Raven"],
  ["DjinnGreen", "Virtuoso Marid"],
  ["Dragon2Green", "Exemplary Draconic Skeleton"],
  ["Dragon3Green", "Tianlong"],
  ["DragonetteGreen", "Sophic Whelp"],
  ["FairyGreen", "Sagacious  Sprite"],
  ["GhostGreen", "Avid Eidolon"],
  ["GhoulGreen", "Scholarly Shade"],
  ["MonkeyGreen", "Winged Capuchin"],
  ["PhoenixGreen", "Sacred Phoenix"],
  ["SpriteGreen", "Scintilating Spirit"],
  ["PumpkinRed", "Bewildered Jack-O"],
  ["PumpkinYellow", "Menacing Jack-O"],
  ["PumpkinBlue", "Cyclops Jack-O"],
  ["PumpkinGreen", "Jubilant Jack-O"],
  ["GargoyleRed", "Red-Eyed Gargoyle"],
  ["GargoyleYellow", "Yellow-Eyed Gargoyle"],
  ["GargoyleBlue", "Blue-Eyed Gargoyle"],
  ["GargoyleGreen", "Green-Eyed Gargoyle"],
  ["Lockbox01L01", "Darkheart Apparition"],
  ["Lockbox01L02", "Dreamscale Dragonette"],
  ["Lockbox01RRed", "Accursed Counselor"],
  ["Lockbox01RYellow", "Ruined Counselor"],
  ["Lockbox01RBlue", "Hexed Counselor"],
  ["Lockbox01RGreen", "Doomed Counselor"],
  ["CodexDragon", "Codex Dragon"],
]);

/**
 * Crit chance from every source is multiplied by 0.15 before it applies, so a charm's raw
 * ProcChanceUp is not what the player gets. This is the same convention
 * patch_gameswz_crit_chance_display.ts already applies to the crit power mods.
 */
const CRIT_CHANCE_SCALE = 0.15;

type CharmText = { name: string; description?: string };

const CHARM_TEXT = new Map<string, CharmText>([
  ["Trog01", { name: "Chipped Diamond" }],
  ["Infernal01", { name: "Chipped Amethyst" }],
  ["Undead01", { name: "Chipped Topaz" }],
  ["Mythic01", { name: "Chipped Zircon" }],
  ["Draconic01", { name: "Chipped Ruby" }],
  ["Sylvan01", { name: "Chipped Emerald" }],
  ["Trog02", { name: "Dim Diamond" }],
  ["Infernal02", { name: "Dim Amethyst" }],
  ["Undead02", { name: "Dim Topaz" }],
  ["Mythic02", { name: "Dim Zircon" }],
  ["Draconic02", { name: "Dim Ruby" }],
  ["Sylvan02", { name: "Dim Emerald" }],
  ["Trog03", { name: "Streaked Diamond" }],
  ["Infernal03", { name: "Streaked Amethyst" }],
  ["Undead03", { name: "Streaked Topaz" }],
  ["Mythic03", { name: "Streaked Zircon" }],
  ["Draconic03", { name: "Streaked Ruby" }],
  ["Sylvan03", { name: "Streaked Emerald" }],
  ["Trog04", { name: "Unflawed Diamond" }],
  ["Infernal04", { name: "Unflawed Amethyst" }],
  ["Undead04", { name: "Unflawed Topaz" }],
  ["Mythic04", { name: "Unflawed Zircon" }],
  ["Draconic04", { name: "Unflawed Ruby" }],
  ["Sylvan04", { name: "Unflawed Emerald" }],
  ["Trog05", { name: "Superb Diamond" }],
  ["Infernal05", { name: "Superb Amethyst" }],
  ["Undead05", { name: "Superb Topaz" }],
  ["Mythic05", { name: "Superb Zircon" }],
  ["Draconic05", { name: "Superb Ruby" }],
  ["Sylvan05", { name: "Superb Emerald" }],
  ["Trog06", { name: "Stunning Diamond" }],
  ["Infernal06", { name: "Stunning Amethyst" }],
  ["Undead06", { name: "Stunning Topaz" }],
  ["Mythic06", { name: "Stunning Zircon" }],
  ["Draconic06", { name: "Stunning Ruby" }],
  ["Sylvan06", { name: "Stunning Emerald" }],
  ["Trog07", { name: "Radiant Diamond" }],
  ["Infernal07", { name: "Radiant Amethyst" }],
  ["Undead07", { name: "Radiant Topaz" }],
  ["Mythic07", { name: "Radiant Zircon" }],
  ["Draconic07", { name: "Radiant Ruby" }],
  ["Sylvan07", { name: "Radiant Emerald" }],
  ["Trog08", { name: "Celestial Diamond" }],
  ["Infernal08", { name: "Celestial Amethyst" }],
  ["Undead08", { name: "Celestial Topaz" }],
  ["Mythic08", { name: "Celestial Zircon" }],
  ["Draconic08", { name: "Celestial Ruby" }],
  ["Sylvan08", { name: "Celestial Emerald" }],
  ["Trog09", { name: "Goddess Diamond" }],
  ["Infernal09", { name: "Goddess Amethyst" }],
  ["Undead09", { name: "Goddess Topaz" }],
  ["Mythic09", { name: "Goddess Zircon" }],
  ["Draconic09", { name: "Goddess Ruby" }],
  ["Sylvan09", { name: "Goddess Emerald" }],
  ["Trog10", { name: "Infinite Diamond" }],
  ["Infernal10", { name: "Infinite Amethyst" }],
  ["Undead10", { name: "Infinite Topaz" }],
  ["Mythic10", { name: "Infinite Zircon" }],
  ["Draconic10", { name: "Infinite Ruby" }],
  ["Sylvan10", { name: "Infinite Emerald" }],
  ["Melee01", { name: "Chipped Citrine" }],
  ["Melee02", { name: "Dim Citrine" }],
  ["Melee03", { name: "Streaked Citrine" }],
  ["Melee04", { name: "Unflawed Citrine" }],
  ["Melee05", { name: "Superb Citrine" }],
  ["Melee06", { name: "Stunning Citrine" }],
  ["Melee07", { name: "Radiant Citrine" }],
  ["Melee08", { name: "Celestial Citrine" }],
  ["Melee09", { name: "Goddess Citrine" }],
  ["Melee10", { name: "Infinite Citrine" }],
  ["Magic01", { name: "Chipped Sapphire" }],
  ["Magic02", { name: "Dim Sapphire" }],
  ["Magic03", { name: "Streaked Sapphire" }],
  ["Magic04", { name: "Unflawed Sapphire" }],
  ["Magic05", { name: "Superb Sapphire" }],
  ["Magic06", { name: "Stunning Sapphire" }],
  ["Magic07", { name: "Radiant Sapphire" }],
  ["Magic08", { name: "Celestial Sapphire" }],
  ["Magic09", { name: "Goddess Sapphire" }],
  ["Magic10", { name: "Infinite Sapphire" }],
  ["Armor01", { name: "Chipped Onyx" }],
  ["Armor02", { name: "Dim Onyx" }],
  ["Armor03", { name: "Streaked Onyx" }],
  ["Armor04", { name: "Unflawed Onyx" }],
  ["Armor05", { name: "Superb Onyx" }],
  ["Armor06", { name: "Stunning Onyx" }],
  ["Armor07", { name: "Radiant Onyx" }],
  ["Armor08", { name: "Celestial Onyx" }],
  ["Armor09", { name: "Goddess Onyx" }],
  ["Armor10", { name: "Infinite Onyx" }],
  ["RespecStone", { name: "Respec Stone", description: "Resets your talent stones." }],
  ["TripleFind", { name: "Eye of Discovery" }],
  ["DoubleFind1", { name: "Gleaming Shard" }],
  ["DoubleFind2", { name: "Shimmering Fragment" }],
  ["DoubleFind3", { name: "Twilight Sliver" }],
  ["CharmRemover", { name: "Charm Remover", description: "Removes a Charm from an item." }],
]);

/** label, and whether the field is a fraction rendered as a percentage. */
const STAT_LABELS: Array<[string, string, boolean]> = [
  ["GoldDrop", "Gold Find", true],
  ["ItemDrop", "Item Find", true],
  ["CraftDrop", "Crafting Material Find", true],
  ["ProcChanceUp", "Critical Chance", true],
  ["PowerBonus", "Critical Bonus", true],
  ["HitPointBoost", "Health", false],
  ["MeleeBonus", "Attack", false],
  ["MagicBonus", "Mastery", false],
  ["ArmorBonus", "Defense", false],
];

function cloneStats(): PatchStats {
  return { ...EMPTY_STATS };
}

function readTag(block: string, tag: string): string {
  return (block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? "").trim();
}

function trimNumber(value: number): string {
  return String(Math.round(value * 10) / 10);
}

export function buildCharmDescription(block: string): string {
  const parts: string[] = [];
  for (const [tag, label, isPercent] of STAT_LABELS) {
    const raw = Number(readTag(block, tag));
    if (!Number.isFinite(raw) || raw === 0) {
      continue;
    }

    if (!isPercent) {
      parts.push(`+${Math.round(raw)} ${label}`);
      continue;
    }

    const effective = tag === "ProcChanceUp" ? raw * CRIT_CHANCE_SCALE : raw;
    parts.push(`+${trimNumber(effective * 100)}% ${label}`);
  }

  return parts.join(";");
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

export function patchCharmTypes(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const patched = xml.replace(/<CharmType CharmName="([^"]+)">[\s\S]*?<\/CharmType>/g, (block: string, charmName: string) => {
    const text = CHARM_TEXT.get(charmName);
    if (!text) {
      return block;
    }

    stats.charmBlocks += 1;
    let next = replaceTag(block, "DisplayName", text.name, stats);
    const description = buildCharmDescription(block) || text.description || "";
    if (description) {
      next = replaceTag(next, "Description", description, stats);
    }
    return next;
  });

  return { xml: patched, stats };
}

export function patchPetTypes(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const patched = xml.replace(/<PetType PetName="([^"]+)">[\s\S]*?<\/PetType>/g, (block: string, petName: string) => {
    const name = PET_NAMES.get(petName);
    if (!name) {
      return block;
    }

    stats.charmBlocks += 1;
    return replaceTag(block, "DisplayName", name, stats);
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
    { marker: "<CharmTypes", patcher: patchCharmTypes },
    { marker: "<PetTypes", patcher: patchPetTypes },
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

  return collected.reduce(
    (merged, item) => ({
      charmBlocks: merged.charmBlocks + item.charmBlocks,
      changes: merged.changes + item.changes,
    }),
    cloneStats(),
  );
}

export function patchConfiguredCharmText(verifyOnly: boolean): PatchStats {
  const swzPaths = ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter(fs.existsSync);

  return [
    patchFile(CHARM_XML, patchCharmTypes, verifyOnly),
    patchFile(PET_XML, patchPetTypes, verifyOnly),
    ...swzPaths.map((swzPath) => patchSwz(swzPath, verifyOnly)),
  ].reduce(
    (merged, item) => ({
      charmBlocks: merged.charmBlocks + item.charmBlocks,
      changes: merged.changes + item.changes,
    }),
    cloneStats(),
  );
}

function main(): number {
  const verifyOnly = process.argv.includes("--verify") || process.argv.includes("--dry-run");
  try {
    const stats = patchConfiguredCharmText(verifyOnly);
    console.log(JSON.stringify({ verifyOnly, stats }, null, 2));
    console.log(stats.changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_gameswz_charm_text] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
