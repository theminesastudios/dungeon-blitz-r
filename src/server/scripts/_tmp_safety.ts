import { parseSwf, parseAbc, disassemble, classIndexByName, methodIdxForTrait, readU30 } from "./swfPatchUtils";

const SWF = "../client/content/localhost/p/cbp/DungeonBlitz.swf";
const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);

const classIdx = classIndexByName(abc, "Entity")!;
const inst = abc.instances[classIdx];
const traits = [...inst.traits, ...(abc.classTraits[classIdx] ?? [])];
const methodIdx = methodIdxForTrait(traits, abc, "method_1667")!;
const body = abc.methodBodies.get(methodIdx)!;
const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);

// read maxStack (u30 at maxStackPos), localCount (u30 at localCountPos), codeLen (u30 at codeLenPos)
const [maxStack] = readU30(ctx.body, body.maxStackPos, "maxStack");
const [localCount] = readU30(ctx.body, body.localCountPos, "localCount");
const [codeLen] = readU30(ctx.body, body.codeLenPos, "codeLen");
console.log("maxStack:", maxStack, "localCount:", localCount, "codeLen:", codeLen);

const insts = disassemble(code, "Entity.method_1667");

// branch opcodes: s24 (0x0c-0x1a except 0x1b) + lookupswitch 0x1b
const branchTargets: Array<[number, number]> = [];
for (const i of insts) {
  if ((i.opcode >= 0x0c && i.opcode <= 0x1a) || i.opcode === 0x10) {
    const t = i.offset + i.size + i.operands[0][1];
    branchTargets.push([t, i.offset]);
  } else if (i.opcode === 0x1b) {
    // lookupswitch: default + cases
    for (let k = 0; k < i.operands.length; k += 1) {
      if (i.operands[k][0] === "s24") branchTargets.push([i.offset + i.size + i.operands[k][1], i.offset]);
    }
  }
}
const region = [811, 815]; // bytes being replaced
const hits = branchTargets.filter(([t]) => t >= region[0] && t < region[1]);
console.log("branch targets into patch region [811,815):", hits.length ? hits : "NONE");

// verify the exact instruction sequence we're patching
const seq = insts.filter((i) => i.offset >= 798 && i.offset <= 815);
console.log("sequence to patch:");
for (const i of seq) console.log(`  @${i.offset} op0x${i.opcode.toString(16)} ${i.operands.map(([k, v]) => `${k}:${v}`).join(",")}`);

// confirm getlocal 6 (0x62 0x06) is the category: find where local 6 was set — check the loop back edge
