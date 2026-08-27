#!/usr/bin/env node

import * as crypto from "crypto";
import * as fs from "fs";
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
  SwfContext,
  u30OperandName,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

/**
 * Charon's Blades: the blades heat up as the power spins up, hold at full ember,
 * and cool back to steel as the energy runs out.
 *
 * The Abomination Spider's a_TalonPowerOn / a_TalonOn / a_TalonPowerOff are one
 * talon shape with a red-hot overlay alpha-tweened in and out, driven by the
 * spider's own animation sequence. The player rig has no such sequence, and
 * SuperAnimData.method_866 flattens the whole character into one cached bitmap
 * per animation frame, so a blade cannot be recoloured frame by frame at
 * runtime. Each tone is therefore its own symbol, selected by CustomArt name --
 * patch-gfxpaladin-charon-blades-hot builds levels 1..4 (level 0 is the stock
 * steel art). Four is the ceiling: Gfx_Paladin_1.swf has exactly four unused
 * a_Offhand_* classes to retarget.
 *
 * The level is a pure function of state the client already keeps, so nothing has
 * to be latched on a sealed class:
 *
 *   mana >= 20 : level = min(4, (now - var_1435) / RAMP_STEP_MS)   -- spin-up
 *   mana <  20 : level = mana / 5                                  -- burn-out
 *
 * CombatState.var_1435 is "time of last mana regen", and regen is skipped while
 * a form power is up (`if (!this.var_39 && ...)`), so it freezes for the whole
 * duration -- which makes `now - var_1435` a free stopwatch. It is stale by up
 * to one regen interval at the moment the form starts, though, which would jump
 * the ramp straight to full, so injection 1 restamps it on activation.
 *
 * Three injections:
 *
 * 1. Entity.method_391, on the activation path just before it writes
 *    combatState.var_39 -- restamp var_1435 to now, starting the stopwatch. The
 *    write is stack-neutral and lands ahead of the ResetEntType this same
 *    method already performs, so the first bake sees a fresh clock. Harmless to
 *    the regen it belongs to: the form suppresses regen anyway, and both before
 *    and after this patch the first post-form regen tick fires immediately.
 *
 * 2. Entity.method_1826 builds gfxType.customArts. Its SeekingBlades arm pushes
 *    Gfx_Paladin_1.swf/SeekingBlades, then Gfx_Rogue_1.swf/SeekingBlades, then
 *    Animation_Rogue.swf/HatHair. SuperAnimData.method_902 resolves each body
 *    part by walking that vector *backwards* and taking the first hit, so an
 *    entry only has to sit after the one it overrides, and only competes for the
 *    parts it actually supplies. The level's blade pair goes in right after the
 *    Paladin push: it wins a_Sword and a_Offhand while the later Rogue and
 *    HatHair entries keep winning the hood and mantle.
 *
 * 3. CombatState.method_960 (the per-tick update) compares the level it wants
 *    against the level the built art is already in -- read back off the last
 *    customArts entry, which is one of the four known offhand names exactly when
 *    the blades are lit -- and calls ResetEntType only when they differ. Each
 *    level is a distinct GfxType and so its own character bake, which is why the
 *    ramp is paced by a clock rather than stepped once per tick: it spreads the
 *    four bakes over RAMP_STEP_MS each instead of over four consecutive frames.
 *
 * Every emitted block is stack-neutral and branches forward only. assemble()
 * walks each one the way the player's verifier will before a byte is written.
 */

const DEFAULT_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf",
);

const ART_FILE = "Gfx_Paladin_1.swf";

/**
 * level -> the CustomArt set names carrying it, and they must stay in step with
 * RAMP in patch-gfxpaladin-charon-blades-hot.js. Index 0 is level 1.
 */
const HOT_SETS = [
  { sword: "SWORD00PLACEHOLDER", offhand: "OFFHAND00PLACEHOLDER" },
  { sword: "MACE00PLACEHOLDER", offhand: "OffhandSabre02" },
  { sword: "AXE00PLACEHOLDER", offhand: "OffhandScepter03" },
  { sword: "RAPIER00PLACEHOLDER", offhand: "OffhandScepter07" },
];

/** Mana at or above this is "the power still has energy"; below it the blades cool. */
const HOT_THRESHOLD = 20;
/** Mana per level on the way down, so 20 -> level 3 and 0 -> level 0. */
const COOL_STEP = 5;
/** Milliseconds per level on the way up: full ember about 440ms after activation. */
const RAMP_STEP_MS = 110;

/** Every emitted block here stays well under this; assemble() enforces it. */
const STACK_BUDGET = 12;

/** --diagnose: cycle the blades 0..4 off a free-running clock to isolate the fault. */
let DIAGNOSE = false;
const DIAGNOSE_STEP_MS = 700;
const OP = {
  jump: 0x10,
  iftrue: 0x11,
  iffalse: 0x12,
  ifeq: 0x13,
  ifne: 0x14,
  greaterequals: 0xb0,
  pushbyte: 0x24,
  pushshort: 0x25,
  pushtrue: 0x26,
  pushfalse: 0x27,
  pop: 0x29,
  dup: 0x2a,
  pushstring: 0x2c,
  constructprop: 0x4a,
  callproperty: 0x46,
  callpropvoid: 0x4f,
  findpropstrict: 0x5d,
  getlex: 0x60,
  setproperty: 0x61,
  getlocal: 0x62,
  setlocal: 0x63,
  getproperty: 0x66,
  coerce: 0x80,
  convert_i: 0x73,
  convert_u: 0x74,
  add: 0xa0,
  subtract: 0xa1,
  multiply: 0xa2,
  divide: 0xa3,
  modulo: 0xa4,
  iflt: 0x15,
  ifle: 0x16,
  ifgt: 0x17,
  ifge: 0x18,
  equals: 0xab,
  getlocal0: 0xd0,
} as const;

type Operand = [Instruction["operands"][number][0], number];
type Emitted =
  | { label: string }
  | { opcode: number; operands?: Operand[]; branchTo?: string; pop?: number; push?: number };

