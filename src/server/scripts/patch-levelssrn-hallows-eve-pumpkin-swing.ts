/**
 * Sets the three jack-o'-lanterns in Blackrose Mire's square swinging.
 *
 * `patch-levelssrn-hallows-eve.ts` hangs them in the bare tree behind the ruins as
 * two still placements each - the gourd (`a_PumpkinHead`) and the carved face
 * (`a_PumpkinFace`) laid over it - inside the square's decor composite. A composite
 * child is drawn once and never moves, so they hang there dead still.
 *
 * This script lifts them out of the composite and hangs them again as a **driven
 * animation**: one generated sprite whose own timeline rocks the lantern about the
 * point its stem meets the branch, placed straight into the room three times.
 *
 * ## Why it is built this way
 *
 * `Level`'s room walk (Level.as:4133) hands a room child to the scenery system only
 * when `getQualifiedClassName(child)` starts with `a_Animation`, and that system -
 * `class_123.method_625` - is the only thing that runs a level animation's timeline.
 * It builds a `GfxType` whose `animClass` is that very class name and whose `var_29`
 * is the level's own file, so the artwork is resolved back out of LevelsSRN.swf by
 * class name. Three consequences shape everything below:
 *
 *   - **It has to be a room child.** Anything inside the decor composite is never
 *     offered to the scenery system, which is exactly why the lanterns are still.
 *   - **One class draws one thing.** All three lanterns share this class, so they
 *     share the artwork and the motion. `method_625` also sets
 *     `bRandomFrameStart`, so each instance starts on a frame of its own and the
 *     three do not swing in lockstep.
 *   - **The class must already exist.** `swfLevelUtils` renames ABC strings; it
 *     cannot mint a class. All four `a_Animation*` classes LevelsSRN.swf ships are
 *     spoken for - `a_Animation_Smoke1` became `a_Door_108`, and `Portal`,
 *     `Smoke2` and `PortaAngled` drive the rift, the besom flames and the wisps -
 *     so this one is renamed out of `a_ParallaxSwampMoss1`.
 *
 * ### Why `a_ParallaxSwampMoss1` is safe to take
 *
 * A donor has to be a MovieClip (a renamed `ac_*` cue would still be `a_Cue`, and
 * Level tests `child is a_Cue` *before* it looks at the name, so a cue can never
 * reach the scenery system) and it has to be one **no named placement depends on**.
 * That second half is the real trap: Flash writes a typed member for every named
 * instance - `public var am_X:a_SharedTrees1` - and `__setProp` assigns straight
 * through it, so rebinding a class out from under a named placement is a TypeError
 * at room construction.
 *
 * `a_ParallaxSwampMoss1` has exactly one placement in the whole file, unnamed, in
 * `a_Room_SRConnS1`, and its character is a one-frame sprite holding a single
 * unnamed child - no typed member, no frame script, nothing generated. Losing its
 * class costs that moss nothing: an unbound child keeps its placement and is drawn
 * exactly where it was, and static art is all it ever was. Parallax itself is
 * chosen by *instance* name (`class_123.const_862` is `"am_Parallax"`, matched
 * against `child.name`), never by class, so the name it carries is inert.
 *
 * ## The swing
 *
 * `a_PumpkinHead` is drawn upward from a floor origin - x -51.1..51.1, y -102.55..0
 * - so the top of the art is the stem, and that is the pivot. Every frame rotates
 * both parts about it by `SWING_DEGREES * sin(2 pi f / SWING_FRAMES)`, which is a
 * pendulum: fastest through the bottom, still at each end.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-pumpkin-swing.ts [--verify]
 *
 * Re-runnable: it looks for its own class and does nothing if the lanterns already
 * swing.
 */
