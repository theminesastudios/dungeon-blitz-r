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
} from "./swfPatchUtils";

/**
 * Unstable Barrier gets its shield pool back, which is what makes the HUD's purple temp-HP
 * readout appear under the health bar.
 *
 * Everything for this feature already ships in the client and none of it was reachable:
 *
 *   - `a_Hud` in UI_4.swf has `am_TempHP` (a bar inside am_HPBar) and `am_TempHPText`, an edit
 *     text in #CC99FF placed 18.5px below am_HPText.
 *   - class_58.OnTickScreen reads `combatState.var_1797` (remaining absorb) and `var_2043`
 *     (capacity), fills the bar, writes the number and flips am_TempHPText visible whenever
 *     the value is above zero.
 *   - CombatState's buff aggregation accumulates both fields off every buff whose name starts
 *     with "DetShield" -- the Barrier buff family.
 *
 * The chain dies at the source. CombatState.method_522 computes the pool:
 *
 *   _loc17_ = 4; if (var_2168) _loc17_ += 0.8;
 *   _loc18_ = Math.floor(var_3.magicDamage * _loc17_);
 *   _loc11_ = new Buff(var_3, param1, 0, param6);   // <- _loc18_ dropped, 0 passed
 *
 * so Buff.var_619 (the pool) is 0, Buff.method_357 absorbs nothing, var_1797 stays 0 and the
 * readout never shows. This is the same nulled-argument corruption as the chat class's
 * `SendPacket(null)` and `_loc3_ += null`.
 *
 * The edit repoints that one constructor argument: `pushbyte 0` (0x24 0x00) -> `getlocal 18`
 * (0x62 0x12). Both are two bytes, so nothing moves -- no code_length, no branch offsets, no
 * constant pool growth.
 *
 * Note this restores absorption as well as the display: the barrier will now soak
 * floor(magicDamage * 4) damage (* 4.8 with the var_2168 talent) before it detonates, which is
 * what the power's own description ("a force field with temporary HP") always claimed.
 *
 * The site is found, not hardcoded: the sole `constructprop Buff` that follows the
 * `pushstring "DetShield"` name test inside method_522.
 */

const DEFAULT_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf",
);

const OP_PUSHBYTE = 0x24;
const OP_PUSHSTRING = 0x2c;
const OP_GETLOCAL = 0x62;
const OP_SETLOCAL = 0x63;
const OP_GETLOCAL_0 = 0xd0;
const OP_GETLOCAL_1 = 0xd1;
const OP_GETPROPERTY = 0x66;
const OP_FINDPROPSTRICT = 0x5d;
const OP_CONSTRUCTPROP = 0x4a;

const SHIELD_POOL_LOCAL = 18;

interface Site {
  /** Index into `instructions` of the `pushbyte 0` that should be `getlocal 18`. */
  argIndex: number;
  constructIndex: number;
}

function findDetShieldBranch(instructions: Instruction[], detShieldString: number): number {
  const hits = instructions
    .map((inst, index) => ({ inst, index }))
    .filter(({ inst }) => inst.opcode === OP_PUSHSTRING && inst.operands[0][1] === detShieldString);

  if (hits.length === 0) {
    throw new PatchError('No pushstring "DetShield" in CombatState.method_522.');
  }
  if (hits.length > 1) {
    throw new PatchError(
      `${hits.length} "DetShield" name tests in method_522; refusing to guess which builds the buff.`,
    );
  }
  return hits[0].index;
}

function findBuffConstruction(
  instructions: Instruction[],
  from: number,
  buffMultiname: number,
): number {
  for (let index = from; index < instructions.length; index += 1) {
    const inst = instructions[index];
    if (
      inst.opcode === OP_CONSTRUCTPROP &&
      inst.operands[0][1] === buffMultiname &&
      inst.operands[1][1] === 4
    ) {
      return index;
    }
  }
  throw new PatchError("No 4-argument `constructprop Buff` after the DetShield name test.");
}

/**
 * The five instructions before `constructprop Buff, 4` are the receiver plus the four
 * arguments. Anything other than the exact shape below means the method was rebuilt and the
 * operand positions can no longer be trusted.
 */
function readConstructorShape(instructions: Instruction[], constructIndex: number): Instruction[] {
  const start = constructIndex - 6;
  if (start < 0) {
    throw new PatchError("The Buff construction sits too close to the start of method_522.");
  }
  return instructions.slice(start, constructIndex);
}

