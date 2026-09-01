import * as crypto from "crypto";
import * as fs from "fs";
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

const DEFAULT_SWF = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf");
const BRANCH_OPCODES = new Set([0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a]);

type PatchInstruction = { opcode: number; operands?: Buffer[]; label?: string; branchTo?: string };
type MethodTarget = {
  body: ReturnType<typeof parseAbc>["methodBodies"] extends Map<number, infer T> ? T : never;
  code: Buffer;
  insts: Instruction[];
};

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") swfPath = path.resolve(argv[++index] || "");
    else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify };
}

function s24(value: number): Buffer {
  const out = Buffer.alloc(3);
  out.writeIntLE(value, 0, 3);
  return out;
}

function assemble(items: PatchInstruction[]): Buffer {
  const labels = new Map<string, number>();
  let offset = 0;
  for (const item of items) {
    if (item.label) labels.set(item.label, offset);
    if (item.opcode >= 0) offset += 1 + (item.branchTo ? 3 : 0) + (item.operands ?? []).reduce((sum, operand) => sum + operand.length, 0);
  }
  const chunks: Buffer[] = [];
  offset = 0;
  for (const item of items) {
    if (item.opcode < 0) continue;
    if (item.branchTo) {
      const target = labels.get(item.branchTo);
      if (target === undefined) throw new PatchError(`Unknown branch label ${item.branchTo}.`);
      chunks.push(Buffer.concat([Buffer.from([item.opcode]), s24(target - (offset + 4))]));
      offset += 4;
    } else {
      const encoded = Buffer.concat([Buffer.from([item.opcode]), ...(item.operands ?? [])]);
      chunks.push(encoded);
      offset += encoded.length;
    }
  }
  return Buffer.concat(chunks);
}

function multiname(abc: ReturnType<typeof parseAbc>, name: string): Buffer {
  const index = abc.multinameNames.findIndex((candidate) => candidate === name);
  if (index < 0) throw new PatchError(`Multiname ${name} not found.`);
  return writeU30(index);
}

function classMultiname(abc: ReturnType<typeof parseAbc>, className: string): Buffer {
  const classIndex = classIndexByName(abc, className);
  if (classIndex === null) throw new PatchError(`${className} class not found.`);
  return writeU30(abc.instances[classIndex].classNameIdx);
}

function stringValue(abc: ReturnType<typeof parseAbc>, value: string): Buffer {
  const index = abc.stringValues.findIndex((candidate) => candidate === value);
  if (index < 0) throw new PatchError(`String ${value} not found.`);
  return writeU30(index);
}

function getLocal(index: number): PatchInstruction {
  return index <= 3 ? { opcode: 0xd0 + index } : { opcode: 0x62, operands: [writeU30(index)] };
}

function setLocal(index: number): PatchInstruction {
  return index <= 3 ? { opcode: 0xd4 + index } : { opcode: 0x63, operands: [writeU30(index)] };
}

function pushPositive(value: number): PatchInstruction {
  return value <= 127 ? { opcode: 0x24, operands: [Buffer.from([value])] } : { opcode: 0x25, operands: [writeU30(value)] };
}

function loadMethod(ctx: ReturnType<typeof parseSwf>, abc: ReturnType<typeof parseAbc>, className: string, methodName: string): MethodTarget {
  const classIndex = classIndexByName(abc, className);
  if (classIndex === null) throw new PatchError(`${className} class not found.`);
  const methodIndex = methodIdxForTrait(abc.instances[classIndex].traits, abc, methodName);
  if (methodIndex === null) throw new PatchError(`${className}.${methodName} not found.`);
  const body = abc.methodBodies.get(methodIndex);
  if (!body) throw new PatchError(`${className}.${methodName} body not found.`);
  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  return { body, code, insts: disassemble(code, `${className}.${methodName}`) };
}

function dynamicChilblainsMultiname(ctx: ReturnType<typeof parseSwf>, abc: ReturnType<typeof parseAbc>): Buffer {
  const chillIndex = abc.stringValues.findIndex((candidate) => candidate === "Chilblains");
  if (chillIndex < 0) throw new PatchError("Chilblains string not found.");
  for (const body of abc.methodBodies.values()) {
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const insts = disassemble(code, `method ${body.methodIdx}`);
    for (let index = 1; index + 1 < insts.length; index += 1) {
      const current = insts[index];
      const previous = insts[index - 1];
      const next = insts[index + 1];
      if (
        current.opcode === 0x2c && current.operands[0]?.[1] === chillIndex &&
        previous.opcode === 0x66 && abc.multinameNames[previous.operands[0]?.[1]] === "buffTypesDict" &&
        next.opcode === 0x66
      ) {
        return writeU30(next.operands[0][1]);
      }
    }
  }
  throw new PatchError("Could not harvest the runtime dictionary multiname used for Chilblains.");
}

function percentageAdd(targetLocal: number, numerator: number, denominator: number): PatchInstruction[] {
  return [
    getLocal(targetLocal),
    pushPositive(numerator),
    pushPositive(denominator),
    { opcode: 0xa3 },
    { opcode: 0xa0 },
    { opcode: 0x75 },
    setLocal(targetLocal),
  ];
}

function percentageSubtract(targetLocal: number, numerator: number, denominator: number): PatchInstruction[] {
  return [
    getLocal(targetLocal),
    pushPositive(numerator),
    pushPositive(denominator),
    { opcode: 0xa3 },
    { opcode: 0xa1 },
    { opcode: 0x75 },
    setLocal(targetLocal),
  ];
}

