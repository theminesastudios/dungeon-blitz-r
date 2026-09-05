/**
 * Fifth pass, and the one that settles the tree: it is a **full-sized** tree, cut off.
 *
 * The fourth pass shrank it to 215 room pixels because the drawing's tree looked
 * 235 wide. That reading was wrong in a way worth writing down, because it is the same
 * mistake three passes made in different clothes: **the drawing's left edge is a crop,
 * not an edge of the thing behind it.** The tree runs off the side of the picture, so
 * what can be measured across is only part of it.
 *
 * Two things say so, and they agree:
 *
 *   - **Its aspect.** Character 38 is 358 x 343, near enough square. In the drawing the
 *     tree stands 365 pixels tall, so it must be about 380 across - not the 235 that
 *     are inside the frame. A hundred and forty-five of it are off the left edge.
 *   - **The other tree.** The drawing's two bare trees are plainly the same size as one
 *     another - 380 and 400 pixels across - and the right-hand one is the scene's own,
 *     which is 410 room pixels wide. So the left-hand one is about 400 too.
 *
 * Its right edge is where the picket fence begins, room -15. The width is then trimmed
 * against the tower's crown skull - see `LEFT_TREE` - and its roots come down half a
 * skull-gap above the gourds' base, room -158, not the -200 the third pass lifted it
 * to, which is what left it standing clear of the grass.
 *
 * ## And one of the two webs belongs in front after all
 *
 * The third pass put both behind the scene. That is right for the higher one, which the
 * drawing shows through the gaps in the iron fence - but the lower one is drawn *over*
 * the stone wall's top-left corner, its strands crossing the masonry. Behind the scene
 * that corner simply swallows it. So it goes back into the dressing composite, on the
 * same point, and only the higher one stays behind.
 *
 * ## Where the webs ended up
 *
 * Their points were settled on the way here and are baked into the file: room
 * (519, -400) for the higher and (593, -327) for the lower, both read as fractions of
 * the gap between the tower's two skulls rather than as absolute pixels. Nothing here
 * moves them - the lower one only changes which layer it is drawn on.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-reference-square-5.ts
 *          [--verify] [--out <swf>]
 *
 * Re-runnable: it stops when everything already sits where it should.
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

/** How close a placement has to be to a point below to count as already on it. */
const SETTLED = 1;

/**
 * The left-hand tree: near enough as wide as the one it is a second copy of, and back
 * on the grass.
 *
 * 400 - the scene tree's own width - drew its crown up to the top of the frame, which
 * the drawing does not. Measured against the one landmark that has never moved, the
 * skull on the tower's crown: in the drawing the tree's topmost twigs finish about 110
 * pixels below that skull's top, and at 400 they finished 30 below. Seventy-five room
 * pixels of height come off, which is 325 across.
 */
const LEFT_TREE = {
  WIDTH: 325,
  CENTRE: -177,
  BASE_Y: -158,
};

/** The web that comes back out in front, and the depth the third pass left it on. */
const FRONT_WEB_DEPTH = 120;

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


/**
 * How far the seasonal scene has been slid along the room, in room pixels.
 *
 * `patch-levelssrn-hallows-eve-reference-square-7.ts` moves the square right to close
 * the gap by the mushroom house, and it moves the scene's composite together with every
 * room child that was positioned against it. Anything in this file that names a
 * **room-level** x therefore has to be read through this, or it will look for a prop
 * where the prop used to be and quietly drag it back.
 *
 * Points inside the dressing composite need no such thing: the composite moved as a
 * whole, so its contents kept their own coordinates.
 */
function sceneOffset(swf: SwfFile, roomCharId: number): number {
  const scene = placementsOf(swf, roomCharId).find((place) => place.depth === 124);
  return scene && scene.matrix ? scene.matrix.translateX / 20 : 0;
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
  const decorPlace = placementsOf(swf, room.id).find((place) => place.depth === DECOR_DEPTH);
  if (!decorPlace || decorPlace.charId === null) {
    throw new SwfLevelError(`${HOST_ROOM} has no dressing on depth ${DECOR_DEPTH}`);
  }

  const shift = sceneOffset(swf, room.id);
  const changed: string[] = [];
  /** The lower web's tag, lifted out of the room so it can go into the dressing. */
  let frontWeb: SwfTag | null = null;

  const roomRebuilt: SwfTag[] = [];
  for (const tag of spriteInnerTags(swf.tags[roomIndex])) {
    if (!isPlace(tag)) {
      roomRebuilt.push(tag);
      continue;
    }
    const place = parsePlace(tag);
    if (place.charId === null || place.matrix === null) {
      roomRebuilt.push(tag);
      continue;
    }

    if (place.depth === FRONT_WEB_DEPTH) {
      /**
       * Rebuilt rather than reused: the depth it lands on inside the dressing is not
       * the one it had out here, and its point and scale are the only parts that carry.
       */
      frontWeb = tag;
      changed.push("lower cobweb back in front");
      continue;
    }

    if (place.depth !== TREE_DEPTH) {
      roomRebuilt.push(tag);
      continue;
    }

    const bounds = characterBounds(swf, place.charId);
    if (!bounds) throw new SwfLevelError("the wrapped tree has no bounds");
    const art = { left: bounds.xMin / 20, right: bounds.xMax / 20, bottom: bounds.yMax / 20 };
    const scale = LEFT_TREE.WIDTH / (art.right - art.left);
    const x = LEFT_TREE.CENTRE + shift + (scale * (art.left + art.right)) / 2;
    const y = LEFT_TREE.BASE_Y - scale * art.bottom;
    /**
     * Judged on where it stands and how wide it is, **not** on its seat.
     *
     * `-9` brings the tree down onto the room's own hill band once the square has moved
     * off it, so its y is no longer this script's to hold. Testing y here would see a
     * tree that is turned round and the right size and lift it back into the air.
     */
    if (Math.abs(place.matrix.translateX / 20 - x) < SETTLED && Math.abs(place.matrix.scaleX + scale) < 0.001) {
      roomRebuilt.push(tag);
      continue;
    }
    changed.push("left-hand tree");
    roomRebuilt.push(
      buildPlaceObject2({ depth: TREE_DEPTH, charId: place.charId, x, y, scaleX: -scale, scaleY: scale }),
    );
  }

  console.log(`re-seated: ${changed.length ? changed.join(", ") : "nothing"}`);
  if (changed.length === 0) {
    console.log("the square already matches the reference.");
    return;
  }
  if (verify) {
    console.log("verify only - no file written.");
    return;
  }

  swf.tags[roomIndex] = rebuildSprite(swf.tags[roomIndex], roomRebuilt);

  if (frontWeb) {
    const decorIndex = spriteIndexFor(swf, decorPlace.charId);
    const inner = spriteInnerTags(swf.tags[decorIndex]);
    const place = parsePlace(frontWeb);
    const matrix = place.matrix as NonNullable<typeof place.matrix>;
    const depth = Math.max(...inner.filter(isPlace).map((tag) => parsePlace(tag).depth)) + 1;
    const showFrame = inner.findIndex((tag) => tag.code === TAG_SHOW_FRAME);
    inner.splice(
      showFrame === -1 ? inner.length - 1 : showFrame,
      0,
      buildPlaceObject2({
        depth,
        charId: place.charId as number,
        x: matrix.translateX / 20,
        y: matrix.translateY / 20,
        scaleX: matrix.scaleX,
        scaleY: matrix.scaleY,
      }),
    );
    swf.tags[decorIndex] = rebuildSprite(swf.tags[decorIndex], inner);
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
