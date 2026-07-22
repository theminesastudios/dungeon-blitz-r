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

// ScreenArmory.GetPaperDollType builds the Gear Manager paper doll EntType as
//
//   <EntType EntName="PaperDoll" parent="Player:{entName}"><GfxType>...</GfxType></EntType>
//
// with no <EquippedGear> block at all, relying on parent inheritance to supply
// the gear. Inheritance brings the gear shapes across but not the player's
// dyes, so a dyed item renders in its original colour. Every other paper doll
// screen that has to show dyes (class_121, the dye screen) emits the block
// explicitly instead.
//
// This patch appends the same <EquippedGear> block, built from the live
// clientEnt EntType (local_2) that the method already resolved, using each
// EntTypeGear's var_2432 serialisation - the string that carries gear name,
// runes and both dye ids, and that LinkUpdater.method_1974 keeps current via
// EntTypeGear.method_875().

type Operand = ["u30" | "s8" | "s24", number];
type Asm =
  | { kind: "op"; opcode: number; operands?: Operand[] }
  | { kind: "branch"; opcode: number; target: string }
  | { kind: "label"; name: string };

const OP = {
  getlocal2: 0xd2,
  getlocal: 0x62,
  setlocal: 0x63,
  getlex: 0x60,
  getproperty: 0x66,
  pushstring: 0x2c,
  pushbyte: 0x24,
  pushnull: 0x20,
  convertI: 0x73,
  coerce: 0x80,
  coerceS: 0x85,
  add: 0xa0,
  inclocalI: 0xc2,
  iffalse: 0x12,
  ifge: 0x18,
  jump: 0x10,
  callproperty: 0x46,
} as const;

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
        "  npm exec tsx src/server/scripts/patch-dungeonblitz-armory-paperdoll-equipped-gear.ts [--verify] [--swf <path>]",
        "",
        "Patches ScreenArmory.GetPaperDollType in DungeonBlitz.swf so the Gear Manager",
        "paper doll emits an <EquippedGear> block carrying the player's dyes instead of",
        "inheriting undyed gear from the parent EntType.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
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
  if (kind === "u30") return writeU30(value);
  if (kind === "s8") return Buffer.from([value & 0xff]);
  if (kind === "s24") return writeS24(value);
  throw new PatchError(`Unsupported operand kind ${kind}`);
}

function assemble(items: Asm[]): Buffer {
  const sizes = items.map((item) => {
    if (item.kind === "label") return 0;
    if (item.kind === "branch") return 4;
    let size = 1;
    for (const [kind, value] of item.operands ?? []) size += operandBytes(kind, value).length;
    return size;
  });

  const offsets: number[] = [];
  let cursor = 0;
  for (const size of sizes) {
    offsets.push(cursor);
    cursor += size;
  }

  const labels = new Map<string, number>();
  items.forEach((item, index) => {
    if (item.kind === "label") labels.set(item.name, offsets[index]);
  });

  const chunks: Buffer[] = [];
  items.forEach((item, index) => {
    if (item.kind === "label") return;
    if (item.kind === "branch") {
      const target = labels.get(item.target);
      if (target === undefined) throw new PatchError(`Unresolved label ${item.target}`);
      chunks.push(Buffer.concat([Buffer.from([item.opcode]), writeS24(target - (offsets[index] + 4))]));
      return;
    }
    const parts: Buffer[] = [Buffer.from([item.opcode])];
    for (const [kind, value] of item.operands ?? []) parts.push(operandBytes(kind, value));
    chunks.push(Buffer.concat(parts));
  });

  return Buffer.concat(chunks);
}

