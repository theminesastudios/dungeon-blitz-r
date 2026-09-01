/**
 * Turns the lockbox screen into the Hallow's Eve coffers board when a coffer is
 * what is being opened, and leaves it alone when a Treasure Trove is.
 *
 * ## The problem this exists for
 *
 * `class_73` / `a_ScreenLockBoxAD` is one screen serving two lockboxes: the
 * Treasure Trove (id 1) and the Hallow's Eve coffer (id 2, minted by
 * `patch_swz_hallows_eve_coffer.ts`). `patch-ui4-hallows-eve-coffer-skin.ts` lays
 * the seasonal panel into it as `am_HallowsEveSkin`, and with nothing to switch
 * that placement a trove opens wearing skulls and pumpkins too.
 *
 * Everything below is driven off `mLockboxData.mLockboxID`, which the client sets
 * from the bag item the player actually clicked, so the two screens can share one
 * class and still be two screens.
 *
 * ## The four blocks
 *
 * **`OnTickScreen` - the chrome.** The panel is shown for the coffer and hidden for
 * everything else, and the trove's own furniture goes the other way. Two lists,
 * because they are not the same problem:
 *
 *   - `HIDDEN_ALWAYS` is art the class never touches - the gold chest, the OPEN
 *     TROVES plate, the two counters standing on it. Nothing would ever put them
 *     back, so they are driven both ways: `visible = !isCoffer`.
 *   - `HIDDEN_ON_COFFER` is what the class shows and hides itself - the four
 *     mutually exclusive buttons and the OPEN TREASURE TROVE board. These are only
 *     ever forced *off*, on the coffer path; pushing them on would draw all four
 *     buttons at once.
 *
 *   The room, the hairline and the pedestal are not in either list: they are
 *   unnamed placements, so the art patch moves them under the panel instead, where
 *   being covered is as good as being hidden. `am_Ok` stays where it was authored
 *   and stays visible on both screens - it is the only way out of either.
 *
 *   The same block picks the prize column's helm. `am_CacheIcon` ships all three
 *   class hats stacked in one cell - `am_MageHelm`, `am_PallyHelm`, `am_RogueHelm`,
 *   in that depth order - so the Rogue hood was drawn over the other two for
 *   everyone. Each is shown only to the class that would actually be paid it, which
 *   is the same helm `HallowsEve.nextPrize` hands out.
 *
 * **`OnCreateScreen` - the wiring.** Every `am_Coffer0..39` gets `buttonMode` and a
 * click listener, once, when the screen is built. The listener is `method_782` -
 * the screen's *own* Open handler, the one the OPEN button used - so a click on a
 * skull spends a key and opens a coffer through exactly the path that was already
 * tested, including its "you have no keys" and "you have no boxes" branches. A
 * hidden clip receives no mouse events, so the cells are inert on the trove screen
 * without anything having to switch them off.
 *
 *   `addEventListener` with the same method closure twice is a no-op in AVM2 -
 *   `this.method_782 == this.method_782` - so this cannot stack a second listener
 *   even if the screen is somehow rebuilt on the same clip.
 *
 * **`OnInitDisplay` and `OnRefreshScreen` - the board.** Each cell is a three-frame
 * clip authored `Ready` / `Over` / `Inactive`: a skull, a lit skull, and an empty
 * socket. Nothing was stopping it, which is why all forty were flickering through
 * the three. Cell *i* is now stopped on `Ready` while `i < remaining` and on
 * `Inactive` otherwise, where `remaining` is the coffer's own `stackCount` - the
 * server keeps that equal to the number of cells left on the board
 * (`HallowsEve.boardRemaining`), so a key spent takes a skull off the wall and the
 * wall stays that way across sessions.
 *
 *   These two run on opening and on every lockbox update - which is exactly when a
 *   cell changes - rather than per frame: `getChildByName` down forty cells every
 *   tick is a linear scan forty times over, and re-issuing `gotoAndStop` would also
 *   restart each cell's glow animation every frame.
 *
 * ## How it is written
 *
 * Every child is reached with `getChildByName("...")`, never as a property, so no
 * multiname has to be minted for a name that is not already in a 5MB obfuscated
 * constant pool - only the strings themselves are appended, past the last one, so
 * no existing index moves. Each lookup is null-checked; a file whose art patch has
 * not been run yet finds nothing and does nothing.
 *
 * The forty cells are unrolled rather than looped. A loop would be a fortieth of
 * the bytes, but it puts a back edge in injected code, and a back edge is the one
 * shape in this codebase that has verified clean in FFDec and still thrown
 * VerifyError #1021 in real Flash. Every block here branches forward only.
 *
 * Each block is fenced by `pushstring MARKER; pop` at both ends so re-running swaps
 * it out instead of stacking a second copy in front of it.
 *
 * Usage: npm exec ts-node scripts/patch-dungeonblitz-hallows-eve-coffer-screen.ts [--verify]
 */
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

/** The art half of this feature, hashed into the cache token alongside the client. */
const UI4_SWF = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "UI_4.swf");

const HOST_CLASS = "class_73";

/** Fences an injected block. Appears nowhere else in the client. */
const MARKER = "HallowsEveCofferScreen";

/** The placement `patch-ui4-hallows-eve-coffer-skin.ts` adds to the screen. */
const SKIN_NAME = "am_HallowsEveSkin";

/** The prize column, the icon strip inside it, and the grid of cells. */
const PRIZE_GROUP_NAME = "am_PrizeGroup";
const CACHE_ICON_NAME = "am_CacheIcon";
const COFFER_GROUP_NAME = "am_CofferGroup";
const COFFER_CELL_PREFIX = "am_Coffer";

/** How many cells the seasonal panel authored, and what the board is worth. */
const COFFER_CELLS = 40;

