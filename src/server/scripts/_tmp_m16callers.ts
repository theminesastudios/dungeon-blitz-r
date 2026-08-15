import { parseSwf, parseAbc, disassemble } from "./swfPatchUtils";

const SWF = "../client/content/localhost/p/cbp/DungeonBlitz.swf";
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);
const names = abc.multinameNames;

const m16 = names.indexOf("method_16");
console.log("method_16 multiname idx:", m16);

const owners: Array<{ label: string; methodIdx: number }> = [];
for (let i = 0; i < abc.instances.length; i += 1) {
  const inst = abc.instances[i];
  const clsName = inst.classNameIdx < names.length ? names[inst.classNameIdx] : `cls${i}`;
  for (const t of [...inst.traits, ...(abc.classTraits[i] ?? [])]) {
    if (t.methodIdx !== null) {
      const tn = t.nameIdx < names.length ? names[t.nameIdx] : `trait${t.nameIdx}`;
      owners.push({ label: `${clsName}.${tn}`, methodIdx: t.methodIdx });
    }
  }
}
for (const [methodIdx] of abc.methodBodies) {
  if (!owners.some((o) => o.methodIdx === methodIdx)) owners.push({ label: `(anon ${methodIdx})`, methodIdx });
}

for (const o of owners) {
  const body = abc.methodBodies.get(o.methodIdx);
  if (!body) continue;
  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  let insts;
  try {
    insts = disassemble(code, o.label);
  } catch {
    continue;
  }
  for (const ins of insts) {
    if ((ins.opcode === 0x46 || ins.opcode === 0x4f) && ins.operands[0]?.[0] === "u30" && ins.operands[0][1] === m16) {
      console.log(`${o.label} calls method_16 @${ins.offset} argc=${ins.operands[1]?.[1] ?? "?"}`);
    }
  }
}

// also: any getDefinitionByName / getDefinition calls with a_PowerIcon_ prefix strings
const dgn = names.indexOf("getDefinitionByName");
const gd = names.indexOf("getDefinition");
console.log("\ngetDefinitionByName idx:", dgn, "getDefinition idx:", gd);
for (const o of owners) {
  const body = abc.methodBodies.get(o.methodIdx);
  if (!body) continue;
  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  let insts;
  try {
    insts = disassemble(code, o.label);
  } catch {
    continue;
  }
  for (const ins of insts) {
    if ((ins.opcode === 0x46 || ins.opcode === 0x4f) && ins.operands[0]?.[0] === "u30" &&
        (ins.operands[0][1] === dgn || ins.operands[0][1] === gd)) {
      console.log(`${o.label} calls ${names[ins.operands[0][1]]} @${ins.offset}`);
    }
  }
}
