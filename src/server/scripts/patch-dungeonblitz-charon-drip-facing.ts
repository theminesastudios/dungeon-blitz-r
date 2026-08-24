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
 * Mirrors the Charon's Blades blood drip with the character's facing.
 *
 * The drip animation (patch-sfx1-charon-blood-drip) puts a stream under each
 * blade tip, and the two blades point opposite ways: the long one out front, the
 * short one back the other side. Those offsets are large and asymmetric, so the
 * animation is only correct for one facing.
 *
 * Buff visuals are added to playerEntLayer rather than parented to the entity,
 * so they do not inherit its flip -- Buff does it by hand for the one effect that
 * needs it (`if (this.var_4.bFacingLeft()) m_TheDO.scaleX *= -1` on the Blink
 * particles). This does the same for the drip, but in UpdatePos rather than at
 * creation, so it tracks a character who turns around mid-form.
 *
 * The gate is the buff's own art rather than its name: any buff whose GfxType
 * animClass is the drip gets mirrored. That keeps this patch and the swz wiring
 * from having to agree on a buff name, and it needs only `type`, `gfxType` and
 * `animClass`, all of which Buff already reads -- no buffTypesDict lookup and no
 * runtime-keyed multiname.
 *
 * The emitted block is stack-neutral and branches forward only; assemble() walks
 * it the way the player's verifier will before a byte is written.
 */

const DEFAULT_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf",
);

/** Keep in step with HOST_CLASS in patch-sfx1-charon-blood-drip.js. */
const DRIP_ANIM_CLASS = "a_Conflagration_old";

/** Every emitted block here stays well under this; assemble() enforces it. */
const STACK_BUDGET = 12;
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
 * Multiname operands are lifted out of code that already touches the property.
 * Most of these are PackageInternalNs, so "the index this class itself uses" is
 * the only definition that cannot pick the wrong namespace.
 */
function operandInClass(ctx: SwfContext, abc: Abc, className: string, opcodes: number[], name: string): number {
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
      continue; // lookupswitch and friends; another method will have the read
    }
    for (const inst of instructions) {
      if (opcodes.includes(inst.opcode) && u30OperandName(inst, abc.multinameNames) === name) {
        hits.add(inst.operands[0][1]);
      }
    }
  }
  if (hits.size === 0) throw new PatchError(`No reference to "${name}" in ${className}.`);
  if (hits.size > 1) {
    throw new PatchError(`"${name}" resolves to ${hits.size} multinames in ${className}; refusing to guess.`);
  }
  return [...hits][0];
}

interface Names {
  gfxType: number;
  animClass: number;
  var_4: number;
  bFacingLeft: number;
  m_TheDO: number;
  scaleX: number;
  instances: number[];
}

/**
 * `inst.m_TheDO.scaleX = facingLeft ? -1 : 1`, guarded at every hop.
 *
 * UpdatePos runs every frame for every buff on every entity, and a buff can be
 * mid-teardown with its instance or its display object already gone, so an
 * unguarded chain here would be a #1009 in the common path rather than a rare
 * one.
 */
function mirrorInstance(names: Names, instanceField: number, tag: string): Emitted[] {
  return [
    { opcode: OP.getlocal0, push: 1 },
    { opcode: OP.getproperty, operands: [["u30", instanceField]], pop: 1, push: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: `${tag}:drop`, pop: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.m_TheDO]], pop: 1, push: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: `${tag}:drop`, pop: 1 },

    // [DO] -- var_4 is guarded too: a buff can outlive its entity for a frame,
    // and calling a method on null here would be a #1009 in the hottest path in
    // the client rather than a rare one.
    { opcode: OP.getlocal0, push: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.var_4]], pop: 1, push: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: `${tag}:dropBoth`, pop: 1 },
    { opcode: OP.callproperty, operands: [["u30", names.bFacingLeft], ["u30", 0]], pop: 1, push: 1 },
    { opcode: OP.iffalse, branchTo: `${tag}:right`, pop: 1 },
    { opcode: OP.pushbyte, operands: [["s8", -1]], push: 1 },
    { opcode: OP.setproperty, operands: [["u30", names.scaleX]], pop: 2 },
    { opcode: OP.jump, branchTo: `${tag}:done` },

    { label: `${tag}:right` },
    { opcode: OP.pushbyte, operands: [["s8", 1]], push: 1 },
    { opcode: OP.setproperty, operands: [["u30", names.scaleX]], pop: 2 },
    { opcode: OP.jump, branchTo: `${tag}:done` },

    // the null var_4 sits on top of the display object
    { label: `${tag}:dropBoth` },
    { opcode: OP.pop, pop: 1 },
    // a null hop left its own value on the stack
    { label: `${tag}:drop` },
    { opcode: OP.pop, pop: 1 },
    { label: `${tag}:done` },
  ];
}

