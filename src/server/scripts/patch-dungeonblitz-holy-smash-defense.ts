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
 * Reduces Holy Smash's flat Defense contribution from 300% to 1% without recompiling
 * CombatState. FFDec source imports rebuild the class and can discard unrelated bytecode
 * patches added later in the build, so this edit repoints the existing two-byte literal in
 * place. Both encodings are two bytes and 0.01 already exists in the ABC double pool.
 */

const DEFAULT_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf",
);

const OLD_DEFENSE_MULTIPLIER = 3;
const NEW_DEFENSE_MULTIPLIER = 0.01;
const MAX_HP_MULTIPLIER = 0.0001;

const OP_PUSHBYTE = 0x24;
const OP_PUSHDOUBLE = 0x2f;
const OP_GETLOCAL0 = 0xd0;
const OP_GETPROPERTY = 0x66;
const OP_MULTIPLY = 0xa2;

function poolIndexFor(values: number[], wanted: number): number {
  const hits = values
    .map((value, index) => ({ value, index }))
    .filter((entry) => entry.value === wanted);
  if (hits.length !== 1) {
    throw new PatchError(
      `${wanted} appears ${hits.length} times in the double pool; expected exactly one.`,
    );
  }
  return hits[0].index;
}

function isProperty(instruction: Instruction | undefined, multiname: number): boolean {
  return Boolean(
    instruction?.opcode === OP_GETPROPERTY && instruction.operands[0]?.[1] === multiname,
  );
}

function isHolySmashDefenseSite(
  instructions: Instruction[],
  index: number,
  var3Multiname: number,
  armorMultiname: number,
  maxHpMultiname: number,
  maxHpMultiplierIndex: number,
): boolean {
  return (
    instructions[index + 1]?.opcode === OP_GETLOCAL0 &&
    isProperty(instructions[index + 2], var3Multiname) &&
    isProperty(instructions[index + 3], armorMultiname) &&
    instructions[index + 4]?.opcode === OP_MULTIPLY &&
    instructions[index + 5]?.opcode === OP_PUSHDOUBLE &&
    instructions[index + 5]?.operands[0]?.[1] === maxHpMultiplierIndex &&
    instructions[index + 6]?.opcode === OP_GETLOCAL0 &&
    isProperty(instructions[index + 7], var3Multiname) &&
    isProperty(instructions[index + 8], maxHpMultiname) &&
    instructions[index + 9]?.opcode === OP_MULTIPLY
  );
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
        "Usage: ts-node patch-dungeonblitz-holy-smash-defense.ts [--verify] [--swf <path>]\n" +
        "Reduces Holy Smash's Defense damage contribution from 300% to 1%.",
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
    if (classIndex === null) throw new PatchError("CombatState class not found.");

    const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1393");
    if (methodIdx === null) throw new PatchError("CombatState.method_1393 not found.");
    const methodBody = abc.methodBodies.get(methodIdx);
    if (!methodBody) throw new PatchError(`No method body for method_1393 (${methodIdx}).`);

    const var3Multiname = abc.multinameNames.indexOf("var_3");
    const armorMultiname = abc.multinameNames.indexOf("armorClass");
    const maxHpMultiname = abc.multinameNames.indexOf("maxHP");
    if ([var3Multiname, armorMultiname, maxHpMultiname].some((value) => value < 0)) {
      throw new PatchError("Required CombatState multinames are missing.");
    }

    const newMultiplierIndex = poolIndexFor(abc.doubleValues, NEW_DEFENSE_MULTIPLIER);
    const maxHpMultiplierIndex = poolIndexFor(abc.doubleValues, MAX_HP_MULTIPLIER);
    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const instructions = disassemble(code, "CombatState.method_1393");

    const oldSites = instructions.filter((instruction, index) =>
      instruction.opcode === OP_PUSHBYTE &&
      instruction.operands[0]?.[1] === OLD_DEFENSE_MULTIPLIER &&
      isHolySmashDefenseSite(
        instructions,
        index,
        var3Multiname,
        armorMultiname,
        maxHpMultiname,
        maxHpMultiplierIndex,
      ),
    );
    const patchedSites = instructions.filter((instruction, index) =>
      instruction.opcode === OP_PUSHDOUBLE &&
      instruction.operands[0]?.[1] === newMultiplierIndex &&
      isHolySmashDefenseSite(
        instructions,
        index,
        var3Multiname,
        armorMultiname,
        maxHpMultiname,
        maxHpMultiplierIndex,
      ),
    );

    if (patchedSites.length === 1 && oldSites.length === 0) {
      console.log(JSON.stringify({ verify, swf: swfPath, alreadyPatched: true }, null, 2));
      console.log("No changes needed.");
      return 0;
    }
    if (oldSites.length !== 1 || patchedSites.length !== 0) {
      throw new PatchError(
        `Expected one 300% site and no 1% site; found old=${oldSites.length}, patched=${patchedSites.length}.`,
      );
    }

    const replacement = Buffer.concat([Buffer.from([OP_PUSHDOUBLE]), writeU30(newMultiplierIndex)]);
    if (replacement.length !== oldSites[0].size) {
      throw new PatchError(
        `Literal width would change (${oldSites[0].size} -> ${replacement.length}); refusing unsafe patch.`,
      );
    }

    const start = methodBody.codeStart + oldSites[0].offset;
    const patches: BytePatch[] = [{
      key: "CombatState.method_1393.holySmashDefenseMultiplier",
      start,
      end: start + oldSites[0].size,
      data: replacement,
      detail: `Defense multiplier ${OLD_DEFENSE_MULTIPLIER} -> ${NEW_DEFENSE_MULTIPLIER}`,
    }];
    const { body, delta } = applyPatchesToBody(ctx.body, patches);

    console.log(JSON.stringify({
      verify,
      swf: swfPath,
      methodIdx,
      site: oldSites[0].offset,
      multiplier: `${OLD_DEFENSE_MULTIPLIER} -> ${NEW_DEFENSE_MULTIPLIER}`,
      abcDelta: delta,
    }, null, 2));
    if (verify) {
      console.log("Patch required.");
      return 0;
    }

    ensureBackup(swfPath);
    writeSwf(ctx, body, delta);
    console.log("Holy Smash Defense patch applied.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch-dungeonblitz-holy-smash-defense] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
