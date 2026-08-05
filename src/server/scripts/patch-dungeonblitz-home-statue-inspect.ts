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
 * Opens the gear window when a player uses a keep garden statue.
 *
 * A statue is spawned by the server as a player-shaped entity carrying the cue name `StatueName`
 * (see `src/server/core/HomeStatues.ts`). `Game.method_668` is the interact entry point: it is
 * handed the entity id, sends TALK_TO_NPC to the server, and then dispatches on `cue.characterName`
 * through a long chain of `Special_*` comparisons. `StatueName` matches none of them, so stock code
 * falls through it doing nothing visible.
 *
 * This patch prepends a prologue that recognises the cue and calls `Game.method_778(id)` — the same
 * entry the party frame uses to raise the inspect window (`class_68`, `a_InspectWindow`), whose
 * Examine panel reads gear straight off `entity.entType.equippedGear`. So the viewer gets the real
 * Examine Gear panel with no new UI and no extra packet, and the server-side owner check still runs
 * off the TALK_TO_NPC the original code sends a few instructions later.
 *
 * Shape of the edit, and why it is safe:
 *   - It only *prepends*. Every original instruction shifts by the same amount and every branch in
 *     the method is relative, so no branch operand needs recomputing — the failure mode that
 *     produced VerifyError #1021 in an earlier patch here is structurally impossible.
 *   - It uses no scratch registers and no `getlex`/`findproperty`, so `localCount` is untouched and
 *     the empty-scope-at-offset-0 trap does not apply.
 *   - Peak stack is 2 against a declared maxStack of 6.
 *   - Both the marker string and every multiname already exist in the constant pool, taken from the
 *     operands the target method itself uses, so the pool is not touched at all.
 *
 * Usage:
 *   npx tsx src/server/scripts/patch-dungeonblitz-home-statue-inspect.ts [--verify] [--swf <path>]
 */

const DEFAULT_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf",
);
const INDEX_HTML = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "index.html",
);

/** Must match HOME_STATUE_CUE_NAME in src/server/core/HomeStatues.ts. */
const CUE_NAME = "StatueName";

const OP_GETLOCAL_0 = 0xd0;
const OP_GETLOCAL_1 = 0xd1;
const OP_CALLPROPERTY = 0x46;
const OP_CALLPROPVOID = 0x4f;
const OP_GETPROPERTY = 0x66;
const OP_PUSHSTRING = 0x2c;
const OP_DUP = 0x2a;
const OP_POP = 0x29;
const OP_JUMP = 0x10;
const OP_IFFALSE = 0x12;
const OP_IFSTRICTNE = 0x1a;

const BRANCH_OPCODES = new Set([
  0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a,
]);

type Op = { opcode: number; operands?: Buffer[]; label?: string; branchTo?: string };

function s24(value: number): Buffer {
  if (value < -0x800000 || value > 0x7fffff) throw new PatchError(`s24 out of range: ${value}`);
  const out = Buffer.alloc(3);
  out.writeIntLE(value, 0, 3);
  return out;
}

/** Assembles a self-contained block. Every branch is relative, so the block is position independent. */
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

/**
 * index.html requests the SWF at a fixed `clientrev=` token, so without this the browser keeps
 * serving the pre-patch copy and a test run silently measures the old build.
 */
