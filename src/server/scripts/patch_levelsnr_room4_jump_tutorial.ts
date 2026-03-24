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
const POP_AND_NOP_FILL = Buffer.from([0x29, 0x02, 0x02, 0x02]);

type BranchPatchTarget = {
  methodName: string;
  triggerName: string;
  patchKey: string;
  detail: string;
};

const TARGETS: BranchPatchTarget[] = [
  {
    methodName: "FirstTick",
    triggerName: "cutSceneDefeatBoss",
    patchKey: "levelsnr_room4_opening_scene_auto_start",
    detail: "Auto-start room 4 parrot opening scene without waiting on cutSceneDefeatBoss trigger",
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

function findBranchPatch(
  ctx: ReturnType<typeof parseSwf>,
  abc: ReturnType<typeof parseAbc>,
  target: BranchPatchTarget,
): BytePatch | null {
  const classIndex = classIndexByName(abc, CLASS_NAME);
  if (classIndex === null) {
    throw new PatchError(`${CLASS_NAME} class not found`);
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

  const matches: Array<{ start: number; end: number }> = [];
  for (let i = 1; i + 1 < instrs.length; i += 1) {
    const prev = instrs[i - 1];
    const inst = instrs[i];

    if (prev.opcode !== 0x2c) {
      continue;
    }
    const prevName = u30OperandName(prev, abc.multinameNames) ?? u30OperandName(prev, abc.stringValues);
    if (prevName !== target.triggerName) {
      continue;
    }
    if (inst.opcode !== 0x46 || u30OperandName(inst, abc.multinameNames) !== "OnTrigger") {
      continue;
    }

    const next = instrs[i + 1];
    if (next.size === 4) {
      matches.push({
        start: methodBody.codeStart + next.offset,
        end: methodBody.codeStart + next.offset + next.size,
      });
      continue;
    }

    const nopWindow = instrs.slice(i + 1, i + 5);
    if (
      nopWindow.length === 4 &&
      nopWindow[0].opcode === 0x29 &&
      nopWindow[0].size === 1 &&
      nopWindow.slice(1).every((candidate) => candidate.opcode === 0x02 && candidate.size === 1)
    ) {
      matches.push({
        start: methodBody.codeStart + nopWindow[0].offset,
        end: methodBody.codeStart + nopWindow[3].offset + nopWindow[3].size,
      });
      continue;
    }

    throw new PatchError(`Expected 4-byte branch after ${CLASS_NAME}.${target.methodName} trigger ${target.triggerName}`);
  }

  if (matches.length === 0) {
    throw new PatchError(`Could not find trigger branch for ${CLASS_NAME}.${target.methodName} (${target.triggerName})`);
  }
  if (matches.length > 1) {
    throw new PatchError(`Found multiple trigger branches for ${CLASS_NAME}.${target.methodName} (${target.triggerName})`);
  }

  const { start, end } = matches[0];
  const current = ctx.body.subarray(start, end);
  if (current.equals(POP_AND_NOP_FILL)) {
    return null;
  }

  return {
    key: target.patchKey,
    start,
    end,
    data: POP_AND_NOP_FILL,
    detail: target.detail,
  };
}

function analyzePatches(swfPath: string): {
  ctx: ReturnType<typeof parseSwf>;
  patches: BytePatch[];
} {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);

  const patches = TARGETS
    .map((target) => findBranchPatch(ctx, abc, target))
    .filter((patch): patch is BytePatch => patch !== null);

  return { ctx, patches };
}

function main(): number {
  const args = process.argv.slice(2);
  const swfPath = resolveSwfPath(args);
  const verifyOnly = hasFlag(args, "--verify") || hasFlag(args, "--dry-run");

  try {
    const { ctx, patches } = analyzePatches(swfPath);

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
