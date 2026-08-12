import * as path from "path";
import {
  BytePatch,
  Instruction,
  PatchError,
  applyPatchesToBody,
  classIndexByName,
  disassemble,
  ensureBackup,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  readU30,
  u30OperandName,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const DEFAULT_SWF = path.resolve(
  __dirname,
  "../../client/content/localhost/p/cbp/DungeonBlitz.swf",
);
const TARGET_ANIMATION_MARKER = "Templar";
const FINAL_MARKER_SOURCE = "FinalSplat";
const LATE_GFX_GUARD_MARKERS = [TARGET_ANIMATION_MARKER, FINAL_MARKER_SOURCE] as const;
const CASTLE_FIRE_GUARD_MARKERS = ["Castle", "Fire"] as const;
const PREVIOUS_ANIMATION_MARKERS = ["Justicar", "Templar"] as const;
const ORIGINAL_LOCAL_COUNT = 20;

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
        "  npm exec ts-node scripts/patch-dungeonblitz-home-tower-superanim-live-fallback.ts [--verify] [--swf <path>]",
        "",
        "Removes obsolete Home-tower live-Sprite overrides after the Templar flames",
        "have been authored into LevelsHome's parent timeline.",
      ].join("\n"));
      process.exit(0);
    }
    throw new PatchError(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify };
}

function writeS24(value: number): Buffer {
  if (value < -0x800000 || value > 0x7fffff) {
    throw new PatchError(`s24 value out of range: ${value}`);
  }
  const encoded = value < 0 ? value + 0x1000000 : value;
  const out = Buffer.alloc(3);
  out[0] = encoded & 0xff;
  out[1] = (encoded >>> 8) & 0xff;
  out[2] = (encoded >>> 16) & 0xff;
  return out;
}

function isBranchOpcode(opcode: number): boolean {
  return opcode >= 0x0c && opcode <= 0x1a;
}

function getLocalOperand(instruction: Instruction): number | null {
  if (instruction.opcode >= 0xd0 && instruction.opcode <= 0xd3) {
    return instruction.opcode - 0xd0;
  }
  return instruction.opcode === 0x62 ? instruction.operands[0]?.[1] ?? null : null;
}

function applyCodeReplacementAndAdjustBranches(
  originalCode: Buffer,
  instructions: Instruction[],
  replacementStart: number,
  replacementEnd: number,
  replacementCode: Buffer,
): Buffer {
  const delta = replacementCode.length - (replacementEnd - replacementStart);
  const patched = Buffer.concat([
    originalCode.subarray(0, replacementStart),
    replacementCode,
    originalCode.subarray(replacementEnd),
  ]);
  const remapOffset = (offset: number): number => {
    if (offset <= replacementStart) return offset;
    if (offset >= replacementEnd) return offset + delta;
    throw new PatchError(`Branch enters replaced SuperAnim guard at offset ${offset}.`);
  };
  for (const instruction of instructions) {
    if (!isBranchOpcode(instruction.opcode)) continue;
    if (instruction.offset >= replacementStart && instruction.offset < replacementEnd) continue;
    const branch = instruction.operands[0];
    if (branch?.[0] !== "s24") {
      throw new PatchError(`Unexpected branch operand at SuperAnimData.method_866+${instruction.offset}`);
    }
    const oldEnd = instruction.offset + instruction.size;
    const oldTarget = oldEnd + branch[1];
    const newInstructionOffset = remapOffset(instruction.offset);
    const newEnd = newInstructionOffset + instruction.size;
    const newTarget = remapOffset(oldTarget);
    writeS24(newTarget - newEnd).copy(patched, newInstructionOffset + 1);
  }
  return patched;
}

