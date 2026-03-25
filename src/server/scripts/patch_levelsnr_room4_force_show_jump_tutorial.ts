import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  defaultLevelsNrPath,
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

const CLASS_NAME = "a_Room_Tutorial_04";
const METHOD_NAME = "WaitingForJump";
const SCRIPT_NAME = "Script_OpeningScene";
const POP_AND_NOP_FILL = Buffer.from([0x29, 0x02, 0x02, 0x02]);
const REQUIRED_TRIGGER = "am_Trigger_2";
const JUMP_TUTORIAL = "am_JumpTut";
const SHOW_TUTORIAL = "ShowTutorial";

function resolveSwfPath(args: string[]): string {
  const idx = args.indexOf("--swf-path");
  if (idx !== -1 && idx + 1 < args.length) {
    return path.resolve(args[idx + 1]);
  }
  return defaultLevelsNrPath();
}

function hasFlag(args: string[], flag: string): boolean {
  return args.includes(flag);
}

function buildShowTutorialCall(tutorialIndex: number, showTutorialIndex: number): Buffer {
  return Buffer.concat([
    Buffer.from([0xd1]),
    Buffer.from([0x2c]),
    writeU30(tutorialIndex),
    Buffer.from([0x4f]),
    writeU30(showTutorialIndex),
    writeU30(1),
  ]);
}

