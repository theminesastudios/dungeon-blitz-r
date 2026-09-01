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

const DEFAULT_SWF = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf");
const DEFAULT_INDEX = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "index.html");
const BRANCH_OPCODES = new Set(Array.from({ length: 15 }, (_, index) => 0x0c + index));

const OP = {
  getlex: 0x60,
  getlocal: 0x62,
  setlocal: 0x63,
  getproperty: 0x66,
  coerceS: 0x85,
  callpropvoid: 0x4f,
} as const;

function parseArgs(argv: string[]): { swfPath: string; verify: boolean; updateRevision: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  let updateRevision = true;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      updateRevision = swfPath === DEFAULT_SWF;
    } else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else if (arg === "--no-revision") updateRevision = false;
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm exec -- tsx src/server/scripts/patch-dungeonblitz-armory-ability-rune-display-name.ts [--verify] [--swf <path>]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify, updateRevision };
}

function multiname(abc: ReturnType<typeof parseAbc>, name: string): number {
  const index = abc.multinameNames.indexOf(name);
  if (index < 0) throw new PatchError(`Multiname ${name} not found`);
  return index;
}

function op(opcode: number, ...operands: number[]): Buffer {
  return Buffer.concat([Buffer.from([opcode]), ...operands.map(writeU30)]);
}

function isGetLocal(inst: Instruction, local: number): boolean {
  return (local <= 3 && inst.opcode === 0xd0 + local) ||
    (inst.opcode === OP.getlocal && inst.operands[0]?.[1] === local);
}

function isSetLocal(inst: Instruction, local: number): boolean {
  return (local <= 3 && inst.opcode === 0xd4 + local) ||
    (inst.opcode === OP.setlocal && inst.operands[0]?.[1] === local);
}

function remapOffset(offset: number, start: number, end: number, delta: number): number {
  if (offset <= start) return offset;
  if (offset >= end) return offset + delta;
  throw new PatchError(`Offset ${offset} lies inside replaced bytecode ${start}..${end}`);
}

function replaceInstructionRange(
  code: Buffer,
  instructions: Instruction[],
  start: number,
  end: number,
  replacement: Buffer,
  label: string,
): Buffer {
  const boundaries = new Set([...instructions.map((inst) => inst.offset), code.length]);
  if (!boundaries.has(start) || !boundaries.has(end) || start >= end) {
    throw new PatchError(`${label}: replacement is not on instruction boundaries`);
  }
  const delta = replacement.length - (end - start);
  const output = Buffer.concat([code.subarray(0, start), replacement, code.subarray(end)]);

  for (const inst of instructions) {
    if (!BRANCH_OPCODES.has(inst.opcode)) continue;
    if (inst.offset >= start && inst.offset < end) {
      throw new PatchError(`${label}: replaced range contains a branch at ${inst.offset}`);
    }
    const oldTarget = inst.offset + inst.size + inst.operands[0][1];
    if (oldTarget > start && oldTarget < end) {
      throw new PatchError(`${label}: branch at ${inst.offset} targets replaced instruction ${oldTarget}`);
    }
    const newInstruction = remapOffset(inst.offset, start, end, delta);
    const newTarget = remapOffset(oldTarget, start, end, delta);
    output.writeIntLE(newTarget - (newInstruction + inst.size), newInstruction + 1, 3);
  }
  return output;
}

function assertBranchesLand(code: Buffer, label: string): void {
  const instructions = disassemble(code, label);
  const boundaries = new Set(instructions.map((inst) => inst.offset));
  const last = instructions[instructions.length - 1];
  if (!last || last.offset + last.size !== code.length) throw new PatchError(`${label}: invalid code length`);
  for (const inst of instructions) {
    if (!BRANCH_OPCODES.has(inst.opcode)) continue;
    const target = inst.offset + inst.size + inst.operands[0][1];
    if (target !== code.length && !boundaries.has(target)) {
      throw new PatchError(`${label}: branch at ${inst.offset} misses instruction boundary ${target}`);
    }
  }
}

