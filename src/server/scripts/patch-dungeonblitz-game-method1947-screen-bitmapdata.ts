import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  Instruction,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  u30OperandName,
  writeSwf,
  writeU30,
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
const SAFE_SCREEN_BITMAP_WIDTH = 2048;
const SAFE_SCREEN_BITMAP_HEIGHT = 1152;

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
        "  ts-node src/server/scripts/patch-dungeonblitz-game-method1947-screen-bitmapdata.ts [--verify] [--swf <path>]",
        "",
        "Patches Game.method_1947 so the fullscreen screen-buffer BitmapData",
        "uses a safe fullscreen backing size instead of unbounded overallScale dimensions.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function pushShort(value: number): Buffer {
  return Buffer.concat([Buffer.from([0x25]), writeU30(value)]);
}

function getGameMethod1947(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "Game");
  if (classIndex === null) {
    throw new PatchError("Could not find Game class.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1947");
  if (methodIdx === null) {
    throw new PatchError("Could not find Game.method_1947.");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find method body for Game.method_1947 (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `Game.method_1947:${methodIdx}`);
  return { ctx, abc, methodBody, code, instructions };
}

function findScreenBitmapConstructor(instructions: Instruction[], names: string[]) {
  for (let index = 0; index < instructions.length - 3; index += 1) {
    const find = instructions[index];
    const construct = instructions.find((candidate, candidateIndex) =>
      candidateIndex > index &&
      candidate.offset - find.offset < 80 &&
      candidate.opcode === 0x4a &&
      u30OperandName(candidate, names) === "BitmapData" &&
      candidate.operands[1]?.[1] === 3
    );
    if (
      find.opcode === 0x5d &&
      u30OperandName(find, names) === "BitmapData" &&
      construct
    ) {
      return { find, construct };
    }
  }

  throw new PatchError("Could not find Game.method_1947 screen BitmapData constructor.");
}

function isPatched(code: Buffer, constructorStart: number, constructOffset: number): boolean {
  const prefix = Buffer.concat([
    pushShort(SAFE_SCREEN_BITMAP_WIDTH),
    pushShort(SAFE_SCREEN_BITMAP_HEIGHT),
  ]);
  return code.subarray(constructorStart, constructorStart + prefix.length).equals(prefix) &&
    code.subarray(constructorStart + prefix.length, constructOffset).every((byte) => byte === 0x02);
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, code, instructions } = getGameMethod1947(swfPath);
  const { find, construct } = findScreenBitmapConstructor(instructions, abc.multinameNames);
  const constructorArgsStart = find.offset + find.size;
  const constructorArgsEnd = construct.offset - 1;

  if (constructorArgsEnd <= constructorArgsStart) {
    throw new PatchError("Unexpected Game.method_1947 BitmapData argument range.");
  }

  if (isPatched(code, constructorArgsStart, constructorArgsEnd)) {
    console.log(`${swfPath}: already patched (Game.method_1947 safe screen BitmapData present).`);
    return;
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; Game.method_1947 safe screen BitmapData is missing.`);
  }

  const replacementPrefix = Buffer.concat([
    pushShort(SAFE_SCREEN_BITMAP_WIDTH),
    pushShort(SAFE_SCREEN_BITMAP_HEIGHT),
  ]);
  const replacement = Buffer.concat([
    replacementPrefix,
    Buffer.alloc(constructorArgsEnd - constructorArgsStart - replacementPrefix.length, 0x02),
  ]);

  const patches: BytePatch[] = [
    {
      key: "Game.method_1947.screen_bitmap_dimensions",
      start: methodBody.codeStart + constructorArgsStart,
      end: methodBody.codeStart + constructorArgsEnd,
      data: replacement,
      detail: "force screen BitmapData dimensions to 2048x1152",
    },
  ];

  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: patched Game.method_1947 safe screen BitmapData.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
