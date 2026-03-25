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
const JUMP_TUTORIAL = "am_JumpTut";
const REMOVE_LABEL = "Remove";
const HIDE_TUTORIAL = "HideTutorial";
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

function buildNopBlock(targetLength: number): Buffer {
  return Buffer.alloc(targetLength, NOP);
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

  const jumpTutorialIndex = abc.stringValues.indexOf(JUMP_TUTORIAL);
  const hideTutorialIndex = abc.multinameNames.indexOf(HIDE_TUTORIAL);
  if (jumpTutorialIndex <= 0 || hideTutorialIndex <= 0) {
    throw new PatchError(`Required names not found (${JUMP_TUTORIAL}, ${HIDE_TUTORIAL})`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instrs = disassemble(code, `${CLASS_NAME}.${METHOD_NAME}`);
  const nopRun = Buffer.alloc(21, NOP);

  for (let i = 0; i + 20 < instrs.length; i += 1) {
    const first = instrs[i];
    const second = instrs[i + 1];
    if (first.opcode !== 0x2c || u30OperandName(first, abc.stringValues) !== "a_Room_NRM04R09") {
      continue;
    }
    if (second.opcode !== 0x46 || u30OperandName(second, abc.multinameNames) !== "OnTrigger") {
      continue;
    }

    const nopStart = methodBody.codeStart + second.offset + second.size + 3;
    const existing = ctx.body.subarray(nopStart, nopStart + nopRun.length);
    if (existing.equals(nopRun)) {
      return { ctx, patch: null };
    }
  }

  for (let i = 0; i + 4 < instrs.length; i += 1) {
    const first = instrs[i];
    const second = instrs[i + 1];
    const third = instrs[i + 2];
    const fourth = instrs[i + 3];
    const fifth = instrs[i + 4];

    if (first.opcode !== 0xd1) {
      continue;
    }
    if (second.opcode !== 0x2c || u30OperandName(second, abc.stringValues) !== JUMP_TUTORIAL) {
      continue;
    }
    const matchesRemoveAnimate =
      third.opcode === 0x2c &&
      (u30OperandName(third, abc.stringValues) || u30OperandName(third, abc.multinameNames) || "") ===
        REMOVE_LABEL &&
      fourth.opcode === 0x26 &&
      fifth.opcode === 0x4f &&
      u30OperandName(fifth, abc.multinameNames) === "Animate";

    const matchesHideTutorial =
      third.opcode === 0x4f &&
      third.operands[0]?.[1] === hideTutorialIndex &&
      third.operands[1]?.[1] === 1;

    if (!matchesRemoveAnimate && !matchesHideTutorial) {
      continue;
    }

    const start = methodBody.codeStart + first.offset;
    const endInstruction = matchesHideTutorial ? third : fifth;
    const end = methodBody.codeStart + endInstruction.offset + endInstruction.size;
    const current = ctx.body.subarray(start, end);
    const replacement = buildNopBlock(current.length);
    if (current.equals(replacement)) {
      return { ctx, patch: null };
    }

    return {
      ctx,
      patch: {
        key: "levelsnr_room4_jump_remove_to_hide",
        start,
        end,
        data: replacement,
        detail: `Suppress ${JUMP_TUTORIAL} removal block in ${CLASS_NAME}.${METHOD_NAME}`,
      },
    };
  }

  throw new PatchError(`Could not find ${JUMP_TUTORIAL} Remove Animate block in ${CLASS_NAME}.${METHOD_NAME}`);
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