function writeS24(value: number): Buffer {
  const out = Buffer.alloc(3);
  let encoded = value;
  if (encoded < 0) {
    encoded += 1 << 24;
  }
  out[0] = encoded & 0xff;
  out[1] = (encoded >>> 8) & 0xff;
  out[2] = (encoded >>> 16) & 0xff;
  return out;
}

function isBranchOpcode(opcode: number): boolean {
  return opcode >= 0x0c && opcode <= 0x1a;
}

function operandBytes(kind: Operand[0], value: number): Buffer {
  if (kind === "u30") {
    return writeU30(value);
  }
  if (kind === "s8") {
    return Buffer.from([value & 0xff]);
  }
  if (kind === "s24") {
    return writeS24(value);
  }
  throw new PatchError(`Unsupported operand kind ${kind}`);
}


/**
 * Constant pool detail parseAbc does not keep: namespace kinds and the multiname
 * table, so a property can be referenced by the exact QName the player VM will
 * resolve (public `x`, not some private `x`), plus the two positions needed to
 * append new strings.
 */
interface PoolInfo {
  strings: string[];
  stringCountPos: number;
  stringCountEnd: number;
  stringPoolEnd: number;
  publicQName(name: string): number;
  qNameIn(namespace: string, name: string): number;
}

function parsePool(ctx: SwfContext): PoolInfo {
  const d = ctx.body;
  let pos = ctx.abcStart + 4;
  let count: number;

  [count, pos] = readU30(d, pos, "pool.int");
  for (let i = 1; i < count; i += 1) {
    [, pos] = readU30(d, pos, "pool.int[]");
  }
  [count, pos] = readU30(d, pos, "pool.uint");
  for (let i = 1; i < count; i += 1) {
    [, pos] = readU30(d, pos, "pool.uint[]");
  }
  [count, pos] = readU30(d, pos, "pool.double");
  pos += 8 * (count - 1);

  const stringCountPos = pos;
  [count, pos] = readU30(d, pos, "pool.string");
  const stringCountEnd = pos;
  const strings = [""];
  for (let i = 1; i < count; i += 1) {
    let len: number;
    [len, pos] = readU30(d, pos, "pool.string[].len");
    strings.push(d.subarray(pos, pos + len).toString("utf8"));
    pos += len;
  }
  const stringPoolEnd = pos;

  [count, pos] = readU30(d, pos, "pool.ns");
  const nsKind = [0];
  const nsName = [0];
  for (let i = 1; i < count; i += 1) {
    nsKind.push(d[pos]);
    pos += 1;
    let name: number;
    [name, pos] = readU30(d, pos, "pool.ns[].name");
    nsName.push(name);
  }

  [count, pos] = readU30(d, pos, "pool.nsset");
  for (let i = 1; i < count; i += 1) {
    let entries: number;
    [entries, pos] = readU30(d, pos, "pool.nsset[].count");
    for (let j = 0; j < entries; j += 1) {
      [, pos] = readU30(d, pos, "pool.nsset[][]");
    }
  }

  let multinameCount: number;
  [multinameCount, pos] = readU30(d, pos, "pool.mn");
  const multinames: Array<{ kind: number; ns: number; name: number }> = [{ kind: 0, ns: 0, name: 0 }];
  for (let i = 1; i < multinameCount; i += 1) {
    const kind = d[pos];
    pos += 1;
    let ns = 0;
    let name = 0;
    if (kind === 0x07 || kind === 0x0d) {
      [ns, pos] = readU30(d, pos, "mn.ns");
      [name, pos] = readU30(d, pos, "mn.name");
    } else if (kind === 0x0f || kind === 0x10) {
      [name, pos] = readU30(d, pos, "mn.name");
    } else if (kind === 0x11 || kind === 0x12) {
      // runtime multiname, no operands
    } else if (kind === 0x09 || kind === 0x0e) {
      [name, pos] = readU30(d, pos, "mn.name");
      [, pos] = readU30(d, pos, "mn.nsset");
    } else if (kind === 0x1b || kind === 0x1c) {
      [, pos] = readU30(d, pos, "mn.nsset");
    } else if (kind === 0x1d) {
      [, pos] = readU30(d, pos, "mn.qname");
      let params: number;
      [params, pos] = readU30(d, pos, "mn.params");
      for (let j = 0; j < params; j += 1) {
        [, pos] = readU30(d, pos, "mn.param[]");
      }
    } else {
      throw new PatchError(`Unsupported multiname kind 0x${kind.toString(16)} at ${i}`);
    }
    multinames.push({ kind, ns, name });
  }

  function findQName(namespace: string, name: string): number {
    const matches: number[] = [];
    for (let i = 1; i < multinames.length; i += 1) {
      const mn = multinames[i];
      if (mn.kind !== 0x07 || strings[mn.name] !== name) {
        continue;
      }
      // 0x16 is PackageNamespace, the one public members live in.
      if (nsKind[mn.ns] !== 0x16 || strings[nsName[mn.ns]] !== namespace) {
        continue;
      }
      matches.push(i);
    }
    if (matches.length === 0) {
      throw new PatchError(`No QName for ${namespace || "public"}::${name} in the constant pool.`);
    }
    return matches[0];
  }

  return {
    strings,
    stringCountPos,
    stringCountEnd,
    stringPoolEnd,
    publicQName: (name: string) => findQName("", name),
    qNameIn: findQName,
  };
}

/** New string constants, appended past the last one so no existing index moves. */
function appendStrings(pool: PoolInfo, wanted: string[]): { indexOf: Map<string, number>; patches: BytePatch[] } {
  const indexOf = new Map<string, number>();
  const missing: string[] = [];
  for (const value of wanted) {
    const existing = pool.strings.indexOf(value);
    if (existing > 0) {
      indexOf.set(value, existing);
      continue;
    }
    if (!missing.includes(value)) {
      missing.push(value);
    }
  }
  if (missing.length === 0) {
    return { indexOf, patches: [] };
  }

  let nextIndex = pool.strings.length;
  const chunks: Buffer[] = [];
  for (const value of missing) {
    const bytes = Buffer.from(value, "utf8");
    chunks.push(writeU30(bytes.length), bytes);
    indexOf.set(value, nextIndex);
    nextIndex += 1;
  }

  return {
    indexOf,
    patches: [
      {
        key: "abc.string_pool.append",
        start: pool.stringPoolEnd,
        end: pool.stringPoolEnd,
        data: Buffer.concat(chunks),
        detail: `append ${missing.length} string constants`,
      },
      {
        key: "abc.string_count",
        start: pool.stringCountPos,
        end: pool.stringCountEnd,
        data: writeU30(nextIndex),
        detail: `string_count -> ${nextIndex}`,
      },
    ],
  };
}

