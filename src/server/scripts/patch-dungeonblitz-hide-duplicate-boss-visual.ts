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
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

/**
 * Hides the duplicate boss standing in a boss scene.
 *
 * Dread Goblin Hideout draws two Tag Ugos: the one BossFight actually drives,
 * and a copy frozen at the room's authored spawn point that never moves and
 * never sheds a debuff. The server cannot remove it — it is not in the shared
 * state, and the client's own destroy path is a no-op for an entity that has no
 * brain (see patch-dungeonblitz-destroy-entity-without-brain.ts). So the removal
 * has to happen where the truth about "which one is the real boss" lives:
 * BossFight resolves it by instance name, `mRoom.method_35("am_Boss")`.
 *
 * The rule this installs is therefore identity-based, not position- or id-based,
 * and holds whichever of the two copies turns out to be the stale one:
 *
 *     for each e in game.entities:
 *         if (e === am_Boss || e === am_Boss2) continue;   // the driven bosses
 *         if (e.entType !== am_Boss.entType) continue;     // not this boss
 *         e.gfx.var_151.visible = false;                   // hide the copy
 *
 * It hides rather than destroys deliberately. `BossFight.method_1981` is the
 * per-tick update, so a copy that reappears is hidden again on the next frame,
 * and a wrong match costs a missing sprite instead of a broken encounter.
 *
 * SHAPE — this follows the rules the pet-fetches-loot patch arrived at after
 * shipping a VerifyError #1021 twice:
 *   1. New code is only ever *prepended*, so every original instruction shifts
 *      by the same amount and no existing branch operand has to be recomputed.
 *   2. Nothing inside the original body is edited at all.
 *   3. The patched body is re-disassembled and every branch is proven to land on
 *      an instruction boundary before anything is written.
 *
 * The prologue runs before the method's own `getlocal0; pushscope`, so the scope
 * stack is empty there. It therefore uses no `findproperty`/`getlex` — the boss
 * names are pushed as string constants and every lookup is a plain property read
 * off a local.
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

// BossFight.method_1981 declares 10 locals; these are the scratch registers.
const L_ROOM = 10;
const L_BOSS = 11;
const L_BOSS2 = 12;
const L_TYPE = 13;
const L_GAME = 14;
const L_VEC = 15;
const L_IDX = 16;
const L_ENT = 17;
const L_GFX = 18;
const LOCAL_COUNT = 19;

type Op = { opcode: number; operands?: Buffer[]; label?: string; branchTo?: string };

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
        "  npx ts-node src/server/scripts/patch-dungeonblitz-hide-duplicate-boss-visual.ts [--verify] [--swf <path>]",
        "",
        "Hides any entity that shares the boss room's am_Boss EntType but is not the",
        "entity BossFight drives — the motionless duplicate Tag Ugo in Dread Goblin",
        "Hideout and any other boss scene with the same problem.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function s24(value: number): Buffer {
  return Buffer.from([value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff]);
}

function s8(value: number): Buffer {
  const out = Buffer.alloc(1);
  out.writeInt8(value, 0);
  return out;
}

/** Assembles a position-independent block; every branch is relative to its own end. */
function assemble(ops: Op[]): Buffer {
  const labels = new Map<string, number>();
  let offset = 0;
  for (const op of ops) {
    if (op.label) {
      labels.set(op.label, offset);
    }
    if (op.opcode >= 0) {
      offset += 1 + (op.branchTo ? 3 : 0) + (op.operands ?? []).reduce((total, buf) => total + buf.length, 0);
    }
  }

  const chunks: Buffer[] = [];
  offset = 0;
  for (const op of ops) {
    if (op.opcode < 0) {
      continue;
    }
    if (op.branchTo) {
      const target = labels.get(op.branchTo);
      if (target === undefined) {
        throw new PatchError(`Unknown label ${op.branchTo}`);
      }
      chunks.push(Buffer.concat([Buffer.from([op.opcode]), s24(target - (offset + 4))]));
      offset += 4;
      continue;
    }
    const encoded = Buffer.concat([Buffer.from([op.opcode]), ...(op.operands ?? [])]);
    chunks.push(encoded);
    offset += encoded.length;
  }
  return Buffer.concat(chunks);
}

type Abc = ReturnType<typeof parseAbc>;
type Ctx = ReturnType<typeof parseSwf>;

/**
 * A multiname carries the namespace of the class that declares it, and the
 * obfuscated names collide across classes — BossFight's private `var_1` is index
 * 1693 while the first `var_1` in the pool is index 1, a different class's slot
 * entirely. So resolve every property against the class that actually uses it,
 * by finding a real instruction that reads or calls it.
 */
