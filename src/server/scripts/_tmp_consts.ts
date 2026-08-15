import { parseSwf, parseAbc, classIndexByName } from "./swfPatchUtils";

const SWF = "../client/content/localhost/p/cbp/DungeonBlitz.swf";
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);
const names = abc.multinameNames;

const classIdx = classIndexByName(abc, "BuffType")!;
const classTraits = abc.classTraits[classIdx] ?? [];
for (const t of classTraits) {
  const n = t.nameIdx < names.length ? names[t.nameIdx] : `#${t.nameIdx}`;
  let value = "";
  if (t.vkind === 0x01) value = `int=${abc.intValues[t.vindex ?? 0]}`; // ConstInt
  else if (t.vkind === 0x02) value = `uint=${abc.uintValues[t.vindex ?? 0]}`; // ConstUInt
  else if (t.vkind === 0x03) value = `double=${abc.doubleValues[t.vindex ?? 0]}`; // ConstDouble
  else if (t.vkind === 0x04) value = `string=${JSON.stringify(abc.stringValues[t.vindex ?? 0])}`; // ConstString
  else value = `vkind=${t.vkind} vindex=${t.vindex}`;
  console.log(`${n}: ${value}`);
}
