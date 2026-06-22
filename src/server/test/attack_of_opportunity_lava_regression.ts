import { strict as assert } from "assert";
import * as fs from "fs";
import * as path from "path";
import {
  classIndexByName,
  disassemble,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  u30OperandName,
  type AbcParseResult,
  type Instruction,
} from "../scripts/swfPatchUtils";

const CLASS_NAME = "a_Room_JCMission8_10";

function resolveLevelsJcPath(): string {
  const candidates = [
    path.resolve(__dirname, "../../client/content/localhost/p/cbp/LevelsJC.swf"),
    path.resolve(process.cwd(), "src", "client", "content", "localhost", "p", "cbp", "LevelsJC.swf"),
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(resolved, "LevelsJC.swf not found");
  return resolved!;
}

function methodInstructions(methodName: string): { abc: AbcParseResult; instructions: Instruction[] } {
  const ctx = parseSwf(resolveLevelsJcPath());
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, CLASS_NAME);
  assert.notEqual(classIndex, null, `${CLASS_NAME} class not found`);

  const methodIndex = methodIdxForTrait(abc.instances[classIndex!].traits, abc, methodName);
  assert.notEqual(methodIndex, null, `${CLASS_NAME}.${methodName} not found`);

  const methodBody = abc.methodBodies.get(methodIndex!);
  assert.ok(methodBody, `${CLASS_NAME}.${methodName} body not found`);

  const code = ctx.body.subarray(methodBody!.codeStart, methodBody!.codeStart + methodBody!.codeLen);
  return {
    abc,
    instructions: disassemble(code, `${CLASS_NAME}.${methodName}`),
  };
}

function multiname(instruction: Instruction, abc: AbcParseResult): string {
  return u30OperandName(instruction, abc.multinameNames) || "";
}

function callArgCount(instruction: Instruction): number | null {
  return instruction.operands[1]?.[1] ?? null;
}

function hasCallNearProperty(
  instructions: Instruction[],
  abc: AbcParseResult,
  propertyName: string,
  callName: string,
): boolean {
  for (let index = 0; index < instructions.length; index += 1) {
    if (multiname(instructions[index], abc) !== propertyName) {
      continue;
    }

    const end = Math.min(instructions.length, index + 8);
    for (let next = index + 1; next < end; next += 1) {
      if (
        instructions[next].opcode === 0x4f &&
        multiname(instructions[next], abc) === callName &&
        callArgCount(instructions[next]) === 0
      ) {
        return true;
      }
    }
  }

  return false;
}

function callNearPropertyIndexes(
  instructions: Instruction[],
  abc: AbcParseResult,
  propertyName: string,
  callName: string,
): number[] {
  const indexes: number[] = [];

  for (let index = 0; index < instructions.length; index += 1) {
    if (multiname(instructions[index], abc) !== propertyName) {
      continue;
    }

    const end = Math.min(instructions.length, index + 8);
    for (let next = index + 1; next < end; next += 1) {
      if (
        instructions[next].opcode === 0x4f &&
        multiname(instructions[next], abc) === callName &&
        callArgCount(instructions[next]) === 0
      ) {
        indexes.push(next);
        break;
      }
    }
  }

  return indexes;
}

function callPropVoidCount(instructions: Instruction[], abc: AbcParseResult, callName: string): number {
  return instructions.filter((instruction) => instruction.opcode === 0x4f && multiname(instruction, abc) === callName).length;
}

function hasPushShort(instructions: Instruction[], value: number): boolean {
  return instructions.some((instruction) => instruction.opcode === 0x25 && instruction.operands[0]?.[1] === value);
}

function testLavaOffCycleKillsHazards(): void {
  const phaseOne = methodInstructions("UpdatePhaseOne");

  assert.equal(hasPushShort(phaseOne.instructions, 6000), true, "lava off-cycle timer should still run at 6000 ms");
  assert.equal(
    hasCallNearProperty(phaseOne.instructions, phaseOne.abc, "am_FirePitGroup", "Kill"),
    true,
    "Attack Of Opportunity lava off cycle should kill fire pit hazards",
  );
  assert.equal(
    callPropVoidCount(phaseOne.instructions, phaseOne.abc, "Remove"),
    0,
    "Attack Of Opportunity lava off cycle should not only remove fire pit hazards",
  );
}

function testBurnPhaseStillCyclesHazards(): void {
  const phaseTwo = methodInstructions("UpdatePhaseTwo");
  const reviveCalls = callNearPropertyIndexes(phaseTwo.instructions, phaseTwo.abc, "am_FirePitGroup", "Revive");
  const spawnCalls = callNearPropertyIndexes(phaseTwo.instructions, phaseTwo.abc, "am_FirePitGroup", "Spawn");

  assert.equal(
    reviveCalls.length >= 1,
    true,
    "Attack Of Opportunity burn phase should revive fire pit hazards before respawning them",
  );
  assert.equal(
    spawnCalls.length >= 1,
    true,
    "Attack Of Opportunity burn phase should still spawn fire pit hazards",
  );
  assert.equal(
    reviveCalls[0] < spawnCalls[0],
    true,
    "Attack Of Opportunity burn phase should revive fire pit hazards before Spawn",
  );
  assert.equal(
    callPropVoidCount(phaseTwo.instructions, phaseTwo.abc, "Kill") >= 2,
    true,
    "Attack Of Opportunity burn phase should still clear fire pit hazards on defeat and phase end",
  );
}

testLavaOffCycleKillsHazards();
testBurnPhaseStillCyclesHazards();
console.log("attack_of_opportunity_lava_regression passed");
