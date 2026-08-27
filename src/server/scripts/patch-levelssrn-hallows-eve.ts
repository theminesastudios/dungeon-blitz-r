/**
 * Clears Blackrose Mire's town square and hangs the Hallow's Eve portal in it.
 *
 * `a_Room_SRN04` - the room the market road runs through, placed at (2440, 660)
 * in `a_Level_SwampRoadNorth` - carries four skull-faced stone pedestals named
 * `am_StatueFirst` .. `am_StatueFourth`. They are not decoration: `Level.method_663`
 * paints a player body onto each one out of `class_6.var_1148`, which is why the
 * square shows four grey figures standing on the wall. The method is gated on
 * `levelSymbolName == "a_Level_SwampRoadNorth"`, so this room is the only place
 * in the game that does it.
 *
 * This patch removes those four placements. That is the whole change to the SWF:
 *
 *   - **The pedestals go, the cues stay.** The four `ac_HalloweenStatues` cue
 *     markers in the same room are invisible, but `a_Room_SRN04`'s constructor
 *     calls a generated `__setProp___id<n>__a_Room_SRN04_cues_0()` for each of
 *     them, and each of those writes straight through a typed member
 *     (`this.__id1133_.characterName = ...`). Deleting a cue placement leaves
 *     that member null and the room throws on construction, taking the level with
 *     it. The cues spawn nothing on their own - what stood on the pedestals came
 *     from `npcs/SwampRoadNorth.json` - so leaving them in place costs nothing.
 *   - **Removing the pedestals is safe on the paint side.** `method_663` reads
 *     each one as `_loc2_["am_StatueFirst"] as Sprite` and guards the result with
 *     `if(_loc8_)` before it adds a child, so a missing pedestal is simply skipped.
 *
 * The matching server-side removal is the four `HalloweenStatues` entries in
 * `data/npcs/SwampRoadNorth.json` and `SwampRoadNorthHard.json`; without those the
 * square has no statue entities left to click.
 *
 * ## What goes in their place
 *
 * The cleared wall is where the Hallow's Eve rift hangs, assembled the same way
 * Craft Town's Legends' Inn portal is - three children of the room rather than one:
 *
 *   - `a_EvilPortalAnimation`, the event's *own* white-green rift out of
 *     `UI_Seasonal.swf` - the artwork the square was originally built around;
 *   - an invisible `a_Door_108` marker carrying the door itself;
 *   - an `a_DoorMarker`, which is what draws the floating name plate.
 *
 * The split is not optional. An `a_Door_` child is an editor marker and is given
 * `visible = DEVFLAG_SHOWCUES`, i.e. hidden, so it cannot also be the artwork. The
 * door still needs a character with real bounds, because a Door's clickable
 * rectangle comes from the marker clip - so it is a copy of `a_Door_2`'s own
 * 200x400 rectangle, the shape the room's existing door already uses.
 *
 * Around it goes the square as it was actually designed. `UI_Seasonal.swf` carries
 * the finished scene as a single orphan character - the mossy stone tower with the
 * skulls, the carved wall, four green skull lanterns, the green fire on its pole,
 * the bare tree and the iron fencing - and it is the same artwork the event's own
 * announcement panel shows a slice of. It is imported whole and laid into the
 * cleared strip, minus its two flat backdrop rectangles (see `backdropSky`). The
 * only things added on top are the jack-o'-lanterns and cobwebs the original square
 * also carried. Nothing here is drawn: every piece is shipped artwork. See `PROPS`.
 *
 * `a_Door_108` is a rename of `a_Animation_Smoke1`: a MovieClip subclass that
 * LevelsSRN.swf exports, never places, and which nothing in the client, the
 * EntTypes or the level's own scripts refers to by name. A donor has to be a
 * MovieClip and not a cue - renaming one of the unused `ac_Halloween*` classes
 * would leave the door a subclass of `a_Cue`, and `Level` would then try to build
 * a cue out of it and log a missing-characterName error every load.
 *
 * Where it leads is not in the SWF: `Level` matches a child's class name against
 * `a_Door_` and takes the id from it, and the destination comes from the
 * SwampRoadNorth/108 DoorType in Game.swz plus door_map.json on the server.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve.ts [--verify]
 *
 * Re-runnable: each half checks for its own result and skips if it is already there.
 */
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
  appendCharacterTag,
  buildPlaceObject2,
  buildSolidRectShape,
  buildSprite,
  ensureBackup,
  encodeTag,
  importCharacters,
  maxCharacterId,
  parsePlace,
  readSwfFile,
  readSymbolClasses,
  rebuildSprite,
  repointPlacement,
  renameAbcStrings,
  spriteInnerTags,
  writeSwfFile,
  writeSymbolClasses,
  TAG_DEFINE_SPRITE,
  TAG_PLACE_OBJECT2,
  TAG_PLACE_OBJECT3,
} from "./swfLevelUtils";

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p");
const SRN_SWF = path.join(CLIENT_CONTENT, "cbp", "LevelsSRN.swf");

/** The room the town square is drawn in. */
const HOST_ROOM = "a_Room_SRN04";

/** The level `a_Room_SRN04` is placed in. */
const LEVEL_CLASS = "a_Level_SwampRoadNorth";

/** `a_Room_SRN04`'s placement inside `a_Level_SwampRoadNorth`. */
const HOST_ROOM_ORIGIN = { x: 2440, y: 660 };

/**
 * The pedestal instances, by the names `Level.method_663` looks them up under.
 * Nothing else in the level references them.
 */
const STATUE_INSTANCES = ["am_StatueFirst", "am_StatueSecond", "am_StatueThird", "am_StatueFourth"];

/** The door id the square's new portal answers to. SwampRoadNorth uses 1, 2 and 101..107. */
export const HALLOWS_EVE_DOOR_ID = 108;

const DOOR_CLASS = `a_Door_${HALLOWS_EVE_DOOR_ID}`;
/** Exported by LevelsSRN.swf, never placed, referenced by nothing. See the file comment. */
const DOOR_DONOR_CLASS = "a_Animation_Smoke1";
/** The room's own door, whose 200x400 rectangle the new door borrows. */
const DOOR_SHAPE_CLASS = "a_Door_2";
const MARKER_CLASS = "a_DoorMarker";

/**
 * The walkable floor the square's props stand on, in `a_Level_SwampRoadNorth`
 * world pixels.
 *
 * Read off `am_CollisionObject`: its cyan path runs flat at shape-local y=0 for
 * the whole left half of the room, and the collision object is placed at room-local
 * (-80, -80), which puts the line at room-local y=-80 and world y=580. The
 * authored entities in the room agree - the four statues were stored at y=579 and
 * NPCIeld at 584, both within the +-20 the game itself uses.
 */
const FLOOR_WORLD_Y = 580;

