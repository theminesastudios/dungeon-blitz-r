/**
 * Gives Wolf's End its name plate back.
 *
 * **A room may show exactly one door name plate.** `Level`'s room walk keeps a single
 * door variable and positions its plate once, after the walk - read off the P-code:
 *
 *     if (door) {                              // one variable, not a list
 *         if (hasMarker) { door.var_2280 = markerX; door.var_2285 = markerY; }
 *         else {
 *             class_24.method_19(room + ": missing marker for Door_" + door.doorID);
 *             door.var_2280 = door.posX - 220;
 *             door.var_2285 = door.posY - door.var_443.height - 150;
 *         }
 *     } else if (hasMarker) {
 *         class_24.method_19("Room has a marker, but no door: " + room);
 *     }
 *
 * `Entity.method_579` then draws the plate at `(var_2280, var_2285)`, and every door
 * the walk did *not* keep is left on `(0, 0)` - the room's own origin, which is off at
 * the far left of the square. The room walk reads `getChildAt(i)`, so the door it
 * keeps is the last one in **depth** order.
 *
 * The engine assumes one door per room and every other room in the level has exactly
 * that. `a_Room_SRN04` has had two since the Hallow's Eve rift went in on depth 231,
 * behind the road out to Wolf's End on depth 211 - so the rift took the plate and
 * "Travel to Wolf's End" was being built on every approach and drawn fifteen hundred
 * pixels away. Nothing about the text was ever wrong: the server answers that door
 * `STATIC / NewbieRoad` and `NewbieRoad`'s display name in Game.swz is `Wolf's End`.
 *
 * ## What this does
 *
 *   - **Moves `a_Door_2` to the back of the depth order** (`PLATE_DOOR_DEPTH`), which
 *     hands it the plate. Door children are editor markers drawn with
 *     `visible = DEVFLAG_SHOWCUES`, i.e. never, so depth costs them nothing.
 *   - **Drops the marker the square's own patch added** beside the rift. A marker is
 *     per room too, and the last one wins, so with both in place the plate would land
 *     on the rift's point even now. The room's original marker stays, which is what
 *     puts the plate exactly where the level's author drew it.
 *
 * The rift's own plate has to go, and that is the trade this makes: one room, one
 * plate. It is suppressed properly rather than left at (0,0) - `LevelHandler`
 * answers `DOORSTATE_CLOSED` for `HALLOWS_EVE_DOOR_ID`, which stops the client
 * building a plate at all and, per Legends' Inn, does not stop the door being used.
 * The arch keeps the Hollow Watcher standing beside it and the prompt that names the
 * dungeon. Set `PLATE_DOOR` to 108 here (and drop that branch in `LevelHandler`) to
 * trade the other way.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-door-plates.ts [--verify]
 *
 * Re-runnable: it checks the depth order and the marker count first.
 */
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
  SwfTag,
  ensureBackup,
  encodeMatrix,
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
const MARKER_CLASS = "a_DoorMarker";

/** The door that keeps the room's one plate. 2 is the road out to Wolf's End. */
const PLATE_DOOR = 2;

/** Where it is moved to: past every other door child, and clear of the dressing's depths. */
const PLATE_DOOR_DEPTH = 245;

/**
 * The marker that stays, by the point it sits on.
 *
 * The room shipped one, drawn by the level's author to hang the plate above the road
 * out. The square's patch added a second beside the rift; that one goes.
 */
const KEPT_MARKER = { x: 1458.55, y: -355.7 };

