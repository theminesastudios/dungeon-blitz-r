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

const CLASS_NAME = "a_Room_Tutorial_04";
const METHOD_NAME = "WaitingForDrop";
const TARGET_TRIGGER = "a_Room_NRM04R10";
const ACCEPTED_TRIGGERS = ["am_Leader3", "am_Trigger_3", TARGET_TRIGGER];

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

function analyzePatch(swfPath: string): {
  ctx: ReturnType<typeof parseSwf>;
  patch: BytePatch | null;
  currentTrigger: string;
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
  const targetIndex = abc.multinameNames.indexOf(TARGET_TRIGGER);
  if (targetIndex <= 0) {
    throw new PatchError(`Required multiname not found (${TARGET_TRIGGER})`);
  }

  const candidates = [];
  for (let i = 0; i + 2 < instrs.length; i += 1) {
    const inst = instrs[i];
    const next = instrs[i + 1];
    const branch = instrs[i + 2];
    if (inst.opcode !== 0x2c || next.opcode !== 0x46 || branch.opcode !== 0x12) {
      continue;
    }
    const triggerName =
      u30OperandName(inst, abc.multinameNames) ||
      u30OperandName(inst, abc.stringValues) ||
      "";
    if (!ACCEPTED_TRIGGERS.includes(triggerName)) {
      continue;
    }
    if (branch.operands.length !== 1 || branch.operands[0][0] !== "s24" || branch.operands[0][1] !== 34) {
      continue;
    }
    candidates.push({ inst, triggerName });
  }

  if (candidates.length !== 1) {
    throw new PatchError(`Expected exactly one completion trigger in ${CLASS_NAME}.${METHOD_NAME}, found ${candidates.length}`);
  }

  const { inst: candidate, triggerName } = candidates[0];
  if (triggerName === TARGET_TRIGGER) {
    return { ctx, patch: null, currentTrigger: triggerName };
  }

  const replacement = writeU30(targetIndex);
  const operandStart = methodBody.codeStart + candidate.offset + 1;
  const operandEnd = methodBody.codeStart + candidate.offset + candidate.size;
  const currentBytes = ctx.body.subarray(operandStart, operandEnd);
  if (currentBytes.length !== replacement.length) {
    throw new PatchError(`Unsupported varint width change ${currentBytes.length} -> ${replacement.length}`);
  }

  return {
    ctx,
    currentTrigger: triggerName,
    patch: {
      key: "levelsnr_room4_waitingfordrop_autocomplete",
      start: operandStart,
      end: operandEnd,
      data: replacement,
      detail: `Retarget ${CLASS_NAME}.${METHOD_NAME} completion trigger from ${triggerName} to ${TARGET_TRIGGER}`,
    },
  };
}

function main(): number {
  const args = process.argv.slice(2);
  const swfPath = resolveSwfPath(args);
  const verifyOnly = hasFlag(args, "--verify") || hasFlag(args, "--dry-run");

  try {
    const { ctx, patch, currentTrigger } = analyzePatch(swfPath);
    console.log(`SWF: ${swfPath}`);
    console.log(`${METHOD_NAME} completion trigger: ${currentTrigger}`);
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
