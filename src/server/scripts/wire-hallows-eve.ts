/**
 * Opens the way into the shipped Green Knight arena, and clears out the dungeon
 * this project briefly invented before finding it.
 *
 * `LDArena1` is not a level anything here built. `LevelsLD.swf` has always carried
 * `a_Level_LDArena1` - two catacomb rooms, `am_Boss` bound to `ac_GreenKnight`,
 * three `ac_GreenKnightFalse` decoys, four `ac_TauntingSkull` switches, an
 * `ac_BoneFiend`, tower arms and an `a_Scene_BossRoom` cutscene - and it is already
 * registered on both sides: `level_config.json` lists it at
 * `LevelsLD.swf/a_Level_LDArena1 50 50 true` (the "Dungeon Level: 50" the screen
 * shows), `dungeon_enemy_elements.json` already carries its catalog, and Game.swz
 * already names it **The Green Knight**.
 *
 * Two things were missing, and they are the only reason it was unreachable:
 *
 *   - **`door_map.json` had no row for it.** SwampRoadNorth's door 108, and the
 *     Dread town's copy of it, now lead here. There is deliberately no way back out
 *     through a door: the arena ends the way every mission dungeon does, on
 *     completion, and the player is returned to where they stood.
 *   - **`dungeon_completion_conditions.json` had it as `{"mode":"disabled"}`** - a
 *     level that can never report itself finished, which is what an unreachable
 *     dungeon is set to. It becomes a boss condition on `GreenKnight`, which is
 *     what pays the coffer key.
 *
 * The rest of this script is a *removal*: the `HallowsEve` level, its catalog and
 * its masterFileList row are swept back out, because the dungeon they described was
 * a stand-in for the one that turned out to be sitting in LevelsLD.swf all along.
 *
 * The client's own half - the DoorType - lives in Game.swz and is written by
 * `patch_gameswz_hallows_eve.ts`.
 *
 * Usage: npm exec ts-node scripts/wire-hallows-eve.ts [--verify]
 *
 * Re-runnable: every entry it owns is replaced rather than appended.
 */
import * as fs from "fs";
import * as path from "path";
import { HALLOWS_EVE_DOOR_ID } from "./patch-levelssrn-hallows-eve";

const DATA_DIR = path.resolve(__dirname, "..", "data");
const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content");
const CLIENT_XML_DIR = path.join(CLIENT_CONTENT, "xml");
const SWZ_LIST_DIR = path.join(CLIENT_CONTENT, "localhost", "p", "cbq");

const MASTER_FILE_LISTS = [
  path.join(CLIENT_XML_DIR, "MasterFileList.xml"),
  path.join(SWZ_LIST_DIR, "masterFileList.xml"),
  path.join(SWZ_LIST_DIR, "masterFileList_1.xml"),
  path.join(SWZ_LIST_DIR, "masterFileList_2.xml"),
];

/** The shipped Green Knight arena. */
export const HALLOWS_EVE_LEVEL = "LDArena1";

/** The boss the run ends on. */
export const HALLOWS_EVE_BOSS_ENT = "GreenKnight";

/** The towns whose door 108 leads into it. Both share the room the door is in. */
export const HALLOWS_EVE_ENTRY_LEVELS = ["SwampRoadNorth", "SwampRoadNorthHard"];

/** What this project invented before finding LDArena1, and now sweeps back out. */
const RETIRED_LEVEL = "HallowsEve";
const RETIRED_SWF = "LevelsHW.swf";

function readJson(filePath: string): any {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^﻿/, ""));
}

function writeText(filePath: string, text: string, crlf: boolean, verify: boolean): boolean {
  const next = crlf ? text.replace(/\r?\n/g, "\r\n") : text;
  const changed = fs.readFileSync(filePath, "utf8") !== next;
  if (changed && !verify) fs.writeFileSync(filePath, next);
  return changed;
}

