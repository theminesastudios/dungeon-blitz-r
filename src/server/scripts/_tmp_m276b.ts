import * as path from "path";
import { parseAbc, parseSwf, classIndexByName, methodIdxForTrait, disassemble } from "./swfPatchUtils";

const swfPath = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf");
const ctx = parseSwf(swfPath);
const abc = parseAbc(ctx);

const class4Idx = classIndexByName(abc, "class_4");
if (class4Idx === null) throw new Error("class_4 not found");
const traits = [...abc.instances[class4Idx].traits, ...(abc.classTraits[class4Idx] ?? [])];

const mn = (idx: number) => abc.multinameNames[idx] ?? `#${idx}`;
const isMnOp = (op: number) =>
  [0x66, 0x61, 0x46, 0x4f, 0x68, 0x60, 0x2c, 0x48, 0x6a, 0x6b, 0x62, 0x63, 0x65, 0x69, 0x4a, 0x1c, 0x55].includes(op);

const mi = methodIdxForTrait(traits, abc, "method_276");
if (mi === null) throw new Error("method_276 not found");
const body = abc.methodBodies.get(mi);
if (!body) throw new Error("no body");
const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
const insts = disassemble(code, "class_4.method_276");
console.log(`class_4.method_276: ${body.codeLen} bytes, ${insts.length} insts`);
for (const i of insts) {
  const ops = (i.operands ?? [])
    .map((o) => {
      const [kind, val] = o;
      if (kind === "u30" && isMnOp(i.opcode)) return mn(val);
      if (kind === "u30" && i.opcode === 0x2c) return `"${abc.stringValues[val] ?? ""}"`;
      return `${kind}=${val}`;
    })
    .join(" ");
  console.log(`@${i.offset} op${i.opcode.toString(16).padStart(2, "0")} ${ops}`);
}
