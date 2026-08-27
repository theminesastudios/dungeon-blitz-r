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
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

/**
 * Prevent the local player's master mana from becoming negative.
 *
 * ActivePower.method_716 spends master mana after a cast finishes. Cast eligibility is checked
 * earlier, so two powers queued around a temporary full-mana buff expiring can both pass that
 * check and later spend from the reduced pool. The original spend path reports and draws the
 * negative result before any later code can repair it:
 *
 *   this.var_4.var_31 -= _loc1_;
 *   this.var_1.method_114(this.var_4.var_31);
 *
 * Insert the same zero floor already used by the mana-gain path immediately after the subtraction,
 * before the HUD update and the client mana packet are emitted.
 */

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

const OP_PUSHBYTE = 0x24;
const OP_GETPROPERTY = 0x66;
const OP_SETPROPERTY = 0x61;
const OP_SUBTRACT = 0xa1;
const OP_IFGE = 0x18;
const OP_LOOKUPSWITCH = 0x1b;
const OP_GETLOCAL_0 = 0xd0;

const BRANCH_OPCODES = new Set([
  0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
  0x18, 0x19, 0x1a,
]);

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") swfPath = path.resolve(argv[++index] || "");
    else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npm exec tsx src/server/scripts/patch-dungeonblitz-nonnegative-mana.ts [--verify] [--swf <path>]",
        "",
        "Clamps master mana to zero immediately after ActivePower spends it.",
      ].join("\n"));
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify };
}

function u30Index(inst: Instruction): number | null {
  const operand = inst.operands[0];
  return operand?.[0] === "u30" ? operand[1] : null;
}

function writeS24(value: number): Buffer {
  if (value < -0x800000 || value > 0x7fffff) {
    throw new PatchError(`Branch displacement ${value} does not fit in s24.`);
  }
  const encoded = value < 0 ? value + 0x1000000 : value;
  return Buffer.from([encoded & 0xff, (encoded >>> 8) & 0xff, (encoded >>> 16) & 0xff]);
}

function expectedClientRevision(swfPath: string): string {
  return crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
}

function clientRevisionIsCurrent(swfPath: string): boolean {
  return path.resolve(swfPath) !== DEFAULT_SWF ||
    !fs.existsSync(INDEX_HTML) ||
    fs.readFileSync(INDEX_HTML, "utf8").includes(`clientrev=swf-${expectedClientRevision(swfPath)}`);
}