function buildDamageBlock(
  abc: ReturnType<typeof parseAbc>,
  markerLocal: number,
  buffLocal: number,
  dynamicProperty: Buffer,
  cometNumerator = 10,
): Buffer {
  const var3 = multiname(abc, "var_3");
  const var18 = multiname(abc, "var_18");
  const basePowerName = multiname(abc, "basePowerName");
  const method102 = multiname(abc, "method_102");
  const combatState = multiname(abc, "combatState");
  const var1176 = multiname(abc, "var_1176");
  const buffTypesDict = multiname(abc, "buffTypesDict");
  const method135 = multiname(abc, "method_135");
  const method351 = multiname(abc, "method_351");

  const immobileGuard = (amount: number): PatchInstruction[] => [
    getLocal(3),
    { opcode: 0x66, operands: [combatState] },
    { opcode: 0x66, operands: [var1176] },
    { opcode: 0x60, operands: [classMultiname(abc, "BuffType")] },
    { opcode: 0x66, operands: [multiname(abc, "const_54")] },
    { opcode: 0xa8 },
    { opcode: 0x12, branchTo: "done" },
    ...percentageAdd(6, amount, 100),
    { opcode: 0x10, branchTo: "done" },
  ];

  return assemble([
    getLocal(0), { opcode: 0x66, operands: [var3] }, { opcode: 0x66, operands: [var18] },
    { opcode: 0x12, branchTo: "done" },
    getLocal(0), { opcode: 0x66, operands: [var3] }, { opcode: 0x66, operands: [var18] },
    getLocal(0), { opcode: 0x66, operands: [var3] },
    getLocal(2), { opcode: 0x66, operands: [basePowerName] },
    { opcode: 0x2c, operands: [stringValue(abc, "SpawnLimit")] },
    { opcode: 0x46, operands: [method102, writeU30(3)] },
    setLocal(markerLocal),

    getLocal(markerLocal), pushPositive(11), { opcode: 0xab },
    { opcode: 0x12, branchTo: "checkGlacial" },
    ...immobileGuard(15),

    { opcode: -1, label: "checkGlacial" },
    getLocal(markerLocal), pushPositive(15), { opcode: 0xab },
    { opcode: 0x12, branchTo: "checkComet" },
    ...immobileGuard(10),

    { opcode: -1, label: "checkComet" },
    getLocal(markerLocal), pushPositive(12), { opcode: 0xab },
    { opcode: 0x11, branchTo: "chill15" },
    getLocal(markerLocal), pushPositive(13), { opcode: 0xab },
    { opcode: 0x12, branchTo: "done" },
    { opcode: 0x10, branchTo: "loadChill1" },

    { opcode: -1, label: "chill15" },
    { opcode: 0x10, branchTo: "loadChill15" },

    { opcode: -1, label: "loadChill1" },
    getLocal(3), { opcode: 0x66, operands: [combatState] },
    { opcode: 0x60, operands: [classMultiname(abc, "class_14")] },
    { opcode: 0x66, operands: [buffTypesDict] },
    { opcode: 0x2c, operands: [stringValue(abc, "Chilblains")] },
    { opcode: 0x66, operands: [dynamicProperty] },
    { opcode: 0x46, operands: [method135, writeU30(1)] },
    { opcode: 0x2a }, setLocal(buffLocal), { opcode: 0x12, branchTo: "done" },
    getLocal(6), pushPositive(1), pushPositive(100), { opcode: 0xa3 },
    getLocal(buffLocal), { opcode: 0x46, operands: [method351, writeU30(0)] },
    { opcode: 0xa2 }, { opcode: 0xa0 }, { opcode: 0x75 }, setLocal(6),
    { opcode: 0x10, branchTo: "done" },

    { opcode: -1, label: "loadChill15" },
    getLocal(3), { opcode: 0x66, operands: [combatState] },
    { opcode: 0x60, operands: [classMultiname(abc, "class_14")] },
    { opcode: 0x66, operands: [buffTypesDict] },
    { opcode: 0x2c, operands: [stringValue(abc, "Chilblains")] },
    { opcode: 0x66, operands: [dynamicProperty] },
    { opcode: 0x46, operands: [method135, writeU30(1)] },
    { opcode: 0x2a }, setLocal(buffLocal), { opcode: 0x12, branchTo: "done" },
    getLocal(6), pushPositive(cometNumerator), pushPositive(1000), { opcode: 0xa3 },
    getLocal(buffLocal), { opcode: 0x46, operands: [method351, writeU30(0)] },
    { opcode: 0xa2 }, { opcode: 0xa0 }, { opcode: 0x75 }, setLocal(6),

    { opcode: -1, label: "done" },
  ]);
}

function buildFireStackDamageBlock(
  abc: ReturnType<typeof parseAbc>,
  markerLocal: number,
  buffLocal: number,
  dynamicProperty: Buffer,
): Buffer {
  const var3 = multiname(abc, "var_3");
  const var18 = multiname(abc, "var_18");
  const basePowerName = multiname(abc, "basePowerName");
  const method102 = multiname(abc, "method_102");
  const combatState = multiname(abc, "combatState");
  const buffTypesDict = multiname(abc, "buffTypesDict");
  const method135 = multiname(abc, "method_135");
  const method351 = multiname(abc, "method_351");

  return assemble([
    getLocal(0), { opcode: 0x66, operands: [var3] }, { opcode: 0x66, operands: [var18] },
    { opcode: 0x12, branchTo: "done" },
    getLocal(0), { opcode: 0x66, operands: [var3] }, { opcode: 0x66, operands: [var18] },
    getLocal(0), { opcode: 0x66, operands: [var3] },
    getLocal(2), { opcode: 0x66, operands: [basePowerName] },
    { opcode: 0x2c, operands: [stringValue(abc, "SpawnLimit")] },
    { opcode: 0x46, operands: [method102, writeU30(3)] },
    setLocal(markerLocal),

    getLocal(markerLocal), pushPositive(16), { opcode: 0xab },
    { opcode: 0x11, branchTo: "loadBurn" },
    getLocal(markerLocal), pushPositive(17), { opcode: 0xab },
    { opcode: 0x12, branchTo: "done" },

    { opcode: -1, label: "loadBurn" },
    getLocal(3), { opcode: 0x66, operands: [combatState] },
    { opcode: 0x60, operands: [classMultiname(abc, "class_14")] },
    { opcode: 0x66, operands: [buffTypesDict] },
    { opcode: 0x2c, operands: [stringValue(abc, "Burned")] },
    { opcode: 0x66, operands: [dynamicProperty] },
    { opcode: 0x46, operands: [method135, writeU30(1)] },
    { opcode: 0x2a }, setLocal(buffLocal), { opcode: 0x12, branchTo: "done" },
    getLocal(6), pushPositive(1), pushPositive(100), { opcode: 0xa3 },
    getLocal(buffLocal), { opcode: 0x46, operands: [method351, writeU30(0)] },
    { opcode: 0xa2 }, { opcode: 0xa0 }, { opcode: 0x75 }, setLocal(6),

    { opcode: -1, label: "done" },
  ]);
}

