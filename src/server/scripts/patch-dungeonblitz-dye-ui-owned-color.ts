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

type Operand = [Instruction["operands"][number][0], number];
type InsertedInstruction = {
  opcode: number;
  operands?: Operand[];
  branchToEnd?: boolean;
};

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
        "  npm exec tsx src/server/scripts/patch-dungeonblitz-dye-ui-owned-color.ts [--verify] [--swf <path>]",
        "",
        "Patches class_121 in DungeonBlitz.swf so character-creation shirt/pants colors",
        "are not displayed as dye bottles unless the player owns the matching dye.",
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
  const chunks: Buffer[] = [];
  const fixups: Array<{ pos: number }> = [];
  let offset = 0;

  for (const inst of instructions) {
    const parts: Buffer[] = [Buffer.from([inst.opcode])];
    offset += 1;

    if (inst.branchToEnd) {
      parts.push(Buffer.alloc(3));
      fixups.push({ pos: offset });
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
    writeS24(assembled.length - (fixup.pos + 3)).copy(assembled, fixup.pos);
  }
  return assembled;
}

function insertAndAdjustBranches(
  originalCode: Buffer,
  instructions: Instruction[],
  insertions: Array<{ pos: number; data: Buffer }>,
): Buffer {
  if (insertions.length === 0) {
    return originalCode;
  }

  const ordered = [...insertions].sort((left, right) => left.pos - right.pos);
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const insertion of ordered) {
    chunks.push(originalCode.subarray(cursor, insertion.pos));
    chunks.push(insertion.data);
    cursor = insertion.pos;
  }
  chunks.push(originalCode.subarray(cursor));

  const patched = Buffer.concat(chunks);

  function shiftBeforeOrAt(offset: number): number {
    return ordered.reduce((sum, insertion) => sum + (insertion.pos <= offset ? insertion.data.length : 0), 0);
  }

  function shiftBefore(offset: number): number {
    return ordered.reduce((sum, insertion) => sum + (insertion.pos < offset ? insertion.data.length : 0), 0);
  }

  for (const inst of instructions) {
    if (!isBranchOpcode(inst.opcode)) {
      continue;
    }
    const branch = inst.operands[0];
    if (branch?.[0] !== "s24") {
      throw new PatchError(`Unexpected branch operand at original offset ${inst.offset}`);
    }

    const oldEnd = inst.offset + inst.size;
    const oldTarget = oldEnd + branch[1];
    const newInstOffset = inst.offset + shiftBeforeOrAt(inst.offset);
    const newEnd = oldEnd + shiftBefore(inst.offset);
    const newTarget = oldTarget + shiftBeforeOrAt(oldTarget);
    writeS24(newTarget - newEnd).copy(patched, newInstOffset + 1);
  }

  return patched;
}

function findRequiredMultiname(abc: ReturnType<typeof parseAbc>, name: string): number {
  const matches: number[] = [];
  for (let index = 0; index < abc.multinameNames.length; index += 1) {
    if (abc.multinameNames[index] === name) {
      matches.push(index);
    }
  }
  if (matches.length === 0) {
    throw new PatchError(`Multiname ${name} not found`);
  }
  return matches[0];
}

function setLocalOperand(inst: Instruction): number | null {
  if (inst.opcode === 0xd4) {
    return 0;
  }
  if (inst.opcode === 0xd5) {
    return 1;
  }
  if (inst.opcode === 0xd6) {
    return 2;
  }
  if (inst.opcode === 0xd7) {
    return 3;
  }
  if (inst.opcode === 0x63 && inst.operands[0]?.[0] === "u30") {
    return inst.operands[0][1];
  }
  return null;
}

function findSetLocalAfterProperty(
  instructions: Instruction[],
  abc: ReturnType<typeof parseAbc>,
  propertyName: string,
  localIndex: number,
): number {
  let sawProperty = false;
  for (const inst of instructions) {
    if (u30OperandName(inst, abc.multinameNames) === propertyName) {
      sawProperty = true;
      continue;
    }
    if (sawProperty && setLocalOperand(inst) === localIndex) {
      return inst.offset;
    }
  }
  throw new PatchError(`Could not find setlocal ${localIndex} after ${propertyName}`);
}

function nextInstructionOffset(instructions: Instruction[], offset: number): number {
  const index = instructions.findIndex((inst) => inst.offset === offset);
  if (index < 0 || index + 1 >= instructions.length) {
    throw new PatchError(`Could not resolve next instruction after ${offset}`);
  }
  return instructions[index + 1].offset;
}

function buildOwnedDyeGuard(
  localIndex: number,
  multinames: { var1: number; ownedDyes: number; var57: number; class21: number },
): InsertedInstruction[] {
  return [
    { opcode: 0x62, operands: [["u30", localIndex]] }, // getlocal
    { opcode: 0x12, branchToEnd: true }, // iffalse
    { opcode: 0x60, operands: [["u30", multinames.var1]] }, // getlex var_1
    { opcode: 0x66, operands: [["u30", multinames.ownedDyes]] }, // getproperty mOwnedDyes
    { opcode: 0x62, operands: [["u30", localIndex]] },
    { opcode: 0x66, operands: [["u30", multinames.var57]] }, // getproperty var_57
    { opcode: 0x66, operands: [["u30", 0]] }, // getproperty MultinameL, patched below
    { opcode: 0x11, branchToEnd: true }, // iftrue
    { opcode: 0x20 }, // pushnull
    { opcode: 0x80, operands: [["u30", multinames.class21]] }, // coerce class_21
    { opcode: localIndex <= 3 ? 0xd4 + localIndex : 0x63, operands: localIndex <= 3 ? [] : [["u30", localIndex]] },
  ];
}

