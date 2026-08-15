import { parseSwf, parseAbc, writeU30 } from "./swfPatchUtils";

const ctx = parseSwf("../client/content/localhost/p/cbp/DungeonBlitz.swf");
const abc = parseAbc(ctx);
console.log("stringValues.length:", abc.stringValues.length);
console.log("index 1173 =", JSON.stringify(abc.stringValues[1173]));
const n = abc.stringValues.length;
console.log("new index", n, "u30 width:", writeU30(n).length, "vs 1173 width:", writeU30(1173).length);
