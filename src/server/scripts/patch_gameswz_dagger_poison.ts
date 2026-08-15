import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

/**
 * DaggerPoison -- the poison applied by the Viperblade's Bone Daggers (PoisonDagger).
 *
 * PoisonDagger / PoisonDagger1 used to apply ViperbladePoison (the buff PoisonStrike
 * ranks use). This moves the two dagger powers onto the DaggerPoison buff and retunes
 * that buff so the daggers are their own poison: 0.5 damage per tick instead of 1,
 * 8 stacks instead of 6, and a status icon.
 *
 * The BuffIcon value is the client's *category selector*, not the drawn sprite. The
 * entity status readout (Entity.method_1667) draws one icon per category bit the buff
 * sets, and the category bits come from the BuffIcon list via BuffType.method_1328.
 * a_StatusIcon_AttackUp is a real category that no buff in the data uses, so assigning
 * it to DaggerPoison sets that bit and nothing else changes; patch-dungeonblitz-
 * dagger-poison-icon.ts then repoints the readout's AttackUp case at the dagger sprite
 * class (a_PowerIcon_PoisonDagger, chid 2157) so the dagger icon actually renders.
 *
 * The buff and the powers live in the served archives, not just the loose XML: the
 * client reads Game*.swz and never downloads src/client/content/xml, so both copies
 * have to change together.
 */

type PatchStats = {
  buffBlocks: number;
  powerBlocks: number;
  changes: number;
};

const EMPTY_STATS: PatchStats = { buffBlocks: 0, powerBlocks: 0, changes: 0 };

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
const BUFF_XML = path.join(XML_DIR, "PlayerBuffTypes.xml");
const POWER_XML = path.join(XML_DIR, "PlayerPowerTypes.xml");

export const DAGGER_POISON_BUFF_NAME = "DaggerPoison";
export const DAGGER_POISON_DOT_DAMAGE = "0.5";
export const DAGGER_POISON_STACK_COUNT = "8";
// The readout category the dagger icon is wired to (see patch-dungeonblitz-dagger-poison-icon.ts).
export const DAGGER_POISON_BUFF_ICON = "a_StatusIcon_AttackUp";

/** The powers that switch from ViperbladePoison to DaggerPoison. */
const DAGGER_POWERS = ["PoisonDagger", "PoisonDagger1"];
const OLD_TARGET_BUFF = "ViperbladePoison";
const NEW_TARGET_BUFF = "DaggerPoison";

function cloneStats(): PatchStats {
  return { ...EMPTY_STATS };
}

function mergeStats(...stats: PatchStats[]): PatchStats {
  return stats.reduce(
    (merged, item) => ({
      buffBlocks: merged.buffBlocks + item.buffBlocks,
      powerBlocks: merged.powerBlocks + item.powerBlocks,
      changes: merged.changes + item.changes,
    }),
    cloneStats(),
  );
}

/**
 * PoisonDagger / PoisonDagger1: <AddTargetBuff>ViperbladePoison</AddTargetBuff> ->
 * <AddTargetBuff>DaggerPoison</AddTargetBuff>. Scoped to those two power blocks so any
 * other use of ViperbladePoison (PoisonStrike keeps it) is left alone.
 */
export function patchPlayerPowers(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const oldTag = `<AddTargetBuff>${OLD_TARGET_BUFF}</AddTargetBuff>`;
  const newTag = `<AddTargetBuff>${NEW_TARGET_BUFF}</AddTargetBuff>`;

  const patched = xml.replace(
    /<Power PowerName="([^"]*)">[\s\S]*?<\/Power>/g,
    (block: string, powerName: string) => {
      if (!DAGGER_POWERS.includes(powerName) || !block.includes(oldTag)) {
        return block;
      }
      stats.powerBlocks += 1;
      stats.changes += 1;
      return block.replace(oldTag, newTag);
    },
  );

  return { xml: patched, stats };
}

