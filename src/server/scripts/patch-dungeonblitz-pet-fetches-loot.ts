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
 * Makes an equipped follower pet fetch dropped gold.
 *
 *   Loot.method_1300   the pickup test. `local1` is Game.clientEnt and doubles as the centre of the
 *                      pickup box, the source of the box dimensions, and the HP gate for health
 *                      orbs. Only the box *centre* moves to the pet: dimensions stay on the player
 *                      (70x125 beats the pet's 50x50) and the HP gate stays on the player or health
 *                      orbs break. With no pet summoned the lookup falls back to clientEnt, so an
 *                      unequipped player collects loot exactly as before.
 *
 *   Brain.Think        the pet's follow destination. `local4` holds the summoner Entity and its
 *                      physPos reads steer the pet; a prologue precomputes a goal point (nearest
 *                      gold Loot within GOLD_SEEK_RADIUS, else the summoner's own position) and the
 *                      two reads are retargeted at it.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THIS IS SHAPED THE WAY IT IS — an earlier revision shipped a `VerifyError #1021` ("branch
 * target not on a valid instruction") because it *grew* the body at the two read sites and then
 * recomputed every relative branch from a disassembled instruction map. That map only has to be
 * wrong about one instruction's size for the recomputation to corrupt a branch, and this SWF is
 * obfuscated enough that trusting it is not worth it.
 *
 * So this revision never renumbers a branch. Two rules:
 *   1. New code is only ever *prepended*. That shifts every original instruction by the same
 *      amount, so every relative branch offset stays correct by construction.
 *   2. Every in-body edit is byte-for-byte **length preserving**, asserted at build time.
 * Together these make #1021 structurally impossible rather than merely unobserved.
 *
 * The two Loot sites are each one byte short of what the replacement needs, so each absorbs a
 * neighbouring instruction that is provably a no-op:
 *   appearPosX  absorbs the preceding `label` (0x09), which is a pure marker.
 *   appearPosY  absorbs the trailing `convert_d` (0x75), redundant because Entity.appearPosY is a
 *               Number-typed slot (checked against the trait, not assumed).
 * The Brain sites fit exactly once padded with `nop` (0x02).
 * ---------------------------------------------------------------------------------------------
 *
 * Usage:
 *   npm exec tsx src/server/scripts/patch-dungeonblitz-pet-fetches-loot.ts [--verify] [--only brain|loot|both]
 */

const DEFAULT_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf",
);
const INDEX_HTML = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "index.html",
);

/**
 * index.html requests the SWF at a fixed `clientrev=` token, so a browser happily serves a stale
 * copy after the file on disk changes — which silently invalidates a test run. Pin the token to the
 * SWF's content hash so patching, reverting and re-patching always produce a distinct URL.
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

/** Pixels. Beyond this the pet ignores gold and just follows the player. */
const GOLD_SEEK_RADIUS = 600;

const OP_NOP = 0x02;
const OP_LABEL = 0x09;
const OP_CONVERT_D = 0x75;

// Brain.Think scratch locals (original localCount is 12).
const B_GOAL_X = 12, B_GOAL_Y = 13, B_SELF = 14, B_OWNER = 15, B_BEST = 16;
const B_VEC = 17, B_IDX = 18, B_LOOT = 19, B_DX = 20, B_DY = 21, B_DIST = 22, B_GAME = 23;
const B_LOCAL_COUNT = 24, B_MAX_STACK = 12;

// Loot.method_1300 scratch locals (original localCount is 16).
const L_COLLECTOR = 16, L_VEC = 17, L_IDX = 18, L_POS_X = 19, L_POS_Y = 20;
const L_LOCAL_COUNT = 21, L_MAX_STACK = 12;

type Op = { opcode: number; operands?: Buffer[]; label?: string; branchTo?: string };
type Only = "both" | "brain" | "loot";

/**
 * Bisect switch. When true, the Loot prologue does NOT look up a summoned pet: the collector stays
 * Game.clientEnt, exactly what the original code used as the pickup-box centre. Behaviour is then
 * identical to stock, but the prologue-prepend + in-place site rewrite mechanism is still exercised.
 * So if `--minimal` crashes, the fault is the patch mechanism itself; if only the full version
 * crashes, the fault is the GetSummonedCreatures loop.
 */
let MINIMAL_LOOT = false;

/**
 * Second bisect stage. `--probe-call` runs the scope + getlex + `GetSummonedCreatures` call exactly
 * as the full build does, but throws the result away and leaves the collector as clientEnt — the
 * iteration loop (hasnext2 / nextvalue / coerce) is omitted. So if `--probe-call` crashes the fault
 * is the call/scope; if only the full build crashes the fault is the loop.
 */
let PROBE_CALL = false;

function parseArgs(argv: string[]): { swfPath: string; verify: boolean; only: Only } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  let only: Only = "both";
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") swfPath = path.resolve(argv[++index] || "");
    else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else if (arg === "--minimal") MINIMAL_LOOT = true;
    else if (arg === "--probe-call") PROBE_CALL = true;
    else if (arg === "--only") {
      const value = argv[++index];
      if (value !== "brain" && value !== "loot" && value !== "both") throw new Error("--only expects brain|loot|both");
      only = value;
    } else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage: npm exec tsx src/server/scripts/patch-dungeonblitz-pet-fetches-loot.ts [--verify] [--only brain|loot|both]",
        "  --only loot    the pet becomes what collects loot (does not steer it)",
        "  --only brain   the pet walks toward dropped gold (does not collect it)",
        "Revert with: git checkout -- <swf path>",
      ].join("\n"));
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify, only };
}

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

