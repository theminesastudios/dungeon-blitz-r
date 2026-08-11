/// <reference types="node" />

import { strict as assert } from "assert";
import { spawnSync } from "child_process";
import * as path from "path";

const serverRoot = path.resolve(__dirname, "..");
const patchScript = path.join(
  serverRoot,
  "scripts",
  "patch-dungeonblitz-forge-tutorial-persistence.ts",
);

const verification = spawnSync(
  process.execPath,
  [
    "-r",
    path.join(serverRoot, "node_modules", "ts-node", "register", "transpile-only"),
    patchScript,
    "--verify",
  ],
  {
    cwd: serverRoot,
    encoding: "utf8",
    env: process.env,
  },
);

assert.notEqual(
  verification.status,
  0,
  "The crash-inducing Forge tutorial persistence patch must stay disabled",
);
assert.match(
  `${verification.stdout}${verification.stderr}`,
  /Forge tutorial persistence is incomplete: restore=false persist=false/,
  "The served client unexpectedly carries a partial or unknown Forge tutorial patch state",
);

const refusedApply = spawnSync(
  process.execPath,
  [
    "-r",
    path.join(serverRoot, "node_modules", "ts-node", "register", "transpile-only"),
    patchScript,
  ],
  {
    cwd: serverRoot,
    encoding: "utf8",
    env: { ...process.env, DB_FORGE_TUTORIAL_PATCH_ANYWAY: "" },
  },
);

assert.notEqual(refusedApply.status, 0, "The known-crashing Forge tutorial patch must refuse normal application");
assert.match(
  `${refusedApply.stdout}${refusedApply.stderr}`,
  /this patch makes the client drop its connection on world enter/,
);

console.log("forge_tutorial_persistence_regression: disabled crash patch confirmed");
