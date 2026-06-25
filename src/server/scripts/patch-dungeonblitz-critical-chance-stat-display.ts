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
const EXPECTED_PATCHED_SEQUENCES = 3;
const MIN_METHOD_43_MAX_STACK = 5;

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
  return instructions.some((inst, index) => (
    isGetLexMath(abc, inst) &&
    instructions[index + 1]?.opcode === 0xd2 &&
    pushByteValue(instructions[index + 2]) === 10 &&
    instructions[index + 3]?.opcode === 0xa2 &&
    isRoundCall(abc, instructions[index + 4]) &&
    pushByteValue(instructions[index + 5]) === 10 &&
    instructions[index + 6]?.opcode === 0xa3
  ));
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
        detail: "round percent display values to one decimal before string formatting",
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
  const firstPass = findCriticalChanceStatPatches(swfPath);
  if (!verifyOnly && firstPass.patches.length > 0) {
    const ctx = parseSwf(swfPath);
    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(ctx.body, firstPass.patches);
    writeSwf(ctx, body, delta);
  }

  const verifyPass = findCriticalChanceStatPatches(swfPath);
  if (verifyPass.oldCount !== 0 || verifyPass.patchedCount !== EXPECTED_PATCHED_SEQUENCES) {
    throw new PatchError(
      `Critical Chance stat display verification failed: old=${verifyPass.oldCount}, patched=${verifyPass.patchedCount}`,
    );
  }
  patchMethod43PercentFormatting(swfPath, verifyOnly);

  console.log(
    `${verifyOnly ? "Verified" : firstPass.patches.length > 0 ? "Patched" : "Already patched"} Critical Chance stat display and percent formatting in ${swfPath}`,
  );
}

if (require.main === module) {
  const { swfPath, verify } = parseArgs(process.argv);
  patchCriticalChanceStatDisplay(swfPath, verify);
}
