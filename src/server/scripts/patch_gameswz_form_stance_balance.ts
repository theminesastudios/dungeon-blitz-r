import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

/**
 * Charon's Blades and Sentinel Form trade mana for a stance, and both stances were
 * priced so steeply that nobody could stay in them. Neither buff has a Duration --
 * PlayerBuffTypes gives SeekingBlades and SentinelForm1-10 `<Duration>0</Duration>` --
 * so "how long the form lasts" is not a timer at all. It is mana divided by the cost of
 * a swing, and at rank 10 Charon's Blades charged 10 mana per swing, which measures out
 * at roughly 6-8 mana a second in play.
 *
 * So the knob for duration is the per-swing cost, and it is paid for in damage:
 *
 *   - stance/attack mana cost x0.6  -> the form lasts about 1.7x as long
 *   - attack damage x0.75           -> 25% less damage while in it
 *   - Sentinel defense +5pp         -> the tankier form gets tankier, as asked
 *
 * Values are absolute, not multipliers applied to whatever is in the file. This runs on
 * every prebuild, and a multiplier would scale an already-scaled number on the second
 * run.
 *
 * ponytail: one flat scale per stance rather than a per-rank curve. If a specific rank
 * ends up over- or under-tuned, edit its row -- the tables are the whole design.
 */

type PatchStats = {
  powerBlocks: number;
  buffBlocks: number;
  changes: number;
};

const EMPTY_STATS: PatchStats = { powerBlocks: 0, buffBlocks: 0, changes: 0 };

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
const POWER_XML = path.join(XML_DIR, "PlayerPowerTypes.xml");
const BUFF_XML = path.join(XML_DIR, "PlayerBuffTypes.xml");

// What a swing costs while the stance is up. Comments are the authored value.
const STANCE_MANA_COSTS = new Map<string, string>([
  ["SeekingBlades", "12"], //   20
  ["SeekingBlades1", "12"], //  20
  ["SeekingBlades2", "9"], //   15
  ["SeekingBlades3", "9"], //   15
  ["SeekingBlades4", "9"], //   15
  ["SeekingBlades5", "9"], //   15
  ["SeekingBlades6", "6"], //   10
  ["SeekingBlades7", "6"], //   10
  ["SeekingBlades8", "6"], //   10
  ["SeekingBlades9", "6"], //   10
  ["SeekingBlades10", "6"], //  10
  ["SFMelee1", "7"], //         11
  ["SFMelee2", "7"], //         11
  ["SFMelee3", "5"], //          8
  ["SFMelee6", "5"], //          8
  ["SFMelee8", "4"], //          6
  ["SFMelee9", "4"], //          6
  ["SFMelee10", "4"], //         6
  ["SFMeleeCombo1", "7"], //    11
  ["SFMeleeCombo2", "7"], //    11
  ["SFMeleeCombo3", "5"], //     8
  ["SFMeleeCombo6", "5"], //     8
  ["SFMeleeCombo8", "4"], //     6
  ["SFMeleeCombo9", "4"], //     6
  ["SFMeleeCombo10", "4"], //    6
  ["SFRanged1", "7"], //        11
  ["SFRanged2", "7"], //        11
  ["SFRanged3", "5"], //         8
  ["SFRanged6", "5"], //         8
  ["SFRanged8", "4"], //         6
  ["SFRanged9", "4"], //         6
  ["SFRanged10", "4"], //        6
]);

// What a swing hits for while the stance is up. Comments are the authored value.
const STANCE_DAMAGE_MULTS = new Map<string, string>([
  ["SeekingBladesAttack", "1.36"], //   1.82
  ["SeekingBladesAttack1", "0.75"], //  1
  ["SeekingBladesAttack2", "0.83"], //  1.1
  ["SeekingBladesAttack3", "0.91"], //  1.21
  ["SeekingBladesAttack4", "1"], //     1.33
  ["SeekingBladesAttack5", "1.09"], //  1.46
  ["SeekingBladesAttack6", "1.26"], //  1.68
  ["SeekingBladesAttack7", "1.45"], //  1.93
  ["SeekingBladesAttack8", "1.67"], //  2.23
  ["SeekingBladesAttack9", "1.83"], //  2.44
  ["SeekingBladesAttack10", "1.83"], // 2.44
  ["SFMelee1", "1.6"], //               2.13
  ["SFMelee2", "1.7"], //               2.27
  ["SFMelee3", "1.7"], //               2.27
  ["SFMelee6", "1.88"], //              2.5
  ["SFMelee8", "1.88"], //              2.5
  ["SFMelee9", "2.08"], //              2.77
  ["SFMelee10", "2.17"], //             2.9
  ["SFMeleeCombo1", "0.9"], //          1.2
  ["SFMeleeCombo2", "0.95"], //         1.26
  ["SFMeleeCombo3", "0.95"], //         1.26
  ["SFMeleeCombo6", "1.03"], //         1.38
  ["SFMeleeCombo8", "1.03"], //         1.38
  ["SFMeleeCombo9", "1.12"], //         1.5
  ["SFMeleeCombo10", "1.16"], //        1.55
  ["SFRanged1", "1.05"], //             1.4
  ["SFRanged2", "1.1"], //              1.47
  ["SFRanged3", "1.1"], //              1.47
  ["SFRanged6", "1.34"], //             1.79
  ["SFRanged8", "1.44"], //             1.92
  ["SFRanged9", "1.53"], //             2.04
  ["SFRanged10", "1.63"], //            2.17
]);

