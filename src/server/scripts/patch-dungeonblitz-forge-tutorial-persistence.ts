#!/usr/bin/env node

import * as fs from "fs";
import * as path from "path";
import {
  AbcParseResult,
  BytePatch,
  Instruction,
  MethodBodyInfo,
  PatchError,
  SwfContext,
  applyPatchesToBody,
  classIndexByName,
  disassemble,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  readU30,
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

const GAME_CLASS = "Game";
const GAME_INITIALIZE_METHOD = "method_1435";
const TUTORIAL_CLASS = "class_89";
const TUTORIAL_COMPLETE_METHOD = "method_345";
const TUTORIAL_CHECK_METHOD = "CheckCompletedTutorials";

type ParsedMethod = {
  body: MethodBodyInfo;
  code: Buffer;
};

type PatchSymbols = {
  var1: number;
  var304: number;
  data: number;
  tutorialsCompleted: number;
  currentTutorial: number;
  flush: number;
};

type Args = {
  swfPath: string;
  verify: boolean;
};

function parseArgs(argv: string[]): Args {
  let swfPath = DEFAULT_SWF;
  let verify = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verify") {
      verify = true;
      continue;
    }
    if (arg === "--swf" || arg === "-s") {
      const value = argv[++index];
      if (!value) {
        throw new PatchError(`${arg} requires a path`);
      }
      swfPath = path.resolve(value);
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  ts-node src/server/scripts/patch-dungeonblitz-forge-tutorial-persistence.ts [--verify] [--swf <path>]",
        "",
        "Persists DungeonBlitz.swf's completed interactive-tutorial bitmask in its",
        "existing dbSavedGameData SharedObject so the Forge tutorial remains complete",
        "after the client restarts.",
      ].join("\n"));
      process.exit(0);
    }
    throw new PatchError(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function requireMultiname(abc: AbcParseResult, name: string): number {
  const matches: number[] = [];
  for (let index = 0; index < abc.multinameNames.length; index += 1) {
    if (abc.multinameNames[index] === name) {
      matches.push(index);
    }
  }
  if (matches.length !== 1) {
    throw new PatchError(`Expected one multiname ${name}, found ${matches.length}`);
  }
  return matches[0];
}

function requireReferencedMultiname(
  abc: AbcParseResult,
  code: Buffer,
  name: string,
  opcodes: ReadonlySet<number>,
  label: string,
): number {
  const namedIndices = new Set<number>();
  for (let index = 0; index < abc.multinameNames.length; index += 1) {
    if (abc.multinameNames[index] === name) {
      namedIndices.add(index);
    }
  }

  const referenced = new Set(
    disassemble(code, label)
      .filter((instruction) =>
        opcodes.has(instruction.opcode) &&
        instruction.operands[0]?.[0] === "u30" &&
        namedIndices.has(instruction.operands[0][1])
      )
      .map((instruction) => instruction.operands[0][1]),
  );
  if (referenced.size !== 1) {
    throw new PatchError(
      `Expected ${label} to reference one ${name} multiname, found ${referenced.size}`,
    );
  }
  return [...referenced][0];
}

function getSymbols(ctx: SwfContext, abc: AbcParseResult): PatchSymbols {
  const game = getMethod(ctx, abc, GAME_CLASS, GAME_INITIALIZE_METHOD);
  const tutorial = getMethod(ctx, abc, TUTORIAL_CLASS, TUTORIAL_COMPLETE_METHOD);
  return {
    var1: requireReferencedMultiname(
      abc,
      tutorial.code,
      "var_1",
      new Set([0x60]),
      `${TUTORIAL_CLASS}.${TUTORIAL_COMPLETE_METHOD}`,
    ),
    var304: requireReferencedMultiname(
      abc,
      game.code,
      "var_304",
      new Set([0x66, 0x68]),
      `${GAME_CLASS}.${GAME_INITIALIZE_METHOD}`,
    ),
    data: requireReferencedMultiname(
      abc,
      game.code,
      "data",
      new Set([0x66]),
      `${GAME_CLASS}.${GAME_INITIALIZE_METHOD}`,
    ),
    tutorialsCompleted: requireReferencedMultiname(
      abc,
      tutorial.code,
      "mTutorialsCompletedList",
      new Set([0x66, 0x61]),
      `${TUTORIAL_CLASS}.${TUTORIAL_COMPLETE_METHOD}`,
    ),
    currentTutorial: requireReferencedMultiname(
      abc,
      tutorial.code,
      "mCurrentTutorialIdx",
      new Set([0x66]),
      `${TUTORIAL_CLASS}.${TUTORIAL_COMPLETE_METHOD}`,
    ),
    flush: requireMultiname(abc, "flush"),
  };
}

function getMethod(
  ctx: SwfContext,
  abc: AbcParseResult,
  className: string,
  methodName: string,
): ParsedMethod {
  const classIndex = classIndexByName(abc, className);
  if (classIndex === null) {
    throw new PatchError(`Class ${className} not found`);
  }
  const methodIndex = methodIdxForTrait(abc.instances[classIndex].traits, abc, methodName);
  if (methodIndex === null) {
    throw new PatchError(`Method ${className}.${methodName} not found`);
  }
  const body = abc.methodBodies.get(methodIndex);
  if (!body) {
    throw new PatchError(`Method body ${className}.${methodName} not found`);
  }
  if (body.exceptionCount !== 0) {
    throw new PatchError(`${className}.${methodName} unexpectedly contains exception handlers`);
  }
  return {
    body,
    code: Buffer.from(ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen)),
  };
}

