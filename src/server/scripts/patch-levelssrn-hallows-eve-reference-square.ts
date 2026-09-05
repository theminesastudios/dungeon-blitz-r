/**
 * The last four things between the square and the reference drawing.
 *
 * `patch-levelssrn-hallows-eve-match-reference.ts` pulled the tree and the railing
 * back to the artwork. Rendering the room out whole and laying it beside the drawing
 * leaves four differences, all of them props this project added and the drawing does
 * not have - plus one it has in a different place:
 *
 *   - **The cobweb on the mushroom house.** A wide web hung on the trunk at
 *     room-local (1010, -690). It is the big white web in the top right of the
 *     screen; nothing hangs there in the drawing.
 *   - **The cobweb on the far trunk**, at (1980, -700). Same story, further right.
 *   - **The second besom.** A broom was stood against the mushroom house at
 *     (1060, -80) and lit with a green flame - it reads as a scarecrow at that size,
 *     and it is a copy of a prop the scene already carries. The drawing has exactly
 *     one besom, the scene's own at 607, and that one stays lit.
 *   - **The jack-o'-lanterns are too big and too far right.** See `GROUND_PUMPKINS`.
 *
 * ## Reading the drawing
 *
 * Not by eye off a screenshot. `a_Room_SRN04` is exported to PNG with FFDec, which
 * comes out 1:1 against the room's own bounds (x -2523.2..3680.7), so a pixel in that
 * render *is* a room pixel: `room = render + 2523.2`. Two landmarks that appear in
 * both it and the drawing - the skull on the tower's crown and the skull grid on the
 * wall - fix the drawing's scale at 1.284 render pixels to one of its own and give
 * `reference = 1.284 * room + 116.5`. Every number below was read through that.
 *
 * ## What is deliberately left alone
 *
 * - **The scene's own besom and its green flame** (room 607). It is part of character
 *   60 - `patch-levelssrn-hallows-eve-relight-lanterns.ts`'s sibling `stripBesom`
 *   took its frozen flame out and put a live one back - so it belongs to the drawing.
 * - **The four skull lanterns' light.** Their glow is what fills the gap the art
 *   leaves behind each lamp; see `patch-levelssrn-hallows-eve-relight-lanterns.ts`.
 * - **The foreground railing.** The drawing is a render of the scene, which has no
 *   foreground layer at all, so it cannot say what belongs there. The railing is cut
 *   out of the scene's own iron fence and stays.
 * - **The three cobwebs at the tower and the two rift wisps.** Both match already.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-reference-square.ts
 *          [--verify] [--out <swf>]
 *
 * Re-runnable: every step checks for its own result first.
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
const DECOR_DEPTH = 234;

/** How close a placement has to be to one of the points below to count as it. */
const MATCH_TOLERANCE = 2;

/**
 * The props the drawing does not have, by the points they were put on.
 *
 * Read straight out of `DECOR_BACK` in `patch-levelssrn-hallows-eve.ts` - the two
 * treeline cobwebs and the besom by the mushroom house, which that list's own comment
 * calls "the props the square did not carry before".
 */
const EXTRA_DECOR = [
  { what: "cobweb on the mushroom house", x: 1010, y: -690 },
  { what: "cobweb on the far trunk", x: 1980, y: -700 },
  { what: "besom by the mushroom house", x: 1060, y: -80 },
];

/**
 * The green flame that belongs to the besom being taken out.
 *
 * The two flames are `a_Animation_Smoke2` children of the *room* rather than of the
 * dressing composite - they have to be, or the scenery system never drives them and
 * they freeze - so this one cannot come out with the broom above. They are told apart
 * by x: the scene's own besom burns at 583 and stays, this one at 1039.
 */
const HOUSE_FLAME_X = 1039;
const SCENE_FLAME_X = 583.4;

/** Where the carved face sits on the gourd, in the gourd's own pixels. */
const FACE_OFFSET = { x: 12.9, y: -7.1 };

/**
 * The two jack-o'-lanterns, as the drawing sits them - which is not where they were.
 *
 * They were at room 58 and 142 at full size, which puts them **on the hillside and to
 * the right of the picket fence's bottom post**, a foot taller than the skull hanging
 * off the tower. The drawing has them on the flat grass at the very bottom left, past
 * the foot of the hill, small enough to read as dressing:
 *
 *   - Across, they cover reference 25..165, which is room -71..38 - so their centres
 *     are -44 and 14, about 115 pixels left of where they stood.
 *   - Their size is read against the skull on the tower's left, which is 90 room
 *     pixels wide in both pictures. In the drawing a gourd is about seven tenths of
 *     that skull; at full size it was over one and a tenth. Hence 0.62 and 0.55.
 *
 * They keep the floor line they had - the ground is flat from the hill's foot out to
 * the room's left edge - and the second keeps its mirror, so the pair reads as two
 * gourds rather than one drawn twice.
 */
const GROUND_PUMPKINS = [
  { x: -44, y: -78, scale: 0.62, flip: false },
  { x: 14, y: -80, scale: 0.55, flip: true },
];

/** Where the gourds stood before, so an already-patched file can be recognised. */
const OLD_PUMPKIN_X = [58, 142];

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

function pointOf(tag: SwfTag): { x: number; y: number } | null {
  const place = parsePlace(tag);
  if (!place.matrix) return null;
  return { x: place.matrix.translateX / 20, y: place.matrix.translateY / 20 };
}

