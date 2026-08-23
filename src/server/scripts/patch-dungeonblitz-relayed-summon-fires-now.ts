#!/usr/bin/env node

import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  ensureBackup,
  Instruction,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

// A relayed cast is QUEUED on the receiving client, so its summons land seconds late.
//
// `LinkUpdater.method_1180` (the 0x09 reader) picks one of two branches on `PowerType.var_301`,
// which the loader sets as `var_301 = !powerName.indexOf("Proc")` -- true only for powers whose
// name begins with `Proc`:
//
//   var_301  -> new ActivePower(...); method_243(); method_129();   // fires on arrival
//   else     -> cancel any in-flight mActivePower, install this one // fires on the LOCAL timeline
//
// `SummonStealth` is not a `Proc` power, so Tanja's clones take the second branch on every screen
// except the one that cast: the queued ActivePower waits for that copy of the boss to finish
// whatever animation and recover it is in. Reported live in The East Wing as the boss playing the
// summon animation with the clones landing seconds afterwards.
//
// This widens the immediate-fire test to `var_301 || SpawnedMonsters`, so a cast that creates
// entities fires the moment the packet arrives. Only powers that spawn something change branch;
// everything else keeps the queue, which is what makes a normal cast look like a cast.
//
// TRADE-OFF, on purpose: the immediate branch does not set `mActivePower`, so the receiving client
// stops driving the boss's cast animation from this packet. Her animation on that screen is her own
// AI's business either way, and a clone that appears with the wrong flourish beats one that appears
// four seconds late.
//
// SHAPE: unlike patch-dungeonblitz-remote-cast-cooldown.ts, which appends before the method's final
// `returnvoid` precisely so that nothing moves, this one replaces an instruction in the MIDDLE. The
// method's code therefore has to be re-emitted with every branch offset that spans the site fixed
// up. That is done generically below -- old->new offset map, then every s24 recomputed from its
// resolved target -- rather than by hand, and the method is refused outright if it contains a
// `lookupswitch` or an exception range, because both carry offsets this rewrite does not touch.
const DEFAULT_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf",
);

const CLASS_NAME = "LinkUpdater";
const METHOD_NAME = "method_1180";
const LOCAL_POWER = 6;

const OP_GETLOCAL = 0x62;
const OP_GETPROPERTY = 0x66;
const OP_IFTRUE = 0x11;
const OP_IFFALSE = 0x12;
const OP_LOOKUPSWITCH = 0x1b;

const NAME_PROC_FLAG = "var_301";      // PowerType.var_301 -- set from powerName.indexOf("Proc")
const NAME_SPAWNED_MONSTERS = "var_851"; // PowerType.var_851 -- the SpawnedMonsters list

function parseArgs(argv: string[]): { swfPath: string; verify: boolean; revert: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  let revert = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") swfPath = path.resolve(argv[++index] || "");
    else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else if (arg === "--revert") revert = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: ts-node patch-dungeonblitz-relayed-summon-fires-now.ts [--verify|--revert] [--swf <path>]\n" +
        "Makes a relayed cast that spawns monsters fire on arrival instead of queueing.",
      );
      process.exit(0);
    } else throw new PatchError(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify, revert };
}

function qnameIndex(names: string[], kinds: number[], want: string): number {
  const hits: number[] = [];
  for (let index = 0; index < names.length; index += 1) {
    if (names[index] === want && kinds[index] === 0x07) hits.push(index);
  }
  if (hits.length !== 1) throw new PatchError(`Expected exactly one QName named "${want}", found ${hits.length}`);
  return hits[0];
}

function s24(value: number): Buffer {
  const buf = Buffer.alloc(3);
  buf.writeIntLE(value, 0, 3);
  return buf;
}

/** The one s24 a branch carries, or null for everything else. */
function branchOperand(inst: Instruction): number | null {
  for (const [kind, value] of inst.operands) {
    if (kind === "s24") return value;
  }
  return null;
}

/**
 * Locate `getlocal <power>; getproperty var_301; iffalse <else>` and insist it is unique.
 *
 * Uniqueness is the whole safety argument for editing by pattern rather than by offset: if the
 * shape appears twice, this is not the method this patch was written against.
 */