/**
 * DaggerPoison: DoTDamage 1 -> 0.5, StackCount 6 -> 8, and a BuffIcon pointing at the
 * dagger power icon sprite (a_PowerIcon_PoisonDagger, chid 2157). Scoped to the
 * DaggerPoison block: DoTDamage 1 appears on plenty of other buffs.
 */
export function patchPlayerBuffs(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();

  const start = xml.indexOf(`<BuffType BuffName="${DAGGER_POISON_BUFF_NAME}">`);
  if (start < 0) {
    throw new SwzPatchError(`${DAGGER_POISON_BUFF_NAME} BuffType not found`);
  }
  const blockStart = xml.lastIndexOf("<BuffType", start);
  const end = xml.indexOf("</BuffType>", start);
  if (end < 0) {
    throw new SwzPatchError(`${DAGGER_POISON_BUFF_NAME} BuffType has no closing tag`);
  }
  const blockEnd = end + "</BuffType>".length;

  let block = xml.slice(blockStart, blockEnd);
  const original = block;

  block = block.replace(`<DoTDamage>1</DoTDamage>`, `<DoTDamage>${DAGGER_POISON_DOT_DAMAGE}</DoTDamage>`);
  block = block.replace(`<StackCount>6</StackCount>`, `<StackCount>${DAGGER_POISON_STACK_COUNT}</StackCount>`);
  const expectedIcon = `<BuffIcon>${DAGGER_POISON_BUFF_ICON}</BuffIcon>`;
  if (block.includes(expectedIcon)) {
    // Already on the current BuffIcon; nothing to do.
  } else if (block.includes(`<BuffIcon>`)) {
    // Migrate the earlier value (or any other) to the category selector.
    block = block.replace(/<BuffIcon>[^<]*<\/BuffIcon>/, expectedIcon);
  } else {
    // Reuse the line ending and indent of the BuffLoc line above rather than assuming
    // either: the loose XML and the swz copy do not agree on CRLF.
    block = block.replace(
      /(<BuffLoc>Head<\/BuffLoc>)(\r?\n)([ \t]*)/,
      `$1$2\t\t${expectedIcon}$2$3`,
    );
  }

  if (block !== original) {
    stats.buffBlocks += 1;
    stats.changes += 1;
    return { xml: `${xml.slice(0, blockStart)}${block}${xml.slice(blockEnd)}`, stats };
  }

  return { xml, stats };
}

type Patcher = (xml: string) => { xml: string; stats: PatchStats };

function patchFile(filePath: string, patcher: Patcher, verifyOnly: boolean): PatchStats {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = patcher(original);
  if (!verifyOnly && patched.xml !== original) {
    fs.writeFileSync(filePath, patched.xml, "utf8");
  }
  return patched.stats;
}

function patchSwz(swzPath: string, verifyOnly: boolean): PatchStats {
  const ctx = parseSwz(swzPath);
  const resources: Array<{ marker: string; patcher: Patcher }> = [
    { marker: "<PlayerBuffTypes", patcher: patchPlayerBuffs },
    { marker: "<PlayerPowerTypes", patcher: patchPlayerPowers },
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

  return mergeStats(...collected);
}

export function patchConfiguredDaggerPoison(verifyOnly: boolean): PatchStats {
  const swzPaths = ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter(fs.existsSync);

  return mergeStats(
    patchFile(BUFF_XML, patchPlayerBuffs, verifyOnly),
    patchFile(POWER_XML, patchPlayerPowers, verifyOnly),
    ...swzPaths.map((swzPath) => patchSwz(swzPath, verifyOnly)),
  );
}

function main(): number {
  const verifyOnly = process.argv.includes("--verify") || process.argv.includes("--dry-run");
  try {
    const stats = patchConfiguredDaggerPoison(verifyOnly);
    console.log(JSON.stringify({ verifyOnly, stats }, null, 2));
    console.log(stats.changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_gameswz_dagger_poison] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
