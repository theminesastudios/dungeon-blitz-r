/**
 * Seventh pass: the whole square slides right, and the last gap closes.
 *
 * Opening the scene's window in `-6` filled the strip of bare hillside at ground level,
 * but the gap above it stayed: the bare tree's outermost twigs finish around room 981
 * and the mushroom house's foliage does not begin until 1081, so a hundred pixels of
 * empty forest sat between them. Nothing can be drawn into that - it is the distance
 * between two pieces of artwork - so the square itself moves.
 *
 * ## What has to move, and why it is a list rather than one placement
 *
 * The seasonal scene is a single composite on depth 124, so the ruins, the wall, the
 * tree and the fence all move by moving one thing. Everything else that was positioned
 * *against* that artwork is a separate placement and has to travel with it, or it comes
 * adrift - and two of them are not decoration:
 *
 *   - **The rift and `a_Door_108`.** The door is the level exit. Left behind, the rift
 *     would be drawn a hundred pixels from the arch it belongs in and the doorway would
 *     be somewhere else again.
 *   - **The ledges inside `am_CollisionObject`.** `RUIN_LEDGES` are stroked soft-floor
 *     lines drawn onto the ruins so the wall can be climbed. They are one shape on
 *     depth 20 of the collision object; left where they are, a player would stand on
 *     empty air beside the wall and fall through the wall itself.
 *
 * The rest is the dressing composite, the tree, the higher cobweb, the besom's flame
 * and the three wisps over the rift.
 *
 * **Not moved:** the four `ac_HalloweenStatues` cues. They are the Black Rose Mire
 * leaderboard pedestals' own cues, kept because deleting a cue takes the room down with
 * it, and they draw nothing - so they are left exactly where the room authored them.
 *
 * ## The window has to be re-cut, not carried
 *
 * The mask is inside the composite, so it slides too - and a hundred pixels further out
 * the fence runs across the front of the mushroom house's trunk, which is the cut `-6`
 * rejected. So its right edge is pulled back in the composite's own coordinates by more
 * than the shift: the wall's far end lands at 1027 and the trunk starts at 1081, so the
 * window closes at 1085 and the fence spans just that.
 *
 * Its left edge is left alone. The scene's artwork begins at composite-local -172.5 and
 * the mask starts there too, so the mask never clipped that side; after the shift the
 * scene simply begins at room -72.5 and the gourds and the left-hand tree stand on the
 * room's own grass, which is the same grass.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-reference-square-7.ts
 *          [--verify] [--out <swf>] [--shift <px>]
 *
 * Re-runnable: it stops once the scene is already out at `SHIFT`.
 */
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
  SwfTag,
  buildSolidRectShape,
  characterBounds,
  characterId,
  ensureBackup,
  movePlacement,
  parsePlace,
  readSwfFile,
  readSymbolClasses,
  rebuildSprite,
  spriteInnerTags,
  writeSwfFile,
  TAG_DEFINE_SHAPE,
  TAG_DEFINE_SPRITE,
  TAG_PLACE_OBJECT2,
  TAG_PLACE_OBJECT3,
} from "./swfLevelUtils";

const SRN_SWF = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "LevelsSRN.swf");

const HOST_ROOM = "a_Room_SRN04";

/**
 * Where the square stands, measured from where the level authored it.
 *
 * A hundred closed the gap by the mushroom house exactly, but it also carried the
 * scene's own left edge out to room -72.5, into the open beside the gourds, where the
 * step between the scene's grass and the room's own shows. **Seventy** puts that step
 * at -102.5, which is inside the left-hand tree's trunk - the tree stands at -107 once
 * it has moved with everything else - so the join is behind bark instead of on grass.
 * The cost is thirty pixels of gap left at the house, which is the trade that was
 * asked for.
 *
 * This is an absolute position, not a nudge: the script reads where the scene is now
 * and moves everything by the difference, so changing this number re-seats the square
 * rather than shifting it again.
 */
const SHIFT = 70;

/** The scene composite's own depth in the room; everything else is listed against it. */
const SCENE_DEPTH = 124;

/**
 * The room depths that travel with the scene.
 *
 * Written as depths rather than as points because depths are what this file is
 * addressed by everywhere else in this series, and because a point moves every time the
 * square does - a list of points would be stale after the first run.
 *
 *   118 the higher cobweb        122 the left-hand bare tree
 *   124 the seasonal scene       230 the rift
 *   231 `a_Door_108`             234 the dressing composite
 *   236 the besom's green flame  237-239 the wisps over the rift
 */
const MOVES_WITH_SCENE = [118, 122, 124, 230, 231, 234, 236, 237, 238, 239];

/** The collision object, and the depth its climbable ledges sit on inside it. */
const COLLISION_INSTANCE = "am_CollisionObject";
const LEDGE_DEPTH = 20;

/**
 * The scene's window after the move, in the composite's own coordinates.
 *
 * `right` is where the fence stops: room 1085 once the composite is out at `SHIFT`.
 * `left` is the artwork's own edge, where the mask already sat and where it stays.
 */