function findSite(instructions: Instruction[], procFlagIdx: number): number {
  const hits: number[] = [];
  for (let index = 0; index + 2 < instructions.length; index += 1) {
    const [a, b, c] = [instructions[index], instructions[index + 1], instructions[index + 2]];
    if (a.opcode !== OP_GETLOCAL || a.operands[0]?.[1] !== LOCAL_POWER) continue;
    if (b.opcode !== OP_GETPROPERTY || b.operands[0]?.[1] !== procFlagIdx) continue;
    if (c.opcode !== OP_IFFALSE) continue;
    hits.push(index + 2);
  }
  if (hits.length !== 1) {
    throw new PatchError(`Expected exactly one 'getlocal ${LOCAL_POWER}; getproperty ${NAME_PROC_FLAG}; iffalse', found ${hits.length}`);
  }
  return hits[0];
}

/**
 * Re-emit the method with the site instruction replaced and every branch re-resolved.
 *
 * `replacement` is a function so the block can be built once its own targets are known: it is
 * handed the old->new offset map after the map exists.
 */
function rewriteCode(
  code: Buffer,
  instructions: Instruction[],
  siteIndex: number,
  replacementLength: number,
  buildReplacement: (mapOffset: (old: number) => number, newSiteOffset: number) => Buffer,
): Buffer {
  const site = instructions[siteIndex];
  const delta = replacementLength - site.size;
  // Everything at or before the site keeps its offset; everything after it shifts. A branch that
  // targeted the site itself still targets the start of the replacement, which is what we want.
  const mapOffset = (old: number): number => (old > site.offset ? old + delta : old);

  const parts: Buffer[] = [];
  for (const inst of instructions) {
    if (inst === site) {
      parts.push(buildReplacement(mapOffset, site.offset));
      continue;
    }

    const operand = branchOperand(inst);
    if (operand === null) {
      parts.push(code.subarray(inst.offset, inst.offset + inst.size));
      continue;
    }

    const oldTarget = inst.offset + inst.size + operand;
    const newTarget = mapOffset(oldTarget);
    const newOffset = mapOffset(inst.offset);
    const newOperand = newTarget - (newOffset + inst.size);
    parts.push(Buffer.concat([code.subarray(inst.offset, inst.offset + inst.size - 3), s24(newOperand)]));
  }

  return Buffer.concat(parts);
}

