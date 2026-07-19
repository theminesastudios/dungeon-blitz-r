import * as fs from "fs";
import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  disassemble,
  ensureBackup,
  Instruction,
  parseAbc,
  parseSwf,
  PatchError,
  writeS32,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const DEFAULT_SWF_CANDIDATES = [
  path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf"),
  path.resolve(__dirname, "..", "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf"),
];
const DEFAULT_SWF = DEFAULT_SWF_CANDIDATES.find((candidate) => fs.existsSync(candidate)) ?? DEFAULT_SWF_CANDIDATES[0];

const OLD_CHARM_DURATIONS_SECONDS = [1800, 4800, 10800, 21600, 36000, 64800, 96000, 144000, 192000, 288000] as const;
const MODERN_CHARM_DURATIONS_SECONDS = [300, 900, 1800, 3600, 7200, 14400, 21600, 28800, 43200, 86400] as const;
const BAD_UNSIGNED_PATCH_DURATIONS_SECONDS = [300, 900, 1800, 3600, 7200, -1984, 21600, 28800, 43200, 86400] as const;
const BAD_CAPPED_UNSIGNED_PATCH_DURATIONS_SECONDS = [300, 900, 1800, 3600, 7200, -1984, 21600, 28800, 43200, 43200] as const;

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
        "  ts-node src/server/scripts/patch-dungeonblitz-forge-charm-durations.ts [--verify] [--swf <path>]",
        "",
        "Patches DungeonBlitz.swf normal charm forge durations to the modern",
        "5min, 15min, 30min, 1h, 2h, 4h, 6h, 8h, 12h, 24h schedule.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function instructionValue(abc: ReturnType<typeof parseAbc>, inst: Instruction): number | null {
  const operand = inst.operands[0];
  if (inst.opcode === 0x24 && operand?.[0] === "s8") {
    return operand[1];
  }
  if (inst.opcode === 0x25 && operand?.[0] === "u30") {
    return operand[1];
  }
  if (inst.opcode === 0x2d && operand?.[0] === "u30") {
    return abc.intValues[operand[1]] ?? null;
  }
  return null;
}

function pushShortPadded(value: number, oldLength: number): Buffer {
  const pushShort = Buffer.concat([Buffer.from([0x25]), writeU30(value)]);
  if (pushShort.length > oldLength) {
    throw new PatchError(`Charm duration replacement is too long: ${pushShort.length} > ${oldLength}`);
  }
  return Buffer.concat([pushShort, Buffer.alloc(oldLength - pushShort.length, 0x02)]);
}

function findDurationSequence(abc: ReturnType<typeof parseAbc>, instructions: Instruction[], sequence: readonly number[]): Instruction[] | null {
  for (let index = 0; index < instructions.length; index += 1) {
    const matched: Instruction[] = [];
    let cursor = index;

    while (cursor < instructions.length && matched.length < sequence.length) {
      const inst = instructions[cursor];
      const value = instructionValue(abc, inst);
      if (value === null) {
        if (inst.opcode === 0x02 && matched.length > 0) {
          cursor += 1;
          continue;
        }
        break;
      }
      if (value !== sequence[matched.length]) {
        break;
      }
      matched.push(inst);
      cursor += 1;
    }

    if (matched.length === sequence.length) {
      return matched;
    }
  }
  return null;
}

