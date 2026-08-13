import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

type PatchResult = {
  xml: string;
  changes: number;
  matchedRarities: Set<string>;
};

const TARGET_GEAR_ID = "227";
const EXPECTED_RARITIES = new Set(["M", "R", "L"]);
const XML_PATH = path.resolve(__dirname, "..", "..", "client", "content", "xml", "GearTypes.xml");
const LOGIN_SWZ_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "client",
  "content",
  "localhost",
  "p",
  "cbq",
  "Login.swz",
);

function readTag(block: string, tag: string): string | null {
  return block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? null;
}

export function patchGear227CriticalPower(xml: string): PatchResult {
  let changes = 0;
  const matchedRarities = new Set<string>();
  const patchedXml = xml.replace(
    /<Gear\b[^>]*GearID="([^"]+)"[^>]*>[\s\S]*?<\/Gear>/g,
    (block: string, gearId: string) => {
      if (gearId !== TARGET_GEAR_ID) return block;

      const rarity = readTag(block, "Rarity");
      if (!rarity || !EXPECTED_RARITIES.has(rarity)) {
        throw new Error(`Gear ${TARGET_GEAR_ID} has unexpected rarity ${rarity ?? "<missing>"}.`);
      }
      if (matchedRarities.has(rarity)) {
        throw new Error(`Gear ${TARGET_GEAR_ID} has duplicate rarity ${rarity}.`);
      }
      matchedRarities.add(rarity);

      if (rarity !== "L") {
        if (block.includes("<ProcRune2>ResistLife</ProcRune2>")) {
          throw new Error(`Gear ${TARGET_GEAR_ID}${rarity} unexpectedly contains ResistLife.`);
        }
        return block;
      }

      const currentRune = readTag(block, "ProcRune2");
      if (currentRune === "CritDamage") return block;
      if (currentRune !== "ResistLife") {
        throw new Error(`Gear ${TARGET_GEAR_ID}L has unexpected ProcRune2 ${currentRune ?? "<missing>"}.`);
      }
      changes += 1;
      return block.replace("<ProcRune2>ResistLife</ProcRune2>", "<ProcRune2>CritDamage</ProcRune2>");
    },
  );

  for (const rarity of EXPECTED_RARITIES) {
    if (!matchedRarities.has(rarity)) {
      throw new Error(`Gear ${TARGET_GEAR_ID}${rarity} was not found in GearTypes data.`);
    }
  }
  return { xml: patchedXml, changes, matchedRarities };
}

function patchXmlFile(filePath: string, verifyOnly: boolean): number {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = patchGear227CriticalPower(original);
  if (!verifyOnly && patched.xml !== original) fs.writeFileSync(filePath, patched.xml, "utf8");
  return patched.changes;
}

function patchSwzFile(filePath: string, verifyOnly: boolean): number {
  const ctx = parseSwz(filePath);
  const gearTypesChunk = ctx.chunks.find((entry) => entry.xml.includes("<GearTypes"));
  if (!gearTypesChunk) throw new Error(`${filePath} does not contain GearTypes data.`);

  const patched = patchGear227CriticalPower(gearTypesChunk.xml);
  if (!verifyOnly && patched.xml !== gearTypesChunk.xml) {
    gearTypesChunk.xml = patched.xml;
    ensureBackup(filePath);
    writeSwz(ctx);
  }
  return patched.changes;
}

export function patchConfiguredGear227CriticalPower(verifyOnly: boolean): number {
  return patchXmlFile(XML_PATH, verifyOnly) + patchSwzFile(LOGIN_SWZ_PATH, verifyOnly);
}

function main(): number {
  const verifyOnly = process.argv.includes("--verify") || process.argv.includes("--dry-run");
  const changes = patchConfiguredGear227CriticalPower(verifyOnly);
  console.log(JSON.stringify({ verifyOnly, changes }, null, 2));
  return verifyOnly && changes > 0 ? 1 : 0;
}

if (require.main === module) process.exit(main());