import * as path from "path";
import {
  Matrix,
  SwfFile,
  SwfLevelError,
  SwfTag,
  appendCharacterTag,
  characterBounds,
  encodeMatrix,
  encodeTag,
  ensureBackup,
  maxCharacterId,
  parsePlace,
  readSwfFile,
  readSymbolClasses,
  rebuildSprite,
  renameAbcStrings,
  spriteInnerTags,
  writeSwfFile,
  writeSymbolClasses,
  TAG_DEFINE_SPRITE,
  TAG_END,
  TAG_PLACE_OBJECT2,
  TAG_PLACE_OBJECT3,
  TAG_SHOW_FRAME,
} from "./swfLevelUtils";
import { HALLOWS_EVE_DOOR_ID } from "./patch-levelssrn-hallows-eve";

const SRN_SWF = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "LevelsSRN.swf");
const PETS_SWF = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "Animation_Pets.swf");

const HOST_ROOM = "a_Room_SRN04";
const DOOR_CLASS = `a_Door_${HALLOWS_EVE_DOOR_ID}`;

/** The class the swinging lantern is published under. Must start with `a_Animation`. */
const SWING_CLASS = "a_Animation_PumpkinSwing";

/**
 * The class it is renamed out of. See the file comment for why this one.
 *
 * Its character keeps every byte it has; all it loses is the AS3 class nothing was
 * using, so the moss in `a_Room_SRConnS1` is drawn exactly as before.
 */
const DONOR_CLASS = "a_ParallaxSwampMoss1";

/** The classes the two halves of a lit lantern are exported under in Animation_Pets.swf. */
const GOURD_CLASS = "a_PumpkinHead";
const FACE_CLASS = "a_PumpkinFace";

/**
 * How far the lantern leans, in degrees, at each end of its swing.
 *
 * Small on purpose. These hang on a dead branch in the background of a town square;
 * anything past about ten degrees stops reading as a lantern stirring in the wind
 * and starts reading as one being pushed.
 */
const SWING_DEGREES = 7;

/**
 * Frames in one full there-and-back swing.
 *
 * LevelsSRN.swf runs at 30fps, so 48 frames is a hair over a second and a half per
 * cycle - the pace of something heavy on a short stem.
 */
const SWING_FRAMES = 48;

/** Depths inside the generated sprite. The face is drawn over the gourd. */
const GOURD_DEPTH = 1;
const FACE_DEPTH = 2;

/** Where the room places the square's still dressing; `patch-levelssrn-hallows-eve.ts` owns it. */
const DECOR_DEPTH = 234;

/** The first free depth for a room child. The scenery system relayers these anyway. */
const ANIMATED_BASE_DEPTH = 240;

interface Lantern {
  x: number;
  y: number;
  scale: number;
}

/**
 * Where the three lanterns hang, in room-local pixels, by the point their stem meets
 * the branch - which is also what the sprite rotates about.
 *
 * **These are branch ends, read off the tree's own outline.** The tree is its own
 * character (1932, a `DefineShape`) inside the imported scene, placed through
 * `[-0.5318 -0.1840; -0.1840 0.5318] + (422.9, 80.35)` and then the scene's own 2.15
 * and (-76.5, -649.85) - so its outline maps to room-local
 * `x = -1.1433 sx - 0.3955 sy + 832.7`, `y = -0.3955 sx + 1.1433 sy - 477.1`, and it
 * covers room-local 643..1054 across and -695..-233 up. Walking that outline for
 * points that are a local maximum of distance from the trunk gives every twig end in
 * the crown; these are the three that hang clear of other branches and read as
 * lanterns tied to the outer twigs rather than as gourds resting on wood.
 *
 * They were laid out this way in the first place - the build script hung them at
 * (790, -470), (880, -525) and (965, -430), which is the fork of the trunk, so all
 * three sat on thick branch mass.
 *
 * **Two things bound where they can go, and both are learned the hard way.**
 *
 *   - **Height.** The crown's own tips are up at -690..-609, and lanterns hung there
 *     are off the top of the screen in play - the camera sits on a player standing at
 *     floor level, room-local -80. The band the square was dressed in, about -560 up
 *     to -420, is the one that is actually looked at, so a tip only counts if it is
 *     in it. That rules out the whole upper crown.
 *   - **1020 is the right-hand wall.** The scene composite is masked (`RUINS_MASK`),
 *     so the tree is simply not drawn past that and a lantern hung off a twig beyond
 *     it would hang on nothing. The rightmost point here is 969.
 *
 * The scales are the ones the square was dressed with, kept so the three still read
 * as three different lanterns.
 */
