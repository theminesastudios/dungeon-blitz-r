import * as path from "path";
import { parseAbc, parseSwf, classIndexByName, methodIdxForTrait, disassemble } from "./swfPatchUtils";

const swfPath = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf");
const ctx = parseSwf(swfPath);
const abc = parseAbc(ctx);

const class4Idx = classIndexByName(abc, "class_4");
if (class4Idx === null) throw new Error("class_4 not found");
const traits = [...abc.instances[class4Idx].traits, ...(abc.classTraits[class4Idx] ?? [])];

const mn = (idx: number) => abc.multinameNames[idx] ?? `#${idx}`;

const mi = methodIdxForTrait(traits, abc, "method_639");
if (mi === null) throw new Error("method_639 not found");
const body = abc.methodBodies.get(mi);
if (!body) throw new Error("no body");
const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
const insts = disassemble(code, "class_4.method_639");
for (const i of insts) {
  const ops = (i.operands ?? [])
    .map((o) => {
      if (!Array.isArray(o)) return String(o);
      const [kind, val] = o;
      if (kind === "u30" && (i.opcode === 0x66 || i.opcode === 0x61 || i.opcode === 0x46 || i.opcode === 0x4f || i.opcode === 0x47 || i.opcode === 0x68 || i.opcode === 0x60 || i.opcode === 0x65 || i.opcode === 0x62 || i.opcode === 0x6a || i.opcode === 0x2c || i.opcode === 0x48 || i.opcode === 0x6b || i.opcode === 0x6c || i.opcode === 0x69 || i.opcode === 0x63 || i.opcode === 0x6d || i.opcode === 0x4a)) return mn(val);
      return `${kind}=${val}`;
    })
    .join(" ");
  console.log(`@${i.offset} ${String(i.opcode).padEnd(4)} ${ops}`);
}
