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
  writeSwf,
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

// The Gear Manager ships with six gear-set rows. Three separate numbers hold
// that ceiling in place and all of them have to move together:
//
//   Game.const_1057      - the create gate ("param1 < Game.const_1057"), 6
//   GearType.const_348   - the bit width of every gear-set index on the wire, 3
//   ScreenArmory.const_134 - the UI row count, 6
//
// const_134 is shared: four of its eight read sites drive the var_472 gear-set
// rows, the other four drive the var_762 am_Pointer arrows of the socket panel,
// and there are only ever six of those clips. So const_134 keeps its value and
// the four gear-set sites are rewritten to a literal 10 instead.
//
// The matching row clips (am_GearSet6..am_GearSet9) are added to UI_4.swf by
// patch-ui4-gear-manager-slots.ts; without that patch the constructor walks off
// the end of am_GearSets and dies on a null MovieClip.
//
// The wire side needs 4 bits because the index is sent as an unsigned field on
// 0xC6/0xC7/0xC8 and the set count rides the same width in the player-data
// packet. GearSetHandler and WorldEnter on the server carry the same 4.

const NEW_GEAR_SET_COUNT = 10;
const NEW_INDEX_BITS = 4;

const OP_PUSHBYTE = 0x24;
const OP_CONVERT_U = 0x74;
const OP_NOP = 0x02;
const OP_GETLEX = 0x60;
const OP_FINDPROPSTRICT = 0x5e;
const OP_GETPROPERTY = 0x66;
const OP_SETPROPERTY = 0x61;
const OP_PUSHTRUE = 0x26;
const OP_CONSTRUCT = 0x42;

type Abc = ReturnType<typeof parseAbc>;

interface MethodCode {
  name: string;
  codeStart: number;
  instructions: Instruction[];
}

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
        "  ts-node src/server/scripts/patch-dungeonblitz-gear-manager-slots.ts [--verify] [--swf <path>]",
        "",
        "Raises the Gear Manager from 6 gear sets to 10 and widens the gear-set",
        "index field from 3 to 4 bits. Run patch-ui4-gear-manager-slots.ts too -",
        "the extra row clips live in UI_4.swf.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function multinameOf(abc: Abc, inst: Instruction): string | null {
  const operand = inst.operands[0];
  if (!operand || operand[0] !== "u30") {
    return null;
  }
  return abc.multinameNames[operand[1]] ?? null;
}

function pushByteValue(inst: Instruction): number | null {
  const operand = inst.operands[0];
  if (inst.opcode !== OP_PUSHBYTE || !operand || operand[0] !== "s8") {
    return null;
  }
  return operand[1];
}

function methodsOfClass(ctx: ReturnType<typeof parseSwf>, abc: Abc, className: string): MethodCode[] {
  const classIndex = classIndexByName(abc, className);
  if (classIndex === null) {
    throw new PatchError(`Could not find ${className} class.`);
  }

  const instance = abc.instances[classIndex];
  const methodIndices = new Set<number>([instance.iinitMethodIdx]);
  for (const trait of instance.traits) {
    if (trait.methodIdx !== null) {
      methodIndices.add(trait.methodIdx);
    }
  }
  for (const trait of abc.classTraits[classIndex] ?? []) {
    if (trait.methodIdx !== null) {
      methodIndices.add(trait.methodIdx);
    }
  }

  const out: MethodCode[] = [];
  for (const methodIdx of methodIndices) {
    const body = abc.methodBodies.get(methodIdx);
    if (!body) {
      continue;
    }
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    try {
      out.push({
        name: `${className}#${methodIdx}`,
        codeStart: body.codeStart,
        instructions: disassemble(code, `${className}#${methodIdx}`),
      });
    } catch {
      // Obfuscated bodies the disassembler chokes on never mention const_134.
    }
  }
  return out;
}

// pushbyte is two bytes; getlex is two or three depending on the multiname
// index width. Pad with convert_u (which is what the uint const would have
// produced anyway) and then nops so the replacement is byte-for-byte the same
// length and no branch target has to move.
function literalPush(value: number, size: number): Buffer {
  if (size < 2) {
    throw new PatchError(`Cannot fit a literal push into ${size} bytes.`);
  }
  const bytes = [OP_PUSHBYTE, value];
  if (size >= 3) {
    bytes.push(OP_CONVERT_U);
  }
  while (bytes.length < size) {
    bytes.push(OP_NOP);
  }
  return Buffer.from(bytes);
}

