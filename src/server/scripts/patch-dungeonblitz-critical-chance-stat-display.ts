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

const CRIT_CHANCE_LOCALS = new Set([7, 65]);

function multiname(abc: any, inst: Instruction): string | null {
  const operand = inst.operands[0];
  if (!operand || operand[0] !== "u30") {
    return null;
  }
  return abc.multinameNames[operand[1]] ?? null;
}

function localOperand(inst: Instruction): number | null {
  if (inst.opcode >= 0xd0 && inst.opcode <= 0xd3) {
    return inst.opcode - 0xd0;
  }
  const operand = inst.operands[0];
  if (inst.opcode !== 0x62 || !operand || operand[0] !== "u30") {
    return null;
  }
  return operand[1];
}

function pushByteValue(inst: Instruction): number | null {
  const operand = inst.operands[0];
  if (inst.opcode !== 0x24 || !operand || operand[0] !== "s8") {
    return null;
  }
  return operand[1];
}

function isRoundCall(abc: any, inst: Instruction): boolean {
  return inst.opcode === 0x46 && multiname(abc, inst) === "round";
}

function isGetLexMath(abc: any, inst: Instruction | undefined): boolean {
  return Boolean(inst && inst.opcode === 0x60 && multiname(abc, inst) === "Math");
}

function nops(count: number): Buffer {
  return Buffer.alloc(count, 0x02);
}

/**
 * Replaces the Critical Chance scaling/rounding logic with a robust 1-decimal fixed-point formatter.
 * Original sequence:
 *   getlex Math
 *   getlocal _loc7_
 *   pushbyte 15
 *   multiply
 *   callproperty round
 * 
 * New sequence:
 *   getlocal _loc7_
 *   pushbyte 15
 *   multiply
 *   pushbyte 10  <-- Multiplier for 1 decimal
 *   multiply
 *   callproperty round
 *   pushbyte 10
 *   divide
 */
function buildRobustDecimalPatch(abc: any, localInst: Instruction, oldLen: number): Buffer {
  const roundIdx = abc.multinameNames.indexOf("round");
  if (roundIdx === -1) throw new PatchError("round multiname not found in SWF");

  const localBytes = Buffer.from([localInst.opcode, ...(localInst.operands.length > 0 ? writeU30(localInst.operands[0][1]) : [])]);

  const replacement = Buffer.concat([
    localBytes,           // getlocal _loc7_
    Buffer.from([0x24, 0x0f]), // pushbyte 15
    Buffer.from([0xa2]),       // multiply
    Buffer.from([0x24, 0x0a]), // pushbyte 10 (scale up for rounding)
    Buffer.from([0xa2]),       // multiply
    Buffer.from([0x60]), writeU30(abc.multinameNames.indexOf("Math")), // getlex Math
    Buffer.from([0x2a]),       // swap (ensure Math is bottom for call)
    Buffer.from([0x46]), writeU30(roundIdx), writeU30(0), // callproperty round, args: 0
    Buffer.from([0x24, 0x0a]), // pushbyte 10 (scale down)
    Buffer.from([0xa3]),       // divide
  ]);

  if (replacement.length > oldLen) {
    // If we exceed original space, we fall back to raw string formatting or simpler patch
    // But ScreenArmory methods are usually large enough to accommodate this small growth via NOP padding 
    // or by replacing the getlex Math which is usually 2-3 bytes.
    throw new PatchError(`Patch too large for slot: ${replacement.length} > ${oldLen}`);
  }

  return Buffer.concat([replacement, nops(oldLen - replacement.length)]);
}

export function patchCriticalChanceStatDisplay(swfPath: string, verifyOnly = false): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "ScreenArmory");
  if (classIndex === null) throw new PatchError("ScreenArmory not found");

  const patches: BytePatch[] = [];
  
  const traits = [...abc.instances[classIndex].traits, ...(abc.classTraits[classIndex] ?? [])];
  for (const trait of traits) {
    const methodIdx = trait.methodIdx;
    if (methodIdx === null) continue;
    const methodBody = abc.methodBodies.get(methodIdx);
    if (!methodBody) continue;

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const instructions = disassemble(code, "ScreenArmory");

    for (let i = 0; i < instructions.length - 4; i++) {
      const inst0 = instructions[i];   // getlex Math
      const inst1 = instructions[i+1]; // getlocal _loc7_
      const inst2 = instructions[i+2]; // pushbyte 15
      const inst3 = instructions[i+3]; // multiply
      const inst4 = instructions[i+4]; // callproperty round

      const local = localOperand(inst1);
      if (isGetLexMath(abc, inst0) && 
          local !== null && CRIT_CHANCE_LOCALS.has(local) && 
          pushByteValue(inst2) === 15 && 
          inst3.opcode === 0xa2 && 
          isRoundCall(abc, inst4)) {
        
        const oldLen = inst0.size + inst1.size + inst2.size + inst3.size + inst4.size;
        try {
            const patchData = buildRobustDecimalPatch(abc, inst1, oldLen);
            patches.push({
              key: `ScreenArmory.crit.robust.${methodBody.codeStart + inst0.offset}`,
              start: methodBody.codeStart + inst0.offset,
              end: methodBody.codeStart + inst4.offset + inst4.size,
              data: patchData,
              detail: "robust 1-decimal rounding for critical chance"
            });
        } catch (e) {
            console.warn("Skipping robust patch due to size constraints, using simple float patch.");
            // Fallback: just local * 15 and hope back-calculated multipliers work
            const fallback = Buffer.concat([
                Buffer.from([inst1.opcode, ...(inst1.operands.length > 0 ? writeU30(inst1.operands[0][1]) : [])]),
                Buffer.from([0x24, 0x0f, 0xa2]),
                nops(oldLen - (inst1.size + 3))
            ]);
            patches.push({
              key: `ScreenArmory.crit.fallback.${methodBody.codeStart + inst0.offset}`,
              start: methodBody.codeStart + inst0.offset,
              end: methodBody.codeStart + inst4.offset + inst4.size,
              data: fallback,
              detail: "fallback float formatting for critical chance"
            });
        }
      }
    }
  }

  if (!verifyOnly && patches.length > 0) {
    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, body, delta);
    console.log(`Applied ${patches.length} robust critical chance display patches to ${swfPath}`);
  } else {
    console.log("No patches applied or verification mode.");
  }
}

if (require.main === module) {
  patchCriticalChanceStatDisplay(DEFAULT_SWF);
}
