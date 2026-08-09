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
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

/**
 * Sentinel Form's last 20 energy is a burn phase: the Sentinel turns red and hits 60% harder
 * until the bar empties and the form drops on its own.
 *
 * This is the code half. The damage and the colour both live on one buff, `SentinelFury`,
 * added to PlayerBuffTypes by `patch_gameswz_sentinel_fury_buff.ts`; all this file does is
 * put the buff on and take it off from the energy bar. Run the data patch first -- without it
 * `buffTypesDict["SentinelFury"]` is undefined and the block below quietly does nothing.
 *
 * Where it goes: a prologue on `CombatState.method_960`, the per-tick combat update. That
 * method already owns the two mirror-image mechanics -- it drops the form when energy can no
 * longer pay for a swing, and it runs the Mage's FrostShock low-mana buff off the same bar --
 * so the state it needs is all in hand and the shape is one the class already has.
 *
 * The block, in ActionScript:
 *
 *   if (this.var_1 && this.var_3 && this.var_1.clientEntID == this.var_3.id) {
 *     if (class_14.buffTypesDict["SentinelFury"]) {
 *       if (this.var_39 == class_14.powerTypesDict["SentinelForm1"].powerID
 *           && this.var_3.var_31 <= 20) {
 *         if (!this.method_135(fury)) this.AddBuff(fury, this.var_3, 0, 0);
 *       } else if (this.method_135(fury)) {
 *         this.RemoveBuff(fury);
 *       }
 *     }
 *   }
 *
 * Notes on the shape, all of them load-bearing:
 *
 *   - The clientEntID/id test keeps this on the local player. Every other entity's
 *     CombatState ticks through here too, and AddBuff reports to the server
 *     (linkUpdater.method_1262), so an ungated version would have each client announcing the
 *     buff on everyone else's body. The one report the local player sends is what puts the
 *     red on every other screen.
 *   - `var_39` is the sustained-power id, which is how the class already asks "is the form
 *     up" (see the EndSentinelForm drop a few hundred bytes further down). It clears when the
 *     form ends, so the else-branch takes the buff off without needing to hook the exit.
 *   - The buff-type lookup is null-guarded but the power-type lookup is not, matching what
 *     the surrounding code does with powerTypesDict["SentinelForm1"] -- a missing power there
 *     is a broken data file, whereas a missing buff is just this patch pair applied by halves.
 *   - AddBuff's amount argument is 0 on purpose: buff ids >= 740 have it overwritten with the
 *     caster's meleeDamage anyway, and SentinelFury has no DoT for it to scale.
 *
 * Mechanism: prepend at body offset 0. Every existing branch is relative and the whole body
 * shifts uniformly, so nothing needs re-targeting, and there is no back edge anywhere in the
 * injected block -- both of which are hard requirements here; see the notes on VerifyError
 * #1021 in the sibling patches. The scope stack does *not* exist at offset 0 (this method
 * establishes its own at 0-1), so the prologue pushes and pops its own around the two
 * `getlex class_14` sites, and every internal branch targets `end`, which sits before the
 * `popscope`, so scope depth is balanced on every path into the original code.
 *
 * The one thing that grows the file: "SentinelFury" is not in the ABC string pool, so it is
 * appended at the end of the pool and string_count is bumped. Existing indices are unchanged.
 */

const DEFAULT_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf",
);
const INDEX_HTML = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "index.html",
);

const TARGET_CLASS = "CombatState";
const TARGET_METHOD = "method_960";
const FURY_BUFF_NAME = "SentinelFury";
const FORM_POWER_NAME = "SentinelForm1";

/** Energy at or below this, while the form is up, is the burn phase. */
const FURY_ENERGY_THRESHOLD = 20;

const OP_GETLOCAL_0 = 0xd0;
const OP_PUSHSCOPE = 0x30;
const OP_POPSCOPE = 0x1d;
const OP_PUSHBYTE = 0x24;
const OP_PUSHSTRING = 0x2c;
const OP_GETLEX = 0x60;
const OP_GETPROPERTY = 0x66;
const OP_CALLPROPERTY = 0x46;
const OP_CALLPROPVOID = 0x4f;
const OP_JUMP = 0x10;
const OP_IFTRUE = 0x11;
const OP_IFFALSE = 0x12;
const OP_IFNE = 0x14; // 0x0e is ifngt -- do not transpose these.
const OP_IFGT = 0x17;

