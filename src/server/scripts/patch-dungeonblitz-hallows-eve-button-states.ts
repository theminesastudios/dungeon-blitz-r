/**
 * Gives the Green Knight's panel one button per state.
 *
 * ## What the panel was authored to do
 *
 * `a_ScreenHalloweenDungeonPrompt` ships two buttons - *Enter Dungeon* and *Summon
 * Knight Now* - because it was authored with two states, and only one of them is ever
 * true: the Knight is either up, or sleeping off the twelve hours since he last fell.
 *
 * `class_69` - the Class Tower screen class, which this build binds to the seasonal
 * panel - switches two containers on the Class Tower's research flag, and 0xD5 now
 * carries the Knight's deadline in exactly that flag
 * (`patch-dungeonblitz-hallows-eve-cooldown-timer.ts`, `HallowsEve.sendCooldownTimer`):
 *
 *     // class_69.OnRefreshScreen
 *     if (mMasterClassTower.mStatus == const_200) {   // he sleeps
 *         am_SpeedUpPanel.Show();  am_TrainTalentPanel.Hide();
 *     } else {                                        // he is up
 *         am_SpeedUpPanel.Hide();  am_TrainTalentPanel.Show();
 *     }
 *
 * and it binds a button inside each: `am_SpeedUp` to `method_1410` (the Class Tower's
 * *speed up the research* purchase) and `am_TrainTalent` to `TrainTalentPoint`. So the
 * two states, the two containers and the two click handlers are all already there.
 * `patch-hallows-eve-challenge-screen.ts` moves the Summon art into `am_SpeedUp` and
 * the Enter art into `am_TrainTalent`; this script makes the code behind them agree.
 *
 * ## The two operands
 *
 *   1. **`am_SpeedUpPanel` is hidden again in the idle branch.** An earlier pass
 *      flipped that `Hide` to `Show`, because at the time nothing ever set the research
 *      flag and the button would otherwise never have been drawn at all. The flag is
 *      real now, so the authored `Hide` is right again: without it the Summon button is
 *      drawn over the Enter button in the state where there is nothing to summon. Runs
 *      on a file that still carries the flip *or* on one that never had it.
 *
 *   2. **`am_TrainTalent`'s handler becomes `method_1410`.** `TrainTalentPoint` spends
 *      a talent point on a Class Tower this build no longer has. `method_1410` sends
 *      `LinkUpdater.const_1284` - `0xE0` - which `TalentHandler.handleTalentSpeedup`
 *      answers, in the two Hallow's Eve towns, by taking the player through the arch:
 *      free while the Knight is up (and on a first visit), twenty Mammoth Idols while
 *      he sleeps. Both buttons therefore mean one thing - *go and fight him now* - and
 *      only the label and the price change with the state.
 *
 *      The handler is a plain `getproperty` operand on the `method_10(control,
 *      handler)` call, so this is one multiname index. `method_1410` takes one
 *      parameter and `TrainTalentPoint` takes two with the second optional, so both are
 *      callable the way `class_33` calls them, with the event alone.
 *
 * Neither site adds or removes an instruction, and both replacement operands encode to
 * the same width as the ones they replace, so no branch offset moves.
 *
 * ## Why the idle state does not simply reuse the one button
 *
 * `class_33` wraps one MovieClip per control and the label is baked into the artwork -
 * two 3-frame clips, up/over/down, one saying *Enter Dungeon* and one saying *Summon
 * Knight Now*. Nothing can retext them at runtime, and a label drawn on top of a button
 * swallows its clicks. Two bound controls in two containers the class already switches
 * is the only shape that gives the panel both labels.
 *
 * Usage: npm exec ts-node scripts/patch-dungeonblitz-hallows-eve-button-states.ts [--verify]
 *
 * Re-runnable: each site checks for its own result first.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  Instruction,
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

const HOST_CLASS = "class_69";
const REFRESH_METHOD = "OnRefreshScreen";
const CREATE_METHOD = "OnCreateScreen";

/**
 * Site 1: the container the Summon button lives in, and the one that names the branch.
 *
 * `var_1134` is `am_SpeedUpPanel` and `var_617` is `am_ResearchProgressPanel` - the
 * countdown's container, shown while he sleeps and hidden while he is up. So the
 * `var_1134` call that is *followed by* `var_617.Hide()` is the idle branch's, and the
 * one followed by `var_617.Show()` is the sleeping branch's. That pairing is what picks
 * the site out; no offset and no ordering is assumed.
 */