function insertAndAdjustBranches(
  originalCode: Buffer,
  instructions: Instruction[],
  insertPos: number,
  data: Buffer,
): Buffer {
  const patched = Buffer.concat([
    originalCode.subarray(0, insertPos),
    data,
    originalCode.subarray(insertPos),
  ]);

  const shiftBeforeOrAt = (offset: number): number => (insertPos <= offset ? data.length : 0);
  const shiftBefore = (offset: number): number => (insertPos < offset ? data.length : 0);

  for (const inst of instructions) {
    if (!isBranchOpcode(inst.opcode)) continue;
    const branch = inst.operands[0];
    if (branch?.[0] !== "s24") {
      throw new PatchError(`Unexpected branch operand at original offset ${inst.offset}`);
    }
    const oldEnd = inst.offset + inst.size;
    const oldTarget = oldEnd + branch[1];
    const newInstOffset = inst.offset + shiftBeforeOrAt(inst.offset);
    const newEnd = oldEnd + shiftBefore(inst.offset);
    const newTarget = oldTarget + shiftBeforeOrAt(oldTarget);
    writeS24(newTarget - newEnd).copy(patched, newInstOffset + 1);
  }

  return patched;
}

function requireMultiname(abc: ReturnType<typeof parseAbc>, name: string): number {
  const index = abc.multinameNames.indexOf(name);
  if (index < 0) throw new PatchError(`Multiname ${name} not found`);
  return index;
}

