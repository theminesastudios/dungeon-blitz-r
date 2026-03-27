import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  ensureBackup,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  u30OperandName,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const ENTITY_CLASS_NAME = "Entity";
const ENTITY_METHOD_NAME = "method_156";

type Op = { kind: "op"; opcode: number; operands?: number[] };
type Label = { kind: "label"; name: string };
type Branch = { kind: "branch"; opcode: number; target: string };
type AsmEntry = Op | Label | Branch;

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

function resolveSwfPath(args: string[]): string {
  const idx = args.indexOf("--swf-path");
  if (idx !== -1 && idx + 1 < args.length) {
    return path.resolve(args[idx + 1]);
  }
  return path.resolve("src/client/content/localhost/p/cbp/DungeonBlitz.localhost.swf");
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function findRequiredMultiname(
  instructions: ReturnType<typeof disassemble>,
  abc: ReturnType<typeof parseAbc>,
  name: string,
  predicate?: (inst: ReturnType<typeof disassemble>[number], index: number) => boolean,
): number {
  for (let i = 0; i < instructions.length; i += 1) {
    const inst = instructions[i];
    const operandName = u30OperandName(inst, abc.multinameNames);
    if (operandName !== name) {
      continue;
    }
    if (predicate && !predicate(inst, i)) {
      continue;
    }
    if (inst.operands.length === 0 || inst.operands[0][0] !== "u30") {
      break;
    }
    return inst.operands[0][1];
  }
  throw new PatchError(`Required multiname ${name} not found in ${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME}`);
}

function findUniqueMultiname(abc: ReturnType<typeof parseAbc>, name: string): number {
  const matches: number[] = [];
  for (let i = 0; i < abc.multinameNames.length; i += 1) {
    if (abc.multinameNames[i] === name) {
      matches.push(i);
    }
  }
  if (matches.length !== 1) {
    throw new PatchError(`Expected unique multiname ${name}, found ${matches.length}`);
  }
  return matches[0];
}

function assemble(entries: AsmEntry[]): Buffer {
  const chunks: Buffer[] = [];
  const labels = new Map<string, number>();
  const fixups: Array<{ pos: number; target: string }> = [];
  let offset = 0;

  for (const entry of entries) {
    if (entry.kind === "label") {
      labels.set(entry.name, offset);
      continue;
    }

    if (entry.kind === "branch") {
      chunks.push(Buffer.from([entry.opcode]));
      chunks.push(Buffer.alloc(3));
      fixups.push({ pos: offset + 1, target: entry.target });
      offset += 4;
      continue;
    }

    const bytes: Buffer[] = [Buffer.from([entry.opcode])];
    for (const operand of entry.operands ?? []) {
      bytes.push(writeU30(operand));
    }
    const chunk = Buffer.concat(bytes);
    chunks.push(chunk);
    offset += chunk.length;
  }

  const code = Buffer.concat(chunks);
  for (const fixup of fixups) {
    const labelOffset = labels.get(fixup.target);
    if (labelOffset === undefined) {
      throw new PatchError(`Unknown label ${fixup.target}`);
    }
    const branchOffset = labelOffset - (fixup.pos + 3);
    writeS24(branchOffset).copy(code, fixup.pos);
  }
  return code;
}

function buildReplacementCode(
  multinames: {
    behaviorType: number;
    behaviorUntargetable: number;
    combatState: number;
    combatStateUntargetable: number;
    entState: number;
    deadUntargetableState: number;
    entityUntargetable: number;
    inActiveCutScene: number;
    behaviorAllowsStateTargeting: number;
  },
): Buffer {
  return assemble([
    { kind: "op", opcode: 0xd0 },
    { kind: "op", opcode: 0x30 },

    { kind: "op", opcode: 0xd0 },
    { kind: "op", opcode: 0x66, operands: [multinames.entityUntargetable] },
    { kind: "branch", opcode: 0x12, target: "afterEntityUntargetable" },
    { kind: "op", opcode: 0x27 },
    { kind: "op", opcode: 0x48 },
    { kind: "label", name: "afterEntityUntargetable" },

    { kind: "op", opcode: 0xd0 },
    { kind: "op", opcode: 0x46, operands: [multinames.inActiveCutScene, 0] },
    { kind: "branch", opcode: 0x12, target: "afterCutscene" },
    { kind: "op", opcode: 0x27 },
    { kind: "op", opcode: 0x48 },
    { kind: "label", name: "afterCutscene" },

    { kind: "op", opcode: 0xd0 },
    { kind: "op", opcode: 0x66, operands: [multinames.combatState] },
    { kind: "op", opcode: 0xd5 },
    { kind: "op", opcode: 0xd1 },
    { kind: "branch", opcode: 0x12, target: "afterCombatState" },
    { kind: "op", opcode: 0xd1 },
    { kind: "op", opcode: 0x66, operands: [multinames.combatStateUntargetable] },
    { kind: "branch", opcode: 0x12, target: "afterCombatState" },
    { kind: "op", opcode: 0x27 },
    { kind: "op", opcode: 0x48 },
    { kind: "label", name: "afterCombatState" },

    { kind: "op", opcode: 0xd0 },
    { kind: "op", opcode: 0x66, operands: [multinames.behaviorType] },
    { kind: "op", opcode: 0x66, operands: [multinames.behaviorUntargetable] },
    { kind: "branch", opcode: 0x12, target: "afterBehaviorUntargetable" },
    { kind: "op", opcode: 0x27 },
    { kind: "op", opcode: 0x48 },
    { kind: "label", name: "afterBehaviorUntargetable" },

    { kind: "op", opcode: 0xd0 },
    { kind: "op", opcode: 0x66, operands: [multinames.entState] },
    { kind: "op", opcode: 0x60, operands: [multinames.deadUntargetableState] },
    { kind: "op", opcode: 0xab },
    { kind: "branch", opcode: 0x12, target: "targetable" },
    { kind: "op", opcode: 0xd0 },
    { kind: "op", opcode: 0x66, operands: [multinames.behaviorType] },
    { kind: "op", opcode: 0x66, operands: [multinames.behaviorAllowsStateTargeting] },
    { kind: "branch", opcode: 0x11, target: "targetable" },
    { kind: "op", opcode: 0x27 },
    { kind: "op", opcode: 0x48 },

    { kind: "label", name: "targetable" },
    { kind: "op", opcode: 0x26 },
    { kind: "op", opcode: 0x48 },
  ]);
}

function analyzePatch(swfPath: string): {
  ctx: ReturnType<typeof parseSwf>;
  patches: BytePatch[];
} {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const entityClassIndex = classIndexByName(abc, ENTITY_CLASS_NAME);
  if (entityClassIndex === null) {
    throw new PatchError(`${ENTITY_CLASS_NAME} class not found`);
  }

  const methodIdx = methodIdxForTrait(abc.instances[entityClassIndex].traits, abc, ENTITY_METHOD_NAME);
  if (methodIdx === null) {
    throw new PatchError(`${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME} not found`);
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME} body not found`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instructions = disassemble(code, `${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME}`);

  const multinames = {
    behaviorType: findRequiredMultiname(instructions, abc, "behaviorType"),
    behaviorUntargetable: findRequiredMultiname(
      instructions,
      abc,
      "bUntargetable",
      (_inst, index) => u30OperandName(instructions[index - 1] ?? { operands: [] } as never, abc.multinameNames) === "behaviorType",
    ),
    combatState: findRequiredMultiname(instructions, abc, "combatState"),
    combatStateUntargetable: findRequiredMultiname(instructions, abc, "var_1421"),
    entState: findRequiredMultiname(instructions, abc, "entState"),
    deadUntargetableState: findRequiredMultiname(instructions, abc, "const_467"),
    entityUntargetable: findRequiredMultiname(
      instructions,
      abc,
      "bUntargetable",
      (_inst, index) => (instructions[index - 1]?.opcode ?? -1) === 0xd0,
    ),
    inActiveCutScene: findUniqueMultiname(abc, "InActiveCutScene"),
    behaviorAllowsStateTargeting: findRequiredMultiname(instructions, abc, "var_1124"),
  };

  const replacementCode = buildReplacementCode(multinames);
  if (code.equals(replacementCode)) {
    return { ctx, patches: [] };
  }

  return {
    ctx,
    patches: [
      {
        key: "entity_method_156_cutscene_untargetable_len",
        start: methodBody.codeLenPos,
        end: methodBody.codeLenPos + writeU30(methodBody.codeLen).length,
        data: writeU30(replacementCode.length),
        detail: `Adjust ${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME} code length for active-cutscene untargetable guard`,
      },
      {
        key: "entity_method_156_cutscene_untargetable_body",
        start: methodBody.codeStart,
        end: methodBody.codeStart + methodBody.codeLen,
        data: replacementCode,
        detail: `Force ${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME} to reject active-cutscene entities as untargetable`,
      },
    ],
  };
}

function main(): number {
  const args = process.argv.slice(2);
  const swfPath = resolveSwfPath(args);
  const verifyOnly = hasFlag(args, "--verify") || hasFlag(args, "--dry-run");

  try {
    const { ctx, patches } = analyzePatch(swfPath);
    console.log(`SWF: ${swfPath}`);
    if (patches.length === 0) {
      console.log("No changes needed.");
      return 0;
    }

    for (const patch of patches) {
      console.log(`Patch: ${patch.detail}`);
    }

    if (verifyOnly) {
      return 0;
    }

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