/**
 * The cell clip's frames, by number.
 *
 * It is authored `Ready` (the skull), `Over` (the skull lit) and `Inactive` (an
 * empty socket) in that order. Numbers rather than labels, because a number is what
 * a cell that has never been stopped is sitting on.
 */
const FRAME_READY = 1;
const FRAME_INACTIVE = 3;

/**
 * Trove furniture the class never hides on its own, so this drives it both ways.
 *
 * The chest and the plate are the two things that still say *trove* over a board
 * made of skulls; the counters stand on the plate and would be left floating. The
 * sigil row along the bottom right is the same argument one step further out - it
 * is the trove's shop, and the coffers does not have one. `am_SigilPlate` is the
 * plate, the coin and the amount, which are three unnamed placements until
 * `patch-ui4-hallows-eve-coffer-skin.ts` wraps them under that one name; they sit
 * below the panel's bottom edge, so unlike the pedestal they cannot simply be
 * pushed underneath it.
 */
const HIDDEN_ALWAYS = [
  "am_OpenButtonBase",
  "am_KeyCounter",
  "am_LockboxCounter",
  "am_EarnedSigils",
  "am_OpenSigilStore",
  "am_SigilPlate",
  "am_LockBoxRoom",
  "am_Ok",
];

/**
 * The chest, which is trove furniture right up until it is the prize reveal.
 *
 * `method_1148` - the reveal - is literally *open the chest*: it plays
 * `var_396.method_147("Open", "LockBox_Basic_Open")` and floats the prize out of
 * it. Hiding the chest outright therefore took the reward screen with it: the key
 * was spent, the server sent the prize, and it was revealed on something nobody
 * could see.
 *
 * So the chest is hidden while the board is idle and shown for exactly as long as
 * an open is in flight. `var_1883` is set when the open is sent and cleared when
 * the reveal lands; `var_1929` is set when the reveal starts and cleared when it
 * finishes, so between them they cover the click all the way to the prize. The
 * shipped code writes both with `initproperty`, which FFDec renders as a plain
 * assignment; the `getproperty` operand for each is in the pool all the same.
 */
const CHEST_NAME = "am_Lockbox";

/** The panel's own close button, which takes DONE's place and DONE's handler. */
const CLOSE_NAME = "am_Close";

/**
 * Trove furniture the class shows and hides itself.
 *
 * Only ever forced off, and only on the coffer path: the first four are one button
 * in four states and pushing them all on would draw them over each other, and
 * `am_SigilFloatAnim` is a transient "+N" the class hides for itself on every
 * opening.
 */
const HIDDEN_ON_COFFER = [
  "am_Open",
  "am_OpenAnother",
  "am_GetKeys",
  "am_GetTroves",
  "am_RewardsTooltip",
  "am_SigilFloatAnim",
];

/**
 * The stacked helms, and the `EntType.className` each belongs to.
 *
 * The names are the seasonal panel's own; the class strings are what
 * `EntType.className` is set to for a player - "Paladin", "Rogue", "Mage" - not
 * `mMasterClass`, which is lowercase.
 */
const HELMS: Array<{ child: string; className: string }> = [
  { child: "am_MageHelm", className: "Mage" },
  { child: "am_PallyHelm", className: "Paladin" },
  { child: "am_RogueHelm", className: "Rogue" },
];

/** The class shown to a character whose entity has not arrived yet. */
const DEFAULT_CLASS = "Mage";

/** The event a cell listens for. `MouseEvent.CLICK`, spelled out. */
const CLICK_EVENT = "click";

/**
 * `HALLOWS_EVE_COFFER_LOCKBOX_ID`, on the client's side of the wire.
 *
 * Ids are sent in two bits, so this cannot drift far, but it does have to agree
 * with `core/HallowsEve.ts` and with `LockboxTypes.xml`.
 */
const COFFER_LOCKBOX_ID = 2;

/**
 * Scratch locals, appended past every host method's own count (the largest is 5).
 *
 * One base for all four blocks so a method that has already been patched - and so
 * declares the raised count - reads back the same way as one that has not.
 */
const L_CLIP = 10;
const L_DATA = 11;
const L_FLAG = 12;
const L_NOT = 13;
const L_GROUP = 14;
const L_READY = 15;
const L_WANT = 16;
const L_SKIN = 17;
const L_CAN_OPEN = 18;
const L_ENABLED = 19;
const L_CHEST = 20;
const SCRATCH_BASE = 10;
const NEW_LOCAL_COUNT = 21;
const NEW_MAX_STACK = 8;

const OP = {
  jump: 0x10,
  iftrue: 0x11,
  iffalse: 0x12,
  ifeq: 0x13,
  // 0x15. 0x0c is ifnlt, which is what this said for one round: the board came out
  // inverted, spent cells showing skulls and live ones showing empty sockets.
  iflt: 0x15,
  pushbyte: 0x24,
  pushtrue: 0x26,
  pushfalse: 0x27,
  pop: 0x29,
  dup: 0x2a,
  pushstring: 0x2c,
  callproperty: 0x46,
  callpropvoid: 0x4f,
  getlex: 0x60,
  setproperty: 0x61,
  getlocal: 0x62,
  setlocal: 0x63,
  getproperty: 0x66,
  convert_b: 0x76,
  coerce_a: 0x82,
  not: 0x96,
  equals: 0xab,
} as const;

type Operand = [Instruction["operands"][number][0], number];
type Emitted =
  | { label: string }
  | { opcode: number; operands?: Operand[]; branchTo?: string; pop?: number; push?: number };

