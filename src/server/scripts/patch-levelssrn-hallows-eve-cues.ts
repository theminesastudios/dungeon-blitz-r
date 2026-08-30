/**
 * Gives the square's two props a cue, which is the only thing that makes them
 * clickable.
 *
 * ## The bug this fixes
 *
 * `Game.method_668` - the interact handler - does **not** branch on the entity's
 * name, and it does not branch on the `characterName` the server puts in the
 * entity packet either. It branches on `entity.cue.characterName`, and the cue is
 * resolved on the client:
 *
 *     // LinkUpdater, on an entity update
 *     ent.cue = game.level.var_1046[<the characterName string from the packet>];
 *
 * `Level.var_1046` is a dictionary built by walking the *level's own* `a_Cue`
 * objects and keying each one by its authored `characterName` (`Level.as:4940`,
 * which even logs "contact needs a unique character name" on a collision). So a
 * name that no cue in the room carries resolves to `undefined`, `entity.cue` is
 * null, and `method_668` returns before it reaches a single arm of the chain.
 *
 * That is exactly what the challenge marker and the coffers were: entities whose
 * `characterName` was `Special_ClassTower` / `Special_TreasureTrove`, in a room
 * whose cue list is
 *
 *     Ield, SRN_Mayor01..03, SRN_Merchant01,
 *     Special_Halloween_Statue_First..Fourth
 *
 * Neither string was in it. Clicking them did nothing at all - no bubble, no
 * screen, no packet - and no amount of work on the *screens* could have shown up,
 * because the click never got as far as choosing one.
 *
 * ## The fix
 *
 * Two of the four leaderboard-statue cues are renamed in `LevelsSRN.swf`'s
 * constant pool. They are the right donors and not a compromise:
 *
 *   - The pedestals they belong to were already dropped by
 *     `patch-levelssrn-hallows-eve.ts`, so nothing is drawn on them any more.
 *   - `displayName` is `"Hidden"`, so neither prop grows a name plate off the cue
 *     - the wart that made the Herald show up as "Ield".
 *   - `sayOnInteract` is `"Nothing"`, so the cue contributes no speech bubble of
 *     its own.
 *   - Each string occurs exactly once in the pool, so the rename cannot touch
 *     anything else.
 *
 * The cue's *placement* does not matter: an entity keeps the position the server
 * sent it at, and the only code that moves it onto its cue (`Entity.method_1656`)
 * fires only when the body falls out of the bottom of the level, which a Flying,
 * SLEEP prop never does.
 *
 * The `Special_Halloween_Statue_*` arms of `method_668` become unreachable in this
 * room, which is the point: they ran the leaderboard skit for statues that are no
 * longer there.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-cues.ts [--verify]
 *
 * Re-runnable: checks for its own result first.
 */
import * as path from "path";
import {
  SwfLevelError,
  ensureBackup,
  readAbcStrings,
  readSwfFile,
  renameAbcStrings,
  writeSwfFile,
} from "./swfLevelUtils";

const LEVEL_SWF = path.resolve(
  __dirname,
  "..",
  "..",
  "client",
  "content",
  "localhost",
  "p",
  "cbp",
  "LevelsSRN.swf",
);

/**
 * Donor cue -> the cue name the prop standing on it needs.
 *
 * `Special_ClassTower` is the challenge marker on the arch; the repointed
 * `class_69` opens `a_ScreenHalloweenDungeonPrompt` behind it. `Special_TreasureTrove`
 * is the skull grid; it opens `screenLockBox`. Both names are read out of
 * `core/HallowsEve.ts`, where the entities that carry them are built.
 */
const CUE_RENAMES = new Map<string, string>([
  ["Special_Halloween_Statue_First", "Special_ClassTower"],
  ["Special_Halloween_Statue_Second", "Special_TreasureTrove"],

  /**
   * The other two statue hotspots, silenced.
   *
   * `Game.method_668` has an arm for each `Special_Halloween_Statue_*` that runs a
   * skit off `class_14.var_661[n]` - the leaderboard champions' lines. There are no
   * champions on this server and no data behind that index, so the skit plays as an
   * empty speech bubble: the "..." that appears on the ruin two or three times over.
   *
   * Renaming them to something the chain has no arm for stops the skit. The click
   * then falls through to `PKTTYPE_TALK_TO_NPC`, and the server has no NPC at that
   * id, so nothing is said at all.
   *
   * **This does not remove the interact cursor.** The hotspot is still an entity with
   * a bound cue, and `Entity.method_355` asks only for a neutral team and a cue - so
   * it stays clickable, silently. Hiding the icon means making one cue non-neutral in
   * the room's own `__setProp`, which is a per-placement edit rather than the
   * constant-pool rename this file does.
   */
  /**
   * This one is renamed to `friend` on purpose, and the name is doing double duty.
   *
   * `Room.as` turns a cue's `team` string into a team id by comparing it against
   * exactly three words - `friend` -> GOODGUY, `enemy` -> BADGUY, `neutral` ->
   * NEUTRAL - and anything else falls through to 0, which the client draws as a
   * hostile: a red health bar over each hotspot. `patch-levelssrn-hallows-eve-mute-hotspots.ts`
   * needs a non-neutral team that is *not* hostile, and `friend` is the only one -
   * but it is not in this level's string pool and a pool cannot be grown without
   * moving every index after it.
   *
   * So the word arrives as a rename. This cue's name is otherwise meaningless (it
   * matches no arm of the interact chain, which is the point), and the string it now
   * holds is what the four team operands are repointed at.
   */
  ["Special_Halloween_Statue_Third", "friend"],
  ["Special_Halloween_Statue_Fourth", "SRN_HallowsEveMute02"],
]);

function main(): void {
  const verify = process.argv.includes("--verify");
  /**
   * `--revert` puts the statue cue names back.
   *
   * The square regressed after this patch went in - the Herald, who had answered
   * clicks for weeks on a cue this script never touches, stopped answering and lost
   * his name plate. `Level.method_1130` walks a room's cues and validates them, and
   * on at least one failure it breaks out of the walk rather than skipping the one
   * cue; its logger (`class_24.method_19`) is an empty function in this release
   * build, so a rejected cue is completely silent. Backing the rename out is the
   * only way to test whether it is what broke the walk.
   */
  const revert = process.argv.includes("--revert");
  const swf = readSwfFile(LEVEL_SWF);
  const strings = new Set(readAbcStrings(swf));

  const pairs = revert
    ? [...CUE_RENAMES].map(([from, to]) => [to, from] as [string, string])
    : [...CUE_RENAMES];

  const todo = new Map<string, string>();
  for (const [from, to] of pairs) {
    if (strings.has(to)) {
      console.log(`${to} is already a cue in this level.`);
      continue;
    }
    if (!strings.has(from)) {
      throw new SwfLevelError(`LevelsSRN.swf has no ${from} to rename, and no ${to} either`);
    }
    todo.set(from, to);
  }

  if (todo.size === 0) {
    console.log("nothing to do - both props already have a cue.");
    return;
  }
  for (const [from, to] of todo) console.log(`${from} -> ${to}`);
  if (verify) {
    console.log("verify only - nothing written.");
    return;
  }

  const renamed = renameAbcStrings(swf, todo);
  if (renamed !== todo.size) {
    throw new SwfLevelError(`expected ${todo.size} constant-pool entries to change, ${renamed} did`);
  }

  ensureBackup(LEVEL_SWF);
  writeSwfFile(LEVEL_SWF, swf);
  console.log(`wrote ${LEVEL_SWF} (${renamed} cue names)`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
