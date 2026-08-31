/**
 * Makes the panel's purchase land: a real price, and a window that closes behind it.
 *
 * ## Where the button comes from
 *
 * The Green Knight's panel is `class_69` - the Class Tower screen class, repointed at
 * `a_ScreenHalloweenDungeonPrompt` by `patch-hallows-eve-challenge-screen.ts` - and the
 * one control it binds a Mammoth Idol purchase to is `am_SpeedUpPanel.am_SpeedUp`, the
 * tower's *speed up the research* button. The seasonal *Summon Knight Now* art is moved
 * into that slot, so a click reaches `method_1410`, which sends `0xE0`.
 *
 * Which button is drawn in which state, and the handler behind the idle one, are
 * `patch-dungeonblitz-hallows-eve-button-states.ts`'s. This script is only about what
 * `method_1410` itself does when it runs.
 *
 * Usage: npm exec ts-node scripts/patch-dungeonblitz-hallows-eve-summon-button.ts [--verify]
 *
 * Re-runnable: each site checks for its own result first.
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

/** The screen class and the handler both sites live in. */
const HOST_CLASS = "class_69";

const OP_NOP = 0x02;
const OP_PUSHSTRING = 0x2c;
const OP_CALLPROPVOID = 0x4f;
const OP_GETPROPERTY = 0x66;
const OP_GETLOCAL0 = 0xd0;
const OP_FINDPROPSTRICT = 0x5d;
const OP_PUSHBYTE = 0x24;
const OP_GETLEX = 0x60;
const OP_GETLOCAL2 = 0xd2;
const OP_CALLPROPERTY = 0x46;
const OP_CONVERT_U = 0x74;
const OP_SETLOCAL3 = 0xd7;

/**
 * The first site: the click that disables the button forever.
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

/**
 * The second site: the price the client checks against, taken out of its hands.
 *
 * `method_1410` derives a cost from the Class Tower's own clock -
 * `Game.method_257(mMasterClassTower.mEndtime - mServerGameTime)` - and refuses to
 * send anything when `mMammothIdols < cost`, opening `screenBuyIdols` instead. That
 * check cannot be right here, because **one handler now serves both of the panel's
 * buttons**: *Summon Knight Now* while the Knight sleeps, which costs twenty idols,
 * and *Enter Dungeon* while he is up, which costs nothing (and neither does a first
 * visit). Any literal that makes the paid press honest makes the free press
 * impossible - and since the arch itself is shut, a player with no idols would have
 * no way in at all, on the one screen that says *Enter Dungeon* to them.
 *
 * A pass that priced it at twenty did exactly that, back when the panel had a single
 * button and the twelve-hour wait was almost always over. So the literal is **0**: the
 * client always sends, and the server - which is the only side that knows whether the
 * Knight is up, whether this is a first visit, and what a summon costs - answers.
 * `HallowsEve.summonKnightNow` charges `HALLOWS_EVE_SUMMON_COST_IDOLS`, and a player
 * who cannot pay is told at the arch how long is left and what it would cost, in
 * words, rather than by a shop window that cannot explain itself.
 *
 * What is lost is the idol shop opening itself on a refused summon. What is kept is
 * the price *on the panel*: `am_IdolGroup`, the twenty-idol tag, is drawn beside the
 * Summon button in exactly the state that has to pay
 * (`patch-hallows-eve-panel-timer.ts`).
 *
 * `getlex Game; getlocal2; callproperty method_257, 1` and `pushbyte 0` both leave one
 * value on the stack, and the literal is shorter, so the remainder stays `nop` and
 * nothing moves. The cost also travels in the packet, where it is now a zero the
 * server logs and ignores.
 */
const COST_CALL = "method_257";
const COST_VALUE = 0;

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


