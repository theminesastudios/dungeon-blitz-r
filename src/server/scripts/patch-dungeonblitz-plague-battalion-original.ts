import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  ensureBackup,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  u30OperandName,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

const DEFAULT_SWF = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf");
const INDEX_HTML = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "index.html");
const CUSTOM_TRIGGER = "PlagueBattalion";
const DISABLED_TRIGGER = "ShadowLegionCloneTwo";

function opU30(opcode: number, value: number): Buffer {
  return Buffer.concat([Buffer.from([opcode]), writeU30(value)]);
}

function patchPlagueRankResolution(
  ctx: ReturnType<typeof parseSwf>,
  abc: ReturnType<typeof parseAbc>,
  classIndex: number,
  verify: boolean,
): BytePatch | null {
  const methodIndex = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_322");
  if (methodIndex === null) throw new PatchError("CombatState.method_322 not found.");
  const body = abc.methodBodies.get(methodIndex);
  if (!body) throw new PatchError("CombatState.method_322 body not found.");
  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  const instructions = disassemble(code, "CombatState.method_322");
  const plague = instructions.findIndex((inst) =>
    inst.opcode === 0x2c && abc.stringValues[inst.operands[0]?.[1] ?? -1] === "PlagueBattalion",
  );
  if (plague < 0) throw new PatchError("Plague Battalion rank resolver not found.");
  const nextGoto = instructions.findIndex((inst, index) => index > plague && inst.opcode === 0x10);
  if (nextGoto < 0) throw new PatchError("Plague Battalion rank resolver boundary not found.");
  const resolver = instructions.slice(plague, nextGoto);
  const hasVar1209 = resolver.some((inst) => u30OperandName(inst, abc.multinameNames) === "var_1209");
  // The stable resolver derives the rank arithmetically (powerId - PLAGUE_BASE_POWER_ID). Every
  // Plague Battalion power id is exactly baseId + rank, so this is identical to the original
  // powerTypes[powerId].var_7 lookup for all shipped ranks -- but it cannot throw a null
  // reference when the marker buff's power id does not resolve (0 or a removed/custom power).
  const hasArithmeticRank = resolver.some((inst, index) =>
    inst.opcode === 0x25 &&
    resolver.slice(index + 1).some((later) => later.opcode === 0xa1),
  );
  const startIndex = instructions.findIndex((inst, index) =>
    index > plague && inst.opcode === 0x62 && inst.operands[0]?.[1] === 8,
  );
  if (startIndex < 0 || startIndex >= nextGoto) throw new PatchError("Plague Battalion resolver start not found.");
  // Earlier patch variants are all detectable and must be re-applied: (1) the original
  // feature-era resolver dereferenced powerTypes[powerId].var_7 with no null guard (crash on
  // cast); (2) a variant left `class_14.powerTypes` pushed above the getlocal 8; (3) a variant
  // filled the slack with raw pushnull padding; (4) a variant stored the subtract result
  // (Number) into the uint field var_1188, which the AVM2 verifier rejects at first execution.
  const hasStalePowerTypesPrefix =
    startIndex >= 2 &&
    instructions[startIndex - 2].opcode === 0x60 &&
    u30OperandName(instructions[startIndex - 2], abc.multinameNames) === "class_14" &&
    instructions[startIndex - 1].opcode === 0x66 &&
    u30OperandName(instructions[startIndex - 1], abc.multinameNames) === "powerTypes";
  // The stable resolver ends with a bitand: bitwise ops always yield int32, and var_1188 is a
  // uint field whose other (original) writers all push int -- so this keeps the assignment
  // verifier-clean without a Number->uint coercion. Its trailing nop (0x02) padding has no stack
  // effect, so arithmetic-rank + bitand + no stale prefix uniquely identifies the stable result.
  const hasBitandRank = resolver.some((inst) => inst.opcode === 0xa8);
  const stableResolver =
    hasVar1209 && hasArithmeticRank && hasBitandRank && !hasStalePowerTypesPrefix;
  if (stableResolver) return null;
  if (verify) {
    if (hasVar1209 && hasArithmeticRank && !hasBitandRank) {
      throw new PatchError("Plague Battalion rank resolver still stores a Number into the uint field var_1188.");
    }
    if (hasVar1209) {
      throw new PatchError("Plague Battalion rank resolver still dereferences powerTypes without a null guard.");
    }
    throw new PatchError("Plague Battalion still derives minion rank from transient buff history.");
  }

  const original = instructions.slice(startIndex, nextGoto);

  const multiname = (name: string): number => {
    const index = abc.multinameNames.indexOf(name);
    if (index < 0) throw new PatchError(`ABC multiname ${name} not found.`);
    return index;
  };
  // this.var_1188 = (powerId - 5931) & -1. Net operand-stack effect of this whole block is
  // exactly 0 (matching the branch-over path at the join point) and its peak depth is D+2
  // (same as the original resolver, so it fits the method's declared max_stack). The trailing
  // bitand is what guarantees an int result for the uint field. Any reclaimed slack is filled
  // with nops (0x02) -- the same padding idiom the other resolvers in this file use.
  const core = Buffer.concat([
    opU30(0x62, 8),                            // getlocal 8 (the marker Buff)
    opU30(0x66, multiname("var_1209")),        // getproperty var_1209 (persistent power id)
    opU30(0x25, 5931),                         // pushshort PLAGUE_BASE_POWER_ID
    Buffer.from([0xa1]),                       // subtract -> rank
    Buffer.from([0x24, 0xff]),                 // pushbyte -1
    Buffer.from([0xa8]),                       // bitand -> int32 rank (verifier-typed int)
    Buffer.from([0xd0]),                       // getlocal_0 (this)
    Buffer.from([0x2b]),                       // swap
    opU30(0x61, multiname("var_1188")),        // setproperty var_1188
  ]);
  // When a stale class_14.powerTypes prefix is present the span starts two instructions earlier
  // so the replacement subsumes (and discards) that dangling push -- the core is self-contained,
  // so nothing is left on the stack and no lead pop is needed.
  const start = hasStalePowerTypesPrefix ? instructions[startIndex - 2].offset : original[0].offset;
  const end = instructions[nextGoto].offset;
  const width = end - start;
  if (core.length > width) {
    throw new PatchError(`Stable Plague rank resolver (${core.length} bytes) does not fit the ${width}-byte original span.`);
  }
  const replacement = Buffer.concat([core, Buffer.alloc(width - core.length, 0x02)]);
  return {
    key: "CombatState.method_322.stabilizePlagueMinionRank",
    start: body.codeStart + start,
    end: body.codeStart + end,
    data: replacement,
    detail: "derive Plague Battalion rank from the marker buff's power id so no powerTypes lookup can throw",
  };
}

