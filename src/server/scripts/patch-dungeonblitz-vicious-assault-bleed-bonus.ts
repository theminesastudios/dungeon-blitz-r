import * as crypto from "crypto";
import * as fs from "fs";
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
  readU30,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

/**
 * Adds Vicious Assault's Bleed-stack damage directly to CombatState.method_1393.
 *
 * The old source-import patch recompiled the whole CombatState class, which changed unrelated
 * AVM2 and destabilized the five-hit cast. This patch only inserts one self-contained bytecode
 * block immediately before the method's final flat-damage calculation. It reads the target's
 * real Bleeding Buff stack count via method_135(...).method_351(), then adds:
 *
 *   ranks 0-2: 0
 *   ranks 3-6: 0.01 per stack
 *   ranks 7-9: 0.015 per stack
 *   rank 10:   0.02 per stack
 *
 * No ActivePower or cast-sequencing bytecode is touched.
 */

const DEFAULT_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf",
);
const INDEX_HTML = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "index.html");

type PatchInstruction = { opcode?: number; operands?: Buffer[]; label?: string; branchTo?: string };

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") swfPath = path.resolve(argv[++index] || "");
    else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else throw new PatchError(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify };
}

function s24(value: number): Buffer {
  const out = Buffer.alloc(3);
  out.writeIntLE(value, 0, 3);
  return out;
}

function assemble(program: PatchInstruction[]): Buffer {
  const labels = new Map<string, number>();
  let offset = 0;
  for (const item of program) {
    if (item.label) labels.set(item.label, offset);
    if (item.opcode !== undefined) {
      offset += 1 + (item.branchTo ? 3 : 0) + (item.operands ?? []).reduce((sum, operand) => sum + operand.length, 0);
    }
  }

  const chunks: Buffer[] = [];
  offset = 0;
  for (const item of program) {
    if (item.opcode === undefined) continue;
    const operands = item.branchTo
      ? [s24((labels.get(item.branchTo) ?? (() => { throw new PatchError(`Unknown label ${item.branchTo}`); })()) - (offset + 4))]
      : item.operands ?? [];
    const encoded = Buffer.concat([Buffer.from([item.opcode]), ...operands]);
    chunks.push(encoded);
    offset += encoded.length;
  }
  return Buffer.concat(chunks);
}

function requiredPoolIndex(values: Array<string | number>, value: string | number, label: string): number {
  const index = values.indexOf(value);
  if (index < 0) throw new PatchError(`${label} ${value} is missing from the ABC constant pool.`);
  return index;
}

function findRuntimeDictionaryPropertyMultiname(
  ctx: ReturnType<typeof parseSwf>,
  abc: ReturnType<typeof parseAbc>,
): number {
  const stockRuntimeMultiname = 53;
  const class14 = requiredPoolIndex(abc.multinameNames, "class_14", "Multiname");
  const buffTypesDict = requiredPoolIndex(abc.multinameNames, "buffTypesDict", "Multiname");
  const method135 = requiredPoolIndex(abc.multinameNames, "method_135", "Multiname");
  for (const body of abc.methodBodies.values()) {
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    let instructions;
    try { instructions = disassemble(code, "runtime dictionary multiname lookup"); } catch { continue; }
    for (let index = 0; index < instructions.length - 3; index += 1) {
      const window = instructions.slice(index, index + 4);
      if (
        window[0].opcode === 0x60 && window[0].operands[0]?.[1] === class14 &&
        window[1].opcode === 0x66 && window[1].operands[0]?.[1] === buffTypesDict &&
        window[2].opcode === 0x2c && window[3].opcode === 0x66 && window[3].operands[0]?.[1] === stockRuntimeMultiname &&
        instructions.slice(index + 4, index + 10).some((instruction) =>
          instruction.opcode === 0x46 && instruction.operands[0]?.[1] === method135)
      ) return stockRuntimeMultiname;
    }
  }
  throw new PatchError("The stock runtime property multiname for class_14.buffTypesDict could not be validated.");
}

