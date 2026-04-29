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
const DROP_TRIGGER = "a_Room_NRM04R10";
const SCRIPT_FALL = "Script_Fall";
const GETLOCAL1 = 0xd1;
const PUSHNULL = 0x20;
const POP = 0x29;
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
  const replacement = Buffer.from([GETLOCAL1, PUSHNULL, POP, POP, NOP, NOP, NOP, NOP]);

  for (let i = 0; i + 7 < instrs.length; i += 1) {
    const trigger = instrs[i];
    const onTrigger = instrs[i + 1];
    const branch = instrs[i + 2];
    const receiver = instrs[i + 3];
    const local0 = instrs[i + 4];
    const scriptLoad = instrs[i + 5];
    const playScript = instrs[i + 6];

    if (trigger.opcode !== 0x2c || u30OperandName(trigger, abc.multinameNames) !== DROP_TRIGGER) {
      continue;
    }
    if (onTrigger.opcode !== 0x46 || u30OperandName(onTrigger, abc.multinameNames) !== "OnTrigger") {
      continue;
    }
    if (branch.opcode !== 0x12 || branch.operands.length !== 1 || branch.operands[0][0] !== "s24") {
      continue;
    }
    if (receiver.opcode === GETLOCAL1 && local0.opcode === PUSHNULL && scriptLoad.opcode === POP && playScript.opcode === POP) {
      const start = methodBody.codeStart + receiver.offset;
      const end = start + replacement.length;
      if (ctx.body.subarray(start, end).equals(replacement)) {
        return { ctx, patch: null };
      }
    }
    if (receiver.opcode !== 0xd1) {
      continue;
    }
    if (local0.opcode !== 0xd0) {
      continue;
    }
    if (scriptLoad.opcode !== 0x66 || u30OperandName(scriptLoad, abc.multinameNames) !== SCRIPT_FALL) {
      continue;
    }
    if (playScript.opcode !== 0x4f || u30OperandName(playScript, abc.multinameNames) !== "PlayScript") {
      continue;
    }

    const start = methodBody.codeStart + receiver.offset;
    const end = methodBody.codeStart + playScript.offset + playScript.size;
    const current = ctx.body.subarray(start, end);
    if (current.equals(replacement)) {
      return { ctx, patch: null };
    }
    if (current.length !== replacement.length) {
      throw new PatchError(`Unexpected ${SCRIPT_FALL} block size ${current.length}`);
    }

    return {
      ctx,
      patch: {
        key: "levelsnr_room4_suppress_drop_repeat_dialog",
        start,
        end,
        data: replacement,
        detail: `Suppress repeated ${SCRIPT_FALL} playback in ${CLASS_NAME}.${METHOD_NAME}`,
      },
    };
  }

  throw new PatchError(`Could not find ${DROP_TRIGGER} -> ${SCRIPT_FALL} block in ${CLASS_NAME}.${METHOD_NAME}`);
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
