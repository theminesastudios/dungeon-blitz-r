import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  ensureBackup,
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

type PatchInstruction = { opcode: number; operands?: Buffer[]; label?: string; branchTo?: string };

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

function instruction(opcode: number, operands: Buffer[] = []): Buffer {
  return Buffer.concat([Buffer.from([opcode]), ...operands]);
}

function assemble(instructions: PatchInstruction[]): Buffer {
  const labels = new Map<string, number>();
  let offset = 0;
  for (const item of instructions) {
    if (item.label) labels.set(item.label, offset);
    if (item.opcode >= 0) offset += 1 + (item.branchTo ? 3 : 0) + (item.operands ?? []).reduce((sum, operand) => sum + operand.length, 0);
  }

  const chunks: Buffer[] = [];
  offset = 0;
  for (const item of instructions) {
    if (item.opcode < 0) continue;
    if (item.branchTo) {
      const target = labels.get(item.branchTo);
      if (target === undefined) throw new PatchError(`Unknown branch label: ${item.branchTo}`);
      chunks.push(instruction(item.opcode, [s24(target - (offset + 4))]));
      offset += 4;
      continue;
    }
    const encoded = instruction(item.opcode, item.operands ?? []);
    chunks.push(encoded);
    offset += encoded.length;
  }
  return Buffer.concat(chunks);
}

function requiredMultiname(abc: ReturnType<typeof parseAbc>, name: string): Buffer {
  const index = abc.multinameNames.findIndex((candidate) => candidate === name);
  if (index < 0) throw new PatchError(`Multiname ${name} not found.`);
  return writeU30(index);
}

function requiredString(abc: ReturnType<typeof parseAbc>, value: string): Buffer {
  const index = abc.stringValues.findIndex((candidate) => candidate === value);
  if (index < 0) throw new PatchError(`String ${value} not found.`);
  return writeU30(index);
}

function getMethod(
  abc: ReturnType<typeof parseAbc>,
  ctx: ReturnType<typeof parseSwf>,
  classIndex: number,
  methodName: string,
) {
  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, methodName);
  if (methodIdx === null) throw new PatchError(`ActivePower.${methodName} not found.`);
  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) throw new PatchError(`ActivePower.${methodName} body ${methodIdx} not found.`);
  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  return { methodBody, code };
}

function getMethods(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "ActivePower");
  if (classIndex === null) throw new PatchError("ActivePower class not found.");
  return {
    ctx,
    abc,
    targetGather: getMethod(abc, ctx, classIndex, "method_921"),
    fire: getMethod(abc, ctx, classIndex, "method_872"),
  };
}

