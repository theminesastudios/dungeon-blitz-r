import * as path from "path";
import { classIndexByName, disassemble, methodIdxForTrait, parseAbc, parseSwf, u30OperandName } from "./swfPatchUtils";

const SWF = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf");
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);
const ci = classIndexByName(abc, "CombatState")!;
const mi = methodIdxForTrait(abc.instances[ci].traits, abc, "method_322")!;
const body = abc.methodBodies.get(mi)!;
const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
const ins = disassemble(code, "method_322");

const plague = ins.findIndex((i) => i.opcode === 0x2c && abc.stringValues[i.operands[0]?.[1] ?? -1] === "PlagueBattalion");
const nextGoto = ins.findIndex((i, idx) => idx > plague && i.opcode === 0x10);
const startIndex = ins.findIndex((i, idx) => idx > plague && i.opcode === 0x62 && i.operands[0]?.[1] === 8);

console.log(`plague=${plague} startIndex=${startIndex} nextGoto=${nextGoto}`);
console.log(`startIndex-2 off=${ins[startIndex - 2].offset}  nextGoto off=${ins[nextGoto].offset}  width(stale)=${ins[nextGoto].offset - ins[startIndex - 2].offset}  width(nonstale)=${ins[nextGoto].offset - ins[startIndex].offset}`);

for (let i = plague; i <= nextGoto; i += 1) {
  const inst = ins[i];
  const name = u30OperandName(inst, abc.multinameNames) || "";
  const ops = inst.operands.map((o) => o[1]).join(",");
  const mark = i === startIndex ? " <== startIndex(getlocal8)" : i === startIndex - 2 ? " <== startIndex-2" : i === nextGoto ? " <== nextGoto" : "";
  console.log(`[${i}] off=${inst.offset} size=${inst.size} op=0x${inst.opcode.toString(16).padStart(2, "0")} ops=[${ops}] name=${name}${mark}`);
}
