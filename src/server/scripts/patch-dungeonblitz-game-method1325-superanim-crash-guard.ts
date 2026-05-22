import * as fs from "fs";
import * as path from "path";
import {
  applyPatchesToBody,
  classIndexByName,
  disassemble,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  readU30,
  u30OperandName,
  writeSwf,
  writeU30,
  type BytePatch,
  type Instruction,
  type MethodBodyInfo,
  type SwfContext,
} from "./swfPatchUtils";

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = path.resolve("src/client/content/localhost/p/cbp/DungeonBlitz.swf");
  let verify = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verify") {
      verify = true;
      continue;
    }
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] ?? "");
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npx ts-node src/server/scripts/patch-dungeonblitz-game-method1325-superanim-crash-guard.ts [--verify] [--swf <path>]",
        "",
        "Patches Game.method_1325 so SuperAnimInstance.method_105 BitmapData failures",
        "finish the bad animation instance instead of crashing the client tick.",
      ].join("\n"));
      process.exit(0);
    }
    throw new PatchError(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function isBranchOpcode(opcode: number): boolean {
  return opcode >= 0x0c && opcode <= 0x18;
}

function writeS24(value: number): Buffer {
  const out = Buffer.alloc(3);
  out[0] = value & 0xff;
  out[1] = (value >> 8) & 0xff;
  out[2] = (value >> 16) & 0xff;
  return out;
}

function u30Instruction(opcode: number, value: number): Buffer {
  return Buffer.concat([Buffer.from([opcode]), writeU30(value)]);
}

function applyCodeEditsAndAdjustBranches(
  originalCode: Buffer,
  instructions: Instruction[],
  edits: Array<{ start: number; end: number; data: Buffer }>,
): Buffer {
  const ordered = [...edits].sort((left, right) => left.start - right.start);
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const edit of ordered) {
    chunks.push(originalCode.subarray(cursor, edit.start));
    chunks.push(edit.data);
    cursor = edit.end;
  }
  chunks.push(originalCode.subarray(cursor));

  const patched = Buffer.concat(chunks);

  function deltaFor(edit: { start: number; end: number; data: Buffer }): number {
    return edit.data.length - (edit.end - edit.start);
  }

  function isInsideEdit(offset: number): boolean {
    return ordered.some((edit) => offset >= edit.start && offset < edit.end);
  }

  function mapInstructionOffset(offset: number): number {
    let mapped = offset;
    for (const edit of ordered) {
      if (edit.end <= offset || edit.start === edit.end && edit.start <= offset) {
        mapped += deltaFor(edit);
      }
    }
    return mapped;
  }

  function mapTargetOffset(offset: number): number {
    let mapped = offset;
    for (const edit of ordered) {
      if (offset < edit.start) {
        continue;
      }
      if (offset >= edit.start && offset < edit.end) {
        return edit.start + (mapped - offset);
      }
      if (offset === edit.end) {
        return edit.start + edit.data.length + (mapped - offset);
      }
      mapped += deltaFor(edit);
    }
    return mapped;
  }

  for (const inst of instructions) {
    if (!isBranchOpcode(inst.opcode) || isInsideEdit(inst.offset)) {
      continue;
    }
    const branch = inst.operands[0];
    if (branch?.[0] !== "s24") {
      throw new PatchError(`Unexpected branch operand at original offset ${inst.offset}`);
    }

    const oldEnd = inst.offset + inst.size;
    const oldTarget = oldEnd + branch[1];
    const newInstOffset = mapInstructionOffset(inst.offset);
    const newEnd = newInstOffset + inst.size;
    const newTarget = mapTargetOffset(oldTarget);
    writeS24(newTarget - newEnd).copy(patched, newInstOffset + 1);
  }

  return patched;
}

function getGameMethod1325(swfPath: string): {
  ctx: SwfContext;
  methodBody: MethodBodyInfo;
  abc: ReturnType<typeof parseAbc>;
  code: Buffer;
  instructions: Instruction[];
} {
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
    throw new PatchError("Could not find Game.method_1325 body.");
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  return {
    ctx,
    methodBody,
    abc,
    code,
    instructions: disassemble(code, "Game.method_1325"),
  };
}

function findMethod105TryEnd(instructions: Instruction[], names: string[]): { call: Instruction; tryEnd: number } {
  const callIndex = instructions.findIndex(
    (instruction) =>
      instruction.opcode === 0x46 &&
      u30OperandName(instruction, names) === "method_105" &&
      instruction.operands[1]?.[1] === 0,
  );
  if (callIndex === -1) {
    throw new PatchError("Could not find SuperAnimInstance.method_105 call in Game.method_1325.");
  }

  const tryEnd = instructions[callIndex + 8]?.offset;
  if (tryEnd === undefined) {
    throw new PatchError("Could not find Game.method_1325 method_105 guard end.");
  }

  return { call: instructions[callIndex], tryEnd };
}

function findRequiredMultiname(abc: ReturnType<typeof parseAbc>, name: string): number {
  const index = abc.multinameNames.findIndex((candidate) => candidate === name);
  if (index === -1) {
    throw new PatchError(`Could not find multiname ${name}.`);
  }
  return index;
}