function parseArgs(argv: string[]): { swfPath: string; verify: boolean; remove: boolean; only: string[] | null } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  let remove = false;
  let only: string[] | null = null;

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
    if (arg === "--remove") {
      remove = true;
      continue;
    }
    if (arg === "--only") {
      only = (argv[++index] || "").split(",").map((name) => name.trim()).filter(Boolean);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log(
        [
          "Usage:",
          "  ts-node src/server/scripts/patch-dungeonblitz-hallows-eve-coffer-screen.ts [--verify] [--swf <path>]",
          "",
          "Makes a_ScreenLockBoxAD the Hallow's Eve coffers board for lockbox 2 and the",
          "shipped Treasure Trove screen for everything else: switches the panel, takes",
          "the trove's furniture off, stops the forty cells flickering, wires each one to",
          "the screen's own Open handler, empties the cells the board has spent, and draws",
          "one class helm in the prize column instead of three.",
        ].join("\n"),
      );
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify, remove, only };
}

/**
 * Moves the cache token, over **both** files this feature ships.
 *
 * `clientrev` is one token for every asset the client fetches, and every patch
 * script stamps it from a digest of the file it just wrote - which means a change
 * to `UI_4.swf` alone never moves it, and the panel would sit in browser caches
 * behind bytecode that expects it. This script is the one that runs after the art
 * patch, so it hashes the pair.
 */
function syncClientRev(swfPath: string): void {
  if (path.resolve(swfPath) !== DEFAULT_SWF || !fs.existsSync(INDEX_HTML)) {
    return;
  }
  const hash = crypto.createHash("sha1").update(fs.readFileSync(swfPath));
  if (fs.existsSync(UI4_SWF)) {
    hash.update(fs.readFileSync(UI4_SWF));
  }
  const digest = hash.digest("hex").slice(0, 12);
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
 * Constant pool detail parseAbc does not keep: the two positions needed to append
 * new strings, plus the namespace kinds behind the multiname table so a property
 * can be referenced by the exact QName the player VM will resolve.
 */
interface PoolInfo {
  strings: string[];
  stringCountPos: number;
  stringCountEnd: number;
  stringPoolEnd: number;
  publicQName(name: string): number;
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

  function publicQName(name: string): number {
    for (let i = 1; i < multinames.length; i += 1) {
      const mn = multinames[i];
      if (mn.kind !== 0x07 || strings[mn.name] !== name) {
        continue;
      }
      // 0x16 is PackageNamespace, the one public members live in.
      if (nsKind[mn.ns] !== 0x16 || strings[nsName[mn.ns]] !== "") {
        continue;
      }
      return i;
    }
    throw new PatchError(`No public QName for ${name} in the constant pool.`);
  }

  return { strings, stringCountPos, stringCountEnd, stringPoolEnd, publicQName };
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
 * Assembles a block and, on the way, checks it the way the player's verifier will:
 * every path reaching a label must arrive with the same operand stack depth, and
 * the block must leave the stack exactly as it found it. FFDec will happily
 * decompile a block that fails this; the player throws VerifyError.
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
  mLockboxData: number;
  mLockboxID: number;
  mOwnedLockboxes: number;
  /** The `obj[expr]` multiname - a MultinameL, which has no readable name. */
  indexer: number;
  stackCount: number;
  mLockboxKeys: number;
  clientEnt: number;
  entType: number;
  className: number;
  visible: number;
  getChildByName: number;
  gotoAndStop: number;
  buttonMode: number;
  mouseChildren: number;
  mouseEnabled: number;
  addEventListener: number;
  openHandler: number;
  closeHandler: number;
  openInFlight: number;
  revealRunning: number;
}

/** The shared shorthands every block is written with. */
function emitters(names: Names, str: (value: string) => number) {
  const get = (mn: number): Emitted => ({ opcode: OP.getproperty, operands: [["u30", mn]], pop: 1, push: 1 });
  const set = (mn: number): Emitted => ({ opcode: OP.setproperty, operands: [["u30", mn]], pop: 2 });
  const pushString = (value: string): Emitted => ({
    opcode: OP.pushstring,
    operands: [["u30", str(value)]],
    push: 1,
  });
  const child = (name: string): Emitted[] => [
    pushString(name),
    { opcode: OP.callproperty, operands: [["u30", names.getChildByName], ["u30", 1]], pop: 2, push: 1 },
  ];
  const marker: Emitted[] = [pushString(MARKER), { opcode: OP.pop, pop: 1 }];
  return { get, set, pushString, child, marker };
}

/**
 * `clip = var_2`, the screen root every child hangs off.
 *
 * Every block opens with this, and every block ends with the `bail` / `done` pair
 * the null check branches into.
 */
function prologue(names: Names): Emitted[] {
  return [
    { opcode: OP.getlex, operands: [["u30", names.var_2]], push: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "bail", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_CLIP),
  ];
}

function epilogue(): Emitted[] {
  return [
    { opcode: OP.jump, branchTo: "done" },
    // Every null check above lands here with its own dup still on the stack.
    { label: "bail" },
    { opcode: OP.pop, pop: 1 },
    { label: "done" },
  ];
}

/** `data = var_1.mLockboxData`, which both the id and the stack come off. */
function lockboxData(names: Names): Emitted[] {
  const { get } = emitters(names, () => 0);
  return [
    { opcode: OP.getlex, operands: [["u30", names.var_1]], push: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "bail", pop: 1 },
    get(names.mLockboxData),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "bail", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_DATA),
  ];
}

/** `flag = data.mLockboxID == COFFER_LOCKBOX_ID`, into `L_FLAG`. */
function isCoffer(names: Names): Emitted[] {
  const { get } = emitters(names, () => 0);
  return [
    getlocal(L_DATA),
    get(names.mLockboxID),
    { opcode: OP.pushbyte, operands: [["s8", COFFER_LOCKBOX_ID]], push: 1 },
    { opcode: OP.equals, pop: 2, push: 1 },
    setlocal(L_FLAG),
  ];
}

