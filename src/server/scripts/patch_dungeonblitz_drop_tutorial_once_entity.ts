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
const ENTITY_METHOD_NAME = "method_1075";

const MULTINAME_CURR_ROOM = 225;
const MULTINAME_METHOD_79 = 1120;
const MULTINAME_VAR_1944 = 4657;
const MULTINAME_VAR_1714 = 4038;
const MULTINAME_VAR_1715 = 4040;
const MULTINAME_VAR_2788 = 7338;

const STRING_AM_PREFIX = "am_";
const STRING_TRIGGER = "Trigger";
const STRING_UNDERSCORE = "_";
const STRING_FALL = "Fall";
const STRING_TWO = "2";
const STRING_THREE = "3";

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
  return path.resolve("src/client/content/localhost/p/cbp/DungeonBlitz.swf");
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function buildTriggerCall(abc: ReturnType<typeof parseAbc>, suffix: string): Buffer {
  const amPrefixIndex = abc.stringValues.indexOf(STRING_AM_PREFIX);
  const triggerIndex = abc.stringValues.indexOf(STRING_TRIGGER);
  const underscoreIndex = abc.stringValues.indexOf(STRING_UNDERSCORE);
  const fallIndex = abc.stringValues.indexOf(STRING_FALL);
  const suffixIndex = abc.stringValues.indexOf(suffix);

  if (amPrefixIndex <= 0 || triggerIndex <= 0 || underscoreIndex <= 0 || fallIndex <= 0 || suffixIndex <= 0) {
    throw new PatchError(
      `Required strings not found (${STRING_AM_PREFIX}, ${STRING_TRIGGER}, ${STRING_UNDERSCORE}, ${STRING_FALL}, ${suffix})`,
    );
  }

  return Buffer.concat([
    Buffer.from([0xd0]),
    Buffer.from([0x66]), writeU30(MULTINAME_CURR_ROOM),
    Buffer.from([0x2c]), writeU30(amPrefixIndex),
    Buffer.from([0x2c]), writeU30(triggerIndex),
    Buffer.from([0xa0]),
    Buffer.from([0x2c]), writeU30(underscoreIndex),
    Buffer.from([0xa0]),
    Buffer.from([0x2c]), writeU30(fallIndex),
    Buffer.from([0xa0]),
    Buffer.from([0x2c]), writeU30(suffixIndex),
    Buffer.from([0xa0]),
    Buffer.from([0x4f]), writeU30(MULTINAME_METHOD_79), writeU30(1),
  ]);
}

