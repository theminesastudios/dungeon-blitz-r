/**
 * Sixth pass: the bare strip between the ruins and the mushroom house, and the webs.
 *
 * ## The gap on the right was a crop, not missing art
 *
 * Walking right from the skull wall the square ran out into a hundred pixels of plain
 * hillside before the mushroom house began - a dead strip with two lonely fence spikes
 * in it. It reads as a seam between two pictures, and it is one.
 *
 * The seasonal scene is **not** cropped by having been cut down. `a_Room_SRN04` holds
 * it as character 1955 - the whole of `UI_Seasonal.swf` character 60, 795 scene pixels
 * laid down at 2.15, so it reaches room 1632 - and character **2013 is a mask**: a
 * 44-byte `DefineShape` rectangle placed on depth 1 of the scene composite with a clip
 * depth, showing the art only between room -172.5 and 1020. Everything past 1020 is
 * there and simply not drawn.
 *
 * And what is there is exactly what the strip wants: the scene's own iron fence,
 * carrying on along the hillside. So the mask's right edge moves out to **1100**, which
 * is where the mushroom house's trunk begins - the fence runs from the wall to the
 * trunk and stops against it, and the cut in the grass falls on the trunk's own edge
 * where nothing shows. 1130 was tried too and is worse: the fence then draws across the
 * front of the trunk and the cut lands in open bark.
 *
 * Nothing moves for this. The mask is one rectangle and it is the only thing rewritten.
 *
 * ## The webs
 *
 * Their points are right - measured against the besom and the tower they land where the
 * drawing has them - but they draw small and thin, and the higher one sits behind the
 * scene, so what reaches the screen is a fragment. They grow by about a quarter and
 * both lift, so more of each stands clear of the artwork in front of it.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-reference-square-6.ts
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
  buildSolidRectShape,
  characterBounds,
  characterId,
  ensureBackup,
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
const DECOR_DEPTH = 234;

/** How close a placement has to be to a point below to count as already on it. */
const SETTLED = 1;

/**
 * The scene's window, as it is now and as it becomes.
 *
 * The mask is found by its box rather than by a character number, because the number
 * is whatever the import happened to give it. Nothing else in the file is a shape a
 * thousand and twenty pixels tall starting at room -172.5.
 */
const MASK = {
  left: -172.5,
  top: -900,
  bottom: 120,
  wasRight: 1020,
  right: 1100,
};

/**
 * The webs, by the depths they are on and the points they move to.
 *
 * The higher one is a room child behind the scene (depth 118); the lower one lives in
 * the dressing composite in front of it, and is found there by its point.
 */
const BEHIND_WEB = { depth: 118, x: 512, y: -425, scale: 0.85 };
const FRONT_WEB = { was: { x: 593, y: -327 }, x: 585, y: -360, scale: 0.68 };

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

function near(value: number, wanted: number): boolean {
  return Math.abs(value - wanted) < SETTLED;
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

  /**
   * The window is only this script's to open while the square still stands where it
   * did. Once `-7` has slid the scene along, that pass owns the cut - it re-measures it
   * against the mushroom house in the composite's own coordinates - and re-widening it
   * from here would push the fence back across the front of the trunk.
   */
  const maskIndex = shift !== 0 ? -1 : swf.tags.findIndex((tag) => {
    if (tag.code !== TAG_DEFINE_SHAPE) return false;
    const id = characterId(tag);
    if (id === null) return false;
    const box = characterBounds(swf, id);
    return (
      box !== null &&
      near(box.xMin / 20, MASK.left) &&
      near(box.yMin / 20, MASK.top) &&
      near(box.yMax / 20, MASK.bottom) &&
      box.xMax / 20 < MASK.right - SETTLED
    );
  });
  if (maskIndex !== -1) {
    const id = characterId(swf.tags[maskIndex]) as number;
    swf.tags[maskIndex] = buildSolidRectShape(
      id,
      { xMin: MASK.left * 20, xMax: MASK.right * 20, yMin: MASK.top * 20, yMax: MASK.bottom * 20 },
      0x000000,
    );
    changed.push(`scene window out to ${MASK.right}`);
  }

  // ---- the higher web, behind the scene -------------------------------------
  const roomRebuilt = spriteInnerTags(swf.tags[roomIndex]).map((tag) => {
    if (!isPlace(tag)) return tag;
    const place = parsePlace(tag);
    if (place.depth !== BEHIND_WEB.depth || place.charId === null || place.matrix === null) return tag;
    if (near(place.matrix.translateX / 20, BEHIND_WEB.x + shift) && near(place.matrix.translateY / 20, BEHIND_WEB.y)) {
      return tag;
    }
    changed.push("higher cobweb");
    return buildPlaceObject2({
      depth: BEHIND_WEB.depth,
      charId: place.charId,
      x: BEHIND_WEB.x + shift,
      y: BEHIND_WEB.y,
      scaleX: BEHIND_WEB.scale,
      scaleY: BEHIND_WEB.scale,
    });
  });

  // ---- the lower web, in the dressing ---------------------------------------
  const decorIndex = spriteIndexFor(swf, decorPlace.charId);
  const decorRebuilt = spriteInnerTags(swf.tags[decorIndex]).map((tag) => {
    if (!isPlace(tag)) return tag;
    const place = parsePlace(tag);
    if (place.charId === null || place.matrix === null) return tag;
    const x = place.matrix.translateX / 20;
    const y = place.matrix.translateY / 20;
    if (!near(x, FRONT_WEB.was.x) || !near(y, FRONT_WEB.was.y)) return tag;
    changed.push("lower cobweb");
    return buildPlaceObject2({
      depth: place.depth,
      charId: place.charId,
      x: FRONT_WEB.x,
      y: FRONT_WEB.y,
      scaleX: FRONT_WEB.scale,
      scaleY: FRONT_WEB.scale,
    });
  });

  console.log(`changed: ${changed.length ? changed.join(", ") : "nothing"}`);
  if (changed.length === 0) {
    console.log("the square already matches the reference.");
    return;
  }
  if (verify) {
    console.log("verify only - no file written.");
    return;
  }

  swf.tags[roomIndex] = rebuildSprite(swf.tags[roomIndex], roomRebuilt);
  swf.tags[decorIndex] = rebuildSprite(swf.tags[decorIndex], decorRebuilt);

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
