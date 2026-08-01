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
 * Not covered here: pet ability *cooldown* does not exist in the power data at all --
 * every Pet* power in PlayerPowerTypes.xml has <CoolDownTime>0</CoolDownTime>, so the
 * several-minute wait between activations is paced by the pet brain inside the client SWF.
 * Making it scale with pet level needs that code, not this file.
 */

type PatchStats = {
  buffBlocks: number;
  changes: number;
};

const EMPTY_STATS: PatchStats = { buffBlocks: 0, changes: 0 };

const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
const BUFF_XML = path.join(XML_DIR, "PlayerBuffTypes.xml");

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

function patchFile(filePath: string, verifyOnly: boolean): PatchStats {
  const original = fs.readFileSync(filePath, "utf8");
  const patched = patchPetBuffs(original);
  if (!verifyOnly && patched.xml !== original) {
    fs.writeFileSync(filePath, patched.xml, "utf8");
  }
  return patched.stats;
}

function patchSwz(swzPath: string, verifyOnly: boolean): PatchStats {
  const ctx = parseSwz(swzPath);
  const chunk = ctx.chunks.find((entry) => entry.xml.includes("<PlayerBuffTypes"));
  if (!chunk) {
    return cloneStats();
  }

  const patched = patchPetBuffs(chunk.xml);
  if (!verifyOnly && patched.xml !== chunk.xml) {
    chunk.xml = patched.xml;
    ensureBackup(swzPath);
    writeSwz(ctx);
  }

  return patched.stats;
}

export function patchConfiguredPetAbilityBalance(verifyOnly: boolean): PatchStats {
  const swzPaths = ["Game.swz", "Game.en.swz", "Game.tr.swz"]
    .map((fileName) => path.join(CBQ_DIR, fileName))
    .filter(fs.existsSync);

  return mergeStats(
    patchFile(BUFF_XML, verifyOnly),
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