function getMethod866(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "SuperAnimData");
  if (classIndex === null) throw new PatchError("Could not find SuperAnimData class.");
  const methodIndex = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_866");
  if (methodIndex === null) throw new PatchError("Could not find SuperAnimData.method_866.");
  const methodBody = abc.methodBodies.get(methodIndex);
  if (!methodBody) throw new PatchError(`Could not find SuperAnimData.method_866 body (${methodIndex}).`);
  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `SuperAnimData.method_866:${methodIndex}`);
  return { ctx, abc, methodBody, code, instructions };
}

function findLiveFallbackNullCheck(
  instructions: Instruction[],
  abc: ReturnType<typeof parseAbc>,
): number {
  for (let index = 0; index < instructions.length - 18; index += 1) {
    if (getLocalOperand(instructions[index]) !== 11 || instructions[index + 1]?.opcode !== 0x11) {
      continue;
    }
    for (let scan = index + 2; scan < index + 18; scan += 1) {
      if (
        getLocalOperand(instructions[scan]) === 3
        && getLocalOperand(instructions[scan + 1]) === 9
        && instructions[scan + 2]?.opcode === 0x4f
        && u30OperandName(instructions[scan + 2], abc.multinameNames) === "addChild"
      ) {
        return instructions[index].offset;
      }
    }
  }
  throw new PatchError("Could not find SuperAnimData.method_866 live-MovieClip fallback.");
}

function hasNoTargetedLiveFallback(
  instructions: Instruction[],
  abc: ReturnType<typeof parseAbc>,
): boolean {
  return findEarlyGuardRange(instructions, abc) === null
    && findNestedReplayRange(instructions, abc) === null
    && findMarkerGuardRange(instructions, abc, LATE_GFX_GUARD_MARKERS) === null
    && findMarkerGuardRange(instructions, abc, CASTLE_FIRE_GUARD_MARKERS) === null
    && findMarkerGuardRange(instructions, abc, PREVIOUS_ANIMATION_MARKERS) === null;
}

function findLiveFallbackAddChildEnd(
  instructions: Instruction[],
  abc: ReturnType<typeof parseAbc>,
): number {
  const fallbackOffset = findLiveFallbackNullCheck(instructions, abc);
  const fallbackIndex = instructions.findIndex((instruction) => instruction.offset === fallbackOffset);
  for (let index = fallbackIndex + 2; index < Math.min(instructions.length - 2, fallbackIndex + 22); index += 1) {
    if (
      getLocalOperand(instructions[index]) === 3
      && getLocalOperand(instructions[index + 1]) === 9
      && instructions[index + 2].opcode === 0x4f
      && u30OperandName(instructions[index + 2], abc.multinameNames) === "addChild"
    ) {
      return instructions[index + 2].offset + instructions[index + 2].size;
    }
  }
  throw new PatchError("Could not find SuperAnimData.method_866 live-Sprite addChild call.");
}

function findNestedReplayRange(
  instructions: Instruction[],
  abc: ReturnType<typeof parseAbc>,
): { start: number; end: number } | null {
  const start = findLiveFallbackAddChildEnd(instructions, abc);
  const startIndex = instructions.findIndex((instruction) => instruction.offset === start);
  if (startIndex < 0) return null;
  for (let index = startIndex; index < Math.min(instructions.length - 1, startIndex + 220); index += 1) {
    if (getLocalOperand(instructions[index]) !== 19 || instructions[index + 1]?.opcode !== 0x12) continue;
    const candidate = instructions.slice(startIndex, index);
    const names = candidate
      .map((instruction) => u30OperandName(instruction, abc.multinameNames))
      .filter((name): name is string => name !== null);
    const strings = candidate
      .filter((instruction) => instruction.opcode === 0x2c)
      .map((instruction) => abc.stringValues[instruction.operands[0]?.[1] ?? -1]);
    if (
      names.includes("play")
      && names.includes("getChildAt")
      && strings.includes("Castle")
      && strings.includes("Fire")
    ) {
      return { start, end: instructions[index].offset };
    }
    return null;
  }
  return null;
}

