import { execFileSync } from "child_process";
import * as path from "path";

const ROOT = path.resolve(__dirname, "..", "..", "..");
const PATCH_SCRIPT = path.join(ROOT, "src", "server", "scripts", "patch-dungeonblitz-music-mute-position.js");
const SWF_PATH = path.join(ROOT, "src", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf");

execFileSync("node", [PATCH_SCRIPT, "--verify", "--swf", SWF_PATH], {
  cwd: ROOT,
  stdio: "inherit",
});

console.log("music_mute_position_swf_regression passed");
