/**
 * Third pass: the cobwebs go behind the scene, and the left-hand tree is turned round.
 *
 * ## The two shoulder cobwebs are in front of everything
 *
 * They live in the dressing composite on depth 234, which is above the seasonal scene
 * on 124, so they draw over the iron fence, over the besom, over the stones - a sheet
 * of white laid on top of the square. In the drawing they are *behind* all of that:
 * you see them through the gaps between the fence spikes and against the forest, and
 * they disappear where the scene's own artwork is solid.
 *
 * So they move out of the dressing and become room children of their own on depths
 * **118 and 120**, below the scene on 124. The dressing is placed at the room's origin
 * at scale 1, so their points carry over untouched.
 *
 * The **big cobweb off the skull's jaw stays where it is.** In the drawing that one is
 * drawn over the tower's stones and down across the hillside - it is in front, and it
 * is the one web that should be.
 *
 * ## The left-hand tree faces the wrong way
 *
 * Character 38 is drawn with its trunk left of centre and its crown spreading right.
 * The drawing's left-hand tree has it the other way round: the trunk rises on the
 * *right* of the shape and the branches reach back across to the left, which is how
 * the scene's own copy is placed too (character 60 puts it at `scaleX -0.532`).
 *
 * That is not a matter of taste, it is measurable. In the drawing the tree is cut off
 * by the frame's left edge, and its trunk stands at about 90..150 of the 235 pixels
 * that remain. Solving for the full width both ways round, only one has an answer:
 * mirrored the tree comes out 382 pixels wide with 147 of them off-frame, and the
 * right way round it would have to be narrower than the part you can already see.
 *
 * It also sits about fifty pixels low - the drawing has its roots up where the grass
 * mound crests rather than down beside the gourds - hence the new `BASE`.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-reference-square-3.ts
 *          [--verify] [--out <swf>]
 *
 * Re-runnable: both steps check for their own result first.
 */
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
  SwfTag,
  buildPlaceObject2,
  characterBounds,
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
const DECOR_DEPTH = 234;
const TREE_DEPTH = 122;

/** How close a placement has to be to one of the points below to count as it. */
const MATCH_TOLERANCE = 2;

/**
 * The two webs that go behind the scene, and the depths they go onto.
 *
 * Both depths are free and both are below the scene's 124. They are odd-numbered
 * neighbours' gaps - the room's own art runs 111, 113, 115 ... and leaves the even
 * numbers empty - and the three placements that share the band (117, 119, 121, 123)
 * are all ground pieces past room x 1100, so nothing of the room's own is displaced.
 */
const BACKGROUND_WEBS = [
  { what: "shoulderHigh", at: { x: 505, y: -437 }, depth: 118 },
  { what: "shoulderLow", at: { x: 574, y: -368 }, depth: 120 },
];

/**
 * The left-hand tree, turned round and lifted.
 *
 * `CENTRE` is where the middle of the drawn tree lands and `WIDTH` how wide it is, so
 * the part that hangs off the frame's left edge is implied rather than written down:
 * 335 wide centred on -177 runs room -344..-9, and the room only shows from about
 * -209, which is the cut the drawing has.
 */
const LEFT_TREE = {
  WIDTH: 335,
  CENTRE: -177,
  BASE_Y: -200,
};

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

function pointOf(tag: SwfTag): { x: number; y: number } | null {
  if (!isPlace(tag)) return null;
  const place = parsePlace(tag);
  if (!place.matrix) return null;
  return { x: place.matrix.translateX / 20, y: place.matrix.translateY / 20 };
}

function near(value: number, wanted: number): boolean {
  return Math.abs(value - wanted) < MATCH_TOLERANCE;
}

