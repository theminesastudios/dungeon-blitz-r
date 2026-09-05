/**
 * Second pass over the square against the reference drawing.
 *
 * `patch-levelssrn-hallows-eve-reference-square.ts` took out the props the drawing
 * does not have. Laying the two pictures side by side again, four things are still
 * placed differently - and one is simply missing:
 *
 *   - **The bare tree at the far left is not there at all.** The drawing has a second
 *     gnarled tree standing behind the picket fence on the left of the square. It is
 *     the scene's *own* tree - `UI_Seasonal.swf` character 38, the one character 60
 *     places at scene 422.9 - reused smaller and the other way round. See `LEFT_TREE`.
 *   - **The big cobweb hangs the wrong way.** It falls from the jaw of the skull on
 *     the tower's left in both, but in the drawing it fans down and to the **left**;
 *     ours fanned down and to the right. It is one sign on `scaleX`.
 *   - **The two cobwebs off the tower's right shoulder are too small**, by about half
 *     again, and sit a little left of where the drawing hangs them.
 *   - **The jack-o'-lanterns are still about ninety pixels too far right.** The first
 *     pass moved them a hundred and fifteen; the drawing wants them further out still,
 *     past the foot of the picket fence and against the frame's left edge.
 *
 * ## The mapping, redone
 *
 * The first pass fitted the drawing to room pixels off two landmarks and got the
 * scale slightly wrong, which is why the gourds only went half the distance. This one
 * pins it to the seasonal scene's own box: character 2013 covers room -172.5..1020,
 * and the drawing is that box, give or take a sliver at each end. Fitting the tower's
 * crown skull, the skull on its left and the skull grid on the wall through
 * `reference = 1.1489 * room + 240` puts all three within a few pixels, so that is
 * what every number below is read through - `room = (reference - 240) / 1.1489`.
 *
 * ## Why the tree goes in the room and not in the dressing
 *
 * The picket fence is drawn *in front of* it, and the fence is part of character 2013,
 * the scene's single flattened shape on depth 124. Anything in the dressing composite
 * (depth 234) draws over that. So the tree is a room child of its own on **depth 122**,
 * one below the scene - which also means the scene's hillside covers the foot of its
 * trunk, exactly as the drawing has it.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-reference-square-2.ts
 *          [--verify] [--out <swf>]
 *
 * Re-runnable: every step checks for its own result first.
 */
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
  SwfTag,
  appendCharacterTag,
  buildPlaceObject2,
  characterBounds,
  encodeTag,
  ensureBackup,
  importCharacters,
  maxCharacterId,
  parsePlace,
  readSwfFile,
  readSymbolClasses,
  rebuildSprite,
  repointPlacement,
  spriteInnerTags,
  writeSwfFile,
  TAG_DEFINE_SPRITE,
  TAG_END,
  TAG_PLACE_OBJECT2,
  TAG_PLACE_OBJECT3,
  TAG_SHOW_FRAME,
} from "./swfLevelUtils";

const CLIENT = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p");
const SRN_SWF = path.join(CLIENT, "cbp", "LevelsSRN.swf");
const SEASONAL_SWF = path.join(CLIENT, "cbo", "UI_Seasonal.swf");

const HOST_ROOM = "a_Room_SRN04";
const DECOR_DEPTH = 234;

/** The seasonal scene itself, the character the tree's own placement is copied out of. */
const SEASONAL_SCENE_CHAR = 60;

/** How close a placement has to be to one of the points below to count as it. */
const MATCH_TOLERANCE = 2;

