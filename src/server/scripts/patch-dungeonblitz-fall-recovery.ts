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
  readU30,
  u30OperandName,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";

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

type Op = { kind: "op"; opcode: number; operands?: Buffer[] };
type Label = { kind: "label"; name: string };
type Branch = { kind: "branch"; opcode: number; target: string };
type AsmEntry = Op | Label | Branch;

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
    } else if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npm exec tsx src/server/scripts/patch-dungeonblitz-fall-recovery.ts [--verify] [--swf <path>]",
        "",
        "Makes authored Plummet and generic out-of-bounds recovery prefer the last",
        "grounded surface over room/global first-spawn markers.",
      ].join("\n"));
      process.exit(0);
    } else {
      throw new PatchError(`Unknown argument: ${arg}`);
    }
  }
  return { swfPath, verify };
}

function s24(value: number): Buffer {
  if (value < -0x800000 || value > 0x7fffff) {
    throw new PatchError(`s24 branch offset out of range: ${value}`);
  }
  const out = Buffer.alloc(3);
  out.writeIntLE(value, 0, 3);
  return out;
}

function assemble(entries: AsmEntry[]): Buffer {
  const labels = new Map<string, number>();
  let offset = 0;
  for (const entry of entries) {
    if (entry.kind === "label") {
      labels.set(entry.name, offset);
      continue;
    }
    offset += 1 + (entry.kind === "branch" ? 3 : (entry.operands ?? []).reduce((sum, operand) => sum + operand.length, 0));
  }

  const chunks: Buffer[] = [];
  offset = 0;
  for (const entry of entries) {
    if (entry.kind === "label") {
      continue;
    }
    if (entry.kind === "branch") {
      const target = labels.get(entry.target);
      if (target === undefined) {
        throw new PatchError(`Unknown label: ${entry.target}`);
      }
      chunks.push(Buffer.concat([Buffer.from([entry.opcode]), s24(target - (offset + 4))]));
      offset += 4;
      continue;
    }
    const encoded = Buffer.concat([Buffer.from([entry.opcode]), ...(entry.operands ?? [])]);
    chunks.push(encoded);
    offset += encoded.length;
  }
  return Buffer.concat(chunks);
}

function op(opcode: number, ...operands: number[]): Op {
  return { kind: "op", opcode, operands: operands.map(writeU30) };
}

function byte(value: number): Op {
  return { kind: "op", opcode: 0x24, operands: [Buffer.from([value & 0xff])] };
}

function branch(opcode: number, target: string): Branch {
  return { kind: "branch", opcode, target };
}

function label(name: string): Label {
  return { kind: "label", name };
}

function findMultiname(abc: ReturnType<typeof parseAbc>, name: string): number {
  const matches = abc.multinameNames
    .map((candidate, index) => candidate === name ? index : -1)
    .filter((index) => index >= 0);
  const index = matches[0];
  if (index === undefined) {
    throw new PatchError(`Required multiname ${name} was not found.`);
  }
  return index;
}

function findMethodMultiname(
  instructions: ReturnType<typeof disassemble>,
  abc: ReturnType<typeof parseAbc>,
  name: string,
  opcode: number,
): number {
  const instruction = instructions.find((candidate) =>
    candidate.opcode === opcode && u30OperandName(candidate, abc.multinameNames) === name
  );
  const operand = instruction?.operands[0];
  if (!operand || operand[0] !== "u30") {
    throw new PatchError(`Required ${name} opcode 0x${opcode.toString(16)} was not found in the fall recovery method.`);
  }
  return operand[1];
}

function buildSurfaceMidpoint(multinames: Record<string, number>, doneLabel: string): AsmEntry[] {
  return [
    op(0xd0), op(0x66, multinames.var703), op(0x66, multinames.startX),
    op(0xd0), op(0x66, multinames.var703), op(0x66, multinames.endX),
    op(0xd0), op(0x66, multinames.var703), op(0x66, multinames.startX),
    op(0xa1), byte(2), op(0xa3), op(0xa0), op(0x75), op(0xd5),
    op(0xd0), op(0x66, multinames.var703), op(0x66, multinames.startY),
    op(0xd0), op(0x66, multinames.var703), op(0x66, multinames.endY),
    op(0xd0), op(0x66, multinames.var703), op(0x66, multinames.startY),
    op(0xa1), byte(2), op(0xa3), op(0xa0), byte(5), op(0xa1), op(0x75), op(0xd6),
    branch(0x10, doneLabel),
  ];
}

