/**
 * Ends the seasonal panel's refresh where it has always effectively ended, instead
 * of on a TypeError.
 *
 * ## The error
 *
 *     TypeError: Error #1009: Cannot access a property or method of a null object reference.
 *         at class_32/method_12()
 *         at class_69/OnRefreshScreen()
 *         at class_32/Refresh()   at class_32/Display()   at Game/method_668()
 *
 * `class_69` is the Class Tower screen class, bound to `a_ScreenHalloweenDungeonPrompt`
 * (see `patch-hallows-eve-challenge-screen.ts`). Everything it reaches for on that panel
 * is an empty dummy this project minted, and the spec that mints them deliberately stops
 * at the children `OnCreateScreen` touches. `OnRefreshScreen` reaches for one more:
 *
 *     mStatus == const_200:  method_12(var_617.mMovieClip.am_IconHolder, "a_TalentPointIcon")
 *     otherwise:             method_14(var_617.mMovieClip.am_IconHolder)
 *
 * `am_IconHolder` is the Class Tower's talent-point icon slot. It is not on this panel,
 * both helpers open with `param1.numChildren`, and so **both branches have always thrown
 * here** - the idle one since the panel first opened, and now the busy one too, because
 * the twelve-hour clock finally puts the panel into that state
 * (`HallowsEve.sendCooldownTimer`).
 *
 * ## Why the fix is a `returnvoid` and not a dummy
 *
 * The obvious repair - mint `am_IconHolder` like the rest - is the risky one. It would
 * let `OnRefreshScreen` run *past* a line that has never been reached in this build, into
 * the Class Tower tail: `mBuildingInfo.GetBuildingByMasterClass`, `UpdateBuildingUpgradePanel`
 * and a `displayName.indexOf(" Level")` on whatever that returns. None of it draws anything
 * on this panel, all of it is untested here, and any one of those is another #1009 - only
 * later, and in code that is far harder to reason about than a missing child.
 *
 * So each of the two call blocks is replaced by a single `returnvoid`, padded with `nop`:
 *
 *   - Every `Show`/`Hide` the two panel states need happens **before** these calls - the
 *     busy branch has already shown `am_ResearchProgressPanel` and hidden `am_Notice`, the
 *     idle branch the reverse - so the panel is fully arranged by the time the method ends.
 *   - What follows in each branch is either a repeat of a decision already made
 *     (`if (var_1045)`, which the same branch settled a dozen lines earlier) or work on
 *     dummies, and **none of it has ever executed**, because the throw was always here.
 *
 *  That makes this exactly today's behaviour with the exception removed, rather than a new
 *  code path.
 *
 * Each block begins at a statement boundary, so the operand stack is empty where the
 * `returnvoid` lands, and nothing live branches past it: the only jumps into that stretch
 * come from inside it. The body length never changes, so no branch offset moves.
 *
 * Usage: npm exec ts-node scripts/patch-dungeonblitz-hallows-eve-refresh-guard.ts [--verify]
 *
 * Re-runnable: it checks for its own result first.
 */
import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  BytePatch,
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
const HOST_METHOD = "OnRefreshScreen";

/** The child that is not on this panel, and the two helpers that dereference it. */
const MISSING_CHILD = "am_IconHolder";
const HELPERS = ["method_12", "method_14"];

const OP_NOP = 0x02;
const OP_RETURNVOID = 0x47;
const OP_CALLPROPVOID = 0x4f;
const OP_FINDPROPSTRICT = 0x5d;

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

  const patches: BytePatch[] = [];
  for (let i = 0; i < instructions.length; i += 1) {
    if (u30OperandName(instructions[i], abc.multinameNames) !== MISSING_CHILD) continue;

    /**
     * The statement the dereference belongs to.
     *
     * `findpropstrict <helper>` is where the call is built from, and it is the first
     * instruction of the statement - which is what makes the operand stack empty there.
     * The block runs to the matching `callpropvoid`, and both ends have to name the same
     * helper or this is not the shape that was read.
     */
    let start = -1;
    let helper: string | null = null;
    for (let back = i - 1; back >= 0 && back >= i - 8; back -= 1) {
      if (instructions[back].opcode !== OP_FINDPROPSTRICT) continue;
      const name = u30OperandName(instructions[back], abc.multinameNames);
      if (name === null || !HELPERS.includes(name)) break;
      start = back;
      helper = name;
      break;
    }
    if (start === -1 || helper === null) {
      throw new PatchError(`the ${MISSING_CHILD} read at ${instructions[i].offset} is not a ${HELPERS.join("/")} call`);
    }

    let end = -1;
    for (let ahead = i + 1; ahead < instructions.length && ahead <= i + 8; ahead += 1) {
      if (instructions[ahead].opcode !== OP_CALLPROPVOID) continue;
      if (u30OperandName(instructions[ahead], abc.multinameNames) !== helper) break;
      end = ahead;
      break;
    }
    if (end === -1) throw new PatchError(`the ${helper}(${MISSING_CHILD}) call at ${instructions[i].offset} has no end`);

    const from = instructions[start].offset;
    const to = instructions[end].offset + instructions[end].size;
    patches.push({
      key: `${HOST_CLASS}.${HOST_METHOD}@${from}`,
      detail: `${helper}(${MISSING_CHILD}) -> returnvoid + ${to - from - 1} nop`,
      start: body.codeStart + from,
      end: body.codeStart + to,
      data: Buffer.concat([Buffer.from([OP_RETURNVOID]), Buffer.alloc(to - from - 1, OP_NOP)]),
    });
  }

  if (patches.length === 0) {
    console.log(`${HOST_METHOD} no longer touches ${MISSING_CHILD}; nothing to do.`);
    return;
  }
  if (patches.length !== HELPERS.length) {
    throw new PatchError(
      `expected ${HELPERS.length} ${MISSING_CHILD} sites (one per panel state), found ${patches.length}`,
    );
  }
  for (const patch of patches) console.log(`${patch.key}: ${patch.detail}`);
  if (verify) {
    console.log("verify only - no file written.");
    return;
  }

  const patched = applyPatchesToBody(ctx.body, patches);
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
