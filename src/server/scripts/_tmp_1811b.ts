import { parseSwf, parseAbc, disassemble, classIndexByName, methodIdxForTrait } from "./swfPatchUtils";

const SWF = "../client/content/localhost/p/cbp/DungeonBlitz.swf";
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);
const names = abc.multinameNames;
const strings = abc.stringValues;

const classIdx = classIndexByName(abc, "BuffType")!;
const inst = abc.instances[classIdx];
const traits = [...inst.traits, ...(abc.classTraits[classIdx] ?? [])];
const methodIdx = methodIdxForTrait(traits, abc, "method_1811")!;
const body = abc.methodBodies.get(methodIdx)!;
const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
const insts = disassemble(code, "BuffType.method_1811");

const OP: Record<number, string> = {
  0x00: "???", 0x01: "breakpoint", 0x02: "nop", 0x03: "throw", 0x04: "getsuper", 0x05: "setsuper",
  0x06: "dxns", 0x07: "dxnslate", 0x08: "kill", 0x09: "label", 0x0c: "ifnlt", 0x0d: "ifnle",
  0x0e: "ifngt", 0x0f: "ifnge", 0x10: "jump", 0x11: "iftrue", 0x12: "iffalse", 0x13: "ifeq",
  0x14: "ifne", 0x15: "iflt", 0x16: "ifle", 0x17: "ifgt", 0x18: "ifge", 0x19: "ifstricteq",
  0x1a: "ifstrictne", 0x1b: "lookupswitch", 0x1c: "pushwith", 0x1d: "popscope", 0x1e: "nextname",
  0x1f: "hasnext", 0x20: "pushnull", 0x21: "pushundefined", 0x23: "pushnan", 0x24: "pushbyte",
  0x25: "pushshort", 0x26: "pushtrue", 0x27: "pushfalse", 0x28: "pushnan", 0x29: "pop", 0x2a: "dup",
  0x2b: "swap", 0x2c: "pushstring", 0x2d: "pushint", 0x2e: "pushuint", 0x2f: "pushdouble",
  0x30: "pushscope", 0x31: "pushnamespace", 0x32: "hasnext2", 0x35: "newfunction", 0x36: "call",
  0x37: "newobject", 0x38: "newarray", 0x39: "newactivation", 0x3a: "newclass", 0x3b: "getdescendants",
  0x3c: "newcatch", 0x40: "findproperty", 0x41: "findpropstrict", 0x42: "construct", 0x43: "constructprop",
  0x44: "applytype", 0x45: "callproperty", 0x46: "callpropvoid", 0x47: "returnvoid", 0x48: "returnvalue",
  0x49: "constructsuper", 0x4a: "constructprop", 0x4c: "callproplex", 0x4e: "callmethod", 0x4f: "callstatic",
  0x50: "newfunction", 0x51: "newarray", 0x52: "newobject", 0x53: "applytype", 0x54: "callproperty",
  0x55: "getproperty", 0x56: "initproperty", 0x57: "setproperty", 0x58: "getlocal0", 0x59: "getlocal1",
  0x5a: "getlocal2", 0x5b: "getlocal3", 0x5c: "setlocal0", 0x5d: "setlocal1", 0x5e: "setlocal2",
  0x5f: "setlocal3", 0x60: "getlex", 0x61: "setproperty", 0x62: "getlocal", 0x63: "setlocal",
  0x64: "getglobalscope", 0x65: "getscopeobject", 0x66: "getproperty", 0x67: "getouterscope",
  0x68: "initproperty", 0x69: "setlocal", 0x6a: "getglobalslot", 0x6b: "setslot", 0x6c: "getslot",
  0x6d: "getglobalslot", 0x6e: "getslot", 0x6f: "getlocal", 0x70: "coerce", 0x71: "coerce_a",
  0x72: "coerce_i", 0x73: "coerce_d", 0x74: "coerce_ui", 0x75: "coerce_b", 0x76: "convert_b",
  0x77: "convert_i", 0x78: "convert_u", 0x79: "convert_d", 0x7a: "convert_s", 0x80: "coerce_a",
  0x81: "coerce_i", 0x82: "coerce_d", 0x83: "coerce_ui", 0x84: "coerce_b", 0x85: "coerce_s",
  0x86: "coerce_o", 0x87: "coerce_u", 0x88: "convert_i", 0x89: "convert_ui", 0x8a: "convert_d",
  0x8b: "convert_s", 0x8e: "convert_o", 0x90: "negate", 0x91: "increment", 0x92: "decrement",
  0x93: "typeof", 0x94: "not", 0x95: "bitnot", 0x96: "negate_i", 0x97: "increment_i", 0x98: "decrement_i",
  0x99: "add", 0x9a: "subtract", 0x9b: "multiply", 0x9c: "divide", 0x9d: "modulo", 0x9e: "lshift",
  0x9f: "rshift", 0xa0: "urshift", 0xa1: "bitand", 0xa2: "bitor", 0xa3: "bitxor", 0xa4: "add",
  0xa5: "subtract", 0xa6: "multiply", 0xa7: "divide", 0xa8: "modulo", 0xa9: "lshift", 0xaa: "rshift",
  0xab: "urshift", 0xac: "bitand", 0xad: "bitxor", 0xae: "add", 0xaf: "equals", 0xb0: "strictequals",
  0xb1: "lessthan", 0xb2: "lessequals", 0xb3: "greaterthan", 0xb4: "greaterequals", 0xb5: "instanceof",
  0xb6: "istype", 0xb7: "istypelate", 0xb8: "in", 0xb9: "increment", 0xba: "increment_i",
  0xbb: "decrement", 0xbc: "decrement_i", 0xbd: "typeof", 0xbe: "not", 0xbf: "bitnot",
  0xc0: "getlocal0", 0xc1: "getlocal1", 0xc2: "getlocal2", 0xc3: "getlocal3", 0xc4: "getlocal4",
  0xc5: "setlocal1", 0xc6: "setlocal2", 0xc7: "setlocal3", 0xd0: "getlocal0", 0xd1: "getlocal1",
  0xd2: "getlocal2", 0xd3: "getlocal3", 0xd4: "getlocal4", 0xd5: "setlocal1", 0xd6: "setlocal2",
  0xd7: "setlocal3",
};

const fmt = (inst: { opcode: number; offset: number; operands: Array<[string, number]> }): string => {
  const operands = inst.operands
    .map(([k, v]) => {
      if (k === "u30" && v < names.length) return names[v] || String(v);
      return String(v);
    })
    .join(", ");
  let extra = "";
  if (inst.opcode === 0x2c && inst.operands[0]?.[0] === "u30") {
    const si = inst.operands[0][1];
    if (si < strings.length) extra = `   # ${JSON.stringify(strings[si])}`;
  }
  return `@${inst.offset} ${OP[inst.opcode] ?? `op${inst.opcode.toString(16)}`} ${operands}${extra}`;
};

console.log(`BuffType.method_1811: ${body.codeLen} bytes, ${insts.length} insts, maxScope ${body.maxScopeDepth}`);
insts.forEach((inst) => console.log(fmt(inst)));
