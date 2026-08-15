import { parseSwf, parseAbc, disassemble, classIndexByName, methodIdxForTrait } from "./swfPatchUtils";

const SWF = "../client/content/localhost/p/cbp/DungeonBlitz.swf";
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);
const names = abc.multinameNames;

const scaleX = names.indexOf("scaleX");
const scaleY = names.indexOf("scaleY");
console.log("scaleX:", scaleX, "scaleY:", scaleY);

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

console.log("-- scaleX/scaleY accesses --");
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
    if ((ins.opcode === 0x66 || ins.opcode === 0x61) && ins.operands[0]?.[0] === "u30" &&
        (ins.operands[0][1] === scaleX || ins.operands[0][1] === scaleY)) {
      console.log(`${o.label} ${ins.opcode === 0x66 ? "get" : "set"} ${names[ins.operands[0][1]]} @${ins.offset}`);
    }
  }
}

// class_4.method_16 callers
const class4Idx = classIndexByName(abc, "class_4")!;
const class4Traits = [...abc.instances[class4Idx].traits, ...(abc.classTraits[class4Idx] ?? [])];
const m16 = methodIdxForTrait(class4Traits, abc, "method_16");
console.log("\nclass_4.method_16 methodIdx:", m16);
if (m16 !== null) {
  console.log("-- callers of class_4.method_16 --");
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
      if (ins.opcode === 0x46 && ins.operands[0]?.[0] === "u30" && ins.operands[0][1] === names.indexOf("method_16")) {
        console.log(`${o.label} @${ins.offset}`);
      }
    }
  }
}
