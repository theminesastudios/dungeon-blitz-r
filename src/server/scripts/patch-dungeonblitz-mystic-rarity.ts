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
/**
 * `var_1943` is the Mystic marker every red-UI patch gates on, and 3 is a value no stock rarity ever
 * writes (Legendary 2, Rare 1, Magic 0). It has to be a property of the GearType rather than the
 * gearID, because all four rarities of a lockbox unique share one gearID — a range test reddens the
 * Magic copy too.
 *
 * The field is also the stat-table row offset (`method_377` returns level + var_1943), and 3 walks
 * off the end of those tables -> uint(undefined - baseline) -> the +4294966689 Attack garbage. The
 * `stats` part clamps that one read back to 2, so Mystic keeps Legendary stat values while carrying
 * a distinguishable marker; its identity is the rune chain + red UI, not bigger numbers.
 */
const MYSTIC_STAT_OFFSET = 3;
/** What the marker used to be, before the clamp made 3 safe. Stripped from an older build on sight. */
const LEGACY_STAT_OFFSET = 2;
/** The clamp ceiling: the highest stat-table row the client actually ships (Legendary). */
const MAX_STAT_OFFSET = 2;

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

/**
 * Tint for the Legendary rarity frame behind a Mystic item in the backpack, tuned to land on
 * MYSTIC_NAME_COLOR. Zeroing the green and blue multipliers drops the gold plate to its red channel
 * alone (offsets alone, what RED_TINT does, only shift gold to orange); the green and blue offsets
 * then lift that pure red back up to the pink-red the name text uses.
 *
 * Every argument is an integer so it fits in a `pushbyte` (-128..127) — a fractional multiplier
 * would need a double-pool entry that may not exist. To retune, keep the offsets equal to the
 * target colour's G and B: the plate's own red channel supplies R.
 */
const RED_FRAME = { rMul: 1, gMul: 0, bMul: 0, aMul: 1, rOff: 4, gOff: 0x3a, bOff: 0x4c, aOff: 0 };

/** The Mystic item name colour, replacing Legendary gold (ScreenArmory.const_23 = 0xF8E045). */
const MYSTIC_NAME_COLOR = 0xfc3a4c;

