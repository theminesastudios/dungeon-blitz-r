import { parseSwf, parseAbc, disassemble, classIndexByName, methodIdxForTrait } from "./swfPatchUtils";

const SWF = "../client/content/localhost/p/cbp/DungeonBlitz.swf";
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);
const names = abc.multinameNames;

const classIdx = classIndexByName(abc, "BuffType")!;
const inst = abc.instances[classIdx];
const traits = [...inst.traits, ...(abc.classTraits[classIdx] ?? [])];
const methodIdx = methodIdxForTrait(traits, abc, "method_1811")!;
const body = abc.methodBodies.get(methodIdx)!;
const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
const insts = disassemble(code, "BuffType.method_1811");

// find the lookupswitch
const sw = insts.find((i) => i.opcode === 0x1b)!;
console.log("lookupswitch at", sw.offset, "operands:", JSON.stringify(sw.operands));
const swEnd = sw.offset + sw.size;
console.log("switch end:", swEnd);
const targets = sw.operands.slice(2).map(([k, v]) => swEnd + v);
console.log("default target:", swEnd + sw.operands[0][1]);
console.log("case targets:", targets.join(", "));

// dump instructions at each target
const fmt = (inst: { opcode: number; offset: number; operands: Array<[string, number]> }): string => {
  const operands = inst.operands
    .map(([k, v]) => (k === "u30" && v < names.length ? names[v] : v))
    .join(", ");
  let extra = "";
  if (inst.opcode === 0x2c && inst.operands[0]?.[0] === "u30") {
    const si = inst.operands[0][1];
    if (si < abc.stringValues.length) extra = `   # ${JSON.stringify(abc.stringValues[si])}`;
  }
  return `@${inst.offset} op${inst.opcode.toString(16)} ${operands}${extra}`;
};

const seen = new Set<number>();
for (const t of [...new Set(targets), swEnd + sw.operands[0][1]]) {
  const idx = insts.findIndex((i) => i.offset === t);
  if (idx < 0 || seen.has(t)) continue;
  seen.add(t);
  console.log(`\n-- target @${t} --`);
  for (let i = idx; i < Math.min(insts.length, idx + 8); i += 1) {
    console.log("  " + fmt(insts[i]));
  }
}
