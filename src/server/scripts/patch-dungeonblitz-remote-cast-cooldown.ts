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
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

// A relayed cast fires the power but never charges the caster's cooldown.
//
// `LinkUpdater.method_1180` is the 0x09 reader. It resolves the entity and the power, builds an
// `ActivePower(..., true)` and installs it -- and that really does cast: `CombatState.FireThisPower`
// gates its summon block on `power.SpawnedMonsters` alone, with no local/remote check, so the
// receiving client spawns the monsters itself. What it does NOT do is write `CombatState.var_114`,
// the cooldown table. Only the local cast path does that.
//
// The gate that reads it is `CombatState.method_414`:
//
//     if (mTimeThisTick < this.var_114[param1.powerID]) return false;
//
// so a copy of a hostile that only ever received relayed casts has an open gate forever. Live, in
// The East Wing: Tanja's clones die and the member whose client cast locally waits the authored 7s
// before she summons again, while the member whose Tanja was driven by the relay gets a fresh pair
// the instant the old one dies. The same hole desynchronises the summon rhythm generally -- the
// uncharged copy casts more often, so the two screens drift apart.
//
// The fix charges the cooldown on the receiving side, from the power's own `coolDownTime`. Nothing
// is added to the wire: the send path only writes a cooldown stamp for `var_219` powers (the
// player's hotbar), so a monster's cast carries no such field and the receiver has to derive it.
//
// MONSTERS ONLY, by `entity.brain`. That is the game's own test for "not a player"
// (`CombatState.method_414` itself reads `!this.var_3.brain` to mean exactly that), and it keeps
// the blast radius off every remote player cast in the game. A remote player's cooldown table is
// never consulted by the viewer's client anyway.
//
// Shape, deliberately: the code is inserted at the method's LAST instruction, immediately before
// its single `returnvoid`. Nothing branches past that point, so no existing branch offset moves --
// the several jumps that already target the returnvoid simply land on the guard first and fall
// through, which is wanted (every exit path charges it, and the null guards cover the paths where
// the locals were never filled in). Only `code_length` changes. There is no back edge: appending
// one and jumping back is what produces VerifyError #1021 on real Flash while FFDec still reports
// the method as clean.
//
// `method_433(PowerType, uint)` is used instead of writing `var_114[powerID]` directly. The direct
// write needs a runtime-index `setproperty`, i.e. a MultinameL, which resolves through a namespace
// SET and is only valid inside the class it was written for. `method_433` is a public QName and is
// the same one-liner: `var_114[param1.powerID] = mTimeThisTick + param2`.
const DEFAULT_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf",
);

const CLASS_NAME = "LinkUpdater";
const METHOD_NAME = "method_1180";

// Locals, read off the disassembly of the unpatched method: local 5 is the resolved Entity
// (`GetEntFromID` -> coerce Entity -> setlocal 5) and local 6 is the PowerType.
const LOCAL_ENTITY = 5;
const LOCAL_POWER = 6;

const OP_GETLOCAL = 0x62;
const OP_GETPROPERTY = 0x66;
const OP_IFFALSE = 0x12;
const OP_CALLPROPVOID = 0x4f;
const OP_RETURNVOID = 0x47;

const MIN_MAX_STACK = 3;

function parseArgs(argv: string[]): { swfPath: string; verify: boolean; revert: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  let revert = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") swfPath = path.resolve(argv[++index] || "");
    else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else if (arg === "--revert") revert = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: ts-node patch-dungeonblitz-remote-cast-cooldown.ts [--verify|--revert] [--swf <path>]\n" +
        "Charges a monster's power cooldown on the client that receives a relayed 0x09 cast.",
      );
      process.exit(0);
    } else throw new PatchError(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify, revert };
}

function qnameIndex(names: string[], kinds: number[], want: string): number {
  const hits: number[] = [];
  for (let index = 0; index < names.length; index += 1) {
    // QName (0x07) only. A Multiname resolves through a namespace set and is valid only inside
    // the class it was written for; borrowing one into LinkUpdater is the documented way to get a
    // property that silently fails to resolve at runtime.
    if (names[index] === want && kinds[index] === 0x07) hits.push(index);
  }
  if (hits.length !== 1) {
    throw new PatchError(`Expected exactly one QName named "${want}", found ${hits.length}`);
  }
  return hits[0];
}

function s24(value: number): Buffer {
  const buf = Buffer.alloc(3);
  buf.writeIntLE(value, 0, 3);
  return buf;
}

