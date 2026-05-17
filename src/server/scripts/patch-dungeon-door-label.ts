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
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const DEFAULT_SWF_PATH = path.resolve(
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

type Operand = ["u30" | "s8" | "s24", number];
type InsertedInstruction =
  | { label: string }
  | { opcode: number; operands?: Operand[]; branchTo?: string; absoluteTarget?: number };

interface ParsedArgs {
  swfPath: string;
  verify: boolean;
}

interface MethodContext {
  ctx: ReturnType<typeof parseSwf>;
  methodBody: NonNullable<ReturnType<typeof parseAbc>["methodBodies"] extends Map<number, infer T> ? T : never>;
  code: Buffer;
  instructions: Instruction[];
  doorIdMultiname: number;
  targetMapMultiname: number;
  legacyMissingTargetMapMultiname: number;
  indexOfMultiname: number;
  dungeonString: number;
  travelString: number;
  missionString: number;
}

function parseArgs(argv: string[]): ParsedArgs {
  let swfPath = DEFAULT_SWF_PATH;
  let verify = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verify") {
      verify = true;
      continue;
    }
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npm exec tsx src/server/scripts/patch-dungeon-door-label.ts [--verify] [--swf <path>]",
        "",
        'Patches DungeonBlitz.swf so dungeon targets say "Dungeon" and zone targets say "Travel to".',
      ].join("\n"));
      process.exit(0);
    }
    if (!arg.startsWith("-") && swfPath === DEFAULT_SWF_PATH) {
      swfPath = path.resolve(arg);
      continue;
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

function operandBytes(kind: Operand[0], value: number): Buffer {
  if (kind === "u30") {
    return writeU30(value);
  }
  if (kind === "s8") {
    return Buffer.from([value & 0xff]);
  }
  return writeS24(value);
}

function emitU30(opcode: number, value: number): InsertedInstruction {
  return { opcode, operands: [["u30", value]] };
}

function assemble(instructions: InsertedInstruction[], baseOffset = 0): Buffer {
  const labels = new Map<string, number>();
  let offset = 0;

  for (const instruction of instructions) {
    if ("label" in instruction) {
      labels.set(instruction.label, offset);
      continue;
    }
    offset += 1;
    if (instruction.branchTo || instruction.absoluteTarget !== undefined) {
      offset += 3;
    } else {
      for (const [kind, value] of instruction.operands ?? []) {
        offset += operandBytes(kind, value).length;
      }
    }
  }

  const chunks: Buffer[] = [];
  const fixups: Array<{ pos: number; target: string }> = [];
  const absoluteFixups: Array<{ pos: number; target: number }> = [];
  offset = 0;
  for (const instruction of instructions) {
    if ("label" in instruction) {
      continue;
    }

    const parts: Buffer[] = [Buffer.from([instruction.opcode])];
    offset += 1;
    if (instruction.branchTo) {
      parts.push(Buffer.alloc(3));
      fixups.push({ pos: offset, target: instruction.branchTo });
      offset += 3;
    } else if (instruction.absoluteTarget !== undefined) {
      parts.push(Buffer.alloc(3));
      absoluteFixups.push({ pos: offset, target: instruction.absoluteTarget });
      offset += 3;
    } else {
      for (const [kind, value] of instruction.operands ?? []) {
        const bytes = operandBytes(kind, value);
        parts.push(bytes);
        offset += bytes.length;
      }
    }
    chunks.push(Buffer.concat(parts));
  }

  const out = Buffer.concat(chunks);
  for (const fixup of fixups) {
    const target = labels.get(fixup.target);
    if (target === undefined) {
      throw new PatchError(`Unknown label ${fixup.target}`);
    }
    writeS24(target - (fixup.pos + 3)).copy(out, fixup.pos);
  }
  for (const fixup of absoluteFixups) {
    writeS24(fixup.target - (baseOffset + fixup.pos + 3)).copy(out, fixup.pos);
  }
  return out;
}

function isBranchOpcode(opcode: number): boolean {
  return opcode >= 0x0c && opcode <= 0x1a;
}

function branchTarget(instruction: Instruction): number {
  return instruction.offset + instruction.size + instruction.operands[0][1];
}

function findMethodContext(swfPath: string): MethodContext {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const entityClassIndex = classIndexByName(abc, "Entity");
  if (entityClassIndex === null) {
    throw new PatchError("Could not find Entity class in DungeonBlitz.swf");
  }

  const methodIdx = methodIdxForTrait(abc.instances[entityClassIndex].traits, abc, "method_579");
  if (methodIdx === null) {
    throw new PatchError("Could not find Entity.method_579 in DungeonBlitz.swf");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find method body for Entity.method_579 (${methodIdx})`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `Entity.method_579:${methodIdx}`);
  const doorIdMultiname = abc.multinameNames.findIndex((name) => name === "doorID");
  const targetMapMultiname = abc.multinameNames.findIndex((name) => name === "var_1260");
  const legacyMissingTargetMapMultiname = abc.multinameNames.findIndex((name) => name === "var_929");
  const indexOfMultiname = abc.multinameNames.findIndex((name) => name === "indexOf");
  const dungeonString = abc.stringValues.findIndex((value) => value === "Dungeon");
  const travelString = abc.stringValues.findIndex((value) => value === "Travel to");
  const missionString = abc.stringValues.findIndex((value) => value === "Mission");
  if (
    doorIdMultiname < 1 ||
    targetMapMultiname < 1 ||
    indexOfMultiname < 1 ||
    dungeonString < 1 ||
    travelString < 1 ||
    missionString < 1
  ) {
    throw new PatchError('Could not find required door label constants in DungeonBlitz.swf');
  }

  return {
    ctx,
    methodBody,
    code,
    instructions,
    doorIdMultiname,
    targetMapMultiname,
    legacyMissingTargetMapMultiname,
    indexOfMultiname,
    dungeonString,
    travelString,
    missionString,
  };
}

function findDoorLabelStart(context: MethodContext): number {
  const doorIdRead = context.instructions.find((instruction, index) => {
    const previous = context.instructions[index - 1];
    return (
      previous?.opcode === 0xd1 &&
      instruction.opcode === 0x66 &&
      instruction.operands[0]?.[1] === context.doorIdMultiname &&
      instruction.offset > 1000 &&
      instruction.offset < 1300
    );
  });
  if (!doorIdRead) {
    throw new PatchError("Could not locate Entity.method_579 door label block");
  }
  return doorIdRead.offset - 1;
}

function buildLegacyEntryBlock(checkOffset: number, dungeonImmediateOffset: number): Buffer {
  const bytes = Buffer.alloc(46, 0x02);

  Buffer.from([
    0xd1,
    0x66, 0xc2, 0x07,
    0x24, 0x02,
    0xab,
    0x96,
    0x09,
    0x12, 0x0d, 0x00, 0x00,
  ]).copy(bytes, 0);

  bytes[13] = 0x09;
  bytes[14] = 0x10;
  writeS24(checkOffset - (14 + 4)).copy(bytes, 15);

  bytes[26] = 0x09;
  bytes[27] = 0x10;
  writeS24(checkOffset - (27 + 4)).copy(bytes, 28);

  bytes[39] = 0x09;
  bytes[40] = 0x10;
  writeS24(dungeonImmediateOffset - (40 + 4)).copy(bytes, 41);

  return bytes;
}

function buildDoorLabelCheck(context: MethodContext, baseOffset: number, continueOffset: number): Buffer {
  const doorId = context.doorIdMultiname;
  const targetMap = context.targetMapMultiname;
  const indexOf = context.indexOfMultiname;
  const dungeon = context.dungeonString;
  const travel = context.travelString;
  const mission = context.missionString;

  return assemble([
    { label: "check" },
    { opcode: 0xd1 },
    emitU30(0x66, doorId),
    { opcode: 0x24, operands: [["s8", 100]] },
    { opcode: 0xad },
    { opcode: 0x11, branchTo: "targetNameCheck" },
    { opcode: 0xd1 },
    emitU30(0x66, doorId),
    { opcode: 0x25, operands: [["u30", 300]] },
    { opcode: 0xad },
    { opcode: 0x11, branchTo: "dungeon" },

    { label: "targetNameCheck" },
    { opcode: 0xd1 },
    emitU30(0x66, targetMap),
    emitU30(0x2c, mission),
    { opcode: 0x46, operands: [["u30", indexOf], ["u30", 1]] },
    { opcode: 0x24, operands: [["s8", -1]] },
    { opcode: 0xaf },
    { opcode: 0x11, branchTo: "dungeon" },
    { opcode: 0xd1 },
    emitU30(0x66, targetMap),
    emitU30(0x2c, dungeon),
    { opcode: 0x46, operands: [["u30", indexOf], ["u30", 1]] },
    { opcode: 0x24, operands: [["s8", -1]] },
    { opcode: 0xaf },
    { opcode: 0x11, branchTo: "dungeon" },

    emitU30(0x2c, travel),
    { opcode: 0x10, branchTo: "set" },

    { label: "dungeon" },
    emitU30(0x2c, dungeon),

    { label: "set" },
    { opcode: 0x85 },
    { opcode: 0x63, operands: [["u30", 10]] },
    { opcode: 0x10, absoluteTarget: continueOffset },

    { label: "dungeonImmediate" },
    emitU30(0x2c, dungeon),
    { opcode: 0x85 },
    { opcode: 0x63, operands: [["u30", 10]] },
    { opcode: 0x10, absoluteTarget: continueOffset },
  ], baseOffset);
}

function buildPatchData(context: MethodContext, start: number): Buffer {
  const originalLength = 46;
  const appendedStart = start + originalLength;

  const appendedDraft = buildDoorLabelCheck(context, appendedStart, 1124);
  const dungeonImmediateMarker = (() => {
    const marker = Buffer.concat([
      Buffer.from([0x2c]),
      writeU30(context.dungeonString),
      Buffer.from([0x85, 0x63, 0x0a, 0x10]),
    ]);
    const index = appendedDraft.indexOf(marker);
    if (index < 0) {
      throw new PatchError("Could not locate dungeonImmediate label in assembled door label check");
    }
    return index;
  })();
  const entry = buildLegacyEntryBlock(originalLength, originalLength + dungeonImmediateMarker);
  return Buffer.concat([entry, appendedDraft]);
}

function adjustBranches(originalCode: Buffer, instructions: Instruction[], start: number, oldLength: number, replacement: Buffer): Buffer {
  const delta = replacement.length - oldLength;
  const patched = Buffer.concat([
    originalCode.subarray(0, start),
    replacement,
    originalCode.subarray(start + oldLength),
  ]);

  const mapInstructionOffset = (offset: number): number => (offset >= start + oldLength ? offset + delta : offset);
  const mapTargetOffset = (target: number): number => {
    if (target >= start + oldLength) {
      return target + delta;
    }
    return target;
  };

  for (const instruction of instructions) {
    if (!isBranchOpcode(instruction.opcode) || (instruction.offset >= start && instruction.offset < start + oldLength)) {
      continue;
    }
    const newInstructionOffset = mapInstructionOffset(instruction.offset);
    const oldTarget = branchTarget(instruction);
    const newTarget = mapTargetOffset(oldTarget);
    const newRelative = newTarget - (newInstructionOffset + instruction.size);
    writeS24(newRelative).copy(patched, newInstructionOffset + 1);
  }

  return patched;
}

function hasValidBranchTargets(code: Buffer): boolean {
  const instructions = disassemble(code, "Entity.method_579.verify");
  const starts = new Set(instructions.map((instruction) => instruction.offset));
  return instructions.every((instruction) => {
    if (!isBranchOpcode(instruction.opcode)) {
      return true;
    }
    const target = branchTarget(instruction);
    return target === code.length || starts.has(target);
  });
}

function hasExpandedDoorLabelPatch(context: MethodContext, start: number, replacementLength: number): boolean {
  const originalLength = 46;
  if (context.code.length < start + replacementLength) {
    return false;
  }

  const expanded = context.code.subarray(start + originalLength, start + replacementLength);
  const targetMapNeedles = [
    context.targetMapMultiname,
    context.legacyMissingTargetMapMultiname,
  ]
    .filter((multiname) => multiname > 0)
    .map((multiname) => Buffer.concat([Buffer.from([0x66]), writeU30(multiname)]));

  return (
    targetMapNeedles.some((needle) => expanded.includes(needle)) &&
    expanded.includes(Buffer.concat([Buffer.from([0x2c]), writeU30(context.missionString)])) &&
    expanded.includes(Buffer.concat([Buffer.from([0x2c]), writeU30(context.travelString)]))
  );
}

function patchDungeonDoorLabel(swfPath: string, verify: boolean): void {
  const context = findMethodContext(swfPath);
  const start = findDoorLabelStart(context);
  const replacement = buildPatchData(context, start);
  const currentReplacement = context.code.subarray(start, start + replacement.length);
  if (currentReplacement.equals(replacement)) {
    if (!hasValidBranchTargets(context.code)) {
      throw new PatchError("Entity.method_579 contains invalid branch targets");
    }
    console.log(`Dungeon and zone door labels already patched in ${path.basename(swfPath)}`);
    return;
  }

  const oldLength = hasExpandedDoorLabelPatch(context, start, replacement.length)
    ? replacement.length
    : 46;
  const patchedCode = adjustBranches(context.code, context.instructions, start, oldLength, replacement);

  if (!hasValidBranchTargets(patchedCode)) {
    throw new PatchError("Patched Entity.method_579 would contain invalid branch targets");
  }

  if (verify) {
    throw new PatchError(`Dungeon and zone door labels still need patching in ${path.basename(swfPath)}`);
  }

  const patches: BytePatch[] = [
    {
      key: "Entity.method_579.code",
      start: context.methodBody.codeStart,
      end: context.methodBody.codeStart + context.methodBody.codeLen,
      data: patchedCode,
      detail: 'target dungeon names/door IDs -> "Dungeon"; zone targets -> "Travel to"',
    },
    {
      key: "Entity.method_579.codeLen",
      start: context.methodBody.codeLenPos,
      end: context.methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: "update Entity.method_579 code length",
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(context.ctx.body, patches);
  writeSwf(context.ctx, body, delta);
  console.log(`Patched ${path.basename(swfPath)} door labels: ${patches[0].detail}`);
}

try {
  const { swfPath, verify } = parseArgs(process.argv);
  patchDungeonDoorLabel(swfPath, verify);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