/**
 * The stone tower's own geometry, in the seasonal scene's coordinates.
 *
 * Measured off a 1:1 PNG export of character 39 - the single DefineShape that
 * carries both ruins, the hill and the iron fencing. That shape's bounds start at
 * (-41.1, 7), so a pixel in the export maps to scene x - 41.1, y + 7.
 *
 *   - `centreX` 177: the tower body runs 150..287 in export pixels.
 *   - `groundY` 252: the stone pad at its foot, 13px above the scene's own bottom
 *     edge, which is the crown of the hill it stands on.
 *
 * The rift hangs here rather than out on the open grass: the arch is the way in,
 * and the Hollow Watcher who used to stand in front of it is gone.
 */
const TOWER_IN_SCENE = { centreX: 177, groundY: 252 };

/**
 * The plate is not drawn on the `a_DoorMarker` point: it renders down-right of it.
 * These three numbers are the ones the Craft Town portal was measured against.
 * `placePortal` turns them into a point once it knows how tall the rift is drawn.
 */
const PLATE_RENDER_OFFSET = { x: 157, y: -53 };
const PLATE_HALF_HEIGHT = 47;
const PLATE_GAP_ABOVE_ART = 60;

// ---------------------------------------------------------------------------
// The decorations
// ---------------------------------------------------------------------------

/**
 * The dressing is deliberately bound to no class at all.
 *
 * `Level`'s room walk (around Level.as:4133) does this to every child whose class
 * name starts with `a_Animation`:
 *
 *     sceneryObj = var_77.method_625(child, ..., isForeground, isBackground);
 *     param2.var_1530.push(sceneryObj);
 *     child.visible = false;
 *
 * i.e. it lifts the child out into the level's scenery system and hides the
 * original where it stood. That system decides its own layering from the
 * `am_Foreground` / `am_Background` flags, so a bound child does *not* keep the
 * depth it was placed on - which is exactly what went wrong on the first pass: the
 * graveyard was placed behind the fence on depth 124 and came out in front of it.
 *
 * A child with no SymbolClass entry is left alone and drawn by Flash at its
 * placement depth, which is how every piece of the room's own artwork works
 * (characters 8, 10, 12 and the rest are all unbound) and is the only way to say
 * where something goes and be believed. Nested sprites still run their own
 * timelines, so the rift and the fire animate either way.
 */

/** Where the props come from. Both are globally loaded animation files. */
const ENVIRONMENTALS_SWF = path.join(CLIENT_CONTENT, "cbp", "Animation_Environmentals.swf");
const PETS_SWF = path.join(CLIENT_CONTENT, "cbp", "Animation_Pets.swf");

/**
 * The depths the dressing is placed on.
 *
 * Both are above the room's highest art (129), so the graveyard and the fire stand
 * in front of the fence the way the original square's did, with the fire over the
 * graves. Entities are drawn in their own pass, so this does not put a tombstone in
 * front of a player.
 */
const DECOR_DEPTH = 234;

const DECOR_FRONT_DEPTH = 235;

/** The files the props are imported from. All are loaded separately at runtime. */
const SEASONAL_SWF = path.join(CLIENT_CONTENT, "cbo", "UI_Seasonal.swf");
const UI_LIBRARY_SWF = path.join(CLIENT_CONTENT, "caa", "UI_Library.swf");

/** The prop artwork, by the class each is exported under in its source file. */
const PROPS = {
  /**
   * The event's own portal, and its own green flame.
   *
   * `UI_Seasonal.swf` is where the Hallow's Eve effects live - `a_EvilPortalAnimation`
   * is the white-green rift the square was built around and `a_EvilTorchAnimation`
   * the green fire that burned beside it. Both are real animations (24 and 32
   * frames); a nested sprite runs its own timeline, so they loop inside a
   * one-frame composite without anything driving them.
   */
  portal: { swf: SEASONAL_SWF, className: "a_EvilPortalAnimation" },

  /**
   * **The square itself, as it was drawn.**
   *
   * Character 60 of `UI_Seasonal.swf` is the finished Hallow's Eve scene in one
   * piece: the mossy stone tower with the skulls on it, the carved wall beside it,
   * four green skull lanterns, the green fire on its pole, the bare tree, the iron
   * fencing and the night forest behind all of it. It is the same artwork the
   * event's own announcement panel (`a_ScreenHalloweenOverview`) shows a slice of.
   *
   * It is bound to no class and placed nowhere - an orphan character, exactly like
   * the Green Knight's arena was an orphan level. That is why it has to be reached
   * for by *id* rather than by name.
   *
   * Its own dark backdrop is also where the green cast in the original screenshots
   * comes from: there is no seasonal palette anywhere in the client, the square
   * simply had a night forest painted behind it.
   */
  ruins: { swf: SEASONAL_SWF, charId: 60 },

  /**
   * The scene's two backdrop rectangles, imported only so they can be taken back
   * out again.
   *
   * Character 28 is a flat purple night-sky gradient and 26 a dark green ground
   * slab, both 700-odd pixels wide with hard straight edges. Inside the
   * announcement panel that is fine - the panel has a frame around it. Dropped into
   * a level they read as exactly what they are: a rectangle of night pasted over a
   * daylit forest, with two visible seams. The ruins, the lanterns, the fire and the
   * bare tree carry the scene perfectly well without them, and against the room's
   * own trees they still read as a graveyard.
   *
   * `stripBackdrop` removes their placements from the imported copy of the scene.
   */
  backdropSky: { swf: SEASONAL_SWF, charId: 28 },
  backdropGround: { swf: SEASONAL_SWF, charId: 26 },

  pumpkin: { swf: PETS_SWF, className: "a_PumpkinHead" },
  pumpkinFace: { swf: PETS_SWF, className: "a_PumpkinFace" },

  /**
   * The besom, and the green fire that belongs on it.
   *
   * Character 50 of `UI_Seasonal.swf` is the broom itself - bound twigs on a
   * crooked handle - and it is the same orphan-by-id case as the scene: it exists
   * only as a child of character 60, bound to no class. The scene's own copy
   * carries an orange flame (character 59) turned green by a colour transform on
   * its placement; a second broom is simpler with `a_EvilTorchAnimation`, which is
   * the event's own green flame and already animates.
   */
  broom: { swf: SEASONAL_SWF, charId: 50 },
  greenFlame: { swf: SEASONAL_SWF, className: "a_EvilTorchAnimation" },

  /** The drifting green motes. `UI_Seasonal.swf`'s own, and already animated. */
  wisp: { swf: SEASONAL_SWF, className: "a_EvilTrailAnimation" },

  /**
   * The cobwebs.
   *
   * UI doodads rather than level art - `UI_Library.swf` keeps them for panel
   * dressing - but they are ordinary sprites and the square is what they were drawn
   * for. Importing them into LevelsSRN.swf makes them part of that file, so it does
   * not matter that the UI library is loaded separately at runtime.
   */
  web: { swf: UI_LIBRARY_SWF, className: "_DoodadWeb01" },
  webWide: { swf: UI_LIBRARY_SWF, className: "_DoodadWeb03" },
} as const;

