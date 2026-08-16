import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  disassemble,
  ensureBackup,
  parseAbc,
  parseSwf,
  PatchError,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";
import type { AbcParseResult, Instruction, SwfContext } from "./swfPatchUtils";

const DEFAULT_SWF = path.resolve(
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

const INDEX_HTML = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "index.html");

// The realm drop-location table in DungeonBlitz.swf (the same `var_32` map the
// server's GameData.loadGearDropLocationMaps extracts) assigns each
// realm+level gear set to the one dungeon it drops in. The gear sheet placed
// the Black Rose Mire Devourers (realm "Devourer", level 8) in the Great Green
// Svath dungeon; issue #715 moves them to Mystery of the Yornak.
const REALM_KEY = "Devourer8";
const OLD_DUNGEON = "SRN_Mission7"; // The Great Green Svath
const NEW_DUNGEON = "SRN_Mission2"; // Mystery of the Yornak

const OP_GETLEX = 0x60;
const OP_PUSHSTRING = 0x2c;
const OP_SETPROPERTY = 0x61;

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npx ts-node src/server/scripts/patch-dungeonblitz-devourer-drop-location.ts [--verify] [--swf <path>]",
        "",
        "Moves the Black Rose Mire Devourer (Devourer8) gear drop dungeon in",
        "DungeonBlitz.swf from SRN_Mission7 (Svath) to SRN_Mission2 (Yornak),",
        "issue #715. The realm drop-location map entry is repointed to the",
        "existing 'SRN_Mission2' string-pool constant, so the patch is",
        "same-size and the client gear tooltip shows the same dungeon.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function readOperand(inst: Instruction | undefined, index = 0): number | null {
  const value = inst?.operands?.[index]?.[1];
  return Number.isFinite(value) ? Number(value) : null;
}

interface RealmEntry {
  levelIndex: number; // pushstring string-pool index of the dungeon level
  levelName: string;
  operandOffset: number; // file offset of the level pushstring operand
  operandWidth: number; // encoded byte width of that operand
  methodIdx: number;
  instIdx: number;
}

function findRealmEntry(swf: SwfContext, abc: AbcParseResult, key: string): RealmEntry | null {
  for (const methodBody of abc.methodBodies.values()) {
    const code = swf.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    let instructions: Instruction[];
    try {
      instructions = disassemble(code, `devourer-drop-location:${methodBody.methodIdx}`);
    } catch {
      continue;
    }

    for (let index = 0; index + 3 < instructions.length; index += 1) {
      const mapInst = instructions[index];
      const keyInst = instructions[index + 1];
      const levelInst = instructions[index + 2];
      const setInst = instructions[index + 3];
      if (
        mapInst.opcode !== OP_GETLEX ||
        keyInst.opcode !== OP_PUSHSTRING ||
        levelInst.opcode !== OP_PUSHSTRING ||
        setInst.opcode !== OP_SETPROPERTY
      ) {
        continue;
      }

      const mapName = abc.multinameNames[readOperand(mapInst) ?? -1] ?? "";
      if (mapName !== "var_32") {
        continue;
      }

      const keyIndex = readOperand(keyInst) ?? -1;
      if (abc.stringValues[keyIndex] !== key) {
        continue;
      }

      const levelIndex = readOperand(levelInst) ?? -1;
      if (levelIndex < 0 || levelIndex >= abc.stringValues.length) {
        continue;
      }

      return {
        levelIndex,
        levelName: abc.stringValues[levelIndex],
        operandOffset: methodBody.codeStart + levelInst.offset + 1,
        operandWidth: levelInst.size - 1,
        methodIdx: methodBody.methodIdx,
        instIdx: index,
      };
    }
  }
  return null;
}

function stringPoolIndex(abc: AbcParseResult, value: string): number | null {
  const matches: number[] = [];
  for (let index = 1; index < abc.stringValues.length; index += 1) {
    if (abc.stringValues[index] === value) {
      matches.push(index);
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/**
 * Moves index.html's cache-busting token to match the SWF that was just
 * written, so the browser does not keep serving the stale cached SWF.
 */
function syncClientRev(swfPath: string): void {
  if (path.resolve(swfPath) !== DEFAULT_SWF || !fs.existsSync(INDEX_HTML)) {
    return;
  }
  const digest = crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const updated = html.replace(/clientrev=[^&`"'$]+/, `clientrev=swf-${digest}`);
  if (updated !== html) {
    fs.writeFileSync(INDEX_HTML, updated);
    console.log(`  index.html clientrev -> swf-${digest} (cache buster)`);
  }
}

function patchSwf(swfPath: string, verify: boolean): void {
  const swf = parseSwf(swfPath);
  const abc = parseAbc(swf);

  const entry = findRealmEntry(swf, abc, REALM_KEY);
  if (!entry) {
    throw new PatchError(`Could not find the ${REALM_KEY} realm drop-location entry in the SWF.`);
  }

  if (entry.levelName === NEW_DUNGEON) {
    if (verify) {
      console.log(`Devourer drop dungeon verified: ${REALM_KEY} -> ${NEW_DUNGEON} (Yornak).`);
      return;
    }
    console.log(`${swfPath}: already patched (${REALM_KEY} drops in ${NEW_DUNGEON}).`);
    return;
  }

  if (entry.levelName !== OLD_DUNGEON) {
    throw new PatchError(
      `Unexpected ${REALM_KEY} drop dungeon "${entry.levelName}" (expected "${OLD_DUNGEON}" or "${NEW_DUNGEON}").`,
    );
  }

  if (verify) {
    throw new PatchError(
      `Devourer drop dungeon patch missing: ${REALM_KEY} still drops in ${OLD_DUNGEON} (Svath).`,
    );
  }

  const newLevelIndex = stringPoolIndex(abc, NEW_DUNGEON);
  if (newLevelIndex === null) {
    throw new PatchError(`String-pool entry "${NEW_DUNGEON}" must exist exactly once.`);
  }

  const newOperand = writeU30(newLevelIndex);
  if (newOperand.length !== entry.operandWidth) {
    throw new PatchError(
      `Operand width changed (${entry.operandWidth} -> ${newOperand.length}); same-size repoint expected.`,
    );
  }

  ensureBackup(swfPath);
  newOperand.copy(swf.body, entry.operandOffset);
  writeSwf(swf, swf.body, 0);
  syncClientRev(swfPath);

  const afterSwf = parseSwf(swfPath);
  const afterEntry = findRealmEntry(afterSwf, parseAbc(afterSwf), REALM_KEY);
  if (!afterEntry || afterEntry.levelName !== NEW_DUNGEON) {
    throw new PatchError("Devourer drop dungeon patch did not verify after write.");
  }

  console.log(
    `${swfPath}: ${REALM_KEY} gear drops now in ${NEW_DUNGEON} (Yornak) instead of ${OLD_DUNGEON} (Svath).`,
  );
}

const args = parseArgs(process.argv);
patchSwf(args.swfPath, args.verify);