export const SWING_POINTS: Lantern[] = [
  { x: 680, y: -476, scale: 0.62 },
  { x: 876, y: -512, scale: 0.56 },
  { x: 969, y: -444, scale: 0.6 },
];

/** A placement carrying a full matrix - `buildPlaceObject2` cannot express rotation. */
function placeWithMatrix(depth: number, charId: number, matrix: Matrix): SwfTag {
  const head = Buffer.alloc(5);
  head.writeUInt8(0x02 | 0x04, 0);
  head.writeUInt16LE(depth, 1);
  head.writeUInt16LE(charId, 3);
  return { code: TAG_PLACE_OBJECT2, data: Buffer.concat([head, encodeMatrix(matrix)]) };
}

/** The same, as a move: it re-matrices whatever already stands on `depth`. */
function moveWithMatrix(depth: number, matrix: Matrix): SwfTag {
  const head = Buffer.alloc(3);
  head.writeUInt8(0x01 | 0x04, 0);
  head.writeUInt16LE(depth, 1);
  return { code: TAG_PLACE_OBJECT2, data: Buffer.concat([head, encodeMatrix(matrix)]) };
}

/**
 * The matrix that puts a part drawn at `point` where a rotation of `radians` about
 * `pivot` would leave it.
 *
 * Flash applies `[a c; b d]` and then the translation, so a rotation is
 * `a = d = cos`, `b = sin`, `c = -sin`, and the translation is whatever carries the
 * part's own origin to its rotated position.
 */
function rotateAbout(point: { x: number; y: number }, pivot: { x: number; y: number }, radians: number): Matrix {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const dx = point.x - pivot.x;
  const dy = point.y - pivot.y;
  return {
    scaleX: cos,
    scaleY: cos,
    rotateSkew0: sin,
    rotateSkew1: -sin,
    translateX: Math.round((pivot.x + cos * dx - sin * dy) * 20),
    translateY: Math.round((pivot.y + sin * dx + cos * dy) * 20),
  };
}

/** Bounds in pixels, for matching an imported character back to the art it came from. */
function boundsKey(swf: SwfFile, charId: number): string {
  const bounds = characterBounds(swf, charId);
  if (!bounds) return `none`;
  return `${bounds.xMin},${bounds.xMax},${bounds.yMin},${bounds.yMax}`;
}