function multinameIndex(abc: ReturnType<typeof parseAbc>, name: string): number {
  const index = abc.multinameNames.findIndex((candidate) => candidate === name);
  if (index < 0) throw new PatchError(`Multiname ${name} not found.`);
  return index;
}

function multiname(abc: ReturnType<typeof parseAbc>, name: string): Buffer {
  return writeU30(multinameIndex(abc, name));
}

/** Asserts a slot trait exists on `className` with the given type — used to prove a coercion is redundant. */
function assertSlotType(abc: ReturnType<typeof parseAbc>, className: string, slot: string, expected: string): void {
  const classIndex = classIndexByName(abc, className);
  if (classIndex === null) throw new PatchError(`Class ${className} not found.`);
  const trait = abc.instances[classIndex].traits.find((t) => abc.multinameNames[t.nameIdx] === slot);
  if (!trait || trait.typeNameIdx === undefined) throw new PatchError(`${className}.${slot} is not a typed slot.`);
  const actual = abc.multinameNames[trait.typeNameIdx];
  if (actual !== expected) throw new PatchError(`${className}.${slot} is ${actual}, expected ${expected}; the convert_d elision is no longer safe.`);
}

/** goalX/goalY = nearest gold Loot within radius of a follower pet, else the summoner's position. */
function buildBrainPrologue(abc: ReturnType<typeof parseAbc>): Buffer {
  const getlocal = (n: number): Op => ({ opcode: 0x62, operands: [writeU30(n)] });
  const setlocal = (n: number): Op => ({ opcode: 0x63, operands: [writeU30(n)] });
  const getprop = (name: string): Op => ({ opcode: 0x66, operands: [multiname(abc, name)] });

  return assemble([
    { opcode: 0x24, operands: [s8(0)] }, { opcode: 0x75 }, setlocal(B_GOAL_X),
    { opcode: 0x24, operands: [s8(0)] }, { opcode: 0x75 }, setlocal(B_GOAL_Y),

    { opcode: 0xd0 }, getprop("e"), setlocal(B_SELF),
    getlocal(B_SELF), { opcode: 0x12, branchTo: "end" },

    // The original only touches this.var_1 inside the follow branch, so guard it here.
    { opcode: 0xd0 }, getprop("var_1"), setlocal(B_GAME),
    getlocal(B_GAME), { opcode: 0x12, branchTo: "end" },

    getlocal(B_GAME), getlocal(B_SELF), getprop("summonerId"),
    { opcode: 0x46, operands: [multiname(abc, "GetEntFromID"), writeU30(1)] },
    setlocal(B_OWNER),
    getlocal(B_OWNER), { opcode: 0x12, branchTo: "end" },

    // Identical to the reads being replaced.
    getlocal(B_OWNER), getprop("physPosX"), { opcode: 0x75 }, setlocal(B_GOAL_X),
    getlocal(B_OWNER), getprop("physPosY"), { opcode: 0x75 }, setlocal(B_GOAL_Y),

    getlocal(B_SELF), getprop("behaviorType"),
    { opcode: 0x2a }, { opcode: 0x12, branchTo: "popEnd" },
    getprop("bFollowSpawner"), { opcode: 0x12, branchTo: "end" },

    { opcode: 0x25, operands: [writeU30(GOLD_SEEK_RADIUS)] }, { opcode: 0x75 },
    { opcode: 0x2a }, { opcode: 0xa2 }, setlocal(B_BEST),

    // coerce_a is mandatory: hasnext2 requires a `*`-typed object register. Mirrors Game#method_447.
    getlocal(B_GAME), getprop("var_326"), { opcode: 0x82 }, setlocal(B_VEC),
    getlocal(B_VEC), { opcode: 0x12, branchTo: "end" },
    { opcode: 0x24, operands: [s8(0)] }, setlocal(B_IDX),
    { opcode: 0x10, branchTo: "loopCheck" },

    { opcode: -1, label: "loopBody" },
    getlocal(B_VEC), getlocal(B_IDX), { opcode: 0x23 },
    { opcode: 0x80, operands: [multiname(abc, "Loot")] }, setlocal(B_LOOT),
    getlocal(B_LOOT), { opcode: 0x12, branchTo: "loopCheck" },
    getlocal(B_LOOT), getprop("var_79"), { opcode: 0x24, operands: [s8(0)] },
    { opcode: 0x16, branchTo: "loopCheck" },

    getlocal(B_LOOT), getprop("var_11"), getprop("x"),
    getlocal(B_SELF), getprop("physPosX"), { opcode: 0xa1 }, { opcode: 0x75 }, setlocal(B_DX),
    getlocal(B_LOOT), getprop("var_11"), getprop("y"),
    getlocal(B_SELF), getprop("physPosY"), { opcode: 0xa1 }, { opcode: 0x75 }, setlocal(B_DY),

    getlocal(B_DX), { opcode: 0x2a }, { opcode: 0xa2 },
    getlocal(B_DY), { opcode: 0x2a }, { opcode: 0xa2 },
    { opcode: 0xa0 }, setlocal(B_DIST),
    getlocal(B_DIST), getlocal(B_BEST), { opcode: 0x18, branchTo: "loopCheck" },

    getlocal(B_DIST), setlocal(B_BEST),
    getlocal(B_LOOT), getprop("var_11"), getprop("x"), { opcode: 0x75 }, setlocal(B_GOAL_X),
    getlocal(B_LOOT), getprop("var_11"), getprop("y"), { opcode: 0x75 }, setlocal(B_GOAL_Y),

    { opcode: -1, label: "loopCheck" },
    { opcode: 0x32, operands: [writeU30(B_VEC), writeU30(B_IDX)] },
    { opcode: 0x11, branchTo: "loopBody" },
    { opcode: 0x10, branchTo: "end" },

    { opcode: -1, label: "popEnd" },
    { opcode: 0x29 },
    { opcode: -1, label: "end" },
  ]);
}