function analyzePatch(swfPath: string): {
  ctx: ReturnType<typeof parseSwf>;
  patches: BytePatch[];
  currentTrigger: string;
} {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, CLASS_NAME);
  if (classIndex === null) {
    throw new PatchError(`${CLASS_NAME} class not found`);
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, METHOD_NAME);
  if (methodIdx === null) {
    throw new PatchError(`${CLASS_NAME}.${METHOD_NAME} not found`);
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`${CLASS_NAME}.${METHOD_NAME} body not found`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instrs = disassemble(code, `${CLASS_NAME}.${METHOD_NAME}`);
  const patches: BytePatch[] = [];
  const showTutorialIndex = abc.multinameNames.indexOf(SHOW_TUTORIAL);
  if (showTutorialIndex <= 0) {
    throw new PatchError(`${SHOW_TUTORIAL} multiname not found`);
  }

  const jumpTutorialIndex = abc.stringValues.indexOf(JUMP_TUTORIAL);
  if (jumpTutorialIndex <= 0) {
    throw new PatchError(`${JUMP_TUTORIAL} string not found`);
  }

  const matches: Array<{ start: number; end: number }> = [];
  for (let i = 1; i < instrs.length; i += 1) {
    const prev = instrs[i - 1];
    const inst = instrs[i];

    if (prev.opcode !== 0x66 || u30OperandName(prev, abc.multinameNames) !== SCRIPT_NAME) {
      continue;
    }
    if (inst.opcode !== 0x46 || u30OperandName(inst, abc.multinameNames) !== "OnScriptFinish") {
      continue;
    }

    matches.push({
      start: methodBody.codeStart + inst.offset + inst.size,
      end: methodBody.codeStart + inst.offset + inst.size + POP_AND_NOP_FILL.length,
    });
  }

  if (matches.length !== 1) {
    throw new PatchError(`Expected exactly one ${SCRIPT_NAME}.OnScriptFinish branch in ${CLASS_NAME}.${METHOD_NAME}, found ${matches.length}`);
  }

  const { start, end } = matches[0];
  const current = ctx.body.subarray(start, end);
  if (!current.equals(POP_AND_NOP_FILL)) {
    patches.push({
      key: "levelsnr_room4_force_show_jump_tutorial",
      start,
      end,
      data: POP_AND_NOP_FILL,
      detail: `Force ${CLASS_NAME}.${METHOD_NAME} to show the jump tutorial without waiting for ${SCRIPT_NAME} to finish`,
    });
  }

  const showTutorialPayload = buildShowTutorialCall(jumpTutorialIndex, showTutorialIndex);
  let insertionPos = -1;
  for (let i = 0; i + 3 < instrs.length; i += 1) {
    const first = instrs[i];
    const second = instrs[i + 1];
    const third = instrs[i + 2];
    const fourth = instrs[i + 3];

    if (first.opcode !== 0x2c || u30OperandName(first, abc.stringValues) !== JUMP_TUTORIAL) {
      continue;
    }
    if (
      second.opcode !== 0x2c ||
      (u30OperandName(second, abc.multinameNames) !== "Show" &&
        u30OperandName(second, abc.stringValues) !== "Show")
    ) {
      continue;
    }
    if (third.opcode !== 0x26) {
      continue;
    }
    if (fourth.opcode !== 0x4f || u30OperandName(fourth, abc.multinameNames) !== "Animate") {
      continue;
    }

    insertionPos = methodBody.codeStart + fourth.offset + fourth.size;
    break;
  }

  if (insertionPos < 0) {
    throw new PatchError(`Could not find initial ${JUMP_TUTORIAL} animation call in ${CLASS_NAME}.${METHOD_NAME}`);
  }

  const legacyShowTutorialPayload = Buffer.concat([
    Buffer.from([0x2c]),
    writeU30(jumpTutorialIndex),
    Buffer.from([0x4f]),
    writeU30(showTutorialIndex),
    writeU30(1),
  ]);
  const existingShowTutorial = ctx.body.subarray(insertionPos, insertionPos + showTutorialPayload.length);
  const existingLegacyShowTutorial = ctx.body.subarray(
    insertionPos,
    insertionPos + legacyShowTutorialPayload.length
  );
  const hasCorrectShowTutorial = existingShowTutorial.equals(showTutorialPayload);
  const hasLegacyShowTutorial = existingLegacyShowTutorial.equals(legacyShowTutorialPayload);
  const needsShowTutorialPatch = !hasCorrectShowTutorial;
  if (needsShowTutorialPatch) {
    patches.push({
      key: "levelsnr_room4_insert_jump_showtutorial",
      start: insertionPos,
      end: insertionPos + (hasLegacyShowTutorial ? legacyShowTutorialPayload.length : 0),
      data: showTutorialPayload,
      detail: `Show ${JUMP_TUTORIAL} tutorial box during ${CLASS_NAME}.${METHOD_NAME}`,
    });
  }

  const requiredTriggerIndex = abc.stringValues.indexOf(REQUIRED_TRIGGER);
  if (requiredTriggerIndex <= 0) {
    throw new PatchError(`Required trigger string not found (${REQUIRED_TRIGGER})`);
  }

  const triggerCandidates = [];
  for (let i = 0; i + 1 < instrs.length; i += 1) {
    const inst = instrs[i];
    const next = instrs[i + 1];
    if (inst.opcode !== 0x2c || inst.operands.length !== 1 || inst.operands[0][0] !== "u30") {
      continue;
    }
    if (next.opcode !== 0x46 || u30OperandName(next, abc.multinameNames) !== "OnTrigger") {
      continue;
    }

    const triggerName = u30OperandName(inst, abc.stringValues);
    if (triggerName) {
      triggerCandidates.push({ inst, triggerName });
    }
  }

  if (triggerCandidates.length === 0) {
    throw new PatchError(`No OnTrigger check found in ${CLASS_NAME}.${METHOD_NAME}`);
  }

  const matchingTrigger = triggerCandidates.find((candidate) => candidate.triggerName === REQUIRED_TRIGGER);
  const activeTrigger = matchingTrigger ?? triggerCandidates[0];
  if (activeTrigger.triggerName !== REQUIRED_TRIGGER) {
    const replacement = writeU30(requiredTriggerIndex);
    const operandStart = methodBody.codeStart + activeTrigger.inst.offset + 1;
    const operandEnd = methodBody.codeStart + activeTrigger.inst.offset + activeTrigger.inst.size;
    const currentBytes = ctx.body.subarray(operandStart, operandEnd);
    if (currentBytes.length !== replacement.length) {
      throw new PatchError(`Unsupported varint width change ${currentBytes.length} -> ${replacement.length}`);
    }

    patches.push({
      key: "levelsnr_room4_restore_jump_trigger",
      start: operandStart,
      end: operandEnd,
      data: replacement,
      detail: `Restore ${CLASS_NAME}.${METHOD_NAME} completion trigger to ${REQUIRED_TRIGGER}`,
    });
  }

  if (needsShowTutorialPatch) {
    const replacedLength = hasLegacyShowTutorial ? legacyShowTutorialPayload.length : 0;
    const newCodeLen = methodBody.codeLen + showTutorialPayload.length - replacedLength;
    const currentCodeLenBytes = writeU30(methodBody.codeLen);
    const replacementCodeLenBytes = writeU30(newCodeLen);
    if (currentCodeLenBytes.length !== replacementCodeLenBytes.length) {
      throw new PatchError(
        `Unsupported ${CLASS_NAME}.${METHOD_NAME} code length varint width change ${currentCodeLenBytes.length} -> ${replacementCodeLenBytes.length}`
      );
    }

    patches.push({
      key: "levelsnr_room4_force_show_jump_tutorial_codelen",
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: replacementCodeLenBytes,
      detail: `Expand ${CLASS_NAME}.${METHOD_NAME} code length to ${newCodeLen}`,
    });
  }

  return { ctx, patches, currentTrigger: activeTrigger.triggerName };
}

function main(): number {
  const args = process.argv.slice(2);
  const swfPath = resolveSwfPath(args);
  const verifyOnly = hasFlag(args, "--verify") || hasFlag(args, "--dry-run");

  try {
    const { ctx, patches, currentTrigger } = analyzePatch(swfPath);
    console.log(`SWF: ${swfPath}`);
    console.log(`${METHOD_NAME} trigger: ${currentTrigger}`);
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
