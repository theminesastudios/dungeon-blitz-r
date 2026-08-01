#!/usr/bin/env node

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
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

/**
 * Viperblade's passive scales off attack damage instead of Expertise.
 *
 * Every damage-over-time buff in the game takes its potency from the caster's magicDamage --
 * that is the Expertise-driven stat -- because CombatState hands it to AddBuff as the
 * potency argument and Buff multiplies its DoTDamage by whatever it was given
 * (Buff.method_351's clamped stack count times that value). Nothing in the XML reaches it,
 * which is why the Viperblade passive kept scaling off Expertise even once it had its own
 * BuffType.
 *
 * The edit goes at the top of CombatState.AddBuff rather than at the three assignments in
 * method_1192 that feed it. One site instead of three, it covers every path that applies the
 * buff rather than only the ones found by reading, and the entity it needs is right there:
 * AddBuff is invoked on the *target's* combatState, so `this` is the target and param2 is the
 * caster. Reading meleeDamage off param2 is the caster's attack damage, which is the ask.
 *
 *   if (param1.buffID >= 740) param3 = uint(param2.meleeDamage);
 *
 * Keyed on BuffID, not buff name, and that is the point: a name test would need a new entry
 * in the SWF string pool, and appending to the pool shifts the section offsets that every
 * later structure is parsed from. A numeric compare needs nothing that is not already there.
 * 740 is the first ID past the authored maximum of 739, and it is a floor rather than an
 * equality test so the Viperblade poison at 741 and any later passive buff come along
 * without another bytecode patch -- IDs from 740 up are reserved for exactly that, which is
 * recorded next to the buffs themselves in patch_gameswz_rogue_mastery_balance.
 *
 * Safe to insert at offset 0: AddBuff authors no exception handlers, so there are no
 * absolute code offsets to rewrite, and every branch in AVM2 is relative -- shifting the
 * whole body down by a constant leaves them all correct. The inserted code is stack
 * balanced, peaks two deep against an authored max_stack of 11, touches no local beyond the
 * three incoming parameters, and needs no scope, so max_stack, local_count and
 * max_scope_depth are all left alone. Only code_length moves.
 *
 * The one sharp edge worth naming: the meleeDamage read would throw if param2 were ever
 * null, and it is only reached for buff IDs 740 and up. Those are applied through the normal
 * power path, which always has a real caster.
 */

const DEFAULT_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf",
);

// The first BuffID past the authored maximum. Everything at or above this scales off attack
// damage; see NEW_BUFFS in patch_gameswz_rogue_mastery_balance.ts.
const PASSIVE_BUFF_ID_FLOOR = 740;

const OP_PUSHSHORT = 0x25;
const OP_IFLT = 0x15;
const OP_GETLOCAL_1 = 0xd1;
const OP_GETLOCAL_2 = 0xd2;
const OP_SETLOCAL_3 = 0xd7;
const OP_GETPROPERTY = 0x66;
const OP_CONVERT_U = 0x74;

function s24(value: number): Buffer {
  const out = Buffer.alloc(3);
  out.writeUIntLE(value < 0 ? value + 0x1000000 : value, 0, 3);
  return out;
}