function findPatches(swfPath: string): { patches: BytePatch[]; oldSequenceCount: number; modernSequenceCount: number } {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const patches: BytePatch[] = [];
  let oldSequenceCount = 0;
  let modernSequenceCount = 0;

  for (const [methodIdx, methodBody] of abc.methodBodies.entries()) {
    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    let instructions: Instruction[];
    try {
      instructions = disassemble(code, `method_${methodIdx}`);
    } catch {
      continue;
    }
    const oldSequence = findDurationSequence(abc, instructions, OLD_CHARM_DURATIONS_SECONDS);
    const badSequence = findDurationSequence(abc, instructions, BAD_UNSIGNED_PATCH_DURATIONS_SECONDS);
    const cappedBadSequence = findDurationSequence(abc, instructions, BAD_CAPPED_UNSIGNED_PATCH_DURATIONS_SECONDS);
    const modernSequence = findDurationSequence(abc, instructions, MODERN_CHARM_DURATIONS_SECONDS);

    if (modernSequence !== null) {
      modernSequenceCount += 1;
    }
    const sourceSequence = oldSequence ?? badSequence ?? cappedBadSequence;
    const sourceDurations =
      oldSequence !== null ? OLD_CHARM_DURATIONS_SECONDS :
        badSequence !== null ? BAD_UNSIGNED_PATCH_DURATIONS_SECONDS :
          BAD_CAPPED_UNSIGNED_PATCH_DURATIONS_SECONDS;
    if (sourceSequence === null) {
      continue;
    }

    oldSequenceCount += 1;
    for (let offset = 0; offset < OLD_CHARM_DURATIONS_SECONDS.length; offset += 1) {
      const inst = sourceSequence[offset];
      const nextValue = MODERN_CHARM_DURATIONS_SECONDS[offset];

      if (inst.opcode === 0x25) {
        patches.push({
          key: `method_${methodIdx}.charmDurationInline.${offset}`,
          start: methodBody.codeStart + inst.offset,
          end: methodBody.codeStart + inst.offset + inst.size,
          data: pushShortPadded(nextValue, inst.size),
          detail: `replace inline charm duration ${sourceDurations[offset]} with ${nextValue}`,
        });
        continue;
      }

      const operand = inst.operands[0];
      if (inst.opcode !== 0x2d || operand?.[0] !== "u30") {
        throw new PatchError(`Unexpected charm duration opcode 0x${inst.opcode.toString(16)} at sequence offset ${offset}`);
      }

      const intIndex = operand[1];
      const intStart = abc.intValuePositions[intIndex];
      const intEnd = abc.intValueEndPositions[intIndex];
      if (!intStart || !intEnd || abc.intValues[intIndex] !== sourceDurations[offset]) {
        throw new PatchError(`Unexpected int constant for charm duration ${sourceDurations[offset]}`);
      }

      patches.push({
        key: `method_${methodIdx}.charmDurationConstant.${offset}`,
        start: intStart,
        end: intEnd,
        data: writeS32(nextValue),
        detail: `replace charm duration constant ${sourceDurations[offset]} with ${nextValue}`,
      });
    }
  }

  return {
    patches,
    oldSequenceCount,
    modernSequenceCount,
  };
}

function patchSwf(swfPath: string, verify: boolean): void {
  const firstPass = findPatches(swfPath);
  if (verify) {
    if (firstPass.oldSequenceCount > 0 || firstPass.modernSequenceCount !== 1) {
      throw new PatchError(
        `Charm forge duration patch missing: old=${firstPass.oldSequenceCount}, modern=${firstPass.modernSequenceCount}`,
      );
    }
    console.log("Charm forge duration patch verified.");
    return;
  }

  if (firstPass.patches.length === 0) {
    if (firstPass.modernSequenceCount === 1) {
      console.log("Charm forge duration patch already applied.");
      return;
    }
    throw new PatchError(`Could not find old or modern charm duration sequence in ${swfPath}`);
  }

  const ctx = parseSwf(swfPath);
  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, firstPass.patches);
  writeSwf(ctx, body, delta);

  const secondPass = findPatches(swfPath);
  if (secondPass.oldSequenceCount > 0 || secondPass.modernSequenceCount !== 1) {
    throw new PatchError(
      `Charm forge duration patch did not verify after write: old=${secondPass.oldSequenceCount}, modern=${secondPass.modernSequenceCount}`,
    );
  }

  console.log("Charm forge duration patch applied.");
}

const args = parseArgs(process.argv);
patchSwf(args.swfPath, args.verify);
