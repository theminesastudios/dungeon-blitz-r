#!/usr/bin/env node

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

/**
 * Restores Viperblade poison to the game's standard Expertise-based DoT scaling.
 *
 * CombatState normally passes the caster's magicDamage (the Expertise-derived stat) to
 * AddBuff, and Buff multiplies that potency by DoTDamage and the active stack count. An old
 * Viperblade override replaced that potency with meleeDamage (Attack) for BuffID >= 740:
 *
 *   if (param1.buffID >= 740) param3 = uint(param2.meleeDamage);
 *
 * Removing only this guard restores the intended formula without changing the poison's
 * authored DoTDamage, one-second tick, five-second duration, or 16-stack cap.
 *
 * The guard can have either of two bytecode shapes. The original byte patch used convert_u
 * directly; FFDec recompiles the same source with getlex/callproperty uint. Both are matched
 * semantically, including the branch target, before any bytes are removed.
 */

const DEFAULT_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf",
);

const PASSIVE_BUFF_ID_FLOOR = 740;

const OP_IFNLT = 0x0f;
const OP_IFLT = 0x15;
const OP_PUSHSHORT = 0x25;
const OP_CALLPROPERTY = 0x46;
const OP_GETLEX = 0x5d;
const OP_GETPROPERTY = 0x66;
const OP_CONVERT_U = 0x74;
const OP_GETLOCAL_1 = 0xd1;
const OP_GETLOCAL_2 = 0xd2;
const OP_SETLOCAL_3 = 0xd7;

interface GuardRange {
  start: number;
  end: number;
  shape: "byte-patched" | "ffdec";
}

function operand(inst: Instruction | undefined, index = 0): number | null {
  return inst?.operands[index]?.[1] ?? null;
}

function propertyName(inst: Instruction | undefined, names: string[]): string | null {
  const index = operand(inst);
  return index === null ? null : names[index] ?? null;
}

function branchTargetsEnd(branch: Instruction, end: number): boolean {
  return branch.offset + branch.size + (operand(branch) ?? Number.NaN) === end;
}

function findAttackOverride(instructions: Instruction[], names: string[]): GuardRange | null {
  for (let i = 0; i < instructions.length; i += 1) {
    const head = instructions.slice(i, i + 10);
    if (
      head[0]?.opcode !== OP_GETLOCAL_1 ||
      head[1]?.opcode !== OP_GETPROPERTY || propertyName(head[1], names) !== "buffID" ||
      head[2]?.opcode !== OP_PUSHSHORT || operand(head[2]) !== PASSIVE_BUFF_ID_FLOOR
    ) continue;

    if (
      head[3]?.opcode === OP_IFLT &&
      head[4]?.opcode === OP_GETLOCAL_2 &&
      head[5]?.opcode === OP_GETPROPERTY && propertyName(head[5], names) === "meleeDamage" &&
      head[6]?.opcode === OP_CONVERT_U &&
      head[7]?.opcode === OP_SETLOCAL_3
    ) {
      const end = head[7].offset + head[7].size;
      if (branchTargetsEnd(head[3], end)) return { start: head[0].offset, end, shape: "byte-patched" };
    }

    if (
      head[3]?.opcode === OP_IFNLT &&
      head[4]?.opcode === OP_GETLEX && propertyName(head[4], names) === "uint" &&
      head[5]?.opcode === OP_GETLOCAL_2 &&
      head[6]?.opcode === OP_GETPROPERTY && propertyName(head[6], names) === "meleeDamage" &&
      head[7]?.opcode === OP_CALLPROPERTY && propertyName(head[7], names) === "uint" && operand(head[7], 1) === 1 &&
      head[8]?.opcode === OP_CONVERT_U &&
      head[9]?.opcode === OP_SETLOCAL_3
    ) {
      const end = head[9].offset + head[9].size;
      if (branchTargetsEnd(head[3], end)) return { start: head[0].offset, end, shape: "ffdec" };
    }
  }
  return null;
}

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") swfPath = path.resolve(argv[++index] || "");
    else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: ts-node patch-dungeonblitz-viperblade-passive-scaling.ts [--verify] [--swf <path>]\n" +
        "Restores buffs with BuffID >= 740 to Expertise-based DoT scaling.",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify };
}

function main(): number {
  const { swfPath, verify } = parseArgs(process.argv);
  try {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const classIndex = classIndexByName(abc, "CombatState");
    if (classIndex === null) throw new PatchError("CombatState class not found");

    const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "AddBuff");
    if (methodIdx === null) throw new PatchError("CombatState.AddBuff not found");
    const body = abc.methodBodies.get(methodIdx);
    if (!body) throw new PatchError(`No method body for AddBuff (method ${methodIdx})`);
    if (body.exceptionCount !== 0) {
      throw new PatchError(
        `AddBuff has ${body.exceptionCount} exception handler(s); their absolute offsets would need rewriting.`,
      );
    }

    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const instructions = disassemble(code, "CombatState.AddBuff");
    const guard = findAttackOverride(instructions, abc.multinameNames);
    if (!guard) {
      console.log(JSON.stringify({ verify, swf: swfPath, expertiseScaling: true }, null, 2));
      console.log("No changes needed.");
      return 0;
    }

    const precedingBranch = instructions.find(
      (inst) => inst.offset < guard.start && inst.opcode >= 0x0c && inst.opcode <= 0x1b,
    );
    if (precedingBranch) {
      throw new PatchError(`Unexpected branch before Viperblade guard at offset ${precedingBranch.offset}`);
    }

    const removedBytes = guard.end - guard.start;
    const [oldCodeLen] = readU30(ctx.body, body.codeLenPos, "AddBuff.code_length");
    const patches: BytePatch[] = [
      {
        key: "CombatState.AddBuff.attackOverride",
        start: body.codeStart + guard.start,
        end: body.codeStart + guard.end,
        data: Buffer.alloc(0),
        detail: `remove ${removedBytes}-byte ${guard.shape} Attack override`,
      },
      {
        key: "CombatState.AddBuff.code_length",
        start: body.codeLenPos,
        end: body.codeStart,
        data: writeU30(oldCodeLen - removedBytes),
        detail: `code_length ${oldCodeLen} -> ${oldCodeLen - removedBytes}`,
      },
    ];

    const { body: outBody, delta } = applyPatchesToBody(ctx.body, patches);
    console.log(JSON.stringify({
      verify,
      swf: swfPath,
      methodIdx,
      guardShape: guard.shape,
      guardRange: `${guard.start}:${guard.end}`,
      codeLen: `${oldCodeLen} -> ${oldCodeLen - removedBytes}`,
      abcDelta: delta,
    }, null, 2));

    if (verify) {
      console.log("Expertise-scaling patch required.");
      return 0;
    }

    ensureBackup(swfPath);
    writeSwf(ctx, outBody, delta);
    console.log("Expertise-scaling patch complete.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch-dungeonblitz-viperblade-passive-scaling] ${message}`);
    return 1;
  }
}

if (require.main === module) process.exit(main());
