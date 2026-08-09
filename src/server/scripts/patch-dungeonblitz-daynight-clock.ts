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
 * A day/night readout in the top-right HUD.
 *
 * The keep runs the engine's own day/night cycle (see
 * patch-dungeonblitz-home-night-mode.ts) but nothing on screen says which phase
 * is running or how long is left, so the change reads as random weather. This
 * adds a line under the gold counter -- "Day -> Night 23:41" -- that ticks down
 * to the next major phase.
 *
 * It lives in class_70 ("a_HudTopRight") because that screen already owns the
 * top-right corner and already has a per-frame hook, OnTickScreen. The field is
 * created once, found again on later ticks by child name, and takes its font,
 * outline and geometry from the existing am_Gold field so it matches the HUD
 * without hardcoding any coordinates.
 */

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
const INDEX_HTML = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "index.html");

const CLOCK_CHILD_NAME = "am_DayNightClock";
const HOME_LEVEL_NAME = "CraftTown";
const AUTO_SIZE_RIGHT = "right"; // TextFieldAutoSize.RIGHT

// Seconds per time-of-day slot and slots per cycle, straight out of
// DayNightManager: TIME_PER_CYCLE = 7200 / 8 and mServerGameTime is unix seconds.
const SECONDS_PER_SLOT = 900;
const SLOT_COUNT = 8;

/**
 * Per slot: the label to show, and how many slots (including this one) run
 * before that label's target arrives. Must stay in step with KEEP_CYCLE in
 * patch-dungeonblitz-home-night-mode.ts -- [Morning, Day, Day, Day, Evening,
 * Night, Night, Night].
 *
 * The countdown deliberately skips the short transition phases and targets the
 * next *major* one: standing in daylight, what a player wants to know is how
 * long until night, not how long until dusk. So Day counts through Evening to
 * Night (up to 4 slots = 60:00) and Night counts through Morning to Day.
 */
const SLOT_TABLE: Array<{ label: string; slotsLeft: number }> = [
  { label: "Morning → Day ", slotsLeft: 1 },
  { label: "Day → Night ", slotsLeft: 4 },
  { label: "Day → Night ", slotsLeft: 3 },
  { label: "Day → Night ", slotsLeft: 2 },
  { label: "Evening → Night ", slotsLeft: 1 },
  { label: "Night → Day ", slotsLeft: 4 },
  { label: "Night → Day ", slotsLeft: 3 },
  { label: "Night → Day ", slotsLeft: 2 },
];

// Scratch locals appended past the method's own localcount (7).
const L_CLIP = 7;
const L_REF = 8;
const L_CLOCK = 9;
const L_GAME = 10;
const L_TIME = 11;
const L_SLOT = 12;
const L_RUN = 13;
const L_REM = 14;
const L_SEC = 15;
const L_LABEL = 16;
const NEW_LOCAL_COUNT = 17;
const NEW_MAX_STACK = 10;

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
} as const;

