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
  readU30,
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

type Operand = [Instruction["operands"][number][0], number];
type InsertedInstruction =
  | { label: string }
  | { opcode: number; operands?: Operand[]; branchTo?: string };

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
        "  npm exec tsx src/server/scripts/patch-dungeonblitz-entity-display-null-guard.ts [--verify] [--swf <path>]",
        "",
        "Patches Entity visual update methods so entities without a live display object",
        "skip unsafe visual updates instead of crashing the client tick.",
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

function isBranchOpcode(opcode: number): boolean {
  return opcode >= 0x0c && opcode <= 0x1a;
}

function operandBytes(kind: Operand[0], value: number): Buffer {
  if (kind === "u30") {
    return writeU30(value);
  }
  if (kind === "s8") {
    return Buffer.from([value & 0xff]);
  }
  if (kind === "s24") {
    return writeS24(value);
  }
  throw new PatchError(`Unsupported operand kind ${kind}`);
}

function assembleInserted(instructions: InsertedInstruction[]): Buffer {
  const labels = new Map<string, number>();
  let offset = 0;

  for (const inst of instructions) {
    if ("label" in inst) {
      labels.set(inst.label, offset);
      continue;
    }
    offset += 1;
    if (inst.branchTo) {
      offset += 3;
    } else {
      for (const [kind, value] of inst.operands ?? []) {
        offset += operandBytes(kind, value).length;
      }
    }
  }

  const chunks: Buffer[] = [];
  const fixups: Array<{ pos: number; target: string }> = [];
  offset = 0;

  for (const inst of instructions) {
    if ("label" in inst) {
      continue;
    }

    const parts: Buffer[] = [Buffer.from([inst.opcode])];
    offset += 1;

    if (inst.branchTo) {
      parts.push(Buffer.alloc(3));
      fixups.push({ pos: offset, target: inst.branchTo });
      offset += 3;
    } else {
      for (const [kind, value] of inst.operands ?? []) {
        const bytes = operandBytes(kind, value);
        parts.push(bytes);
        offset += bytes.length;
      }
    }

    chunks.push(Buffer.concat(parts));
  }

  const assembled = Buffer.concat(chunks);
  for (const fixup of fixups) {
    const target = labels.get(fixup.target);
    if (target === undefined) {
      throw new PatchError(`Unknown branch label ${fixup.target}`);
    }
    writeS24(target - (fixup.pos + 3)).copy(assembled, fixup.pos);
  }

  return assembled;
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

function findRequiredMultiname(abc: ReturnType<typeof parseAbc>, name: string): number {
  const index = abc.multinameNames.findIndex((candidate) => candidate === name);
  if (index < 0) {
    throw new PatchError(`Multiname ${name} not found.`);
  }
  return index;
}

function buildDisplayObjectGuard(gfxName: number, displayObjectName: number): Buffer {
  return assembleInserted([
    { opcode: 0xd0 }, // getlocal0
    { opcode: 0x66, operands: [["u30", gfxName]] }, // getproperty gfx
    { opcode: 0x2a }, // dup
    { opcode: 0x12, branchTo: "missingGfx" }, // iffalse
    { opcode: 0x66, operands: [["u30", displayObjectName]] }, // getproperty m_TheDO
    { opcode: 0x11, branchTo: "ok" }, // iftrue
    { opcode: 0x47 }, // returnvoid
    { label: "missingGfx" },
    { opcode: 0x29 }, // pop duplicated null gfx
    { opcode: 0x47 }, // returnvoid
    { label: "ok" },
  ]);
}

function buildReturnCatchHandler(localIndex: number): Buffer {
  return assembleInserted([
    { opcode: 0xd0 }, // getlocal0
    { opcode: 0x30 }, // pushscope
    { opcode: 0x5a, operands: [["u30", 0]] }, // newcatch 0
    { opcode: 0x2a }, // dup
    { opcode: 0x63, operands: [["u30", localIndex]] }, // setlocal
    { opcode: 0x2a },
    { opcode: 0x30 },
    { opcode: 0x2b }, // swap
    { opcode: 0x6d, operands: [["u30", 1]] }, // setslot 1
    { opcode: 0x1d }, // popscope
    { opcode: 0x08, operands: [["u30", localIndex]] }, // kill
    { opcode: 0x47 }, // returnvoid
  ]);
}

function buildJumpCatchHandler(localIndex: number, handlerOffset: number, continuationOffset: number): Buffer {
  const prologue = assembleInserted([
    { opcode: 0xd0 }, // getlocal0
    { opcode: 0x30 }, // pushscope
    { opcode: 0x5a, operands: [["u30", 0]] }, // newcatch 0
    { opcode: 0x2a }, // dup
    { opcode: 0x63, operands: [["u30", localIndex]] }, // setlocal
    { opcode: 0x2a },
    { opcode: 0x30 },
    { opcode: 0x2b }, // swap
    { opcode: 0x6d, operands: [["u30", 1]] }, // setslot 1
    { opcode: 0x1d }, // popscope
    { opcode: 0x08, operands: [["u30", localIndex]] }, // kill
  ]);

  return Buffer.concat([
    prologue,
    Buffer.from([0x10]), // jump
    writeS24(continuationOffset - (handlerOffset + prologue.length + 4)),
  ]);
}

function getEntityMethod(swfPath: string, methodName: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "Entity");
  if (classIndex === null) {
    throw new PatchError("Entity class not found.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, methodName);
  if (methodIdx === null) {
    throw new PatchError(`Entity.${methodName} not found.`);
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Entity.${methodName} body not found (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `Entity.${methodName}:${methodIdx}`);
  return { ctx, abc, methodBody, code, instructions };
}

function getLocalOperand(instruction: Instruction | undefined): number | null {
  if (!instruction) {
    return null;
  }
  if (instruction.opcode >= 0xd0 && instruction.opcode <= 0xd3) {
    return instruction.opcode - 0xd0;
  }
  if (instruction.opcode === 0x62 && instruction.operands[0]?.[0] === "u30") {
    return instruction.operands[0][1];
  }
  return null;
}

function findGuardInsertionOffset(instructions: Instruction[]): number {
  for (let index = 0; index < instructions.length - 1; index += 1) {
    const getThis = instructions[index];
    const pushScope = instructions[index + 1];
    if (getThis.opcode === 0xd0 && pushScope.opcode === 0x30) {
      return pushScope.offset + pushScope.size;
    }
  }

  throw new PatchError("Could not find Entity.method_900 scope prologue.");
}

function hasDisplayObjectGuard(swfPath: string): boolean {
  const { abc, code, instructions } = getEntityMethod(swfPath, "method_900");
  const insertOffset = findGuardInsertionOffset(instructions);
  const guard = buildDisplayObjectGuard(
    findRequiredMultiname(abc, "gfx"),
    findRequiredMultiname(abc, "m_TheDO"),
  );
  return code.subarray(insertOffset, insertOffset + guard.length).equals(guard);
}

function hasMethod853CatchGuard(swfPath: string): boolean {
  const { abc, methodBody, instructions } = getEntityMethod(swfPath, "method_853");
  const errorName = findRequiredMultiname(abc, "Error");
  return methodBody.exceptions.some((entry) => (
    entry.from === 0 &&
    entry.type === errorName &&
    entry.target >= entry.to &&
    entry.target < methodBody.codeLen &&
    instructions.some((instruction) => instruction.offset === entry.target && instruction.opcode === 0xd0) &&
    instructions.some((instruction) => instruction.offset >= entry.target && instruction.opcode === 0x47)
  ));
}

function findTakeDamageVisualRange(instructions: Instruction[], abc: ReturnType<typeof parseAbc>) {
  const displayAccesses: number[] = [];
  for (let index = 0; index < instructions.length; index += 1) {
    if (u30OperandName(instructions[index], abc.multinameNames) === "m_TheDO") {
      displayAccesses.push(index);
    }
  }

  if (displayAccesses.length < 6) {
    throw new PatchError("Could not find Entity.TakeDamage damage floater display object accesses.");
  }

  let firstThisIndex = displayAccesses[0];
  while (firstThisIndex >= 0 && getLocalOperand(instructions[firstThisIndex]) !== 0) {
    firstThisIndex -= 1;
  }
  if (firstThisIndex < 0) {
    throw new PatchError("Could not find Entity.TakeDamage damage floater range start.");
  }

  let lastCallIndex = displayAccesses[displayAccesses.length - 1];
  while (lastCallIndex < instructions.length) {
    const instruction = instructions[lastCallIndex];
    if (
      instruction.opcode === 0x4f &&
      u30OperandName(instruction, abc.multinameNames) === "method_527" &&
      instruction.operands[1]?.[1] === 9
    ) {
      break;
    }
    lastCallIndex += 1;
  }
  if (lastCallIndex >= instructions.length) {
    throw new PatchError("Could not find Entity.TakeDamage damage floater method_527 call.");
  }

  const rangeEnd = instructions[lastCallIndex].offset + instructions[lastCallIndex].size;
  const next = instructions[lastCallIndex + 1];
  const continuation = next?.opcode === 0x10
    ? next.offset + next.size
    : rangeEnd;

  return {
    from: instructions[firstThisIndex].offset,
    to: rangeEnd,
    continuation,
  };
}

function hasTakeDamageVisualGuard(swfPath: string): boolean {
  const { abc, methodBody, instructions } = getEntityMethod(swfPath, "TakeDamage");
  const range = findTakeDamageVisualRange(instructions, abc);
  const errorName = findRequiredMultiname(abc, "Error");
  return methodBody.exceptions.some((entry) => (
    entry.from === range.from &&
    entry.to === range.to &&
    entry.type === errorName &&
    entry.target >= range.to &&
    entry.target < methodBody.codeLen &&
    instructions.some((instruction) => instruction.offset === entry.target && instruction.opcode === 0xd0)
  ));
}

function patchMethod900(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, code, instructions } = getEntityMethod(swfPath, "method_900");
  const insertOffset = findGuardInsertionOffset(instructions);
  const guard = buildDisplayObjectGuard(
    findRequiredMultiname(abc, "gfx"),
    findRequiredMultiname(abc, "m_TheDO"),
  );

  if (code.subarray(insertOffset, insertOffset + guard.length).equals(guard)) {
    console.log(`${swfPath}: already patched (Entity.method_900 display null guard present).`);
    return;
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; Entity.method_900 display null guard is missing.`);
  }

  if (methodBody.exceptionCount !== 0) {
    throw new PatchError("Entity.method_900 has exception ranges; refusing to insert without exception remapping.");
  }

  const patchedCode = applyCodeEditsAndAdjustBranches(code, instructions, [
    { start: insertOffset, end: insertOffset, data: guard },
  ]);
  const patches: BytePatch[] = [
    {
      key: "Entity.method_900.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "insert display object null guard",
    },
    {
      key: "Entity.method_900.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: "update Entity.method_900 code length",
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: patched Entity.method_900 display null guard.`);
}

function patchMethod853(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, code } = getEntityMethod(swfPath, "method_853");
  const errorName = findRequiredMultiname(abc, "Error");
  const catchName = findRequiredMultiname(abc, "error");
  const [localCount] = readU30(ctx.body, methodBody.localCountPos, "Entity.method_853.local_count");

  if (hasMethod853CatchGuard(swfPath)) {
    console.log(`${swfPath}: already patched (Entity.method_853 visual null guard present).`);
    return;
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; Entity.method_853 visual null guard is missing.`);
  }

  if (methodBody.exceptionCount !== 0) {
    throw new PatchError("Entity.method_853 already has unexpected exception handlers.");
  }

  const handler = buildReturnCatchHandler(localCount);
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
      key: "Entity.method_853.localCount",
      start: methodBody.localCountPos,
      end: methodBody.localCountPos + writeU30(localCount).length,
      data: writeU30(localCount + 1),
      detail: "add visual guard catch local",
    },
    {
      key: "Entity.method_853.maxScopeDepth",
      start: methodBody.maxScopeDepthPos,
      end: methodBody.codeLenPos,
      data: writeU30(Math.max(methodBody.maxScopeDepth, 6)),
      detail: "allow visual catch scope",
    },
    {
      key: "Entity.method_853.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "append visual null catch handler",
    },
    {
      key: "Entity.method_853.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: "update Entity.method_853 code length",
    },
    {
      key: "Entity.method_853.exceptionTable",
      start: methodBody.exceptionCountPos,
      end: methodBody.traitsCountPos,
      data: exceptionTable,
      detail: "catch unsafe visual update errors",
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: patched Entity.method_853 visual null guard.`);
}

function patchTakeDamage(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, code, instructions } = getEntityMethod(swfPath, "TakeDamage");
  const range = findTakeDamageVisualRange(instructions, abc);
  const errorName = findRequiredMultiname(abc, "Error");
  const catchName = findRequiredMultiname(abc, "error");
  const [localCount] = readU30(ctx.body, methodBody.localCountPos, "Entity.TakeDamage.local_count");

  if (hasTakeDamageVisualGuard(swfPath)) {
    console.log(`${swfPath}: already patched (Entity.TakeDamage visual null guard present).`);
    return;
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; Entity.TakeDamage visual null guard is missing.`);
  }

  if (methodBody.exceptionCount !== 0) {
    throw new PatchError("Entity.TakeDamage already has unexpected exception handlers.");
  }

  const handler = buildJumpCatchHandler(localCount, code.length, range.continuation);
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
      key: "Entity.TakeDamage.localCount",
      start: methodBody.localCountPos,
      end: methodBody.localCountPos + writeU30(localCount).length,
      data: writeU30(localCount + 1),
      detail: "add damage floater guard catch local",
    },
    {
      key: "Entity.TakeDamage.maxScopeDepth",
      start: methodBody.maxScopeDepthPos,
      end: methodBody.codeLenPos,
      data: writeU30(Math.max(methodBody.maxScopeDepth, 6)),
      detail: "allow damage floater catch scope",
    },
    {
      key: "Entity.TakeDamage.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "append damage floater null catch handler",
    },
    {
      key: "Entity.TakeDamage.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: "update Entity.TakeDamage code length",
    },
    {
      key: "Entity.TakeDamage.exceptionTable",
      start: methodBody.exceptionCountPos,
      end: methodBody.traitsCountPos,
      data: exceptionTable,
      detail: "catch unsafe damage floater display errors",
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: patched Entity.TakeDamage visual null guard.`);
}

const { swfPath, verify } = parseArgs(process.argv);
if (verify) {
  if (!hasDisplayObjectGuard(swfPath)) {
    throw new PatchError(`${swfPath}: verify failed; Entity.method_900 display null guard is missing.`);
  }
  if (!hasMethod853CatchGuard(swfPath)) {
    throw new PatchError(`${swfPath}: verify failed; Entity.method_853 visual null guard is missing.`);
  }
  if (!hasTakeDamageVisualGuard(swfPath)) {
    throw new PatchError(`${swfPath}: verify failed; Entity.TakeDamage visual null guard is missing.`);
  }
  console.log(`${swfPath}: verified Entity visual null guards.`);
} else {
  patchMethod900(swfPath, false);
  patchMethod853(swfPath, false);
  patchTakeDamage(swfPath, false);
}
