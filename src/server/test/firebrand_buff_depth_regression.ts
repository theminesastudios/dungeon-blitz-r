import * as path from "path";
import { hasBuffBackVfxDepthGuard } from "../scripts/patch_dungeonblitz_buff_back_vfx_depth";

const repoRoot = path.resolve(__dirname, "../../..");
const dungeonBlitzSwfPath = path.join(repoRoot, "src/client/content/localhost/p/cbp/DungeonBlitz.swf");

function assert(condition: unknown, message: string): void {
  if (!condition) {
    throw new Error(message);
  }
}

assert(
  hasBuffBackVfxDepthGuard(dungeonBlitzSwfPath),
  "DungeonBlitz.swf Buff.UpdatePos must keep back-layer buff VFX behind the owning entity after hit/depth changes",
);

console.log("firebrand_buff_depth_regression passed");
