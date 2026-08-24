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
  readU30,
  writeU30,
  writeSwf,
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

const CRIT_CHANCE_LOCALS = new Set([7, 65]);
const EXPECTED_PATCHED_SEQUENCES = 2;
const EXPECTED_FIXED_RAW_DISPLAYS = 1;
const PRECISE_PERCENT_LOCALS = new Set([8, 13, 14, 15, 16, 66, 71, 72, 73, 74]);
const EXPECTED_PRECISE_PERCENT_SEQUENCES = 15;
const MIN_METHOD_43_MAX_STACK = 5;
const LEGACY_NORMALIZED_BONUS = 0.13333333333333333;
const DISPLAYED_BONUS = 0.1;
const NORMALIZED_BONUS_TRAITS = [
  ["CombatState", "const_466"], // CritDamage gear rune: +10%
  ["class_7", "const_661"], // Pet base bonus: 10% + 1% per level
] as const;

function syncClientRevision(swfPath: string, verifyOnly: boolean): void {
  const indexPath = path.resolve(path.dirname(swfPath), "..", "..", "index.html");
  if (!fs.existsSync(indexPath)) return;
  const revision = `clientrev=swf-${crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12)}`;
  const html = fs.readFileSync(indexPath, "utf8");
  if (html.includes(revision)) return;
  if (verifyOnly) throw new PatchError(`${indexPath} is missing ${revision}.`);
  const next = html.replace(/clientrev=[^&"'`$]+/, revision);
  if (next === html) throw new PatchError(`Could not update clientrev in ${indexPath}.`);
  fs.writeFileSync(indexPath, next, "utf8");
}

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
        "  ts-node src/server/scripts/patch-dungeonblitz-critical-chance-stat-display.ts [--verify] [--swf <path>]",
        "",
        "Patches DungeonBlitz.swf ScreenArmory so the Critical Chance stat page",
        "formats gear/charm proc chance as +16.5% instead of rounded +17%.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function multiname(abc: ReturnType<typeof parseAbc>, inst: Instruction): string | null {
  const operand = inst.operands[0];
  if (!operand || operand[0] !== "u30") {
    return null;
  }
  return abc.multinameNames[operand[1]] ?? null;
}

function localOperand(inst: Instruction): number | null {
  if (inst.opcode >= 0xd0 && inst.opcode <= 0xd3) {
    return inst.opcode - 0xd0;
  }
  const operand = inst.operands[0];
  if (inst.opcode !== 0x62 || !operand || operand[0] !== "u30") {
    return null;
  }
  return operand[1];
}

function pushByteValue(inst: Instruction): number | null {
  const operand = inst.operands[0];
  if (inst.opcode !== 0x24 || !operand || operand[0] !== "s8") {
    return null;
  }
  return operand[1];
}

function isRoundCall(abc: ReturnType<typeof parseAbc>, inst: Instruction): boolean {
  return inst.opcode === 0x46 && multiname(abc, inst) === "round";
}

function isGetLexMath(abc: ReturnType<typeof parseAbc>, inst: Instruction | undefined): boolean {
  return Boolean(inst && inst.opcode === 0x60 && multiname(abc, inst) === "Math");
}

function nops(count: number): Buffer {
  return Buffer.alloc(count, 0x02);
}

function s24(value: number): Buffer {
  const out = Buffer.alloc(3);
  out.writeIntLE(value, 0, 3);
  return out;
}

function inst(opcode: number, ...operands: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from([opcode]), ...operands]);
}

function opU30(opcode: number, value: number): Buffer {
  return inst(opcode, writeU30(value));
}

function opU30U30(opcode: number, first: number, second: number): Buffer {
  return inst(opcode, writeU30(first), writeU30(second));
}

function opS24(opcode: number, value: number): Buffer {
  return inst(opcode, s24(value));
}

function buildInventoryScalePatch(localBytes: Buffer, oldLen: number): Buffer {
  const replacement = Buffer.concat([
    localBytes,
    Buffer.from([0x24, 0x0f, 0xa2]),
  ]);
  if (replacement.length > oldLen) {
    throw new PatchError(`Unexpected Critical Chance replacement length: ${oldLen} -> ${replacement.length}`);
  }
  return Buffer.concat([replacement, nops(oldLen - replacement.length)]);
}

function isScaledInventoryDisplay(instructions: Instruction[], index: number): boolean {
  return (
    pushByteValue(instructions[index + 1]) === 15 &&
    instructions[index + 2]?.opcode === 0xa2 &&
    instructions[index + 3]?.opcode === 0x02
  );
}