function buildBonusBlock(abc: ReturnType<typeof parseAbc>, runtimePropertyIndex: number): Buffer {
  const mn = (name: string) => writeU30(requiredPoolIndex(abc.multinameNames, name, "Multiname"));
  const str = (value: string) => writeU30(requiredPoolIndex(abc.stringValues, value, "String"));
  const dbl = (value: number) => writeU30(requiredPoolIndex(abc.doubleValues, value, "Double"));
  const runtimeProperty = writeU30(runtimePropertyIndex);

  return assemble([
    { opcode: 0xd2 }, // getlocal2: PowerType
    { opcode: 0x66, operands: [mn("basePowerName")] },
    { opcode: 0x2c, operands: [str("AssassinateClose")] },
    { opcode: 0x14, branchTo: "done" }, // ifne
    { opcode: 0xd2 },
    { opcode: 0x66, operands: [mn("var_7")] },
    { opcode: 0x24, operands: [Buffer.from([3])] },
    { opcode: 0x15, branchTo: "done" }, // iflt: ranks 0-2

    { opcode: 0x62, operands: [writeU30(5)] }, // target CombatState
    { opcode: 0x60, operands: [mn("class_14")] },
    { opcode: 0x66, operands: [mn("buffTypesDict")] },
    { opcode: 0x2c, operands: [str("Bleeding")] },
    { opcode: 0x66, operands: [runtimeProperty] },
    { opcode: 0x46, operands: [mn("method_135"), writeU30(1)] },
    { opcode: 0x63, operands: [writeU30(37)] }, // last scratch local, no later reads
    { opcode: 0x62, operands: [writeU30(37)] },
    { opcode: 0x12, branchTo: "done" }, // no Bleeding buff

    { opcode: 0xd2 },
    { opcode: 0x66, operands: [mn("var_7")] },
    { opcode: 0x24, operands: [Buffer.from([10])] },
    { opcode: 0x15, branchTo: "below10" },
    { opcode: 0x2f, operands: [dbl(0.02)] },
    { opcode: 0x10, branchTo: "apply" },
    { label: "below10" },
    { opcode: 0xd2 },
    { opcode: 0x66, operands: [mn("var_7")] },
    { opcode: 0x24, operands: [Buffer.from([7])] },
    { opcode: 0x15, branchTo: "below7" },
    { opcode: 0x2f, operands: [dbl(0.015)] },
    { opcode: 0x10, branchTo: "apply" },
    { label: "below7" },
    { opcode: 0x2f, operands: [dbl(0.01)] },

    { label: "apply" },
    { opcode: 0x62, operands: [writeU30(37)] },
    { opcode: 0x46, operands: [mn("method_351"), writeU30(0)] },
    { opcode: 0xa2 }, // multiply rate * Bleed stacks
    { opcode: 0x62, operands: [writeU30(6)] },
    { opcode: 0xa0 }, // add to the damage multiplier
    { opcode: 0x75 }, // convert_d
    { opcode: 0x63, operands: [writeU30(6)] },
    { label: "done" },
  ]);
}

function findInsertionOffset(code: Buffer): number {
  const instructions = disassemble(code, "CombatState.method_1393");
  for (let index = instructions.length - 9; index >= 0; index -= 1) {
    const window = instructions.slice(index, index + 9);
    if (
      window[0]?.opcode === 0x62 && window[0].operands[0]?.[1] === 6 &&
      window[1]?.opcode === 0x62 && window[1].operands[0]?.[1] === 7 &&
      window[2]?.opcode === 0xd1 && window[3]?.opcode === 0xa3 &&
      window[4]?.opcode === 0xa0 && window[5]?.opcode === 0x75 &&
      window[6]?.opcode === 0x63 && window[6].operands[0]?.[1] === 6
    ) return window[0].offset;
  }
  throw new PatchError("CombatState.method_1393 final flat-damage anchor not found.");
}

