/**
 * Stops the countdown from recolouring a glow that is not on it.
 *
 * ## The error
 *
 *     TypeError: Error #1009: Cannot access a property or method of a null object reference.
 *         at MathUtil$/method_8()
 *         at class_69/OnTickScreen()
 *         at class_32/method_434()   ...   at Main/method_1284()
 *
 * `MathUtil.method_8` is the "write this string in this colour" helper, and its fourth
 * argument is a glow colour:
 *
 *     public static function method_8(param1:TextField, param2:String, param3:uint, param4:int = -1) {
 *        if (!param1) return;
 *        param1.textColor = param3;
 *        if (param4 > -1) {
 *           _loc5_ = param1.filters[0];      // <- nothing here, so undefined
 *           _loc5_.color = param4;           // <- #1009
 *           param1.filters = [_loc5_];
 *        }
 *        method_2(param1, param2);
 *     }
 *
 * It does not check that the field *has* a filter. Every field the Class Tower screen
 * writes through it was authored with a glow; `am_Timer`, the seasonal panel's own clock
 * (`patch-hallows-eve-panel-timer.ts` puts it where `OnTickScreen` writes the countdown),
 * was not. So the very first tick after the twelve-hour clock goes up throws - once per
 * frame, which is what makes it read as a crash rather than a glitch.
 *
 * ## The patch
 *
 * The fourth argument of that one call becomes a literal `-1`, which is the value the
 * signature itself defaults to and the value every caller that does not want a glow
 * passes:
 *
 *     getlex ScreenArmory; getproperty const_47    ->    pushbyte -1; nop nop ...
 *
 * `param3` is untouched, so the countdown still gets its colour from `param1.textColor`;
 * only the glow recolour - which had nothing to recolour - is skipped. One value on the
 * stack becomes one value on the stack, the literal is shorter than the pair it replaces,
 * so the body length is unchanged and no branch offset moves.
 *
 * Only the `am_Time` call is touched. The other `method_8` calls in `OnTickScreen` write
 * `am_Gold`, `am_Gold2` and the panel's own `am_Time`, none of which exist on this panel,
 * and `method_8` returns on a null field before it reaches the filter.
 *
 * Usage: npm exec ts-node scripts/patch-dungeonblitz-hallows-eve-timer-glow.ts [--verify]
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
} from "./swfPatchUtils";

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content", "localhost");
const CLIENT_SWF = path.join(CLIENT_CONTENT, "p", "cbp", "DungeonBlitz.swf");
const INDEX_HTML = path.join(CLIENT_CONTENT, "index.html");

const HOST_CLASS = "class_69";
const HOST_METHOD = "OnTickScreen";

/** The write, and the field it writes: the panel's countdown. */
const WRITE_CALL = "method_8";
const CLOCK_FIELD = "am_Time";
const CLOCK_OWNER = "var_1238";

const OP_NOP = 0x02;
const OP_PUSHBYTE = 0x24;
const OP_CALLPROPVOID = 0x4f;
const OP_GETPROPERTY = 0x66;

/** `pushbyte` sign-extends its operand, so 0xff is the -1 the signature defaults to. */
const NO_GLOW = 0xff;

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

  /**
   * The one call that writes a field that really exists.
   *
   * Found by its receiver rather than by position: `var_1238.mMovieClip.am_Time` is the
   * progress panel's clock, and it is the only `method_8` target on this panel that is
   * not null.
   */
  let field = -1;
  for (let i = 2; i < instructions.length; i += 1) {
    if (instructions[i].opcode !== OP_GETPROPERTY) continue;
    if (u30OperandName(instructions[i], abc.multinameNames) !== CLOCK_FIELD) continue;
    if (u30OperandName(instructions[i - 2], abc.multinameNames) !== CLOCK_OWNER) continue;
    field = i;
    break;
  }
  if (field === -1) throw new PatchError(`${HOST_METHOD} does not write ${CLOCK_OWNER}.mMovieClip.${CLOCK_FIELD}`);

  let call = -1;
  for (let i = field + 1; i < instructions.length && i <= field + 12; i += 1) {
    if (instructions[i].opcode !== OP_CALLPROPVOID) continue;
    if (u30OperandName(instructions[i], abc.multinameNames) !== WRITE_CALL) {
      throw new PatchError(`the ${CLOCK_FIELD} write is not a ${WRITE_CALL} call`);
    }
    call = i;
    break;
  }
  if (call === -1) throw new PatchError(`the ${CLOCK_FIELD} write has no ${WRITE_CALL} call`);
  if (instructions[call].operands[1][1] !== 4) {
    throw new PatchError(`the ${CLOCK_FIELD} write takes ${instructions[call].operands[1][1]} arguments, expected 4`);
  }

  /**
   * The fourth argument: `getlex ScreenArmory` + `getproperty const_47`, the glow colour.
   *
   * The nops an earlier pass leaves sit *after* the literal, so the argument is the last
   * instruction before the call that is not one of them.
   */
  let value = call - 1;
  while (value > 0 && instructions[value].opcode === OP_NOP) value -= 1;
  const glowValue = instructions[value];
  const glowClass = instructions[value - 1];
  if (glowValue.opcode === OP_PUSHBYTE) {
    console.log(`${HOST_METHOD} already passes a literal glow colour; nothing to do.`);
    return;
  }
  if (glowValue.opcode !== OP_GETPROPERTY) {
    throw new PatchError(`the glow colour is not a property read; refusing to patch an unknown shape`);
  }

  const start = glowClass.offset;
  const end = glowValue.offset + glowValue.size;
  const data = Buffer.concat([Buffer.from([OP_PUSHBYTE, NO_GLOW]), Buffer.alloc(end - start - 2, OP_NOP)]);
  if (end - start < 2) throw new PatchError(`only ${end - start} bytes available for the literal`);

  console.log(
    `${HOST_CLASS}.${HOST_METHOD}: ${CLOCK_FIELD}'s glow colour ` +
      `(${u30OperandName(glowClass, abc.multinameNames)}.${u30OperandName(glowValue, abc.multinameNames)}) ` +
      `-> pushbyte -1 + ${data.length - 2} nop`,
  );
  if (verify) {
    console.log("verify only - no file written.");
    return;
  }

  const patched = applyPatchesToBody(ctx.body, [
    {
      key: `${HOST_CLASS}.${HOST_METHOD}`,
      detail: `${CLOCK_FIELD} is written without a glow recolour`,
      start: body.codeStart + start,
      end: body.codeStart + end,
      data,
    },
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