function getScreenArmoryMethodBodies(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "ScreenArmory");
  if (classIndex === null) {
    throw new PatchError("Could not find ScreenArmory class.");
  }

  const methodBodies: Array<{
    methodBody: NonNullable<ReturnType<typeof parseAbc>["methodBodies"] extends Map<number, infer T> ? T : never>;
    instructions: Instruction[];
  }> = [];

  const traits = [
    ...abc.instances[classIndex].traits,
    ...(abc.classTraits[classIndex] ?? []),
  ];
  for (const trait of traits) {
    const methodIdx = trait.methodIdx;
    if (methodIdx === null) {
      continue;
    }
    const methodBody = abc.methodBodies.get(methodIdx);
    if (!methodBody) {
      continue;
    }
    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    try {
      methodBodies.push({
        methodBody,
        instructions: disassemble(code, `ScreenArmory.${abc.multinameNames[trait.nameIdx] ?? methodIdx}`),
      });
    } catch {
      continue;
    }
  }

  return { ctx, abc, methodBodies };
}

function findStringIndex(abc: ReturnType<typeof parseAbc>, value: string): number {
  const index = abc.stringValues.findIndex((entry, entryIndex) => entryIndex > 0 && entry === value);
  if (index < 0) {
    throw new PatchError(`Could not find string constant ${JSON.stringify(value)}.`);
  }
  return index;
}

function findMultinameIndex(abc: ReturnType<typeof parseAbc>, value: string, preferred?: number): number {
  if (preferred !== undefined && abc.multinameNames[preferred] === value) {
    return preferred;
  }
  const index = abc.multinameNames.findIndex((entry) => entry === value);
  if (index < 0) {
    throw new PatchError(`Could not find multiname ${JSON.stringify(value)}.`);
  }
  return index;
}

function findMethodBody(
  swfPath: string,
  className: string,
  methodName: string,
): {
  ctx: ReturnType<typeof parseSwf>;
  abc: ReturnType<typeof parseAbc>;
  methodBody: NonNullable<ReturnType<typeof parseAbc>["methodBodies"] extends Map<number, infer T> ? T : never>;
  instructions: Instruction[];
} {
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
    throw new PatchError(`Could not find method body for ${className}.${methodName}.`);
  }
  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  return {
    ctx,
    abc,
    methodBody,
    instructions: disassemble(code, `${className}.${methodName}`),
  };
}

function isFormattedPercentMethod43(instructions: Instruction[], abc: ReturnType<typeof parseAbc>): boolean {
  const roundedLocals = new Set<number>();
  for (let index = 0; index < instructions.length - 6; index += 1) {
    if (
      isGetLexMath(abc, instructions[index]) &&
      (instructions[index + 1]?.opcode === 0xd1 || instructions[index + 1]?.opcode === 0xd2) &&
      pushByteValue(instructions[index + 2]) === 10 &&
      instructions[index + 3]?.opcode === 0xa2 &&
      isRoundCall(abc, instructions[index + 4]) &&
      pushByteValue(instructions[index + 5]) === 10 &&
      instructions[index + 6]?.opcode === 0xa3
    ) {
      roundedLocals.add(instructions[index + 1].opcode - 0xd0);
    }
  }
  return !roundedLocals.has(1) && roundedLocals.has(2);
}