/** The `Game.method_257(...)` cost computation, as a byte range to overwrite. */
function findCostBlock(instructions: ReturnType<typeof disassemble>, names: string[]): { start: number; end: number } | null {
  for (let i = 2; i < instructions.length; i += 1) {
    const call = instructions[i];
    if (call.opcode !== OP_CALLPROPERTY || u30OperandName(call, names) !== COST_CALL) continue;
    if (instructions[i - 1].opcode !== OP_GETLOCAL2) continue;
    if (instructions[i - 2].opcode !== OP_GETLEX) continue;
    return { start: instructions[i - 2].offset, end: call.offset + call.size };
  }
  return null;
}

/**
 * The literal an earlier pass left in place of the cost computation.
 *
 * Found by what it feeds rather than by its value: the price is the only `pushbyte`
 * in `method_1410` whose next real instructions are `convert_u; setlocal3`, local 3
 * being the cost the idol check and the packet both read. Returns the byte to rewrite
 * when the literal is not the one this script wants.
 */
function findCostLiteral(instructions: ReturnType<typeof disassemble>): { at: number; value: number } | null {
  for (let i = 0; i < instructions.length - 1; i += 1) {
    if (instructions[i].opcode !== OP_PUSHBYTE) continue;
    const rest = instructions.slice(i + 1).filter((inst) => inst.opcode !== OP_NOP);
    if (rest.length < 2) continue;
    if (rest[0].opcode !== OP_CONVERT_U || rest[1].opcode !== OP_SETLOCAL3) continue;
    return { at: instructions[i].offset + 1, value: instructions[i].operands[0][1] };
  }
  return null;
}

function main(): void {
  const verify = process.argv.includes("--verify");

  const ctx = parseSwf(CLIENT_SWF);
  const abc = parseAbc(ctx);

  const classIdx = classIndexByName(abc, HOST_CLASS);
  if (classIdx === null) throw new PatchError(`no ${HOST_CLASS} in this ABC`);

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

  const cost = findCostBlock(send.instructions, abc.multinameNames);
  const costBytes = Buffer.from([OP_PUSHBYTE, COST_VALUE]);
  // The computation is gone already: check the literal that replaced it is this one.
  const literal = cost ? null : findCostLiteral(send.instructions);
  const reprice = literal && literal.value !== COST_VALUE ? literal : null;

  // Both sites are independent: either may already be applied while the other is not.
  if (!disable && !cost && !reprice) {
    console.log("the Summon purchase already closes the window and carries its price; nothing to do.");
    return;
  }
  console.log(
    disable
      ? `${HOST_CLASS}.${SEND_METHOD}: ${disable.end - disable.start} bytes -> ${HIDE_CALL}() + nops`
      : `${HOST_CLASS}.${SEND_METHOD}: already closes the window on purchase`,
  );
  if (cost) {
    console.log(`${HOST_CLASS}.${SEND_METHOD}: ${COST_CALL}(...) -> pushbyte ${COST_VALUE}`);
  } else if (reprice) {
    console.log(`${HOST_CLASS}.${SEND_METHOD}: client-side price ${reprice.value} -> ${COST_VALUE}`);
  } else {
    console.log(`${HOST_CLASS}.${SEND_METHOD}: the client already leaves the price to the server`);
  }
  if (verify) {
    console.log("verify only - nothing written.");
    return;
  }

  const patches: Parameters<typeof applyPatchesToBody>[1] = [];

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

  if (cost) {
    patches.push({
      key: "hallows-eve-summon-price",
      start: sendBody.codeStart + cost.start,
      end: sendBody.codeStart + cost.end,
      data: Buffer.concat([costBytes, Buffer.alloc(cost.end - cost.start - costBytes.length, OP_NOP)]),
      detail: `${COST_CALL}(...) -> ${COST_VALUE}`,
    });
  }

  if (reprice) {
    patches.push({
      key: "hallows-eve-summon-price",
      start: sendBody.codeStart + reprice.at,
      end: sendBody.codeStart + reprice.at + 1,
      data: Buffer.from([COST_VALUE]),
      detail: `client-side price ${reprice.value} -> ${COST_VALUE}`,
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
