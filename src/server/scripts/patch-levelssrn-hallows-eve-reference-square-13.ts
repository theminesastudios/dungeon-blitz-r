/**
 * Thirteenth pass: the blunt branch ends at the top of the left-hand tree.
 *
 * ## It is the artwork, not the placement
 *
 * The topmost limbs of the bare tree stop dead - a flat edge where a twig should curl.
 * That is not something this series did to it. Exporting `UI_Seasonal.swf` character 37
 * on its own (the shape inside character 38, the tree) and laying it beside the same
 * corner of the room render, the two are identical: the same limb, the same flat end,
 * the same two horns beside it. The asset was drawn that way - cropped, most likely,
 * when the seasonal panel was composed, where the frame covered the top of the tree.
 *
 * In the square there is nothing over it, so it shows.
 *
 * ## Completing it
 *
 * The missing pieces are small, so they are drawn rather than borrowed: three hooked
 * twigs continuing the three stubs, as strokes in the tree's own darkest tone.
 *
 * `TWIG_RGB` is not guessed. Counting the colours in the crown of the room render gives
 * the tree four: 0x393E38 for the shaded side and the thin twigs, 0x545A53 for the lit
 * fill, 0x444A43 between them and 0x656D59 for the lichen speckles. The art's own twigs
 * are drawn in the first, so these are too.
 *
 * `TWIG_WIDTH` matches them as well - three and a half room pixels, which is what the
 * stubs measure across.
 *
 * They go on depth 128, above the tree on 122. Nothing else is up there: the seasonal
 * scene starts at room -102.5 and these are all left of -130.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-reference-square-13.ts
 *          [--verify] [--out <swf>]
 *
 * Re-runnable: it checks the depth first.
 */
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
  SwfTag,
  appendCharacterTag,
  buildPlaceObject2,
  buildStrokedPolylineShape,
  ensureBackup,
  maxCharacterId,
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

/** The depth the twigs go on: above the tree, and clear of everything else. */
const TWIG_DEPTH = 128;

/** The tree's darkest tone, which is what its own thin twigs are drawn in. */
const TWIG_RGB = 0x393e38;

/** Three and a half room pixels, in twips - the width the stubs measure across. */
const TWIG_WIDTH = 70;

/**
 * The twigs, in room pixels, each starting on the stub it continues.
 *
 * Read off an alpha map of the crown: the three stubs end at room (-148, -451),
 * (-139, -445) and (-166, -444). Each twig rises about ten pixels and then hooks back
 * on itself, which is how every other twig on this tree is drawn.
 */
const TWIGS: Array<Array<{ x: number; y: number }>> = [
  [
    { x: -148, y: -450 },
    { x: -151, y: -459 },
    { x: -146, y: -464 },
    { x: -152, y: -466 },
  ],
  [
    { x: -139, y: -444 },
    { x: -135, y: -452 },
    { x: -140, y: -458 },
    { x: -134, y: -460 },
  ],
  [
    { x: -166, y: -443 },
    { x: -170, y: -451 },
    { x: -165, y: -457 },
    { x: -172, y: -459 },
  ],
];

function spriteIndexFor(swf: SwfFile, charId: number): number {
  const index = swf.tags.findIndex((tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === charId);
  if (index === -1) throw new SwfLevelError(`character ${charId} is not a sprite`);
  return index;
}

function isPlace(tag: SwfTag): boolean {
  return tag.code === TAG_PLACE_OBJECT2 || tag.code === TAG_PLACE_OBJECT3;
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

  const taken = spriteInnerTags(swf.tags[roomIndex])
    .filter(isPlace)
    .some((tag) => parsePlace(tag).depth === TWIG_DEPTH);

  console.log(`branch twigs: ${taken ? "already drawn" : `${TWIGS.length} to draw`}`);
  if (taken) {
    console.log("the square already matches the reference.");
    return;
  }
  if (verify) {
    console.log("verify only - no file written.");
    return;
  }

  const shapeId = maxCharacterId(swf) + 1;
  appendCharacterTag(
    swf,
    buildStrokedPolylineShape(
      shapeId,
      TWIGS.map((twig) => twig.map((point) => ({ x: Math.round(point.x * 20), y: Math.round(point.y * 20) }))),
      TWIG_RGB,
      TWIG_WIDTH,
    ),
  );

  /**
   * Placed at the room's own origin at scale 1, because the twigs are written in room
   * pixels - there is no character to be positioned relative to.
   */
  const inner = spriteInnerTags(swf.tags[spriteIndexFor(swf, room.id)]);
  const showFrame = inner.findIndex((tag) => tag.code === TAG_SHOW_FRAME);
  inner.splice(
    showFrame === -1 ? inner.length - 1 : showFrame,
    0,
    buildPlaceObject2({ depth: TWIG_DEPTH, charId: shapeId, x: 0, y: 0, scaleX: 1, scaleY: 1 }),
  );
  swf.tags[spriteIndexFor(swf, room.id)] = rebuildSprite(swf.tags[spriteIndexFor(swf, room.id)], inner);

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
