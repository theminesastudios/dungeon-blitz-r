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
        "  npm exec tsx src/server/scripts/patch_dungeonblitz_buff_back_vfx_depth.ts [--verify] [--swf <path>]",
        "",
        "Patches Buff.UpdatePos so back-layer buff VFX stay behind their entity",
        "after hit-react or other entity display-depth changes.",
      ].join("\n"));
      process.exit(0);
    }

    throw new PatchError(`Unknown argument: ${arg}`);
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
      if (edit.end <= offset || (edit.start === edit.end && edit.start <= offset)) {
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

function getRequiredMultiname(abc: ReturnType<typeof parseAbc>, name: string): number {
  const index = abc.multinameNames.findIndex((candidate) => candidate === name);
  if (index < 0) {
    throw new PatchError(`Multiname ${name} not found.`);
  }
  return index;
}

function getLocal(localIndex: number): InsertedInstruction {
  return localIndex >= 0 && localIndex <= 3
    ? { opcode: 0xd0 + localIndex }
    : { opcode: 0x62, operands: [["u30", localIndex]] };
}

function setLocal(localIndex: number): InsertedInstruction {
  return localIndex >= 0 && localIndex <= 3
    ? { opcode: 0xd4 + localIndex }
    : { opcode: 0x63, operands: [["u30", localIndex]] };
}

function getProp(nameIndex: number): InsertedInstruction {
  return { opcode: 0x66, operands: [["u30", nameIndex]] };
}

function callProperty(nameIndex: number, argCount: number): InsertedInstruction {
  return { opcode: 0x46, operands: [["u30", nameIndex], ["u30", argCount]] };
}

function callPropVoid(nameIndex: number, argCount: number): InsertedInstruction {
  return { opcode: 0x4f, operands: [["u30", nameIndex], ["u30", argCount]] };
}

function loadBackBuffDisplay(names: { var283: number; mTheDO: number }): InsertedInstruction[] {
  return [
    getLocal(0),
    getProp(names.var283),
    getProp(names.mTheDO),
  ];
}

function loadPlayerEntLayer(names: { var1: number; playerEntLayer: number }): InsertedInstruction[] {
  return [
    getLocal(0),
    getProp(names.var1),
    getProp(names.playerEntLayer),
  ];
}

function loadEntityDisplay(names: { var4: number; gfx: number; mTheDO: number }): InsertedInstruction[] {
  return [
    getLocal(0),
    getProp(names.var4),
    getProp(names.gfx),
    getProp(names.mTheDO),
  ];
}

function buildBackVfxDepthGuard(abc: ReturnType<typeof parseAbc>, checkEntityParent = true): Buffer {
  const names = {
    var1: getRequiredMultiname(abc, "var_1"),
    var4: getRequiredMultiname(abc, "var_4"),
    var283: getRequiredMultiname(abc, "var_283"),
    gfx: getRequiredMultiname(abc, "gfx"),
    mTheDO: getRequiredMultiname(abc, "m_TheDO"),
    parent: getRequiredMultiname(abc, "parent"),
    playerEntLayer: getRequiredMultiname(abc, "playerEntLayer"),
    getChildIndex: getRequiredMultiname(abc, "getChildIndex"),
    setChildIndex: getRequiredMultiname(abc, "setChildIndex"),
  };

  const playerIndexLocal = 6;
  const buffIndexLocal = 7;

  return assembleInserted([
    getLocal(0),
    getProp(names.var283),
    { opcode: 0x12, branchTo: "done" },

    ...loadBackBuffDisplay(names),
    { opcode: 0x12, branchTo: "done" },

    getLocal(0),
    getProp(names.var4),
    { opcode: 0x12, branchTo: "done" },

    getLocal(0),
    getProp(names.var4),
    getProp(names.gfx),
    { opcode: 0x12, branchTo: "done" },

    ...loadEntityDisplay(names),
    { opcode: 0x12, branchTo: "done" },

    getLocal(0),
    getProp(names.var1),
    { opcode: 0x12, branchTo: "done" },

    ...loadPlayerEntLayer(names),
    { opcode: 0x12, branchTo: "done" },

    ...loadBackBuffDisplay(names),
    getProp(names.parent),
    ...loadPlayerEntLayer(names),
    { opcode: 0xac },
    { opcode: 0x12, branchTo: "done" },

    ...(checkEntityParent
      ? [
        ...loadEntityDisplay(names),
        getProp(names.parent),
        ...loadPlayerEntLayer(names),
        { opcode: 0xac },
        { opcode: 0x12, branchTo: "done" },
      ]
      : []),

    ...loadPlayerEntLayer(names),
    ...loadEntityDisplay(names),
    callProperty(names.getChildIndex, 1),
    setLocal(playerIndexLocal),

    ...loadPlayerEntLayer(names),
    ...loadBackBuffDisplay(names),
    callProperty(names.getChildIndex, 1),
    setLocal(buffIndexLocal),

    getLocal(buffIndexLocal),
    getLocal(playerIndexLocal),
    { opcode: 0x16, branchTo: "done" },

    ...loadPlayerEntLayer(names),
    ...loadBackBuffDisplay(names),
    getLocal(playerIndexLocal),
    callPropVoid(names.setChildIndex, 2),

    { label: "done" },
  ]);
}

function getBuffUpdatePos(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "Buff");
  if (classIndex === null) {
    throw new PatchError("Could not find Buff class.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "UpdatePos");
  if (methodIdx === null) {
    throw new PatchError("Could not find Buff.UpdatePos.");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find method body for Buff.UpdatePos (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `Buff.UpdatePos:${methodIdx}`);
  return { ctx, abc, methodBody, code, instructions };
}

export function hasBuffBackVfxDepthGuard(swfPath: string): boolean {
  const { abc, code } = getBuffUpdatePos(swfPath);
  const guard = buildBackVfxDepthGuard(abc);
  return code.subarray(0, guard.length).equals(guard);
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, code, instructions } = getBuffUpdatePos(swfPath);
  const guard = buildBackVfxDepthGuard(abc);
  const legacyGuard = buildBackVfxDepthGuard(abc, false);
  if (code.subarray(0, guard.length).equals(guard)) {
    console.log(`${swfPath}: already patched (Buff.UpdatePos back VFX depth guard present).`);
    return;
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; Buff.UpdatePos back VFX depth guard is missing.`);
  }

  if (methodBody.exceptionCount !== 0) {
    throw new PatchError(`${swfPath}: Buff.UpdatePos has an unexpected exception table.`);
  }

  const replaceLegacyGuard = code.subarray(0, legacyGuard.length).equals(legacyGuard);
  const patchedCode = applyCodeEditsAndAdjustBranches(code, instructions, [
    { start: 0, end: replaceLegacyGuard ? legacyGuard.length : 0, data: guard },
  ]);
  const [oldMaxStack, oldMaxStackEnd] = readU30(ctx.body, methodBody.maxStackPos, "Buff.UpdatePos.max_stack");
  const [oldLocalCount, oldLocalCountEnd] = readU30(ctx.body, methodBody.localCountPos, "Buff.UpdatePos.local_count");
  const oldCodeLen = writeU30(methodBody.codeLen);

  const patches: BytePatch[] = [
    {
      key: "Buff.UpdatePos.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "insert back VFX depth guard",
    },
    {
      key: "Buff.UpdatePos.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeLenPos + oldCodeLen.length,
      data: writeU30(patchedCode.length),
      detail: "update Buff.UpdatePos code length",
    },
  ];

  if (oldMaxStack < 4) {
    patches.push({
      key: "Buff.UpdatePos.maxStack",
      start: methodBody.maxStackPos,
      end: oldMaxStackEnd,
      data: writeU30(4),
      detail: "reserve stack for back VFX depth guard",
    });
  }

  if (oldLocalCount < 8) {
    patches.push({
      key: "Buff.UpdatePos.localCount",
      start: methodBody.localCountPos,
      end: oldLocalCountEnd,
      data: writeU30(8),
      detail: "reserve locals for back VFX depth guard",
    });
  }

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: patched Buff.UpdatePos back VFX depth guard.`);
}

function main(): number {
  try {
    const { swfPath, verify } = parseArgs(process.argv);
    patchSwf(swfPath, verify);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Patch error: ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
