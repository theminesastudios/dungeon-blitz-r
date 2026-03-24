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
type TriggerTarget = {
  methodName: string;
  acceptedTriggers: string[];
  targetTrigger: string;
  patchKey: string;
};

const TARGETS: TriggerTarget[] = [
  {
    methodName: "WaitingForJump",
    acceptedTriggers: ["am_Trigger_Fall2", "am_Leader2", "am_Parrot", "am_Trigger_2"],
    targetTrigger: "am_Trigger_2",
    patchKey: "levelsnr_room4_waitingforjump_trigger",
  },
  {
    methodName: "WaitingForDrop",
    acceptedTriggers: ["am_Trigger_Fall3", "am_Leader3", "am_Parrot", "am_Trigger_3"],
    targetTrigger: "am_Trigger_3",
    patchKey: "levelsnr_room4_waitingfordrop_trigger",
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
  currentTriggers: Array<{ methodName: string; triggerName: string }>;
} {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);

  const classIndex = classIndexByName(abc, CLASS_NAME);
  if (classIndex === null) {
    throw new PatchError(`${CLASS_NAME} class not found`);
  }

  const patches: BytePatch[] = [];
  const currentTriggers: Array<{ methodName: string; triggerName: string }> = [];

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

    const targetIndex = abc.stringValues.indexOf(target.targetTrigger);
    if (targetIndex <= 0) {
      throw new PatchError(`Required trigger string not found (${target.targetTrigger})`);
    }

    const replacement = writeU30(targetIndex);
    const candidates = [];
    for (let i = 0; i + 1 < instrs.length; i += 1) {
      const inst = instrs[i];
      const next = instrs[i + 1];
      if (inst.opcode !== 0x2c || inst.operands.length !== 1 || inst.operands[0][0] !== "u30") {
        continue;
      }
      if (next.opcode !== 0x46 || u30OperandName(next, abc.multinameNames) !== "OnTrigger") {
        continue;
      }

      const triggerName = u30OperandName(inst, abc.stringValues);
      if (triggerName && target.acceptedTriggers.includes(triggerName)) {
        candidates.push({ inst, triggerName });
      }
    }

    if (candidates.length === 0) {
      throw new PatchError(
        `No ${target.acceptedTriggers.join("/")} OnTrigger check found in ${CLASS_NAME}.${target.methodName}`
      );
    }
    if (candidates.length > 1) {
      throw new PatchError(`Found multiple candidate OnTrigger checks in ${CLASS_NAME}.${target.methodName}`);
    }

    const { inst: candidate, triggerName } = candidates[0];
    currentTriggers.push({ methodName: target.methodName, triggerName });
    if (triggerName === target.targetTrigger) {
      continue;
    }

    const operandStart = methodBody.codeStart + candidate.offset + 1;
    const operandEnd = methodBody.codeStart + candidate.size + candidate.offset;
    const currentBytes = ctx.body.subarray(operandStart, operandEnd);
    if (currentBytes.length !== replacement.length) {
      throw new PatchError(`Unsupported varint width change ${currentBytes.length} -> ${replacement.length}`);
    }

    patches.push({
      key: target.patchKey,
      start: operandStart,
      end: operandEnd,
      data: replacement,
      detail: `Retarget ${CLASS_NAME}.${target.methodName} from ${triggerName} to ${target.targetTrigger}`,
    });
  }

  return { ctx, patches, currentTriggers };
}

function main(): number {
  const args = process.argv.slice(2);
  const swfPath = resolveSwfPath(args);
  const verifyOnly = hasFlag(args, "--verify") || hasFlag(args, "--dry-run");

  try {
    const { ctx, patches, currentTriggers } = analyzePatch(swfPath);
    console.log(`SWF: ${swfPath}`);
    for (const current of currentTriggers) {
      console.log(`${current.methodName} trigger: ${current.triggerName}`);
    }
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