function buildPoisonDamageBlock(abc: ReturnType<typeof parseAbc>, markerLocal: number): Buffer {
  const var3 = multiname(abc, "var_3");
  const var18 = multiname(abc, "var_18");
  const basePowerName = multiname(abc, "basePowerName");
  const method102 = multiname(abc, "method_102");
  const combatState = multiname(abc, "combatState");
  const var1176 = multiname(abc, "var_1176");

  return assemble([
    getLocal(0), { opcode: 0x66, operands: [var3] }, { opcode: 0x66, operands: [var18] },
    { opcode: 0x12, branchTo: "done" },
    getLocal(0), { opcode: 0x66, operands: [var3] }, { opcode: 0x66, operands: [var18] },
    getLocal(0), { opcode: 0x66, operands: [var3] },
    getLocal(2), { opcode: 0x66, operands: [basePowerName] },
    { opcode: 0x2c, operands: [stringValue(abc, "SpawnLimit")] },
    { opcode: 0x46, operands: [method102, writeU30(3)] },
    setLocal(markerLocal),

    getLocal(markerLocal), pushPositive(18), { opcode: 0xab },
    { opcode: 0x11, branchTo: "checkPoison" },
    getLocal(markerLocal), pushPositive(19), { opcode: 0xab },
    { opcode: 0x12, branchTo: "done" },

    { opcode: -1, label: "checkPoison" },
    getLocal(3), { opcode: 0x66, operands: [combatState] },
    { opcode: 0x66, operands: [var1176] },
    { opcode: 0x60, operands: [classMultiname(abc, "BuffType")] },
    { opcode: 0x66, operands: [multiname(abc, "const_70")] },
    { opcode: 0xa8 },
    { opcode: 0x12, branchTo: "done" },
    ...percentageAdd(6, 10, 100),

    { opcode: -1, label: "done" },
  ]);
}

function buildBlackStormDamageBlock(abc: ReturnType<typeof parseAbc>): Buffer {
  const var3 = multiname(abc, "var_3");
  const var18 = multiname(abc, "var_18");
  const basePowerName = multiname(abc, "basePowerName");
  const method102 = multiname(abc, "method_102");
  const var1298 = multiname(abc, "var_1298");

  return assemble([
    getLocal(0), { opcode: 0x66, operands: [var3] }, { opcode: 0x66, operands: [var18] },
    { opcode: 0x12, branchTo: "done" },
    getLocal(0), { opcode: 0x66, operands: [var3] }, { opcode: 0x66, operands: [var18] },
    getLocal(0), { opcode: 0x66, operands: [var3] },
    getLocal(2), { opcode: 0x66, operands: [basePowerName] },
    { opcode: 0x2c, operands: [stringValue(abc, "SpawnLimit")] },
    { opcode: 0x46, operands: [method102, writeU30(3)] },
    pushPositive(7), { opcode: 0xab }, { opcode: 0x12, branchTo: "done" },
    getLocal(0), { opcode: 0x66, operands: [var1298] }, { opcode: 0x12, branchTo: "done" },
    ...percentageAdd(6, 30, 100),
    { opcode: -1, label: "done" },
  ]);
}

function buildPainBenderBalanceBlock(abc: ReturnType<typeof parseAbc>, gearBonus = 10): Buffer {
  const var3 = multiname(abc, "var_3");
  const var18 = multiname(abc, "var_18");
  const basePowerName = multiname(abc, "basePowerName");
  const var7 = multiname(abc, "var_7");
  const combatState = multiname(abc, "combatState");
  const var1033 = multiname(abc, "var_1033");
  const method102 = multiname(abc, "method_102");

  return assemble([
    // The stock runtime grants 15/30/45/60/75% vs Bound. Subtract only the amount
    // needed to make the innate curve 15/25/35/45/50%.
    getLocal(2), { opcode: 0x66, operands: [basePowerName] },
    { opcode: 0x2c, operands: [stringValue(abc, "PainBender")] }, { opcode: 0xab },
    { opcode: 0x12, branchTo: "done" },
    getLocal(3), { opcode: 0x66, operands: [combatState] }, { opcode: 0x66, operands: [var1033] },
    { opcode: 0x12, branchTo: "done" },

    getLocal(2), { opcode: 0x66, operands: [var7] }, pushPositive(10), { opcode: 0x18, branchTo: "subtract25" },
    getLocal(2), { opcode: 0x66, operands: [var7] }, pushPositive(9), { opcode: 0x18, branchTo: "subtract15" },
    getLocal(2), { opcode: 0x66, operands: [var7] }, pushPositive(7), { opcode: 0x18, branchTo: "subtract10" },
    getLocal(2), { opcode: 0x66, operands: [var7] }, pushPositive(4), { opcode: 0x18, branchTo: "subtract5" },
    { opcode: 0x10, branchTo: "gear" },

    { opcode: -1, label: "subtract25" }, ...percentageSubtract(6, 25, 100), { opcode: 0x10, branchTo: "gear" },
    { opcode: -1, label: "subtract15" }, ...percentageSubtract(6, 15, 100), { opcode: 0x10, branchTo: "gear" },
    { opcode: -1, label: "subtract10" }, ...percentageSubtract(6, 10, 100), { opcode: 0x10, branchTo: "gear" },
    { opcode: -1, label: "subtract5" }, ...percentageSubtract(6, 5, 100),

    // Marker 9 replaces the old self-Bind rune with a flat Bound-target bonus.
    { opcode: -1, label: "gear" },
    getLocal(0), { opcode: 0x66, operands: [var3] }, { opcode: 0x66, operands: [var18] },
    { opcode: 0x12, branchTo: "done" },
    getLocal(0), { opcode: 0x66, operands: [var3] }, { opcode: 0x66, operands: [var18] },
    getLocal(0), { opcode: 0x66, operands: [var3] },
    getLocal(2), { opcode: 0x66, operands: [basePowerName] },
    { opcode: 0x2c, operands: [stringValue(abc, "SpawnLimit")] },
    { opcode: 0x46, operands: [method102, writeU30(3)] },
    pushPositive(9), { opcode: 0xab }, { opcode: 0x12, branchTo: "done" },
    ...percentageAdd(6, gearBonus, 100),

    { opcode: -1, label: "done" },
  ]);
}

