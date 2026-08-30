/**
 * Gives the Green Knight's panel a countdown, by handing 0xD5 a deadline.
 *
 * ## What the panel could already do, and could not
 *
 * `a_ScreenHalloweenDungeonPrompt` is driven by `class_69` - the Class Tower screen
 * class, repointed at the seasonal panel (see
 * `scripts/patch-hallows-eve-challenge-screen.ts`). That class already draws a live
 * countdown, every frame, with no help from anything:
 *
 *     // class_69.OnTickScreen
 *     if (mMasterClassTower.mStatus == class_66.const_200) {       // researching
 *        _loc2_ = mMasterClassTower.mEndtime - mServerGameTime;
 *        MathUtil.method_8(var_1238.mMovieClip.am_Time, Game.method_70(_loc2_), ...);
 *     }
 *
 * and `OnRefreshScreen` switches the whole panel on the same flag: on `const_200` it
 * shows `am_ResearchProgressPanel` (which is where `am_Time` lives) and hides
 * `am_Notice`; otherwise it does the reverse. That is exactly the two states the
 * panel was authored with - *"The Green Knight returns in: 23:59:59"* against *"The
 * Green Knight has returned!"* - and `scripts/patch-hallows-eve-panel-timer.ts` puts
 * the seasonal text back into those two containers.
 *
 * The one thing missing was a way for the **server** to say when the Knight is next
 * due. `mMasterClassTower.mEndtime` is written in exactly two places:
 *
 *   - the character block of the login packet, which is sent once, at login, and
 *     never again (`LevelHandler.shouldSendExtendedOnTransfer` returns false); and
 *   - `LinkUpdater.method_1099`, the reader for **0xD5**, which hardcodes zero:
 *
 *         _loc2_ = param1.method_6(class_66.const_571);       // 2 bits
 *         if (var_1.mMasterClassTower) {
 *            var_1.mMasterClassTower.SetCurrentResearch(_loc2_, 0);
 *            var_1.mMasterClassTower.GiveNewResearchPoint();
 *            var_1.mMasterClassTower.method_469();            // "Gained Talent Point"
 *         }
 *
 * A twelve-hour gate that starts when the Knight dies cannot travel on a packet that
 * is only sent at login, so this patch turns 0xD5 into the channel that carries it.
 *
 * ## The patch
 *
 * One contiguous run of instructions, replaced in place and padded with `nop` so the
 * body length never changes and no branch offset moves. `pushbyte 0` becomes a real
 * read off the packet, and the two calls that follow - the ones that grant a talent
 * point and pop a notification - go:
 *
 *     getlocal1
 *     callproperty method_4, 0          ; the deadline, straight off the packet
 *     callpropvoid SetCurrentResearch, 2
 *     nop nop nop ...
 *
 * `SetCurrentResearch` then decides the state on its own: a non-zero index with a
 * non-zero deadline is `const_200`, and `(0, 0)` is `const_185` - so the server says
 * "he sleeps until T" and "he is up" in the same two fields, and the client's own
 * untouched code draws both.
 *
 * The stack is unchanged in width: `[tower, index]` becomes `[tower, index, deadline]`
 * at its peak, which is the `maxstack 3` the method already declares.
 *
 * ## What this costs
 *
 * 0xD5 stops granting a talent point on arrival. That is the Class Tower's
 * research-complete packet, and the Class Tower is gone from this client - its screen
 * class is this panel, so no research can be started, and `TalentHandler` grants the
 * point server-side either way. `TalentHandler.sendTalentResearchComplete` writes the
 * new two-field shape so the packet stays honest whoever sends it.
 *
 * Usage: npm exec ts-node scripts/patch-dungeonblitz-hallows-eve-cooldown-timer.ts [--verify]
 *
 * Re-runnable: it checks for its own result first.
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

const HOST_CLASS = "LinkUpdater";
const HOST_METHOD = "method_1099";

/** The call the deadline is handed to, and the packet reader that supplies it. */
const TARGET_CALL = "SetCurrentResearch";
const READ_CALL = "method_4";

/** The two calls that go: they belong to the Class Tower, not to the arch. */
const DROPPED_CALLS = ["GiveNewResearchPoint", "method_469"];

const OP_NOP = 0x02;
const OP_PUSHBYTE = 0x24;
const OP_CALLPROPERTY = 0x46;
const OP_CALLPROPVOID = 0x4f;
const OP_GETLOCAL1 = 0xd1;

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

/**
 * The multiname `Packet.method_4()` is called through.
 *
 * Lifted off a real call rather than looked up by name: several multinames can carry
 * the same name in different namespaces, and only the one this class already reads
 * packets with is certainly right for this pool. Every zero-argument `method_4` call
 * in `LinkUpdater` is a packet read, so they must all agree - and the patch refuses
 * to guess if they do not.
 */