/**
 * The guard, assembled twice: once to measure it and once with the real branch targets.
 *
 * Every `iffalse` jumps to the end of the inserted block, which is the method's original
 * `returnvoid`. `total` is that offset relative to the start of the block.
 */
function buildGuard(
  brainIdx: number,
  coolDownIdx: number,
  combatStateIdx: number,
  method433Idx: number,
  total: number,
): Buffer {
  const brain = writeU30(brainIdx);
  const cooldown = writeU30(coolDownIdx);
  const combatState = writeU30(combatStateIdx);
  const method433 = writeU30(method433Idx);

  const parts: Buffer[] = [];
  let offset = 0;
  const emit = (buf: Buffer) => { parts.push(buf); offset += buf.length; };
  // An `iffalse` is 1 opcode byte + 3 operand bytes, and its target is relative to the byte AFTER it.
  const branchToEnd = () => { emit(Buffer.concat([Buffer.from([OP_IFFALSE]), s24(total - (offset + 4))])); };

  emit(Buffer.from([OP_GETLOCAL, LOCAL_ENTITY]));
  branchToEnd();
  emit(Buffer.from([OP_GETLOCAL, LOCAL_POWER]));
  branchToEnd();
  // A player has no brain; only a monster's copy consults the cooldown table.
  emit(Buffer.concat([Buffer.from([OP_GETLOCAL, LOCAL_ENTITY]), Buffer.from([OP_GETPROPERTY]), brain]));
  branchToEnd();
  // Nothing to charge for a power with no cooldown.
  emit(Buffer.concat([Buffer.from([OP_GETLOCAL, LOCAL_POWER]), Buffer.from([OP_GETPROPERTY]), cooldown]));
  branchToEnd();
  // entity.combatState.method_433(power, power.coolDownTime)
  emit(Buffer.concat([Buffer.from([OP_GETLOCAL, LOCAL_ENTITY]), Buffer.from([OP_GETPROPERTY]), combatState]));
  emit(Buffer.from([OP_GETLOCAL, LOCAL_POWER]));
  emit(Buffer.concat([Buffer.from([OP_GETLOCAL, LOCAL_POWER]), Buffer.from([OP_GETPROPERTY]), cooldown]));
  emit(Buffer.concat([Buffer.from([OP_CALLPROPVOID]), method433, writeU30(2)]));

  return Buffer.concat(parts);
}