function syncClientRev(swfPath: string): void {
  if (path.resolve(swfPath) !== DEFAULT_SWF || !fs.existsSync(INDEX_HTML)) return;
  const digest = crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  // Stop at $ as well as & and the quotes: the token is followed by ${languageParam} in a template
  // literal, and swallowing that would drop the locale.
  const updated = html.replace(/clientrev=[^&`"'$]+/, `clientrev=swf-${digest}`);
  if (updated !== html) {
    fs.writeFileSync(INDEX_HTML, updated);
    console.log(`  index.html clientrev -> swf-${digest} (cache buster)`);
  }
}

function uniqueIndex(values: string[], wanted: string, what: string): number {
  const hits: number[] = [];
  values.forEach((value, index) => { if (value === wanted) hits.push(index); });
  if (hits.length !== 1) throw new PatchError(`Expected exactly one ${what} named "${wanted}", found ${hits.length}.`);
  return hits[0];
}

/**
 * Pulls a multiname index out of the target method's own code rather than off a name lookup, so the
 * prologue is guaranteed to use the same constant-pool entry the surrounding code resolves against.
 */
function operandFromMethod(
  instructions: Instruction[],
  names: string[],
  opcode: number,
  wanted: string,
  what: string,
): number {
  const seen = new Set<number>();
  for (const instruction of instructions) {
    if (instruction.opcode !== opcode) continue;
    const [kind, value] = instruction.operands[0] ?? [];
    if (kind !== "u30") continue;
    if (names[value] === wanted) seen.add(value);
  }
  if (seen.size !== 1) throw new PatchError(`Expected exactly one ${what} operand for "${wanted}" in method_668, found ${seen.size}.`);
  return [...seen][0];
}

/** Every branch target must land on an instruction boundary, or Flash rejects the whole method. */
function assertBranchTargetsLand(instructions: Instruction[], codeLen: number, label: string): void {
  const boundaries = new Set(instructions.map((instruction) => instruction.offset));
  boundaries.add(codeLen);
  for (const instruction of instructions) {
    if (!BRANCH_OPCODES.has(instruction.opcode)) continue;
    const [kind, value] = instruction.operands[0] ?? [];
    if (kind !== "s24") continue;
    const target = instruction.offset + instruction.size + value;
    if (!boundaries.has(target)) {
      throw new PatchError(`${label}: branch at ${instruction.offset} targets ${target}, not an instruction boundary.`);
    }
  }
}

function readMethod(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);

  const gameIndex = classIndexByName(abc, "Game");
  if (gameIndex === null) throw new PatchError("Class Game not found.");

  const methodIdx = methodIdxForTrait(abc.instances[gameIndex].traits, abc, "method_668");
  if (methodIdx === null) throw new PatchError("Game.method_668 not found.");

  const body = abc.methodBodies.get(methodIdx);
  if (!body) throw new PatchError("Game.method_668 has no body.");

  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  const instructions = disassemble(code, "Game.method_668");
  const covered = instructions.length ? instructions[instructions.length - 1].offset + instructions[instructions.length - 1].size : 0;
  if (covered !== body.codeLen) throw new PatchError(`Disassembly covers ${covered} of ${body.codeLen} bytes.`);
  if (body.exceptionCount !== 0) throw new PatchError(`Game.method_668 has ${body.exceptionCount} exception handlers; prepending is not safe.`);

  return { ctx, abc, body, code, instructions };
}

function buildPrologue(
  abc: ReturnType<typeof parseAbc>,
  instructions: Instruction[],
): Buffer {
  const getEntFromId = operandFromMethod(instructions, abc.multinameNames, OP_CALLPROPERTY, "GetEntFromID", "callproperty");
  const cue = operandFromMethod(instructions, abc.multinameNames, OP_GETPROPERTY, "cue", "getproperty");
  const characterName = operandFromMethod(instructions, abc.multinameNames, OP_GETPROPERTY, "characterName", "getproperty");
  const inspect = uniqueIndex(abc.multinameNames, "method_778", "multiname");
  const marker = uniqueIndex(abc.stringValues, CUE_NAME, "string");

  //   ent = this.GetEntFromID(param1)
  //   if (!ent) goto skip
  //   if (!ent.cue) goto skip
  //   if (ent.cue.characterName !== "StatueName") goto skip
  //   this.method_778(param1)
  // skip: <original body>
  return assemble([
    { opcode: OP_GETLOCAL_0 },
    { opcode: OP_GETLOCAL_1 },
    { opcode: OP_CALLPROPERTY, operands: [writeU30(getEntFromId), writeU30(1)] },
    { opcode: OP_DUP },
    { opcode: OP_IFFALSE, branchTo: "drop" },
    { opcode: OP_GETPROPERTY, operands: [writeU30(cue)] },
    { opcode: OP_DUP },
    { opcode: OP_IFFALSE, branchTo: "drop" },
    { opcode: OP_GETPROPERTY, operands: [writeU30(characterName)] },
    { opcode: OP_PUSHSTRING, operands: [writeU30(marker)] },
    { opcode: OP_IFSTRICTNE, branchTo: "skip" },
    { opcode: OP_GETLOCAL_0 },
    { opcode: OP_GETLOCAL_1 },
    { opcode: OP_CALLPROPVOID, operands: [writeU30(inspect), writeU30(1)] },
    { opcode: OP_JUMP, branchTo: "skip" },
    // `iffalse` consumed one copy of the duplicated value; drop the other so the original body
    // starts on a balanced stack.
    { opcode: -1, label: "drop" },
    { opcode: OP_POP },
    { opcode: -1, label: "skip" },
  ]);
}

function isPatched(instructions: Instruction[], abc: ReturnType<typeof parseAbc>): boolean {
  const first = instructions[0];
  if (!first || first.opcode !== OP_GETLOCAL_0) return false;
  const pushString = instructions.slice(0, 20).find((instruction) => instruction.opcode === OP_PUSHSTRING);
  if (!pushString) return false;
  const [, index] = pushString.operands[0] ?? [];
  return abc.stringValues[index as number] === CUE_NAME;
}

function main(): void {
  const args = process.argv.slice(2);
  const verifyOnly = args.includes("--verify");
  const swfIndex = args.indexOf("--swf");
  const swfPath = swfIndex >= 0 ? path.resolve(process.cwd(), args[swfIndex + 1]) : DEFAULT_SWF;

  const { ctx, abc, body, instructions } = readMethod(swfPath);

  if (isPatched(instructions, abc)) {
    console.log("Game.method_668 already opens the gear window for keep statues.");
    if (!verifyOnly) syncClientRev(swfPath);
    return;
  }
  if (verifyOnly) throw new PatchError("Game.method_668 does not carry the keep statue prologue.");

  const prologue = buildPrologue(abc, instructions);
  const newCodeLen = body.codeLen + prologue.length;

  const patches: BytePatch[] = [
    {
      key: "method_668.code_length",
      start: body.codeLenPos,
      end: body.codeStart,
      data: writeU30(newCodeLen),
      detail: `code_length ${body.codeLen} -> ${newCodeLen}`,
    },
    {
      key: "method_668.prologue",
      start: body.codeStart,
      end: body.codeStart,
      data: prologue,
      detail: `prepend ${prologue.length} bytes`,
    },
  ];

  const { body: patchedBody, delta } = applyPatchesToBody(ctx.body, patches);

  ensureBackup(swfPath);
  writeSwf(ctx, patchedBody, delta);

  // Re-read from disk with a fresh parse and prove the method is still well formed.
  const after = readMethod(swfPath);
  if (!isPatched(after.instructions, after.abc)) throw new PatchError("Prologue did not take.");
  assertBranchTargetsLand(after.instructions, after.body.codeLen, "Game.method_668");

  console.log(`Patched ${path.basename(swfPath)}: Game.method_668 +${prologue.length} bytes, code_length ${after.body.codeLen}.`);
  syncClientRev(swfPath);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`[patch-dungeonblitz-home-statue-inspect] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
