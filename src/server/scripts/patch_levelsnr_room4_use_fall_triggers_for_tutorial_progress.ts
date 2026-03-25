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

type TargetSpec = {
  methodName: string;
  currentTrigger: string;
  targetTrigger: string;
  occurrence: number;
  patchKey: string;
};

const TARGETS: TargetSpec[] = [
  {
    methodName: "WaitingForJump",
    currentTrigger: "am_Trigger_2",
    targetTrigger: "am_Trigger_Fall2",
    occurrence: 2,
    patchKey: "levelsnr_room4_jump_progress_on_fall2",
  },
  {
    methodName: "WaitingForDrop",
    currentTrigger: "am_Trigger_3",
    targetTrigger: "am_Trigger_Fall3",
    occurrence: 2,
    patchKey: "levelsnr_room4_drop_progress_on_fall3",
  },
];

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
  patches: BytePatch[];
} {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, CLASS_NAME);
  if (classIndex === null) {
    throw new PatchError(`${CLASS_NAME} class not found`);
  }

  const patches: BytePatch[] = [];

  for (const target of TARGETS) {
    const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, target.methodName);
    if (methodIdx === null) {
      throw new PatchError(`${CLASS_NAME}.${target.methodName} not found`);
    }

    const methodBody = abc.methodBodies.get(methodIdx);
    if (!methodBody) {
      throw new PatchError(`${CLASS_NAME}.${target.methodName} body not found`);
    }

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const instrs = disassemble(code, `${CLASS_NAME}.${target.methodName}`);
    const replacementIndex = abc.stringValues.indexOf(target.targetTrigger);
    if (replacementIndex <= 0) {
      throw new PatchError(`Required trigger string not found (${target.targetTrigger})`);
    }

    let seen = 0;
    let candidate: typeof instrs[number] | null = null;
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
      if (triggerName !== target.currentTrigger && triggerName !== target.targetTrigger) {
        continue;
      }

      seen += 1;
      if (seen === target.occurrence) {
        candidate = inst;
        if (triggerName === target.targetTrigger) {
          candidate = null;
        }
        break;
      }
    }

    if (seen < target.occurrence) {
      throw new PatchError(
        `Could not find occurrence ${target.occurrence} of ${target.currentTrigger} in ${CLASS_NAME}.${target.methodName}`,
      );
    }

    if (!candidate) {
      continue;
    }

    const replacement = writeU30(replacementIndex);
    const operandStart = methodBody.codeStart + candidate.offset + 1;
    const operandEnd = methodBody.codeStart + candidate.offset + candidate.size;
    const currentBytes = ctx.body.subarray(operandStart, operandEnd);
    if (currentBytes.length !== replacement.length) {
      throw new PatchError(`Unsupported varint width change ${currentBytes.length} -> ${replacement.length}`);
    }

    patches.push({
      key: target.patchKey,
      start: operandStart,
      end: operandEnd,
      data: replacement,
      detail: `Retarget ${CLASS_NAME}.${target.methodName} occurrence ${target.occurrence} from ${target.currentTrigger} to ${target.targetTrigger}`,
    });
  }

  return { ctx, patches };
}

function main(): number {
  const args = process.argv.slice(2);
  const swfPath = resolveSwfPath(args);
  const verifyOnly = hasFlag(args, "--verify") || hasFlag(args, "--dry-run");

  try {
    const { ctx, patches } = analyzePatch(swfPath);
    console.log(`SWF: ${swfPath}`);
    if (patches.length === 0) {
      console.log("No changes needed.");
      return 0;
    }

    for (const patch of patches) {
      console.log(`Patch: ${patch.detail}`);
    }

    if (verifyOnly) {
      return 0;
    }

    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(ctx.body, patches);
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