interface LoadedMethod {
  body: NonNullable<ReturnType<typeof parseAbc>["methodBodies"] extends Map<number, infer T> ? T : never>;
  code: Buffer;
  instructions: Instruction[];
}

function loadMethod(
  ctx: ReturnType<typeof parseSwf>,
  abc: ReturnType<typeof parseAbc>,
  classIndex: number,
  methodName: string,
): LoadedMethod {
  const methodIndex = methodIdxForTrait(abc.instances[classIndex].traits, abc, methodName);
  if (methodIndex === null) throw new PatchError(`class_150.${methodName} not found`);
  const body = abc.methodBodies.get(methodIndex);
  if (!body || body.exceptionCount !== 0) throw new PatchError(`class_150.${methodName} has an unexpected body`);
  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  const instructions = disassemble(code, `class_150.${methodName}`);
  assertBranchesLand(code, `class_150.${methodName}`);
  return { body, code, instructions };
}

function analyze(swfPath: string): { ctx: ReturnType<typeof parseSwf>; patches: BytePatch[] } {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "class_150");
  if (classIndex === null) throw new PatchError("class_150 not found");
  const names = {
    class14: multiname(abc, "class_14"),
    powerTypes: multiname(abc, "powerTypesDict"),
    powerRune: multiname(abc, "var_1062"),
    basePowerName: multiname(abc, "basePowerName"),
    displayName: multiname(abc, "displayName"),
    filter: multiname(abc, "var_1503"),
    powers: multiname(abc, "var_27"),
    push: multiname(abc, "push"),
  };

  const build = loadMethod(ctx, abc, classIndex, "method_798");
  const buildAnchors: number[] = [];
  for (let index = 0; index + 7 < build.instructions.length; index += 1) {
    const window = build.instructions.slice(index, index + 8);
    if (
      isGetLocal(window[0], 0) &&
      window[1].opcode === OP.getproperty && window[1].operands[0]?.[1] === names.filter &&
      isGetLocal(window[2], 0) &&
      window[3].opcode === OP.getproperty && window[3].operands[0]?.[1] === names.powers &&
      isGetLocal(window[4], 1) &&
      window[5].opcode === OP.getproperty &&
      window[6].opcode === OP.getproperty &&
      (window[6].operands[0]?.[1] === names.basePowerName || window[6].operands[0]?.[1] === names.displayName) &&
      window[7].opcode === OP.callpropvoid && window[7].operands[0]?.[1] === names.push && window[7].operands[1]?.[1] === 1
    ) buildAnchors.push(index);
  }
  if (buildAnchors.length !== 1) throw new PatchError(`Expected one ability-filter builder anchor, found ${buildAnchors.length}`);
  const buildAnchor = build.instructions.slice(buildAnchors[0], buildAnchors[0] + 8);
  const runtimeKey = buildAnchor[5].operands[0][1];
  const builderUsesDisplayName = buildAnchor[6].operands[0][1] === names.displayName;

  const filter = loadMethod(ctx, abc, classIndex, "method_997");
  const resolvedDisplayName = filter.instructions.some((inst, index) =>
    inst.opcode === OP.getlex && inst.operands[0]?.[1] === names.class14 &&
    filter.instructions[index + 1]?.opcode === OP.getproperty && filter.instructions[index + 1].operands[0]?.[1] === names.powerTypes &&
    isGetLocal(filter.instructions[index + 2], 11) &&
    filter.instructions[index + 3]?.opcode === OP.getproperty && filter.instructions[index + 3].operands[0]?.[1] === names.powerRune &&
    filter.instructions[index + 4]?.opcode === OP.getproperty && filter.instructions[index + 4].operands[0]?.[1] === runtimeKey &&
    filter.instructions[index + 5]?.opcode === OP.getproperty && filter.instructions[index + 5].operands[0]?.[1] === names.displayName
  );
  if (builderUsesDisplayName !== resolvedDisplayName) {
    throw new PatchError("Armory ability-rune display-name patch is only partially present");
  }
  if (builderUsesDisplayName) return { ctx, patches: [] };

  const filterAnchors: number[] = [];
  for (let index = 0; index + 3 < filter.instructions.length; index += 1) {
    if (
      isGetLocal(filter.instructions[index], 11) &&
      filter.instructions[index + 1].opcode === OP.getproperty && filter.instructions[index + 1].operands[0]?.[1] === names.powerRune &&
      filter.instructions[index + 2].opcode === OP.coerceS &&
      isSetLocal(filter.instructions[index + 3], 23)
    ) filterAnchors.push(index);
  }
  if (filterAnchors.length !== 1) throw new PatchError(`Expected one gear PowerRune filter anchor, found ${filterAnchors.length}`);

  const anchorIndex = filterAnchors[0];
  const start = filter.instructions[anchorIndex].offset;
  const end = filter.instructions[anchorIndex + 2].offset; // Keep coerce_s; an existing branch targets it.
  const replacement = Buffer.concat([
    op(OP.getlex, names.class14),
    op(OP.getproperty, names.powerTypes),
    op(OP.getlocal, 11),
    op(OP.getproperty, names.powerRune),
    op(OP.getproperty, runtimeKey),
    op(OP.getproperty, names.displayName),
  ]);
  const patchedFilter = replaceInstructionRange(filter.code, filter.instructions, start, end, replacement, "class_150.method_997");
  assertBranchesLand(patchedFilter, "class_150.method_997 patched");

  const builderInstruction = buildAnchor[6];
  const builderReplacement = op(OP.getproperty, names.displayName);
  if (builderReplacement.length !== builderInstruction.size) {
    throw new PatchError(`method_798 displayName replacement changes instruction size ${builderInstruction.size} -> ${builderReplacement.length}`);
  }

  return {
    ctx,
    patches: [
      {
        key: "armory_ability_filter_key",
        start: build.body.codeStart + builderInstruction.offset,
        end: build.body.codeStart + builderInstruction.offset + builderInstruction.size,
        data: builderReplacement,
        detail: "Build Ability Rune selections from the stock PowerType display name",
      },
      {
        key: "armory_ability_filter_length",
        start: filter.body.codeLenPos,
        end: filter.body.codeStart,
        data: writeU30(patchedFilter.length),
        detail: `Adjust class_150.method_997 code length ${filter.body.codeLen} -> ${patchedFilter.length}`,
      },
      {
        key: "armory_ability_filter_code",
        start: filter.body.codeStart,
        end: filter.body.codeStart + filter.body.codeLen,
        data: patchedFilter,
        detail: "Resolve a gear PowerRune through its PowerType display name before filtering",
      },
    ],
  };
}

