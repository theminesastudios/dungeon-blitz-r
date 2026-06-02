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
  let sawOpenGateCall = false;
  let sawScoutAggro = false;

  for (let index = 0; index + 1 < update.instructions.length; index += 1) {
    const instruction = update.instructions[index];
    const next = update.instructions[index + 1];
    const name = u30OperandName(instruction, update.abc.multinameNames) || "";
    const nextName = u30OperandName(next, update.abc.multinameNames) || "";
    sawRoomCleared ||= name === "RoomCleared";
    sawFallbackCall ||= name === "RoomTwoGateCanOpen";
    sawOpenGateCall ||= name === "OpenRoomTwoGate";
    sawScoutAggro ||= name === "am_Scout" && nextName === "Aggro";
  }

  assert.equal(sawRoomCleared, true, "room 2 should keep the original RoomCleared gate path");
  assert.equal(sawFallbackCall, true, "room 2 should also open from the explicit hard enemy defeat fallback");
  assert.equal(sawOpenGateCall, true, "room 2 summon phase should open through the explicit gate helper");
  assert.equal(sawScoutAggro, false, "room 2 should not aggro the untouchable door-side scout");

  const idleUpdate = getMethodInstructions("a_Room_GoblinBeachHard_02", "Update");
  const idleNames = idleUpdate.instructions.map((instruction) => u30OperandName(instruction, idleUpdate.abc.multinameNames) || "");
  assert.equal(idleNames.includes("OpenRoomTwoGate"), true, "room 2 idle phase should also open through the explicit gate helper");

  const gateOpen = getMethodInstructions("a_Room_GoblinBeachHard_02", "OpenRoomTwoGate");
  let sawGateCollisionOpen = false;
  let sawAnimateGate = false;
  for (const instruction of gateOpen.instructions) {
    const name = u30OperandName(instruction, gateOpen.abc.multinameNames) || "";
    const stringValue = u30OperandName(instruction, gateOpen.abc.stringValues) || "";
    sawGateCollisionOpen ||= stringValue === "am_DynamicCollision_GateBlock";
    sawAnimateGate ||= name === "Animate";
  }
  assert.equal(sawGateCollisionOpen, true, "room 2 gate helper should open the authored gate collision");
  assert.equal(sawAnimateGate, true, "room 2 gate helper should animate the gate");

  const fallback = getMethodInstructions("a_Room_GoblinBeachHard_02", "RoomTwoGateCanOpen");
  const fallbackNames = fallback.instructions.map((instruction) => u30OperandName(instruction, fallback.abc.multinameNames) || "");
  assert.equal(fallbackNames.includes("am_Scout"), false, "room 2 fallback should not wait for removed am_Scout");
  assert.equal(fallbackNames.includes("am_Mage1"), true, "room 2 fallback should keep am_Mage1");
  assert.equal(fallbackNames.includes("am_Add1"), true, "room 2 fallback should keep am_Add1");
  assert.equal(fallbackNames.includes("am_Add2"), true, "room 2 fallback should keep am_Add2");
  assert.equal(fallbackNames.filter((name) => name === "RoomTwoEnemyCleared").length, 3, "room 2 fallback should check the three remaining authored hard-room gate enemies");

  const enemyCleared = getMethodInstructions("a_Room_GoblinBeachHard_02", "RoomTwoEnemyCleared");
  const enemyClearedNames = enemyCleared.instructions.map((instruction) => u30OperandName(instruction, enemyCleared.abc.multinameNames) || "");
  assert.equal(enemyClearedNames.includes("Defeated"), true, "room 2 enemy clear check should accept Defeated()");
  assert.equal(enemyClearedNames.includes("Health"), true, "room 2 enemy clear check should also accept Health() < 1");

  const init = getMethodInstructions("a_Room_GoblinBeachHard_02", "InitRoom");
  const initNames = init.instructions.map((instruction) => u30OperandName(instruction, init.abc.multinameNames) || "");
  assert.equal(initNames.includes("RemoveRoomTwoDoorScout"), true, "room 2 should remove am_Scout during InitRoom");

  const removal = getMethodInstructions("a_Room_GoblinBeachHard_02", "RemoveRoomTwoDoorScout");
  const removalNames = removal.instructions.map((instruction) => u30OperandName(instruction, removal.abc.multinameNames) || "");
  assert.equal(removalNames.includes("am_Scout"), true, "room 2 removal helper should target am_Scout");
  assert.equal(removalNames.includes("Remove"), true, "room 2 removal helper should remove am_Scout from the room runtime");
  assert.equal(removalNames.includes("removeChild"), true, "room 2 removal helper should remove am_Scout from display");

  const frame1 = getMethodInstructions("a_Room_GoblinBeachHard_02", "frame1");
  const frameStrings = frame1.instructions
    .map((instruction) => u30OperandName(instruction, frame1.abc.stringValues) || "")
    .filter(Boolean);
  assert.equal(frameStrings.includes("1 Scout <Cheer> Now!!!"), false, "room 2 summon script should not reference removed am_Scout");
  assert.equal(frameStrings.includes("1 SpawnCue Mage1"), true, "room 2 summon script should still spawn Mage1");
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

