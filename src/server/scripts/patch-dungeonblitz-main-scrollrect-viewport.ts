import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  ensureBackup,
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

const VIEWPORT_PADDING_LEFT = 31;
const VIEWPORT_PADDING_TOP = 31;
const VIEWPORT_PADDING_RIGHT = 31;
const VIEWPORT_PADDING_BOTTOM = 70;
const VIEWPORT_PADDING_HORIZONTAL = VIEWPORT_PADDING_LEFT + VIEWPORT_PADDING_RIGHT;
const VIEWPORT_PADDING_VERTICAL = VIEWPORT_PADDING_TOP + VIEWPORT_PADDING_BOTTOM;
const RECTANGLE_OP = 0x4a;
const SET_PROPERTY_OP = 0x61;
const GET_PROPERTY_OP = 0x66;
const GETLEX_OP = 0x60;
const GETLOCAL0_OP = 0xd0;
const FIND_PROP_STRICT_OP = 0x5d;
const SUBTRACT_OP = 0xa0;
const MULTIPLY_OP = 0xa2;
const PUSH_BYTE_OP = 0x24;
const PUSH_INT_OP = 0x25;
const CONSTRUCT_PROP_OP = 0x4a;

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
        "  npm exec tsx src/server/scripts/patch-dungeonblitz-main-scrollrect-viewport.ts [--verify] [--swf <path>]",
        "",
        "Removes the injected Main.scrollRect viewport clip.",
        "Leaves the authored EdgeHud/EdgeFull border art in the SWF untouched.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function writeOpcode(opcode: number, ...operands: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([opcode]), ...operands]);
}

function pushByte(value: number): Buffer {
  return writeOpcode(PUSH_BYTE_OP, Buffer.from([value & 0xff]));
}

function pushInt(value: number): Buffer {
  return writeOpcode(PUSH_INT_OP, writeU30(value));
}

function getLex(multiname: number): Buffer {
  return writeOpcode(GETLEX_OP, writeU30(multiname));
}

function findPropStrict(multiname: number): Buffer {
  return writeOpcode(FIND_PROP_STRICT_OP, writeU30(multiname));
}

function getProperty(multiname: number): Buffer {
  return writeOpcode(GET_PROPERTY_OP, writeU30(multiname));
}

function setProperty(multiname: number): Buffer {
  return writeOpcode(SET_PROPERTY_OP, writeU30(multiname));
}

function constructProperty(multiname: number, argCount: number): Buffer {
  return writeOpcode(CONSTRUCT_PROP_OP, writeU30(multiname), writeU30(argCount));
}

function op(opcode: number): Buffer {
  return writeOpcode(opcode);
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

function findExistingScrollRectPatchBounds(instructions: Instruction[], names: string[]): { start: number; end: number } | null {
  const constructIndex = instructions.findIndex((instruction, index) =>
    instruction.opcode === RECTANGLE_OP &&
    u30OperandName(instruction, names) === "Rectangle" &&
    instruction.operands[1]?.[1] === 4 &&
    instructions[index + 1]?.opcode === SET_PROPERTY_OP &&
    u30OperandName(instructions[index + 1], names) === "scrollRect"
  );
  if (constructIndex === -1) {
    return null;
  }

  for (let index = constructIndex - 1; index >= 0; index -= 1) {
    const setY = instructions[index];
    if (setY.opcode === SET_PROPERTY_OP && u30OperandName(setY, names) === "y") {
      const setScrollRect = instructions[constructIndex + 1];
      return { start: setY.offset + setY.size, end: setScrollRect.offset + setScrollRect.size };
    }
  }

  return null;
}

function buildScrollRectPatch(abc: ReturnType<typeof parseAbc>): Buffer {
  const names = abc.multinameNames;
  const camera = names.indexOf("Camera");
  const screenWidth = names.indexOf("SCREEN_WIDTH");
  const screenHeight = names.indexOf("SCREEN_HEIGHT");
  const overallScale = names.indexOf("overallScale");
  const rectangle = names.indexOf("Rectangle");
  const scrollRect = names.indexOf("scrollRect");

  if (names[camera] !== "Camera") {
    throw new PatchError("Could not find Camera multiname.");
  }
  if (names[screenWidth] !== "SCREEN_WIDTH") {
    throw new PatchError("Could not find SCREEN_WIDTH multiname.");
  }
  if (names[screenHeight] !== "SCREEN_HEIGHT") {
    throw new PatchError("Could not find SCREEN_HEIGHT multiname.");
  }
  if (names[overallScale] !== "overallScale") {
    throw new PatchError("Could not find overallScale multiname.");
  }
  if (names[rectangle] !== "Rectangle") {
    throw new PatchError("Could not find Rectangle multiname.");
  }
  if (names[scrollRect] !== "scrollRect") {
    throw new PatchError("Could not find scrollRect multiname.");
  }

  return Buffer.concat([
    op(GETLOCAL0_OP),
    findPropStrict(rectangle),
    pushByte(0),
    pushByte(0),
    getLex(camera),
    getProperty(screenWidth),
    pushInt(VIEWPORT_PADDING_HORIZONTAL),
    op(SUBTRACT_OP),
    op(GETLOCAL0_OP),
    getProperty(overallScale),
    op(MULTIPLY_OP),
    getLex(camera),
    getProperty(screenHeight),
    pushInt(VIEWPORT_PADDING_VERTICAL),
    op(SUBTRACT_OP),
    op(GETLOCAL0_OP),
    getProperty(overallScale),
    op(MULTIPLY_OP),
    constructProperty(rectangle, 4),
    setProperty(scrollRect),
  ]);
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, instructions } = getMainMethod561(swfPath);
  const names = abc.multinameNames;
  const existingPatchBounds = findExistingScrollRectPatchBounds(instructions, names);

  if (verify) {
    if (existingPatchBounds) {
      throw new PatchError(`${swfPath}: verify failed; Main.method_561 still contains an injected scrollRect viewport clip.`);
    }
    console.log(`${swfPath}: verify passed (Main.method_561 injected scrollRect viewport clip absent).`);
    return;
  }

  if (!existingPatchBounds) {
    console.log(`${swfPath}: already unpatched (Main.method_561 injected scrollRect viewport clip absent).`);
    return;
  }

  const removedLength = existingPatchBounds.end - existingPatchBounds.start;
  const patches: BytePatch[] = [
    {
      key: "Main.method_561.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(methodBody.codeLen - removedLength),
      detail: "adjust Main.method_561 code length after removing scrollRect clip",
    },
    {
      key: "Main.method_561.scrollRect",
      start: methodBody.codeStart + existingPatchBounds.start,
      end: methodBody.codeStart + existingPatchBounds.end,
      data: Buffer.alloc(0),
      detail: "remove injected shared viewport scrollRect in Main.method_561",
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: removed Main.method_561 injected scrollRect viewport clip.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