/** Drops the stand-in level. `LDArena1`'s own entry was always there. */
function writeLevelConfig(verify: boolean): boolean {
  const filePath = path.join(DATA_DIR, "level_config.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const config: Record<string, string> = JSON.parse(raw);

  const entries = Object.entries(config).filter(
    ([key, value]) => key !== RETIRED_LEVEL && !String(value).startsWith(`${RETIRED_SWF}/`) && !key.includes("HALLOW'S EVE"),
  );
  if (!entries.some(([key]) => key === HALLOWS_EVE_LEVEL)) {
    throw new Error(`level_config.json has no ${HALLOWS_EVE_LEVEL} - the shipped arena should already be listed`);
  }

  return writeText(filePath, `${JSON.stringify(Object.fromEntries(entries), null, 4)}\n`, raw.includes("\r\n"), verify);
}

function writeDoorMap(verify: boolean): boolean {
  const filePath = path.join(DATA_DIR, "door_map.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const doors: Array<[[string, number], string]> = JSON.parse(raw);

  const kept = doors.filter(
    ([[level, doorId], target]) =>
      target !== HALLOWS_EVE_LEVEL && target !== RETIRED_LEVEL && level !== RETIRED_LEVEL && doorId !== HALLOWS_EVE_DOOR_ID,
  );
  const added: Array<[[string, number], string]> = HALLOWS_EVE_ENTRY_LEVELS.map((level) => [
    [level, HALLOWS_EVE_DOOR_ID],
    HALLOWS_EVE_LEVEL,
  ]);

  const trailing = raw.endsWith("\n") ? "\n" : "";
  const next = JSON.stringify([...kept, ...added]) + trailing;
  const changed = raw !== next;
  if (changed && !verify) fs.writeFileSync(filePath, next);
  return changed;
}

/**
 * Turns the arena's completion back on.
 *
 * It sat at `{"mode":"disabled"}` because nothing could reach it, and a level that
 * cannot report itself finished pays no key. `GreenKnight` is `am_Boss` in
 * `a_Room_LDArena1_02`; there is no `*Hard` variant of the level, so no bossAliases
 * entry is needed - the level is not a Hard one.
 */
function writeCompletionConditions(verify: boolean): boolean {
  const filePath = path.join(DATA_DIR, "dungeon_completion_conditions.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = readJson(filePath) as { schemaVersion: number; levels: Record<string, unknown> };

  delete parsed.levels[RETIRED_LEVEL];
  parsed.levels[HALLOWS_EVE_LEVEL] = {
    mode: "bosses",
    bossGroups: [[HALLOWS_EVE_BOSS_ENT]],
  };

  // Re-emitted one level per line, which is how the file is written by hand.
  const rows = Object.entries(parsed.levels).map(([name, value]) => `    ${JSON.stringify(name)}: ${JSON.stringify(value)}`);
  const text = `{\n  "schemaVersion": ${parsed.schemaVersion},\n  "levels": {\n${rows.join(",\n")}\n  }\n}\n`;
  return writeText(filePath, text, raw.includes("\r\n"), verify);
}

/** Drops the stand-in's catalog. `LDArena1`'s own was always there. */
function writeEnemyElements(verify: boolean): boolean {
  const filePath = path.join(DATA_DIR, "dungeon_enemy_elements.json");
  const raw = fs.readFileSync(filePath, "utf8");
  const manifest = readJson(filePath) as Record<string, unknown>;

  if (!(HALLOWS_EVE_LEVEL in manifest)) {
    throw new Error(`dungeon_enemy_elements.json has no ${HALLOWS_EVE_LEVEL} catalog`);
  }
  delete manifest[RETIRED_LEVEL];

  return writeText(filePath, `${JSON.stringify(manifest, null, 2)}\n`, raw.includes("\r\n"), verify);
}

/** Drops the stand-in's row. `LevelsLD.swf` has always been listed. */
function writeMasterFileLists(verify: boolean): number {
  const ownRow = new RegExp(`^[^\\n]*Name="${RETIRED_SWF.replace(".", "\\.")}"[^\\n]*\\r?\\n`, "gm");

  let written = 0;
  for (const filePath of MASTER_FILE_LISTS) {
    if (!fs.existsSync(filePath)) throw new Error(`${filePath} not found`);
    const raw = fs.readFileSync(filePath, "utf8");
    if (!/Name="LevelsLD\.swf"/.test(raw)) {
      throw new Error(`${filePath} does not list LevelsLD.swf - the arena would never download`);
    }
    // These files mix line endings, so they are edited in place rather than split
    // and rejoined - normalising them would rewrite every untouched row.
    const next = raw.replace(ownRow, "");
    if (next !== raw) {
      if (!verify) fs.writeFileSync(filePath, next);
      written += 1;
    }
  }
  return written;
}

/** The stand-in level file itself. */
function removeRetiredSwf(verify: boolean): boolean {
  const filePath = path.join(CLIENT_CONTENT, "localhost", "p", "cbp", RETIRED_SWF);
  if (!fs.existsSync(filePath)) return false;
  if (!verify) fs.unlinkSync(filePath);
  return true;
}

function main(): void {
  const verify = process.argv.includes("--verify");
  console.log(`level_config.json               ${writeLevelConfig(verify) ? "written" : "already current"}`);
  console.log(`door_map.json                   ${writeDoorMap(verify) ? "written" : "already current"}`);
  console.log(`dungeon_completion_conditions   ${writeCompletionConditions(verify) ? "written" : "already current"}`);
  console.log(`dungeon_enemy_elements          ${writeEnemyElements(verify) ? "written" : "already current"}`);
  console.log(`master file lists               ${writeMasterFileLists(verify)} cleaned of ${RETIRED_SWF}`);
  console.log(`${RETIRED_SWF}                   ${removeRetiredSwf(verify) ? "deleted" : "already gone"}`);
  console.log(
    `${HALLOWS_EVE_LEVEL} (The Green Knight) entered from ` +
      `${HALLOWS_EVE_ENTRY_LEVELS.map((level) => `${level}/${HALLOWS_EVE_DOOR_ID}`).join(", ")}`,
  );
  if (verify) console.log("verify only - nothing written");
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