type Op = { opcode: number; operands?: Buffer[]; label?: string; branchTo?: string };

function s24(value: number): Buffer {
  if (value < -0x800000 || value > 0x7fffff) throw new PatchError(`s24 out of range: ${value}`);
  const out = Buffer.alloc(3);
  out.writeIntLE(value, 0, 3);
  return out;
}

function s8(value: number): Buffer {
  const out = Buffer.alloc(1);
  out.writeInt8(value, 0);
  return out;
}

/** Assembles a self-contained, position-independent block; every branch is relative. */
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
      if (target < offset) {
        // A backward branch inside injected code is the one shape the real AVM2 verifier
        // rejects (#1021) while FFDec and the linear disassembler both pass it.
        throw new PatchError(`Injected back edge to ${op.branchTo}; forward branches only.`);
      }
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

interface Operands {
  class14: number;
  buffTypesDict: number;
  powerTypesDict: number;
  runtimeKey: number;
  powerID: number;
  var_1: number;
  var_3: number;
  var_31: number;
  var_39: number;
  clientEntID: number;
  id: number;
  addBuff: number;
  removeBuff: number;
  findBuff: number;
  formPowerString: number;
}

/**
 * Every operand is lifted from the target method itself rather than looked up by name.
 *
 * That matters most for the runtime-key multiname behind `dict["name"]`: a MultinameL carries
 * the declaring class's namespace set, so one borrowed from another class assembles cleanly
 * and is wrong. Here it comes from the `buffTypesDict["FrostShock"]` and
 * `powerTypesDict["SentinelForm1"]` reads that are already in this class -- which is also
 * why the pair of dictionary reads has to be found before anything else is trusted.
 *
 * The search is class-wide rather than method-wide only because not every name is used in
 * method_960; uniqueness across the class is what makes each one unambiguous.
 */
function readOperands(abc: ReturnType<typeof parseAbc>, instructions: Instruction[]): Operands {
  const nameOf = (inst: Instruction): string => abc.multinameNames[inst.operands[0]?.[1] as number] ?? "";

  const uniqueOperand = (opcode: number, name: string): number => {
    const found = new Set(
      instructions.filter((inst) => inst.opcode === opcode && nameOf(inst) === name).map((inst) => inst.operands[0][1] as number),
    );
    if (found.size !== 1) {
      throw new PatchError(`Expected exactly one ${name} operand for opcode 0x${opcode.toString(16)} in ${TARGET_CLASS}, found ${found.size}.`);
    }
    return [...found][0];
  };

  const formPowerString = abc.stringValues.indexOf(FORM_POWER_NAME);
  if (formPowerString < 0) throw new PatchError(`"${FORM_POWER_NAME}" is not in the string pool.`);

  // dict["..."] is `getproperty <dict>` then `pushstring` then `getproperty <MultinameL>`.
  const runtimeKeys = new Set<number>();
  const powerIDs = new Set<number>();
  instructions.forEach((inst, index) => {
    if (inst.opcode !== OP_PUSHSTRING) return;
    const next = instructions[index + 1];
    const previous = instructions[index - 1];
    if (!next || !previous) return;
    if (next.opcode !== OP_GETPROPERTY) return;
    if (previous.opcode !== OP_GETPROPERTY) return;
    if (nameOf(previous) !== "buffTypesDict" && nameOf(previous) !== "powerTypesDict") return;
    runtimeKeys.add(next.operands[0][1] as number);

    // `powerID` exists in more than one namespace; the one that matters is whichever is read
    // straight off a PowerType pulled out of powerTypesDict.
    const after = instructions[index + 2];
    if (nameOf(previous) === "powerTypesDict" && after?.opcode === OP_GETPROPERTY && nameOf(after) === "powerID") {
      powerIDs.add(after.operands[0][1] as number);
    }
  });
  if (runtimeKeys.size !== 1) {
    throw new PatchError(`Expected one runtime-key multiname behind the type dictionaries, found ${runtimeKeys.size}.`);
  }
  if (powerIDs.size !== 1) {
    throw new PatchError(`Expected one powerID operand read off powerTypesDict, found ${powerIDs.size}.`);
  }

  return {
    class14: uniqueOperand(OP_GETLEX, "class_14"),
    buffTypesDict: uniqueOperand(OP_GETPROPERTY, "buffTypesDict"),
    powerTypesDict: uniqueOperand(OP_GETPROPERTY, "powerTypesDict"),
    runtimeKey: [...runtimeKeys][0],
    powerID: [...powerIDs][0],
    var_1: uniqueOperand(OP_GETPROPERTY, "var_1"),
    var_3: uniqueOperand(OP_GETPROPERTY, "var_3"),
    var_31: uniqueOperand(OP_GETPROPERTY, "var_31"),
    var_39: uniqueOperand(OP_GETPROPERTY, "var_39"),
    clientEntID: uniqueOperand(OP_GETPROPERTY, "clientEntID"),
    id: uniqueOperand(OP_GETPROPERTY, "id"),
    addBuff: uniqueOperand(OP_CALLPROPVOID, "AddBuff"),
    removeBuff: uniqueOperand(OP_CALLPROPVOID, "RemoveBuff"),
    findBuff: uniqueOperand(OP_CALLPROPERTY, "method_135"),
    formPowerString,
  };
}

