#!/usr/bin/env node

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
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

/**
 * Show the player the debuffs that are on them.
 *
 * Every other body in the game already carries a status readout. Entity.method_280 builds a
 * little `a_HealthHeart` clip under each entity, Entity.method_1667 fills its `am_IconGroup`
 * with one `a_StatusIcon_*` per status category the entity carries, and Entity.method_1271
 * positions it and fades it in and out. Stand next to a party member and their Ignite,
 * Weaken, Cripple and Stagger are all right there under their feet.
 *
 * The player is the one body that has none of it, and for one reason: method_280 opens with
 *
 *   if (this != this.var_1.clientEnt) { ...build var_78... }
 *
 * so `var_78` is never created for the local player, and method_1667's very first test is
 * `if (!this.var_78) return`. Which enemy applied what to you is the information you most
 * need in a fight and the only information the client refuses to draw.
 *
 * Nothing about the icon pipeline needs changing to fix that -- the categories, the artwork
 * and the expiry animation all already work, and they work off the entity's own
 * `combatState.var_1176`, which the local player's CombatState maintains exactly like anyone
 * else's. Two edits are enough.
 *
 * ---------------------------------------------------------------------------------------
 * 1. method_280, one byte: build the readout for the local player too.
 *
 * The guard compiles to `getlocal0; getlocal0; getproperty var_1; getproperty clientEnt; ifne`,
 * and the `ifne` jumps *into* the build block while the fallthrough is a bare `returnvoid`.
 * Replacing the first `getlocal0` with `pushnull` turns the test into
 * `null != this.var_1.clientEnt`, which is true whenever there is a client entity at all --
 * so the branch is always taken. Both opcodes are one byte and both leave exactly one value
 * on the stack, so the comparison still balances and not a single offset in the method moves.
 *
 * Deliberately not done by rewriting the `ifne` into a `jump`: a jump pops nothing, and the
 * two operands the comparison pushed would be left on the stack for the verifier to reject.
 *
 * ---------------------------------------------------------------------------------------
 * 2. method_1271, whole body: stop the readout fading out from under the player.
 *
 * The fade is keyed to `var_1282`, the moment the entity was last damaged: full opacity for
 * 1.5 seconds, then a half-second fade, then hidden. That is right for an enemy health bar
 * and wrong for a status readout you are meant to be able to read -- a Weaken with eight
 * seconds left would be drawn for two of them.
 *
 * So the method is replaced outright rather than patched in place. It has no exception
 * ranges, its real logic is a dozen statements, and Entity is control-flow obfuscated past
 * the point where an FFDec recompile is available as a fallback -- which makes owning the
 * whole body *safer* than threading a new branch through the obfuscator's spaghetti, because
 * there is then no pre-existing branch offset left to get wrong. The replacement is written
 * to the same behaviour it replaces, plus one exception:
 *
 *   if (!this.var_78) return;
 *   this.var_78.x = this.appearPosX;
 *   this.var_78.y = this.appearPosY + 20;
 *   this.var_78.visible = true;
 *   this.var_78.alpha = 1;
 *   if (this === this.var_1.clientEnt) {
 *      // Icons only: the player already reads their health off the HUD, so everything in the
 *      // clip except the icon strip is hidden.
 *      for (var i:int = this.var_78.numChildren - 1; i >= 0; i--) {
 *         var child:DisplayObject = this.var_78.getChildAt(i);
 *         child.visible = (child === this.var_78.am_IconGroup);
 *      }
 *      // The player's own readout does not fade. It still goes away on death, which is what
 *      // method_280 uses its var_1282 = now - 5000 trick to say; read the health directly
 *      // rather than re-deriving it from a timestamp that means two things.
 *      if (this.currHP <= 0) this.var_78.visible = false;
 *      return;
 *   }
 *   var t:Number = this.var_1.mTimeThisTick - this.var_1282;
 *   if (t <= 500)  { this.var_78.alpha = 0.2 + 0.8 * t / 500; return; }
 *   if (t <= 1500) { return; }                       // alpha is already 1
 *   if (t > 2000)  { this.var_78.visible = false; return; }
 *   this.var_78.alpha = 1 - (t - 1500) / 500;
 *
 * The assembled body is padded with `nop` to the authored 311 bytes so `code_length` never
 * moves: no method body after this one shifts, and the DoABC tag keeps its length. The script
 * refuses to write if the assembly does not fit or if the padding arithmetic comes out wrong.
 *
 * Every constant it needs already exists. 0.2 and 0.8 are double pool entries the authored
 * fade itself used, and every multiname is lifted from an existing getproperty/setproperty in
 * this same class, so none of them can turn out to be the MultinameL shape that needs a
 * namespace off the stack.
 *
 * ---------------------------------------------------------------------------------------
 * Icons only, no health bar. `am_IconGroup` is a child of the `a_HealthHeart_Player` clip, so
 * showing the icons means instantiating the bar as well -- and the player already reads their
 * health off the HUD, where it is bigger and always there.
 *
 * The suppression walks `var_78`'s children and hides everything that is not the icon group,
 * rather than naming `am_HealthLevel` and hoping that is the whole of it. The clip also carries
 * a frame, a heart and whatever raw shapes its timeline draws, and none of those are reachable
 * by name from ActionScript -- but every one of them is a child. Walking is the only form of
 * this that cannot leave a stray graphic behind.
 *
 * It runs every frame rather than once at creation, because creation happens in method_280 and
 * that is a 673-byte obfuscated method where an insertion would have to be threaded past
 * existing branch offsets. Here it costs a handful of property reads on one entity.
 */

