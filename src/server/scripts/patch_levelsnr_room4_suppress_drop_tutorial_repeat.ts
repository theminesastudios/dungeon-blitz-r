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
} from "./swfPatchUtils";

const CLASS_NAME = "a_Room_Tutorial_04";
const METHOD_NAME = "WaitingForDrop";
const DROP_TUTORIAL_TARGET = "a_BossTargetRed_20";
const QUICK_FIRE_POWER = "QuickFirePower";
const ANIMATE = "Animate";
const NOP = 0x02;

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

  for (let i = 0; i + 3 < instrs.length; i += 1) {
    const receiver = instrs[i];
    const power = instrs[i + 1];
    const argNull = instrs[i + 2];
    const call = instrs[i + 3];

    if (receiver.opcode !== 0x2c || u30OperandName(receiver, abc.multinameNames) !== DROP_TUTORIAL_TARGET) {
      continue;
    }
    if (power.opcode !== 0x2c || u30OperandName(power, abc.multinameNames) !== QUICK_FIRE_POWER) {
      continue;
    }
    if (argNull.opcode !== 0x26) {
      continue;
    }
    if (call.opcode !== 0x4f || u30OperandName(call, abc.multinameNames) !== ANIMATE) {
      continue;
    }

    const start = methodBody.codeStart + receiver.offset;
    const end = methodBody.codeStart + call.offset + call.size;
    const current = ctx.body.subarray(start, end);
    const replacement = Buffer.alloc(current.length, NOP);
    if (current.equals(replacement)) {
      return { ctx, patch: null };
    }

    return {
      ctx,
      patch: {
        key: "levelsnr_room4_suppress_drop_tutorial_repeat",
        start,
        end,
        data: replacement,
        detail: `Suppress repeated ${DROP_TUTORIAL_TARGET} ${QUICK_FIRE_POWER} animation in ${CLASS_NAME}.${METHOD_NAME}`,
      },
    };
  }

  for (let i = 0; i + 6 < instrs.length; i += 1) {
    const trigger = instrs[i];
    const onTrigger = instrs[i + 1];
    const branch = instrs[i + 2];
    if (
      trigger.opcode === 0x2c &&
      u30OperandName(trigger, abc.multinameNames) === "a_Room_NRM04R10" &&
      onTrigger.opcode === 0x46 &&
      u30OperandName(onTrigger, abc.multinameNames) === "OnTrigger" &&
      branch.opcode === 0x12 &&
      instrs[i + 3].opcode === NOP &&
      instrs[i + 4].opcode === NOP &&
      instrs[i + 5].opcode === NOP &&
      instrs[i + 6].opcode === NOP
    ) {
      return { ctx, patch: null };
    }
  }

  throw new PatchError(
    `Could not find ${DROP_TUTORIAL_TARGET} ${QUICK_FIRE_POWER} animation block in ${CLASS_NAME}.${METHOD_NAME}`,
  );
}

function main(): number {
  const args = process.argv.slice(2);
  const swfPath = resolveSwfPath(args);
  const verifyOnly = hasFlag(args, "--verify") || hasFlag(args, "--dry-run");

  try {
    const { ctx, patch } = analyzePatch(swfPath);
    console.log(`SWF: ${swfPath}`);
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