function buildPrologue(operands: Operands, furyStringIndex: number): Buffer {
  const self = (): Op => ({ opcode: OP_GETLOCAL_0 });
  const getprop = (operand: number): Op => ({ opcode: OP_GETPROPERTY, operands: [writeU30(operand)] });
  const pushstring = (operand: number): Op => ({ opcode: OP_PUSHSTRING, operands: [writeU30(operand)] });

  /** class_14.buffTypesDict["SentinelFury"] -- rebuilt at each use so nothing is held on the stack. */
  const furyBuffType = (): Op[] => [
    { opcode: OP_GETLEX, operands: [writeU30(operands.class14)] },
    getprop(operands.buffTypesDict),
    pushstring(furyStringIndex),
    getprop(operands.runtimeKey),
  ];

  return assemble([
    self(), { opcode: OP_PUSHSCOPE },

    self(), getprop(operands.var_1), { opcode: OP_IFFALSE, branchTo: "end" },
    self(), getprop(operands.var_3), { opcode: OP_IFFALSE, branchTo: "end" },

    // Local player only -- AddBuff reports to the server, and one report is all that is wanted.
    self(), getprop(operands.var_1), getprop(operands.clientEntID),
    self(), getprop(operands.var_3), getprop(operands.id),
    { opcode: OP_IFNE, branchTo: "end" },

    // Nothing to do at all if the data half of the patch is not installed.
    ...furyBuffType(), { opcode: OP_IFFALSE, branchTo: "end" },

    // In the form?
    self(), getprop(operands.var_39),
    { opcode: OP_GETLEX, operands: [writeU30(operands.class14)] },
    getprop(operands.powerTypesDict),
    pushstring(operands.formPowerString),
    getprop(operands.runtimeKey),
    getprop(operands.powerID),
    { opcode: OP_IFNE, branchTo: "remove" },

    // Down to the last of the bar?
    self(), getprop(operands.var_3), getprop(operands.var_31),
    { opcode: OP_PUSHBYTE, operands: [s8(FURY_ENERGY_THRESHOLD)] },
    { opcode: OP_IFGT, branchTo: "remove" },

    self(), ...furyBuffType(),
    { opcode: OP_CALLPROPERTY, operands: [writeU30(operands.findBuff), writeU30(1)] },
    { opcode: OP_IFTRUE, branchTo: "end" },

    self(), ...furyBuffType(),
    self(), getprop(operands.var_3),
    { opcode: OP_PUSHBYTE, operands: [s8(0)] },
    { opcode: OP_PUSHBYTE, operands: [s8(0)] },
    { opcode: OP_CALLPROPVOID, operands: [writeU30(operands.addBuff), writeU30(4)] },
    { opcode: OP_JUMP, branchTo: "end" },

    { opcode: -1, label: "remove" },
    self(), ...furyBuffType(),
    { opcode: OP_CALLPROPERTY, operands: [writeU30(operands.findBuff), writeU30(1)] },
    { opcode: OP_IFFALSE, branchTo: "end" },
    self(), ...furyBuffType(),
    { opcode: OP_CALLPROPVOID, operands: [writeU30(operands.removeBuff), writeU30(1)] },

    { opcode: -1, label: "end" },
    { opcode: OP_POPSCOPE },
  ]);
}

/** Peak operand-stack depth of the injected block, walked the way the verifier walks it. */
const PROLOGUE_MAX_STACK = 5;

