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
const METHOD_NAME = "FirstTick";
const CURRENT_PHASE = "WaitingForDrop";
const TARGET_PHASE = "WaitingForJump";

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
  currentPhase: string;
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
  const currentPhaseIndex = abc.multinameNames.indexOf(CURRENT_PHASE);
  const targetPhaseIndex = abc.multinameNames.indexOf(TARGET_PHASE);
  if (currentPhaseIndex <= 0 || targetPhaseIndex <= 0) {
    throw new PatchError(`Required phase strings not found (${CURRENT_PHASE}, ${TARGET_PHASE})`);
  }

  const phaseInst = instrs.find((inst) =>
    inst.opcode === 0x66 &&
    inst.operands.length === 1 &&
    inst.operands[0][0] === "u30" &&
    (
      u30OperandName(inst, abc.multinameNames) === CURRENT_PHASE
    )
  );

  if (!phaseInst) {
    const alreadyTarget = instrs.find((inst) =>
      inst.opcode === 0x66 &&
      inst.operands.length === 1 &&
      inst.operands[0][0] === "u30" &&
      (
        u30OperandName(inst, abc.multinameNames) === TARGET_PHASE
      )
    );
    if (alreadyTarget) {
      return { ctx, patch: null, currentPhase: TARGET_PHASE };
    }
    throw new PatchError(`Could not find ${CURRENT_PHASE} phase load in ${CLASS_NAME}.${METHOD_NAME}`);
  }

  const replacement = writeU30(targetPhaseIndex);
  const operandStart = methodBody.codeStart + phaseInst.offset + 1;
  const operandEnd = methodBody.codeStart + phaseInst.offset + phaseInst.size;
  const currentBytes = ctx.body.subarray(operandStart, operandEnd);
  if (currentBytes.length !== replacement.length) {
    throw new PatchError(`Unsupported varint width change ${currentBytes.length} -> ${replacement.length}`);
  }

  return {
    ctx,
    currentPhase: CURRENT_PHASE,
    patch: {
      key: "levelsnr_room4_firsttick_force_drop_tutorial",
      start: operandStart,
      end: operandEnd,
      data: replacement,
      detail: `Retarget ${CLASS_NAME}.${METHOD_NAME} phase from ${CURRENT_PHASE} to ${TARGET_PHASE}`,
    },
  };
}

function main(): number {
  const args = process.argv.slice(2);
  const swfPath = resolveSwfPath(args);
  const verifyOnly = hasFlag(args, "--verify") || hasFlag(args, "--dry-run");

  try {
    const { ctx, patch, currentPhase } = analyzePatch(swfPath);
    console.log(`SWF: ${swfPath}`);
    console.log(`${METHOD_NAME} phase: ${currentPhase}`);
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
