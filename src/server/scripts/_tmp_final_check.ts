import { parseSwf, parseAbc, disassemble, classIndexByName, methodIdxForTrait } from "./swfPatchUtils";

const SWF = "../client/content/localhost/p/cbp/DungeonBlitz.swf";
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);
const strings = abc.stringValues;
const names = abc.multinameNames;

const daggerIdx = strings.indexOf("a_PowerIcon_PoisonDagger");
const attackUpIdx = strings.indexOf("a_StatusIcon_AttackUp");
console.log("a_PowerIcon_PoisonDagger pool idx:", daggerIdx);
console.log("a_StatusIcon_AttackUp pool idx:", attackUpIdx);

const classIdx = classIndexByName(abc, "BuffType")!;
const traits = [...abc.instances[classIdx].traits, ...(abc.classTraits[classIdx] ?? [])];
const methodIdx = methodIdxForTrait(traits, abc, "method_1811")!;
const body = abc.methodBodies.get(methodIdx)!;
const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
const insts = disassemble(code, "BuffType.method_1811");

for (const inst of insts) {
  if (inst.opcode === 0x2c) {
    const si = inst.operands[0][1];
    if (si < strings.length && strings[si].startsWith("a_")) {
      console.log(`@${inst.offset} pushstring ${JSON.stringify(strings[si])} (idx ${si})`);
    }
  }
}
