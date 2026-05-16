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
        "  npm exec tsx src/server/scripts/patch-dungeonblitz-game-keyboard-null-guard.ts [--verify] [--swf <path>]",
        "",
        "Patches Game.method_930 so early keyboard events cannot crash",
        "while the UI keybind bars are still null.",
      ].join("\n"));
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function opcode(op: number, operands: Buffer[] = []): Buffer {
  return Buffer.concat([Buffer.from([op]), ...operands]);
}

function findRequiredMultiname(abc: ReturnType<typeof parseAbc>, name: string): number {
  const index = abc.multinameNames.findIndex((candidate) => candidate === name);
  if (index < 0) {
    throw new PatchError(`Multiname ${name} not found.`);
  }
  return index;
}

function getGameMethod(swfPath: string, methodName: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "Game");
  if (classIndex === null) {
    throw new PatchError("Game class not found.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, methodName);
  if (methodIdx === null) {
    throw new PatchError(`Game.${methodName} not found.`);
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Game.${methodName} body not found (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `Game.${methodName}:${methodIdx}`);
  return { ctx, abc, methodBody, code, instructions };
}

function buildReturnCatchHandler(localIndex: number): Buffer {
  return Buffer.concat([
    opcode(0xd0), // getlocal0
    opcode(0x30), // pushscope
    opcode(0x5a, [writeU30(0)]), // newcatch 0
    opcode(0x2a), // dup
    opcode(0x63, [writeU30(localIndex)]), // setlocal
    opcode(0x2a),
    opcode(0x30),
    opcode(0x2b), // swap
    opcode(0x6d, [writeU30(1)]), // setslot 1
    opcode(0x1d), // popscope
    opcode(0x08, [writeU30(localIndex)]), // kill
    opcode(0x47), // returnvoid
  ]);
}

function hasKeyboardGuard(swfPath: string): boolean {
  const { abc, methodBody, instructions } = getGameMethod(swfPath, "method_930");
  const errorName = findRequiredMultiname(abc, "Error");
  return methodBody.exceptions.some((entry) => (
    entry.from === 0 &&
    entry.type === errorName &&
    entry.target >= entry.to &&
    entry.target < methodBody.codeLen &&
    instructions.some((instruction) => instruction.offset >= entry.target && instruction.opcode === 0x5a)
  ));
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, code } = getGameMethod(swfPath, "method_930");
  const errorName = findRequiredMultiname(abc, "Error");
  const catchName = findRequiredMultiname(abc, "error");

  if (hasKeyboardGuard(swfPath)) {
    console.log(`${swfPath}: already patched (Game.method_930 keyboard null guard present).`);
    return;
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; Game.method_930 keyboard null guard is missing.`);
  }

  if (methodBody.exceptionCount !== 0) {
    throw new PatchError("Game.method_930 already has unexpected exception handlers.");
  }

  const handler = buildReturnCatchHandler(5);
  const patchedCode = Buffer.concat([code, handler]);
  const exceptionTable = Buffer.concat([
    writeU30(1),
    writeU30(0),
    writeU30(code.length),
    writeU30(code.length),
    writeU30(errorName),
    writeU30(catchName),
  ]);

  const patches: BytePatch[] = [
    {
      key: "Game.method_930.localCount",
      start: methodBody.localCountPos,
      end: methodBody.localCountPos + writeU30(5).length,
      data: writeU30(6),
      detail: "add keyboard guard catch local",
    },
    {
      key: "Game.method_930.maxScopeDepth",
      start: methodBody.maxScopeDepthPos,
      end: methodBody.codeLenPos,
      data: writeU30(6),
      detail: "allow keyboard catch scope",
    },
    {
      key: "Game.method_930.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "append keyboard null catch handler",
    },
    {
      key: "Game.method_930.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: "update method_930 code length",
    },
    {
      key: "Game.method_930.exceptionTable",
      start: methodBody.exceptionCountPos,
      end: methodBody.traitsCountPos,
      data: exceptionTable,
      detail: "catch early keyboard null errors",
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: patched Game.method_930 keyboard null guard.`);
}

const { swfPath, verify } = parseArgs(process.argv);
if (verify) {
  if (!hasKeyboardGuard(swfPath)) {
    throw new PatchError(`${swfPath}: verify failed; Game.method_930 keyboard null guard is missing.`);
  }
  console.log(`${swfPath}: verified Game.method_930 keyboard null guard.`);
} else {
  patchSwf(swfPath, false);
}
