import { parseSwf, parseAbc, disassemble } from "./swfPatchUtils";

const SWF = "../client/content/localhost/p/cbp/DungeonBlitz.swf";
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);
const names = abc.multinameNames;

const amIconGroup = names.indexOf("am_IconGroup");
const getDefinition = names.indexOf("getDefinition");
const hasDefinition = names.indexOf("hasDefinition");
console.log("am_IconGroup mn:", amIconGroup, "getDefinition mn:", getDefinition, "hasDefinition mn:", hasDefinition);

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
  let usesIconGroup = false;
  let usesGetDef = false;
  for (const ins of insts) {
    if (ins.operands[0]?.[0] === "u30") {
      const idx = ins.operands[0][1];
      if (idx === amIconGroup) usesIconGroup = true;
      if (idx === getDefinition || idx === hasDefinition) usesGetDef = true;
    }
  }
  if (usesIconGroup) {
    console.log(`${o.label} uses am_IconGroup${usesGetDef ? "  <-- ALSO getDefinition/hasDefinition" : ""}`);
  }
}