function patchBrokenGlobalChargeGate(
  ctx: ReturnType<typeof parseSwf>,
  abc: ReturnType<typeof parseAbc>,
  classIndex: number,
  verify: boolean,
): BytePatch | null {
  const methodIndex = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1192");
  if (methodIndex === null) throw new PatchError("CombatState.method_1192 not found.");
  const body = abc.methodBodies.get(methodIndex);
  if (!body) throw new PatchError("CombatState.method_1192 body not found.");
  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  const instructions = disassemble(code, "CombatState.method_1192");
  const gate = instructions.findIndex((inst) => u30OperandName(inst, abc.multinameNames) === "var_1815");
  if (gate < 0) return null;
  if (verify) throw new PatchError("Minion Plague hits are still blocked by the broken global charge counter.");
  const startIndex = gate - 2;
  const branchIndex = gate + 1;
  if (
    startIndex < 0 ||
    u30OperandName(instructions[startIndex + 1], abc.multinameNames) !== "combatState" ||
    instructions[branchIndex]?.opcode !== 0x12
  ) {
    throw new PatchError("Unexpected PlagueStackLimit gate bytecode shape.");
  }
  const start = instructions[startIndex].offset;
  const end = instructions[branchIndex].offset;
  const width = end - start;
  return {
    key: "CombatState.method_1192.allowMarkedMinionPlagueHit",
    start: body.codeStart + start,
    end: body.codeStart + end,
    data: Buffer.concat([Buffer.from([0x26]), Buffer.alloc(width - 1, 0x02)]),
    detail: "let each marked minion transfer its own Plague charge even when the redundant global counter failed to initialize",
  };
}

