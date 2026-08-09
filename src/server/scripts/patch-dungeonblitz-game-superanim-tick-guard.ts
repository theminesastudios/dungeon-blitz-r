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
        "  npm exec tsx src/server/scripts/patch-dungeonblitz-game-superanim-tick-guard.ts [--verify] [--swf <path>]",
        "",
        "Patches Game.method_1325 so a transient SuperAnimInstance BitmapData error",
        "releases the render lock and retries on the next tick without deleting the animation.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function instruction(opcode: number, operands: Buffer[] = []): Buffer {
  return Buffer.concat([Buffer.from([opcode]), ...operands]);
}

function getLocal(localIndex: number): Buffer {
  if (localIndex >= 0 && localIndex <= 3) {
    return instruction(0xd0 + localIndex);
  }
  return instruction(0x62, [writeU30(localIndex)]);
}

function setLocal(localIndex: number): Buffer {
  if (localIndex >= 0 && localIndex <= 3) {
    return instruction(0xd4 + localIndex);
  }
  return instruction(0x63, [writeU30(localIndex)]);
}

function getRequiredMultiname(abc: ReturnType<typeof parseAbc>, name: string): number {
  const index = abc.multinameNames.findIndex((candidate) => candidate === name);
  if (index < 0) {
    throw new PatchError(`Multiname ${name} not found.`);
  }
  return index;
}

