#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
const { execFileSync } = require("child_process");

const scriptPath = path.join(__dirname, "patch-dungeonblitz-game-method1325-superanim-crash-guard.ts");
const repoRoot = path.resolve(__dirname, "..", "..", "..");
const localTsNode = path.join(repoRoot, "src", "server", "node_modules", ".bin", "ts-node");

execFileSync(fs.existsSync(localTsNode) ? localTsNode : "npx", [
    ...(fs.existsSync(localTsNode) ? [] : ["ts-node"]),
    scriptPath,
    ...process.argv.slice(2),
], {
    cwd: repoRoot,
    stdio: "inherit",
});
