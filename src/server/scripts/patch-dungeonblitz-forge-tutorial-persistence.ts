#!/usr/bin/env node

import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  ensureBackup,
  Instruction,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  readU30,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

// The Charms Forge tutorial replays after every client restart. The tutorial's
// completed-bit lives only on Game.mTutorialsCompletedList, an in-memory bitmask,
// so a relog clears it. On world enter the client re-derives bits from game state
// in class_89.CheckCompletedTutorials, but the forge block restored its bit only
// while a forge was *actively* crafting:
//
//     if (Game.mMagicForgeStatus.GetCurrentlyCrafting()) {
//         Game.mTutorialsCompletedList |= class_89.const_138; // forge tutorial bit
//     }
//
// GetCurrentlyCrafting() returns the charm currently in the forge, which is 0 for
// the idle forge every player has after login. So the bit never came back, and the
// tutorial fired again the next time the forge screen opened.
//
// This patch swaps that transient condition for the persistent craft XP the server
// already sends at world enter: a player who has forged even once (the tutorial's
// whole point) has craftXP > 0 forever, so the bit is restored and the tutorial
// plays exactly once.
//
//     if (Game.mCraftTalentData.craftXP) {
//         Game.mTutorialsCompletedList |= class_89.const_138;
//     }
//
// The replacement is exactly the same length as the code it replaces (11 bytes),
// so no branch offset anywhere in the method moves.
//
// History: the first fix for this (#628 / #644) persisted the whole bitmask in the
// client's dbSavedGameData SharedObject. That SWF could not enter the world -- the
// client authenticated, parsed its first level, then tore down the socket. Root
// cause was never found (an AVM2 error needs a debug Flash player; ruled out were
// the null SharedObject dereference, max_stack, and the multiname namespaces).
// That script is now deliberately disabled (DB_FORGE_TUTORIAL_PATCH_ANYWAY) and
// this in-place rewrite replaces it entirely -- no SharedObject access, no inserted
// code, just the condition swap above.
const DEFAULT_SWF = path.resolve(
  __dirname,
  "..",
  "..",
  "client",
  "content",
  "localhost",
  "p",
  "cbp",
  "DungeonBlitz.swf",
);
const INDEX_HTML = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "index.html");

const TUTORIAL_CLASS = "class_89";
const TUTORIAL_CHECK_METHOD = "CheckCompletedTutorials";

// Resolved per-SWF by name; these are the names the client ships with.
const NAME_FORGE_BIT = "const_138";
const NAME_MAGIC_FORGE_STATUS = "mMagicForgeStatus";
const NAME_GET_CURRENTLY_CRAFTING = "GetCurrentlyCrafting";
const NAME_CRAFT_TALENT_DATA = "mCraftTalentData";
const NAME_CRAFT_XP = "craftXP";
const NAME_TUTORIALS_COMPLETED = "mTutorialsCompletedList";
const NAME_VAR_1 = "var_1";

const OP_GETLEX = 0x60;
const OP_GETPROPERTY = 0x66;
const OP_CALLPROPERTY = 0x46;
const OP_CONVERT_B = 0x76;
const OP_LABEL = 0x09;
const OP_IFFALSE = 0x12;

/**
 * The unpatched forge-tutorial restore condition:
 *   getlex var_1; getproperty mMagicForgeStatus; callproperty GetCurrentlyCrafting,0; convert_b; label
 */
function unpatchedSequence(abc: ReturnType<typeof parseAbc>, mns: Record<string, number>): Buffer {
  return Buffer.concat([
    Buffer.from([OP_GETLEX]), writeU30(mns[NAME_VAR_1]),
    Buffer.from([OP_GETPROPERTY]), writeU30(mns[NAME_MAGIC_FORGE_STATUS]),
    Buffer.from([OP_CALLPROPERTY]), writeU30(mns[NAME_GET_CURRENTLY_CRAFTING]), writeU30(0),
    Buffer.from([OP_CONVERT_B]),
    Buffer.from([OP_LABEL]),
  ]);
}

/**
 * The patched condition, same byte length (11):
 *   getlex var_1; getproperty mCraftTalentData; getproperty craftXP; convert_b; label; label
 */
function patchedSequence(abc: ReturnType<typeof parseAbc>, mns: Record<string, number>): Buffer {
  return Buffer.concat([
    Buffer.from([OP_GETLEX]), writeU30(mns[NAME_VAR_1]),
    Buffer.from([OP_GETPROPERTY]), writeU30(mns[NAME_CRAFT_TALENT_DATA]),
    Buffer.from([OP_GETPROPERTY]), writeU30(mns[NAME_CRAFT_XP]),
    Buffer.from([OP_CONVERT_B]),
    Buffer.from([OP_LABEL]),
    Buffer.from([OP_LABEL]),
  ]);
}