/**
 * The bare tree the drawing stands at the far left, and where it goes.
 *
 * `SOURCE_CHAR` is character 38 of `UI_Seasonal.swf` - 358 x 343 of gnarled leafless
 * tree. Character 60 already places it once, at scene 422.9 and `scaleX -0.532`, and
 * with the ruins laid down at 2.15 that comes out 410 room pixels wide. The drawing's
 * left-hand tree measures about six tenths of that, hence `WIDTH`.
 *
 * **The way round and the size here are both superseded.** This pass places it as the
 * character is drawn and 335 wide; `-3` mirrors it - which the drawing's own geometry
 * turns out to require - and `-5` settles the width at 325 and the seat at -158. What
 * still matters here is the import, the colour and the depth; the matrix does not, and
 * this script leaves an existing tree alone rather than putting it back on these
 * numbers.
 *
 * `BASE` is the point its roots stand on. It is up the hillside rather than down on
 * the floor line - the drawing has it behind the picket fence, its trunk running into
 * the grass - so it is seated eighty pixels above the gourds rather than beside them.
 *
 * ## The colour has to come with it
 *
 * Character 38 on its own is **olive**, not the grey-brown the square's tree is: the
 * grey is a colour transform on character 60's own placement of it, not part of the
 * art. Imported and placed plainly it comes out the colour of a live tree, which is
 * how the first attempt drew it.
 *
 * A `PlaceObject2`'s matrix and its colour transform are packed as bit fields one
 * after the other, so the transform cannot simply be lifted onto a placement of our
 * own without re-encoding both. So the scene's placement is **copied whole** - matrix,
 * transform and all - into a wrapper sprite of one frame, and the wrapper is what the
 * room places. The scene's matrix then just becomes part of the wrapper's contents and
 * `characterBounds` reports the box it actually draws, which is what the size and seat
 * below are solved against.
 */
const LEFT_TREE = {
  SOURCE_CHAR: 38,
  DEPTH: 122,
  WIDTH: 335,
  BASE: { x: -140, y: -158 },
};

/**
 * The cobwebs, as the drawing hangs them.
 *
 * All three were already in the right *places* - what was wrong is the first one's
 * handedness and the other two's size.
 *
 *   - `jaw` falls from the jaw of the skull on the tower's left. Its placement point
 *     is the web's own apex (the art's top-left corner), so mirroring it about that
 *     point leaves the apex on the jaw and swings the fan across to the other side,
 *     which is where the drawing has it: reference 245..420, room 4..157.
 *   - `shoulderHigh` and `shoulderLow` hang off the tower's right shoulder, at
 *     reference 820..960 and 900..1010 - room 505..627 and 574..670. Their old scales
 *     drew them 81 and 72 pixels wide against the 122 and 96 the drawing wants.
 *
 * Each is matched by the point it is on now, so this can find them without knowing
 * which imported character is which web.
 */
const WEBS = [
  { what: "jaw", at: [178], y: -392, x: 178, scaleX: -1.42, scaleY: 1.42 },
  { what: "shoulderHigh", at: [470, 505], y: -437, x: 505, scaleX: 0.68, scaleY: 0.68 },
  { what: "shoulderLow", at: [545, 574], y: -368, x: 574, scaleX: 0.53, scaleY: 0.53 },
];

/** Where the carved face sits on the gourd, in the gourd's own pixels. */
const FACE_OFFSET = { x: 12.9, y: -7.1 };

/**
 * The jack-o'-lanterns, on the drawing's own points this time.
 *
 * The pair covers reference 45..190, which through the corrected mapping is room
 * -170..-43: a centre of -106 and a width of 127 against the -17 and 118 they had.
 * So they move 89 pixels further left and grow by about a fourteenth.
 */
const GROUND_PUMPKINS = [
  { x: -133, y: -78, scale: 0.67, flip: false },
  { x: -75, y: -80, scale: 0.59, flip: true },
];