interface Located {
  ctx: ReturnType<typeof parseSwf>;
  abc: ReturnType<typeof parseAbc>;
  body: NonNullable<ReturnType<ReturnType<typeof parseAbc>["methodBodies"]["get"]>>;
  code: Buffer;
  instructions: Instruction[];
  operands: Operands;
}

function locate(swfPath: string): Located {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);

  const classIndex = classIndexByName(abc, TARGET_CLASS);
  if (classIndex === null) throw new PatchError(`${TARGET_CLASS} class not found.`);
  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, TARGET_METHOD);
  if (methodIdx === null) throw new PatchError(`${TARGET_CLASS}.${TARGET_METHOD} not found.`);
  const body = abc.methodBodies.get(methodIdx);
  if (!body) throw new PatchError(`No method body for ${TARGET_CLASS}.${TARGET_METHOD} (method ${methodIdx}).`);
  if (body.exceptionCount !== 0) {
    throw new PatchError(`${TARGET_CLASS}.${TARGET_METHOD} has an exception table; its handler offsets would need re-targeting.`);
  }

  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  const instructions = disassemble(code, `${TARGET_CLASS}.${TARGET_METHOD}`);
  const last = instructions[instructions.length - 1];
  if (!last || last.offset + last.size !== body.codeLen) {
    throw new PatchError(`Disassembly of ${TARGET_CLASS}.${TARGET_METHOD} does not cover its code exactly.`);
  }
  if (instructions.some((inst) => inst.opcode === 0x1b)) {
    throw new PatchError(`${TARGET_CLASS}.${TARGET_METHOD} contains a lookupswitch; its jump table is not offset-safe here.`);
  }

  const classInstructions: Instruction[] = [];
  for (const trait of abc.instances[classIndex].traits) {
    const traitBody = abc.methodBodies.get(trait.methodIdx ?? -1);
    if (!traitBody) continue;
    try {
      classInstructions.push(
        ...disassemble(ctx.body.subarray(traitBody.codeStart, traitBody.codeStart + traitBody.codeLen), TARGET_CLASS),
      );
    } catch {
      // A handful of bodies use lookupswitch, which the shared disassembler cannot walk. None
      // of the operands below are unique to one of them.
      continue;
    }
  }

  return { ctx, abc, body, code, instructions, operands: readOperands(abc, classInstructions) };
}

/** Position of the string_count u30, derived from where the first string starts. */
function stringCountPosition(abc: ReturnType<typeof parseAbc>, ctx: ReturnType<typeof parseSwf>): number {
  const count = abc.stringValues.length;
  const firstStringPos = abc.stringLenPositions[1];
  if (firstStringPos === undefined) throw new PatchError("ABC string pool is empty.");
  const countPos = firstStringPos - writeU30(count).length;
  const [readBack, after] = readU30(ctx.body, countPos, "abc.string_count");
  if (readBack !== count || after !== firstStringPos) {
    throw new PatchError("Could not locate the string_count field; the pool is not encoded as expected.");
  }
  return countPos;
}

/** Every branch in the patched body must still land on an instruction boundary. */
function assertBranchesLand(code: Buffer, label: string): void {
  const instructions = disassemble(code, label);
  const boundaries = new Set(instructions.map((inst) => inst.offset));
  const last = instructions[instructions.length - 1];
  boundaries.add(last.offset + last.size);

  for (const inst of instructions) {
    for (const [kind, value] of inst.operands) {
      if (kind !== "s24") continue;
      const target = inst.offset + inst.size + value;
      if (!boundaries.has(target)) {
        throw new PatchError(`${label}: branch at ${inst.offset} targets ${target}, which is not an instruction boundary.`);
      }
    }
  }
}

/**
 * index.html requests the SWF at a fixed `clientrev=` token, so a browser serves a stale copy
 * after the file on disk changes -- a correct patch that nobody loads. Pin it to the content
 * hash. Run this last if other scripts also rewrite the SWF.
 */
