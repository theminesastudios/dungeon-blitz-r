/**
 * Places the Legends' Inn entrance portal in Craft Town.
 *
 * a_Level_Home has no map door of its own (only the tutorial variant does), so
 * the portal is assembled from three children of a_Room_GuildHall:
 *   - a visible copy of a_Animation_Portal (copied out of LevelsBT.swf),
 *   - an invisible a_Door_101 marker that carries the door itself,
 *   - the existing a_DoorMarker, which draws the floating "Legends' Inn" plate.
 *
 * The split is not optional. Level.as renders a room child as scenery only when
 * its class name starts with "a_Animation" (class_123.const_718); an "a_Door_"
 * child is an editor marker that gets `visible = DEVFLAG_SHOWCUES`, i.e. hidden.
 * Shipped levels do the same thing - LevelsHome.swf's own a_Door_1 is an orange
 * "Door 1" placeholder and the archway next to it is separate art. The door copy
 * still has to be the portal artwork rather than an empty sprite, because the
 * Door's clickable rectangle comes from the marker clip's bounds.
 *
 * Both classes come from renaming exports LevelsHome.swf never places
 * (a_PlayerDevSpawn, a_Volume) in the ABC string pool.
 *
 * Level.as finds doors by walking a room's children and matching the child's
 * class name against "a_Door_", so the door only needs the right class binding;
 * where it leads comes from the CraftTown/101 DoorType in Game.swz.
 *
 * Usage: npm exec ts-node scripts/patch-levelshome-legends-inn-portal.ts [--verify]
 */
import * as path from "path";
import {
  SwfLevelError,
  buildPlaceObject2,
  ensureBackup,
  encodeTag,
  importCharacters,
  parsePlace,
  readSwfFile,
  readSymbolClasses,
  rebuildSprite,
  renameAbcStrings,
  spriteInnerTags,
  writeSwfFile,
  writeSymbolClasses,
  TAG_DEFINE_SPRITE,
  TAG_PLACE_OBJECT2,
  TAG_PLACE_OBJECT3,
} from "./swfLevelUtils";

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p");
const HOME_SWF = path.join(CLIENT_CONTENT, "cbp", "LevelsHome.swf");
const BT_SWF = path.join(CLIENT_CONTENT, "cam", "LevelsBT.swf");

const HOST_ROOM = "a_Room_GuildHall";
/** a_Room_GuildHall sits at this level-space offset inside a_Level_Home. */
const HOST_ROOM_ORIGIN = { x: -3260, y: 540 };

const DOOR_CLASS = "a_Door_101";
const MARKER_CLASS = "a_DoorMarker";
/** Must start with "a_Animation" or Level.as will not draw it. */
const ART_CLASS = "a_Animation_LegendsInnPortal";
/** Exported in LevelsHome.swf but never placed, so the names are free to reuse. */
const DOOR_DONOR_CLASS = "a_PlayerDevSpawn";
const ART_DONOR_CLASS = "a_Volume";

/**
 * Where the middle of the drawn portal lands, in a_Level_Home world pixels.
 * This is the fixed part of the layout and everything else follows it.
 *
 * x is the centre of the tree the portal hangs on. Two trunks overlap behind it
 * in a_Room_GuildHall - characters 2071 (172 wide, centred at room-local 2998.7)
 * and 2073 (152 wide, centred at 3029.5) - so the visible mass runs 2912.7..3105.5
 * and its middle is room-local 3009, i.e. world -251. y sits a little below the
 * trunks' own middle (room-local 412) so the portal reads as hanging, not floating.
 */
const PORTAL_CENTRE_WORLD = { x: -251, y: 1002 };

/** How large the portal is drawn. The door marker is scaled to match so the
 * clickable rectangle keeps covering the artwork. */
const PORTAL_SCALE = 0.75;

/**
 * a_Animation_Portal's artwork relative to its origin, from the sprite bounds:
 * x -132.35..171.94, y -211.55..71.45. Scaled to how the portal is drawn.
 */