function assemble(program: Emitted[]): Buffer {
  const labels = new Map<string, number>();
  let offset = 0;
  for (const item of program) {
    if ("label" in item) {
      if (labels.has(item.label)) {
        throw new PatchError(`Duplicate label ${item.label}`);
      }
      labels.set(item.label, offset);
      continue;
    }
    offset += 1;
    if (item.branchTo) {
      offset += 3;
    } else {
      for (const [kind, value] of item.operands ?? []) {
        offset += operandBytes(kind, value).length;
      }
    }
  }

  const depthAt = new Map<string, number>();
  let depth = 0;
  let maxDepth = 0;
  let reachable = true;
  for (const item of program) {
    if ("label" in item) {
      const known = depthAt.get(item.label);
      if (known === undefined) {
        if (!reachable) {
          throw new PatchError(`Label ${item.label} is unreachable`);
        }
        depthAt.set(item.label, depth);
      } else {
        if (reachable && known !== depth) {
          throw new PatchError(`Stack depth mismatch at ${item.label}: ${known} vs ${depth}`);
        }
        depth = known;
      }
      reachable = true;
      continue;
    }
    if (!reachable) {
      throw new PatchError("Unreachable instruction in emitted block");
    }
    depth -= item.pop ?? 0;
    if (depth < 0) {
      throw new PatchError("Emitted block underflows the operand stack");
    }
    depth += item.push ?? 0;
    maxDepth = Math.max(maxDepth, depth);
    if (item.branchTo) {
      const known = depthAt.get(item.branchTo);
      if (known === undefined) {
        depthAt.set(item.branchTo, depth);
      } else if (known !== depth) {
        throw new PatchError(`Stack depth mismatch branching to ${item.branchTo}: ${known} vs ${depth}`);
      }
      if (item.opcode === OP.jump) {
        reachable = false;
      }
    }
  }
  if (reachable && depth !== 0) {
    throw new PatchError(`Emitted block leaves ${depth} values on the stack`);
  }
  if (maxDepth + 4 > STACK_BUDGET) {
    throw new PatchError(`Emitted block needs stack ${maxDepth}, budget is ${STACK_BUDGET}`);
  }

  const chunks: Buffer[] = [];
  const fixups: Array<{ pos: number; target: string }> = [];
  offset = 0;
  for (const item of program) {
    if ("label" in item) {
      continue;
    }
    const parts: Buffer[] = [Buffer.from([item.opcode])];
    offset += 1;
    if (item.branchTo) {
      parts.push(Buffer.alloc(3));
      fixups.push({ pos: offset, target: item.branchTo });
      offset += 3;
    } else {
      for (const [kind, value] of item.operands ?? []) {
        const bytes = operandBytes(kind, value);
        parts.push(bytes);
        offset += bytes.length;
      }
    }
    chunks.push(Buffer.concat(parts));
  }

  const assembled = Buffer.concat(chunks);
  for (const fixup of fixups) {
    const target = labels.get(fixup.target);
    if (target === undefined) {
      throw new PatchError(`Unknown branch label ${fixup.target}`);
    }
    writeS24(target - (fixup.pos + 3)).copy(assembled, fixup.pos);
  }
  return assembled;
}

function spliceAndAdjustBranches(
  originalCode: Buffer,
  instructions: Instruction[],
  replaceStart: number,
  replaceEnd: number,
  data: Buffer,
): Buffer {
  for (const inst of instructions) {
    if (!isBranchOpcode(inst.opcode) || (inst.offset >= replaceStart && inst.offset < replaceEnd)) {
      continue;
    }
    const target = inst.offset + inst.size + inst.operands[0][1];
    if (target >= replaceStart && target < Math.max(replaceEnd, replaceStart + 1)) {
      throw new PatchError(`A branch targets the injection point (${target}); refusing to splice there.`);
    }
  }

  const patched = Buffer.concat([
    originalCode.subarray(0, replaceStart),
    data,
    originalCode.subarray(replaceEnd),
  ]);

  const delta = data.length - (replaceEnd - replaceStart);
  const shift = (offset: number): number => (offset >= replaceEnd ? offset + delta : offset);

  for (const inst of instructions) {
    // Branches inside a block being replaced go away with it.
    if (!isBranchOpcode(inst.opcode) || (inst.offset >= replaceStart && inst.offset < replaceEnd)) {
      continue;
    }
    const branch = inst.operands[0];
    if (branch[0] !== "s24") {
      throw new PatchError(`Unexpected branch operand at ${inst.offset}`);
    }
    const oldEnd = inst.offset + inst.size;
    const newEnd = shift(inst.offset) + inst.size;
    writeS24(shift(oldEnd + branch[1]) - newEnd).copy(patched, shift(inst.offset) + 1);
  }

  return patched;
}
type Abc = ReturnType<typeof parseAbc>;
type Str = (value: string) => number;

interface Site {
  methodIdx: number;
  body: NonNullable<ReturnType<Abc["methodBodies"]["get"]>>;
  code: Buffer;
  instructions: Instruction[];
  label: string;
}

function site(ctx: SwfContext, abc: Abc, className: string, methodName: string): Site {
  const classIndex = classIndexByName(abc, className);
  if (classIndex === null) throw new PatchError(`Could not find ${className}.`);
  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, methodName);
  if (methodIdx === null) throw new PatchError(`Could not find ${className}.${methodName}.`);
  const body = abc.methodBodies.get(methodIdx);
  if (!body) throw new PatchError(`No method body for ${className}.${methodName}.`);
  const label = `${className}.${methodName}`;
  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  return { methodIdx, body, code, instructions: disassemble(code, label), label };
}