function resolveMultinames(abc: ReturnType<typeof parseAbc>, names: string[]): Record<string, number> {
  const indices: Record<string, number> = {};
  for (const name of names) {
    const matches: number[] = [];
    for (let index = 0; index < abc.multinameNames.length; index += 1) {
      if (abc.multinameNames[index] === name) {
        matches.push(index);
      }
    }
    if (matches.length !== 1) {
      throw new PatchError(`Expected one multiname ${name}, found ${matches.length}`);
    }
    indices[name] = matches[0];
  }
  return indices;
}

/**
 * var_1 is a common obfuscator name; resolve it to the single index this method
 * actually references via getlex, mirroring how the original patch located it.
 */
function resolveVar1InMethod(
  abc: ReturnType<typeof parseAbc>,
  code: Buffer,
  candidates: number[],
): number {
  const referenced = new Set(
    disassemble(code, `${TUTORIAL_CLASS}.${TUTORIAL_CHECK_METHOD}`)
      .filter((inst) => inst.opcode === OP_GETLEX && candidates.includes(inst.operands[0]?.[1] ?? -1))
      .map((inst) => inst.operands[0][1]),
  );
  if (referenced.size !== 1) {
    throw new PatchError(
      `Expected ${TUTORIAL_CHECK_METHOD} to reference one var_1 multiname via getlex, found ${referenced.size}`,
    );
  }
  return [...referenced][0];
}

/**
 * Locates the forge-tutorial OR-in block inside CheckCompletedTutorials and the
 * condition region right before it.
 *
 * The anchor is `getlex const_138` (the forge tutorial bit) inside
 *   getlex var_1; getlex var_1; getproperty mTutorialsCompletedList; getlex const_138; bitor; setproperty ...
 * which is unique in the method. Because the patch is length-preserving, the byte
 * coordinates of the surrounding region are identical before and after patching.
 */
function findForgeRestoreRegion(
  abc: ReturnType<typeof parseAbc>,
  code: Buffer,
  mns: Record<string, number>,
): { start: number; end: number; patched: boolean } {
  const instructions = disassemble(code, `${TUTORIAL_CLASS}.${TUTORIAL_CHECK_METHOD}`);
  // The OR-in block is `getlex var_1; getlex var_1; getproperty mTutorialsCompletedList;
  // getlex const_138; bitor; setproperty mTutorialsCompletedList`. The same bit is also
  // *compared* later in the method, so anchor on the one that feeds a bitor.
  const anchors = instructions.filter(
    (inst, index) =>
      inst.opcode === OP_GETLEX &&
      inst.operands[0]?.[1] === mns[NAME_FORGE_BIT] &&
      instructions[index + 1]?.opcode === 0xa9, // bitor
  );
  if (anchors.length !== 1) {
    throw new PatchError(
      `Expected one ${NAME_FORGE_BIT} bitor in ${TUTORIAL_CHECK_METHOD}, found ${anchors.length}`,
    );
  }
  const bitLoad = anchors[0];

  // The block reads `getlex var_1; getlex var_1; getproperty mTutorialsCompletedList` before the bit.
  const completedLoad = instructions.find(
    (inst) => inst.offset === bitLoad.offset - 3 &&
      inst.opcode === OP_GETPROPERTY &&
      inst.operands[0]?.[1] === mns[NAME_TUTORIALS_COMPLETED],
  );
  if (!completedLoad) {
    throw new PatchError(`Forge tutorial bit is not OR-ed into ${NAME_TUTORIALS_COMPLETED} as expected`);
  }
  const blockStart = completedLoad.offset - 2 - 2; // two getlex var_1 (2 bytes each) precede it

  // The condition region is 11 bytes, immediately before the `iffalse` that guards the OR-in.
  const guardOffset = blockStart - 4;
  const guard = instructions.find((inst) => inst.offset === guardOffset && inst.opcode === OP_IFFALSE);
  if (!guard) {
    throw new PatchError(`Forge tutorial OR-in is not guarded by an iffalse at 0x${guardOffset.toString(16)}`);
  }

  const start = guardOffset - 11;
  const end = guardOffset;
  if (start < 0 || end > code.length) {
    throw new PatchError(`Forge tutorial condition region out of bounds: ${start}:${end}`);
  }

  const region = code.subarray(start, end);
  const unpatched = unpatchedSequence(abc, mns);
  const patched = patchedSequence(abc, mns);
  if (region.equals(unpatched)) {
    return { start, end, patched: false };
  }
  if (region.equals(patched)) {
    return { start, end, patched: true };
  }
  throw new PatchError(
    `Forge tutorial condition at 0x${start.toString(16)} matches neither the stock nor the patched form`,
  );
}

