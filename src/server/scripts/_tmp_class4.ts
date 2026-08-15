import { parseSwf, parseAbc, disassemble, classIndexByName, methodIdxForTrait } from "./swfPatchUtils";

const SWF = "../client/content/localhost/p/cbp/DungeonBlitz.swf";
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);
const names = abc.multinameNames;

const classIdx = classIndexByName(abc, "class_4");
if (classIdx !== null) {
  const inst = abc.instances[classIdx];
  const traits = [...inst.traits, ...(abc.classTraits[classIdx] ?? [])];
  console.log("class_4 traits:");
  for (const t of traits) {
    const n = t.nameIdx < names.length ? names[t.nameIdx] : `#${t.nameIdx}`;
    console.log("  ", n, t.methodIdx !== null ? `(method ${t.methodIdx})` : "");
  }
  const m16 = methodIdxForTrait(traits, abc, "method_16");
  if (m16 !== null) {
    const body = abc.methodBodies.get(m16)!;
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const insts = disassemble(code, "class_4.method_16");
    console.log(`\nclass_4.method_16: ${body.codeLen} bytes, ${insts.length} insts`);
    for (const inst of insts) {
      const operands = inst.operands
        .map(([k, v]) => (k === "u30" && v < names.length ? names[v] : v))
        .join(", ");
      let extra = "";
      if (inst.opcode === 0x2c && inst.operands[0]?.[0] === "u30") {
        const si = inst.operands[0][1];
        if (si < abc.stringValues.length) extra = `   # ${JSON.stringify(abc.stringValues[si])}`;
      }
      console.log(`@${inst.offset} op${inst.opcode.toString(16)} ${operands}${extra}`);
    }
  }
}

// Pool strings of length 12 and 24 with reference counts (how many multinames/strings use them)
const strUse = new Map<number, number>();
abc.stringValues.forEach((s, i) => { if (s.length === 12 || s.length === 24) strUse.set(i, 0); });
abc.multinameNames.forEach((n, i) => { if (n.length === 12 || n.length === 24) { const idx = abc.stringValues.indexOf(n); if (idx > 0) strUse.set(idx, (strUse.get(idx) ?? 0) + 1); } });
// count instructions pushing each string
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
const pushCount = new Map<number, number>();
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
    if (ins.opcode === 0x2c && ins.operands[0]?.[0] === "u30") {
      const si = ins.operands[0][1];
      if (strUse.has(si)) pushCount.set(si, (pushCount.get(si) ?? 0) + 1);
    }
  }
}

console.log("\n== pool strings of length 12 ==");
for (const [i, cnt] of [...strUse.entries()].filter(([, c]) => abc.stringValues[c] === undefined ? false : abc.stringValues[c].length === 12).sort((a, b) => a[0] - b[0])) {
  const s = abc.stringValues[i];
  if (s.length !== 12) continue;
  console.log(`  [${i}] ${JSON.stringify(s)} mnRefs=${strUse.get(i)} pushRefs=${pushCount.get(i) ?? 0}`);
}
console.log("\n== pool strings of length 24 ==");
for (const [i, cnt] of [...strUse.entries()].sort((a, b) => a[0] - b[0])) {
  const s = abc.stringValues[i];
  if (s.length !== 24) continue;
  console.log(`  [${i}] ${JSON.stringify(s)} mnRefs=${strUse.get(i)} pushRefs=${pushCount.get(i) ?? 0}`);
}
