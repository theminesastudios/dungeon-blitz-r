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
  parseAbc,
  parseSwf,
  PatchError,
  TraitInfo,
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

/**
 * Mystic is a fourth gear rarity that sits above Legendary. It reuses the wire format unchanged:
 * gear tier already travels in 2 bits (GearType.const_176), so tier 3 needs no protocol change.
 *
 * Two client sites have to learn about it:
 *
 *  - `Game.method_110(gearID, tier)` builds the `"<gearID><RARITY LETTER>"` key that
 *    `class_14.var_421` is indexed by. It only knows M/R/L, so tier 3 currently degrades to "M".
 *  - `GearType.method_628` derives `var_1943` (the rarity's stat-tier offset) from the rarity
 *    letter and only knows "L" -> 2 and "R" -> 1, so a Mystic item would silently roll Magic-tier
 *    stats. The letter is parsed deep inside a loop, so instead of editing that method the fixup is
 *    appended to `GearType.method_30`, which runs immediately after the whole table is loaded.
 *
 * Registration needs no patch at all: `GearType.method_18` already keys var_421 by
 * `String(gearID) + rarity.toUpperCase()`, so a `<Rarity>Y</Rarity>` entry lands on "1171Y" on its
 * own.
 */
const MYSTIC_LETTER = "Y";
const MYSTIC_TIER = 3;
// 2, not 3: the client stat tables index by level+offset and end at the Legendary offset; 3 walks
// off the end -> uint(undefined - baseline) -> the +4294966689 Attack garbage (and a crashed
// paperdoll loop). Mystic keeps Legendary stat values; its identity is the rune chain + red UI.
const MYSTIC_STAT_OFFSET = 2;

const INDEX_HTML = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "index.html");

/**
 * index.html requests the SWF at a fixed URL with a hardcoded cache token, so without this the
 * browser keeps serving the pre-patch copy and a test run reports on the wrong build. Runs on no-op
 * passes too, so patch/revert/re-patch always yield distinct URLs.
 */