function buildFrostSpireBlock(abc: ReturnType<typeof parseAbc>): Buffer {
  const powerType = multiname(abc, "powerType");
  const var4 = multiname(abc, "var_4");
  const var18 = multiname(abc, "var_18");
  const basePowerName = multiname(abc, "basePowerName");
  const method102 = multiname(abc, "method_102");
  const var1 = multiname(abc, "var_1");
  const var10 = multiname(abc, "var_10");
  const var12 = multiname(abc, "var_12");
  const var127 = multiname(abc, "var_127");
  const method63 = multiname(abc, "method_63");
  const var54 = multiname(abc, "var_54");
  const var108 = multiname(abc, "var_108");
  const length = multiname(abc, "length");
  const aoeRadius = multiname(abc, "aoeRadius");
  const gatherEntities = multiname(abc, "GatherEntities");

  return assemble([
    getLocal(0), { opcode: 0x66, operands: [var4] }, { opcode: 0x66, operands: [var18] },
    { opcode: 0x12, branchTo: "stock" },
    getLocal(0), { opcode: 0x66, operands: [var4] }, { opcode: 0x66, operands: [var18] },
    getLocal(0), { opcode: 0x66, operands: [var4] },
    getLocal(0), { opcode: 0x66, operands: [powerType] }, { opcode: 0x66, operands: [basePowerName] },
    { opcode: 0x2c, operands: [stringValue(abc, "SpawnLimit")] },
    { opcode: 0x46, operands: [method102, writeU30(3)] },
    pushPositive(14), { opcode: 0xab }, { opcode: 0x12, branchTo: "stock" },

    getLocal(0), { opcode: 0x66, operands: [var1] },
    getLocal(0), { opcode: 0x66, operands: [var4] },
    getLocal(0), { opcode: 0x66, operands: [var4] }, { opcode: 0x66, operands: [var10] },
    getLocal(0), { opcode: 0x66, operands: [var4] }, { opcode: 0x66, operands: [var12] },
    getLocal(0), { opcode: 0x66, operands: [powerType] }, { opcode: 0x66, operands: [var127] }, { opcode: 0xa0 },
    getLocal(0), { opcode: 0x66, operands: [powerType] },
    getLocal(0), { opcode: 0x66, operands: [var4] },
    { opcode: 0x46, operands: [method63, writeU30(1)] },
    getLocal(0), { opcode: 0x66, operands: [var54] }, pushPositive(1), { opcode: 0xa0 }, { opcode: 0xa2 },
    getLocal(0), { opcode: 0x66, operands: [powerType] }, { opcode: 0x66, operands: [var108] }, { opcode: 0x66, operands: [length] },
    { opcode: 0xa3 }, { opcode: 0x74 },
    getLocal(0), { opcode: 0x66, operands: [powerType] }, { opcode: 0x66, operands: [aoeRadius] },
    getLocal(6),
    { opcode: 0x46, operands: [gatherEntities, writeU30(6)] }, { opcode: 0x48 },

    { opcode: -1, label: "stock" },
  ]);
}

function buildFrostSpireVisualBlock(abc: ReturnType<typeof parseAbc>, mirrorLocal: number): Buffer {
  const powerType = multiname(abc, "powerType");
  const basePowerName = multiname(abc, "basePowerName");
  const var4 = multiname(abc, "var_4");
  const var18 = multiname(abc, "var_18");
  const method102 = multiname(abc, "method_102");
  const var1 = multiname(abc, "var_1");
  const var24 = multiname(abc, "var_24");
  const mTheDo = multiname(abc, "m_TheDO");
  const appearPosX = multiname(abc, "appearPosX");
  const x = multiname(abc, "x");
  const y = multiname(abc, "y");
  const scaleX = multiname(abc, "scaleX");
  const scaleY = multiname(abc, "scaleY");
  const playerEntLayer = multiname(abc, "playerEntLayer");
  const getChildIndex = multiname(abc, "getChildIndex");
  const addChildAt = multiname(abc, "addChildAt");

  return assemble([
    // method_573 initializes local 3 to null, so this also keeps the stock early-out intact.
    getLocal(3), { opcode: 0x12, branchTo: "done" },
    getLocal(0), { opcode: 0x66, operands: [powerType] }, { opcode: 0x66, operands: [basePowerName] },
    { opcode: 0x2c, operands: [stringValue(abc, "Avalanche")] }, { opcode: 0xab },
    { opcode: 0x12, branchTo: "done" },
    getLocal(0), { opcode: 0x66, operands: [var4] }, { opcode: 0x66, operands: [var18] },
    { opcode: 0x12, branchTo: "done" },
    getLocal(0), { opcode: 0x66, operands: [var4] }, { opcode: 0x66, operands: [var18] },
    getLocal(0), { opcode: 0x66, operands: [var4] },
    getLocal(0), { opcode: 0x66, operands: [powerType] }, { opcode: 0x66, operands: [basePowerName] },
    { opcode: 0x2c, operands: [stringValue(abc, "SpawnLimit")] },
    { opcode: 0x46, operands: [method102, writeU30(3)] },
    pushPositive(14), { opcode: 0xab }, { opcode: 0x12, branchTo: "done" },

    { opcode: 0x60, operands: [classMultiname(abc, "SuperAnimInstance")] },
    getLocal(0), { opcode: 0x66, operands: [var1] },
    getLocal(1),
    getLocal(0), { opcode: 0x66, operands: [var4] }, { opcode: 0x66, operands: [var24] },
    { opcode: 0x20 }, { opcode: 0xab }, { opcode: 0x96 },
    { opcode: 0x42, operands: [writeU30(3)] }, setLocal(mirrorLocal),

    // Mirror the already-positioned fire-and-forget effect around the caster. This duplicates
    // only presentation; it does not invoke the power, targeting, or damage paths a second time.
    getLocal(mirrorLocal), { opcode: 0x66, operands: [mTheDo] },
    getLocal(0), { opcode: 0x66, operands: [var4] }, { opcode: 0x66, operands: [appearPosX] },
    pushPositive(2), { opcode: 0xa2 },
    getLocal(3), { opcode: 0x66, operands: [mTheDo] }, { opcode: 0x66, operands: [x] },
    { opcode: 0xa1 }, { opcode: 0x61, operands: [x] },

    getLocal(mirrorLocal), { opcode: 0x66, operands: [mTheDo] },
    getLocal(3), { opcode: 0x66, operands: [mTheDo] }, { opcode: 0x66, operands: [y] },
    { opcode: 0x61, operands: [y] },

    getLocal(mirrorLocal), { opcode: 0x66, operands: [mTheDo] }, pushPositive(0),
    getLocal(3), { opcode: 0x66, operands: [mTheDo] }, { opcode: 0x66, operands: [scaleX] },
    { opcode: 0xa1 }, { opcode: 0x61, operands: [scaleX] },

    getLocal(mirrorLocal), { opcode: 0x66, operands: [mTheDo] },
    getLocal(3), { opcode: 0x66, operands: [mTheDo] }, { opcode: 0x66, operands: [scaleY] },
    { opcode: 0x61, operands: [scaleY] },

    getLocal(0), { opcode: 0x66, operands: [var1] }, { opcode: 0x66, operands: [playerEntLayer] },
    getLocal(mirrorLocal), { opcode: 0x66, operands: [mTheDo] },
    getLocal(0), { opcode: 0x66, operands: [var1] }, { opcode: 0x66, operands: [playerEntLayer] },
    getLocal(3), { opcode: 0x66, operands: [mTheDo] },
    { opcode: 0x46, operands: [getChildIndex, writeU30(1)] }, pushPositive(1), { opcode: 0xa0 },
    { opcode: 0x4f, operands: [addChildAt, writeU30(2)] },

    { opcode: -1, label: "done" },
  ]);
}

