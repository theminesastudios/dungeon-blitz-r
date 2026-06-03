import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

const DEATH_MARK_POWER_RE = /^DeathMark(?:\d+)?$/;
const MINION_VULNERABILITY_BUFF = "DeathMarkUndeadVulnerability";
const MINION_VULNERABILITY_BUFF_ID = "737";

type DeathMarkPatchStats = {
  powerBlocks: number;
  targetBuffsUpdated: number;
  descriptionsUpdated: number;
  buffAdded: number;
};

function defaultPowerXmlPath(): string {
  return path.resolve(__dirname, "..", "..", "client", "content", "xml", "PlayerPowerTypes.xml");
}

function defaultBuffXmlPath(): string {
  return path.resolve(__dirname, "..", "..", "client", "content", "xml", "PlayerBuffTypes.xml");
}

function defaultGameSwzPath(): string {
  return path.resolve(
    __dirname,
    "..",
    "..",
    "client",
    "content",
    "localhost",
    "p",
    "cbq",
    "Game.swz",
  );
}

function resolveArgPath(args: string[], flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  if (idx !== -1 && idx + 1 < args.length) {
    return path.resolve(args[idx + 1]);
  }
  return fallback;
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function buildMinionVulnerabilityBuff(lineEnding = "\n"): string {
  return [
    `\t<BuffType BuffName="${MINION_VULNERABILITY_BUFF}">`,
    `\t\t<BuffID>${MINION_VULNERABILITY_BUFF_ID}</BuffID>`,
    "\t\t<Attack>true</Attack>",
    "\t\t<Duration>500</Duration>",
    "\t\t<MagicDefense>-0.2</MagicDefense>",
    "\t\t<MeleeDefense>-0.2</MeleeDefense>",
    "\t\t<KingdomOnly>Undead</KingdomOnly>",
    "\t\t<BuffLoc>Head</BuffLoc>",
    "\t\t<BuffIcon>a_StatusIcon_DefenseDown</BuffIcon>",
    "\t\t<GfxType>",
    "\t\t\t<AnimScale>0.5</AnimScale>",
    "\t\t\t<AnimFile>SFX_1.swf</AnimFile>",
    "\t\t\t<AnimClass>a_Debuff_Armor</AnimClass>",
    "\t\t</GfxType>",
    "\t</BuffType>",
  ].join(lineEnding);
}

function patchAddTargetBuff(value: string): { value: string; changed: boolean } {
  const buffs = value.split(",");
  let changed = false;

  for (const buffName of ["PoisonCloud", MINION_VULNERABILITY_BUFF]) {
    if (!buffs.includes(buffName)) {
      buffs.push(buffName);
      changed = true;
    }
  }

  return {
    value: buffs.join(","),
    changed,
  };
}

function patchDeathMarkDescription(description: string): { description: string; changed: boolean } {
  if (description.includes("Undead minions")) {
    return {
      description,
      changed: false,
    };
  }

  const patched = description
    .replace(" and have reduced Attack and Defense.", ", are Poisoned, take more damage from Undead minions, and have reduced Attack and Defense.")
    .replace(" and have reduced Attack.", ", are Poisoned, take more damage from Undead minions, and have reduced Attack.");

  return {
    description: patched,
    changed: patched !== description,
  };
}

export function patchDeathMarkPowers(xml: string): { xml: string; stats: DeathMarkPatchStats } {
  const stats: DeathMarkPatchStats = {
    powerBlocks: 0,
    targetBuffsUpdated: 0,
    descriptionsUpdated: 0,
    buffAdded: 0,
  };

  const patchedXml = xml.replace(
    /<Power PowerName="([^"]+)">[\s\S]*?<\/Power>/g,
    (powerBlock: string, powerName: string) => {
      if (!DEATH_MARK_POWER_RE.test(powerName)) {
        return powerBlock;
      }

      stats.powerBlocks += 1;
      let patchedBlock = powerBlock.replace(/<AddTargetBuff>([^<]+)<\/AddTargetBuff>/, (match, buffList) => {
        const patched = patchAddTargetBuff(buffList);
        if (patched.changed) {
          stats.targetBuffsUpdated += 1;
        }
        return `<AddTargetBuff>${patched.value}</AddTargetBuff>`;
      });

      patchedBlock = patchedBlock.replace(/<Description>([^<]+)<\/Description>/, (match, description) => {
        const patched = patchDeathMarkDescription(description);
        if (patched.changed) {
          stats.descriptionsUpdated += 1;
        }
        return `<Description>${patched.description}</Description>`;
      });

      return patchedBlock;
    },
  );

  return {
    xml: patchedXml,
    stats,
  };
}

export function patchDeathMarkBuffs(xml: string): { xml: string; stats: DeathMarkPatchStats } {
  const stats: DeathMarkPatchStats = {
    powerBlocks: 0,
    targetBuffsUpdated: 0,
    descriptionsUpdated: 0,
    buffAdded: 0,
  };

  if (xml.includes(`BuffName="${MINION_VULNERABILITY_BUFF}"`)) {
    const patchedXml = xml.replace(
      new RegExp(`(<BuffType BuffName="${MINION_VULNERABILITY_BUFF}">\\s*<BuffID>)(\\d+)(</BuffID>)`),
      (match, prefix, buffId, suffix) => {
        if (buffId === MINION_VULNERABILITY_BUFF_ID) {
          return match;
        }
        stats.buffAdded = 1;
        return `${prefix}${MINION_VULNERABILITY_BUFF_ID}${suffix}`;
      },
    );
    return { xml: patchedXml, stats };
  }

  const lineEnding = xml.includes("\r\n") ? "\r\n" : "\n";
  const anchor = /(\r?\n\t<BuffType BuffName="PlagueBattalion">)/;
  const patchedXml = xml.replace(anchor, `${lineEnding}${buildMinionVulnerabilityBuff(lineEnding)}$1`);
  if (patchedXml === xml) {
    throw new SwzPatchError("Could not find PlayerBuffTypes insertion point");
  }

  stats.buffAdded = 1;
  return {
    xml: patchedXml,
    stats,
  };
}