function syncClientRev(swfPath: string): void {
  if (path.resolve(swfPath) !== DEFAULT_SWF || !fs.existsSync(INDEX_HTML)) return;
  const digest = crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  // Stop at $ as well as & and the quotes: ${languageParam} follows the token immediately.
  const updated = html.replace(/clientrev=[^&`"'$]+/, `clientrev=swf-${digest}`);
  if (updated !== html) {
    fs.writeFileSync(INDEX_HTML, updated);
    console.log(`  index.html clientrev -> swf-${digest} (cache buster)`);
  }
}

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") swfPath = path.resolve(argv[++index] || "");
    else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npx ts-node src/server/scripts/patch-dungeonblitz-sentinel-form-low-energy-fury.ts [--verify] [--swf <path>]",
        "",
        "Turns the Sentinel red and gives it +60% damage for the last 20 energy of Sentinel Form.",
        "Run patch_gameswz_sentinel_fury_buff.ts first -- it carries the buff this applies.",
      ].join("\n"));
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify };
}

export function patchSentinelFormLowEnergyFury(swfPath: string, verifyOnly = false): boolean {
  const located = locate(swfPath);
  const { ctx, abc, body, code, operands } = located;

  const existingFuryString = abc.stringValues.indexOf(FURY_BUFF_NAME);
  const furyStringIndex = existingFuryString >= 0 ? existingFuryString : abc.stringValues.length;
  const prologue = buildPrologue(operands, furyStringIndex);

  if (code.length >= prologue.length && code.subarray(0, prologue.length).equals(prologue)) {
    console.log(`${swfPath}: verified Sentinel Form low-energy fury prologue.`);
    if (!verifyOnly) syncClientRev(swfPath);
    return false;
  }
  if (verifyOnly) {
    throw new PatchError(`${swfPath}: verify failed; the Sentinel Form low-energy fury prologue is missing.`);
  }

  const [maxStack] = readU30(ctx.body, body.maxStackPos, `${TARGET_METHOD}.max_stack`);
  if (maxStack < PROLOGUE_MAX_STACK) {
    throw new PatchError(`${TARGET_METHOD} declares max_stack ${maxStack}; the prologue peaks at ${PROLOGUE_MAX_STACK}.`);
  }

  const patchedCode = Buffer.concat([prologue, code]);
  assertBranchesLand(patchedCode, `${TARGET_CLASS}.${TARGET_METHOD} (patched)`);

  const patches: BytePatch[] = [
    {
      key: `${TARGET_CLASS}.${TARGET_METHOD}.code`,
      start: body.codeStart,
      end: body.codeStart + body.codeLen,
      data: patchedCode,
      detail: "apply/remove SentinelFury from the energy bar while Sentinel Form is up",
    },
    {
      key: `${TARGET_CLASS}.${TARGET_METHOD}.codeLen`,
      start: body.codeLenPos,
      end: body.codeStart,
      data: writeU30(patchedCode.length),
      detail: "grow the method body by the prologue",
    },
  ];

  if (existingFuryString < 0) {
    const count = abc.stringValues.length;
    const lastIndex = count - 1;
    const poolEnd = abc.stringDataPositions[lastIndex] + Buffer.byteLength(abc.stringValues[lastIndex], "utf8");
    const encoded = Buffer.from(FURY_BUFF_NAME, "utf8");

    patches.push({
      key: "abc.string_pool.SentinelFury",
      start: poolEnd,
      end: poolEnd,
      data: Buffer.concat([writeU30(encoded.length), encoded]),
      detail: `append "${FURY_BUFF_NAME}" as string ${furyStringIndex}`,
    });
    patches.push({
      key: "abc.string_count",
      start: stringCountPosition(abc, ctx),
      end: abc.stringLenPositions[1],
      data: writeU30(count + 1),
      detail: `string_count ${count} -> ${count + 1}`,
    });
  }

  ensureBackup(swfPath);
  const { body: outBody, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, outBody, delta);

  const after = locate(swfPath);
  if (!after.code.subarray(0, prologue.length).equals(prologue)) {
    throw new PatchError(`${swfPath}: post-patch verification failed; the prologue is not at offset 0.`);
  }
  if (after.abc.stringValues[furyStringIndex] !== FURY_BUFF_NAME) {
    throw new PatchError(`${swfPath}: post-patch verification failed; string ${furyStringIndex} is not "${FURY_BUFF_NAME}".`);
  }
  assertBranchesLand(after.code, `${TARGET_CLASS}.${TARGET_METHOD} (reparsed)`);

  syncClientRev(swfPath);
  console.log(`${swfPath}: patched Sentinel Form low-energy fury (prologue ${prologue.length} bytes, string ${furyStringIndex}).`);
  return true;
}

function main(): number {
  try {
    const { swfPath, verify } = parseArgs(process.argv);
    patchSentinelFormLowEnergyFury(swfPath, verify);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch-dungeonblitz-sentinel-form-low-energy-fury] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