function syncClientRevision(swfPath: string): void {
  if (path.resolve(swfPath) !== DEFAULT_SWF || !fs.existsSync(INDEX_HTML)) return;
  const revision = expectedClientRevision(swfPath);
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const updated = html.replace(/clientrev=[^&`"'$]+/, `clientrev=swf-${revision}`);
  if (updated === html) {
    if (!html.includes(`clientrev=swf-${revision}`)) {
      throw new PatchError("Could not update the DungeonBlitz.swf client revision in index.html.");
    }
    return;
  }
  fs.writeFileSync(INDEX_HTML, updated);
  console.log(`Updated index.html client revision to swf-${revision}`);
}

function findMethod(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "ActivePower");
  if (classIndex === null) throw new PatchError("ActivePower class not found.");
  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_716");
  if (methodIdx === null) throw new PatchError("ActivePower.method_716 not found.");
  const body = abc.methodBodies.get(methodIdx);
  if (!body) throw new PatchError(`ActivePower.method_716 body not found (${methodIdx}).`);
  if (body.exceptionCount !== 0) {
    throw new PatchError("ActivePower.method_716 unexpectedly has an exception table; refusing to shift it.");
  }
  const code = Buffer.from(ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen));
  const instructions = disassemble(code, "ActivePower.method_716");
  if (instructions.some((inst) => inst.opcode === OP_LOOKUPSWITCH)) {
    throw new PatchError("ActivePower.method_716 unexpectedly contains lookupswitch; refusing to shift it.");
  }
  return { ctx, abc, body, code, instructions };
}

function findSpendStore(
  instructions: Instruction[],
  var31: number,
): { instruction: Instruction; index: number } {
  const matches = instructions
    .map((instruction, index) => ({ instruction, index }))
    .filter(({ instruction, index }) =>
      instruction.opcode === OP_SETPROPERTY &&
      u30Index(instruction) === var31 &&
      instructions.slice(Math.max(0, index - 5), index).some((item) => item.opcode === OP_SUBTRACT),
    );
  if (matches.length !== 1) {
    throw new PatchError(`Expected one master-mana subtraction store, found ${matches.length}.`);
  }
  return matches[0];
}

function isClampAt(
  instructions: Instruction[],
  startIndex: number,
  var4: number,
  var31: number,
): boolean {
  const expected: Array<[number, number | null]> = [
    [OP_GETLOCAL_0, null],
    [OP_GETPROPERTY, var4],
    [OP_GETPROPERTY, var31],
    [OP_PUSHBYTE, 0],
    [OP_IFGE, null],
    [OP_GETLOCAL_0, null],
    [OP_GETPROPERTY, var4],
    [OP_PUSHBYTE, 0],
    [OP_SETPROPERTY, var31],
  ];
  return expected.every(([opcode, operand], offset) => {
    const instruction = instructions[startIndex + offset];
    return instruction?.opcode === opcode && (operand === null || instruction.operands[0]?.[1] === operand);
  });
}

function buildClamp(var4: number, var31: number): Buffer {
  const setZero = Buffer.concat([
    Buffer.from([OP_GETLOCAL_0, OP_GETPROPERTY]), writeU30(var4),
    Buffer.from([OP_PUSHBYTE, 0, OP_SETPROPERTY]), writeU30(var31),
  ]);
  return Buffer.concat([
    Buffer.from([OP_GETLOCAL_0, OP_GETPROPERTY]), writeU30(var4),
    Buffer.from([OP_GETPROPERTY]), writeU30(var31),
    Buffer.from([OP_PUSHBYTE, 0, OP_IFGE]), writeS24(setZero.length),
    setZero,
  ]);
}

function insertCodeAndRetargetBranches(
  code: Buffer,
  instructions: Instruction[],
  insertAt: number,
  inserted: Buffer,
): Buffer {
  const adjusted = Buffer.from(code);
  for (const instruction of instructions) {
    if (!BRANCH_OPCODES.has(instruction.opcode)) continue;
    const operand = instruction.operands[0];
    if (!operand || operand[0] !== "s24") {
      throw new PatchError(`Malformed branch at byte ${instruction.offset}.`);
    }
    const oldTarget = instruction.offset + instruction.size + operand[1];
    const newSource = instruction.offset + (instruction.offset >= insertAt ? inserted.length : 0);
    const newTarget = oldTarget + (oldTarget >= insertAt ? inserted.length : 0);
    const displacement = newTarget - (newSource + instruction.size);
    if (displacement !== operand[1]) {
      writeS24(displacement).copy(adjusted, instruction.offset + 1);
    }
  }
  return Buffer.concat([adjusted.subarray(0, insertAt), inserted, adjusted.subarray(insertAt)]);
}

function inspect(swfPath: string) {
  const method = findMethod(swfPath);
  const var4 = method.abc.multinameNames.indexOf("var_4");
  const var31 = method.abc.multinameNames.indexOf("var_31");
  if (var4 < 0 || var31 < 0) throw new PatchError("Required Entity mana multinames were not found.");
  const spend = findSpendStore(method.instructions, var31);
  const alreadyPatched = isClampAt(method.instructions, spend.index + 1, var4, var31);
  return { ...method, var4, var31, spend, alreadyPatched };
}

export function patchNonnegativeMana(swfPath: string, verifyOnly = false): void {
  const first = inspect(swfPath);
  if (verifyOnly) {
    if (!first.alreadyPatched) throw new PatchError("Master-mana zero floor is missing.");
    if (!clientRevisionIsCurrent(swfPath)) throw new PatchError("index.html has a stale DungeonBlitz.swf client revision.");
    console.log(`Verified nonnegative master mana in ${swfPath}`);
    return;
  }
  if (first.alreadyPatched) {
    syncClientRevision(swfPath);
    console.log(`Already patched nonnegative master mana in ${swfPath}`);
    return;
  }

  const insertAt = first.spend.instruction.offset + first.spend.instruction.size;
  const clamp = buildClamp(first.var4, first.var31);
  const patchedCode = insertCodeAndRetargetBranches(first.code, first.instructions, insertAt, clamp);
  const oldCodeLen = writeU30(first.body.codeLen);
  const patches: BytePatch[] = [
    {
      key: "ActivePower.method_716.code",
      start: first.body.codeStart,
      end: first.body.codeStart + first.body.codeLen,
      data: patchedCode,
      detail: "clamp master mana to zero before reporting and drawing it",
    },
    {
      key: "ActivePower.method_716.codeLen",
      start: first.body.codeLenPos,
      end: first.body.codeLenPos + oldCodeLen.length,
      data: writeU30(patchedCode.length),
      detail: `update code length ${first.body.codeLen} -> ${patchedCode.length}`,
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(first.ctx.body, patches);
  writeSwf(first.ctx, body, delta);
  syncClientRevision(swfPath);

  const verified = inspect(swfPath);
  if (!verified.alreadyPatched) throw new PatchError("Master-mana zero floor verification failed.");
  console.log(`Patched nonnegative master mana in ${swfPath}`);
}

if (require.main === module) {
  const { swfPath, verify } = parseArgs(process.argv);
  try {
    patchNonnegativeMana(swfPath, verify);
  } catch (error) {
    console.error(`[patch-dungeonblitz-nonnegative-mana] ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