const SUMMON_PANEL = "var_1134";
const BUSY_PANEL = "var_617";
const HIDE_CALL = "Hide";
const SHOW_CALL = "Show";

/** Site 2: the button, the handler it was bound to, and the one it gets. */
const IDLE_BUTTON = "am_TrainTalent";
const OLD_HANDLER = "TrainTalentPoint";
const NEW_HANDLER = "method_1410";
const BIND_CALL = "method_10";

const OP_GETPROPERTY = 0x66;
const OP_GETLOCAL0 = 0xd0;
const OP_CALLPROPERTY = 0x46;
const OP_CALLPROPVOID = 0x4f;

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

interface MethodCode {
  codeStart: number;
  instructions: Instruction[];
}

/** Disassembles one method of the host class, by trait name. */
function methodCode(
  ctx: ReturnType<typeof parseSwf>,
  abc: ReturnType<typeof parseAbc>,
  classIdx: number,
  name: string,
): MethodCode {
  const methodIdx = methodIdxForTrait(abc.instances[classIdx].traits, abc, name);
  if (methodIdx === null) throw new PatchError(`${HOST_CLASS} has no ${name}`);
  const body = abc.methodBodies.get(methodIdx);
  if (!body) throw new PatchError(`${HOST_CLASS}.${name} has no body`);
  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  return { codeStart: body.codeStart, instructions: disassemble(code, `${HOST_CLASS}.${name}`) };
}

/** The index a no-argument call is made through, taken off a real call in `method`. */
function callIndex(instructions: Instruction[], names: string[], call: string, method: string): number {
  for (const inst of instructions) {
    if (inst.opcode !== OP_CALLPROPVOID) continue;
    if (u30OperandName(inst, names) !== call) continue;
    if (inst.operands[1][1] !== 0) continue;
    return inst.operands[0][1];
  }
  throw new PatchError(`${method} never calls ${call}(); refusing to guess an index`);
}

/** Every `this.<field>.<call>()`, as instruction indexes into `instructions`. */
function findCalls(instructions: Instruction[], names: string[], field: string, call: string): number[] {
  const found: number[] = [];
  for (let i = 2; i < instructions.length; i += 1) {
    const inst = instructions[i];
    if (inst.opcode !== OP_CALLPROPVOID || u30OperandName(inst, names) !== call) continue;
    if (instructions[i - 1].opcode !== OP_GETPROPERTY) continue;
    if (u30OperandName(instructions[i - 1], names) !== field) continue;
    if (instructions[i - 2].opcode !== OP_GETLOCAL0) continue;
    found.push(i);
  }
  return found;
}

/**
 * The `var_1134` call in the idle branch: the one the countdown's container is hidden
 * immediately after.
 */
function idleBranchCall(instructions: Instruction[], names: string[], call: string): number | null {
  for (const at of findCalls(instructions, names, SUMMON_PANEL, call)) {
    if (findCalls(instructions.slice(at + 1, at + 5), names, BUSY_PANEL, HIDE_CALL).length > 0) return at;
  }
  return null;
}

/** The handler operand on `method_10(var_2.am_TrainTalentPanel.am_TrainTalent, h)`. */
function idleHandlerOperand(instructions: Instruction[], names: string[]): { at: number; index: number } | null {
  for (let i = 3; i < instructions.length; i += 1) {
    const bind = instructions[i];
    if (bind.opcode !== OP_CALLPROPERTY && bind.opcode !== OP_CALLPROPVOID) continue;
    if (u30OperandName(bind, names) !== BIND_CALL || bind.operands[1][1] !== 2) continue;
    const handler = instructions[i - 1];
    if (handler.opcode !== OP_GETPROPERTY) continue;
    if (instructions[i - 2].opcode !== OP_GETLOCAL0) continue;
    // The control being bound: the getproperty chain ends at the button's own name.
    const control = instructions[i - 3];
    if (control.opcode !== OP_GETPROPERTY || u30OperandName(control, names) !== IDLE_BUTTON) continue;
    return { at: i - 1, index: handler.operands[0][1] };
  }
  return null;
}

