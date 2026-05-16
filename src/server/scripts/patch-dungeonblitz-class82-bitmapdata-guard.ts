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
  u30OperandName,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

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

type Operand = [Instruction["operands"][number][0], number];
type InsertedInstruction =
  | { label: string }
  | { opcode: number; operands?: Operand[]; branchTo?: string };

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npm exec tsx src/server/scripts/patch-dungeonblitz-class82-bitmapdata-guard.ts [--verify] [--swf <path>]",
        "",
        "Patches class_82.method_193 so invalid MagicObject cache BitmapData",
        "dimensions return false instead of crashing Flash during ability rendering.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function writeS24(value: number): Buffer {
  const out = Buffer.alloc(3);
  let encoded = value;
  if (encoded < 0) {
    encoded += 1 << 24;
  }
  out[0] = encoded & 0xff;
  out[1] = (encoded >>> 8) & 0xff;
  out[2] = (encoded >>> 16) & 0xff;
  return out;
}

function isBranchOpcode(opcode: number): boolean {
  return opcode >= 0x0c && opcode <= 0x1a;
}

function operandBytes(kind: Operand[0], value: number): Buffer {
  if (kind === "u30") {
    return writeU30(value);
  }
  if (kind === "s8") {
    return Buffer.from([value & 0xff]);
  }
  if (kind === "s24") {
    return writeS24(value);
  }
  throw new PatchError(`Unsupported operand kind ${kind}`);
}

function assembleInserted(instructions: InsertedInstruction[]): Buffer {
  const labels = new Map<string, number>();
  let offset = 0;

  for (const inst of instructions) {
    if ("label" in inst) {
      labels.set(inst.label, offset);
      continue;
    }
    offset += 1;
    if (inst.branchTo) {
      offset += 3;
    } else {
      for (const [kind, value] of inst.operands ?? []) {
        offset += operandBytes(kind, value).length;
      }
    }
  }

  const chunks: Buffer[] = [];
  const fixups: Array<{ pos: number; target: string }> = [];
  offset = 0;

  for (const inst of instructions) {
    if ("label" in inst) {
      continue;
    }

    const parts: Buffer[] = [Buffer.from([inst.opcode])];
    offset += 1;

    if (inst.branchTo) {
      parts.push(Buffer.alloc(3));
      fixups.push({ pos: offset, target: inst.branchTo });
      offset += 3;
    } else {
      for (const [kind, value] of inst.operands ?? []) {
        const bytes = operandBytes(kind, value);
        parts.push(bytes);
        offset += bytes.length;
      }
    }

    chunks.push(Buffer.concat(parts));
  }

  const assembled = Buffer.concat(chunks);
  for (const fixup of fixups) {
    const target = labels.get(fixup.target);
    if (target === undefined) {
      throw new PatchError(`Unknown branch label ${fixup.target}`);
    }
    writeS24(target - (fixup.pos + 3)).copy(assembled, fixup.pos);
  }

  return assembled;
}

function applyCodeEditsAndAdjustBranches(
  originalCode: Buffer,
  instructions: Instruction[],
  edits: Array<{ start: number; end: number; data: Buffer }>,
): Buffer {
  const ordered = [...edits].sort((left, right) => left.start - right.start);
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const edit of ordered) {
    chunks.push(originalCode.subarray(cursor, edit.start));
    chunks.push(edit.data);
    cursor = edit.end;
  }
  chunks.push(originalCode.subarray(cursor));

  const patched = Buffer.concat(chunks);

  function deltaFor(edit: { start: number; end: number; data: Buffer }): number {
    return edit.data.length - (edit.end - edit.start);
  }

  function isInsideEdit(offset: number): boolean {
    return ordered.some((edit) => offset >= edit.start && offset < edit.end);
  }

  function mapInstructionOffset(offset: number): number {
    let mapped = offset;
    for (const edit of ordered) {
      if (edit.end <= offset || edit.start === edit.end && edit.start <= offset) {
        mapped += deltaFor(edit);
      }
    }
    return mapped;
  }

  function mapTargetOffset(offset: number): number {
    let mapped = offset;
    for (const edit of ordered) {
      if (offset < edit.start) {
        continue;
      }
      if (offset >= edit.start && offset < edit.end) {
        return edit.start + (mapped - offset);
      }
      if (offset === edit.end) {
        return edit.start + edit.data.length + (mapped - offset);
      }
      mapped += deltaFor(edit);
    }
    return mapped;
  }

  for (const inst of instructions) {
    if (!isBranchOpcode(inst.opcode) || isInsideEdit(inst.offset)) {
      continue;
    }

    const branch = inst.operands[0];
    if (branch?.[0] !== "s24") {
      throw new PatchError(`Unexpected branch operand at original offset ${inst.offset}`);
    }

    const oldEnd = inst.offset + inst.size;
    const oldTarget = oldEnd + branch[1];
    const newInstOffset = mapInstructionOffset(inst.offset);
    const newEnd = newInstOffset + inst.size;
    const newTarget = mapTargetOffset(oldTarget);
    writeS24(newTarget - newEnd).copy(patched, newInstOffset + 1);
  }

  return patched;
}

function getLocalOperand(inst: Instruction | undefined): number | null {
  if (!inst) {
    return null;
  }
  if (inst.opcode >= 0xd0 && inst.opcode <= 0xd3) {
    return inst.opcode - 0xd0;
  }
  if (inst.opcode === 0x62 && inst.operands[0]?.[0] === "u30") {
    return inst.operands[0][1];
  }
  return null;
}

