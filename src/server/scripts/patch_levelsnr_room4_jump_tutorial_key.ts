import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  defaultLevelsNrPath,
  ensureBackup,
  parseAbc,
  parseSwf,
  PatchError,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const OLD_KEY = "am_JumpTut";
const NEW_KEY = "am_HighlighterJumping";

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

  const oldIndex = abc.stringValues.indexOf(OLD_KEY);
  if (oldIndex <= 0) {
    throw new PatchError(`${OLD_KEY} string not found`);
  }

  const currentValue = abc.stringValues[oldIndex];
  if (currentValue === NEW_KEY) {
    return { ctx, patches: [] };
  }

  if (currentValue !== OLD_KEY) {
    throw new PatchError(`Expected ${OLD_KEY} at string slot ${oldIndex}, found ${currentValue}`);
  }

  const lenPos = abc.stringLenPositions[oldIndex];
  const dataPos = abc.stringDataPositions[oldIndex];
  const currentLen = Buffer.byteLength(currentValue, "utf8");
  const nextStringPos =
    oldIndex + 1 < abc.stringDataPositions.length && abc.stringDataPositions[oldIndex + 1] > 0
      ? abc.stringLenPositions[oldIndex + 1]
      : -1;
  const dataEnd = nextStringPos > dataPos ? nextStringPos : dataPos + currentLen;

  const replacementData = Buffer.from(NEW_KEY, "utf8");
  const replacementLen = writeU30(replacementData.length);

  return {
    ctx,
    patches: [
      {
        key: "levelsnr_room4_jump_tutorial_key_len",
        start: lenPos,
        end: dataPos,
        data: replacementLen,
        detail: `Update ${OLD_KEY} string length`,
      },
      {
        key: "levelsnr_room4_jump_tutorial_key_data",
        start: dataPos,
        end: dataEnd,
        data: replacementData,
        detail: `Rename ${OLD_KEY} to ${NEW_KEY}`,
      },
    ],
  };
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
