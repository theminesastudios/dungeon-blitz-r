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
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const CLASS_NAME = "class_143";
const ENTITY_CLASS_NAME = "Entity";
const ENTITY_METHOD_NAME = "method_1075";

const MULTINAME_VAR_48 = 397;
const MULTINAME_CURR_ROOM = 225;
const MULTINAME_METHOD_79 = 1120;
const MULTINAME_VAR_1944 = 4657;
const MULTINAME_VAR_1714 = 4038;

const STRING_AM_PREFIX = "am_";
const STRING_TRIGGER = "Trigger";
const STRING_UNDERSCORE = "_";
const STRING_FALL = "Fall";
const STRING_TWO = "2";
const STRING_THREE = "3";

type TriggerTarget = {
  methodName: string;
  triggerSuffix: string;
  patchKeyPrefix: string;
};

const TARGETS: TriggerTarget[] = [
  {
    methodName: "Jump",
    triggerSuffix: STRING_TWO,
    patchKeyPrefix: "dungeonblitz_jump_fall",
  },
  {
    methodName: "Drop",
    triggerSuffix: STRING_THREE,
    patchKeyPrefix: "dungeonblitz_drop_fall",
  },
];

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

function buildTriggerCall(abc: ReturnType<typeof parseAbc>, suffix: string, includeVar48: boolean): Buffer {
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
    ...(includeVar48 ? [Buffer.from([0x66]), writeU30(MULTINAME_VAR_48)] : []),
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

function buildMethodTail(abc: ReturnType<typeof parseAbc>, suffix: string): Buffer {
  return Buffer.concat([buildTriggerCall(abc, suffix, true), Buffer.from([0x47, 0x47])]);
}

function buildEntityTail(abc: ReturnType<typeof parseAbc>): Buffer {
  const trigger2Call = buildTriggerCall(abc, STRING_TWO, false);
  const trigger3Call = buildTriggerCall(abc, STRING_THREE, false);

  const jumpBranch = Buffer.concat([
    Buffer.from([0xd0]),
    Buffer.from([0x66]), writeU30(MULTINAME_VAR_1944),
    Buffer.from([0x12]), writeS24(trigger2Call.length),
    trigger2Call,
  ]);

  const dropBranch = Buffer.concat([
    Buffer.from([0xd0]),
    Buffer.from([0x66]), writeU30(MULTINAME_VAR_1714),
    Buffer.from([0x12]), writeS24(trigger3Call.length),
    trigger3Call,
  ]);

  return Buffer.concat([jumpBranch, dropBranch, Buffer.from([0x47, 0x47])]);
}

function analyzePatch(swfPath: string): {
  ctx: ReturnType<typeof parseSwf>;
  patches: BytePatch[];
} {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, CLASS_NAME);
  if (classIndex === null) {
    throw new PatchError(`${CLASS_NAME} class not found`);
  }

  const patches: BytePatch[] = [];

  for (const target of TARGETS) {
    const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, target.methodName);
    if (methodIdx === null) {
      throw new PatchError(`${CLASS_NAME}.${target.methodName} not found`);
    }

    const methodBody = abc.methodBodies.get(methodIdx);
    if (!methodBody) {
      throw new PatchError(`${CLASS_NAME}.${target.methodName} body not found`);
    }

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    disassemble(code, `${CLASS_NAME}.${target.methodName}`);

    const replacementCode = Buffer.concat([
      code.subarray(0, code.length - 2),
      buildMethodTail(abc, target.triggerSuffix),
    ]);

    if (!code.equals(replacementCode)) {
      const replacementLen = writeU30(replacementCode.length);
      const currentLen = writeU30(methodBody.codeLen);
      if (replacementLen.length !== currentLen.length) {
        throw new PatchError(
          `Unsupported code_length width change for ${CLASS_NAME}.${target.methodName} ${currentLen.length} -> ${replacementLen.length}`,
        );
      }

      patches.push(
        {
          key: `${target.patchKeyPrefix}_len`,
          start: methodBody.codeLenPos,
          end: methodBody.codeLenPos + currentLen.length,
          data: replacementLen,
          detail: `Expand ${CLASS_NAME}.${target.methodName} for Fall tutorial signal`,
        },
        {
          key: `${target.patchKeyPrefix}_body`,
          start: methodBody.codeStart,
          end: methodBody.codeStart + methodBody.codeLen,
          data: replacementCode,
          detail: `Retarget ${CLASS_NAME}.${target.methodName} to emit am_Trigger_Fall${target.triggerSuffix}`,
        },
      );
    }
  }

  const entityClassIndex = classIndexByName(abc, ENTITY_CLASS_NAME);
  if (entityClassIndex === null) {
    throw new PatchError(`${ENTITY_CLASS_NAME} class not found`);
  }

  const entityMethodIdx = methodIdxForTrait(abc.instances[entityClassIndex].traits, abc, ENTITY_METHOD_NAME);
  if (entityMethodIdx === null) {
    throw new PatchError(`${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME} not found`);
  }

  const entityMethodBody = abc.methodBodies.get(entityMethodIdx);
  if (!entityMethodBody) {
    throw new PatchError(`${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME} body not found`);
  }

  const entityCode = ctx.body.subarray(entityMethodBody.codeStart, entityMethodBody.codeStart + entityMethodBody.codeLen);
  disassemble(entityCode, `${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME}`);
  const replacementEntityCode = Buffer.concat([
    entityCode.subarray(0, entityCode.length - 2),
    buildEntityTail(abc),
  ]);

  if (!entityCode.equals(replacementEntityCode)) {
    const replacementLen = writeU30(replacementEntityCode.length);
    const currentLen = writeU30(entityMethodBody.codeLen);
    if (replacementLen.length !== currentLen.length) {
      throw new PatchError(
        `Unsupported code_length width change for ${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME} ${currentLen.length} -> ${replacementLen.length}`,
      );
    }

    patches.push(
      {
        key: "entity_method_1075_fall_len",
        start: entityMethodBody.codeLenPos,
        end: entityMethodBody.codeLenPos + currentLen.length,
        data: replacementLen,
        detail: `Expand ${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME} for Fall tutorial signal`,
      },
      {
        key: "entity_method_1075_fall_body",
        start: entityMethodBody.codeStart,
        end: entityMethodBody.codeStart + entityMethodBody.codeLen,
        data: replacementEntityCode,
        detail: `Retarget ${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME} to emit am_Trigger_Fall2/Fall3`,
      },
    );
  }

  return { ctx, patches };
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