const MASK = { left: -172.5, top: -900, bottom: 120, roomRight: 1092 };

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
  const shiftIndex = argv.indexOf("--shift");
  const shift = shiftIndex === -1 ? SHIFT : Number(argv[shiftIndex + 1]);

  const swf = readSwfFile(SRN_SWF);
  const room = readSymbolClasses(swf).find((entry) => entry.name === HOST_ROOM);
  if (!room) throw new SwfLevelError(`LevelsSRN.swf has no ${HOST_ROOM}`);
  const roomIndex = spriteIndexFor(swf, room.id);

  const scene = placementsOf(swf, room.id).find((place) => place.depth === SCENE_DEPTH);
  if (!scene || scene.charId === null || scene.matrix === null) {
    throw new SwfLevelError(`${HOST_ROOM} has no seasonal scene on depth ${SCENE_DEPTH}`);
  }
  const already = scene.matrix.translateX / 20;
  const delta = shift - already;

  /**
   * The cut is checked on its own, not only when the square moves.
   *
   * Where it lands is a *room* position - the mushroom house's trunk - and that reading
   * has been corrected more than once without the square itself needing to move. Tying
   * the re-cut to the move meant editing `MASK` did nothing until `SHIFT` was touched
   * as well.
   */
  const maskIndex = swf.tags.findIndex((tag) => {
    if (tag.code !== TAG_DEFINE_SHAPE) return false;
    const id = characterId(tag);
    if (id === null) return false;
    const box = characterBounds(swf, id);
    return (
      box !== null &&
      Math.abs(box.xMin / 20 - MASK.left) < 1 &&
      Math.abs(box.yMin / 20 - MASK.top) < 1 &&
      Math.abs(box.yMax / 20 - MASK.bottom) < 1
    );
  });
  if (maskIndex === -1) throw new SwfLevelError("the scene's mask rectangle is not in the file");
  const maskRight = MASK.roomRight - shift;
  const maskIsCut = Math.abs((characterBounds(swf, characterId(swf.tags[maskIndex]) as number) as { xMax: number }).xMax / 20 - maskRight) < 1;

  if (Math.abs(delta) < 1 && maskIsCut) {
    console.log(`the square is already out at ${shift}.`);
    return;
  }

  // ---- the room's own children ----------------------------------------------
  const moving = Math.abs(delta) >= 1;
  let moved = 0;
  const roomRebuilt = spriteInnerTags(swf.tags[roomIndex]).map((tag) => {
    if (!isPlace(tag)) return tag;
    if (!MOVES_WITH_SCENE.includes(parsePlace(tag).depth)) return tag;
    moved += 1;
    return moving ? movePlacement(tag, delta, 0) : tag;
  });
  if (moved !== MOVES_WITH_SCENE.length) {
    throw new SwfLevelError(`expected ${MOVES_WITH_SCENE.length} placements to move, found ${moved}`);
  }

  // ---- the climbable ledges, inside the collision object ----------------------
  const collision = placementsOf(swf, room.id).find((place) => place.name === COLLISION_INSTANCE);
  if (!collision || collision.charId === null) throw new SwfLevelError(`${HOST_ROOM} has no ${COLLISION_INSTANCE}`);
  const collisionIndex = spriteIndexFor(swf, collision.charId);
  let ledgesMoved = 0;
  const collisionRebuilt = spriteInnerTags(swf.tags[collisionIndex]).map((tag) => {
    if (!isPlace(tag) || parsePlace(tag).depth !== LEDGE_DEPTH) return tag;
    ledgesMoved += 1;
    return moving ? movePlacement(tag, delta, 0) : tag;
  });
  if (ledgesMoved !== 1) throw new SwfLevelError(`expected the ruin ledges on depth ${LEDGE_DEPTH}, found ${ledgesMoved}`);

  // ---- the window, re-cut ----------------------------------------------------
  /**
   * The window's right edge is a *room* position - the mushroom house's trunk - but the
   * mask lives inside the composite and travels with it, so what is written is that
   * position less however far the composite has been slid.
   */
  swf.tags[maskIndex] = buildSolidRectShape(
    characterId(swf.tags[maskIndex]) as number,
    { xMin: MASK.left * 20, xMax: maskRight * 20, yMin: MASK.top * 20, yMax: MASK.bottom * 20 },
    0x000000,
  );

  console.log(
    `${moving ? `moved ${moved} room children and the ruin ledges by ${delta.toFixed(0)}` : "square unmoved"} (out at ${shift}); ` +
      `window re-cut to ${maskRight} (room ${maskRight + shift})`,
  );
  if (verify) {
    console.log("verify only - no file written.");
    return;
  }

  swf.tags[roomIndex] = rebuildSprite(swf.tags[roomIndex], roomRebuilt);
  swf.tags[collisionIndex] = rebuildSprite(swf.tags[collisionIndex], collisionRebuilt);

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
