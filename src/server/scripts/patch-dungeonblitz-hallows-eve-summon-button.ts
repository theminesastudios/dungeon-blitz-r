/**
 * Keeps the Summon button on screen, by stopping the host class from hiding it.
 *
 * ## The last thing in the way
 *
 * "Summon Knight Now" is bound by moving its art into `am_SpeedUpPanel.am_SpeedUp`,
 * the one control `class_69` attaches a Mammoth Idol purchase to - see
 * `scripts/patch-hallows-eve-challenge-screen.ts`. That works, and the click reaches
 * `method_1410`, which sends `0xE0`.
 *
 * It is never clickable, though, because `class_69.OnRefreshScreen` decides what to
 * draw from the Class Tower's research state:
 *
 *     if (mMasterClassTower.mStatus == const_200) {   // research in progress
 *         var_1134.Show();     // am_SpeedUpPanel
 *         …
 *     } else {
 *         var_1134.Hide();     // am_SpeedUpPanel  <- always taken here
 *         …
 *     }
 *
 * and `class_66`'s constructor sets `mStatus = const_185` (0). Nothing on this server
 * starts tower research, so the panel is hidden on every refresh and the button with
 * it - drawn once by `OnCreateScreen`, gone by the first `Refresh()`.
 *
 * ## The patch
 *
 * One operand. The `callpropvoid` in the else branch is repointed from `Hide` to
 * `Show`, so the container the Summon button lives in is shown in the state this
 * server is always in. No instruction is added or removed and no branch offset moves;
 * the multiname index is simply the other one, and both are already in the pool
 * because the same method calls `Show` a dozen times.
 *
 * The site is found structurally rather than by offset: the class is looked up by
 * name, the method by trait name, and the instruction is the `callpropvoid Hide, 0`
 * whose receiver is the `getproperty var_1134` immediately before it. That pair
 * occurs exactly once, and the patch refuses to run if it does not.
 *
 * ## What else moves with it
 *
 * Only this one container. Everything `class_69` shows or hides beside it is an empty
 * dummy this project minted, so its visibility is invisible either way. `am_Close`
 * and the panel's own artwork are not touched by `OnRefreshScreen` at all.
 *
 * Usage: npm exec ts-node scripts/patch-dungeonblitz-hallows-eve-summon-button.ts [--verify]
 *
 * Re-runnable: it checks for its own result first.
 */
import * as crypto from "crypto";
import * as fs from "fs";
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

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content", "localhost");
const CLIENT_SWF = path.join(CLIENT_CONTENT, "p", "cbp", "DungeonBlitz.swf");
const INDEX_HTML = path.join(CLIENT_CONTENT, "index.html");

/** The screen class, its refresh, and the wrapper that holds the Summon button. */
const HOST_CLASS = "class_69";
const HOST_METHOD = "OnRefreshScreen";
const CONTAINER_FIELD = "var_1134";
const FROM_CALL = "Hide";
const TO_CALL = "Show";

const OP_NOP = 0x02;
const OP_PUSHSTRING = 0x2c;
const OP_CALLPROPVOID = 0x4f;
const OP_GETPROPERTY = 0x66;
const OP_GETLOCAL0 = 0xd0;
const OP_FINDPROPSTRICT = 0x5d;

/**
 * The second site: the click that disables the button forever.
 *
 * `method_1410` opens its send path with
 *
 *     getlocal0
 *     getproperty var_1324            // the am_SpeedUp wrapper
 *     pushstring "Inactive"
 *     callpropvoid DisableButton, 1
 *
 * which is right for a Class Tower speed-up - the research finishes, the screen
 * refreshes, and the button comes back. Nothing brings it back here: `var_1324` is
 * touched in exactly one other place in the class (`OnCreateScreen`, where it is
 * created) and `OnRefreshScreen` never calls `EnableButton` on it. So the first
 * Summon sticks the button off for the rest of the session.
 *
 * The four instructions are replaced with `nop`s. They are stack-neutral as a group
 * - `+1 +0 +1 -2` - so removing them cannot unbalance the frame, and `nop` is the
 * same width as the bytes it covers, so no branch offset moves. The label at the head
 * of this block (`ofs0063`, the target of the "not enough idols" test) simply lands on
 * a `nop` and falls through.
 */
const DISABLE_CALL = "DisableButton";
const BUTTON_FIELD = "var_1324";
const SEND_METHOD = "method_1410";
const HIDE_CALL = "Hide";
const HIDE_SOURCE = "method_687";

/** Keeps index.html's cache token in step, or nobody is served the patch. */
function syncClientRevision(): void {
  const digest = crypto.createHash("sha1").update(fs.readFileSync(CLIENT_SWF)).digest("hex").slice(0, 12);
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const updated = html.replace(/clientrev=swf-[A-Za-z0-9]+/, `clientrev=swf-${digest}`);
  if (updated === html) {
    console.log("  no clientrev token moved in index.html - check it by hand.");
    return;
  }
  fs.writeFileSync(INDEX_HTML, updated);
  console.log(`  clientrev -> swf-${digest}`);
}