function multinameIndex(abc: Abc, constName: string): number {
  const matches: number[] = [];
  abc.multinameNames.forEach((name, index) => {
    if (name === constName) {
      matches.push(index);
    }
  });
  if (matches.length !== 1) {
    throw new PatchError(`Expected one multiname named ${constName}, found ${matches.length}.`);
  }
  return matches[0];
}

function encodeU30(value: number): number[] {
  const out: number[] = [];
  let rest = value;
  do {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) {
      byte |= 0x80;
    }
    out.push(byte);
  } while (rest !== 0);
  return out;
}

// Both constants are written by a class initialiser, and class initialisers are
// neither reachable from the traits nor walkable by the disassembler here -
// they are the obfuscated bodies with the poisoned jump tables. Their store is
// a fixed five-byte shape though:
//
//   findpropstrict <const>   pushbyte <value>
//
// so it is located by scanning the ABC for those bytes and asserting the match
// is unique.
function constInitPatch(
  ctx: ReturnType<typeof parseSwf>,
  abc: Abc,
  className: string,
  constName: string,
  oldValue: number,
  newValue: number,
): { patch: BytePatch | null; current: number } {
  const prefix = Buffer.from([OP_FINDPROPSTRICT, ...encodeU30(multinameIndex(abc, constName)), OP_PUSHBYTE]);
  const hits: Array<{ at: number; value: number }> = [];

  for (let at = ctx.abcStart; at + prefix.length < ctx.body.length; at += 1) {
    if (ctx.body.compare(prefix, 0, prefix.length, at, at + prefix.length) !== 0) {
      continue;
    }
    hits.push({ at: at + prefix.length - 1, value: ctx.body.readInt8(at + prefix.length) });
  }

  if (hits.length !== 1) {
    throw new PatchError(
      `Expected exactly one initialiser for ${className}.${constName}, found ${hits.length}.`,
    );
  }

  const hit = hits[0];
  if (hit.value === newValue) {
    return { patch: null, current: hit.value };
  }
  if (hit.value !== oldValue) {
    throw new PatchError(
      `${className}.${constName} initialises to ${hit.value}, expected ${oldValue} or ${newValue}.`,
    );
  }

  return {
    current: hit.value,
    patch: {
      key: `${className}.${constName}`,
      start: hit.at,
      end: hit.at + 2,
      data: Buffer.from([OP_PUSHBYTE, newValue]),
      detail: `set ${className}.${constName} from ${oldValue} to ${newValue}`,
    },
  };
}

// True when the method touches the gear-set row vector and not the socket-panel
// pointer vector. The constructor touches both, so it is reported separately.
function vectorsTouched(abc: Abc, instructions: Instruction[]): { rows: boolean; pointers: boolean } {
  let rows = false;
  let pointers = false;
  for (const inst of instructions) {
    if (inst.opcode !== OP_GETPROPERTY && inst.opcode !== OP_SETPROPERTY) {
      continue;
    }
    const name = multinameOf(abc, inst);
    if (name === "var_472") {
      rows = true;
    } else if (name === "var_762") {
      pointers = true;
    }
  }
  return { rows, pointers };
}

function vectorNameAt(abc: Abc, inst: Instruction): "rows" | "pointers" | null {
  if (inst.opcode !== OP_GETPROPERTY && inst.opcode !== OP_SETPROPERTY) {
    return null;
  }
  const name = multinameOf(abc, inst);
  if (name === "var_472") {
    return "rows";
  }
  if (name === "var_762") {
    return "pointers";
  }
  return null;
}

// In the constructor both vectors are built by the same shape of code:
//
//   getlex const_134; pushtrue; construct 2; setproperty var_472   (allocate)
//   ...
//   getlocal2; getlex const_134; iflt <body>                       (loop bound)
//
// with the gear-set pair first and the pointer pair second. Rather than trust
// that order, each read is attributed structurally: an allocation by the
// setproperty a couple of instructions later, a loop bound by walking the body
// the backward branch jumps to.
function ownerOfSite(abc: Abc, instructions: Instruction[], siteIndex: number): "rows" | "pointers" | null {
  const next = instructions[siteIndex + 1];
  if (!next) {
    return null;
  }

  if (next.opcode === OP_PUSHTRUE && instructions[siteIndex + 2]?.opcode === OP_CONSTRUCT) {
    for (let index = siteIndex + 3; index <= siteIndex + 5 && index < instructions.length; index += 1) {
      const owner = vectorNameAt(abc, instructions[index]);
      if (owner) {
        return owner;
      }
    }
    return null;
  }

  const branch = next.operands[0];
  if (!branch || branch[0] !== "s24") {
    return null;
  }
  const target = next.offset + next.size + branch[1];
  if (target >= next.offset) {
    // Not a loop: nothing to scan.
    return null;
  }
  for (let index = 0; index < siteIndex; index += 1) {
    if (instructions[index].offset < target) {
      continue;
    }
    const owner = vectorNameAt(abc, instructions[index]);
    if (owner) {
      return owner;
    }
  }
  return null;
}