function patchLocalPlagueOwnerResolution(
  ctx: ReturnType<typeof parseSwf>,
  abc: ReturnType<typeof parseAbc>,
  classIndex: number,
  verify: boolean,
): BytePatch | null {
  const methodIndex = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1192");
  if (methodIndex === null) throw new PatchError("CombatState.method_1192 not found.");
  const body = abc.methodBodies.get(methodIndex);
  if (!body) throw new PatchError("CombatState.method_1192 body not found.");
  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  const instructions = disassemble(code, "CombatState.method_1192");
  const plagueString = instructions.findIndex((inst) =>
    inst.opcode === 0x2c && abc.stringValues[inst.operands[0]?.[1] ?? -1] === "PlagueBattalion",
  );
  const summoner = instructions.findIndex((inst, index) =>
    index > plagueString && u30OperandName(inst, abc.multinameNames) === "summonerId",
  );
  const clientEnt = instructions.findIndex((inst, index) =>
    index > summoner && u30OperandName(inst, abc.multinameNames) === "clientEntID",
  );
  const ownerSet = instructions.findIndex((inst, index) =>
    index > clientEnt && inst.opcode === 0x63 && inst.operands[0]?.[1] === 71,
  );
  if (summoner < 0 || ownerSet < 0) return null;
  // A patched resolver loads clientEntID immediately before GetEntFromID and has no equality test.
  if (clientEnt >= 0 && instructions.slice(clientEnt, ownerSet).every((inst) => inst.opcode !== 0xab)) return null;
  if (verify) throw new PatchError("Plague minion owner lookup still rejects canonical/raw summoner ID mismatches.");

  const startIndex = instructions.findIndex((inst, index) =>
    index > summoner && inst.opcode === 0x62 && inst.operands[0]?.[1] === 70,
  );
  if (startIndex < 0 || startIndex >= ownerSet) throw new PatchError("Plague owner resolver start not found.");
  const multiname = (name: string): number => {
    const index = abc.multinameNames.indexOf(name);
    if (index < 0) throw new PatchError(`ABC multiname ${name} not found.`);
    return index;
  };
  const replacement = Buffer.concat([
    Buffer.from([0xd0]),
    opU30(0x66, multiname("var_1")),
    Buffer.from([0xd0]),
    opU30(0x66, multiname("var_1")),
    opU30(0x66, multiname("clientEntID")),
    Buffer.concat([Buffer.from([0x46]), writeU30(multiname("GetEntFromID")), writeU30(1)]),
    opU30(0x80, multiname("Entity")),
    opU30(0x63, 71),
  ]);
  const start = instructions[startIndex].offset;
  const end = instructions[ownerSet].offset + instructions[ownerSet].size;
  const width = end - start;
  if (replacement.length > width) throw new PatchError("Local Plague owner resolver does not fit original bytecode span.");
  return {
    key: "CombatState.method_1192.resolveLocalPlagueOwner",
    start: body.codeStart + start,
    end: body.codeStart + end,
    data: Buffer.concat([replacement, Buffer.alloc(width - replacement.length, 0x02)]),
    detail: "resolve marked local minion hits through clientEntID even when the server canonicalized the player's id",
  };
}

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") swfPath = path.resolve(argv[++index] || "");
    else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify };
}

function verifyOriginalNextHitHandler(ctx: ReturnType<typeof parseSwf>, abc: ReturnType<typeof parseAbc>, classIndex: number): void {
  const methodIndex = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1192");
  if (methodIndex === null) throw new PatchError("CombatState.method_1192 not found.");
  const body = abc.methodBodies.get(methodIndex);
  if (!body) throw new PatchError("CombatState.method_1192 body not found.");
  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  const instructions = disassemble(code, "CombatState.method_1192");
  const strings = new Set(
    instructions
      .filter((inst) => inst.opcode === 0x2c)
      .map((inst) => abc.stringValues[inst.operands[0]?.[1] ?? -1]),
  );
  const names = new Set(instructions.map((inst) => u30OperandName(inst, abc.multinameNames)).filter(Boolean));
  for (const expected of ["Plagued", "PlagueBattalion"]) {
    if (!strings.has(expected)) throw new PatchError(`Original next-hit handler is missing ${expected}.`);
  }
  for (const expected of ["summonerId", "magicDamage", "AddBuff", "RemoveBuff", "var_1188"]) {
    if (!names.has(expected)) throw new PatchError(`Original next-hit handler is missing ${expected}.`);
  }
}