function buildAuthoredRecovery(multinames: Record<string, number>): Buffer {
  return assemble([
    op(0xd0), op(0x30),
    op(0xd0), byte(0), op(0x61, multinames.var2170),
    op(0xd0), op(0x27), op(0x61, multinames.var1122),
    op(0xd0), op(0x66, multinames.velocity), byte(0), op(0x61, multinames.x),
    op(0xd0), op(0x66, multinames.var703), branch(0x12, "room"),
    ...buildSurfaceMidpoint(multinames, "teleport"),
    label("room"),
    op(0xd0), op(0x66, multinames.currRoom), op(0x66, multinames.var928), branch(0x12, "global"),
    op(0xd0), op(0xd0), op(0x66, multinames.currRoom), op(0x66, multinames.var928), op(0x66, multinames.x),
    op(0xd0), op(0x66, multinames.currRoom), op(0x66, multinames.var928), op(0x66, multinames.y),
    op(0x4f, multinames.teleportTo, 2),
    branch(0x10, "end"),
    label("global"),
    op(0xd0), op(0x66, multinames.var1), op(0x66, multinames.level), op(0x66, multinames.var239), branch(0x12, "end"),
    op(0xd0), op(0xd0), op(0x66, multinames.var1), op(0x66, multinames.level), op(0x66, multinames.var239), op(0x66, multinames.x),
    op(0xd0), op(0x66, multinames.var1), op(0x66, multinames.level), op(0x66, multinames.var239), op(0x66, multinames.y),
    op(0x4f, multinames.teleportTo, 2),
    branch(0x10, "end"),
    label("teleport"),
    op(0xd0), op(0xd1), op(0xd2), op(0x4f, multinames.teleportTo, 2),
    label("end"), op(0x47),
  ]);
}

function buildGenericRecovery(multinames: Record<string, number>): Buffer {
  return assemble([
    op(0xd0), op(0x30), op(0x28), op(0xd5), op(0x28), op(0xd6),
    op(0x20), op(0x80, multinames.point), op(0xd7),
    op(0x20), op(0x80, multinames.class37), op(0x63, 4),
    op(0x20), op(0x80, multinames.point), op(0x63, 5),
    op(0xd0), op(0x66, multinames.var1122), branch(0x11, "end"),
    op(0xd0), op(0x66, multinames.var1), op(0x66, multinames.level), branch(0x12, "end"),
    op(0xd0), op(0x66, multinames.physPosY),
    op(0xd0), op(0x66, multinames.var1), op(0x66, multinames.level), op(0x66, multinames.var1266),
    op(0xaf), branch(0x12, "end"),
    byte(0), op(0x75), op(0xd5), byte(0), op(0x75), op(0xd6),
    op(0xd0), op(0x66, multinames.cue), branch(0x12, "surface"),
    op(0xd0), op(0x66, multinames.cue), op(0x66, multinames.didGroundSnap), branch(0x12, "cuePosition"),
    op(0xd0), op(0x66, multinames.cue), op(0x66, multinames.groupSnapPos), op(0x66, multinames.x), op(0x75), op(0xd5),
    op(0xd0), op(0x66, multinames.cue), op(0x66, multinames.groupSnapPos), op(0x66, multinames.y), op(0x75), op(0xd6),
    branch(0x10, "ground"),
    label("cuePosition"),
    op(0xd0), op(0x66, multinames.var1), op(0xd0), op(0x66, multinames.cue), op(0x46, multinames.method234, 1),
    op(0x80, multinames.point), op(0x63, 5),
    op(0x62, 5), op(0x66, multinames.x), op(0x75), op(0xd5),
    op(0x62, 5), op(0x66, multinames.y), op(0x75), op(0xd6),
    branch(0x10, "ground"),
    label("surface"),
    op(0xd0), op(0x66, multinames.var703), branch(0x12, "global"),
    ...buildSurfaceMidpoint(multinames, "ground"),
    label("global"),
    op(0xd0), op(0x66, multinames.var1), op(0x66, multinames.level), op(0x66, multinames.var239), branch(0x12, "end"),
    op(0xd0), op(0x66, multinames.var1), op(0x66, multinames.level), op(0x66, multinames.var239), op(0x66, multinames.x), op(0x75), op(0xd5),
    op(0xd0), op(0x66, multinames.var1), op(0x66, multinames.level), op(0x66, multinames.var239), op(0x66, multinames.y), op(0x75), op(0xd6),
    label("ground"),
    op(0x5d, multinames.point), op(0x4a, multinames.point, 0), op(0x80, multinames.point), op(0xd7),
    op(0xd0), op(0x66, multinames.var1), op(0x66, multinames.collMan),
    byte(0), op(0xd1), op(0xd2), byte(19), op(0xa1),
    op(0x5d, multinames.point), byte(0), byte(120), op(0x4a, multinames.point, 2),
    op(0xd3), op(0x20), op(0x20), op(0x20),
    op(0x60, multinames.collisionManager), op(0x66, multinames.hardFloor),
    op(0x60, multinames.collisionManager), op(0x66, multinames.softFloor), op(0xa9), byte(0),
    op(0x46, multinames.getFloorCollision, 10), op(0x80, multinames.class37), op(0x63, 4),
    op(0x62, 4), branch(0x12, "teleport"),
    op(0xd3), op(0x66, multinames.x), op(0x75), op(0xd5),
    op(0xd3), op(0x66, multinames.y), op(0x60, multinames.entity), op(0x66, multinames.pullbackDist), op(0xa1), op(0x75), op(0xd6),
    label("teleport"), op(0xd0), op(0xd1), op(0xd2), op(0x4f, multinames.teleportTo, 2),
    label("end"), op(0x47),
  ]);
}

