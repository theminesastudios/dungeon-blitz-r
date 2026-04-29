import * as fs from "fs";
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
const FIRST_TRIGGER = "am_Trigger_Fall2";
const REQUIRED_TRIGGER = "am_Trigger_2";
const TIMER_METHOD = "AtTime";
const TRIGGER_METHOD = "OnTrigger";

function resolveSwfPath(args: string[]): string {
  const idx = args.indexOf("--swf-path");
  if (idx !== -1 && idx + 1 < args.length) {
    return path.resolve(args[idx + 1]);
  }

  const candidates = [
    defaultLevelsNrPath(),
    path.resolve(process.cwd(), "src", "client", "content", "localhost", "p", "cbp", "LevelsNR.swf"),
    path.resolve(__dirname, "..", "..", "..", "client", "content", "localhost", "p", "cbp", "LevelsNR.swf"),
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  if (!resolved) {
    throw new PatchError("Could not resolve LevelsNR.swf path");
  }
  return resolved;
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

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, METHOD_NAME);
  if (methodIdx === null) {
    throw new PatchError(`${CLASS_NAME}.${METHOD_NAME} not found`);
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`${CLASS_NAME}.${METHOD_NAME} body not found`);
  }

  const requiredTriggerIndex = abc.stringValues.indexOf(REQUIRED_TRIGGER);
  const firstTriggerIndex = abc.stringValues.indexOf(FIRST_TRIGGER);
  const onTriggerNameIndex = abc.multinameNames.indexOf(TRIGGER_METHOD);
  if (requiredTriggerIndex <= 0 || firstTriggerIndex <= 0 || onTriggerNameIndex <= 0) {
    throw new PatchError("Required trigger metadata not found in ABC pools");
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instrs = disassemble(code, `${CLASS_NAME}.${METHOD_NAME}`);
  const patches: BytePatch[] = [];
  let onTriggerChecksSeen = 0;
  let jumpGateFound = false;

  for (let i = 0; i + 1 < instrs.length; i += 1) {
    const inst = instrs[i];
    const next = instrs[i + 1];
    if (next.opcode !== 0x46) {
      continue;
    }

    const callName = u30OperandName(next, abc.multinameNames) || "";
    if (callName !== TRIGGER_METHOD && callName !== TIMER_METHOD) {
      continue;
    }

    const instStart = methodBody.codeStart + inst.offset;
    const instEnd = methodBody.codeStart + inst.offset + inst.size;
    const callStart = methodBody.codeStart + next.offset;
    const callEnd = methodBody.codeStart + next.offset + next.size;

    const timerValue = inst.operands.length > 0 ? inst.operands[0][1] : -1;
    const isCorruptJumpGate =
      inst.opcode === 0x25 &&
      callName === TRIGGER_METHOD &&
      timerValue === requiredTriggerIndex;

    if (callName === TRIGGER_METHOD && inst.opcode === 0x2c) {
      const triggerName = u30OperandName(inst, abc.stringValues) || "";
      if (triggerName === FIRST_TRIGGER) {
        onTriggerChecksSeen += 1;
      }
      if (triggerName === REQUIRED_TRIGGER) {
        jumpGateFound = true;
      }
      continue;
    }

    if (timerValue !== 1200 && !isCorruptJumpGate) {
      continue;
    }

    const replacementTrigger = Buffer.concat([Buffer.from([0x2c]), writeU30(requiredTriggerIndex)]);
    const replacementCall = Buffer.from([0x46, ...writeU30(onTriggerNameIndex), 0x01]);
    const currentTrigger = ctx.body.subarray(instStart, instEnd);
    const currentCall = ctx.body.subarray(callStart, callEnd);

    if (currentTrigger.length !== replacementTrigger.length || currentCall.length !== replacementCall.length) {
      throw new PatchError("Unsupported width change while restoring jump gate");
    }

    patches.push({
      key: "levelsnr_room4_restore_jump_gate_trigger",
      start: instStart,
      end: instEnd,
      data: replacementTrigger,
      detail: `Restore ${REQUIRED_TRIGGER} as the ${METHOD_NAME} transition trigger`,
    });
    patches.push({
      key: "levelsnr_room4_restore_jump_gate_call",
      start: callStart,
      end: callEnd,
      data: replacementCall,
      detail: `Restore ${TRIGGER_METHOD} call for the ${METHOD_NAME} transition gate`,
    });
    jumpGateFound = true;
  }

  if (onTriggerChecksSeen === 0) {
    throw new PatchError(`Could not find initial ${FIRST_TRIGGER} gate in ${CLASS_NAME}.${METHOD_NAME}`);
  }
  if (!jumpGateFound) {
    throw new PatchError(`Could not find ${REQUIRED_TRIGGER} or timer transition in ${CLASS_NAME}.${METHOD_NAME}`);
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