function buildMethod43Code(abc: ReturnType<typeof parseAbc>, currentInstructions: Instruction[]): Buffer {
  const emptyString = findStringIndex(abc, "");
  const plusString = findStringIndex(abc, "+");
  const percentString = findStringIndex(abc, "%");
  const redFontString = findStringIndex(abc, "<font color=\"#FF0000\">");
  const greenFontString = findStringIndex(abc, "<font color=\"#00FF00\">");
  const closeFontString = findStringIndex(abc, "</font>");
  const mathName = findMultinameIndex(abc, "Math");
  const roundName = findMultinameIndex(abc, "round");
  const currentToString = currentInstructions
    .map((entry) => entry.opcode === 0x46 && multiname(abc, entry) === "toString" ? entry.operands[0]?.[1] : undefined)
    .find((entry): entry is number => typeof entry === "number");
  const toStringName = findMultinameIndex(abc, "toString", currentToString);

  const chunks: Buffer[] = [];
  const labels = new Map<string, number>();
  const branches: Array<{ at: number; label: string; opcode: number }> = [];

  function emit(buffer: Buffer): void {
    chunks.push(buffer);
  }

  function offset(): number {
    return chunks.reduce((total, chunk) => total + chunk.length, 0);
  }

  function label(name: string): void {
    labels.set(name, offset());
  }

  function branch(opcode: number, target: string): void {
    branches.push({ at: offset(), label: target, opcode });
    emit(opS24(opcode, 0));
  }

  emit(inst(0xd0)); // getlocal0
  emit(inst(0x30)); // pushscope
  emit(opU30(0x2c, emptyString)); // pushstring ""
  emit(inst(0x85)); // coerce_s
  emit(opU30(0x63, 4)); // setlocal 4
  emit(opU30(0x2c, emptyString)); // pushstring ""
  emit(inst(0x85)); // coerce_s
  emit(opU30(0x63, 5)); // setlocal 5
  emit(inst(0xd3)); // getlocal3
  branch(0x12, "afterPercent"); // iffalse
  emit(opU30(0x2c, plusString));
  emit(inst(0x85));
  emit(opU30(0x63, 4));
  emit(opU30(0x2c, percentString));
  emit(inst(0x85));
  emit(opU30(0x63, 5));
  emit(opU30(0x60, mathName)); // getlex Math
  emit(inst(0xd2)); // getlocal2
  emit(Buffer.from([0x24, 10])); // pushbyte 10
  emit(inst(0xa2)); // multiply
  emit(opU30U30(0x46, roundName, 1)); // callproperty round, 1
  emit(Buffer.from([0x24, 10]));
  emit(inst(0xa3)); // divide
  emit(inst(0xd6)); // setlocal2
  label("afterPercent");
  emit(inst(0xd1)); // getlocal1
  emit(inst(0xd2)); // getlocal2
  branch(0x0e, "afterRed"); // ifngt
  emit(opU30(0x2c, redFontString));
  emit(opU30(0x62, 4));
  emit(inst(0xa0));
  emit(inst(0xd2));
  emit(inst(0xa0));
  emit(opU30(0x62, 5));
  emit(inst(0xa0));
  emit(opU30(0x2c, closeFontString));
  emit(inst(0xa0));
  emit(inst(0x48)); // returnvalue
  label("afterRed");
  emit(inst(0xd1));
  emit(inst(0xd2));
  branch(0x0c, "afterGreen"); // ifnlt
  emit(opU30(0x2c, greenFontString));
  emit(opU30(0x62, 4));
  emit(inst(0xa0));
  emit(inst(0xd2));
  emit(inst(0xa0));
  emit(opU30(0x62, 5));
  emit(inst(0xa0));
  emit(opU30(0x2c, closeFontString));
  emit(inst(0xa0));
  emit(inst(0x48));
  label("afterGreen");
  emit(opU30(0x62, 4));
  emit(inst(0xd2));
  emit(opU30U30(0x46, toStringName, 0));
  emit(inst(0xa0));
  emit(opU30(0x62, 5));
  emit(inst(0xa0));
  emit(inst(0x48));

  const code = Buffer.concat(chunks);
  for (const branchPatch of branches) {
    const target = labels.get(branchPatch.label);
    if (target === undefined) {
      throw new PatchError(`Missing label ${branchPatch.label}.`);
    }
    const relative = target - (branchPatch.at + 4);
    code[branchPatch.at] = branchPatch.opcode;
    s24(relative).copy(code, branchPatch.at + 1);
  }
  return code;
}

function pushStringValue(inst: Instruction, abc: ReturnType<typeof parseAbc>): string | null {
  const operand = inst.operands[0];
  if (inst.opcode !== 0x2c || !operand || operand[0] !== "u30") {
    return null;
  }
  return abc.stringValues[operand[1]] ?? null;
}

function isCallTo(inst: Instruction, abc: ReturnType<typeof parseAbc>, methodName: string, argCount: number): boolean {
  return (
    inst.opcode === 0x46 &&
    multiname(abc, inst) === methodName &&
    inst.operands[1]?.[0] === "u30" &&
    inst.operands[1][1] === argCount
  );
}