function findMethod982Assignment(
  instructions: Instruction[],
  abc: ReturnType<typeof parseAbc>,
): { start: number; end: number } {
  for (let index = 0; index < instructions.length - 4; index += 1) {
    const sequence = instructions.slice(index, index + 5);
    if (
      sequence[0].opcode === 0x5d
      && u30OperandName(sequence[0], abc.multinameNames) === "method_982"
      && getLocalOperand(sequence[1]) === 9
      && sequence[2].opcode === 0x46
      && u30OperandName(sequence[2], abc.multinameNames) === "method_982"
      && sequence[2].operands[1]?.[1] === 1
      && sequence[3].opcode === 0x80
      && u30OperandName(sequence[3], abc.multinameNames) === "Bitmap"
      && sequence[4].opcode === 0x63
      && sequence[4].operands[0]?.[1] === 11
    ) {
      return { start: sequence[0].offset, end: sequence[4].offset + sequence[4].size };
    }
  }
  throw new PatchError("Could not find SuperAnimData.method_866 method_982 Bitmap assignment.");
}

function findEarlyGuardRange(
  instructions: Instruction[],
  abc: ReturnType<typeof parseAbc>,
): { start: number; end: number } | null {
  const rasterize = findMethod982Assignment(instructions, abc);
  const beforeRasterize = instructions.filter((instruction) =>
    instruction.offset >= rasterize.start - 80 && instruction.offset < rasterize.start
  );
  const markerIndex = beforeRasterize.findIndex((instruction) =>
    instruction.opcode === 0x2c
    && abc.stringValues[instruction.operands[0]?.[1] ?? -1] === TARGET_ANIMATION_MARKER
  );
  if (markerIndex < 3) return null;
  const pushedStrings = beforeRasterize
    .filter((instruction) => instruction.opcode === 0x2c)
    .map((instruction) => abc.stringValues[instruction.operands[0]?.[1] ?? -1]);
  if (!pushedStrings.includes(FINAL_MARKER_SOURCE)) return null;
  const start = beforeRasterize[markerIndex - 3];
  if (
    start.opcode !== 0xd0
    || u30OperandName(beforeRasterize[markerIndex - 2], abc.multinameNames) !== "var_36"
    || u30OperandName(beforeRasterize[markerIndex - 1], abc.multinameNames) !== "animClass"
  ) {
    return null;
  }
  const skipsRasterize = beforeRasterize.some((instruction) =>
    instruction.opcode === 0x10
    && instruction.offset + instruction.size + (instruction.operands[0]?.[1] ?? 0) === rasterize.end
  );
  return skipsRasterize ? { start: start.offset, end: rasterize.start } : null;
}

