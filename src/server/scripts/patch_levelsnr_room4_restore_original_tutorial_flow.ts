import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  defaultLevelsNrPath,
  ensureBackup,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const CLASS_NAME = "a_Room_Tutorial_04";
const JUMP_TUTORIAL = "am_JumpTut";
const JUMP_TUTORIAL_SLOT = 1470;

const ORIGINAL_METHODS: Array<{ methodName: string; codeHex: string }> = [
  {
    methodName: "WaitingForJump",
    codeHex:
      "d030ef018e0c0000d1d066dd01462b01120b0000d12cbe0b2cf409264f1d03d12cbf0b462c0112080000d1d06686064f2801d12caf08462c01124c0000d12cbe0b2c4c264f1d03d12cc00b2cf409264f1d03d1d066dd014f2901d1d06686064f2901d1461b0025b8170c0c0000d1d06685064f280110080000d1d06684064f2801d1d06689064f1c0147",
  },
  {
    methodName: "WaitingForDrop",
    codeHex:
      "d030ef018e0c0000d12cc10b462c0112080000d1d06686064f2801d12cb008462c0112220000d12cc00b2c4c264f1d03d1d06685064f2901d1d06684064f2901d1d06686064f2901d12cc20b462c0112080000d1d06687064f2801d1d0668706462b0112130000d12cc30b2cf409264f1d03d1d0668a064f1c0147",
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

  const currentJumpTutorial = abc.stringValues[JUMP_TUTORIAL_SLOT];
  if (!currentJumpTutorial) {
    throw new PatchError(`String slot ${JUMP_TUTORIAL_SLOT} not found`);
  }

  if (currentJumpTutorial !== JUMP_TUTORIAL) {
    const lenPos = abc.stringLenPositions[JUMP_TUTORIAL_SLOT];
    const dataPos = abc.stringDataPositions[JUMP_TUTORIAL_SLOT];
    const nextLenPos = abc.stringLenPositions[JUMP_TUTORIAL_SLOT + 1];
    const replacementData = Buffer.from(JUMP_TUTORIAL, "utf8");
    patches.push(
      {
        key: "levelsnr_room4_restore_jump_tutorial_len",
        start: lenPos,
        end: dataPos,
        data: writeU30(replacementData.length),
        detail: `Restore string slot ${JUMP_TUTORIAL_SLOT} length for ${JUMP_TUTORIAL}`,
      },
      {
        key: "levelsnr_room4_restore_jump_tutorial_name",
        start: dataPos,
        end: nextLenPos,
        data: replacementData,
        detail: `Restore string slot ${JUMP_TUTORIAL_SLOT} to ${JUMP_TUTORIAL}`,
      },
    );
  }

  for (const target of ORIGINAL_METHODS) {
    const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, target.methodName);
    if (methodIdx === null) {
      throw new PatchError(`${CLASS_NAME}.${target.methodName} not found`);
    }

    const methodBody = abc.methodBodies.get(methodIdx);
    if (!methodBody) {
      throw new PatchError(`${CLASS_NAME}.${target.methodName} body not found`);
    }

    const replacementCode = Buffer.from(target.codeHex, "hex");
    const currentCode = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const currentLenBytes = writeU30(methodBody.codeLen);
    const replacementLenBytes = writeU30(replacementCode.length);
    if (currentLenBytes.length !== replacementLenBytes.length) {
      throw new PatchError(
        `Unsupported ${CLASS_NAME}.${target.methodName} code length width change ${currentLenBytes.length} -> ${replacementLenBytes.length}`,
      );
    }

    if (!currentCode.equals(replacementCode)) {
      patches.push(
        {
          key: `levelsnr_room4_restore_${target.methodName}_len`,
          start: methodBody.codeLenPos,
          end: methodBody.codeStart,
          data: replacementLenBytes,
          detail: `Restore ${CLASS_NAME}.${target.methodName} code length`,
        },
        {
          key: `levelsnr_room4_restore_${target.methodName}_body`,
          start: methodBody.codeStart,
          end: methodBody.codeStart + methodBody.codeLen,
          data: replacementCode,
          detail: `Restore original ${CLASS_NAME}.${target.methodName} tutorial flow`,
        },
      );
    }
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
