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

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;

  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++i] ?? "");
      continue;
    }
    if (arg === "--verify") {
      verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  ts-node src/server/scripts/patch-dungeonblitz-dungeon-quest-helper.ts [--verify] [--swf <path>]",
        "",
        "Patches Game.SelectMissionToTrack so instanced dungeon levels clear only the",
        "visual quest-helper tracking slot. Mission state/progress stays untouched.",
      ].join("\n"));
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function findSingleMultiname(abc: ReturnType<typeof parseAbc>, name: string): number {
  const matches: number[] = [];
  for (let i = 0; i < abc.multinameNames.length; i += 1) {
    if (abc.multinameNames[i] === name) {
      matches.push(i);
    }
  }
  if (matches.length !== 1) {
    throw new PatchError(`Expected one multiname for ${name}, found ${matches.length}: ${matches.join(",")}`);
  }
  return matches[0];
}

function findSelectMissionToTrackBody(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const gameIndex = classIndexByName(abc, "Game");
  if (gameIndex === null) {
    throw new PatchError("Could not find Game class.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[gameIndex].traits, abc, "SelectMissionToTrack");
  if (methodIdx === null) {
    throw new PatchError("Could not find Game.SelectMissionToTrack.");
  }

  const body = abc.methodBodies.get(methodIdx);
  if (!body) {
    throw new PatchError(`Could not find method body for Game.SelectMissionToTrack method ${methodIdx}.`);
  }

  return { ctx, abc, body };
}

function encodeS24(value: number): Buffer {
  if (value < -0x800000 || value > 0x7fffff) {
    throw new PatchError(`s24 out of range: ${value}`);
  }
  const out = Buffer.alloc(3);
  out.writeIntLE(value, 0, 3);
  return out;
}

function opU30(opcode: number, value: number): Buffer {
  return Buffer.concat([Buffer.from([opcode]), writeU30(value)]);
}

function opU30U30(opcode: number, first: number, second: number): Buffer {
  return Buffer.concat([Buffer.from([opcode]), writeU30(first), writeU30(second)]);
}

function branch(opcode: number, fromOffset: number, targetOffset: number): Buffer {
  return Buffer.concat([Buffer.from([opcode]), encodeS24(targetOffset - (fromOffset + 4))]);
}

function buildDungeonGuard(multinames: {
  level: number;
  bInstanced: number;
  internalName: number;
  class13: number;
  mTrackedMission: number;
  screenQuestTracker: number;
  refresh: number;
  craftTownTutorialString: number;
}): Buffer {
  const chunks: Buffer[] = [];
  let length = 0;
  const emit = (buffer: Buffer): number => {
    const offset = length;
    chunks.push(buffer);
    length += buffer.length;
    return offset;
  };
  const emitPlaceholder = (): { index: number; offset: number } => {
    const index = chunks.length;
    const offset = emit(Buffer.alloc(4));
    return { index, offset };
  };

  emit(Buffer.from([0xd0])); // getlocal0
  emit(opU30(0x66, multinames.level)); // getproperty level
  emit(Buffer.from([0x2a])); // dup
  const ifHasLevel = emitPlaceholder();
  emit(Buffer.from([0x29])); // pop duplicated null level
  const jumpAfterNullLevel = emitPlaceholder();

  const hasLevelOffset = length;
  emit(opU30(0x66, multinames.bInstanced)); // getproperty bInstanced
  const ifNotDungeon = emitPlaceholder();
  emit(Buffer.from([0xd0])); // getlocal0
  emit(opU30(0x66, multinames.level)); // getproperty level
  emit(opU30(0x66, multinames.internalName)); // getproperty internalName
  emit(opU30(0x2c, multinames.craftTownTutorialString)); // pushstring CraftTownTutorial
  const ifCraftTownTutorial = emitPlaceholder();
  emit(Buffer.from([0xd0, 0x20])); // getlocal0, pushnull
  emit(opU30(0x80, multinames.class13)); // coerce class_13
  emit(opU30(0x68, multinames.mTrackedMission)); // setproperty mTrackedMission
  emit(Buffer.from([0xd0])); // getlocal0
  emit(opU30(0x66, multinames.screenQuestTracker)); // getproperty screenQuestTracker
  emit(opU30U30(0x4f, multinames.refresh, 0)); // callpropvoid Refresh, 0
  emit(Buffer.from([0x47])); // returnvoid

  const afterGuardOffset = length;
  chunks[ifHasLevel.index] = branch(0x11, ifHasLevel.offset, hasLevelOffset); // iftrue
  chunks[jumpAfterNullLevel.index] = branch(0x10, jumpAfterNullLevel.offset, afterGuardOffset); // jump
  chunks[ifNotDungeon.index] = branch(0x12, ifNotDungeon.offset, afterGuardOffset); // iffalse
  chunks[ifCraftTownTutorial.index] = branch(0x13, ifCraftTownTutorial.offset, afterGuardOffset); // ifeq

  return Buffer.concat(chunks);
}

function locateInsertionOffset(code: Buffer): number {
  const instructions = disassemble(code, "Game.SelectMissionToTrack");
  const pushScope = instructions.find((inst) => inst.opcode === 0x30);
  if (!pushScope) {
    throw new PatchError("Could not find pushscope in Game.SelectMissionToTrack.");
  }
  return pushScope.offset + pushScope.size;
}

function findMethodOperand(
  code: Buffer,
  names: string[],
  opcode: number,
  name: string,
  operandIndex: number = 0,
): number {
  const operands = disassemble(code, "Game.SelectMissionToTrack.operands")
    .filter((inst) => inst.opcode === opcode && u30OperandName(inst, names) === name);
  const values = operands.map((inst) => {
    const operand = inst.operands[operandIndex];
    if (!operand || operand[0] !== "u30") {
      throw new PatchError(`Instruction for ${name} does not have u30 operand ${operandIndex}.`);
    }
    return operand[1];
  });
  const uniqueValues = [...new Set(values)];
  if (uniqueValues.length !== 1) {
    throw new PatchError(
      `Expected one unique Game.SelectMissionToTrack opcode 0x${opcode.toString(16)} operand for ${name}, found ${uniqueValues.length}: ${uniqueValues.join(",")}.`,
    );
  }
  return uniqueValues[0];
}

function hasDungeonGuard(code: Buffer, names: string[]): boolean {
  const instructions = disassemble(code, "Game.SelectMissionToTrack.verify");
  for (let i = 0; i < instructions.length - 24; i += 1) {
    const window = instructions.slice(i, i + 25);
    if (
      window[0].opcode === 0xd0 &&
      window[1].opcode === 0x66 &&
      u30OperandName(window[1], names) === "level" &&
      window.some((inst) => inst.opcode === 0x66 && u30OperandName(inst, names) === "bInstanced") &&
      window.some((inst) => inst.opcode === 0x68 && u30OperandName(inst, names) === "mTrackedMission")
    ) {
      return true;
    }
  }
  return false;
}

function hasCraftTownTutorialExclusion(code: Buffer, abc: ReturnType<typeof parseAbc>): boolean {
  const instructions = disassemble(code, "Game.SelectMissionToTrack.verify.craftTown");
  return instructions.some((inst) => {
    if (inst.opcode !== 0x2c || inst.operands[0]?.[0] !== "u30") {
      return false;
    }
    return abc.stringValues[inst.operands[0][1]] === "CraftTownTutorial";
  });
}

function findStringIndex(abc: ReturnType<typeof parseAbc>, value: string): number {
  const index = abc.stringValues.indexOf(value);
  if (index <= 0) {
    throw new PatchError(`Could not find string ${value} in SWF string pool.`);
  }
  return index;
}

function buildCraftTownTutorialExclusion(multinames: {
  level: number;
  internalName: number;
  craftTownTutorialString: number;
}, insertionOffset: number, afterGuardOffset: number): Buffer {
  const prefix = Buffer.concat([
    Buffer.from([0xd0]), // getlocal0
    opU30(0x66, multinames.level), // getproperty level
    opU30(0x66, multinames.internalName), // getproperty internalName
    opU30(0x2c, multinames.craftTownTutorialString), // pushstring CraftTownTutorial
  ]);
  const branchOffset = insertionOffset + prefix.length;
  const targetOffset = afterGuardOffset + prefix.length + 4;
  return Buffer.concat([prefix, branch(0x13, branchOffset, targetOffset)]); // ifeq after guard
}

function findExistingGuardPatchPoint(code: Buffer, names: string[]): { insertionOffset: number; afterGuardOffset: number } {
  const instructions = disassemble(code, "Game.SelectMissionToTrack.guardPoint");
  for (let i = 0; i < instructions.length - 12; i += 1) {
    const inst = instructions[i];
    const window = instructions.slice(i, i + 13);
    if (
      inst.opcode === 0x66 &&
      u30OperandName(inst, names) === "bInstanced" &&
      window[1]?.opcode === 0x12 &&
      window.some((item) => item.opcode === 0x68 && u30OperandName(item, names) === "mTrackedMission") &&
      window.some((item) => item.opcode === 0x66 && u30OperandName(item, names) === "screenQuestTracker")
    ) {
      const returnVoid = window.find((item) => item.opcode === 0x47);
      if (!returnVoid) {
        break;
      }
      return {
        insertionOffset: window[1].offset + window[1].size,
        afterGuardOffset: returnVoid.offset + returnVoid.size,
      };
    }
  }
  throw new PatchError("Could not locate existing dungeon quest-helper guard patch point.");
}

function buildBranchAdjustmentPatches(
  body: NonNullable<ReturnType<typeof findSelectMissionToTrackBody>["body"]>,
  code: Buffer,
  insertionOffset: number,
  insertionLength: number,
): BytePatch[] {
  const patches: BytePatch[] = [];
  for (const inst of disassemble(code, "Game.SelectMissionToTrack.branchAdjust")) {
    const operand = inst.operands[0];
    if (!operand || operand[0] !== "s24") {
      continue;
    }
    const target = inst.offset + inst.size + operand[1];
    let nextOperand = operand[1];
    if (inst.offset < insertionOffset && target >= insertionOffset) {
      nextOperand += insertionLength;
    } else if (inst.offset >= insertionOffset && target < insertionOffset) {
      nextOperand -= insertionLength;
    } else {
      continue;
    }
    patches.push({
      key: `select-mission-branch-${inst.offset}`,
      start: body.codeStart + inst.offset + 1,
      end: body.codeStart + inst.offset + inst.size,
      data: encodeS24(nextOperand),
      detail: `adjust Game.SelectMissionToTrack branch ${inst.offset} across CraftTownTutorial exclusion`,
    });
  }
  return patches;
}

function patchSwf(swfPath: string): void {
  const { ctx, abc, body } = findSelectMissionToTrackBody(swfPath);
  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  if (hasDungeonGuard(code, abc.multinameNames)) {
    if (hasCraftTownTutorialExclusion(code, abc)) {
      console.log(`${path.basename(swfPath)} already has the dungeon quest-helper guard.`);
      return;
    }

    const patchPoint = findExistingGuardPatchPoint(code, abc.multinameNames);
    const exclusion = buildCraftTownTutorialExclusion({
      level: findMethodOperand(code, abc.multinameNames, 0x66, "level"),
      internalName: findSingleMultiname(abc, "internalName"),
      craftTownTutorialString: findStringIndex(abc, "CraftTownTutorial"),
    }, patchPoint.insertionOffset, patchPoint.afterGuardOffset);
    ensureBackup(swfPath);
    const patches: BytePatch[] = [
      {
        key: "select-mission-code-len-crafttown-exclusion",
        start: body.codeLenPos,
        end: body.codeStart,
        data: writeU30(body.codeLen + exclusion.length),
        detail: "update Game.SelectMissionToTrack code length for CraftTownTutorial exclusion",
      },
      {
        key: "select-mission-crafttown-tutorial-exclusion",
        start: body.codeStart + patchPoint.insertionOffset,
        end: body.codeStart + patchPoint.insertionOffset,
        data: exclusion,
        detail: "let CraftTownTutorial use normal mission tracker progress",
      },
      ...buildBranchAdjustmentPatches(body, code, patchPoint.insertionOffset, exclusion.length),
    ];
    const { body: patchedBody, delta } = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, patchedBody, delta);
    verifySwf(swfPath);
    console.log(`${path.basename(swfPath)} patched: CraftTownTutorial uses normal mission tracker progress.`);
    return;
  }

  const insertionOffset = locateInsertionOffset(code);
  const guard = buildDungeonGuard({
    level: findMethodOperand(code, abc.multinameNames, 0x66, "level"),
    bInstanced: findSingleMultiname(abc, "bInstanced"),
    internalName: findSingleMultiname(abc, "internalName"),
    class13: findMethodOperand(code, abc.multinameNames, 0x80, "class_13"),
    mTrackedMission: findMethodOperand(code, abc.multinameNames, 0x68, "mTrackedMission"),
    screenQuestTracker: findMethodOperand(code, abc.multinameNames, 0x66, "screenQuestTracker"),
    refresh: findMethodOperand(code, abc.multinameNames, 0x4f, "Refresh"),
    craftTownTutorialString: findStringIndex(abc, "CraftTownTutorial"),
  });

  ensureBackup(swfPath);
  const newCodeLen = body.codeLen + guard.length;
  const patches: BytePatch[] = [
    {
      key: "select-mission-code-len",
      start: body.codeLenPos,
      end: body.codeStart,
      data: writeU30(newCodeLen),
      detail: "update Game.SelectMissionToTrack code length",
    },
    {
      key: "select-mission-dungeon-guard",
      start: body.codeStart + insertionOffset,
      end: body.codeStart + insertionOffset,
      data: guard,
      detail: "clear visual tracked mission when current level is an instanced dungeon",
    },
  ];

  const { body: patchedBody, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, patchedBody, delta);
  verifySwf(swfPath);
  console.log(`${path.basename(swfPath)} patched: dungeon quest helper now prioritizes dungeon progress.`);
}

function verifySwf(swfPath: string): void {
  const { ctx, abc, body } = findSelectMissionToTrackBody(swfPath);
  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  if (!hasDungeonGuard(code, abc.multinameNames)) {
    throw new PatchError(`${path.basename(swfPath)} is missing the dungeon quest-helper guard.`);
  }
  if (!hasCraftTownTutorialExclusion(code, abc)) {
    throw new PatchError(`${path.basename(swfPath)} is missing the CraftTownTutorial quest-helper exclusion.`);
  }
  console.log(`${path.basename(swfPath)} verify ok.`);
}

function main(): void {
  const { swfPath, verify } = parseArgs(process.argv);
  if (verify) {
    verifySwf(swfPath);
    return;
  }
  patchSwf(swfPath);
}

main();