function findRawCriticalChanceDisplay(
  swfPath: string,
): { ctx: ReturnType<typeof parseSwf>; patches: BytePatch[]; oldCount: number; fixedCount: number } {
  const { ctx, abc, methodBodies } = getScreenArmoryMethodBodies(swfPath);
  const patches: BytePatch[] = [];
  let oldCount = 0;
  let fixedCount = 0;

  for (const { methodBody, instructions } of methodBodies) {
    for (let index = 0; index < instructions.length - 13; index += 1) {
      const isFixed =
        pushStringValue(instructions[index], abc) === "+" &&
        localOperand(instructions[index + 1]) === 7 &&
        instructions[index + 2].opcode === 0x25 &&
        instructions[index + 2].operands[0]?.[1] === 150 &&
        instructions[index + 3].opcode === 0xa2 &&
        instructions[index + 4].opcode === 0x73 &&
        pushByteValue(instructions[index + 5]) === 10 &&
        instructions[index + 6].opcode === 0xa3 &&
        instructions[index + 7].opcode === 0xa0 &&
        pushStringValue(instructions[index + 8], abc) === "%" &&
        instructions[index + 9].opcode === 0xa0 &&
        instructions[index + 10].opcode === 0x82 &&
        instructions[index + 11].opcode === 0x63 &&
        instructions[index + 11].operands[0]?.[1] === 35;
      if (isFixed) {
        fixedCount += 1;
        continue;
      }

      let startIndex = -1;
      let endIndex = -1;
      let localIndex = -1;
      let setLocalIndex = -1;

      if (
        instructions[index].opcode === 0xd0 &&
        localOperand(instructions[index + 1]) === 7 &&
        pushByteValue(instructions[index + 2]) === 15 &&
        instructions[index + 3].opcode === 0xa2 &&
        instructions[index + 4].opcode === 0x2a &&
        instructions[index + 5].opcode === 0x26 &&
        isCallTo(instructions[index + 6], abc, "method_43", 3) &&
        instructions[index + 7].opcode === 0x82 &&
        instructions[index + 8].opcode === 0x63 &&
        instructions[index + 8].operands[0]?.[1] === 35
      ) {
        startIndex = index;
        endIndex = index + 8;
        while (instructions[endIndex + 1]?.opcode === 0x02) endIndex += 1;
        localIndex = index + 1;
        setLocalIndex = index + 8;
      } else if (
        pushStringValue(instructions[index], abc) !== "+" ||
        localOperand(instructions[index + 1]) !== 7 ||
        pushByteValue(instructions[index + 2]) !== 15 ||
        instructions[index + 3].opcode !== 0xa2 ||
        !instructions.slice(index + 4, index + 9).every((entry) => entry.opcode === 0x02) ||
        instructions[index + 9].opcode !== 0xa0 ||
        pushStringValue(instructions[index + 10], abc) !== "%" ||
        instructions[index + 11].opcode !== 0xa0 ||
        instructions[index + 12].opcode !== 0x82 ||
        instructions[index + 13].opcode !== 0x63 ||
        instructions[index + 13].operands[0]?.[1] !== 35
      ) {
        continue;
      } else {
        startIndex = index;
        endIndex = index + 13;
        localIndex = index + 1;
        setLocalIndex = index + 13;
      }

      const start = instructions[startIndex].offset;
      const end = instructions[endIndex].offset + instructions[endIndex].size;
      const oldLen = end - start;
      const localBytes = ctx.body.subarray(
        methodBody.codeStart + instructions[localIndex].offset,
        methodBody.codeStart + instructions[localIndex].offset + instructions[localIndex].size,
      );
      const setLocalBytes = ctx.body.subarray(
        methodBody.codeStart + instructions[setLocalIndex].offset,
        methodBody.codeStart + instructions[setLocalIndex].offset + instructions[setLocalIndex].size,
      );
      const replacement = Buffer.concat([
        opU30(0x2c, findStringIndex(abc, "+")),
        localBytes,
        opU30(0x25, 150),
        inst(0xa2), // value * 150
        inst(0x73), // convert_i: exact tenths of a percent
        Buffer.from([0x24, 10]),
        inst(0xa3), // divide: integer percentages render without .0
        inst(0xa0),
        opU30(0x2c, findStringIndex(abc, "%")),
        inst(0xa0),
        inst(0x82),
        setLocalBytes,
      ]);
      if (replacement.length > oldLen) {
        throw new PatchError(`Call-free Critical Chance formatter does not fit: ${oldLen} -> ${replacement.length}`);
      }
      oldCount += 1;
      patches.push({
        key: `ScreenArmory.criticalChance.callFreeDisplay.${methodBody.codeStart + start}`,
        start: methodBody.codeStart + start,
        end: methodBody.codeStart + end,
        data: Buffer.concat([replacement, nops(oldLen - replacement.length)]),
        detail: "round Critical Chance to exact tenths without calling another method",
      });
    }
  }
  return { ctx, patches, oldCount, fixedCount };
}

function patchRawCriticalChanceDisplay(swfPath: string, verifyOnly = false): void {
  const firstPass = findRawCriticalChanceDisplay(swfPath);
  if (!verifyOnly && firstPass.patches.length > 0) {
    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(firstPass.ctx.body, firstPass.patches);
    writeSwf(firstPass.ctx, body, delta);
  }
  const verifyPass = findRawCriticalChanceDisplay(swfPath);
  if (verifyPass.oldCount !== 0 || verifyPass.fixedCount !== EXPECTED_FIXED_RAW_DISPLAYS) {
    throw new PatchError(
      `Raw Critical Chance display verification failed: old=${verifyPass.oldCount}, fixed=${verifyPass.fixedCount}`,
    );
  }
}