function multinameFromClass(ctx: Ctx, abc: Abc, className: string, propertyName: string): number {
  const classIndex = classIndexByName(abc, className);
  if (classIndex === null) {
    throw new PatchError(`Class ${className} not found.`);
  }

  const methodIdxs = new Set<number>([abc.instances[classIndex].iinitMethodIdx]);
  for (const trait of abc.instances[classIndex].traits) {
    if (trait.methodIdx !== null) {
      methodIdxs.add(trait.methodIdx);
    }
  }

  for (const methodIdx of methodIdxs) {
    const body = abc.methodBodies.get(methodIdx);
    if (!body) {
      continue;
    }
    let instructions: Instruction[];
    try {
      instructions = disassemble(ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen), className);
    } catch {
      continue;
    }
    for (const instruction of instructions) {
      // getproperty / setproperty / callproperty / callpropvoid
      if (![0x66, 0x61, 0x46, 0x4f].includes(instruction.opcode) || instruction.operands.length === 0) {
        continue;
      }
      const index = instruction.operands[0][1];
      if (abc.multinameNames[index] === propertyName) {
        return index;
      }
    }
  }

  throw new PatchError(`Could not resolve ${className}.${propertyName} from any of its own instructions.`);
}

function typeNameIndex(abc: Abc, name: string): number {
  const index = abc.multinameNames.findIndex((candidate) => candidate === name);
  if (index < 0) {
    throw new PatchError(`Type name ${name} not found.`);
  }
  return index;
}

function stringIndex(abc: Abc, value: string): number {
  const index = abc.stringValues.findIndex((candidate) => candidate === value);
  if (index < 0) {
    throw new PatchError(`String constant "${value}" not found.`);
  }
  return index;
}

function buildPrologue(ctx: Ctx, abc: Abc): Buffer {
  const getlocal = (n: number): Op => ({ opcode: 0x62, operands: [writeU30(n)] });
  const setlocal = (n: number): Op => ({ opcode: 0x63, operands: [writeU30(n)] });
  const getprop = (index: number): Op => ({ opcode: 0x66, operands: [writeU30(index)] });
  const setprop = (index: number): Op => ({ opcode: 0x61, operands: [writeU30(index)] });
  const pushstring = (value: string): Op => ({ opcode: 0x2c, operands: [writeU30(stringIndex(abc, value))] });
  const coerce = (name: string): Op => ({ opcode: 0x80, operands: [writeU30(typeNameIndex(abc, name))] });

  const mRoom = multinameFromClass(ctx, abc, "BossFight", "mRoom");
  const game = multinameFromClass(ctx, abc, "BossFight", "var_1");
  const method35 = multinameFromClass(ctx, abc, "BossFight", "method_35");
  const entType = multinameFromClass(ctx, abc, "Entity", "entType");
  const gfx = multinameFromClass(ctx, abc, "Entity", "gfx");
  const clip = multinameFromClass(ctx, abc, "Entity", "var_151");
  const visible = multinameFromClass(ctx, abc, "Entity", "visible");
  const entities = multinameFromClass(ctx, abc, "Game", "entities");

  const resolveBoss = (instanceName: string, target: number): Op[] => [
    getlocal(L_ROOM),
    pushstring(instanceName),
    { opcode: 0x46, operands: [writeU30(method35), writeU30(1)] },
    coerce("Entity"),
    setlocal(target),
  ];

  return assemble([
    // room = this.mRoom
    { opcode: 0xd0 }, getprop(mRoom), setlocal(L_ROOM),
    getlocal(L_ROOM), { opcode: 0x12, branchTo: "end" },

    // boss = room.method_35("am_Boss"); nothing to compare against without it.
    ...resolveBoss("am_Boss", L_BOSS),
    getlocal(L_BOSS), { opcode: 0x12, branchTo: "end" },
    // boss2 may legitimately be null; it is only ever used as an exclusion.
    ...resolveBoss("am_Boss2", L_BOSS2),

    getlocal(L_BOSS), getprop(entType), setlocal(L_TYPE),
    getlocal(L_TYPE), { opcode: 0x12, branchTo: "end" },

    { opcode: 0xd0 }, getprop(game), setlocal(L_GAME),
    getlocal(L_GAME), { opcode: 0x12, branchTo: "end" },

    // coerce_a is mandatory: hasnext2 needs a `*`-typed object register.
    getlocal(L_GAME), getprop(entities), { opcode: 0x82 }, setlocal(L_VEC),
    getlocal(L_VEC), { opcode: 0x12, branchTo: "end" },
    { opcode: 0x24, operands: [s8(0)] }, setlocal(L_IDX),
    { opcode: 0x10, branchTo: "loopCheck" },

    { opcode: -1, label: "loopBody" },
    getlocal(L_VEC), getlocal(L_IDX), { opcode: 0x23 }, coerce("Entity"), setlocal(L_ENT),
    getlocal(L_ENT), { opcode: 0x12, branchTo: "loopCheck" },
    getlocal(L_ENT), getlocal(L_BOSS), { opcode: 0x19, branchTo: "loopCheck" },
    getlocal(L_ENT), getlocal(L_BOSS2), { opcode: 0x19, branchTo: "loopCheck" },
    getlocal(L_ENT), getprop(entType), getlocal(L_TYPE), { opcode: 0x1a, branchTo: "loopCheck" },

    // gfx and its clip are both optional; a half-built entity must not throw.
    getlocal(L_ENT), getprop(gfx), setlocal(L_GFX),
    getlocal(L_GFX), { opcode: 0x12, branchTo: "loopCheck" },
    getlocal(L_GFX), getprop(clip), setlocal(L_GFX),
    getlocal(L_GFX), { opcode: 0x12, branchTo: "loopCheck" },
    getlocal(L_GFX), { opcode: 0x27 }, setprop(visible),

    { opcode: -1, label: "loopCheck" },
    { opcode: 0x32, operands: [writeU30(L_VEC), writeU30(L_IDX)] },
    { opcode: 0x11, branchTo: "loopBody" },

    { opcode: -1, label: "end" },
  ]);
}