function getGameMethod1325(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "Game");
  if (classIndex === null) {
    throw new PatchError("Could not find Game class.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1325");
  if (methodIdx === null) {
    throw new PatchError("Could not find Game.method_1325.");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find method body for Game.method_1325 (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `Game.method_1325:${methodIdx}`);
  return { ctx, abc, methodBody, code, instructions };
}

function findMethod105TryRange(instructions: Instruction[], abc: ReturnType<typeof parseAbc>): { from: number; to: number } {
  for (let index = 1; index < instructions.length - 5; index += 1) {
    const call = instructions[index];
    if (call.opcode !== 0x46 || u30OperandName(call, abc.multinameNames) !== "method_105") {
      continue;
    }

    const receiver = instructions[index - 1];
    const getLocal4 = instructions[index + 1];
    const dup = instructions[index + 2];
    const ifFalse = instructions[index + 3];
    const pop = instructions[index + 4];
    const getLocal2 = instructions[index + 5];
    const convertB = instructions[index + 6];
    if (
      receiver.opcode === 0xd2 &&
      getLocal4.opcode === 0x62 &&
      getLocal4.operands[0]?.[1] === 4 &&
      dup.opcode === 0x2a &&
      ifFalse.opcode === 0x12 &&
      pop.opcode === 0x29 &&
      getLocal2.opcode === 0xd2 &&
      convertB.opcode === 0x76
    ) {
      return { from: receiver.offset, to: convertB.offset + convertB.size };
    }
  }

  throw new PatchError("Could not find Game.method_1325 SuperAnimInstance.method_105 call range.");
}

function buildCatchHandler(abc: ReturnType<typeof parseAbc>, catchIndex: number): Buffer {
  const superAnimDataName = getRequiredMultiname(abc, "SuperAnimData");
  const var1220Name = getRequiredMultiname(abc, "var_1220");

  return Buffer.concat([
    getLocal(0),
    instruction(0x30),
    instruction(0x5a, [writeU30(catchIndex)]),
    instruction(0x2a),
    setLocal(5),
    instruction(0x2a),
    instruction(0x30),
    instruction(0x2b),
    instruction(0x6d, [writeU30(1)]),
    instruction(0x1d),
    instruction(0x08, [writeU30(5)]),
    // A Home reload can invalidate a cached bitmap for one frame. Keep the
    // SuperAnimInstance registered so the next render tick can rebuild it;
    // destroying it here permanently freezes nested discipline-tower loops.
    instruction(0x60, [writeU30(superAnimDataName)]),
    instruction(0x27),
    instruction(0x61, [writeU30(var1220Name)]),
    instruction(0x47),
  ]);
}

function buildExceptionEntry(
  from: number,
  to: number,
  target: number,
  abc: ReturnType<typeof parseAbc>,
): Buffer {
  const errorType = getRequiredMultiname(abc, "Error");
  const errorName = getRequiredMultiname(abc, "error");
  return Buffer.concat([
    writeU30(from),
    writeU30(to),
    writeU30(target),
    writeU30(errorType),
    writeU30(errorName),
  ]);
}

function matchingExceptionIndex(
  methodBody: ReturnType<typeof getGameMethod1325>["methodBody"],
  range: { from: number; to: number },
): number {
  return methodBody.exceptions.findIndex((exception) => exception.from === range.from && exception.to === range.to);
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, code, instructions } = getGameMethod1325(swfPath);
  const range = findMethod105TryRange(instructions, abc);
  const existingExceptionIndex = matchingExceptionIndex(methodBody, range);
  if (existingExceptionIndex >= 0) {
    const exception = methodBody.exceptions[existingExceptionIndex];
    const catchHandler = buildCatchHandler(abc, existingExceptionIndex);
    const existingHandler = code.subarray(exception.target);
    if (existingHandler.equals(catchHandler)) {
      console.log(`${swfPath}: already patched (retry-safe Game.method_1325 SuperAnim tick guard present).`);
      return;
    }
    if (verify) {
      throw new PatchError(`${swfPath}: verify failed; Game.method_1325 still destroys failed SuperAnim instances.`);
    }

    const patchedCode = Buffer.concat([code.subarray(0, exception.target), catchHandler]);
    const patches: BytePatch[] = [
      {
        key: "Game.method_1325.code",
        start: methodBody.codeStart,
        end: methodBody.codeStart + methodBody.codeLen,
        data: patchedCode,
        detail: "replace destructive SuperAnim catch handler with retry-safe handler",
      },
      {
        key: "Game.method_1325.codeLen",
        start: methodBody.codeLenPos,
        end: methodBody.codeStart,
        data: writeU30(patchedCode.length),
        detail: "update Game.method_1325 code length",
      },
    ];

    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, body, delta);
    console.log(`${swfPath}: replaced destructive Game.method_1325 SuperAnim tick guard.`);
    return;
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; Game.method_1325 SuperAnim tick guard is missing.`);
  }

  const catchIndex = methodBody.exceptionCount;
  const catchOffset = code.length;
  const catchHandler = buildCatchHandler(abc, catchIndex);
  const patchedCode = Buffer.concat([code, catchHandler]);
  const exceptionEntry = buildExceptionEntry(range.from, range.to, catchOffset, abc);

  const patches: BytePatch[] = [
    {
      key: "Game.method_1325.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "append SuperAnim tick catch handler",
    },
    {
      key: "Game.method_1325.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: "update Game.method_1325 code length",
    },
    {
      key: "Game.method_1325.localCount",
      start: methodBody.localCountPos,
      end: methodBody.localCountPos + 1,
      data: writeU30(6),
      detail: "reserve catch local",
    },
    {
      key: "Game.method_1325.maxScopeDepth",
      start: methodBody.maxScopeDepthPos,
      end: methodBody.maxScopeDepthPos + 1,
      data: writeU30(Math.max(methodBody.maxScopeDepth, 6)),
      detail: "reserve catch scope",
    },
    {
      key: "Game.method_1325.exceptionCount",
      start: methodBody.exceptionCountPos,
      end: methodBody.exceptionCountPos + 1,
      data: writeU30(methodBody.exceptionCount + 1),
      detail: "add SuperAnim tick catch entry",
    },
    {
      key: "Game.method_1325.exception",
      start: methodBody.traitsCountPos,
      end: methodBody.traitsCountPos,
      data: exceptionEntry,
      detail: "catch SuperAnim tick errors",
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: patched Game.method_1325 SuperAnim tick guard.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
