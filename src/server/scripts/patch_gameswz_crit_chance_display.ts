import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

type PatchResult = {
  xml: string;
  changes: number;
};

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");

const CRIT_CHANCE_DESCRIPTIONS: Array<{ modName: string; values: string }> = [
  { modName: "CritChance1", values: "+0.3%, +0.6%, +0.9%, +1.2%, +1.5%" },
  { modName: "Opportunist1", values: "0.15%, 0.3%, 0.6%, 1.05%, 1.5%" },
  { modName: "CurseCrit1", values: "0.3%, 0.6%, 0.9%, 1.2%, 1.5%" },
];

function replaceOnce(xml: string, search: RegExp, replace: (match: string, ...groups: string[]) => string): PatchResult {
  let changes = 0;
  const patched = xml.replace(search, (match, ...args: string[]) => {
    const replacement = replace(match, ...args);
    if (replacement !== match) {
      changes += 1;
    }
    return replacement;
  });
  return { xml: patched, changes };
}

function replacePowerDescription(xml: string, powerName: string, description: string): PatchResult {
  return replaceOnce(
    xml,
    new RegExp(`(<Power\\s+PowerName="${powerName}">[\\s\\S]*?<Description>)([\\s\\S]*?)(<\\/Description>)`),
    (_match, prefix, _oldDescription, suffix) => `${prefix}${description}${suffix}`,
  );
}

function replaceModDescriptionValues(xml: string, modName: string, values: string): PatchResult {
  return replaceOnce(
    xml,
    new RegExp(`(<PowerModType>\\s*<ModName>${modName}<\\/ModName>[\\s\\S]*?<Description>[\\s\\S]*?@[^:]+:,\\s*)([\\s\\S]*?)(<\\/Description>)`),
    (_match, prefix, _oldValues, suffix) => `${prefix}${values}${suffix}`,
  );
}

function mergeResults(originalXml: string, results: PatchResult[]): PatchResult {
  return {
    xml: results.length > 0 ? results[results.length - 1].xml : originalXml,
    changes: results.reduce((total, result) => total + result.changes, 0),
  };
}

export function patchPlayerPowerCritChanceDisplay(xml: string): PatchResult {
  return replacePowerDescription(xml, "CritChance", "+2% Critical Chance");
}

export function patchPowerModCritChanceDisplay(xml: string): PatchResult {
  const results: PatchResult[] = [];
  let next = xml;
  for (const entry of CRIT_CHANCE_DESCRIPTIONS) {
    const result = replaceModDescriptionValues(next, entry.modName, entry.values);
    next = result.xml;
    results.push(result);
  }
  return mergeResults(xml, results);
}

function patchXmlFile(filePath: string, patcher: (xml: string) => PatchResult, verifyOnly: boolean): number {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = patcher(original);
  if (!verifyOnly && patched.xml !== original) {
    fs.writeFileSync(filePath, patched.xml, "utf8");
  }
  return patched.changes;
}

function patchSwzFile(swzPath: string, verifyOnly: boolean): number {
  const ctx = parseSwz(swzPath);
  let changes = 0;
  let changed = false;

  const playerPowerChunk = ctx.chunks.find((entry) => entry.xml.includes("<PlayerPowerTypes"));
  if (playerPowerChunk) {
    const patched = patchPlayerPowerCritChanceDisplay(playerPowerChunk.xml);
    changes += patched.changes;
    if (patched.xml !== playerPowerChunk.xml) {
      playerPowerChunk.xml = patched.xml;
      changed = true;
    }
  }

  const powerModChunk = ctx.chunks.find((entry) => entry.xml.includes("<PowerModTypes"));
  if (powerModChunk) {
    const patched = patchPowerModCritChanceDisplay(powerModChunk.xml);
    changes += patched.changes;
    if (patched.xml !== powerModChunk.xml) {
      powerModChunk.xml = patched.xml;
      changed = true;
    }
  }

  if (!verifyOnly && changed) {
    ensureBackup(swzPath);
    writeSwz(ctx);
  }

  return changes;
}

function main(): number {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify") || args.includes("--dry-run");
  const swzPaths = ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter(fs.existsSync);

  const changes =
    patchXmlFile(path.join(XML_DIR, "PlayerPowerTypes.xml"), patchPlayerPowerCritChanceDisplay, verifyOnly) +
    patchXmlFile(path.join(XML_DIR, "PowerModTypes.xml"), patchPowerModCritChanceDisplay, verifyOnly) +
    swzPaths.reduce((total, swzPath) => total + patchSwzFile(swzPath, verifyOnly), 0);

  console.log(JSON.stringify({ verifyOnly, swzPaths, changes }, null, 2));
  console.log(changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
  return 0;
}

if (require.main === module) {
  process.exit(main());
}
