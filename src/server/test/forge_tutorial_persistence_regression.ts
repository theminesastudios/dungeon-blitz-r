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

assert.equal(
  verification.status,
  0,
  `Forge tutorial persistence verification failed:\n${verification.stdout}${verification.stderr}`,
);
assert.match(
  verification.stdout,
  /Forge tutorial persistence patch verified with lazy restore\./,
  "The served client did not prove completion saving plus verifier-safe lazy restoration",
);

console.log("forge_tutorial_persistence_regression: ok");