type PropName = keyof typeof PROPS;

/**
 * The props the square did not carry before this pass.
 *
 * Only used by the `extras` bisect switch: leaving them out drops both their
 * placements and their import, so a level that will not load can be told apart
 * from a level that draws them wrong.
 */
const NEW_PROPS: PropName[] = ["broom", "greenFlame", "wisp"];

/**
 * The classes the animated props are bound to, and the donors they are taken from.
 *
 * A level animation only runs if `Level`'s room walk recognises its class name, and
 * the test is `getQualifiedClassName(child).indexOf("a_Animation") == 0`. The
 * seasonal artwork is exported under `a_Evil*` names, which fail it, so each one is
 * rebound to a class LevelsSRN.swf already exports and never places - the same
 * trick that turned `a_Animation_Smoke1` into `a_Door_108`.
 *
 * The donor characters are left in the file, unbound and unplaced; nothing reads
 * them. A class binds to exactly one character, but a character may be placed as
 * often as it likes, so one `a_Animation_Smoke2` covers all three green flames.
 */
const ANIMATION_BINDINGS: Array<{ donor: string; prop: PropName }> = [
  { donor: "a_Animation_Portal", prop: "portal" },
  { donor: "a_Animation_Smoke2", prop: "greenFlame" },
  { donor: "a_Animation_PortaAngled", prop: "wisp" },
];

/**
 * How each prop hangs off its own origin, so a layout entry can name a point and
 * mean the same thing every time.
 *
 * `base` - drawn up from a floor origin, so the point is where it stands.
 * `ground` - drawn down-right of its origin, so it is pulled back half its width
 *   and up its full height to rest on the point.
 * `centre` - drawn around its origin, so the point is its middle.
 * `hang` - drawn down-right of its origin, so the point is its top-left corner.
 */
type PropAnchor = "base" | "ground" | "centre" | "hang";

const PROP_ANCHORS: Record<PropName, { anchor: PropAnchor; width: number; height: number }> = {
  portal: { anchor: "base", width: 418.4, height: 384.7 },
  // Drawn down-right of its origin (x -44.6..751.5, y -5.8..265.1), so `hang`
  // anchors it by its own top-left corner and `RUINS_ART_OFFSET` does the rest.
  ruins: { anchor: "hang", width: 796.1, height: 270.9 },
  // Imported and immediately stripped out; never placed, so the anchor is unused.
  backdropSky: { anchor: "hang", width: 0, height: 0 },
  backdropGround: { anchor: "hang", width: 0, height: 0 },
  pumpkin: { anchor: "base", width: 102.2, height: 102.5 },
  pumpkinFace: { anchor: "base", width: 72.0, height: 63.7 },
  web: { anchor: "hang", width: 108.0, height: 214.0 },
  webWide: { anchor: "hang", width: 179.9, height: 203.6 },
  // Drawn up from its handle (y -351.9..-21.3), so the point is where it stands.
  broom: { anchor: "base", width: 70.8, height: 330.6 },
  // Both hang down-right of their origin, so the point is the top-left corner.
  // Drawn down-right of its origin (x -2.3..32.6, y 0.2..77.9), so `ground` pulls
  // it back onto the point it is standing on.
  greenFlame: { anchor: "ground", width: 34.8, height: 77.7 },
  // Already drawn around its own origin (x -55.9..58.5, y -100.9..15.8), so the
  // point is its middle with no offset of its own.
  wisp: { anchor: "hang", width: 114.4, height: 116.7 },
};

/**
 * How the scene is laid into the square.
 *
 * `scale` sizes the stone tower against the people standing in front of it: 1.9
 * puts it a little under three player heights (the room's `a_PlayerSpawn` is
 * 175px tall), which is how the event's own announcement panel draws it.
 *
 * The scene is anchored by its **right** edge rather than its left, because that
 * is the edge that matters. It has to finish just short of the mushroom house -
 * `a_Room_SRN04` draws the house on depth 11 and the dressing sits on 124, so
 * anything that overlaps the house is drawn *over* it - while the ruins themselves
 * want to be as close to the house as they will go. Anchoring the right edge means
 * scaling the scene up grows it leftwards, into the empty half of the square,
 * instead of pushing the ruins away from the house.
 */
const RUINS_SCALE = 1.9;

/** Its bounds relative to its origin, from character 60. */
const RUINS_ART_OFFSET = { left: -44.65, bottom: 265.05 };

/**
 * The slice of the scene that is kept, in the scene's own coordinates.
 *
 * Character 60 is 796px of artwork, and its right third is bare hillside: the two
 * ruins, the besom and the bare tree all live in the left 500px. Laid down whole
 * and enlarged, that bare third is what would run over the mushroom house.
 *
 * A DefineShape cannot be split, so the tail is masked off instead - see
 * `buildMaskedScene`. The cut lands at scene x 490, where the hill is already low
 * enough (scene y 222, i.e. room-local -162) that `am_Foreground_1`'s grass band -
 * which covers room-local x 895..1466 up to y -163 - hides all but a dozen pixels
 * of the edge. 510 is the flattest column in that stretch; the profile either side
 * of it rides up on the small iron fence the scene carries there.
 */
const RUINS_CROP = { left: RUINS_ART_OFFSET.left, right: 510 };

/**
 * Where the kept slice's right edge lands, in room-local x.
 *
 * The mushroom house's character starts at 1002 but its drawn trunk does not
 * begin until about 1090, so 1020 lands the cut in the house's own transparent
 * margin - as far right as the ruins will go - and inside `am_Foreground_1`'s
 * grass, which runs 895..1466.
 */
const RUINS_RIGHT_EDGE = 1020;

/**
 * The height of the flat slab on top of each ruin, in scene coordinates.
 *
 * Both walls are capped at the same course, so one number seats a lantern on
 * either of them. Read back off the laid-out room rather than off the art export:
 * the export has an iron fence standing on the same slab, and measuring to the top
 * of that puts anything resting here 60px in the air.
 */
const RUIN_LEDGE_SCENE_Y = 153.5;

/** Scene coordinates to room-local ones, once the scale and the anchor are known. */
function sceneToLocalX(sceneX: number): number {
  return RUINS_RIGHT_EDGE - (RUINS_CROP.right - sceneX) * RUINS_SCALE;
}

function sceneToLocalY(sceneY: number): number {
  return DECOR_FLOOR_Y - (RUINS_ART_OFFSET.bottom - sceneY) * RUINS_SCALE;
}

/**
 * The portal's artwork relative to its origin, from character 415's bounds
 * (x -80.8..337.6, y -27.7..357.0). It is the one prop placed on its own rather
 * than inside a composite, because it needs a depth of its own.
 */
const PORTAL_ART_OFFSET = { centreX: 128.4, top: -27.7, bottom: 357.0 };