function spriteIndexFor(swf: SwfFile, charId: number): number {
  const index = swf.tags.findIndex((tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === charId);
  if (index === -1) throw new SwfLevelError(`character ${charId} is not a sprite`);
  return index;
}

/**
 * The lantern halves as they were imported into LevelsSRN.swf.
 *
 * The import renumbers everything and binds none of it, so the copies cannot be
 * found by class or by id. They are matched by their bounds instead, read out of
 * `Animation_Pets.swf` - which is exactly as stable as the artwork itself, and
 * fails loudly rather than quietly picking the wrong sprite.
 */
function findLanternParts(srn: SwfFile, composite: number): { gourd: number; face: number } {
  const pets = readSwfFile(PETS_SWF);
  const petSymbols = readSymbolClasses(pets);
  const wanted = new Map<string, string>();
  for (const className of [GOURD_CLASS, FACE_CLASS]) {
    const binding = petSymbols.find((entry) => entry.name === className);
    if (!binding) throw new SwfLevelError(`${path.basename(PETS_SWF)} has no ${className}`);
    wanted.set(className, boundsKey(pets, binding.id));
  }

  const found = new Map<string, Set<number>>();
  for (const tag of spriteInnerTags(srn.tags[spriteIndexFor(srn, composite)])) {
    if (tag.code !== TAG_PLACE_OBJECT2 && tag.code !== TAG_PLACE_OBJECT3) continue;
    const place = parsePlace(tag);
    if (place.charId === null) continue;
    const key = boundsKey(srn, place.charId);
    for (const [className, wantedKey] of wanted) {
      if (key !== wantedKey) continue;
      const ids = found.get(className) ?? new Set<number>();
      ids.add(place.charId);
      found.set(className, ids);
    }
  }

  const single = (className: string): number => {
    const ids = [...(found.get(className) ?? [])];
    if (ids.length !== 1) {
      throw new SwfLevelError(`expected one ${className} character in the decor composite, found ${ids.length}`);
    }
    return ids[0];
  };
  return { gourd: single(GOURD_CLASS), face: single(FACE_CLASS) };
}

/**
 * Takes the still lanterns out of the decor composite and reports where they hung.
 *
 * The face is dropped with the gourd it belongs to: `patch-levelssrn-hallows-eve.ts`
 * writes the pair together, gourd first, and the generated sprite carries its own
 * face from here on.
 */
function liftLanterns(srn: SwfFile, composite: number, parts: { gourd: number; face: number }): Lantern[] {
  const index = spriteIndexFor(srn, composite);
  const inner = spriteInnerTags(srn.tags[index]);
  const lanterns: Lantern[] = [];
  const kept: SwfTag[] = [];
  for (const tag of inner) {
    if (tag.code !== TAG_PLACE_OBJECT2 && tag.code !== TAG_PLACE_OBJECT3) {
      kept.push(tag);
      continue;
    }
    const place = parsePlace(tag);
    if (place.charId === parts.gourd && place.matrix) {
      lanterns.push({
        x: place.matrix.translateX / 20,
        y: place.matrix.translateY / 20,
        scale: place.matrix.scaleX,
      });
      continue;
    }
    if (place.charId === parts.face) continue;
    kept.push(tag);
  }
  if (lanterns.length === 0) throw new SwfLevelError("the decor composite carries no jack-o'-lanterns");
  srn.tags[index] = rebuildSprite(srn.tags[index], kept);
  return lanterns;
}

/**
 * The swinging lantern itself: one sprite, `SWING_FRAMES` frames long.
 *
 * Frame one places both parts; every frame after it moves them, so the file carries
 * two matrices per frame and nothing else.
 */
function buildSwingSprite(id: number, parts: { gourd: number; face: number }, faceOffset: { x: number; y: number }, pivot: { x: number; y: number }): SwfTag {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(id, 0);
  head.writeUInt16LE(SWING_FRAMES, 2);

  const inner: Buffer[] = [head];
  for (let frame = 0; frame < SWING_FRAMES; frame += 1) {
    const radians = ((SWING_DEGREES * Math.PI) / 180) * Math.sin((2 * Math.PI * frame) / SWING_FRAMES);
    const gourd = rotateAbout({ x: 0, y: 0 }, pivot, radians);
    const face = rotateAbout(faceOffset, pivot, radians);
    inner.push(
      encodeTag(frame === 0 ? placeWithMatrix(GOURD_DEPTH, parts.gourd, gourd) : moveWithMatrix(GOURD_DEPTH, gourd)),
      encodeTag(frame === 0 ? placeWithMatrix(FACE_DEPTH, parts.face, face) : moveWithMatrix(FACE_DEPTH, face)),
      encodeTag({ code: TAG_SHOW_FRAME, data: Buffer.alloc(0) }),
    );
  }
  inner.push(encodeTag({ code: TAG_END, data: Buffer.alloc(0) }));
  return { code: TAG_DEFINE_SPRITE, data: Buffer.concat(inner) };
}

/**
 * Puts lanterns that are already hanging back on the points `SWING_POINTS` names.
 *
 * The install below only happens once - the class can only be renamed out of its
 * donor once - so moving a lantern afterwards has to be an edit, the same way
 * `patch-levelssrn-hallows-eve-portal-align.ts` re-seats the rift. Every placement of
 * the swinging character is rewritten from the table, in the order the table gives,
 * which makes this equivalent to a fresh install and a no-op on a file already on
 * target.
 */
function reseat(srn: SwfFile, roomIndex: number, swingId: number, verify: boolean): boolean {
  const inner = spriteInnerTags(srn.tags[roomIndex]);
  const onTarget: boolean[] = [];
  let seen = 0;
  const rewritten = inner.map((tag) => {
    if (tag.code !== TAG_PLACE_OBJECT2 && tag.code !== TAG_PLACE_OBJECT3) return tag;
    const place = parsePlace(tag);
    if (place.charId !== swingId) return tag;
    const target = SWING_POINTS[seen];
    seen += 1;
    if (!target) throw new SwfLevelError(`${HOST_ROOM} hangs more lanterns than SWING_POINTS names`);
    const at = place.matrix;
    onTarget.push(
      at !== null &&
        Math.abs(at.translateX / 20 - target.x) < 0.05 &&
        Math.abs(at.translateY / 20 - target.y) < 0.05 &&
        Math.abs(at.scaleX - target.scale) < 0.005,
    );
    return placeWithMatrix(place.depth, swingId, {
      scaleX: target.scale,
      scaleY: target.scale,
      rotateSkew0: 0,
      rotateSkew1: 0,
      translateX: Math.round(target.x * 20),
      translateY: Math.round(target.y * 20),
    });
  });
  if (seen !== SWING_POINTS.length) {
    throw new SwfLevelError(`${HOST_ROOM} hangs ${seen} lanterns; SWING_POINTS names ${SWING_POINTS.length}`);
  }
  if (onTarget.every(Boolean)) {
    console.log("the lanterns already hang on the branch ends - nothing to move.");
    return false;
  }
  for (const [index, point] of SWING_POINTS.entries()) {
    console.log(`  lantern ${index + 1} -> (${point.x}, ${point.y}) x${point.scale}${onTarget[index] ? " (already)" : ""}`);
  }
  if (!verify) srn.tags[roomIndex] = rebuildSprite(srn.tags[roomIndex], rewritten);
  return true;
}

function main(): void {
  const verify = process.argv.includes("--verify");
  const srn = readSwfFile(SRN_SWF);
  const symbols = readSymbolClasses(srn);

  if (!symbols.some((entry) => entry.name === DOOR_CLASS)) {
    throw new SwfLevelError(
      `${path.basename(SRN_SWF)} does not carry the Hallow's Eve square yet (${DOOR_CLASS} is unbound); ` +
        `run patch-levelssrn-hallows-eve.ts first`,
    );
  }

  const hostRoom = symbols.find((entry) => entry.name === HOST_ROOM);
  if (!hostRoom) throw new SwfLevelError(`LevelsSRN.swf has no ${HOST_ROOM} symbol`);

  const hung = symbols.find((entry) => entry.name === SWING_CLASS);
  if (hung) {
    // Already installed, so this run is only about where they hang.
    if (!reseat(srn, spriteIndexFor(srn, hostRoom.id), hung.id, verify) || verify) {
      if (verify) console.log("verify only - no file written.");
      return;
    }
    ensureBackup(SRN_SWF);
    writeSwfFile(SRN_SWF, srn);
    console.log(`wrote ${SRN_SWF}`);
    return;
  }

  const donor = symbols.find((entry) => entry.name === DONOR_CLASS);
  if (!donor) throw new SwfLevelError(`LevelsSRN.swf has no ${DONOR_CLASS} to rename`);

  const room = symbols.find((entry) => entry.name === HOST_ROOM);
  if (!room) throw new SwfLevelError(`LevelsSRN.swf has no ${HOST_ROOM} symbol`);
  const roomIndex = spriteIndexFor(srn, room.id);

  const decor = spriteInnerTags(srn.tags[roomIndex])
    .filter((tag) => tag.code === TAG_PLACE_OBJECT2 || tag.code === TAG_PLACE_OBJECT3)
    .map((tag) => parsePlace(tag))
    .find((place) => place.depth === DECOR_DEPTH);
  if (!decor || decor.charId === null) {
    throw new SwfLevelError(`${HOST_ROOM} has nothing on depth ${DECOR_DEPTH}; the square is not dressed`);
  }

  const parts = findLanternParts(srn, decor.charId);
  const gourdBounds = characterBounds(srn, parts.gourd);
  if (!gourdBounds) throw new SwfLevelError(`character ${parts.gourd} has no bounds`);
  // The stem, i.e. the top of the art, centred on the gourd's own origin.
  const pivot = { x: 0, y: gourdBounds.yMin / 20 };

  // Where the carved face sits on the gourd, read off the placements the square
  // already carries rather than restated here.
  const composite = spriteInnerTags(srn.tags[spriteIndexFor(srn, decor.charId)])
    .filter((tag) => tag.code === TAG_PLACE_OBJECT2 || tag.code === TAG_PLACE_OBJECT3)
    .map((tag) => parsePlace(tag));
  const firstGourd = composite.find((place) => place.charId === parts.gourd);
  const firstFace = composite.find((place) => place.charId === parts.face);
  if (!firstGourd?.matrix || !firstFace?.matrix) throw new SwfLevelError("a lantern is missing half of itself");
  const faceOffset = {
    x: (firstFace.matrix.translateX - firstGourd.matrix.translateX) / 20 / firstGourd.matrix.scaleX,
    y: (firstFace.matrix.translateY - firstGourd.matrix.translateY) / 20 / firstGourd.matrix.scaleY,
  };

  const lanterns = liftLanterns(srn, decor.charId, parts);
  console.log(
    `${lanterns.length} lanterns lifted out of the decor composite: ` +
      lanterns.map((l) => `(${l.x}, ${l.y}) x${l.scale.toFixed(2)}`).join(", "),
  );
  if (lanterns.length !== SWING_POINTS.length) {
    throw new SwfLevelError(
      `the square hangs ${lanterns.length} lanterns but SWING_POINTS names ${SWING_POINTS.length}`,
    );
  }
  console.log(`rehung on the branch ends: ` + SWING_POINTS.map((p) => `(${p.x}, ${p.y}) x${p.scale}`).join(", "));
  console.log(
    `swing: ${SWING_FRAMES} frames, +/-${SWING_DEGREES} degrees about (${pivot.x}, ${pivot.y}), ` +
      `face at (${faceOffset.x.toFixed(1)}, ${faceOffset.y.toFixed(1)})`,
  );
  if (verify) {
    console.log(`verify only - would bind ${DONOR_CLASS} -> ${SWING_CLASS} and place ${lanterns.length} room children`);
    return;
  }

  const swingId = maxCharacterId(srn) + 1;
  appendCharacterTag(srn, buildSwingSprite(swingId, parts, faceOffset, pivot));

  // Room children, one per lantern, on the branch ends `SWING_POINTS` names. Their
  // depths are placeholders - a child the scenery system takes is hidden where it
  // stands and redrawn on a layer of its own choosing.
  const roomTag = srn.tags[roomIndex];
  const inner = spriteInnerTags(roomTag);
  const showFrameIndex = inner.findIndex((tag) => tag.code === TAG_SHOW_FRAME);
  const insertAt = showFrameIndex === -1 ? inner.length - 1 : showFrameIndex;
  inner.splice(
    insertAt,
    0,
    ...SWING_POINTS.map((lantern, index) =>
      placeWithMatrix(ANIMATED_BASE_DEPTH + index, swingId, {
        scaleX: lantern.scale,
        scaleY: lantern.scale,
        rotateSkew0: 0,
        rotateSkew1: 0,
        translateX: Math.round(lantern.x * 20),
        translateY: Math.round(lantern.y * 20),
      }),
    ),
  );
  srn.tags[roomIndex] = rebuildSprite(roomTag, inner);

  const renamed = renameAbcStrings(srn, new Map([[DONOR_CLASS, SWING_CLASS]]));
  if (renamed === 0) throw new SwfLevelError(`${DONOR_CLASS} is not in the ABC string pool`);
  writeSymbolClasses(
    srn,
    symbols.map((entry) => (entry.name === DONOR_CLASS ? { id: swingId, name: SWING_CLASS } : entry)),
  );
  console.log(`${DONOR_CLASS} -> ${SWING_CLASS}, bound to character ${swingId} (${renamed} ABC string(s) renamed)`);

  ensureBackup(SRN_SWF);
  writeSwfFile(SRN_SWF, srn);
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
