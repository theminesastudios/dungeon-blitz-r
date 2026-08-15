import * as path from "path";
import {
  readSwfFile,
  characterTagsById,
  readSymbolClasses,
  characterBounds,
} from "./swfLevelUtils";
import { parseSwf, parseAbc, disassemble, classIndexByName, methodIdxForTrait } from "./swfPatchUtils";

const CBP = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp");

// --- UI_1.swf ---
const ui1 = readSwfFile(path.join(CBP, "UI_1.swf"));
const syms1 = readSymbolClasses(ui1);
const byId1 = characterTagsById(ui1);
const orig = syms1.find((b) => b.name === "a_PowerIcon_PoisonDagger");
const clone = syms1.find((b) => b.name === "a_StatusIcon_PoisonDagger");
console.log("UI_1 orig:", orig, "bounds", orig ? characterBounds(ui1, orig.id) : null);
if (clone) {
  const b = characterBounds(ui1, clone.id);
  console.log("UI_1 clone:", clone, "bounds", b, "px", b ? `${((b.xMax - b.xMin) / 20).toFixed(1)}x${((b.yMax - b.yMin) / 20).toFixed(1)}` : null);
}

// --- DungeonBlitz.swf ---
const ctx = parseSwf(path.join(CBP, "DungeonBlitz.swf"));
const abc = parseAbc(ctx);
const si = abc.stringValues.indexOf("a_StatusIcon_PoisonDagger");
const pi = abc.stringValues.indexOf("a_PowerIcon_PoisonDagger");
const ui = abc.stringValues.indexOf("a_StatusIcon_AttackUp");
console.log("DB pool indexes: statusIcon=", si, "powerIcon=", pi, "attackUp=", ui);
const classIdx = classIndexByName(abc, "BuffType")!;
const methodIdx = methodIdxForTrait(
  [...abc.instances[classIdx].traits, ...(abc.classTraits[classIdx] ?? [])],
  abc,
  "method_1811"
)!;
const body = abc.methodBodies.get(methodIdx)!;
const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
const pushed = disassemble(code, "method_1811")
  .filter((i) => i.opcode === 0x2c)
  .map((i) => abc.stringValues[i.operands[0]?.[1] ?? 0]);
console.log("method_1811 pushes:", JSON.stringify(pushed));