/** Where the gourds stand now, so an already-patched file can be recognised. */
const PREVIOUS_PUMPKIN_X = [-44, 14];

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
  const decorIndex = spriteIndexFor(swf, decorPlace.charId);
  const decorInner = spriteInnerTags(swf.tags[decorIndex]);

  // ---- the cobwebs: one turned round, two grown ------------------------------
  const rehung: string[] = [];
  let dressed = decorInner.map((tag) => {
    const point = pointOf(tag);
    if (!point) return tag;
    const web = WEBS.find((entry) => near(point.y, entry.y) && entry.at.some((x) => near(point.x, x)));
    if (!web) return tag;
    const place = parsePlace(tag);
    /**
     * Only counted when it actually changes. The points a web can be found on include
     * the one this script puts it on, so without this a second run would report all
     * three as rehung and never reach the "already matches" line.
     */
    if (place.matrix && Math.abs(place.matrix.scaleX - web.scaleX) > 0.001) rehung.push(web.what);
    return buildPlaceObject2({
      depth: place.depth,
      charId: place.charId as number,
      x: web.x,
      y: web.y,
      scaleX: web.scaleX,
      scaleY: web.scaleY,
    });
  });

  // ---- the gourds, the rest of the way out ----------------------------------
  const gourdTags = dressed.filter((tag) => {
    const point = pointOf(tag);
    return point !== null && PREVIOUS_PUMPKIN_X.some((x) => Math.abs(point.x - x) < 16);
  });
  let pumpkinsMoved = false;
  if (gourdTags.length === 4) {
    const parsed = gourdTags.map((tag) => parsePlace(tag));
    const rebuilt = GROUND_PUMPKINS.flatMap((pumpkin, index) => {
      const gourd = parsed[index * 2];
      const face = parsed[index * 2 + 1];
      const sign = pumpkin.flip ? -1 : 1;
      return [
        buildPlaceObject2({
          depth: gourd.depth,
          charId: gourd.charId as number,
          x: pumpkin.x,
          y: pumpkin.y,
          scaleX: sign * pumpkin.scale,
          scaleY: pumpkin.scale,
        }),
        buildPlaceObject2({
          depth: face.depth,
          charId: face.charId as number,
          x: pumpkin.x + sign * FACE_OFFSET.x * pumpkin.scale,
          y: pumpkin.y + FACE_OFFSET.y * pumpkin.scale,
          scaleX: sign * pumpkin.scale,
          scaleY: pumpkin.scale,
        }),
      ];
    });
    let next = 0;
    dressed = dressed.map((tag) => (gourdTags.includes(tag) ? rebuilt[next++] : tag));
    pumpkinsMoved = true;
  } else if (gourdTags.length !== 0) {
    throw new SwfLevelError(`expected 4 jack-o'-lantern placements, found ${gourdTags.length}`);
  }

  // ---- the bare tree at the far left ----------------------------------------
  const seasonal = readSwfFile(SEASONAL_SWF);
  const donor = spriteInnerTags(seasonal.tags[spriteIndexFor(seasonal, SEASONAL_SCENE_CHAR)])
    .filter(isPlace)
    .find((tag) => parsePlace(tag).charId === LEFT_TREE.SOURCE_CHAR);
  if (!donor) throw new SwfLevelError(`character ${SEASONAL_SCENE_CHAR} does not place the bare tree`);
  const artBounds = characterBounds(seasonal, LEFT_TREE.SOURCE_CHAR);
  if (!artBounds) throw new SwfLevelError(`${path.basename(SEASONAL_SWF)} has no character ${LEFT_TREE.SOURCE_CHAR}`);

  /**
   * The two halves of the tree, found by what they *are* rather than by shape.
   *
   * An earlier draft looked for "a sprite whose only child carries a colour transform"
   * and matched an unrelated Black Rose Mire prop, which it then stood at the far left
   * of the square. So the raw tree is identified by its own box - 358 x 343, and
   * nothing else in LevelsSRN.swf is that size - and the wrapper by the fact that its
   * single child is that tree.
   */
  const sprites = swf.tags.filter((tag) => tag.code === TAG_DEFINE_SPRITE).map((tag) => tag.data.readUInt16LE(0));
  const sameBox = (id: number): boolean => {
    const box = characterBounds(swf, id);
    return (
      box !== null &&
      Math.abs(box.xMax - box.xMin - (artBounds.xMax - artBounds.xMin)) < 20 &&
      Math.abs(box.yMax - box.yMin - (artBounds.yMax - artBounds.yMin)) < 20
    );
  };
  let treeChar = sprites.find(sameBox);
  if (treeChar === undefined) {
    treeChar = importCharacters(seasonal, swf, [LEFT_TREE.SOURCE_CHAR]).idMap.get(LEFT_TREE.SOURCE_CHAR);
    if (treeChar === undefined) throw new SwfLevelError("the bare tree did not import");
  }
  const treeCharId = treeChar;
  const existingWrapper = swf.tags
    .filter((tag) => tag.code === TAG_DEFINE_SPRITE)
    .map((tag) => tag.data.readUInt16LE(0))
    .find((charId) => {
      const children = spriteInnerTags(swf.tags[spriteIndexFor(swf, charId)]).filter(isPlace);
      return children.length === 1 && parsePlace(children[0]).charId === treeCharId;
    });

  let wrapperId = existingWrapper;
  if (wrapperId === undefined) {
    wrapperId = maxCharacterId(swf) + 1;
    const head = Buffer.alloc(4);
    head.writeUInt16LE(wrapperId, 0);
    head.writeUInt16LE(1, 2);
    appendCharacterTag(swf, {
      code: TAG_DEFINE_SPRITE,
      data: Buffer.concat([
        head,
        encodeTag(repointPlacement(donor, treeCharId)),
        encodeTag({ code: TAG_SHOW_FRAME, data: Buffer.alloc(0) }),
        encodeTag({ code: TAG_END, data: Buffer.alloc(0) }),
      ]),
    });
  }

  const treeBounds = characterBounds(swf, wrapperId);
  if (!treeBounds) throw new SwfLevelError("the wrapped bare tree has no bounds");
  const art = { left: treeBounds.xMin / 20, right: treeBounds.xMax / 20, bottom: treeBounds.yMax / 20 };
  const treeScale = LEFT_TREE.WIDTH / (art.right - art.left);
  /**
   * Seated by where its roots and its middle land rather than by its origin: the
   * wrapper is drawn up and out from a point that is neither, so putting it on the
   * hillside means solving for the translation rather than writing one down.
   */
  const treeTag = buildPlaceObject2({
    depth: LEFT_TREE.DEPTH,
    charId: wrapperId,
    x: LEFT_TREE.BASE.x - (treeScale * (art.left + art.right)) / 2,
    y: LEFT_TREE.BASE.y - treeScale * art.bottom,
    scaleX: treeScale,
    scaleY: treeScale,
  });
  /**
   * What the room already has on the tree's depth, so a re-run says what it did and a
   * second run says it did nothing.
   */
  const seated = placementsOf(swf, room.id).find((place) => place.depth === LEFT_TREE.DEPTH);
  /**
   * Any placement on the depth counts, not one matching this script's own numbers.
   *
   * Later passes turn this tree round and re-size it - `-3` mirrors it, `-5` settles
   * its width - and a test against *these* numbers would see a tree that is not where
   * this script would put it, re-seat it upright, and quietly undo both of them. The
   * question this needs to ask is "is the tree in", not "is the tree where I left it".
   */
  const treeSeated = seated !== undefined;
  const treeState = treeSeated ? "already seated" : existingWrapper === undefined ? "wrapped and placed" : "re-seated";

  console.log(
    `cobwebs rehung: ${rehung.length ? rehung.join(", ") : "none"}   ` +
      `jack-o'-lanterns: ${pumpkinsMoved ? "moved out to the drawing's points" : "already there"}   ` +
      `left-hand bare tree: ${treeState}`,
  );
  if (rehung.length === 0 && !pumpkinsMoved && treeSeated) {
    console.log("the square already matches the reference.");
    return;
  }
  if (verify) {
    console.log("verify only - no file written.");
    return;
  }

  /**
   * Looked up again rather than reused. `importCharacters` splices the tree's own
   * tags in ahead of the `SymbolClass` tag, so every index taken before it - including
   * `decorIndex` and `roomIndex` above - now points one character too early.
   */
  const decorNow = spriteIndexFor(swf, decorPlace.charId);
  swf.tags[decorNow] = rebuildSprite(swf.tags[decorNow], dressed);

  /**
   * Straight into the room's first frame, before the `ShowFrame` that ends it - a
   * placement after that frame would draw a frame late, which on a one-frame room
   * means never. Any placement already on that depth comes out first, so re-running
   * re-seats the tree rather than stacking a second one on top of it.
   */
  if (!treeSeated) {
    const roomNow = spriteIndexFor(swf, room.id);
    const inner = spriteInnerTags(swf.tags[roomNow]);
    const showFrame = inner.findIndex((tag) => tag.code === TAG_SHOW_FRAME);
    inner.splice(showFrame === -1 ? inner.length - 1 : showFrame, 0, treeTag);
    swf.tags[roomNow] = rebuildSprite(swf.tags[roomNow], inner);
  }

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