function buildRadiusGuard(abc: ReturnType<typeof parseAbc>, includeCurrentModifiers: boolean): Buffer {
  const powerType = requiredMultiname(abc, "powerType");
  const basePowerName = requiredMultiname(abc, "basePowerName");
  const var4 = requiredMultiname(abc, "var_4");
  const magicDamage = requiredMultiname(abc, "magicDamage");
  const aoeRadius = requiredMultiname(abc, "aoeRadius");
  const darkChi = requiredString(abc, "DarkChi");
  const falseChi = requiredString(abc, "FalseChi");

  const calculation: PatchInstruction[] = includeCurrentModifiers
    ? [
        { opcode: 0xd0 },
        { opcode: 0x66, operands: [var4] },
        { opcode: 0x66, operands: [magicDamage] },
        { opcode: 0xd0 },
        { opcode: 0x66, operands: [var4] },
        { opcode: 0x66, operands: [requiredMultiname(abc, "combatState")] },
        { opcode: 0x66, operands: [requiredMultiname(abc, "var_288")] },
        { opcode: 0x24, operands: [Buffer.from([1])] },
        { opcode: 0xa0 },
        { opcode: 0xd0 },
        { opcode: 0x66, operands: [var4] },
        { opcode: 0x66, operands: [requiredMultiname(abc, "totalMods")] },
        { opcode: 0x66, operands: [magicDamage] },
        { opcode: 0xa0 },
        { opcode: 0xa2 },
      ]
    : [
        { opcode: 0xd0 },
        { opcode: 0x66, operands: [var4] },
        { opcode: 0x66, operands: [magicDamage] },
      ];

  return assemble([
    { opcode: 0xd0 },
    { opcode: 0x66, operands: [powerType] },
    { opcode: 0x66, operands: [basePowerName] },
    { opcode: 0x2c, operands: [darkChi] },
    { opcode: 0xab },
    { opcode: 0x11, branchTo: "apply" },
    { opcode: 0xd0 },
    { opcode: 0x66, operands: [powerType] },
    { opcode: 0x66, operands: [basePowerName] },
    { opcode: 0x2c, operands: [falseChi] },
    { opcode: 0xab },
    { opcode: 0x12, branchTo: "continue" },
    { opcode: -1, label: "apply" },
    { opcode: 0xd0 },
    { opcode: 0x66, operands: [powerType] },
    { opcode: 0x24, operands: [Buffer.from([50])] },
    ...calculation,
    { opcode: 0x24, operands: [Buffer.from([5])] },
    { opcode: 0xa2 },
    { opcode: 0x24, operands: [Buffer.from([100])] },
    { opcode: 0xa3 },
    { opcode: 0xa0 },
    { opcode: 0x74 },
    { opcode: 0x61, operands: [aoeRadius] },
    { opcode: -1, label: "continue" },
  ]);
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, abc, targetGather, fire } = getMethods(swfPath);
  const guard = buildRadiusGuard(abc, true);
  const legacyGuard = buildRadiusGuard(abc, false);
  const fireHasGuard = fire.code.subarray(0, guard.length).equals(guard);
  const gatherGuardLength = targetGather.code.subarray(0, guard.length).equals(guard)
    ? guard.length
    : targetGather.code.subarray(0, legacyGuard.length).equals(legacyGuard)
      ? legacyGuard.length
      : 0;

  if (fireHasGuard && gatherGuardLength === 0) {
    console.log(`${swfPath}: Dark Chi Expertise AoE scaling verified.`);
    return;
  }
  if (verify) throw new PatchError(`${swfPath}: Dark Chi Expertise AoE scaling is missing.`);
  if (fire.methodBody.exceptionCount > 0) throw new PatchError("ActivePower.method_872 has an unexpected exception table.");
  if (targetGather.methodBody.exceptionCount > 0) throw new PatchError("ActivePower.method_921 has an unexpected exception table.");

  const patchedFireCode = fireHasGuard ? fire.code : Buffer.concat([guard, fire.code]);
  const patchedGatherCode = gatherGuardLength ? targetGather.code.subarray(gatherGuardLength) : targetGather.code;
  const [fireMaxStack] = readU30(ctx.body, fire.methodBody.maxStackPos, "ActivePower.method_872.max_stack");
  const patches: BytePatch[] = [];

  if (!fireHasGuard) patches.push(
    {
      key: "ActivePower.method_872.code",
      start: fire.methodBody.codeStart,
      end: fire.methodBody.codeStart + fire.methodBody.codeLen,
      data: patchedFireCode,
      detail: "set Dark Chi projectile radius to 50 + 5% of caster Expertise",
    },
    {
      key: "ActivePower.method_872.codeLen",
      start: fire.methodBody.codeLenPos,
      end: fire.methodBody.codeStart,
      data: writeU30(patchedFireCode.length),
      detail: "update ActivePower.method_872 code length",
    },
  );
  if (!fireHasGuard && fireMaxStack < 5) {
    patches.push({
      key: "ActivePower.method_872.maxStack",
      start: fire.methodBody.maxStackPos,
      end: fire.methodBody.localCountPos,
      data: writeU30(5),
      detail: "raise stack depth for Dark Chi radius calculation",
    });
  }
  if (gatherGuardLength) patches.push(
    {
      key: "ActivePower.method_921.code",
      start: targetGather.methodBody.codeStart,
      end: targetGather.methodBody.codeStart + targetGather.methodBody.codeLen,
      data: patchedGatherCode,
      detail: "remove unreachable Dark Chi projectile radius patch",
    },
    {
      key: "ActivePower.method_921.codeLen",
      start: targetGather.methodBody.codeLenPos,
      end: targetGather.methodBody.codeStart,
      data: writeU30(patchedGatherCode.length),
      detail: "update ActivePower.method_921 code length",
    },
  );

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: patched Dark Chi projectile radius to 50 + 5% of caster Expertise.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
