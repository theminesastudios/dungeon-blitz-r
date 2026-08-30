/**
 * Gives the square's two Hallow's Eve figures name plates.
 *
 * ## Where a name plate comes from
 *
 * The client draws it from the **cue**, not from the entity or its EntType:
 * `Entity` does `MathUtil.method_2(am_NameText, this.cue.displayName)`. And the value
 * both of these cues carry is `"Hidden"`, which is the authored sentinel for *no
 * plate* - the statues they used to belong to were meant to be nameless pedestals.
 *
 * So naming the figures means writing two words into `a_Room_SRN04`'s own
 * `__setProp` code:
 *
 *     __id1140_  Special_ClassTower     -> Solus   (the watcher by the arch)
 *     __id1139_  Special_TreasureTrove  -> Hans    (the herald, who holds the coffers)
 *
 * The other two hotspot cues keep `"Hidden"`: they are silent and unclickable now,
 * and a floating name over bare ruin would undo that.
 *
 * ## Why the pool has to grow
 *
 * Neither word is in the level's string pool, and the sibling patches in this folder
 * all work by *repointing* an operand at a string that is already there - which only
 * works while a spare string exists. There are none left: the four statue names have
 * already been spent on the two magic cue names, on `friend` (the team value) and on
 * a mute name.
 *
 * Appending is safe where inserting is not. A new entry goes on the end of the pool,
 * so every existing index still means what it meant; only the count changes. The ABC
 * after the pool shifts by the bytes added, which costs nothing because ABC is parsed
 * strictly in order and the only offsets inside it - branch targets - are relative to
 * their own method body.
 *
 * The work is two passes over the file: append the words, then re-read (every offset
 * past the pool has moved) and repoint the two `pushstring` operands feeding
 * `setproperty displayName`.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-npc-names.ts [--verify]
 *
 * Re-runnable: it checks for its own result first.
 */
import * as fs from "fs";
import * as path from "path";
import {
  SwfLevelError,
  ensureBackup as ensureLevelBackup,
  movePlacement,
  parsePlace,
  readSwfFile,
  readSymbolClasses,
  rebuildSprite,
  spriteInnerTags,
  writeSwfFile,
  TAG_DEFINE_SPRITE,
  TAG_PLACE_OBJECT2,
  TAG_PLACE_OBJECT3,
} from "./swfLevelUtils";
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
const DISPLAY_FIELD = "displayName";
/** The authored "draw no plate" sentinel these cues start on. */
const UNNAMED = "Hidden";

/** Which cue instance gets which name. */
const NAMES: Record<string, string> = {
  __id1140_: "Solus", // Special_ClassTower - the watcher beside the arch
  __id1139_: "Hans",  // Special_TreasureTrove - the herald with the coffers
};

const OP_PUSHSTRING = 0x2c;
const OP_SETPROPERTY = 0x61;

/**
 * Where each cue is moved to, in room-local pixels.
 *
 * **Two plates were being drawn, not one.** The room's own hotspot and the prop this
 * project spawns are two entities bound to the *same* cue, and the plate comes from
 * `cue.displayName` - so naming the cue named both of them, and the hotspot's copy
 * floated up on the ruins where the statue used to stand.
 *
 * The hotspot cannot be given a different name (there is only one cue) and cannot be
 * deleted (removing a cue placement crashes the room's constructor). But it can be
 * *moved*: stood on the same spot as the prop, the two plates land on top of each
 * other and read as one.
 *
 * The numbers are `CHALLENGE_POSITION` and `HERALD_POSITION` from `core/HallowsEve.ts`
 * minus the room's origin at world (2440, 660). Move a prop and this has to follow.
 */
const CUE_HOME: Record<string, { x: number; y: number }> = {
  __id1140_: { x: 2580 - 2440, y: 580 - 660 }, // Solus, the watcher by the arch
  __id1139_: { x: 2992 - 2440, y: 580 - 660 }, // Hans, the herald with the coffers
};

const ROOM_SYMBOL = "a_Room_SRN04";

function traitName(instance: string): string {
  return `__setProp_${instance}_${ROOM_CLASS}_cues_0`;
}

/** Adds words to the end of the string pool, leaving every existing index alone. */
function appendStrings(words: string[]): boolean {
  const ctx = parseSwf(LEVEL_SWF);
  const abc = parseAbc(ctx);

  const missing = words.filter((word) => abc.stringValues.indexOf(word) < 0);
  if (missing.length === 0) return false;

  const added = Buffer.concat(
    missing.map((word) => {
      const bytes = Buffer.from(word, "utf8");
      return Buffer.concat([writeU30(bytes.length), bytes]);
    }),
  );

  const patched = applyPatchesToBody(ctx.body, [
    {
      key: "hallows-eve-names-pool",
      start: abc.stringPoolEnd,
      end: abc.stringPoolEnd,
      data: added,
      detail: `append ${missing.join(", ")}`,
    },
    {
      key: "hallows-eve-names-count",
      start: abc.stringCountPos,
      end: abc.stringCountEnd,
      data: writeU30(abc.stringValues.length + missing.length),
      detail: `string_count ${abc.stringValues.length} -> ${abc.stringValues.length + missing.length}`,
    },
  ]);

  ensureBackup(LEVEL_SWF);
  writeSwf(ctx, patched.body, patched.delta);
  console.log(`  appended to the string pool: ${missing.join(", ")}`);
  return true;
}