/**
 * Multiname operands are lifted out of code that already reads the property
 * rather than looked up by name. Several of these live in PackageInternalNs and
 * some share a name with an unrelated public member, so "the index the client
 * itself uses for this read" is the only definition that cannot pick the wrong
 * namespace.
 */
function operandIn(target: Site, opcode: number, abc: Abc, name: string): number {
  const hits = new Set<number>();
  for (const inst of target.instructions) {
    if (inst.opcode === opcode && u30OperandName(inst, abc.multinameNames) === name) {
      hits.add(inst.operands[0][1]);
    }
  }
  if (hits.size === 0) throw new PatchError(`No 0x${opcode.toString(16)} for "${name}" in ${target.label}.`);
  if (hits.size > 1) {
    throw new PatchError(`"${name}" resolves to ${hits.size} multinames in ${target.label}; refusing to guess.`);
  }
  return [...hits][0];
}

function operandInClass(ctx: SwfContext, abc: Abc, className: string, opcode: number, name: string): number {
  const classIndex = classIndexByName(abc, className);
  if (classIndex === null) throw new PatchError(`Could not find ${className}.`);
  const hits = new Set<number>();
  for (const trait of abc.instances[classIndex].traits) {
    if (trait.methodIdx === null) continue;
    const body = abc.methodBodies.get(trait.methodIdx);
    if (!body) continue;
    let instructions: Instruction[];
    try {
      instructions = disassemble(ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen), className);
    } catch {
      continue; // lookupswitch and friends; some other method will have the read
    }
    for (const inst of instructions) {
      if (inst.opcode === opcode && u30OperandName(inst, abc.multinameNames) === name) {
        hits.add(inst.operands[0][1]);
      }
    }
  }
  if (hits.size === 0) throw new PatchError(`No 0x${opcode.toString(16)} for "${name}" anywhere in ${className}.`);
  if (hits.size > 1) {
    throw new PatchError(`"${name}" resolves to ${hits.size} multinames in ${className}; refusing to guess.`);
  }
  return [...hits][0];
}

/**
 * The runtime-keyed multiname (`dict[expr]`) carries the *declaring* class's
 * namespace set, so it has to come from the patched class's own code rather than
 * from any other class that happens to index a Dictionary. parseAbc cannot name
 * these -- it reads a garbage base name -- so it and the `.powerID` read that
 * follows it are identified positionally, off the powerTypesDict["..."].powerID
 * idiom these blocks are copying.
 */
function findDictIdiom(target: Site, abc: Abc): { runtimeIndex: number; powerID: number } {
  const runtime = new Set<number>();
  const powerID = new Set<number>();
  for (let i = 2; i < target.instructions.length; i += 1) {
    const dict = target.instructions[i - 2];
    const key = target.instructions[i - 1];
    const index = target.instructions[i];
    if (key.opcode !== OP.pushstring || index.opcode !== OP.getproperty) continue;
    if (dict.opcode !== OP.getproperty) continue;
    if (u30OperandName(dict, abc.multinameNames) !== "powerTypesDict") continue;
    runtime.add(index.operands[0][1]);
    const next = target.instructions[i + 1];
    if (next && next.opcode === OP.getproperty && u30OperandName(next, abc.multinameNames) === "powerID") {
      powerID.add(next.operands[0][1]);
    }
  }
  if (runtime.size !== 1) {
    throw new PatchError(`Expected one runtime-keyed multiname in ${target.label}, found ${runtime.size}.`);
  }
  if (powerID.size !== 1) {
    throw new PatchError(`Expected one powerTypesDict[..].powerID multiname in ${target.label}, found ${powerID.size}.`);
  }
  return { runtimeIndex: [...runtime][0], powerID: [...powerID][0] };
}

// --- emitters ---------------------------------------------------------------

/** `this.<a>` then `.<b>`... -- a getlocal0 followed by a chain of getproperty. */
function read(...multinames: number[]): Emitted[] {
  const out: Emitted[] = [{ opcode: OP.getlocal0, push: 1 }];
  for (const mn of multinames) out.push({ opcode: OP.getproperty, operands: [["u30", mn]], pop: 1, push: 1 });
  return out;
}

