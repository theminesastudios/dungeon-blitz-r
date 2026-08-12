import * as crypto from "crypto";
import * as fs from "fs";
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
  readU30,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

/**
 * The client tells the server its Defense.
 *
 * Packet 0xFC (LinkUpdater.const_969, the server's handleSendCombatStats) is the one message
 * that carries a player's own derived stats, and it carries three of them: meleeDamage,
 * magicDamage and maxHP -- Attack, Expertise and max Health. `armorClass`, which the screens
 * call Defense, has never been in it, so no server-side rule has ever been able to read it.
 *
 * That is what blocked the Defense half of the Sentinel passive (issue #670): "0.1% of your
 * Defense" is a number the server cannot see. The obvious alternative -- putting the whole
 * passive in CombatState.method_1393, next to Holy Smash and Retribution, which already read
 * armorClass -- is closed. CombatState carries raw bytecode injections in method_960, and
 * FFDec can no longer decompile past them: the method comes back truncated with a bare
 * `§§goto`, so a source recompile would delete around 110 lines of live combat code. See the
 * note at the top of patch-dungeonblitz-templar-talent-effects.
 *
 * So the stat comes to the server instead, and every future Defense-scaled server rule gets
 * it for free.
 *
 * Why this is a safe splice, which is the whole reason it is done as raw bytecode rather than
 * an FFDec source recompile of a 5,000-line networking class:
 *
 *   - method_1834 is 142 bytes and completely branch-free. Nothing in it carries an s24, so
 *     inserting bytes in the middle cannot invalidate a jump target. This is asserted, not
 *     assumed.
 *   - It declares no exception ranges, so there are no handler offsets to re-target.
 *   - The insert is appended after the *last* field the method writes, so the packet keeps
 *     its existing layout and the new value lands on the end. A server that does not read the
 *     extra field, or a client too old to send it, both still work -- which matters, because
 *     browsers cache the SWF and the two halves do not update in lockstep.
 *   - The block pushes two values and pops both. max_stack is checked against that.
 *
 * Every operand is lifted from real code rather than looked up by name. `var_1`, `clientEnt`
 * and `method_9` come from the maxHP write three statements up, and the Packet local comes
 * from the statement the insert follows, so the new write is byte-for-byte the same shape as
 * the three already there. `armorClass` cannot come from this method -- it is not in it -- so
 * it is taken from the one multiname in the file with that name, checked to be the one some
 * other class already reads straight off `clientEnt`; a QName carries its namespace, and one
 * borrowed from the wrong namespace assembles cleanly and reads nothing.
 */

const DEFAULT_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf",
);
const INDEX_HTML = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "index.html");

const TARGET_CLASS = "LinkUpdater";
const TARGET_METHOD = "method_1834";
const ARMOR_PROPERTY = "armorClass";
const RECEIVER_PROPERTY = "clientEnt";
const WRITE_METHOD = "method_9";

const OP_GETLOCAL_0 = 0xd0;
const OP_GETLOCAL = 0x62;
const OP_GETPROPERTY = 0x66;
const OP_CALLPROPERTY = 0x46;
const OP_CALLPROPVOID = 0x4f;
const OP_LOOKUPSWITCH = 0x1b;

/** The insert pushes the Packet and one value, and pops both. */
const INSERT_MAX_STACK = 2;

function encode(inst: Instruction, code: Buffer): Buffer {
  return Buffer.from(code.subarray(inst.offset, inst.offset + inst.size));
}

function isGetLocal(inst: Instruction | undefined): boolean {
  return Boolean(inst) && (inst!.opcode === OP_GETLOCAL || (inst!.opcode >= 0xd0 && inst!.opcode <= 0xd3));
}

function isCall(inst: Instruction | undefined): boolean {
  return Boolean(inst) && (inst!.opcode === OP_CALLPROPERTY || inst!.opcode === OP_CALLPROPVOID);
}

interface Located {
  ctx: ReturnType<typeof parseSwf>;
  abc: ReturnType<typeof parseAbc>;
  body: NonNullable<ReturnType<ReturnType<typeof parseAbc>["methodBodies"]["get"]>>;
  code: Buffer;
  instructions: Instruction[];
  alreadyApplied: boolean;
}