function findMarkerGuardRange(
  instructions: Instruction[],
  abc: ReturnType<typeof parseAbc>,
  markers: readonly string[],
): { start: number; end: number } | null {
  const fallbackOffset = findLiveFallbackNullCheck(instructions, abc);
  const beforeFallback = instructions.filter((instruction) =>
    instruction.offset >= fallbackOffset - 80 && instruction.offset < fallbackOffset
  );
  const firstMarkerIndex = beforeFallback.findIndex((instruction) =>
    instruction.opcode === 0x2c
    && abc.stringValues[instruction.operands[0]?.[1] ?? -1] === markers[0]
  );
  if (firstMarkerIndex < 3) return null;
  const pushedStrings = beforeFallback
    .filter((instruction) => instruction.opcode === 0x2c)
    .map((instruction) => abc.stringValues[instruction.operands[0]?.[1] ?? -1]);
  if (!markers.every((marker) => pushedStrings.includes(marker))) return null;
  const startsWithQualifiedClassName = u30OperandName(
    beforeFallback[firstMarkerIndex - 3],
    abc.multinameNames,
  ) === "getQualifiedClassName";
  const startsWithGfxAnimClass = beforeFallback[firstMarkerIndex - 3].opcode === 0xd0
    && u30OperandName(beforeFallback[firstMarkerIndex - 2], abc.multinameNames) === "var_36"
    && u30OperandName(beforeFallback[firstMarkerIndex - 1], abc.multinameNames) === "animClass";
  if (!startsWithQualifiedClassName && !startsWithGfxAnimClass) {
    return null;
  }
  return { start: beforeFallback[firstMarkerIndex - 3].offset, end: fallbackOffset };
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, code, instructions } = getMethod866(swfPath);
  const [initialLocalCount] = readU30(ctx.body, methodBody.localCountPos, "method_866.local_count");
  if (hasNoTargetedLiveFallback(instructions, abc) && initialLocalCount === ORIGINAL_LOCAL_COUNT) {
    console.log(`${swfPath}: already patched (Home towers use the standard SuperAnim path).`);
    return;
  }
  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; a legacy Home tower live fallback remains.`);
  }

  const earlyGuard = findEarlyGuardRange(instructions, abc);
  const withoutEarlyGuard = earlyGuard
    ? applyCodeReplacementAndAdjustBranches(code, instructions, earlyGuard.start, earlyGuard.end, Buffer.alloc(0))
    : code;
  const withoutEarlyInstructions = disassemble(
    withoutEarlyGuard,
    `SuperAnimData.method_866:${methodBody.methodIdx}:without-early-guard`,
  );
  const replayRange = findNestedReplayRange(withoutEarlyInstructions, abc);
  const withoutReplay = replayRange
    ? applyCodeReplacementAndAdjustBranches(
      withoutEarlyGuard,
      withoutEarlyInstructions,
      replayRange.start,
      replayRange.end,
      Buffer.alloc(0),
    )
    : withoutEarlyGuard;
  const withoutReplayInstructions = disassemble(
    withoutReplay,
    `SuperAnimData.method_866:${methodBody.methodIdx}:without-replay`,
  );
  const lateGuard = findMarkerGuardRange(withoutReplayInstructions, abc, LATE_GFX_GUARD_MARKERS)
    ?? findMarkerGuardRange(withoutReplayInstructions, abc, CASTLE_FIRE_GUARD_MARKERS)
    ?? findMarkerGuardRange(withoutReplayInstructions, abc, PREVIOUS_ANIMATION_MARKERS);
  const cleanedCode = lateGuard
    ? applyCodeReplacementAndAdjustBranches(
      withoutReplay,
      withoutReplayInstructions,
      lateGuard.start,
      lateGuard.end,
      Buffer.alloc(0),
    )
    : withoutReplay;
  const patchedCode = cleanedCode;
  const [localCount, localCountEnd] = readU30(ctx.body, methodBody.localCountPos, "method_866.local_count");
  const patches: BytePatch[] = [
    {
      key: "SuperAnimData.method_866.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "remove obsolete Home tower live fallbacks",
    },
    {
      key: "SuperAnimData.method_866.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: "update SuperAnimData.method_866 code length",
    },
  ];
  if (localCount !== ORIGINAL_LOCAL_COUNT) {
    patches.push({
      key: "SuperAnimData.method_866.localCount",
      start: methodBody.localCountPos,
      end: localCountEnd,
      data: writeU30(ORIGINAL_LOCAL_COUNT),
      detail: "restore original SuperAnimData.method_866 local count",
    });
  }
  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);

  const verified = getMethod866(swfPath);
  const [verifiedLocalCount] = readU30(
    verified.ctx.body,
    verified.methodBody.localCountPos,
    "method_866.local_count",
  );
  if (!hasNoTargetedLiveFallback(verified.instructions, verified.abc) || verifiedLocalCount !== ORIGINAL_LOCAL_COUNT) {
    throw new PatchError(`${swfPath}: patch write completed but verification failed.`);
  }
  console.log(`${swfPath}: restored Home towers to the standard SuperAnim path.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