function syncClientRevision(swfPath: string, verifyOnly: boolean): void {
  if (path.resolve(swfPath) !== path.resolve(DEFAULT_SWF)) return;
  const digest = crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
  const expected = `clientrev=swf-${digest}`;
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  if (html.includes(expected)) return;
  if (verifyOnly) throw new PatchError(`index.html is missing ${expected}.`);
  const updated = html.replace(/clientrev=[^&`"'$]+/, expected);
  if (updated === html) throw new PatchError("index.html clientrev token not found.");
  fs.writeFileSync(INDEX_HTML, updated, "utf8");
}

export function patchViciousAssaultBleedBonus(swfPath: string, verifyOnly = false): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "CombatState");
  if (classIndex === null) throw new PatchError("CombatState class not found.");
  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1393");
  if (methodIdx === null) throw new PatchError("CombatState.method_1393 not found.");
  const body = abc.methodBodies.get(methodIdx);
  if (!body) throw new PatchError("CombatState.method_1393 body not found.");
  if (body.exceptionCount !== 0) throw new PatchError("CombatState.method_1393 has an unexpected exception table.");

  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  const block = buildBonusBlock(abc, findRuntimeDictionaryPropertyMultiname(ctx, abc));
  const insertAt = findInsertionOffset(code);
  const alreadyPatched = insertAt >= block.length && code.subarray(insertAt - block.length, insertAt).equals(block);
  if (alreadyPatched) {
    syncClientRevision(swfPath, verifyOnly);
    console.log(`Verified Vicious Assault Bleed-stack bonus in ${swfPath}`);
    return;
  }
  if (verifyOnly) throw new PatchError(`${swfPath}: Vicious Assault Bleed-stack bonus is missing.`);

  // The stock branches crossing this point both target the anchor itself. Leaving their s24
  // operands unchanged makes every path enter the new block; all other branches are wholly
  // before or after the insertion and retain their relative offsets.
  const crossings = disassemble(code, "CombatState.method_1393").filter((instruction) => {
    const operand = instruction.operands[0];
    if (operand?.[0] !== "s24" || instruction.opcode === 0x1b) return false;
    const target = instruction.offset + instruction.size + operand[1];
    return (instruction.offset < insertAt && target >= insertAt) || (instruction.offset >= insertAt && target < insertAt);
  });
  if (crossings.length !== 2 || crossings.some((instruction) => instruction.offset + instruction.size + instruction.operands[0][1] !== insertAt)) {
    throw new PatchError(`Unexpected control flow across Vicious Assault insertion point (${crossings.length} crossing branches).`);
  }

  const [maxStack] = readU30(ctx.body, body.maxStackPos, "CombatState.method_1393.max_stack");
  const patchedCode = Buffer.concat([code.subarray(0, insertAt), block, code.subarray(insertAt)]);
  const patches: BytePatch[] = [
    {
      key: "CombatState.method_1393.code",
      start: body.codeStart,
      end: body.codeStart + body.codeLen,
      data: patchedCode,
      detail: "add rank-scaled Vicious Assault damage per target Bleed stack",
    },
    {
      key: "CombatState.method_1393.codeLen",
      start: body.codeLenPos,
      end: body.codeStart,
      data: writeU30(patchedCode.length),
      detail: `update method code length ${body.codeLen} -> ${patchedCode.length}`,
    },
  ];
  if (maxStack < 4) {
    patches.push({
      key: "CombatState.method_1393.maxStack",
      start: body.maxStackPos,
      end: body.localCountPos,
      data: writeU30(4),
      detail: "raise max stack for Vicious Assault bonus block",
    });
  }

  ensureBackup(swfPath);
  const patched = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, patched.body, patched.delta);
  syncClientRevision(swfPath, false);

  // Reparse and byte-verify the written file rather than trusting the in-memory patch.
  patchViciousAssaultBleedBonus(swfPath, true);
  console.log(`Patched Vicious Assault Bleed-stack bonus in ${swfPath}`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchViciousAssaultBleedBonus(swfPath, verify);