function locate(swfPath: string): Located {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);

  const classIndex = classIndexByName(abc, TARGET_CLASS);
  if (classIndex === null) throw new PatchError(`${TARGET_CLASS} class not found.`);
  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, TARGET_METHOD);
  if (methodIdx === null) throw new PatchError(`${TARGET_CLASS}.${TARGET_METHOD} not found.`);
  const body = abc.methodBodies.get(methodIdx);
  if (!body) throw new PatchError(`No method body for ${TARGET_CLASS}.${TARGET_METHOD}.`);
  if (body.exceptionCount !== 0) {
    throw new PatchError(`${TARGET_CLASS}.${TARGET_METHOD} has an exception table; its handler offsets would need re-targeting.`);
  }

  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  const instructions = disassemble(code, `${TARGET_CLASS}.${TARGET_METHOD}`);
  const last = instructions[instructions.length - 1];
  if (!last || last.offset + last.size !== body.codeLen) {
    throw new PatchError(`Disassembly of ${TARGET_CLASS}.${TARGET_METHOD} does not cover its code exactly.`);
  }
  if (instructions.some((inst) => inst.opcode === OP_LOOKUPSWITCH)) {
    throw new PatchError(`${TARGET_CLASS}.${TARGET_METHOD} contains a lookupswitch; its jump table is not offset-safe here.`);
  }
  // The load-bearing assumption. A mid-method insert shifts everything after it, and a
  // relative branch that spans the insert would silently land in the middle of an
  // instruction; there are none, so there is nothing to fix up.
  const branch = instructions.find((inst) => inst.operands.some(([kind]) => kind === "s24"));
  if (branch) {
    throw new PatchError(
      `${TARGET_CLASS}.${TARGET_METHOD} branches at offset ${branch.offset}; a mid-method insert is no longer offset-safe.`,
    );
  }

  const alreadyApplied = instructions.some(
    (inst) => inst.opcode === OP_GETPROPERTY && abc.multinameNames[inst.operands[0][1] as number] === ARMOR_PROPERTY,
  );

  return { ctx, abc, body, code, instructions, alreadyApplied };
}

/** The multiname for Entity.armorClass, proven by another class reading it off `clientEnt`. */
function armorClassOperand(abc: ReturnType<typeof parseAbc>, ctx: ReturnType<typeof parseSwf>): number {
  const named = abc.multinameNames
    .map((name, index) => (name === ARMOR_PROPERTY ? index : -1))
    .filter((index) => index >= 0);
  if (named.length !== 1) {
    throw new PatchError(`Expected exactly one "${ARMOR_PROPERTY}" multiname, found ${named.length}.`);
  }

  const operand = named[0];
  for (const [, body] of abc.methodBodies) {
    let instructions: Instruction[];
    try {
      instructions = disassemble(ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen), "scan");
    } catch {
      continue; // lookupswitch bodies the shared disassembler cannot walk; none of them matter here.
    }
    for (let index = 1; index < instructions.length; index += 1) {
      const inst = instructions[index];
      const previous = instructions[index - 1];
      if (inst.opcode !== OP_GETPROPERTY || (inst.operands[0][1] as number) !== operand) continue;
      if (previous.opcode !== OP_GETPROPERTY) continue;
      if (abc.multinameNames[previous.operands[0][1] as number] === RECEIVER_PROPERTY) return operand;
    }
  }

  throw new PatchError(`No "${RECEIVER_PROPERTY}.${ARMOR_PROPERTY}" read found; the operand's namespace cannot be trusted.`);
}

/**
 * The bytes to insert, and where. Both come out of the method's own last two field writes:
 * the maxHP write supplies the receiver chain and the write call, and the statement the
 * insert follows supplies the Packet local.
 */
function buildInsert(located: Located): { at: number; bytes: Buffer } {
  const { abc, code, instructions } = located;
  const nameOf = (inst: Instruction): string => abc.multinameNames[inst.operands[0]?.[1] as number] ?? "";

  const writeCalls = instructions.filter((inst) => inst.opcode === OP_CALLPROPVOID && nameOf(inst) === WRITE_METHOD);
  if (writeCalls.length === 0) {
    throw new PatchError(`${TARGET_CLASS}.${TARGET_METHOD} writes no ${WRITE_METHOD} fields; this is not the packet builder.`);
  }

  // `this.var_1.clientEnt.<stat>` -- the receiver chain, taken from a real stat write.
  const receiverIndex = instructions.findIndex((inst) => inst.opcode === OP_GETPROPERTY && nameOf(inst) === RECEIVER_PROPERTY);
  if (receiverIndex < 2) {
    throw new PatchError(`${TARGET_CLASS}.${TARGET_METHOD} does not read ${RECEIVER_PROPERTY} the way this patch expects.`);
  }
  const ownerRead = instructions[receiverIndex - 1];
  const selfRead = instructions[receiverIndex - 2];
  if (ownerRead.opcode !== OP_GETPROPERTY || selfRead.opcode !== OP_GETLOCAL_0) {
    throw new PatchError(`${RECEIVER_PROPERTY} is not read off "this" in ${TARGET_CLASS}.${TARGET_METHOD}.`);
  }

  // The last field the method writes; the new one goes straight after it so the packet keeps
  // its layout and Defense lands on the end.
  const lastWrite = writeCalls[writeCalls.length - 1];
  const lastWriteIndex = instructions.indexOf(lastWrite);
  let statementStart = lastWriteIndex;
  while (statementStart > 0 && !isCall(instructions[statementStart - 1])) statementStart -= 1;
  const packetPush = instructions[statementStart];
  if (!isGetLocal(packetPush)) {
    throw new PatchError(`The final ${WRITE_METHOD} write does not begin by pushing the Packet local.`);
  }

  return {
    at: lastWrite.offset + lastWrite.size,
    bytes: Buffer.concat([
      encode(packetPush, code),
      encode(selfRead, code),
      encode(ownerRead, code),
      encode(instructions[receiverIndex], code),
      Buffer.concat([Buffer.from([OP_GETPROPERTY]), writeU30(armorClassOperand(abc, located.ctx))]),
      encode(lastWrite, code),
    ]),
  };
}

