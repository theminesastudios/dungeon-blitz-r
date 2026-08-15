import { parseSwf, parseAbc, disassemble, classIndexByName, methodIdxForTrait } from "./swfPatchUtils";

const SWF = "../client/content/localhost/p/cbp/DungeonBlitz.swf";
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);
const names = abc.multinameNames;
const strings = abc.stringValues;

const classIdx = classIndexByName(abc, "class_4")!;
const inst = abc.instances[classIdx];
const traits = [...inst.traits, ...(abc.classTraits[classIdx] ?? [])];
const methodIdx = methodIdxForTrait(traits, abc, "method_639")!;
const body = abc.methodBodies.get(methodIdx)!;
const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
const insts = disassemble(code, "class_4.method_639");

const OP: Record<number, string> = {
  0x02: "nop", 0x09: "kill", 0x10: "jump", 0x11: "iftrue", 0x12: "iffalse", 0x13: "ifeq",
  0x14: "ifne", 0x15: "iflt", 0x16: "ifle", 0x17: "ifgt", 0x18: "ifge", 0x19: "ifstricteq",
  0x1a: "ifstrictne", 0x1b: "lookupswitch", 0x20: "pushnull", 0x21: "pushundefined",
  0x23: "pushnan", 0x24: "pushbyte", 0x25: "pushshort", 0x26: "pushtrue", 0x27: "pushfalse",
  0x28: "pushnan", 0x29: "pop", 0x2a: "dup", 0x2b: "swap", 0x2c: "pushstring", 0x2d: "pushint",
  0x2e: "pushuint", 0x2f: "pushdouble", 0x30: "pushscope", 0x42: "construct", 0x46: "callproperty",
  0x47: "returnvoid", 0x48: "returnvalue", 0x49: "constructsuper", 0x4a: "constructprop",
  0x4c: "callproplex", 0x4f: "callpropvoid", 0x50: "newarray", 0x51: "newobject",
  0x53: "applytype", 0x56: "dup", 0x57: "swap", 0x5d: "findpropstrict", 0x5e: "findproperty",
  0x5f: "finddef", 0x60: "getlex", 0x61: "setproperty", 0x62: "getlocal", 0x63: "setlocal",
  0x65: "getdescendants", 0x66: "getproperty", 0x68: "initproperty", 0x6a: "getglobalslot",
  0x6c: "getslot", 0x6d: "getslot", 0x6e: "setslot", 0x70: "coerce", 0x71: "coerce_a",
  0x74: "convert_u", 0x75: "convert_d", 0x76: "convert_b", 0x80: "coerce_a", 0x85: "convert_s",
  0x86: "coerce_s", 0x92: "typeof", 0x93: "not", 0xa0: "add", 0xa1: "subtract", 0xa2: "multiply",
  0xa3: "divide", 0xa4: "modulo", 0xac: "strictequals", 0xad: "equals", 0xae: "lessthan",
  0xaf: "lessequals", 0xb0: "greaterthan", 0xb1: "greaterequals", 0xc0: "getlocal0",
  0xc1: "getlocal1", 0xc2: "getlocal2", 0xc3: "getlocal3", 0xc4: "getlocal4", 0xc5: "setlocal1",
  0xc6: "setlocal2", 0xc7: "setlocal3", 0xd0: "getlocal0", 0xd1: "getlocal1", 0xd2: "getlocal2",
  0xd3: "getlocal3", 0xd4: "getlocal4", 0xd5: "setlocal1", 0xd6: "setlocal2", 0xd7: "setlocal3",
};

// opcodes whose first u30 operand is a multiname
const MN_OP = new Set([
  0x46, 0x4a, 0x4c, 0x4f, 0x5d, 0x5e, 0x5f, 0x60, 0x61, 0x65, 0x66, 0x68, 0x6e,
]);

const fmt = (inst: { opcode: number; offset: number; operands: Array<[string, number]> }): string => {
  const operands = inst.operands
    .map(([k, v]) => {
      if (k === "u30" && MN_OP.has(inst.opcode)) return names[v] ?? String(v);
      if (k === "u30" && inst.opcode === 0x2c) return JSON.stringify(strings[v] ?? "");
      if (k === "u30" && inst.opcode === 0x2f) return `#d${v}`;
      return String(v);
    })
    .join(", ");
  return `@${inst.offset} ${OP[inst.opcode] ?? `op${inst.opcode.toString(16)}`} ${operands}`;
};

console.log(`class_4.method_639: ${body.codeLen} bytes`);
for (const inst of insts) console.log(fmt(inst));
