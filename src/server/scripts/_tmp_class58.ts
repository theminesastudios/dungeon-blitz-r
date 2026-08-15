import * as path from "path";
import { parseAbc, parseSwf, classIndexByName, methodIdxForTrait, disassemble } from "./swfPatchUtils";

const swfPath = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf");
const ctx = parseSwf(swfPath);
const abc = parseAbc(ctx);

const ci = classIndexByName(abc, "class_58");
if (ci === null) throw new Error("class_58 not found");
console.log(
  "class_58 instance traits:",
  abc.instances[ci].traits.map((t) => abc.multinameNames[t.nameIdx]).join(", "),
);
console.log(
  "class_58 class traits:",
  (abc.classTraits[ci] ?? []).map((t) => abc.multinameNames[t.nameIdx]).join(", "),
);

const traits = [...abc.instances[ci].traits, ...(abc.classTraits[ci] ?? [])];
const mi = methodIdxForTrait(traits, abc, "method_639");
console.log("method_639 methodIdx:", mi);
if (mi !== null) {
  const body = abc.methodBodies.get(mi);
  if (body) {
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const insts = disassemble(code, "class_58.method_639");
    const text = insts
      .map((i) => {
        const ops = (i.operands ?? [])
          .map((o) => {
            if (Array.isArray(o)) return o.map((x) => (typeof x === "number" ? x : String(x))).join(",");
            return String(o);
          })
          .join(" ");
        return `@${i.offset} ${String(i.opcode).padEnd(16)} ${ops}`;
      })
      .join("\n");
    console.log(text);
  }
}

// Find class_58's name via multinames
console.log("class_58 instance classNameIdx:", abc.instances[ci].classNameIdx, "->", abc.multinameNames[abc.instances[ci].classNameIdx]);
