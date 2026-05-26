import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  ensureBackup,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  writeU30,
  writeSwf,
} from "./swfPatchUtils";

const DEFAULT_SWF = path.resolve(
  __dirname,
  "..",
  "..",
  "client",
  "content",
  "localhost",
  "p",
  "cbp",
  "DungeonBlitz.swf",
);

const NOP_OPCODE = 0x02;
const PUSHD_DOUBLE_OPCODE = 0x2f;
const CONVERT_D_OPCODE = 0x75;
const SETLOCAL3_OPCODE = 0xd7;
const GETLOCAL3_OPCODE = 0xd3;
const IFNLT_OPCODE = 0x0c;
const MAX_SCALE = 1.25;

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npm exec tsx src/server/scripts/patch-dungeonblitz-main-method561-restore-scale-clamp.ts [--verify] [--swf <path>]",
        "",
        "Restores Main.method_561's legacy 1.25 max-scale clamp so fullscreen",
        "fit does not inflate Flash bitmap/render work on large viewports.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function getMainMethod561(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "Main");
  if (classIndex === null) {
    throw new PatchError("Could not find Main class.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_561");
  if (methodIdx === null) {
    throw new PatchError("Could not find Main.method_561.");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find method body for Main.method_561 (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `Main.method_561:${methodIdx}`);
  return { ctx, abc, methodBody, code, instructions };
}

function isNopped(code: Buffer, start: number, end: number): boolean {
  return code.subarray(start, end).every((byte) => byte === NOP_OPCODE);
}

function findMaxScaleClampAssignmentRange(swfPath: string): { start: number; end: number; restored: boolean } {
  const { code, instructions } = getMainMethod561(swfPath);

  for (let index = 0; index < instructions.length - 6; index += 1) {
    const pushMaxScale = instructions[index];
    const convert = instructions[index + 1];
    const assign = instructions[index + 2];
    const getScaleForMinClamp = instructions[index + 3];
    const pushMinScale = instructions[index + 4];
    const minClampBranch = instructions[index + 5];

    if (
      pushMaxScale.opcode === PUSHD_DOUBLE_OPCODE &&
      convert?.opcode === CONVERT_D_OPCODE &&
      assign?.opcode === SETLOCAL3_OPCODE &&
      getScaleForMinClamp?.opcode === GETLOCAL3_OPCODE &&
      pushMinScale?.opcode === PUSHD_DOUBLE_OPCODE &&
      minClampBranch?.opcode === IFNLT_OPCODE
    ) {
      return {
        start: pushMaxScale.offset,
        end: assign.offset + assign.size,
        restored: true,
      };
    }
  }

  for (let offset = 0; offset <= code.length - 4; offset += 1) {
    if (!isNopped(code, offset, offset + 4)) {
      continue;
    }

    const marker = instructions.find((instruction) => instruction.offset === offset + 4);
    const pushMinScale = instructions.find((instruction) => instruction.offset === offset + 5);
    const minClampBranch = instructions.find((instruction) => instruction.offset === offset + 7);
    if (
      marker?.opcode === GETLOCAL3_OPCODE &&
      pushMinScale?.opcode === PUSHD_DOUBLE_OPCODE &&
      minClampBranch?.opcode === IFNLT_OPCODE
    ) {
      return { start: offset, end: offset + 4, restored: false };
    }
  }

  throw new PatchError("Could not find Main.method_561 1.25 max-scale clamp assignment.");
}

function buildMaxScaleClampAssignment(abc: ReturnType<typeof parseAbc>, expectedSize: number): Buffer {
  const doubleIndex = abc.doubleValues.findIndex((value) => value === MAX_SCALE);
  if (doubleIndex <= 0) {
    throw new PatchError(`Could not find ${MAX_SCALE} in the ABC double constant pool.`);
  }

  const assignment = Buffer.concat([
    Buffer.from([PUSHD_DOUBLE_OPCODE]),
    writeU30(doubleIndex),
    Buffer.from([CONVERT_D_OPCODE, SETLOCAL3_OPCODE]),
  ]);
  if (assignment.length !== expectedSize) {
    throw new PatchError(
      `Unexpected Main.method_561 clamp assignment size ${assignment.length}; expected ${expectedSize}.`
    );
  }
  return assignment;
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, code } = getMainMethod561(swfPath);
  const clampRange = findMaxScaleClampAssignmentRange(swfPath);
  const alreadyRestored = clampRange.restored && !isNopped(code, clampRange.start, clampRange.end);

  if (alreadyRestored) {
    console.log(`${swfPath}: already patched (Main.method_561 max-scale clamp restored).`);
    return;
  }
  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; Main.method_561 max-scale clamp is disabled.`);
  }

  const assignment = buildMaxScaleClampAssignment(abc, clampRange.end - clampRange.start);

  const patches: BytePatch[] = [
    {
      key: "Main.method_561.restore_max_scale_clamp",
      start: methodBody.codeStart + clampRange.start,
      end: methodBody.codeStart + clampRange.end,
      data: assignment,
      detail: "restore legacy 1.25 max-scale cap",
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: patched Main.method_561 max-scale clamp restored.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