function syncClientRevision(swfPath: string, verify: boolean): void {
  if (path.resolve(swfPath) !== path.resolve(DEFAULT_SWF)) return;
  // sha1, matching every other patch that writes the clientrev token (Sentinel Form exit
  // cooldown, Shadow Legion equipped skills, ...). sha256 produced a different token for the
  // same SWF, so whichever patch wrote index.html last made the other patches' verifies fail.
  const digest = crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
  const expected = `clientrev=swf-${digest}`;
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  if (html.includes(expected)) return;
  if (verify) throw new PatchError(`index.html is missing ${expected}.`);
  const updated = html.replace(/clientrev=[^&`"'$]+/, expected);
  if (updated === html) throw new PatchError("index.html clientrev token not found.");
  fs.writeFileSync(INDEX_HTML, updated, "utf8");
}

export function restorePlagueBattalionClient(swfPath: string, verify = false): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "CombatState");
  if (classIndex === null) throw new PatchError("CombatState class not found.");
  verifyOriginalNextHitHandler(ctx, abc, classIndex);
  const rankPatch = patchPlagueRankResolution(ctx, abc, classIndex, verify);
  const chargeGatePatch = patchBrokenGlobalChargeGate(ctx, abc, classIndex, verify);
  const ownerPatch = patchLocalPlagueOwnerResolution(ctx, abc, classIndex, verify);
  const behaviorPatches = [rankPatch, chargeGatePatch, ownerPatch]
    .filter((patch): patch is BytePatch => patch !== null);
  const methodIndex = methodIdxForTrait(abc.instances[classIndex].traits, abc, "FireThisPower");
  if (methodIndex === null) throw new PatchError("CombatState.FireThisPower not found.");
  const body = abc.methodBodies.get(methodIndex);
  if (!body) throw new PatchError("CombatState.FireThisPower body not found.");
  const disabledIndex = abc.stringValues.indexOf(DISABLED_TRIGGER);
  if (disabledIndex < 0) throw new PatchError(`Replacement string ${DISABLED_TRIGGER} not found.`);

  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  const instructions = disassemble(code, "CombatState.FireThisPower");
  const custom = instructions.filter((inst) =>
    inst.opcode === 0x2c && abc.stringValues[inst.operands[0]?.[1] ?? -1] === CUSTOM_TRIGGER,
  );
  const minionCheckPresent = instructions.some((inst) =>
    inst.opcode === 0x2c && abc.stringValues[inst.operands[0]?.[1] ?? -1] === "PlagueBattalionMinion",
  );

  if (custom.length === 0) {
    if (!minionCheckPresent) throw new PatchError("Plague Battalion custom window signature not found.");
    if (behaviorPatches.length > 0) {
      ensureBackup(swfPath);
      const patched = applyPatchesToBody(ctx.body, behaviorPatches);
      writeSwf(ctx, patched.body, patched.delta);
      syncClientRevision(swfPath, false);
      restorePlagueBattalionClient(swfPath, true);
      return;
    }
    syncClientRevision(swfPath, verify);
    console.log(`${swfPath}: original Plague Battalion client behavior verified.`);
    return;
  }
  if (custom.length !== 1) throw new PatchError(`Expected one custom Plague Battalion trigger, found ${custom.length}.`);
  if (verify) throw new PatchError(`${swfPath}: custom Plague Battalion Expertise window is still enabled.`);

  const inst = custom[0];
  const patch: BytePatch = {
    key: "CombatState.FireThisPower.disablePlagueExpertiseWindow",
    start: body.codeStart + inst.offset,
    end: body.codeStart + inst.offset + inst.size,
    data: Buffer.concat([Buffer.from([0x2c]), writeU30(disabledIndex)]),
    detail: "disable the custom timed Expertise window and fall back to the shipped next-attack behavior",
  };
  ensureBackup(swfPath);
  const patched = applyPatchesToBody(ctx.body, [patch, ...behaviorPatches]);
  writeSwf(ctx, patched.body, patched.delta);
  syncClientRevision(swfPath, false);
  restorePlagueBattalionClient(swfPath, true);
}

const { swfPath, verify } = parseArgs(process.argv);
restorePlagueBattalionClient(swfPath, verify);