function main(): void {
  const { swfPath, verify, revert } = parseArgs(process.argv);
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);

  const classIndex = classIndexByName(abc, CLASS_NAME);
  if (classIndex === null) throw new PatchError(`${CLASS_NAME} not found`);
  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, METHOD_NAME);
  if (methodIdx === null) throw new PatchError(`${CLASS_NAME}.${METHOD_NAME} not found`);
  const body = abc.methodBodies.get(methodIdx);
  if (!body) throw new PatchError(`${CLASS_NAME}.${METHOD_NAME} has no body`);

  const brainIdx = qnameIndex(abc.multinameNames, abc.multinameKinds, "brain");
  const coolDownIdx = qnameIndex(abc.multinameNames, abc.multinameKinds, "coolDownTime");
  const combatStateIdx = qnameIndex(abc.multinameNames, abc.multinameKinds, "combatState");
  const method433Idx = qnameIndex(abc.multinameNames, abc.multinameKinds, "method_433");

  // Measure, then assemble for real. The block's own length is what every branch target is
  // relative to, so it has to be known before the branches can be written.
  const probe = buildGuard(brainIdx, coolDownIdx, combatStateIdx, method433Idx, 0);
  const guard = buildGuard(brainIdx, coolDownIdx, combatStateIdx, method433Idx, probe.length);
  if (guard.length !== probe.length) {
    throw new PatchError(`Guard length is not stable: ${probe.length} then ${guard.length}`);
  }

  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  const alreadyPatched = code.includes(
    Buffer.concat([Buffer.from([OP_CALLPROPVOID]), writeU30(method433Idx), writeU30(2)]),
  );
  if (alreadyPatched) {
    if (!revert) {
      console.log(`${swfPath}: already patched (${CLASS_NAME}.${METHOD_NAME} charges the relayed cooldown).`);
      return;
    }
    // Cut the guard back out, byte for byte. The shared `.bak` is NOT a way back -- `ensureBackup`
    // only writes it when it is absent, so it belongs to whichever patch touched this SWF first,
    // and restoring it would roll back every patch since.
    const guardStart = body.codeLen - 1 - guard.length;
    if (guardStart < 0 || !code.subarray(guardStart, body.codeLen - 1).equals(guard)) {
      throw new PatchError(`${CLASS_NAME}.${METHOD_NAME} does not end in this patch's guard; refusing to revert`);
    }
    const revertPatches: BytePatch[] = [
      {
        key: `${CLASS_NAME}.${METHOD_NAME}.guard.revert`,
        start: body.codeStart + guardStart,
        end: body.codeStart + body.codeLen - 1,
        data: Buffer.alloc(0),
        detail: `remove ${guard.length} bytes`,
      },
      {
        key: `${CLASS_NAME}.${METHOD_NAME}.codeLen.revert`,
        start: body.codeLenPos,
        end: body.codeStart,
        data: writeU30(body.codeLen - guard.length),
        detail: `code_length ${body.codeLen} -> ${body.codeLen - guard.length}`,
      },
    ];
    const reverted = applyPatchesToBody(ctx.body, revertPatches);
    writeSwf(ctx, reverted.body, reverted.delta);
    console.log(`${swfPath}: reverted ${CLASS_NAME}.${METHOD_NAME} (-${guard.length} bytes).`);
    return;
  }
  if (revert) {
    console.log(`${swfPath}: nothing to revert (${CLASS_NAME}.${METHOD_NAME} is unpatched).`);
    return;
  }
  if (verify) {
    console.log(`${swfPath}: patch required (${CLASS_NAME}.${METHOD_NAME} does not charge the relayed cooldown).`);
    return;
  }

  // The insertion point is the method's own last instruction, and it must be the single
  // `returnvoid`. If it is not, this is not the method this patch was written against and the
  // no-branch-moves argument above does not hold.
  const instructions = disassemble(code, `${CLASS_NAME}.${METHOD_NAME}`);
  const last = instructions[instructions.length - 1];
  if (!last || last.opcode !== OP_RETURNVOID || last.offset !== body.codeLen - 1) {
    throw new PatchError(
      `${CLASS_NAME}.${METHOD_NAME} does not end in a single-byte returnvoid ` +
      `(last op 0x${(last?.opcode ?? 0).toString(16)} at ${last?.offset} of ${body.codeLen})`,
    );
  }
  if (body.exceptionCount !== 0) {
    // An exception range carries absolute offsets of its own, and this patch does not move them.
    throw new PatchError(`${CLASS_NAME}.${METHOD_NAME} has ${body.exceptionCount} exception ranges; refusing`);
  }
  // Every branch in the method must already target something inside the original code. Anything
  // pointing past the old end would be moved by the insertion.
  for (const inst of instructions) {
    for (const [kind, value] of inst.operands) {
      if (kind !== "s24") continue;
      const target = inst.offset + inst.size + value;
      if (target < 0 || target > last.offset) {
        throw new PatchError(
          `${CLASS_NAME}.${METHOD_NAME}: branch at ${inst.offset} targets ${target}, past the returnvoid`,
        );
      }
    }
  }

  const maxStack = ctx.body[body.maxStackPos];
  if (maxStack < MIN_MAX_STACK) {
    throw new PatchError(`${CLASS_NAME}.${METHOD_NAME} max_stack is ${maxStack}, below the ${MIN_MAX_STACK} the guard needs`);
  }

  const insertAt = body.codeStart + last.offset;
  const patches: BytePatch[] = [
    {
      key: `${CLASS_NAME}.${METHOD_NAME}.guard`,
      start: insertAt,
      end: insertAt,
      data: guard,
      detail: `insert ${guard.length} bytes before the returnvoid`,
    },
    {
      key: `${CLASS_NAME}.${METHOD_NAME}.codeLen`,
      start: body.codeLenPos,
      end: body.codeStart,
      data: writeU30(body.codeLen + guard.length),
      detail: `code_length ${body.codeLen} -> ${body.codeLen + guard.length}`,
    },
  ];

  ensureBackup(swfPath);
  const { body: outBody, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, outBody, delta);
  console.log(
    `${swfPath}: patched ${CLASS_NAME}.${METHOD_NAME} (+${guard.length} bytes) -- ` +
    "a relayed cast now charges a monster's cooldown.",
  );
}

try {
  main();
} catch (error) {
  console.error(`Patch error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
