import * as fs from "fs";
import { strict as assert } from "assert";
import * as path from "path";
import {
  classIndexByName,
  disassemble,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  u30OperandName,
} from "../scripts/swfPatchUtils";

function resolveLevelsNrPath(): string {
  const candidates = [
    path.resolve(__dirname, "../../client/content/localhost/p/cbp/LevelsNR.swf"),
    path.resolve(process.cwd(), "src", "client", "content", "localhost", "p", "cbp", "LevelsNR.swf"),
    path.resolve(__dirname, "../../../client/content/localhost/p/cbp/LevelsNR.swf"),
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate));
  assert.ok(resolved, "LevelsNR.swf not found");
  return resolved!;
}

function getMethodInstructions(className: string, methodName: string) {
  const ctx = parseSwf(resolveLevelsNrPath());
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, className);
  assert.notEqual(classIndex, null, `${className} class not found`);

  const methodIdx = methodIdxForTrait(abc.instances[classIndex!].traits, abc, methodName);
  assert.notEqual(methodIdx, null, `${className}.${methodName} not found`);

  const methodBody = abc.methodBodies.get(methodIdx!);
  assert.ok(methodBody, `${className}.${methodName} body not found`);

  const code = ctx.body.subarray(methodBody!.codeStart, methodBody!.codeStart + methodBody!.codeLen);
  return {
    abc,
    instructions: disassemble(code, `${className}.${methodName}`),
  };
}

function testHardGoblinBeachRoomTwoGateHasDefeatFallback(): void {
  const update = getMethodInstructions("a_Room_GoblinBeachHard_02", "UpdateSummonWaveOne");
  let sawRoomCleared = false;
  let sawFallbackCall = false;
  let sawGateCollisionOpen = false;
  let sawAggro = false;

  for (const instruction of update.instructions) {
    const name = u30OperandName(instruction, update.abc.multinameNames) || "";
    const stringValue = u30OperandName(instruction, update.abc.stringValues) || "";
    sawRoomCleared ||= name === "RoomCleared";
    sawFallbackCall ||= name === "RoomTwoGateCanOpen";
    sawGateCollisionOpen ||= stringValue === "am_DynamicCollision_GateBlock";
    sawAggro ||= name === "Aggro";
  }

  assert.equal(sawRoomCleared, true, "room 2 should keep the original RoomCleared gate path");
  assert.equal(sawFallbackCall, true, "room 2 should also open from the explicit hard enemy defeat fallback");
  assert.equal(sawGateCollisionOpen, true, "room 2 should still open the authored gate collision");
  assert.equal(sawAggro, true, "room 2 should keep its authored scout aggro");

  const fallback = getMethodInstructions("a_Room_GoblinBeachHard_02", "RoomTwoGateCanOpen");
  const defeatedCalls = fallback.instructions
    .map((instruction) => u30OperandName(instruction, fallback.abc.multinameNames) || "")
    .filter((name) => name === "Defeated");

  assert.equal(defeatedCalls.length, 4, "room 2 fallback should check all four authored hard-room gate enemies");
}

function testHardGoblinBeachRoomOneRemovesStrayDoorGoblin(): void {
  const init = getMethodInstructions("a_Room_GoblinBeachHard_01", "InitRoom");
  const initNames = init.instructions.map((instruction) => u30OperandName(instruction, init.abc.multinameNames) || "");
  assert.equal(initNames.includes("RemoveRoomOneStrayDoorGoblin"), false, "room 1 diagnostic enemy removal should be gone");

  const update = getMethodInstructions("a_Room_GoblinBeachHard_01", "UpdateIntro");
  let aggroCount = 0;
  let sawHealthGate = false;
  let sawFliersPhase = false;

  for (const instruction of update.instructions) {
    const name = u30OperandName(instruction, update.abc.multinameNames) || "";
    if (name === "Aggro") {
      aggroCount++;
    }
    sawHealthGate ||= name === "Health";
    sawFliersPhase ||= name === "UpdateFliers";
  }

  assert.equal(aggroCount >= 3, true, "room 1 intro enemies should be restored");
  assert.equal(sawHealthGate, true, "room 1 health gate should be restored");
  assert.equal(sawFliersPhase, true, "room 1 flier phase should be restored");

  const fliers = getMethodInstructions("a_Room_GoblinBeachHard_01", "UpdateFliers");
  let sawFlierSpawnOrAggro = false;
  for (const instruction of fliers.instructions) {
    const name = u30OperandName(instruction, fliers.abc.multinameNames) || "";
    sawFlierSpawnOrAggro ||= name === "Spawn" || name === "Aggro";
  }
  assert.equal(sawFlierSpawnOrAggro, true, "room 1 flier phase enemies should be restored");
}

function testHardGoblinBeachRoomEightGateHasDefeatFallback(): void {
  const update = getMethodInstructions("a_Room_GoblinBeachHard_08", "Update");
  let sawRoomCleared = false;
  let sawFallbackCall = false;
  let sawPathCollisionOpen = false;

  for (const instruction of update.instructions) {
    const name = u30OperandName(instruction, update.abc.multinameNames) || "";
    const stringValue = u30OperandName(instruction, update.abc.stringValues) || "";
    sawRoomCleared ||= name === "RoomCleared";
    sawFallbackCall ||= name === "RoomEightGateCanOpen";
    sawPathCollisionOpen ||= stringValue === "am_DynamicCollision_PathBlock02";
  }

  assert.equal(sawRoomCleared, true, "room 8 should keep the original RoomCleared gate path");
  assert.equal(sawFallbackCall, true, "room 8 should also open from the explicit hard enemy defeat fallback");
  assert.equal(sawPathCollisionOpen, true, "room 8 should still open the authored path blocker");

  const fallback = getMethodInstructions("a_Room_GoblinBeachHard_08", "RoomEightGateCanOpen");
  const defeatedCalls = fallback.instructions
    .map((instruction) => u30OperandName(instruction, fallback.abc.multinameNames) || "")
    .filter((name) => name === "Defeated");

  assert.equal(defeatedCalls.length, 5, "room 8 fallback should check all five authored hard-room gate enemies");
}

function main(): void {
  testHardGoblinBeachRoomOneRemovesStrayDoorGoblin();
  testHardGoblinBeachRoomTwoGateHasDefeatFallback();
  testHardGoblinBeachRoomEightGateHasDefeatFallback();
  console.log("levelsnr_hard_goblinbeach_gate_regression: ok");
}

main();
