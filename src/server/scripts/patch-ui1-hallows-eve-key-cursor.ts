/**
 * Makes the coffer board's hover cursor the waiting key without its clock.
 *
 * ## Where these cursors come from
 *
 * `Game` registers sixteen custom cursors with `CustomMouse.method_66`, and two of
 * them - `a_CustomMouse_Key` and `a_CustomMouse_KeyWaiting` - are *only* registered.
 * Nothing in the shipped client ever selects them: they belong to the Hallow's Eve
 * coffers screen, and that screen was cut.
 * `patch-dungeonblitz-hallows-eve-coffer-screen.ts` selects them again - one over a
 * skull that can still be opened, the other while one is opening.
 *
 * ## Why the hover cursor is rebuilt
 *
 * The two were drawn from different keys. `a_CustomMouse_KeyWaiting` is a key with a
 * clock laid over its bow; `a_CustomMouse_Key` is an unrelated, plainer key. The
 * board wants the *waiting* key without the clock - the same drawing in both states,
 * with only the clock appearing when a coffer is opening.
 *
 * `a_CustomMouse_KeyWaiting` turns out to be exactly that: two placements, the key
 * on the lower depth and the clock scaled down over it. So the hover cursor becomes
 * that sprite's key placement, carried across untouched - same character, same
 * matrix, same position, so the two cursors line up pixel for pixel and swapping
 * between them only adds and removes the clock.
 *
 * Rewriting the sprite rather than minting a new one keeps `CustomMouse` out of it:
 * cursors are registered by symbol name, `Game` already registers this name at boot,
 * and nothing else in the client draws it. The name, the registration and the
 * selection all stay where they were - only the picture changes.
 *
 * Usage: npm exec ts-node scripts/patch-ui1-hallows-eve-key-cursor.ts [--verify]
 *
 * Re-runnable: it checks whether the hover cursor already draws the waiting key's
 * character. To undo, `git checkout` `UI_1.swf` - nothing else in this feature
 * touches that file.
 */
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
  SwfTag,
  characterBounds,
  ensureBackup,
  parsePlace,
  readSwfFile,
  readSymbolClasses,
  rebuildSprite,
  spriteInnerTags,
  writeSwfFile,
  TAG_DEFINE_SPRITE,
  TAG_END,
  TAG_PLACE_OBJECT2,
  TAG_PLACE_OBJECT3,
  TAG_SHOW_FRAME,
} from "./swfLevelUtils";

const UI1_SWF = path.resolve(
  __dirname,
  "..",
  "..",
  "client",
  "content",
  "localhost",
  "p",
  "cbp",
  "UI_1.swf",
);

/** The cursor to rebuild, and the one it borrows its key from. */
const HOVER_CURSOR = "a_CustomMouse_Key";
const WAITING_CURSOR = "a_CustomMouse_KeyWaiting";

function spriteIndexOf(swf: SwfFile, charId: number): number {
  const index = swf.tags.findIndex(
    (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === charId,
  );
  if (index === -1) throw new SwfLevelError(`character ${charId} is not a sprite in this SWF`);
  return index;
}

function isPlacement(code: number): boolean {
  return code === TAG_PLACE_OBJECT2 || code === TAG_PLACE_OBJECT3;
}

function cursorSprite(swf: SwfFile, name: string): { id: number; index: number } {
  const symbol = readSymbolClasses(swf).find((entry) => entry.name === name);
  if (!symbol) throw new SwfLevelError(`no ${name} in ${path.basename(UI1_SWF)}`);
  return { id: symbol.id, index: spriteIndexOf(swf, symbol.id) };
}

function describe(swf: SwfFile, tag: SwfTag): string {
  const place = parsePlace(tag);
  const art = place.charId === null ? null : characterBounds(swf, place.charId);
  const scale = place.matrix ? place.matrix.scaleX : 1;
  return (
    `d${place.depth} char ${place.charId} scale ${scale.toFixed(2)}` +
    (art ? ` (${Math.round(((art.xMax - art.xMin) / 20) * scale)}x${Math.round(((art.yMax - art.yMin) / 20) * scale)}px)` : "")
  );
}

function main(): void {
  const verify = process.argv.includes("--verify");

  const ui1 = readSwfFile(UI1_SWF);
  const hover = cursorSprite(ui1, HOVER_CURSOR);
  const waiting = cursorSprite(ui1, WAITING_CURSOR);

  const waitingParts = spriteInnerTags(ui1.tags[waiting.index]).filter((tag) => isPlacement(tag.code));
  if (waitingParts.length !== 2) {
    throw new SwfLevelError(
      `${WAITING_CURSOR} has ${waitingParts.length} placements; this expects the key and the clock over it`,
    );
  }

  // The key is the one underneath - the clock is laid over its bow, scaled down.
  const byDepth = [...waitingParts].sort((a, b) => parsePlace(a).depth - parsePlace(b).depth);
  const key = byDepth[0];
  const clock = byDepth[1];
  const keyChar = parsePlace(key).charId;

  const hoverParts = spriteInnerTags(ui1.tags[hover.index]).filter((tag) => isPlacement(tag.code));
  if (hoverParts.length === 1 && parsePlace(hoverParts[0]).charId === keyChar) {
    console.log(`${HOVER_CURSOR} already draws ${WAITING_CURSOR}'s key; nothing to do.`);
    return;
  }

  console.log(`${WAITING_CURSOR} [${waiting.id}]`);
  console.log(`  key   ${describe(ui1, key)}   <- kept`);
  console.log(`  clock ${describe(ui1, clock)}   <- dropped`);
  console.log(`${HOVER_CURSOR} [${hover.id}]`);
  for (const part of hoverParts) console.log(`  was   ${describe(ui1, part)}`);
  if (verify) {
    console.log("verify only - nothing written.");
    return;
  }

  ui1.tags[hover.index] = rebuildSprite(ui1.tags[hover.index], [
    key,
    { code: TAG_SHOW_FRAME, data: Buffer.alloc(0) },
    { code: TAG_END, data: Buffer.alloc(0) },
  ]);

  ensureBackup(UI1_SWF);
  writeSwfFile(UI1_SWF, ui1);
  console.log(`wrote ${UI1_SWF}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
