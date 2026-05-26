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
const METHOD982_SAFE_TOTAL_PIXELS = 4194304;
const METHOD982_PREVIOUS_SAFE_TOTAL_PIXELS = 65536;
const METHOD982_OLDER_SAFE_TOTAL_PIXELS = 4096;
const METHOD982_OLDEST_SAFE_TOTAL_PIXELS = 16384;
const METHOD982_FORCED_BITMAP_SIZE = 1;
const METHOD982_PREVIOUS_FORCED_BITMAP_SIZES = [64, 128, 256, 512, 2048];
const METHOD200_SAFE_TOTAL_PIXELS = 16384;
const METHOD200_PREVIOUS_SAFE_TOTAL_PIXELS = 65536;
const METHOD200_OLDER_SAFE_TOTAL_PIXELS = 16777215;

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
        "  npm exec tsx src/server/scripts/patch-dungeonblitz-superanim-method200-bitmapdata-guard.ts [--verify] [--swf <path>]",
        "",
        "Patches SuperAnimData.method_200 and method_982 so oversized ability",
        "BitmapData allocations are bounded before Flash can crash, and",
        "method_866 clears stale Bitmap snapshots if it ever falls back to live sprites.",
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
    if (!isBranchOpcode(inst.opcode)) {
      continue;
    }
    if (isInsideEdit(inst.offset)) {
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

function setLocalOperand(inst: Instruction): number | null {
  if (inst.opcode >= 0xd4 && inst.opcode <= 0xd7) {
    return inst.opcode - 0xd4;
  }
  if (inst.opcode === 0x63 && inst.operands[0]?.[0] === "u30") {
    return inst.operands[0][1];
  }
  return null;
}

function pushInteger(value: number): InsertedInstruction {
  if (value >= -128 && value <= 127) {
    return { opcode: 0x24, operands: [["s8", value]] };
  }
  return { opcode: 0x25, operands: [["u30", value]] };
}

function pushedIntegerValue(inst: Instruction): number | null {
  if ((inst.opcode === 0x24 || inst.opcode === 0x25) && inst.operands[0]) {
    return inst.operands[0][1];
  }
  return null;
}

function dimensionGuard(
  widthLocal: number,
  heightLocal: number,
  invalidExtra: InsertedInstruction[] = [],
  totalPixelsIntIndex: number | null = null,
  fallbackSize: number = 1,
): InsertedInstruction[] {
  const guard: InsertedInstruction[] = [
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
  ];

  if (totalPixelsIntIndex !== null) {
    guard.push(
      getLocal(widthLocal),
      getLocal(heightLocal),
      { opcode: 0xa2 },
      { opcode: 0x2d, operands: [["u30", totalPixelsIntIndex]] },
      { opcode: 0xaf },
      { opcode: 0x12, branchTo: "ok" },
    );
  } else {
    guard.push({ opcode: 0x10, branchTo: "ok" });
  }

  guard.push(
    { label: "invalid" },
    pushInteger(fallbackSize),
    { opcode: 0x75 },
    setLocal(widthLocal),
    pushInteger(fallbackSize),
    { opcode: 0x75 },
    setLocal(heightLocal),
    ...invalidExtra,
    { label: "ok" },
  );

  return guard;
}

function croppedDimensionGuard(widthName: number, heightName: number): InsertedInstruction[] {
  return rectDimensionGuard(25, 26, 24, widthName, heightName);
}

function croppedDimensionGuardWithFallback(widthName: number, heightName: number, fallbackSize: number): InsertedInstruction[] {
  return rectDimensionGuard(25, 26, 24, widthName, heightName, null, fallbackSize);
}

function rectDimensionGuard(
  widthLocal: number,
  heightLocal: number,
  rectLocal: number,
  widthName: number,
  heightName: number,
  totalPixelsIntIndex: number | null = null,
  fallbackSize: number = 1,
): InsertedInstruction[] {
  return dimensionGuard(widthLocal, heightLocal, [
    getLocal(rectLocal),
    pushInteger(fallbackSize),
    { opcode: 0x61, operands: [["u30", widthName]] },
    getLocal(rectLocal),
    pushInteger(fallbackSize),
    { opcode: 0x61, operands: [["u30", heightName]] },
  ], totalPixelsIntIndex, fallbackSize);
}

function rectFallback(
  widthLocal: number,
  heightLocal: number,
  rectLocal: number,
  widthName: number,
  heightName: number,
): InsertedInstruction[] {
  return [
    { opcode: 0x24, operands: [["s8", 1]] },
    { opcode: 0x75 },
    setLocal(widthLocal),
    { opcode: 0x24, operands: [["s8", 1]] },
    { opcode: 0x75 },
    setLocal(heightLocal),
    getLocal(rectLocal),
    { opcode: 0x24, operands: [["s8", 1]] },
    { opcode: 0x61, operands: [["u30", widthName]] },
    getLocal(rectLocal),
    { opcode: 0x24, operands: [["s8", 1]] },
    { opcode: 0x61, operands: [["u30", heightName]] },
  ];
}

function productDimensionGuard(
  widthLocal: number,
  heightLocal: number,
  totalPixelsIntIndex: number,
  fallbackSize: number = 1,
): InsertedInstruction[] {
  return dimensionGuard(widthLocal, heightLocal, [], totalPixelsIntIndex, fallbackSize);
}

function productCroppedDimensionGuard(
  widthName: number,
  heightName: number,
  totalPixelsIntIndex: number,
  fallbackSize: number = 1,
): InsertedInstruction[] {
  return rectDimensionGuard(25, 26, 24, widthName, heightName, totalPixelsIntIndex, fallbackSize);
}

function pushshortProductDimensionGuard(
  widthLocal: number,
  heightLocal: number,
  invalidExtra: InsertedInstruction[] = [],
): InsertedInstruction[] {
  const guard = dimensionGuard(widthLocal, heightLocal, invalidExtra);
  const jumpIndex = guard.findIndex((inst) => "opcode" in inst && inst.opcode === 0x10 && inst.branchTo === "ok");
  if (jumpIndex < 0) {
    throw new PatchError("Could not build legacy pushshort product guard.");
  }
  guard.splice(
    jumpIndex,
    1,
    getLocal(widthLocal),
    getLocal(heightLocal),
    { opcode: 0xa2 },
    { opcode: 0x25, operands: [["u30", 16777215]] },
    { opcode: 0xaf },
    { opcode: 0x12, branchTo: "ok" },
  );
  return guard;
}

function pushshortProductCroppedDimensionGuard(widthName: number, heightName: number): InsertedInstruction[] {
  return pushshortProductDimensionGuard(25, 26, [
    getLocal(24),
    { opcode: 0x24, operands: [["s8", 1]] },
    { opcode: 0x61, operands: [["u30", widthName]] },
    getLocal(24),
    { opcode: 0x24, operands: [["s8", 1]] },
    { opcode: 0x61, operands: [["u30", heightName]] },
  ]);
}

function legacyPushshortProductCroppedDimensionGuard(widthName: number, heightName: number): InsertedInstruction[] {
  return [
    ...pushshortProductDimensionGuard(25, 26),
    getLocal(24),
    { opcode: 0x24, operands: [["s8", 1]] },
    { opcode: 0x61, operands: [["u30", widthName]] },
    getLocal(24),
    { opcode: 0x24, operands: [["s8", 1]] },
    { opcode: 0x61, operands: [["u30", heightName]] },
  ];
}

function findRequiredMultiname(abc: ReturnType<typeof parseAbc>, name: string): number {
  const index = abc.multinameNames.findIndex((candidate) => candidate === name);
  if (index < 0) {
    throw new PatchError(`Multiname ${name} not found`);
  }
  return index;
}

function findRequiredInt(abc: ReturnType<typeof parseAbc>, value: number): number {
  const index = abc.intValues.findIndex((candidate) => candidate === value);
  if (index < 0) {
    throw new PatchError(`Int constant ${value} not found`);
  }
  return index;
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

function findBitmapDataConstructorOrForced(
  instructions: Instruction[],
  abc: ReturnType<typeof parseAbc>,
  widthLocal: number,
  heightLocal: number,
): { constructor: Instruction; width: Instruction; height: Instruction; forced: boolean } {
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
    const usesLocals = getLocalOperand(width) === widthLocal && getLocalOperand(height) === heightLocal;
    const forcedWidth = pushedIntegerValue(width);
    const forcedHeight = pushedIntegerValue(height);
    const forcedSmall =
      (forcedWidth === 1 ||
        METHOD982_PREVIOUS_FORCED_BITMAP_SIZES.includes(forcedWidth ?? 0) ||
        forcedWidth === METHOD982_FORCED_BITMAP_SIZE) &&
      (forcedHeight === 1 ||
        METHOD982_PREVIOUS_FORCED_BITMAP_SIZES.includes(forcedHeight ?? 0) ||
        forcedHeight === METHOD982_FORCED_BITMAP_SIZE);
    if (
      (usesLocals || forcedSmall) &&
      pushTrue.opcode === 0x26 &&
      pushZero.opcode === 0x24 &&
      pushZero.operands[0]?.[1] === 0 &&
      construct.opcode === 0x4a &&
      u30OperandName(construct, abc.multinameNames) === "BitmapData" &&
      construct.operands[1]?.[1] === 4
    ) {
      return { constructor: inst, width, height, forced: forcedSmall };
    }
  }

  throw new PatchError(`Could not find BitmapData constructor for locals ${widthLocal}/${heightLocal}`);
}

function hasExactGuardBefore(code: Buffer, constructorOffset: number, guard: Buffer): boolean {
  return constructorOffset >= guard.length && code.subarray(constructorOffset - guard.length, constructorOffset).equals(guard);
}

function findMethod982ExistingGuardStart(instructions: Instruction[], constructorOffset: number): number | null {
  for (let index = 0; index < instructions.length - 7; index += 1) {
    const candidate = instructions[index];
    if (candidate.offset >= constructorOffset) {
      break;
    }
    if (constructorOffset - candidate.offset > 700) {
      continue;
    }
    if (
      getLocalOperand(candidate) === 11 &&
      getLocalOperand(instructions[index + 1]) === 11 &&
      instructions[index + 2]?.opcode === 0xab &&
      instructions[index + 3]?.opcode === 0x12 &&
      getLocalOperand(instructions[index + 4]) === 12 &&
      getLocalOperand(instructions[index + 5]) === 12 &&
      instructions[index + 6]?.opcode === 0xab &&
      instructions[index + 7]?.opcode === 0x12
    ) {
      return candidate.offset;
    }
  }

  return null;
}

function getStaticMethod(swfPath: string, methodName: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "SuperAnimData");
  if (classIndex === null) {
    throw new PatchError("Could not find SuperAnimData class.");
  }

  const methodIdx = methodIdxForTrait(abc.classTraits[classIndex], abc, methodName);
  if (methodIdx === null) {
    throw new PatchError(`Could not find SuperAnimData.${methodName}.`);
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find method body for SuperAnimData.${methodName} (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `SuperAnimData.${methodName}:${methodIdx}`);
  return { ctx, abc, methodBody, code, instructions };
}

function getInstanceMethod(swfPath: string, methodName: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "SuperAnimData");
  if (classIndex === null) {
    throw new PatchError("Could not find SuperAnimData class.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, methodName);
  if (methodIdx === null) {
    throw new PatchError(`Could not find SuperAnimData.${methodName}.`);
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find method body for SuperAnimData.${methodName} (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `SuperAnimData.${methodName}:${methodIdx}`);
  return { ctx, abc, methodBody, code, instructions };
}

function writePatchedMethod(
  swfPath: string,
  methodName: string,
  ctx: ReturnType<typeof parseSwf>,
  methodBody: ReturnType<typeof getStaticMethod>["methodBody"],
  patchedCode: Buffer,
): void {
  const patches: BytePatch[] = [
    {
      key: `SuperAnimData.${methodName}.code`,
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "insert BitmapData dimension guards",
    },
    {
      key: `SuperAnimData.${methodName}.codeLen`,
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: `update ${methodName} code length`,
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
}

function findMethod866NullFallbackInsertOffset(
  instructions: Instruction[],
  abc: ReturnType<typeof parseAbc>,
): number | null {
  for (let index = 0; index < instructions.length - 8; index += 1) {
    const nullCheckLocal = instructions[index];
    const jumpToBitmapPath = instructions[index + 1];
    if (
      getLocalOperand(nullCheckLocal) !== 11 ||
      jumpToBitmapPath.opcode !== 0x11 ||
      jumpToBitmapPath.operands[0]?.[0] !== "s24"
    ) {
      continue;
    }

    for (let scan = index + 2; scan < Math.min(instructions.length - 2, index + 18); scan += 1) {
      if (
        getLocalOperand(instructions[scan]) === 3 &&
        getLocalOperand(instructions[scan + 1]) === 9 &&
        instructions[scan + 2]?.opcode === 0x4f &&
        u30OperandName(instructions[scan + 2], abc.multinameNames) === "addChild" &&
        instructions[scan + 2].operands[1]?.[1] === 1
      ) {
        return jumpToBitmapPath.offset + jumpToBitmapPath.size;
      }
    }
  }

  return null;
}

function findMethod866Method982ResultInsertOffset(
  instructions: Instruction[],
  abc: ReturnType<typeof parseAbc>,
): number | null {
  for (let index = 0; index < instructions.length - 4; index += 1) {
    if (
      instructions[index].opcode === 0x5d &&
      u30OperandName(instructions[index], abc.multinameNames) === "method_982" &&
      getLocalOperand(instructions[index + 1]) === 9 &&
      instructions[index + 2]?.opcode === 0x46 &&
      u30OperandName(instructions[index + 2], abc.multinameNames) === "method_982" &&
      instructions[index + 2].operands[1]?.[1] === 1 &&
      instructions[index + 3]?.opcode === 0x80 &&
      u30OperandName(instructions[index + 3], abc.multinameNames) === "Bitmap" &&
      setLocalOperand(instructions[index + 4]) === 11
    ) {
      return instructions[index + 4].offset + instructions[index + 4].size;
    }
  }

  return null;
}

function method866LiveFallbackCleanup(bitmapDataName: number): Buffer {
  return assembleInserted([
    getLocal(4),
    { opcode: 0x20 },
    { opcode: 0x61, operands: [["u30", bitmapDataName]] },
  ]);
}

function method866ForcedBitmapReject(
  bitmapDataName: number,
  widthName: number,
  heightName: number,
  disposeName: number,
): Buffer {
  return assembleInserted([
    getLocal(11),
    { opcode: 0x12, branchTo: "ok" },
    getLocal(11),
    { opcode: 0x66, operands: [["u30", bitmapDataName]] },
    { opcode: 0x12, branchTo: "ok" },
    getLocal(11),
    { opcode: 0x66, operands: [["u30", bitmapDataName]] },
    { opcode: 0x66, operands: [["u30", widthName]] },
    { opcode: 0x24, operands: [["s8", 1]] },
    { opcode: 0x17, branchTo: "ok" },
    getLocal(11),
    { opcode: 0x66, operands: [["u30", bitmapDataName]] },
    { opcode: 0x66, operands: [["u30", heightName]] },
    { opcode: 0x24, operands: [["s8", 1]] },
    { opcode: 0x17, branchTo: "ok" },
    getLocal(11),
    { opcode: 0x66, operands: [["u30", bitmapDataName]] },
    { opcode: 0x4f, operands: [["u30", disposeName], ["u30", 0]] },
    getLocal(11),
    { opcode: 0x20 },
    { opcode: 0x61, operands: [["u30", bitmapDataName]] },
    { opcode: 0x20 },
    setLocal(11),
    { label: "ok" },
  ]);
}

function patchMethod866(swfPath: string, verify: boolean): boolean {
  const { ctx, abc, methodBody, code, instructions } = getInstanceMethod(swfPath, "method_866");
  const bitmapDataName = findRequiredMultiname(abc, "bitmapData");
  const widthName = findRequiredMultiname(abc, "width");
  const heightName = findRequiredMultiname(abc, "height");
  const disposeName = findRequiredMultiname(abc, "dispose");
  const cleanup = method866LiveFallbackCleanup(bitmapDataName);
  const forcedBitmapReject = method866ForcedBitmapReject(bitmapDataName, widthName, heightName, disposeName);
  const resultInsertOffset = findMethod866Method982ResultInsertOffset(instructions, abc);
  if (resultInsertOffset === null) {
    throw new PatchError(`${swfPath}: could not find SuperAnimData.method_866 method_982 result assignment.`);
  }

  const insertOffset = findMethod866NullFallbackInsertOffset(instructions, abc);
  if (insertOffset === null) {
    throw new PatchError(`${swfPath}: could not find SuperAnimData.method_866 live sprite fallback.`);
  }

  const resultAlreadyPatched =
    code.subarray(resultInsertOffset, resultInsertOffset + forcedBitmapReject.length).equals(forcedBitmapReject);
  const fallbackAlreadyPatched =
    code.subarray(insertOffset, insertOffset + cleanup.length).equals(cleanup);
  if (resultAlreadyPatched && fallbackAlreadyPatched) {
    return false;
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; SuperAnimData.method_866 unsafe bitmap fallback handling is missing.`);
  }

  const edits: Array<{ start: number; end: number; data: Buffer }> = [];
  if (!resultAlreadyPatched) {
    edits.push({ start: resultInsertOffset, end: resultInsertOffset, data: forcedBitmapReject });
  }
  if (!fallbackAlreadyPatched) {
    edits.push({ start: insertOffset, end: insertOffset, data: cleanup });
  }

  const patchedCode = applyCodeEditsAndAdjustBranches(code, instructions, edits);
  writePatchedMethod(swfPath, "method_866", ctx, methodBody, patchedCode);
  return true;
}

function patchMethod200(swfPath: string, verify: boolean): boolean {
  const { ctx, abc, methodBody, code, instructions } = getStaticMethod(swfPath, "method_200");
  const directCtor = findBitmapDataConstructor(instructions, abc, 10, 11);
  const croppedCtor = findBitmapDataConstructor(instructions, abc, 25, 26);
  const widthName = findRequiredMultiname(abc, "width");
  const heightName = findRequiredMultiname(abc, "height");
  const totalPixelsIntIndex = findRequiredInt(abc, METHOD200_SAFE_TOTAL_PIXELS);
  const previousTotalPixelsIntIndex = findRequiredInt(abc, METHOD200_PREVIOUS_SAFE_TOTAL_PIXELS);
  const olderTotalPixelsIntIndex = findRequiredInt(abc, METHOD200_OLDER_SAFE_TOTAL_PIXELS);
  const directGuard = assembleInserted(productDimensionGuard(10, 11, totalPixelsIntIndex, 128));
  const croppedGuard = assembleInserted(productCroppedDimensionGuard(widthName, heightName, totalPixelsIntIndex, 128));
  const directPreviousGuard = assembleInserted(productDimensionGuard(10, 11, previousTotalPixelsIntIndex));
  const croppedPreviousGuard = assembleInserted(productCroppedDimensionGuard(widthName, heightName, previousTotalPixelsIntIndex));
  const directOlderGuard = assembleInserted(productDimensionGuard(10, 11, olderTotalPixelsIntIndex));
  const croppedOlderGuard = assembleInserted(productCroppedDimensionGuard(widthName, heightName, olderTotalPixelsIntIndex));
  const noProductDirectGuard = assembleInserted(dimensionGuard(10, 11));
  const noProductCroppedGuard = assembleInserted(croppedDimensionGuard(widthName, heightName));
  const noProductCroppedFallbackGuard = assembleInserted(croppedDimensionGuardWithFallback(widthName, heightName, 128));
  const pushshortProductDirectGuard = assembleInserted(pushshortProductDimensionGuard(10, 11));
  const pushshortProductCroppedGuard = assembleInserted(pushshortProductCroppedDimensionGuard(widthName, heightName));
  const legacyPushshortProductCroppedGuard = assembleInserted(legacyPushshortProductCroppedDimensionGuard(widthName, heightName));

  const directPatched = hasExactGuardBefore(code, directCtor.offset, directGuard);
  const croppedPatched = hasExactGuardBefore(code, croppedCtor.offset, croppedGuard);
  const directPreviousPatched = hasExactGuardBefore(code, directCtor.offset, directPreviousGuard);
  const croppedPreviousPatched = hasExactGuardBefore(code, croppedCtor.offset, croppedPreviousGuard);
  const directOlderPatched = hasExactGuardBefore(code, directCtor.offset, directOlderGuard);
  const croppedOlderPatched = hasExactGuardBefore(code, croppedCtor.offset, croppedOlderGuard);
  const directNoProductPatched = hasExactGuardBefore(code, directCtor.offset, noProductDirectGuard);
  const croppedNoProductPatched = hasExactGuardBefore(code, croppedCtor.offset, noProductCroppedGuard);
  const croppedNoProductFallbackPatched = hasExactGuardBefore(code, croppedCtor.offset, noProductCroppedFallbackGuard);
  const directPushshortProductPatched = hasExactGuardBefore(code, directCtor.offset, pushshortProductDirectGuard);
  const croppedPushshortProductPatched = hasExactGuardBefore(code, croppedCtor.offset, pushshortProductCroppedGuard);
  const croppedLegacyPushshortProductPatched = hasExactGuardBefore(
    code,
    croppedCtor.offset,
    legacyPushshortProductCroppedGuard,
  );

  if (directPatched && croppedPatched) {
    return false;
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; SuperAnimData.method_200 BitmapData guards are missing.`);
  }

  const edits: Array<{ start: number; end: number; data: Buffer }> = [];
  if (!directPatched) {
    if (directPreviousPatched) {
      edits.push({
        start: directCtor.offset - directPreviousGuard.length,
        end: directCtor.offset,
        data: directGuard,
      });
    } else if (directOlderPatched) {
      edits.push({
        start: directCtor.offset - directOlderGuard.length,
        end: directCtor.offset,
        data: directGuard,
      });
    } else if (directNoProductPatched) {
      edits.push({
        start: directCtor.offset - noProductDirectGuard.length,
        end: directCtor.offset,
        data: directGuard,
      });
    } else if (directPushshortProductPatched) {
      edits.push({
        start: directCtor.offset - pushshortProductDirectGuard.length,
        end: directCtor.offset,
        data: directGuard,
      });
    } else {
      edits.push({ start: directCtor.offset, end: directCtor.offset, data: directGuard });
    }
  }
  if (!croppedPatched) {
    if (croppedPreviousPatched) {
      edits.push({
        start: croppedCtor.offset - croppedPreviousGuard.length,
        end: croppedCtor.offset,
        data: croppedGuard,
      });
    } else if (croppedOlderPatched) {
      edits.push({
        start: croppedCtor.offset - croppedOlderGuard.length,
        end: croppedCtor.offset,
        data: croppedGuard,
      });
    } else if (croppedNoProductFallbackPatched) {
      edits.push({
        start: croppedCtor.offset - noProductCroppedFallbackGuard.length,
        end: croppedCtor.offset,
        data: croppedGuard,
      });
    } else if (croppedNoProductPatched) {
      edits.push({
        start: croppedCtor.offset - noProductCroppedGuard.length,
        end: croppedCtor.offset,
        data: croppedGuard,
      });
    } else if (croppedPushshortProductPatched) {
      edits.push({
        start: croppedCtor.offset - pushshortProductCroppedGuard.length,
        end: croppedCtor.offset,
        data: croppedGuard,
      });
    } else if (croppedLegacyPushshortProductPatched) {
      edits.push({
        start: croppedCtor.offset - legacyPushshortProductCroppedGuard.length,
        end: croppedCtor.offset,
        data: croppedGuard,
      });
    } else {
      edits.push({ start: croppedCtor.offset, end: croppedCtor.offset, data: croppedGuard });
    }
  }

  const patchedCode = applyCodeEditsAndAdjustBranches(code, instructions, edits);
  writePatchedMethod(swfPath, "method_200", ctx, methodBody, patchedCode);
  return true;
}

function patchMethod982(swfPath: string, verify: boolean): boolean {
  const { ctx, abc, methodBody, code, instructions } = getStaticMethod(swfPath, "method_982");
  const outputCtor = findBitmapDataConstructorOrForced(instructions, abc, 11, 12);
  const widthName = findRequiredMultiname(abc, "width");
  const heightName = findRequiredMultiname(abc, "height");
  const totalPixelsIntIndex = findRequiredInt(abc, METHOD982_SAFE_TOTAL_PIXELS);
  const previousTotalPixelsIntIndex = findRequiredInt(abc, METHOD982_PREVIOUS_SAFE_TOTAL_PIXELS);
  const olderTotalPixelsIntIndex = findRequiredInt(abc, METHOD982_OLDER_SAFE_TOTAL_PIXELS);
  const oldestTotalPixelsIntIndex = findRequiredInt(abc, METHOD982_OLDEST_SAFE_TOTAL_PIXELS);
  const hardTotalPixelsIntIndex = findRequiredInt(abc, 16777215);
  const forcedOutputFallback = assembleInserted(rectFallback(11, 12, 10, widthName, heightName));
  const legacyForcedOutputFallback = assembleInserted([
    { opcode: 0x26 },
    { opcode: 0x29 },
    ...rectFallback(11, 12, 10, widthName, heightName),
  ]);
  const outputGuard = assembleInserted(
    rectDimensionGuard(11, 12, 10, widthName, heightName, totalPixelsIntIndex, METHOD982_FORCED_BITMAP_SIZE),
  );
  const onePixelOutputGuard = assembleInserted(rectDimensionGuard(11, 12, 10, widthName, heightName, totalPixelsIntIndex));
  const previousOutputGuard = assembleInserted(
    rectDimensionGuard(11, 12, 10, widthName, heightName, previousTotalPixelsIntIndex, 128),
  );
  const olderOutputGuard = assembleInserted(
    rectDimensionGuard(11, 12, 10, widthName, heightName, olderTotalPixelsIntIndex, 128),
  );
  const oldestOutputGuard = assembleInserted(
    rectDimensionGuard(11, 12, 10, widthName, heightName, oldestTotalPixelsIntIndex),
  );
  const hardOutputGuard = assembleInserted(rectDimensionGuard(11, 12, 10, widthName, heightName, hardTotalPixelsIntIndex));
  const noProductOutputGuard = assembleInserted(rectDimensionGuard(11, 12, 10, widthName, heightName));
  const pushshortProductOutputGuard = assembleInserted(
    pushshortProductDimensionGuard(11, 12, [
      getLocal(10),
      { opcode: 0x24, operands: [["s8", 1]] },
      { opcode: 0x61, operands: [["u30", widthName]] },
      getLocal(10),
      { opcode: 0x24, operands: [["s8", 1]] },
      { opcode: 0x61, operands: [["u30", heightName]] },
    ]),
  );

  const outputForcedPatched = hasExactGuardBefore(code, outputCtor.constructor.offset, forcedOutputFallback);
  const outputLegacyForcedPatched = hasExactGuardBefore(code, outputCtor.constructor.offset, legacyForcedOutputFallback);
  const outputPatched = hasExactGuardBefore(code, outputCtor.constructor.offset, outputGuard);
  const outputOnePixelPatched = hasExactGuardBefore(code, outputCtor.constructor.offset, onePixelOutputGuard);
  const outputPreviousPatched = hasExactGuardBefore(code, outputCtor.constructor.offset, previousOutputGuard);
  const outputOlderPatched = hasExactGuardBefore(code, outputCtor.constructor.offset, olderOutputGuard);
  const outputOldestPatched = hasExactGuardBefore(code, outputCtor.constructor.offset, oldestOutputGuard);
  const outputHardPatched = hasExactGuardBefore(code, outputCtor.constructor.offset, hardOutputGuard);
  const outputNoProductPatched = hasExactGuardBefore(code, outputCtor.constructor.offset, noProductOutputGuard);
  const outputPushshortProductPatched = hasExactGuardBefore(code, outputCtor.constructor.offset, pushshortProductOutputGuard);
  const outputUsesGuardedLocals = getLocalOperand(outputCtor.width) === 11 && getLocalOperand(outputCtor.height) === 12;

  if (outputPatched && outputUsesGuardedLocals) {
    return false;
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; SuperAnimData.method_982 BitmapData guard is missing.`);
  }

  const edits: Array<{ start: number; end: number; data: Buffer }> = [];
  if (!outputUsesGuardedLocals) {
    edits.push(
      {
        start: outputCtor.width.offset,
        end: outputCtor.width.offset + outputCtor.width.size,
        data: assembleInserted([getLocal(11)]),
      },
      {
        start: outputCtor.height.offset,
        end: outputCtor.height.offset + outputCtor.height.size,
        data: assembleInserted([getLocal(12)]),
      },
    );
  }
  const existingGuardStart = findMethod982ExistingGuardStart(instructions, outputCtor.constructor.offset);
  if (existingGuardStart !== null) {
    edits.push({
      start: existingGuardStart,
      end: outputCtor.constructor.offset,
      data: outputGuard,
    });
  } else if (outputForcedPatched) {
    edits.push({
      start: outputCtor.constructor.offset - forcedOutputFallback.length,
      end: outputCtor.constructor.offset,
      data: outputGuard,
    });
  } else if (outputLegacyForcedPatched) {
    edits.push({
      start: outputCtor.constructor.offset - legacyForcedOutputFallback.length,
      end: outputCtor.constructor.offset,
      data: outputGuard,
    });
  } else if (outputOnePixelPatched) {
    edits.push({
      start: outputCtor.constructor.offset - onePixelOutputGuard.length,
      end: outputCtor.constructor.offset,
      data: outputGuard,
    });
  } else if (outputPreviousPatched) {
    edits.push({
      start: outputCtor.constructor.offset - previousOutputGuard.length,
      end: outputCtor.constructor.offset,
      data: outputGuard,
    });
  } else if (outputOlderPatched) {
    edits.push({
      start: outputCtor.constructor.offset - olderOutputGuard.length,
      end: outputCtor.constructor.offset,
      data: outputGuard,
    });
  } else if (outputOldestPatched) {
    edits.push({
      start: outputCtor.constructor.offset - oldestOutputGuard.length,
      end: outputCtor.constructor.offset,
      data: outputGuard,
    });
  } else if (outputHardPatched) {
    edits.push({
      start: outputCtor.constructor.offset - hardOutputGuard.length,
      end: outputCtor.constructor.offset,
      data: outputGuard,
    });
  } else if (outputNoProductPatched) {
    edits.push({
      start: outputCtor.constructor.offset - noProductOutputGuard.length,
      end: outputCtor.constructor.offset,
      data: outputGuard,
    });
  } else if (outputPushshortProductPatched) {
    edits.push({
      start: outputCtor.constructor.offset - pushshortProductOutputGuard.length,
      end: outputCtor.constructor.offset,
      data: outputGuard,
    });
  } else {
    edits.push({ start: outputCtor.constructor.offset, end: outputCtor.constructor.offset, data: outputGuard });
  }

  const patchedCode = applyCodeEditsAndAdjustBranches(code, instructions, edits);
  writePatchedMethod(swfPath, "method_982", ctx, methodBody, patchedCode);
  return true;
}

function patchSwf(swfPath: string, verify: boolean): void {
  const patched200 = patchMethod200(swfPath, verify);
  const patched982 = patchMethod982(swfPath, verify);
  const patched866 = patchMethod866(swfPath, verify);

  if (!patched200 && !patched982 && !patched866) {
    console.log(`${swfPath}: already patched (SuperAnimData BitmapData guards present).`);
    return;
  }

  const patchedMethods = [
    patched200 ? "method_200" : "",
    patched982 ? "method_982" : "",
    patched866 ? "method_866" : "",
  ].filter(Boolean).join(", ");
  console.log(`${swfPath}: patched SuperAnimData ${patchedMethods} BitmapData guards.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
