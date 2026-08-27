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
  writeU30,
  writeSwf,
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

type Label = "normal" | "legendaryCritical" | "criticalDivisor" | "checkLegendary" | "zero";

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
    } else if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { swfPath, verify };
}

function s24(value: number): Buffer {
  const out = Buffer.alloc(3);
  out.writeIntLE(value, 0, 3);
  return out;
}

function findMultiname(abc: ReturnType<typeof parseAbc>, name: string): number {
  const index = abc.multinameNames.findIndex((entry) => entry === name);
  if (index < 0) {
    throw new PatchError(`Could not find multiname ${name}.`);
  }
  return index;
}

function findDouble(abc: ReturnType<typeof parseAbc>, value: number): number {
  const index = abc.doubleValues.findIndex((entry) => entry === value);
  if (index < 0) {
    throw new PatchError(`Could not find double constant ${value}.`);
  }
  return index;
}

function buildMethodCode(abc: ReturnType<typeof parseAbc>): Buffer {
  const secondary = findMultiname(abc, "secondary");
  const tier = findMultiname(abc, "var_8");
  const primaryLevel = findMultiname(abc, "method_2020");
  const doubleZero = findDouble(abc, 0);
  const doubleHalf = findDouble(abc, 0.5);
  const doubleOne = findDouble(abc, 1);

  const chunks: Buffer[] = [];
  const labels = new Map<Label, number>();
  const branches: Array<{ operandOffset: number; label: Label }> = [];
  let offset = 0;

  const emit = (data: Buffer): void => {
    chunks.push(data);
    offset += data.length;
  };
  const op = (opcode: number, ...operands: Buffer[]): void => emit(Buffer.concat([Buffer.from([opcode]), ...operands]));
  const branch = (opcode: number, label: Label): void => {
    op(opcode, Buffer.alloc(3));
    branches.push({ operandOffset: offset - 3, label });
  };
  const mark = (label: Label): void => {
    labels.set(label, offset);
  };

  op(0xd0); // getlocal0
  op(0x30); // pushscope

  // Critical Chance is secondary type 2. Its forged rarity bonus is flat:
  // Rare = 0.5% (5 / primary level), Legendary = 1% (10 / primary level).
  op(0xd0);
  op(0x66, writeU30(secondary));
  op(0x24, Buffer.from([2]));
  branch(0x14, "normal"); // ifne
  op(0xd0);
  op(0x66, writeU30(tier));
  branch(0x12, "normal"); // iffalse
  op(0xd0);
  op(0x66, writeU30(tier));
  op(0x24, Buffer.from([1]));
  branch(0x14, "legendaryCritical");
  op(0x24, Buffer.from([5]));
  branch(0x10, "criticalDivisor");
  mark("legendaryCritical");
  op(0x24, Buffer.from([10]));
  mark("criticalDivisor");
  op(0xd0);
  op(0x46, writeU30(primaryLevel), writeU30(0));
  op(0xa3); // divide
  op(0x48); // returnvalue

  mark("normal");
  op(0xd0);
  op(0x66, writeU30(tier));
  op(0x24, Buffer.from([1]));
  branch(0x14, "checkLegendary");
  op(0x2f, writeU30(doubleHalf));
  op(0x48);
  mark("checkLegendary");
  op(0xd0);
  op(0x66, writeU30(tier));
  op(0x24, Buffer.from([2]));
  branch(0x14, "zero");
  op(0x2f, writeU30(doubleOne));
  op(0x48);
  mark("zero");
  op(0x2f, writeU30(doubleZero));
  op(0x48);

  const code = Buffer.concat(chunks);
  for (const fixup of branches) {
    const target = labels.get(fixup.label);
    if (target === undefined) {
      throw new PatchError(`Missing branch label ${fixup.label}.`);
    }
    s24(target - (fixup.operandOffset + 3)).copy(code, fixup.operandOffset);
  }
  return code;
}

function findMethod(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "class_64");
  if (classIndex === null) {
    throw new PatchError("Could not find class_64.");
  }
  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_421");
  if (methodIdx === null) {
    throw new PatchError("Could not find class_64.method_421.");
  }
  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError("Could not find class_64.method_421 body.");
  }
  return { ctx, abc, methodBody };
}

function isPatched(swfPath: string): boolean {
  const { ctx, abc, methodBody } = findMethod(swfPath);
  const expected = buildMethodCode(abc);
  const actual = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  return actual.equals(expected);
}

export function patchForgedCharmCriticalChance(swfPath: string, verifyOnly = false): void {
  if (isPatched(swfPath)) {
    console.log(`Forged charm critical-chance rarity scaling verified in ${swfPath}`);
    return;
  }
  if (verifyOnly) {
    throw new PatchError("Forged charm critical-chance rarity scaling is not patched.");
  }

  const { ctx, abc, methodBody } = findMethod(swfPath);
  const code = buildMethodCode(abc);
  const oldCodeLenBytes = writeU30(methodBody.codeLen);
  const patches: BytePatch[] = [
    {
      key: "class_64.method_421.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: code,
      detail: "normalize forged Critical Chance secondary to 0.5% Rare / 1% Legendary",
    },
    {
      key: "class_64.method_421.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeLenPos + oldCodeLenBytes.length,
      data: writeU30(code.length),
      detail: `class_64.method_421 code_length ${methodBody.codeLen} -> ${code.length}`,
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  if (!isPatched(swfPath)) {
    throw new PatchError("Forged charm critical-chance rarity scaling verification failed after patching.");
  }
  console.log(`Patched forged charm critical-chance rarity scaling in ${swfPath}`);
}

if (require.main === module) {
  const { swfPath, verify } = parseArgs(process.argv);
  patchForgedCharmCriticalChance(swfPath, verify);
}