function getLocal(localIndex: number): InsertedInstruction {
  if (localIndex >= 0 && localIndex <= 3) {
    return { opcode: 0xd0 + localIndex };
  }
  return { opcode: 0x62, operands: [["u30", localIndex]] };
}

function bitmapCacheDimensionGuard(widthLocal: number, heightLocal: number, totalPixelsIntIndex: number): InsertedInstruction[] {
  return [
    getLocal(widthLocal),
    getLocal(widthLocal),
    { opcode: 0xab }, // equals; NaN fails this check.
    { opcode: 0x12, branchTo: "invalid" },
    getLocal(heightLocal),
    getLocal(heightLocal),
    { opcode: 0xab },
    { opcode: 0x12, branchTo: "invalid" },
    getLocal(widthLocal),
    { opcode: 0x24, operands: [["s8", 1]] },
    { opcode: 0xad }, // lessthan
    { opcode: 0x11, branchTo: "invalid" },
    getLocal(heightLocal),
    { opcode: 0x24, operands: [["s8", 1]] },
    { opcode: 0xad },
    { opcode: 0x11, branchTo: "invalid" },
    getLocal(widthLocal),
    { opcode: 0x25, operands: [["u30", 8191]] },
    { opcode: 0xaf }, // greaterthan
    { opcode: 0x11, branchTo: "invalid" },
    getLocal(heightLocal),
    { opcode: 0x25, operands: [["u30", 8191]] },
    { opcode: 0xaf },
    { opcode: 0x11, branchTo: "invalid" },
    getLocal(widthLocal),
    getLocal(heightLocal),
    { opcode: 0xa2 }, // multiply
    { opcode: 0x2d, operands: [["u30", totalPixelsIntIndex]] },
    { opcode: 0xaf },
    { opcode: 0x12, branchTo: "ok" },
    { label: "invalid" },
    { opcode: 0x27 }, // pushfalse
    { opcode: 0x48 }, // returnvalue
    { label: "ok" },
  ];
}

function findRequiredInt(abc: ReturnType<typeof parseAbc>, value: number): number {
  const index = abc.intValues.findIndex((candidate) => candidate === value);
  if (index < 0) {
    throw new PatchError(`Int constant ${value} not found`);
  }
  return index;
}

function findBitmapDataConstructor(instructions: Instruction[], abc: ReturnType<typeof parseAbc>): Instruction {
  for (let index = 0; index < instructions.length - 5; index += 1) {
    const inst = instructions[index];
    if (inst.opcode !== 0x5d || u30OperandName(inst, abc.multinameNames) !== "BitmapData") {
      continue;
    }

    const width = instructions[index + 1];
    const height = instructions[index + 2];
    const pushTrue = instructions[index + 3];
    const pushZero = instructions[index + 4];
    const construct = instructions[index + 5];
    if (
      getLocalOperand(width) === 8 &&
      getLocalOperand(height) === 9 &&
      pushTrue.opcode === 0x26 &&
      pushZero.opcode === 0x24 &&
      pushZero.operands[0]?.[1] === 0 &&
      construct.opcode === 0x4a &&
      u30OperandName(construct, abc.multinameNames) === "BitmapData" &&
      construct.operands[1]?.[1] === 4
    ) {
      return inst;
    }
  }

  throw new PatchError("Could not find class_82.method_193 BitmapData constructor for locals 8/9");
}

function hasExactGuardBefore(code: Buffer, constructorOffset: number, guard: Buffer): boolean {
  return constructorOffset >= guard.length && code.subarray(constructorOffset - guard.length, constructorOffset).equals(guard);
}

function getMethod193(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "class_82");
  if (classIndex === null) {
    throw new PatchError("Could not find class_82 class.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_193");
  if (methodIdx === null) {
    throw new PatchError("Could not find class_82.method_193.");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find method body for class_82.method_193 (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `class_82.method_193:${methodIdx}`);
  return { ctx, abc, methodBody, code, instructions };
}

function writePatchedMethod(
  swfPath: string,
  ctx: ReturnType<typeof parseSwf>,
  methodBody: ReturnType<typeof getMethod193>["methodBody"],
  patchedCode: Buffer,
): void {
  const patches: BytePatch[] = [
    {
      key: "class_82.method_193.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "insert class_82 BitmapData dimension guard",
    },
    {
      key: "class_82.method_193.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: "update class_82.method_193 code length",
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, code, instructions } = getMethod193(swfPath);
  const ctor = findBitmapDataConstructor(instructions, abc);
  const guard = assembleInserted(bitmapCacheDimensionGuard(8, 9, findRequiredInt(abc, 16777215)));

  if (hasExactGuardBefore(code, ctor.offset, guard)) {
    console.log(`${swfPath}: already patched (class_82.method_193 BitmapData guard present).`);
    return;
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; class_82.method_193 BitmapData guard is missing.`);
  }

  if (methodBody.exceptionCount !== 0) {
    throw new PatchError("class_82.method_193 has exception ranges; refusing to insert without exception remapping.");
  }

  const patchedCode = applyCodeEditsAndAdjustBranches(code, instructions, [
    { start: ctor.offset, end: ctor.offset, data: guard },
  ]);
  writePatchedMethod(swfPath, ctx, methodBody, patchedCode);
  console.log(`${swfPath}: patched class_82.method_193 BitmapData guard.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
