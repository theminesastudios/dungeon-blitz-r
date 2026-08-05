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
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

/**
 * Clutch Heal fires below 30% health instead of 20%.
 *
 * The talentstone's magnitude is data -- a SelfValue per rank, retuned in
 * patch_gameswz_paladin_mastery_balance -- but the threshold it triggers under is not. The
 * mod is ModType "WTF", the file's own word for "the client hardcodes this", and the client
 * duly hardcodes it in CombatState.method_1192:
 *
 *   if (this.var_1428 && param2.currHP < param2.maxHP * 0.2) { heal *= 1 + this.var_1428; }
 *
 * var_1428 is the summed SelfValue of every ClutchHeal rank the player owns, accumulated a
 * few hundred lines earlier off a name prefix test.
 *
 * The edit is the smallest one in this repo: 0.2 and 0.3 are both already in the ABC double
 * constant pool, at indices 5 and 11, and both encode to a single u30 byte. So this repoints
 * one operand and changes nothing else -- no code_length, no branch offsets, no pool growth,
 * the file does not even change size.
 *
 * What it deliberately does not do is edit the pool entry for 0.2 itself. That value is
 * shared by every other 0.2 literal in the client, and rewriting it in place would quietly
 * retune all of them.
 *
 * The site is found rather than hardcoded: the one pushdouble of 0.2 in method_1192 that
 * follows a maxHP read. There is exactly one, and the only other nearby literal is the 0.3
 * on the line above it, which already points at index 11. If a rebuild ever makes that
 * ambiguous the script refuses instead of guessing.
 */

const DEFAULT_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf",
);

const OLD_THRESHOLD = 0.2;
const NEW_THRESHOLD = 0.3;

const OP_PUSHDOUBLE = 0x2f;
const OP_GETPROPERTY = 0x66;

function poolIndexFor(values: number[], wanted: number, label: string): number {
  const hits = values.map((value, index) => ({ value, index })).filter((entry) => entry.value === wanted);
  if (hits.length === 0) {
    throw new PatchError(`${wanted} is not in the double constant pool; ${label} cannot be repointed without growing it.`);
  }
  if (hits.length > 1) {
    throw new PatchError(`${wanted} appears ${hits.length} times in the double pool; refusing to guess which ${label} to use.`);
  }
  return hits[0].index;
}

function findThresholdPush(instructions: Instruction[], oldIndex: number, maxHpMultiname: number): Instruction {
  const matches = instructions.filter((inst, i) => {
    if (inst.opcode !== OP_PUSHDOUBLE || inst.operands[0][1] !== oldIndex) return false;
    // The comparison reads param2.maxHP immediately before scaling it.
    return instructions
      .slice(Math.max(0, i - 8), i)
      .some((prev) => prev.opcode === OP_GETPROPERTY && prev.operands[0][1] === maxHpMultiname);
  });

  if (matches.length === 0) throw new PatchError("No maxHP-scaled 0.2 found in CombatState.method_1192");
  if (matches.length > 1) {
    throw new PatchError(`${matches.length} maxHP-scaled 0.2 sites in method_1192; refusing to guess which is Clutch Heal.`);
  }
  return matches[0];
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
        "Usage: ts-node patch-dungeonblitz-clutch-heal-threshold.ts [--verify] [--swf <path>]\n" +
        `Moves the Clutch Heal health threshold from ${OLD_THRESHOLD * 100}% to ${NEW_THRESHOLD * 100}%.`,
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
    const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1192");
    if (methodIdx === null) throw new PatchError("CombatState.method_1192 not found");
    const body = abc.methodBodies.get(methodIdx);
    if (!body) throw new PatchError(`No method body for method_1192 (method ${methodIdx})`);

    const maxHpMultiname = abc.multinameNames.indexOf("maxHP");
    if (maxHpMultiname < 0) throw new PatchError("maxHP multiname not found");

    const newIndex = poolIndexFor(abc.doubleValues, NEW_THRESHOLD, "the new threshold");
    const oldIndex = poolIndexFor(abc.doubleValues, OLD_THRESHOLD, "the old threshold");

    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const instructions = disassemble(code, "CombatState.method_1192");

    const alreadyPatched = instructions.some((inst, i) =>
      inst.opcode === OP_PUSHDOUBLE &&
      inst.operands[0][1] === newIndex &&
      instructions
        .slice(Math.max(0, i - 8), i)
        .some((prev) => prev.opcode === OP_GETPROPERTY && prev.operands[0][1] === maxHpMultiname));

    if (alreadyPatched) {
      console.log(JSON.stringify({ verify, swf: swfPath, alreadyPatched: true }, null, 2));
      console.log("No changes needed.");
      return 0;
    }

    const target = findThresholdPush(instructions, oldIndex, maxHpMultiname);
    const operandStart = body.codeStart + target.offset + 1;
    const oldOperand = writeU30(oldIndex);
    const newOperand = writeU30(newIndex);
    if (oldOperand.length !== newOperand.length) {
      throw new PatchError(
        `Pool indices ${oldIndex} and ${newIndex} encode to different widths; this patch only does in-place operand swaps.`,
      );
    }

    const patches: BytePatch[] = [
      {
        key: "CombatState.method_1192.clutchHealThreshold",
        start: operandStart,
        end: operandStart + oldOperand.length,
        data: newOperand,
        detail: `pushdouble ${oldIndex} (${OLD_THRESHOLD}) -> ${newIndex} (${NEW_THRESHOLD})`,
      },
    ];

    const { body: outBody, delta } = applyPatchesToBody(ctx.body, patches);
    console.log(JSON.stringify({
      verify,
      swf: swfPath,
      methodIdx,
      site: target.offset,
      threshold: `${OLD_THRESHOLD} -> ${NEW_THRESHOLD}`,
      poolIndex: `${oldIndex} -> ${newIndex}`,
      abcDelta: delta,
    }, null, 2));

    if (verify) {
      console.log("Patch required.");
      return 0;
    }

    ensureBackup(swfPath);
    writeSwf(ctx, outBody, delta);
    console.log("Patch apply complete.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch-dungeonblitz-clutch-heal-threshold] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
