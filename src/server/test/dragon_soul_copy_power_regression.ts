import * as path from "path";
import { hasDragonSoulCopyPowerPatch } from "../scripts/patch-dungeonblitz-dragon-soul-copy-power";

const repoRoot = path.resolve(__dirname, "../../..");
const dungeonBlitzSwfPath = path.join(repoRoot, "src/client/content/localhost/p/cbp/DungeonBlitz.swf");

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  hasDragonSoulCopyPowerPatch(dungeonBlitzSwfPath),
  "DungeonBlitz.swf ActivePower.method_872 must make Dragon Soul copy triggering basic ranged attacks only",
);

console.log("dragon_soul_copy_power_regression passed");
