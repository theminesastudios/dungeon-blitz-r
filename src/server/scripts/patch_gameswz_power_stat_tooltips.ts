import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

/**
 * Ability tooltips describe what a power does without ever saying how much: "deals extra
 * damage to Ignited enemies", "Gain increased Defense", "boosts your damage". 242 authored
 * descriptions are written that way and only 21 of them carry a number.
 *
 * The numbers do exist -- they are just in fields the tooltip never reads. A power's own
 * <BaseDamageMult> is its damage multiplier, and whatever it lists in <AddSelfBuff> or
 * <AddTargetBuff> resolves to a PlayerBuffTypes block holding the percentages and the
 * duration. This appends a generated summary built from exactly those fields.
 *
 * Appended, not rewritten. The authored prose says what the power is for and is worth
 * keeping; re-wording 1693 descriptions by machine would lose that and read worse. The
 * summary is fenced in a "[Stats: ...]" marker, which is also what makes this idempotent:
 * any previous marker is stripped before a new one is built, so re-running on every
 * prebuild converges instead of stacking.
 *
 * Only fields with a player-facing meaning are rendered. AggroChange, BuffLoc, EntTint and
 * the GFX fields are deliberately skipped -- a hate multiplier in a damage tooltip is
 * noise, not information.
 */

type PatchStats = {
  powerBlocks: number;
  changes: number;
};

const EMPTY_STATS: PatchStats = { powerBlocks: 0, changes: 0 };

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
const POWER_XML = path.join(XML_DIR, "PlayerPowerTypes.xml");
const BUFF_XML = path.join(XML_DIR, "PlayerBuffTypes.xml");

const STATS_MARKER = /\s*\[Stats:[^\]]*\]\s*$/;

type BuffFields = Record<string, string>;

function cloneStats(): PatchStats {
  return { ...EMPTY_STATS };
}

function readTag(block: string, tag: string): string {
  return (block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1] ?? "").trim();
}

export function parseBuffTable(buffXml: string): Map<string, BuffFields> {
  const table = new Map<string, BuffFields>();
  for (const block of buffXml.match(/<BuffType BuffName="[^"]*">[\s\S]*?<\/BuffType>/g) ?? []) {
    const name = block.match(/<BuffType BuffName="([^"]*)">/)?.[1] ?? "";
    if (!name) {
      continue;
    }

    const fields: BuffFields = {};
    for (const field of block.match(/<([A-Za-z]+)>([^<]*)<\/\1>/g) ?? []) {
      const tag = field.match(/^<([A-Za-z]+)>/)?.[1] ?? "";
      if (tag) {
        fields[tag] = readTag(field, tag);
      }
    }
    table.set(name, fields);
  }

  return table;
}

/** "0.3" -> "+30%", "-0.24" -> "-24%". Authored as fractions throughout. */
function percent(value: string): string | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric === 0) {
    return null;
  }

  const rendered = Math.round(Math.abs(numeric) * 1000) / 10;
  return `${numeric > 0 ? "+" : "-"}${rendered}%`;
}

function seconds(value: string): string | null {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return `${Math.round(numeric / 100) / 10}s`;
}

/**
 * A buff authors Melee and Magic separately but almost always sets them to the same
 * number, and "+30% Melee Damage, +30% Magic Damage" is worse to read than "+30% Damage".
 */
function pairedStat(fields: BuffFields, meleeTag: string, magicTag: string, label: string): string[] {
  const melee = percent(fields[meleeTag] ?? "");
  const magic = percent(fields[magicTag] ?? "");
  if (melee && magic && melee === magic) {
    return [`${melee} ${label}`];
  }

  const parts: string[] = [];
  if (melee) {
    parts.push(`${melee} Melee ${label}`);
  }
  if (magic) {
    parts.push(`${magic} Magic ${label}`);
  }
  return parts;
}

export function describeBuff(fields: BuffFields): string[] {
  const parts: string[] = [];
  parts.push(...pairedStat(fields, "MeleeDamage", "MagicDamage", "Damage"));
  parts.push(...pairedStat(fields, "MeleeDefense", "MagicDefense", "Defense"));

  const speed = percent(fields.SpeedChange ?? "");
  if (speed) {
    parts.push(`${speed} Speed`);
  }

  // DoTDamage is per tick, and a tick is DoTTickLength ms. Per second is what a player can
  // actually compare against anything else. Negative is a heal, which is how the authored
  // regeneration buffs are written.
  const dot = Number(fields.DoTDamage ?? NaN);
  const tickMs = Number(fields.DoTTickLength ?? NaN);
  if (Number.isFinite(dot) && dot !== 0 && Number.isFinite(tickMs) && tickMs > 0) {
    const perSecond = Math.round(Math.abs(dot) * (1000 / tickMs) * 10) / 10;
    parts.push(`${perSecond}${dot < 0 ? " heal" : " damage"}/s`);
  }

  const duration = seconds(fields.Duration ?? "");
  if (duration && parts.length > 0) {
    parts.push(`over ${duration}`);
  }

  return parts;
}