function near(value: number, wanted: number): boolean {
  return Math.abs(value - wanted) < MATCH_TOLERANCE;
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
  const symbols = readSymbolClasses(swf);
  const room = symbols.find((entry) => entry.name === HOST_ROOM);
  const smoke = symbols.find((entry) => entry.name === "a_Animation_Smoke2");
  if (!room || !smoke) throw new SwfLevelError("LevelsSRN.swf is missing the square's own characters");

  const roomIndex = spriteIndexFor(swf, room.id);
  const decorPlace = placementsOf(swf, room.id).find((place) => place.depth === DECOR_DEPTH);
  if (!decorPlace || decorPlace.charId === null) {
    throw new SwfLevelError(`${HOST_ROOM} has no dressing on depth ${DECOR_DEPTH}`);
  }
  const decorIndex = spriteIndexFor(swf, decorPlace.charId);

  // ---- the two treeline cobwebs and the second besom ------------------------
  const dropped: string[] = [];
  const decorKept = spriteInnerTags(swf.tags[decorIndex]).filter((tag) => {
    if (!isPlace(tag)) return true;
    const point = pointOf(tag);
    if (!point) return true;
    const extra = EXTRA_DECOR.find((entry) => near(point.x, entry.x) && near(point.y, entry.y));
    if (!extra) return true;
    dropped.push(extra.what);
    return false;
  });

  // ---- that besom's flame, out of the room itself ---------------------------
  const shift = sceneOffset(swf, room.id);
  let flameDropped = false;
  const roomInner = spriteInnerTags(swf.tags[roomIndex]);
  const roomKept = roomInner.filter((tag) => {
    if (!isPlace(tag)) return true;
    const place = parsePlace(tag);
    if (place.charId !== smoke.id) return true;
    const point = pointOf(tag);
    if (!point || !near(point.x, HOUSE_FLAME_X + shift)) return true;
    flameDropped = true;
    return false;
  });
  /**
   * The scene's own flame has to still be there afterwards. Taking both out is the
   * one way this step can go wrong quietly - the square would simply lose its fire -
   * so it is checked rather than trusted.
   */
  const sceneFlameSurvives = roomKept.some((tag) => {
    if (!isPlace(tag)) return false;
    const place = parsePlace(tag);
    const point = pointOf(tag);
    return place.charId === smoke.id && point !== null && near(point.x, SCENE_FLAME_X + shift);
  });
  if (!sceneFlameSurvives) throw new SwfLevelError("the scene's own besom flame is gone - refusing to write");

  // ---- the jack-o'-lanterns, back where the drawing sits them ---------------
  const decorPlaces = decorKept.filter(isPlace).map((tag) => parsePlace(tag));
  const gourdChar = (() => {
    const old = decorPlaces.find((place) => place.matrix && OLD_PUMPKIN_X.some((x) => near(place.matrix!.translateX / 20, x)));
    const already = decorPlaces.find(
      (place) => place.matrix && GROUND_PUMPKINS.some((p) => near(place.matrix!.translateX / 20, p.x)),
    );
    return { old: old ?? null, already: already ?? null };
  })();

  let pumpkinTags: SwfTag[] = [];
  let pumpkinDepths: number[] = [];
  let decorFinal = decorKept;
  if (gourdChar.old) {
    /**
     * The four placements move together: gourd, face, gourd, face, in the order the
     * composite already holds them. Their characters and depths are read back off
     * what is there rather than looked up, so this does not need to know which
     * imported character is which.
     */
    const oldTags = decorKept.filter((tag) => {
      if (!isPlace(tag)) return false;
      const point = pointOf(tag);
      return point !== null && OLD_PUMPKIN_X.some((x) => Math.abs(point.x - x) < 16);
    });
    if (oldTags.length !== 4) {
      throw new SwfLevelError(`expected 4 jack-o'-lantern placements, found ${oldTags.length}`);
    }
    const parsed = oldTags.map((tag) => parsePlace(tag));
    pumpkinDepths = parsed.map((place) => place.depth);
    pumpkinTags = GROUND_PUMPKINS.flatMap((pumpkin, index) => {
      const gourd = parsed[index * 2];
      const face = parsed[index * 2 + 1];
      const sign = pumpkin.flip ? -1 : 1;
      return [
        buildPlaceObject2({
          depth: gourd.depth,
          charId: gourd.charId as number,
          x: pumpkin.x,
          y: pumpkin.y,
          scaleX: sign * pumpkin.scale,
          scaleY: pumpkin.scale,
        }),
        buildPlaceObject2({
          depth: face.depth,
          charId: face.charId as number,
          x: pumpkin.x + sign * FACE_OFFSET.x * pumpkin.scale,
          y: pumpkin.y + FACE_OFFSET.y * pumpkin.scale,
          scaleX: sign * pumpkin.scale,
          scaleY: pumpkin.scale,
        }),
      ];
    });
    let next = 0;
    decorFinal = decorKept.map((tag) => {
      if (!isPlace(tag)) return tag;
      const point = pointOf(tag);
      if (point === null) return tag;
      if (!OLD_PUMPKIN_X.some((x) => Math.abs(point.x - x) < 16)) return tag;
      return pumpkinTags[next++];
    });
  }

  const moved = pumpkinTags.length > 0;
  console.log(
    `dropped: ${dropped.length ? dropped.join(", ") : "none"}   ` +
      `besom flame: ${flameDropped ? "dropped" : "already gone"}   ` +
      `jack-o'-lanterns: ${moved ? `reseated on depths ${pumpkinDepths.join(", ")}` : gourdChar.already ? "already on the drawing's points" : "not found"}`,
  );
  if (dropped.length === 0 && !flameDropped && !moved) {
    console.log("the square already matches the reference.");
    return;
  }
  if (verify) {
    console.log("verify only - no file written.");
    return;
  }

  swf.tags[decorIndex] = rebuildSprite(swf.tags[decorIndex], decorFinal);
  swf.tags[roomIndex] = rebuildSprite(swf.tags[roomIndex], roomKept);

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