const PORTAL_ART = {
  centreX: 19.8 * PORTAL_SCALE,
  centreY: -70.05 * PORTAL_SCALE,
  top: -211.55 * PORTAL_SCALE,
};

const PORTAL_WORLD = {
  x: PORTAL_CENTRE_WORLD.x - PORTAL_ART.centreX,
  y: PORTAL_CENTRE_WORLD.y - PORTAL_ART.centreY,
};

/**
 * The plate is not drawn on the a_DoorMarker point: it renders down-right of it,
 * measured in game against a marker at a known world position. (Level.as's
 * marker-less fallback anchors at posX - 220, which is the same idea.)
 */
const PLATE_RENDER_OFFSET = { x: 157, y: -53 };
/** Half the plate's drawn height, so gaps are measured from its lower edge. */
const PLATE_HALF_HEIGHT = 47;
/**
 * Clearance between the bottom of the plate and the top of the portal. The
 * artwork's top edge is the faint outer swirl rather than the solid glow, so a
 * tight gap still reads as the plate sitting on the effect.
 */
const PLATE_GAP_ABOVE_ART = 60;

/** Centred over the portal, clearing its top - so moving the portal moves the plate. */
const PLATE_ANCHOR_WORLD = {
  x: PORTAL_CENTRE_WORLD.x - PLATE_RENDER_OFFSET.x,
  y: PORTAL_WORLD.y + PORTAL_ART.top - PLATE_GAP_ABOVE_ART - PLATE_HALF_HEIGHT - PLATE_RENDER_OFFSET.y,
};

function parseArgs(argv: string[]): { verify: boolean; out: string } {
  let verify = false;
  let out = HOME_SWF;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verify" || arg === "--dry-run") verify = true;
    else if (arg === "--out") out = path.resolve(argv[++index] || "");
    else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm exec ts-node scripts/patch-levelshome-legends-inn-portal.ts [--verify] [--out <path>]");
      process.exit(0);
    } else throw new SwfLevelError(`Unknown argument: ${arg}`);
  }
  return { verify, out };
}

function nextFreeDepth(spriteTag: { code: number; data: Buffer }): number {
  let max = 0;
  for (const inner of spriteInnerTags(spriteTag)) {
    if (inner.code !== TAG_PLACE_OBJECT2 && inner.code !== TAG_PLACE_OBJECT3) continue;
    const place = parsePlace(inner);
    if (place.depth > max) max = place.depth;
  }
  return max + 1;
}

