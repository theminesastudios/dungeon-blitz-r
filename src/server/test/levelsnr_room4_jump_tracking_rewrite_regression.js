const { strict: assert } = require("assert");
const path = require("path");
const fs = require("fs");

function main() {
  const repoRoot = path.resolve(__dirname, "..", "..", "..");
  const scriptPath = path.join(repoRoot, "src", "server", "scripts", "patch_levelsnr_room4_jump_training_rewrite.js");
  const source = fs.readFileSync(scriptPath, "utf8");

  assert.match(source, /OnJumpTrainingEnterFrame/, "patch script should inject ENTER_FRAME jump tracking");
  assert.match(source, /bDidGroundSnap/, "patch script should use grounded flag tracking");
  assert.match(source, /Number\(param1\.physPosY\) >= this\.jumpGroundY - this\.jumpGroundedEpsilon/, "patch script should keep Y-threshold fallback");
  assert.match(source, /WaitingForJump still depends on am_Trigger_2/, "patch script should verify the old trigger gate is gone");
  console.log("levelsnr_room4_jump_tracking_rewrite_regression: ok");
}

main();