function main(): void {
  const { swfPath, verify, revert } = parseArgs(process.argv);
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);

  const classIndex = classIndexByName(abc, CLASS_NAME);
  if (classIndex === null) throw new PatchError(`${CLASS_NAME} not found`);
  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, METHOD_NAME);
  if (methodIdx === null) throw new PatchError(`${CLASS_NAME}.${METHOD_NAME} not found`);
  const body = abc.methodBodies.get(methodIdx);
  if (!body) throw new PatchError(`${CLASS_NAME}.${METHOD_NAME} has no body`);

  const procFlagIdx = qnameIndex(abc.multinameNames, abc.multinameKinds, NAME_PROC_FLAG);
  const spawnedIdx = qnameIndex(abc.multinameNames, abc.multinameKinds, NAME_SPAWNED_MONSTERS);

  const code = Buffer.from(ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen));
  const instructions = disassemble(code, `${CLASS_NAME}.${METHOD_NAME}`);

  const patchedShape = instructions.some((inst, index) =>
    inst.opcode === OP_GETPROPERTY &&
    inst.operands[0]?.[1] === spawnedIdx &&
    instructions[index + 1]?.opcode === OP_IFFALSE);
  if (patchedShape) {
    if (!revert) {
      console.log(`${swfPath}: already patched (${CLASS_NAME}.${METHOD_NAME} fires spawning casts on arrival).`);
      return;
    }
  } else if (revert) {
    console.log(`${swfPath}: nothing to revert (${CLASS_NAME}.${METHOD_NAME} is unpatched).`);
    return;
  } else if (verify) {
    console.log(`${swfPath}: patch required (${CLASS_NAME}.${METHOD_NAME} queues relayed spawning casts).`);
    return;
  }

  if (body.exceptionCount !== 0) {
    throw new PatchError(`${CLASS_NAME}.${METHOD_NAME} has ${body.exceptionCount} exception ranges; their offsets are not rewritten here`);
  }
  for (const inst of instructions) {
    if (inst.opcode === OP_LOOKUPSWITCH) {
      throw new PatchError(`${CLASS_NAME}.${METHOD_NAME} contains a lookupswitch; its case offsets are not rewritten here`);
    }
  }

  let newCode: Buffer;
  if (revert) {
    // Put the single `iffalse` back. The replacement is the four instructions this patch wrote, and
    // the site is found by the shape it left behind rather than by a stored offset.
    const idx = instructions.findIndex((inst, index) =>
      inst.opcode === OP_GETPROPERTY &&
      inst.operands[0]?.[1] === spawnedIdx &&
      instructions[index + 1]?.opcode === OP_IFFALSE);
    const iftrue = instructions[idx - 2];
    const iffalse = instructions[idx + 1];
    if (!iftrue || iftrue.opcode !== OP_IFTRUE || instructions[idx - 1]?.opcode !== OP_GETLOCAL) {
      throw new PatchError(`${CLASS_NAME}.${METHOD_NAME} does not carry this patch's shape; refusing to revert`);
    }
    // Collapse the four instructions back into one iffalse aimed at the same else branch.
    const blockStart = iftrue.offset;
    const blockEnd = iffalse.offset + iffalse.size;
    const elseTarget = iffalse.offset + iffalse.size + (branchOperand(iffalse) ?? 0);
    const shrunk = instructions.filter((inst) => inst.offset < blockStart || inst.offset >= blockEnd);
    const delta = 4 - (blockEnd - blockStart);
    const mapOffset = (old: number): number => (old > blockStart ? old + delta : old);
    const parts: Buffer[] = [];
    for (const inst of shrunk) {
      if (inst.offset === blockEnd) {
        parts.push(Buffer.concat([
          Buffer.from([OP_IFFALSE]),
          s24(mapOffset(elseTarget) - (blockStart + 4)),
        ]));
      }
      const operand = branchOperand(inst);
      if (operand === null) {
        parts.push(code.subarray(inst.offset, inst.offset + inst.size));
        continue;
      }
      const newTarget = mapOffset(inst.offset + inst.size + operand);
      const newOffset = mapOffset(inst.offset);
      parts.push(Buffer.concat([
        code.subarray(inst.offset, inst.offset + inst.size - 3),
        s24(newTarget - (newOffset + inst.size)),
      ]));
    }
    newCode = Buffer.concat(parts);
  } else {
    const siteIndex = findSite(instructions, procFlagIdx);
    const site = instructions[siteIndex];
    const spawned = writeU30(spawnedIdx);
    // iftrue <immediate> ; getlocal power ; getproperty SpawnedMonsters ; iffalse <else>
    const replacementLength = 4 + 2 + (1 + spawned.length) + 4;
    const oldElseTarget = site.offset + site.size + (branchOperand(site) ?? 0);
    const oldImmediateTarget = site.offset + site.size;

    newCode = rewriteCode(code, instructions, siteIndex, replacementLength, (mapOffset, newSiteOffset) => {
      const iffalseOffset = newSiteOffset + 4 + 2 + (1 + spawned.length);
      return Buffer.concat([
        Buffer.from([OP_IFTRUE]), s24(mapOffset(oldImmediateTarget) - (newSiteOffset + 4)),
        Buffer.from([OP_GETLOCAL, LOCAL_POWER]),
        Buffer.from([OP_GETPROPERTY]), spawned,
        Buffer.from([OP_IFFALSE]), s24(mapOffset(oldElseTarget) - (iffalseOffset + 4)),
      ]);
    });
  }

  // Re-disassembling the result is the cheapest proof the rewrite is self-consistent: every branch
  // must land on an instruction boundary inside the new code.
  const check = disassemble(newCode, `${CLASS_NAME}.${METHOD_NAME}(patched)`);
  const boundaries = new Set(check.map((inst) => inst.offset));
  boundaries.add(newCode.length);
  for (const inst of check) {
    const operand = branchOperand(inst);
    if (operand === null) continue;
    const target = inst.offset + inst.size + operand;
    if (!boundaries.has(target)) {
      throw new PatchError(`Rewrite produced a branch at ${inst.offset} targeting ${target}, which is not an instruction boundary`);
    }
  }

  const patches: BytePatch[] = [
    {
      key: `${CLASS_NAME}.${METHOD_NAME}.code`,
      start: body.codeStart,
      end: body.codeStart + body.codeLen,
      data: newCode,
      detail: `code ${body.codeLen} -> ${newCode.length} bytes`,
    },
    {
      key: `${CLASS_NAME}.${METHOD_NAME}.codeLen`,
      start: body.codeLenPos,
      end: body.codeStart,
      data: writeU30(newCode.length),
      detail: `code_length ${body.codeLen} -> ${newCode.length}`,
    },
  ];

  ensureBackup(swfPath);
  const { body: outBody, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, outBody, delta);
  console.log(
    `${swfPath}: ${revert ? "reverted" : "patched"} ${CLASS_NAME}.${METHOD_NAME} ` +
    `(${body.codeLen} -> ${newCode.length} bytes)` +
    (revert ? "." : " -- a relayed cast that spawns monsters now fires on arrival."),
  );
}

try {
  main();
} catch (error) {
  console.error(`Patch error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
