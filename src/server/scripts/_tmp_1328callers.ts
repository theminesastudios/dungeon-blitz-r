import { parseSwf, parseAbc, disassemble } from "./swfPatchUtils";

const SWF = "../client/content/localhost/p/cbp/DungeonBlitz.swf";
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);
const names = abc.multinameNames;

const classIdx1328 = (() => {
  for (let i = 0; i < abc.instances.length; i += 1) {
    if (abc.instances[i].classNameIdx < names.length && names[abc.instances[i].classNameIdx] === "BuffType") return i;
  }
  return -1;
})();
const inst = abc.instances[classIdx1328];
const traits = [...inst.traits, ...(abc.classTraits[classIdx1328] ?? [])];
const methodIdx1328 = traits.find((t) => t.methodIdx !== null && names[t.nameIdx] === "method_1328")?.methodIdx ?? -1;
const methodIdx1811 = traits.find((t) => t.methodIdx !== null && names[t.nameIdx] === "method_1811")?.methodIdx ?? -1;
console.log("method_1328 idx:", methodIdx1328, "method_1811 idx:", methodIdx1811);

const owners: Array<{ label: string; methodIdx: number }> = [];
for (let i = 0; i < abc.instances.length; i += 1) {
  const inst2 = abc.instances[i];
  const clsName = inst2.classNameIdx < names.length ? names[inst2.classNameIdx] : `cls${i}`;
  for (const t of [...inst2.traits, ...(abc.classTraits[i] ?? [])]) {
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
    if ((ins.opcode === 0x46 || ins.opcode === 0x4f) && ins.operands[0]?.[0] === "u30") {
      const mn = ins.operands[0][1];
      const nm = mn < names.length ? names[mn] : "";
      if (nm === "method_1328" || nm === "method_1811") {
        console.log(`${o.label} calls ${nm} @${ins.offset}`);
      }
    }
  }
}