function requireString(abc: ReturnType<typeof parseAbc>, value: string): number {
  const index = abc.stringValues.indexOf(value);
  if (index < 0) throw new PatchError(`String constant ${JSON.stringify(value)} not found`);
  return index;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * The runtime-keyed (MultinameL) index used for `foo[bar]`.
 *
 * This MUST come from ScreenArmory itself: a MultinameL carries the declaring
 * class's namespace set, so reusing another class's (e.g. LinkUpdater's) inside
 * ScreenArmory produces a method the AVM2 verifier rejects.
 *
 * A MultinameL has no real base name, so the parser reads garbage for it -
 * that is the discriminator here: take the most-used property multiname in the
 * class whose "name" is not a legal identifier.
 */
function findRuntimeKeyMultiname(
  ctx: ReturnType<typeof parseSwf>,
  abc: ReturnType<typeof parseAbc>,
  classIndex: number,
): number {
  const tally = new Map<number, number>();
  for (const trait of abc.instances[classIndex].traits) {
    if (trait.methodIdx === null) continue;
    const body = abc.methodBodies.get(trait.methodIdx);
    if (!body) continue;
    let instructions: Instruction[];
    try {
      instructions = disassemble(ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen), "scan");
    } catch {
      continue;
    }
    for (const inst of instructions) {
      if (inst.opcode !== 0x66 && inst.opcode !== 0x61) continue;
      const index = inst.operands[0][1];
      const name = abc.multinameNames[index];
      if (name === undefined || IDENTIFIER.test(name)) continue;
      tally.set(index, (tally.get(index) ?? 0) + 1);
    }
  }

  const ranked = [...tally.entries()].sort((left, right) => right[1] - left[1]);
  if (ranked.length === 0 || ranked[0][1] < 50) {
    throw new PatchError("Could not identify ScreenArmory's runtime-key multiname");
  }
  return ranked[0][0];
}

function analyzePatch(swfPath: string): { ctx: ReturnType<typeof parseSwf>; patches: BytePatch[] } {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);

  const classIndex = classIndexByName(abc, "ScreenArmory");
  if (classIndex === null) throw new PatchError("ScreenArmory not found");

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "GetPaperDollType");
  if (methodIdx === null) throw new PatchError("ScreenArmory.GetPaperDollType not found");

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) throw new PatchError("ScreenArmory.GetPaperDollType body not found");
  if (methodBody.exceptionCount !== 0) {
    throw new PatchError("ScreenArmory.GetPaperDollType unexpectedly has exception handlers");
  }

  const mn = {
    equippedGear: requireMultiname(abc, "equippedGear"),
    gearName: requireMultiname(abc, "gearName"),
    type: requireMultiname(abc, "type"),
    serialized: requireMultiname(abc, "var_2432"),
    gearTypesDict: requireMultiname(abc, "gearTypesDict"),
    slotTagName: requireMultiname(abc, "method_523"),
    class14: requireMultiname(abc, "class_14"),
    entType: requireMultiname(abc, "EntType"),
    entTypeGear: requireMultiname(abc, "EntTypeGear"),
    gearType: requireMultiname(abc, "GearType"),
    runtimeKey: findRuntimeKeyMultiname(ctx, abc, classIndex),
  };

  const str = {
    open: requireString(abc, "<EquippedGear>"),
    close: requireString(abc, "</EquippedGear>"),
    lt: requireString(abc, "<"),
    gt: requireString(abc, ">"),
    ltSlash: requireString(abc, "</"),
  };

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, "ScreenArmory.GetPaperDollType");

  // Idempotency: the block is already there if we ever push "<EquippedGear>".
  const alreadyPatched = instructions.some(
    (inst) => inst.opcode === OP.pushstring && inst.operands[0][1] === str.open,
  );
  if (alreadyPatched) return { ctx, patches: [] };

  // Anchor: the trailing `"</EntType>"` append. Insert immediately before it,
  // where the accumulated XML string is the only thing on the stack.
  const anchorIndex = instructions.findIndex(
    (inst) => inst.opcode === OP.pushstring && abc.stringValues[inst.operands[0][1]] === "</EntType>",
  );
  if (anchorIndex < 0) throw new PatchError('Could not find the trailing "</EntType>" append');
  const insertPos = instructions[anchorIndex].offset;

  // Locals: 4 = accumulator, 5 = current EntTypeGear.
  // local_2 already holds var_1.clientEnt.entType.
  const ACC = 4, GEAR = 5;
  const NEEDED_LOCALS = GEAR + 1;

  // The six slots are emitted unrolled rather than as a loop.
  //
  // Diagnostic probes established that the insertion machinery, the header
  // rewrites and high registers are all fine, and that a loop version fails
  // AVM2 verification even with its locals pre-typed. The loop's backward
  // branch is the one construct left, so this avoids it: every branch below
  // jumps forward, and at each merge the stack is empty and locals 4/5 hold
  // the same types on both paths.
  //
  // Slot tag names come from EntType.method_523(slot) - the same helper the
  // dye screen's own paper doll uses - so no GearType lookup is needed.
  const slotBlock = (slot: number): Asm[] => {
    const skip = `SKIP_${slot}`;
    return [
      // gear = entType.equippedGear[slot]
      { kind: "op", opcode: OP.getlocal2 },
      { kind: "op", opcode: OP.getproperty, operands: [["u30", mn.equippedGear]] },
      { kind: "op", opcode: OP.pushbyte, operands: [["s8", slot]] },
      { kind: "op", opcode: OP.getproperty, operands: [["u30", mn.runtimeKey]] },
      { kind: "op", opcode: OP.coerce, operands: [["u30", mn.entTypeGear]] },
      { kind: "op", opcode: OP.setlocal, operands: [["u30", GEAR]] },
      { kind: "op", opcode: OP.getlocal, operands: [["u30", GEAR]] },
      { kind: "branch", opcode: OP.iffalse, target: skip },
      { kind: "op", opcode: OP.getlocal, operands: [["u30", GEAR]] },
      { kind: "op", opcode: OP.getproperty, operands: [["u30", mn.gearName]] },
      { kind: "branch", opcode: OP.iffalse, target: skip },

      // acc += "<" + tag + ">" + gear.var_2432 + "</" + tag + ">"
      { kind: "op", opcode: OP.getlocal, operands: [["u30", ACC]] },
      { kind: "op", opcode: OP.pushstring, operands: [["u30", str.lt]] },
      { kind: "op", opcode: OP.add },
      { kind: "op", opcode: OP.getlex, operands: [["u30", mn.entType]] },
      { kind: "op", opcode: OP.pushbyte, operands: [["s8", slot]] },
      { kind: "op", opcode: OP.callproperty, operands: [["u30", mn.slotTagName], ["u30", 1]] },
      { kind: "op", opcode: OP.add },
      { kind: "op", opcode: OP.pushstring, operands: [["u30", str.gt]] },
      { kind: "op", opcode: OP.add },
      { kind: "op", opcode: OP.getlocal, operands: [["u30", GEAR]] },
      { kind: "op", opcode: OP.getproperty, operands: [["u30", mn.serialized]] },
      { kind: "op", opcode: OP.add },
      { kind: "op", opcode: OP.pushstring, operands: [["u30", str.ltSlash]] },
      { kind: "op", opcode: OP.add },
      { kind: "op", opcode: OP.getlex, operands: [["u30", mn.entType]] },
      { kind: "op", opcode: OP.pushbyte, operands: [["s8", slot]] },
      { kind: "op", opcode: OP.callproperty, operands: [["u30", mn.slotTagName], ["u30", 1]] },
      { kind: "op", opcode: OP.add },
      { kind: "op", opcode: OP.pushstring, operands: [["u30", str.gt]] },
      { kind: "op", opcode: OP.add },
      { kind: "op", opcode: OP.coerceS },
      { kind: "op", opcode: OP.setlocal, operands: [["u30", ACC]] },

      { kind: "label", name: skip },
    ];
  };

  const block = assemble([
    // acc = <incoming xml> + "<EquippedGear>"
    { kind: "op", opcode: OP.pushstring, operands: [["u30", str.open]] },
    { kind: "op", opcode: OP.add },
    { kind: "op", opcode: OP.coerceS },
    { kind: "op", opcode: OP.setlocal, operands: [["u30", ACC]] },

    // Pre-type the gear register so it is never untyped at a merge.
    { kind: "op", opcode: OP.pushnull },
    { kind: "op", opcode: OP.coerce, operands: [["u30", mn.entTypeGear]] },
    { kind: "op", opcode: OP.setlocal, operands: [["u30", GEAR]] },

    ...slotBlock(1),
    ...slotBlock(2),
    ...slotBlock(3),
    ...slotBlock(4),
    ...slotBlock(5),
    ...slotBlock(6),

    { kind: "op", opcode: OP.getlocal, operands: [["u30", ACC]] },
    { kind: "op", opcode: OP.pushstring, operands: [["u30", str.close]] },
    { kind: "op", opcode: OP.add },
  ]);

  const replacement = insertAndAdjustBranches(code, instructions, insertPos, block);

  const patches: BytePatch[] = [];

  const [maxStack, maxStackEnd] = readU30(ctx.body, methodBody.maxStackPos, "max_stack");
  if (maxStack < 4) {
    patches.push({
      key: "getpaperdolltype_max_stack",
      start: methodBody.maxStackPos,
      end: maxStackEnd,
      data: writeU30(4),
      detail: `Raise ScreenArmory.GetPaperDollType max_stack ${maxStack} -> 4`,
    });
  }

  const [localCount, localCountEnd] = readU30(ctx.body, methodBody.localCountPos, "local_count");
  const neededLocals = NEEDED_LOCALS;
  if (localCount < neededLocals) {
    patches.push({
      key: "getpaperdolltype_local_count",
      start: methodBody.localCountPos,
      end: localCountEnd,
      data: writeU30(neededLocals),
      detail: `Raise ScreenArmory.GetPaperDollType local_count ${localCount} -> ${neededLocals}`,
    });
  }

  const oldCodeLen = writeU30(methodBody.codeLen);
  patches.push(
    {
      key: "getpaperdolltype_code_len",
      start: methodBody.codeLenPos,
      end: methodBody.codeLenPos + oldCodeLen.length,
      data: writeU30(replacement.length),
      detail: `Adjust ScreenArmory.GetPaperDollType code length ${methodBody.codeLen} -> ${replacement.length}`,
    },
    {
      key: "getpaperdolltype_body",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: replacement,
      detail: "Emit an <EquippedGear> block carrying the player's dyes",
    },
  );

  return { ctx, patches };
}

function main(): number {
  const { swfPath, verify } = parseArgs(process.argv);

  try {
    const { ctx, patches } = analyzePatch(swfPath);
    console.log(`SWF: ${swfPath}`);

    if (patches.length === 0) {
      console.log("No changes needed.");
      return 0;
    }

    for (const patch of patches) console.log(`Patch: ${patch.detail}`);

    if (verify) return 1;

    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, body, delta);
    console.log("Patch apply complete.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Patch error: ${message}`);
    return 1;
  }
}

process.exit(main());
