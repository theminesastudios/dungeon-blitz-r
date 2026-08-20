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
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

// Give the server a way to REMOVE a body the client spawned, leaving no corpse.
//
// A hostile the client spawned from a level cue has no `var_38` (class_122), the
// server-driven remote-entity record, so both packets that would normally take it away are
// discarded at the door: LinkUpdater.method_1072 (0x07) and method_1018 (0x0D) each open
// with a `var_38` test. The only channel that lands is 0x78, whose reader calls TakeDamage,
// so the server can currently only clear such a body by killing it. That works -- it is how
// EntityHandler buries an enemy another member already killed -- but it looks like what it
// is: the client plays the death and then leaves the corpse lying there for
// TIME_MONSTER_LAYS_DEAD_BEFORE_VANISHING, which is ten seconds.
//
// For a member joining a dungeon their party has half cleared, that is a room full of
// enemies dying in front of them on arrival, for kills somebody else made minutes ago.
//
// THE MECHANISM: Entity.var_1835, the engine's own retire-me tombstone.
//
// Game.method_1970 ticks brainless entities under `if (!entity.var_38)` -- exactly this set
// -- and retires any whose tick returns false with `DestroyEntity(true); entities.splice(i, 1)`,
// destroy AND splice in the order it expects. Entity.method_1770 opens with
// `if (this.var_1835) return false`, reached before any field DestroyEntity would empty. One
// property write and the body is gone on the next tick, with no death animation and no corpse.
// A property write cannot throw and nothing is torn down here, so this cannot crash.
//
// WHY NOT PATCH 0x0D. Making the destroy reader honour these entities is written and was
// playtested (patch-dungeonblitz-destroy-entity-without-brain.ts, which holds the long
// account) and it was reverted for a reason that still stands: 0x0D was a silent no-op here,
// which masked every routine destroy the server already sends -- relevance culling above all
// -- and honouring it made all of them lethal. Enemies vanished that had never been hit. It
// needs an audit of some twenty send sites before it can be used again.
//
// So this takes a channel the server has never sent instead. LinkUpdater.const_1271 is
// declaration 52 of the TYPE_ITERATOR run that starts at PKTTYPE_ENT_FULL_UPDATE = 0x08, so
// it is 0x3B; the same arithmetic puts PKTTYPE_ENT_DESTROY (#6) at 0x0D and PKTTYPE_CHAR_REGEN
// (#113) at 0x78, which is how it was checked. Its reader is method_1408, and nothing in the
// game can trigger it, because nothing sends 0x3B.
//
// THE EDIT IS SMALL, DELIBERATELY. method_1408 already reads the entity id, resolves it
// through GetEntFromID and null-checks the result -- the whole first 64 bytes are what we
// want. Only its 17-byte tail, the `method_3000(ent, -amount, ent != clientEnt)` call, is
// replaced. The id read, the second (amount) read and the null-check branch are untouched,
// which means:
//
//   * The wire format does not change. The reader still consumes both fields, so the server
//     sends 0x3B with the same (id, amount) shape as 0x78 and the amount is simply ignored.
//     Under-reading here would desync every packet behind it in the buffer.
//   * The `iffalse` at offset 60 still lands on the method's own returnvoid, so no branch
//     moves and code_length is unchanged (the replacement is padded with nops).

const DEFAULT_SWF = path.resolve(
  __dirname,
  "..",
  "..",
  "client",
  "content",
  "localhost",
  "p",
  "cbp",
  "DungeonBlitz.swf",
);

// Editing index.html's own `clientrev=` literal does nothing: StaticServer 302-redirects
// every SWF request to its own `clientRevision` token, so that constant is the only cache key
// a browser ever sees. Report the hash and let the operator bump it, or players keep running
// the cached previous build and this patch looks like it did nothing.
function reportCacheKey(swfPath: string): void {
  if (!fs.existsSync(swfPath)) {
    return;
  }
  const digest = crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
  console.log(
    `  DungeonBlitz.swf is now swf-${digest}. ` +
    "Bump StaticServer.clientRevision so browsers stop serving the cached client.",
  );
}

// Entity's retire-me tombstone. One read site (the head of Entity.method_1770) and, before
// this patch, one write site (DestroyEntity -- which stamps it on the entity's ghost,
// `this.var_183`, and never on `this`, which is why DestroyEntity is not a substitute).
const TOMBSTONE = "var_1835";
const HP_APPLIER = "method_3000";