function buildCatchBlock(
  exceptionIndex: number,
  mBFinishedName: number,
  insertOffset: number,
  insertionLength: number,
): Buffer {
  const jumpTarget = 0xa1 + insertionLength;
  const prefix = Buffer.concat([
    Buffer.from([0xd0, 0x30]),
    u30Instruction(0x5a, exceptionIndex),
    Buffer.from([0x2a]),
    u30Instruction(0x63, 5),
    Buffer.from([0x2a, 0x30, 0x2b]),
    u30Instruction(0x6d, 1),
    Buffer.from([0x1d]),
    u30Instruction(0x08, 5),
    Buffer.from([0xd2, 0x27]),
    u30Instruction(0x61, mBFinishedName),
    Buffer.from([0x27]),
  ]);
  const jumpEnd = insertOffset + prefix.length + 4;

  return Buffer.concat([prefix, Buffer.from([0x10]), writeS24(jumpTarget - jumpEnd)]);
}

function assertPatched(swfPath: string): void {
  const { abc, methodBody, instructions } = getGameMethod1325(swfPath);
  const { call } = findMethod105TryEnd(instructions, abc.multinameNames);
  const finishSet = instructions.find(
    (instruction, index) =>
      instructions[index - 1]?.opcode === 0x27 &&
      instruction.opcode === 0x61 &&
      u30OperandName(instruction, abc.multinameNames) === "m_bFinished",
  );

  if (!finishSet) {
    throw new PatchError(`${swfPath}: verify failed; Game.method_1325 does not mark failed SuperAnimInstance finished.`);
  }

  const hasGuard = methodBody.exceptions.some(
    (exception) =>
      abc.multinameNames[exception.type] === "Error" &&
      exception.from <= call.offset &&
      exception.to >= call.offset + call.size &&
      exception.target <= finishSet.offset,
  );

  if (!hasGuard) {
    throw new PatchError(`${swfPath}: verify failed; Game.method_1325 SuperAnimInstance.method_105 catch guard is missing.`);
  }
}

function patchSwf(swfPath: string, verify: boolean): void {
  if (!fs.existsSync(swfPath)) {
    throw new PatchError(`SWF not found: ${swfPath}`);
  }

  if (verify) {
    assertPatched(swfPath);
    console.log(`${swfPath}: verified Game.method_1325 SuperAnimInstance crash guard.`);
    return;
  }

  const { ctx, methodBody, abc, code, instructions } = getGameMethod1325(swfPath);
  const { call, tryEnd } = findMethod105TryEnd(instructions, abc.multinameNames);
  const errorName = findRequiredMultiname(abc, "Error");
  const errorLocalName = findRequiredMultiname(abc, "error");
  const mBFinishedName = findRequiredMultiname(abc, "m_bFinished");

  const alreadyPatched = methodBody.exceptions.some(
    (exception) =>
      abc.multinameNames[exception.type] === "Error" &&
      exception.from <= call.offset &&
      exception.to >= call.offset + call.size,
  );
  if (alreadyPatched) {
    console.log(`${swfPath}: already patched (Game.method_1325 SuperAnimInstance crash guard present).`);
    return;
  }

  const exceptionIndex = methodBody.exceptionCount;
  const placeholderLength = buildCatchBlock(exceptionIndex, mBFinishedName, tryEnd, 0).length;
  const catchBlock = buildCatchBlock(exceptionIndex, mBFinishedName, tryEnd, placeholderLength);
  const patchedCode = applyCodeEditsAndAdjustBranches(code, instructions, [
    { start: tryEnd, end: tryEnd, data: catchBlock },
  ]);

  const [, localCountEnd] = readU30(ctx.body, methodBody.localCountPos, "Game.method_1325.local_count");
  const [, maxScopeDepthEnd] = readU30(ctx.body, methodBody.maxScopeDepthPos, "Game.method_1325.max_scope_depth");
  const [, exceptionCountEnd] = readU30(ctx.body, methodBody.exceptionCountPos, "Game.method_1325.exception_count");
  const exceptionEntry = Buffer.concat([
    writeU30(call.offset),
    writeU30(tryEnd),
    writeU30(tryEnd),
    writeU30(errorName),
    writeU30(errorLocalName),
  ]);

  const patches: BytePatch[] = [
    {
      key: "Game.method_1325.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "insert SuperAnimInstance render error catch block",
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
      end: localCountEnd,
      data: writeU30(6),
      detail: "add catch local",
    },
    {
      key: "Game.method_1325.maxScopeDepth",
      start: methodBody.maxScopeDepthPos,
      end: maxScopeDepthEnd,
      data: writeU30(Math.max(methodBody.maxScopeDepth, 6)),
      detail: "allow catch scope",
    },
    {
      key: "Game.method_1325.exceptionCount",
      start: methodBody.exceptionCountPos,
      end: exceptionCountEnd,
      data: writeU30(methodBody.exceptionCount + 1),
      detail: "add SuperAnimInstance render error exception handler",
    },
    {
      key: "Game.method_1325.exception",
      start: methodBody.traitsCountPos,
      end: methodBody.traitsCountPos,
      data: exceptionEntry,
      detail: "catch SuperAnimInstance.method_105 errors",
    },
  ];

  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: patched Game.method_1325 SuperAnimInstance crash guard.`);
}

try {
  const { swfPath, verify } = parseArgs(process.argv);
  patchSwf(swfPath, verify);
} catch (error) {
  console.error("[game-method1325-superanim-crash-guard] failed");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