const DEFAULT_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf",
);

// Opcodes.
const OP_PUSHNULL = 0x20;
const OP_PUSHTRUE = 0x26;
const OP_PUSHFALSE = 0x27;
const OP_NOP = 0x02;
const OP_JUMP = 0x10;
const OP_IFNE = 0x14;
const OP_IFLE = 0x16;
const OP_IFGT = 0x17;
const OP_IFSTRICTEQ = 0x19;
const OP_IFFALSE = 0x12;
const OP_PUSHBYTE = 0x24;
const OP_PUSHSHORT = 0x25;
const OP_PUSHDOUBLE = 0x2f;
const OP_GETLOCAL0 = 0xd0;
const OP_GETLOCAL1 = 0xd1;
const OP_GETLOCAL2 = 0xd2;
const OP_GETLOCAL3 = 0xd3;
const OP_SETLOCAL1 = 0xd5;
const OP_SETLOCAL2 = 0xd6;
const OP_SETLOCAL3 = 0xd7;
const OP_IFLT = 0x15;
const OP_STRICTEQUALS = 0xac;
const OP_CALLPROPERTY = 0x46;
const OP_PUSHSCOPE = 0x30;
const OP_GETPROPERTY = 0x66;
const OP_SETPROPERTY = 0x61;
const OP_ADD = 0xa0;
const OP_SUBTRACT = 0xa1;
const OP_MULTIPLY = 0xa2;
const OP_DIVIDE = 0xa3;
const OP_CONVERT_D = 0x75;
const OP_RETURNVOID = 0x47;

/** Names read out of the file rather than hardcoded, so a rebuild fails loudly. */
const MULTINAMES = [
  "var_78", "x", "y", "appearPosX", "appearPosY", "visible", "alpha",
  "var_1", "mTimeThisTick", "var_1282", "clientEnt", "currHP",
  // The child walk that leaves only the icons.
  "numChildren", "getChildAt", "am_IconGroup",
] as const;
type MultinameKey = (typeof MULTINAMES)[number];

/** The fade thresholds and opacities the authored method_1271 uses. */
const FADE_IN_MS = 500;
const FULL_ALPHA_MS = 1500;
const HIDE_AFTER_MS = 2000;
const FADE_IN_BASE_ALPHA = 0.2;
const FADE_IN_ALPHA_RANGE = 0.8;
// The offset method_1271 hangs the readout at, below the entity's own anchor.
const READOUT_Y_OFFSET = 20;

type Operand =
  | { kind: "u30"; value: number }
  | { kind: "s8"; value: number }
  | { kind: "label"; label: string };