const OP_NOP = 0x02;
const OP_GETLOCAL_0 = 0xd0;
const OP_GETLOCAL_3 = 0xd3;
const OP_GETLOCAL = 0x62;
const OP_SETLOCAL = 0x63;
const OP_PUSHTRUE = 0x26;
const OP_SETPROPERTY = 0x61;
const OP_GETPROPERTY = 0x66;
const OP_CALLPROPERTY = 0x46;
const OP_CALLPROPVOID = 0x4f;
const OP_EQUALS = 0xab;
const OP_NOT = 0x96;
const OP_RETURNVOID = 0x47;
const OP_IFFALSE = 0x12;
const OP_COERCE = 0x80;

const KIND_QNAME = 0x07;

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npx ts-node src/server/scripts/patch-dungeonblitz-retire-entity-packet.ts [--verify] [--swf <path>]",
        "",
        "Repurposes packet 0x3B (LinkUpdater.method_1408, which the server has never sent) into",
        "a retire-entity channel: it resolves the entity id and sets Entity.var_1835, the engine's",
        "own retire-me tombstone. The next tick removes the body with no death animation and no",
        "corpse, which is the only way to clear a client-spawned hostile that a joining party",
        "member should never have seen alive.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

type Context = {
  ctx: ReturnType<typeof parseSwf>;
  abc: ReturnType<typeof parseAbc>;
  methodBody: NonNullable<ReturnType<ReturnType<typeof parseAbc>["methodBodies"]["get"]>>;
  code: Buffer;
  instructions: Instruction[];
};

