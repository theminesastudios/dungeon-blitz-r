/**
 * ShadowPuppet is East Wing's summon, and it was left behind at Level 29.
 *
 * Every other enemy in the dungeon was raised to 50 (see the east-wing-enemy-level-50 pass), but
 * ShadowPuppet is not in the spawn roster -- Tanja conjures it mid-fight -- so it was missed. The
 * client sizes a hostile it spawns from EntTypes, and East Wing hands out `mBonusLevels +0`, so a
 * level 50 party met a level 29 pool and one hit killed a clone.
 *
 * HitPoints stays at 0.8: against the boss's 3 that is roughly a quarter of its pool, which is the
 * "tougher than trash, nowhere near the boss" the clones are meant to be. Only the level moves.
 *
 * EntTypes lives in Login.swz, NOT Game.swz, and the live copy is the one under p/cbq.
 * `src/server/data/EntTypes.json` has to carry the same value or the two sides size the same enemy
 * differently -- that desync is the whole reason this file exists.
 */
import * as path from "path";
import { defaultLoginSwzPath, ensureBackup, parseSwz, SwzPatchError, writeSwz } from "./swzPatchUtils";

const TARGETS = ["ShadowPuppet", "ShadowPuppetHard"];
const TARGET_LEVEL = "50";

function resolveSwzPath(args: string[]): string {
  const idx = args.indexOf("--swz-path");
  return idx !== -1 && idx + 1 < args.length ? path.resolve(args[idx + 1]) : defaultLoginSwzPath();
}

function patchLevel(xml: string, entName: string): { xml: string; changed: boolean; level: string } {
  const start = xml.indexOf(`<EntType EntName="${entName}"`);
  if (start === -1) {
    throw new SwzPatchError(`${entName} block not found`);
  }
  const end = xml.indexOf("</EntType>", start);
  if (end === -1) {
    throw new SwzPatchError(`${entName} closing tag not found`);
  }

  const block = xml.slice(start, end);
  const match = /<Level>([^<]*)<\/Level>/.exec(block);
  if (!match) {
    throw new SwzPatchError(`${entName} has no Level element`);
  }
  if (match[1].trim() === TARGET_LEVEL) {
    return { xml, changed: false, level: match[1].trim() };
  }

  const patchedBlock = block.replace(match[0], `<Level>${TARGET_LEVEL}</Level>`);
  return { xml: xml.slice(0, start) + patchedBlock + xml.slice(end), changed: true, level: match[1].trim() };
}

function main(): number {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify");
  const swzPath = resolveSwzPath(args);

  try {
    const ctx = parseSwz(swzPath);
    const chunk = ctx.chunks.find((candidate) => candidate.xml.includes(`<EntType EntName="${TARGETS[0]}"`));
    if (!chunk) {
      throw new SwzPatchError(`no chunk carries ${TARGETS[0]}`);
    }

    let xml = chunk.xml;
    let changed = false;
    console.log(`SWZ: ${swzPath}`);
    for (const entName of TARGETS) {
      const result = patchLevel(xml, entName);
      xml = result.xml;
      changed = changed || result.changed;
      console.log(`${entName}: Level ${result.level} -> ${TARGET_LEVEL}${result.changed ? "" : " (already)"}`);
    }

    if (!changed) {
      console.log("No changes needed.");
      return 0;
    }
    if (verifyOnly) {
      console.log("Patch required.");
      return 0;
    }

    ensureBackup(swzPath);
    chunk.xml = xml;
    writeSwz(ctx);
    console.log("Patch apply complete.");
    return 0;
  } catch (error) {
    console.error(`Patch error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

process.exit(main());
