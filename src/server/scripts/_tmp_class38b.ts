import { parseSwf, parseAbc, disassemble, classIndexByName, methodIdxForTrait } from "./swfPatchUtils";

const SWF = "../client/content/localhost/p/cbp/DungeonBlitz.swf";
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);
const names = abc.multinameNames;
const strings = abc.stringValues;

const classIdx = classIndexByName(abc, "class_38")!;
const inst = abc.instances[classIdx];
const traits = [...inst.traits, ...(abc.classTraits[classIdx] ?? [])];
console.log("class_38 traits:", traits.map((t) => names[t.nameIdx]).join(", "));

const var76 = names.indexOf("var_76");
const buffIcon = names.indexOf("BuffIcon");

for (const t of traits) {
  if (t.methodIdx === null) continue;
  const body = abc.methodBodies.get(t.methodIdx);
  if (!body) continue;
  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  let insts;
  try {
    insts = disassemble(code, `class_38.${names[t.nameIdx]}`);
  } catch {
    continue;
  }
  for (const ins of insts) {
    if (
      ((ins.opcode === 0x66 || ins.opcode === 0x61 || ins.opcode === 0x68) &&
        ins.operands[0]?.[0] === "u30" &&
        (ins.operands[0][1] === var76 || ins.operands[0][1] === buffIcon)) ||
      (ins.opcode === 0x2c && ins.operands[0]?.[0] === "u30" && ins.operands[0][1] < strings.length &&
        strings[ins.operands[0][1]].startsWith("a_"))
    ) {
      const si = ins.opcode === 0x2c ? ins.operands[0][1] : -1;
      console.log(
        `class_38.${names[t.nameIdx]} @${ins.offset} ${ins.opcode === 0x66 ? "get" : ins.opcode === 0x61 ? "set" : ins.opcode === 0x68 ? "init" : "pushstr"} ${si >= 0 ? JSON.stringify(strings[si]) : names[ins.operands[0]?.[1]] ?? ins.operands[0]?.[1]}`,
      );
    }
  }
}