export function buildStatsSuffix(block: string, buffs: Map<string, BuffFields>): string {
  const parts: string[] = [];
  const isChaosWave = readTag(block, "PowerGroup") === "ChaosArmor"
    || readTag(block, "BasePowerName") === "ChaosArmor";

  // A power's damage multiplier. 0 means the power deals none of its own -- a stance or a
  // pure buff -- and printing "x0 damage" on those would be actively misleading.
  const damageMult = Number(readTag(block, "BaseDamageMult"));
  if (Number.isFinite(damageMult) && damageMult > 0) {
    parts.push(`x${Math.round(damageMult * 100) / 100} damage`);
  }

  const buffNames = [readTag(block, "AddSelfBuff"), readTag(block, "AddTargetBuff")]
    .join(",")
    .split(",")
    .map((name) => name.trim().replace(/^Last:/, ""))
    .filter(Boolean);

  const seen = new Set<string>();
  for (const buffName of buffNames) {
    if (seen.has(buffName)) {
      continue;
    }
    seen.add(buffName);

    // Chaos Wave's authored self-buffs use MagicDamage fields, but the ability does not
    // grant the player an Expertise bonus. Do not turn those carrier values into a tooltip
    // promise; target debuffs and the power's own damage remain visible below.
    if (isChaosWave && /^ChaosArmor(?:5|10|15|30)$/.test(buffName)) {
      continue;
    }

    const fields = buffs.get(buffName);
    if (fields) {
      parts.push(...describeBuff(fields));
    }
  }

  return parts.length > 0 ? ` [Stats: ${parts.join(", ")}]` : "";
}

export function patchPowerDescriptions(powerXml: string, buffs: Map<string, BuffFields>): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const patched = powerXml.replace(/<Power PowerName="[^"]*">[\s\S]*?<\/Power>/g, (block: string) => {
    const descriptionMatch = block.match(/<Description>([^<]*)<\/Description>/);
    if (!descriptionMatch) {
      return block;
    }

    // Strip first: the previous run's suffix must not feed the next one.
    const authored = descriptionMatch[1].replace(STATS_MARKER, "").trimEnd();
    if (!authored) {
      return block;
    }

    stats.powerBlocks += 1;
    const next = `<Description>${authored}${buildStatsSuffix(block, buffs)}</Description>`;
    if (next === descriptionMatch[0]) {
      const isChaosWave = readTag(block, "PowerGroup") === "ChaosArmor"
        || readTag(block, "BasePowerName") === "ChaosArmor";
      if (isChaosWave && block.includes(`${descriptionMatch[0]}\r\n`)) {
        stats.changes += 1;
        return block.replace(`${descriptionMatch[0]}\r\n`, `${next}\n`);
      }
      return block;
    }

    stats.changes += 1;
    return block.includes(`${descriptionMatch[0]}\r\n`)
      ? block.replace(`${descriptionMatch[0]}\r\n`, `${next}\n`)
      : block.replace(descriptionMatch[0], next);
  });

  return { xml: patched, stats };
}

function patchXmlFiles(verifyOnly: boolean): PatchStats {
  const buffs = parseBuffTable(fs.readFileSync(BUFF_XML, "utf8"));
  const original = fs.readFileSync(POWER_XML, "utf8");
  const patched = patchPowerDescriptions(original, buffs);
  if (!verifyOnly && patched.xml !== original) {
    fs.writeFileSync(POWER_XML, patched.xml, "utf8");
  }
  return patched.stats;
}

function patchSwz(swzPath: string, verifyOnly: boolean): PatchStats {
  const ctx = parseSwz(swzPath);
  const powerChunk = ctx.chunks.find((entry) => entry.xml.includes("<PlayerPowerTypes"));
  const buffChunk = ctx.chunks.find((entry) => entry.xml.includes("<PlayerBuffTypes"));
  if (!powerChunk || !buffChunk) {
    return cloneStats();
  }

  const patched = patchPowerDescriptions(powerChunk.xml, parseBuffTable(buffChunk.xml));
  if (!verifyOnly && patched.xml !== powerChunk.xml) {
    powerChunk.xml = patched.xml;
    ensureBackup(swzPath);
    writeSwz(ctx);
  }

  return patched.stats;
}

export function patchConfiguredPowerStatTooltips(verifyOnly: boolean): PatchStats {
  const swzPaths = ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter(fs.existsSync);

  const collected = [patchXmlFiles(verifyOnly), ...swzPaths.map((swzPath) => patchSwz(swzPath, verifyOnly))];
  return collected.reduce(
    (merged, item) => ({
      powerBlocks: merged.powerBlocks + item.powerBlocks,
      changes: merged.changes + item.changes,
    }),
    cloneStats(),
  );
}

function main(): number {
  const verifyOnly = process.argv.includes("--verify") || process.argv.includes("--dry-run");
  try {
    const stats = patchConfiguredPowerStatTooltips(verifyOnly);
    console.log(JSON.stringify({ verifyOnly, stats }, null, 2));
    console.log(stats.changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_gameswz_power_stat_tooltips] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