function packetReadMultiname(
  abc: ReturnType<typeof parseAbc>,
  ctx: ReturnType<typeof parseSwf>,
  classIdx: number,
): number {
  const seen = new Set<number>();
  for (const trait of abc.instances[classIdx].traits) {
    if (trait.methodIdx === null) continue;
    const body = abc.methodBodies.get(trait.methodIdx);
    if (!body) continue;
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    let instructions: Instruction[];
    try {
      instructions = disassemble(code, `${HOST_CLASS}.method#${trait.methodIdx}`);
    } catch {
      continue;
    }
    for (const inst of instructions) {
      if (inst.opcode !== OP_CALLPROPERTY) continue;
      if (u30OperandName(inst, abc.multinameNames) !== READ_CALL) continue;
      if (inst.operands[1][1] !== 0) continue;
      seen.add(inst.operands[0][1]);
    }
  }
  if (seen.size !== 1) {
    throw new PatchError(
      `expected exactly one multiname for ${READ_CALL}() in ${HOST_CLASS}, found ${seen.size}`,
    );
  }
  return [...seen][0];
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

  const callIndex = instructions.findIndex(
    (inst) => inst.opcode === OP_CALLPROPVOID && u30OperandName(inst, abc.multinameNames) === TARGET_CALL,
  );
  if (callIndex < 1) throw new PatchError(`${HOST_METHOD} does not call ${TARGET_CALL}`);
  const call = instructions[callIndex];
  const argument = instructions[callIndex - 1];

  if (argument.opcode === OP_CALLPROPERTY && u30OperandName(argument, abc.multinameNames) === READ_CALL) {
    console.log(`${HOST_METHOD} already reads the deadline off the packet; nothing to do.`);
    return;
  }
  if (argument.opcode !== OP_PUSHBYTE || argument.operands[0][1] !== 0) {
    throw new PatchError(
      `${HOST_METHOD} does not pass a literal 0 to ${TARGET_CALL}; refusing to patch an unknown shape`,
    );
  }

  /**
   * The tail: the two Class Tower calls, which are the room this patch is written in.
   *
   * They are taken as a block from the end of the `SetCurrentResearch` call to the end
   * of the last dropped call, and the shape is checked rather than assumed - the block
   * must be exactly those two calls, and nothing may branch into it (the method's only
   * label is the `returnvoid` after it).
   */
  let last = callIndex;
  const dropped: string[] = [];
  for (let i = callIndex + 1; i < instructions.length; i += 1) {
    const inst = instructions[i];
    if (inst.opcode !== OP_CALLPROPVOID) continue;
    const name = u30OperandName(inst, abc.multinameNames);
    if (name === null || !DROPPED_CALLS.includes(name)) break;
    dropped.push(name);
    last = i;
  }
  if (dropped.length !== DROPPED_CALLS.length) {
    throw new PatchError(
      `${HOST_METHOD} does not end in ${DROPPED_CALLS.join(" + ")} (found ${dropped.join(", ") || "nothing"})`,
    );
  }

  const readMultiname = packetReadMultiname(abc, ctx, classIdx);
  const start = argument.offset;
  const end = instructions[last].offset + instructions[last].size;

  const replacement = Buffer.concat([
    Buffer.from([OP_GETLOCAL1]),
    Buffer.from([OP_CALLPROPERTY]), writeU30(readMultiname), writeU30(0),
    Buffer.from([OP_CALLPROPVOID]), writeU30(call.operands[0][1]), writeU30(call.operands[1][1]),
  ]);
  if (replacement.length > end - start) {
    throw new PatchError(`replacement is ${replacement.length} bytes, only ${end - start} available`);
  }
  const padded = Buffer.concat([replacement, Buffer.alloc(end - start - replacement.length, OP_NOP)]);

  console.log(
    `${HOST_CLASS}.${HOST_METHOD}: bytes ${start}..${end} (${end - start}) -> ` +
      `getlocal1 + callproperty ${READ_CALL} + callpropvoid ${TARGET_CALL} + ${padded.length - replacement.length} nop` +
      `, dropping ${dropped.join(" and ")}`,
  );
  if (verify) {
    console.log("verify only - no file written.");
    return;
  }

  const patched = applyPatchesToBody(ctx.body, [
    { key: `${HOST_CLASS}.${HOST_METHOD}`, detail: `${TARGET_CALL} takes its deadline off the packet`, start: body.codeStart + start, end: body.codeStart + end, data: padded },
  ]);
  if (patched.delta !== 0) throw new PatchError(`patch changed the body length by ${patched.delta}; refusing`);

  ensureBackup(CLIENT_SWF);
  writeSwf(ctx, patched.body, 0);
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
