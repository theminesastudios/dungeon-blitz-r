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
const SHOW_TUTORIAL = "ShowTutorial";
const HIDE_TUTORIAL = "HideTutorial";
const JUMP_TUTORIAL = "am_JumpTut";
const DROP_TUTORIAL = "am_DropTut";

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

function buildHookCall(tutorialIndex: number, hookIndex: number): Buffer {
  return Buffer.concat([
    Buffer.from([0xd1]),
    Buffer.from([0x2c]),
    writeU30(tutorialIndex),
    Buffer.from([0x4f]),
    writeU30(hookIndex),
    writeU30(1),
  ]);
}

function buildInsertPatch(
  ctx: ReturnType<typeof parseSwf>,
  abc: ReturnType<typeof parseAbc>,
  methodName: string,
  insertionMatcher: (instrs: ReturnType<typeof disassemble>) => number,
  payload: Buffer,
  patchKey: string,
  detail: string
): BytePatch[] {
  const classIndex = classIndexByName(abc, CLASS_NAME);
  if (classIndex === null) {
    throw new PatchError(`${CLASS_NAME} class not found`);
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, methodName);
  if (methodIdx === null) {
    throw new PatchError(`${CLASS_NAME}.${methodName} not found`);
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`${CLASS_NAME}.${methodName} body not found`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  const instrs = disassemble(code, `${CLASS_NAME}.${methodName}`);
  const insertionPos = insertionMatcher(instrs);
  if (insertionPos < 0) {
    throw new PatchError(`Could not find insertion point in ${CLASS_NAME}.${methodName}`);
  }

  const absoluteInsertPos = methodBody.codeStart + insertionPos;
  const existing = ctx.body.subarray(absoluteInsertPos, absoluteInsertPos + payload.length);
  if (existing.equals(payload)) {
    return [];
  }

  const newCodeLen = methodBody.codeLen + payload.length;
  const currentCodeLenBytes = writeU30(methodBody.codeLen);
  const replacementCodeLenBytes = writeU30(newCodeLen);
  if (currentCodeLenBytes.length !== replacementCodeLenBytes.length) {
    throw new PatchError(
      `Unsupported ${CLASS_NAME}.${methodName} code length varint width change ${currentCodeLenBytes.length} -> ${replacementCodeLenBytes.length}`
    );
  }

  return [
    {
      key: `${patchKey}_insert`,
      start: absoluteInsertPos,
      end: absoluteInsertPos,
      data: payload,
      detail,
    },
    {
      key: `${patchKey}_codelen`,
      start: methodBody.codeLenPos,
      end: methodBody.codeStart,
      data: replacementCodeLenBytes,
      detail: `Expand ${CLASS_NAME}.${methodName} code length to ${newCodeLen}`,
    },
  ];
}

function analyzePatch(swfPath: string): {
  ctx: ReturnType<typeof parseSwf>;
  patches: BytePatch[];
} {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const showTutorialIndex = abc.multinameNames.indexOf(SHOW_TUTORIAL);
  const hideTutorialIndex = abc.multinameNames.indexOf(HIDE_TUTORIAL);
  const jumpTutorialIndex = abc.stringValues.indexOf(JUMP_TUTORIAL);
  const dropTutorialIndex = abc.stringValues.indexOf(DROP_TUTORIAL);

  if (showTutorialIndex <= 0 || hideTutorialIndex <= 0) {
    throw new PatchError(`Required tutorial hooks not found (${SHOW_TUTORIAL}, ${HIDE_TUTORIAL})`);
  }
  if (jumpTutorialIndex <= 0 || dropTutorialIndex <= 0) {
    throw new PatchError(`Required tutorial ids not found (${JUMP_TUTORIAL}, ${DROP_TUTORIAL})`);
  }

  const patches: BytePatch[] = [];

  patches.push(
    ...buildInsertPatch(
      ctx,
      abc,
      "FirstTick",
      (instrs) => {
        const target = instrs.find(
          (inst) => inst.opcode === 0x4f && u30OperandName(inst, abc.multinameNames) === "SetPhase"
        );
        return target ? target.offset : -1;
      },
      buildHookCall(jumpTutorialIndex, showTutorialIndex),
      "levelsnr_room4_firsttick_show_jump_tutorial",
      `Show ${JUMP_TUTORIAL} tutorial at ${CLASS_NAME}.FirstTick startup`
    )
  );

  patches.push(
    ...buildInsertPatch(
      ctx,
      abc,
      "WaitingForDrop",
      (instrs) => {
        for (let i = 0; i + 4 < instrs.length; i += 1) {
          const first = instrs[i];
          const second = instrs[i + 1];
          const third = instrs[i + 2];
          const fourth = instrs[i + 3];
          const fifth = instrs[i + 4];
          if (first.opcode !== 0xd1) {
            continue;
          }
          if (second.opcode !== 0x2c || u30OperandName(second, abc.stringValues) !== DROP_TUTORIAL) {
            continue;
          }
          if (
            third.opcode !== 0x2c ||
            (u30OperandName(third, abc.stringValues) !== "Remove" &&
              u30OperandName(third, abc.multinameNames) !== "Remove")
          ) {
            continue;
          }
          if (fourth.opcode !== 0x26) {
            continue;
          }
          if (fifth.opcode !== 0x4f || u30OperandName(fifth, abc.multinameNames) !== "Animate") {
            continue;
          }
          return fifth.offset + fifth.size;
        }
        return -1;
      },
      Buffer.concat([
        buildHookCall(jumpTutorialIndex, hideTutorialIndex),
        buildHookCall(dropTutorialIndex, showTutorialIndex),
      ]),
      "levelsnr_room4_waitingfordrop_activate_tutorial",
      `Hide ${JUMP_TUTORIAL} and show ${DROP_TUTORIAL} during ${CLASS_NAME}.WaitingForDrop`
    )
  );

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