function locateSite(
  instructions: Instruction[],
  detShieldString: number,
  buffMultiname: number,
  var3Multiname: number,
): Site {
  const branchIndex = findDetShieldBranch(instructions, detShieldString);
  const constructIndex = findBuffConstruction(instructions, branchIndex, buffMultiname);
  const shape = readConstructorShape(instructions, constructIndex);

  const expected = [
    { opcode: OP_FINDPROPSTRICT, operand: buffMultiname, label: "findpropstrict Buff" },
    { opcode: OP_GETLOCAL_0, operand: null, label: "getlocal_0" },
    { opcode: OP_GETPROPERTY, operand: var3Multiname, label: "getproperty var_3" },
    { opcode: OP_GETLOCAL_1, operand: null, label: "getlocal_1" },
    { opcode: null, operand: null, label: "the shield-pool argument" },
    { opcode: OP_GETLOCAL, operand: 6, label: "getlocal 6" },
  ];

  expected.forEach((want, offset) => {
    const got = shape[offset];
    if (!got) {
      throw new PatchError(`Buff construction is shorter than expected; missing ${want.label}.`);
    }
    if (want.opcode !== null && got.opcode !== want.opcode) {
      throw new PatchError(
        `Buff construction argument ${offset} is opcode 0x${got.opcode.toString(16)}, expected ${want.label}.`,
      );
    }
    if (want.operand !== null && got.operands[0]?.[1] !== want.operand) {
      throw new PatchError(`Buff construction argument ${offset} does not read ${want.label}.`);
    }
  });

  return { argIndex: constructIndex - 2, constructIndex };
}

function poolLocalIsComputed(instructions: Instruction[], before: number): boolean {
  return instructions
    .slice(0, before)
    .some((inst) => inst.opcode === OP_SETLOCAL && inst.operands[0][1] === SHIELD_POOL_LOCAL);
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
        "Usage: ts-node patch-dungeonblitz-unstable-barrier-shield-amount.ts [--verify] [--swf <path>]\n" +
        "Passes the computed shield pool to the DetShield Buff so Unstable Barrier absorbs damage\n" +
        "and the HUD's purple temp-HP readout under the health bar becomes reachable.",
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
    const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_522");
    if (methodIdx === null) throw new PatchError("CombatState.method_522 not found");
    const body = abc.methodBodies.get(methodIdx);
    if (!body) throw new PatchError(`No method body for method_522 (method ${methodIdx})`);

    const detShieldString = abc.stringValues.indexOf("DetShield");
    if (detShieldString < 0) throw new PatchError('"DetShield" is not in the string pool.');
    const buffMultiname = abc.multinameNames.indexOf("Buff");
    if (buffMultiname < 0) throw new PatchError("Buff multiname not found");
    const var3Multiname = abc.multinameNames.indexOf("var_3");
    if (var3Multiname < 0) throw new PatchError("var_3 multiname not found");

    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const instructions = disassemble(code, "CombatState.method_522");

    const site = locateSite(instructions, detShieldString, buffMultiname, var3Multiname);
    const arg = instructions[site.argIndex];

    if (arg.opcode === OP_GETLOCAL && arg.operands[0][1] === SHIELD_POOL_LOCAL) {
      console.log(JSON.stringify({ verify, swf: swfPath, alreadyPatched: true }, null, 2));
      console.log("No changes needed.");
      return 0;
    }

    if (arg.opcode !== OP_PUSHBYTE || arg.operands[0][1] !== 0) {
      throw new PatchError(
        `DetShield Buff shield-pool argument is opcode 0x${arg.opcode.toString(16)}, expected \`pushbyte 0\`.`,
      );
    }

    if (!poolLocalIsComputed(instructions, site.argIndex)) {
      throw new PatchError(
        `local ${SHIELD_POOL_LOCAL} is never assigned before the Buff construction; the shield pool is not where this patch expects it.`,
      );
    }

    const newInstruction = Buffer.from([OP_GETLOCAL, SHIELD_POOL_LOCAL]);
    if (newInstruction.length !== arg.size) {
      throw new PatchError(
        `getlocal ${SHIELD_POOL_LOCAL} is ${newInstruction.length} bytes but \`pushbyte 0\` is ${arg.size}; this patch only does in-place swaps.`,
      );
    }

    const start = body.codeStart + arg.offset;
    const patches: BytePatch[] = [
      {
        key: "CombatState.method_522.detShieldPool",
        start,
        end: start + arg.size,
        data: newInstruction,
        detail: `pushbyte 0 -> getlocal ${SHIELD_POOL_LOCAL} (Math.floor(magicDamage * mult))`,
      },
    ];

    const { body: outBody, delta } = applyPatchesToBody(ctx.body, patches);
    console.log(JSON.stringify({
      verify,
      swf: swfPath,
      methodIdx,
      site: arg.offset,
      argument: `pushbyte 0 -> getlocal ${SHIELD_POOL_LOCAL}`,
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
    console.error(`[patch-dungeonblitz-unstable-barrier-shield-amount] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