function spriteIndexFor(swf: SwfFile, charId: number): number {
  const index = swf.tags.findIndex((tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === charId);
  if (index === -1) throw new SwfLevelError(`character ${charId} is not a sprite`);
  return index;
}

/** Rewrites a placement's depth, leaving its character and matrix alone. */
function redepth(tag: SwfTag, depth: number): SwfTag {
  const place = parsePlace(tag);
  if (!place.matrix || place.charId === null) throw new SwfLevelError("placement carries no matrix");
  const head = Buffer.alloc(5);
  head.writeUInt8(0x02 | 0x04, 0);
  head.writeUInt16LE(depth, 1);
  head.writeUInt16LE(place.charId, 3);
  return { code: TAG_PLACE_OBJECT2, data: Buffer.concat([head, encodeMatrix(place.matrix)]) };
}

function main(): void {
  const verify = process.argv.includes("--verify");
  const swf = readSwfFile(SRN_SWF);
  const symbols = readSymbolClasses(swf);
  const idByName = new Map(symbols.map((entry) => [entry.name, entry.id]));
  const nameById = new Map(symbols.map((entry) => [entry.id, entry.name]));

  const roomId = idByName.get(HOST_ROOM);
  const markerId = idByName.get(MARKER_CLASS);
  const plateDoorId = idByName.get(`a_Door_${PLATE_DOOR}`);
  if (roomId === undefined || markerId === undefined || plateDoorId === undefined) {
    throw new SwfLevelError(`LevelsSRN.swf is missing ${HOST_ROOM}, ${MARKER_CLASS} or a_Door_${PLATE_DOOR}`);
  }

  const roomIndex = spriteIndexFor(swf, roomId);
  const inner = spriteInnerTags(swf.tags[roomIndex]);
  const placements = inner
    .filter((tag) => tag.code === TAG_PLACE_OBJECT2 || tag.code === TAG_PLACE_OBJECT3)
    .map((tag) => parsePlace(tag));

  const doors = placements.filter((place) => /^a_Door_\d+$/.test(nameById.get(place.charId as number) ?? ''));
  const markers = placements.filter((place) => place.charId === markerId);
  const plateDoor = doors.find((place) => place.charId === plateDoorId);
  if (!plateDoor) throw new SwfLevelError(`${HOST_ROOM} does not place a_Door_${PLATE_DOOR}`);

  const deepest = Math.max(...doors.map((place) => place.depth));
  const alreadyLast = plateDoor.depth === deepest;
  const strayMarkers = markers.filter(
    (place) =>
      Math.abs(place.matrix!.translateX / 20 - KEPT_MARKER.x) > 0.5 ||
      Math.abs(place.matrix!.translateY / 20 - KEPT_MARKER.y) > 0.5,
  );

  for (const door of doors) {
    console.log(`  ${nameById.get(door.charId as number)} on depth ${door.depth}`);
  }
  for (const marker of markers) {
    const point = `(${marker.matrix!.translateX / 20}, ${marker.matrix!.translateY / 20})`;
    console.log(`  marker on depth ${marker.depth} at ${point}${strayMarkers.includes(marker) ? ' - removing' : ' - keeping'}`);
  }

  if (alreadyLast && strayMarkers.length === 0) {
    console.log(`a_Door_${PLATE_DOOR} already holds the room's plate.`);
    return;
  }
  console.log(
    `a_Door_${PLATE_DOOR}: depth ${plateDoor.depth} -> ${PLATE_DOOR_DEPTH}; ` +
      `${strayMarkers.length} stray marker(s) dropped`,
  );
  if (verify) {
    console.log('verify only - no file written.');
    return;
  }

  const strayDepths = new Set(strayMarkers.map((place) => place.depth));
  const rebuilt: SwfTag[] = [];
  for (const tag of inner) {
    if (tag.code !== TAG_PLACE_OBJECT2 && tag.code !== TAG_PLACE_OBJECT3) {
      rebuilt.push(tag);
      continue;
    }
    const place = parsePlace(tag);
    if (place.charId === markerId && strayDepths.has(place.depth)) continue;
    rebuilt.push(place.charId === plateDoorId ? redepth(tag, PLATE_DOOR_DEPTH) : tag);
  }
  swf.tags[roomIndex] = rebuildSprite(swf.tags[roomIndex], rebuilt);

  ensureBackup(SRN_SWF);
  writeSwfFile(SRN_SWF, swf);
  console.log(`wrote ${SRN_SWF}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
