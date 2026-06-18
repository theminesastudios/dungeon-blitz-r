import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

type PatchResult = {
  xml: string;
  changes: number;
};

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const DATA_DIR = path.resolve(__dirname, "..", "data");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");

const BASE_CRIT_CHANCE = 0.15;
const CRITICAL_CHARM_FLAT_CHANCES = new Map<string, number>([
  ...Array.from({ length: 10 }, (_, index) => {
    const level = index + 1;
    return [`Infernal${String(level).padStart(2, "0")}`, level * 0.005] as const;
  }),
  ["TripleFind", 0.04],
  ["DoubleFind2", 0.04],
  ["DoubleFind3", 0.04],
]);

function storedProcChance(flatChance: number): string {
  // Target: 15 * (1 + procChanceUp) should be a "clean" number (max 1 decimal place)
  // Current display: 13.700000000000001
  // Target display: 13.7
  // x = (targetResult / 15) - 1
  
  const currentResult = BASE_CRIT_CHANCE * 100 * (1 + flatChance / BASE_CRIT_CHANCE);
  const targetResult = Math.round(currentResult * 10) / 10;
  const idealMultiplier = (targetResult / (BASE_CRIT_CHANCE * 100)) - 1;
  
  // Use toFixed(6) and trim to ensure a clean, consistent representation on the server
  return idealMultiplier.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

function expectedProcChanceByCharm(): Map<string, string> {
  return new Map(
    Array.from(CRITICAL_CHARM_FLAT_CHANCES, ([charmName, flatChance]) => [
      charmName,
      storedProcChance(flatChance),
    ]),
  );
}

function replaceCharmProcChance(xml: string): PatchResult {
  const expected = expectedProcChanceByCharm();
  let changes = 0;
  const patched = xml.replace(/<CharmType\s+CharmName="([^"]+)">[\s\S]*?<\/CharmType>/g, (block, charmName: string) => {
    const nextValue = expected.get(charmName);
    if (!nextValue) {
      return block;
    }

    return block.replace(
      /(<ProcChanceUp>)([\s\S]*?)(<\/ProcChanceUp>)/,
      (match, prefix: string, oldValue: string, suffix: string) => {
        if (oldValue.trim() === nextValue) {
          return match;
        }
        changes += 1;
        return `${prefix}${nextValue}${suffix}`;
      },
    );
  });

  return { xml: patched, changes };
}

function replaceCharmProcChanceJsonText(xml: string): PatchResult {
  const expected = expectedProcChanceByCharm();
  let changes = 0;
  const patched = xml.replace(
    /("CharmName"\s*:\s*"([^"]+)"[\s\S]*?"ProcChanceUp"\s*:\s*")([^"]*)(")/g,
    (match, prefix: string, charmName: string, oldValue: string, suffix: string) => {
      const nextValue = expected.get(charmName);
      if (!nextValue || oldValue.trim() === nextValue) {
        return match;
      }
      changes += 1;
      return `${prefix}${nextValue}${suffix}`;
    },
  );
  return { xml: patched, changes };
}

function patchXmlFile(filePath: string, verifyOnly: boolean): number {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = replaceCharmProcChance(original);
  if (!verifyOnly && patched.xml !== original) {
    fs.writeFileSync(filePath, patched.xml, "utf8");
  }
  return patched.changes;
}

function patchCharmsJson(filePath: string, verifyOnly: boolean): number {
  const original = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(original);
  const expected = expectedProcChanceByCharm();
  let changes = 0;

  for (const charm of Array.isArray(data) ? data : Object.values(data)) {
    if (!charm || typeof charm !== "object") {
      continue;
    }
    const charmName = String((charm as Record<string, unknown>).CharmName ?? "");
    const nextValue = expected.get(charmName);
    if (!nextValue) {
      continue;
    }
    const record = charm as Record<string, unknown>;
    if (String(record.ProcChanceUp ?? "") === nextValue) {
      continue;
    }
    record.ProcChanceUp = nextValue;
    changes += 1;
  }

  if (!verifyOnly && changes > 0) {
    fs.writeFileSync(filePath, `${JSON.stringify(data, null, 4)}\n`, "utf8");
  }

  return changes;
}

function patchSwzFile(swzPath: string, verifyOnly: boolean): number {
  const ctx = parseSwz(swzPath);
  const charmChunk = ctx.chunks.find((entry) => entry.xml.includes("<CharmTypes") || entry.xml.includes('"CharmName"'));
  if (!charmChunk) {
    return 0;
  }

  const patched = charmChunk.xml.includes("<CharmTypes")
    ? replaceCharmProcChance(charmChunk.xml)
    : replaceCharmProcChanceJsonText(charmChunk.xml);
  if (!verifyOnly && patched.xml !== charmChunk.xml) {
    charmChunk.xml = patched.xml;
    ensureBackup(swzPath);
    writeSwz(ctx);
  }
  return patched.changes;
}

function main(): number {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify") || args.includes("--dry-run");
  const swzPaths = ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter(fs.existsSync);

  const changes =
    patchXmlFile(path.join(XML_DIR, "CharmTypes.xml"), verifyOnly) +
    patchCharmsJson(path.join(DATA_DIR, "Charms.json"), verifyOnly) +
    swzPaths.reduce((total, swzPath) => total + patchSwzFile(swzPath, verifyOnly), 0);

  console.log(JSON.stringify({ verifyOnly, swzPaths, changes }, null, 2));
  console.log(changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
  return 0;
}

if (require.main === module) {
  process.exit(main());
}
