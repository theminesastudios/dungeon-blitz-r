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
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const DEFAULT_SWF = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf");
type PatchInstruction = { opcode: number; operands?: Buffer[]; label?: string; branchTo?: string };
type TargetMethod = "FindClosestEnemy" | "CallForHelp";

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") swfPath = path.resolve(argv[++index] || "");
    else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm exec tsx src/server/scripts/patch-dungeonblitz-brain-instanced-aggro-guard.ts [--verify] [--swf <path>]\nRemoves the obsolete instanced-dungeon aggro guards; --verify confirms they are absent.");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify };
}

function s24(value: number): Buffer {
  if (value < -0x800000 || value > 0x7fffff) throw new PatchError(`s24 branch offset out of range: ${value}`);
  const out = Buffer.alloc(3);
  out.writeIntLE(value, 0, 3);
  return out;
}

function assemble(instructions: PatchInstruction[]): Buffer {
  const labels = new Map<string, number>();
  let offset = 0;
  for (const inst of instructions) {
    if (inst.label) labels.set(inst.label, offset);
    if (inst.opcode >= 0) offset += 1 + (inst.branchTo ? 3 : 0) + (inst.operands ?? []).reduce((sum, operand) => sum + operand.length, 0);
  }
  const chunks: Buffer[] = [];
  offset = 0;
  for (const inst of instructions) {
    if (inst.opcode < 0) continue;
    if (inst.branchTo) {
      const target = labels.get(inst.branchTo);
      if (target === undefined) throw new PatchError(`Unknown branch label: ${inst.branchTo}`);
      chunks.push(Buffer.concat([Buffer.from([inst.opcode]), s24(target - (offset + 4))]));
      offset += 4;
    } else {
      const encoded = Buffer.concat([Buffer.from([inst.opcode]), ...(inst.operands ?? [])]);
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

function buildGuard(abc: ReturnType<typeof parseAbc>, methodName: TargetMethod): Buffer {
  const terminal = methodName === "FindClosestEnemy"
    ? [{ opcode: 0x20 }, { opcode: 0x48 }]
    : [{ opcode: 0x47 }];
  return assemble([
    { opcode: 0xd0 },
    { opcode: 0x66, operands: [multiname(abc, "var_1")] },
    { opcode: 0x66, operands: [multiname(abc, "level")] },
    { opcode: 0x2a },
    { opcode: 0x11, branchTo: "hasLevel" },
    { opcode: 0x29 },
    { opcode: 0x10, branchTo: "continue" },
    { opcode: -1, label: "hasLevel" },
    { opcode: 0x66, operands: [multiname(abc, "bInstanced")] },
    { opcode: 0x12, branchTo: "continue" },
    ...terminal,
    { opcode: -1, label: "continue" },
  ]);
}

function restoreSwfAggro(swfPath: string, verify: boolean): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "Brain");
  if (classIndex === null) throw new PatchError("Could not find Brain class.");
  const patches: BytePatch[] = [];
  const guarded: TargetMethod[] = [];

  for (const methodName of ["FindClosestEnemy", "CallForHelp"] as const) {
    const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, methodName);
    if (methodIdx === null) throw new PatchError(`Could not find Brain.${methodName}.`);
    const body = abc.methodBodies.get(methodIdx);
    if (!body) throw new PatchError(`Could not find body for Brain.${methodName}.`);
    if (body.exceptionCount > 0) throw new PatchError(`Brain.${methodName} has an unexpected exception table.`);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const guard = buildGuard(abc, methodName);
    if (!code.subarray(0, guard.length).equals(guard)) continue;
    guarded.push(methodName);
    const restoredCode = code.subarray(guard.length);
    patches.push(
      { key: `Brain.${methodName}.code`, start: body.codeStart, end: body.codeStart + body.codeLen, data: restoredCode, detail: "restore automatic aggro in instanced dungeons" },
      { key: `Brain.${methodName}.codeLen`, start: body.codeLenPos, end: body.codeStart, data: writeU30(restoredCode.length), detail: `update Brain.${methodName} code length` },
    );
  }

  if (guarded.length === 0) {
    console.log(`${swfPath}: verified (instanced Brain aggro guards absent).`);
    return;
  }
  if (verify) throw new PatchError(`${swfPath}: verify failed; obsolete Brain guards present: ${guarded.join(", ")}.`);
  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: restored instanced Brain aggro (${guarded.join(", ")}).`);
}

const { swfPath, verify } = parseArgs(process.argv);
restoreSwfAggro(swfPath, verify);
