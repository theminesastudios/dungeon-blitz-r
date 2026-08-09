import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

type PatchResult = {
  xml: string;
  changes: number;
};

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");

// Pyromania's authored per-rank mastery-mana cost, indexed by rank (0 = the unranked entry).
// It was flattened to "10,50" as a way to force a 50 mastery-mana requirement, but the second
// ManaCost field is the mana a *hit restores*, not a requirement -- the flamethrower was handing
// the caster 50 mana per burn tick. patch-dungeonblitz-mana-requirement.ts makes the client honour
// <ManaRequirement> again, so the costs go back to what the data authors wrote.
const PYROMANIA_MANA_COST_BY_RANK = ["40", "20", "20", "15", "15", "15", "15", "10", "10", "10", "10"];

const POWER_MANA_COSTS = new Map<string, string>([
  ["IceSpike10", "25"],
  ["PainBender10", "25"],
  ...PYROMANIA_MANA_COST_BY_RANK.map((manaCost, rank): [string, string] => [
    rank === 0 ? "Pyromania" : `Pyromania${rank}`,
    manaCost,
  ]),
]);

export function patchPowerManaCosts(xml: string): PatchResult {
  let changes = 0;
  const patched = xml.replace(/<Power PowerName="([^"]+)">[\s\S]*?<\/Power>/g, (block: string, powerName: string) => {
    const expectedManaCost = POWER_MANA_COSTS.get(powerName);
    if (!expectedManaCost) {
      return block;
    }

    const nextBlock = block.replace(/<ManaCost>[\s\S]*?<\/ManaCost>/, (match: string) => {
      const expectedTag = `<ManaCost>${expectedManaCost}</ManaCost>`;
      if (match === expectedTag) {
        return match;
      }
      changes += 1;
      return expectedTag;
    });

    return nextBlock;
  });

  return { xml: patched, changes };
}

function patchXmlFile(filePath: string, verifyOnly: boolean): number {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = patchPowerManaCosts(original);
  if (!verifyOnly && patched.xml !== original) {
    fs.writeFileSync(filePath, patched.xml, "utf8");
  }
  return patched.changes;
}

function patchSwzFile(swzPath: string, verifyOnly: boolean): number {
  const ctx = parseSwz(swzPath);
  const playerPowerChunk = ctx.chunks.find((entry) => entry.xml.includes("<PlayerPowerTypes"));
  if (!playerPowerChunk) {
    return 0;
  }

  const patched = patchPowerManaCosts(playerPowerChunk.xml);
  if (!verifyOnly && patched.xml !== playerPowerChunk.xml) {
    playerPowerChunk.xml = patched.xml;
    ensureBackup(swzPath);
    writeSwz(ctx);
  }

  return patched.changes;
}

export function patchConfiguredPowerManaCosts(verifyOnly: boolean): number {
  const swzPaths = ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter(fs.existsSync);

  return patchXmlFile(path.join(XML_DIR, "PlayerPowerTypes.xml"), verifyOnly) +
    swzPaths.reduce((total, swzPath) => total + patchSwzFile(swzPath, verifyOnly), 0);
}

function main(): number {
  const verifyOnly = process.argv.includes("--verify") || process.argv.includes("--dry-run");
  const changes = patchConfiguredPowerManaCosts(verifyOnly);
  console.log(JSON.stringify({ verifyOnly, changes }, null, 2));
  console.log(changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
  return 0;
}

if (require.main === module) {
  process.exit(main());
}
