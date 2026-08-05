import { parseSwf, parseAbc, disassemble } from "./swfPatchUtils";
const ctx = parseSwf(process.argv[2]); const abc = parseAbc(ctx);
let ok=0,bad=0;
for (const [mi,b] of abc.methodBodies) {
  const c = ctx.body.subarray(b.codeStart,b.codeStart+b.codeLen);
  try { const ins=disassemble(c,`m${mi}`); const l=ins[ins.length-1];
    if(!l||l.offset+l.size!==b.codeLen) bad++; else ok++; } catch { bad++; }
}
console.log("bodies:",abc.methodBodies.size,"clean:",ok,"bad:",bad);