/** Disassembles one method of the host class, by trait name. */
function methodCode(ctx: ReturnType<typeof parseSwf>, abc: ReturnType<typeof parseAbc>, classIdx: number, name: string) {
  const methodIdx = methodIdxForTrait(abc.instances[classIdx].traits, abc, name);
  if (methodIdx === null) throw new PatchError(`${HOST_CLASS} has no ${name}`);
  const body = abc.methodBodies.get(methodIdx);
  if (!body) throw new PatchError(`${HOST_CLASS}.${name} has no body`);
  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  return { body, instructions: disassemble(code, `${HOST_CLASS}.${name}`) };
}

/** The `var_1324.DisableButton("Inactive")` block, as a byte range to nop out. */
function findDisableBlock(instructions: ReturnType<typeof disassemble>, names: string[]): { start: number; end: number } | null {
  for (let i = 3; i < instructions.length; i += 1) {
    const call = instructions[i];
    if (call.opcode !== OP_CALLPROPVOID || u30OperandName(call, names) !== DISABLE_CALL) continue;
    if (instructions[i - 1].opcode !== OP_PUSHSTRING) continue;
    if (instructions[i - 2].opcode !== OP_GETPROPERTY) continue;
    if (u30OperandName(instructions[i - 2], names) !== BUTTON_FIELD) continue;
    if (instructions[i - 3].opcode !== OP_GETLOCAL0) continue;
    return { start: instructions[i - 3].offset, end: call.offset + call.size };
  }
  return null;
}


/** The bytes for a bare `Hide()` call on this screen, as `method_687` encodes it. */
function hideCallBytes(instructions: ReturnType<typeof disassemble>, names: string[]): Buffer | null {
  for (const inst of instructions) {
    if (inst.opcode !== OP_CALLPROPVOID) continue;
    if (u30OperandName(inst, names) !== HIDE_CALL) continue;
    if (inst.operands[1][1] !== 0) continue;
    const mn = writeU30(inst.operands[0][1]);
    return Buffer.concat([
      Buffer.from([OP_FINDPROPSTRICT]), mn,
      Buffer.from([OP_CALLPROPVOID]), mn, writeU30(0),
    ]);
  }
  return null;
}

/** A run of at least `need` consecutive nops, left by an earlier pass. */
function findNopRun(instructions: ReturnType<typeof disassemble>, need: number): { start: number; end: number } | null {
  let run = 0;
  for (let i = 0; i < instructions.length; i += 1) {
    if (instructions[i].opcode === OP_NOP) {
      run += 1;
      continue;
    }
    if (run >= need) return { start: instructions[i - run].offset, end: instructions[i - 1].offset + 1 };
    run = 0;
  }
  return run >= need
    ? { start: instructions[instructions.length - run].offset, end: instructions[instructions.length - 1].offset + 1 }
    : null;
}