function loadMethod1408(swfPath: string): Context {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "LinkUpdater");
  if (classIndex === null) {
    throw new PatchError("Could not find LinkUpdater class.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1408");
  if (methodIdx === null) {
    throw new PatchError("Could not find LinkUpdater.method_1408 (the 0x3B reader).");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find a method body for LinkUpdater.method_1408 (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  return { ctx, abc, methodBody, code, instructions: disassemble(code, "LinkUpdater.method_1408") };
}

// `var_1835` is declared internal on Entity and LinkUpdater never touches it, so the index has
// to be borrowed. That is only safe for a QName, which names one absolute namespace and so
// resolves identically from any class; a Multiname or MultinameL resolves through a namespace
// *set* belonging to the class it was written for, and borrowing one of those is the trap.
function tombstoneMultiname(context: Context): number {
  const matches: number[] = [];
  context.abc.multinameNames.forEach((name, index) => {
    if (name === TOMBSTONE) {
      matches.push(index);
    }
  });

  if (matches.length !== 1) {
    throw new PatchError(
      `Expected exactly one "${TOMBSTONE}" multiname, found ${matches.length}; refusing to guess.`,
    );
  }

  const index = matches[0];
  const kind = context.abc.multinameKinds[index];
  if (kind !== KIND_QNAME) {
    throw new PatchError(
      `"${TOMBSTONE}" resolves to multiname ${index} of kind 0x${kind.toString(16)}, not a QName; ` +
      "it cannot be borrowed from another class. Refusing to patch.",
    );
  }
  return index;
}

// The exact original head and tail, so a changed client is refused rather than corrupted.
//
// Head, which we keep verbatim and rely on:
//   getlocal0; getproperty var_1; getlocal2; callproperty GetEntFromID,1
//   coerce Entity; setlocal 4; getlocal 4; iffalse -> returnvoid
//
// Tail, which we replace:
//   getlocal0; getlocal 4; getlocal3; getlocal 4; getlocal0;
//   getproperty var_1; getproperty clientEnt; equals; not;
//   callpropvoid method_3000,3; returnvoid
type Region = { start: number; end: number; entityLocal: number };

function findOriginalShape(context: Context): Region {
  const { instructions, abc } = context;

  for (let i = 0; i + 7 < instructions.length; i += 1) {
    const head = instructions.slice(i, i + 8);
    const headOps = head.map((instruction) => instruction.opcode);
    const expectedHead = [
      OP_GETLOCAL_0, OP_GETPROPERTY, 0xd2 /* getlocal2 */, OP_CALLPROPERTY,
      OP_COERCE, OP_SETLOCAL, OP_GETLOCAL, OP_IFFALSE,
    ];
    if (headOps.join(",") !== expectedHead.join(",")) {
      continue;
    }
    if (abc.multinameNames[head[3].operands[0][1]] !== "GetEntFromID") {
      continue;
    }

    const entityLocal = head[5].operands[0][1];
    if (head[6].operands[0][1] !== entityLocal) {
      continue;
    }

    // The null-check must fall through into the tail we are about to replace, and its
    // false branch must be the method's own returnvoid. Anything else and the offsets we
    // are leaving in place would no longer mean what they mean today.
    const tailStart = head[7].offset + head[7].size;
    const tail = instructions.filter((instruction) => instruction.offset >= tailStart);
    const tailOps = tail.map((instruction) => instruction.opcode);
    const expectedTail = [
      OP_GETLOCAL_0, OP_GETLOCAL, OP_GETLOCAL_3, OP_GETLOCAL, OP_GETLOCAL_0,
      OP_GETPROPERTY, OP_GETPROPERTY, OP_EQUALS, OP_NOT, OP_CALLPROPVOID, OP_RETURNVOID,
    ];
    if (tailOps.join(",") !== expectedTail.join(",")) {
      continue;
    }
    if (abc.multinameNames[tail[9].operands[0][1]] !== HP_APPLIER) {
      continue;
    }

    const last = tail[tail.length - 1];
    if (last.offset + last.size !== context.methodBody.codeLen) {
      continue;
    }

    // `iffalse` operands are relative to the end of the branch instruction.
    if (head[7].offset + head[7].size + head[7].operands[0][1] !== last.offset) {
      throw new PatchError(
        "LinkUpdater.method_1408's null-check does not branch to its own returnvoid; refusing to patch.",
      );
    }

    return { start: tailStart, end: last.offset, entityLocal };
  }

  throw new PatchError(
    "LinkUpdater.method_1408 does not have the expected 0x3B shape; refusing to patch an unknown client.",
  );
}

// The marker is the tombstone write itself. There is nothing else distinctive to look for,
// because the patched body calls nothing at all.
function alreadyPatched(context: Context): boolean {
  return context.instructions.some(
    (instruction) =>
      instruction.opcode === OP_SETPROPERTY &&
      instruction.operands.length > 0 &&
      context.abc.multinameNames[instruction.operands[0][1]] === TOMBSTONE,
  );
}

function buildTail(region: Region, tombstone: number): Buffer {
  // `ent.var_1835 = true` -- one property write, and deliberately nothing else. The engine
  // does the rest on its next tick.
  const replacement = Buffer.concat([
    Buffer.from([OP_GETLOCAL]), writeU30(region.entityLocal),
    Buffer.from([OP_PUSHTRUE]),
    Buffer.from([OP_SETPROPERTY]), writeU30(tombstone),
  ]);

  const room = region.end - region.start;
  if (replacement.length > room) {
    throw new PatchError(
      `Rewritten tail needs ${replacement.length} bytes but the original holds ${room}.`,
    );
  }

  // Padded to the original length so the method's returnvoid stays where it is, the
  // null-check branch still lands on it, and code_length does not move.
  return Buffer.concat([replacement, Buffer.alloc(room - replacement.length, OP_NOP)]);
}

function main(): number {
  const args = parseArgs(process.argv);
  const context = loadMethod1408(args.swfPath);

  console.log(`SWF: ${args.swfPath}`);

  if (alreadyPatched(context)) {
    console.log(`${args.swfPath}: already patched (0x3B retires the entity it names).`);
    return 0;
  }

  const region = findOriginalShape(context);
  const tombstone = tombstoneMultiname(context);
  const tail = buildTail(region, tombstone);

  const patch: BytePatch = {
    key: "LinkUpdater.method_1408.retireTail",
    start: context.methodBody.codeStart + region.start,
    end: context.methodBody.codeStart + region.end,
    data: tail,
    detail:
      `LinkUpdater.method_1408 (0x3B) sets Entity.${TOMBSTONE} on local ${region.entityLocal} ` +
      "so a client-spawned body retires with no death animation and no corpse",
  };

  console.log(`Patch: ${patch.detail}`);

  if (args.verify) {
    console.error(`${args.swfPath}: verify failed; 0x3B still routes to ${HP_APPLIER}.`);
    return 1;
  }

  ensureBackup(args.swfPath);
  const applied = applyPatchesToBody(context.ctx.body, [patch]);
  writeSwf(context.ctx, applied.body, applied.delta);
  console.log(`${args.swfPath}: patched LinkUpdater.method_1408 into a retire-entity channel.`);
  reportCacheKey(args.swfPath);
  return 0;
}

try {
  process.exitCode = main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
