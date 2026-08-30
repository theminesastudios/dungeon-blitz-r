/**
 * Takes the click out of the square's four Hallow's Eve hotspots.
 *
 * ## What they are
 *
 * `a_Room_SRN04` carries four cues that used to belong to the leaderboard statues -
 * `__id1133_`, `__id1139_`, `__id1140_`, `__id1141_`. The pedestals were removed when
 * the square was dressed, but the cues had to stay (deleting a cue placement crashes
 * the room's constructor, which writes through a generated typed member), and each
 * one is still a click target sitting on the ruins at a fixed spot:
 *
 *     __id1133_  world (2706, 414)
 *     __id1140_  world (2896, 368)   <- now Special_ClassTower
 *     __id1139_  world (3098, 366)   <- now Special_TreasureTrove, by the besom
 *     __id1141_  world (3316, 454)
 *
 * Two of them carry the names that open the event's screens, because `var_1046` is
 * keyed by cue name and a server-spawned prop can only bind through a cue the *room*
 * defines. So the names had to go somewhere, and wherever they went became a second,
 * invisible way to open the panel: clicking the broom opened the coffers, clicking
 * bare stone opened the dungeon prompt. The other two answered a click with an empty
 * speech bubble - the "..." - until they were renamed out of the skit arms.
 *
 * ## The fix
 *
 * `Entity.method_355` - the whole of what makes a body clickable - is
 *
 *     team == NEUTRAL && cue != null && cue.characterName
 *
 * and it reads the team off the **entity**. The room's hotspots take theirs from the
 * cue; the props this project spawns send their own in the entity packet. So moving
 * one cue off `"neutral"` kills the hotspot and leaves the prop untouched.
 *
 * `Level.method_1130` still registers the cue - its non-contact path branches on
 * `team != "neutral"` straight into the registration block, and the "should be set to
 * team neutral" complaint goes to `class_24.method_19`, which is empty in this build.
 * So `var_1046` keeps the name and the props keep binding through it.
 *
 * The edit is one operand: the `pushstring` feeding `setproperty team` is repointed
 * from `"neutral"` to another string already in the pool. Both indices are two bytes,
 * so nothing moves.
 *
 * The villagers' cues - `SRN_Mayor01`, `SRN_Merchant01`, `Ield` - are deliberately not
 * touched: those are real NPCs the square still wants.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-mute-hotspots.ts [--verify]
 *
 * Re-runnable: it checks for its own result first.
 */
import * as path from "path";
import {
  PatchError,
  applyPatchesToBody,
  classIndexByName,
  disassemble,
  ensureBackup,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  u30OperandName,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const LEVEL_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "LevelsSRN.swf",
);

const ROOM_CLASS = "a_Room_SRN04";

/** The cue instances whose hotspots should stop answering clicks. */
const HOTSPOTS = ["__id1133_", "__id1139_", "__id1140_", "__id1141_"];

const TEAM_FIELD = "team";
const FROM_TEAM = "neutral";
/**
 * Not `neutral`, and not hostile either.
 *
 * `Room.as` maps the cue's team string with three literal comparisons and lets
 * anything it does not recognise fall through to team 0, which the client draws with
 * a red health bar - which is what the first pass, using `"Hidden"`, put over all four
 * hotspots. `friend` is GOODGUY: still not NEUTRAL, so `method_355` refuses the
 * click, but an ally rather than a monster, so nothing is drawn over it.
 *
 * The word is put into the pool by `patch-levelssrn-hallows-eve-cues.ts`, which
 * renames a spare statue cue to it; see the note there.
 */
const TO_TEAM = "friend";

const OP_PUSHSTRING = 0x2c;
const OP_SETPROPERTY = 0x61;

function traitName(instance: string): string {
  return `__setProp_${instance}_${ROOM_CLASS}_cues_0`;
}

function main(): void {
  const verify = process.argv.includes("--verify");

  const ctx = parseSwf(LEVEL_SWF);
  const abc = parseAbc(ctx);

  const classIdx = classIndexByName(abc, ROOM_CLASS);
  if (classIdx === null) throw new PatchError(`no ${ROOM_CLASS} in this level`);
  const traits = abc.instances[classIdx].traits;

  const fromIdx = abc.stringValues.indexOf(FROM_TEAM);
  const toIdx = abc.stringValues.indexOf(TO_TEAM);
  if (fromIdx < 0 || toIdx < 0) {
    throw new PatchError(`the string pool has no "${FROM_TEAM}" or no "${TO_TEAM}" to swap to`);
  }
  const replacement = writeU30(toIdx);
  if (replacement.length !== writeU30(fromIdx).length) {
    throw new PatchError(
      `"${TO_TEAM}" encodes to ${replacement.length} bytes and "${FROM_TEAM}" to ${writeU30(fromIdx).length}; ` +
        "this patch only swaps same-width operands so that no branch offset moves",
    );
  }

  const patches = [];
  const done: string[] = [];
  for (const instance of HOTSPOTS) {
    const name = traitName(instance);
    const methodIdx = methodIdxForTrait(traits, abc, name);
    if (methodIdx === null) throw new PatchError(`${ROOM_CLASS} has no ${name}`);
    const body = abc.methodBodies.get(methodIdx);
    if (!body) throw new PatchError(`${name} has no body`);

    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const instructions = disassemble(code, name);

    let site: number | null = null;
    for (let i = 1; i < instructions.length; i += 1) {
      if (instructions[i].opcode !== OP_SETPROPERTY) continue;
      if (u30OperandName(instructions[i], abc.multinameNames) !== TEAM_FIELD) continue;
      const push = instructions[i - 1];
      if (push.opcode !== OP_PUSHSTRING) continue;
      if (push.operands[0][1] !== fromIdx) continue; // already moved
      site = push.offset + 1;
      break;
    }
    if (site === null) continue;

    done.push(instance);
    if (verify) continue;
    patches.push({
      key: `hallows-eve-mute-${instance}`,
      start: body.codeStart + site,
      end: body.codeStart + site + replacement.length,
      data: replacement,
      detail: `${instance}.team "${FROM_TEAM}" -> "${TO_TEAM}"`,
    });
  }

  if (done.length === 0) {
    console.log("every Hallow's Eve hotspot is already off the neutral team; nothing to do.");
    return;
  }
  console.log(`${done.length} hotspot cue(s) leaving team "${FROM_TEAM}": ${done.join(", ")}`);
  if (verify) {
    console.log("verify only - nothing written.");
    return;
  }

  const patched = applyPatchesToBody(ctx.body, patches);
  ensureBackup(LEVEL_SWF);
  writeSwf(ctx, patched.body, patched.delta);
  console.log(`wrote ${LEVEL_SWF}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