function patchSwf(swfPath: string, verify: boolean): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);

  const classIndex = classIndexByName(abc, "BossFight");
  if (classIndex === null) {
    throw new PatchError("Could not find BossFight class.");
  }
  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1981");
  if (methodIdx === null) {
    throw new PatchError("Could not find BossFight.method_1981 (the per-tick boss update).");
  }
  const body = abc.methodBodies.get(methodIdx);
  if (!body) {
    throw new PatchError("Could not find a method body for BossFight.method_1981.");
  }
  if (body.exceptionCount !== 0) {
    throw new PatchError("BossFight.method_1981 has an exception table; its handler offsets would move.");
  }

  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  const instructions = disassemble(code, "BossFight.method_1981");
  const last = instructions[instructions.length - 1];
  if (last.offset + last.size !== body.codeLen) {
    throw new PatchError("BossFight.method_1981 did not disassemble cleanly.");
  }
  if (instructions.some((instruction) => instruction.opcode === 0x1b)) {
    throw new PatchError("BossFight.method_1981 contains a lookupswitch; its case offsets would move.");
  }
  const prologue = buildPrologue(ctx, abc);
  // Checked before the local-count guard, or a re-run would fail that guard
  // against the locals this patch itself added.
  if (code.subarray(0, prologue.length).equals(prologue)) {
    console.log(`${swfPath}: already patched (duplicate boss visuals are hidden).`);
    reportCacheKey(swfPath);
    return;
  }
  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; duplicate boss visuals are still drawn.`);
  }
  if (ctx.body[body.localCountPos] !== L_ROOM) {
    throw new PatchError(
      `BossFight.method_1981 declares ${ctx.body[body.localCountPos]} locals, expected ${L_ROOM}; ` +
      "the scratch registers would collide.",
    );
  }

  const newCode = Buffer.concat([prologue, code]);

  // The check that matters: prepending shifts every instruction uniformly, so no
  // branch operand changes — but prove it rather than assume it, because a wrong
  // branch target is VerifyError #1021 and takes the whole class down.
  const finalInstructions = disassemble(newCode, "BossFight.method_1981 (patched)");
  const finalLast = finalInstructions[finalInstructions.length - 1];
  if (finalLast.offset + finalLast.size !== newCode.length) {
    throw new PatchError("Patched BossFight.method_1981 does not disassemble cleanly.");
  }
  const boundaries = new Set(finalInstructions.map((instruction) => instruction.offset));
  const BRANCH = new Set([0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a]);
  for (const instruction of finalInstructions) {
    if (!BRANCH.has(instruction.opcode)) {
      continue;
    }
    const destination = instruction.offset + 4 + instruction.operands[0][1];
    if (destination !== newCode.length && !boundaries.has(destination)) {
      throw new PatchError(
        `Branch at ${instruction.offset} targets ${destination}, which is not an instruction boundary ` +
        "(this is VerifyError #1021).",
      );
    }
  }

  const patches: BytePatch[] = [
    {
      key: "BossFight.method_1981.code",
      start: body.codeStart,
      end: body.codeStart + body.codeLen,
      data: newCode,
      detail: "hide duplicate boss visuals",
    },
    {
      key: "BossFight.method_1981.codeLen",
      start: body.codeLenPos,
      end: body.codeStart,
      data: writeU30(newCode.length),
      detail: "code length",
    },
    {
      key: "BossFight.method_1981.localCount",
      start: body.localCountPos,
      end: body.localCountPos + 1,
      data: Buffer.from([LOCAL_COUNT]),
      detail: "scratch registers",
    },
  ];

  ensureBackup(swfPath);
  const { body: patchedBody, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, patchedBody, delta);
  console.log(
    `${swfPath}: patched BossFight.method_1981 (${prologue.length}-byte prologue prepended, ` +
    `locals ${L_ROOM} -> ${LOCAL_COUNT}).`,
  );
  reportCacheKey(swfPath);
}

// Editing index.html's own `clientrev=` literal does nothing: StaticServer
// 302-redirects every SWF request to its own `clientRevision` token.
function reportCacheKey(swfPath: string): void {
  if (!fs.existsSync(swfPath)) {
    return;
  }
  const digest = crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
  console.log(
    `  DungeonBlitz.swf is now swf-${digest}. ` +
    "Bump StaticServer.clientRevision so browsers stop serving the cached client.",
  );
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