function buildDeathMarkDurationBlock(abc: ReturnType<typeof parseAbc>): Buffer {
  const var4 = multiname(abc, "var_4");
  const var18 = multiname(abc, "var_18");
  const powerType = multiname(abc, "powerType");
  const basePowerName = multiname(abc, "basePowerName");
  const method102 = multiname(abc, "method_102");
  const var54 = multiname(abc, "var_54");
  const var108 = multiname(abc, "var_108");
  const length = multiname(abc, "length");
  const var2064 = multiname(abc, "var_2064");
  const var1145 = multiname(abc, "var_1145");
  const var344 = multiname(abc, "var_344");

  return assemble([
    getLocal(0), { opcode: 0x66, operands: [var4] }, { opcode: 0x66, operands: [var18] },
    { opcode: 0x12, branchTo: "stock" },
    getLocal(0), { opcode: 0x66, operands: [var4] }, { opcode: 0x66, operands: [var18] },
    getLocal(0), { opcode: 0x66, operands: [var4] },
    getLocal(0), { opcode: 0x66, operands: [powerType] }, { opcode: 0x66, operands: [basePowerName] },
    { opcode: 0x2c, operands: [stringValue(abc, "SpawnDuration")] },
    { opcode: 0x46, operands: [method102, writeU30(3)] },
    pushPositive(3000), { opcode: 0xab }, { opcode: 0x12, branchTo: "stock" },

    getLocal(0), { opcode: 0x66, operands: [var54] },
    getLocal(0), { opcode: 0x66, operands: [powerType] }, { opcode: 0x66, operands: [var108] },
    { opcode: 0x66, operands: [length] }, pushPositive(1), { opcode: 0xa1 },
    { opcode: 0xab }, { opcode: 0x12, branchTo: "stock" },
    getLocal(0), { opcode: 0x66, operands: [var2064] }, pushPositive(16),
    { opcode: 0x18, branchTo: "stock" },

    getLocal(0), getLocal(0), { opcode: 0x66, operands: [var1145] }, pushPositive(500),
    { opcode: 0xa0 }, { opcode: 0x61, operands: [var1145] },
    getLocal(0), { opcode: 0x27 }, { opcode: 0x61, operands: [var344] },
    { opcode: 0x26 }, { opcode: 0x48 },

    { opcode: -1, label: "stock" },
  ]);
}

function buildBlackMiasmaDurationBlock(abc: ReturnType<typeof parseAbc>): Buffer {
  const var4 = multiname(abc, "var_4");
  const var18 = multiname(abc, "var_18");
  const powerType = multiname(abc, "powerType");
  const basePowerName = multiname(abc, "basePowerName");
  const method102 = multiname(abc, "method_102");
  const var54 = multiname(abc, "var_54");
  const var108 = multiname(abc, "var_108");
  const length = multiname(abc, "length");
  const var2064 = multiname(abc, "var_2064");
  const var1145 = multiname(abc, "var_1145");
  const var344 = multiname(abc, "var_344");

  return assemble([
    getLocal(0), { opcode: 0x66, operands: [var4] }, { opcode: 0x66, operands: [var18] },
    { opcode: 0x12, branchTo: "stock" },
    getLocal(0), { opcode: 0x66, operands: [var4] }, { opcode: 0x66, operands: [var18] },
    getLocal(0), { opcode: 0x66, operands: [var4] },
    getLocal(0), { opcode: 0x66, operands: [powerType] }, { opcode: 0x66, operands: [basePowerName] },
    { opcode: 0x2c, operands: [stringValue(abc, "SpawnLimit")] },
    { opcode: 0x46, operands: [method102, writeU30(3)] },
    pushPositive(8), { opcode: 0xab }, { opcode: 0x12, branchTo: "stock" },

    getLocal(0), { opcode: 0x66, operands: [var54] },
    getLocal(0), { opcode: 0x66, operands: [powerType] }, { opcode: 0x66, operands: [var108] },
    { opcode: 0x66, operands: [length] }, pushPositive(1), { opcode: 0xa1 },
    { opcode: 0xab }, { opcode: 0x12, branchTo: "stock" },
    // The helper has five authored phases. Six additional 500 ms final phases keep its
    // cloud active for exactly three more seconds, independent of the authored phase count.
    getLocal(0), { opcode: 0x66, operands: [var2064] },
    getLocal(0), { opcode: 0x66, operands: [powerType] }, { opcode: 0x66, operands: [var108] },
    { opcode: 0x66, operands: [length] }, pushPositive(6), { opcode: 0xa0 },
    { opcode: 0x18, branchTo: "stock" },

    getLocal(0), getLocal(0), { opcode: 0x66, operands: [var1145] }, pushPositive(500),
    { opcode: 0xa0 }, { opcode: 0x61, operands: [var1145] },
    getLocal(0), { opcode: 0x27 }, { opcode: 0x61, operands: [var344] },
    { opcode: 0x26 }, { opcode: 0x48 },

    { opcode: -1, label: "stock" },
  ]);
}