function findPrecisePercentPatches(
  swfPath: string,
): { ctx: ReturnType<typeof parseSwf>; patches: BytePatch[]; oldCount: number; patchedCount: number } {
  const { ctx, abc, methodBody, instructions } = findMethodBody(swfPath, "ScreenArmory", "method_170");
  const patches: BytePatch[] = [];
  let oldCount = 0;
  let patchedCount = 0;

  for (let index = 0; index < instructions.length; index += 1) {
    const local = localOperand(instructions[index]);
    if (local === null || !PRECISE_PERCENT_LOCALS.has(local)) continue;

    const isPatched =
      instructions[index + 1]?.opcode === 0x25 &&
      instructions[index + 1].operands[0]?.[1] === 1000 &&
      instructions[index + 2]?.opcode === 0xa2 &&
      instructions[index + 3]?.opcode === 0x73 &&
      pushByteValue(instructions[index + 4]) === 10 &&
      instructions[index + 5]?.opcode === 0xa3;
    if (isPatched) {
      patchedCount += 1;
      continue;
    }

    const mathInst = instructions[index - 1];
    const scaleInst = instructions[index + 1];
    const multiplyInst = instructions[index + 2];
    const roundInst = instructions[index + 3];
    if (
      !isGetLexMath(abc, mathInst) ||
      pushByteValue(scaleInst) !== 100 ||
      multiplyInst?.opcode !== 0xa2 ||
      !roundInst ||
      !isRoundCall(abc, roundInst)
    ) {
      continue;
    }

    const start = mathInst.offset;
    const end = roundInst.offset + roundInst.size;
    const oldLen = end - start;
    const localBytes = ctx.body.subarray(
      methodBody.codeStart + instructions[index].offset,
      methodBody.codeStart + instructions[index].offset + instructions[index].size,
    );
    const replacement = Buffer.concat([
      localBytes,
      opU30(0x25, 1000),
      inst(0xa2), // value * 1000
      inst(0x73), // truncate to tenths so the UI never overstates the bonus
      Buffer.from([0x24, 10]),
      inst(0xa3),
    ]);
    if (replacement.length > oldLen) {
      throw new PatchError(`Precise percent formatter for local ${local} does not fit: ${oldLen} -> ${replacement.length}`);
    }

    oldCount += 1;
    patches.push({
      key: `ScreenArmory.precisePercent.local${local}.${methodBody.codeStart + start}`,
      start: methodBody.codeStart + start,
      end: methodBody.codeStart + end,
      data: Buffer.concat([replacement, nops(oldLen - replacement.length)]),
      detail: `display Critical Power/pet bonus local ${local} to one decimal without rounding upward`,
    });
  }

  return { ctx, patches, oldCount, patchedCount };
}

function patchPrecisePercentDisplays(swfPath: string, verifyOnly = false): number {
  const firstPass = findPrecisePercentPatches(swfPath);
  if (!verifyOnly && firstPass.patches.length > 0) {
    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(firstPass.ctx.body, firstPass.patches);
    writeSwf(firstPass.ctx, body, delta);
  }

  const verifyPass = findPrecisePercentPatches(swfPath);
  if (verifyPass.oldCount !== 0 || verifyPass.patchedCount !== EXPECTED_PRECISE_PERCENT_SEQUENCES) {
    throw new PatchError(
      `Critical Power/pet bonus precision verification failed: old=${verifyPass.oldCount}, patched=${verifyPass.patchedCount}`,
    );
  }
  return firstPass.patches.length;
}