// Sentinel is the tank stance, so the trade is defense, not just uptime. Comments are
// the authored value; both resistances move together, as authored.
const SENTINEL_DEFENSE = new Map<string, string>([
  ["SentinelForm1", "0.65"], //  0.6
  ["SentinelForm2", "0.65"], //  0.6
  ["SentinelForm3", "0.65"], //  0.6
  ["SentinelForm4", "0.75"], //  0.7
  ["SentinelForm5", "0.75"], //  0.7
  ["SentinelForm6", "0.75"], //  0.7
  ["SentinelForm7", "0.8"], //   0.75
  ["SentinelForm8", "0.8"], //   0.75
  ["SentinelForm9", "0.8"], //   0.75
  ["SentinelForm10", "0.8"], //  0.75
]);

// The tooltips quote the defense number, so they move with it or they start lying. Both
// languages, because Game.tr.swz carries its own translated copy of the same string and
// an English-only rewrite leaves Turkish players reading the old number.
//
// Ordered longest-first per power: "75% Defense Boost" is what rank 4 becomes and what
// rank 7 currently says, so a naive pass over rank 7 would rewrite 75 -> 80 twice.
// Rewriting a whole quoted phrase rather than the bare number is what keeps that safe.
const SENTINEL_TOOLTIPS = new Map<string, Array<[string, string]>>([
  [
    "SentinelForm4",
    [
      ["70% Defense Boost", "75% Defense Boost"],
      ["%70 savunma artisi", "%75 savunma artisi"],
    ],
  ],
  [
    "SentinelForm7",
    [
      ["75% Defense Boost", "80% Defense Boost"],
      ["%75 savunma artisi", "%80 savunma artisi"],
    ],
  ],
]);

function cloneStats(): PatchStats {
  return { ...EMPTY_STATS };
}

function mergeStats(...stats: PatchStats[]): PatchStats {
  return stats.reduce(
    (merged, item) => ({
      powerBlocks: merged.powerBlocks + item.powerBlocks,
      buffBlocks: merged.buffBlocks + item.buffBlocks,
      changes: merged.changes + item.changes,
    }),
    cloneStats(),
  );
}

function replaceTag(block: string, tag: string, value: string, stats: PatchStats): string {
  const expected = `<${tag}>${value}</${tag}>`;
  const pattern = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`);
  if (!pattern.test(block)) {
    return block;
  }

  return block.replace(pattern, (match: string) => {
    if (match === expected) {
      return match;
    }
    stats.changes += 1;
    return expected;
  });
}

export function patchPlayerPowers(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const patched = xml.replace(/<Power PowerName="([^"]+)">[\s\S]*?<\/Power>/g, (block: string, powerName: string) => {
    const manaCost = STANCE_MANA_COSTS.get(powerName);
    const damageMult = STANCE_DAMAGE_MULTS.get(powerName);
    if (!manaCost && !damageMult) {
      return block;
    }

    stats.powerBlocks += 1;
    let next = block;
    if (manaCost) {
      next = replaceTag(next, "ManaCost", manaCost, stats);
    }
    if (damageMult) {
      next = replaceTag(next, "BaseDamageMult", damageMult, stats);
    }
    return next;
  });

  return { xml: patched, stats };
}

export function patchPlayerBuffs(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const patched = xml.replace(/<BuffType BuffName="([^"]+)">[\s\S]*?<\/BuffType>/g, (block: string, buffName: string) => {
    const defense = SENTINEL_DEFENSE.get(buffName);
    if (!defense) {
      return block;
    }

    stats.buffBlocks += 1;
    let next = replaceTag(block, "MeleeDefense", defense, stats);
    next = replaceTag(next, "MagicDefense", defense, stats);
    return next;
  });

  return { xml: patched, stats };
}

export function patchSentinelTooltips(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const patched = xml.replace(/<Power PowerName="([^"]+)">[\s\S]*?<\/Power>/g, (block: string, powerName: string) => {
    const tooltips = SENTINEL_TOOLTIPS.get(powerName);
    if (!tooltips) {
      return block;
    }

    let next = block;
    for (const [from, to] of tooltips) {
      if (!next.includes(from)) {
        continue;
      }
      stats.changes += 1;
      next = next.split(from).join(to);
    }
    return next;
  });

  return { xml: patched, stats };
}

function patchPowerXml(xml: string): { xml: string; stats: PatchStats } {
  const powers = patchPlayerPowers(xml);
  const tooltips = patchSentinelTooltips(powers.xml);
  return { xml: tooltips.xml, stats: mergeStats(powers.stats, tooltips.stats) };
}

function patchFile(filePath: string, patcher: (xml: string) => { xml: string; stats: PatchStats }, verifyOnly: boolean): PatchStats {
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
    { marker: "<PlayerPowerTypes", patcher: patchPowerXml },
    { marker: "<PlayerBuffTypes", patcher: patchPlayerBuffs },
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

export function patchConfiguredFormStanceBalance(verifyOnly: boolean): PatchStats {
  const swzPaths = ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter(fs.existsSync);

  return mergeStats(
    patchFile(POWER_XML, patchPowerXml, verifyOnly),
    patchFile(BUFF_XML, patchPlayerBuffs, verifyOnly),
    ...swzPaths.map((swzPath) => patchSwz(swzPath, verifyOnly)),
  );
}

function main(): number {
  const verifyOnly = process.argv.includes("--verify") || process.argv.includes("--dry-run");
  try {
    const stats = patchConfiguredFormStanceBalance(verifyOnly);
    console.log(JSON.stringify({ verifyOnly, stats }, null, 2));
    console.log(stats.changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_gameswz_form_stance_balance] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
