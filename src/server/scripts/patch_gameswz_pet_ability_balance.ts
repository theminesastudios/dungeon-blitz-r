import * as fs from "fs";
import * as path from "path";
import { ensureBackup, parseSwz, writeSwz } from "./swzPatchUtils";

/**
 * Pet abilities landed as an afterthought: a sprite that burns for a couple of points a
 * second next to a player hitting for thousands, and buffs that expire before the pet can
 * use them again. This scales the payload up and holds it on the target longer.
 *
 *   damage-over-time     x2      the burn/poison/bleed ticks were the worst offender
 *   buff/debuff strength +5pp    haste, defense, enfeeble
 *   duration             x1.5    every timed effect except the two instant ones
 *
 * PetAngelDefense and PetPhoenixCleanse keep their 1000ms window on purpose. Those are not
 * durations -- they are one-tick effects whose DoTDamage field carries a heal, so stretching
 * the window would multiply the heal instead of extending a buff.
 *
 * Values are absolute, not multipliers applied to what is in the file. This runs on every
 * prebuild, and a multiplier would scale an already-scaled number on the second pass.
 *
 * The summon itself is retuned too. SummonPet (PowerID 1674) authored a 180000ms cooldown
 * against a 180000ms SpawnDuration, so the pet expired at the exact moment it could be
 * re-summoned -- the whole three minutes read as downtime, and a pet that died mid-fight
 * stayed dead for the rest of it. Uptime goes up and the wait after a death comes down.
 *
 * What this cannot do is make that cooldown scale with pet level. The cast path reads one
 * number off the PowerType and adds a PowerMod looked up by power name (CombatState:1843),
 * and PowerMods come from talents, not from the equipped pet -- there is no data path from
 * pet level to cooldown. Scaling needs a trampoline into that shared cast path, which is
 * the code every power in the game runs through, so it belongs in its own change.
 */

type PatchStats = {
  buffBlocks: number;
  changes: number;
};

const EMPTY_STATS: PatchStats = { buffBlocks: 0, changes: 0 };

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
const BUFF_XML = path.join(XML_DIR, "PlayerBuffTypes.xml");
const POWER_XML = path.join(XML_DIR, "PlayerPowerTypes.xml");

// The summon power itself, not a buff. Comments are the authored value.
const SUMMON_PET_TUNING = new Map<string, Record<string, string>>([
  ["SummonPet", { CoolDownTime: "90000", SpawnDuration: "600000" }], // 180000, 180000
]);

type PetBuffTuning = {
  Duration?: string;
  DoTDamage?: string;
  MeleeDamage?: string;
  MagicDamage?: string;
  MeleeDefense?: string;
  MagicDefense?: string;
};

// Comments are the authored value.
const PET_BUFFS = new Map<string, PetBuffTuning>([
  ["PetGhostRoot", { Duration: "14625" }], //                                    9750
  ["PetGhoulEnfeeble", { Duration: "15000", MeleeDamage: "-0.3", MagicDamage: "-0.3" }], // 10000, -0.24
  ["PetFairyBlind", { Duration: "14580" }], //                                   9720
  ["PetCrowBlind", { Duration: "7500", DoTDamage: "10.8", MeleeDamage: "-0.3", MagicDamage: "-0.3" }], // 5000, 5.4, -0.25
  ["PetMonkeyHaste", { Duration: "15000", MeleeDamage: "0.15", MagicDamage: "0.15" }], // 10000, 0.1
  ["PetAngelDefense", { MeleeDefense: "0.35", MagicDefense: "0.35" }], //         0.3, duration held
  ["PetOwlDefense", { Duration: "18750", MeleeDefense: "0.3", MagicDefense: "0.3" }], // 12500, 0.25
  ["PetDragonBonePoison", { Duration: "12000", DoTDamage: "12" }], //             8000, 6
  ["PetSpriteBurn", { Duration: "7500", DoTDamage: "3.2" }], //                   5000, 1.6
]);

function cloneStats(): PatchStats {
  return { ...EMPTY_STATS };
}

function mergeStats(...stats: PatchStats[]): PatchStats {
  return stats.reduce(
    (merged, item) => ({
      buffBlocks: merged.buffBlocks + item.buffBlocks,
      changes: merged.changes + item.changes,
    }),
    cloneStats(),
  );
}

function replaceTag(block: string, tag: string, value: string, stats: PatchStats): string {
  const pattern = new RegExp(`<${tag}>[\\s\\S]*?</${tag}>`);
  if (!pattern.test(block)) {
    // Never invent a field a buff does not author -- a MeleeDefense on a buff that has
    // none would be a new effect, not a tuning change.
    return block;
  }

  const expected = `<${tag}>${value}</${tag}>`;
  return block.replace(pattern, (match: string) => {
    if (match === expected) {
      return match;
    }
    stats.changes += 1;
    return expected;
  });
}

export function patchSummonPower(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const patched = xml.replace(/<Power PowerName="([^"]+)">[\s\S]*?<\/Power>/g, (block: string, powerName: string) => {
    const tuning = SUMMON_PET_TUNING.get(powerName);
    if (!tuning) {
      return block;
    }

    stats.buffBlocks += 1;
    let next = block;
    for (const [tag, value] of Object.entries(tuning)) {
      next = replaceTag(next, tag, value, stats);
    }
    return next;
  });

  return { xml: patched, stats };
}

export function patchPetBuffs(xml: string): { xml: string; stats: PatchStats } {
  const stats = cloneStats();
  const patched = xml.replace(/<BuffType BuffName="([^"]+)">[\s\S]*?<\/BuffType>/g, (block: string, buffName: string) => {
    const tuning = PET_BUFFS.get(buffName);
    if (!tuning) {
      return block;
    }

    stats.buffBlocks += 1;
    let next = block;
    for (const [tag, value] of Object.entries(tuning)) {
      next = replaceTag(next, tag, String(value), stats);
    }
    return next;
  });

  return { xml: patched, stats };
}

function patchFile(
  filePath: string,
  patcher: (xml: string) => { xml: string; stats: PatchStats },
  verifyOnly: boolean,
): PatchStats {
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
    { marker: "<PlayerBuffTypes", patcher: patchPetBuffs },
    { marker: "<PlayerPowerTypes", patcher: patchSummonPower },
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

export function patchConfiguredPetAbilityBalance(verifyOnly: boolean): PatchStats {
  const swzPaths = ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter(fs.existsSync);

  return mergeStats(
    patchFile(BUFF_XML, patchPetBuffs, verifyOnly),
    patchFile(POWER_XML, patchSummonPower, verifyOnly),
    ...swzPaths.map((swzPath) => patchSwz(swzPath, verifyOnly)),
  );
}

function main(): number {
  const verifyOnly = process.argv.includes("--verify") || process.argv.includes("--dry-run");
  try {
    const stats = patchConfiguredPetAbilityBalance(verifyOnly);
    console.log(JSON.stringify({ verifyOnly, stats }, null, 2));
    console.log(stats.changes === 0 ? "No changes needed." : verifyOnly ? "Patch required." : "Patch apply complete.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch_gameswz_pet_ability_balance] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
