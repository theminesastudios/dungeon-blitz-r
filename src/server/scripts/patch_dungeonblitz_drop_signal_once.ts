import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  ensureBackup,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const CLASS_NAME = "class_143";
const METHOD_NAME = "Drop";
const ORIGINAL_CODE = Buffer.from(
  "2726d510060000d0a295782890d6d030d12a1103000029d276120d0000d0668d0366a60b60d8234f25014747",
  "hex",
);

function resolveSwfPath(args: string[]): string {
  const idx = args.indexOf("--swf-path");
  if (idx !== -1 && idx + 1 < args.length) {
    return path.resolve(args[idx + 1]);
  }
  return path.resolve("src/client/content/localhost/p/cbp/DungeonBlitz.swf");
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

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);

  const replacementCode = ORIGINAL_CODE;
  if (code.equals(replacementCode)) {
    return { ctx, patches: [] };
  }

  const currentLenBytes = writeU30(methodBody.codeLen);
  const replacementLenBytes = writeU30(replacementCode.length);
  if (currentLenBytes.length !== replacementLenBytes.length) {
    throw new PatchError(
      `Unsupported ${CLASS_NAME}.${METHOD_NAME} code length width change ${currentLenBytes.length} -> ${replacementLenBytes.length}`,
    );
  }

  return {
    ctx,
    patches: [
      {
        key: "dungeonblitz_drop_signal_once_len",
        start: methodBody.codeLenPos,
        end: methodBody.codeLenPos + currentLenBytes.length,
        data: replacementLenBytes,
        detail: `Restore ${CLASS_NAME}.${METHOD_NAME} original code length`,
      },
      {
        key: "dungeonblitz_drop_signal_once_body",
        start: methodBody.codeStart,
        end: methodBody.codeStart + methodBody.codeLen,
        data: replacementCode,
        detail: `Remove extra tutorial trigger tail from ${CLASS_NAME}.${METHOD_NAME}; keep one-shot drop signal in Entity.method_1075`,
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
