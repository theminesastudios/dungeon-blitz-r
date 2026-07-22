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
        "  npx ts-node src/server/scripts/patch-dungeonblitz-demon-maligner-passive-regen.ts [--verify] [--swf <path>]",
        "",
        "Prevents the Embodiment of Evil boss from using the client's generic",
        "out-of-combat NPC regeneration while it is alive.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function op(opcode: number, ...operands: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([opcode]), ...operands]);
}

function requiredString(abc: ReturnType<typeof parseAbc>, value: string): number {
  const matches = abc.stringValues
    .map((candidate, index) => candidate === value ? index : -1)
    .filter((index) => index >= 0);
  if (matches.length !== 1) {
    throw new PatchError(`Expected one string constant ${value}, found ${matches.length}.`);
  }
  return matches[0];
}

function operandForNamedInstruction(
  abc: ReturnType<typeof parseAbc>,
  instructions: Instruction[],
  opcode: number,
  name: string,
): number {
  const matches = instructions
    .filter((inst) => inst.opcode === opcode && abc.multinameNames[inst.operands[0]?.[1]] === name)
    .map((inst) => inst.operands[0][1]);
  const unique = [...new Set(matches)];
  if (unique.length !== 1) {
    throw new PatchError(`Expected one ${name} operand in CombatState, found ${unique.length}.`);
  }
  return unique[0];
}

function mostUsedCallOperand(abc: ReturnType<typeof parseAbc>, ctx: ReturnType<typeof parseSwf>, name: string): number {
  const counts = new Map<number, number>();
  for (const methodBody of abc.methodBodies.values()) {
    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    let instructions: Instruction[];
    try {
      instructions = disassemble(code, `method ${methodBody.methodIdx}`);
    } catch {
      continue;
    }
    for (const inst of instructions) {
      if (
        (inst.opcode === 0x46 || inst.opcode === 0x4f) &&
        abc.multinameNames[inst.operands[0]?.[1]] === name
      ) {
        const operand = inst.operands[0][1];
        counts.set(operand, (counts.get(operand) ?? 0) + 1);
      }
    }
  }

  const ranked = [...counts.entries()].sort((left, right) => right[1] - left[1]);
  if (ranked.length === 0 || (ranked[1] && ranked[0][1] === ranked[1][1])) {
    throw new PatchError(`Could not resolve the public ${name} call operand.`);
  }
  return ranked[0][0];
}

function getCombatStateRegenGate(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "CombatState");
  if (classIndex === null) {
    throw new PatchError("Could not find CombatState class.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1553");
  if (methodIdx === null) {
    throw new PatchError("Could not find CombatState.method_1553.");
  }
  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find method body for CombatState.method_1553 (${methodIdx}).`);
  }
  if (methodBody.exceptionCount !== 0) {
    throw new PatchError("CombatState.method_1553 has an exception table; update this patch before inserting code.");
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, "CombatState.method_1553");
  return { ctx, abc, classIndex, methodBody, code, instructions };
}

function buildGuard(swfPath: string) {
  const state = getCombatStateRegenGate(swfPath);
  const { ctx, abc, classIndex, instructions } = state;
  const var3 = operandForNamedInstruction(abc, instructions, 0x66, "var_3");

  const combatStateInstructions: Instruction[] = [];
  for (const trait of abc.instances[classIndex].traits) {
    const methodBody = abc.methodBodies.get(trait.methodIdx ?? -1);
    if (!methodBody) {
      continue;
    }
    const methodCode = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    try {
      combatStateInstructions.push(...disassemble(methodCode, "CombatState"));
    } catch {
      continue;
    }
  }

  const entType = operandForNamedInstruction(abc, combatStateInstructions, 0x66, "entType");
  const entName = operandForNamedInstruction(abc, combatStateInstructions, 0x66, "entName");
  const indexOf = mostUsedCallOperand(abc, ctx, "indexOf");
  const demonMaligner = requiredString(abc, "DemonMaligner");

  // if (this.var_3.entType.entName.indexOf("DemonMaligner") == 0) return false;
  // Prefix matching also covers DemonMalignerHard without touching Spirit/Greater variants.
  const guard = Buffer.concat([
    op(0xd0),
    op(0x66, writeU30(var3)),
    op(0x66, writeU30(entType)),
    op(0x66, writeU30(entName)),
    op(0x2c, writeU30(demonMaligner)),
    op(0x46, writeU30(indexOf), writeU30(1)),
    op(0x24, Buffer.from([0x00])),
    op(0x14, Buffer.from([0x02, 0x00, 0x00])),
    op(0x27),
    op(0x48),
  ]);

  return { ...state, guard };
}

function hasGuard(code: Buffer, guard: Buffer): boolean {
  return code.length >= guard.length && code.subarray(0, guard.length).equals(guard);
}

export function patchDemonMalignerPassiveRegen(swfPath: string, verifyOnly = false): void {
  const firstPass = buildGuard(swfPath);
  if (hasGuard(firstPass.code, firstPass.guard)) {
    console.log(`${swfPath}: verified Embodiment of Evil passive regen guard.`);
    return;
  }
  if (verifyOnly) {
    throw new PatchError(`${swfPath}: verify failed; Embodiment of Evil passive regen guard is missing.`);
  }

  const patchedCode = Buffer.concat([firstPass.guard, firstPass.code]);
  const patches: BytePatch[] = [
    {
      key: "CombatState.method_1553.code",
      start: firstPass.methodBody.codeStart,
      end: firstPass.methodBody.codeStart + firstPass.methodBody.codeLen,
      data: patchedCode,
      detail: "disable generic living regen for DemonMaligner and DemonMalignerHard",
    },
    {
      key: "CombatState.method_1553.codeLen",
      start: firstPass.methodBody.codeLenPos,
      end: firstPass.methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: "update CombatState.method_1553 code length",
    },
  ];

  const [maxStack] = readU30(firstPass.ctx.body, firstPass.methodBody.maxStackPos, "CombatState.method_1553.max_stack");
  if (maxStack < 2) {
    patches.push({
      key: "CombatState.method_1553.maxStack",
      start: firstPass.methodBody.maxStackPos,
      end: firstPass.methodBody.localCountPos,
      data: writeU30(2),
      detail: "allow the DemonMaligner name guard stack",
    });
  }

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(firstPass.ctx.body, patches);
  writeSwf(firstPass.ctx, body, delta);

  const verifyPass = buildGuard(swfPath);
  if (!hasGuard(verifyPass.code, verifyPass.guard)) {
    throw new PatchError(`${swfPath}: post-patch verification failed.`);
  }
  console.log(`${swfPath}: patched Embodiment of Evil passive regen guard.`);
}

if (require.main === module) {
  const { swfPath, verify } = parseArgs(process.argv);
  patchDemonMalignerPassiveRegen(swfPath, verify);
}
