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

type ParsedArgs = {
  swfPath: string;
  verify: boolean;
};

function parseArgs(argv: string[]): ParsedArgs {
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
        "  npm exec tsx src/server/scripts/patch-dungeonblitz-game-superanim-crash-guard.ts [--verify] [--swf <path>]",
        "",
        "Patches Game.method_1325 so SuperAnimInstance.method_105 render",
        "errors mark the animation finished instead of crashing the client.",
      ].join("\n"));
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function writeS24(value: number): Buffer {
  const out = Buffer.alloc(3);
  let encoded = value;
  if (encoded < 0) {
    encoded += 1 << 24;
  }
  out[0] = encoded & 0xff;
  out[1] = (encoded >>> 8) & 0xff;
  out[2] = (encoded >>> 16) & 0xff;
  return out;
}

function operandBytes(kind: "u30" | "s24" | "s8", value: number): Buffer {
  if (kind === "u30") {
    return writeU30(value);
  }
  if (kind === "s24") {
    return writeS24(value);
  }
  return Buffer.from([value & 0xff]);
}

function opcode(op: number, operands: Array<["u30" | "s24" | "s8", number]> = []): Buffer {
  return Buffer.concat([Buffer.from([op]), ...operands.map(([kind, value]) => operandBytes(kind, value))]);
}

function getLocalOperand(instruction: Instruction): number | null {
  if (instruction.opcode >= 0xd0 && instruction.opcode <= 0xd3) {
    return instruction.opcode - 0xd0;
  }
  if (instruction.opcode === 0x62 && instruction.operands[0]?.[0] === "u30") {
    return instruction.operands[0][1];
  }
  return null;
}

function findRequiredMultiname(abc: ReturnType<typeof parseAbc>, name: string): number {
  const index = abc.multinameNames.findIndex((candidate) => candidate === name);
  if (index < 0) {
    throw new PatchError(`Multiname ${name} not found.`);
  }
  return index;
}

function findMethod105TryRange(instructions: Instruction[], abc: ReturnType<typeof parseAbc>) {
  for (let index = 1; index < instructions.length - 8; index += 1) {
    const call = instructions[index];
    if (
      call.opcode !== 0x46 ||
      u30OperandName(call, abc.multinameNames) !== "method_105" ||
      call.operands[1]?.[1] !== 0
    ) {
      continue;
    }

    const getAnim = instructions[index - 1];
    const getFlag = instructions[index + 1];
    const dup = instructions[index + 2];
    const iffalse = instructions[index + 3];
    const pop = instructions[index + 4];
    const getAnimAgain = instructions[index + 5];
    const convertB = instructions[index + 6];
    const continuationBranch = instructions[index + 7];
    if (
      getLocalOperand(getAnim) === 2 &&
      getLocalOperand(getFlag) === 4 &&
      dup.opcode === 0x2a &&
      iffalse.opcode === 0x12 &&
      pop.opcode === 0x29 &&
      getLocalOperand(getAnimAgain) === 2 &&
      convertB.opcode === 0x76 &&
      continuationBranch.opcode === 0x11 &&
      continuationBranch.operands[0]?.[0] === "s24"
    ) {
      return {
        from: getAnim.offset,
        to: continuationBranch.offset,
        continuation: continuationBranch.offset + continuationBranch.size + continuationBranch.operands[0][1],
      };
    }
  }

  throw new PatchError("Could not find Game.method_1325 SuperAnimInstance.method_105 block.");
}

function buildCatchHandler(handlerOffset: number, continuationOffset: number, finishedName: number): Buffer {
  const chunks: Buffer[] = [
    opcode(0xd0), // getlocal0
    opcode(0x30), // pushscope
    opcode(0x5a, [["u30", 0]]), // newcatch 0
    opcode(0x2a), // dup
    opcode(0x63, [["u30", 5]]), // setlocal 5
    opcode(0x2a),
    opcode(0x30),
    opcode(0x2b), // swap
    opcode(0x6d, [["u30", 1]]), // setslot 1
    opcode(0x1d), // popscope
    opcode(0x08, [["u30", 5]]), // kill 5
    opcode(0xd2), // getlocal2
    opcode(0x26), // pushtrue
    opcode(0x61, [["u30", finishedName]]), // setproperty m_bFinished
    opcode(0x26), // preserve method_105 return value expected below ofs00a1
  ];

  const beforeJump = chunks.reduce((total, chunk) => total + chunk.length, 0);
  chunks.push(opcode(0x10, [["s24", continuationOffset - (handlerOffset + beforeJump + 4)]]));
  return Buffer.concat(chunks);
}