/**
 * index.html requests the SWF at a fixed `clientrev=` token, so a browser serves a stale copy
 * after the file on disk changes -- a correct patch that nobody loads. Pin it to the content
 * hash. Run this last if other scripts also rewrite the SWF.
 */
function syncClientRev(swfPath: string): void {
  if (path.resolve(swfPath) !== DEFAULT_SWF || !fs.existsSync(INDEX_HTML)) return;
  const digest = crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const updated = html.replace(/clientrev=[^&`"'$]+/, `clientrev=swf-${digest}`);
  if (updated !== html) {
    fs.writeFileSync(INDEX_HTML, updated);
    console.log(`  index.html clientrev -> swf-${digest} (cache buster)`);
  }
}

export function patchCombatStatsArmor(swfPath: string, verifyOnly = false): boolean {
  const located = locate(swfPath);
  const { ctx, body, code } = located;

  if (located.alreadyApplied) {
    console.log(`${swfPath}: verified Defense in the combat stats packet.`);
    if (!verifyOnly) syncClientRev(swfPath);
    return false;
  }
  if (verifyOnly) {
    throw new PatchError(`${swfPath}: verify failed; the combat stats packet does not carry Defense.`);
  }

  const insert = buildInsert(located);
  const [maxStack] = readU30(ctx.body, body.maxStackPos, `${TARGET_METHOD}.max_stack`);
  if (maxStack < INSERT_MAX_STACK) {
    throw new PatchError(`${TARGET_METHOD} declares max_stack ${maxStack}; the insert peaks at ${INSERT_MAX_STACK}.`);
  }

  const patchedCode = Buffer.concat([code.subarray(0, insert.at), insert.bytes, code.subarray(insert.at)]);
  const rewalked = disassemble(patchedCode, `${TARGET_CLASS}.${TARGET_METHOD} (patched)`);
  const last = rewalked[rewalked.length - 1];
  if (last.offset + last.size !== patchedCode.length) {
    throw new PatchError("The patched body does not disassemble cleanly to its own length.");
  }

  const patches: BytePatch[] = [
    {
      key: `${TARGET_CLASS}.${TARGET_METHOD}.code`,
      start: body.codeStart,
      end: body.codeStart + body.codeLen,
      data: patchedCode,
      detail: "send the player's Defense in the combat stats packet",
    },
    {
      key: `${TARGET_CLASS}.${TARGET_METHOD}.codeLen`,
      start: body.codeLenPos,
      end: body.codeStart,
      data: writeU30(patchedCode.length),
      detail: "method body length",
    },
  ];

  ensureBackup(swfPath);
  const { body: outBody, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, outBody, delta);
  console.log(`${swfPath}: combat stats packet now carries Defense (+${insert.bytes.length} bytes).`);
  syncClientRev(swfPath);
  return true;
}

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") swfPath = path.resolve(argv[++index] || "");
    else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npx ts-node src/server/scripts/patch-dungeonblitz-combat-stats-armor.ts [--verify] [--swf <path>]",
        "",
        "Appends the player's Defense (Entity.armorClass) to packet 0xFC so server-side rules",
        "can read it. Required by the Sentinel passive's Defense term.",
      ].join("\n"));
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify };
}

function main(): number {
  const { swfPath, verify } = parseArgs(process.argv);
  try {
    patchCombatStatsArmor(swfPath, verify);
    return 0;
  } catch (error) {
    console.error(`[patch-dungeonblitz-combat-stats-armor] ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
