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
const ROOM_CLASS_NAME = "Room";
const ROOM_METHOD_NAME = "method_79";

const MULTINAME_VAR_1 = 1;
const MULTINAME_LEVEL = 84;
const MULTINAME_INTERNAL_NAME = 323;
const MULTINAME_VAR_48 = 397;
const MULTINAME_CURR_ROOM = 225;
const MULTINAME_METHOD_79 = 1120;
const MULTINAME_VAR_1944 = 4657;
const MULTINAME_VAR_1714 = 4038;
const MULTINAME_VAR_409 = 1304;
const MULTINAME_MROOMTICK = 2732;
const MULTINAME_DYNAMIC_SETPROPERTY = 221;

const STRING_TUTORIAL_DUNGEON = "TutorialDungeon";
const STRING_AM_PREFIX = "am_";
const STRING_TRIGGER = "Trigger";
const STRING_UNDERSCORE = "_";
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
    patchKeyPrefix: "dungeonblitz_jump",
  },
  {
    methodName: "Drop",
    triggerSuffix: STRING_THREE,
    patchKeyPrefix: "dungeonblitz_drop",
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

function buildInjectedTail(abc: ReturnType<typeof parseAbc>, triggerSuffix: string): Buffer {
  const amPrefixIndex = abc.stringValues.indexOf(STRING_AM_PREFIX);
  const triggerIndex = abc.stringValues.indexOf(STRING_TRIGGER);
  const underscoreIndex = abc.stringValues.indexOf(STRING_UNDERSCORE);
  const suffixIndex = abc.stringValues.indexOf(triggerSuffix);
  if (amPrefixIndex <= 0 || triggerIndex <= 0 || underscoreIndex <= 0 || suffixIndex <= 0) {
    throw new PatchError(
      `Required strings not found (${STRING_AM_PREFIX}, ${STRING_TRIGGER}, ${STRING_UNDERSCORE}, ${triggerSuffix})`,
    );
  }

  return Buffer.concat([
    Buffer.from([0xd0]),
    Buffer.from([0x66]), writeU30(MULTINAME_VAR_48),
    Buffer.from([0x66]), writeU30(MULTINAME_CURR_ROOM),
    Buffer.from([0x2c]), writeU30(amPrefixIndex),
    Buffer.from([0x2c]), writeU30(triggerIndex),
    Buffer.from([0xa0]),
    Buffer.from([0x2c]), writeU30(underscoreIndex),
    Buffer.from([0xa0]),
    Buffer.from([0x2c]), writeU30(suffixIndex),
    Buffer.from([0xa0]),
    Buffer.from([0x4f]), writeU30(MULTINAME_METHOD_79), writeU30(1),
    Buffer.from([0x47, 0x47]),
  ]);
}

function buildEntityInjectedTail(abc: ReturnType<typeof parseAbc>): Buffer {
  const amPrefixIndex = abc.stringValues.indexOf(STRING_AM_PREFIX);
  const triggerIndex = abc.stringValues.indexOf(STRING_TRIGGER);
  const underscoreIndex = abc.stringValues.indexOf(STRING_UNDERSCORE);
  const twoIndex = abc.stringValues.indexOf(STRING_TWO);
  const threeIndex = abc.stringValues.indexOf(STRING_THREE);
  if (
    amPrefixIndex <= 0 ||
    triggerIndex <= 0 ||
    underscoreIndex <= 0 ||
    twoIndex <= 0 ||
    threeIndex <= 0
  ) {
    throw new PatchError(
      `Required strings not found (${STRING_AM_PREFIX}, ${STRING_TRIGGER}, ${STRING_UNDERSCORE}, ${STRING_TWO}, ${STRING_THREE})`,
    );
  }

  const trigger2Call = Buffer.concat([
    Buffer.from([0xd0]),
    Buffer.from([0x66]), writeU30(MULTINAME_CURR_ROOM),
    Buffer.from([0x2c]), writeU30(amPrefixIndex),
    Buffer.from([0x2c]), writeU30(triggerIndex),
    Buffer.from([0xa0]),
    Buffer.from([0x2c]), writeU30(underscoreIndex),
    Buffer.from([0xa0]),
    Buffer.from([0x2c]), writeU30(twoIndex),
    Buffer.from([0xa0]),
    Buffer.from([0x4f]), writeU30(MULTINAME_METHOD_79), writeU30(1),
  ]);

  const trigger3Call = Buffer.concat([
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
    Buffer.from([0x12]), writeS24(trigger2Call.length),
    trigger2Call,
  ]);

  const dropBranch = Buffer.concat([
    Buffer.from([0xd0]),
    Buffer.from([0x66]), writeU30(MULTINAME_VAR_1714),
    Buffer.from([0x12]), writeS24(trigger3Call.length),
    trigger3Call,
  ]);

  const body = Buffer.concat([jumpBranch, dropBranch]);

  return Buffer.concat([
    body,
    Buffer.from([0x47, 0x47]),
  ]);
}

function buildRoomMethod79Code(abc: ReturnType<typeof parseAbc>): Buffer {
  const tutorialDungeonIndex = abc.stringValues.indexOf(STRING_TUTORIAL_DUNGEON);
  if (tutorialDungeonIndex <= 0) {
    throw new PatchError(`Required string not found (${STRING_TUTORIAL_DUNGEON})`);
  }

  const elseBody = Buffer.concat([
    Buffer.from([0xd0]),
    Buffer.from([0x66]), writeU30(MULTINAME_MROOMTICK),
  ]);

  const tutorialBody = Buffer.concat([
    Buffer.from([0xd0]),
    Buffer.from([0x66]), writeU30(MULTINAME_MROOMTICK),
    Buffer.from([0x24, 0x01]),
    Buffer.from([0xa0]),
    Buffer.from([0x10]), writeS24(elseBody.length),
  ]);

  return Buffer.concat([
    Buffer.from([0x27]),
    Buffer.from([0x26]),
    Buffer.from([0xd0]),
    Buffer.from([0x66]), writeU30(MULTINAME_VAR_409),
    Buffer.from([0xd1]),
    Buffer.from([0xd0]),
    Buffer.from([0x66]), writeU30(MULTINAME_VAR_1),
    Buffer.from([0x66]), writeU30(MULTINAME_LEVEL),
    Buffer.from([0x66]), writeU30(MULTINAME_INTERNAL_NAME),
    Buffer.from([0x2c]), writeU30(tutorialDungeonIndex),
    Buffer.from([0x14]), writeS24(tutorialBody.length),
    tutorialBody,
    elseBody,
    Buffer.from([0x61]), writeU30(MULTINAME_DYNAMIC_SETPROPERTY),
    Buffer.from([0x47, 0x47]),
  ]);
}

function analyzePatch(swfPath: string): {
  ctx: ReturnType<typeof parseSwf>;
  patches: BytePatch[];
  alreadyPatched: boolean;
} {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);

  const classIndex = classIndexByName(abc, CLASS_NAME);
  if (classIndex === null) {
    throw new PatchError(`${CLASS_NAME} class not found`);
  }

  const patches: BytePatch[] = [];
  let alreadyPatched = true;

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

    const injectedTail = buildInjectedTail(abc, target.triggerSuffix);
    const existingTail = code.subarray(Math.max(0, code.length - injectedTail.length));
    if (existingTail.equals(injectedTail)) {
      continue;
    }

    alreadyPatched = false;

    const originalTail = Buffer.from([0x47, 0x47]);
    if (!code.subarray(code.length - originalTail.length).equals(originalTail)) {
      throw new PatchError(`${CLASS_NAME}.${target.methodName} no longer ends with returnvoid returnvoid`);
    }

    const newCode = Buffer.concat([code.subarray(0, code.length - originalTail.length), injectedTail]);
    const newCodeLen = writeU30(newCode.length);
    const oldCodeLen = writeU30(methodBody.codeLen);
    if (newCodeLen.length !== oldCodeLen.length) {
      throw new PatchError(
        `Unsupported code_length width change for ${CLASS_NAME}.${target.methodName} ${oldCodeLen.length} -> ${newCodeLen.length}`,
      );
    }

    patches.push(
      {
        key: `${target.patchKeyPrefix}_code_length`,
        start: methodBody.codeLenPos,
        end: methodBody.codeLenPos + oldCodeLen.length,
        data: newCodeLen,
        detail: `Expand ${CLASS_NAME}.${target.methodName} code length for TutorialDungeon trigger hook`,
      },
      {
        key: `${target.patchKeyPrefix}_tutorial_signal`,
        start: methodBody.codeStart,
        end: methodBody.codeStart + methodBody.codeLen,
        data: newCode,
        detail: `Signal TutorialDungeon ${target.triggerSuffix === STRING_TWO ? "jump" : "drop"} tutorial progress from ${CLASS_NAME}.${target.methodName}`,
      },
    );
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

  const entityInjectedTail = buildEntityInjectedTail(abc);
  const entityExistingTail = entityCode.subarray(Math.max(0, entityCode.length - entityInjectedTail.length));
  if (!entityExistingTail.equals(entityInjectedTail)) {
    alreadyPatched = false;

    const originalTail = Buffer.from([0x47, 0x47]);
    if (!entityCode.subarray(entityCode.length - originalTail.length).equals(originalTail)) {
      throw new PatchError(`${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME} no longer ends with returnvoid returnvoid`);
    }

    const newEntityCode = Buffer.concat([
      entityCode.subarray(0, entityCode.length - originalTail.length),
      entityInjectedTail,
    ]);
    const newEntityCodeLen = writeU30(newEntityCode.length);
    const oldEntityCodeLen = writeU30(entityMethodBody.codeLen);
    if (newEntityCodeLen.length !== oldEntityCodeLen.length) {
      throw new PatchError(
        `Unsupported code_length width change for ${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME} ${oldEntityCodeLen.length} -> ${newEntityCodeLen.length}`,
      );
    }

    patches.push(
      {
        key: "entity_method_1075_code_length",
        start: entityMethodBody.codeLenPos,
        end: entityMethodBody.codeLenPos + oldEntityCodeLen.length,
        data: newEntityCodeLen,
        detail: `Expand ${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME} code length for TutorialDungeon trigger hook`,
      },
      {
        key: "entity_method_1075_tutorial_signal",
        start: entityMethodBody.codeStart,
        end: entityMethodBody.codeStart + entityMethodBody.codeLen,
        data: newEntityCode,
        detail: `Signal TutorialDungeon jump/drop tutorial progress from ${ENTITY_CLASS_NAME}.${ENTITY_METHOD_NAME}`,
      },
    );
  }

  const roomClassIndex = classIndexByName(abc, ROOM_CLASS_NAME);
  if (roomClassIndex === null) {
    throw new PatchError(`${ROOM_CLASS_NAME} class not found`);
  }

  const roomMethodIdx = methodIdxForTrait(abc.instances[roomClassIndex].traits, abc, ROOM_METHOD_NAME);
  if (roomMethodIdx === null) {
    throw new PatchError(`${ROOM_CLASS_NAME}.${ROOM_METHOD_NAME} not found`);
  }

  const roomMethodBody = abc.methodBodies.get(roomMethodIdx);
  if (!roomMethodBody) {
    throw new PatchError(`${ROOM_CLASS_NAME}.${ROOM_METHOD_NAME} body not found`);
  }

  const roomCode = ctx.body.subarray(roomMethodBody.codeStart, roomMethodBody.codeStart + roomMethodBody.codeLen);
  disassemble(roomCode, `${ROOM_CLASS_NAME}.${ROOM_METHOD_NAME}`);

  const roomInjectedCode = buildRoomMethod79Code(abc);
  if (!roomCode.equals(roomInjectedCode)) {
    alreadyPatched = false;

    const newRoomCodeLen = writeU30(roomInjectedCode.length);
    const oldRoomCodeLen = writeU30(roomMethodBody.codeLen);
    if (newRoomCodeLen.length !== oldRoomCodeLen.length) {
      throw new PatchError(
        `Unsupported code_length width change for ${ROOM_CLASS_NAME}.${ROOM_METHOD_NAME} ${oldRoomCodeLen.length} -> ${newRoomCodeLen.length}`,
      );
    }

    patches.push(
      {
        key: "room_method_79_code_length",
        start: roomMethodBody.codeLenPos,
        end: roomMethodBody.codeLenPos + oldRoomCodeLen.length,
        data: newRoomCodeLen,
        detail: `Expand ${ROOM_CLASS_NAME}.${ROOM_METHOD_NAME} code length for TutorialDungeon trigger timing fix`,
      },
      {
        key: "room_method_79_tutorial_timing",
        start: roomMethodBody.codeStart,
        end: roomMethodBody.codeStart + roomMethodBody.codeLen,
        data: roomInjectedCode,
        detail: `Delay TutorialDungeon local trigger ticks by one frame in ${ROOM_CLASS_NAME}.${ROOM_METHOD_NAME}`,
      },
    );
  }

  return { ctx, patches, alreadyPatched };
}

function main(): number {
  const args = process.argv.slice(2);
  const swfPath = resolveSwfPath(args);
  const verifyOnly = hasFlag(args, "--verify") || hasFlag(args, "--dry-run");

  try {
    const { ctx, patches, alreadyPatched } = analyzePatch(swfPath);
    console.log(`SWF: ${swfPath}`);
    if (alreadyPatched || patches.length === 0) {
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