function isGetLocal(inst: Instruction, local: number): boolean {
  return (local <= 3 && inst.opcode === 0xd0 + local) || (inst.opcode === 0x62 && inst.operands[0]?.[1] === local);
}

function isSetLocal(inst: Instruction, local: number): boolean {
  return (local <= 3 && inst.opcode === 0xd4 + local) || (inst.opcode === 0x63 && inst.operands[0]?.[1] === local);
}

function damageAnchor(insts: Instruction[]): number {
  for (let index = 0; index + 6 < insts.length; index += 1) {
    if (
      isGetLocal(insts[index], 6) && isGetLocal(insts[index + 1], 7) &&
      isGetLocal(insts[index + 2], 1) && insts[index + 3].opcode === 0xa3 &&
      insts[index + 4].opcode === 0xa0 && insts[index + 5].opcode === 0x75 &&
      isSetLocal(insts[index + 6], 6)
    ) return insts[index].offset;
  }
  throw new PatchError("CombatState.method_1393 final damage anchor not found.");
}

function frostSpireAnchor(abc: ReturnType<typeof parseAbc>, insts: Instruction[]): number {
  const powerType = abc.multinameNames.findIndex((name) => name === "powerType");
  const var6 = abc.multinameNames.findIndex((name) => name === "var_6");
  const powerTypeClass = abc.multinameNames.findIndex((name) => name === "PowerType");
  const wave = abc.multinameNames.findIndex((name) => name === "const_99");
  for (let index = 0; index + 6 < insts.length; index += 1) {
    if (
      insts[index].opcode === 0xd0 &&
      insts[index + 1].opcode === 0x66 && insts[index + 1].operands[0]?.[1] === powerType &&
      insts[index + 2].opcode === 0x66 && insts[index + 2].operands[0]?.[1] === var6 &&
      insts[index + 3].opcode === 0x60 && insts[index + 3].operands[0]?.[1] === powerTypeClass &&
      insts[index + 4].opcode === 0x66 && insts[index + 4].operands[0]?.[1] === wave &&
      BRANCH_OPCODES.has(insts[index + 5].opcode)
    ) return insts[index + 6].offset;
  }
  throw new PatchError("ActivePower.method_921 Wave branch not found.");
}

function deathMarkDurationAnchor(abc: ReturnType<typeof parseAbc>, insts: Instruction[]): number {
  const propertyIs = (inst: Instruction, name: string): boolean =>
    inst.opcode === 0x66 && abc.multinameNames[inst.operands[0]?.[1]] === name;
  for (let index = 0; index + 9 < insts.length; index += 1) {
    if (
      insts[index].opcode === 0xd0 &&
      propertyIs(insts[index + 1], "var_240") &&
      BRANCH_OPCODES.has(insts[index + 2].opcode) &&
      insts[index + 3].opcode === 0xd0 &&
      propertyIs(insts[index + 4], "var_54") &&
      insts[index + 5].opcode === 0xd0 &&
      propertyIs(insts[index + 6], "powerType") &&
      propertyIs(insts[index + 7], "var_108") &&
      propertyIs(insts[index + 8], "length")
    ) return insts[index].offset;
  }
  throw new PatchError("ActivePower.method_243 final phase branch not found.");
}

function returnVoidAnchor(insts: Instruction[], label: string): number {
  for (let index = insts.length - 1; index >= 0; index -= 1) {
    if (insts[index].opcode === 0x47) return insts[index].offset;
  }
  throw new PatchError(`${label} returnvoid not found.`);
}

function shiftExceptions(
  ctx: ReturnType<typeof parseSwf>,
  target: MethodTarget,
  insertAt: number,
  delta: number,
  label: string,
): BytePatch[] {
  if (!target.body.exceptionCount) return [];
  const [, entriesStart] = readU30(ctx.body, target.body.exceptionCountPos, `${label}.exception_count`);
  const shift = (offset: number): number => offset >= insertAt ? offset + delta : offset;
  const data = Buffer.concat(target.body.exceptions.flatMap((entry) => [
    writeU30(shift(entry.from)),
    writeU30(shift(entry.to)),
    writeU30(shift(entry.target)),
    writeU30(entry.type),
    writeU30(entry.name),
  ]));
  return [{
    key: `${label}.exceptions`,
    start: entriesStart,
    end: target.body.traitsCountPos,
    data,
    detail: `shift ${target.body.exceptionCount} exception range(s)`,
  }];
}

function spliceIntoMethod(code: Buffer, insts: Instruction[], atOffset: number, block: Buffer, label: string): Buffer {
  if (!insts.some((inst) => inst.offset === atOffset)) throw new PatchError(`${label}: splice is not on an instruction boundary.`);
  const remap = new Map<number, number>();
  let cursor = 0;
  for (const inst of insts) {
    remap.set(inst.offset, cursor);
    if (inst.offset === atOffset) cursor += block.length;
    cursor += inst.size;
  }
  remap.set(code.length, cursor);
  const out = Buffer.alloc(cursor);
  let write = 0;
  for (const inst of insts) {
    if (inst.offset === atOffset) { block.copy(out, write); write += block.length; }
    code.copy(out, write, inst.offset, inst.offset + inst.size);
    if (BRANCH_OPCODES.has(inst.opcode)) {
      const oldTarget = inst.offset + 4 + inst.operands[0][1];
      const newTarget = remap.get(oldTarget);
      if (newTarget === undefined) throw new PatchError(`${label}: branch target ${oldTarget} is not an instruction boundary.`);
      out.writeIntLE(newTarget - (write + 4), write + 1, 3);
    }
    write += inst.size;
  }
  return out;
}

function assertBranchesLand(code: Buffer, label: string): void {
  const insts = disassemble(code, `${label} patched`);
  const boundaries = new Set(insts.map((inst) => inst.offset));
  const last = insts[insts.length - 1];
  if (!last || last.offset + last.size !== code.length) throw new PatchError(`${label}: patched code does not disassemble cleanly.`);
  for (const inst of insts) {
    if (!BRANCH_OPCODES.has(inst.opcode)) continue;
    const target = inst.offset + 4 + inst.operands[0][1];
    if (target !== code.length && !boundaries.has(target)) throw new PatchError(`${label}: branch at ${inst.offset} misses ${target}.`);
  }
}

