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

type Args = {
  swfPath: string;
  verify: boolean;
};

type Piece = Buffer | { label: string } | { opcode: number; target: string };

function parseArgs(argv: string[]): Args {
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
        "  npx ts-node src/server/scripts/patch-dungeonblitz-char-regen-damage.ts [--verify] [--swf <path>]",
        "",
        "Patches LinkUpdater.method_1813 so negative PKTTYPE_CHAR_REGEN values apply damage.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function s24(value: number): Buffer {
  if (value < -0x800000 || value > 0x7fffff) {
    throw new PatchError(`s24 branch offset out of range: ${value}`);
  }
  const out = Buffer.alloc(3);
  out.writeIntLE(value, 0, 3);
  return out;
}

function op(opcode: number, ...operands: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([opcode]), ...operands]);
}

function pushByte(value: number): Buffer {
  return op(0x24, Buffer.from([value & 0xff]));
}

function getLocal(index: number): Buffer {
  if (index >= 0 && index <= 3) {
    return op(0xd0 + index);
  }
  return op(0x62, writeU30(index));
}

function setLocal(index: number): Buffer {
  if (index >= 0 && index <= 3) {
    return op(0xd4 + index);
  }
  return op(0x63, writeU30(index));
}

function getProperty(index: number): Buffer {
  return op(0x66, writeU30(index));
}

function coerce(index: number): Buffer {
  return op(0x80, writeU30(index));
}

function callProperty(index: number, argCount: number): Buffer {
  return op(0x46, writeU30(index), writeU30(argCount));
}

function callPropVoid(index: number, argCount: number): Buffer {
  return op(0x4f, writeU30(index), writeU30(argCount));
}

function branch(opcode: number, target: string): { opcode: number; target: string } {
  return { opcode, target };
}

function label(name: string): { label: string } {
  return { label: name };
}

function assemble(pieces: Piece[]): Buffer {
  let offset = 0;
  const labels = new Map<string, number>();
  for (const piece of pieces) {
    if (Buffer.isBuffer(piece)) {
      offset += piece.length;
      continue;
    }
    if ("label" in piece) {
      labels.set(piece.label, offset);
      continue;
    }
    offset += 4;
  }

  offset = 0;
  const out: Buffer[] = [];
  for (const piece of pieces) {
    if (Buffer.isBuffer(piece)) {
      out.push(piece);
      offset += piece.length;
      continue;
    }
    if ("label" in piece) {
      continue;
    }

    const target = labels.get(piece.target);
    if (target === undefined) {
      throw new PatchError(`Unknown branch target ${piece.target}.`);
    }
    out.push(op(piece.opcode, s24(target - (offset + 4))));
    offset += 4;
  }

  return Buffer.concat(out);
}

function requiredMultiname(abc: ReturnType<typeof parseAbc>, name: string): number {
  const index = abc.multinameNames.findIndex((candidate) => candidate === name);
  if (index < 0) {
    throw new PatchError(`Could not find multiname ${name}.`);
  }
  return index;
}

function getLinkUpdaterCharRegen(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "LinkUpdater");
  if (classIndex === null) {
    throw new PatchError("Could not find LinkUpdater class.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1813");
  if (methodIdx === null) {
    throw new PatchError("Could not find LinkUpdater.method_1813.");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find method body for LinkUpdater.method_1813 (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  return { ctx, abc, methodBody, code };
}

function hasNegativeCharRegenDamageBranch(
  abc: ReturnType<typeof parseAbc>,
  instructions: Instruction[],
): boolean {
  return instructions.some((inst) => {
    return inst.opcode === 0x4f && u30OperandName(inst, abc.multinameNames) === "TakeDamage";
  });
}

function buildPatchedCharRegen(abc: ReturnType<typeof parseAbc>): Buffer {
  const method4 = requiredMultiname(abc, "method_4");
  const method45 = requiredMultiname(abc, "method_45");
  const var1 = requiredMultiname(abc, "var_1");
  const getEntFromId = requiredMultiname(abc, "GetEntFromID");
  const entity = requiredMultiname(abc, "Entity");
  const takeDamage = requiredMultiname(abc, "TakeDamage");
  const method3000 = requiredMultiname(abc, "method_3000");

  return assemble([
    getLocal(1),
    callProperty(method4, 0),
    op(0x74),
    setLocal(2),

    getLocal(1),
    callProperty(method45, 0),
    op(0x73),
    setLocal(3),

    getLocal(0),
    getProperty(var1),
    getLocal(2),
    callProperty(getEntFromId, 1),
    coerce(entity),
    setLocal(4),

    getLocal(4),
    branch(0x12, "end"),

    getLocal(3),
    pushByte(0),
    branch(0x18, "heal"),

    getLocal(4),
    pushByte(0),
    getLocal(3),
    op(0xa1),
    op(0x27),
    callPropVoid(takeDamage, 2),
    branch(0x10, "end"),

    label("heal"),
    getLocal(0),
    getLocal(4),
    getLocal(3),
    op(0x27),
    callPropVoid(method3000, 3),

    label("end"),
    op(0x47),
  ]);
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, code } = getLinkUpdaterCharRegen(swfPath);
  if (methodBody.exceptionCount !== 0) {
    throw new PatchError("LinkUpdater.method_1813 has an exception table; update this patch before replacing code.");
  }

  const instructions = disassemble(code, "LinkUpdater.method_1813");
  if (hasNegativeCharRegenDamageBranch(abc, instructions)) {
    console.log(`${swfPath}: already patched (negative PKTTYPE_CHAR_REGEN applies damage).`);
    return;
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; negative PKTTYPE_CHAR_REGEN damage branch is missing.`);
  }

  const patchedCode = buildPatchedCharRegen(abc);
  const patches: BytePatch[] = [
    {
      key: "LinkUpdater.method_1813.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "apply negative PKTTYPE_CHAR_REGEN values as damage",
    },
    {
      key: "LinkUpdater.method_1813.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: "update LinkUpdater.method_1813 code length",
    },
  ];

  const [maxStack] = readU30(ctx.body, methodBody.maxStackPos, "LinkUpdater.method_1813.max_stack");
  if (maxStack < 4) {
    patches.push({
      key: "LinkUpdater.method_1813.maxStack",
      start: methodBody.maxStackPos,
      end: methodBody.localCountPos,
      data: writeU30(4),
      detail: "allow negative CHAR_REGEN damage branch stack",
    });
  }

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);

  const verifyPass = getLinkUpdaterCharRegen(swfPath);
  if (!hasNegativeCharRegenDamageBranch(verifyPass.abc, disassemble(verifyPass.code, "LinkUpdater.method_1813"))) {
    throw new PatchError(`${swfPath}: post-patch verification failed.`);
  }

  console.log(`${swfPath}: patched negative PKTTYPE_CHAR_REGEN damage handling.`);
}

if (require.main === module) {
  const { swfPath, verify } = parseArgs(process.argv);
  patchSwf(swfPath, verify);
}