function main(): void {
  const { verify, out } = parseArgs(process.argv);

  const home = readSwfFile(HOME_SWF);
  const bt = readSwfFile(BT_SWF);

  const homeSymbols = readSymbolClasses(home);
  if (homeSymbols.some((entry) => entry.name === DOOR_CLASS)) {
    // A door that is already there means the portal was placed in an earlier build. In apply mode
    // that is a double-apply and must stop; in verify mode it is the state this patch produces, so
    // re-applying is impossible and the check should report success.
    if (verify) {
      console.log(`verify only - ${DOOR_CLASS} already present; Legends' Inn portal already applied.`);
      return;
    }
    throw new SwfLevelError(`${DOOR_CLASS} already exists in LevelsHome.swf - patch already applied?`);
  }

  const btSymbols = readSymbolClasses(bt);
  const portalSource = btSymbols.find((entry) => entry.name === "a_Animation_Portal");
  if (!portalSource) throw new SwfLevelError("LevelsBT.swf has no a_Animation_Portal symbol");

  const roomBinding = homeSymbols.find((entry) => entry.name === HOST_ROOM);
  if (!roomBinding) throw new SwfLevelError(`LevelsHome.swf has no ${HOST_ROOM} symbol`);
  // The tutorial level already ships a door plate; reuse that character.
  const markerBinding = homeSymbols.find((entry) => entry.name === MARKER_CLASS);
  if (!markerBinding) throw new SwfLevelError(`LevelsHome.swf has no ${MARKER_CLASS} symbol`);
  const markerId = markerBinding.id;

  // Two independent copies: one class can only be bound to one character, and the
  // drawn portal and the door marker have to be different classes.
  const artId = importCharacters(bt, home, [portalSource.id]).idMap.get(portalSource.id) as number;
  const doorId = importCharacters(bt, home, [portalSource.id]).idMap.get(portalSource.id) as number;

  renameAbcStrings(
    home,
    new Map([
      [DOOR_DONOR_CLASS, DOOR_CLASS],
      [ART_DONOR_CLASS, ART_CLASS],
    ]),
  );

  const rebound = homeSymbols
    .filter((entry) => entry.name !== DOOR_DONOR_CLASS && entry.name !== ART_DONOR_CLASS)
    .concat([
      { id: artId, name: ART_CLASS },
      { id: doorId, name: DOOR_CLASS },
    ]);
  writeSymbolClasses(home, rebound);

  const roomIndex = home.tags.findIndex(
    (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === roomBinding.id,
  );
  if (roomIndex === -1) throw new SwfLevelError(`${HOST_ROOM} sprite ${roomBinding.id} not found`);

  const roomTag = home.tags[roomIndex];
  const depth = nextFreeDepth(roomTag);
  const portalLocal = {
    x: PORTAL_WORLD.x - HOST_ROOM_ORIGIN.x,
    y: PORTAL_WORLD.y - HOST_ROOM_ORIGIN.y,
  };
  const plateLocal = {
    x: PLATE_ANCHOR_WORLD.x - HOST_ROOM_ORIGIN.x,
    y: PLATE_ANCHOR_WORLD.y - HOST_ROOM_ORIGIN.y,
  };

  const inner = spriteInnerTags(roomTag);
  // Insert ahead of the sprite's ShowFrame so both land on frame 1.
  const showFrameIndex = inner.findIndex((tag) => tag.code === 1);
  const insertAt = showFrameIndex === -1 ? inner.length - 1 : showFrameIndex;
  inner.splice(
    insertAt,
    0,
    buildPlaceObject2({
      depth,
      charId: artId,
      x: portalLocal.x,
      y: portalLocal.y,
      scaleX: PORTAL_SCALE,
      scaleY: PORTAL_SCALE,
    }),
    buildPlaceObject2({
      depth: depth + 1,
      charId: doorId,
      x: portalLocal.x,
      y: portalLocal.y,
      scaleX: PORTAL_SCALE,
      scaleY: PORTAL_SCALE,
    }),
    buildPlaceObject2({ depth: depth + 2, charId: markerId, x: plateLocal.x, y: plateLocal.y }),
  );
  home.tags[roomIndex] = rebuildSprite(roomTag, inner);

  const size = home.tags.reduce((total, tag) => total + encodeTag(tag).length, 0);
  console.log(`portal character ${portalSource.id} -> art ${artId}, door ${doorId}`);
  console.log(`${ART_DONOR_CLASS} -> ${ART_CLASS}, ${DOOR_DONOR_CLASS} -> ${DOOR_CLASS}`);
  console.log(`reusing ${MARKER_CLASS} character ${markerId} for the name plate`);
  console.log(
    `placed in ${HOST_ROOM} at local: portal (${portalLocal.x.toFixed(2)}, ${portalLocal.y.toFixed(2)}), ` +
      `plate anchor (${plateLocal.x.toFixed(2)}, ${plateLocal.y.toFixed(2)}) depth ${depth}`,
  );
  console.log(`uncompressed tag payload: ${size} bytes`);

  if (verify) {
    console.log("verify only - LevelsHome.swf not written");
    return;
  }

  if (out === HOME_SWF) ensureBackup(HOME_SWF);
  writeSwfFile(out, home);
  console.log(`wrote ${out}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
