import { parseSwf, parseAbc } from "./swfPatchUtils";

const SWF = "../client/content/localhost/p/cbp/DungeonBlitz.swf";
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);

for (const s of ["a_PowerIcon_PoisonDagger", "a_StatusIcon_Poisoned", "a_StatusIcon_SpeedDown", "a_StatusIcon_AttackUp", "a_StatusIcon_SpeedUp"]) {
  const idx = abc.stringValues.indexOf(s);
  console.log(`${s}: ${idx < 0 ? "NOT in pool" : `pool idx ${idx}`}`);
}

const used: string[] = [];
for (let i = 1; i < abc.stringValues.length; i += 1) {
  const s = abc.stringValues[i];
  if (s.startsWith("a_StatusIcon_")) used.push(s);
}
console.log("\na_StatusIcon_* strings in DungeonBlitz.swf pool:");
console.log([...new Set(used)].join("\n"));
