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

function dynamicBuffMultiname(ctx: ReturnType<typeof parseSwf>, abc: ReturnType<typeof parseAbc>): Buffer {
  const lookupIndex = abc.stringValues.findIndex((candidate) => candidate === "Chilblains");
  if (lookupIndex < 0) throw new PatchError("Chilblains string not found.");
  for (const body of abc.methodBodies.values()) {
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const insts = disassemble(code, `method ${body.methodIdx}`);
    for (let index = 1; index + 1 < insts.length; index += 1) {
      if (
        insts[index].opcode === 0x2c && insts[index].operands[0]?.[1] === lookupIndex &&
        insts[index - 1].opcode === 0x66 && abc.multinameNames[insts[index - 1].operands[0]?.[1]] === "buffTypesDict" &&
        insts[index + 1].opcode === 0x66
      ) return writeU30(insts[index + 1].operands[0][1]);
    }
  }
  throw new PatchError("Could not harvest the runtime buff dictionary multiname.");
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

function percentageAdd(targetLocal: number, numerator: number, denominator: number): PatchInstruction[] {
  return [
    getLocal(targetLocal), pushPositive(numerator), pushPositive(denominator),
    { opcode: 0xa3 }, { opcode: 0xa0 }, { opcode: 0x75 }, setLocal(targetLocal),
  ];
}

function buildHolySmashDamageBlock(abc: ReturnType<typeof parseAbc>): Buffer {
  const var3 = multiname(abc, "var_3");
  const var18 = multiname(abc, "var_18");
  const basePowerName = multiname(abc, "basePowerName");
  const method102 = multiname(abc, "method_102");
  const combatState = multiname(abc, "combatState");
  const var2291 = multiname(abc, "var_2291");
  return assemble([
    getLocal(0), { opcode: 0x66, operands: [var3] }, { opcode: 0x66, operands: [var18] },
    { opcode: 0x12, branchTo: "done" },
    getLocal(0), { opcode: 0x66, operands: [var3] }, { opcode: 0x66, operands: [var18] },
    getLocal(0), { opcode: 0x66, operands: [var3] },
    getLocal(2), { opcode: 0x66, operands: [basePowerName] },
    { opcode: 0x2c, operands: [stringValue(abc, "SpawnLimit")] },
    { opcode: 0x46, operands: [method102, writeU30(3)] },
    pushPositive(20), { opcode: 0xab }, { opcode: 0x12, branchTo: "done" },
    getLocal(3), { opcode: 0x66, operands: [combatState] }, { opcode: 0x66, operands: [var2291] },
    { opcode: 0x12, branchTo: "done" },
    ...percentageAdd(6, 10, 100),
    { opcode: -1, label: "done" },
  ]);
}

function buildIgnitedDamageBlock(abc: ReturnType<typeof parseAbc>, marker: number, percent: number): Buffer {
  const var3 = multiname(abc, "var_3");
  const var18 = multiname(abc, "var_18");
  const basePowerName = multiname(abc, "basePowerName");
  const method102 = multiname(abc, "method_102");
  const combatState = multiname(abc, "combatState");
  const ignite = multiname(abc, "var_1234");
  return assemble([
    getLocal(0), { opcode: 0x66, operands: [var3] }, { opcode: 0x66, operands: [var18] },
    { opcode: 0x12, branchTo: "done" },
    getLocal(0), { opcode: 0x66, operands: [var3] }, { opcode: 0x66, operands: [var18] },
    getLocal(0), { opcode: 0x66, operands: [var3] },
    getLocal(2), { opcode: 0x66, operands: [basePowerName] },
    { opcode: 0x2c, operands: [stringValue(abc, "SpawnLimit")] },
    { opcode: 0x46, operands: [method102, writeU30(3)] },
    pushPositive(marker), { opcode: 0xab }, { opcode: 0x12, branchTo: "done" },
    getLocal(3), { opcode: 0x66, operands: [combatState] }, { opcode: 0x66, operands: [ignite] },
    { opcode: 0x12, branchTo: "done" },
    ...percentageAdd(6, percent, 100),
    { opcode: -1, label: "done" },
  ]);
}

function buildBlindOrHolyDamageBlock(
  abc: ReturnType<typeof parseAbc>,
  dynamicProperty: Buffer,
  holyFireString: Buffer,
  marker: number,
  percent: number,
): Buffer {
  const var3 = multiname(abc, "var_3");
  const var18 = multiname(abc, "var_18");
  const basePowerName = multiname(abc, "basePowerName");
  const method102 = multiname(abc, "method_102");
  const combatState = multiname(abc, "combatState");
  const buffTypesDict = multiname(abc, "buffTypesDict");
  const method135 = multiname(abc, "method_135");
  const buffLookup = (name: Buffer): PatchInstruction[] => [
    getLocal(3), { opcode: 0x66, operands: [combatState] },
    { opcode: 0x60, operands: [classMultiname(abc, "class_14")] },
    { opcode: 0x66, operands: [buffTypesDict] },
    { opcode: 0x2c, operands: [name] },
    { opcode: 0x66, operands: [dynamicProperty] },
    { opcode: 0x46, operands: [method135, writeU30(1)] },
  ];
  return assemble([
    getLocal(0), { opcode: 0x66, operands: [var3] }, { opcode: 0x66, operands: [var18] },
    { opcode: 0x12, branchTo: "done" },
    getLocal(0), { opcode: 0x66, operands: [var3] }, { opcode: 0x66, operands: [var18] },
    getLocal(0), { opcode: 0x66, operands: [var3] },
    getLocal(2), { opcode: 0x66, operands: [basePowerName] },
    { opcode: 0x2c, operands: [stringValue(abc, "SpawnLimit")] },
    { opcode: 0x46, operands: [method102, writeU30(3)] },
    pushPositive(marker), { opcode: 0xab }, { opcode: 0x12, branchTo: "done" },
    ...buffLookup(stringValue(abc, "Blinded")), { opcode: 0x11, branchTo: "apply" },
    ...buffLookup(holyFireString), { opcode: 0x12, branchTo: "done" },
    { opcode: -1, label: "apply" },
    ...percentageAdd(6, percent, 100),
    { opcode: -1, label: "done" },
  ]);
}

/** Leaves the already-loaded magicDamage on the stack, scaling it by 1.5 only for the gear mod. */
function buildRetributionCapacityBlock(abc: ReturnType<typeof parseAbc>): Buffer {
  const var3 = multiname(abc, "var_3");
  const var18 = multiname(abc, "var_18");
  const basePowerName = multiname(abc, "basePowerName");
  const method102 = multiname(abc, "method_102");
  return assemble([
    getLocal(12), { opcode: 0x12, branchTo: "done" },
    getLocal(0), { opcode: 0x66, operands: [var3] }, { opcode: 0x66, operands: [var18] },
    { opcode: 0x12, branchTo: "done" },
    getLocal(0), { opcode: 0x66, operands: [var3] }, { opcode: 0x66, operands: [var18] },
    getLocal(0), { opcode: 0x66, operands: [var3] },
    getLocal(12), { opcode: 0x66, operands: [basePowerName] },
    { opcode: 0x2c, operands: [stringValue(abc, "SpawnLimit")] },
    { opcode: 0x46, operands: [method102, writeU30(3)] },
    pushPositive(5), { opcode: 0xab }, { opcode: 0x12, branchTo: "done" },
    pushPositive(3), pushPositive(2), { opcode: 0xa3 }, { opcode: 0xa2 },
    { opcode: -1, label: "done" },
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
      isGetLocal(insts[index], 6) && isGetLocal(insts[index + 1], 7) && isGetLocal(insts[index + 2], 1) &&
      insts[index + 3].opcode === 0xa3 && insts[index + 4].opcode === 0xa0 && insts[index + 5].opcode === 0x75 &&
      isSetLocal(insts[index + 6], 6)
    ) return insts[index].offset;
  }
  throw new PatchError("CombatState.method_1393 final damage anchor not found.");
}

function retributionCapacityAnchor(abc: ReturnType<typeof parseAbc>, insts: Instruction[]): number {
  for (let index = 0; index + 4 < insts.length; index += 1) {
    if (
      insts[index].opcode === 0x66 && abc.multinameNames[insts[index].operands[0]?.[1]] === "magicDamage" &&
      insts[index + 1].opcode === 0x24 && insts[index + 1].operands[0]?.[1] === 10 &&
      insts[index + 2].opcode === 0xa2 && insts[index + 3].opcode === 0x75 && isSetLocal(insts[index + 4], 15)
    ) return insts[index + 1].offset;
  }
  throw new PatchError("CombatState.method_522 Retribution capacity anchor not found.");
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
  const addBuff = loadMethod(ctx, abc, "CombatState", "method_522");
  if (damage.body.exceptionCount || addBuff.body.exceptionCount) throw new PatchError("Paladin gear target methods have unexpected exception tables.");
  const holySmashBlock = buildHolySmashDamageBlock(abc);
  const flameAxeBlock = buildIgnitedDamageBlock(abc, 21, 15);
  const furiousJusticeBlock = buildIgnitedDamageBlock(abc, 22, 10);
  const dynamicProperty = dynamicBuffMultiname(ctx, abc);
  const existingHolyFireString = abc.stringValues.findIndex((candidate) => candidate === "HolyFire1");
  const holyFireStringIndex = existingHolyFireString >= 0 ? existingHolyFireString : abc.stringValues.length;
  const holyFireString = writeU30(holyFireStringIndex);
  const subjugateCelestialBlock = buildBlindOrHolyDamageBlock(abc, dynamicProperty, holyFireString, 23, 15);
  const penanceBlock = buildBlindOrHolyDamageBlock(abc, dynamicProperty, holyFireString, 24, 10);
  const capacityBlock = buildRetributionCapacityBlock(abc);
  const hasHolySmash = damage.code.indexOf(holySmashBlock) >= 0;
  const hasFlameAxe = damage.code.indexOf(flameAxeBlock) >= 0;
  const hasFuriousJustice = damage.code.indexOf(furiousJusticeBlock) >= 0;
  const hasSubjugateCelestial = damage.code.indexOf(subjugateCelestialBlock) >= 0;
  const hasPenance = damage.code.indexOf(penanceBlock) >= 0;
  const hasCapacity = addBuff.code.indexOf(capacityBlock) >= 0;
  if (hasHolySmash && hasFlameAxe && hasFuriousJustice && hasSubjugateCelestial && hasPenance && hasCapacity) {
    syncClientRevision(swfPath, verify);
    console.log(`${swfPath}: Paladin gear rune runtime verified.`);
    return;
  }
  if (verify) throw new PatchError(`${swfPath}: Paladin gear rune runtime patch is missing.`);

  const patches: BytePatch[] = [];
  if (existingHolyFireString < 0) {
    const bytes = Buffer.from("HolyFire1", "utf8");
    patches.push(
      {
        key: "paladinGear.stringCount",
        start: abc.stringCountPos,
        end: abc.stringCountEnd,
        data: writeU30(abc.stringValues.length + 1),
        detail: "Paladin gear HolyFire1 string count",
      },
      {
        key: "paladinGear.holyFireString",
        start: abc.stringPoolEnd,
        end: abc.stringPoolEnd,
        data: Buffer.concat([writeU30(bytes.length), bytes]),
        detail: "Paladin gear HolyFire1 string",
      },
    );
  }
  if (!hasHolySmash || !hasFlameAxe || !hasFuriousJustice || !hasSubjugateCelestial || !hasPenance) {
    let code = damage.code;
    if (!hasHolySmash) {
      const insts = disassemble(code, "CombatState.method_1393 Holy Smash gear damage");
      code = spliceIntoMethod(code, insts, damageAnchor(insts), holySmashBlock, "CombatState.method_1393 Holy Smash gear damage");
    }
    if (!hasFlameAxe) {
      const insts = disassemble(code, "CombatState.method_1393 Flame Axe gear damage");
      code = spliceIntoMethod(code, insts, damageAnchor(insts), flameAxeBlock, "CombatState.method_1393 Flame Axe gear damage");
    }
    if (!hasFuriousJustice) {
      const insts = disassemble(code, "CombatState.method_1393 Furious Assault and Justice Fist gear damage");
      code = spliceIntoMethod(code, insts, damageAnchor(insts), furiousJusticeBlock, "CombatState.method_1393 Furious Assault and Justice Fist gear damage");
    }
    if (!hasSubjugateCelestial) {
      const insts = disassemble(code, "CombatState.method_1393 Subjugate and Celestial Lance gear damage");
      code = spliceIntoMethod(code, insts, damageAnchor(insts), subjugateCelestialBlock, "CombatState.method_1393 Subjugate and Celestial Lance gear damage");
    }
    if (!hasPenance) {
      const insts = disassemble(code, "CombatState.method_1393 Penance gear damage");
      code = spliceIntoMethod(code, insts, damageAnchor(insts), penanceBlock, "CombatState.method_1393 Penance gear damage");
    }
    assertBranchesLand(code, "CombatState.method_1393 Paladin gear damage");
    patches.push(
      { key: "paladinDamage.code", start: damage.body.codeStart, end: damage.body.codeStart + damage.body.codeLen, data: code, detail: "Paladin gear conditional damage" },
      { key: "paladinDamage.codeLen", start: damage.body.codeLenPos, end: damage.body.codeStart, data: writeU30(code.length), detail: "Paladin damage code length" },
    );
  }
  if (!hasCapacity) {
    const anchor = retributionCapacityAnchor(abc, addBuff.insts);
    const code = spliceIntoMethod(addBuff.code, addBuff.insts, anchor, capacityBlock, "CombatState.method_522 Retribution gear capacity");
    assertBranchesLand(code, "CombatState.method_522 Retribution gear capacity");
    patches.push(
      { key: "retributionCapacity.code", start: addBuff.body.codeStart, end: addBuff.body.codeStart + addBuff.body.codeLen, data: code, detail: "Retribution gear maximum hits" },
      { key: "retributionCapacity.codeLen", start: addBuff.body.codeLenPos, end: addBuff.body.codeStart, data: writeU30(code.length), detail: "Retribution capacity code length" },
    );
    const [maxStack] = readU30(ctx.body, addBuff.body.maxStackPos, "CombatState.method_522.max_stack");
    if (maxStack < 10) patches.push({ key: "retributionCapacity.stack", start: addBuff.body.maxStackPos, end: addBuff.body.localCountPos, data: writeU30(10), detail: "Retribution capacity stack" });
  }

  ensureBackup(swfPath);
  const result = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, result.body, result.delta);
  syncClientRevision(swfPath, false);
  console.log(`${swfPath}: patched Paladin gear runtime.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