function facingProgram(names: Names, dripString: number): Emitted[] {
  const out: Emitted[] = [
    // Only the buff carrying the drip art.
    //
    // `this.gfxType`, not `this.type.gfxType`: the resolved GfxType is a field on
    // Buff itself, which sets it from `this.type.var_306[this.var_666]`. BuffType
    // stores its own as `var_1035` and has no `gfxType` at all, so reading it off
    // the type raised ReferenceError #1069 on the first buff to update its
    // position -- which is any mount or any hit.
    { opcode: OP.getlocal0, push: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.gfxType]], pop: 1, push: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "gate:drop", pop: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.animClass]], pop: 1, push: 1 },
    { opcode: OP.pushstring, operands: [["u30", dripString]], push: 1 },
    { opcode: OP.ifne, branchTo: "gate:done", pop: 2 },
  ];

  names.instances.forEach((field, index) => {
    out.push(...mirrorInstance(names, field, `inst${index}`));
  });
  out.push({ opcode: OP.jump, branchTo: "gate:done" });

  out.push(
    { label: "gate:drop" },
    { opcode: OP.pop, pop: 1 },
    { label: "gate:done" },
  );
  return out;
}

/**
 * The front of the method.
 *
 * Where a method opens with `getlocal0; pushscope` the block has to go after it,
 * because a getlex before the scope stack is set up throws. UpdatePos does not:
 * it establishes no scope of its own, and searching the whole body for that pair
 * found one buried deep inside and spliced the block in halfway through
 * unrelated logic. The emitted block only uses getlocal0/getproperty/callproperty
 * and never getlex, so offset 0 is correct here -- and `init_scope_depth` means
 * the caller's scopes are present anyway.
 */
function methodEntry(target: Site): number {
  const list = target.instructions;
  if (list.length >= 2 && list[0].opcode === 0xd0 && list[1].opcode === 0x30) {
    return list[2].offset;
  }
  return 0;
}

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

function inject(ctx: SwfContext, target: Site, at: number, block: Buffer, detail: string): BytePatch[] {
  const code = spliceAndAdjustBranches(target.code, target.instructions, at, at, block);
  const [maxStack, maxStackEnd] = readU30(ctx.body, target.body.maxStackPos, `${target.label}.max_stack`);
  const [, codeLenEnd] = readU30(ctx.body, target.body.codeLenPos, `${target.label}.code_length`);
  const needed = maxStack + STACK_BUDGET;

  return [
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
    {
      key: `${target.label}.max_stack`,
      start: target.body.maxStackPos,
      end: maxStackEnd,
      data: writeU30(needed),
      detail: `max_stack ${maxStack} -> ${needed}`,
    },
  ];
}

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--swf" || arg === "-s") swfPath = path.resolve(argv[++i] || "");
    else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: ts-node patch-dungeonblitz-charon-drip-facing.ts [--verify] [--swf <path>]\n" +
        "Mirrors the Charon's Blades blood drip with the character's facing.",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify };
}

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

    const target = site(ctx, abc, "Buff", "UpdatePos");

    const already = target.instructions.some(
      (inst) => inst.opcode === OP.pushstring && pool.strings[inst.operands[0][1]] === DRIP_ANIM_CLASS,
    );
    if (already) {
      console.log(`${swfPath}: already patched (drip mirrors with facing).`);
      if (!verify) syncClientRev(swfPath);
      return 0;
    }
    if (verify) {
      throw new PatchError(`${swfPath}: verify failed; the drip never mirrors with facing.`);
    }

    const { indexOf, patches: stringPatches } = appendStrings(pool, [DRIP_ANIM_CLASS]);
    const dripString = indexOf.get(DRIP_ANIM_CLASS);
    if (dripString === undefined) throw new PatchError("Drip class string was never resolved");

    const names: Names = {
      gfxType: operandInClass(ctx, abc, "Buff", [OP.getproperty], "gfxType"),
      animClass: operandInClass(ctx, abc, "Buff", [OP.getproperty, OP.setproperty], "animClass"),
      var_4: operandInClass(ctx, abc, "Buff", [OP.getproperty], "var_4"),
      bFacingLeft: operandInClass(ctx, abc, "Buff", [OP.callproperty], "bFacingLeft"),
      m_TheDO: operandInClass(ctx, abc, "Buff", [OP.getproperty], "m_TheDO"),
      scaleX: operandInClass(ctx, abc, "Buff", [OP.getproperty, OP.setproperty], "scaleX"),
      instances: [
        operandInClass(ctx, abc, "Buff", [OP.getproperty], "var_283"),
        operandInClass(ctx, abc, "Buff", [OP.getproperty], "var_176"),
      ],
    };

    const block = assemble(facingProgram(names, dripString));
    const at = methodEntry(target);

    const patches: BytePatch[] = [
      ...stringPatches,
      ...inject(ctx, target, at, block, "mirror the blood drip with the character's facing"),
    ];

    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, body, delta);

    console.log(`${swfPath}: patched Buff.UpdatePos (+${block.length} bytes at ${at}).`);
    syncClientRev(swfPath);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exit(main());