function op(opcode: number, ...operands: number[]): Buffer {
  return Buffer.concat([
    Buffer.from([opcode]),
    ...operands.map((operand) => writeU30(operand)),
  ]);
}

function tutorialCompletionSequence(symbols: PatchSymbols): Buffer {
  return Buffer.concat([
    op(0x60, symbols.var1), // getlex var_1
    op(0x60, symbols.var1), // getlex var_1
    op(0x66, symbols.tutorialsCompleted), // getproperty mTutorialsCompletedList
    Buffer.from([0xd0]), // getlocal0 (the interactive tutorial screen)
    op(0x66, symbols.currentTutorial), // getproperty mCurrentTutorialIdx
    Buffer.from([0xa9]), // bitor
    op(0x61, symbols.tutorialsCompleted), // setproperty mTutorialsCompletedList
  ]);
}

function persistenceSequence(symbols: PatchSymbols): Buffer {
  return Buffer.concat([
    op(0x60, symbols.var1), // getlex var_1
    op(0x66, symbols.var304), // getproperty saved-game SharedObject
    op(0x66, symbols.data), // getproperty data
    op(0x60, symbols.var1), // getlex var_1
    op(0x66, symbols.tutorialsCompleted), // getproperty completed mask
    op(0x61, symbols.tutorialsCompleted), // data.mTutorialsCompletedList = mask
    op(0x60, symbols.var1), // getlex var_1
    op(0x66, symbols.var304), // getproperty saved-game SharedObject
    op(0x4f, symbols.flush, 0), // callpropvoid flush, 0
  ]);
}

function restoreSequence(symbols: PatchSymbols): Buffer {
  return Buffer.concat([
    op(0x60, symbols.var1), // getlex var_1 (Game)
    op(0x60, symbols.var1), // getlex var_1 (Game)
    op(0x66, symbols.tutorialsCompleted), // current in-memory mask
    op(0x60, symbols.var1), // getlex var_1 (Game)
    op(0x66, symbols.var304), // saved-game SharedObject
    op(0x66, symbols.data),
    op(0x66, symbols.tutorialsCompleted), // persisted mask (undefined => uint(0))
    Buffer.from([0xa9]), // bitor, retaining any already-completed bits
    op(0x61, symbols.tutorialsCompleted),
  ]);
}

function unsafeStartupRestoreSequence(symbols: PatchSymbols): Buffer {
  return Buffer.concat([
    Buffer.from([0xd0]), // getlocal0 (Game)
    Buffer.from([0xd0]), // getlocal0 (Game)
    op(0x66, symbols.tutorialsCompleted),
    Buffer.from([0xd0]), // getlocal0 (Game)
    op(0x66, symbols.var304),
    op(0x66, symbols.data),
    op(0x66, symbols.tutorialsCompleted),
    Buffer.from([0xa9]), // bitor
    op(0x61, symbols.tutorialsCompleted),
  ]);
}

function findAll(code: Buffer, needle: Buffer): number[] {
  const offsets: number[] = [];
  let from = 0;
  while (from <= code.length - needle.length) {
    const offset = code.indexOf(needle, from);
    if (offset < 0) {
      break;
    }
    offsets.push(offset);
    from = offset + 1;
  }
  return offsets;
}