/**
 * collector = the player's first summoned pet, else Game.clientEnt.
 *
 * The method does not establish its scope stack until offset 18 (`getlocal_0; pushscope`), and this
 * prologue runs ahead of that, so `getlex PowerType` would verify against an empty scope chain and
 * kill the class at load time. The prologue therefore pushes and pops its own scope, and every
 * internal branch targets `end`, which sits before the `popscope`, so scope depth is balanced on
 * every path back into the original code.
 */
function buildLootPrologue(abc: ReturnType<typeof parseAbc>): Buffer {
  const getlocal = (n: number): Op => ({ opcode: 0x62, operands: [writeU30(n)] });
  const setlocal = (n: number): Op => ({ opcode: 0x63, operands: [writeU30(n)] });
  const getprop = (name: string): Op => ({ opcode: 0x66, operands: [multiname(abc, name)] });

  if (MINIMAL_LOOT) {
    // Bisect build: collector is always clientEnt, so no getlex/callproperty and no scope needed.
    // Behaviour is identical to stock; only the mechanism (prepend + in-place site rewrite) is under
    // test. Uses `end` so the two read-site edits still resolve.
    return assemble([
      { opcode: 0x24, operands: [s8(0)] }, { opcode: 0x75 }, setlocal(L_POS_X),
      { opcode: 0x24, operands: [s8(0)] }, { opcode: 0x75 }, setlocal(L_POS_Y),
      { opcode: 0xd0 }, getprop("var_1"), getprop("clientEnt"), setlocal(L_COLLECTOR),
      getlocal(L_COLLECTOR), { opcode: 0x12, branchTo: "end" },
      getlocal(L_COLLECTOR), getprop("appearPosX"), { opcode: 0x75 }, setlocal(L_POS_X),
      getlocal(L_COLLECTOR), getprop("appearPosY"), { opcode: 0x75 }, setlocal(L_POS_Y),
      { opcode: -1, label: "end" },
    ]);
  }

  return assemble([
    { opcode: 0xd0 }, { opcode: 0x30 },

    // Defaults, so the two read sites always see a Number even if there is no collector at all.
    { opcode: 0x24, operands: [s8(0)] }, { opcode: 0x75 }, setlocal(L_POS_X),
    { opcode: 0x24, operands: [s8(0)] }, { opcode: 0x75 }, setlocal(L_POS_Y),

    // The original dereferences this.var_1.clientEnt unconditionally at offset 68, so this adds no
    // new null risk.
    { opcode: 0xd0 }, getprop("var_1"), getprop("clientEnt"), setlocal(L_COLLECTOR),
    getlocal(L_COLLECTOR), { opcode: 0x12, branchTo: "done" },

    { opcode: 0xd0 }, getprop("var_1"),
    getlocal(L_COLLECTOR), getprop("id"),
    { opcode: 0x60, operands: [multiname(abc, "PowerType")] }, getprop("var_315"),
    { opcode: 0x46, operands: [multiname(abc, "GetSummonedCreatures"), writeU30(2)] },
    ...(PROBE_CALL
      // Probe build: make the call, discard its result, keep collector = clientEnt. Isolates the
      // call + scope from the iteration loop.
      ? [{ opcode: 0x29 } as Op, { opcode: 0x10, branchTo: "end" } as Op]
      : [
        { opcode: 0x82 }, setlocal(L_VEC),
        getlocal(L_VEC), { opcode: 0x12, branchTo: "end" },
        { opcode: 0x24, operands: [s8(0)] }, setlocal(L_IDX),
        { opcode: 0x10, branchTo: "loopCheck" },

        { opcode: -1, label: "loopBody" },
        getlocal(L_VEC), getlocal(L_IDX), { opcode: 0x23 },
        { opcode: 0x80, operands: [multiname(abc, "Entity")] },
        { opcode: 0x2a }, { opcode: 0x12, branchTo: "skip" },
        setlocal(L_COLLECTOR),
        { opcode: 0x10, branchTo: "end" },
        { opcode: -1, label: "skip" },
        { opcode: 0x29 },

        { opcode: -1, label: "loopCheck" },
        { opcode: 0x32, operands: [writeU30(L_VEC), writeU30(L_IDX)] },
        { opcode: 0x11, branchTo: "loopBody" },
      ]),

    // Precompute the pickup-box centre here rather than at the read sites. Reading the property at
    // the site would need 5 bytes, and the only spare byte there is a `convert_d` that turned out to
    // be the target of an iftrue — absorbing it is what produced VerifyError #1021. A plain
    // `getlocal` fits the natural 4-byte window with nop padding and touches no neighbour.
    { opcode: -1, label: "end" },
    getlocal(L_COLLECTOR), getprop("appearPosX"), { opcode: 0x75 }, setlocal(L_POS_X),
    getlocal(L_COLLECTOR), getprop("appearPosY"), { opcode: 0x75 }, setlocal(L_POS_Y),
    { opcode: -1, label: "done" },
    { opcode: 0x1d },
  ]);
}