function findMultinameLAfterColorLookup(instructions: Instruction[], setLocalOffset: number): number {
  const setLocalIndex = instructions.findIndex((inst) => inst.offset === setLocalOffset);
  for (let index = setLocalIndex - 1; index >= 0; index -= 1) {
    const inst = instructions[index];
    if (inst.opcode === 0x66 && inst.operands[0]?.[0] === "u30" && u30OperandName(inst, { length: 0 } as never) === null) {
      return inst.operands[0][1];
    }
  }
  throw new PatchError(`Could not find dynamic MultinameL before setlocal at ${setLocalOffset}`);
}

function hasOwnedGuardAfter(instructions: Instruction[], abc: ReturnType<typeof parseAbc>, setLocalOffset: number): boolean {
  const index = instructions.findIndex((inst) => inst.offset === setLocalOffset);
  if (index < 0 || index + 4 >= instructions.length) {
    return false;
  }

  return (
    u30OperandName(instructions[index + 3], abc.multinameNames) === "var_1" &&
    u30OperandName(instructions[index + 4], abc.multinameNames) === "mOwnedDyes"
  );
}

function patchMethod(
  ctx: ReturnType<typeof parseSwf>,
  abc: ReturnType<typeof parseAbc>,
  methodIdx: number,
  insertions: Array<{ afterOffset: number; instructions: InsertedInstruction[] }>,
  label: string,
): BytePatch[] {
  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`${label} body not found`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, label);
  const replacement = insertAndAdjustBranches(
    code,
    instructions,
    insertions.map((insertion) => {
      const inst = instructions.find((entry) => entry.offset === insertion.afterOffset);
      if (!inst) {
        throw new PatchError(`Could not find insertion offset ${insertion.afterOffset} in ${label}`);
      }
      return {
        pos: inst.offset + inst.size,
        data: assembleInserted(insertion.instructions),
      };
    }),
  );
  if (replacement.equals(code)) {
    return [];
  }

  const oldCodeLen = writeU30(methodBody.codeLen);
  return [
    {
      key: `${label}_code_len`,
      start: methodBody.codeLenPos,
      end: methodBody.codeLenPos + oldCodeLen.length,
      data: writeU30(replacement.length),
      detail: `Adjust ${label} code length for owned-dye color guard`,
    },
    {
      key: `${label}_body`,
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: replacement,
      detail: `Patch ${label} owned-dye color guard`,
    },
  ];
}

function analyzePatch(swfPath: string): { ctx: ReturnType<typeof parseSwf>; patches: BytePatch[] } {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "class_121");
  if (classIndex === null) {
    throw new PatchError("class_121 not found");
  }

  const traits = abc.instances[classIndex].traits;
  const methods = {
    method1869: methodIdxForTrait(traits, abc, "method_1869"),
    method1434: methodIdxForTrait(traits, abc, "method_1434"),
    method1534: methodIdxForTrait(traits, abc, "method_1534"),
  };
  if (methods.method1869 === null || methods.method1434 === null || methods.method1534 === null) {
    throw new PatchError("Required class_121 dye UI methods not found");
  }

  const multinames = {
    var1: findRequiredMultiname(abc, "var_1"),
    ownedDyes: findRequiredMultiname(abc, "mOwnedDyes"),
    var57: findRequiredMultiname(abc, "var_57"),
    class21: findRequiredMultiname(abc, "class_21"),
  };

  const patches: BytePatch[] = [];
  for (const [methodIdx, label, targets] of [
    [methods.method1869, "class_121.method_1869", [["shirtColor", 9], ["pantColor", 10]]],
  ] as const) {
    const methodBody = abc.methodBodies.get(methodIdx);
    if (!methodBody) {
      throw new PatchError(`${label} body not found`);
    }

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const instructions = disassemble(code, label);
    const dynamicLookupMultiname = findMultinameLAfterColorLookup(
      instructions,
      findSetLocalAfterProperty(instructions, abc, targets[0][0], targets[0][1]),
    );
    const insertions: Array<{ afterOffset: number; instructions: InsertedInstruction[] }> = [];

    for (const [propertyName, localIndex] of targets) {
      const setLocalOffset = findSetLocalAfterProperty(instructions, abc, propertyName, localIndex);
      if (hasOwnedGuardAfter(instructions, abc, setLocalOffset)) {
        continue;
      }
      const guard = buildOwnedDyeGuard(localIndex, multinames);
      for (const entry of guard) {
        if (entry.opcode === 0x66 && entry.operands?.[0]?.[1] === 0) {
          entry.operands = [["u30", dynamicLookupMultiname]];
        }
      }
      insertions.push({ afterOffset: setLocalOffset, instructions: guard });
    }

    if (insertions.length > 0) {
      patches.push(...patchMethod(ctx, abc, methodIdx, insertions, label));
    }
  }

  return { ctx, patches };
}

function main(): number {
  const { swfPath, verify } = parseArgs(process.argv);

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

    if (verify) {
      return 1;
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