function requireUniqueSequence(code: Buffer, needle: Buffer, label: string): number {
  const matches = findAll(code, needle);
  if (matches.length !== 1) {
    throw new PatchError(`Expected one ${label} sequence, found ${matches.length}`);
  }
  return matches[0];
}

function writeS24(value: number): Buffer {
  if (value < -0x800000 || value > 0x7fffff) {
    throw new PatchError(`s24 branch offset out of range: ${value}`);
  }
  const encoded = value < 0 ? value + 0x1000000 : value;
  return Buffer.from([
    encoded & 0xff,
    (encoded >>> 8) & 0xff,
    (encoded >>> 16) & 0xff,
  ]);
}

function branchTarget(instruction: Instruction): number | null {
  const operand = instruction.operands[0];
  if (!operand || operand[0] !== "s24") {
    return null;
  }
  return instruction.offset + instruction.size + operand[1];
}

function verifyBranchTargets(code: Buffer, label: string): void {
  const instructions = disassemble(code, label);
  const boundaries = new Set(instructions.map((instruction) => instruction.offset));
  boundaries.add(code.length);

  const last = instructions[instructions.length - 1];
  if (!last || last.offset + last.size !== code.length) {
    throw new PatchError(`${label} does not disassemble to its declared code length`);
  }

  for (const instruction of instructions) {
    const target = branchTarget(instruction);
    if (target !== null && !boundaries.has(target)) {
      throw new PatchError(
        `${label} branch at ${instruction.offset} targets invalid boundary ${target}`,
      );
    }
  }
}

function insertCode(code: Buffer, insertAt: number, inserted: Buffer, label: string): Buffer {
  const instructions = disassemble(code, label);
  const boundaries = new Set(instructions.map((instruction) => instruction.offset));
  boundaries.add(code.length);
  if (!boundaries.has(insertAt)) {
    throw new PatchError(`${label} insertion ${insertAt} is not an instruction boundary`);
  }

  const delta = inserted.length;
  const patched = Buffer.concat([
    code.subarray(0, insertAt),
    inserted,
    code.subarray(insertAt),
  ]);

  for (const instruction of instructions) {
    const oldTarget = branchTarget(instruction);
    if (oldTarget === null) {
      continue;
    }
    if (!boundaries.has(oldTarget)) {
      throw new PatchError(
        `${label} original branch at ${instruction.offset} targets invalid boundary ${oldTarget}`,
      );
    }

    const newOffset = instruction.offset + (instruction.offset >= insertAt ? delta : 0);
    const newTarget = oldTarget + (oldTarget >= insertAt ? delta : 0);
    const newRelative = newTarget - (newOffset + instruction.size);
    writeS24(newRelative).copy(patched, newOffset + 1);
  }

  verifyBranchTargets(patched, `${label} patched`);
  return patched;
}

function findMethodEntryInsertion(code: Buffer, label: string): number {
  const scopeSetup = Buffer.from([0xd0, 0x30]); // getlocal0; pushscope
  return requireUniqueSequence(code, scopeSetup, `${label} scope setup`) + scopeSetup.length;
}

function patchStatus(
  ctx: SwfContext,
  abc: AbcParseResult,
  symbols: PatchSymbols,
): {
  tutorialCheck: ParsedMethod;
  tutorial: ParsedMethod;
  restoreInsertAt: number;
  tutorialInsertAt: number;
  hasRestore: boolean;
  hasPersistence: boolean;
} {
  const tutorialCheck = getMethod(ctx, abc, TUTORIAL_CLASS, TUTORIAL_CHECK_METHOD);
  const tutorial = getMethod(ctx, abc, TUTORIAL_CLASS, TUTORIAL_COMPLETE_METHOD);

  const completion = tutorialCompletionSequence(symbols);
  const completionOffset = requireUniqueSequence(
    tutorial.code,
    completion,
    "interactive tutorial completion",
  );
  const tutorialInsertAt = completionOffset + completion.length;
  const restoreInsertAt = findMethodEntryInsertion(
    tutorialCheck.code,
    `${TUTORIAL_CLASS}.${TUTORIAL_CHECK_METHOD}`,
  );
  const persistence = persistenceSequence(symbols);
  const restore = restoreSequence(symbols);

  return {
    tutorialCheck,
    tutorial,
    restoreInsertAt,
    tutorialInsertAt,
    hasRestore: tutorialCheck.code
      .subarray(restoreInsertAt, restoreInsertAt + restore.length)
      .equals(restore),
    hasPersistence: tutorial.code
      .subarray(tutorialInsertAt, tutorialInsertAt + persistence.length)
      .equals(persistence),
  };
}