function findNormalizedBonusConstantPatches(
  swfPath: string,
): { ctx: ReturnType<typeof parseSwf>; patches: BytePatch[] } {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const patches: BytePatch[] = [];
  const doubleReferenceCounts = new Map<number, number>();
  const addDoubleReference = (index: number | undefined): void => {
    if (index === undefined || index <= 0) return;
    doubleReferenceCounts.set(index, (doubleReferenceCounts.get(index) ?? 0) + 1);
  };
  for (const methodBody of abc.methodBodies.values()) {
    const instructions = disassemble(
      ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen),
      `method.${methodBody.methodIdx}`,
    );
    for (const instruction of instructions) {
      if (instruction.opcode === 0x2f) addDoubleReference(instruction.operands[0]?.[1]);
    }
  }
  for (const traits of [
    ...abc.instances.map((entry) => entry.traits),
    ...abc.classTraits,
    ...abc.scriptTraits,
  ]) {
    for (const trait of traits) {
      if (trait.vkind === 0x06) addDoubleReference(trait.vindex);
    }
  }

  let displayedBonusIndex = abc.doubleValues.findIndex(
    (value, index) => index > 0 && index < 128 && value === DISPLAYED_BONUS,
  );
  if (displayedBonusIndex < 0) {
    displayedBonusIndex = abc.doubleValues.findIndex(
      (_value, index) => index > 0 && index < 128 && (doubleReferenceCounts.get(index) ?? 0) === 0,
    );
    if (displayedBonusIndex < 0) {
      throw new PatchError("Could not find an unused one-byte double-pool slot for the exact 10% bonus.");
    }
    const encodedValue = Buffer.alloc(8);
    encodedValue.writeDoubleLE(DISPLAYED_BONUS);
    patches.push({
      key: "ScreenArmory.normalizedBonus.reusableDouble",
      start: abc.doubleValuePositions[displayedBonusIndex],
      end: abc.doubleValuePositions[displayedBonusIndex] + 8,
      data: encodedValue,
      detail: `reuse unreferenced double ${displayedBonusIndex} for the exact 10% bonus`,
    });
  }

  const targets = NORMALIZED_BONUS_TRAITS.map(([className, traitName]) => {
    const classIndex = classIndexByName(abc, className);
    if (classIndex === null) throw new PatchError(`Could not find ${className}.`);
    const trait = (abc.classTraits[classIndex] ?? []).find(
      (entry) => abc.multinameNames[entry.nameIdx] === traitName,
    );
    if (
      !trait ||
      trait.vkind !== 0x06 ||
      !trait.vindex ||
      trait.vindexPos === undefined ||
      trait.vindexEnd === undefined
    ) {
      throw new PatchError(`Could not resolve ${className}.${traitName} as a double constant.`);
    }
    const classInitMethodIdx = abc.classInitMethodIdxs[classIndex];
    const classInitBody = abc.methodBodies.get(classInitMethodIdx);
    if (!classInitBody) throw new PatchError(`Could not find ${className} class initializer.`);
    const classInitInstructions = disassemble(
      ctx.body.subarray(classInitBody.codeStart, classInitBody.codeStart + classInitBody.codeLen),
      `${className}.cinit`,
    );
    const initializerCandidates = classInitInstructions.filter((instruction, index) => (
      instruction.opcode === 0x2f &&
      multiname(abc, classInitInstructions[index - 1]) === traitName &&
      multiname(abc, classInitInstructions[index + 1]) === traitName
    ));
    if (initializerCandidates.length !== 1) {
      throw new PatchError(`Expected one ${className}.${traitName} runtime initializer, found ${initializerCandidates.length}.`);
    }
    const initializer = initializerCandidates[0];
    const initializerIndex = initializer.operands[0]?.[1];
    if (initializerIndex === undefined) throw new PatchError(`Could not resolve ${className}.${traitName} initializer value.`);
    return {
      className,
      traitName,
      trait,
      value: abc.doubleValues[trait.vindex],
      classInitBody,
      initializer,
      initializerValue: abc.doubleValues[initializerIndex],
    };
  });

  const needsPatch = targets.some(({ value, initializerValue }) => (
    value !== DISPLAYED_BONUS || initializerValue !== DISPLAYED_BONUS
  ));
  if (!needsPatch) return { ctx, patches };
  for (const { className, traitName, value, initializerValue } of targets) {
    if (
      (value !== DISPLAYED_BONUS && value !== LEGACY_NORMALIZED_BONUS) ||
      (initializerValue !== DISPLAYED_BONUS && initializerValue !== LEGACY_NORMALIZED_BONUS)
    ) {
      throw new PatchError(
        `Unexpected ${className}.${traitName} values: trait=${value}, initializer=${initializerValue}.`,
      );
    }
  }

  for (const { className, traitName, trait, value, classInitBody, initializer, initializerValue } of targets) {
    if (trait.vindex !== displayedBonusIndex) {
      patches.push({
        key: `${className}.${traitName}.normalizedBonus`,
        start: trait.vindexPos!,
        end: trait.vindexEnd!,
        data: writeU30(displayedBonusIndex),
        detail: `change ${className}.${traitName} from 13.333% to 10%`,
      });
    }
    if (initializerValue !== DISPLAYED_BONUS) {
      patches.push({
        key: `${className}.${traitName}.runtimeInitializer`,
        start: classInitBody.codeStart + initializer.offset,
        end: classInitBody.codeStart + initializer.offset + initializer.size,
        data: Buffer.concat([Buffer.from([0x2f]), writeU30(displayedBonusIndex)]),
        detail: `initialize ${className}.${traitName} at 10% during runtime`,
      });
    }
  }

  const appendedDisplayedBonusIndex = abc.doubleValues.findIndex(
    (value, index) => index >= 128 && value === DISPLAYED_BONUS,
  );
  if (appendedDisplayedBonusIndex === abc.doubleValues.length - 1) {
    const targetReferenceCount = targets.reduce((count, { trait, initializer }) => (
      count + (trait.vindex === appendedDisplayedBonusIndex ? 1 : 0) +
      (initializer.operands[0]?.[1] === appendedDisplayedBonusIndex ? 1 : 0)
    ), 0);
    if ((doubleReferenceCounts.get(appendedDisplayedBonusIndex) ?? 0) === targetReferenceCount) {
      patches.push(
        {
          key: "ScreenArmory.normalizedBonus.removeAppendedDouble",
          start: abc.doubleValuePositions[appendedDisplayedBonusIndex],
          end: abc.doubleValuePositions[appendedDisplayedBonusIndex] + 8,
          data: Buffer.alloc(0),
          detail: "remove the superseded two-byte-index 10% constant",
        },
        {
          key: "ScreenArmory.normalizedBonus.restoreDoubleCount",
          start: abc.doubleCountPos,
          end: abc.doubleCountEnd,
          data: writeU30(abc.doubleValues.length - 1),
          detail: "restore the ABC double-pool count after migration",
        },
      );
    }
  }

  // A previous patch pass may already have corrected the trait default while
  // leaving the class initializer on the shared legacy constant.
  for (const { className, traitName, classInitBody, initializer, initializerValue } of targets) {
    if (initializerValue === DISPLAYED_BONUS) continue;
    if (patches.some((patch) => patch.key === `${className}.${traitName}.runtimeInitializer`)) continue;
    patches.push({
      key: `${className}.${traitName}.runtimeInitializer`,
      start: classInitBody.codeStart + initializer.offset,
      end: classInitBody.codeStart + initializer.offset + initializer.size,
      data: Buffer.concat([Buffer.from([0x2f]), writeU30(displayedBonusIndex)]),
      detail: `initialize ${className}.${traitName} at 10% during runtime`,
    });
  }

  return { ctx, patches };
}

