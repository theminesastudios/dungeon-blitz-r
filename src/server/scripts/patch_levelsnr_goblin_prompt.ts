import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  defaultLevelsNrPath,
  disassemble,
  ensureBackup,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  u30OperandName,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const CLASS_NAME = "a_Room_NRIMR03";
const METHOD_NAME = "WaitingOnGoblin";
const OLD_DELAY_MS = 12000;
const NEW_DELAY_MS = 2500;

function resolveSwfPath(args: string[]): string {
  const idx = args.indexOf("--swf-path");
  if (idx !== -1 && idx + 1 < args.length) {
    return path.resolve(args[idx + 1]);
  }
  return defaultLevelsNrPath();
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function analyzeDelayPatch(swfPath: string): {
  ctx: ReturnType<typeof parseSwf>;
  patch: BytePatch | null;
  currentBytes: Buffer;
  currentDelay: number;
} {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);

  const classIndex = classIndexByName(abc, CLASS_NAME);
  if (classIndex === null) {
    throw new PatchError(`${CLASS_NAME} class not found`);
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, METHOD_NAME);
  if (methodIdx === null) {
    throw new PatchError(`${CLASS_NAME}.${METHOD_NAME} not found`);
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`${CLASS_NAME}.${METHOD_NAME} body not found`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instrs = disassemble(code, `${CLASS_NAME}.${METHOD_NAME}`);

  const candidates: Array<{ offset: number; size: number; delay: number }> = [];
  for (let i = 0; i < instrs.length; i += 1) {
    const inst = instrs[i];
    if (inst.opcode !== 0x25 || inst.operands.length === 0 || inst.operands[0][0] !== "u30") {
      continue;
    }
    const delayValue = inst.operands[0][1];
    if (delayValue !== OLD_DELAY_MS && delayValue !== NEW_DELAY_MS) {
      continue;
    }
    for (let j = i + 1; j < Math.min(i + 4, instrs.length); j += 1) {
      const lookahead = instrs[j];
      if (lookahead.opcode === 0x46 && u30OperandName(lookahead, abc.multinameNames) === "AtTime") {
        candidates.push({ offset: inst.offset, size: inst.size, delay: delayValue });
        break;
      }
    }
  }

  if (candidates.length === 0) {
    throw new PatchError(`Could not find AtTime delay used by ${CLASS_NAME}.${METHOD_NAME}`);
  }
  if (candidates.length > 1) {
    throw new PatchError(`Found multiple candidate delays for ${CLASS_NAME}.${METHOD_NAME}: ${JSON.stringify(candidates)}`);
  }

  const candidate = candidates[0];
  const operandStart = methodBody.codeStart + candidate.offset + 1;
  const operandEnd = methodBody.codeStart + candidate.offset + candidate.size;
  const currentBytes = ctx.body.subarray(operandStart, operandEnd);
  const replacement = writeU30(NEW_DELAY_MS);
  if (currentBytes.length !== replacement.length) {
    throw new PatchError(`Unsupported varint width change for delay: ${currentBytes.length} -> ${replacement.length}`);
  }

  if (currentBytes.equals(replacement)) {
    return { ctx, patch: null, currentBytes, currentDelay: candidate.delay };
  }

  return {
    ctx,
    currentBytes,
    currentDelay: candidate.delay,
    patch: {
      key: "levelsnr_goblin_prompt_delay",
      start: operandStart,
      end: operandEnd,
      data: replacement,
      detail: `Change ${CLASS_NAME}.${METHOD_NAME} AtTime(${OLD_DELAY_MS}) to AtTime(${NEW_DELAY_MS})`,
    },
  };
}

function main(): number {
  const args = process.argv.slice(2);
  const swfPath = resolveSwfPath(args);
  const verifyOnly = hasFlag(args, "--verify") || hasFlag(args, "--dry-run");

  try {
    const { ctx, patch, currentBytes, currentDelay } = analyzeDelayPatch(swfPath);
    const replacement = writeU30(NEW_DELAY_MS);

    console.log(`SWF: ${swfPath}`);
    console.log(`Target: ${CLASS_NAME}.${METHOD_NAME}`);
    console.log(`Current delay bytes: ${currentBytes.toString("hex")} (${currentDelay})`);
    console.log(`Replacement bytes:   ${replacement.toString("hex")} (${NEW_DELAY_MS})`);

    if (!patch) {
      console.log("No changes needed.");
      return 0;
    }

    console.log(`Patch: ${patch.detail}`);
    if (verifyOnly) {
      return 0;
    }

    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(ctx.body, [patch]);
    writeSwf(ctx, body, delta);
    console.log("Patch apply complete.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Patch error: ${message}`);
    return 1;
  }
}

process.exit(main());