/** Replaces the value on the stack with `min(value, cap)`. */
function capAt(cap: number, label: string): Emitted[] {
  return [
    { opcode: OP.dup, push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", cap]], push: 1 },
    { opcode: OP.iflt, branchTo: label, pop: 2 },
    { opcode: OP.pop, pop: 1 },
    { opcode: OP.pushbyte, operands: [["s8", cap]], push: 1 },
    { label },
  ];
}

interface LevelReads {
  /** Pushes the entity's mana. */
  mana: Emitted[];
  /** Pushes Game.mTimeThisTick. */
  now: Emitted[];
  /** Pushes CombatState.var_1435, the frozen activation stamp. */
  stamp: Emitted[];
}

/**
 * Leaves the wanted heat level (0..4) on the stack.
 *
 * Above the threshold the level is paced off the stopwatch, so activation ramps
 * up; below it the level follows the remaining mana, so the blades cool in step
 * with the energy actually draining. The two meet cleanly: at 20 mana the
 * stopwatch has long since capped at 4 and the burn-out branch starts at 3.
 */
function wantedLevel(reads: LevelReads, tag: string): Emitted[] {
  if (DIAGNOSE) {
    // Free-running 0..4 cycle, one step per DIAGNOSE_STEP_MS, ignoring mana and
    // the stopwatch entirely. If the blades visibly cycle under this build then
    // the art, the re-bake and the power gate are all working and the fault is
    // in the level inputs; if they sit still, the fault is upstream of them.
    return [
      ...reads.now,
      { opcode: OP.pushshort, operands: [["u30", DIAGNOSE_STEP_MS]], push: 1 },
      { opcode: OP.divide, pop: 2, push: 1 },
      { opcode: OP.convert_i, pop: 1, push: 1 },
      { opcode: OP.pushbyte, operands: [["s8", HOT_SETS.length + 1]], push: 1 },
      { opcode: OP.modulo, pop: 2, push: 1 },
      { opcode: OP.convert_i, pop: 1, push: 1 },
    ];
  }
  return [
    ...reads.mana,
    { opcode: OP.dup, push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", HOT_THRESHOLD]], push: 1 },
    { opcode: OP.ifge, branchTo: `${tag}:spinUp`, pop: 2 },

    // burn-out: level = mana / COOL_STEP, truncated
    { opcode: OP.pushbyte, operands: [["s8", COOL_STEP]], push: 1 },
    { opcode: OP.divide, pop: 2, push: 1 },
    { opcode: OP.convert_i, pop: 1, push: 1 },
    { opcode: OP.jump, branchTo: `${tag}:haveWanted` },

    { label: `${tag}:spinUp` },
    { opcode: OP.pop, pop: 1 }, // drop the mana copy
    ...reads.now,
    ...reads.stamp,
    { opcode: OP.subtract, pop: 2, push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", RAMP_STEP_MS]], push: 1 },
    { opcode: OP.divide, pop: 2, push: 1 },
    { opcode: OP.convert_i, pop: 1, push: 1 },
    ...capAt(HOT_SETS.length, `${tag}:haveWanted`),
  ];
}

interface ArtNames {
  entType: number;
  gfxType: number;
  customArts: number;
  setName: number;
  length: number;
  runtimeIndex: number;
}

/**
 * Leaves the level the *built* art is in (0..4) on the stack, by matching the
 * last customArts entry against the four offhand set names. Reading it back off
 * the art is what keeps the ramp from needing a latch field on a sealed class.
 *
 * Every hop is null-guarded: this runs on every combat tick for every entity in
 * the level, and a half-built entType would otherwise be a #1009.
 */
function builtLevel(entity: Emitted[], names: ArtNames, str: Str, tag: string): Emitted[] {
  const done = `${tag}:haveBuilt`;
  const guard = (): Emitted[] => [
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: `${tag}:none`, pop: 1 },
  ];

  const out: Emitted[] = [...entity];
  for (const mn of [names.entType, names.gfxType, names.customArts]) {
    out.push({ opcode: OP.getproperty, operands: [["u30", mn]], pop: 1, push: 1 });
    out.push(...guard());
  }

  out.push(
    // [customArts] -> [customArts, length]
    { opcode: OP.dup, push: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.length]], pop: 1, push: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 },
    { opcode: OP.ifle, branchTo: `${tag}:empty`, pop: 2 },
    { opcode: OP.pushbyte, operands: [["s8", 1]], push: 1 },
    { opcode: OP.subtract, pop: 2, push: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.runtimeIndex]], pop: 2, push: 1 },
    ...guard(),
    { opcode: OP.getproperty, operands: [["u30", names.setName]], pop: 1, push: 1 },
  );

  // [setName] -> [level]
  HOT_SETS.forEach((set, index) => {
    out.push(
      { opcode: OP.dup, push: 1 },
      { opcode: OP.pushstring, operands: [["u30", str(set.offhand)]], push: 1 },
      { opcode: OP.ifeq, branchTo: `${tag}:is${index + 1}`, pop: 2 },
    );
  });
  out.push(
    { opcode: OP.pop, pop: 1 },
    { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 },
    { opcode: OP.jump, branchTo: done },
  );
  HOT_SETS.forEach((_set, index) => {
    out.push(
      { label: `${tag}:is${index + 1}` },
      { opcode: OP.pop, pop: 1 },
      { opcode: OP.pushbyte, operands: [["s8", index + 1]], push: 1 },
      { opcode: OP.jump, branchTo: done },
    );
  });

  out.push(
    // the length probe left [customArts, length] on the stack
    { label: `${tag}:empty` },
    { opcode: OP.pop, pop: 1 },
    { opcode: OP.pop, pop: 1 },
    { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 },
    { opcode: OP.jump, branchTo: done },
    // a null hop left its own null on the stack
    { label: `${tag}:none` },
    { opcode: OP.pop, pop: 1 },
    { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 },
    { label: done },
  );
  return out;
}

// --- injection 1: restamp the stopwatch on activation -----------------------

interface StampNames {
  combatState: number;
  var_1435: number;
  var_1: number;
  mTimeThisTick: number;
}

function stampProgram(names: StampNames): Emitted[] {
  return [
    { opcode: OP.getlocal0, push: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.combatState]], pop: 1, push: 1 },
    { opcode: OP.getlocal0, push: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.var_1]], pop: 1, push: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.mTimeThisTick]], pop: 1, push: 1 },
    { opcode: OP.setproperty, operands: [["u30", names.var_1435]], pop: 2 },
  ];
}

/**
 * The activation write `combatState.var_39 = powerTypesDict["SeekingBlades1"].powerID`.
 * The stamp goes in just ahead of the pushstring: the instruction after the
 * setproperty is a branch target, and a stack-neutral block can sit anywhere on
 * a linear path regardless of what the surrounding expression has already
 * pushed, as long as max_stack covers it.
 */
function findActivationWrite(entity: Site, abc: Abc, pool: PoolInfo): number {
  const list = entity.instructions;
  const matches: number[] = [];
  for (let i = 0; i < list.length - 3; i += 1) {
    const [key, index, power, store] = list.slice(i, i + 4);
    if (key.opcode !== OP.pushstring || pool.strings[key.operands[0][1]] !== "SeekingBlades1") continue;
    if (index.opcode !== OP.getproperty) continue;
    if (power.opcode !== OP.getproperty || u30OperandName(power, abc.multinameNames) !== "powerID") continue;
    if (store.opcode !== OP.setproperty || u30OperandName(store, abc.multinameNames) !== "var_39") continue;
    matches.push(key.offset);
  }
  if (matches.length === 0) throw new PatchError("Charon's Blades activation write not found in Entity.method_391.");
  if (matches.length > 1) {
    throw new PatchError(`${matches.length} activation writes in Entity.method_391; refusing to guess.`);
  }
  return matches[0];
}

// --- injection 2: the blade pair for the wanted level ------------------------

interface SeekingBladesPush {
  /** Offset just past `callpropvoid push,1`, where the new block goes. */
  injectAt: number;
  customArtsLocal: number;
  customArtMn: number;
  pushMn: number;
  artFileString: number;
}

