import * as path from "path";
import {
  classIndexByName,
  ensureBackup,
  parseAbc,
  parseSwf,
  PatchError,
  writeSwf,
} from "./swfPatchUtils";

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
const ORIGINAL = 0.1;
const PATCHED = 0.13333333333333333;

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
    } else if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { swfPath, verify };
}

function locateRuneConstant(swfPath: string) {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "CombatState");
  if (classIndex === null) throw new PatchError("Could not find CombatState.");
  const trait = (abc.classTraits[classIndex] ?? []).find(
    (entry) => abc.multinameNames[entry.nameIdx] === "const_560",
  );
  if (!trait || trait.vkind !== 0x06 || !trait.vindex) {
    throw new PatchError("Could not resolve CombatState.const_560 as a double constant.");
  }
  const position = abc.doubleValuePositions[trait.vindex];
  if (!position) throw new PatchError("Could not resolve the rune constant position.");
  return { ctx, value: abc.doubleValues[trait.vindex], position };
}

export function patchCriticalChanceRune(swfPath: string, verifyOnly = false): void {
  const located = locateRuneConstant(swfPath);
  if (located.value !== PATCHED) {
    if (verifyOnly) throw new PatchError(`Critical chance rune constant is ${located.value}, expected ${PATCHED}.`);
    if (located.value !== ORIGINAL) {
      throw new PatchError(`Unexpected CombatState.const_560 value: ${located.value}.`);
    }
    const body = Buffer.from(located.ctx.body);
    body.writeDoubleLE(PATCHED, located.position);
    ensureBackup(swfPath);
    writeSwf(located.ctx, body, 0);
  }

  const verified = locateRuneConstant(swfPath);
  if (verified.value !== PATCHED || verified.value * 15 !== 2) {
    throw new PatchError(`Critical chance rune verification failed: ${verified.value} * 15.`);
  }
  console.log(`${verifyOnly ? "Verified" : located.value === PATCHED ? "Already patched" : "Patched"} critical chance rune at 2% in ${swfPath}`);
}

if (require.main === module) {
  const { swfPath, verify } = parseArgs(process.argv);
  patchCriticalChanceRune(swfPath, verify);
}
