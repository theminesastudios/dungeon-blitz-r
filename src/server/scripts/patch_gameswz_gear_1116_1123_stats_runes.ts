import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

type PatchResult = { xml: string; changes: number; matchedVariants: Set<string> };

const TARGET_GEAR_IDS = new Set(["1116", "1123"]);
const EXPECTED_RARITIES = new Set(["M", "R", "L"]);
const XML_PATH = path.resolve(__dirname, "..", "..", "client", "content", "xml", "GearTypes.xml");
const LOGIN_SWZ_PATH = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbq", "Login.swz",
);

function readTag(block: string, tag: string): string | null {
  return block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? null;
}

function replaceExpectedTag(
  block: string,
  tag: string,
  oldValue: string,
  newValue: string,
  variant: string,
): { block: string; changed: boolean } {
  const currentValue = readTag(block, tag);
  if (currentValue === newValue) return { block, changed: false };
  if (currentValue !== oldValue) {
    throw new Error(`${variant} has unexpected ${tag} ${currentValue ?? "<missing>"}.`);
  }
  return {
    block: block.replace(`<${tag}>${oldValue}</${tag}>`, `<${tag}>${newValue}</${tag}>`),
    changed: true,
  };
}

export function patchGear1116And1123StatsRunes(xml: string): PatchResult {
  let changes = 0;
  const matchedVariants = new Set<string>();
  const patchedXml = xml.replace(
    /<Gear\b[^>]*GearID="([^"]+)"[^>]*>[\s\S]*?<\/Gear>/g,
    (originalBlock: string, gearId: string) => {
      if (!TARGET_GEAR_IDS.has(gearId)) return originalBlock;

      const rarity = readTag(originalBlock, "Rarity");
      if (!rarity || !EXPECTED_RARITIES.has(rarity)) {
        throw new Error(`Gear ${gearId} has unexpected rarity ${rarity ?? "<missing>"}.`);
      }
      const variant = `${gearId}${rarity}`;
      if (matchedVariants.has(variant)) throw new Error(`Duplicate gear variant ${variant}.`);
      matchedVariants.add(variant);

      let result = replaceExpectedTag(
        originalBlock, "StatRune", "RogueArmor", "RogueExpertise", variant,
      );
      changes += Number(result.changed);

      if (rarity === "M") {
        if (readTag(result.block, "MagicRune") !== "ItemDrop") {
          throw new Error(`${variant} has unexpected MagicRune ${readTag(result.block, "MagicRune") ?? "<missing>"}.`);
        }
      } else {
        const oldMagicRune = gearId === "1116" ? "ItemDrop+CraftDrop" : "ItemDrop+GoldDrop";
        result = replaceExpectedTag(result.block, "MagicRune", oldMagicRune, "Speed+ItemDrop", variant);
        changes += Number(result.changed);
      }

      if (gearId === "1123") {
        result = replaceExpectedTag(result.block, "ProcRune", "DeathSlay", "Haste", variant);
        changes += Number(result.changed);
      }
      if (gearId === "1116" && rarity === "L") {
        result = replaceExpectedTag(result.block, "ProcRune2", "ResistEarth", "CritDamage", variant);
        changes += Number(result.changed);
      }
      return result.block;
    },
  );

  for (const gearId of TARGET_GEAR_IDS) {
    for (const rarity of EXPECTED_RARITIES) {
      const variant = `${gearId}${rarity}`;
      if (!matchedVariants.has(variant)) throw new Error(`Gear variant ${variant} was not found.`);
    }
  }
  return { xml: patchedXml, changes, matchedVariants };
}

function patchXmlFile(filePath: string, verifyOnly: boolean): number {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = patchGear1116And1123StatsRunes(original);
  if (!verifyOnly && patched.xml !== original) fs.writeFileSync(filePath, patched.xml, "utf8");
  return patched.changes;
}

function patchSwzFile(filePath: string, verifyOnly: boolean): number {
  const ctx = parseSwz(filePath);
  const gearTypesChunk = ctx.chunks.find((entry) => entry.xml.includes("<GearTypes"));
  if (!gearTypesChunk) throw new Error(`${filePath} does not contain GearTypes data.`);

  const patched = patchGear1116And1123StatsRunes(gearTypesChunk.xml);
  if (!verifyOnly && patched.xml !== gearTypesChunk.xml) {
    gearTypesChunk.xml = patched.xml;
    ensureBackup(filePath);
    writeSwz(ctx);
  }
  return patched.changes;
}

export function patchConfiguredGear1116And1123StatsRunes(verifyOnly: boolean): number {
  return patchXmlFile(XML_PATH, verifyOnly) + patchSwzFile(LOGIN_SWZ_PATH, verifyOnly);
}

function main(): number {
  const verifyOnly = process.argv.includes("--verify") || process.argv.includes("--dry-run");
  const changes = patchConfiguredGear1116And1123StatsRunes(verifyOnly);
  console.log(JSON.stringify({ verifyOnly, changes }, null, 2));
  return verifyOnly && changes > 0 ? 1 : 0;
}

if (require.main === module) process.exit(main());