function analyze(swfPath: string): { ctx: ReturnType<typeof parseSwf>; patches: BytePatch[] } {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "Entity");
  if (classIndex === null) throw new PatchError("Entity class not found.");
  const authoredIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1213");
  const genericIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "method_1656");
  if (authoredIdx === null || genericIdx === null) throw new PatchError("Entity fall recovery methods not found.");
  const authoredBody = abc.methodBodies.get(authoredIdx);
  const genericBody = abc.methodBodies.get(genericIdx);
  if (!authoredBody || !genericBody || authoredBody.exceptionCount || genericBody.exceptionCount) {
    throw new PatchError("Unexpected Entity fall recovery method layout.");
  }
  const genericCurrentCode = ctx.body.subarray(genericBody.codeStart, genericBody.codeStart + genericBody.codeLen);
  const genericInstructions = disassemble(genericCurrentCode, "Entity.method_1656");

  const names = {
    var2170: findMultiname(abc, "var_2170"), var1122: findMultiname(abc, "var_1122"),
    velocity: findMultiname(abc, "velocity"), x: findMultiname(abc, "x"), y: findMultiname(abc, "y"),
    var703: findMultiname(abc, "var_703"), startX: findMultiname(abc, "startX"), endX: findMultiname(abc, "endX"),
    startY: findMultiname(abc, "startY"), endY: findMultiname(abc, "endY"), teleportTo: findMultiname(abc, "TeleportTo"),
    currRoom: findMultiname(abc, "currRoom"), var928: findMultiname(abc, "var_928"), var1: findMultiname(abc, "var_1"),
    level: findMultiname(abc, "level"), var239: findMultiname(abc, "var_239"), point: findMultiname(abc, "Point"),
    class37: findMultiname(abc, "class_37"), physPosY: findMultiname(abc, "physPosY"), var1266: findMultiname(abc, "var_1266"),
    cue: findMultiname(abc, "cue"), didGroundSnap: findMultiname(abc, "bDidGroundSnap"), groupSnapPos: findMultiname(abc, "groupSnapPos"),
    method234: findMultiname(abc, "method_234"), collMan: findMultiname(abc, "collMan"),
    collisionManager: findMethodMultiname(genericInstructions, abc, "CollisionManager", 0x60),
    hardFloor: findMultiname(abc, "HARD_FLOOR"), softFloor: findMultiname(abc, "SOFT_FLOOR"),
    getFloorCollision: findMultiname(abc, "getFloorCollision"), entity: findMultiname(abc, "Entity"), pullbackDist: findMultiname(abc, "PULLBACK_DIST"),
  };
  const authoredCode = buildAuthoredRecovery(names);
  const genericCode = buildGenericRecovery(names);
  const patches: BytePatch[] = [];

  for (const [key, body, code, maxStack, localCount] of [
    ["authored", authoredBody, authoredCode, 5, 3],
    ["generic", genericBody, genericCode, 13, 6],
  ] as const) {
    const current = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (current.equals(code)) continue;
    const [, localCountEnd] = readU30(ctx.body, body.localCountPos, `${key}.local_count`);
    patches.push(
      { key: `${key}-max-stack`, start: body.maxStackPos, end: body.localCountPos, data: writeU30(maxStack), detail: `${key} fall recovery max stack` },
      { key: `${key}-local-count`, start: body.localCountPos, end: localCountEnd, data: writeU30(localCount), detail: `${key} fall recovery local count` },
      { key: `${key}-code-length`, start: body.codeLenPos, end: body.codeStart, data: writeU30(code.length), detail: `${key} fall recovery code length` },
      { key: `${key}-code`, start: body.codeStart, end: body.codeStart + body.codeLen, data: code, detail: `${key} fall recovery uses last grounded surface` },
    );
  }
  return { ctx, patches };
}

function main(): number {
  const { swfPath, verify } = parseArgs(process.argv);
  try {
    const { ctx, patches } = analyze(swfPath);
    if (!patches.length) {
      console.log(`${swfPath}: fall recovery patch verified.`);
      return 0;
    }
    if (verify) throw new PatchError(`${swfPath}: fall recovery patch is missing.`);
    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, body, delta);
    if (analyze(swfPath).patches.length) throw new PatchError("Post-write fall recovery verification failed.");
    console.log(`${swfPath}: patched fall recovery to use the last grounded surface.`);
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

process.exit(main());
