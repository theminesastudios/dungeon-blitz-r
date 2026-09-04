/**
 * Fills the empty strip under Blackrose Mire's railing and dresses the square for
 * Hallow's Eve.
 *
 * ## What it does
 *
 *   - **Levels the railing and brings it forward.** The four `am_Foreground_1` runs
 *     never sat at the same height - their rails were at room y -14, -10, +6 and +20,
 *     because each placement carried its own scale - and scaling them all up by one
 *     factor stretched that spread instead of closing it, which put a second row of
 *     spikes across the square where two runs met. `FENCE_RUNS` replaces all four
 *     with one scale, one rail height and ends that butt together, so there is one
 *     row and it sits at the bottom of the view.
 *   - **Dresses the bare tree**: cobwebs in the crown and two more swinging lanterns
 *     on branch ends further out.
 *   - **Adds wisps** over the square and around the tree.
 *
 * Everything placed here is artwork the file already holds, so nothing is drawn and
 * nothing new is imported. `dev-render-room.ts` draws the result; every number below
 * was read off that.
 *
 * **The ground stays bare on purpose.** Lanterns, grass and green fire were all tried
 * along the floor line and under the railing and all of it was taken back out: the
 * square reads as a graveyard, and a row of props at the player's feet turned it into
 * a market stall. The strip under the rail is closed by the rail itself now.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-square-dressing.ts
 *          [--verify] [--out <swf>]
 *
 * Re-runnable: it looks for its own composite depth and does nothing if the square
 * is already dressed. `--out` writes elsewhere, which is how a layout is rendered
 * and looked at before it is committed to the live file.
 */
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
  SwfTag,
  appendCharacterTag,
  buildPlaceObject2,
  buildSprite,
  characterBounds,
  encodeTag,
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
const PETS_SWF = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "Animation_Pets.swf");

const HOST_ROOM = "a_Room_SRN04";
const DOOR_CLASS = "a_Door_108";

/** The still dressing already in the room; the cobwebs are added to this composite. */
const DECOR_DEPTH = 234;

/** Room children start here. The scenery system relayers them, so these are only slots. */
const ANIMATED_BASE_DEPTH = 260;

/** Where the carved face sits on the gourd, in the gourd's own pixels. */
const PUMPKIN_FACE_OFFSET = { x: 12.9, y: -7.1 };

/**
 * Cobwebs strung in the bare tree, added to the square's still composite.
 *
 * The tree's crown is room-local 643..1054 across and -695..-233 up; these hang in
 * the forks where a web would actually catch. Both are the cobwebs the square
 * already carries on the treeline, so nothing new is imported.
 */
const TREE_DRESSING: Array<{ web: "web" | "webWide"; x: number; y: number; scale: number }> = [
  { web: "web", x: 700, y: -640, scale: 0.75 },
  { web: "webWide", x: 830, y: -600, scale: 0.6 },
  { web: "web", x: 962, y: -560, scale: 0.65 },
];

/**
 * More of what already animates.
 *
 * `swing` is the swinging jack-o'-lantern, `flame` the green fire and `wisp` the
 * drifting mote - all three are classes that are already bound and driven, so extra
 * placements cost nothing but a tag each. They are room children rather than
 * composite children because only a room child reaches the scenery system.
 */
const ANIMATED: Array<{ prop: "swing" | "flame" | "wisp"; x: number; y: number; scale: number }> = [
  // Two more lanterns in the tree, smaller and further out than the first three, so
  // the crown reads as hung rather than as three lanterns in a row.
  { prop: "swing", x: 757, y: -447, scale: 0.44 },
  { prop: "swing", x: 913, y: -480, scale: 0.5 },

  // **No green fire and no wisps.** Four flames stood along the floor line and four
  // wisps drifted over the square, and all eight came back out: a green light with
  // nothing holding it reads as a smear rather than as a lantern. The square's own
  // fire is up on the besoms and in the skull lanterns on the wall, which is where
  // this event's light belongs; the rift's three wisps stay because they are the
  // arch giving off light, and they were shipped that way.
];

