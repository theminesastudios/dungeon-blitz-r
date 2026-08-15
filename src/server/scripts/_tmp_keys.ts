import { parseSwf, parseAbc } from "./swfPatchUtils";

const SWF = "../client/content/localhost/p/cbp/DungeonBlitz.swf";
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);

const keys = [
  "Chilblains", "Ignite", "Ignited", "Burned", "Scorched", "Poisoned", "Bleeding",
  "Stagger", "Staggered", "Immobile", "SpeedUp", "DefenseUp", "AttackUp",
  "SpeedDown", "DefenseDown", "AttackDown",
];
for (const k of keys) {
  const inPool = abc.stringValues.indexOf(k);
  console.log(`${k}: ${inPool > 0 ? `IN POOL [${inPool}]` : "NOT in pool"}`);
}

// also: are these strings used as multinames (would renaming break anything)?
for (const k of keys) {
  const mn = abc.multinameNames.indexOf(k);
  if (mn > 0) console.log(`  (${k} is also multiname [${mn}])`);
}
