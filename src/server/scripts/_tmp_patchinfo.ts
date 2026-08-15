import { parseSwf, parseAbc, disassemble, classIndexByName, methodIdxForTrait } from "./swfPatchUtils";

const SWF = "../client/content/localhost/p/cbp/DungeonBlitz.swf";
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);
const names = abc.multinameNames;

const classIdx = classIndexByName(abc, "Entity")!;
const inst = abc.instances[classIdx];
const traits = [...inst.traits, ...(abc.classTraits[classIdx] ?? [])];
const methodIdx = methodIdxForTrait(traits, abc, "method_1667")!;
const body = abc.methodBodies.get(methodIdx)!;
console.log("Entity.method_1667: methodIdx", methodIdx, "codeStart", body.codeStart, "codeLen", body.codeLen);
console.log("maxStackPos", body.maxStackPos, "localCountPos", body.localCountPos, "codeLenPos", body.codeLenPos, "exceptionCount", body.exceptionCount);

const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
const insts = disassemble(code, "Entity.method_1667");

for (const name of ["class_4", "BuffType", "method_1811", "method_16", "addChild"]) {
  console.log(name, "multiname idx:", names.indexOf(name));
}

// print the exact region 790..830 with raw bytes
const from = insts.find((i) => i.offset >= 790)!.offset;
const to = 830;
console.log("\ninstructions 790..830:");
for (const inst of insts) {
  if (inst.offset < from || inst.offset >= to) continue;
  const raw = code.subarray(inst.offset, inst.offset + inst.size).toString("hex").match(/../g)?.join(" ") ?? "";
  console.log(`@${inst.offset} op0x${inst.opcode.toString(16)} size=${inst.size} raw=${raw} operands=${inst.operands.map(([k, v]) => `${k}:${v}`).join(",")}`);
}