/**
 * How large the rift is drawn.
 *
 * 0.7 makes it 293px wide against a 260px-wide tower, so it fills the arch and
 * spills a little either side of it rather than sitting politely inside.
 */
const PORTAL_SCALE = 0.7;

/**
 * Where the carved face sits on the pumpkin.
 *
 * The body runs y -102.5..0 and the face -63.7..0, both from a base origin, so an
 * offset of -22 lands the face across the pumpkin's upper middle - which is where
 * a lantern is carved - rather than centred on it.
 */
const PUMPKIN_FACE_OFFSET_Y = -22;

/** The floor, in room-local pixels. See `FLOOR_WORLD_Y`. */
const DECOR_FLOOR_Y = FLOOR_WORLD_Y - HOST_ROOM_ORIGIN.y;

interface DecorEntry {
  prop: PropName;
  x: number;
  /** Room-local y. Defaults to the floor line. */
  y?: number;
  scale?: number;
}

/**
 * The scene itself, on a depth of its own well below everything else.
 *
 * It has to sit behind the room's fence and grass so that its base is overlapped
 * rather than pasted on top of them, and behind the rift so the rift burns in front
 * of the ruins the way it did. 124 is the free slot between the room's mid-ground
 * (123) and its `am_Foreground_1` grass (125).
 */
const DECOR_SCENE_DEPTH = 124;

const DECOR_SCENE: DecorEntry[] = [
  {
    prop: "ruins",
    // The scene's own origin, once its right edge is pinned to `RUINS_RIGHT_EDGE`.
    x: sceneToLocalX(0),
    y: sceneToLocalY(0),
    scale: RUINS_SCALE,
  },
];

/**
 * The window the scene is shown through, in room-local pixels.
 *
 * Only the horizontal edges do any work; the vertical ones are pushed well clear
 * of the artwork so nothing is trimmed off the top of the tower.
 */
const RUINS_MASK = {
  left: sceneToLocalX(RUINS_CROP.left),
  right: sceneToLocalX(RUINS_CROP.right),
  top: -900,
  bottom: 120,
};

/**
 * Where the second ruin's ledge ends up, so the dressing can be hung off the
 * artwork rather than off numbers that stop meaning anything the moment the scale
 * moves.
 *
 * The **tower's** ledge is deliberately left bare: the rift is drawn 293px wide
 * over a 260px tower and on a lower depth than the dressing, so a lantern or a
 * torch standing there is drawn in front of the portal rather than beside it. The
 * tower's face belongs to the arch; what hangs above the tower hangs off the
 * branches instead.
 */
const LOWER_WALL_TOP = { x: sceneToLocalX(420), y: sceneToLocalY(RUIN_LEDGE_SCENE_Y) };

/**
 * The still dressing, in a composite of its own.
 *
 * No lanterns. Every jack-o'-lantern the square carried is gone: hung in the
 * branches they read as pumpkins floating in mid-air with nothing holding them up,
 * and the reward the square is built around is the ruin itself, not a prop sitting
 * on it.
 */
const DECOR_BACK: DecorEntry[] = [
  // The cobwebs need something to hang off. Above the fence the left half of the
  // square is open sky, so both go on the treeline: the mushroom house at
  // room-local 1002..1724 and the trunk on the far right past 1950.
  { prop: "webWide", x: 1010, y: -690, scale: 0.9 },
  { prop: "web", x: 1980, y: -700, scale: 1.1 },

  // A second besom stood against the house, the way the square carried one there.
  { prop: "broom", x: 1060, scale: 0.7 },
];

/**
 * Everything that moves, placed **straight into the room** rather than into a
 * composite.
 *
 * This is the whole reason the square stood still. `Level`'s room walk
 * (Level.as:4133) tests `getQualifiedClassName(child).indexOf("a_Animation")` and
 * only a child that passes is handed to `class_123.method_625`, the scenery
 * system - and that system is what drives a level animation's timeline. A child
 * bound to nothing is simply drawn, once, on the frame it happens to be showing.
 * The rift, the green fire and the wisps were all unbound, so all three froze.
 *
 * Two things follow, and both shape this list:
 *
 *   - **The class matters, not the artwork.** `bindAnimations` rebinds three
 *     `a_Animation_*` classes LevelsSRN.swf exports and never places onto the
 *     imported seasonal characters, exactly the way `a_Door_108` was made out of
 *     `a_Animation_Smoke1`.
 *   - **It has to be a child of the room.** The walk looks at the room's own
 *     children; anything buried inside an unbound composite is never offered to
 *     the scenery system. So these cannot ride in `DECOR_BACK`.
 *
 * The cost is layering: `method_625` takes the child's *concatenated matrix*, so
 * position and scale survive intact, but the depth is the scenery system's to
 * choose from the `am_Foreground` / `am_Background` flags on the instance name.
 * These carry no prefix, which is the middle layer - in front of the room's static
 * art, behind the foreground grass. That is where all of them want to be anyway.
 */
const DECOR_ANIMATED: DecorEntry[] = [
  // The besom's fire, seated in the bristles so it burns out of the top.
  { prop: "greenFlame", x: 1062, y: -300, scale: 1.2 },
  // Either end of the second ruin's ledge.
  { prop: "greenFlame", x: LOWER_WALL_TOP.x - 80, y: LOWER_WALL_TOP.y, scale: 1.3 },
  { prop: "greenFlame", x: LOWER_WALL_TOP.x + 70, y: LOWER_WALL_TOP.y, scale: 1.3 },
  // Drifting across the arch.
  { prop: "wisp", x: 300, y: -300, scale: 1.2 },
  { prop: "wisp", x: 500, y: -450, scale: 0.9 },
  { prop: "wisp", x: 640, y: -230, scale: 1.4 },
];

/**
 * The parts of the patch that can be left out, for bisecting a level that will
 * not load.
 *
 * A level SWF gives no useful error when the client throws on it - the whole
 * region simply fails to come up - so the only way to find which change did it is
 * to build the file without one part at a time. These are the three that add
 * something the room did not have before:
 *
 *   - `green`  - the Dread backdrop repoint in `a_Level_SwampRoadNorth`.
 *   - `mask`   - the clip-depth rectangle that crops the scene.
 *   - `extras`  - the props the square did not carry before: the second besom, the
 *                 green torches and the drifting wisps.
 *
 * And the patch's own steps, so a build that will not load can be bisected down to
 * the one that does it:
 *
 *   - `statues` - removing the four leaderboard pedestals.
 *   - `imports` - bringing the seasonal artwork across at all. Implies `portal`
 *                 and `decor`, which have nothing to place without it.
 *   - `portal`  - the rift, `a_Door_108` and the name plate.
 *   - `scene`   - the ruins composite on depth 124.
 *   - `decor`   - the two prop composites on depths 234 and 235.
 */