/**
 * The railing, laid out from scratch rather than nudged.
 *
 * **The four runs were never level and scaling them made it worse.** Each placement
 * carried its own scale - two at 1.0, two at 1.1 across and 1.176 down - and a run's
 * rail hangs `TILE_DROP` below its origin *times that scale*, so the four rails sat at
 * room y -14, -10, +6 and +20. Multiplying every scale by one factor stretched a 34
 * pixel spread to 39 and pushed two runs into each other, which is what drew a second
 * row of spikes across the square where runs B and C met at x 890.
 *
 * So all four are rewritten instead: one scale, one rail height, and x values that
 * make each run start where the one before it ends. A run reaches 443.4 art pixels
 * left of its origin and 75.4 right, so at `FENCE_SCALE` it spans 591 pixels and the
 * runs are spaced by exactly that. A mirrored run reaches the other way, which is why
 * its x is the left-hand end plus 86 rather than minus 505.
 *
 * `FENCE_SCALE` is what brings it forward: bigger *and* lower, because scaling about
 * an origin that sits above the rail pushes the rail down with it. At 1.14 the rail
 * lands on the bottom of the view - room y +2, measured off a screenshot against the
 * rift at room x 367 and the tree trunk at 860.
 */
const FENCE_SCALE = 1.14;

/** How far a run's rail hangs below its own origin, in the run's own pixels. */
const TILE_DROP = 226.7;

/**
 * Where every rail is put, in room-local pixels.
 *
 * **The camera shows 161 pixels below the floor line**, measured off a screenshot of
 * the Wolf's End end of the road: the player's feet on the -60 ledge sit 175 screen
 * pixels above the bottom of the play area, at 1.09 screen pixels to the room pixel.
 * (An earlier reading of 82 was taken off a crouching character and was wrong by
 * half; it is what left a band of bare ground under the rail.)
 *
 * The fence art ends 25 pixels below its rail, so a rail at 55 puts its bottom edge
 * on the bottom of the view when the player is on the square's own floor at -80 -
 * flush, with nothing showing under it.
 *
 * It pays off twice. The road dips to +60 on the way down to Wolf's End, and a rail
 * at 55 lands *on* that lower ground rather than hanging forty pixels over it, which
 * is what made the railing look like it was floating once the camera followed the
 * player down.
 */
const FENCE_RAIL_Y = 55;

/**
 * The four runs, left to right.
 *
 * **The gap between the third and the fourth is a doorway, not a mistake.** The room
 * ships its railing with 1466..1666 left open, and that is where Wolf's End is: the
 * `a_Door_2` placement sits at room x 1676 with its name plate marker at 1459, so the
 * opening is the way through. Laying the four runs end to end across the whole room -
 * which is what a first pass here did - walls the passage off behind a fence the
 * player then walks through, and it reads as a bug even though the door still works.
 *
 * So three runs are joined up across the square and the fourth starts again past the
 * doorway, on the same two ends the room shipped: C finishes at 1466 and D begins at
 * 1666. A run reaches 443.4 art pixels left of its origin and 75.4 right, so at
 * `FENCE_SCALE` it spans 591; a mirrored run reaches the other way, which is why its
 * x is its left-hand end plus 86 rather than minus 505.
 *
 * The third is kept mirrored - it is the one the room shipped mirrored - so the run
 * of tiles does not read as the same picture stamped four times.
 */
const FENCE_RUNS: Array<{ x: number; mirror?: boolean }> = [
  { x: 197 },
  { x: 788.5 },
  { x: 960.5, mirror: true },
  { x: 2171.5 },
];

/**
 * The instance name the room's railing runs carry.
 *
 * Not enough on its own: `am_Foreground_1` is also on three placements of an empty
 * marker sprite, so the runs are picked out by *character* - the one whose artwork is
 * wider than a screen, which only a run of fence tiles is.
 */
const FENCE_INSTANCE = "am_Foreground_1";
const FENCE_MIN_WIDTH = 1000;

