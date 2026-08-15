import { parseSwf, parseAbc } from "./swfPatchUtils";

const SWF = "../client/content/localhost/p/cbp/DungeonBlitz.swf";
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);

const needles = [
  "getDefinition", "getDefinitionByName", "getClassByAlias", "getQualifiedDefinitionNames",
  "hasDefinition", "ApplicationDomain", "currentDomain", "loaderInfo", "getSymbol",
  "classByName", "getClass", "Class", "createClass", "library", "Library", "attachMovie",
];

console.log("== multiname hits ==");
abc.multinameNames.forEach((n, i) => {
  if (needles.some((x) => n.includes(x))) console.log(`  [mn ${i}] ${JSON.stringify(n)}`);
});
console.log("== string hits ==");
abc.stringValues.forEach((n, i) => {
  if (needles.some((x) => n.includes(x))) console.log(`  [str ${i}] ${JSON.stringify(n)}`);
});

// Also look for a static Dictionary that maps names -> classes: find classes with a Dictionary-typed static trait? skip.
