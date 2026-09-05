/**
 * Tenth pass: the grass line, and the two places where it steps.
 *
 * Zooming in on the tree's roots showed what all three complaints were: **one** fault,
 * seen from three sides.
 *
 * The seasonal scene's grass and Black Rose Mire's own grass do not stand at the same
 * height. The scene's surface is at room y -159; the room's hill band (character 29,
 * placed at y -115) tops out at -135. Twenty-four pixels apart. So where the scene
 * begins, at room -102.5, its grass draws as a **rectangle** standing proud of the
 * ground around it - a hard corner and a hard horizontal top edge, right beside the
 * tree's roots. That block is what reads as a broken tree: the roots end where it
 * starts, so the trunk looks cut off against it.
 *
 * The fix is not to hide it but to remove the step. The three hill tiles this series
 * laid at the left-hand end come up twenty-four pixels, to y -139, which puts their top
 * on -159 - the scene's own line - and the two grasses become one surface. The bridge
 * tiles under them come up with them, or the sixteen-pixel slot they were laid to close
 * opens again.
 *
 * Where the raised tiles meet the room's original band the step simply moves, to room
 * -90..-81 - and that is underneath the scene, which draws over it on depth 124, so it
 * is never seen.
 *
 * ## The same step at the other end
 *
 * At room 1092 the scene's grass ends against the mushroom house's mound, which rises
 * there, so that one cannot be levelled - the two surfaces are genuinely at different
 * heights and the house's hill is authored that way. A fern was stood on it from here
 * at first; `-11` replaced that with a band of the room's own grass laid across the
 * whole join, which covers it without looking planted.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-reference-square-10.ts
 *          [--verify] [--out <swf>]
 *
 * Re-runnable: it stops when the tiles already stand on these lines.
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
 * The tiles laid at the left-hand end, and the lines they should stand on.
 *
 * `-9` put them on the room's own lines, which was right when they were only meant to
 * continue the room. They now have to meet the *scene's* line instead, which is twenty
 * four pixels higher, so both runs come up by that much: the hill tiles from -115 to
 * -139 and the bridge tiles from -32 to -56.
 */
const RAISE = [
  { depths: [74, 76, 78], y: -139 },
  { depths: [80, 86, 90], y: -56 },
];

/**
 * A third row of the low band's tile, laid across the seam between the two runs.
 *
 * Every one of these tiles is drawn with a ragged top - grass strokes over transparency
 * - so where the hill band's ragged bottom meets the bridge row's ragged top, at room
 * y -128..-110, neither is solid and the parallax behind stops at -112. It shows as a
 * thin bright line through the grass. This row sits at y -113, whose solid body starts
 * at -128, and it is offset half a tile from the others so their vertical seams do not
 * line up with it either.
 */
const FILL = { like: 83, y: -113, tiles: [
  { depth: 66, x: -60 },
  { depth: 68, x: -310 },
  { depth: 92, x: -560 },
  { depth: 94, x: -810 },
] };

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

  const wantedY = new Map<number, number>();
  for (const run of RAISE) for (const depth of run.depths) wantedY.set(depth, run.y);

  let raised = 0;
  const rebuilt = spriteInnerTags(swf.tags[roomIndex]).map((tag) => {
    if (!isPlace(tag)) return tag;
    const place = parsePlace(tag);
    const y = wantedY.get(place.depth);
    if (y === undefined || place.charId === null || place.matrix === null) return tag;
    if (Math.abs(place.matrix.translateY / 20 - y) < 1) return tag;
    raised += 1;
    return buildPlaceObject2({
      depth: place.depth,
      charId: place.charId,
      x: place.matrix.translateX / 20,
      y,
      scaleX: place.matrix.scaleX,
      scaleY: place.matrix.scaleY,
    });
  });

  const copyOf = (depth: number): ReturnType<typeof parsePlace> => {
    const found = placements.find((place) => place.depth === depth);
    if (!found || found.charId === null || found.matrix === null) {
      throw new SwfLevelError(`${HOST_ROOM} has nothing on depth ${depth} to copy`);
    }
    return found;
  };
  const fillModel = copyOf(FILL.like);
  const fill = FILL.tiles.filter((tile) => !placements.some((place) => place.depth === tile.depth));
  const additions: SwfTag[] = fill.map((tile) =>
    buildPlaceObject2({
      depth: tile.depth,
      charId: fillModel.charId as number,
      x: tile.x,
      y: FILL.y,
      scaleX: (fillModel.matrix as { scaleX: number }).scaleX,
      scaleY: (fillModel.matrix as { scaleY: number }).scaleY,
    }),
  );

  console.log(`ground tiles raised: ${raised}   seam row laid: ${fill.length}`);
  if (raised === 0 && fill.length === 0) {
    console.log("the square already matches the reference.");
    return;
  }
  if (verify) {
    console.log("verify only - no file written.");
    return;
  }

  if (additions.length) {
    const showFrame = rebuilt.findIndex((tag) => tag.code === TAG_SHOW_FRAME);
    rebuilt.splice(showFrame === -1 ? rebuilt.length - 1 : showFrame, 0, ...additions);
  }
  swf.tags[roomIndex] = rebuildSprite(swf.tags[roomIndex], rebuilt);

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