function spriteIndexFor(swf: SwfFile, charId: number): number {
  const index = swf.tags.findIndex((tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === charId);
  if (index === -1) throw new SwfLevelError(`character ${charId} is not a sprite`);
  return index;
}

function placementsOf(swf: SwfFile, charId: number): ReturnType<typeof parsePlace>[] {
  return spriteInnerTags(swf.tags[spriteIndexFor(swf, charId)])
    .filter((tag) => tag.code === TAG_PLACE_OBJECT2 || tag.code === TAG_PLACE_OBJECT3)
    .map((tag) => parsePlace(tag));
}

/** Bounds in pixels, rounded, for matching a character against what it should be. */
function sizeOf(swf: SwfFile, charId: number): [number, number] {
  const bounds = characterBounds(swf, charId);
  if (!bounds) throw new SwfLevelError(`character ${charId} has no bounds`);
  return [Math.round((bounds.xMax - bounds.xMin) / 20), Math.round((bounds.yMax - bounds.yMin) / 20)];
}

/**
 * Finds the imported seasonal props, which carry no class and whose ids moved when
 * they were imported: they are matched by the bounds of the art they came from.
 */
function findImported(swf: SwfFile): { gourd: number; face: number; web: number; webWide: number } {
  const pets = readSwfFile(PETS_SWF);
  const petSymbols = readSymbolClasses(pets);
  const petSize = (className: string): string => {
    const binding = petSymbols.find((entry) => entry.name === className);
    if (!binding) throw new SwfLevelError(`${path.basename(PETS_SWF)} has no ${className}`);
    return sizeOf(pets, binding.id).join("x");
  };
  const wanted = new Map<string, string>([
    ["gourd", petSize("a_PumpkinHead")],
    ["face", petSize("a_PumpkinFace")],
    // The two cobwebs the square already hangs on the treeline, by their own sizes.
    ["web", "108x214"],
    ["webWide", "180x204"],
  ]);

  const found = new Map<string, number>();
  // The gourd and its face live in the swinging lantern now - the swing patch lifted
  // them out of the still composite - so that character is searched as well.
  const sources = [decorComposite(swf), sceneCharacter(swf), animatedCharacter(swf, "a_Animation_PumpkinSwing")];
  for (const place of sources.flatMap((id) => placementsOf(swf, id))) {
    if (place.charId === null) continue;
    const size = sizeOf(swf, place.charId).join("x");
    for (const [name, wantedSize] of wanted) {
      if (size === wantedSize && !found.has(name)) found.set(name, place.charId);
    }
  }
  for (const name of wanted.keys()) {
    if (!found.has(name)) throw new SwfLevelError(`could not find the imported ${name} (${wanted.get(name)})`);
  }
  return {
    gourd: found.get("gourd")!,
    face: found.get("face")!,
    web: found.get("web")!,
    webWide: found.get("webWide")!,
  };
}

function roomCharacter(swf: SwfFile): number {
  const room = readSymbolClasses(swf).find((entry) => entry.name === HOST_ROOM);
  if (!room) throw new SwfLevelError(`LevelsSRN.swf has no ${HOST_ROOM}`);
  return room.id;
}

/** The still-dressing composite the square is built in, by the depth it sits on. */
function decorComposite(swf: SwfFile): number {
  const place = placementsOf(swf, roomCharacter(swf)).find((entry) => entry.depth === DECOR_DEPTH);
  if (!place || place.charId === null) {
    throw new SwfLevelError(`${HOST_ROOM} has nothing on depth ${DECOR_DEPTH}; the square is not dressed`);
  }
  return place.charId;
}

/** The seasonal scene composite, one depth further back; the cobweb sizes are read from it. */
function sceneCharacter(swf: SwfFile): number {
  const place = placementsOf(swf, roomCharacter(swf)).find((entry) => entry.depth === 124);
  if (!place || place.charId === null) throw new SwfLevelError(`${HOST_ROOM} has no scene on depth 124`);
  return place.charId;
}

/** The character a bound animation class draws, by class name. */
function animatedCharacter(swf: SwfFile, className: string): number {
  const binding = readSymbolClasses(swf).find((entry) => entry.name === className);
  if (!binding) throw new SwfLevelError(`LevelsSRN.swf has no ${className}`);
  return binding.id;
}

function main(): void {
  const argv = process.argv;
  const verify = argv.includes("--verify");
  const outIndex = argv.indexOf("--out");
  const out = outIndex === -1 ? SRN_SWF : path.resolve(argv[outIndex + 1]);

  const swf = readSwfFile(SRN_SWF);
  const symbols = readSymbolClasses(swf);
  if (!symbols.some((entry) => entry.name === DOOR_CLASS)) {
    throw new SwfLevelError(
      `${path.basename(SRN_SWF)} does not carry the Hallow's Eve square yet; run patch-levelssrn-hallows-eve.ts first`,
    );
  }

  const roomId = roomCharacter(swf);
  const roomIndex = spriteIndexFor(swf, roomId);
  if (placementsOf(swf, roomId).some((place) => place.depth === ANIMATED_BASE_DEPTH)) {
    console.log(`${HOST_ROOM} already carries the dressing on depth ${ANIMATED_BASE_DEPTH}.`);
    return;
  }

  const imported = findImported(swf);
  console.log(
    `props: gourd ${imported.gourd}, face ${imported.face}, web ${imported.web}, wide web ${imported.webWide}`,
  );

  const swing = animatedCharacter(swf, "a_Animation_PumpkinSwing");
  const flame = animatedCharacter(swf, "a_Animation_Smoke2");
  const wisp = animatedCharacter(swf, "a_Animation_PortaAngled");
  const animatedChar = { swing, flame, wisp };

  if (verify) {
    console.log(
      `verify only - would place ${TREE_DRESSING.length} cobwebs, ${ANIMATED.length} animated children, ` +
        `and relay ${FENCE_RUNS.length} railing runs`,
    );
    return;
  }

  // ---- cobwebs, into the composite that is already there --------------------
  const decorId = decorComposite(swf);
  const decorIndex = spriteIndexFor(swf, decorId);
  const decorInner = spriteInnerTags(swf.tags[decorIndex]);
  let decorDepth = Math.max(...placementsOf(swf, decorId).map((place) => place.depth)) + 1;
  const webTags = TREE_DRESSING.map((entry) =>
    buildPlaceObject2({
      depth: decorDepth++,
      charId: entry.web === "web" ? imported.web : imported.webWide,
      x: entry.x,
      y: entry.y,
      scaleX: entry.scale,
      scaleY: entry.scale,
    }),
  );
  const decorEnd = decorInner.findIndex((tag) => tag.code === TAG_SHOW_FRAME);
  decorInner.splice(decorEnd === -1 ? decorInner.length - 1 : decorEnd, 0, ...webTags);
  swf.tags[decorIndex] = rebuildSprite(swf.tags[decorIndex], decorInner);

  // ---- the room's own new children ------------------------------------------
  const roomTag = swf.tags[roomIndex];
  const roomInner = spriteInnerTags(roomTag);
  const newChildren: SwfTag[] = [
    ...ANIMATED.map((entry, index) =>
      buildPlaceObject2({
        depth: ANIMATED_BASE_DEPTH + index,
        charId: animatedChar[entry.prop],
        x: entry.x,
        y: entry.y,
        scaleX: entry.scale,
        scaleY: entry.scale,
      }),
    ),
  ];

  // ---- the railing, levelled and brought forward -----------------------------
  let moved = 0;
  const rebuilt = roomInner.map((tag) => {
    if (tag.code !== TAG_PLACE_OBJECT2 && tag.code !== TAG_PLACE_OBJECT3) return tag;
    const place = parsePlace(tag);
    if (place.name !== FENCE_INSTANCE || !place.matrix || place.charId === null) return tag;
    const bounds = characterBounds(swf, place.charId);
    if (!bounds || (bounds.xMax - bounds.xMin) / 20 < FENCE_MIN_WIDTH) return tag;
    const run = FENCE_RUNS[moved];
    moved += 1;
    if (!run) throw new SwfLevelError(`${HOST_ROOM} has more railing runs than FENCE_RUNS lays out`);
    return buildPlaceObject2({
      depth: place.depth,
      charId: place.charId as number,
      name: FENCE_INSTANCE,
      scaleX: run.mirror ? -FENCE_SCALE : FENCE_SCALE,
      scaleY: FENCE_SCALE,
      x: run.x,
      // One height for all four: the placement origin sits `TILE_DROP` above the
      // rail, so this is what puts every rail on `FENCE_RAIL_Y`.
      y: FENCE_RAIL_Y - TILE_DROP * FENCE_SCALE,
    });
  });
  if (moved !== FENCE_RUNS.length) {
    throw new SwfLevelError(`${HOST_ROOM} has ${moved} railing runs; FENCE_RUNS lays out ${FENCE_RUNS.length}`);
  }
  const showFrame = rebuilt.findIndex((tag) => tag.code === TAG_SHOW_FRAME);
  rebuilt.splice(showFrame === -1 ? rebuilt.length - 1 : showFrame, 0, ...newChildren);
  swf.tags[roomIndex] = rebuildSprite(roomTag, rebuilt);

  console.log(
    `${webTags.length} cobwebs in the composite, ${ANIMATED.length} animated children, ` +
      `${moved} railing runs relaid at x${FENCE_SCALE} with every rail on y ${FENCE_RAIL_Y}`,
  );

  const size = swf.tags.reduce((total, tag) => total + encodeTag(tag).length, 0);
  console.log(`${size} bytes of tags`);
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