/**
 * Offset just past the *last* CustomArt the SeekingBlades arm pushes.
 *
 * The blade pair has to go in behind every other entry, not just behind the
 * Gfx_Paladin_1 one it overrides, because the tick reads the level back off the
 * final entry. Injecting after the Paladin push instead left Animation_Rogue's
 * HatHair last, so the readback never matched, the levels always compared
 * unequal, and ResetEntType fired on every single tick.
 *
 * The arm ends `... callpropvoid push,1 ; jump <rest of the method>`, and that
 * jump is where the arm's internal skip branches land -- which is exactly why
 * the block belongs there: every path through the arm passes it.
 */
function endOfSeekingBladesArm(list: Instruction[], from: number): number {
  for (let i = from; i < list.length - 1; i += 1) {
    const inst = list[i];
    if (inst.opcode !== OP.callpropvoid) continue;
    if (list[i + 1].opcode !== OP.jump) continue;
    return inst.offset + inst.size;
  }
  throw new PatchError("Could not find the end of the SeekingBlades customArts arm.");
}

function findSeekingBladesPush(entity: Site, abc: Abc, pool: PoolInfo): SeekingBladesPush {
  const list = entity.instructions;
  const matches: SeekingBladesPush[] = [];

  for (let i = 2; i < list.length - 3; i += 1) {
    const [file, set, construct, push] = list.slice(i, i + 4);
    if (file.opcode !== OP.pushstring || pool.strings[file.operands[0][1]] !== ART_FILE) continue;
    if (set.opcode !== OP.pushstring || pool.strings[set.operands[0][1]] !== "SeekingBlades") continue;
    if (construct.opcode !== OP.constructprop || construct.operands[1][1] !== 2) continue;
    if (push.opcode !== OP.callpropvoid || push.operands[1][1] !== 1) continue;
    if (u30OperandName(push, abc.multinameNames) !== "push") continue;

    // ...; dup; setlocal N; findpropstrict CustomArt; pushstring; pushstring
    const findProp = list[i - 1];
    const setLocal = list[i - 2];
    if (findProp.opcode !== OP.findpropstrict) continue;
    if (setLocal.opcode !== OP.setlocal) continue;
    if (findProp.operands[0][1] !== construct.operands[0][1]) continue;

    matches.push({
      injectAt: endOfSeekingBladesArm(list, i + 4),
      customArtsLocal: setLocal.operands[0][1],
      customArtMn: construct.operands[0][1],
      pushMn: push.operands[0][1],
      artFileString: file.operands[0][1],
    });
  }

  if (matches.length === 0) throw new PatchError("Charon's Blades customArts push not found in Entity.method_1826.");
  if (matches.length > 1) {
    throw new PatchError(`${matches.length} Charon's Blades pushes in Entity.method_1826; refusing to guess.`);
  }
  return matches[0];
}

/** One `customArts.push(new CustomArt(file, set))`. */
function pushCustomArt(anchor: SeekingBladesPush, setString: number): Emitted[] {
  return [
    { opcode: OP.getlocal, operands: [["u30", anchor.customArtsLocal]], push: 1 },
    { opcode: OP.findpropstrict, operands: [["u30", anchor.customArtMn]], push: 1 },
    { opcode: OP.pushstring, operands: [["u30", anchor.artFileString]], push: 1 },
    { opcode: OP.pushstring, operands: [["u30", setString]], push: 1 },
    { opcode: OP.constructprop, operands: [["u30", anchor.customArtMn], ["u30", 2]], pop: 3, push: 1 },
    { opcode: OP.callpropvoid, operands: [["u30", anchor.pushMn], ["u30", 1]], pop: 2 },
  ];
}

function entityProgram(anchor: SeekingBladesPush, reads: LevelReads, str: Str): Emitted[] {
  const tag = "art";
  const out: Emitted[] = [...wantedLevel(reads, tag)];

  HOT_SETS.forEach((_set, index) => {
    out.push(
      { opcode: OP.dup, push: 1 },
      { opcode: OP.pushbyte, operands: [["s8", index + 1]], push: 1 },
      { opcode: OP.ifeq, branchTo: `${tag}:push${index + 1}`, pop: 2 },
    );
  });
  // level 0 keeps the stock steel blades, so nothing is pushed
  out.push({ opcode: OP.pop, pop: 1 }, { opcode: OP.jump, branchTo: `${tag}:done` });

  HOT_SETS.forEach((set, index) => {
    out.push(
      { label: `${tag}:push${index + 1}` },
      { opcode: OP.pop, pop: 1 },
      ...pushCustomArt(anchor, str(set.sword)),
      ...pushCustomArt(anchor, str(set.offhand)),
      { opcode: OP.jump, branchTo: `${tag}:done` },
    );
  });
  out.push({ label: `${tag}:done` });
  return out;
}

// --- injection 3: re-bake when the level moves ------------------------------

interface TickNames extends ArtNames {
  var_3: number;
  var_39: number;
  resetEntType: number;
  class_14: number;
  powerTypesDict: number;
  powerID: number;
}

function tickProgram(names: TickNames, reads: LevelReads, str: Str): Emitted[] {
  const tag = "tick";
  return [
    // Charon's Blades only.
    { opcode: OP.getlocal0, push: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.var_39]], pop: 1, push: 1 },
    { opcode: OP.getlex, operands: [["u30", names.class_14]], push: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.powerTypesDict]], pop: 1, push: 1 },
    { opcode: OP.pushstring, operands: [["u30", str("SeekingBlades1")]], push: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.runtimeIndex]], pop: 2, push: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.powerID]], pop: 1, push: 1 },
    { opcode: OP.ifne, branchTo: `${tag}:done`, pop: 2 },

    ...wantedLevel(reads, tag),
    ...builtLevel([{ opcode: OP.getlocal0, push: 1 }, { opcode: OP.getproperty, operands: [["u30", names.var_3]], pop: 1, push: 1 }], names, str, tag),

    // [wanted, built] -- a no-op on every tick that is not a crossing
    { opcode: OP.ifeq, branchTo: `${tag}:done`, pop: 2 },
    { opcode: OP.getlocal0, push: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.var_3]], pop: 1, push: 1 },
    { opcode: OP.getlocal0, push: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.var_3]], pop: 1, push: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.entType]], pop: 1, push: 1 },
    { opcode: OP.callpropvoid, operands: [["u30", names.resetEntType], ["u30", 1]], pop: 2 },
    { label: `${tag}:done` },
  ];
}

