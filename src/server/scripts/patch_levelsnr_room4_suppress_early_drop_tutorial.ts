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
const METHOD_NAME = "WaitingForJump";
const DROP_TUTORIAL = "am_DropTut";
const SHOW_STATE = "Show";
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

  for (let i = 0; i + 4 < instrs.length; i += 1) {
    const first = instrs[i];
    const second = instrs[i + 1];
    const third = instrs[i + 2];
    const fourth = instrs[i + 3];
    const fifth = instrs[i + 4];

    if (first.opcode !== 0xd1) {
      continue;
    }
    if (second.opcode !== 0x2c || u30OperandName(second, abc.stringValues) !== DROP_TUTORIAL) {
      continue;
    }
    if (
      third.opcode !== 0x2c ||
      (u30OperandName(third, abc.stringValues) !== SHOW_STATE &&
        u30OperandName(third, abc.multinameNames) !== SHOW_STATE)
    ) {
      continue;
    }
    if (fourth.opcode !== 0x26) {
      continue;
    }
    if (fifth.opcode !== 0x4f || u30OperandName(fifth, abc.multinameNames) !== "Animate") {
      continue;
    }

    const start = methodBody.codeStart + first.offset;
    const end = methodBody.codeStart + fifth.offset + fifth.size;
    const current = ctx.body.subarray(start, end);
    const replacement = Buffer.alloc(current.length, NOP);
    if (current.equals(replacement)) {
      return { ctx, patch: null };
    }

    return {
      ctx,
      patch: {
        key: "levelsnr_room4_suppress_early_drop_tutorial",
        start,
        end,
        data: replacement,
        detail: `Suppress early ${DROP_TUTORIAL} overlay in ${CLASS_NAME}.${METHOD_NAME}`,
      },
    };
  }

  throw new PatchError(`Could not find early ${DROP_TUTORIAL} animation block in ${CLASS_NAME}.${METHOD_NAME}`);
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