function main(): void {
  const verify = process.argv.includes("--verify");

  const ctx = parseSwf(CLIENT_SWF);
  const abc = parseAbc(ctx);
  const names = abc.multinameNames;

  const classIdx = classIndexByName(abc, HOST_CLASS);
  if (classIdx === null) throw new PatchError(`no ${HOST_CLASS} in this ABC`);

  const refresh = methodCode(ctx, abc, classIdx, REFRESH_METHOD);
  const create = methodCode(ctx, abc, classIdx, CREATE_METHOD);

  const patches: Parameters<typeof applyPatchesToBody>[1] = [];

  // Site 1 - the idle branch hides the Summon button's container.
  const shown = idleBranchCall(refresh.instructions, names, SHOW_CALL);
  if (shown === null) {
    if (idleBranchCall(refresh.instructions, names, HIDE_CALL) === null) {
      throw new PatchError(
        `${REFRESH_METHOD} has no ${SUMMON_PANEL} call followed by ${BUSY_PANEL}.${HIDE_CALL}(); ` +
          "refusing to guess which branch is the idle one",
      );
    }
    console.log(`${HOST_CLASS}.${REFRESH_METHOD}: ${SUMMON_PANEL} is already hidden while he is up`);
  } else {
    const call = refresh.instructions[shown];
    const hideIdx = writeU30(callIndex(refresh.instructions, names, HIDE_CALL, REFRESH_METHOD));
    const showIdx = writeU30(call.operands[0][1]);
    if (hideIdx.length !== showIdx.length) {
      throw new PatchError(
        `${HIDE_CALL} encodes to ${hideIdx.length} bytes and ${SHOW_CALL} to ${showIdx.length}; ` +
          "this patch only swaps same-width operands so that no branch offset moves",
      );
    }
    console.log(
      `${HOST_CLASS}.${REFRESH_METHOD}: idle branch ${SUMMON_PANEL}.${SHOW_CALL}() -> ${SUMMON_PANEL}.${HIDE_CALL}()`,
    );
    patches.push({
      key: "hallows-eve-summon-panel-idle-hidden",
      start: refresh.codeStart + call.offset + 1,
      end: refresh.codeStart + call.offset + 1 + showIdx.length,
      data: hideIdx,
      detail: `${SUMMON_PANEL}.${SHOW_CALL}() -> ${HIDE_CALL}()`,
    });
  }

  // Site 2 - the Enter button's handler.
  const handler = idleHandlerOperand(create.instructions, names);
  if (!handler) {
    throw new PatchError(`${CREATE_METHOD} does not bind ${IDLE_BUTTON}; the panel is not wired as expected`);
  }
  const bound = names[handler.index];
  if (bound === NEW_HANDLER) {
    console.log(`${HOST_CLASS}.${CREATE_METHOD}: ${IDLE_BUTTON} already sends 0xE0`);
  } else if (bound !== OLD_HANDLER) {
    throw new PatchError(
      `${IDLE_BUTTON} is bound to ${bound}, not ${OLD_HANDLER} or ${NEW_HANDLER}; refusing to overwrite it`,
    );
  } else {
    // The index `method_1410` is already read through in this same method, so it is
    // certainly the right multiname for this constant pool.
    let wanted: number | null = null;
    for (const inst of create.instructions) {
      if (inst.opcode !== OP_GETPROPERTY) continue;
      if (u30OperandName(inst, names) !== NEW_HANDLER) continue;
      wanted = inst.operands[0][1];
      break;
    }
    if (wanted === null) {
      throw new PatchError(`${CREATE_METHOD} never reads ${NEW_HANDLER}; refusing to guess an index`);
    }

    const to = writeU30(wanted);
    const from = writeU30(handler.index);
    if (to.length !== from.length) {
      throw new PatchError(
        `${NEW_HANDLER} encodes to ${to.length} bytes and ${OLD_HANDLER} to ${from.length}; ` +
          "this patch only swaps same-width operands so that no branch offset moves",
      );
    }
    const inst = create.instructions[handler.at];
    console.log(`${HOST_CLASS}.${CREATE_METHOD}: ${IDLE_BUTTON} -> ${NEW_HANDLER} (was ${OLD_HANDLER})`);
    patches.push({
      key: "hallows-eve-enter-button-handler",
      start: create.codeStart + inst.offset + 1,
      end: create.codeStart + inst.offset + 1 + from.length,
      data: to,
      detail: `${OLD_HANDLER} -> ${NEW_HANDLER}`,
    });
  }

  if (patches.length === 0) {
    console.log("both button states are already wired; nothing to do.");
    return;
  }
  if (verify) {
    console.log("verify only - nothing written.");
    return;
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
