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
const CLASS82_TARGET_TOTAL_PIXELS = 4194304;
const CLASS82_LEGACY_TOTAL_PIXEL_GUARDS = [
  16777215,
  262144,
];
const CLASS82_MAX_SCENE_CACHE_SCALE = 16;
const CACHE_SCALE_DIVISOR = 1;
const LEGACY_CACHE_SCALE_DIVISORS = [2, 4];
const FALLBACK_BITMAP_SIZE = 128;
const SCALE_DIVISOR_PATCH = Buffer.from([0x24, CACHE_SCALE_DIVISOR, 0xa3]);

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
        "  ts-node src/server/scripts/patch-dungeonblitz-class82-bitmapdata-guard.ts [--verify] [--swf <path>]",
        "",
        "Patches class_82.method_193 so invalid scene cache scale/dimensions",
        "are reduced to a safe fallback bitmap without lowering normal cache resolution.",
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
      if (edit.end <= offset || (edit.start === edit.end && edit.start <= offset)) {
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

function getLocalOperand(inst: Instruction): number | null {
  if (inst.opcode >= 0xd0 && inst.opcode <= 0xd3) {
    return inst.opcode - 0xd0;
  }
  if (inst.opcode === 0x62 && inst.operands[0]?.[0] === "u30") {
    return inst.operands[0][1];
  }
  return null;
}

function setLocalOperand(inst: Instruction | undefined): number | null {
  if (!inst) {
    return null;
  }
  if (inst.opcode >= 0xd4 && inst.opcode <= 0xd7) {
    return inst.opcode - 0xd4;
  }
  if (inst.opcode === 0x63 && inst.operands[0]?.[0] === "u30") {
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

function setLocal(localIndex: number): InsertedInstruction {
  if (localIndex >= 0 && localIndex <= 3) {
    return { opcode: 0xd4 + localIndex };
  }
  return { opcode: 0x63, operands: [["u30", localIndex]] };
}

function dimensionGuard(widthLocal: number, heightLocal: number, totalPixelsIntIndex: number): InsertedInstruction[] {
  return [
    getLocal(widthLocal),
    getLocal(widthLocal),
    { opcode: 0xab },
    { opcode: 0x12, branchTo: "invalid" },
    getLocal(heightLocal),
    getLocal(heightLocal),
    { opcode: 0xab },
    { opcode: 0x12, branchTo: "invalid" },
    getLocal(widthLocal),
    { opcode: 0x24, operands: [["s8", 1]] },
    { opcode: 0xad },
    { opcode: 0x11, branchTo: "invalid" },
    getLocal(heightLocal),
    { opcode: 0x24, operands: [["s8", 1]] },
    { opcode: 0xad },
    { opcode: 0x11, branchTo: "invalid" },
    getLocal(widthLocal),
    { opcode: 0x25, operands: [["u30", 8191]] },
    { opcode: 0xaf },
    { opcode: 0x11, branchTo: "invalid" },
    getLocal(heightLocal),
    { opcode: 0x25, operands: [["u30", 8191]] },
    { opcode: 0xaf },
    { opcode: 0x11, branchTo: "invalid" },
    getLocal(widthLocal),
    getLocal(heightLocal),
    { opcode: 0xa2 },
    { opcode: 0x2d, operands: [["u30", totalPixelsIntIndex]] },
    { opcode: 0xaf },
    { opcode: 0x12, branchTo: "ok" },
    { label: "invalid" },
    { opcode: 0x25, operands: [["u30", FALLBACK_BITMAP_SIZE]] },
    { opcode: 0x75 },
    setLocal(widthLocal),
    { opcode: 0x25, operands: [["u30", FALLBACK_BITMAP_SIZE]] },
    { opcode: 0x75 },
    setLocal(heightLocal),
    { label: "ok" },
  ];
}

function scaleGuard(scaleLocal: number): InsertedInstruction[] {
  return [
    getLocal(scaleLocal),
    getLocal(scaleLocal),
    { opcode: 0xab },
    { opcode: 0x12, branchTo: "invalid" },
    getLocal(scaleLocal),
    { opcode: 0x24, operands: [["s8", 0]] },
    { opcode: 0xaf },
    { opcode: 0x12, branchTo: "invalid" },
    getLocal(scaleLocal),
    { opcode: 0x24, operands: [["s8", CLASS82_MAX_SCENE_CACHE_SCALE]] },
    { opcode: 0xaf },
    { opcode: 0x11, branchTo: "invalid" },
    { opcode: 0x10, branchTo: "ok" },
    { label: "invalid" },
    { opcode: 0x24, operands: [["s8", 1]] },
    { opcode: 0x75 },
    setLocal(scaleLocal),
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

function findOptionalInt(abc: ReturnType<typeof parseAbc>, value: number): number | null {
  const index = abc.intValues.findIndex((candidate) => candidate === value);
  return index < 0 ? null : index;
}

function findBitmapDataConstructor(
  instructions: Instruction[],
  abc: ReturnType<typeof parseAbc>,
  widthLocal: number,
  heightLocal: number,
): Instruction {
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
      getLocalOperand(width) === widthLocal &&
      getLocalOperand(height) === heightLocal &&
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

  throw new PatchError(`Could not find BitmapData constructor for locals ${widthLocal}/${heightLocal}`);
}

function findScaleAssignmentOffsets(
  instructions: Instruction[],
  abc: ReturnType<typeof parseAbc>,
): { divisorPatchStart: number; divisorPatchEnd: number; guardInsertOffset: number } {
  for (let index = 0; index < instructions.length - 7; index += 1) {
    const self = instructions[index];
    const var1 = instructions[index + 1];
    const main = instructions[index + 2];
    const scale = instructions[index + 3];
    const divisorIndex =
      instructions[index + 4].opcode === 0x24 &&
      (instructions[index + 4].operands[0]?.[1] === CACHE_SCALE_DIVISOR ||
        LEGACY_CACHE_SCALE_DIVISORS.includes(instructions[index + 4].operands[0]?.[1] ?? -1)) &&
      instructions[index + 5].opcode === 0xa3
        ? index + 4
        : -1;
    const convertIndex = divisorIndex >= 0 ? -1 : index + 4;
    const setScaleIndex = (() => {
      const start = divisorIndex >= 0 ? divisorIndex + 2 : convertIndex + 1;
      for (let scan = start; scan < Math.min(instructions.length, start + 6); scan += 1) {
        if (setLocalOperand(instructions[scan]) === 6) {
          return scan;
        }
      }
      return -1;
    })();
    const convert = convertIndex >= 0 ? instructions[convertIndex] : undefined;
    const setScale = instructions[setScaleIndex];
    if (
      self.opcode === 0xd0 &&
      var1.opcode === 0x66 &&
      u30OperandName(var1, abc.multinameNames) === "var_1" &&
      main.opcode === 0x66 &&
      u30OperandName(main, abc.multinameNames) === "main" &&
      scale.opcode === 0x66 &&
      u30OperandName(scale, abc.multinameNames) === "var_2825" &&
      (divisorIndex >= 0 || convert?.opcode === 0x75) &&
      setScaleIndex >= 0
    ) {
      const divisorPatchStart = divisorIndex >= 0 ? instructions[divisorIndex].offset : convert!.offset;
      const divisorPatchEnd = divisorIndex >= 0
        ? instructions[divisorIndex + 1].offset + instructions[divisorIndex + 1].size
        : convert!.offset;
      return {
        divisorPatchStart,
        divisorPatchEnd,
        guardInsertOffset: setScale.offset + setScale.size,
      };
    }
  }

  throw new PatchError("Could not find class_82.method_193 cache scale assignment.");
}

function hasExactGuardBefore(code: Buffer, constructorOffset: number, guard: Buffer): boolean {
  return constructorOffset >= guard.length && code.subarray(constructorOffset - guard.length, constructorOffset).equals(guard);
}

function hasScaleDivisorPatch(code: Buffer, start: number, end: number): boolean {
  return end > start && code.subarray(start, end).equals(SCALE_DIVISOR_PATCH);
}

function hasClass82ScaleDivisor(instructions: Instruction[], abc: ReturnType<typeof parseAbc>): boolean {
  return instructions.some((instruction, index) => {
    if (instruction.opcode !== 0x66 || u30OperandName(instruction, abc.multinameNames) !== "var_2825") {
      return false;
    }
    const window = instructions.slice(index + 1, index + 8);
    const divisorIndex = window.findIndex((candidate) =>
      candidate.opcode === 0x24 && candidate.operands[0]?.[1] === CACHE_SCALE_DIVISOR
    );
    return divisorIndex >= 0 &&
      window[divisorIndex + 1]?.opcode === 0xa3 &&
      window.some((candidate) => setLocalOperand(candidate) === 6);
  });
}

function hasScaleGuardPatch(code: Buffer, insertOffset: number, guard: Buffer): boolean {
  return code.subarray(insertOffset, insertOffset + guard.length).equals(guard);
}

function hasClass82ScaleGuard(instructions: Instruction[]): boolean {
  return instructions.some((instruction, index) =>
    getLocalOperand(instruction) === 6 &&
    getLocalOperand(instructions[index + 1]) === 6 &&
    instructions[index + 2]?.opcode === 0xab &&
    instructions[index + 3]?.opcode === 0x12 &&
    getLocalOperand(instructions[index + 4]) === 6 &&
    instructions[index + 5]?.opcode === 0x24 &&
    instructions[index + 5]?.operands[0]?.[1] === 0 &&
    instructions[index + 6]?.opcode === 0xaf &&
    instructions[index + 7]?.opcode === 0x12 &&
    getLocalOperand(instructions[index + 8]) === 6 &&
    instructions[index + 9]?.opcode === 0x24 &&
    instructions[index + 9]?.operands[0]?.[1] === CLASS82_MAX_SCENE_CACHE_SCALE &&
    instructions[index + 10]?.opcode === 0xaf &&
    instructions[index + 11]?.opcode === 0x11
  );
}

function getInstanceMethod(swfPath: string, className: string, methodName: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, className);
  if (classIndex === null) {
    throw new PatchError(`Could not find ${className} class.`);
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, methodName);
  if (methodIdx === null) {
    throw new PatchError(`Could not find ${className}.${methodName}.`);
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find method body for ${className}.${methodName} (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `${className}.${methodName}:${methodIdx}`);
  return { ctx, abc, methodBody, code, instructions };
}

function writePatchedMethod(
  swfPath: string,
  ctx: ReturnType<typeof parseSwf>,
  methodBody: ReturnType<typeof getInstanceMethod>["methodBody"],
  patchedCode: Buffer,
): void {
  const patches: BytePatch[] = [
    {
      key: "class_82.method_193.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "insert BitmapData dimension guard",
    },
    {
      key: "class_82.method_193.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: "update method_193 code length",
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, code, instructions } = getInstanceMethod(swfPath, "class_82", "method_193");
  const constructor = findBitmapDataConstructor(instructions, abc, 8, 9);
  const targetTotalPixelsIntIndex = findRequiredInt(abc, CLASS82_TARGET_TOTAL_PIXELS);
  const guard = assembleInserted(dimensionGuard(8, 9, targetTotalPixelsIntIndex));
  const cacheScaleGuard = assembleInserted(scaleGuard(6));
  const legacyGuards = CLASS82_LEGACY_TOTAL_PIXEL_GUARDS
    .map((totalPixels) => findOptionalInt(abc, totalPixels))
    .filter((index): index is number => index !== null)
    .map((index) => assembleInserted(dimensionGuard(8, 9, index)));
  const hasGuard = hasExactGuardBefore(code, constructor.offset, guard);
  const hasScalePatchByPattern = hasClass82ScaleDivisor(instructions, abc);
  const hasScaleGuardByPattern = hasClass82ScaleGuard(instructions);

  if (hasGuard && hasScalePatchByPattern && hasScaleGuardByPattern) {
    console.log(`${swfPath}: already patched (class_82.method_193 BitmapData guard present).`);
    return;
  }

  const scaleOffsets = findScaleAssignmentOffsets(instructions, abc);
  const hasScalePatch = hasScaleDivisorPatch(code, scaleOffsets.divisorPatchStart, scaleOffsets.divisorPatchEnd) ||
    hasScalePatchByPattern;
  const hasScaleGuard = hasScaleGuardPatch(code, scaleOffsets.guardInsertOffset, cacheScaleGuard) ||
    hasScaleGuardByPattern;

  if (hasGuard && hasScalePatch && hasScaleGuard) {
    console.log(`${swfPath}: already patched (class_82.method_193 BitmapData guard present).`);
    return;
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; class_82.method_193 BitmapData guard, scale divisor, or scale guard is missing.`);
  }

  const edits: Array<{ start: number; end: number; data: Buffer }> = [];
  if (!hasScalePatch) {
    edits.push({ start: scaleOffsets.divisorPatchStart, end: scaleOffsets.divisorPatchEnd, data: SCALE_DIVISOR_PATCH });
  }
  if (!hasScaleGuard) {
    edits.push({ start: scaleOffsets.guardInsertOffset, end: scaleOffsets.guardInsertOffset, data: cacheScaleGuard });
  }
  if (!hasGuard) {
    const legacyGuard = legacyGuards.find((candidate) => hasExactGuardBefore(code, constructor.offset, candidate));
    edits.push(
      legacyGuard
        ? { start: constructor.offset - legacyGuard.length, end: constructor.offset, data: guard }
        : { start: constructor.offset, end: constructor.offset, data: guard },
    );
  }
  const patchedCode = applyCodeEditsAndAdjustBranches(code, instructions, edits);
  writePatchedMethod(swfPath, ctx, methodBody, patchedCode);
  console.log(`${swfPath}: patched class_82.method_193 BitmapData guard.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