function getGameMethod1325(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "Game");
  if (classIndex === null) {
    throw new PatchError("Game class not found.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1325");
  if (methodIdx === null) {
    throw new PatchError("Game.method_1325 not found.");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Game.method_1325 body not found (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `Game.method_1325:${methodIdx}`);
  return { ctx, abc, methodBody, code, instructions };
}

function hasCrashGuard(swfPath: string): boolean {
  const { abc, methodBody, instructions } = getGameMethod1325(swfPath);
  const range = findMethod105TryRange(instructions, abc);
  const errorName = findRequiredMultiname(abc, "Error");
  const finishedName = findRequiredMultiname(abc, "m_bFinished");
  return methodBody.exceptions.some((entry) => (
    entry.from === range.from &&
    entry.to === range.to &&
    entry.type === errorName &&
    entry.target > range.to &&
    entry.target < methodBody.codeLen &&
    instructions.some((instruction) => (
      instruction.offset > entry.target &&
      instruction.opcode === 0x61 &&
      instruction.operands[0]?.[1] === finishedName
    ))
  ));
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, code, instructions } = getGameMethod1325(swfPath);
  const range = findMethod105TryRange(instructions, abc);
  const errorName = findRequiredMultiname(abc, "Error");
  const catchName = findRequiredMultiname(abc, "error");
  const finishedName = findRequiredMultiname(abc, "m_bFinished");

  const alreadyPatched = methodBody.exceptions.some((entry) => (
    entry.from === range.from &&
    entry.to === range.to &&
    entry.type === errorName &&
    entry.target > range.to &&
    entry.target < methodBody.codeLen
  ));

  if (alreadyPatched) {
    console.log(`${swfPath}: already patched (Game.method_1325 SuperAnim crash guard present).`);
    return;
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; Game.method_1325 SuperAnim crash guard is missing.`);
  }

  if (methodBody.exceptionCount !== 0) {
    throw new PatchError("Game.method_1325 already has unexpected exception handlers.");
  }

  const handler = buildCatchHandler(code.length, range.continuation, finishedName);
  const patchedCode = Buffer.concat([code, handler]);
  const exceptionTable = Buffer.concat([
    writeU30(1),
    writeU30(range.from),
    writeU30(range.to),
    writeU30(code.length),
    writeU30(errorName),
    writeU30(catchName),
  ]);

  const patches: BytePatch[] = [
    {
      key: "Game.method_1325.localCount",
      start: methodBody.localCountPos,
      end: methodBody.localCountPos + writeU30(5).length,
      data: writeU30(6),
      detail: "add catch local",
    },
    {
      key: "Game.method_1325.maxScopeDepth",
      start: methodBody.maxScopeDepthPos,
      end: methodBody.codeLenPos,
      data: writeU30(6),
      detail: "allow catch scope",
    },
    {
      key: "Game.method_1325.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "append SuperAnim crash catch handler",
    },
    {
      key: "Game.method_1325.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: "update method_1325 code length",
    },
    {
      key: "Game.method_1325.exceptionTable",
      start: methodBody.exceptionCountPos,
      end: methodBody.traitsCountPos,
      data: exceptionTable,
      detail: "catch SuperAnim render errors",
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: patched Game.method_1325 SuperAnim crash guard.`);
}

const { swfPath, verify } = parseArgs(process.argv);
if (verify) {
  if (!hasCrashGuard(swfPath)) {
    throw new PatchError(`${swfPath}: verify failed; Game.method_1325 SuperAnim crash guard is missing.`);
  }
  console.log(`${swfPath}: verified Game.method_1325 SuperAnim crash guard.`);
} else {
  patchSwf(swfPath, false);
}