function patchNormalizedBonusConstants(swfPath: string, verifyOnly = false): number {
  const firstPass = findNormalizedBonusConstantPatches(swfPath);
  if (verifyOnly && firstPass.patches.length > 0) {
    throw new PatchError("Critical Power/pet base constants are still using the legacy 13.333% value.");
  }
  if (!verifyOnly && firstPass.patches.length > 0) {
    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(firstPass.ctx.body, firstPass.patches);
    writeSwf(firstPass.ctx, body, delta);
  }

  const verifyCtx = parseSwf(swfPath);
  const verifyAbc = parseAbc(verifyCtx);
  if (findNormalizedBonusConstantPatches(swfPath).patches.length !== 0) {
    throw new PatchError("Critical Power/pet runtime constants did not verify at 10%.");
  }
  for (const [className, traitName] of NORMALIZED_BONUS_TRAITS) {
    const classIndex = classIndexByName(verifyAbc, className);
    const trait = classIndex === null
      ? undefined
      : (verifyAbc.classTraits[classIndex] ?? []).find(
          (entry) => verifyAbc.multinameNames[entry.nameIdx] === traitName,
        );
    if (!trait?.vindex || verifyAbc.doubleValues[trait.vindex] !== DISPLAYED_BONUS) {
      throw new PatchError(`${className}.${traitName} did not verify at 10%.`);
    }
  }
  const combatStateIndex = classIndexByName(verifyAbc, "CombatState");
  const critChanceTrait = combatStateIndex === null
    ? undefined
    : (verifyAbc.classTraits[combatStateIndex] ?? []).find(
        (entry) => verifyAbc.multinameNames[entry.nameIdx] === "const_560",
      );
  if (!critChanceTrait?.vindex || verifyAbc.doubleValues[critChanceTrait.vindex] !== LEGACY_NORMALIZED_BONUS) {
    throw new PatchError("Critical Chance rune constant was changed while fixing Critical Power.");
  }
  return firstPass.patches.length;
}

function patchMethod43PercentFormatting(swfPath: string, verifyOnly = false): void {
  const { ctx, abc, methodBody, instructions } = findMethodBody(swfPath, "ScreenArmory", "method_43");
  if (!isFormattedPercentMethod43(instructions, abc)) {
    if (verifyOnly) {
      throw new PatchError("ScreenArmory.method_43 percent formatting is not patched.");
    }
    const newCode = buildMethod43Code(abc, instructions);
    const oldCodeLenBytes = writeU30(methodBody.codeLen);
    const [maxStack, maxStackEnd] = readU30(ctx.body, methodBody.maxStackPos, "ScreenArmory.method_43.max_stack");
    const patches: BytePatch[] = [
      {
        key: "ScreenArmory.method_43.code",
        start: methodBody.codeStart,
        end: methodBody.codeStart + methodBody.codeLen,
        data: newCode,
        detail: "round comparison percent values to one decimal before string formatting",
      },
      {
        key: "ScreenArmory.method_43.codeLen",
        start: methodBody.codeLenPos,
        end: methodBody.codeLenPos + oldCodeLenBytes.length,
        data: writeU30(newCode.length),
        detail: `ScreenArmory.method_43 code_length ${methodBody.codeLen} -> ${newCode.length}`,
      },
    ];
    if (maxStack < MIN_METHOD_43_MAX_STACK) {
      patches.push({
        key: "ScreenArmory.method_43.maxStack",
        start: methodBody.maxStackPos,
        end: maxStackEnd,
        data: writeU30(MIN_METHOD_43_MAX_STACK),
        detail: `ScreenArmory.method_43 max_stack ${maxStack} -> ${MIN_METHOD_43_MAX_STACK}`,
      });
    }
    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, body, delta);
  }

  const verifyPass = findMethodBody(swfPath, "ScreenArmory", "method_43");
  if (!isFormattedPercentMethod43(verifyPass.instructions, verifyPass.abc)) {
    throw new PatchError("ScreenArmory.method_43 percent formatting verification failed.");
  }
}

