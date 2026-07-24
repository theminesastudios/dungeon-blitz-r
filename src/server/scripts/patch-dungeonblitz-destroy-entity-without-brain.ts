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
} from "./swfPatchUtils";

// The client drops PKTTYPE_ENT_DESTROY for any entity that has no brain
// component, so the server can never remove such an entity from the screen.
//
// LinkUpdater.method_1018 (the 0x0D reader) is:
//
//   var e:Entity = game.GetEntFromID(packet.readID());
//   if (Boolean(e) && Boolean(e.var_38)) {
//       e.var_38.var_2778 = true;   // deferred-removal flag
//   }
//
// and Game's per-entity tick only *reads* that flag through method_1366, which
// it calls only when `var_38` is set — entities without one take method_1770
// instead, which never consults it. So the two halves of the removal path agree:
// no brain, no removal. Such an entity then stands wherever it was created,
// motionless (nothing drives it) and holding every buff FX it was ever given
// (nothing ticks them down), until the level itself is torn down — which is why
// the second Tag Ugo in Dread Goblin Hideout only disappears when the rank plate
// arrives.
//
// This patch gives that branch a fallback: when the entity has no brain, call
// Entity.DestroyEntity(true) directly — the same call Game's own tick loop makes
// when it decides an entity is finished. Entities that do have a brain keep the
// original deferred flag, so the blast radius is exactly the case that was
// silently broken.
//
// The rewrite fits inside the original 38-byte tail, so no branch outside the
// replaced region moves and the method body keeps its length.

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

// Editing index.html's own `clientrev=` literal does nothing: StaticServer
// 302-redirects every SWF request to its own `clientRevision` token, so that
// constant is the only cache key a browser ever sees. Report the SWF's hash and
// let the operator bump StaticServer.clientRevision, or players keep running the
// cached previous build and this patch looks like it did nothing.
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

// Opcodes used below.
const OP_NOP = 0x02;
const OP_PUSHTRUE = 0x26;
const OP_GETLOCAL = 0x62;
const OP_GETPROPERTY = 0x66;
const OP_SETPROPERTY = 0x61;
const OP_IFFALSE = 0x12;
const OP_RETURNVOID = 0x47;
const OP_CALLPROPVOID = 0x4f;
const OP_FINDPROPSTRICT = 0x5d;
const OP_CALLPROPERTY = 0x46;
const OP_DUP = 0x2a;
const OP_CONVERT_B = 0x76;
const OP_POP = 0x29;

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
        "  npx ts-node src/server/scripts/patch-dungeonblitz-destroy-entity-without-brain.ts [--verify] [--swf <path>]",
        "",
        "Makes the client honour PKTTYPE_ENT_DESTROY for entities that have no brain",
        "component. Without it such an entity can never be removed by the server and",
        "stands motionless in the level until the level is torn down.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function s24(value: number): number[] {
  return [value & 0xff, (value >> 8) & 0xff, (value >> 16) & 0xff];
}

function u30(value: number): number[] {
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) {
      byte |= 0x80;
    }
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
}

type Context = {
  ctx: ReturnType<typeof parseSwf>;
  abc: ReturnType<typeof parseAbc>;
  methodBody: NonNullable<ReturnType<ReturnType<typeof parseAbc>["methodBodies"]["get"]>>;
  code: Buffer;
  instructions: Instruction[];
};

function loadMethod1018(swfPath: string): Context {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "LinkUpdater");
  if (classIndex === null) {
    throw new PatchError("Could not find LinkUpdater class.");
  }

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1018");
  if (methodIdx === null) {
    throw new PatchError("Could not find LinkUpdater.method_1018 (the PKTTYPE_ENT_DESTROY reader).");
  }

  const methodBody = abc.methodBodies.get(methodIdx);
  if (!methodBody) {
    throw new PatchError(`Could not find a method body for LinkUpdater.method_1018 (${methodIdx}).`);
  }

  const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
  return { ctx, abc, methodBody, code, instructions: disassemble(code, "LinkUpdater.method_1018") };
}

function multinameIndex(context: Context, name: string, opcodes: number[]): number {
  // A multiname carries the namespace set of the class that declares it, so the
  // index must be one this method's own class already uses — see the MultinameL
  // trap in swfPatchUtils. Take it from an existing instruction in this method
  // where possible, and otherwise from anywhere in LinkUpdater.
  const classIndex = classIndexByName(context.abc, "LinkUpdater");
  if (classIndex === null) {
    throw new PatchError("Could not find LinkUpdater class.");
  }

  const methodIdxs = new Set<number>();
  for (const trait of context.abc.instances[classIndex].traits) {
    if (trait.methodIdx !== null) {
      methodIdxs.add(trait.methodIdx);
    }
  }

  for (const methodIdx of methodIdxs) {
    const body = context.abc.methodBodies.get(methodIdx);
    if (!body) {
      continue;
    }
    const code = context.ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    let instructions: Instruction[];
    try {
      instructions = disassemble(code, `LinkUpdater.method#${methodIdx}`);
    } catch {
      continue;
    }
    for (const instruction of instructions) {
      if (!opcodes.includes(instruction.opcode) || instruction.operands.length === 0) {
        continue;
      }
      const index = instruction.operands[0][1];
      if (context.abc.multinameNames[index] === name) {
        return index;
      }
    }
  }

  throw new PatchError(`Could not resolve a LinkUpdater-scoped multiname for "${name}".`);
}