function resolveSymbols(ctx: ReturnType<typeof parseSwf>, abc: ReturnType<typeof parseAbc>): { mns: Record<string, number>; code: Buffer } {
  const mns = resolveMultinames(abc, [
    NAME_FORGE_BIT,
    NAME_MAGIC_FORGE_STATUS,
    NAME_GET_CURRENTLY_CRAFTING,
    NAME_CRAFT_TALENT_DATA,
    NAME_CRAFT_XP,
    NAME_TUTORIALS_COMPLETED,
  ]);
  const { code } = getTutorialCheck(ctx, abc);
  const var1Candidates = abc.multinameNames
    .map((name, index) => (name === NAME_VAR_1 ? index : -1))
    .filter((index) => index >= 0);
  mns[NAME_VAR_1] = resolveVar1InMethod(abc, code, var1Candidates);
  return { mns, code };
}

function verifySwf(swfPath: string): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const { mns, code } = resolveSymbols(ctx, abc);
  const region = findForgeRestoreRegion(abc, code, mns);
  if (!region.patched) {
    throw new PatchError(
      "Forge tutorial restore still keys on an actively-crafting forge (GetCurrentlyCrafting) instead of persistent craft XP.",
    );
  }
  console.log("Forge tutorial persistence patch verified (restore keyed on craft XP).");
}

function getTutorialCheck(
  ctx: ReturnType<typeof parseSwf>,
  abc: ReturnType<typeof parseAbc>,
): { code: Buffer; bodyStart: number } {
  const classIndex = classIndexByName(abc, TUTORIAL_CLASS);
  if (classIndex === null) {
    throw new PatchError(`Class ${TUTORIAL_CLASS} not found`);
  }
  const methodIndex = methodIdxForTrait(abc.instances[classIndex].traits, abc, TUTORIAL_CHECK_METHOD);
  if (methodIndex === null) {
    throw new PatchError(`Method ${TUTORIAL_CLASS}.${TUTORIAL_CHECK_METHOD} not found`);
  }
  const body = abc.methodBodies.get(methodIndex);
  if (!body) {
    throw new PatchError(`Method body ${TUTORIAL_CLASS}.${TUTORIAL_CHECK_METHOD} not found`);
  }
  const code = Buffer.from(ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen));
  // The verifier's max_stack must cover the new getproperty chain (needs 2 slots; the
  // method already declares 5).
  const [maxStack] = readU30(ctx.body, body.maxStackPos, `${TUTORIAL_CHECK_METHOD}.max_stack`);
  if (maxStack < 3) {
    throw new PatchError(`${TUTORIAL_CLASS}.${TUTORIAL_CHECK_METHOD} max_stack ${maxStack} is below 3`);
  }
  return { code, bodyStart: body.codeStart };
}

/**
 * Moves index.html's cache-busting token to match the SWF that was just written.
 * Leave the token alone and browsers keep loading the old SWF.
 */
function syncClientRev(swfPath: string): void {
  if (path.resolve(swfPath) !== DEFAULT_SWF || !fs.existsSync(INDEX_HTML)) return;
  const digest = crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const updated = html.replace(/clientrev=[^&`"'$]+/, `clientrev=swf-${digest}`);
  if (updated !== html) {
    fs.writeFileSync(INDEX_HTML, updated);
    console.log(`  index.html clientrev -> swf-${digest} (cache buster)`);
  }
}

function patchSwf(swfPath: string, verify: boolean): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const { mns, code } = resolveSymbols(ctx, abc);
  const bodyStart = getTutorialCheck(ctx, abc).bodyStart;
  const region = findForgeRestoreRegion(abc, code, mns);

  if (verify) {
    verifySwf(swfPath);
    return;
  }
  if (region.patched) {
    console.log("Forge tutorial persistence patch already applied.");
    verifySwf(swfPath);
    return;
  }

  const patches: BytePatch[] = [{
    key: "forge-tutorial-restore-craft-xp",
    start: bodyStart + region.start,
    end: bodyStart + region.end,
    data: patchedSequence(abc, mns),
    detail: "restore the forge tutorial bit from persistent craft XP instead of an active forge",
  }];

  ensureBackup(swfPath);
  const { body: patchedBody, delta } = applyPatchesToBody(ctx.body, patches);
  if (delta !== 0) {
    throw new PatchError(`Expected a length-preserving patch, got delta ${delta}.`);
  }
  writeSwf(ctx, patchedBody, delta);
  syncClientRev(swfPath);
  verifySwf(swfPath);
  console.log("Forge tutorial persistence patch applied (restore keyed on craft XP).");
}

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
    } else if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  ts-node src/server/scripts/patch-dungeonblitz-forge-tutorial-persistence.ts [--verify] [--swf <path>]",
        "",
        "Restores the Charms Forge tutorial's completed bit from the player's persistent craft XP",
        "so the tutorial plays once instead of after every client restart.",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new PatchError(`Unknown argument: ${arg}`);
    }
  }
  return { swfPath, verify };
}

const { swfPath, verify } = parseArgs(process.argv);
if (!fs.existsSync(swfPath)) {
  throw new PatchError(`SWF not found: ${swfPath}`);
}
patchSwf(swfPath, verify);