// --- body plumbing ----------------------------------------------------------

/**
 * `getlocal0; pushscope` establishes the scope stack; a getlex before it throws.
 * Injecting straight after is the same anchor patch-dungeonblitz-daynight-clock
 * uses.
 */
function afterPrologue(target: Site): number {
  const list = target.instructions;
  for (let i = 0; i < list.length - 2; i += 1) {
    if (list[i].opcode === 0xd0 && list[i + 1].opcode === 0x30) return list[i + 2].offset;
  }
  throw new PatchError(`Could not find getlocal0/pushscope in ${target.label}.`);
}

/**
 * Exception ranges are offsets into the method's own code, so inserting bytes
 * ahead of one moves its end and its handler. parseAbc hands back the decoded
 * table but not the position of each field, so the whole table is re-emitted
 * between exception_count and trait_count.
 */
function shiftExceptions(ctx: SwfContext, target: Site, insertAt: number, delta: number): BytePatch[] {
  const body = target.body;
  if (body.exceptionCount === 0) return [];
  const [, entriesStart] = readU30(ctx.body, body.exceptionCountPos, `${target.label}.exception_count`);
  const shift = (offset: number): number => (offset >= insertAt ? offset + delta : offset);
  const chunks: Buffer[] = [];
  for (const entry of body.exceptions) {
    chunks.push(
      writeU30(shift(entry.from)),
      writeU30(shift(entry.to)),
      writeU30(shift(entry.target)),
      writeU30(entry.type),
      writeU30(entry.name),
    );
  }
  return [{
    key: `${target.label}.exceptions`,
    start: entriesStart,
    end: body.traitsCountPos,
    data: Buffer.concat(chunks),
    detail: `shift ${body.exceptionCount} exception range(s) by ${delta}`,
  }];
}

/**
 * Splices a block in and emits every body field that has to move with it:
 * code_length, the exception table, and max_stack when the block needs more
 * headroom than the method declared.
 */
/**
 * Insert at a point other branches already jump to, making them land on the
 * *front* of the new block rather than skipping over it.
 *
 * spliceAndAdjustBranches refuses this case, and rightly so in general: whether
 * such a branch should run the block or skip it is not something it can know.
 * Here it is: the injection point is the tail of the SeekingBlades arm, and the
 * branches that reach it are the arm's own internal skips, so every path through
 * the arm must push a blade pair.
 */
function spliceAtSharedTarget(originalCode: Buffer, instructions: Instruction[], at: number, data: Buffer): Buffer {
  const patched = Buffer.concat([originalCode.subarray(0, at), data, originalCode.subarray(at)]);
  const delta = data.length;
  // An instruction at `at` moves; a branch *target* of `at` stays, so it lands on
  // the block. No target can fall strictly inside the insertion, since `at` is an
  // instruction boundary.
  const shiftPos = (offset: number): number => (offset >= at ? offset + delta : offset);
  const shiftTarget = (offset: number): number => (offset > at ? offset + delta : offset);

  for (const inst of instructions) {
    if (!isBranchOpcode(inst.opcode)) continue;
    const branch = inst.operands[0];
    if (branch[0] !== "s24") throw new PatchError(`Unexpected branch operand at ${inst.offset}`);
    const oldEnd = inst.offset + inst.size;
    const newEnd = shiftPos(inst.offset) + inst.size;
    writeS24(shiftTarget(oldEnd + branch[1]) - newEnd).copy(patched, shiftPos(inst.offset) + 1);
  }
  return patched;
}

function inject(
  ctx: SwfContext,
  target: Site,
  at: number,
  block: Buffer,
  detail: string,
  sharedTarget = false,
): BytePatch[] {
  const code = sharedTarget
    ? spliceAtSharedTarget(target.code, target.instructions, at, block)
    : spliceAndAdjustBranches(target.code, target.instructions, at, at, block);
  const [maxStack, maxStackEnd] = readU30(ctx.body, target.body.maxStackPos, `${target.label}.max_stack`);
  const [, codeLenEnd] = readU30(ctx.body, target.body.codeLenPos, `${target.label}.code_length`);

  const patches: BytePatch[] = [
    {
      key: `${target.label}.code_length`,
      start: target.body.codeLenPos,
      end: codeLenEnd,
      data: writeU30(code.length),
      detail: `code_length -> ${code.length}`,
    },
    {
      key: `${target.label}.code`,
      start: target.body.codeStart,
      end: target.body.codeStart + target.body.codeLen,
      data: code,
      detail,
    },
    ...shiftExceptions(ctx, target, at, block.length),
  ];

  // The block is stack-neutral but transiently needs STACK_BUDGET slots on top of
  // whatever the surrounding expression is already holding, and injection 1 lands
  // mid-expression. Raising the ceiling is safe; lowering it would not be.
  const needed = maxStack + STACK_BUDGET;
  patches.push({
    key: `${target.label}.max_stack`,
    start: target.body.maxStackPos,
    end: maxStackEnd,
    data: writeU30(needed),
    detail: `max_stack ${maxStack} -> ${needed}`,
  });
  return patches;
}

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") swfPath = path.resolve(argv[++index] || "");
    else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else if (arg === "--diagnose") DIAGNOSE = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: ts-node patch-dungeonblitz-charon-blades-phases.ts [--verify] [--swf <path>]\n" +
        "Ramps the Viperblade's blades through four heat levels while Charon's Blades is up.",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify };
}

/**
 * StaticServer.clientRevision derives the same token as `swf-<sha1[0:12]>` and redirects any
 * DungeonBlitz.swf request whose clientrev does not match, so the `swf-` prefix is part of the
 * value rather than decoration -- writing the bare digest costs every load a redirect.
 */
