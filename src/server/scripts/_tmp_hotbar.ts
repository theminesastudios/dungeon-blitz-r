import * as path from "path";
import { parseAbc, parseSwf, classIndexByName, methodIdxForTrait, disassemble } from "./swfPatchUtils";

const swfPath = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf");
const ctx = parseSwf(swfPath);
const abc = parseAbc(ctx);

const mn = (idx: number) => abc.multinameNames[idx] ?? `#${idx}`;
const opcodeName = (op: number): string => op.toString(16).padStart(2, "0");

function dumpMethod(label: string, classIdx: number, methodName: string): void {
  const traits = [...abc.instances[classIdx].traits, ...(abc.classTraits[classIdx] ?? [])];
  const mi = methodIdxForTrait(traits, abc, methodName);
  if (mi === null) {
    console.log(`${label}: not found`);
    return;
  }
  const body = abc.methodBodies.get(mi);
  if (!body) {
    console.log(`${label}: no body`);
    return;
  }
  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  const insts = disassemble(code, label);
  console.log(`\n=== ${label}: ${body.codeLen} bytes, ${insts.length} insts ===`);
  for (const i of insts) {
    const ops = (i.operands ?? [])
      .map((o) => {
        const [kind, val] = o;
        if (kind === "u30" && (i.opcode === 0x66 || i.opcode === 0x61 || i.opcode === 0x46 || i.opcode === 0x4f || i.opcode === 0x68 || i.opcode === 0x60 || i.opcode === 0x2c || i.opcode === 0x48 || i.opcode === 0x6a || i.opcode === 0x6b || i.opcode === 0x62 || i.opcode === 0x63 || i.opcode === 0x65 || i.opcode === 0x69 || i.opcode === 0x4a)) return mn(val);
        if (kind === "u30" && i.opcode === 0x2c) return `"${abc.stringValues[val]}"`;
        return `${kind}=${val}`;
      })
      .join(" ");
    console.log(`@${i.offset} op${opcodeName(i.opcode)} ${ops}`);
  }
}

const ci = classIndexByName(abc, "class_58");
if (ci === null) throw new Error("class_58 not found");
console.log("class_58 name:", abc.multinameNames[abc.instances[ci].classNameIdx]);
for (const m of ["method_1505", "method_1566", "method_741", "PlayPowerToHotbar", "method_769"]) {
  dumpMethod(`class_58.${m}`, ci, m);
}
