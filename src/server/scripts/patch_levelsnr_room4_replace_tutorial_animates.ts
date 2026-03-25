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
const SHOW_TUTORIAL = "ShowTutorial";
const JUMP_TUTORIAL = "am_JumpTut";
const DROP_TUTORIAL = "am_DropTut";
const SHOW_LABEL = "Show";
const REMOVE_LABEL = "Remove";
const NOP = 0x02;

type TargetSpec = {
  methodName: string;
  tutorialName: string;
  stateLabel: string;
  patchKey: string;
};

const TARGETS: TargetSpec[] = [
  {
    methodName: "WaitingForJump",
    tutorialName: JUMP_TUTORIAL,
    stateLabel: SHOW_LABEL,
    patchKey: "levelsnr_room4_jump_overlay_to_showtutorial",
  },
  {
    methodName: "WaitingForDrop",
    tutorialName: DROP_TUTORIAL,
    stateLabel: REMOVE_LABEL,
    patchKey: "levelsnr_room4_drop_overlay_to_showtutorial",
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

function buildShowTutorialBlock(tutorialIndex: number, showTutorialIndex: number, targetLength: number): Buffer {
  const base = Buffer.concat([
    Buffer.from([0xd1]),
    Buffer.from([0x2c]),
    writeU30(tutorialIndex),
    Buffer.from([0x4f]),
    writeU30(showTutorialIndex),
    writeU30(1),
  ]);

  if (base.length > targetLength) {
    throw new PatchError(`ShowTutorial payload (${base.length}) exceeds target block length (${targetLength})`);
  }

  if (base.length === targetLength) {
    return base;
  }

  return Buffer.concat([base, Buffer.alloc(targetLength - base.length, NOP)]);
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

  const showTutorialIndex = abc.multinameNames.indexOf(SHOW_TUTORIAL);
  if (showTutorialIndex <= 0) {
    throw new PatchError(`${SHOW_TUTORIAL} multiname not found`);
  }

  const patches: BytePatch[] = [];

  for (const target of TARGETS) {
    const tutorialIndex = abc.stringValues.indexOf(target.tutorialName);
    if (tutorialIndex <= 0) {
      throw new PatchError(`${target.tutorialName} string not found`);
    }

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

    let matchStart = -1;
    let matchEnd = -1;
    for (let i = 0; i + 4 < instrs.length; i += 1) {
      const first = instrs[i];
      const second = instrs[i + 1];
      const third = instrs[i + 2];
      const fourth = instrs[i + 3];
      const fifth = instrs[i + 4];

      if (first.opcode !== 0xd1) {
        continue;
      }
      if (second.opcode !== 0x2c || u30OperandName(second, abc.stringValues) !== target.tutorialName) {
        continue;
      }
      const stateName =
        u30OperandName(third, abc.stringValues) || u30OperandName(third, abc.multinameNames) || "";
      if (third.opcode !== 0x2c || stateName !== target.stateLabel) {
        continue;
      }
      if (fourth.opcode !== 0x26) {
        continue;
      }
      if (fifth.opcode !== 0x4f || u30OperandName(fifth, abc.multinameNames) !== "Animate") {
        continue;
      }

      matchStart = methodBody.codeStart + first.offset;
      matchEnd = methodBody.codeStart + fifth.offset + fifth.size;
      break;
    }

    if (matchStart < 0 || matchEnd <= matchStart) {
      continue;
    }

    const current = ctx.body.subarray(matchStart, matchEnd);
    const replacement = buildShowTutorialBlock(tutorialIndex, showTutorialIndex, current.length);
    if (current.equals(replacement)) {
      continue;
    }

    patches.push({
      key: target.patchKey,
      start: matchStart,
      end: matchEnd,
      data: replacement,
      detail: `Replace ${target.tutorialName} Animate block with ShowTutorial in ${CLASS_NAME}.${target.methodName}`,
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