function buildGuard(buffIdMultiname: number, meleeDamageMultiname: number): Buffer {
  const assign = Buffer.concat([
    Buffer.from([OP_GETLOCAL_2]),
    Buffer.from([OP_GETPROPERTY]), writeU30(meleeDamageMultiname),
    Buffer.from([OP_CONVERT_U]),
    Buffer.from([OP_SETLOCAL_3]),
  ]);

  return Buffer.concat([
    Buffer.from([OP_GETLOCAL_1]),
    Buffer.from([OP_GETPROPERTY]), writeU30(buffIdMultiname),
    Buffer.from([OP_PUSHSHORT]), writeU30(PASSIVE_BUFF_ID_FLOOR),
    // iflt jumps when value1 < value2, i.e. when the buff is not one of ours -- straight
    // past the assignment and into the authored first instruction.
    Buffer.from([OP_IFLT]), s24(assign.length),
    assign,
  ]);
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
        "Scales buffs with BuffID >= 740 off the caster's attack damage instead of Expertise.",
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
        `AddBuff now authors ${body.exceptionCount} exception handler(s); their absolute offsets would need shifting.`,
      );
    }

    const buffIdMultiname = abc.multinameNames.indexOf("buffID");
    const meleeDamageMultiname = resolveMeleeDamageMultiname(ctx, abc);
    if (buffIdMultiname < 0) throw new PatchError("buffID multiname not found");

    const guard = buildGuard(buffIdMultiname, meleeDamageMultiname);
    const existing = ctx.body.subarray(body.codeStart, body.codeStart + guard.length);
    if (existing.equals(guard)) {
      console.log(JSON.stringify({ verify, swf: swfPath, alreadyPatched: true }, null, 2));
      console.log("No changes needed.");
      return 0;
    }

    // Sanity: refuse to run twice with a differently-sized guard sitting there.
    const head = disassemble(ctx.body.subarray(body.codeStart, body.codeStart + 16), "AddBuff.head");
    if (head[0]?.opcode === OP_GETLOCAL_1 && head[1]?.opcode === OP_GETPROPERTY) {
      throw new PatchError("AddBuff already begins with a guard-shaped sequence that does not match this one.");
    }

    const [oldCodeLen] = readU30(ctx.body, body.codeLenPos, "AddBuff.code_length");
    const patches: BytePatch[] = [
      {
        key: "CombatState.AddBuff.code",
        start: body.codeStart,
        end: body.codeStart,
        data: guard,
        detail: `insert ${guard.length}-byte passive-scaling guard`,
      },
      {
        key: "CombatState.AddBuff.code_length",
        start: body.codeLenPos,
        end: body.codeStart,
        data: writeU30(oldCodeLen + guard.length),
        detail: `code_length ${oldCodeLen} -> ${oldCodeLen + guard.length}`,
      },
    ];

    const { body: outBody, delta } = applyPatchesToBody(ctx.body, patches);
    console.log(JSON.stringify({
      verify,
      swf: swfPath,
      methodIdx,
      buffIdMultiname,
      meleeDamageMultiname,
      guardBytes: guard.length,
      codeLen: `${oldCodeLen} -> ${oldCodeLen + guard.length}`,
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
    console.error(`[patch-dungeonblitz-viperblade-passive-scaling] ${message}`);
    return 1;
  }
}

/**
 * Entity.meleeDamage, picked by the company it keeps: the correct multiname is the one that
 * shows up in the same method bodies as Entity.magicDamage, which the authored DoT code
 * already reads off the caster.
 */
function resolveMeleeDamageMultiname(ctx: ReturnType<typeof parseSwf>, abc: ReturnType<typeof parseAbc>): number {
  const magicIdx = abc.multinameNames.indexOf("magicDamage");
  if (magicIdx < 0) throw new PatchError("magicDamage multiname not found");

  const candidates = abc.multinameNames
    .map((name, index) => ({ name, index }))
    .filter((entry) => entry.name === "meleeDamage")
    .map((entry) => entry.index);
  if (candidates.length === 0) throw new PatchError("meleeDamage multiname not found");
  if (candidates.length === 1) return candidates[0];

  const scores = new Map<number, number>(candidates.map((index) => [index, 0]));
  for (const [, body] of abc.methodBodies) {
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    let instructions;
    try {
      instructions = disassemble(code, "scan");
    } catch {
      continue;
    }

    const used = new Set<number>();
    let sawMagic = false;
    for (const inst of instructions) {
      if (inst.opcode !== OP_GETPROPERTY) continue;
      const idx = inst.operands[0][1];
      if (idx === magicIdx) sawMagic = true;
      if (scores.has(idx)) used.add(idx);
    }
    if (!sawMagic) continue;
    for (const idx of used) scores.set(idx, (scores.get(idx) ?? 0) + 1);
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (ranked[0][1] === 0) throw new PatchError("Could not tell the meleeDamage multinames apart");
  if (ranked.length > 1 && ranked[0][1] === ranked[1][1]) {
    throw new PatchError("meleeDamage multinames are equally plausible; refusing to guess");
  }
  return ranked[0][0];
}

if (require.main === module) {
  process.exit(main());
}