function syncClientRev(swfPath: string): void {
  const indexPath = path.resolve(path.dirname(swfPath), "..", "..", "index.html");
  if (path.resolve(swfPath) !== DEFAULT_SWF || !fs.existsSync(indexPath)) {
    console.log("  not the served DungeonBlitz.swf; bump the clientrev token by hand.");
    return;
  }
  const digest = crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
  const html = fs.readFileSync(indexPath, "utf8");
  const updated = html.replace(/clientrev=[A-Za-z0-9._-]+/, `clientrev=swf-${digest}`);
  if (updated === html) {
    console.log("  no clientrev token in index.html; players may keep a cached SWF.");
    return;
  }
  fs.writeFileSync(indexPath, updated);
  console.log(`  clientrev -> swf-${digest}`);
}

function main(): number {
  const { swfPath, verify } = parseArgs(process.argv);
  try {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const pool = parsePool(ctx);

    const activation = site(ctx, abc, "Entity", "method_391");
    const artBuild = site(ctx, abc, "Entity", "method_1826");
    const tick = site(ctx, abc, "CombatState", "method_960");

    const marker = HOT_SETS[0].sword;
    const already = artBuild.instructions.some(
      (inst) => inst.opcode === OP.pushstring && pool.strings[inst.operands[0][1]] === marker,
    );
    if (already) {
      console.log(`${swfPath}: already patched (Charon's Blades heat ramp present).`);
      if (!verify) syncClientRev(swfPath);
      return 0;
    }
    if (verify) {
      throw new PatchError(`${swfPath}: verify failed; the Charon's Blades blades never heat up.`);
    }

    const wantedStrings = HOT_SETS.flatMap((set) => [set.sword, set.offhand]);
    const { indexOf, patches: stringPatches } = appendStrings(pool, wantedStrings);
    const str: Str = (value) => {
      const appended = indexOf.get(value);
      if (appended !== undefined) return appended;
      const existing = pool.strings.indexOf(value);
      if (existing > 0) return existing;
      throw new PatchError(`String "${value}" was never resolved`);
    };

    const entityMn = {
      var_31: operandInClass(ctx, abc, "Entity", OP.getproperty, "var_31"),
      var_1: operandInClass(ctx, abc, "Entity", OP.getproperty, "var_1"),
      combatState: operandInClass(ctx, abc, "Entity", OP.getproperty, "combatState"),
      entType: operandInClass(ctx, abc, "Entity", OP.getproperty, "entType"),
      gfxType: operandInClass(ctx, abc, "Entity", OP.getproperty, "gfxType"),
      customArts: operandInClass(ctx, abc, "Entity", OP.getproperty, "customArts"),
      resetEntType: operandInClass(ctx, abc, "Entity", OP.callpropvoid, "ResetEntType"),
    };
    const tickMn = {
      var_3: operandIn(tick, OP.getproperty, abc, "var_3"),
      var_39: operandIn(tick, OP.getproperty, abc, "var_39"),
      var_31: operandIn(tick, OP.getproperty, abc, "var_31"),
      var_1: operandIn(tick, OP.getproperty, abc, "var_1"),
      var_1435: operandIn(tick, OP.getproperty, abc, "var_1435"),
      mTimeThisTick: operandIn(tick, OP.getproperty, abc, "mTimeThisTick"),
      length: operandIn(tick, OP.getproperty, abc, "length"),
      powerTypesDict: operandIn(tick, OP.getproperty, abc, "powerTypesDict"),
      class_14: operandIn(tick, OP.getlex, abc, "class_14"),
    };
    const setName = operandInClass(ctx, abc, "SuperAnimData", OP.getproperty, "setName");
    const tickIdiom = findDictIdiom(tick, abc);
    const artIdiom = findDictIdiom(artBuild, abc);

    // 1 -- restamp the stopwatch on activation
    const stampBlock = assemble(stampProgram({
      combatState: entityMn.combatState,
      var_1435: tickMn.var_1435,
      var_1: entityMn.var_1,
      mTimeThisTick: tickMn.mTimeThisTick,
    }));
    const stampAt = findActivationWrite(activation, abc, pool);

    // 2 -- the blade pair for the wanted level
    const anchor = findSeekingBladesPush(artBuild, abc, pool);
    const artReads: LevelReads = {
      mana: read(entityMn.var_31),
      now: read(entityMn.var_1, tickMn.mTimeThisTick),
      stamp: read(entityMn.combatState, tickMn.var_1435),
    };
    const artBlock = assemble(entityProgram(anchor, artReads, str));

    // 3 -- re-bake when the level moves
    const tickReads: LevelReads = {
      mana: read(tickMn.var_3, tickMn.var_31),
      now: read(tickMn.var_1, tickMn.mTimeThisTick),
      stamp: read(tickMn.var_1435),
    };
    const tickBlock = assemble(tickProgram({
      var_3: tickMn.var_3,
      var_39: tickMn.var_39,
      entType: entityMn.entType,
      gfxType: entityMn.gfxType,
      customArts: entityMn.customArts,
      setName,
      length: tickMn.length,
      runtimeIndex: tickIdiom.runtimeIndex,
      powerTypesDict: tickMn.powerTypesDict,
      powerID: tickIdiom.powerID,
      resetEntType: entityMn.resetEntType,
      class_14: tickMn.class_14,
    }, tickReads, str));
    const tickAt = afterPrologue(tick);

    void artIdiom; // the art build reads no dictionary of its own

    const patches: BytePatch[] = [
      ...stringPatches,
      ...inject(ctx, activation, stampAt, stampBlock, "restamp the ramp stopwatch on activation"),
      ...inject(ctx, artBuild, anchor.injectAt, artBlock, "push the blade pair for the wanted heat level", true),
      ...inject(ctx, tick, tickAt, tickBlock, "re-bake the blades when the heat level moves"),
    ];

    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, body, delta);

    console.log(`${swfPath}: patched the Charon's Blades heat ramp (${HOT_SETS.length} levels).`);
    console.log(`  Entity.method_391       +${stampBlock.length} bytes at ${stampAt}`);
    console.log(`  Entity.method_1826      +${artBlock.length} bytes at ${anchor.injectAt} (customArts in local ${anchor.customArtsLocal})`);
    console.log(`  CombatState.method_960  +${tickBlock.length} bytes at ${tickAt}`);
    syncClientRev(swfPath);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exit(main());