function findCriticalChanceStatPatches(swfPath: string): { patches: BytePatch[]; oldCount: number; patchedCount: number } {
  const { ctx, abc, methodBodies } = getScreenArmoryMethodBodies(swfPath);
  const patches: BytePatch[] = [];
  let oldCount = 0;
  let patchedCount = 0;

  for (const { methodBody, instructions } of methodBodies) {
    for (let index = 0; index < instructions.length - 3; index += 1) {
      const previousInst = instructions[index - 1];
      const localInst = instructions[index];
      const scaleInst = instructions[index + 1];
      const multiplyInst = instructions[index + 2];
      const roundInst = instructions[index + 3];
      const local = localOperand(localInst);
      if (local === null || !CRIT_CHANCE_LOCALS.has(local)) {
        continue;
      }

      if (isScaledInventoryDisplay(instructions, index)) {
        patchedCount += 1;
        continue;
      }

      const localBytes = ctx.body.subarray(
        methodBody.codeStart + localInst.offset,
        methodBody.codeStart + localInst.offset + localInst.size,
      );

      if (
        pushByteValue(scaleInst) === 15 &&
        multiplyInst.opcode === 0xa2 &&
        roundInst.opcode === 0x02 &&
        instructions[index + 4]?.opcode === 0x02 &&
        instructions[index + 5]?.opcode === 0x02
      ) {
        const firstNop = instructions[index - 2];
        if (!firstNop || firstNop.opcode !== 0x02 || previousInst?.opcode !== 0x02) {
          throw new PatchError(`Unexpected patched Critical Chance stale-stack shape for local ${local}.`);
        }
        const oldLen =
          firstNop.size +
          previousInst.size +
          localInst.size +
          scaleInst.size +
          multiplyInst.size +
          roundInst.size +
          instructions[index + 4].size +
          instructions[index + 5].size;
        const scaledReplacement = buildInventoryScalePatch(localBytes, oldLen);
        oldCount += 1;
        patches.push({
          key: `ScreenArmory.criticalChance.rawStaleScale.local${local}.${methodBody.codeStart + firstNop.offset}`,
          start: methodBody.codeStart + firstNop.offset,
          end: methodBody.codeStart + instructions[index + 5].offset + instructions[index + 5].size,
          data: scaledReplacement,
          detail: `display Critical Chance local ${local} after scaling by 15`,
        });
        continue;
      }

      if (
        !isGetLexMath(abc, previousInst) ||
        (pushByteValue(scaleInst) !== 100 && pushByteValue(scaleInst) !== 15) ||
        multiplyInst.opcode !== 0xa2 ||
        !isRoundCall(abc, roundInst)
      ) {
        continue;
      }

      const oldLen = previousInst.size + localInst.size + scaleInst.size + multiplyInst.size + roundInst.size;
      const scaledReplacement = buildInventoryScalePatch(localBytes, oldLen);

      oldCount += 1;
      patches.push({
        key: `ScreenArmory.criticalChance.statScale.local${local}.${methodBody.codeStart + scaleInst.offset}`,
        start: methodBody.codeStart + previousInst.offset,
        end: methodBody.codeStart + roundInst.offset + roundInst.size,
        data: scaledReplacement,
        detail: `scale Critical Chance local ${local} by 15 and keep the displayed decimal`,
      });
    }
  }

  return { patches, oldCount, patchedCount };
}

export function patchCriticalChanceStatDisplay(swfPath: string, verifyOnly = false): void {
  const normalizedBonusPatchCount = patchNormalizedBonusConstants(swfPath, verifyOnly);
  const firstPass = findCriticalChanceStatPatches(swfPath);
  if (!verifyOnly && firstPass.patches.length > 0) {
    const ctx = parseSwf(swfPath);
    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(ctx.body, firstPass.patches);
    writeSwf(ctx, body, delta);
  }

  patchRawCriticalChanceDisplay(swfPath, verifyOnly);
  const precisePercentPatchCount = patchPrecisePercentDisplays(swfPath, verifyOnly);

  const verifyPass = findCriticalChanceStatPatches(swfPath);
  if (verifyPass.oldCount !== 0 || verifyPass.patchedCount !== EXPECTED_PATCHED_SEQUENCES) {
    throw new PatchError(
      `Critical Chance stat display verification failed: old=${verifyPass.oldCount}, patched=${verifyPass.patchedCount}`,
    );
  }
  patchMethod43PercentFormatting(swfPath, verifyOnly);
  syncClientRevision(swfPath, verifyOnly);

  console.log(
    `${verifyOnly ? "Verified" : firstPass.patches.length + precisePercentPatchCount + normalizedBonusPatchCount > 0 ? "Patched" : "Already patched"} Critical Chance, Critical Power, and pet bonus stat formatting in ${swfPath}`,
  );
}

if (require.main === module) {
  const { swfPath, verify } = parseArgs(process.argv);
  patchCriticalChanceStatDisplay(swfPath, verify);
}