type Edit = { start: number; end: number; data: Buffer; what: string };

/**
 * Finds `<objectPush> getproperty <prop>` and returns a length-preserving replacement that pushes
 * `newLocal` instead. `absorb` names an adjacent no-op instruction to swallow when the natural
 * window is too small; the expected opcode is asserted so a future SWF cannot silently shift it.
 */
function retargetSite(
  abc: ReturnType<typeof parseAbc>,
  insts: Instruction[],
  prop: string,
  objOpcode: number,
  objOperand: number | null,
  newLocal: number,
  keepProperty: boolean,
  absorb: "none" | "leading-label" | "trailing-convert-d",
): Edit {
  const propIdx = multinameIndex(abc, prop);
  for (let i = 1; i < insts.length; i += 1) {
    const obj = insts[i - 1];
    const get = insts[i];
    if (obj.opcode !== objOpcode) continue;
    if (objOperand !== null && obj.operands[0]?.[1] !== objOperand) continue;
    if (get.opcode !== 0x66 || get.operands[0]?.[1] !== propIdx) continue;

    let start = obj.offset;
    let end = get.offset + get.size;
    if (absorb === "leading-label") {
      const before = insts[i - 2];
      if (!before || before.opcode !== OP_LABEL) throw new PatchError(`${prop}: expected a label before ${obj.offset}, found 0x${before?.opcode.toString(16)}.`);
      start = before.offset;
    } else if (absorb === "trailing-convert-d") {
      const after = insts[i + 1];
      if (!after || after.opcode !== OP_CONVERT_D) throw new PatchError(`${prop}: expected convert_d after ${get.offset}, found 0x${after?.opcode.toString(16)}.`);
      end = after.offset + after.size;
    }

    const body: Op[] = [{ opcode: 0x62, operands: [writeU30(newLocal)] }];
    if (keepProperty) body.push({ opcode: 0x66, operands: [writeU30(propIdx)] });
    let data = assemble(body);
    const width = end - start;
    if (data.length > width) throw new PatchError(`${prop}: replacement is ${data.length}b but only ${width}b available.`);
    if (data.length < width) data = Buffer.concat([data, Buffer.alloc(width - data.length, OP_NOP)]);
    return { start, end, data, what: `${prop} -> local${newLocal}` };
  }
  throw new PatchError(`Could not locate the ${prop} read site.`);
}

