import { parseSwf, parseAbc, disassemble, classIndexByName, methodIdxForTrait } from "./swfPatchUtils";

const SWF = "../client/content/localhost/p/cbp/DungeonBlitz.swf";
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);
const names = abc.multinameNames;

const classIdx = classIndexByName(abc, "BuffType")!;
const inst = abc.instances[classIdx];
const instTraits = inst.traits;
const classTraits = abc.classTraits[classIdx] ?? [];
console.log("BuffType instance traits:", instTraits.length, "class(static) traits:", classTraits.length);
for (const t of classTraits) {
  const n = t.nameIdx < names.length ? names[t.nameIdx] : `#${t.nameIdx}`;
  console.log("  static trait:", n, t.methodIdx !== null ? `(method ${t.methodIdx})` : "");
}

// map methodIdx -> its multiname (for callproperty detection) & owner
const methodToName = new Map<number, string>();
for (let i = 0; i < abc.instances.length; i += 1) {
  const inst2 = abc.instances[i];
  const clsName = inst2.classNameIdx < names.length ? names[inst2.classNameIdx] : `cls${i}`;
  for (const t of [...inst2.traits, ...(abc.classTraits[i] ?? [])]) {
    if (t.methodIdx !== null) {
      const tn = t.nameIdx < names.length ? names[t.nameIdx] : `trait${t.nameIdx}`;
      methodToName.set(t.methodIdx, `${clsName}.${tn}`);
    }
  }
}

const targetMethod = new Set<number>();
for (const t of [...instTraits, ...classTraits]) {
  if (t.methodIdx !== null) {
    const n = t.nameIdx < names.length ? names[t.nameIdx] : "";
    if (n === "method_1328" || n === "method_1811") targetMethod.add(t.methodIdx);
  }
}

// Find multiname indices whose name is method_1328 / method_1811
const targetMultinames = new Set<number>();
names.forEach((n, i) => {
  if (n === "method_1328" || n === "method_1811") targetMultinames.add(i);
});

// Walk all methods: callproperty/callstatic/constructprop/getlex etc. referencing those multinames
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

const CALL = 0x62, CALLPROPERTY = 0x46, CALLSTATIC = 0x44, GETLEX = 0x60, FINDPROP = 0x5e,
  FINDPROPSTRICT = 0x5d, CONSTRUCTPROP = 0x4a;

console.log("\n== callers of method_1328 / method_1811 ==");
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
    if ((ins.opcode === CALL || ins.opcode === CALLPROPERTY || ins.opcode === CALLSTATIC || ins.opcode === GETLEX || ins.opcode === FINDPROP || ins.opcode === FINDPROPSTRICT || ins.opcode === CONSTRUCTPROP) &&
        ins.operands[0]?.[0] === "u30" && targetMultinames.has(ins.operands[0][1])) {
      console.log(`${o.label} op${ins.opcode.toString(16)} ${names[ins.operands[0][1]]} @${ins.offset}`);
    }
  }
}