// The exact original tail, so a changed client is refused rather than corrupted.
function findOriginalTail(context: Context): { start: number; end: number; var38: number; flag: number } {
  const { instructions, abc } = context;
  for (let i = 0; i + 16 < instructions.length; i += 1) {
    const window = instructions.slice(i, i + 17);
    const opcodes = window.map((instruction) => instruction.opcode);
    const expected = [
      OP_FINDPROPSTRICT, OP_GETLOCAL, OP_CALLPROPERTY, OP_DUP, OP_CONVERT_B, OP_IFFALSE, OP_POP,
      OP_FINDPROPSTRICT, OP_GETLOCAL, OP_GETPROPERTY, OP_CALLPROPERTY, OP_IFFALSE,
      OP_GETLOCAL, OP_GETPROPERTY, OP_PUSHTRUE, OP_SETPROPERTY, OP_RETURNVOID,
    ];
    if (opcodes.join(",") !== expected.join(",")) {
      continue;
    }

    const var38 = window[9].operands[0][1];
    const flag = window[15].operands[0][1];
    if (abc.multinameNames[var38] !== abc.multinameNames[window[13].operands[0][1]]) {
      continue;
    }
    const last = window[16];
    return { start: window[0].offset, end: last.offset + last.size, var38, flag };
  }

  throw new PatchError(
    "LinkUpdater.method_1018 does not have the expected destroy tail; refusing to patch an unknown client.",
  );
}

function alreadyPatched(context: Context): boolean {
  return context.instructions.some(
    (instruction) =>
      instruction.opcode === OP_CALLPROPVOID &&
      instruction.operands.length > 0 &&
      context.abc.multinameNames[instruction.operands[0][1]] === "DestroyEntity",
  );
}

function buildTail(tail: { start: number; end: number; var38: number; flag: number }, destroyEntity: number): Buffer {
  const var38 = u30(tail.var38);
  const flag = u30(tail.flag);
  const destroy = u30(destroyEntity);

  // Offsets are computed from the region start so the two branches land exactly
  // on the alternative path and on the method's original returnvoid.
  const noBrain =
    2 + // getlocal 4
    4 + // iffalse -> return
    2 + // getlocal 4
    (1 + var38.length) + // getproperty var_38
    4 + // iffalse -> noBrain
    2 + // getlocal 4
    (1 + var38.length) + // getproperty var_38
    1 + // pushtrue
    (1 + flag.length) + // setproperty var_2778
    1; // returnvoid

  const afterCall = noBrain + 2 + 1 + (1 + destroy.length + 1);
  const total = tail.end - tail.start;
  const returnOffset = total - 1;
  if (afterCall > returnOffset) {
    throw new PatchError("Rewritten destroy tail does not fit in the original method body.");
  }

  const bytes: number[] = [
    OP_GETLOCAL, 4,
    OP_IFFALSE, ...s24(returnOffset - 6),
    OP_GETLOCAL, 4,
    OP_GETPROPERTY, ...var38,
    OP_IFFALSE, ...s24(noBrain - (13 + var38.length)),
    OP_GETLOCAL, 4,
    OP_GETPROPERTY, ...var38,
    OP_PUSHTRUE,
    OP_SETPROPERTY, ...flag,
    OP_RETURNVOID,
    OP_GETLOCAL, 4,
    OP_PUSHTRUE,
    OP_CALLPROPVOID, ...destroy, 1,
  ];

  while (bytes.length < returnOffset) {
    bytes.push(OP_NOP);
  }
  bytes.push(OP_RETURNVOID);

  if (bytes.length !== total) {
    throw new PatchError(`Rewritten destroy tail is ${bytes.length} bytes, expected ${total}.`);
  }
  return Buffer.from(bytes);
}

function patchSwf(swfPath: string, verify: boolean): void {
  const context = loadMethod1018(swfPath);

  if (alreadyPatched(context)) {
    console.log(`${swfPath}: already patched (LinkUpdater.method_1018 destroys brainless entities).`);
    reportCacheKey(swfPath);
    return;
  }
  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; brainless entities still ignore PKTTYPE_ENT_DESTROY.`);
  }

  const tail = findOriginalTail(context);
  const destroyEntity = multinameIndex(context, "DestroyEntity", [OP_CALLPROPVOID, OP_CALLPROPERTY]);
  const data = buildTail(tail, destroyEntity);

  const patches: BytePatch[] = [
    {
      key: "LinkUpdater.method_1018.destroyTail",
      start: context.methodBody.codeStart + tail.start,
      end: context.methodBody.codeStart + tail.end,
      data,
      detail: "destroy brainless entities instead of dropping the packet",
    },
  ];

  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(context.ctx.body, patches);
  writeSwf(context.ctx, body, delta);
  reportCacheKey(swfPath);
  console.log(
    `${swfPath}: patched LinkUpdater.method_1018 ` +
    `(${data.length} bytes rewritten in place, DestroyEntity multiname ${destroyEntity}).`,
  );
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