/** Repoints each named cue's `displayName` at its word. */
function applyNames(verify: boolean): string[] {
  const ctx = parseSwf(LEVEL_SWF);
  const abc = parseAbc(ctx);

  const classIdx = classIndexByName(abc, ROOM_CLASS);
  if (classIdx === null) throw new PatchError(`no ${ROOM_CLASS} in this level`);
  const traits = abc.instances[classIdx].traits;

  const unnamedIdx = abc.stringValues.indexOf(UNNAMED);
  if (unnamedIdx < 0) throw new PatchError(`the pool has no "${UNNAMED}" to replace`);

  const patches = [];
  const done: string[] = [];
  for (const [instance, word] of Object.entries(NAMES)) {
    const wordIdx = abc.stringValues.indexOf(word);
    if (wordIdx < 0) throw new PatchError(`"${word}" is not in the pool; the append pass did not run`);

    const name = traitName(instance);
    const methodIdx = methodIdxForTrait(traits, abc, name);
    if (methodIdx === null) throw new PatchError(`${ROOM_CLASS} has no ${name}`);
    const body = abc.methodBodies.get(methodIdx);
    if (!body) throw new PatchError(`${name} has no body`);

    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const instructions = disassemble(code, name);

    let site: { start: number; length: number } | null = null;
    for (let i = 1; i < instructions.length; i += 1) {
      if (instructions[i].opcode !== OP_SETPROPERTY) continue;
      if (u30OperandName(instructions[i], abc.multinameNames) !== DISPLAY_FIELD) continue;
      const push = instructions[i - 1];
      if (push.opcode !== OP_PUSHSTRING) continue;
      if (push.operands[0][1] !== unnamedIdx) continue; // already named
      site = { start: push.offset + 1, length: writeU30(push.operands[0][1]).length };
      break;
    }
    if (!site) continue;

    const replacement = writeU30(wordIdx);
    if (replacement.length !== site.length) {
      throw new PatchError(
        `"${word}" encodes to ${replacement.length} bytes and "${UNNAMED}" to ${site.length}; ` +
          "this patch only swaps same-width operands so that no branch offset moves",
      );
    }

    done.push(`${instance} -> ${word}`);
    if (verify) continue;
    patches.push({
      key: `hallows-eve-name-${instance}`,
      start: body.codeStart + site.start,
      end: body.codeStart + site.start + site.length,
      data: replacement,
      detail: `${instance}.displayName "${UNNAMED}" -> "${word}"`,
    });
  }

  if (done.length === 0 || verify) return done;

  const patched = applyPatchesToBody(ctx.body, patches);
  ensureBackup(LEVEL_SWF);
  writeSwf(ctx, patched.body, patched.delta);
  return done;
}

/** Stands each named cue on its prop, so the two name plates coincide. */
function moveCues(verify: boolean): string[] {
  const swf = readSwfFile(LEVEL_SWF);
  const room = readSymbolClasses(swf).find((entry) => entry.name === ROOM_SYMBOL);
  if (!room) throw new SwfLevelError(`no ${ROOM_SYMBOL} in this level`);
  const index = swf.tags.findIndex(
    (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === room.id,
  );
  if (index === -1) throw new SwfLevelError(`${ROOM_SYMBOL} is not a sprite`);

  const inner = spriteInnerTags(swf.tags[index]);
  const moved: string[] = [];
  for (let i = 0; i < inner.length; i += 1) {
    if (inner[i].code !== TAG_PLACE_OBJECT2 && inner[i].code !== TAG_PLACE_OBJECT3) continue;
    const place = parsePlace(inner[i]);
    const home = place.name ? CUE_HOME[place.name] : undefined;
    if (!home || !place.matrix) continue;

    const dx = home.x - place.matrix.translateX / 20;
    const dy = home.y - place.matrix.translateY / 20;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue; // already home

    moved.push(`${place.name} by (${Math.round(dx)}, ${Math.round(dy)})`);
    if (!verify) inner[i] = movePlacement(inner[i], dx, dy);
  }

  if (moved.length === 0 || verify) return moved;
  swf.tags[index] = rebuildSprite(swf.tags[index], inner);
  ensureLevelBackup(LEVEL_SWF);
  writeSwfFile(LEVEL_SWF, swf);
  return moved;
}

function main(): void {
  const verify = process.argv.includes("--verify");

  if (verify) {
    const ctx = parseSwf(LEVEL_SWF);
    const abc = parseAbc(ctx);
    const missing = Object.values(NAMES).filter((w) => abc.stringValues.indexOf(w) < 0);
    if (missing.length > 0) {
      console.log(`would append to the string pool: ${missing.join(", ")}`);
      console.log("verify only - nothing written.");
      return;
    }
    const pending = applyNames(true);
    const pendingMoves = moveCues(true);
    if (pending.length) console.log(`would name: ${pending.join(", ")}`);
    if (pendingMoves.length) console.log(`would move: ${pendingMoves.join(", ")}`);
    if (!pending.length && !pendingMoves.length) console.log("both figures are already named and in place; nothing to do.");
    return;
  }

  const grew = appendStrings(Object.values(NAMES));
  const named = applyNames(false);
  const moved = moveCues(false);
  if (moved.length > 0) console.log(`moved onto their props: ${moved.join(", ")}`);

  if (!grew && named.length === 0 && moved.length === 0) {
    console.log("both figures are already named; nothing to do.");
    return;
  }
  if (named.length > 0) console.log(`named: ${named.join(", ")}`);
  console.log(`wrote ${LEVEL_SWF} (${fs.statSync(LEVEL_SWF).size} bytes)`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