function buildEntityTail(abc: ReturnType<typeof parseAbc>): Buffer {
  const jumpCall = buildTriggerCall(abc, STRING_TWO);
  const dropFallCall = buildTriggerCall(abc, STRING_THREE);
  const amPrefixIndex = abc.stringValues.indexOf(STRING_AM_PREFIX);
  const triggerIndex = abc.stringValues.indexOf(STRING_TRIGGER);
  const underscoreIndex = abc.stringValues.indexOf(STRING_UNDERSCORE);
  const threeIndex = abc.stringValues.indexOf(STRING_THREE);
  if (amPrefixIndex <= 0 || triggerIndex <= 0 || underscoreIndex <= 0 || threeIndex <= 0) {
    throw new PatchError(
      `Required strings not found (${STRING_AM_PREFIX}, ${STRING_TRIGGER}, ${STRING_UNDERSCORE}, ${STRING_THREE})`,
    );
  }
  const dropCompleteCall = Buffer.concat([
    Buffer.from([0xd0]),
    Buffer.from([0x66]), writeU30(MULTINAME_CURR_ROOM),
    Buffer.from([0x2c]), writeU30(amPrefixIndex),
    Buffer.from([0x2c]), writeU30(triggerIndex),
    Buffer.from([0xa0]),
    Buffer.from([0x2c]), writeU30(underscoreIndex),
    Buffer.from([0xa0]),
    Buffer.from([0x2c]), writeU30(threeIndex),
    Buffer.from([0xa0]),
    Buffer.from([0x4f]), writeU30(MULTINAME_METHOD_79), writeU30(1),
  ]);

  const jumpBranch = Buffer.concat([
    Buffer.from([0xd0]),
    Buffer.from([0x66]), writeU30(MULTINAME_VAR_1944),
    Buffer.from([0x12]), writeS24(jumpCall.length),
    jumpCall,
  ]);

  const dropGuardedCall = Buffer.concat([
    Buffer.from([0xd0]),
    Buffer.from([0x66]), writeU30(MULTINAME_VAR_2788),
    Buffer.from([0x11]), writeS24(dropFallCall.length + dropCompleteCall.length + 8),
    Buffer.from([0xd0]),
    Buffer.from([0x66]), writeU30(MULTINAME_VAR_1715),
    Buffer.from([0x11]), writeS24(dropFallCall.length + dropCompleteCall.length + 5),
    dropFallCall,
    dropCompleteCall,
    Buffer.from([0xd0, 0x26, 0x68]), writeU30(MULTINAME_VAR_1715),
  ]);

  const dropBranch = Buffer.concat([
    Buffer.from([0xd0]),
    Buffer.from([0x66]), writeU30(MULTINAME_VAR_1714),
    Buffer.from([0x12]), writeS24(dropGuardedCall.length),
    dropGuardedCall,
  ]);

  return Buffer.concat([jumpBranch, dropBranch, Buffer.from([0x47, 0x47])]);
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
  const instrs = disassemble(code, `${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME}`);

  let tailStart = -1;
  for (let i = instrs.length - 1; i >= 1; i -= 1) {
    const prev = instrs[i - 1];
    const inst = instrs[i];
    if (prev.opcode === 0xd0 && inst.opcode === 0x66 && u30OperandName(inst, abc.multinameNames) === "var_1944") {
      tailStart = prev.offset;
      break;
    }
  }

  if (tailStart < 0) {
    throw new PatchError(`Could not find tutorial signal tail in ${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME}`);
  }

  let dropLatchSetStart = -1;
  let dropLatchSetEnd = -1;
  for (let i = 0; i + 2 < instrs.length; i += 1) {
    const first = instrs[i];
    const second = instrs[i + 1];
    const third = instrs[i + 2];
    if (first.offset >= tailStart) {
      break;
    }
    if (first.opcode !== 0xd0 || second.opcode !== 0x26 || third.opcode !== 0x68) {
      continue;
    }
    if (u30OperandName(third, abc.multinameNames) !== "var_1715") {
      continue;
    }
    dropLatchSetStart = first.offset;
    dropLatchSetEnd = third.offset + third.size;
    break;
  }

  if (dropLatchSetStart < 0 || dropLatchSetEnd <= dropLatchSetStart) {
    const setterAlreadyRemoved =
      code.subarray(Math.max(0, tailStart - 20), tailStart).includes(0x02);
    if (!setterAlreadyRemoved) {
      throw new PatchError(`Could not find drop latch setter in ${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME}`);
    }
  }

  const replacementTail = buildEntityTail(abc);
  const replacementCode = Buffer.concat([
    code.subarray(0, dropLatchSetStart >= 0 ? dropLatchSetStart : tailStart),
    dropLatchSetStart >= 0 ? Buffer.alloc(dropLatchSetEnd - dropLatchSetStart, 0x02) : Buffer.alloc(0),
    code.subarray(dropLatchSetEnd >= 0 ? dropLatchSetEnd : tailStart, tailStart),
    replacementTail,
  ]);
  if (code.equals(replacementCode)) {
    return { ctx, patches: [] };
  }

  const replacementLen = writeU30(replacementCode.length);
  const currentLen = writeU30(methodBody.codeLen);
  if (replacementLen.length !== currentLen.length) {
    throw new PatchError(
      `Unsupported ${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME} code length width change ${currentLen.length} -> ${replacementLen.length}`,
    );
  }

  return {
    ctx,
    patches: [
      {
        key: "entity_method_1075_drop_once_len",
        start: methodBody.codeLenPos,
        end: methodBody.codeLenPos + currentLen.length,
        data: replacementLen,
        detail: `Adjust ${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME} code length for one-shot drop tutorial signal`,
      },
      {
        key: "entity_method_1075_drop_once_body",
        start: methodBody.codeStart,
        end: methodBody.codeStart + methodBody.codeLen,
        data: replacementCode,
        detail: `Emit drop tutorial signal only on first drop press while not already dropping`,
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