function verifySwf(swfPath: string): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const symbols = getSymbols(ctx, abc);
  const status = patchStatus(ctx, abc, symbols);

  if (!status.hasRestore || !status.hasPersistence) {
    throw new PatchError(
      `Forge tutorial persistence is incomplete: restore=${status.hasRestore} persist=${status.hasPersistence}`,
    );
  }

  const gameInitialize = getMethod(ctx, abc, GAME_CLASS, GAME_INITIALIZE_METHOD);
  if (findAll(gameInitialize.code, unsafeStartupRestoreSequence(symbols)).length !== 0) {
    throw new PatchError(
      "Forge tutorial restore still runs during early Game initialization",
    );
  }

  const [tutorialCheckMaxStack] = readU30(
    ctx.body,
    status.tutorialCheck.body.maxStackPos,
    `${TUTORIAL_CLASS}.${TUTORIAL_CHECK_METHOD}.max_stack`,
  );
  if (tutorialCheckMaxStack < 3) {
    throw new PatchError(
      `${TUTORIAL_CLASS}.${TUTORIAL_CHECK_METHOD} max_stack ${tutorialCheckMaxStack} is below 3`,
    );
  }

  verifyBranchTargets(
    status.tutorialCheck.code,
    `${TUTORIAL_CLASS}.${TUTORIAL_CHECK_METHOD}`,
  );
  verifyBranchTargets(status.tutorial.code, `${TUTORIAL_CLASS}.${TUTORIAL_COMPLETE_METHOD}`);
  console.log("Forge tutorial persistence patch verified with lazy restore.");
}

function patchSwf(swfPath: string): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const symbols = getSymbols(ctx, abc);
  const status = patchStatus(ctx, abc, symbols);

  if (status.hasRestore || status.hasPersistence) {
    if (status.hasRestore && status.hasPersistence) {
      console.log("Forge tutorial persistence patch is already applied.");
      verifySwf(swfPath);
      return;
    }
    throw new PatchError(
      `Refusing to patch a partial state: restore=${status.hasRestore} persist=${status.hasPersistence}`,
    );
  }

  const patchedTutorialCheck = insertCode(
    status.tutorialCheck.code,
    status.restoreInsertAt,
    restoreSequence(symbols),
    `${TUTORIAL_CLASS}.${TUTORIAL_CHECK_METHOD}`,
  );
  const patchedTutorial = insertCode(
    status.tutorial.code,
    status.tutorialInsertAt,
    persistenceSequence(symbols),
    `${TUTORIAL_CLASS}.${TUTORIAL_COMPLETE_METHOD}`,
  );

  const patches: BytePatch[] = [
    {
      key: "forge-tutorial-load-code",
      start: status.tutorialCheck.body.codeStart,
      end: status.tutorialCheck.body.codeStart + status.tutorialCheck.body.codeLen,
      data: patchedTutorialCheck,
      detail: "restore completed tutorials from dbSavedGameData when tutorials are checked",
    },
    {
      key: "forge-tutorial-load-code-length",
      start: status.tutorialCheck.body.codeLenPos,
      end: status.tutorialCheck.body.codeStart,
      data: writeU30(patchedTutorialCheck.length),
      detail: "update tutorial-check code length",
    },
    {
      key: "forge-tutorial-save-code",
      start: status.tutorial.body.codeStart,
      end: status.tutorial.body.codeStart + status.tutorial.body.codeLen,
      data: patchedTutorial,
      detail: "persist completed tutorials after tutorial completion",
    },
    {
      key: "forge-tutorial-save-code-length",
      start: status.tutorial.body.codeLenPos,
      end: status.tutorial.body.codeStart,
      data: writeU30(patchedTutorial.length),
      detail: "update interactive tutorial completion code length",
    },
  ];

  const patchedBody = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, patchedBody.body, patchedBody.delta);
  verifySwf(swfPath);
}

function main(): void {
  const args = parseArgs(process.argv);
  if (!fs.existsSync(args.swfPath)) {
    throw new PatchError(`SWF not found: ${args.swfPath}`);
  }
  if (args.verify) {
    verifySwf(args.swfPath);
    return;
  }
  patchSwf(args.swfPath);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
