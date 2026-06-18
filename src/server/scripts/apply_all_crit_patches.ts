import * as fs from "fs";
import * as path from "path";
import { patchCriticalChanceStatDisplay } from "./patch-dungeonblitz-critical-chance-stat-display";
import { main as patchSwzMain } from "./patch_gameswz_critical_charm_proc_chance";

const SWF_PATH = path.resolve(
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

async function run() {
  console.log("--- Starting Local Patching Process ---");

  // 1. Patch DungeonBlitz.swf
  console.log(`[SWF] Patching ${SWF_PATH}...`);
  try {
    if (!fs.existsSync(SWF_PATH)) {
        console.error(`[SWF] Error: ${SWF_PATH} not found.`);
    } else {
        patchCriticalChanceStatDisplay(SWF_PATH);
        console.log("[SWF] Patching complete.");
    }
  } catch (error) {
    console.error("[SWF] Patching failed:", error);
  }

  // 2. Patch Game.swz files (and Charms.json / CharmTypes.xml)
  console.log("[SWZ] Patching game assets...");
  try {
    const changes = patchSwzMain([]);
    console.log(`[SWZ] Patching complete. Applied ${changes} data changes.`);
  } catch (error) {
    console.error("[SWZ] Patching failed:", error);
  }

  console.log("--- Patching Process Finished ---");
}

if (require.main === module) {
    run().catch(console.error);
}