type Operand = [Instruction["operands"][number][0], number];
type Emitted =
  | { label: string }
  | { opcode: number; operands?: Operand[]; branchTo?: string; pop?: number; push?: number };

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
        "  ts-node src/server/scripts/patch-dungeonblitz-daynight-clock.ts [--verify] [--swf <path>]",
        "",
        "Adds a day/night phase readout with a countdown to the top-right HUD",
        "(class_70 / a_HudTopRight), visible while standing in the player keep.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function syncClientRev(swfPath: string): void {
  if (path.resolve(swfPath) !== DEFAULT_SWF || !fs.existsSync(INDEX_HTML)) {
    return;
  }
  const digest = crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const updated = html.replace(/clientrev=[^&`"'$]+/, `clientrev=swf-${digest}`);
  if (updated !== html) {
    fs.writeFileSync(INDEX_HTML, updated);
    console.log(`  index.html clientrev -> swf-${digest} (cache buster)`);
  }
}

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

/**
 * Assembles the block and, on the way, checks it the way the player's verifier
 * will: every path reaching a label must arrive with the same operand stack
 * depth, and the block must leave the stack exactly as it found it. FFDec will
 * happily decompile a block that fails this; the player throws VerifyError.
 */
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
  if (maxDepth + 4 > NEW_MAX_STACK) {
    throw new PatchError(`Emitted block needs stack ${maxDepth}, budget is ${NEW_MAX_STACK}`);
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

/**
 * Splices `data` over [replaceStart, replaceEnd) -- an insertion when the two are
 * equal, a swap of a previously injected block otherwise -- and repoints every
 * branch in the surrounding method.
 */
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

/**
 * End of a block injected by an earlier run, so re-running swaps the block
 * instead of stacking another one in front of it. The block always ends with its
 * hide path: `pushfalse; setproperty visible; jump end; pop;` where `end` is the
 * instruction right after that final pop.
 */
function findInjectedBlockEnd(
  instructions: Instruction[],
  abc: ReturnType<typeof parseAbc>,
  blockStart: number,
): number {
  for (let index = 0; index < instructions.length - 3; index += 1) {
    const [pushFalse, setVisible, jump, pop] = instructions.slice(index, index + 4);
    if (pushFalse.offset < blockStart) {
      continue;
    }
    if (
      pushFalse.opcode === OP.pushfalse &&
      setVisible.opcode === OP.setproperty &&
      u30OperandName(setVisible, abc.multinameNames) === "visible" &&
      jump.opcode === OP.jump &&
      pop.opcode === OP.pop &&
      jump.offset + jump.size + jump.operands[0][1] === pop.offset + pop.size
    ) {
      return pop.offset + pop.size;
    }
  }
  throw new PatchError("Found an injected clock block but not its end; refusing to guess.");
}

const getlocal = (index: number): Emitted =>
  index <= 3
    ? { opcode: 0xd0 + index, push: 1 }
    : { opcode: OP.getlocal, operands: [["u30", index]], push: 1 };
const setlocal = (index: number): Emitted =>
  index <= 3
    ? { opcode: 0xd4 + index, pop: 1 }
    : { opcode: OP.setlocal, operands: [["u30", index]], pop: 1 };

interface Names {
  var_1: number;
  var_2: number;
  am_Gold: number;
  level: number;
  internalName: number;
  mServerGameTime: number;
  textField: number;
  getChildByName: number;
  addChild: number;
  getTextFormat: number;
  name: number;
  selectable: number;
  mouseEnabled: number;
  embedFonts: number;
  defaultTextFormat: number;
  filters: number;
  x: number;
  y: number;
  width: number;
  height: number;
  autoSize: number;
  visible: number;
  text: number;
}

function clockProgram(names: Names, str: (value: string) => number): Emitted[] {
  const get = (mn: number): Emitted => ({ opcode: OP.getproperty, operands: [["u30", mn]], pop: 1, push: 1 });
  const set = (mn: number): Emitted => ({ opcode: OP.setproperty, operands: [["u30", mn]], pop: 2 });
  const pushString = (value: string): Emitted => ({
    opcode: OP.pushstring,
    operands: [["u30", str(value)]],
    push: 1,
  });
  const refProp = (mn: number): Emitted[] => [getlocal(L_REF), get(mn)];

  const program: Emitted[] = [
    // clip = var_2 (the a_HudTopRight MovieClip); nothing to do before it exists.
    { opcode: OP.getlex, operands: [["u30", names.var_2]], push: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "dropOne", pop: 1 },
    setlocal(L_CLIP),

    // ref = clip.am_Gold -- the field we copy our look and position from.
    getlocal(L_CLIP),
    get(names.am_Gold),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "dropOne", pop: 1 },
    setlocal(L_REF),

    // clock = clip.getChildByName("am_DayNightClock")
    getlocal(L_CLIP),
    pushString(CLOCK_CHILD_NAME),
    { opcode: OP.callproperty, operands: [["u30", names.getChildByName], ["u30", 1]], pop: 2, push: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "create", pop: 1 },
    // Coerce on both paths so the local has one static type at the merge.
    { opcode: OP.coerce, operands: [["u30", names.textField]] },
    setlocal(L_CLOCK),
    { opcode: OP.jump, branchTo: "have" },

    { label: "create" },
    { opcode: OP.pop, pop: 1 },
    { opcode: OP.findpropstrict, operands: [["u30", names.textField]], push: 1 },
    { opcode: OP.constructprop, operands: [["u30", names.textField], ["u30", 0]], pop: 1, push: 1 },
    { opcode: OP.coerce, operands: [["u30", names.textField]] },
    setlocal(L_CLOCK),

    getlocal(L_CLOCK),
    pushString(CLOCK_CHILD_NAME),
    set(names.name),
    getlocal(L_CLOCK),
    { opcode: OP.pushfalse, push: 1 },
    set(names.selectable),
    getlocal(L_CLOCK),
    { opcode: OP.pushfalse, push: 1 },
    set(names.mouseEnabled),
    // Device font: an embedded font from the UI SWF would not resolve for a
    // TextField built in this SWF's context, and the text would come out blank.
    getlocal(L_CLOCK),
    { opcode: OP.pushfalse, push: 1 },
    set(names.embedFonts),

    // Font, size, colour, alignment and outline, straight off the gold counter.
    getlocal(L_CLOCK),
    getlocal(L_REF),
    { opcode: OP.callproperty, operands: [["u30", names.getTextFormat], ["u30", 0]], pop: 1, push: 1 },
    set(names.defaultTextFormat),
    getlocal(L_CLOCK),
    ...refProp(names.filters),
    set(names.filters),

    // Directly under the gold row, starting from the gold field's box...
    getlocal(L_CLOCK),
    ...refProp(names.x),
    set(names.x),
    getlocal(L_CLOCK),
    ...refProp(names.y),
    ...refProp(names.height),
    { opcode: OP.add, pop: 2, push: 1 },
    set(names.y),
    getlocal(L_CLOCK),
    ...refProp(names.width),
    set(names.width),
    // ...but the line is wider than a gold amount, so let it size itself. RIGHT
    // pins the right edge (the corner the HUD is anchored to) and grows the
    // field leftwards into open screen instead of clipping the text.
    getlocal(L_CLOCK),
    pushString(AUTO_SIZE_RIGHT),
    set(names.autoSize),

    getlocal(L_CLIP),
    getlocal(L_CLOCK),
    { opcode: OP.callpropvoid, operands: [["u30", names.addChild], ["u30", 1]], pop: 2 },

    { label: "have" },
    // Only the keep runs a cycle, so only the keep gets a clock.
    { opcode: OP.getlex, operands: [["u30", names.var_1]], push: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "hideOne", pop: 1 },
    setlocal(L_GAME),
    getlocal(L_GAME),
    get(names.level),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "hideOne", pop: 1 },
    get(names.internalName),
    pushString(HOME_LEVEL_NAME),
    { opcode: OP.ifne, branchTo: "hide", pop: 2 },

    getlocal(L_CLOCK),
    { opcode: OP.pushtrue, push: 1 },
    set(names.visible),

    // slot = (mServerGameTime / SECONDS_PER_SLOT) % SLOT_COUNT
    getlocal(L_GAME),
    get(names.mServerGameTime),
    { opcode: OP.convert_u },
    setlocal(L_TIME),
    getlocal(L_TIME),
    { opcode: OP.pushshort, operands: [["u30", SECONDS_PER_SLOT]], push: 1 },
    { opcode: OP.divide, pop: 2, push: 1 },
    { opcode: OP.convert_u },
    { opcode: OP.pushbyte, operands: [["s8", SLOT_COUNT]], push: 1 },
    { opcode: OP.modulo, pop: 2, push: 1 },
    { opcode: OP.convert_u },
    setlocal(L_SLOT),
    getlocal(L_SLOT),
  ];

  // slot -> label + how many slots are left in this phase.
  for (let slot = 0; slot < SLOT_TABLE.length - 1; slot += 1) {
    program.push({ opcode: OP.dup, push: 1 });
    program.push({ opcode: OP.pushbyte, operands: [["s8", slot]], push: 1 });
    program.push({ opcode: OP.ifeq, branchTo: `slot${slot}`, pop: 2 });
  }
  const last = SLOT_TABLE.length - 1;
  program.push({ opcode: OP.pop, pop: 1 });
  program.push(pushString(SLOT_TABLE[last].label));
  program.push(setlocal(L_LABEL));
  program.push({ opcode: OP.pushbyte, operands: [["s8", SLOT_TABLE[last].slotsLeft]], push: 1 });
  program.push(setlocal(L_RUN));
  program.push({ opcode: OP.jump, branchTo: "slotDone" });
  for (let slot = 0; slot < SLOT_TABLE.length - 1; slot += 1) {
    program.push({ label: `slot${slot}` });
    program.push({ opcode: OP.pop, pop: 1 });
    program.push(pushString(SLOT_TABLE[slot].label));
    program.push(setlocal(L_LABEL));
    program.push({ opcode: OP.pushbyte, operands: [["s8", SLOT_TABLE[slot].slotsLeft]], push: 1 });
    program.push(setlocal(L_RUN));
    program.push({ opcode: OP.jump, branchTo: "slotDone" });
  }

  program.push(
    { label: "slotDone" },
    // remaining = slotsLeft * SECONDS_PER_SLOT - (time % SECONDS_PER_SLOT)
    getlocal(L_RUN),
    { opcode: OP.pushshort, operands: [["u30", SECONDS_PER_SLOT]], push: 1 },
    { opcode: OP.multiply, pop: 2, push: 1 },
    getlocal(L_TIME),
    { opcode: OP.pushshort, operands: [["u30", SECONDS_PER_SLOT]], push: 1 },
    { opcode: OP.modulo, pop: 2, push: 1 },
    { opcode: OP.subtract, pop: 2, push: 1 },
    { opcode: OP.convert_i },
    setlocal(L_REM),
    getlocal(L_REM),
    { opcode: OP.pushbyte, operands: [["s8", 60]], push: 1 },
    { opcode: OP.modulo, pop: 2, push: 1 },
    { opcode: OP.convert_i },
    setlocal(L_SEC),

    // clock.text = label + minutes + ":" + zero-padded seconds
    getlocal(L_CLOCK),
    getlocal(L_LABEL),
    getlocal(L_REM),
    { opcode: OP.pushbyte, operands: [["s8", 60]], push: 1 },
    { opcode: OP.divide, pop: 2, push: 1 },
    { opcode: OP.convert_i },
    { opcode: OP.add, pop: 2, push: 1 },
    pushString(":"),
    { opcode: OP.add, pop: 2, push: 1 },
    getlocal(L_SEC),
    { opcode: OP.pushbyte, operands: [["s8", 10]], push: 1 },
    { opcode: OP.greaterequals, pop: 2, push: 1 },
    { opcode: OP.iftrue, branchTo: "noPad", pop: 1 },
    pushString("0"),
    { opcode: OP.add, pop: 2, push: 1 },
    { label: "noPad" },
    getlocal(L_SEC),
    { opcode: OP.add, pop: 2, push: 1 },
    set(names.text),
    { opcode: OP.jump, branchTo: "end" },

    { label: "hideOne" },
    { opcode: OP.pop, pop: 1 },
    { label: "hide" },
    getlocal(L_CLOCK),
    { opcode: OP.pushfalse, push: 1 },
    set(names.visible),
    { opcode: OP.jump, branchTo: "end" },

    { label: "dropOne" },
    { opcode: OP.pop, pop: 1 },
    { label: "end" },
  );

  return program;
}

function findInjectionOffset(instructions: Instruction[]): number {
  for (let index = 0; index < instructions.length - 1; index += 1) {
    // getlocal0; pushscope -- everything before this runs on an empty scope
    // stack, where a getlex would blow up.
    if (instructions[index].opcode === 0xd0 && instructions[index + 1].opcode === 0x30) {
      return instructions[index + 2].offset;
    }
  }
  throw new PatchError("Could not find `getlocal0; pushscope` in class_70.OnTickScreen.");
}

function findOperandFor(instructions: Instruction[], abc: ReturnType<typeof parseAbc>, opcode: number, name: string): number {
  for (const inst of instructions) {
    if (inst.opcode === opcode && u30OperandName(inst, abc.multinameNames) === name) {
      return inst.operands[0][1];
    }
  }
  throw new PatchError(`Could not find a 0x${opcode.toString(16)} for "${name}" in class_70.OnTickScreen.`);
}

function findOperandInClass(
  ctx: SwfContext,
  abc: ReturnType<typeof parseAbc>,
  className: string,
  opcode: number,
  name: string,
): number {
  const classIndex = classIndexByName(abc, className);
  if (classIndex === null) {
    throw new PatchError(`Could not find ${className}.`);
  }
  for (const trait of abc.instances[classIndex].traits) {
    if (trait.methodIdx === null) {
      continue;
    }
    const body = abc.methodBodies.get(trait.methodIdx);
    if (!body) {
      continue;
    }
    let instructions: Instruction[];
    try {
      instructions = disassemble(ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen), className);
    } catch {
      continue;
    }
    for (const inst of instructions) {
      if (inst.opcode === opcode && u30OperandName(inst, abc.multinameNames) === name) {
        return inst.operands[0][1];
      }
    }
  }
  throw new PatchError(`Could not find a 0x${opcode.toString(16)} for "${name}" in ${className}.`);
}

function patchSwf(swfPath: string, verify: boolean): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const pool = parsePool(ctx);

  const classIndex = classIndexByName(abc, "class_70");
  if (classIndex === null) {
    throw new PatchError("Could not find class_70 (a_HudTopRight).");
  }
  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "OnTickScreen");
  if (methodIdx === null) {
    throw new PatchError("Could not find class_70.OnTickScreen.");
  }
  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError("Could not find the body of class_70.OnTickScreen.");
  }
  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, "class_70.OnTickScreen");

  const alreadyPatched = instructions.some(
    (inst) => inst.opcode === OP.pushstring && pool.strings[inst.operands[0][1]] === CLOCK_CHILD_NAME,
  );

  const wantedStrings = [
    CLOCK_CHILD_NAME,
    HOME_LEVEL_NAME,
    ":",
    "0",
    AUTO_SIZE_RIGHT,
    ...SLOT_TABLE.map((entry) => entry.label),
  ];
  const { indexOf, patches: stringPatches } = appendStrings(pool, wantedStrings);
  const str = (value: string): number => {
    const index = indexOf.get(value);
    if (index === undefined) {
      throw new PatchError(`String "${value}" was never resolved`);
    }
    return index;
  };

  const names: Names = {
    var_1: findOperandFor(instructions, abc, OP.getlex, "var_1"),
    var_2: findOperandInClass(ctx, abc, "class_70", OP.getlex, "var_2"),
    am_Gold: findOperandInClass(ctx, abc, "class_70", OP.getproperty, "am_Gold"),
    level: findOperandInClass(ctx, abc, "DayNightManager", OP.getproperty, "level"),
    internalName: findOperandInClass(ctx, abc, "Game", OP.getproperty, "internalName"),
    mServerGameTime: findOperandInClass(ctx, abc, "DayNightManager", OP.getproperty, "mServerGameTime"),
    textField: pool.qNameIn("flash.text", "TextField"),
    getChildByName: pool.publicQName("getChildByName"),
    addChild: pool.publicQName("addChild"),
    getTextFormat: pool.publicQName("getTextFormat"),
    name: pool.publicQName("name"),
    selectable: pool.publicQName("selectable"),
    mouseEnabled: pool.publicQName("mouseEnabled"),
    embedFonts: pool.publicQName("embedFonts"),
    defaultTextFormat: pool.publicQName("defaultTextFormat"),
    filters: pool.publicQName("filters"),
    x: pool.publicQName("x"),
    y: pool.publicQName("y"),
    width: pool.publicQName("width"),
    height: pool.publicQName("height"),
    autoSize: pool.publicQName("autoSize"),
    visible: pool.publicQName("visible"),
    text: pool.publicQName("text"),
  };

  const block = assemble(clockProgram(names, str));
  const blockStart = findInjectionOffset(instructions);
  // Re-running with different labels or a different table swaps the old block
  // out rather than leaving two clocks fighting over the same child.
  const blockEnd = alreadyPatched ? findInjectedBlockEnd(instructions, abc, blockStart) : blockStart;

  if (alreadyPatched && code.subarray(blockStart, blockEnd).equals(block)) {
    console.log(`${swfPath}: already patched (day/night clock present).`);
    if (!verify) {
      syncClientRev(swfPath);
    }
    return;
  }
  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; the day/night HUD clock is missing or stale.`);
  }

  const patchedCode = spliceAndAdjustBranches(code, instructions, blockStart, blockEnd, block);

  if (methodBody.maxScopeDepth < 6) {
    throw new PatchError(`Unexpected scope depth ${methodBody.maxScopeDepth} in class_70.OnTickScreen.`);
  }
  if (methodBody.exceptionCount !== 0) {
    throw new PatchError("class_70.OnTickScreen has exception handlers; their ranges would need shifting.");
  }

  // local_count is a u30 of its own; read it back rather than assuming a width.
  const [, localCountEnd] = readU30(ctx.body, methodBody.localCountPos, "OnTickScreen.local_count");

  const patches: BytePatch[] = [
    ...stringPatches,
    {
      key: "class_70.OnTickScreen.maxStack",
      start: methodBody.maxStackPos,
      end: methodBody.localCountPos,
      data: writeU30(NEW_MAX_STACK),
      detail: `maxstack -> ${NEW_MAX_STACK}`,
    },
    {
      key: "class_70.OnTickScreen.localCount",
      start: methodBody.localCountPos,
      end: localCountEnd,
      data: writeU30(NEW_LOCAL_COUNT),
      detail: `localcount -> ${NEW_LOCAL_COUNT}`,
    },
    {
      key: "class_70.OnTickScreen.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "day/night clock in the top-right HUD",
    },
    {
      key: "class_70.OnTickScreen.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: "update OnTickScreen code length",
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: patched class_70.OnTickScreen (top-right day/night clock, ${block.length} bytes).`);
  syncClientRev(swfPath);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
