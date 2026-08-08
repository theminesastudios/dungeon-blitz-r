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

// DayNightManager time-of-day ids. The engine already carries the whole look for
// each one (per-mode multiply tint, a_Circadian clips on their matching frame,
// per-mode soundscape); they are simply never selected, because TIME_OF_DAY_LIST
// is eight Day entries and instanced levels are pinned to const_518 (Day).
const TIME_OF_DAY_DAY = 1;
const TIME_OF_DAY_NIGHT = 2;
const TIME_OF_DAY_EVENING = 3;
const TIME_OF_DAY_MORNING = 4;

const HOME_LEVEL_NAME = "CraftTown";

// method_1547 already computes local2 = (mServerGameTime / TIME_PER_CYCLE) % 8
// before it decides anything, and it keeps that local untouched up to the commit
// point we inject at. mServerGameTime is unix seconds and TIME_PER_CYCLE is
// 7200/8, so a slot is 15 real minutes and the whole cycle is 2 hours, shared by
// every player because it comes off the server clock.
//
// One entry per slot, in cycle order: 15 min dawn, 45 min day, 15 min dusk,
// 45 min night.
const KEEP_CYCLE: number[] = [
  TIME_OF_DAY_MORNING,
  TIME_OF_DAY_DAY,
  TIME_OF_DAY_DAY,
  TIME_OF_DAY_DAY,
  TIME_OF_DAY_EVENING,
  TIME_OF_DAY_NIGHT,
  TIME_OF_DAY_NIGHT,
  TIME_OF_DAY_NIGHT,
];
const CYCLE_SLOT_LOCAL = 2;

const INDEX_HTML = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "index.html");

/**
 * index.html requests the SWF at a fixed `clientrev=` token, so a browser happily
 * serves a stale copy after the file on disk changes. Pin the token to the SWF's
 * content hash, matching what StaticServer derives, so the new client is fetched.
 */