interface Op {
  opcode: number;
  operands?: Operand[];
  label?: string;
}

/**
 * A two-pass assembler, only as clever as this one method needs.
 *
 * Branch operands are always emitted as the full 3-byte s24 an AVM2 jump takes, so an
 * instruction's size never depends on how far its target turns out to be and the first pass's
 * offsets are already final.
 */
function assemble(ops: Op[]): Buffer {
  const sizeOf = (op: Op): number => {
    let size = 1;
    for (const operand of op.operands ?? []) {
      if (operand.kind === "u30") size += writeU30(operand.value).length;
      else if (operand.kind === "s8") size += 1;
      else size += 3;
    }
    return size;
  };

  const labels = new Map<string, number>();
  let offset = 0;
  for (const op of ops) {
    if (op.label !== undefined) labels.set(op.label, offset);
    offset += sizeOf(op);
  }
  labels.set("__end__", offset);

  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const op of ops) {
    const size = sizeOf(op);
    const next = cursor + size;
    chunks.push(Buffer.from([op.opcode]));
    for (const operand of op.operands ?? []) {
      if (operand.kind === "u30") {
        chunks.push(writeU30(operand.value));
      } else if (operand.kind === "s8") {
        const byte = Buffer.alloc(1);
        byte.writeInt8(operand.value, 0);
        chunks.push(byte);
      } else {
        const target = labels.get(operand.label);
        if (target === undefined) throw new PatchError(`Unknown branch label ${operand.label}`);
        // s24 is relative to the byte after the whole instruction.
        const delta = target - next;
        const s24 = Buffer.alloc(3);
        s24.writeIntLE(delta, 0, 3);
        chunks.push(s24);
      }
    }
    cursor = next;
  }
  return Buffer.concat(chunks);
}