function syncClientRevision(swfPath: string, verify: boolean): void {
  if (path.resolve(swfPath) !== DEFAULT_SWF) return;
  const indexPath = path.resolve(path.dirname(swfPath), "..", "..", "index.html");
  const html = fs.readFileSync(indexPath, "utf8");
  const revision = `clientrev=swf-${crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12)}`;
  if (html.includes(revision)) return;
  if (verify) throw new PatchError(`index.html does not use ${revision}.`);
  const updated = html.replace(/clientrev=swf-[0-9a-f]{12}/g, revision);
  if (updated === html) throw new PatchError("Could not update DungeonBlitz client revision in index.html.");
  fs.writeFileSync(indexPath, updated, "utf8");
}

function patchSwf(swfPath: string, verify: boolean): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const damage = loadMethod(ctx, abc, "CombatState", "method_1393");
  const gather = loadMethod(ctx, abc, "ActivePower", "method_921");
  const fireGfx = loadMethod(ctx, abc, "ActivePower", "method_573");
  const activeTick = loadMethod(ctx, abc, "ActivePower", "method_243");
  if (damage.body.exceptionCount || gather.body.exceptionCount || fireGfx.body.exceptionCount) throw new PatchError("Mage gear target methods have unexpected exception tables.");

  const [damageLocals, damageLocalsEnd] = readU30(ctx.body, damage.body.localCountPos, "CombatState.method_1393.local_count");
  const dynamicProperty = dynamicChilblainsMultiname(ctx, abc);
  const spawnLimitString = abc.stringValues.findIndex((candidate) => candidate === "SpawnLimit");
  if (spawnLimitString < 0) throw new PatchError("SpawnLimit string not found.");
  const hasDamage = damage.insts.some((inst) => inst.opcode === 0x2c && inst.operands[0]?.[1] === spawnLimitString);
  const hasFrost = gather.insts.some((inst) => inst.opcode === 0x2c && inst.operands[0]?.[1] === spawnLimitString);
  const markerLocal = hasDamage ? damageLocals - 2 : damageLocals;
  const buffLocal = markerLocal + 1;
  const damageBlock = buildDamageBlock(abc, markerLocal, buffLocal, dynamicProperty);
  const legacyDamageBlock = buildDamageBlock(abc, markerLocal, buffLocal, dynamicProperty, 15);
  const legacyDamageOffset = hasDamage ? damage.code.indexOf(legacyDamageBlock) : -1;
  const hasCurrentDamage = hasDamage && damage.code.indexOf(damageBlock) >= 0;
  const fireDamageBlock = buildFireStackDamageBlock(abc, markerLocal, buffLocal, dynamicProperty);
  const hasFireDamage = hasDamage && damage.code.indexOf(fireDamageBlock) >= 0;
  const poisonDamageBlock = buildPoisonDamageBlock(abc, markerLocal);
  const hasPoisonDamage = hasDamage && damage.code.indexOf(poisonDamageBlock) >= 0;
  const blackStormDamageBlock = buildBlackStormDamageBlock(abc);
  const hasBlackStormDamage = damage.code.indexOf(blackStormDamageBlock) >= 0;
  const painBenderBalanceBlock = buildPainBenderBalanceBlock(abc);
  const legacyPainBenderBalanceBlock = buildPainBenderBalanceBlock(abc, 25);
  const hasPainBenderBalance = damage.code.indexOf(painBenderBalanceBlock) >= 0;
  const frostBlock = buildFrostSpireBlock(abc);
  const [fireGfxLocals, fireGfxLocalsEnd] = readU30(ctx.body, fireGfx.body.localCountPos, "ActivePower.method_573.local_count");
  const hasFrostVisualMarker = fireGfx.insts.some((inst) => inst.opcode === 0x2c && inst.operands[0]?.[1] === spawnLimitString);
  const frostVisualBlock = buildFrostSpireVisualBlock(abc, hasFrostVisualMarker ? fireGfxLocals - 1 : fireGfxLocals);
  const hasFrostVisual = fireGfx.code.indexOf(frostVisualBlock) >= 0;
  const deathMarkBlock = buildDeathMarkDurationBlock(abc);
  const hasDeathMarkDuration = activeTick.code.indexOf(deathMarkBlock) >= 0;
  const blackMiasmaDurationBlock = buildBlackMiasmaDurationBlock(abc);
  const hasBlackMiasmaDuration = activeTick.code.indexOf(blackMiasmaDurationBlock) >= 0;

  if (hasCurrentDamage && hasFireDamage && hasPoisonDamage && hasBlackStormDamage && hasPainBenderBalance && hasFrost && hasFrostVisual && hasDeathMarkDuration && hasBlackMiasmaDuration) {
    syncClientRevision(swfPath, verify);
    console.log(`${swfPath}: Mage gear rune runtime verified.`);
    return;
  }
  if (verify) throw new PatchError(`${swfPath}: Mage gear rune runtime patch is missing.`);

  const patches: BytePatch[] = [];
  if (!hasCurrentDamage || !hasFireDamage || !hasPoisonDamage || !hasBlackStormDamage || !hasPainBenderBalance) {
    let code = damage.code;
    if (!hasCurrentDamage) {
      if (hasDamage && legacyDamageOffset < 0) throw new PatchError("Existing Mage damage runtime has an unknown revision.");
      code = hasDamage
        ? Buffer.concat([
            code.subarray(0, legacyDamageOffset),
            damageBlock,
            code.subarray(legacyDamageOffset + legacyDamageBlock.length),
          ])
        : spliceIntoMethod(code, damage.insts, damageAnchor(damage.insts), damageBlock, "CombatState.method_1393");
    }
    if (!hasFireDamage) {
      const currentInsts = disassemble(code, "CombatState.method_1393 with Ice gear runtime");
      code = spliceIntoMethod(code, currentInsts, damageAnchor(currentInsts), fireDamageBlock, "CombatState.method_1393 Fire stack runtime");
    }
    if (!hasPoisonDamage) {
      const currentInsts = disassemble(code, "CombatState.method_1393 with elemental gear runtime");
      code = spliceIntoMethod(code, currentInsts, damageAnchor(currentInsts), poisonDamageBlock, "CombatState.method_1393 Poison/Plague runtime");
    }
    if (!hasBlackStormDamage) {
      const currentInsts = disassemble(code, "CombatState.method_1393 with Mage gear runtime");
      code = spliceIntoMethod(code, currentInsts, damageAnchor(currentInsts), blackStormDamageBlock, "CombatState.method_1393 Black Storm runtime");
    }
    if (!hasPainBenderBalance) {
      const legacyOffset = code.indexOf(legacyPainBenderBalanceBlock);
      if (legacyOffset >= 0) {
        code = Buffer.concat([
          code.subarray(0, legacyOffset),
          painBenderBalanceBlock,
          code.subarray(legacyOffset + legacyPainBenderBalanceBlock.length),
        ]);
      } else {
        const currentInsts = disassemble(code, "CombatState.method_1393 with conditional gear runtime");
        code = spliceIntoMethod(code, currentInsts, damageAnchor(currentInsts), painBenderBalanceBlock, "CombatState.method_1393 Butcher's Boon runtime");
      }
    }
    assertBranchesLand(code, "CombatState.method_1393");
    patches.push(
      { key: "mageDamage.code", start: damage.body.codeStart, end: damage.body.codeStart + damage.body.codeLen, data: code, detail: "Mage gear conditional damage" },
      { key: "mageDamage.codeLen", start: damage.body.codeLenPos, end: damage.body.codeStart, data: writeU30(code.length), detail: "Mage gear damage code length" },
    );
    if (!hasDamage) {
      patches.push({ key: "mageDamage.locals", start: damage.body.localCountPos, end: damageLocalsEnd, data: writeU30(damageLocals + 2), detail: "Mage gear damage locals" });
      const [maxStack] = readU30(ctx.body, damage.body.maxStackPos, "CombatState.method_1393.max_stack");
      if (maxStack < 8) patches.push({ key: "mageDamage.stack", start: damage.body.maxStackPos, end: damage.body.localCountPos, data: writeU30(8), detail: "Mage gear damage stack" });
    }
  }
  if (!hasFrost) {
    const code = spliceIntoMethod(gather.code, gather.insts, frostSpireAnchor(abc, gather.insts), frostBlock, "ActivePower.method_921");
    assertBranchesLand(code, "ActivePower.method_921");
    patches.push(
      { key: "frostSpire.code", start: gather.body.codeStart, end: gather.body.codeStart + gather.body.codeLen, data: code, detail: "Frost Spire both-direction targeting" },
      { key: "frostSpire.codeLen", start: gather.body.codeLenPos, end: gather.body.codeStart, data: writeU30(code.length), detail: "Frost Spire code length" },
    );
    const [maxStack] = readU30(ctx.body, gather.body.maxStackPos, "ActivePower.method_921.max_stack");
    if (maxStack < 10) patches.push({ key: "frostSpire.stack", start: gather.body.maxStackPos, end: gather.body.localCountPos, data: writeU30(10), detail: "Frost Spire targeting stack" });
  }
  if (!hasFrostVisual) {
    if (hasFrostVisualMarker) throw new PatchError("Existing Frost Spire visual runtime has an unknown revision.");
    const anchor = returnVoidAnchor(fireGfx.insts, "ActivePower.method_573");
    const code = spliceIntoMethod(fireGfx.code, fireGfx.insts, anchor, frostVisualBlock, "ActivePower.method_573");
    assertBranchesLand(code, "ActivePower.method_573");
    patches.push(
      { key: "frostSpireVisual.code", start: fireGfx.body.codeStart, end: fireGfx.body.codeStart + fireGfx.body.codeLen, data: code, detail: "Frost Spire mirrored fire graphics" },
      { key: "frostSpireVisual.codeLen", start: fireGfx.body.codeLenPos, end: fireGfx.body.codeStart, data: writeU30(code.length), detail: "Frost Spire graphics code length" },
      { key: "frostSpireVisual.locals", start: fireGfx.body.localCountPos, end: fireGfxLocalsEnd, data: writeU30(fireGfxLocals + 1), detail: "Frost Spire graphics mirror local" },
    );
    const [maxStack] = readU30(ctx.body, fireGfx.body.maxStackPos, "ActivePower.method_573.max_stack");
    if (maxStack < 8) patches.push({ key: "frostSpireVisual.stack", start: fireGfx.body.maxStackPos, end: fireGfx.body.localCountPos, data: writeU30(8), detail: "Frost Spire graphics stack" });
  }
  if (!hasDeathMarkDuration || !hasBlackMiasmaDuration) {
    const anchor = deathMarkDurationAnchor(abc, activeTick.insts);
    let code = activeTick.code;
    if (!hasDeathMarkDuration) {
      code = spliceIntoMethod(code, disassemble(code, "ActivePower.method_243 duration runtime"), deathMarkDurationAnchor(abc, disassemble(code, "ActivePower.method_243 duration anchor")), deathMarkBlock, "ActivePower.method_243 Death Mark");
    }
    if (!hasBlackMiasmaDuration) {
      const currentInsts = disassemble(code, "ActivePower.method_243 with Death Mark duration");
      code = spliceIntoMethod(code, currentInsts, deathMarkDurationAnchor(abc, currentInsts), blackMiasmaDurationBlock, "ActivePower.method_243 Black Miasma");
    }
    assertBranchesLand(code, "ActivePower.method_243");
    const addedLength = code.length - activeTick.code.length;
    patches.push(
      { key: "areaDuration.code", start: activeTick.body.codeStart, end: activeTick.body.codeStart + activeTick.body.codeLen, data: code, detail: "Death Mark and Black Miasma gear area durations" },
      { key: "areaDuration.codeLen", start: activeTick.body.codeLenPos, end: activeTick.body.codeStart, data: writeU30(code.length), detail: "Gear area duration code length" },
      ...shiftExceptions(ctx, activeTick, anchor, addedLength, "ActivePower.method_243"),
    );
  }

  ensureBackup(swfPath);
  const result = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, result.body, result.delta);
  syncClientRevision(swfPath, false);
  console.log(`${swfPath}: patched gear runtime, including Death Mark and Black Miasma area durations.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
