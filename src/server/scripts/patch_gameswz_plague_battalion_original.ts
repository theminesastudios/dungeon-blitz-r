import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

/**
 * Restore Plague Battalion's shipped data contract.
 *
 * The original power gives the caster and each undead minion the unranked
 * PlagueBattalion buff. That buff is a one-use marker for the next attack; it is not a timed,
 * Expertise-scaled attack window. The authored Plagued stack caps rise from four to six with the
 * ranks whose upgrade descriptions promise that increase.
 */

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
const STACK_CAPS = [4, 4, 4, 4, 5, 5, 5, 5, 5, 6];

type PatchResult = { xml: string; changes: number };

function removeBlocks(xml: string, pattern: RegExp): PatchResult {
  let changes = 0;
  return {
    xml: xml.replace(pattern, () => {
      changes += 1;
      return "";
    }),
    get changes() {
      return changes;
    },
  };
}

export function restorePowerModTypes(xml: string): PatchResult {
  return removeBlocks(
    xml,
    /\n?\t<PowerModType>(?:(?!<\/PowerModType>)[\s\S])*?<ModName>PlagueExpertise<\/ModName>[\s\S]*?<\/PowerModType>/g,
  );
}

export function restorePlayerPowerTypes(xml: string): PatchResult {
  let changes = 0;
  let next = xml.replace(
    /\n?\t<Power PowerName="(?:PlagueBattalion(?:Melee|ROR)|BattalionPoisonMelee)\d+">[\s\S]*?<\/Power>/g,
    () => {
      changes += 1;
      return "";
    },
  );

  next = next.replace(
    /<Power PowerName="PlagueBattalion(\d+)">[\s\S]*?<\/Power>/g,
    (block: string, rank: string) =>
      block.replace(
        /<(AddTargetBuff|AddSelfBuff)>([^<]*)<\/\1>/g,
        (match: string, tag: string, list: string) => {
          const restored = list
            .split(",")
            .map((entry) =>
              /^PlagueBattalion(?:Minion)?\d*$|^BattalionPoisonMinion\d+$/.test(entry.trim())
                ? "PlagueBattalion"
                : entry.trim(),
            )
            .join(",");
          if (restored === list) return match;
          changes += 1;
          return `<${tag}>${restored}</${tag}>`;
        },
      ),
  );

  // These source tables intentionally have mixed historical line endings. Keep only the restored
  // lines LF-terminated so Git does not interpret their CR as newly introduced trailing space.
  const normalized = next.replace(
    /(<(?:AddTargetBuff|AddSelfBuff)>[^<]*(?:PlagueBattalion|BattalionPoisonMinion)[^<]*<\/[^>]+>)\r\n/g,
    "$1\n",
  );
  if (normalized !== next) changes += 1;
  next = normalized;

  return { xml: next, changes: next === xml ? 0 : changes };
}

export function restorePlayerBuffTypes(xml: string): PatchResult {
  let changes = 0;
  let next = xml.replace(
    /\n?\t<BuffType BuffName="(?:PlagueBattalion(?:Minion)?|BattalionPoisonMinion)\d+">[\s\S]*?<\/BuffType>/g,
    () => {
      changes += 1;
      return "";
    },
  );

  next = next.replace(
    /<BuffType BuffName="PlagueBattalion">[\s\S]*?<\/BuffType>/,
    (block: string) => {
      const restored = block.replace(/\n\t\t<(?:Ranged|Melee)Override>[^<]+<\/[^>]+>/g, "");
      if (restored !== block) changes += 1;
      return restored;
    },
  );

  next = next.replace(
    /<BuffType BuffName="Plagued(\d+)">[\s\S]*?<\/BuffType>/g,
    (block: string, rankText: string) => {
      const expected = STACK_CAPS[Number(rankText) - 1];
      const restored = block
        .replace(/<StackCount>[^<]*<\/StackCount>/, `<StackCount>${expected}</StackCount>`)
        .replace(/(<StackCount>[^<]*<\/StackCount>)\r\n/, "$1\n");
      if (restored !== block) changes += 1;
      return restored;
    },
  );

  return { xml: next, changes: next === xml ? 0 : changes };
}

function patchXmlFile(filePath: string, apply: (xml: string) => PatchResult, verifyOnly: boolean): number {
  const original = fs.readFileSync(filePath, "utf8");
  const restored = apply(original);
  if (!verifyOnly && restored.xml !== original) fs.writeFileSync(filePath, restored.xml, "utf8");
  return restored.changes;
}

function patchSwzFile(swzPath: string, verifyOnly: boolean): number {
  const ctx = parseSwz(swzPath);
  let changes = 0;
  let dirty = false;
  for (const [marker, apply] of [
    ["<PlayerPowerTypes", restorePlayerPowerTypes],
    ["<PlayerBuffTypes", restorePlayerBuffTypes],
    ["<PowerModTypes", restorePowerModTypes],
  ] as const) {
    const chunk = ctx.chunks.find((entry) => entry.xml.includes(marker));
    if (!chunk) continue;
    const restored = apply(chunk.xml);
    changes += restored.changes;
    if (restored.xml !== chunk.xml) {
      chunk.xml = restored.xml;
      dirty = true;
    }
  }
  if (dirty && !verifyOnly) {
    ensureBackup(swzPath);
    writeSwz(ctx);
  }
  return changes;
}

export function restorePlagueBattalionOriginal(verifyOnly: boolean): number {
  let changes = 0;
  changes += patchXmlFile(path.join(XML_DIR, "PlayerPowerTypes.xml"), restorePlayerPowerTypes, verifyOnly);
  changes += patchXmlFile(path.join(XML_DIR, "PlayerBuffTypes.xml"), restorePlayerBuffTypes, verifyOnly);
  changes += patchXmlFile(path.join(XML_DIR, "PowerModTypes.xml"), restorePowerModTypes, verifyOnly);
  for (const fileName of ["Game.swz", "Game.en.swz", "Game.tr.swz"]) {
    const swzPath = path.join(CBQ_DIR, fileName);
    if (fs.existsSync(swzPath)) changes += patchSwzFile(swzPath, verifyOnly);
  }
  return changes;
}

if (require.main === module) {
  const verifyOnly = process.argv.includes("--verify");
  const changes = restorePlagueBattalionOriginal(verifyOnly);
  if (verifyOnly && changes > 0) {
    console.error(`Original Plague Battalion data is missing: ${changes} edit(s) outstanding.`);
    process.exit(1);
  }
  console.log(verifyOnly ? "Original Plague Battalion data verified." : `Original Plague Battalion data restored (${changes} edit(s)).`);
}