type Only = "both" | "key" | "tier" | "card" | "slots" | "layout" | "stats" | "color" | "owned";

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
      const value = argv[++index] as Only;
      const known: Only[] = ["both", "key", "tier", "card", "slots", "layout", "stats", "color", "owned"];
      if (!known.includes(value)) {
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
        "  tier  GearType.method_30 marks every 'Y' gear with var_1943 = 3.",
        "  stats GearType.method_377 clamps that marker back to the Legendary stat row.",
        "  color Red name text on the tooltip, red rarity frame in the backpack.",
        "  owned Game.GetBestOwnedGearByID finds a Mystic copy, so equipped slots fill in.",
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
function buildStatTierEpilogue(abc: Abc, method30: Instruction[], gearType: GearTypeMultinames, statOffset: number): Buffer {
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
    { opcode: 0x24, operands: [Buffer.from([statOffset])] }, // pushbyte 3 -> the Mystic marker
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
  amGearName: number;
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
};

/** Peak stack of the tint sequence: [transform, ColorTransform, 8 args]. SkinEquipmentIcon ships 6. */
const SLOTS_MAX_STACK = 11;

/** ScreenArmory.method_707 scratch register; its own locals are 0..6. */
const ARMORY_BASE_LOCAL = 7;
const ARMORY_LOCAL_COUNT = 8;

const OP_PUSHSHORT = 0x25;

/** Multinames ScreenArmory's own cell renderer uses; they carry ScreenArmory namespace sets. */
type ArmoryMultinames = { amBase: number; amRarityLegendary: number };

function harvestArmoryMultinames(ctx: ReturnType<typeof parseSwf>, abc: Abc): ArmoryMultinames {
  const owner = loadMethodsOf(ctx, abc, "ScreenArmory");
  const from = (opcodes: number[], name: string): number => {
    const hit = owner.find((inst) => opcodes.includes(inst.opcode) && abc.multinameNames[inst.operands[0][1]] === name);
    if (!hit) throw new PatchError(`Could not harvest ${name} from ScreenArmory.`);
    return hit.operands[0][1];
  };
  return {
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
 * The gate is the var_1943 marker, not the rarity letter: the letter is "L" by then, so a letter
 * test would fire for every Legendary item in the game.
 *
 * Cells are pooled and the stock fill never touches colorTransform, so the non-Mystic arm has to
 * reset it — otherwise one Mystic cell would leave later Legendary items red.
 */
function buildArmoryCellEpilogue(armory: ArmoryMultinames, card: CardMultinames, gearType: GearTypeMultinames): Buffer {
  const tintLegendaryFrame = (label: string, tint: typeof RED_FRAME): Op[] => [
    { opcode: 0x62, operands: [writeU30(ARMORY_BASE_LOCAL)], label },
    { opcode: 0x66, operands: [writeU30(armory.amRarityLegendary)] },
    { opcode: 0x2a }, // dup
    { opcode: OP_IFFALSE, branchTo: `${label}NoFrame` },
    { opcode: 0x66, operands: [writeU30(card.transform)] }, // getproperty transform
    { opcode: 0x5d, operands: [writeU30(card.colorTransform)] }, // findpropstrict flash.geom::ColorTransform
    pushByte(tint.rMul), pushByte(tint.gMul), pushByte(tint.bMul), pushByte(tint.aMul),
    pushByte(tint.rOff), pushByte(tint.gOff), pushByte(tint.bOff), pushByte(tint.aOff),
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

    ...mysticGate(4, gearType, "reset"),

    ...tintLegendaryFrame("mystic", RED_FRAME),
    ...tintLegendaryFrame("reset", { rMul: 1, gMul: 1, bMul: 1, aMul: 1, rOff: 0, gOff: 0, bOff: 0, aOff: 0 }),

    { opcode: 0x47, label: "done" },
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
    amGearName: fromOwner([0x66], "am_GearName"),
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

/**
 * The offset where a cell-fill method starts picking a rarity frame: the `getlocal` that feeds its
 * single `getproperty var_8`. Splicing there runs before the stock chain makes the Legendary plate
 * visible, with the cell clip and the GearType both in registers and nothing on the stack.
 */
function findRarityChainStart(abc: Abc, insts: Instruction[], label: string, gearLocal: number): number {
  const reads = insts.filter((inst) => inst.opcode === 0x66 && abc.multinameNames[inst.operands[0][1]] === "var_8");
  if (reads.length !== 1) throw new PatchError(`${label}: expected one var_8 read, found ${reads.length}.`);
  const index = insts.indexOf(reads[0]);
  const push = insts[index - 1];
  // getlocal_0..3 have their own one-byte opcodes; anything higher takes the operand form.
  const pushesGear = push && (gearLocal <= 3 ? push.opcode === 0xd0 + gearLocal : push.opcode === 0x62 && push.operands[0][1] === gearLocal);
  if (!pushesGear) {
    throw new PatchError(`${label}: expected the var_8 read to follow getlocal ${gearLocal} (the GearType).`);
  }
  return push.offset;
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

type GearTypeMultinames = { var8: number; var8Setter: number; var1943: number; var1943Getter: number; gearId: number };

/**
 * The write multinames come from GearType.method_628, the method stock code sets them in; the
 * var_1943 *read* comes from method_377, the only method that reads it. Both fields are declared
 * `internal`, so the harvested QName carries the package namespace and resolves from class_101 and
 * ScreenArmory too — the same cross-class read the shipped armory patch already does with gearID.
 */
function harvestGearTypeMultinames(ctx: ReturnType<typeof parseSwf>, abc: Abc): GearTypeMultinames {
  const { insts } = loadMethod(ctx, abc, staticTrait(abc, "GearType", "method_628"), "GearType.method_628");
  const owner = loadMethodsOf(ctx, abc, "GearType");
  return {
    var8: operandAt(insts, 0x66, (inst) => abc.multinameNames[inst.operands[0][1]] === "var_8", "GearType.var_8"),
    var8Setter: operandAt(insts, 0x61, (inst) => abc.multinameNames[inst.operands[0][1]] === "var_8", "GearType.var_8 setter"),
    var1943: operandAt(insts, 0x61, (inst) => abc.multinameNames[inst.operands[0][1]] === "var_1943", "GearType.var_1943"),
    var1943Getter: operandAt(owner, 0x66, (inst) => abc.multinameNames[inst.operands[0][1]] === "var_1943", "GearType.var_1943 getter"),
    gearId: operandAt(owner, 0x66, (inst) => abc.multinameNames[inst.operands[0][1]] === "gearID", "GearType.gearID"),
  };
}

/**
 * `if (local<gear>.var_1943 != 3) goto <elseLabel>` — the one Mystic test every red-UI block uses.
 *
 * A gearID range test cannot stand in for it: the Magic, Rare, Legendary and Mystic rows of a
 * lockbox unique all carry the same gearID (1171 has four), so a range gate reddens the lesser
 * copies too. var_1943 is per-GearType, so it separates them, and it needs no new table or wire
 * field — GearType.method_30 stamps it during the table load.
 */
function mysticGate(gear: number, gearType: GearTypeMultinames, elseLabel: string): Op[] {
  return [
    { opcode: 0x62, operands: [writeU30(gear)] },
    { opcode: OP_IFFALSE, branchTo: elseLabel },
    { opcode: 0x62, operands: [writeU30(gear)] },
    { opcode: 0x66, operands: [writeU30(gearType.var1943Getter)] }, // getproperty var_1943
    pushByte(MYSTIC_STAT_OFFSET),
    { opcode: OP_IFNE, branchTo: elseLabel },
  ];
}

/**
 * Prepended to `Game.GetBestOwnedGearByID(gearID)`, which answers "which copy of this item does the
 * player own?" by probing `mOwnedGear2` for "<gearID>L", then "R", then "M".
 *
 * Owned gear is keyed by `Game.method_110(gearID, tier)` — the method the `key` part teaches to
 * return "<gearID>Y" for tier 3 — so a player whose only copy is Mystic matches none of the three
 * probes and the function returns null. `ScreenArmory.method_1686` fills the six equipped slots from
 * it, and `SkinEquipmentIcon(null, slot)` hides the icon and all three rarity frames: equipping a
 * Mystic item emptied its slot. `Game.HasBetterOrEven` reads the same lookup, and was likewise
 * telling the player they did not own an item they had equipped.
 *
 * The Mystic probe goes first because the probes are in descending quality order and Mystic outranks
 * Legendary. The dictionary read is the stock one, copied instruction for instruction from the arms
 * below it — including the runtime-key `getproperty`, whose multiname has no name to look up and so
 * can only be harvested from a real dynamic lookup like these.
 */
function buildBestOwnedGearPrologue(abc: Abc, insts: Instruction[]): Buffer {
  const dict = operandAt(insts, 0x66, (inst) => abc.multinameNames[inst.operands[0][1]] === "mOwnedGear2", "Game.mOwnedGear2");
  const runtimeKey = operandAt(insts, 0x66, (inst) => abc.multinameNames[inst.operands[0][1]] === "*", "the runtime-key multiname");

  return assemble([
    { opcode: 0xd0 }, // getlocal0 -> this
    { opcode: 0x66, operands: [writeU30(dict)] }, // getproperty mOwnedGear2
    { opcode: 0xd1 }, // getlocal1 -> gearID
    { opcode: 0x2c, operands: [writeU30(stringIndex(abc, MYSTIC_LETTER))] }, // pushstring "Y"
    { opcode: 0xa0 }, // add (uint + String concatenates, as String(gearID) + letter does)
    { opcode: 0x66, operands: [writeU30(runtimeKey)] }, // getproperty mOwnedGear2[key]
    { opcode: 0x2a }, // dup
    { opcode: OP_IFFALSE, branchTo: "stock" },
    { opcode: 0x48 }, // returnvalue -> the Mystic copy
    { opcode: 0x29, label: "stock" }, // pop the dup'd null
  ]);
}

/** Peak stack of the Mystic probe: [dict, gearID, "Y"]. */
const BEST_OWNED_MAX_STACK = 3;

/**
 * Prepended to `GearType.method_377`, which returns `level + var_1943` — the row a gear's stats are
 * read from. The Mystic marker (3) is one row past the last one the client ships, so this clamps it:
 * a Mystic item reads the Legendary row, exactly as it did when the marker was 2.
 *
 * Prepending keeps every relative branch in the stock body correct, and the block needs no scope
 * (getproperty on a local resolves without one), so it is safe in front of the body's `pushscope`.
 */
function buildStatClampPrologue(gearType: GearTypeMultinames): Buffer {
  return assemble([
    { opcode: 0xd0 }, // getlocal0 -> this
    { opcode: 0x66, operands: [writeU30(gearType.var1943Getter)] }, // getproperty var_1943
    pushByte(MAX_STAT_OFFSET),
    { opcode: OP_IFLE, branchTo: "stock" }, // var_1943 <= 2 -> stock behaviour
    { opcode: 0xd1 }, // getlocal1 -> level
    pushByte(MAX_STAT_OFFSET),
    { opcode: 0xa0 }, // add
    { opcode: 0x48 }, // returnvalue (coerced to uint by the method signature)
    { opcode: -1, label: "stock" },
  ]);
}

/**
 * Spliced into `class_101.ShowGearTooltip` after the name has been filled in. Local 10 is the
 * GearType, local 11 the tooltip card; `MathUtil.method_8` sets `am_GearName.textColor` from the
 * rarity letter and then the text, so overwriting textColor here recolours the name that is already
 * on screen.
 *
 * The name colour cannot be fixed in `class_101.method_37` (the rarity -> colour map) instead: that
 * function only ever sees the letter, and a Mystic GearType reports "L" by the time it is called.
 *
 * No reset arm is needed — method_8 re-assigns textColor on every show, so the next non-Mystic
 * tooltip repaints itself gold.
 */
function buildTooltipNameColorBlock(gearType: GearTypeMultinames, card: CardMultinames, textColor: number): Buffer {
  return assemble([
    ...mysticGate(10, gearType, "done"),
    { opcode: 0x62, operands: [writeU30(11)] }, // getlocal 11 -> card
    { opcode: OP_IFFALSE, branchTo: "done" },
    { opcode: 0x62, operands: [writeU30(11)] },
    { opcode: 0x66, operands: [writeU30(card.amGearName)] }, // getproperty am_GearName
    { opcode: 0x2a }, // dup
    { opcode: OP_IFFALSE, branchTo: "noField" },
    ...pushColor(MYSTIC_NAME_COLOR),
    { opcode: 0x61, operands: [writeU30(textColor)] }, // setproperty textColor
    { opcode: OP_JUMP, branchTo: "done" },
    { opcode: 0x29, label: "noField" }, // pop the dup'd (falsy) field
    { opcode: -1, label: "done" },
  ]);
}

/**
 * A 24-bit colour with no constant-pool entry: `(high << 16) + low`. `pushint` would need an int the
 * pool may not carry, and `pushbyte` only reaches 127; two `pushshort`s and a shift reach any RGB.
 */
function pushColor(rgb: number): Op[] {
  return [
    { opcode: OP_PUSHSHORT, operands: [writeU30(rgb >>> 16)] },
    { opcode: OP_PUSHSHORT, operands: [writeU30(16)] },
    { opcode: 0xa5 }, // lshift
    { opcode: OP_PUSHSHORT, operands: [writeU30(rgb & 0xffff)] },
    { opcode: 0xa0 }, // add
  ];
}

/**
 * Spliced into a cell-fill method right where it starts choosing a rarity frame, so it runs with the
 * cell clip and the GearType both in registers. Two methods use it: `ScreenArmory.method_1591` (the
 * backpack grid, cell in local 6 and gear in local 10) and `class_101.SkinEquipmentIcon` (the six
 * equipped slots and the character screen, cell in local 3 and gear in local 1).
 *
 * A Mystic gear reports "L", so the stock chain immediately below this shows the gold Legendary
 * plate; all this does is recolour that plate red. Nothing about the cell's layout or art changes.
 *
 * Cells are pooled and the stock fill never touches colorTransform, so the non-Mystic arm has to
 * reset it — otherwise one Mystic item would leave a red plate behind for the next Legendary drop.
 */
function buildRarityFrameBlock(frame: number, card: CardMultinames, gearType: GearTypeMultinames, cellLocal: number, gearLocal: number): Buffer {
  const tintFrame = (label: string, tint: typeof RED_FRAME): Op[] => [
    { opcode: 0x62, operands: [writeU30(cellLocal)], label },
    { opcode: 0x66, operands: [writeU30(frame)] },
    { opcode: 0x2a }, // dup
    { opcode: OP_IFFALSE, branchTo: `${label}NoFrame` },
    { opcode: 0x66, operands: [writeU30(card.transform)] }, // getproperty transform
    { opcode: 0x5d, operands: [writeU30(card.colorTransform)] }, // findpropstrict flash.geom::ColorTransform
    pushByte(tint.rMul), pushByte(tint.gMul), pushByte(tint.bMul), pushByte(tint.aMul),
    pushByte(tint.rOff), pushByte(tint.gOff), pushByte(tint.bOff), pushByte(tint.aOff),
    { opcode: 0x4a, operands: [writeU30(card.colorTransform), writeU30(8)] }, // constructprop, 8 args
    { opcode: 0x61, operands: [writeU30(card.colorTransformProp)] }, // setproperty colorTransform
    { opcode: OP_JUMP, branchTo: "done" },
    { opcode: 0x29, label: `${label}NoFrame` }, // pop the dup'd (falsy) frame
    { opcode: OP_JUMP, branchTo: "done" },
  ];

  const IDENTITY = { rMul: 1, gMul: 1, bMul: 1, aMul: 1, rOff: 0, gOff: 0, bOff: 0, aOff: 0 };

  return assemble([
    { opcode: 0x62, operands: [writeU30(cellLocal)] },
    { opcode: OP_IFFALSE, branchTo: "done" },
    ...mysticGate(gearLocal, gearType, "reset"),
    ...tintFrame("mystic", RED_FRAME),
    ...tintFrame("reset", IDENTITY),
    { opcode: -1, label: "done" },
  ]);
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
    const epilogue = buildStatTierEpilogue(abc, target.insts, gearTypeMultinames, MYSTIC_STAT_OFFSET);

    if (target.code.length >= epilogue.length && target.code.subarray(target.code.length - epilogue.length).equals(epilogue)) {
      skipped.push(label);
    } else {
      // A SWF carrying the offset-2 epilogue is upgraded in place: strip it (restoring the returnvoid
      // pair it replaced) so the marker epilogue can be appended in its place rather than after it.
      let code = target.code;
      const legacy = buildStatTierEpilogue(abc, target.insts, gearTypeMultinames, LEGACY_STAT_OFFSET);
      if (code.length >= legacy.length && code.subarray(code.length - legacy.length).equals(legacy)) {
        code = Buffer.concat([code.subarray(0, code.length - legacy.length), Buffer.from([0x47, 0x47])]);
        console.log(`  ${label}: stripping the offset-${LEGACY_STAT_OFFSET} epilogue before applying the marker.`);
      }

      // The stock body ends with a redundant pair of returnvoid; the epilogue replaces it. Appending
      // past the last instruction shifts no existing offset, so the stock branches stay valid.
      const tailStart = findTrailingReturnVoidPair(disassemble(code, label), label);
      const newCode = Buffer.concat([code.subarray(0, tailStart), epilogue]);
      assertBranchesLand(newCode, label);
      patches.push(
        { key: `${label}.code`, start: target.body.codeStart, end: target.body.codeStart + target.body.codeLen, data: newCode, detail: `${label}: Mystic stat tier fixup` },
        { key: `${label}.codeLen`, start: target.body.codeLenPos, end: target.body.codeStart, data: writeU30(newCode.length), detail: `${label}: code length` },
      );
      done.push(label);
    }
  }

  if (only === "both" || only === "stats") {
    const label = "GearType.method_377";
    const target = loadMethod(ctx, abc, instanceTrait(abc, "GearType", "method_377"), label);
    const prologue = buildStatClampPrologue(gearTypeMultinames);

    if (target.code.subarray(0, prologue.length).equals(prologue)) {
      skipped.push(label);
    } else {
      // Order matters: without this the tier part's marker (3) indexes one row past the last stat
      // table and every Mystic stat renders as uint garbage. Both always ship together under "both".
      const reads = target.insts.filter((inst) => inst.opcode === 0x66 && abc.multinameNames[inst.operands[0][1]] === "var_1943");
      if (reads.length !== 1) throw new PatchError(`${label}: expected one var_1943 read, found ${reads.length}.`);
      const newCode = Buffer.concat([prologue, target.code]);
      assertBranchesLand(newCode, label);
      patches.push(
        { key: `${label}.code`, start: target.body.codeStart, end: target.body.codeStart + target.body.codeLen, data: newCode, detail: `${label}: clamp the Mystic marker to the Legendary stat row` },
        { key: `${label}.codeLen`, start: target.body.codeLenPos, end: target.body.codeStart, data: writeU30(newCode.length), detail: `${label}: code length` },
      );
      done.push(label);
    }
  }

  if (only === "both" || only === "owned") {
    const label = "Game.GetBestOwnedGearByID";
    const target = loadMethod(ctx, abc, instanceTrait(abc, "Game", "GetBestOwnedGearByID"), label);
    const prologue = buildBestOwnedGearPrologue(abc, target.insts);

    if (target.code.subarray(0, prologue.length).equals(prologue)) {
      skipped.push(label);
    } else {
      assertStockRarityProbes(abc, target.insts, label);
      const newCode = Buffer.concat([prologue, target.code]);
      assertBranchesLand(newCode, label);
      patches.push(
        { key: `${label}.code`, start: target.body.codeStart, end: target.body.codeStart + target.body.codeLen, data: newCode, detail: `${label}: find the Mystic copy before the Legendary one` },
        { key: `${label}.codeLen`, start: target.body.codeLenPos, end: target.body.codeStart, data: writeU30(newCode.length), detail: `${label}: code length` },
        { key: `${label}.maxStack`, start: target.body.maxStackPos, end: target.body.maxStackPos + 1, data: Buffer.from([Math.max(ctx.body[target.body.maxStackPos], BEST_OWNED_MAX_STACK)]), detail: `${label}: probe stack room` },
      );
      done.push(label);
    }
  }

  // Every surface that draws a rarity plate for one item: the backpack grid, and the shared icon
  // skinner behind the six equipped slots and the character screen.
  const frameSites = [
    { className: "ScreenArmory", method: "method_1591", cellLocal: 6, gearLocal: 10, detail: "red Mystic frame in the backpack grid" },
    { className: "class_101", method: "SkinEquipmentIcon", cellLocal: 3, gearLocal: 1, detail: "red Mystic frame on equipped slots" },
  ];

  for (const site of frameSites) {
    if (only !== "both" && only !== "color") break;
    const label = `${site.className}.${site.method}`;
    const target = loadMethod(ctx, abc, instanceTrait(abc, site.className, site.method), label);
    const cardMultinames = harvestCardMultinames(ctx, abc);
    const frame = site.className === "ScreenArmory" ? harvestArmoryMultinames(ctx, abc).amRarityLegendary : cardMultinames.amRarityLegendary;
    const block = buildRarityFrameBlock(frame, cardMultinames, gearTypeMultinames, site.cellLocal, site.gearLocal);

    if (target.code.includes(block)) {
      skipped.push(label);
      continue;
    }
    const anchor = findRarityChainStart(abc, target.insts, label, site.gearLocal);
    const newCode = spliceIntoMethod(target.code, target.insts, anchor, block, label);
    assertBranchesLand(newCode, label);
    patches.push(
      { key: `${label}.code`, start: target.body.codeStart, end: target.body.codeStart + target.body.codeLen, data: newCode, detail: `${label}: ${site.detail}` },
      { key: `${label}.codeLen`, start: target.body.codeLenPos, end: target.body.codeStart, data: writeU30(newCode.length), detail: `${label}: code length` },
      { key: `${label}.maxStack`, start: target.body.maxStackPos, end: target.body.maxStackPos + 1, data: Buffer.from([Math.max(ctx.body[target.body.maxStackPos], SLOTS_MAX_STACK)]), detail: `${label}: tint sequence stack room` },
    );
    done.push(label);
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
    const epilogue = buildArmoryCellEpilogue(harvestArmoryMultinames(ctx, abc), harvestCardMultinames(ctx, abc), gearTypeMultinames);

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
    const layoutMultinames = harvestLayoutMultinames(ctx, abc);
    const layoutBlock = buildTooltipLayoutBlock(layoutMultinames, gearTypeMultinames);
    const mysticOnlyLayoutBlock = buildTooltipLayoutBlock(layoutMultinames, gearTypeMultinames, true);

    // Search the whole body, not the anchor: splicing moves the live return past the block, so an
    // anchor-relative check would miss it and splice a second copy on every re-run.
    if (target.code.includes(layoutBlock)) {
      skipped.push(label);
    } else if (target.code.includes(mysticOnlyLayoutBlock)) {
      // The old and new blocks deliberately have identical lengths; replacing only the gate bytes
      // preserves every surrounding branch target in this already-patched method body.
      const newCode = Buffer.from(target.code);
      layoutBlock.copy(newCode, target.code.indexOf(mysticOnlyLayoutBlock));
      assertBranchesLand(newCode, label);
      patches.push({
        key: `${label}.code`,
        start: target.body.codeStart,
        end: target.body.codeStart + target.body.codeLen,
        data: newCode,
        detail: `${label}: proc rows follow every multi-line ability block`,
      });
      done.push(label);
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

  // Both of ShowGearTooltip's blocks go in one pass: two patch entries for the same method body
  // would collide on the same key, and each splice has to be measured against the code the previous
  // one produced. A block already present in the body is left alone, so parts stay independent.
  if (only === "both" || only === "layout" || only === "color") {
    const label = "class_101.ShowGearTooltip";
    const target = loadMethod(ctx, abc, instanceTrait(abc, "class_101", "ShowGearTooltip"), label);
    const cardMultinames = harvestCardMultinames(ctx, abc);
    const textColor = harvestGlobalMultiname(ctx, abc, 0x61, "textColor");
    const blocks = [
      { part: "layout", detail: "grow the card after PlayAnimation resets it", block: buildCardGrowthBlock(cardMultinames) },
      { part: "color", detail: "red Mystic item name", block: buildTooltipNameColorBlock(gearTypeMultinames, cardMultinames, textColor) },
    ];

    let code = target.code;
    const applied: string[] = [];
    for (const { part, detail, block } of blocks) {
      if (only !== "both" && only !== part) continue;
      if (code.includes(block)) continue;
      const insts = disassemble(code, label);
      // Both blocks anchor after PlayAnimation: it is the one point per show where the card is back
      // at its authored state, so neither growth nor colour can compound across hovers.
      code = spliceIntoMethod(code, insts, findAfterPlayAnimation(abc, insts, label), block, label);
      applied.push(detail);
    }

    if (applied.length === 0) {
      skipped.push(label);
    } else {
      assertBranchesLand(code, label);
      patches.push(
        { key: `${label}.code`, start: target.body.codeStart, end: target.body.codeStart + target.body.codeLen, data: code, detail: `${label}: ${applied.join(", ")}` },
        { key: `${label}.codeLen`, start: target.body.codeLenPos, end: target.body.codeStart, data: writeU30(code.length), detail: `${label}: code length` },
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

/**
 * Guards the assumption that the owned-gear probe still tries exactly the three stock rarities, in
 * descending order — the property that makes prepending a Mystic probe the whole fix.
 */
function assertStockRarityProbes(abc: Abc, insts: Instruction[], label: string): void {
  const letters = insts
    .filter((inst) => inst.opcode === 0x2c)
    .map((inst) => abc.stringValues[inst.operands[0][1]])
    .filter((value) => value === "M" || value === "R" || value === "L" || value === MYSTIC_LETTER);
  // The body is jump-scrambled, so the probes appear in reverse of their run order.
  if (letters.join("") !== "MRL") {
    throw new PatchError(`${label}: expected the stock rarity probes M/R/L, found ${letters.join("/") || "none"}.`);
  }
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
 * For methods whose final `returnvoid` is reached by fallthrough rather than branches: safe to
 * append at when it is the method's only return, because every path (bar a throw) must flow into it.
 */
const OP_IFLE = 0x16;

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
 * exactly that much. This is intentionally rarity-agnostic: Mystic and Legendary gear can both
 * carry multi-line ability text now. A stock single-line field produces a non-positive delta and
 * exits without moving anything. The measurement cannot compound across hovers because the stock
 * fill re-assigns the proc text y values from constants before this runs.
 */
function buildTooltipLayoutBlock(layout: LayoutMultinames, gearType: GearTypeMultinames, mysticOnly = false): Buffer {
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

  // Keep the replacement byte-for-byte the same length as the earlier Mystic-only block. This lets
  // an already-patched SWF upgrade in place without shifting surrounding AVM2 branch offsets.
  const legacyGate = mysticGate(4, gearType, "done");
  const legacyGateLength = assemble([...legacyGate, { opcode: -1, label: "done" }]).length;
  const gate: Op[] = mysticOnly
    ? legacyGate
    : Array.from({ length: legacyGateLength }, () => ({ opcode: 0x02 })); // nop

  return assemble([
    ...gate,

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
