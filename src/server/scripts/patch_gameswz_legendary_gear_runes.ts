import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

type PatchResult = {
  xml: string;
  changes: number;
  matchedGearIds: Set<string>;
};

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
const TARGET_GEAR_IDS = new Set(["1162", "1163", "1164"]);

function readTag(block: string, tag: string): string | null {
  return block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? null;
}

function replaceTag(block: string, tag: string, expectedValue: string): { block: string; changed: boolean } {
  const tagPattern = new RegExp(`<${tag}>[^<]*</${tag}>`);
  const expectedTag = `<${tag}>${expectedValue}</${tag}>`;
  const currentTag = block.match(tagPattern)?.[0];

  if (!currentTag) {
    throw new Error(`Legendary target gear is missing <${tag}>.`);
  }
  if (currentTag === expectedTag) {
    return { block, changed: false };
  }

  return { block: block.replace(tagPattern, expectedTag), changed: true };
}

export function patchLegendaryGearRunes(xml: string): PatchResult {
  let changes = 0;
  const matchedGearIds = new Set<string>();
  const patchedXml = xml.replace(
    /<Gear\b[^>]*GearID="([^"]+)"[^>]*>[\s\S]*?<\/Gear>/g,
    (block: string, gearId: string) => {
      if (!TARGET_GEAR_IDS.has(gearId) || readTag(block, "Rarity") !== "L") {
        return block;
      }

      matchedGearIds.add(gearId);
      const healthRune = replaceTag(block, "ProcRune", "HealthPercent");
      const hasteRune = replaceTag(healthRune.block, "ProcRune2", "Haste");
      changes += Number(healthRune.changed) + Number(hasteRune.changed);
      return hasteRune.block;
    },
  );

  for (const gearId of TARGET_GEAR_IDS) {
    if (!matchedGearIds.has(gearId)) {
      throw new Error(`Legendary gear ${gearId} was not found in GearTypes data.`);
    }
  }

  return { xml: patchedXml, changes, matchedGearIds };
}

function patchXmlFile(filePath: string, verifyOnly: boolean): number {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = patchLegendaryGearRunes(original);
  if (!verifyOnly && patched.xml !== original) {
    fs.writeFileSync(filePath, patched.xml, "utf8");
  }
  return patched.changes;
}

function patchSwzFile(swzPath: string, verifyOnly: boolean): number {
  const ctx = parseSwz(swzPath);
  const gearTypesChunk = ctx.chunks.find((entry) => entry.xml.includes("<GearTypes"));
  if (!gearTypesChunk) {
    throw new Error(`${swzPath} does not contain GearTypes data.`);
  }

  const patched = patchLegendaryGearRunes(gearTypesChunk.xml);
  if (!verifyOnly && patched.xml !== gearTypesChunk.xml) {
    gearTypesChunk.xml = patched.xml;
    ensureBackup(swzPath);
    writeSwz(ctx);
  }
  return patched.changes;
}

export function patchConfiguredLegendaryGearRunes(verifyOnly: boolean): number {
  const swzPaths = ["Login.swz", "Login.en.swz", "Login.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter(fs.existsSync);

  return patchXmlFile(path.join(XML_DIR, "GearTypes.xml"), verifyOnly) +
    swzPaths.reduce((total, swzPath) => total + patchSwzFile(swzPath, verifyOnly), 0);
}

function main(): number {
  const verifyOnly = process.argv.includes("--verify") || process.argv.includes("--dry-run");
  const changes = patchConfiguredLegendaryGearRunes(verifyOnly);
  console.log(JSON.stringify({ verifyOnly, changes }, null, 2));
  console.log(changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
  return verifyOnly && changes > 0 ? 1 : 0;
}

if (require.main === module) {
  process.exit(main());
}
