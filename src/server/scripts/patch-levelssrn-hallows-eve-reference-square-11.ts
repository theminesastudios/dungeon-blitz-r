/**
 * Eleventh pass: the ferns come out, the far join is covered, and the tree is planted.
 *
 * ## The ferns
 *
 * Three of the room's own ferns were stood over the joins between the seasonal scene's
 * grass and Black Rose Mire's - two by the gourds, one past the skull wall. They were a
 * dodge, and they read as one: single plants standing on open grass with nothing else
 * near them. All three come out. What they were hiding is dealt with properly below.
 *
 * ## The join past the wall
 *
 * The scene's grass is a lighter yellow-green than the room's, so where it stops - room
 * 1092, out past the skull wall - it draws as a pale rectangle with a hard corner. It is
 * the same fault the tenth pass levelled at the other end, but this end cannot be
 * levelled the same way: the mushroom house's mound genuinely rises there and is
 * authored that way, so the two surfaces are at different heights on purpose.
 *
 * Instead one tile of the room's own low band goes **in front** of the scene, on a depth
 * above 124, spanning room 1005..1333 at y -128. The join runs underneath it and what
 * shows is one continuous band of the room's own grass in the room's own tone. It starts
 * past the wall's stone base at 1000, so no masonry is covered, and it crosses the
 * scene's fence posts only below their feet.
 *
 * ## The tree - reverted
 *
 * This pass also dropped the tree behind the ground, on depth 64, so the turf would cover
 * its foot. **`-12` undid that**, and the reasoning is worth keeping: the ground tiles'
 * top edge is nearly a straight line where the tree stands, so the trunk came out cut
 * clean across rather than sinking into anything. The tree is drawn to be seen whole and
 * belongs in front. What is left here is the migration for a file still carrying the
 * placement on 64.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-reference-square-11.ts
 *          [--verify] [--out <swf>]
 *
 * Re-runnable: every step checks for its own result first.
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

/** The depths the ferns were planted on. */
const FERN_DEPTHS = [126, 128, 130];

/**
 * The depth the room's own fern is placed on, which is where the pulled ones were
 * copied from.
 *
 * A fern is recognised by **being that character**, not by sitting on one of the depths
 * above. Those depths were reused afterwards - 126 by the band that covers the far join,
 * 128 by the twigs drawn on the tree in `-13` - and a rule of "anything on these depths
 * that is not the band" quietly deleted the twigs every time this ran.
 */
const FERN_MODEL_DEPTH = 153;

/** The band that covers the far join, copied from the room's own low band on depth 83. */
const JOIN_BAND = { depth: 126, like: 83, x: 1170, y: -128 };

/** Where `-12` puts the tree back; kept only to migrate a file left on the old depth. */
const TREE_FROM = 64;
const TREE_TO = 122;

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

  const model = placements.find((place) => place.depth === JOIN_BAND.like);
  if (!model || model.charId === null || model.matrix === null) {
    throw new SwfLevelError(`${HOST_ROOM} has nothing on depth ${JOIN_BAND.like} to copy`);
  }

  const fernChar = placements.find((place) => place.depth === FERN_MODEL_DEPTH)?.charId ?? null;
  const isFern = (place: ReturnType<typeof parsePlace>): boolean =>
    FERN_DEPTHS.includes(place.depth) && place.charId !== null && place.charId === fernChar;

  let fernsPulled = 0;
  let treeMoved = false;
  const rebuilt: SwfTag[] = [];
  for (const tag of spriteInnerTags(swf.tags[roomIndex])) {
    if (!isPlace(tag)) {
      rebuilt.push(tag);
      continue;
    }
    const place = parsePlace(tag);
    if (isFern(place)) {
      fernsPulled += 1;
      continue;
    }
    if (place.depth === TREE_FROM && place.charId !== null && place.matrix !== null) {
      treeMoved = true;
      rebuilt.push(
        buildPlaceObject2({
          depth: TREE_TO,
          charId: place.charId,
          x: place.matrix.translateX / 20,
          y: place.matrix.translateY / 20,
          scaleX: place.matrix.scaleX,
          scaleY: place.matrix.scaleY,
        }),
      );
      continue;
    }
    rebuilt.push(tag);
  }

  const needsBand = !placements.some(
    (place) => place.depth === JOIN_BAND.depth && place.charId === model.charId,
  );

  console.log(
    `ferns pulled: ${fernsPulled}   far join: ${needsBand ? "banded over" : "already banded"}   ` +
      `left-hand tree: ${treeMoved ? `put back on depth ${TREE_TO}` : "already in front"}`,
  );
  if (fernsPulled === 0 && !needsBand && !treeMoved) {
    console.log("the square already matches the reference.");
    return;
  }
  if (verify) {
    console.log("verify only - no file written.");
    return;
  }

  if (needsBand) {
    const showFrame = rebuilt.findIndex((tag) => tag.code === TAG_SHOW_FRAME);
    rebuilt.splice(
      showFrame === -1 ? rebuilt.length - 1 : showFrame,
      0,
      buildPlaceObject2({
        depth: JOIN_BAND.depth,
        charId: model.charId,
        x: JOIN_BAND.x,
        y: JOIN_BAND.y,
        scaleX: model.matrix.scaleX,
        scaleY: model.matrix.scaleY,
      }),
    );
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