function main(): void {
  const argv = process.argv;
  const verify = argv.includes("--verify");
  const outIndex = argv.indexOf("--out");
  const out = outIndex === -1 ? SRN_SWF : path.resolve(argv[outIndex + 1]);

  const swf = readSwfFile(SRN_SWF);
  const room = readSymbolClasses(swf).find((entry) => entry.name === HOST_ROOM);
  if (!room) throw new SwfLevelError(`LevelsSRN.swf has no ${HOST_ROOM}`);
  const decorPlace = placementsOf(swf, room.id).find((place) => place.depth === DECOR_DEPTH);
  if (!decorPlace || decorPlace.charId === null) {
    throw new SwfLevelError(`${HOST_ROOM} has no dressing on depth ${DECOR_DEPTH}`);
  }

  // ---- the two webs, out of the dressing and in behind the scene -------------
  const moved: string[] = [];
  const roomWebs: SwfTag[] = [];
  const dressed = spriteInnerTags(swf.tags[spriteIndexFor(swf, decorPlace.charId)]).filter((tag) => {
    const point = pointOf(tag);
    if (!point) return true;
    const web = BACKGROUND_WEBS.find((entry) => near(point.x, entry.at.x) && near(point.y, entry.at.y));
    if (!web) return true;
    const place = parsePlace(tag);
    const matrix = place.matrix as NonNullable<typeof place.matrix>;
    roomWebs.push(
      buildPlaceObject2({
        depth: web.depth,
        charId: place.charId as number,
        x: matrix.translateX / 20,
        y: matrix.translateY / 20,
        scaleX: matrix.scaleX,
        scaleY: matrix.scaleY,
      }),
    );
    moved.push(web.what);
    return false;
  });

  // ---- the tree, mirrored and lifted ----------------------------------------
  const seated = placementsOf(swf, room.id).find((place) => place.depth === TREE_DEPTH);
  if (!seated || seated.charId === null) throw new SwfLevelError(`nothing on depth ${TREE_DEPTH} to turn round`);
  const bounds = characterBounds(swf, seated.charId);
  if (!bounds) throw new SwfLevelError("the wrapped tree has no bounds");
  const art = { left: bounds.xMin / 20, right: bounds.xMax / 20, bottom: bounds.yMax / 20 };
  const scale = LEFT_TREE.WIDTH / (art.right - art.left);
  /**
   * Mirrored, the art's own box runs backwards from the placement point: what was at
   * `left` lands at `x - scale*left` and what was at `right` at `x - scale*right`. So
   * the translation that centres it is the same expression as the upright one with the
   * sign flipped out of the scale.
   */
  const treeTag = buildPlaceObject2({
    depth: TREE_DEPTH,
    charId: seated.charId,
    x: LEFT_TREE.CENTRE + (scale * (art.left + art.right)) / 2,
    y: LEFT_TREE.BASE_Y - scale * art.bottom,
    scaleX: -scale,
    scaleY: scale,
  });
  const treeTurned = seated.matrix !== null && seated.matrix.scaleX > 0;

  console.log(
    `cobwebs put behind the scene: ${moved.length ? moved.join(", ") : "already there"}   ` +
      `left-hand tree: ${treeTurned ? "turned round and lifted" : "already turned"}`,
  );
  if (moved.length === 0 && !treeTurned) {
    console.log("the square already matches the reference.");
    return;
  }
  if (verify) {
    console.log("verify only - no file written.");
    return;
  }

  swf.tags[spriteIndexFor(swf, decorPlace.charId)] = rebuildSprite(
    swf.tags[spriteIndexFor(swf, decorPlace.charId)],
    dressed,
  );

  const roomIndex = spriteIndexFor(swf, room.id);
  const inner = spriteInnerTags(swf.tags[roomIndex]).filter(
    (tag) => !isPlace(tag) || parsePlace(tag).depth !== TREE_DEPTH,
  );
  const showFrame = inner.findIndex((tag) => tag.code === TAG_SHOW_FRAME);
  inner.splice(showFrame === -1 ? inner.length - 1 : showFrame, 0, treeTag, ...roomWebs);
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
