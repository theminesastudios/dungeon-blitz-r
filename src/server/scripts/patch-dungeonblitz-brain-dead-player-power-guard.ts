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

type PatchInstruction = { opcode: number; operands?: Buffer[]; label?: string; branchTo?: string };

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
        "  npm exec tsx src/server/scripts/patch-dungeonblitz-brain-dead-player-power-guard.ts [--verify] [--swf <path>]",
        "",
        "Patches Brain.FirePowers so client-owned boss AI cannot fire powers",
        "while the local player is in the revive/dead state.",
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

function instruction(opcode: number, operands: Buffer[] = []): Buffer {
  return Buffer.concat([Buffer.from([opcode]), ...operands]);
}

function getRequiredMultiname(abc: ReturnType<typeof parseAbc>, name: string): number {
  const index = abc.multinameNames.findIndex((candidate) => candidate === name);
  if (index < 0) {
    throw new PatchError(`Multiname ${name} not found.`);
  }
  return index;
}

function assemble(instructions: PatchInstruction[]): Buffer {
  const labels = new Map<string, number>();
  let offset = 0;
  for (const inst of instructions) {
    if (inst.label) {
      labels.set(inst.label, offset);
    }
    if (inst.opcode >= 0) {
      offset += 1 + (inst.branchTo ? 3 : 0) + (inst.operands ?? []).reduce((sum, operand) => sum + operand.length, 0);
    }
  }

  const chunks: Buffer[] = [];
  offset = 0;
  for (const inst of instructions) {
    if (inst.opcode < 0) {
      continue;
    }

    if (inst.branchTo) {
      const target = labels.get(inst.branchTo);
      if (target === undefined) {
        throw new PatchError(`Unknown branch label: ${inst.branchTo}`);
      }
      const size = 4;
      chunks.push(instruction(inst.opcode, [s24(target - (offset + size))]));
      offset += size;
      continue;
    }

    const encoded = instruction(inst.opcode, inst.operands ?? []);
    chunks.push(encoded);
    offset += encoded.length;
  }

  return Buffer.concat(chunks);
}

function getBrainFirePowers(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "Brain");
  if (classIndex === null) {
    throw new PatchError("Could not find Brain class.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "FirePowers");
  if (methodIdx === null) {
    throw new PatchError("Could not find Brain.FirePowers.");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find method body for Brain.FirePowers (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `Brain.FirePowers:${methodIdx}`);
  return { ctx, abc, methodBody, code, instructions };
}

function buildDeadPlayerGuard(abc: ReturnType<typeof parseAbc>): Buffer {
  const var1 = writeU30(getRequiredMultiname(abc, "var_1"));
  const clientEnt = writeU30(getRequiredMultiname(abc, "clientEnt"));
  const entState = writeU30(getRequiredMultiname(abc, "entState"));
  const entity = writeU30(getRequiredMultiname(abc, "Entity"));
  const deadState = writeU30(getRequiredMultiname(abc, "const_6"));

  return assemble([
    { opcode: 0xd0 },
    { opcode: 0x66, operands: [var1] },
    { opcode: 0x66, operands: [clientEnt] },
    { opcode: 0x2a },
    { opcode: 0x11, branchTo: "hasClientEnt" },
    { opcode: 0x29 },
    { opcode: 0x10, branchTo: "continue" },
    { opcode: -1, label: "hasClientEnt" },
    { opcode: 0x66, operands: [entState] },
    { opcode: 0x60, operands: [entity] },
    { opcode: 0x66, operands: [deadState] },
    { opcode: 0xab },
    { opcode: 0x12, branchTo: "continue" },
    { opcode: 0x47 },
    { opcode: -1, label: "continue" },
  ]);
}

function alreadyPatched(abc: ReturnType<typeof parseAbc>, code: Buffer): boolean {
  const instructions = disassemble(code, "Brain.FirePowers.verify");
  return (
    instructions[0]?.opcode === 0xd0 &&
    instructions[1]?.opcode === 0x66 &&
    u30OperandName(instructions[1], abc.multinameNames) === "var_1" &&
    instructions[2]?.opcode === 0x66 &&
    u30OperandName(instructions[2], abc.multinameNames) === "clientEnt" &&
    instructions[3]?.opcode === 0x2a
  );
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, code } = getBrainFirePowers(swfPath);
  if (alreadyPatched(abc, code)) {
    console.log(`${swfPath}: already patched (Brain.FirePowers dead-player guard present).`);
    return;
  }

  if (methodBody.exceptionCount > 0) {
    throw new PatchError(`${swfPath}: Brain.FirePowers has an unexpected exception table.`);
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; Brain.FirePowers dead-player guard is missing.`);
  }

  const guard = buildDeadPlayerGuard(abc);
  const patchedCode = Buffer.concat([guard, code]);
  const [maxStack] = readU30(ctx.body, methodBody.maxStackPos, "Brain.FirePowers.max_stack");
  const patches: BytePatch[] = [
    {
      key: "Brain.FirePowers.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "return before firing NPC powers while local player is dead",
    },
    {
      key: "Brain.FirePowers.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: "update Brain.FirePowers code length",
    },
  ];

  if (maxStack < 2) {
    patches.push({
      key: "Brain.FirePowers.maxStack",
      start: methodBody.maxStackPos,
      end: methodBody.localCountPos,
      data: writeU30(2),
      detail: "raise Brain.FirePowers max_stack for dead-player guard",
    });
  }

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: patched Brain.FirePowers dead-player guard.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