export function hasDeathMarkPoisonMinions(powerXml: string, buffXml: string): boolean {
  if (!buffXml.includes(`BuffName="${MINION_VULNERABILITY_BUFF}"`)) {
    return false;
  }

  let checkedBlocks = 0;
  let allBlocksPatched = true;
  powerXml.replace(/<Power PowerName="([^"]+)">[\s\S]*?<\/Power>/g, (powerBlock: string, powerName: string) => {
    if (!DEATH_MARK_POWER_RE.test(powerName)) {
      return powerBlock;
    }

    checkedBlocks += 1;
    if (
      !powerBlock.includes("PoisonCloud") ||
      !powerBlock.includes(MINION_VULNERABILITY_BUFF)
    ) {
      allBlocksPatched = false;
    }

    return powerBlock;
  });

  return checkedBlocks === 11 && allBlocksPatched;
}

function mergeStats(...items: DeathMarkPatchStats[]): DeathMarkPatchStats {
  return items.reduce(
    (merged, item) => ({
      powerBlocks: merged.powerBlocks + item.powerBlocks,
      targetBuffsUpdated: merged.targetBuffsUpdated + item.targetBuffsUpdated,
      descriptionsUpdated: merged.descriptionsUpdated + item.descriptionsUpdated,
      buffAdded: merged.buffAdded + item.buffAdded,
    }),
    { powerBlocks: 0, targetBuffsUpdated: 0, descriptionsUpdated: 0, buffAdded: 0 },
  );
}

function logStats(label: string, stats: DeathMarkPatchStats): void {
  console.log(
    [
      `${label}: Death Mark powers: ${stats.powerBlocks}`,
      `target buffs updated: ${stats.targetBuffsUpdated}`,
      `descriptions updated: ${stats.descriptionsUpdated}`,
      `buffs added: ${stats.buffAdded}`,
    ].join(", "),
  );
}

function patchSourceXml(powerXmlPath: string, buffXmlPath: string, verifyOnly: boolean): DeathMarkPatchStats {
  const powerOriginal = fs.readFileSync(powerXmlPath, "utf8");
  const buffOriginal = fs.readFileSync(buffXmlPath, "utf8");
  const powerPatched = patchDeathMarkPowers(powerOriginal);
  const buffPatched = patchDeathMarkBuffs(buffOriginal);
  const stats = mergeStats(powerPatched.stats, buffPatched.stats);
  logStats("XML", stats);

  if (!hasDeathMarkPoisonMinions(powerPatched.xml, buffPatched.xml)) {
    throw new SwzPatchError("Source XML verification failed");
  }

  if (!verifyOnly) {
    if (powerPatched.xml !== powerOriginal) {
      fs.writeFileSync(powerXmlPath, powerPatched.xml, "utf8");
    }
    if (buffPatched.xml !== buffOriginal) {
      fs.writeFileSync(buffXmlPath, buffPatched.xml, "utf8");
    }
  }

  return stats;
}

function patchGameSwz(swzPath: string, verifyOnly: boolean): DeathMarkPatchStats {
  const ctx = parseSwz(swzPath);
  const powerChunk = ctx.chunks.find((entry) => entry.xml.includes("<PlayerPowerTypes"));
  if (!powerChunk) {
    throw new SwzPatchError("PlayerPowerTypes chunk not found in Game.swz");
  }
  const buffChunk = ctx.chunks.find((entry) => entry.xml.includes("<PlayerBuffTypes"));
  if (!buffChunk) {
    throw new SwzPatchError("PlayerBuffTypes chunk not found in Game.swz");
  }

  const powerOriginal = powerChunk.xml;
  const buffOriginal = buffChunk.xml;
  const powerPatched = patchDeathMarkPowers(powerOriginal);
  const buffPatched = patchDeathMarkBuffs(buffOriginal);
  const stats = mergeStats(powerPatched.stats, buffPatched.stats);
  logStats("SWZ", stats);

  if (!hasDeathMarkPoisonMinions(powerPatched.xml, buffPatched.xml)) {
    throw new SwzPatchError("Game.swz verification failed");
  }

  if (!verifyOnly && (powerPatched.xml !== powerOriginal || buffPatched.xml !== buffOriginal)) {
    ensureBackup(swzPath);
    powerChunk.xml = powerPatched.xml;
    buffChunk.xml = buffPatched.xml;
    writeSwz(ctx);
  }

  return stats;
}

function main(): number {
  const args = process.argv.slice(2);
  const verifyOnly = hasFlag(args, "--verify") || hasFlag(args, "--dry-run");
  const powerXmlPath = resolveArgPath(args, "--power-xml-path", defaultPowerXmlPath());
  const buffXmlPath = resolveArgPath(args, "--buff-xml-path", defaultBuffXmlPath());
  const swzPath = resolveArgPath(args, "--swz-path", defaultGameSwzPath());

  try {
    const xmlStats = patchSourceXml(powerXmlPath, buffXmlPath, verifyOnly);
    const swzStats = patchGameSwz(swzPath, verifyOnly);
    const totalChanges = mergeStats(xmlStats, swzStats);
    const changed =
      totalChanges.targetBuffsUpdated + totalChanges.descriptionsUpdated + totalChanges.buffAdded;

    if (changed === 0) {
      console.log("No changes needed.");
    } else if (verifyOnly) {
      console.log("Patch required.");
    } else {
      console.log("Patch apply complete.");
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Patch error: ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
