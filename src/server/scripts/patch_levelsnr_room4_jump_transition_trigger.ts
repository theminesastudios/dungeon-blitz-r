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
const METHOD_NAME = "WaitingForJump";
const CURRENT_TRIGGER = "a_Room_NRM04R09";
const TARGET_TRIGGER = "am_Trigger_2";

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
  const targetIndex = abc.stringValues.indexOf(TARGET_TRIGGER);
  if (targetIndex <= 0) {
    throw new PatchError(`Required trigger string not found (${TARGET_TRIGGER})`);
  }

  const candidates = [];
  for (let i = 0; i + 1 < instrs.length; i += 1) {
    const inst = instrs[i];
    const next = instrs[i + 1];
    if (inst.opcode !== 0x2c || next.opcode !== 0x46) {
      continue;
    }
    if (u30OperandName(next, abc.multinameNames) !== "OnTrigger") {
      continue;
    }
    const triggerName = u30OperandName(inst, abc.stringValues) || "";
    if (triggerName === CURRENT_TRIGGER || triggerName === TARGET_TRIGGER) {
      candidates.push({ inst, triggerName });
    }
  }

  const current = candidates.find((candidate) => candidate.triggerName === CURRENT_TRIGGER);
  if (!current) {
    const alreadyPatched = candidates.find((candidate) => candidate.triggerName === TARGET_TRIGGER && candidate.inst.offset > 50);
    if (alreadyPatched) {
      return { ctx, patch: null, currentTrigger: TARGET_TRIGGER };
    }
    throw new PatchError(`Could not find ${CURRENT_TRIGGER} trigger in ${CLASS_NAME}.${METHOD_NAME}`);
  }

  const replacement = writeU30(targetIndex);
  const operandStart = methodBody.codeStart + current.inst.offset + 1;
  const operandEnd = methodBody.codeStart + current.inst.offset + current.inst.size;
  const currentBytes = ctx.body.subarray(operandStart, operandEnd);
  if (currentBytes.length !== replacement.length) {
    throw new PatchError(`Unsupported varint width change ${currentBytes.length} -> ${replacement.length}`);
  }

  return {
    ctx,
    currentTrigger: current.triggerName,
    patch: {
      key: "levelsnr_room4_waitingforjump_transition_trigger",
      start: operandStart,
      end: operandEnd,
      data: replacement,
      detail: `Retarget ${CLASS_NAME}.${METHOD_NAME} transition trigger from ${CURRENT_TRIGGER} to ${TARGET_TRIGGER}`,
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
    console.log(`${METHOD_NAME} transition trigger: ${currentTrigger}`);
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
