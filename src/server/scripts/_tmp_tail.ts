import { parseSwf, parseAbc, disassemble, classIndexByName, methodIdxForTrait } from "./swfPatchUtils";

const SWF = "../client/content/localhost/p/cbp/DungeonBlitz.swf";
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);
const names = abc.multinameNames;

const classIdx = classIndexByName(abc, "BuffType")!;
const inst = abc.instances[classIdx];
const traits = [...inst.traits, ...(abc.classTraits[classIdx] ?? [])];
const methodIdx = methodIdxForTrait(traits, abc, "method_1811")!;
const body = abc.methodBodies.get(methodIdx)!;
const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
const insts = disassemble(code, "BuffType.method_1811");

const OP = (o: number): string => {
  const m: Record<number, string> = {
    0x02: "nop", 0x09: "kill", 0x10: "jump", 0x11: "iftrue", 0x12: "iffalse", 0x13: "ifeq",
    0x14: "ifne", 0x15: "iflt", 0x16: "ifle", 0x17: "ifgt", 0x18: "ifge", 0x19: "ifstricteq",
    0x1a: "ifstrictne", 0x1b: "lookupswitch", 0x20: "pushnull", 0x21: "pushundefined",
    0x24: "pushbyte", 0x25: "pushshort", 0x26: "pushtrue", 0x27: "pushfalse", 0x28: "pushnan",
    0x29: "pop", 0x2a: "dup", 0x2b: "swap", 0x2c: "pushstring", 0x2f: "pushdouble",
    0x30: "pushscope", 0x42: "construct", 0x46: "callproperty", 0x47: "returnvoid",
    0x48: "returnvalue", 0x4a: "constructprop", 0x4f: "callpropvoid", 0x50: "newarray",
    0x51: "newobject", 0x5d: "findpropstrict", 0x5e: "findproperty", 0x60: "getlex",
    0x61: "setproperty", 0x62: "getlocal(n)", 0x63: "setlocal(n)", 0x65: "getdescendants",
    0x66: "getproperty", 0x68: "initproperty", 0x69: "setlocal(n)", 0x6f: "getlocal(n)",
    0x74: "convert_u", 0x75: "convert_d", 0x76: "convert_b", 0x80: "coerce_a",
    0x92: "typeof", 0x93: "not", 0xa0: "add", 0xa1: "subtract", 0xa2: "multiply",
    0xa3: "divide", 0xac: "strictequals", 0xad: "equals", 0xd0: "getlocal0", 0xd1: "getlocal1",
    0xd2: "getlocal2", 0xd3: "getlocal3", 0xd4: "getlocal4", 0xd5: "setlocal1",
    0xd6: "setlocal2", 0xd7: "setlocal3",
  };
  return m[o] ?? `op${o.toString(16)}`;
};

// print instructions from offset 860 to end
for (const inst of insts) {
  if (inst.offset < 860) continue;
  const operands = inst.operands
    .map(([k, v]) => (k === "u30" && v < names.length ? names[v] : v))
    .join(", ");
  let extra = "";
  if (inst.opcode === 0x2c && inst.operands[0]?.[0] === "u30") {
    const si = inst.operands[0][1];
    if (si < abc.stringValues.length) extra = `   # ${JSON.stringify(abc.stringValues[si])}`;
  }
  console.log(`@${inst.offset} ${OP(inst.opcode)} ${operands}${extra}`);
}