function main(): void {
  const verify = process.argv.includes("--verify");

  const ctx = parseSwf(CLIENT_SWF);
  const abc = parseAbc(ctx);

  const classIdx = classIndexByName(abc, HOST_CLASS);
  if (classIdx === null) throw new PatchError(`no ${HOST_CLASS} in this ABC`);
  const methodIdx = methodIdxForTrait(abc.instances[classIdx].traits, abc, HOST_METHOD);
  if (methodIdx === null) throw new PatchError(`${HOST_CLASS} has no ${HOST_METHOD}`);
  const body = abc.methodBodies.get(methodIdx);
  if (!body) throw new PatchError(`${HOST_CLASS}.${HOST_METHOD} has no body`);

  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  const instructions = disassemble(code, `${HOST_CLASS}.${HOST_METHOD}`);

  // The multiname index `Show` is called through, taken from this same method so it
  // is certainly the right one for this constant pool.
  let showIdx: number | null = null;
  for (const inst of instructions) {
    if (inst.opcode === OP_CALLPROPVOID && u30OperandName(inst, abc.multinameNames) === TO_CALL) {
      showIdx = inst.operands[0][1];
      break;
    }
  }
  if (showIdx === null) throw new PatchError(`${HOST_METHOD} never calls ${TO_CALL}; refusing to guess an index`);

  // `getproperty var_1134` immediately followed by `callpropvoid Hide, 0`.
  const hits: Array<{ start: number; length: number }> = [];
  for (let i = 1; i < instructions.length; i += 1) {
    const call = instructions[i];
    const receiver = instructions[i - 1];
    if (call.opcode !== OP_CALLPROPVOID || u30OperandName(call, abc.multinameNames) !== FROM_CALL) continue;
    if (receiver.opcode !== OP_GETPROPERTY) continue;
    if (u30OperandName(receiver, abc.multinameNames) !== CONTAINER_FIELD) continue;
    hits.push({ start: call.offset + 1, length: writeU30(call.operands[0][1]).length });
  }

  const already = instructions.some(
    (inst, i) =>
      i > 0 &&
      inst.opcode === OP_CALLPROPVOID &&
      u30OperandName(inst, abc.multinameNames) === TO_CALL &&
      instructions[i - 1].opcode === OP_GETPROPERTY &&
      u30OperandName(instructions[i - 1], abc.multinameNames) === CONTAINER_FIELD,
  );

  if (hits.length > 1) {
    throw new PatchError(
      `${CONTAINER_FIELD}.${FROM_CALL}() occurs ${hits.length} times in ${HOST_METHOD}; ` +
        "it is meant to be unique, so refusing to guess which one hides the Summon button",
    );
  }

  const send = methodCode(ctx, abc, classIdx, SEND_METHOD);
  const sendBody = send.body;

  /**
   * The purchase closes the window.
   *
   * `0x2E` only *arms* the client - `LinkUpdater.method_1565` stores the door and
   * sets `var_2115`, and `Game.method_789` runs the transfer on the next tick. With
   * the panel still up that tick never gets that far, so paying left the player
   * standing in the square with nothing to show for it. Closing the screen is also
   * simply what a finished purchase should do.
   *
   * The room for the call is the space the `DisableButton` block occupied: both are
   * stack-neutral, `Hide()` is the shorter of the two, and the remainder stays `nop`.
   * The method is never longer or shorter than it was, so no branch offset moves.
   */
  const hideBytes = hideCallBytes(methodCode(ctx, abc, classIdx, HIDE_SOURCE).instructions, abc.multinameNames);
  if (!hideBytes) throw new PatchError(`${HIDE_SOURCE} has no bare ${HIDE_CALL}() to copy`);
  const alreadyHides = send.instructions.some(
    (inst) => inst.opcode === OP_CALLPROPVOID && u30OperandName(inst, abc.multinameNames) === HIDE_CALL,
  );
  const disable = alreadyHides
    ? null
    : findDisableBlock(send.instructions, abc.multinameNames) ?? findNopRun(send.instructions, hideBytes.length);

  // The two sites are independent: one may already be applied while the other is not.
  if (hits.length === 0 && !disable) {
    console.log(
      already
        ? "the Summon button is already shown and already closes the window; nothing to do."
        : `no ${CONTAINER_FIELD}.${FROM_CALL}() and no ${DISABLE_CALL}(); nothing to do.`,
    );
    return;
  }
  console.log(
    hits.length > 0
      ? `${HOST_CLASS}.${HOST_METHOD}: ${CONTAINER_FIELD}.${FROM_CALL}() -> ${CONTAINER_FIELD}.${TO_CALL}()`
      : `${HOST_CLASS}.${HOST_METHOD}: ${CONTAINER_FIELD} already shown`,
  );
  console.log(
    disable
      ? `${HOST_CLASS}.${SEND_METHOD}: ${disable.end - disable.start} bytes -> ${HIDE_CALL}() + nops`
      : `${HOST_CLASS}.${SEND_METHOD}: already closes the window on purchase`,
  );
  if (verify) {
    console.log("verify only - nothing written.");
    return;
  }

  const patches: Parameters<typeof applyPatchesToBody>[1] = [];
  if (hits.length > 0) {
  const replacement = writeU30(showIdx);
  if (replacement.length !== hits[0].length) {
    throw new PatchError(
      `${TO_CALL} encodes to ${replacement.length} bytes and ${FROM_CALL} to ${hits[0].length}; ` +
        "this patch only swaps same-width operands so that no branch offset moves",
    );
  }

    patches.push({
      key: "hallows-eve-summon-visible",
      start: body.codeStart + hits[0].start,
      end: body.codeStart + hits[0].start + hits[0].length,
      data: replacement,
      detail: `${CONTAINER_FIELD}.${FROM_CALL}() -> ${TO_CALL}()`,
    });
  }
  if (disable) {
    patches.push({
      key: "hallows-eve-summon-closes-window",
      start: sendBody.codeStart + disable.start,
      end: sendBody.codeStart + disable.end,
      data: Buffer.concat([
        hideBytes,
        Buffer.alloc(disable.end - disable.start - hideBytes.length, OP_NOP),
      ]),
      detail: `${BUTTON_FIELD}.${DISABLE_CALL}() -> ${HIDE_CALL}()`,
    });
  }

  const patched = applyPatchesToBody(ctx.body, patches);

  ensureBackup(CLIENT_SWF);
  writeSwf(ctx, patched.body, patched.delta);
  console.log(`wrote ${CLIENT_SWF}`);
  syncClientRevision();
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
