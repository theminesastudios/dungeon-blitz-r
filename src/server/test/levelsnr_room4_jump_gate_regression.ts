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

const CLASS_NAME = "a_Room_Tutorial_04";
const METHOD_NAME = "WaitingForJump";

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

function testJumpPhaseRequiresJumpTriggerBeforeDropPhase(): void {
  const ctx = parseSwf(resolveLevelsNrPath());
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, CLASS_NAME);
  assert.notEqual(classIndex, null, `${CLASS_NAME} class not found`);

  const methodIdx = methodIdxForTrait(abc.instances[classIndex!].traits, abc, METHOD_NAME);
  assert.notEqual(methodIdx, null, `${CLASS_NAME}.${METHOD_NAME} not found`);

  const methodBody = abc.methodBodies.get(methodIdx!);
  assert.ok(methodBody, `${CLASS_NAME}.${METHOD_NAME} body not found`);

  const code = ctx.body.subarray(methodBody!.codeStart, methodBody!.codeStart + methodBody!.codeLen);
  const instructions = disassemble(code, `${CLASS_NAME}.${METHOD_NAME}`);

  let sawFallGate = false;
    let sawJumpGate = false;
  let sawTimerGate = false;

  for (let i = 0; i + 1 < instructions.length; i += 1) {
    const inst = instructions[i];
    const next = instructions[i + 1];
    if (next.opcode !== 0x46) {
      continue;
    }

    const callName = u30OperandName(next, abc.multinameNames) || "";
    const triggerName = u30OperandName(inst, abc.stringValues) || "";
    if (callName === "OnTrigger" && triggerName === "am_Trigger_Fall2") {
      sawFallGate = true;
    }
    if (callName === "OnTrigger" && triggerName === "am_Trigger_2") {
      sawJumpGate = true;
    }
    if (callName === "AtTime") {
      sawTimerGate = true;
    }
  }

  assert.equal(sawFallGate, true, "Jump tutorial should keep its initial fall trigger gate");
  assert.equal(sawJumpGate, true, "Jump tutorial should complete on am_Trigger_2 before the drop trigger path");
  assert.equal(sawTimerGate, false, "Jump tutorial should not auto-advance on a timer");
}

function main(): void {
  testJumpPhaseRequiresJumpTriggerBeforeDropPhase();
  console.log("levelsnr_room4_jump_gate_regression: ok");
}

main();
