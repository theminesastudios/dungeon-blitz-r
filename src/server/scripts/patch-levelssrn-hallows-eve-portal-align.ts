/**
 * Re-seats the Hallow's Eve rift on the point `portalLayout()` gives it today.
 *
 * `patch-levelssrn-hallows-eve.ts` is a build step, not an edit: it refuses to run
 * over a file it has already patched, because a second pass would re-import the
 * whole seasonal scene and orphan every animated prop. That is fine for everything
 * it decides once - but *where the rift hangs* is a number that gets looked at on
 * screen and corrected, and rebuilding the square from `LevelsSRN.swf.bak` to move
 * one placement 63 pixels is a heavy way to do it.
 *
 * So this script moves the one placement. It reads the target out of
 * `portalLayout()` - the same function the build step places from - so running it is
 * always equivalent to a rebuild, and running it twice does nothing the second time.
 *
 * The three wisps drift *inside* the rift's glow, so they are carried by exactly the
 * same delta rather than left standing where the rift used to be.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-portal-align.ts [--verify]
 *
 * Re-runnable: it moves by the difference, so a file already on target is untouched.
 */
import * as path from "path";
import {
  SwfLevelError,
  ensureBackup,
  characterBounds,
  movePlacement,
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
import { HALLOWS_EVE_DOOR_ID, portalLayout } from "./patch-levelssrn-hallows-eve";

const SRN_SWF = path.resolve(
  __dirname,
  "..",
  "..",
  "client",
  "content",
  "localhost",
  "p",
  "cbp",
  "LevelsSRN.swf",
);

const HOST_ROOM = "a_Room_SRN04";
const DOOR_CLASS = `a_Door_${HALLOWS_EVE_DOOR_ID}`;

/** Anything smaller than this is rounding, not a move. */
const EPSILON = 0.05;

function main(): void {
  const verify = process.argv.includes("--verify");
  const srn = readSwfFile(SRN_SWF);
  const symbols = readSymbolClasses(srn);

  const door = symbols.find((entry) => entry.name === DOOR_CLASS);
  if (!door) {
    throw new SwfLevelError(
      `${path.basename(SRN_SWF)} does not carry the Hallow's Eve square yet (${DOOR_CLASS} is unbound); ` +
        `run patch-levelssrn-hallows-eve.ts first`,
    );
  }
  const room = symbols.find((entry) => entry.name === HOST_ROOM);
  if (!room) throw new SwfLevelError(`LevelsSRN.swf has no ${HOST_ROOM} symbol`);

  const roomIndex = srn.tags.findIndex(
    (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === room.id,
  );
  if (roomIndex === -1) throw new SwfLevelError(`${HOST_ROOM} sprite ${room.id} not found`);
  const inner = spriteInnerTags(srn.tags[roomIndex]);

  const places = inner
    .map((tag, index) => ({ tag, index, place: tag.code === TAG_PLACE_OBJECT2 || tag.code === TAG_PLACE_OBJECT3 ? parsePlace(tag) : null }))
    .filter((entry) => entry.place !== null && entry.place.charId !== null);

  /**
   * The rift is the placement one depth below the door's own rectangle.
   *
   * `placePortal` writes the three of them - rift, door, plate - onto consecutive
   * depths in that order, and the door is the only one of the three bound to a
   * class, so it is the anchor the other two are found from.
   */
  const doorPlace = places.find((entry) => entry.place!.charId === door.id);
  if (!doorPlace) throw new SwfLevelError(`${HOST_ROOM} does not place ${DOOR_CLASS} (character ${door.id})`);
  const portal = places.find((entry) => entry.place!.depth === doorPlace.place!.depth - 1);
  if (!portal) throw new SwfLevelError(`${HOST_ROOM} has nothing on depth ${doorPlace.place!.depth - 1} to be the rift`);

  // A cheap sanity check that what was found really is the rift: character 415's
  // artwork is 418.4px wide about its own origin, and it is placed scaled.
  const bounds = characterBounds(srn, portal.place!.charId as number);
  const width = bounds ? (bounds.xMax - bounds.xMin) / 20 : 0;
  if (Math.abs(width - 418.4) > 1) {
    throw new SwfLevelError(
      `depth ${portal.place!.depth} holds character ${portal.place!.charId}, which is ${width.toFixed(1)}px wide - ` +
        `that is not a_EvilPortalAnimation (418.4px)`,
    );
  }

  const target = portalLayout().portal.x;
  const current = (portal.place!.matrix?.translateX ?? 0) / 20;
  const dx = target - current;
  console.log(`rift is at room-local x ${current.toFixed(2)}, wants ${target.toFixed(2)} (${dx >= 0 ? "+" : ""}${dx.toFixed(2)})`);
  if (Math.abs(dx) < EPSILON) {
    console.log("already on target - nothing to do.");
    return;
  }

  /**
   * The motes, which move with it.
   *
   * All three are placed straight into the room off one character - the only
   * character in the room placed exactly three times - and they are the last three
   * placements the build step writes.
   */
  const byChar = new Map<number, typeof places>();
  for (const entry of places) {
    const list = byChar.get(entry.place!.charId as number) ?? [];
    list.push(entry);
    byChar.set(entry.place!.charId as number, list);
  }
  const wisps = (byChar.get(places[places.length - 1].place!.charId as number) ?? []).filter(
    (entry) => entry.place!.depth > doorPlace.place!.depth,
  );
  if (wisps.length !== 3) {
    throw new SwfLevelError(`expected 3 wisp placements above depth ${doorPlace.place!.depth}, found ${wisps.length}`);
  }

  if (verify) {
    console.log(
      `verify only - would move the rift and ${wisps.length} wisps by ${dx.toFixed(2)}px ` +
        `(wisps at ${wisps.map((entry) => ((entry.place!.matrix?.translateX ?? 0) / 20).toFixed(0)).join(", ")})`,
    );
    return;
  }

  const moved = new Map<number, number>([[portal.index, dx]]);
  for (const wisp of wisps) moved.set(wisp.index, dx);
  const rebuilt = inner.map((tag, index) => (moved.has(index) ? movePlacement(tag, moved.get(index) as number, 0) : tag));
  srn.tags[roomIndex] = rebuildSprite(srn.tags[roomIndex], rebuilt);

  ensureBackup(SRN_SWF);
  writeSwfFile(SRN_SWF, srn);
  console.log(
    `moved the rift to room-local ${target.toFixed(2)} and its ${wisps.length} wisps with it; wrote ${SRN_SWF}`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
