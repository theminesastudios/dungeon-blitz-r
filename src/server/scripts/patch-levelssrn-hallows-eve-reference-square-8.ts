/**
 * Eighth pass: the hole the shift left at the far end of the square.
 *
 * Moving the seasonal scene a hundred pixels right in `-7` closed the gap by the
 * mushroom house and took something with it. The scene's own hillside was the *only*
 * mid-ground artwork at that end of the room - Black Rose Mire's ground band starts at
 * room 37 and there is nothing to its left but parallax trunks - so where the scene's
 * grass used to run from -172.5, it now begins at -72.5 and a strip of the square has
 * no ground in it at all. It shows as a hard vertical edge in the grass, right beside
 * the gourds.
 *
 * The room already owns the fix, and it takes **two** runs, not one. Black Rose Mire
 * draws its ground in bands, and the strip needs both of them:
 *
 *   - the **low band** at the floor line - one 329-wide tile repeated from x 37 - which
 *     is what the player walks along;
 *   - the **hill band** above it, at y -115, which is the mound the ruins stand on and
 *     the one the scene's own hillside was standing in for. Laying only the low band
 *     was tried first and changed nothing: it covers room y -73..60 and the hole is at
 *     -80..-160, entirely above it.
 *
 * Each run is continued backwards past the room's left edge with two more of its own
 * tile, read off the run's own first placement so the character, the line and the scale
 * all come from the room rather than from here.
 *
 * They go on free even depths below the scene's 124, so they sit behind everything the
 * square is dressed with and only ever show where nothing else does.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-reference-square-8.ts
 *          [--verify] [--out <swf>]
 *
 * Re-runnable: it checks the depths before laying anything.
 */
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
  SwfTag,
  buildPlaceObject2,
  ensureBackup,
  parsePlace,
  readSwfFile,
  readSymbolClasses,
  rebuildSprite,
  spriteInnerTags,
  writeSwfFile,
  TAG_DEFINE_SPRITE,
  TAG_PLACE_OBJECT2,
  TAG_PLACE_OBJECT3,
  TAG_SHOW_FRAME,
} from "./swfLevelUtils";

const SRN_SWF = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "LevelsSRN.swf");

const HOST_ROOM = "a_Room_SRN04";

/**
 * The two runs, each by the placement that starts it and the tiles that continue it.
 *
 * The starts are read rather than written: whatever character sits on that depth at
 * that x is the run's first tile, and its y and scale are copied so the new ones land
 * on the same line as the rest of the band.
 */
const RUNS = [
  { what: "low band", start: { depth: 83, x: 37 }, tiles: [{ depth: 82, x: -226 }, { depth: 84, x: -489 }] },
  { what: "hill band", start: { depth: 77, x: 35 }, tiles: [{ depth: 76, x: -197 }, { depth: 78, x: -429 }] },
];

function spriteIndexFor(swf: SwfFile, charId: number): number {
  const index = swf.tags.findIndex((tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === charId);
  if (index === -1) throw new SwfLevelError(`character ${charId} is not a sprite`);
  return index;
}

function isPlace(tag: SwfTag): boolean {
  return tag.code === TAG_PLACE_OBJECT2 || tag.code === TAG_PLACE_OBJECT3;
}

function placementsOf(swf: SwfFile, charId: number): ReturnType<typeof parsePlace>[] {
  return spriteInnerTags(swf.tags[spriteIndexFor(swf, charId)]).filter(isPlace).map((tag) => parsePlace(tag));
}

function main(): void {
  const argv = process.argv;
  const verify = argv.includes("--verify");
  const outIndex = argv.indexOf("--out");
  const out = outIndex === -1 ? SRN_SWF : path.resolve(argv[outIndex + 1]);

  const swf = readSwfFile(SRN_SWF);
  const room = readSymbolClasses(swf).find((entry) => entry.name === HOST_ROOM);
  if (!room) throw new SwfLevelError(`LevelsSRN.swf has no ${HOST_ROOM}`);
  const roomIndex = spriteIndexFor(swf, room.id);

  const placements = placementsOf(swf, room.id);
  const wanted: Array<{ what: string; charId: number; depth: number; x: number; y: number; scaleX: number; scaleY: number }> = [];
  for (const run of RUNS) {
    const first = placements.find((place) => place.depth === run.start.depth);
    if (!first || first.charId === null || first.matrix === null) {
      throw new SwfLevelError(`${HOST_ROOM} has no ${run.what} tile on depth ${run.start.depth}`);
    }
    if (Math.abs(first.matrix.translateX / 20 - run.start.x) > 1) {
      throw new SwfLevelError(`depth ${run.start.depth} does not start the ${run.what}`);
    }
    for (const tile of run.tiles) {
      if (placements.some((place) => place.depth === tile.depth)) continue;
      wanted.push({
        what: run.what,
        charId: first.charId,
        depth: tile.depth,
        x: tile.x,
        y: first.matrix.translateY / 20,
        scaleX: first.matrix.scaleX,
        scaleY: first.matrix.scaleY,
      });
    }
  }
  console.log(`tiles to lay: ${wanted.length ? wanted.map((tile) => `${tile.what} @${tile.x}`).join(", ") : "none"}`);
  if (wanted.length === 0) {
    console.log("the square already matches the reference.");
    return;
  }
  if (verify) {
    console.log("verify only - no file written.");
    return;
  }

  const inner = spriteInnerTags(swf.tags[roomIndex]);
  const showFrame = inner.findIndex((tag) => tag.code === TAG_SHOW_FRAME);
  inner.splice(
    showFrame === -1 ? inner.length - 1 : showFrame,
    0,
    ...wanted.map((tile) =>
      buildPlaceObject2({
        depth: tile.depth,
        charId: tile.charId,
        x: tile.x,
        y: tile.y,
        scaleX: tile.scaleX,
        scaleY: tile.scaleY,
      }),
    ),
  );
  swf.tags[roomIndex] = rebuildSprite(swf.tags[roomIndex], inner);

  if (out === SRN_SWF) ensureBackup(SRN_SWF);
  writeSwfFile(out, swf);
  console.log(`wrote ${out}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