function syncClientRev(swfPath: string): void {
  if (path.resolve(swfPath) !== DEFAULT_SWF || !fs.existsSync(INDEX_HTML)) {
    return;
  }
  const digest = crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const updated = html.replace(/clientrev=[^&`"'$]+/, `clientrev=swf-${digest}`);
  if (updated !== html) {
    fs.writeFileSync(INDEX_HTML, updated);
    console.log(`  index.html clientrev -> swf-${digest} (cache buster)`);
  }
}

type Operand = [Instruction["operands"][number][0], number];
type InsertedInstruction =
  | { label: string }
  | { opcode: number; operands?: Operand[]; branchTo?: string };

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
        "  ts-node src/server/scripts/patch-dungeonblitz-home-night-mode.ts [--verify] [--swf <path>]",
        "",
        "Patches DayNightManager.method_1547 so the player keep (level CraftTown)",
        "runs the engine's own day/night cycle instead of being pinned to Day:",
        "15 min dawn, 45 min day, 15 min dusk, 45 min night, off the server clock.",
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

function assembleInserted(instructions: InsertedInstruction[]): Buffer {
  const labels = new Map<string, number>();
  let offset = 0;

  for (const inst of instructions) {
    if ("label" in inst) {
      labels.set(inst.label, offset);
      continue;
    }
    offset += 1;
    if (inst.branchTo) {
      offset += 3;
    } else {
      for (const [kind, value] of inst.operands ?? []) {
        offset += operandBytes(kind, value).length;
      }
    }
  }

  const chunks: Buffer[] = [];
  const fixups: Array<{ pos: number; target: string }> = [];
  offset = 0;

  for (const inst of instructions) {
    if ("label" in inst) {
      continue;
    }

    const parts: Buffer[] = [Buffer.from([inst.opcode])];
    offset += 1;

    if (inst.branchTo) {
      parts.push(Buffer.alloc(3));
      fixups.push({ pos: offset, target: inst.branchTo });
      offset += 3;
    } else {
      for (const [kind, value] of inst.operands ?? []) {
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

function applyCodeEditsAndAdjustBranches(
  originalCode: Buffer,
  instructions: Instruction[],
  edits: Array<{ start: number; end: number; data: Buffer }>,
): Buffer {
  const ordered = [...edits].sort((left, right) => left.start - right.start);
  const chunks: Buffer[] = [];
  let cursor = 0;
  for (const edit of ordered) {
    chunks.push(originalCode.subarray(cursor, edit.start));
    chunks.push(edit.data);
    cursor = edit.end;
  }
  chunks.push(originalCode.subarray(cursor));

  const patched = Buffer.concat(chunks);

  function deltaFor(edit: { start: number; end: number; data: Buffer }): number {
    return edit.data.length - (edit.end - edit.start);
  }

  function isInsideEdit(offset: number): boolean {
    return ordered.some((edit) => offset >= edit.start && offset < edit.end);
  }

  function mapInstructionOffset(offset: number): number {
    let mapped = offset;
    for (const edit of ordered) {
      if (edit.end <= offset || (edit.start === edit.end && edit.start <= offset)) {
        mapped += deltaFor(edit);
      }
    }
    return mapped;
  }

  // A branch that used to land on the first byte of a replaced instruction still
  // lands on the replacement, i.e. on the front of the injected guard.
  function mapTargetOffset(offset: number): number {
    let mapped = offset;
    for (const edit of ordered) {
      if (offset < edit.start) {
        continue;
      }
      if (offset >= edit.start && offset < edit.end) {
        return edit.start + (mapped - offset);
      }
      if (offset === edit.end) {
        return edit.start + edit.data.length + (mapped - offset);
      }
      mapped += deltaFor(edit);
    }
    return mapped;
  }

  for (const inst of instructions) {
    if (!isBranchOpcode(inst.opcode) || isInsideEdit(inst.offset)) {
      continue;
    }
    const branch = inst.operands[0];
    if (branch?.[0] !== "s24") {
      throw new PatchError(`Unexpected branch operand at original offset ${inst.offset}`);
    }

    const oldEnd = inst.offset + inst.size;
    const oldTarget = oldEnd + branch[1];
    const newInstOffset = mapInstructionOffset(inst.offset);
    const newEnd = newInstOffset + inst.size;
    const newTarget = mapTargetOffset(oldTarget);
    writeS24(newTarget - newEnd).copy(patched, newInstOffset + 1);
  }

  return patched;
}

function setLocalOperand(inst: Instruction | undefined): number | null {
  if (!inst) {
    return null;
  }
  if (inst.opcode >= 0xd4 && inst.opcode <= 0xd7) {
    return inst.opcode - 0xd4;
  }
  if (inst.opcode === 0x63 && inst.operands[0]?.[0] === "u30") {
    return inst.operands[0][1];
  }
  return null;
}

function getInstanceMethod(swfPath: string, className: string, methodName: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, className);
  if (classIndex === null) {
    throw new PatchError(`Could not find ${className} class.`);
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, methodName);
  if (methodIdx === null) {
    throw new PatchError(`Could not find ${className}.${methodName}.`);
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find method body for ${className}.${methodName} (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `${className}.${methodName}:${methodIdx}`);
  return { ctx, abc, classIndex, methodBody, code, instructions };
}

// The time-of-day value is on the stack right before `dup; setlocal 4;` which is
// where method_1547 compares it against the currently applied var_1078.
function findTimeOfDayCommitOffset(
  instructions: Instruction[],
  abc: ReturnType<typeof parseAbc>,
): { offset: number; index: number } {
  for (let index = 0; index < instructions.length - 4; index += 1) {
    const dup = instructions[index];
    const store = instructions[index + 1];
    const self = instructions[index + 2];
    const applied = instructions[index + 3];
    const compare = instructions[index + 4];
    if (
      dup.opcode === 0x2a &&
      setLocalOperand(store) !== null &&
      self.opcode === 0xd0 &&
      applied.opcode === 0x66 &&
      u30OperandName(applied, abc.multinameNames) === "var_1078" &&
      compare.opcode === 0x13
    ) {
      return { offset: dup.offset, index };
    }
  }

  throw new PatchError("Could not find the time-of-day commit point in DayNightManager.method_1547.");
}

function findPropertyIndex(instructions: Instruction[], abc: ReturnType<typeof parseAbc>, name: string): number {
  for (const inst of instructions) {
    if (inst.opcode === 0x66 && u30OperandName(inst, abc.multinameNames) === name) {
      return inst.operands[0][1];
    }
  }
  throw new PatchError(`Could not find a getproperty for "${name}".`);
}

// internalName is not referenced by DayNightManager, so borrow the multiname the
// Game class already uses for Level.internalName.
function findInternalNamePropertyIndex(
  swfPath: string,
  ctx: ReturnType<typeof parseSwf>,
  abc: ReturnType<typeof parseAbc>,
): number {
  const gameIndex = classIndexByName(abc, "Game");
  if (gameIndex === null) {
    throw new PatchError("Could not find Game class.");
  }

  const counts = new Map<number, number>();
  for (const trait of abc.instances[gameIndex].traits) {
    if (trait.methodIdx === null) {
      continue;
    }
    const body = abc.methodBodies.get(trait.methodIdx);
    if (!body) {
      continue;
    }
    let instructions: Instruction[];
    try {
      instructions = disassemble(
        ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen),
        `Game:${trait.methodIdx}`,
      );
    } catch {
      continue;
    }
    for (const inst of instructions) {
      if (inst.opcode === 0x66 && u30OperandName(inst, abc.multinameNames) === "internalName") {
        const idx = inst.operands[0][1];
        counts.set(idx, (counts.get(idx) ?? 0) + 1);
      }
    }
  }

  let best: number | null = null;
  let bestCount = 0;
  for (const [idx, count] of counts) {
    if (count > bestCount) {
      best = idx;
      bestCount = count;
    }
  }
  if (best === null) {
    throw new PatchError(`Could not find Level.internalName multiname in ${swfPath}.`);
  }
  return best;
}

function homeCycleGuard(
  var1Index: number,
  levelIndex: number,
  internalNameIndex: number,
  homeNameStringIndex: number,
): InsertedInstruction[] {
  const modes = [...new Set(KEEP_CYCLE)].filter((mode) => mode !== TIME_OF_DAY_DAY);

  const selector: InsertedInstruction[] = [];
  for (const mode of modes) {
    for (let slot = 0; slot < KEEP_CYCLE.length; slot += 1) {
      if (KEEP_CYCLE[slot] !== mode) {
        continue;
      }
      selector.push({ opcode: 0x2a });                             // dup slot
      selector.push({ opcode: 0x24, operands: [["s8", slot]] });   // pushbyte slot
      selector.push({ opcode: 0x13, branchTo: `mode${mode}` });    // ifeq
    }
  }
  // Anything the table did not claim is plain daylight.
  selector.push({ opcode: 0x29 });                                 // pop slot
  selector.push({ opcode: 0x24, operands: [["s8", TIME_OF_DAY_DAY]] });
  selector.push({ opcode: 0x74 });                                 // convert_u
  selector.push({ opcode: 0x10, branchTo: "done" });               // jump
  for (const mode of modes) {
    selector.push({ label: `mode${mode}` });
    selector.push({ opcode: 0x29 });                               // pop slot
    selector.push({ opcode: 0x24, operands: [["s8", mode]] });
    selector.push({ opcode: 0x74 });                               // convert_u
    selector.push({ opcode: 0x10, branchTo: "done" });             // jump
  }

  return [
    // stack: [timeOfDay]
    { opcode: 0xd0 },                                          // getlocal0
    { opcode: 0x66, operands: [["u30", var1Index]] },          // getproperty var_1 (Game)
    { opcode: 0x66, operands: [["u30", levelIndex]] },         // getproperty level
    { opcode: 0x2a },                                          // dup
    { opcode: 0x12, branchTo: "dropLevel" },                   // iffalse -> no level
    { opcode: 0x66, operands: [["u30", internalNameIndex]] },  // getproperty internalName
    { opcode: 0x2c, operands: [["u30", homeNameStringIndex]] },// pushstring "CraftTown"
    { opcode: 0x14, branchTo: "done" },                        // ifne -> keep computed value
    { opcode: 0x29 },                                          // pop computed value
    getLocal(CYCLE_SLOT_LOCAL),                                // cycle slot, 0..7
    ...selector,
    { label: "dropLevel" },
    { opcode: 0x29 },                                          // pop null level
    { label: "done" },
  ];
}

function getLocal(localIndex: number): InsertedInstruction {
  if (localIndex >= 0 && localIndex <= 3) {
    return { opcode: 0xd0 + localIndex };
  }
  return { opcode: 0x62, operands: [["u30", localIndex]] };
}

/**
 * Start offset of a guard this script injected on an earlier run, so a re-run
 * replaces it instead of stacking a second copy in front of it. Returns null when
 * the method still has its original shape.
 */
function findExistingGuardStart(
  instructions: Instruction[],
  abc: ReturnType<typeof parseAbc>,
  homeNameStringIndex: number,
  commitIndex: number,
): number | null {
  for (let index = 0; index < commitIndex; index += 1) {
    const self = instructions[index];
    const game = instructions[index + 1];
    const level = instructions[index + 2];
    const dup = instructions[index + 3];
    const iffalse = instructions[index + 4];
    const internalName = instructions[index + 5];
    const push = instructions[index + 6];
    if (
      self?.opcode === 0xd0 &&
      game?.opcode === 0x66 &&
      u30OperandName(game, abc.multinameNames) === "var_1" &&
      level?.opcode === 0x66 &&
      u30OperandName(level, abc.multinameNames) === "level" &&
      dup?.opcode === 0x2a &&
      iffalse?.opcode === 0x12 &&
      internalName?.opcode === 0x66 &&
      u30OperandName(internalName, abc.multinameNames) === "internalName" &&
      push?.opcode === 0x2c &&
      push.operands[0]?.[1] === homeNameStringIndex
    ) {
      return index;
    }
  }
  return null;
}

function patchSwf(swfPath: string, verify: boolean): void {
  const { ctx, abc, methodBody, code, instructions } = getInstanceMethod(
    swfPath,
    "DayNightManager",
    "method_1547",
  );

  const homeNameStringIndex = abc.stringValues.indexOf(HOME_LEVEL_NAME);
  if (homeNameStringIndex < 0) {
    throw new PatchError(`String constant "${HOME_LEVEL_NAME}" not found in ${swfPath}.`);
  }

  const var1Index = findPropertyIndex(instructions, abc, "var_1");
  const levelIndex = findPropertyIndex(instructions, abc, "level");
  const internalNameIndex = findInternalNamePropertyIndex(swfPath, ctx, abc);
  const commit = findTimeOfDayCommitOffset(instructions, abc);
  const existingGuardIndex = findExistingGuardStart(instructions, abc, homeNameStringIndex, commit.index);

  const guard = assembleInserted(
    homeCycleGuard(var1Index, levelIndex, internalNameIndex, homeNameStringIndex),
  );

  // A guard from an earlier run is replaced wholesale, so re-running with a
  // different KEEP_CYCLE retunes the keep instead of stacking a second guard.
  const editStart = existingGuardIndex === null ? commit.offset : instructions[existingGuardIndex].offset;
  const editEnd = commit.offset + instructions[commit.index].size;
  const newRegion = Buffer.concat([guard, Buffer.from([0x2a])]);

  if (code.subarray(editStart, editEnd).equals(newRegion)) {
    console.log(`${swfPath}: already patched (keep day/night cycle present).`);
    if (!verify) {
      syncClientRev(swfPath);
    }
    return;
  }

  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; DayNightManager keep day/night cycle is missing or stale.`);
  }

  // Replacing in place (rather than inserting) keeps every branch that targeted
  // the commit point landing on the front of the guard.
  const patchedCode = applyCodeEditsAndAdjustBranches(code, instructions, [
    { start: editStart, end: editEnd, data: newRegion },
  ]);

  const patches: BytePatch[] = [
    {
      key: "DayNightManager.method_1547.code",
      start: methodBody.codeStart,
      end: methodBody.codeStart + methodBody.codeLen,
      data: patchedCode,
      detail: "run the day/night cycle inside the player keep",
    },
    {
      key: "DayNightManager.method_1547.codeLen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: writeU30(patchedCode.length),
      detail: "update method_1547 code length",
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  console.log(`${swfPath}: patched DayNightManager.method_1547 (keep now cycles day/night).`);
  syncClientRev(swfPath);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
