import { parseSwf, parseAbc, classIndexByName } from "./swfPatchUtils";

const SWF = "../client/content/localhost/p/cbp/DungeonBlitz.swf";
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);
const names = abc.multinameNames;

const classIdx = classIndexByName(abc, "BuffType")!;
console.log("BuffType classIdx:", classIdx);
const classTraits = abc.classTraits[classIdx] ?? [];
console.log("class traits:", classTraits.length);

for (const t of classTraits) {
  const tn = t.nameIdx < names.length ? names[t.nameIdx] : `trait${t.nameIdx}`;
  if (!tn.startsWith("const_")) continue;
  let value: string;
  if (t.vkind === 0x01) value = `int=${abc.intValues[t.vindex ?? 0]}`;
  else if (t.vkind === 0x02) value = `uint=${abc.uintValues[t.vindex ?? 0]}`;
  else if (t.vkind === 0x03) value = `double=${abc.doubleValues[t.vindex ?? 0]}`;
  else if (t.vkind === 0x04) value = `string=${JSON.stringify(abc.stringValues[t.vindex ?? 0])}`;
  else value = `vkind=${t.vkind} vindex=${t.vindex}`;
  console.log(`${tn}: ${value}`);
}