function patch(swfPath: string, verify: boolean, only: Only): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);

  const brainIdx = classIndexByName(abc, "Brain");
  const lootIdx = classIndexByName(abc, "Loot");
  if (brainIdx === null || lootIdx === null) throw new PatchError("Brain or Loot class missing.");
  const thinkIdx = methodIdxForTrait(abc.instances[brainIdx].traits, abc, "Think");
  const tickIdx = methodIdxForTrait(abc.instances[lootIdx].traits, abc, "method_1300");
  if (thinkIdx === null || tickIdx === null) throw new PatchError("Brain.Think or Loot.method_1300 missing.");

  // Proves the convert_d absorbed at the appearPosY site is redundant.
  assertSlotType(abc, "Entity", "appearPosY", "Number");

  type Target = {
    label: string; methodIdx: number; localCount: number; maxStack: number;
    prologue: () => Buffer; edits: (i: Instruction[]) => Edit[];
  };
  const targets: Target[] = [
    {
      label: "Brain.Think", methodIdx: thinkIdx, localCount: B_LOCAL_COUNT, maxStack: B_MAX_STACK,
      prologue: () => buildBrainPrologue(abc),
      edits: (insts: Instruction[]) => [
        retargetSite(abc, insts, "physPosX", 0x62, 4, B_GOAL_X, false, "none"),
        retargetSite(abc, insts, "physPosY", 0x62, 4, B_GOAL_Y, false, "none"),
      ],
    },
    {
      label: "Loot.method_1300", methodIdx: tickIdx, localCount: L_LOCAL_COUNT, maxStack: L_MAX_STACK,
      prologue: () => buildLootPrologue(abc),
      edits: (insts: Instruction[]) => [
        retargetSite(abc, insts, "appearPosX", 0xd1, null, L_POS_X, false, "none"),
        retargetSite(abc, insts, "appearPosY", 0xd1, null, L_POS_Y, false, "none"),
      ],
    },
  ].filter((t) => only === "both" || (only === "brain" ? t.label.startsWith("Brain") : t.label.startsWith("Loot")));

  const patches: BytePatch[] = [];
  let alreadyPatched = 0;

  for (const target of targets) {
    const body = abc.methodBodies.get(target.methodIdx);
    if (!body) throw new PatchError(`No body for ${target.label}.`);
    if (body.exceptionCount > 0) throw new PatchError(`${target.label} has an exception table.`);

    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const insts = disassemble(code, target.label);
    const last = insts[insts.length - 1];
    if (last.offset + last.size !== body.codeLen) throw new PatchError(`${target.label} did not disassemble cleanly.`);
    if (insts.some((i) => i.opcode === 0x1b)) throw new PatchError(`${target.label} contains a lookupswitch.`);

    const prologue = target.prologue();
    if (code.subarray(0, prologue.length).equals(prologue)) { alreadyPatched += 1; continue; }

    // In-place, same-length overwrites only: no branch offset anywhere changes.
    const rewritten = Buffer.from(code);
    for (const edit of target.edits(insts)) {
      if (edit.data.length !== edit.end - edit.start) throw new PatchError(`${target.label}: ${edit.what} is not length preserving.`);
      edit.data.copy(rewritten, edit.start);
    }
    const newCode = Buffer.concat([prologue, rewritten]);
    if (newCode.length !== prologue.length + code.length) throw new PatchError(`${target.label}: body length changed by something other than the prologue.`);

    // The check that matters. Overwriting a window in place keeps every branch *operand* correct,
    // but it can still destroy an instruction boundary *inside* that window — and if some branch
    // targets the boundary that disappeared, Flash rejects the whole method with VerifyError #1021.
    // That is exactly how the first two attempts shipped broken: absorbing a `convert_d` that was
    // the target of an iftrue. Re-disassemble and prove every branch still lands on a boundary.
    const finalInsts = disassemble(newCode, `${target.label} (patched)`);
    const finalLast = finalInsts[finalInsts.length - 1];
    if (finalLast.offset + finalLast.size !== newCode.length) throw new PatchError(`${target.label}: patched body does not disassemble cleanly.`);
    const boundaries = new Set(finalInsts.map((i) => i.offset));
    const BRANCH = new Set([0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a]);
    for (const inst of finalInsts) {
      if (!BRANCH.has(inst.opcode)) continue;
      const dest = inst.offset + 4 + inst.operands[0][1];
      if (dest !== newCode.length && !boundaries.has(dest)) {
        throw new PatchError(`${target.label}: branch at ${inst.offset} targets ${dest}, which is no longer an instruction boundary (this is VerifyError #1021).`);
      }
    }

    patches.push(
      { key: `${target.label}.code`, start: body.codeStart, end: body.codeStart + body.codeLen, data: newCode, detail: `${target.label}: pet fetches loot` },
      { key: `${target.label}.codeLen`, start: body.codeLenPos, end: body.codeStart, data: writeU30(newCode.length), detail: `${target.label}: code length` },
      { key: `${target.label}.localCount`, start: body.localCountPos, end: body.localCountPos + 1, data: Buffer.from([target.localCount]), detail: `${target.label}: local count` },
      { key: `${target.label}.maxStack`, start: body.maxStackPos, end: body.maxStackPos + 1, data: Buffer.from([target.maxStack]), detail: `${target.label}: max stack` },
    );
  }

  // Keep the cache token in step with whatever is actually on disk, even on a no-op run.
  if (alreadyPatched === targets.length) { console.log(`${swfPath}: already patched (only=${only}).`); syncClientRev(swfPath); return; }
  if (alreadyPatched !== 0) throw new PatchError(`${swfPath}: partially patched; git checkout the SWF and re-run.`);
  if (verify) { console.log(`${swfPath}: WOULD PATCH -> only=${only} (${patches.length} byte patches).`); return; }

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: patched (only=${only}, delta ${delta} bytes).`);
  syncClientRev(swfPath);
}

const { swfPath, verify, only } = parseArgs(process.argv);
patch(swfPath, verify, only);