function buildMethod1271(
  name: (key: MultinameKey) => number,
  doubleIdx: (value: number) => number,
): Buffer {
  const u30 = (value: number): Operand => ({ kind: "u30", value });
  const s8 = (value: number): Operand => ({ kind: "s8", value });
  const to = (label: string): Operand => ({ kind: "label", label });

  const getThisReadout = (): Op[] => [
    { opcode: OP_GETLOCAL0 },
    { opcode: OP_GETPROPERTY, operands: [u30(name("var_78"))] },
  ];

  return assemble([
    { opcode: OP_GETLOCAL0 },
    { opcode: OP_PUSHSCOPE },

    // if (!this.var_78) return;
    ...getThisReadout(),
    { opcode: OP_IFFALSE, operands: [to("end")] },

    // this.var_78.x = this.appearPosX;
    ...getThisReadout(),
    { opcode: OP_GETLOCAL0 },
    { opcode: OP_GETPROPERTY, operands: [u30(name("appearPosX"))] },
    { opcode: OP_SETPROPERTY, operands: [u30(name("x"))] },

    // this.var_78.y = this.appearPosY + 20;
    ...getThisReadout(),
    { opcode: OP_GETLOCAL0 },
    { opcode: OP_GETPROPERTY, operands: [u30(name("appearPosY"))] },
    { opcode: OP_PUSHBYTE, operands: [s8(READOUT_Y_OFFSET)] },
    { opcode: OP_ADD },
    { opcode: OP_SETPROPERTY, operands: [u30(name("y"))] },

    // this.var_78.visible = true;
    ...getThisReadout(),
    { opcode: OP_PUSHTRUE },
    { opcode: OP_SETPROPERTY, operands: [u30(name("visible"))] },

    // this.var_78.alpha = 1;
    ...getThisReadout(),
    { opcode: OP_PUSHBYTE, operands: [s8(1)] },
    { opcode: OP_SETPROPERTY, operands: [u30(name("alpha"))] },

    // if (this === this.var_1.clientEnt) { ...own readout... }
    { opcode: OP_GETLOCAL0 },
    { opcode: OP_GETLOCAL0 },
    { opcode: OP_GETPROPERTY, operands: [u30(name("var_1"))] },
    { opcode: OP_GETPROPERTY, operands: [u30(name("clientEnt"))] },
    { opcode: OP_IFSTRICTEQ, operands: [to("own")] },

    // var t:Number = this.var_1.mTimeThisTick - this.var_1282;
    { opcode: OP_GETLOCAL0 },
    { opcode: OP_GETPROPERTY, operands: [u30(name("var_1"))] },
    { opcode: OP_GETPROPERTY, operands: [u30(name("mTimeThisTick"))] },
    { opcode: OP_GETLOCAL0 },
    { opcode: OP_GETPROPERTY, operands: [u30(name("var_1282"))] },
    { opcode: OP_SUBTRACT },
    { opcode: OP_CONVERT_D },
    { opcode: OP_SETLOCAL1 },

    // if (t > 500) goto fadedIn;  else alpha = 0.2 + 0.8 * t / 500;
    { opcode: OP_GETLOCAL1 },
    { opcode: OP_PUSHSHORT, operands: [u30(FADE_IN_MS)] },
    { opcode: OP_IFGT, operands: [to("fadedIn")] },
    ...getThisReadout(),
    { opcode: OP_PUSHDOUBLE, operands: [u30(doubleIdx(FADE_IN_BASE_ALPHA))] },
    { opcode: OP_PUSHDOUBLE, operands: [u30(doubleIdx(FADE_IN_ALPHA_RANGE))] },
    { opcode: OP_GETLOCAL1 },
    { opcode: OP_MULTIPLY },
    { opcode: OP_PUSHSHORT, operands: [u30(FADE_IN_MS)] },
    { opcode: OP_DIVIDE },
    { opcode: OP_ADD },
    { opcode: OP_SETPROPERTY, operands: [u30(name("alpha"))] },
    { opcode: OP_JUMP, operands: [to("end")] },

    // if (t > 1500) goto fadingOut;  else the alpha of 1 set above already stands.
    { opcode: OP_GETLOCAL1, label: "fadedIn" },
    { opcode: OP_PUSHSHORT, operands: [u30(FULL_ALPHA_MS)] },
    { opcode: OP_IFGT, operands: [to("fadingOut")] },
    { opcode: OP_JUMP, operands: [to("end")] },

    // if (t <= 2000) goto fading;  else hide.
    { opcode: OP_GETLOCAL1, label: "fadingOut" },
    { opcode: OP_PUSHSHORT, operands: [u30(HIDE_AFTER_MS)] },
    { opcode: OP_IFLE, operands: [to("fading")] },
    ...getThisReadout(),
    { opcode: OP_PUSHFALSE },
    { opcode: OP_SETPROPERTY, operands: [u30(name("visible"))] },
    { opcode: OP_JUMP, operands: [to("end")] },

    // alpha = 1 - (t - 1500) / 500;
    { opcode: OP_GETLOCAL0, label: "fading" },
    { opcode: OP_GETPROPERTY, operands: [u30(name("var_78"))] },
    { opcode: OP_PUSHBYTE, operands: [s8(1)] },
    { opcode: OP_GETLOCAL1 },
    { opcode: OP_PUSHSHORT, operands: [u30(FULL_ALPHA_MS)] },
    { opcode: OP_SUBTRACT },
    { opcode: OP_PUSHSHORT, operands: [u30(FADE_IN_MS)] },
    { opcode: OP_DIVIDE },
    { opcode: OP_SUBTRACT },
    { opcode: OP_SETPROPERTY, operands: [u30(name("alpha"))] },
    { opcode: OP_JUMP, operands: [to("end")] },

    /**
     * The local player's own readout: icons only, and no fade.
     *
     * `for (var i = this.var_78.numChildren - 1; i >= 0; i--)` with the child in local 3 and
     * the counter in local 2, so local 1 stays exclusively the fade path's Number and the two
     * paths never have to agree on a type where they rejoin at `end`.
     */
    { opcode: OP_GETLOCAL0, label: "own" },
    { opcode: OP_GETPROPERTY, operands: [u30(name("var_78"))] },
    { opcode: OP_GETPROPERTY, operands: [u30(name("numChildren"))] },
    { opcode: OP_SETLOCAL2 },

    { opcode: OP_GETLOCAL2, label: "hideLoop" },
    { opcode: OP_PUSHBYTE, operands: [s8(1)] },
    { opcode: OP_SUBTRACT },
    { opcode: OP_SETLOCAL2 },
    { opcode: OP_GETLOCAL2 },
    { opcode: OP_PUSHBYTE, operands: [s8(0)] },
    { opcode: OP_IFLT, operands: [to("ownAlive")] },

    // var child = this.var_78.getChildAt(i);
    ...getThisReadout(),
    { opcode: OP_GETLOCAL2 },
    { opcode: OP_CALLPROPERTY, operands: [u30(name("getChildAt")), u30(1)] },
    { opcode: OP_SETLOCAL3 },

    // child.visible = (child === this.var_78.am_IconGroup);
    { opcode: OP_GETLOCAL3 },
    { opcode: OP_GETLOCAL3 },
    ...getThisReadout(),
    { opcode: OP_GETPROPERTY, operands: [u30(name("am_IconGroup"))] },
    { opcode: OP_STRICTEQUALS },
    { opcode: OP_SETPROPERTY, operands: [u30(name("visible"))] },
    { opcode: OP_JUMP, operands: [to("hideLoop")] },

    // Still gone once they are down.
    { opcode: OP_GETLOCAL0, label: "ownAlive" },
    { opcode: OP_GETPROPERTY, operands: [u30(name("currHP"))] },
    { opcode: OP_PUSHBYTE, operands: [s8(0)] },
    { opcode: OP_IFGT, operands: [to("end")] },
    ...getThisReadout(),
    { opcode: OP_PUSHFALSE },
    { opcode: OP_SETPROPERTY, operands: [u30(name("visible"))] },

    { opcode: OP_RETURNVOID, label: "end" },
  ]);
}

