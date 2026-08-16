import * as path from "path";
import { classIndexByName, methodIdxForTrait, parseAbc, parseSwf, readU30 } from "./swfPatchUtils";

const SWF = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf");

const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);
const ci = classIndexByName(abc, "CombatState")!;

for (const methodName of ["method_322", "method_1192", "FireThisPower"]) {
  const mi = methodIdxForTrait(abc.instances[ci].traits, abc, methodName);
  if (mi === null) { console.log(`${methodName}: not found`); continue; }
  const body = abc.methodBodies.get(mi)!;
  const data = ctx.body;
  // max_stack u30 at maxStackPos
  const maxStack = readU30(data, body.maxStackPos, "maxStack")[0];
  const localCount = readU30(data, body.localCountPos, "localCount")[0];
  const maxScope = readU30(data, body.maxScopeDepthPos, "maxScope")[0];
  console.log(`\n${methodName}: max_stack=${maxStack} local_count=${localCount} max_scope=${maxScope} codeLen=${body.codeLen} exceptions=${body.exceptionCount}`);
  for (const ex of body.exceptions) {
    console.log(`  exception: from=${ex.from} to=${ex.to} target=${ex.target} type=${ex.type}`);
  }
}
