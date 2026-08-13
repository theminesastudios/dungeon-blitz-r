#!/usr/bin/env node

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

// Brain.CallForHelp pulls every friendly entity inside the *visible screen* and hates them onto
// the attacker:
//
//   GatherEntities(e.physPosX, e.physPosY, Camera.SCREEN_WIDTH, Camera.PLAY_SCREEN_HEIGHT, FRIEND)
//
// There is no world-space radius, so the aggro area scales with the player's resolution. The SWF
// stage is 1152x768, which is the area the original game pulled from; at 2560x1440 that becomes
// 2.2x and at 3840x2160 3.3x, which is why attacking one enemy drags in half the room.
//
// Replace the two screen dimensions with a fixed world-space area, padded with nops to preserve the
// method's byte length -- shrinking the code would invalidate every branch offset that spans this
// region.
//
// The numbers below are *half*-extents: GatherEntities gathers over x-w..x+w, y-h..y+h. Pinning
// them to the stage size, which is what this patch did first, therefore still called for help
// across 2304x1536 world pixels - two screens wide. That is the stock game's own reach and it went
// unnoticed while hostiles died in a hit or two; once Legends' Inn put level-50 health pools on
// them it turned into "things I never walked near are already shooting me".
//
// 400x300 is a little over the 250px Brain.AGGRO_RADIUS an enemy sees for itself, so a pack still
// reacts together while the far side of a room stays asleep. To go back to the old behaviour, set
// these to 1152x768 and re-run.
//
// This is a stopgap for client-owned hostiles. Once server-authoritative hostile AI covers more
// than JC_Mini1Hard / JC_Mini2 / TutorialDungeon, the right fix is to restore the instanced-dungeon
// guard (see patch-dungeonblitz-brain-instanced-aggro-guard.ts) and let the server own aggro.
const DEFAULT_SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf",
);

const HELP_HALF_WIDTH = 400;
const HELP_HALF_HEIGHT = 300;

/** Half-extents this patch has shipped, so an older pinning can be re-tuned in place. */
const PREVIOUS_PINNINGS: Array<[number, number]> = [[1152, 768]];

const INDEX_HTML = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "index.html");

/**
 * Moves index.html's cache-busting token to match the SWF that was just written.
 *
 * index.html requests DungeonBlitz.swf at a fixed `clientrev=swf-<sha1[0:12]>`.
 * Leave the token alone and the URL is byte-for-byte the one the browser and the
 * Flash plugin already have cached, so players keep loading the *old* SWF while
 * the patched one sits on disk - a failure that looks exactly like a patch that
 * did not work.
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
        `Pins Brain.CallForHelp's aggro gather area to the ${HELP_HALF_WIDTH}x${HELP_HALF_HEIGHT} stage instead of the live screen.`,
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

/**
 * An existing pinning: `pushshort W, pushshort H` and the nops that pad it out.
 *
 * Reported whether or not the extents are the ones this build wants, so the area
 * can be re-tuned without reverting the SWF first. The nops are part of the span
 * because the replacement has to be exactly as long as what it replaces.
 */
function findPinned(insts: Instruction[]): { byteStart: number; byteLength: number; extents: [number, number] } | null {
  for (let i = 0; i + 1 < insts.length; i += 1) {
    const [a, b] = insts.slice(i, i + 2);
    if (a.opcode !== OP_PUSHSHORT || b.opcode !== OP_PUSHSHORT) continue;
    const extents: [number, number] = [a.operands[0][1], b.operands[0][1]];
    const known =
      (extents[0] === HELP_HALF_WIDTH && extents[1] === HELP_HALF_HEIGHT) ||
      PREVIOUS_PINNINGS.some(([width, height]) => extents[0] === width && extents[1] === height);
    if (!known) continue;

    let byteLength = a.size + b.size;
    for (let j = i + 2; j < insts.length && insts[j].opcode === OP_NOP; j += 1) byteLength += insts[j].size;
    return { byteStart: a.offset, byteLength, extents };
  }
  return null;
}

function buildReplacement(byteLength: number): Buffer {
  const pushes = Buffer.concat([
    Buffer.from([OP_PUSHSHORT]), writeU30(HELP_HALF_WIDTH),
    Buffer.from([OP_PUSHSHORT]), writeU30(HELP_HALF_HEIGHT),
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

  const pinned = findPinned(insts);
  if (pinned && pinned.extents[0] === HELP_HALF_WIDTH && pinned.extents[1] === HELP_HALF_HEIGHT) {
    console.log(`${swfPath}: verified (CallForHelp aggro area pinned to ${HELP_HALF_WIDTH}x${HELP_HALF_HEIGHT}).`);
    return;
  }

  // Either the stock screen reads, or a pinning from an earlier build of this
  // script that is being re-tuned.
  const found = pinned ?? findScreenReads(insts, nameOf);
  if (!found) {
    throw new PatchError(
      `${swfPath}: CallForHelp does not read Camera.SCREEN_WIDTH/PLAY_SCREEN_HEIGHT in the expected order.`,
    );
  }
  if (verify) {
    throw new PatchError(
      `${swfPath}: verify failed; CallForHelp gathers aggro over ` +
      `${pinned ? `${pinned.extents[0]}x${pinned.extents[1]}` : "the live screen size"}.`,
    );
  }

  const replacement = buildReplacement(found.byteLength);
  const patches: BytePatch[] = [{
    key: "Brain.CallForHelp.screenBounds",
    start: body.codeStart + found.byteStart,
    end: body.codeStart + found.byteStart + found.byteLength,
    data: replacement,
    detail: `pin aggro gather area to ${HELP_HALF_WIDTH}x${HELP_HALF_HEIGHT}`,
  }];

  ensureBackup(swfPath);
  const { body: patchedBody, delta } = applyPatchesToBody(ctx.body, patches);
  if (delta !== 0) {
    throw new PatchError(`Expected a length-preserving patch, got delta ${delta}.`);
  }
  writeSwf(ctx, patchedBody, delta);
  syncClientRev(swfPath);
  console.log(`${swfPath}: pinned CallForHelp aggro area to ${HELP_HALF_WIDTH}x${HELP_HALF_HEIGHT}.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
