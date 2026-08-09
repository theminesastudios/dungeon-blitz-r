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

// Brain.CallForHelp pulls every friendly entity inside the *visible screen* and hates them onto
// the attacker:
//
//   GatherEntities(e.physPosX, e.physPosY, Camera.SCREEN_WIDTH, Camera.PLAY_SCREEN_HEIGHT, FRIEND)
//
// There is no world-space radius, so the aggro area scales with the player's resolution. The SWF
// stage is 1152x768, which is the area the original game pulled from; at 2560x1440 that becomes
// 2.2x and at 3840x2160 3.3x, which is why attacking one enemy drags in half the room.
//
// Pin the two screen dimensions to the stage size so the pull area matches the original at every
// resolution. The replacement is padded with nops to preserve the method's byte length -- shrinking
// the code would invalidate every branch offset that spans this region.
//
// This is a stopgap for client-owned hostiles. Once server-authoritative hostile AI covers more
// than JC_Mini1Hard / JC_Mini2 / TutorialDungeon, the right fix is to restore the instanced-dungeon
// guard (see patch-dungeonblitz-brain-instanced-aggro-guard.ts) and let the server own aggro.
const DEFAULT_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf",
);

const STAGE_WIDTH = 1152;
const STAGE_HEIGHT = 768;

const OP_GETLEX = 0x60;
const OP_GETPROPERTY = 0x66;
const OP_PUSHSHORT = 0x25;
const OP_NOP = 0x02;

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") swfPath = path.resolve(argv[++index] || "");
    else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: ts-node patch-dungeonblitz-callforhelp-fixed-radius.ts [--verify] [--swf <path>]\n" +
        `Pins Brain.CallForHelp's aggro gather area to the ${STAGE_WIDTH}x${STAGE_HEIGHT} stage instead of the live screen.`,
      );
      process.exit(0);
    } else throw new Error(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify };
}

/** The four instructions that read the live screen size, in order. */
function findScreenReads(
  insts: Instruction[],
  nameOf: (inst: Instruction) => string,
): { startIndex: number; byteStart: number; byteLength: number } | null {
  for (let i = 0; i + 3 < insts.length; i += 1) {
    const [a, b, c, d] = insts.slice(i, i + 4);
    if (a.opcode !== OP_GETLEX || nameOf(a) !== "Camera") continue;
    if (b.opcode !== OP_GETPROPERTY || nameOf(b) !== "SCREEN_WIDTH") continue;
    if (c.opcode !== OP_GETLEX || nameOf(c) !== "Camera") continue;
    if (d.opcode !== OP_GETPROPERTY || nameOf(d) !== "PLAY_SCREEN_HEIGHT") continue;
    return {
      startIndex: i,
      byteStart: a.offset,
      byteLength: a.size + b.size + c.size + d.size,
    };
  }
  return null;
}

/** Already-pinned form: pushshort W, pushshort H, then nop padding. */
function isAlreadyPinned(insts: Instruction[]): boolean {
  for (let i = 0; i + 1 < insts.length; i += 1) {
    const [a, b] = insts.slice(i, i + 2);
    if (a.opcode !== OP_PUSHSHORT || a.operands[0][1] !== STAGE_WIDTH) continue;
    if (b.opcode !== OP_PUSHSHORT || b.operands[0][1] !== STAGE_HEIGHT) continue;
    return true;
  }
  return false;
}

function buildReplacement(byteLength: number): Buffer {
  const pushes = Buffer.concat([
    Buffer.from([OP_PUSHSHORT]), writeU30(STAGE_WIDTH),
    Buffer.from([OP_PUSHSHORT]), writeU30(STAGE_HEIGHT),
  ]);
  if (pushes.length > byteLength) {
    throw new PatchError(
      `Replacement (${pushes.length} bytes) does not fit the original ${byteLength} bytes.`,
    );
  }
  return Buffer.concat([pushes, Buffer.alloc(byteLength - pushes.length, OP_NOP)]);
}

function patchSwf(swfPath: string, verify: boolean): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const classIndex = classIndexByName(abc, "Brain");
  if (classIndex === null) throw new PatchError("Could not find Brain class.");

  const methodIdx = methodIdxForTrait(abc.instances[classIndex].traits, abc, "CallForHelp");
  if (methodIdx === null) throw new PatchError("Could not find Brain.CallForHelp.");
  const body = abc.methodBodies.get(methodIdx);
  if (!body) throw new PatchError("Could not find body for Brain.CallForHelp.");

  const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
  const insts = disassemble(code, "Brain.CallForHelp");
  const nameOf = (inst: Instruction): string => abc.multinameNames[inst.operands?.[0]?.[1] ?? -1] ?? "";

  if (isAlreadyPinned(insts)) {
    console.log(`${swfPath}: verified (CallForHelp aggro area pinned to ${STAGE_WIDTH}x${STAGE_HEIGHT}).`);
    return;
  }

  const found = findScreenReads(insts, nameOf);
  if (!found) {
    throw new PatchError(
      `${swfPath}: CallForHelp does not read Camera.SCREEN_WIDTH/PLAY_SCREEN_HEIGHT in the expected order.`,
    );
  }
  if (verify) {
    throw new PatchError(
      `${swfPath}: verify failed; CallForHelp still gathers aggro over the live screen size.`,
    );
  }

  const replacement = buildReplacement(found.byteLength);
  const patches: BytePatch[] = [{
    key: "Brain.CallForHelp.screenBounds",
    start: body.codeStart + found.byteStart,
    end: body.codeStart + found.byteStart + found.byteLength,
    data: replacement,
    detail: `pin aggro gather area to ${STAGE_WIDTH}x${STAGE_HEIGHT}`,
  }];

  ensureBackup(swfPath);
  const { body: patchedBody, delta } = applyPatchesToBody(ctx.body, patches);
  if (delta !== 0) {
    throw new PatchError(`Expected a length-preserving patch, got delta ${delta}.`);
  }
  writeSwf(ctx, patchedBody, delta);
  console.log(`${swfPath}: pinned CallForHelp aggro area to ${STAGE_WIDTH}x${STAGE_HEIGHT}.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
