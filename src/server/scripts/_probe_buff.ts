import * as path from "path";
import { classIndexByName, parseAbc, parseSwf } from "./swfPatchUtils";

const SWF = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf");

const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);

function findClass(name: string): number | null {
  for (let i = 0; i < abc.instances.length; i++) {
    const ci = abc.instances[i];
    if (abc.multinameNames[ci.classNameIdx] === name) return i;
  }
  return null;
}

for (const cls of ["Buff", "CombatState"]) {
  const idx = findClass(cls);
  if (idx === null) { console.log(`${cls}: not found`); continue; }
  const traits = abc.instances[idx].traits;
  console.log(`\n${cls}: ${traits.length} traits`);
  for (const t of traits) {
    const name = abc.multinameNames[t.nameIdx];
    if (name === "var_1209" || name === "var_1188" || name === "var_7" || name === "var_4" || name === "powerTypes") {
      const typeName = t.typeNameIdx !== undefined ? abc.multinameNames[t.typeNameIdx] : "?";
      console.log(`  ${name}: nameIdx=${t.nameIdx} kindId=${t.kindId} typeIdx=${t.typeNameIdx} type=${typeName}`);
    }
  }
}
