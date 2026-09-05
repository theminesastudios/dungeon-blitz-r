/**
 * Twelfth pass: the tree comes back in front of the grass, whole.
 *
 * `-11` put it behind the ground so the turf would cover its foot. That cured the
 * flat-bottomed silhouette and caused a worse one: the ground tiles' top edge is very
 * nearly a straight line where the tree stands, so instead of the trunk sinking into
 * ragged grass it was **guillotined** - cut clean across at room y -159, with its root
 * flare and the art's own grass tufts hidden underneath.
 *
 * The tree is drawn to be seen whole. Character 38 has its roots and a few green tufts
 * at its base, which is how character 60 uses it - stood on the grass, not in it. So it
 * goes back to depth **122**, in front of the ground and behind the seasonal scene, and
 * shows all of itself again.
 *
 * The reason it looked wrong there before is gone. What made it read as broken was never
 * its own silhouette but the pale rectangle the scene's grass drew beside it, and `-10`
 * levelled that away.
 *
 * `TREE_DEPTH` is shared with `-2`, `-3`, `-5`, `-7` and `-9`; they go back to 122 with
 * this.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-reference-square-12.ts
 *          [--verify] [--out <swf>]
 *
 * Re-runnable: it stops once the tree is already in front.
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
} from "./swfLevelUtils";

const SRN_SWF = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "LevelsSRN.swf");

const HOST_ROOM = "a_Room_SRN04";

/** Where `-11` put the tree, and where it belongs. */
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

function main(): void {
  const argv = process.argv;
  const verify = argv.includes("--verify");
  const outIndex = argv.indexOf("--out");
  const out = outIndex === -1 ? SRN_SWF : path.resolve(argv[outIndex + 1]);

  const swf = readSwfFile(SRN_SWF);
  const room = readSymbolClasses(swf).find((entry) => entry.name === HOST_ROOM);
  if (!room) throw new SwfLevelError(`LevelsSRN.swf has no ${HOST_ROOM}`);
  const roomIndex = spriteIndexFor(swf, room.id);

  let moved = false;
  const rebuilt = spriteInnerTags(swf.tags[roomIndex]).map((tag) => {
    if (!isPlace(tag)) return tag;
    const place = parsePlace(tag);
    if (place.depth !== TREE_FROM || place.charId === null || place.matrix === null) return tag;
    moved = true;
    return buildPlaceObject2({
      depth: TREE_TO,
      charId: place.charId,
      x: place.matrix.translateX / 20,
      y: place.matrix.translateY / 20,
      scaleX: place.matrix.scaleX,
      scaleY: place.matrix.scaleY,
    });
  });

  console.log(`left-hand tree: ${moved ? `back in front, on depth ${TREE_TO}` : "already in front"}`);
  if (!moved) {
    console.log("the square already matches the reference.");
    return;
  }
  if (verify) {
    console.log("verify only - no file written.");
    return;
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