function syncClientRev(swfPath: string): void {
  if (path.resolve(swfPath) !== DEFAULT_SWF || !fs.existsSync(INDEX_HTML)) return;
  const digest = crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  // Stop at $ as well as & and the quote characters: the token is immediately followed by
  // ${languageParam} in the template literal, and swallowing that would drop the locale.
  const updated = html.replace(/clientrev=[^&`"'$]+/, `clientrev=swf-${digest}`);
  if (updated !== html) {
    fs.writeFileSync(INDEX_HTML, updated);
    console.log(`  index.html clientrev -> swf-${digest} (cache buster)`);
  }
}

/**
 * Red tint applied to the gear tooltip's backing clip for Mystic items. Multipliers stay at 1 and
 * the work is done with offsets so every argument fits in a `pushbyte` (-128..127) — a fractional
 * multiplier would need a `pushdouble` and therefore a double-pool entry that may not exist.
 */
const RED_TINT = { rMul: 1, gMul: 1, bMul: 1, aMul: 1, rOff: 100, gOff: -70, bOff: -70, aOff: 0 };

type Only = "both" | "key" | "tier" | "card" | "slots" | "layout";

function parseArgs(argv: string[]): { swfPath: string; verify: boolean; only: Only } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  let only: Only = "both";

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
    if (arg === "--only") {
      const value = argv[++index];
      if (value !== "both" && value !== "key" && value !== "tier" && value !== "card" && value !== "slots" && value !== "layout") {
        throw new PatchError(`Unknown --only value: ${value}`);
      }
      only = value;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npx ts-node src/server/scripts/patch-dungeonblitz-mystic-rarity.ts [--verify] [--only both|key|tier] [--swf <path>]",
        "",
        "Teaches DungeonBlitz.swf the Mystic gear rarity (tier 3, rarity letter 'Y').",
        "",
        "Parts (--only, for bisecting a bad build):",
        "  key   Game.method_110 maps tier 3 to the 'Y' gear-table key.",
        "  tier  GearType.method_30 gives every 'Y' gear the Legendary+1 stat offset.",
        "  card  class_101.ShowGearTooltip tints a Mystic item's tooltip card red.",
        "  slots ScreenArmory.method_707 tints a Mystic cell frame red.",
        "  layout class_101.method_1120 pushes the proc rows below a multi-line ability block.",
      ].join("\n"));
      process.exit(0);
    }

    throw new PatchError(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify, only };
}

// 0x0e is ifngt, not ifne — the two are easy to transpose and the mistake assembles and disassembles
// cleanly, so it only shows up as a silently dead branch. Name the ones this patch emits.
const OP_IFNE = 0x14;
const OP_IFFALSE = 0x12;
const OP_JUMP = 0x10;

type Op = { opcode: number; operands?: Buffer[]; branchTo?: string; label?: string };

function s24(value: number): Buffer {
  if (value < -0x800000 || value > 0x7fffff) throw new PatchError(`s24 out of range: ${value}`);
  const out = Buffer.alloc(3);
  out.writeIntLE(value, 0, 3);
  return out;
}

/** Assembles a self-contained block; every branch is relative, so the block is position independent. */
function assemble(ops: Op[]): Buffer {
  const labels = new Map<string, number>();
  let offset = 0;
  for (const op of ops) {
    if (op.label) labels.set(op.label, offset);
    if (op.opcode >= 0) offset += 1 + (op.branchTo ? 3 : 0) + (op.operands ?? []).reduce((n, b) => n + b.length, 0);
  }
  const chunks: Buffer[] = [];
  offset = 0;
  for (const op of ops) {
    if (op.opcode < 0) continue;
    if (op.branchTo) {
      const target = labels.get(op.branchTo);
      if (target === undefined) throw new PatchError(`Unknown label ${op.branchTo}`);
      chunks.push(Buffer.concat([Buffer.from([op.opcode]), s24(target - (offset + 4))]));
      offset += 4;
    } else {
      const encoded = Buffer.concat([Buffer.from([op.opcode]), ...(op.operands ?? [])]);
      chunks.push(encoded);
      offset += encoded.length;
    }
  }
  return Buffer.concat(chunks);
}

type Abc = ReturnType<typeof parseAbc>;

function staticTrait(abc: Abc, className: string, methodName: string): TraitInfo {
  const classIndex = classIndexByName(abc, className);
  if (classIndex === null) throw new PatchError(`Class ${className} not found.`);
  const trait = abc.classTraits[classIndex]?.find((candidate) => abc.multinameNames[candidate.nameIdx] === methodName);
  if (!trait || trait.methodIdx === null) throw new PatchError(`Static method ${className}.${methodName} not found.`);
  return trait;
}

function instanceTrait(abc: Abc, className: string, methodName: string): TraitInfo {
  const classIndex = classIndexByName(abc, className);
  if (classIndex === null) throw new PatchError(`Class ${className} not found.`);
  const trait = abc.instances[classIndex]?.traits.find((candidate) => abc.multinameNames[candidate.nameIdx] === methodName);
  if (!trait || trait.methodIdx === null) throw new PatchError(`Instance method ${className}.${methodName} not found.`);
  return trait;
}

type Target = { body: NonNullable<ReturnType<Abc["methodBodies"]["get"]>>; code: Buffer; insts: Instruction[] };

/** Loads a method body and asserts the three properties the shared disassembler needs to be trusted. */
function loadMethod(ctx: ReturnType<typeof parseSwf>, abc: Abc, trait: TraitInfo, label: string): Target {
  const body = abc.methodBodies.get(trait.methodIdx as number);
  if (!body) throw new PatchError(`No method body for ${label}.`);
  if (body.exceptionCount > 0) throw new PatchError(`${label} has an exception table.`);

  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  const insts = disassemble(code, label);
  const last = insts[insts.length - 1];
  if (last.offset + last.size !== code.length) throw new PatchError(`${label} did not disassemble cleanly.`);
  if (insts.some((inst) => inst.opcode === 0x1b)) throw new PatchError(`${label} contains a lookupswitch.`);

  return { body, code, insts };
}

function stringIndex(abc: Abc, value: string): number {
  const index = abc.stringValues.indexOf(value);
  if (index < 0) throw new PatchError(`String constant ${JSON.stringify(value)} is not in the pool.`);
  return index;
}

/**
 * Harvests a multiname index from a real instruction rather than by name. Looking multinames up by
 * name alone picks whichever entry happens to be first and can silently land on one carrying the
 * wrong namespace set; copying the operand the client itself uses cannot.
 */
function operandAt(insts: Instruction[], opcode: number, predicate: (inst: Instruction) => boolean, label: string): number {
  const hit = insts.find((inst) => inst.opcode === opcode && predicate(inst));
  if (!hit) throw new PatchError(`Could not harvest ${label}.`);
  return hit.operands[0][1];
}

/** tier 3 -> `String(gearID) + "Y"`, returned before the stock M/R/L chain runs. */
function buildGearKeyPrologue(abc: Abc): Buffer {
  return assemble([
    { opcode: 0xd2 }, // getlocal2 -> tier
    { opcode: 0x24, operands: [Buffer.from([MYSTIC_TIER])] }, // pushbyte 3
    { opcode: OP_IFNE, branchTo: "stock" }, // ifne stock
    { opcode: 0xd1 }, // getlocal1 -> gearID
    { opcode: 0x2c, operands: [writeU30(stringIndex(abc, MYSTIC_LETTER))] }, // pushstring "Y"
    { opcode: 0xa0 }, // add (uint + String concatenates, exactly as String(gearID) + letter does)
    { opcode: 0x85 }, // coerce_s
    { opcode: 0x48 }, // returnvalue
    { opcode: -1, label: "stock" },
  ]);
}

/**
 * Appended to GearType.method_30 after the table load: walks class_14.var_421 and gives every
 * Mystic GearType the stat-tier offset the stock rarity chain never assigns it.
 */
function buildStatTierEpilogue(abc: Abc, method30: Instruction[], gearType: GearTypeMultinames): Buffer {
  const class14 = operandAt(method30, 0x60, (inst) => abc.multinameNames[inst.operands[0][1]] === "class_14", "getlex class_14");
  const var421 = operandAt(method30, 0x66, (inst) => abc.multinameNames[inst.operands[0][1]] === "var_421", "getproperty var_421");

  return assemble([
    { opcode: 0x60, operands: [writeU30(class14)] }, // getlex class_14
    { opcode: 0x66, operands: [writeU30(var421)] }, // getproperty var_421
    { opcode: 0xd6 }, // setlocal2 -> the gear table
    { opcode: 0x24, operands: [Buffer.from([0])] }, // pushbyte 0
    { opcode: 0xd7 }, // setlocal3 -> iterator index
    { opcode: 0x09, label: "loop" }, // label
    { opcode: 0x32, operands: [writeU30(2), writeU30(3)] }, // hasnext2 local2, local3
    { opcode: OP_IFFALSE, branchTo: "done" }, // iffalse done
    { opcode: 0xd2 }, // getlocal2
    { opcode: 0xd3 }, // getlocal3
    { opcode: 0x23 }, // nextvalue -> GearType
    { opcode: 0x2a }, // dup
    { opcode: 0x66, operands: [writeU30(gearType.var8)] }, // getproperty var_8 -> rarity letter
    { opcode: 0x2c, operands: [writeU30(stringIndex(abc, MYSTIC_LETTER))] }, // pushstring "Y"
    { opcode: OP_IFNE, branchTo: "skip" }, // ifne skip
    { opcode: 0x2a }, // dup -> the GearType again, for the var_8 write below
    { opcode: 0x24, operands: [Buffer.from([MYSTIC_STAT_OFFSET])] }, // pushbyte 3
    { opcode: 0x61, operands: [writeU30(gearType.var1943)] }, // setproperty var_1943
    // Rewrite var_8 to "L" after registration: the table key ("1171Y") is already built, but every
    // rarity if/else chain in the client only knows R/L and renders an unknown letter as the EMPTY
    // Magic overlay — i.e. Mystic cells would be frameless in every UI this patch set does not
    // cover. With "L" they all fall back to the gold Legendary frame; Mystic-only code paths key on
    // var_1943 == 3 instead of the letter.
    { opcode: 0x2c, operands: [writeU30(stringIndex(abc, "L"))] }, // pushstring "L"
    { opcode: 0x61, operands: [writeU30(gearType.var8Setter)] }, // setproperty var_8
    { opcode: OP_JUMP, branchTo: "loop" }, // jump loop
    { opcode: 0x29, label: "skip" }, // pop the dup'd GearType
    { opcode: OP_JUMP, branchTo: "loop" }, // jump loop
    { opcode: 0x47, label: "done" }, // returnvoid
  ]);
}

function pushByte(value: number): Op {
  if (value < -128 || value > 127) throw new PatchError(`pushbyte out of range: ${value}`);
  const out = Buffer.alloc(1);
  out.writeInt8(value, 0);
  return { opcode: 0x24, operands: [out] };
}

/** The revision that shipped first: red am_Base tint only, no reset arm. Kept to strip on upgrade. */
function buildLegacyCardTintV1(abc: Abc, gearType: GearTypeMultinames, card: CardMultinames): Buffer {
  return assemble([
    { opcode: 0x62, operands: [writeU30(10)] },
    { opcode: OP_IFFALSE, branchTo: "done" },
    { opcode: 0x62, operands: [writeU30(10)] },
    { opcode: 0x66, operands: [writeU30(gearType.var8)] },
    { opcode: 0x2c, operands: [writeU30(stringIndex(abc, MYSTIC_LETTER))] },
    { opcode: OP_IFNE, branchTo: "done" },
    { opcode: 0x62, operands: [writeU30(11)] },
    { opcode: OP_IFFALSE, branchTo: "done" },
    { opcode: 0x62, operands: [writeU30(11)] },
    { opcode: 0x66, operands: [writeU30(card.amBase)] },
    { opcode: 0x2a },
    { opcode: OP_IFFALSE, branchTo: "skip" },
    { opcode: 0x66, operands: [writeU30(card.transform)] },
    { opcode: 0x5d, operands: [writeU30(card.colorTransform)] },
    pushByte(RED_TINT.rMul), pushByte(RED_TINT.gMul), pushByte(RED_TINT.bMul), pushByte(RED_TINT.aMul),
    pushByte(RED_TINT.rOff), pushByte(RED_TINT.gOff), pushByte(RED_TINT.bOff), pushByte(RED_TINT.aOff),
    { opcode: 0x4a, operands: [writeU30(card.colorTransform), writeU30(8)] },
    { opcode: 0x61, operands: [writeU30(card.colorTransformProp)] },
    { opcode: OP_JUMP, branchTo: "done" },
    { opcode: 0x29, label: "skip" },
    { opcode: 0x47, label: "done" },
  ]);
}

/** Scratch register for the extra-lines pixel delta; the method's own locals are 0..32. */
const LOCAL_DELTA = 33;
const CARD_LOCAL_COUNT = 34;
/** Height of am_PowerTypeName with a single line in it (fontHeight 14px + 2px gutters each side). */
const ONE_LINE_PX = 18;

/**
 * Authored gap from the top of am_PowerTypeName to the top of am_ProcTypeName1 — measured from the
 * UI art as 38px, and identical on both card instances (hover: 43.1 -> 81.1; comparison: -201.8 ->
 * -163.8, which is anchored from the opposite edge but spans the same distance).
 *
 * The proc rows move by however far the ability text runs *past* this gap, plus a 10px breathing
 * space — hence 38 - 10 = 28. Both neighbouring values were wrong in opposite directions: sizing the
 * shift off ONE_LINE_PX (18) overshot by 20px and pushed the proc rows out through the bottom of the
 * shorter comparison card, while a bare 38 left zero gap and the text descenders collided with the
 * proc row above.
 */
const POWER_ROW_SPAN_PX = 34;
/** Air between the last proc line and the card's bottom edge. */
const BOTTOM_PAD_PX = 12;
/**
 * Extra bottom room added ONLY to the comparison card ("Currently Equipped", left side). Its
 * background is a 3-frame clip (am_Base.totalFrames > 1) whose height maps to fewer visible pixels
 * than the hover card's single-frame background, so `proc2.bottom + BOTTOM_PAD` lands ~a line short
 * and the last bonus overflows. This top-up covers it without touching the (already-correct) hover
 * card. Tunable — raise if the last line still clips, lower if there is too much empty space.
 */
const CMP_EXTRA_PAD_PX = 26;
/**
 * Extra space between the ability block and the proc rows below it, on top of the authored gap. The
 * proc rows are shifted down by `am_PowerTypeName.height - POWER_ROW_SPAN`, which preserves the stock
 * one-line gap; a taller ability block otherwise leaves the two proc lines crammed right under the
 * last ability. This is folded into that shift, so the card background (sized from the proc row)
 * grows to contain it — no overflow. Tunable.
 */
const PROC_ABILITY_GAP_PX = 12;

/**
 * Runs on every exit from `class_101.ShowGearTooltip`. The method's last instruction is its real
 * `returnvoid` *and* a branch target, so replacing that byte with `<block> + returnvoid` runs the
 * block on every path and shifts no offset. Local 10 holds the GearType, local 11 the card clip
 * (`am_GearName` is read off it), and the method has no `kill`, so both are live here.
 *
 * Mystic item: tint the whole card red and make room for the multi-line PowerRune text — shift the
 * two proc lines (text + icon) down by however much `am_PowerTypeName` grew past one line, then
 * stretch `am_Base` so the background reaches under the shifted lines.
 *
 * Anything else: reset the tint and the stretch. The card clip is reused across hovers, and the
 * stock fill re-sets text and positions but never touches colorTransform or scale — without this
 * arm one Mystic hover would leave every later tooltip red. The proc-line y positions need no
 * reset because the stock fill assigns them from constants on every call (verified).
 *
 * Every child fetch is null-guarded: a missing child skips that step, never breaks the tooltip.
 */
function buildCardTintEpilogue(abc: Abc, gearType: GearTypeMultinames, card: CardMultinames): Buffer {
  const guardedShift = (child: number, index: number): Op[] => [
    { opcode: 0x62, operands: [writeU30(11)] }, // getlocal 11 -> card
    { opcode: 0x66, operands: [writeU30(child)] }, // getproperty child
    { opcode: 0x2a }, // dup
    { opcode: OP_IFFALSE, branchTo: `noChild${index}` },
    { opcode: 0x2a }, // dup -> [child, child]
    { opcode: 0x66, operands: [writeU30(card.y)] }, // getproperty y
    { opcode: 0x62, operands: [writeU30(LOCAL_DELTA)] },
    { opcode: 0xa0 }, // add
    { opcode: 0x61, operands: [writeU30(card.y)] }, // setproperty y
    { opcode: OP_JUMP, branchTo: `afterChild${index}` },
    { opcode: 0x29, label: `noChild${index}` }, // pop
    { opcode: -1, label: `afterChild${index}` },
  ];

  const tint = (label: string, offsets: [number, number, number, number]): Op[] => [
    { opcode: 0x62, operands: [writeU30(11)], label },
    { opcode: 0x66, operands: [writeU30(card.transform)] }, // getproperty transform
    { opcode: 0x5d, operands: [writeU30(card.colorTransform)] }, // findpropstrict flash.geom::ColorTransform
    pushByte(1), pushByte(1), pushByte(1), pushByte(1),
    pushByte(offsets[0]), pushByte(offsets[1]), pushByte(offsets[2]), pushByte(offsets[3]),
    { opcode: 0x4a, operands: [writeU30(card.colorTransform), writeU30(8)] }, // constructprop, 8
    { opcode: 0x61, operands: [writeU30(card.colorTransformProp)] }, // setproperty colorTransform
  ];

  return assemble([
    { opcode: 0x62, operands: [writeU30(10)] }, // getlocal 10 -> GearType
    { opcode: OP_IFFALSE, branchTo: "done" },
    { opcode: 0x62, operands: [writeU30(11)] }, // getlocal 11 -> card
    { opcode: OP_IFFALSE, branchTo: "done" },
    { opcode: 0x62, operands: [writeU30(10)] },
    { opcode: 0x66, operands: [writeU30(gearType.var8)] }, // getproperty var_8
    { opcode: 0x2c, operands: [writeU30(stringIndex(abc, MYSTIC_LETTER))] },
    { opcode: OP_IFNE, branchTo: "reset" },

    // --- Mystic arm ---
    ...tint("tintRed", [RED_TINT.rOff, RED_TINT.gOff, RED_TINT.bOff, RED_TINT.aOff]),

    // delta = am_PowerTypeName.height - one line (autoSize has already grown the field)
    { opcode: 0x62, operands: [writeU30(11)] },
    { opcode: 0x66, operands: [writeU30(card.amPowerTypeName)] },
    { opcode: 0x2a },
    { opcode: OP_IFFALSE, branchTo: "noPtn" },
    { opcode: 0x66, operands: [writeU30(card.height)] }, // getproperty height
    pushByte(ONE_LINE_PX),
    { opcode: 0xa1 }, // subtract
    { opcode: 0x63, operands: [writeU30(LOCAL_DELTA)] }, // setlocal delta
    { opcode: OP_JUMP, branchTo: "shifts" },
    { opcode: 0x29, label: "noPtn" }, // pop
    pushByte(0),
    { opcode: 0x63, operands: [writeU30(LOCAL_DELTA)] },

    { opcode: -1, label: "shifts" },
    ...guardedShift(card.amProcTypeName1, 1),
    ...guardedShift(card.amProcRune1, 2),
    ...guardedShift(card.amProcTypeName2, 3),
    ...guardedShift(card.amProcRune2, 4),

    // am_Base.height = am_ProcTypeName2.y + am_ProcTypeName2.height + pad (absolute, so repeated
    // hovers of the same Mystic item converge instead of compounding)
    { opcode: 0x62, operands: [writeU30(11)] },
    { opcode: 0x66, operands: [writeU30(card.amBase)] },
    { opcode: 0x2a },
    { opcode: OP_IFFALSE, branchTo: "noBase" },
    { opcode: 0x62, operands: [writeU30(11)] },
    { opcode: 0x66, operands: [writeU30(card.amProcTypeName2)] },
    { opcode: 0x2a },
    { opcode: OP_IFFALSE, branchTo: "noP2" },
    { opcode: 0x2a }, // [base, p2, p2]
    { opcode: 0x66, operands: [writeU30(card.y)] }, // [base, p2, y]
    { opcode: 0x2b }, // swap -> [base, y, p2]
    { opcode: 0x66, operands: [writeU30(card.height)] }, // [base, y, p2h]
    { opcode: 0xa0 }, // add
    pushByte(BOTTOM_PAD_PX),
    { opcode: 0xa0 }, // [base, bottom]
    { opcode: 0x61, operands: [writeU30(card.height)] }, // setproperty height
    { opcode: OP_JUMP, branchTo: "done" },
    { opcode: 0x29, label: "noP2" }, // pop p2 -> [base]
    { opcode: 0x29 }, // pop base
    { opcode: OP_JUMP, branchTo: "done" },
    { opcode: 0x29, label: "noBase" },
    { opcode: OP_JUMP, branchTo: "done" },

    // --- reset arm: identity tint + un-stretch, so the reused card recovers from a Mystic hover ---
    ...tint("reset", [0, 0, 0, 0]),
    { opcode: 0x62, operands: [writeU30(11)] },
    { opcode: 0x66, operands: [writeU30(card.amBase)] },
    { opcode: 0x2a },
    { opcode: OP_IFFALSE, branchTo: "noBaseReset" },
    pushByte(1),
    { opcode: 0x61, operands: [writeU30(card.scaleY)] }, // setproperty scaleY = 1
    { opcode: OP_JUMP, branchTo: "done" },
    { opcode: 0x29, label: "noBaseReset" },

    { opcode: 0x47, label: "done" }, // returnvoid
  ]);
}

type CardMultinames = {
  amBase: number;
  transform: number;
  colorTransform: number;
  colorTransformProp: number;
  amPowerTypeName: number;
  amProcTypeName1: number;
  amProcTypeName2: number;
  amProcRune1: number;
  amProcRune2: number;
  y: number;
  height: number;
  scaleY: number;
  totalFrames: number;
  amRarityLegendary: number;
  amRarityMagic: number;
  visible: number;
};

/** Peak stack of the tint sequence: [transform, ColorTransform, 8 args]. SkinEquipmentIcon ships 6. */
const SLOTS_MAX_STACK = 11;

/** ScreenArmory.method_707 scratch registers; its own locals are 0..6. */
const ARMORY_BASE_LOCAL = 7;
const ARMORY_GEAR_ID_LOCAL = 8;
const ARMORY_LOCAL_COUNT = 9;

/** The six Rogue lockbox uniques. Contiguous, so the gate is a range check. */
const MYSTIC_FIRST_GEAR_ID = 1171;
const MYSTIC_LAST_GEAR_ID = 1176;

const OP_IFLT = 0x15;
const OP_IFGT = 0x17;
const OP_PUSHSHORT = 0x25;

/** Multinames ScreenArmory's own cell renderer uses; they carry ScreenArmory namespace sets. */
type ArmoryMultinames = { gearId: number; amBase: number; amRarityLegendary: number };

function harvestArmoryMultinames(ctx: ReturnType<typeof parseSwf>, abc: Abc): ArmoryMultinames {
  const owner = loadMethodsOf(ctx, abc, "ScreenArmory");
  const from = (opcodes: number[], name: string): number => {
    const hit = owner.find((inst) => opcodes.includes(inst.opcode) && abc.multinameNames[inst.operands[0][1]] === name);
    if (!hit) throw new PatchError(`Could not harvest ${name} from ScreenArmory.`);
    return hit.operands[0][1];
  };
  return {
    gearId: from([0x66], "gearID"),
    amBase: from([0x66], "am_Base"),
    amRarityLegendary: from([0x66], "am_RarityLegendary"),
  };
}

/**
 * Runs on every exit from `ScreenArmory.method_707(x, y, slot, gearType)` — the armory's own cell
 * renderer (it builds an `a_EmptyGearSlotMoveable` clip into local 5; the gear is local 4 and the
 * frames live under `local5.am_Base`).
 *
 * This only **recolours** the frame the stock chain already chose; it never changes which frame is
 * visible. Because the tier epilogue rewrites Mystic `var_8` to "L", the stock chain has already
 * shown the gold Legendary frame by the time this runs, so tinting it red is the whole job — and
 * nothing else about the cell's layout or art changes.
 *
 * The gate is the gearID range, not the rarity letter: the letter is "L" by then, so a letter test
 * would fire for every Legendary item in the game.
 *
 * Cells are pooled and the stock fill never touches colorTransform, so the non-Mystic arm has to
 * reset it — otherwise one Mystic cell would leave later Legendary items red.
 */
function buildArmoryCellEpilogue(abc: Abc, armory: ArmoryMultinames, card: CardMultinames): Buffer {
  const tintLegendaryFrame = (label: string, offsets: [number, number, number, number]): Op[] => [
    { opcode: 0x62, operands: [writeU30(ARMORY_BASE_LOCAL)], label },
    { opcode: 0x66, operands: [writeU30(armory.amRarityLegendary)] },
    { opcode: 0x2a }, // dup
    { opcode: OP_IFFALSE, branchTo: `${label}NoFrame` },
    { opcode: 0x66, operands: [writeU30(card.transform)] }, // getproperty transform
    { opcode: 0x5d, operands: [writeU30(card.colorTransform)] }, // findpropstrict flash.geom::ColorTransform
    pushByte(1), pushByte(1), pushByte(1), pushByte(1),
    pushByte(offsets[0]), pushByte(offsets[1]), pushByte(offsets[2]), pushByte(offsets[3]),
    { opcode: 0x4a, operands: [writeU30(card.colorTransform), writeU30(8)] }, // constructprop, 8
    { opcode: 0x61, operands: [writeU30(card.colorTransformProp)] }, // setproperty colorTransform
    { opcode: OP_JUMP, branchTo: "done" },
    { opcode: 0x29, label: `${label}NoFrame` }, // pop the dup'd frame
    { opcode: OP_JUMP, branchTo: "done" },
  ];

  return assemble([
    { opcode: 0x62, operands: [writeU30(4)] }, // getlocal 4 -> GearType
    { opcode: OP_IFFALSE, branchTo: "done" },
    { opcode: 0x62, operands: [writeU30(5)] }, // getlocal 5 -> slot clip
    { opcode: OP_IFFALSE, branchTo: "done" },
    { opcode: 0x62, operands: [writeU30(5)] },
    { opcode: 0x66, operands: [writeU30(armory.amBase)] },
    { opcode: 0x63, operands: [writeU30(ARMORY_BASE_LOCAL)] },
    { opcode: 0x62, operands: [writeU30(ARMORY_BASE_LOCAL)] },
    { opcode: OP_IFFALSE, branchTo: "done" },

    { opcode: 0x62, operands: [writeU30(4)] },
    { opcode: 0x66, operands: [writeU30(armory.gearId)] }, // getproperty gearID
    { opcode: 0x63, operands: [writeU30(ARMORY_GEAR_ID_LOCAL)] },
    { opcode: 0x62, operands: [writeU30(ARMORY_GEAR_ID_LOCAL)] },
    { opcode: OP_PUSHSHORT, operands: [writeU30(MYSTIC_FIRST_GEAR_ID)] },
    { opcode: OP_IFLT, branchTo: "reset" },
    { opcode: 0x62, operands: [writeU30(ARMORY_GEAR_ID_LOCAL)] },
    { opcode: OP_PUSHSHORT, operands: [writeU30(MYSTIC_LAST_GEAR_ID)] },
    { opcode: OP_IFGT, branchTo: "reset" },

    ...tintLegendaryFrame("mystic", [RED_TINT.rOff, RED_TINT.gOff, RED_TINT.bOff, RED_TINT.aOff]),
    ...tintLegendaryFrame("reset", [0, 0, 0, 0]),

    { opcode: 0x47, label: "done" },
  ]);
}

/**
 * Runs on every exit from `class_101.SkinEquipmentIcon` (except one mid-method early-out, which at
 * worst leaves a cell untinted). Local 1 is the GearType parameter, local 3 the cell clip; the
 * method's kills only touch locals 5 and 6, so both stay live at the tail.
 *
 * Mystic item: the stock rarity chain does not know "Y" and falls through to the Magic frame, so
 * hide that, show the Legendary frame and tint it red. Anything else: reset the Legendary frame's
 * colorTransform — cells are reused, and without the reset one Mystic cell would leave later
 * Legendary items with a red frame. Visibility needs no reset: the stock chain reassigns it on
 * every call.
 */
function buildSlotFrameEpilogue(abc: Abc, gearType: GearTypeMultinames, card: CardMultinames): Buffer {
  const ctArgs = (offsets: [number, number, number, number]): Op[] => [
    { opcode: 0x5d, operands: [writeU30(card.colorTransform)] }, // findpropstrict flash.geom::ColorTransform
    pushByte(1), pushByte(1), pushByte(1), pushByte(1),
    pushByte(offsets[0]), pushByte(offsets[1]), pushByte(offsets[2]), pushByte(offsets[3]),
    { opcode: 0x4a, operands: [writeU30(card.colorTransform), writeU30(8)] },
    { opcode: 0x61, operands: [writeU30(card.colorTransformProp)] }, // setproperty colorTransform
  ];

  return assemble([
    { opcode: 0x62, operands: [writeU30(1)] }, // getlocal 1 -> GearType
    { opcode: OP_IFFALSE, branchTo: "done" },
    { opcode: 0x62, operands: [writeU30(3)] }, // getlocal 3 -> cell clip
    { opcode: OP_IFFALSE, branchTo: "done" },
    { opcode: 0x62, operands: [writeU30(1)] },
    { opcode: 0x66, operands: [writeU30(gearType.var8)] }, // getproperty var_8
    { opcode: 0x2c, operands: [writeU30(stringIndex(abc, MYSTIC_LETTER))] },
    { opcode: OP_IFNE, branchTo: "reset" },

    // --- Mystic arm: the stock chain showed the Magic frame; swap it for a red Legendary frame ---
    { opcode: 0x62, operands: [writeU30(3)] },
    { opcode: 0x66, operands: [writeU30(card.amRarityMagic)] },
    { opcode: 0x2a }, // dup
    { opcode: OP_IFFALSE, branchTo: "noMagic" },
    { opcode: 0x27 }, // pushfalse
    { opcode: 0x61, operands: [writeU30(card.visible)] }, // setproperty visible
    { opcode: OP_JUMP, branchTo: "legendary" },
    { opcode: 0x29, label: "noMagic" }, // pop

    { opcode: 0x62, operands: [writeU30(3)], label: "legendary" },
    { opcode: 0x66, operands: [writeU30(card.amRarityLegendary)] },
    { opcode: 0x2a }, // dup
    { opcode: OP_IFFALSE, branchTo: "noLegendary" },
    { opcode: 0x2a }, // dup -> [leg, leg]
    { opcode: 0x26 }, // pushtrue
    { opcode: 0x61, operands: [writeU30(card.visible)] }, // setproperty visible -> [leg]
    { opcode: 0x66, operands: [writeU30(card.transform)] }, // getproperty transform
    ...ctArgs([RED_TINT.rOff, RED_TINT.gOff, RED_TINT.bOff, RED_TINT.aOff]),
    { opcode: OP_JUMP, branchTo: "done" },
    { opcode: 0x29, label: "noLegendary" }, // pop
    { opcode: OP_JUMP, branchTo: "done" },

    // --- reset arm: undo a red tint left by a Mystic item previously drawn into this cell ---
    { opcode: 0x62, operands: [writeU30(3)], label: "reset" },
    { opcode: 0x66, operands: [writeU30(card.amRarityLegendary)] },
    { opcode: 0x2a }, // dup
    { opcode: OP_IFFALSE, branchTo: "noLegendaryReset" },
    { opcode: 0x66, operands: [writeU30(card.transform)] },
    ...ctArgs([0, 0, 0, 0]),
    { opcode: OP_JUMP, branchTo: "done" },
    { opcode: 0x29, label: "noLegendaryReset" }, // pop

    { opcode: 0x47, label: "done" }, // returnvoid
  ]);
}

/**
 * Harvested from instructions the client already executes. `ColorTransform` in particular must come
 * from a real `constructprop` so the operand carries `QName(flash.geom, ColorTransform)` — resolving
 * it by bare name could pick an entry with the wrong namespace, which only fails at runtime.
 */
function harvestCardMultinames(ctx: ReturnType<typeof parseSwf>, abc: Abc): CardMultinames {
  const bubble = loadMethodsOf(ctx, abc, "ChatBubble");
  const fromBubble = (opcodes: number[], name: string): number => {
    const hit = bubble.find((inst) => opcodes.includes(inst.opcode) && abc.multinameNames[inst.operands[0][1]] === name);
    if (!hit) throw new PatchError(`Could not harvest ${name} from ChatBubble.`);
    return hit.operands[0][1];
  };

  const construct = bubble.find((inst) => inst.opcode === 0x4a && abc.multinameNames[inst.operands[0][1]] === "ColorTransform");
  if (!construct) throw new PatchError("No ColorTransform constructprop to harvest from ChatBubble.");
  if (construct.operands[1][1] !== 8) throw new PatchError(`ColorTransform is constructed with ${construct.operands[1][1]} args, expected 8.`);

  const owner = loadMethodsOf(ctx, abc, "class_101");
  const fromOwner = (opcodes: number[], name: string): number => {
    const hit = owner.find((inst) => opcodes.includes(inst.opcode) && abc.multinameNames[inst.operands[0][1]] === name);
    if (!hit) throw new PatchError(`Could not harvest ${name} from class_101.`);
    return hit.operands[0][1];
  };

  // totalFrames is a stock flash.display::MovieClip getter not read by class_101/ChatBubble, so
  // harvest its multiname from any getproperty across the whole SWF (correct namespace guaranteed).
  const totalFrames = harvestGlobalMultiname(ctx, abc, 0x66, "totalFrames");

  return {
    amBase: fromOwner([0x66], "am_Base"),
    transform: fromBubble([0x66], "transform"),
    colorTransform: construct.operands[0][1],
    colorTransformProp: fromBubble([0x61], "colorTransform"),
    amPowerTypeName: fromOwner([0x66], "am_PowerTypeName"),
    amProcTypeName1: fromOwner([0x66], "am_ProcTypeName1"),
    amProcTypeName2: fromOwner([0x66], "am_ProcTypeName2"),
    amProcRune1: fromOwner([0x66], "am_ProcRune1"),
    amProcRune2: fromOwner([0x66], "am_ProcRune2"),
    y: fromOwner([0x61, 0x66], "y"),
    height: fromBubble([0x66], "height"),
    scaleY: fromBubble([0x61, 0x66], "scaleY"),
    totalFrames,
    amRarityLegendary: fromOwner([0x66], "am_RarityLegendary"),
    amRarityMagic: fromOwner([0x66], "am_RarityMagic"),
    visible: fromOwner([0x61], "visible"),
  };
}

/** First multiname operand of the given opcode with the given name, scanned across every method. */
function harvestGlobalMultiname(ctx: ReturnType<typeof parseSwf>, abc: Abc, opcode: number, name: string): number {
  for (let classIndex = 0; classIndex < abc.instances.length; classIndex += 1) {
    const traits = [...abc.instances[classIndex].traits, ...(abc.classTraits[classIndex] ?? [])];
    for (const trait of traits) {
      if (trait.methodIdx === null) continue;
      const body = abc.methodBodies.get(trait.methodIdx);
      if (!body) continue;
      let insts: Instruction[];
      try {
        insts = disassemble(ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen), name);
      } catch {
        continue;
      }
      const hit = insts.find((inst) => inst.opcode === opcode && abc.multinameNames[inst.operands[0]?.[1]] === name);
      if (hit) return hit.operands[0][1];
    }
  }
  throw new PatchError(`Could not harvest a getproperty ${name} multiname anywhere in the SWF.`);
}

/** Every instruction of every method on a class, for harvesting operands. */
function loadMethodsOf(ctx: ReturnType<typeof parseSwf>, abc: Abc, className: string): Instruction[] {
  const classIndex = classIndexByName(abc, className);
  if (classIndex === null) throw new PatchError(`Class ${className} not found.`);
  const out: Instruction[] = [];
  const traits = [...abc.instances[classIndex].traits, ...(abc.classTraits[classIndex] ?? [])];
  for (const trait of traits) {
    if (trait.methodIdx === null) continue;
    const body = abc.methodBodies.get(trait.methodIdx);
    if (!body) continue;
    try {
      out.push(...disassemble(ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen), className));
    } catch {
      // Methods the shared disassembler cannot read (lookupswitch) are simply not harvested from.
    }
  }
  return out;
}

type GearTypeMultinames = { var8: number; var8Setter: number; var1943: number };

/** All multinames are harvested from GearType.method_628, the method stock code reads them in. */
function harvestGearTypeMultinames(ctx: ReturnType<typeof parseSwf>, abc: Abc): GearTypeMultinames {
  const { insts } = loadMethod(ctx, abc, staticTrait(abc, "GearType", "method_628"), "GearType.method_628");
  return {
    var8: operandAt(insts, 0x66, (inst) => abc.multinameNames[inst.operands[0][1]] === "var_8", "GearType.var_8"),
    var8Setter: operandAt(insts, 0x61, (inst) => abc.multinameNames[inst.operands[0][1]] === "var_8", "GearType.var_8 setter"),
    var1943: operandAt(insts, 0x61, (inst) => abc.multinameNames[inst.operands[0][1]] === "var_1943", "GearType.var_1943"),
  };
}

/** Re-disassembles a patched body and proves no branch lost its landing pad (VerifyError #1021). */
function assertBranchesLand(code: Buffer, label: string): void {
  const insts = disassemble(code, `${label} (patched)`);
  const last = insts[insts.length - 1];
  if (last.offset + last.size !== code.length) throw new PatchError(`${label}: patched body does not disassemble cleanly.`);

  const boundaries = new Set(insts.map((inst) => inst.offset));
  const BRANCH = new Set([0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a]);
  for (const inst of insts) {
    if (!BRANCH.has(inst.opcode)) continue;
    const dest = inst.offset + 4 + inst.operands[0][1];
    if (dest !== code.length && !boundaries.has(dest)) {
      throw new PatchError(`${label}: branch at ${inst.offset} targets ${dest}, which is no longer an instruction boundary (VerifyError #1021).`);
    }
  }
}

function patch(swfPath: string, verify: boolean, only: Only): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const gearTypeMultinames = harvestGearTypeMultinames(ctx, abc);

  const patches: BytePatch[] = [];
  const done: string[] = [];
  const skipped: string[] = [];

  if (only === "both" || only === "key") {
    const label = "Game.method_110";
    const target = loadMethod(ctx, abc, staticTrait(abc, "Game", "method_110"), label);
    const prologue = buildGearKeyPrologue(abc);

    if (target.code.subarray(0, prologue.length).equals(prologue)) {
      skipped.push(label);
    } else {
      // Prepending leaves every relative branch in the stock body correct, so nothing needs fixing up.
      assertStockGearKeyMethod(abc, target.insts, label);
      const newCode = Buffer.concat([prologue, target.code]);
      assertBranchesLand(newCode, label);
      patches.push(
        { key: `${label}.code`, start: target.body.codeStart, end: target.body.codeStart + target.body.codeLen, data: newCode, detail: `${label}: tier ${MYSTIC_TIER} -> "${MYSTIC_LETTER}" gear key` },
        { key: `${label}.codeLen`, start: target.body.codeLenPos, end: target.body.codeStart, data: writeU30(newCode.length), detail: `${label}: code length` },
      );
      done.push(label);
    }
  }

  if (only === "both" || only === "tier") {
    const label = "GearType.method_30";
    const target = loadMethod(ctx, abc, staticTrait(abc, "GearType", "method_30"), label);
    const epilogue = buildStatTierEpilogue(abc, target.insts, gearTypeMultinames);

    if (target.code.length >= epilogue.length && target.code.subarray(target.code.length - epilogue.length).equals(epilogue)) {
      skipped.push(label);
    } else {
      // The stock body ends with a redundant pair of returnvoid; the epilogue replaces it. Appending
      // past the last instruction shifts no existing offset, so the stock branches stay valid.
      const tailStart = findTrailingReturnVoidPair(target.insts, label);
      const newCode = Buffer.concat([target.code.subarray(0, tailStart), epilogue]);
      assertBranchesLand(newCode, label);
      patches.push(
        { key: `${label}.code`, start: target.body.codeStart, end: target.body.codeStart + target.body.codeLen, data: newCode, detail: `${label}: Mystic stat tier fixup` },
        { key: `${label}.codeLen`, start: target.body.codeLenPos, end: target.body.codeStart, data: writeU30(newCode.length), detail: `${label}: code length` },
      );
      done.push(label);
    }
  }

  if (only === "card") { // EXCLUDED from "both": tail placement proven unreachable in live code
    const label = "class_101.ShowGearTooltip";
    const target = loadMethod(ctx, abc, instanceTrait(abc, "class_101", "ShowGearTooltip"), label);
    const cardMultinames = harvestCardMultinames(ctx, abc);
    const epilogue = buildCardTintEpilogue(abc, gearTypeMultinames, cardMultinames);

    if (target.code.length >= epilogue.length && target.code.subarray(target.code.length - epilogue.length).equals(epilogue)) {
      skipped.push(label);
    } else {
      // A SWF carrying the first revision's epilogue is upgraded: strip it (it replaced the final
      // returnvoid, so stripping restores that byte) and append the current one.
      let code = target.code;
      const legacy = buildLegacyCardTintV1(abc, gearTypeMultinames, cardMultinames);
      if (code.length >= legacy.length && code.subarray(code.length - legacy.length).equals(legacy)) {
        code = Buffer.concat([code.subarray(0, code.length - legacy.length), Buffer.from([0x47])]);
        console.log(`  ${label}: stripping the v1 epilogue before applying v2.`);
      }

      const insts = disassemble(code, label);
      const tailStart = findFinalReturnVoid(insts, code, label);
      const newCode = Buffer.concat([code.subarray(0, tailStart), epilogue]);
      assertBranchesLand(newCode, label);
      patches.push(
        { key: `${label}.code`, start: target.body.codeStart, end: target.body.codeStart + target.body.codeLen, data: newCode, detail: `${label}: red Mystic tooltip card + ability lines layout` },
        { key: `${label}.codeLen`, start: target.body.codeLenPos, end: target.body.codeStart, data: writeU30(newCode.length), detail: `${label}: code length` },
        { key: `${label}.localCount`, start: target.body.localCountPos, end: target.body.localCountPos + 1, data: Buffer.from([CARD_LOCAL_COUNT]), detail: `${label}: scratch local for the line delta` },
      );
      done.push(label);
    }
  }

  // class_101.SkinEquipmentIcon is deliberately NOT patched: a reachability walk from offset 0
  // proved its trailing returnvoid is unreachable, so a tail epilogue there is dead code. Its
  // surfaces need the reassembler; see the notes on findFinalReturnVoid.

  if (only === "both" || only === "slots") {
    const label = "ScreenArmory.method_707";
    const target = loadMethod(ctx, abc, instanceTrait(abc, "ScreenArmory", "method_707"), label);
    const epilogue = buildArmoryCellEpilogue(abc, harvestArmoryMultinames(ctx, abc), harvestCardMultinames(ctx, abc));

    if (target.code.length >= epilogue.length && target.code.subarray(target.code.length - epilogue.length).equals(epilogue)) {
      skipped.push(label);
    } else {
      const tailStart = findSoleReturnVoid(target.insts, target.code, label);
      const newCode = Buffer.concat([target.code.subarray(0, tailStart), epilogue]);
      assertBranchesLand(newCode, label);
      patches.push(
        { key: `${label}.code`, start: target.body.codeStart, end: target.body.codeStart + target.body.codeLen, data: newCode, detail: `${label}: red Mystic armory cell frame` },
        { key: `${label}.codeLen`, start: target.body.codeLenPos, end: target.body.codeStart, data: writeU30(newCode.length), detail: `${label}: code length` },
        { key: `${label}.maxStack`, start: target.body.maxStackPos, end: target.body.maxStackPos + 1, data: Buffer.from([SLOTS_MAX_STACK]), detail: `${label}: tint sequence stack room` },
        { key: `${label}.localCount`, start: target.body.localCountPos, end: target.body.localCountPos + 1, data: Buffer.from([ARMORY_LOCAL_COUNT]), detail: `${label}: scratch local for am_Base` },
      );
      done.push(label);
    }
  }

  if (only === "both" || only === "layout") {
    const label = "class_101.method_1120";
    const target = loadMethod(ctx, abc, instanceTrait(abc, "class_101", "method_1120"), label);
    const layoutBlock = buildTooltipLayoutBlock(harvestLayoutMultinames(ctx, abc), harvestArmoryMultinames(ctx, abc).gearId);

    // Search the whole body, not the anchor: splicing moves the live return past the block, so an
    // anchor-relative check would miss it and splice a second copy on every re-run.
    if (target.code.includes(layoutBlock)) {
      skipped.push(label);
    } else {
      const anchorOffset = findLiveReturn(target.code, target.insts, label);
      const newCode = spliceIntoMethod(target.code, target.insts, anchorOffset, layoutBlock, label);
      assertBranchesLand(newCode, label);
      patches.push(
        { key: `${label}.code`, start: target.body.codeStart, end: target.body.codeStart + target.body.codeLen, data: newCode, detail: `${label}: proc rows follow the ability block` },
        { key: `${label}.codeLen`, start: target.body.codeLenPos, end: target.body.codeStart, data: writeU30(newCode.length), detail: `${label}: code length` },
        { key: `${label}.localCount`, start: target.body.localCountPos, end: target.body.localCountPos + 1, data: Buffer.from([LAYOUT_LOCAL_COUNT]), detail: `${label}: scratch local for the row delta` },
        { key: `${label}.maxStack`, start: target.body.maxStackPos, end: target.body.maxStackPos + 1, data: Buffer.from([LAYOUT_MAX_STACK]), detail: `${label}: headroom for the layout block` },
      );
      done.push(label);
    }
  }

  if (only === "both" || only === "layout") {
    const label = "class_101.ShowGearTooltip";
    const target = loadMethod(ctx, abc, instanceTrait(abc, "class_101", "ShowGearTooltip"), label);
    const growth = buildCardGrowthBlock(harvestCardMultinames(ctx, abc));
    const anchorOffset = findAfterPlayAnimation(abc, target.insts, label);

    if (target.code.includes(growth)) {
      skipped.push(label);
    } else {
      const newCode = spliceIntoMethod(target.code, target.insts, anchorOffset, growth, label);
      assertBranchesLand(newCode, label);
      patches.push(
        { key: `${label}.code`, start: target.body.codeStart, end: target.body.codeStart + target.body.codeLen, data: newCode, detail: `${label}: grow the card after PlayAnimation resets it` },
        { key: `${label}.codeLen`, start: target.body.codeLenPos, end: target.body.codeStart, data: writeU30(newCode.length), detail: `${label}: code length` },
        { key: `${label}.localCount`, start: target.body.localCountPos, end: target.body.localCountPos + 1, data: Buffer.from([SHOW_TOOLTIP_LOCAL_COUNT]), detail: `${label}: scratch local for the growth delta` },
      );
      done.push(label);
    }
  }

  if (done.length === 0) {
    console.log(`${swfPath}: already patched (only=${only}).`);
    syncClientRev(swfPath);
    return;
  }
  if (verify) {
    console.log(`${swfPath}: WOULD PATCH ${done.join(", ")}${skipped.length ? ` (already patched: ${skipped.join(", ")})` : ""}.`);
    return;
  }

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: patched ${done.join(", ")} (delta ${delta} bytes)${skipped.length ? `; already patched: ${skipped.join(", ")}` : ""}.`);
  syncClientRev(swfPath);
}

/** Guards the assumption that the stock key builder still only understands M/R/L. */
function assertStockGearKeyMethod(abc: Abc, insts: Instruction[], label: string): void {
  const letters = insts
    .filter((inst) => inst.opcode === 0x2c)
    .map((inst) => abc.stringValues[inst.operands[0][1]]);
  const expected = ["M", "R", "L"];
  if (letters.length !== expected.length || expected.some((letter, index) => letters[index] !== letter)) {
    throw new PatchError(`${label}: expected the stock rarity letters ${expected.join("/")}, found ${letters.join("/") || "none"}.`);
  }
}

/**
 * The offset of the method's final `returnvoid`, asserting it is the real exit: something branches
 * to it, so replacing it with `<block> + returnvoid` runs the block on every path out.
 */
function findFinalReturnVoid(insts: Instruction[], code: Buffer, label: string): number {
  const last = insts[insts.length - 1];
  if (last.opcode !== 0x47 || last.offset + last.size !== code.length) {
    throw new PatchError(`${label}: expected the body to end with returnvoid.`);
  }

  const BRANCH = new Set([0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a]);
  const isTarget = insts.some((inst) => BRANCH.has(inst.opcode) && inst.offset + 4 + inst.operands[0][1] === last.offset);
  if (!isTarget) {
    throw new PatchError(`${label}: the final returnvoid is not a branch target, so appending there would be dead code.`);
  }
  if (insts.some((inst) => inst.opcode === 0x08)) {
    throw new PatchError(`${label}: method contains a kill, so the locals the epilogue reads may be dead.`);
  }
  return last.offset;
}

/**
 * Same contract as `findFinalReturnVoid`, but tolerates kills on the given locals — for methods
 * whose kills provably never touch the locals the epilogue reads.
 */
function findFinalReturnVoidAllowingKills(insts: Instruction[], code: Buffer, label: string, allowed: number[]): number {
  const killed = insts.filter((inst) => inst.opcode === 0x08).map((inst) => inst.operands[0][1]);
  const unexpected = killed.filter((local) => !allowed.includes(local));
  if (unexpected.length > 0) {
    throw new PatchError(`${label}: kills locals ${unexpected.join(", ")}, which the epilogue may rely on.`);
  }
  return findFinalReturnVoidIgnoringKillCheck(insts, code, label);
}

function findFinalReturnVoidIgnoringKillCheck(insts: Instruction[], code: Buffer, label: string): number {
  const last = insts[insts.length - 1];
  if (last.opcode !== 0x47 || last.offset + last.size !== code.length) {
    throw new PatchError(`${label}: expected the body to end with returnvoid.`);
  }
  const BRANCH = new Set([0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a]);
  const isTarget = insts.some((inst) => BRANCH.has(inst.opcode) && inst.offset + 4 + inst.operands[0][1] === last.offset);
  if (!isTarget) {
    throw new PatchError(`${label}: the final returnvoid is not a branch target, so appending there would be dead code.`);
  }
  return last.offset;
}

/**
 * For methods whose final `returnvoid` is reached by fallthrough rather than branches: safe to
 * append at when it is the method's only return, because every path (bar a throw) must flow into it.
 */
const OP_IFLE = 0x16;

/** method_1120 scratch register for the measured overflow; its own locals are 0..20. */
/** Gap kept under the last proc row, matching the stock card's bottom margin. */
const CARD_BOTTOM_PAD_PX = 10;

const LAYOUT_DELTA_LOCAL = 21;
const LAYOUT_LOCAL_COUNT = 22;
/**
 * The splice sits in front of a returnvoid that stock code can reach with operands still on the
 * stack (legal — returnvoid discards them). The block is stack-neutral but peaks 3 above whatever
 * it inherits, so the ceiling has to clear the stock maxStack of 6 plus that headroom.
 */
const LAYOUT_MAX_STACK = 12;

type LayoutMultinames = {
  amBase: number;
  amPowerTypeName: number;
  amProcTypeName1: number;
  amProcTypeName2: number;
  amProcRune1: number;
  amProcRune2: number;
  y: number;
  height: number;
};

function harvestLayoutMultinames(ctx: ReturnType<typeof parseSwf>, abc: Abc): LayoutMultinames {
  const owner = loadMethodsOf(ctx, abc, "class_101");
  const from = (opcodes: number[], name: string): number => {
    const hit = owner.find((inst) => opcodes.includes(inst.opcode) && abc.multinameNames[inst.operands[0][1]] === name);
    if (!hit) throw new PatchError(`Could not harvest ${name} from class_101.`);
    return hit.operands[0][1];
  };
  const bubble = loadMethodsOf(ctx, abc, "ChatBubble");
  const height = bubble.find((inst) => inst.opcode === 0x66 && abc.multinameNames[inst.operands[0][1]] === "height");
  if (!height) throw new PatchError("Could not harvest height from ChatBubble.");

  return {
    amBase: from([0x66], "am_Base"),
    amPowerTypeName: from([0x66], "am_PowerTypeName"),
    amProcTypeName1: from([0x66], "am_ProcTypeName1"),
    amProcTypeName2: from([0x66], "am_ProcTypeName2"),
    amProcRune1: from([0x66], "am_ProcRune1"),
    amProcRune2: from([0x66], "am_ProcRune2"),
    y: from([0x61], "y"),
    height: height.operands[0][1],
  };
}

/**
 * Spliced in front of `class_101.method_1120`'s live return. That method fills the tooltip's three
 * description fields; `local3` is the card clip.
 *
 * The two proc rows sit at fixed pixel positions that land on rows 3 and 5 of the power field, so a
 * multi-line ability block (Mystic items) draws straight through them. This measures how far
 * `am_PowerTypeName` actually grew past one line and pushes the proc text and its rune icons down by
 * exactly that much.
 *
 * Gated to the six Mystic Rogue uniques (gearID 1171..1176), not self-adjusting: only those items
 * carry the authored multi-line ability text, and the user wants every other Legendary card to keep
 * its default height. `local4` is the GearType here (it is read as `local4.var_1062` throughout the
 * method and never reassigned or killed), so a gearID range test cleanly excludes everything else.
 * The measurement below still cannot compound across hovers — the stock fill re-assigns those y
 * values from constants on every call, before this runs.
 */
function buildTooltipLayoutBlock(layout: LayoutMultinames, gearId: number): Buffer {
  // Proc TEXT rows: additive `y += delta`. Safe because the stock fill re-sets am_ProcTypeName1/2.y
  // from constants on every call (verified: setproperty y off both), so each hover starts from the
  // authored y and this cannot compound.
  const shiftChild = (child: number, tag: string): Op[] => [
    { opcode: 0xd3 }, // getlocal3 -> card
    { opcode: 0x66, operands: [writeU30(child)] },
    { opcode: 0x2a }, // dup
    { opcode: OP_IFFALSE, branchTo: `${tag}Missing` },
    { opcode: 0x2a }, // dup -> [child, child]
    { opcode: 0x66, operands: [writeU30(layout.y)] }, // getproperty y
    { opcode: 0x62, operands: [writeU30(LAYOUT_DELTA_LOCAL)] },
    { opcode: 0xa0 }, // add
    { opcode: 0x61, operands: [writeU30(layout.y)] }, // setproperty y
    { opcode: OP_JUMP, branchTo: `${tag}Done` },
    { opcode: 0x29, label: `${tag}Missing` }, // pop the dup'd child
    { opcode: -1, label: `${tag}Done` },
  ];

  // Proc RUNE icons: the stock fill NEVER touches am_ProcRune1/2.y, so an additive shift would
  // compound (the icon drifts a little lower on every hover). Instead pin each icon absolutely to
  // its own text row, which the stock fill already re-anchors — non-compounding, and the icon shares
  // that row's baseline so it lands exactly where the text does.
  const alignChild = (rune: number, text: number, tag: string): Op[] => [
    { opcode: 0xd3 }, // getlocal3 -> card
    { opcode: 0x66, operands: [writeU30(rune)] },
    { opcode: 0x2a }, // dup
    { opcode: OP_IFFALSE, branchTo: `${tag}NoRune` },
    { opcode: 0xd3 }, // getlocal3
    { opcode: 0x66, operands: [writeU30(text)] },
    { opcode: 0x2a }, // dup -> [rune, text, text]
    { opcode: OP_IFFALSE, branchTo: `${tag}NoText` },
    { opcode: 0x66, operands: [writeU30(layout.y)] }, // [rune, texty]
    { opcode: 0x61, operands: [writeU30(layout.y)] }, // rune.y = texty
    { opcode: OP_JUMP, branchTo: `${tag}Done` },
    { opcode: 0x29, label: `${tag}NoText` }, // pop the dup'd (falsy) text -> [rune]
    { opcode: 0x29 }, // pop rune
    { opcode: OP_JUMP, branchTo: `${tag}Done` },
    { opcode: 0x29, label: `${tag}NoRune` }, // pop the dup'd (falsy) rune
    { opcode: -1, label: `${tag}Done` },
  ];

  return assemble([
    // Gate: only the six Mystic Rogue uniques (gearID 1171..1176) get the enlarged card. local4 is
    // the GearType; a null/undefined gear or any gearID outside the range falls straight through to
    // "done", leaving every other item's tooltip byte-for-byte as stock.
    { opcode: 0x62, operands: [writeU30(4)] }, // getlocal 4 -> GearType
    { opcode: OP_IFFALSE, branchTo: "done" },
    { opcode: 0x62, operands: [writeU30(4)] },
    { opcode: 0x66, operands: [writeU30(gearId)] }, // getproperty gearID
    { opcode: OP_PUSHSHORT, operands: [writeU30(MYSTIC_FIRST_GEAR_ID)] },
    { opcode: OP_IFLT, branchTo: "done" },
    { opcode: 0x62, operands: [writeU30(4)] },
    { opcode: 0x66, operands: [writeU30(gearId)] },
    { opcode: OP_PUSHSHORT, operands: [writeU30(MYSTIC_LAST_GEAR_ID)] },
    { opcode: OP_IFGT, branchTo: "done" },

    { opcode: 0xd3 }, // getlocal3 -> card clip
    { opcode: OP_IFFALSE, branchTo: "done" },

    // This block deliberately touches ONLY children the stock body already reads off local3
    // (am_ProcTypeName1/2, am_ProcRune1/2, am_PowerTypeName). Reaching for am_Base here is what
    // crashed the tooltip: AVM2 `getproperty` on a sealed class throws for a name the class does not
    // declare, so the null-guard never gets a chance to run. Growing the card needs a child that is
    // provably on this clip — see the notes in the memory file before trying again.

    // delta = am_PowerTypeName.height - one line, or 0 when the field is missing
    { opcode: 0xd3 },
    { opcode: 0x66, operands: [writeU30(layout.amPowerTypeName)] },
    { opcode: 0x2a }, // dup
    { opcode: OP_IFFALSE, branchTo: "noField" },
    { opcode: 0x66, operands: [writeU30(layout.height)] }, // getproperty height
    pushByte(POWER_ROW_SPAN_PX),
    { opcode: 0xa1 }, // subtract
    { opcode: 0x63, operands: [writeU30(LAYOUT_DELTA_LOCAL)] },
    { opcode: OP_JUMP, branchTo: "haveDelta" },
    { opcode: 0x29, label: "noField" }, // pop the dup'd field
    pushByte(0),
    { opcode: 0x63, operands: [writeU30(LAYOUT_DELTA_LOCAL)] },

    // A single-line field measures <= one line, so stock tooltips fall out here untouched.
    { opcode: 0x62, operands: [writeU30(LAYOUT_DELTA_LOCAL)], label: "haveDelta" },
    pushByte(0),
    { opcode: OP_IFLE, branchTo: "done" },

    // Push the proc rows an extra PROC_ABILITY_GAP below the abilities so they are not crammed under
    // the last ability line. Folded into the shift delta; the proc-sized card background follows.
    { opcode: 0x62, operands: [writeU30(LAYOUT_DELTA_LOCAL)] },
    pushByte(PROC_ABILITY_GAP_PX),
    { opcode: 0xa0 }, // add
    { opcode: 0x63, operands: [writeU30(LAYOUT_DELTA_LOCAL)] },

    ...shiftChild(layout.amProcTypeName1, "procText1"),
    ...shiftChild(layout.amProcTypeName2, "procText2"),
    ...alignChild(layout.amProcRune1, layout.amProcTypeName1, "procRune1"),
    ...alignChild(layout.amProcRune2, layout.amProcTypeName2, "procRune2"),

    { opcode: -1, label: "done" },
  ]);
}

const BRANCH_OPCODES = new Set([0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a]);

/** Every instruction offset reachable from offset 0 by following both arms of each branch. */
function reachableOffsets(insts: Instruction[]): Set<number> {
  const byOffset = new Map(insts.map((inst) => [inst.offset, inst]));
  const seen = new Set<number>();
  const work = [0];
  while (work.length > 0) {
    const offset = work.pop() as number;
    if (seen.has(offset)) continue;
    seen.add(offset);
    const inst = byOffset.get(offset);
    if (!inst) continue;
    if (inst.opcode === 0x47 || inst.opcode === 0x48 || inst.opcode === 0x03) continue; // returns / throw
    if (BRANCH_OPCODES.has(inst.opcode)) {
      work.push(inst.offset + 4 + inst.operands[0][1]);
      if (inst.opcode !== 0x10) work.push(inst.offset + inst.size);
    } else {
      work.push(inst.offset + inst.size);
    }
  }
  return seen;
}

/**
 * The offset of the method's single *reachable* return. Obfuscated bodies here routinely end in an
 * unreachable returnvoid, and splicing in front of that one produces dead code that verifies, ships,
 * and silently does nothing — the failure mode that made two earlier UI patches no-ops.
 */
/** ShowGearTooltip's own locals are 0..32; the growth delta gets a fresh scratch. */
const SHOW_TOOLTIP_DELTA_LOCAL = 33;
const SHOW_TOOLTIP_LOCAL_COUNT = 34;

/**
 * The instruction right after ShowGearTooltip's single `PlayAnimation` call. That call sizes the
 * card to its stock Single/Double state — so it is the one moment per show where am_Base is at its
 * authored height. Growing it here (rather than in method_1120, which runs *before* PlayAnimation
 * and would be reset by it) makes the growth non-compounding: every show starts from the freshly
 * reset height. The proc-row shift lives in method_1120 because those rows are code-positioned and
 * PlayAnimation leaves them alone.
 */
function findAfterPlayAnimation(abc: Abc, insts: Instruction[], label: string): number {
  const calls = insts.filter(
    (inst) => (inst.opcode === 0x46 || inst.opcode === 0x4f) && abc.multinameNames[inst.operands[0][1]] === "PlayAnimation",
  );
  if (calls.length !== 1) {
    throw new PatchError(`${label}: expected exactly one PlayAnimation call, found ${calls.length}.`);
  }
  const call = calls[0];
  const next = insts.find((inst) => inst.offset === call.offset + call.size);
  if (!next) throw new PatchError(`${label}: no instruction after the PlayAnimation call.`);
  return next.offset;
}

/**
 * `am_Base.height = am_ProcTypeName2.y + am_ProcTypeName2.height + BOTTOM_PAD` — set the card
 * background to end just below the last proc row. Stack-neutral, so the code after the splice is
 * unaffected; every child fetch is null-guarded.
 *
 * Absolute (not additive) and self-adjusting: nothing in stock resets am_Base.height, and the stock
 * fill re-anchors the proc row every hover, so recomputing from proc2 lands on the same value each
 * time (no compounding) and reproduces a non-Mystic card's default height (no leak from the reused
 * clip). Mystic items grow because method_1120 pushed their proc row down.
 *
 * Both tooltip cards run this. The bottom-anchored comparison card ("Currently Equipped") uses a
 * 3-frame am_Base whose height maps to fewer visible pixels than the hover card's single-frame
 * am_Base, so the same target lands ~a line short and the last bonus clips. It is told apart
 * reliably by `am_Base.totalFrames > 1` (hover = 1) and gets CMP_EXTRA_PAD added; the hover card is
 * untouched.
 */
function buildCardGrowthBlock(card: CardMultinames): Buffer {
  return assemble([
    { opcode: 0x62, operands: [writeU30(11)] }, // getlocal 11 -> card clip
    { opcode: 0x66, operands: [writeU30(card.amBase)] },
    { opcode: 0x2a }, // dup
    { opcode: OP_IFFALSE, branchTo: "noBase" },
    { opcode: 0x62, operands: [writeU30(11)] },
    { opcode: 0x66, operands: [writeU30(card.amProcTypeName2)] },
    { opcode: 0x2a }, // dup
    { opcode: OP_IFFALSE, branchTo: "noP2" },
    { opcode: 0x2a }, // [base, p2, p2]
    { opcode: 0x66, operands: [writeU30(card.y)] }, // [base, p2, y]
    { opcode: 0x2b }, // swap -> [base, y, p2]
    { opcode: 0x66, operands: [writeU30(card.height)] }, // [base, y, p2h]
    { opcode: 0xa0 }, // add
    pushByte(BOTTOM_PAD_PX),
    { opcode: 0xa0 }, // [base, target]
    { opcode: 0x63, operands: [writeU30(SHOW_TOOLTIP_DELTA_LOCAL)] }, // stash target -> [base] (keeps peak at 3)

    // Comparison card top-up: if am_Base.totalFrames > 1, add CMP_EXTRA_PAD to the stashed target.
    { opcode: 0x62, operands: [writeU30(11)] },
    { opcode: 0x66, operands: [writeU30(card.amBase)] },
    { opcode: 0x66, operands: [writeU30(card.totalFrames)] }, // [base, totalFrames]
    pushByte(1),
    { opcode: OP_IFLE, branchTo: "afterExtra" }, // totalFrames <= 1 (hover) -> no top-up
    { opcode: 0x62, operands: [writeU30(SHOW_TOOLTIP_DELTA_LOCAL)] },
    pushByte(CMP_EXTRA_PAD_PX),
    { opcode: 0xa0 }, // target + extra
    { opcode: 0x63, operands: [writeU30(SHOW_TOOLTIP_DELTA_LOCAL)] }, // -> [base]
    { opcode: -1, label: "afterExtra" },

    { opcode: 0x62, operands: [writeU30(SHOW_TOOLTIP_DELTA_LOCAL)] }, // [base, target]
    { opcode: 0x61, operands: [writeU30(card.height)] }, // setproperty height
    { opcode: OP_JUMP, branchTo: "done" },
    { opcode: 0x29, label: "noP2" }, // pop p2 -> [base]
    { opcode: 0x29 }, // pop base
    { opcode: OP_JUMP, branchTo: "done" },
    { opcode: 0x29, label: "noBase" }, // pop the dup'd base
    { opcode: -1, label: "done" },
  ]);
}

function findLiveReturn(code: Buffer, insts: Instruction[], label: string): number {
  const reachable = reachableOffsets(insts);
  const live = insts.filter(
    (inst) => (inst.opcode === 0x47 || inst.opcode === 0x48) && reachable.has(inst.offset),
  );
  if (live.length !== 1) {
    throw new PatchError(`${label}: expected exactly one reachable return, found ${live.length}.`);
  }
  return live[0].offset;
}

/**
 * Splices a block into the middle of a method body and re-emits every relative branch against the
 * new offsets. This is what lifts the "append at a live tail only" restriction: tails are often
 * unreachable obfuscator code, while the sites worth patching sit mid-method.
 *
 * Instruction sizes never change (a branch operand is a fixed 3-byte s24), so one pass suffices —
 * no fixpoint iteration. A branch whose target *is* the insertion offset is repointed at the
 * inserted block, so every path that jumped there now runs it and falls through into the original
 * instruction.
 *
 * Callers must still bump `code_length`, and `localCount`/`maxStack` if the block needs them.
 */
function spliceIntoMethod(code: Buffer, insts: Instruction[], atOffset: number, block: Buffer, label: string): Buffer {
  if (!insts.some((inst) => inst.offset === atOffset)) {
    throw new PatchError(`${label}: splice offset ${atOffset} is not an instruction boundary.`);
  }

  // old offset -> new offset. The insertion point maps to the start of the inserted block.
  const remap = new Map<number, number>();
  let cursor = 0;
  for (const inst of insts) {
    if (inst.offset === atOffset) cursor += block.length;
    remap.set(inst.offset, cursor);
    cursor += inst.size;
  }
  remap.set(code.length, cursor); // branches to "one past the end" are legal

  const out = Buffer.alloc(cursor);
  let write = 0;
  for (const inst of insts) {
    if (inst.offset === atOffset) {
      block.copy(out, write);
      write += block.length;
    }
    code.copy(out, write, inst.offset, inst.offset + inst.size);

    if (BRANCH_OPCODES.has(inst.opcode)) {
      const oldTarget = inst.offset + 4 + inst.operands[0][1];
      const newTarget = remap.get(oldTarget);
      if (newTarget === undefined) {
        throw new PatchError(`${label}: branch at ${inst.offset} targets ${oldTarget}, which is not an instruction boundary.`);
      }
      out.writeIntLE(newTarget - (write + 4), write + 1, 3);
    }
    write += inst.size;
  }

  if (write !== cursor) throw new PatchError(`${label}: reassembly wrote ${write} of ${cursor} bytes.`);
  return out;
}

function findSoleReturnVoid(insts: Instruction[], code: Buffer, label: string): number {
  const last = insts[insts.length - 1];
  if (last.opcode !== 0x47 || last.offset + last.size !== code.length) {
    throw new PatchError(`${label}: expected the body to end with returnvoid.`);
  }
  const returns = insts.filter((inst) => inst.opcode === 0x47 || inst.opcode === 0x48);
  if (returns.length !== 1) {
    throw new PatchError(`${label}: expected a single return, found ${returns.length}.`);
  }
  return last.offset;
}

function findTrailingReturnVoidPair(insts: Instruction[], label: string): number {
  const last = insts[insts.length - 1];
  const prev = insts[insts.length - 2];
  if (!prev || last.opcode !== 0x47 || prev.opcode !== 0x47) {
    throw new PatchError(`${label}: expected the body to end with two returnvoid instructions.`);
  }
  return prev.offset;
}

const { swfPath, verify, only } = parseArgs(process.argv);
patch(swfPath, verify, only);