function gearSetRowCountPatches(ctx: ReturnType<typeof parseSwf>, abc: Abc): {
  patches: BytePatch[];
  remaining: number;
} {
  const patches: BytePatch[] = [];
  let remaining = 0;

  for (const method of methodsOfClass(ctx, abc, "ScreenArmory")) {
    const { instructions, codeStart, name } = method;
    const sites: number[] = [];
    for (let index = 0; index < instructions.length; index += 1) {
      const inst = instructions[index];
      if (inst.opcode === OP_GETLEX && multinameOf(abc, inst) === "const_134") {
        sites.push(index);
      }
    }
    if (sites.length === 0) {
      continue;
    }

    const touched = vectorsTouched(abc, instructions);
    for (const siteIndex of sites) {
      const owner = touched.rows && touched.pointers
        ? ownerOfSite(abc, instructions, siteIndex)
        : touched.rows
          ? "rows"
          : "pointers";
      if (owner === null) {
        throw new PatchError(`Could not attribute a const_134 read in ${name}.`);
      }
      if (owner !== "rows") {
        continue;
      }

      const inst = instructions[siteIndex];
      remaining += 1;
      patches.push({
        key: `ScreenArmory.gearSetRows@${name}+${inst.offset}`,
        start: codeStart + inst.offset,
        end: codeStart + inst.offset + inst.size,
        data: literalPush(NEW_GEAR_SET_COUNT, inst.size),
        detail: `read ${NEW_GEAR_SET_COUNT} gear-set rows instead of const_134`,
      });
    }
  }

  // Two in the constructor (allocate + populate) and one in each of the two
  // refresh methods. Anything else means the class moved under us.
  if (remaining !== 0 && remaining !== 4) {
    throw new PatchError(`Expected 4 gear-set reads of const_134, found ${remaining}.`);
  }

  return { patches, remaining };
}

interface PassResult {
  patches: BytePatch[];
  gearSetCount: number;
  indexBits: number;
  rowSitesLeft: number;
}

function buildPatches(swfPath: string): PassResult {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);

  const createGate = constInitPatch(ctx, abc, "Game", "const_1057", 6, NEW_GEAR_SET_COUNT);
  const indexBits = constInitPatch(ctx, abc, "GearType", "const_348", 3, NEW_INDEX_BITS);
  const rows = gearSetRowCountPatches(ctx, abc);

  const patches: BytePatch[] = [];
  if (createGate.patch) {
    patches.push(createGate.patch);
  }
  if (indexBits.patch) {
    patches.push(indexBits.patch);
  }
  patches.push(...rows.patches);

  return {
    patches,
    gearSetCount: createGate.current,
    indexBits: indexBits.current,
    rowSitesLeft: rows.remaining,
  };
}

export function patchGearManagerSlots(swfPath: string, verifyOnly = false): void {
  const firstPass = buildPatches(swfPath);

  if (!verifyOnly && firstPass.patches.length > 0) {
    const ctx = parseSwf(swfPath);
    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(ctx.body, firstPass.patches);
    writeSwf(ctx, body, delta);
  }

  const verifyPass = buildPatches(swfPath);
  const problems: string[] = [];
  if (verifyPass.gearSetCount !== NEW_GEAR_SET_COUNT) {
    problems.push(`Game.const_1057 is ${verifyPass.gearSetCount}`);
  }
  if (verifyPass.indexBits !== NEW_INDEX_BITS) {
    problems.push(`GearType.const_348 is ${verifyPass.indexBits}`);
  }
  if (verifyPass.rowSitesLeft !== 0) {
    problems.push(`${verifyPass.rowSitesLeft} gear-set const_134 reads remain`);
  }
  if (problems.length > 0) {
    throw new PatchError(`Gear Manager slot verification failed: ${problems.join("; ")}`);
  }

  const verb = verifyOnly ? "Verified" : firstPass.patches.length > 0 ? "Patched" : "Already patched";
  console.log(`${verb} ${NEW_GEAR_SET_COUNT} Gear Manager slots (${NEW_INDEX_BITS}-bit index) in ${swfPath}`);
}

if (require.main === module) {
  try {
    const { swfPath, verify } = parseArgs(process.argv);
    patchGearManagerSlots(swfPath, verify);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