function syncClientRevision(swfPath: string, verify: boolean): void {
  if (path.resolve(swfPath) !== DEFAULT_SWF) return;
  const revision = `clientrev=swf-${crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12)}`;
  const html = fs.readFileSync(DEFAULT_INDEX, "utf8");
  if (html.includes(revision)) return;
  if (verify) throw new PatchError(`index.html does not use ${revision}`);
  const updated = html.replace(/clientrev=swf-[0-9a-f]{12}/g, revision);
  if (updated === html) throw new PatchError("Could not update DungeonBlitz client revision");
  fs.writeFileSync(DEFAULT_INDEX, updated, "utf8");
}

function main(): number {
  const { swfPath, verify, updateRevision } = parseArgs(process.argv);
  try {
    const { ctx, patches } = analyze(swfPath);
    console.log(`SWF: ${swfPath}`);
    if (patches.length === 0) {
      if (updateRevision) syncClientRevision(swfPath, verify);
      console.log("No changes needed.");
      return 0;
    }
    for (const patch of patches) console.log(`Patch: ${patch.detail}`);
    if (verify) return 1;
    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, body, delta);
    if (updateRevision) syncClientRevision(swfPath, false);
    console.log("Patch apply complete.");
    return 0;
  } catch (error) {
    console.error(`Patch error: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

process.exit(main());