function testHardGoblinBeachRoomSixGateHasAmbushFallback(): void {
  const intro = getMethodInstructions("a_Room_GoblinBeachHard_06", "UpdateIntro");
  const introNames = intro.instructions.map((instruction) => u30OperandName(instruction, intro.abc.multinameNames) || "");
  assert.equal(introNames.includes("OnTrigger"), true, "room 6 should keep the authored trigger-volume ambush start");
  assert.equal(introNames.includes("RoomSixChestBroken"), true, "room 6 should also start the ambush when the chest is broken");
  assert.equal(introNames.includes("StartRoomSixAmbush"), true, "room 6 intro should enter the ambush through the shared start helper");

  const chestBroken = getMethodInstructions("a_Room_GoblinBeachHard_06", "RoomSixChestBroken");
  const chestBrokenNames = chestBroken.instructions.map((instruction) => u30OperandName(instruction, chestBroken.abc.multinameNames) || "");
  assert.equal(chestBrokenNames.includes("am_Chest"), true, "room 6 chest helper should inspect am_Chest");
  assert.equal(chestBrokenNames.includes("Defeated"), true, "room 6 chest helper should accept Defeated()");
  assert.equal(chestBrokenNames.includes("Health"), true, "room 6 chest helper should also accept Health() < 1");

  const start = getMethodInstructions("a_Room_GoblinBeachHard_06", "StartRoomSixAmbush");
  const startNames = start.instructions.map((instruction) => u30OperandName(instruction, start.abc.multinameNames) || "");
  assert.equal(startNames.includes("PlayScript"), true, "room 6 ambush start should play the opening scene");
  assert.equal(startNames.includes("UpdateAmbush"), true, "room 6 ambush start should switch into UpdateAmbush");

  const ambush = getMethodInstructions("a_Room_GoblinBeachHard_06", "UpdateAmbush");
  const ambushNames = ambush.instructions.map((instruction) => u30OperandName(instruction, ambush.abc.multinameNames) || "");
  assert.equal(ambushNames.includes("Group"), true, "room 6 should keep the authored ambush group path");
  assert.equal(ambushNames.includes("RoomSixAmbushCleared"), true, "room 6 should also use the explicit ambush clear fallback");
  assert.equal(ambushNames.includes("OpenRoomSixGate"), true, "room 6 should open the gate directly after the ambush is cleared");

  const fallback = getMethodInstructions("a_Room_GoblinBeachHard_06", "RoomSixAmbushCleared");
  const fallbackNames = fallback.instructions.map((instruction) => u30OperandName(instruction, fallback.abc.multinameNames) || "");
  assert.equal(fallbackNames.includes("bRoomSixAmbushSpawned"), true, "room 6 fallback should wait until the ambush has actually spawned");
  assert.equal(fallbackNames.filter((name) => name === "RoomSixEnemyCleared").length, 6, "room 6 fallback should check all six ambush enemies");
  assert.equal(fallbackNames.includes("am_Mob1"), true, "room 6 fallback should check am_Mob1");
  assert.equal(fallbackNames.includes("am_Mob6"), true, "room 6 fallback should check am_Mob6");

  const enemyCleared = getMethodInstructions("a_Room_GoblinBeachHard_06", "RoomSixEnemyCleared");
  const enemyClearedNames = enemyCleared.instructions.map((instruction) => u30OperandName(instruction, enemyCleared.abc.multinameNames) || "");
  assert.equal(enemyClearedNames.includes("Defeated"), true, "room 6 enemy clear check should accept Defeated()");
  assert.equal(enemyClearedNames.includes("Health"), false, "room 6 enemy clear fallback should not open from transient zero health");
  assert.equal(enemyClearedNames.includes("Boolean"), true, "room 6 enemy clear check should not treat missing held-spawn enemies as cleared");

  const gateOpen = getMethodInstructions("a_Room_GoblinBeachHard_06", "OpenRoomSixGate");
  let sawGateCollisionOpen = false;
  let sawAnimateGate = false;
  let sawNullPhase = false;
  for (const instruction of gateOpen.instructions) {
    const name = u30OperandName(instruction, gateOpen.abc.multinameNames) || "";
    const stringValue = u30OperandName(instruction, gateOpen.abc.stringValues) || "";
    sawGateCollisionOpen ||= stringValue === "am_DynamicCollision_Gate";
    sawAnimateGate ||= name === "Animate";
    sawNullPhase ||= name === "SetPhase";
  }
  assert.equal(sawGateCollisionOpen, true, "room 6 gate helper should open the spike gate collision");
  assert.equal(sawAnimateGate, true, "room 6 gate helper should animate the gate");
  assert.equal(sawNullPhase, true, "room 6 gate helper should stop phase logic after opening");
}