/** The `this != this.var_1.clientEnt` gate at the head of method_280. */
function findClientEntGate(instructions: Instruction[], names: Record<MultinameKey, number>): Instruction {
  const matches: Instruction[] = [];
  for (let i = 0; i < instructions.length; i += 1) {
    const self = instructions[i];
    if (self.opcode !== OP_GETLOCAL0 && self.opcode !== OP_PUSHNULL) continue;
    const alsoSelf = instructions[i + 1];
    const readVar1 = instructions[i + 2];
    const readClientEnt = instructions[i + 3];
    const compare = instructions[i + 4];
    if (!alsoSelf || alsoSelf.opcode !== OP_GETLOCAL0) continue;
    if (!readVar1 || readVar1.opcode !== OP_GETPROPERTY || readVar1.operands[0][1] !== names.var_1) continue;
    if (!readClientEnt || readClientEnt.opcode !== OP_GETPROPERTY || readClientEnt.operands[0][1] !== names.clientEnt) {
      continue;
    }
    if (!compare || compare.opcode !== OP_IFNE) continue;
    matches.push(self);
  }

  if (matches.length !== 1) {
    throw new PatchError(
      `Expected exactly 1 clientEnt gate in Entity.method_280, found ${matches.length}.`,
    );
  }
  return matches[0];
}

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") swfPath = path.resolve(argv[++index] || "");
    else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: ts-node patch-dungeonblitz-player-status-icons.ts [--verify] [--swf <path>]\n" +
          "Gives the local player the status-icon readout every other entity already has,\n" +
          "and stops it fading out while a debuff is still on them.",
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify };
}