const OPTIONAL_PHASES = ["green", "mask", "extras", "statues", "imports", "portal", "scene", "decor"] as const;
type OptionalPhase = (typeof OPTIONAL_PHASES)[number];

interface Options {
  verify: boolean;
  out: string;
  without: Set<OptionalPhase>;
}

function parseArgs(argv: string[]): Options {
  let verify = false;
  let out = SRN_SWF;
  const without = new Set<OptionalPhase>();
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verify" || arg === "--dry-run") verify = true;
    else if (arg === "--out") out = path.resolve(argv[++index] || "");
    else if (arg === "--without") {
      for (const name of String(argv[++index] || "").split(",")) {
        const phase = name.trim() as OptionalPhase;
        if (!OPTIONAL_PHASES.includes(phase)) {
          throw new SwfLevelError(`Unknown phase '${name}'. Known: ${OPTIONAL_PHASES.join(", ")}`);
        }
        without.add(phase);
      }
    } else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve.ts [--verify] [--out <path>]\n" +
          `       [--without ${OPTIONAL_PHASES.join("|")}[,...]]`,
      );
      process.exit(0);
    } else throw new SwfLevelError(`Unknown argument: ${arg}`);
  }
  return { verify, out, without };
}

function roomSpriteIndex(srn: SwfFile): number {
  const roomBinding = readSymbolClasses(srn).find((entry) => entry.name === HOST_ROOM);
  if (!roomBinding) throw new SwfLevelError(`LevelsSRN.swf has no ${HOST_ROOM} symbol`);
  const index = srn.tags.findIndex(
    (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === roomBinding.id,
  );
  if (index === -1) throw new SwfLevelError(`${HOST_ROOM} sprite ${roomBinding.id} not found`);
  return index;
}

function nextFreeDepth(spriteTag: { code: number; data: Buffer }): number {
  let max = 0;
  for (const inner of spriteInnerTags(spriteTag as never)) {
    if (inner.code !== TAG_PLACE_OBJECT2 && inner.code !== TAG_PLACE_OBJECT3) continue;
    const place = parsePlace(inner);
    if (place.depth > max) max = place.depth;
  }
  return max + 1;
}

/**
 * Takes the four pedestals out of the square.
 *
 * Returns false when there is nothing left to remove, which is what a re-run of an
 * already-patched file looks like.
 */
function removeStatues(srn: SwfFile, verify: boolean): boolean {
  const roomIndex = roomSpriteIndex(srn);
  const roomTag = srn.tags[roomIndex];
  const inner = spriteInnerTags(roomTag);

  const removed: string[] = [];
  const kept = inner.filter((tag) => {
    if (tag.code !== TAG_PLACE_OBJECT2 && tag.code !== TAG_PLACE_OBJECT3) return true;
    const place = parsePlace(tag);
    if (!place.name || !STATUE_INSTANCES.includes(place.name)) return true;
    removed.push(`${place.name} (depth ${place.depth}, character ${place.charId})`);
    return false;
  });

  if (removed.length === 0) {
    console.log(`${HOST_ROOM} has no pedestal placements left; statues already removed.`);
    return false;
  }

  for (const name of STATUE_INSTANCES) {
    if (!removed.some((entry) => entry.startsWith(`${name} `))) {
      throw new SwfLevelError(`${HOST_ROOM} is missing ${name}; refusing a partial removal`);
    }
  }
  for (const entry of removed) console.log(`removed ${entry}`);
  if (verify) return true;

  srn.tags[roomIndex] = rebuildSprite(roomTag, kept);
  console.log(`rebuilt ${HOST_ROOM}: ${inner.length} -> ${kept.length} inner tags`);
  return true;
}

/**
 * Imports every prop into LevelsSRN.swf, once, and hands back their new ids.
 *
 * Grouped by source file so each dependency walk runs a single time, and looked up
 * by the class name each was exported under rather than by a hard-coded character
 * id - the source files are patched by other scripts and ids move.
 */
function importProps(srn: SwfFile, without: Set<OptionalPhase> = new Set()): Map<PropName, number> {
  const imported = new Map<PropName, number>();
  const bySwf = new Map<string, PropName[]>();
  for (const name of Object.keys(PROPS) as PropName[]) {
    // With `extras` left out the new characters are not even brought across, so
    // the bisect rules out a bad import as well as a bad placement.
    if (without.has("extras") && NEW_PROPS.includes(name)) continue;
    const list = bySwf.get(PROPS[name].swf) ?? [];
    list.push(name);
    bySwf.set(PROPS[name].swf, list);
  }

  for (const [swfPath, names] of bySwf) {
    const source = readSwfFile(swfPath);
    const sourceSymbols = readSymbolClasses(source);
    const rootByProp = new Map<PropName, number>();
    for (const name of names) {
      const spec = PROPS[name] as { className?: string; charId?: number };
      // Most props are found by the class they are exported under, which survives
      // the source file being repatched. `ruins` has no class at all - it is an
      // orphan character - so it is the one that has to name an id.
      if (spec.charId !== undefined) {
        rootByProp.set(name, spec.charId);
        continue;
      }
      const binding = sourceSymbols.find((entry) => entry.name === spec.className);
      if (!binding) throw new SwfLevelError(`${path.basename(swfPath)} has no ${spec.className}`);
      rootByProp.set(name, binding.id);
    }
    const { idMap } = importCharacters(source, srn, [...rootByProp.values()]);
    for (const [name, rootId] of rootByProp) {
      const mapped = idMap.get(rootId);
      if (mapped === undefined) throw new SwfLevelError(`${name} (character ${rootId}) did not import`);
      imported.set(name, mapped);
    }
  }
  return imported;
}

/**
 * Takes the two flat backdrop rectangles out of the imported scene.
 *
 * They are dropped by *placement*, not by deleting the characters: the scene is one
 * DefineSprite and the rest of it - the ruins, the lanterns, the bare tree, the
 * fire - has to survive untouched. See the note on `backdropSky` for why they go.
 */
function stripBackdrop(srn: SwfFile, ruinsCharId: number, dropIds: number[]): number {
  const index = srn.tags.findIndex(
    (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === ruinsCharId,
  );
  if (index === -1) throw new SwfLevelError(`imported scene ${ruinsCharId} is not a sprite`);

  const inner = spriteInnerTags(srn.tags[index]);
  const kept = inner.filter((tag) => {
    if (tag.code !== TAG_PLACE_OBJECT2 && tag.code !== TAG_PLACE_OBJECT3) return true;
    const charId = parsePlace(tag).charId;
    return charId === null || !dropIds.includes(charId);
  });
  srn.tags[index] = rebuildSprite(srn.tags[index], kept);
  return inner.length - kept.length;
}

interface Placement {
  depth: number;
  charId: number;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
  clipDepth?: number;
}

/** Turns one layout entry into a placement, applying the prop's own anchor. */
function placementFor(entry: DecorEntry, charId: number, depth: number): Placement {
  const spec = PROP_ANCHORS[entry.prop];
  const scale = entry.scale ?? 1;
  const y = entry.y ?? DECOR_FLOOR_Y;
  const offset =
    spec.anchor === "ground"
      ? { x: -spec.width / 2, y: -spec.height }
      : spec.anchor === "centre"
        ? { x: -spec.width / 2, y: -spec.height / 2 }
        : { x: 0, y: 0 };
  return {
    depth,
    charId,
    x: entry.x + offset.x * scale,
    y: y + offset.y * scale,
    scaleX: scale,
    scaleY: scale,
  };
}

/**
 * Hangs the rift, its door and its name plate on the cleared wall.
 *
 * Returns false when `a_Door_108` is already bound, which is what a re-run of an
 * already-patched file looks like.
 */
function placePortal(srn: SwfFile, props: Map<PropName, number>, verify: boolean): boolean {
  const symbols = readSymbolClasses(srn);
  if (symbols.some((entry) => entry.name === DOOR_CLASS)) {
    console.log(`${DOOR_CLASS} is already bound; portal already placed.`);
    return false;
  }

  const donor = symbols.find((entry) => entry.name === DOOR_DONOR_CLASS);
  if (!donor) throw new SwfLevelError(`LevelsSRN.swf has no ${DOOR_DONOR_CLASS} to rename into ${DOOR_CLASS}`);
  const doorShape = symbols.find((entry) => entry.name === DOOR_SHAPE_CLASS);
  if (!doorShape) throw new SwfLevelError(`LevelsSRN.swf has no ${DOOR_SHAPE_CLASS} symbol`);
  const markerBinding = symbols.find((entry) => entry.name === MARKER_CLASS);
  if (!markerBinding) throw new SwfLevelError(`LevelsSRN.swf has no ${MARKER_CLASS} symbol`);

  // Centred on the tower and standing on its stone pad, so the rift burns in the
  // arch rather than out on the grass beside it. The door marker itself stays down
  // on the walkable floor line, which is where the player has to be to use it.
  const portalCentreX = sceneToLocalX(TOWER_IN_SCENE.centreX);
  const portalBaseY = sceneToLocalY(TOWER_IN_SCENE.groundY);
  const portalLocal = {
    x: portalCentreX - PORTAL_ART_OFFSET.centreX * PORTAL_SCALE,
    y: portalBaseY - PORTAL_ART_OFFSET.bottom * PORTAL_SCALE,
  };
  const doorLocal = { x: portalCentreX, y: DECOR_FLOOR_Y };
  // The plate hangs a fixed clearance above the top of the drawn rift, so moving
  // or resizing the rift moves the plate with it.
  const riftTop = portalLocal.y + PORTAL_ART_OFFSET.top * PORTAL_SCALE;
  const plateLocal = {
    x: doorLocal.x - PLATE_RENDER_OFFSET.x,
    y: riftTop - PLATE_GAP_ABOVE_ART - PLATE_HALF_HEIGHT - PLATE_RENDER_OFFSET.y,
  };

  if (verify) {
    console.log(
      `verify only - would place the rift at local (${portalLocal.x.toFixed(2)}, ${portalLocal.y.toFixed(2)}) ` +
        `scale ${PORTAL_SCALE}, ${DOOR_CLASS} at (${doorLocal.x.toFixed(2)}, ${doorLocal.y.toFixed(2)})`,
    );
    return true;
  }

  // A class can only be bound to one character, so the door gets its own copy of
  // the existing door's rectangle rather than sharing the character with a_Door_2.
  const doorCharId = importCharacters(srn, srn, [doorShape.id]).idMap.get(doorShape.id) as number;

  renameAbcStrings(srn, new Map([[DOOR_DONOR_CLASS, DOOR_CLASS]]));
  writeSymbolClasses(
    srn,
    readSymbolClasses(srn)
      .filter((entry) => entry.name !== DOOR_DONOR_CLASS && entry.name !== DOOR_CLASS)
      .concat([{ id: doorCharId, name: DOOR_CLASS }]),
  );

  const roomIndex = roomSpriteIndex(srn);
  const roomTag = srn.tags[roomIndex];
  const depth = nextFreeDepth(roomTag);
  const inner = spriteInnerTags(roomTag);
  // Ahead of the sprite's ShowFrame, so all three land on frame 1.
  const showFrameIndex = inner.findIndex((tag) => tag.code === 1);
  const insertAt = showFrameIndex === -1 ? inner.length - 1 : showFrameIndex;
  inner.splice(
    insertAt,
    0,
    buildPlaceObject2({
      depth,
      charId: props.get("portal") as number,
      x: portalLocal.x,
      y: portalLocal.y,
      scaleX: PORTAL_SCALE,
      scaleY: PORTAL_SCALE,
    }),
    buildPlaceObject2({ depth: depth + 1, charId: doorCharId, x: doorLocal.x, y: doorLocal.y }),
    buildPlaceObject2({ depth: depth + 2, charId: markerBinding.id, x: plateLocal.x, y: plateLocal.y }),
  );
  srn.tags[roomIndex] = rebuildSprite(roomTag, inner);

  console.log(`${DOOR_DONOR_CLASS} -> ${DOOR_CLASS}, bound to character ${doorCharId} (copy of ${doorShape.id})`);
  console.log(
    `placed in ${HOST_ROOM}: rift (${portalLocal.x.toFixed(2)}, ${portalLocal.y.toFixed(2)}) scale ${PORTAL_SCALE}, ` +
      `door (${doorLocal.x.toFixed(2)}, ${doorLocal.y.toFixed(2)}) from depth ${depth}`,
  );
  return true;
}

/**
 * Dresses the square for Hallow's Eve.
 *
 * Two composites, because the dressing straddles the room's foreground: the
 * graveyard goes behind the grass on `DECOR_DEPTH` and the green fire in front of
 * it on `DECOR_FRONT_DEPTH`, so the fire reads as being between the viewer and the
 * graves. Neither is bound to a class - see the note above `DECOR_DEPTH` for why
 * binding one would hand its layering to the scenery system.
 *
 * Returns false when either depth is already taken, which is what a re-run of an
 * already-patched file looks like.
 */
function placeDecor(srn: SwfFile, props: Map<PropName, number>, verify: boolean, without: Set<OptionalPhase>): boolean {
  const usedDepths = new Set<number>();
  for (const tag of spriteInnerTags(srn.tags[roomSpriteIndex(srn)])) {
    if (tag.code !== TAG_PLACE_OBJECT2 && tag.code !== TAG_PLACE_OBJECT3) continue;
    usedDepths.add(parsePlace(tag).depth);
  }
  if (usedDepths.has(DECOR_SCENE_DEPTH) || usedDepths.has(DECOR_DEPTH) || usedDepths.has(DECOR_FRONT_DEPTH)) {
    console.log(`depth ${DECOR_DEPTH}/${DECOR_FRONT_DEPTH} is taken; square already dressed.`);
    return false;
  }

  if (verify) {
    console.log(
      `verify only - would place ${DECOR_BACK.length} props on depth ${DECOR_DEPTH} and ` +
        `${DECOR_ANIMATED.length} animated props as room children`,
    );
    return true;
  }

  /**
   * Packs one layout into a composite sprite and returns its character id.
   *
   * `mask` turns the composite into a masked one: a solid rectangle goes on depth
   * 1 carrying a clip depth, which makes Flash draw everything above it only where
   * the rectangle covers. That is the only way to show part of a DefineShape, and
   * the scene's ruins and its bare right-hand hillside are one shape.
   */
  const build = (layout: DecorEntry[], mask?: typeof RUINS_MASK): number => {
    const placements: Placement[] = [];
    let depth = 1;
    if (mask) {
      const maskId = maxCharacterId(srn) + 1;
      appendCharacterTag(
        srn,
        buildSolidRectShape(
          maskId,
          {
            xMin: Math.round(mask.left * 20),
            xMax: Math.round(mask.right * 20),
            yMin: Math.round(mask.top * 20),
            yMax: Math.round(mask.bottom * 20),
          },
          0x000000,
        ),
      );
      // A mask is never drawn, so its colour is arbitrary. The clip depth is well
      // past anything the layout can reach, so every layer above is masked.
      placements.push({ depth: depth++, charId: maskId, x: 0, y: 0, scaleX: 1, scaleY: 1, clipDepth: 999 });
    }
    for (const entry of layout) {
      placements.push(placementFor(entry, props.get(entry.prop) as number, depth++));
      // A lit lantern is two characters: the body, and the carved face over it.
      if (entry.prop === "pumpkin") {
        const scale = entry.scale ?? 1;
        placements.push({
          depth: depth++,
          charId: props.get("pumpkinFace") as number,
          x: entry.x,
          y: (entry.y ?? DECOR_FLOOR_Y) + PUMPKIN_FACE_OFFSET_Y * scale,
          scaleX: scale,
          scaleY: scale,
        });
      }
    }
    const id = maxCharacterId(srn) + 1;
    appendCharacterTag(srn, buildSprite({ id, placements }));
    return id;
  };

  const keep = (layout: DecorEntry[]): DecorEntry[] =>
    without.has("extras") ? layout.filter((entry) => !NEW_PROPS.includes(entry.prop)) : layout;

  const sceneId = build(DECOR_SCENE, without.has("mask") ? undefined : RUINS_MASK);
  const backId = build(keep(DECOR_BACK));

  const roomIndex = roomSpriteIndex(srn);
  const roomTag = srn.tags[roomIndex];
  const inner = spriteInnerTags(roomTag);
  for (const tag of inner) {
    if (tag.code !== TAG_PLACE_OBJECT2 && tag.code !== TAG_PLACE_OBJECT3) continue;
    const depth = parsePlace(tag).depth;
    if (depth === DECOR_SCENE_DEPTH || depth === DECOR_DEPTH || depth === DECOR_FRONT_DEPTH) {
      throw new SwfLevelError(`${HOST_ROOM} already uses depth ${depth}`);
    }
  }
  const showFrameIndex = inner.findIndex((tag) => tag.code === 1);
  const insertAt = showFrameIndex === -1 ? inner.length - 1 : showFrameIndex;

  // The animated props go in one at a time, as room children, because only a room
  // child is offered to the scenery system - see the note above `DECOR_ANIMATED`.
  // Their depths are placeholders: the scenery system relayers them anyway.
  const animated = keep(DECOR_ANIMATED).map((entry, index) =>
    buildPlaceObject2({
      ...placementFor(entry, props.get(entry.prop) as number, DECOR_FRONT_DEPTH + index),
    }),
  );

  const composites = [
    without.has("scene") ? null : buildPlaceObject2({ depth: DECOR_SCENE_DEPTH, charId: sceneId, x: 0, y: 0 }),
    buildPlaceObject2({ depth: DECOR_DEPTH, charId: backId, x: 0, y: 0 }),
  ].filter((tag): tag is NonNullable<typeof tag> => tag !== null);
  inner.splice(insertAt, 0, ...composites, ...animated);
  srn.tags[roomIndex] = rebuildSprite(roomTag, inner);

  console.log(
    `dressed ${HOST_ROOM}: the scene on depth ${DECOR_SCENE_DEPTH} (character ${sceneId}), ` +
      `${DECOR_BACK.length} still props on depth ${DECOR_DEPTH}, ` +
      `${animated.length} animated props as room children from depth ${DECOR_FRONT_DEPTH}`,
  );
  return true;
}

/**
 * Rebinds the `a_Animation_*` donor classes onto the imported seasonal artwork.
 *
 * Without this every animated prop is drawn once and frozen: `Level` only hands a
 * child to the scenery system - the thing that runs its timeline - when its class
 * name starts with `a_Animation`. See `ANIMATION_BINDINGS`.
 *
 * Returns false when the donors are already repointed, which is what a re-run of an
 * already-patched file looks like.
 */
function bindAnimations(srn: SwfFile, props: Map<PropName, number>, verify: boolean): boolean {
  const bindings = readSymbolClasses(srn);
  const wanted = ANIMATION_BINDINGS.map(({ donor, prop }) => {
    const charId = props.get(prop);
    if (charId === undefined) throw new SwfLevelError(`${prop} was not imported; cannot bind ${donor}`);
    if (!bindings.some((entry) => entry.name === donor)) {
      throw new SwfLevelError(`LevelsSRN.swf has no ${donor} to rebind`);
    }
    return { donor, charId };
  });

  if (wanted.every(({ donor, charId }) => bindings.some((e) => e.name === donor && e.id === charId))) {
    console.log("animation classes already rebound.");
    return false;
  }
  for (const { donor, charId } of wanted) console.log(`${donor} -> character ${charId}`);
  if (verify) return true;

  const donors = new Set(wanted.map((entry) => entry.donor));
  writeSymbolClasses(
    srn,
    bindings
      .filter((entry) => !donors.has(entry.name))
      .concat(wanted.map(({ donor, charId }) => ({ id: charId, name: donor }))),
  );
  return true;
}

/**
 * Puts Blackrose Mire back under its green sky, in Dread as well as in Normal.
 *
 * **The green cast the event is remembered for is shipped art, not a filter.**
 * `a_Level_SwampRoadNorth` carries every backdrop layer twice, once for each
 * difficulty, tagged by instance name:
 *
 *     am_Parallax_0_0$am_Moment_Normal    character 499   average RGB 219,252,78
 *     am_Parallax_0_0$am_Moment_Hard      character 509   average RGB 253,172,76
 *     am_Parallax_2_0$am_Moment1_Normal   character 506   average RGB 176,228,66
 *     am_Parallax_2_0$am_Moment1_Hard     character 512   average RGB 212,161,59
 *     am_Parallax_20_0$am_Moment2_Normal  character 521 (a_SharedTrees2)
 *     am_Parallax_20_0$am_Moment2_Hard    character 525 (a_SharedTrees1)
 *
 * `Level.method_923` splits an instance name on `$`, takes the tail of every
 * `am_Moment*` token and shows the object only when that tail is in the level's
 * moment list - which the server fills from `DungeonEntryDisplay.buildMomentParams`
 * and which reads `Hard` in a Dread town. So the *Normal* set is the green one and
 * Dread has always drawn the orange set over it. Nothing was missing; the wrong
 * half of the artwork was being selected.
 *
 * `DayNightManager` is a blind alley here and worth writing down: it does own a
 * greenish tint (`0x99BB99`, with `0x55BB55` for a horizon), but its
 * `TIME_OF_DAY_LIST` is eight slots of Day, its tints only ever multiply - so they
 * darken rather than shift towards this yellow-green - and it reaches exactly one
 * object, `level.var_59`, resetting it to an identity transform on Day. It cannot
 * produce this look and it is not what produced it.
 *
 * The fix is data: repoint each `_Hard` placement at the character its `_Normal`
 * twin uses. Both sets then draw the green art, so the square is green whichever
 * difficulty it is entered at, and no server field or client method is touched.
 * Everything else about the placement - name, matrix, depth - is left alone.
 */
function greenParallax(srn: SwfFile, verify: boolean): boolean {
  const binding = readSymbolClasses(srn).find((entry) => entry.name === LEVEL_CLASS);
  if (!binding) throw new SwfLevelError(`LevelsSRN.swf has no ${LEVEL_CLASS} symbol`);
  const index = srn.tags.findIndex(
    (tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === binding.id,
  );
  if (index === -1) throw new SwfLevelError(`${LEVEL_CLASS} sprite ${binding.id} not found`);

  const inner = spriteInnerTags(srn.tags[index]);

  /** `am_Parallax_0_0$am_Moment_Hard` -> `am_Parallax_0_0$am_Moment`. */
  const momentKey = (name: string, suffix: string): string | null => {
    if (!name.endsWith(suffix) || name.indexOf("am_Moment") === -1) return null;
    return name.slice(0, name.length - suffix.length);
  };

  const green = new Map<string, number>();
  for (const tag of inner) {
    if (tag.code !== TAG_PLACE_OBJECT2 && tag.code !== TAG_PLACE_OBJECT3) continue;
    const place = parsePlace(tag);
    if (!place.name || place.charId === null) continue;
    const key = momentKey(place.name, "_Normal");
    if (key) green.set(key, place.charId);
  }

  /**
   * A class-bound layer must be left alone, and this is not a nicety.
   *
   * Flash CS declares a typed member for every named timeline instance, after the
   * class its character is bound to. `a_Level_SwampRoadNorth` really does say:
   *
   *     public var am_Parallax_20_0$am_Moment2_Hard:a_SharedTrees1;
   *
   * so repointing that placement at character 521 makes the player build an
   * `a_SharedTrees2` and assign it to an `a_SharedTrees1` member - **TypeError
   * #1034, Type Coercion failed**, thrown while the level is still constructing,
   * which takes the whole region down with it. That is exactly what happened, and
   * it is silent apart from the client's crash report.
   *
   * The parallax layers that matter carry no class at all (their members are
   * declared `MovieClip`, which accepts anything), so the rule is simply: repoint
   * a layer only when neither side is bound to a class. The two tree sets are the
   * only bound pair here, and their average colours - 186,192,59 against
   * 172,206,63 - are close enough that skipping them costs nothing.
   */
  const boundIds = new Set(readSymbolClasses(srn).map((entry) => entry.id));

  const swapped: string[] = [];
  const skipped: string[] = [];
  const rebuilt = inner.map((tag) => {
    if (tag.code !== TAG_PLACE_OBJECT2 && tag.code !== TAG_PLACE_OBJECT3) return tag;
    const place = parsePlace(tag);
    if (!place.name || place.charId === null) return tag;
    const key = momentKey(place.name, "_Hard");
    if (!key) return tag;
    const greenId = green.get(key);
    if (greenId === undefined || greenId === place.charId) return tag;
    if (boundIds.has(place.charId) || boundIds.has(greenId)) {
      skipped.push(place.name);
      return tag;
    }
    swapped.push(`${place.name} (depth ${place.depth}): ${place.charId} -> ${greenId}`);
    return repointPlacement(tag, greenId);
  });

  if (skipped.length > 0) {
    console.log(`left alone (class-bound, would fail type coercion): ${[...new Set(skipped)].join(", ")}`);
  }

  if (swapped.length === 0) {
    console.log(`${LEVEL_CLASS} already draws the green backdrop in Dread.`);
    return false;
  }
  for (const entry of swapped) console.log(`green backdrop ${entry}`);
  if (verify) return true;

  srn.tags[index] = rebuildSprite(srn.tags[index], rebuilt);
  console.log(`${LEVEL_CLASS}: ${swapped.length} Dread backdrop layers repointed at the green artwork`);
  return true;
}

function main(): void {
  const { verify, out, without } = parseArgs(process.argv);
  if (without.size > 0) console.log(`leaving out: ${[...without].join(", ")}`);

  const srn = readSwfFile(SRN_SWF);
  const greened = without.has("green") ? false : greenParallax(srn, verify);
  const clearedStatues = without.has("statues") ? false : removeStatues(srn, verify);
  // `imports` leaves the seasonal artwork out of the file entirely. Nothing can be
  // placed without it, so it forces the two steps that place things off as well.
  if (without.has("imports")) { without.add("portal"); without.add("decor"); }
  const props = without.has("imports") ? new Map<PropName, number>() : importProps(srn, without);
  if (!verify && !without.has("imports")) {
    const dropped = stripBackdrop(srn, props.get("ruins") as number, [
      props.get("backdropSky") as number,
      props.get("backdropGround") as number,
    ]);
    console.log(`stripped ${dropped} backdrop placements out of the imported scene`);
  }
  const placedPortal = without.has("portal") ? false : placePortal(srn, props, verify);
  const dressedSquare = without.has("decor") ? false : placeDecor(srn, props, verify, without);
  // After placePortal, which also rewrites the symbol table.
  const boundAnims = without.has("decor") || without.has("extras") ? false : bindAnimations(srn, props, verify);

  if (!greened && !clearedStatues && !placedPortal && !dressedSquare && !boundAnims) {
    console.log("nothing to do - LevelsSRN.swf already carries the Hallow's Eve square.");
    return;
  }
  if (verify) {
    console.log("verify only - no file written.");
    return;
  }

  const size = srn.tags.reduce((total, tag) => total + encodeTag(tag).length, 0);
  console.log(`${size} bytes of tags`);
  if (out === SRN_SWF) ensureBackup(SRN_SWF);
  writeSwfFile(out, srn);
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