function testHardGoblinBeachRoomEightGateHasDefeatFallback(): void {
  const update = getMethodInstructions("a_Room_GoblinBeachHard_08", "Update");
  let sawRoomCleared = false;
  let sawFallbackCall = false;
  let sawAmbushStarted = false;
  let sawRemoveCall = false;
  let sawPathCollisionOpen = false;

  for (const instruction of update.instructions) {
    const name = u30OperandName(instruction, update.abc.multinameNames) || "";
    const stringValue = u30OperandName(instruction, update.abc.stringValues) || "";
    sawRoomCleared ||= name === "RoomCleared";
    sawFallbackCall ||= name === "RoomEightGateCanOpen";
    sawAmbushStarted ||= name === "bRoomEightAmbushStarted";
    sawRemoveCall ||= name === "RemoveRoomEightPedestalGoblin";
    sawPathCollisionOpen ||= stringValue === "am_DynamicCollision_PathBlock02";
  }

  assert.equal(sawRoomCleared, true, "room 8 should keep the original RoomCleared gate path");
  assert.equal(sawFallbackCall, true, "room 8 should also open from the explicit hard enemy defeat fallback");
  assert.equal(sawAmbushStarted, true, "room 8 should remember when the ambush trigger starts");
  assert.equal(sawRemoveCall, true, "room 8 should remove the broken pedestal goblin once active enemies are cleared");
  assert.equal(sawPathCollisionOpen, true, "room 8 should still open the authored path blocker");

  const init = getMethodInstructions("a_Room_GoblinBeachHard_08", "InitRoom");
  const initNames = init.instructions.map((instruction) => u30OperandName(instruction, init.abc.multinameNames) || "");
  assert.equal(initNames.includes("RemoveRoomEightPedestalGoblin"), true, "room 8 should remove the pedestal goblin during InitRoom");

  const removal = getMethodInstructions("a_Room_GoblinBeachHard_08", "RemoveRoomEightPedestalGoblin");
  const removalNames = removal.instructions.map((instruction) => u30OperandName(instruction, removal.abc.multinameNames) || "");
  assert.equal(removalNames.includes("am_Gob1"), true, "room 8 removal helper should target am_Gob1");
  assert.equal(removalNames.includes("Remove"), true, "room 8 removal helper should remove am_Gob1 from the room runtime");
  assert.equal(removalNames.includes("removeChild"), true, "room 8 removal helper should remove am_Gob1 from display");

  const startMages = getMethodInstructions("a_Room_GoblinBeachHard_08", "StartRoomEightMages");
  const startMageNames = startMages.instructions.map((instruction) => u30OperandName(instruction, startMages.abc.multinameNames) || "");
  assert.equal(startMageNames.includes("am_Mage1"), true, "room 8 mage start helper should target am_Mage1");
  assert.equal(startMageNames.includes("am_Mage2"), true, "room 8 mage start helper should target am_Mage2");
  assert.equal(startMageNames.filter((name) => name === "Aggro").length, 2, "room 8 mage start helper should aggro both shamans");

  const frontLine = getMethodInstructions("a_Room_GoblinBeachHard_08", "RoomEightFrontLineCleared");
  const frontLineNames = frontLine.instructions.map((instruction) => u30OperandName(instruction, frontLine.abc.multinameNames) || "");
  assert.equal(frontLineNames.includes("am_Gob2"), true, "room 8 front-line fallback should include am_Gob2");
  assert.equal(frontLineNames.includes("am_Gob3"), true, "room 8 front-line fallback should include am_Gob3");

  const activeEnemies = getMethodInstructions("a_Room_GoblinBeachHard_08", "RoomEightActiveEnemiesCleared");
  const activeEnemyNames = activeEnemies.instructions.map((instruction) => u30OperandName(instruction, activeEnemies.abc.multinameNames) || "");
  assert.equal(activeEnemyNames.includes("am_Gob2"), true, "room 8 active clear fallback should include am_Gob2");
  assert.equal(activeEnemyNames.includes("am_Gob3"), true, "room 8 active clear fallback should include am_Gob3");
  assert.equal(activeEnemyNames.includes("am_Mage1"), true, "room 8 active clear fallback should include am_Mage1");
  assert.equal(activeEnemyNames.includes("am_Mage2"), true, "room 8 active clear fallback should include am_Mage2");

  const fallback = getMethodInstructions("a_Room_GoblinBeachHard_08", "RoomEightGateCanOpen");
  const fallbackCalls = fallback.instructions
    .map((instruction) => u30OperandName(instruction, fallback.abc.multinameNames) || "")
    .filter((name) => name === "RoomEightEnemyCleared");

  const fallbackNames = fallback.instructions.map((instruction) => u30OperandName(instruction, fallback.abc.multinameNames) || "");
  assert.equal(fallbackCalls.length, 0, "room 8 gate fallback should not require the removed am_Gob1");
  assert.equal(fallbackNames.includes("RoomEightActiveEnemiesCleared"), true, "room 8 gate fallback should require the active enemy group");
  assert.equal(fallbackNames.includes("am_Gob1"), false, "room 8 gate fallback should not reference removed am_Gob1");

  const frame1 = getMethodInstructions("a_Room_GoblinBeachHard_08", "frame1");
  const frameStrings = frame1.instructions
    .map((instruction) => u30OperandName(instruction, frame1.abc.stringValues) || "")
    .filter(Boolean);
  assert.equal(frameStrings.some((value) => value.includes("Gob1 <PullLever>")), false, "room 8 ambush script should not reference removed am_Gob1");
  assert.equal(frameStrings.includes("2 SpawnCue Mage1"), true, "room 8 ambush script should still spawn Mage1");

  const enemyCleared = getMethodInstructions("a_Room_GoblinBeachHard_08", "RoomEightEnemyCleared");
  const enemyClearedNames = enemyCleared.instructions.map((instruction) => u30OperandName(instruction, enemyCleared.abc.multinameNames) || "");
  assert.equal(enemyClearedNames.includes("Defeated"), true, "room 8 enemy clear check should accept Defeated()");
  assert.equal(enemyClearedNames.includes("Health"), true, "room 8 enemy clear check should also accept Health() < 1");
  assert.equal(enemyClearedNames.includes("Boolean"), true, "room 8 enemy clear check should not treat missing held-spawn enemies as cleared");
}

function main(): void {
  testHardGoblinBeachRoomOneRemovesStrayDoorGoblin();
  testHardGoblinBeachRoomTwoGateHasDefeatFallback();
  testHardGoblinBeachRoomSixGateHasAmbushFallback();
  testHardGoblinBeachRoomEightGateHasDefeatFallback();
  console.log("levelsnr_hard_goblinbeach_gate_regression: ok");
}

main();