/**
 * The chrome: which of the two screens this is, and what the other one's furniture
 * does about it.
 */
function chromeProgram(names: Names, str: (value: string) => number): Emitted[] {
  const { get, set, pushString, child, marker } = emitters(names, str);

  const program: Emitted[] = [
    ...marker,
    ...prologue(names),
    ...lockboxData(names),
    ...isCoffer(names),

    // The other half of the switch, computed once.
    getlocal(L_FLAG),
    { opcode: OP.not, pop: 1, push: 1 },
    setlocal(L_NOT),

    // The seasonal panel belongs to the coffer and to nothing else.
    getlocal(L_CLIP),
    ...child(SKIN_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noSkin", pop: 1 },
    getlocal(L_FLAG),
    set(names.visible),
    { opcode: OP.jump, branchTo: "afterSkin" },
    { label: "noSkin" },
    { opcode: OP.pop, pop: 1 },
    { label: "afterSkin" },
  ];

  // chest = !isCoffer || openInFlight || revealRunning
  program.push(
    getlocal(L_FLAG),
    { opcode: OP.iffalse, branchTo: "chestOn", pop: 1 },
    getlocal(0),
    get(names.openInFlight),
    { opcode: OP.iftrue, branchTo: "chestOn", pop: 1 },
    getlocal(0),
    get(names.revealRunning),
    { opcode: OP.convert_b, pop: 1, push: 1 },
    { opcode: OP.jump, branchTo: "chestSet" },
    { label: "chestOn" },
    { opcode: OP.pushtrue, push: 1 },
    { label: "chestSet" },
    setlocal(L_CHEST),

    getlocal(L_CLIP),
    ...child(CHEST_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noChest", pop: 1 },
    getlocal(L_CHEST),
    set(names.visible),
    { opcode: OP.jump, branchTo: "afterChest" },
    { label: "noChest" },
    { opcode: OP.pop, pop: 1 },
    { label: "afterChest" },
  );

  HIDDEN_ALWAYS.forEach((name, index) => {
    program.push(
      getlocal(L_CLIP),
      ...child(name),
      { opcode: OP.dup, push: 1 },
      { opcode: OP.iffalse, branchTo: `noAlways${index}`, pop: 1 },
      getlocal(L_NOT),
      set(names.visible),
      { opcode: OP.jump, branchTo: `afterAlways${index}` },
      { label: `noAlways${index}` },
      { opcode: OP.pop, pop: 1 },
      { label: `afterAlways${index}` },
    );
  });

  // Everything below dresses the coffer; a trove is left exactly as it shipped.
  program.push(getlocal(L_FLAG), { opcode: OP.iffalse, branchTo: "done", pop: 1 });

  // **The X, wired from here rather than from `OnCreateScreen`.**
  //
  // DONE is hidden with the rest of the trove furniture, so the panel's own close
  // button has to work or there is no way out of the screen. The binding lives in
  // this block because this block is the one that has been shown to run: the two
  // methods `Display()` calls before the screen appears are exactly the two that
  // could stop it appearing, and the board is only up again because they are empty.
  //
  // Re-binding every tick costs nothing. `addEventListener` ignores a listener it
  // already has, and in AVM2 `this.method_1132 == this.method_1132` - method
  // closures compare by receiver and method - so the second call and every one
  // after it is a no-op.
  program.push(
    getlocal(L_CLIP),
    ...child(SKIN_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noClose", pop: 1 },
    ...child(CLOSE_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noClose", pop: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.pushtrue, push: 1 },
    set(names.buttonMode),
    pushString(CLICK_EVENT),
    getlocal(0),
    { opcode: OP.getproperty, operands: [["u30", names.closeHandler]], pop: 1, push: 1 },
    { opcode: OP.callpropvoid, operands: [["u30", names.addEventListener], ["u30", 2]], pop: 3 },
    { opcode: OP.jump, branchTo: "afterClose" },
    { label: "noClose" },
    { opcode: OP.pop, pop: 1 },
    { label: "afterClose" },
  );

  HIDDEN_ON_COFFER.forEach((name, index) => {
    program.push(
      getlocal(L_CLIP),
      ...child(name),
      { opcode: OP.dup, push: 1 },
      { opcode: OP.iffalse, branchTo: `noCoffer${index}`, pop: 1 },
      { opcode: OP.pushfalse, push: 1 },
      set(names.visible),
      { opcode: OP.jump, branchTo: `afterCoffer${index}` },
      { label: `noCoffer${index}` },
      { opcode: OP.pop, pop: 1 },
      { label: `afterCoffer${index}` },
    );
  });

  program.push(
    // cls = var_1.clientEnt.entType.className, or the default before it exists.
    pushString(DEFAULT_CLASS),
    { opcode: OP.coerce_a },
    setlocal(L_WANT),
    { opcode: OP.getlex, operands: [["u30", names.var_1]], push: 1 },
    get(names.clientEnt),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noClass", pop: 1 },
    get(names.entType),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noClass", pop: 1 },
    get(names.className),
    { opcode: OP.coerce_a },
    setlocal(L_WANT),
    { opcode: OP.jump, branchTo: "haveClass" },
    { label: "noClass" },
    { opcode: OP.pop, pop: 1 },
    { label: "haveClass" },

    // icons = skin.am_PrizeGroup.am_CacheIcon, the strip the helms are stacked in.
    getlocal(L_CLIP),
    ...child(SKIN_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noIcons", pop: 1 },
    ...child(PRIZE_GROUP_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noIcons", pop: 1 },
    ...child(CACHE_ICON_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noIcons", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_GROUP),
    { opcode: OP.jump, branchTo: "haveIcons" },
    { label: "noIcons" },
    { opcode: OP.pop, pop: 1 },
    { opcode: OP.jump, branchTo: "done" },
    { label: "haveIcons" },
  );

  HELMS.forEach((helm, index) => {
    program.push(
      getlocal(L_GROUP),
      ...child(helm.child),
      { opcode: OP.dup, push: 1 },
      { opcode: OP.iffalse, branchTo: `noHelm${index}`, pop: 1 },
      getlocal(L_WANT),
      pushString(helm.className),
      { opcode: OP.equals, pop: 2, push: 1 },
      set(names.visible),
      { opcode: OP.jump, branchTo: `afterHelm${index}` },
      { label: `noHelm${index}` },
      { opcode: OP.pop, pop: 1 },
      { label: `afterHelm${index}` },
    );
  });

  program.push(...epilogue(), ...marker);
  return program;
}

/** `skin = clip.am_HallowsEveSkin`, into `L_SKIN`. Nothing to do without it. */
function skinInto(names: Names, str: (value: string) => number): Emitted[] {
  const { child } = emitters(names, str);
  return [
    getlocal(L_CLIP),
    ...child(SKIN_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noSkin", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_SKIN),
    { opcode: OP.jump, branchTo: "haveSkin" },
    { label: "noSkin" },
    { opcode: OP.pop, pop: 1 },
    { opcode: OP.jump, branchTo: "done" },
    { label: "haveSkin" },
  ];
}

/** `group = skin.am_CofferGroup`, into `L_GROUP`. */
function cofferGroup(names: Names, str: (value: string) => number): Emitted[] {
  const { child } = emitters(names, str);
  return [
    getlocal(L_SKIN),
    ...child(COFFER_GROUP_NAME),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noGroup", pop: 1 },
    { opcode: OP.coerce_a },
    setlocal(L_GROUP),
    { opcode: OP.jump, branchTo: "haveGroup" },
    { label: "noGroup" },
    { opcode: OP.pop, pop: 1 },
    { opcode: OP.jump, branchTo: "done" },
    { label: "haveGroup" },
  ];
}

/**
 * Gives every cell a hand cursor and the screen's own Open handler, and the panel's
 * X the screen's own close handler.
 *
 * `mouseChildren` goes off on each cell so that the cell itself is what a click
 * lands on. That is what lets the board block switch a cell off with
 * `mouseEnabled`: with children still listening, a dead cell's skull would keep
 * taking clicks and bubbling them up.
 */
function wireProgram(names: Names, str: (value: string) => number): Emitted[] {
  const { set, pushString, child, marker } = emitters(names, str);

  const listener = (handler: number): Emitted[] => [
    pushString(CLICK_EVENT),
    getlocal(0),
    { opcode: OP.getproperty, operands: [["u30", handler]], pop: 1, push: 1 },
    { opcode: OP.callpropvoid, operands: [["u30", names.addEventListener], ["u30", 2]], pop: 3 },
  ];

  const program: Emitted[] = [
    ...marker,
    ...prologue(names),
    ...skinInto(names, str),

    // **The X is not wired while the screen is being bisected.**
    //
    // `OnCreateScreen` and `OnInitDisplay` are the only two of the four blocks that
    // run *inside* `Display()`, before the screen is made visible - so they are the
    // only two that can stop it appearing at all, which is the symptom. Everything
    // added to them in the rounds where the board stopped opening is off: this
    // binding, the `mouseChildren` write below, and the per-cell `mouseEnabled` in
    // the board block. DONE is visible again to close the screen with.

    ...cofferGroup(names, str),
  ];

  for (let index = 0; index < COFFER_CELLS; index += 1) {
    program.push(
      getlocal(L_GROUP),
      ...child(`${COFFER_CELL_PREFIX}${index}`),
      { opcode: OP.dup, push: 1 },
      { opcode: OP.iffalse, branchTo: `noCell${index}`, pop: 1 },
      { opcode: OP.dup, push: 1 },
      { opcode: OP.pushtrue, push: 1 },
      set(names.buttonMode),
      ...listener(names.openHandler),
      { opcode: OP.jump, branchTo: `afterCell${index}` },
      { label: `noCell${index}` },
      { opcode: OP.pop, pop: 1 },
      { label: `afterCell${index}` },
    );
  }

  program.push(...epilogue(), ...marker);
  return program;
}

/**
 * Stops each cell on the frame the board says it should be on.
 *
 * `remaining` is the coffer's own `stackCount`, which the server keeps equal to the
 * number of cells left; anything past it is a socket the board has already paid
 * out.
 */
function boardProgram(names: Names, str: (value: string) => number): Emitted[] {
  const { get, set, child, marker } = emitters(names, str);

  const program: Emitted[] = [
    ...marker,
    ...prologue(names),
    ...lockboxData(names),
    ...isCoffer(names),
    getlocal(L_FLAG),
    { opcode: OP.iffalse, branchTo: "done", pop: 1 },

    // **This line is why the board stopped opening for four rounds.**
    //
    // `cofferGroup` reads the panel out of `L_SKIN`, and `L_SKIN` is filled by
    // `skinInto`. When the close-button wiring moved the panel lookup into that
    // helper, only `wireProgram` was given the call - so this block ran
    // `undefined.getChildByName("am_CofferGroup")`, threw TypeError #1009 inside
    // `Display()`, and the screen never appeared. Not a VerifyError, which is why
    // every static check on the bytecode came back clean: the code is perfectly
    // valid, it just read a local nobody had written.
    ...skinInto(names, str),

    // remaining = data.mOwnedLockboxes[COFFER_LOCKBOX_ID].stackCount, or none.
    { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 },
    setlocal(L_READY),
    getlocal(L_DATA),
    get(names.mOwnedLockboxes),
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noEntry", pop: 1 },
    { opcode: OP.pushbyte, operands: [["s8", COFFER_LOCKBOX_ID]], push: 1 },
    { opcode: OP.getproperty, operands: [["u30", names.indexer]], pop: 2, push: 1 },
    { opcode: OP.dup, push: 1 },
    { opcode: OP.iffalse, branchTo: "noEntry", pop: 1 },
    get(names.stackCount),
    setlocal(L_READY),
    { opcode: OP.jump, branchTo: "haveReady" },
    { label: "noEntry" },
    { opcode: OP.pop, pop: 1 },
    { label: "haveReady" },

    // A cell can only be clicked while there is a key to spend on it. Without this
    // the screen's Open handler is still reached on a dead board, and its own
    // no-key branch puts the *Treasure Trove purchase* screen up over the coffers.
    getlocal(L_DATA),
    get(names.mLockboxKeys),
    { opcode: OP.convert_b, pop: 1, push: 1 },
    setlocal(L_CAN_OPEN),

    ...cofferGroup(names, str),
  ];

  for (let index = 0; index < COFFER_CELLS; index += 1) {
    program.push(
      getlocal(L_GROUP),
      ...child(`${COFFER_CELL_PREFIX}${index}`),
      { opcode: OP.dup, push: 1 },
      { opcode: OP.iffalse, branchTo: `noCell${index}`, pop: 1 },

      // A cell still behind glass shows its skull and takes a click; one the board
      // has already paid out shows an empty socket and takes nothing.
      { opcode: OP.pushbyte, operands: [["s8", index]], push: 1 },
      getlocal(L_READY),
      { opcode: OP.iflt, branchTo: `live${index}`, pop: 2 },
      { opcode: OP.pushbyte, operands: [["s8", FRAME_INACTIVE]], push: 1 },
      { opcode: OP.jump, branchTo: `frame${index}` },
      { label: `live${index}` },
      { opcode: OP.pushbyte, operands: [["s8", FRAME_READY]], push: 1 },
      { label: `frame${index}` },

      // Unconditionally, and this matters: a cell arrives *playing*, and a playing
      // clip is on frame 1 a third of the time. Skipping the call when
      // `currentFrame` already reads the wanted frame therefore left every cell it
      // was sampled on still running - which is what the flicker was after the
      // first pass at this. `gotoAndStop` is what stops them; nothing else does.
      { opcode: OP.callpropvoid, operands: [["u30", names.gotoAndStop], ["u30", 1]], pop: 2 },
      { opcode: OP.jump, branchTo: `afterCell${index}` },
      { label: `noCell${index}` },
      { opcode: OP.pop, pop: 1 },
      { label: `afterCell${index}` },
    );
  }

  program.push(...epilogue(), ...marker);
  return program;
}

/** The instruction after `getlocal0; pushscope`, where the scope stack is live. */
function findInjectionOffset(instructions: Instruction[], method: string): number {
  for (let index = 0; index < instructions.length - 1; index += 1) {
    if (instructions[index].opcode === 0xd0 && instructions[index + 1].opcode === 0x30) {
      return instructions[index + 2].offset;
    }
  }
  throw new PatchError(`Could not find \`getlocal0; pushscope\` in ${HOST_CLASS}.${method}.`);
}

/** The marker positions of a block an earlier run left behind. */
function findMarkers(instructions: Instruction[], strings: string[]): number[] {
  const found: number[] = [];
  for (const inst of instructions) {
    if (inst.opcode === OP.pushstring && strings[inst.operands[0][1]] === MARKER) {
      found.push(inst.offset);
    }
  }
  return found;
}

function classTraits(abc: ReturnType<typeof parseAbc>, className: string) {
  const classIndex = classIndexByName(abc, className);
  if (classIndex === null) {
    throw new PatchError(`Could not find ${className}.`);
  }
  return abc.instances[classIndex].traits;
}

function methodInstructions(
  ctx: SwfContext,
  abc: ReturnType<typeof parseAbc>,
  className: string,
  method: string,
): Instruction[] {
  const methodIdx = methodIdxForTrait(classTraits(abc, className), abc, method);
  if (methodIdx === null) {
    throw new PatchError(`Could not find ${className}.${method}.`);
  }
  const body = abc.methodBodies.get(methodIdx);
  if (!body) {
    throw new PatchError(`Could not find the body of ${className}.${method}.`);
  }
  return disassemble(ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen), `${className}.${method}`);
}

function findOperandInClass(
  ctx: SwfContext,
  abc: ReturnType<typeof parseAbc>,
  className: string,
  opcode: number,
  name: string,
): number {
  for (const trait of classTraits(abc, className)) {
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

/**
 * The `obj[expr]` multiname, read off the screen's own array access.
 *
 * A MultinameL carries a namespace set where a QName carries a name, so it cannot
 * be looked up by name at all - `u30OperandName` reads its nsset index as a string
 * index and answers with something unrelated. `OnRefreshScreen` opens with
 * `mOwnedLockboxes[mLockboxID]`, so the getproperty straight after the one for
 * `mLockboxID` is the indexer, and taking it from there means taking the one this
 * very class already uses on this very object.
 */
function findIndexerOperand(ctx: SwfContext, abc: ReturnType<typeof parseAbc>): number {
  const instructions = methodInstructions(ctx, abc, HOST_CLASS, "OnRefreshScreen");
  for (let index = 0; index < instructions.length - 1; index += 1) {
    const inst = instructions[index];
    if (inst.opcode !== OP.getproperty || u30OperandName(inst, abc.multinameNames) !== "mLockboxID") {
      continue;
    }
    // Not every `mLockboxID` is an index: this file's own block reads it to compare
    // against the coffer's id, and its block sits ahead of the authored code.
    const next = instructions[index + 1];
    if (next.opcode !== OP.getproperty) {
      continue;
    }
    return next.operands[0][1];
  }
  throw new PatchError(`Could not find mOwnedLockboxes[mLockboxID] in ${HOST_CLASS}.OnRefreshScreen.`);
}

interface Site {
  method: string;
  detail: string;
  build(names: Names, str: (value: string) => number): Emitted[];
}

const SITES: Site[] = [
  { method: "OnTickScreen", detail: "coffer/trove chrome and the class helm", build: chromeProgram },
  { method: "OnCreateScreen", detail: "forty cells wired to the Open handler", build: wireProgram },
  { method: "OnInitDisplay", detail: "board state on opening", build: boardProgram },
  { method: "OnRefreshScreen", detail: "board state on every lockbox update", build: boardProgram },
];

function patchSwf(swfPath: string, verify: boolean, only: string[] | null): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const pool = parsePool(ctx);

  const cellNames = Array.from({ length: COFFER_CELLS }, (_, index) => `${COFFER_CELL_PREFIX}${index}`);
  const wantedStrings = [
    MARKER,
    SKIN_NAME,
    PRIZE_GROUP_NAME,
    CACHE_ICON_NAME,
    COFFER_GROUP_NAME,
    CLICK_EVENT,
    CLOSE_NAME,
    DEFAULT_CLASS,
    ...cellNames,
    CHEST_NAME,
    ...HIDDEN_ALWAYS,
    ...HIDDEN_ON_COFFER,
    ...HELMS.map((helm) => helm.child),
    ...HELMS.map((helm) => helm.className),
  ];
  const { indexOf, patches: stringPatches } = appendStrings(pool, wantedStrings);
  const str = (value: string): number => {
    const index = indexOf.get(value);
    if (index === undefined) {
      throw new PatchError(`String "${value}" was never resolved`);
    }
    return index;
  };

  const inClass = (opcode: number, name: string): number =>
    findOperandInClass(ctx, abc, HOST_CLASS, opcode, name);

  const names: Names = {
    var_1: inClass(OP.getlex, "var_1"),
    var_2: inClass(OP.getlex, "var_2"),
    mLockboxData: inClass(OP.getproperty, "mLockboxData"),
    mLockboxID: inClass(OP.getproperty, "mLockboxID"),
    mOwnedLockboxes: inClass(OP.getproperty, "mOwnedLockboxes"),
    indexer: findIndexerOperand(ctx, abc),
    stackCount: inClass(OP.getproperty, "stackCount"),
    mLockboxKeys: inClass(OP.getproperty, "mLockboxKeys"),
    clientEnt: inClass(OP.getproperty, "clientEnt"),
    entType: inClass(OP.getproperty, "entType"),
    className: inClass(OP.getproperty, "className"),
    visible: inClass(OP.setproperty, "visible"),
    openHandler: inClass(OP.getproperty, "method_782"),
    closeHandler: inClass(OP.getproperty, "method_1132"),
    openInFlight: inClass(OP.getproperty, "var_1883"),
    revealRunning: inClass(OP.getproperty, "var_1929"),
    getChildByName: pool.publicQName("getChildByName"),
    gotoAndStop: pool.publicQName("gotoAndStop"),
    buttonMode: pool.publicQName("buttonMode"),
    mouseChildren: pool.publicQName("mouseChildren"),
    mouseEnabled: pool.publicQName("mouseEnabled"),
    addEventListener: pool.publicQName("addEventListener"),
  };

  const patches: BytePatch[] = [...stringPatches];
  const applied: string[] = [];
  let allPresent = true;

  for (const site of SITES) {
    if (only && !only.includes(site.method)) {
      continue;
    }
    const methodIdx = methodIdxForTrait(classTraits(abc, HOST_CLASS), abc, site.method);
    if (methodIdx === null) {
      throw new PatchError(`Could not find ${HOST_CLASS}.${site.method}.`);
    }
    const methodBody = abc.methodBodies.get(methodIdx);
    if (!methodBody) {
      throw new PatchError(`Could not find the body of ${HOST_CLASS}.${site.method}.`);
    }
    if (methodBody.exceptionCount !== 0) {
      throw new PatchError(
        `${HOST_CLASS}.${site.method} has exception handlers; their ranges would need shifting.`,
      );
    }
    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const instructions = disassemble(code, `${HOST_CLASS}.${site.method}`);

    const block = assemble(site.build(names, str));
    const blockStart = findInjectionOffset(instructions, site.method);

    const markers = findMarkers(instructions, pool.strings);
    if (markers.length !== 0 && markers.length !== 2) {
      throw new PatchError(
        `${swfPath}: found ${markers.length} ${MARKER} markers in ${site.method}; refusing to guess the block.`,
      );
    }
    let blockEnd = blockStart;
    if (markers.length === 2) {
      if (markers[0] !== blockStart) {
        throw new PatchError(
          `${swfPath}: the block in ${site.method} starts at ${markers[0]}, not at ${blockStart}.`,
        );
      }
      // The closing marker is `pushstring MARKER; pop`; the block ends after the pop.
      const trailing = instructions.find((inst) => inst.offset > markers[1]);
      if (!trailing || trailing.opcode !== OP.pop) {
        throw new PatchError(`${swfPath}: the closing marker in ${site.method} is not followed by a pop.`);
      }
      blockEnd = trailing.offset + trailing.size;
    }

    if (markers.length === 2 && code.subarray(blockStart, blockEnd).equals(block)) {
      continue;
    }
    allPresent = false;
    if (verify) {
      continue;
    }

    const patchedCode = spliceAndAdjustBranches(code, instructions, blockStart, blockEnd, block);

    // local_count is a u30 of its own; read it back rather than assuming a width.
    const [localCount, localCountEnd] = readU30(
      ctx.body,
      methodBody.localCountPos,
      `${site.method}.local_count`,
    );
    // Only a method this script has never touched can be measured this way: one it
    // has declares whatever `NEW_LOCAL_COUNT` was when it was last written, which
    // is by definition above the scratch base. `--remove` strips the code but
    // leaves the raised count behind - a method may always declare more locals than
    // it uses - so that exact value has to be recognised as this script's own.
    if (markers.length === 0 && localCount > SCRATCH_BASE && localCount !== NEW_LOCAL_COUNT) {
      throw new PatchError(
        `${HOST_CLASS}.${site.method} declares ${localCount} locals; the scratch block would overwrite one.`,
      );
    }

    patches.push(
      {
        key: `${HOST_CLASS}.${site.method}.maxStack`,
        start: methodBody.maxStackPos,
        end: methodBody.localCountPos,
        data: writeU30(NEW_MAX_STACK),
        detail: `maxstack -> ${NEW_MAX_STACK}`,
      },
      {
        key: `${HOST_CLASS}.${site.method}.localCount`,
        start: methodBody.localCountPos,
        end: localCountEnd,
        data: writeU30(NEW_LOCAL_COUNT),
        detail: `localcount -> ${NEW_LOCAL_COUNT}`,
      },
      {
        key: `${HOST_CLASS}.${site.method}.code`,
        start: methodBody.codeStart,
        end: methodBody.codeStart + methodBody.codeLen,
        data: patchedCode,
        detail: site.detail,
      },
      {
        key: `${HOST_CLASS}.${site.method}.codeLen`,
        start: methodBody.codeLenPos,
        end: methodBody.codeStart,
        data: writeU30(patchedCode.length),
        detail: `update ${site.method} code length`,
      },
    );
    applied.push(`${site.method} (${block.length} bytes, ${site.detail})`);
  }

  if (allPresent && stringPatches.length === 0) {
    console.log(`${swfPath}: already patched (all four ${HOST_CLASS} blocks present).`);
    if (!verify) {
      syncClientRev(swfPath);
    }
    return;
  }
  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; the coffers board is missing or stale.`);
  }

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  for (const line of applied) {
    console.log(`  ${HOST_CLASS}.${line}`);
  }
  console.log(`${swfPath}: patched ${applied.length} method(s).`);
  syncClientRev(swfPath);
}

/**
 * Takes every injected block back out, leaving `class_73` exactly as it shipped.
 *
 * This is the experiment that ends an argument no amount of static checking has
 * been able to settle. The board stopped opening, and the two candidates are "the
 * bytecode this file writes is rejected by the player's verifier" and "something
 * else entirely" - a `VerifyError` is thrown when a method is first *called*, so a
 * bad `OnCreateScreen` shows up as `Display()` doing nothing at all, which is the
 * symptom exactly. With the blocks gone the screen is the shipped lockbox panel:
 * if it opens, this file is the cause and there is no more guessing; if it still
 * does not, this file never was.
 *
 * The blocks are marker-fenced, so removing them is the same splice that replaces
 * them, with an empty buffer. `max_stack` and `local_count` are left raised, which
 * costs nothing - a method may always declare more than it uses.
 */
function removeBlocks(swfPath: string): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const pool = parsePool(ctx);
  const patches: BytePatch[] = [];
  const removed: string[] = [];

  for (const site of SITES) {
    const methodIdx = methodIdxForTrait(classTraits(abc, HOST_CLASS), abc, site.method);
    if (methodIdx === null) continue;
    const methodBody = abc.methodBodies.get(methodIdx);
    if (!methodBody) continue;
    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const instructions = disassemble(code, `${HOST_CLASS}.${site.method}`);

    const markers = findMarkers(instructions, pool.strings);
    if (markers.length === 0) continue;
    if (markers.length !== 2) {
      throw new PatchError(`${site.method} carries ${markers.length} markers; refusing to guess the block.`);
    }
    const trailing = instructions.find((inst) => inst.offset > markers[1]);
    if (!trailing || trailing.opcode !== OP.pop) {
      throw new PatchError(`${site.method}: the closing marker is not followed by a pop.`);
    }
    const blockStart = markers[0];
    const blockEnd = trailing.offset + trailing.size;
    const stripped = spliceAndAdjustBranches(code, instructions, blockStart, blockEnd, Buffer.alloc(0));

    patches.push(
      {
        key: `${HOST_CLASS}.${site.method}.code`,
        start: methodBody.codeStart,
        end: methodBody.codeStart + methodBody.codeLen,
        data: stripped,
        detail: `remove the ${site.method} block`,
      },
      {
        key: `${HOST_CLASS}.${site.method}.codeLen`,
        start: methodBody.codeLenPos,
        end: methodBody.codeStart,
        data: writeU30(stripped.length),
        detail: `update ${site.method} code length`,
      },
    );
    removed.push(`${site.method} (-${blockEnd - blockStart} bytes)`);
  }

  if (removed.length === 0) {
    console.log(`${swfPath}: no injected blocks found; nothing to remove.`);
    return;
  }

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  for (const line of removed) console.log(`  ${HOST_CLASS}.${line}`);
  console.log(`${swfPath}: removed ${removed.length} block(s); class_73 is now as it shipped.`);
  syncClientRev(swfPath);
}

function main(): void {
  const { swfPath, verify, remove, only } = parseArgs(process.argv);
  if (remove) {
    removeBlocks(swfPath);
    return;
  }
  patchSwf(swfPath, verify, only);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
