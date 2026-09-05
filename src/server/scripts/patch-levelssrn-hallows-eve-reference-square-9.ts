/**
 * Ninth pass: finishing the ground at the left-hand end, and standing the tree on it.
 *
 * With the square out at seventy the join between the seasonal scene's grass and the
 * room's own falls at room -102.5, behind the left-hand tree's trunk, which is what was
 * wanted. What that exposed is that the ground it now falls onto was never finished -
 * the scene used to be the only artwork there, so nothing else had to be right. Four
 * things, all measured off the room's own placements rather than guessed:
 *
 *   - **A sixteen-pixel strip with nothing in it.** Black Rose Mire draws its ground in
 *     two bands: the hill band (character 29, placed at y -115) covers room y -135..-78,
 *     and the low band (character 18, at y -16) covers -62..78. Between -78 and -62
 *     there is nothing, and left of room -76 there is no parallax behind it either, so
 *     it reads as a slot cut through the grass. `BRIDGE` lays the low band's own tile
 *     again, sixteen pixels higher, which closes it.
 *   - **Both bands stop.** The hill band ends at -554 and the low band at -655, and the
 *     camera reaches past both when the player stands at the square's left wall.
 *     `EXTEND` carries each one further.
 *   - **The join itself.** Above room y -147 the tree's trunk covers it; below that it
 *     is open grass. `SCRUB` puts two of the room's own bushes over it - one on the
 *     join, one further out so it does not read as a single planted thing.
 *   - **The tree stood on nothing.** Its roots were seated at -158, which was right when
 *     it stood on the scene's hillside; on the room's own hill band, whose top is -135,
 *     it floats twenty-three pixels clear. It comes down to -132.
 *
 * The bushes go on depths above the scene's 124 - they have to be in front of the join
 * to hide it - and everything else below it.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-reference-square-9.ts
 *          [--verify] [--out <swf>]
 *
 * Re-runnable: every step checks its own depth first.
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
const SCENE_DEPTH = 124;
const TREE_DEPTH = 122;

/**
 * The tiles to lay, each one a copy of whatever the room already has on `like`.
 *
 * Nothing here names a character. `like` is a depth the room authored, and the
 * character, scale and - unless `y` says otherwise - the line are read off it, so these
 * stay copies of the room's own ground however that ground is changed.
 */
const TILES = [
  // The strip between the two bands: the low band's tile again, sixteen pixels up.
  { what: "bridge", depth: 80, like: 83, x: -226, y: -32 },
  { what: "bridge", depth: 86, like: 83, x: -489, y: -32 },
  // Both bands, carried out past where the camera can reach.
  { what: "extend hill", depth: 74, like: 77, x: -661 },
  { what: "extend low", depth: 88, like: 83, x: -752 },
  { what: "extend bridge", depth: 90, like: 83, x: -752, y: -32 },
  /**
   * And the forest behind them.
   *
   * The ground tiles are drawn with ragged tops - grass strokes over transparency, meant
   * to be laid over something - so extending them alone still left the strip reading as
   * a hole: there was nothing behind to show through. The room's two parallax panels
   * stop at -73 and -76 for the same reason everything else did, and these carry them
   * out to the room's own left edge.
   */
  { what: "extend forest", depth: 70, like: 73, x: -1230 },
  { what: "extend treeline", depth: 72, like: 75, x: -765 },
];

/**
 * **The bushes are gone.** Two of the room's own ferns were stood over the join here to
 * hide it. They read as exactly what they were - single plants on open grass with
 * nothing else near them - and `-10` removed the need for them by levelling the two
 * grasses instead, so `-11` pulled them. Nothing is planted from this file any more.
 */

/** The left-hand tree, seated on the room's hill band instead of the scene's hillside. */
const LEFT_TREE = { WIDTH: 325, CENTRE: -177, BASE_Y: -132 };

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

  const model = (depth: number): ReturnType<typeof parsePlace> => {
    const found = placements.find((place) => place.depth === depth);
    if (!found || found.charId === null || found.matrix === null) {
      throw new SwfLevelError(`${HOST_ROOM} has nothing on depth ${depth} to copy`);
    }
    return found;
  };

  const additions: SwfTag[] = [];
  const laid: string[] = [];
  for (const tile of TILES) {
    if (placements.some((place) => place.depth === tile.depth)) continue;
    const from = model(tile.like);
    const matrix = from.matrix as NonNullable<typeof from.matrix>;
    additions.push(
      buildPlaceObject2({
        depth: tile.depth,
        charId: from.charId as number,
        x: tile.x,
        y: "y" in tile && tile.y !== undefined ? tile.y : matrix.translateY / 20,
        scaleX: matrix.scaleX,
        scaleY: matrix.scaleY,
      }),
    );
    laid.push(tile.what);
  }

  // ---- the tree, back down onto the grass ------------------------------------
  const scene = placements.find((place) => place.depth === SCENE_DEPTH);
  const shift = scene && scene.matrix ? scene.matrix.translateX / 20 : 0;
  let treeSeated = true;
  const rebuilt = spriteInnerTags(swf.tags[roomIndex]).map((tag) => {
    if (!isPlace(tag)) return tag;
    const place = parsePlace(tag);
    if (place.depth !== TREE_DEPTH || place.charId === null || place.matrix === null) return tag;
    const bounds = characterBounds(swf, place.charId);
    if (!bounds) throw new SwfLevelError("the wrapped tree has no bounds");
    const art = { left: bounds.xMin / 20, right: bounds.xMax / 20, bottom: bounds.yMax / 20 };
    const scale = LEFT_TREE.WIDTH / (art.right - art.left);
    const y = LEFT_TREE.BASE_Y - scale * art.bottom;
    if (Math.abs(place.matrix.translateY / 20 - y) < 1) return tag;
    treeSeated = false;
    return buildPlaceObject2({
      depth: TREE_DEPTH,
      charId: place.charId,
      x: LEFT_TREE.CENTRE + shift + (scale * (art.left + art.right)) / 2,
      y,
      scaleX: -scale,
      scaleY: scale,
    });
  });

  console.log(
    `laid: ${laid.length ? laid.join(", ") : "nothing"}   left-hand tree: ${treeSeated ? "already on the grass" : "seated on the hill band"}`,
  );
  if (laid.length === 0 && treeSeated) {
    console.log("the square already matches the reference.");
    return;
  }
  if (verify) {
    console.log("verify only - no file written.");
    return;
  }

  const showFrame = rebuilt.findIndex((tag) => tag.code === TAG_SHOW_FRAME);
  rebuilt.splice(showFrame === -1 ? rebuilt.length - 1 : showFrame, 0, ...additions);
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