function main(): number {
  const { swfPath, verify } = parseArgs(process.argv);
  try {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);

    const classIndex = classIndexByName(abc, "Entity");
    if (classIndex === null) throw new PatchError("Entity class not found");
    const traits = abc.instances[classIndex].traits;

    const names = {} as Record<MultinameKey, number>;
    for (const key of MULTINAMES) {
      const index = abc.multinameNames.indexOf(key);
      if (index < 0) throw new PatchError(`Multiname ${key} not found`);
      names[key] = index;
    }

    const doubleIdx = (value: number): number => {
      const hits = abc.doubleValues
        .map((entry, index) => ({ entry, index }))
        .filter((row) => row.entry === value);
      if (hits.length !== 1) {
        throw new PatchError(`${value} appears ${hits.length} times in the double pool; refusing to guess.`);
      }
      return hits[0].index;
    };

    const patches: BytePatch[] = [];
    const report: Record<string, unknown> = { verify, swf: swfPath };

    // ---- 1. method_280: build the readout for the local player too.
    const buildIdx = methodIdxForTrait(traits, abc, "method_280");
    if (buildIdx === null) throw new PatchError("Entity.method_280 not found");
    const buildBody = abc.methodBodies.get(buildIdx);
    if (!buildBody) throw new PatchError("No method body for Entity.method_280");
    const buildCode = ctx.body.subarray(buildBody.codeStart, buildBody.codeStart + buildBody.codeLen);
    const gate = findClientEntGate(disassemble(buildCode, "Entity.method_280"), names);
    report.method_280 = { methodIdx: buildIdx, gateOffset: gate.offset, alreadyPatched: gate.opcode === OP_PUSHNULL };
    if (gate.opcode !== OP_PUSHNULL) {
      patches.push({
        key: "Entity.method_280.clientEntGate",
        start: buildBody.codeStart + gate.offset,
        end: buildBody.codeStart + gate.offset + 1,
        data: Buffer.from([OP_PUSHNULL]),
        detail: "getlocal0 -> pushnull, so the readout is built for the client entity as well",
      });
    }

    // ---- 2. method_1271: replace the body so the player's readout does not fade.
    const fadeIdx = methodIdxForTrait(traits, abc, "method_1271");
    if (fadeIdx === null) throw new PatchError("Entity.method_1271 not found");
    const fadeBody = abc.methodBodies.get(fadeIdx);
    if (!fadeBody) throw new PatchError("No method body for Entity.method_1271");
    if (fadeBody.exceptionCount !== 0) {
      throw new PatchError(
        `Entity.method_1271 has ${fadeBody.exceptionCount} exception ranges; replacing its body would orphan them.`,
      );
    }

    const assembled = buildMethod1271((key) => names[key], doubleIdx);
    if (assembled.length > fadeBody.codeLen) {
      throw new PatchError(
        `Replacement method_1271 is ${assembled.length} bytes and will not fit in the authored ${fadeBody.codeLen}.`,
      );
    }
    const replacement = Buffer.concat([
      assembled,
      Buffer.alloc(fadeBody.codeLen - assembled.length, OP_NOP),
    ]);
    if (replacement.length !== fadeBody.codeLen) {
      throw new PatchError("Padding arithmetic is wrong; refusing to write.");
    }

    const existing = ctx.body.subarray(fadeBody.codeStart, fadeBody.codeStart + fadeBody.codeLen);
    const fadeAlreadyPatched = existing.equals(replacement);
    report.method_1271 = {
      methodIdx: fadeIdx,
      codeLen: fadeBody.codeLen,
      assembled: assembled.length,
      padding: fadeBody.codeLen - assembled.length,
      alreadyPatched: fadeAlreadyPatched,
    };
    if (!fadeAlreadyPatched) {
      patches.push({
        key: "Entity.method_1271.body",
        start: fadeBody.codeStart,
        end: fadeBody.codeStart + fadeBody.codeLen,
        data: replacement,
        detail: "rewritten so the client entity's status readout never fades out",
      });
    }

    if (patches.length === 0) {
      console.log(JSON.stringify({ ...report, alreadyPatched: true }, null, 2));
      console.log("No changes needed.");
      return 0;
    }

    const { body: outBody, delta } = applyPatchesToBody(ctx.body, patches);
    report.abcDelta = delta;
    console.log(JSON.stringify(report, null, 2));
    if (delta !== 0) {
      throw new PatchError(`Same-length replacement changed the ABC by ${delta} bytes; refusing to write.`);
    }

    if (verify) {
      console.log("Patch required.");
      return 0;
    }

    ensureBackup(swfPath);
    writeSwf(ctx, outBody, delta);
    console.log("Patch apply complete.");
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch-dungeonblitz-player-status-icons] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
