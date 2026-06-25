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
const CRITICAL_CHARM_FLAT_CHANCES = new Map<string, { field: "ProcChanceUp" | "PowerBonus"; flatChance: number }>([
  ...Array.from({ length: 10 }, (_, index) => {
    const level = index + 1;
    return [
      `Infernal${String(level).padStart(2, "0")}`,
      { field: "ProcChanceUp" as const, flatChance: level * 0.001 },
    ] as const;
  }),
  ...Array.from({ length: 10 }, (_, index) => {
    const level = index + 1;
    return [
      `Draconic${String(level).padStart(2, "0")}`,
      { field: "PowerBonus" as const, flatChance: level * 0.001 },
    ] as const;
  }),
  ["TripleFind", { field: "ProcChanceUp", flatChance: 0.04 }],
  ["DoubleFind2", { field: "ProcChanceUp", flatChance: 0.04 }],
  ["DoubleFind3", { field: "ProcChanceUp", flatChance: 0.04 }],
]);

function storedProcChance(flatChance: number): string {
  return (flatChance / BASE_CRIT_CHANCE).toFixed(15).replace(/0+$/, "").replace(/\.$/, "");
}

function expectedValueByCharm(): Map<string, { field: "ProcChanceUp" | "PowerBonus"; value: string }> {
  return new Map(
    Array.from(CRITICAL_CHARM_FLAT_CHANCES, ([charmName, { field, flatChance }]) => [
      charmName,
      {
        field,
        value: field === "ProcChanceUp" ? storedProcChance(flatChance) : formatDecimal(flatChance),
      },
    ]),
  );
}

function formatDecimal(value: number): string {
  return value.toFixed(15).replace(/0+$/, "").replace(/\.$/, "");
}

function formatPercent(value: number): string {
  return (value * 100).toFixed(1).replace(/0+$/, "").replace(/\.$/, "");
}

function expectedDescriptionByCharm(): Map<string, string> {
  const entries: Array<readonly [string, string]> = [
    ...Array.from({ length: 10 }, (_, index) => {
      const level = index + 1;
      return [
        `Infernal${String(level).padStart(2, "0")}`,
        `+${formatPercent(level * 0.001)}%`,
      ] as const;
    }),
    ...Array.from({ length: 10 }, (_, index) => {
      const level = index + 1;
      return [
        `Draconic${String(level).padStart(2, "0")}`,
        `+${formatPercent(level * 0.001)}%`,
      ] as const;
    }),
  ];
  return new Map(entries);
}

function replaceCharmProcChance(xml: string): PatchResult {
  const expected = expectedValueByCharm();
  const expectedDescriptions = expectedDescriptionByCharm();
  let changes = 0;
  const patched = xml.replace(/<CharmType\s+CharmName="([^"]+)">[\s\S]*?<\/CharmType>/g, (block, charmName: string) => {
    const next = expected.get(charmName);
    if (!next) {
      return block;
    }

    let nextBlock = block.replace(
      new RegExp(`(<${next.field}>)([\\s\\S]*?)(</${next.field}>)`),
      (match, prefix: string, oldValue: string, suffix: string) => {
        if (oldValue.trim() === next.value) {
          return match;
        }
        changes += 1;
        return `${prefix}${next.value}${suffix}`;
      },
    );
    const nextDescriptionPrefix = expectedDescriptions.get(charmName);
    if (nextDescriptionPrefix) {
      nextBlock = nextBlock.replace(
        /(<Description>\s*)\+[\d.]+%(\s*[^<]*<\/Description>)/,
        (match, prefix: string, suffix: string) => {
          const replacement = `${prefix}${nextDescriptionPrefix}${suffix}`;
          if (match === replacement) {
            return match;
          }
          changes += 1;
          return replacement;
        },
      );
    }
    return nextBlock;
  });

  return { xml: patched, changes };
}

function replaceCharmProcChanceJsonText(xml: string): PatchResult {
  const expected = expectedValueByCharm();
  let changes = 0;
  const patched = xml.replace(
    /("CharmName"\s*:\s*"([^"]+)"[\s\S]*?"(ProcChanceUp|PowerBonus)"\s*:\s*")([^"]*)(")/g,
    (match, prefix: string, charmName: string, field: string, oldValue: string, suffix: string) => {
      const next = expected.get(charmName);
      if (!next || field !== next.field || oldValue.trim() === next.value) {
        return match;
      }
      changes += 1;
      return `${prefix}${next.value}${suffix}`;
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
  const expected = expectedValueByCharm();
  let changes = 0;

  for (const charm of Array.isArray(data) ? data : Object.values(data)) {
    if (!charm || typeof charm !== "object") {
      continue;
    }
    const charmName = String((charm as Record<string, unknown>).CharmName ?? "");
    const next = expected.get(charmName);
    if (!next) {
      continue;
    }
    const record = charm as Record<string, unknown>;
    if (String(record[next.field] ?? "") === next.value) {
      continue;
    }
    record[next.field] = next.value;
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
