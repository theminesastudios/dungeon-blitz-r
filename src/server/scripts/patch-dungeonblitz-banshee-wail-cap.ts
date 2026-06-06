import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  ensureBackup,
  Instruction,
  parseAbc,
  parseSwf,
  PatchError,
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
        "  ts-node src/server/scripts/patch-dungeonblitz-banshee-wail-cap.ts [--verify] [--swf <path>]",
        "",
        "Patches DungeonBlitz.swf CombatState so Wail of the Banshee rank 10",
        "caps unique-condition bonus damage at 500% instead of 300%.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function multiname(abc: ReturnType<typeof parseAbc>, inst: Instruction): string | null {
  const operand = inst.operands[0];
  if (!operand || operand[0] !== "u30") {
    return null;
  }
  return abc.multinameNames[operand[1]] ?? null;
}

function stringValue(abc: ReturnType<typeof parseAbc>, inst: Instruction): string | null {
  const operand = inst.operands[0];
  if (inst.opcode !== 0x2c || !operand || operand[0] !== "u30") {
    return null;
  }
  return abc.stringValues[operand[1]] ?? null;
}

function pushByteValue(inst: Instruction): number | null {
  const operand = inst.operands[0];
  if (inst.opcode !== 0x24 || !operand || operand[0] !== "s8") {
    return null;
  }
  return operand[1];
}

function doubleValue(abc: ReturnType<typeof parseAbc>, inst: Instruction): number | null {
  const operand = inst.operands[0];
  if (inst.opcode !== 0x2f || !operand || operand[0] !== "u30") {
    return null;
  }
  return abc.doubleValues[operand[1]];
}

function getCombatStateBansheeMethod(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "CombatState");
  if (classIndex === null) {
    throw new PatchError("Could not find CombatState class.");
  }

  for (const trait of abc.instances[classIndex].traits) {
    const methodIdx = trait.methodIdx;
    if (methodIdx === null) {
      continue;
    }
    const methodBody = abc.methodBodies.get(methodIdx);
    if (!methodBody) {
      continue;
    }
    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    let instructions: Instruction[];
    try {
      instructions = disassemble(code, `CombatState.${abc.multinameNames[trait.nameIdx] ?? methodIdx}`);
    } catch {
      continue;
    }
    if (instructions.some((inst) => stringValue(abc, inst) === "BansheeWail")) {
      return { ctx, abc, methodBody, instructions };
    }
  }

  throw new PatchError("Could not find CombatState method containing BansheeWail.");
}

function findRank10CapInstruction(abc: ReturnType<typeof parseAbc>, instructions: Instruction[]): Instruction {
  const bansheePush = instructions.find((inst) => stringValue(abc, inst) === "BansheeWail");
  if (!bansheePush) {
    throw new PatchError("BansheeWail string instruction not found.");
  }

  const candidates: Instruction[] = [];
  for (let index = 0; index < instructions.length; index += 1) {
    const inst = instructions[index];
    const next = instructions[index + 1];
    if (inst.opcode !== 0xd2 || next?.opcode !== 0x66 || multiname(abc, next) !== "var_7") {
      continue;
    }

    const window = instructions.slice(index, index + 32);
    const rank10 = window.find((item) => pushByteValue(item) === 10);
    const condition = window.find((item) => item.opcode === 0x0f);
    const cap = window.find((item) => item.offset > (condition?.offset ?? -1) && (pushByteValue(item) === 3 || pushByteValue(item) === 5));
    if (!rank10 || !condition || !cap) {
      continue;
    }

    if (cap.offset < bansheePush.offset && bansheePush.offset - cap.offset < 256) {
      candidates.push(cap);
    }
  }

  if (candidates.length !== 1) {
    throw new PatchError(`Expected one BansheeWail rank 10 cap instruction, found ${candidates.length}.`);
  }
  const hasRank10Scaling = instructions.some(
    (inst) => inst.offset < bansheePush.offset && bansheePush.offset - inst.offset < 512 && doubleValue(abc, inst) === 0.6,
  );
  if (!hasRank10Scaling) {
    throw new PatchError("Could not verify Wail of the Banshee rank 10 still uses 60% per-condition scaling.");
  }
  return candidates[0];
}

function buildPatch(swfPath: string): { patch: BytePatch | null; currentCap: number } {
  const { ctx, abc, methodBody, instructions } = getCombatStateBansheeMethod(swfPath);
  const cap = findRank10CapInstruction(abc, instructions);
  const currentCap = pushByteValue(cap);
  if (currentCap !== 3 && currentCap !== 5) {
    throw new PatchError(`Unexpected BansheeWail rank 10 cap value: ${currentCap}`);
  }
  if (currentCap === 5) {
    return { patch: null, currentCap };
  }

  return {
    currentCap,
    patch: {
      key: "CombatState.BansheeWail.rank10BonusCap",
      start: methodBody.codeStart + cap.offset,
      end: methodBody.codeStart + cap.offset + cap.size,
      data: Buffer.from([0x24, 0x05]),
      detail: "set Wail of the Banshee rank 10 bonus cap from 300% to 500%",
    },
  };
}

export function patchBansheeWailCap(swfPath: string, verifyOnly = false): void {
  const firstPass = buildPatch(swfPath);
  if (!verifyOnly && firstPass.patch) {
    const ctx = parseSwf(swfPath);
    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(ctx.body, [firstPass.patch]);
    writeSwf(ctx, body, delta);
  }

  const verifyPass = buildPatch(swfPath);
  if (verifyPass.currentCap !== 5) {
    throw new PatchError(`Wail of the Banshee rank 10 cap verification failed: ${verifyPass.currentCap}`);
  }

  console.log(`${verifyOnly ? "Verified" : firstPass.patch ? "Patched" : "Already patched"} Wail of the Banshee rank 10 500% cap in ${swfPath}`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchBansheeWailCap(swfPath, verify);
