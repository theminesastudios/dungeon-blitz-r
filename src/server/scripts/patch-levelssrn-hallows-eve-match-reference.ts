/**
 * Pulls the square back to the event's own artwork.
 *
 * The reference is the Hallow's Eve panel illustration - the same drawing this square
 * was built out of (`UI_Seasonal.swf` character 60). Laid side by side with what the
 * square had grown into, four things differ, and this patch settles all four:
 *
 *   - **No lanterns in the bare tree.** Five swinging ones had accumulated there.
 *   - **No lanterns on the railing.** Four were spiked on it.
 *   - **Two jack-o'-lanterns on the ground, bottom left**, sitting in the grass to the
 *     left of the tower - the only pumpkins the drawing has.
 *   - **Three cobwebs around the tower**: a tall one hanging from the jaw of the skull
 *     on its left, and two smaller ones off its right shoulder. The three that had
 *     been strung in the tree come out.
 *
 * The four green skull lanterns stay lit: every one of them glows in the drawing, and
 * their light is not decoration - the scene's art leaves a gap where each lamp sits
 * and the light is what fills it. With it off you see the room's own grass through the
 * gap, which is the dark patch that chased us for three rounds. See
 * `patch-levelssrn-hallows-eve-relight-lanterns.ts`.
 *
 * ## Reading positions off the drawing
 *
 * Two landmarks tie the illustration to room-local pixels: the rift's middle, which
 * the room puts at (367, -243), and the left edge of the skull wall's grid at 747.
 * In the reference those sit 655 and 1140 pixels across, so the drawing runs at 1.276
 * of a room pixel, and everything else is read through
 * `room = 367 + (image - 655) / 1.276`.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-match-reference.ts
 *          [--verify] [--out <swf>]
 *
 * Re-runnable: each of the four steps checks for its own result first.
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
  repointPlacement,
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
const DECOR_DEPTH = 234;
const FENCE_INSTANCE = "am_Foreground_1";
const FENCE_MIN_WIDTH = 1000;

/** Where the carved face sits on the gourd, in the gourd's own pixels. */
const FACE_OFFSET = { x: 12.9, y: -7.1 };

/**
 * The two jack-o'-lanterns the drawing has, on the grass left of the tower.
 *
 * They stand on the floor line, and the second is a little smaller and set back so the
 * pair reads as two gourds rather than one mirrored twice.
 */
const GROUND_PUMPKINS = [
  { x: 58, y: -78, scale: 1.0 },
  { x: 142, y: -86, scale: 0.85, flip: true },
];

/**
 * The cobwebs, as the drawing hangs them.
 *
 * The tall one falls from the jaw of the skull on the tower's left - in the reference
 * it runs from about -392 down to -133, which is why it is the narrow web at 1.2 - and
 * the two small ones sit off the tower's right shoulder.
 */
const TOWER_WEBS: Array<{ web: "web" | "webWide"; x: number; y: number; scale: number }> = [
  { web: "web", x: 178, y: -392, scale: 1.2 },
  { web: "webWide", x: 470, y: -437, scale: 0.45 },
  { web: "webWide", x: 545, y: -368, scale: 0.4 },
];

/** The cobwebs this project strung in the tree, by the points they were put on. */
const TREE_WEBS = [
  { x: 700, y: -640 },
  { x: 830, y: -600 },
  { x: 962, y: -560 },
];

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

function sizeOf(swf: SwfFile, charId: number): string {
  const bounds = characterBounds(swf, charId);
  if (!bounds) return "?";
  return `${Math.round((bounds.xMax - bounds.xMin) / 20)}x${Math.round((bounds.yMax - bounds.yMin) / 20)}`;
}

/** The imported props, matched by the size of the art they were imported from. */
function findProps(swf: SwfFile, decorId: number, swingId: number): Record<string, number> {
  const pets = readSwfFile(PETS_SWF);
  const petSymbols = readSymbolClasses(pets);
  const petSize = (className: string): string => {
    const binding = petSymbols.find((entry) => entry.name === className);
    if (!binding) throw new SwfLevelError(`${path.basename(PETS_SWF)} has no ${className}`);
    return sizeOf(pets, binding.id);
  };
  const wanted: Record<string, string> = {
    gourd: petSize("a_PumpkinHead"),
    face: petSize("a_PumpkinFace"),
    web: "108x214",
    webWide: "180x204",
  };
  const found: Record<string, number> = {};
  for (const place of [...placementsOf(swf, decorId), ...placementsOf(swf, swingId)]) {
    if (place.charId === null) continue;
    const size = sizeOf(swf, place.charId);
    for (const [name, wantedSize] of Object.entries(wanted)) {
      if (size === wantedSize && found[name] === undefined) found[name] = place.charId;
    }
  }
  for (const name of Object.keys(wanted)) {
    if (found[name] === undefined) throw new SwfLevelError(`could not find the imported ${name} (${wanted[name]})`);
  }
  return found;
}

function main(): void {
  const argv = process.argv;
  const verify = argv.includes("--verify");
  const outIndex = argv.indexOf("--out");
  const out = outIndex === -1 ? SRN_SWF : path.resolve(argv[outIndex + 1]);

  const swf = readSwfFile(SRN_SWF);
  const symbols = readSymbolClasses(swf);
  const room = symbols.find((entry) => entry.name === HOST_ROOM);
  const swing = symbols.find((entry) => entry.name === "a_Animation_PumpkinSwing");
  if (!room || !swing) throw new SwfLevelError("LevelsSRN.swf is missing the square's own characters");

  const roomIndex = spriteIndexFor(swf, room.id);
  const decor = placementsOf(swf, room.id).find((place) => place.depth === DECOR_DEPTH);
  if (!decor || decor.charId === null) throw new SwfLevelError(`${HOST_ROOM} has no dressing on depth ${DECOR_DEPTH}`);
  const props = findProps(swf, decor.charId, swing.id);

  // ---- the tree, and the railing -------------------------------------------
  const roomInner = spriteInnerTags(swf.tags[roomIndex]);
  let swingsDropped = 0;
  let runsReverted = 0;
  /**
   * The undressed railing run.
   *
   * Every placement in the room points at a dressed variant now, so it cannot be found
   * through them: it is looked up in the file at large as the sprite that holds
   * nothing but the run's two rail tiles. The variants were built as copies of it with
   * the lanterns added, so they hold six.
   */
  const tileChar = (() => {
    const dressed = placementsOf(swf, room.id).find(
      (place) => place.name === FENCE_INSTANCE && place.charId !== null && (characterBounds(swf, place.charId) ?? { xMax: 0, xMin: 0 }).xMax - (characterBounds(swf, place.charId) ?? { xMax: 0, xMin: 0 }).xMin > FENCE_MIN_WIDTH * 20,
    );
    if (!dressed || dressed.charId === null) throw new SwfLevelError(`${HOST_ROOM} has no railing runs`);
    return placementsOf(swf, dressed.charId)[0].charId as number;
  })();
  const plainRun = swf.tags
    .filter((tag) => tag.code === TAG_DEFINE_SPRITE)
    .map((tag) => tag.data.readUInt16LE(0))
    .find((charId) => {
      const places = placementsOf(swf, charId);
      return places.length === 2 && places.every((place) => place.charId === tileChar);
    });

  const roomRebuilt = roomInner
    .filter((tag) => {
      if (tag.code !== TAG_PLACE_OBJECT2 && tag.code !== TAG_PLACE_OBJECT3) return true;
      if (parsePlace(tag).charId !== swing.id) return true;
      swingsDropped += 1;
      return false;
    })
    .map((tag) => {
      if (tag.code !== TAG_PLACE_OBJECT2 && tag.code !== TAG_PLACE_OBJECT3) return tag;
      const place = parsePlace(tag);
      if (place.name !== FENCE_INSTANCE || place.charId === null) return tag;
      const bounds = characterBounds(swf, place.charId);
      if (!bounds || (bounds.xMax - bounds.xMin) / 20 < FENCE_MIN_WIDTH) return tag;
      if (placementsOf(swf, place.charId).length === 2) return tag;
      if (plainRun === undefined) throw new SwfLevelError("no plain railing run left to revert to");
      runsReverted += 1;
      return repointPlacement(tag, plainRun);
    });

  // ---- the dressing: webs out of the tree, webs and gourds where the drawing
  //      puts them -------------------------------------------------------------
  const decorIndex = spriteIndexFor(swf, decor.charId);
  const decorInner = spriteInnerTags(swf.tags[decorIndex]);
  let treeWebsDropped = 0;
  const keptDecor = decorInner.filter((tag) => {
    if (tag.code !== TAG_PLACE_OBJECT2 && tag.code !== TAG_PLACE_OBJECT3) return true;
    const place = parsePlace(tag);
    if (!place.matrix) return true;
    const x = place.matrix.translateX / 20;
    const y = place.matrix.translateY / 20;
    const isTreeWeb = TREE_WEBS.some((web) => Math.abs(web.x - x) < 1 && Math.abs(web.y - y) < 1);
    if (isTreeWeb) treeWebsDropped += 1;
    return !isTreeWeb;
  });

  /**
   * Whether the dressing is there already, asked as "is there a gourd at all".
   *
   * Not "is there a gourd on `GROUND_PUMPKINS[0]`". A later pass reads the same
   * drawing more closely and moves them - `patch-levelssrn-hallows-eve-reference-square.ts`
   * takes them off the hillside and out to the flat grass - and a point test would
   * then see no gourd on its own point and lay a second pair down on top.
   */
  const already = placementsOf(swf, decor.charId).some((place) => place.charId === props.gourd);
  let depth = Math.max(...placementsOf(swf, decor.charId).map((place) => place.depth)) + 1;
  const additions: SwfTag[] = already
    ? []
    : [
        ...TOWER_WEBS.map((web) =>
          buildPlaceObject2({
            depth: depth++,
            charId: props[web.web],
            x: web.x,
            y: web.y,
            scaleX: web.scale,
            scaleY: web.scale,
          }),
        ),
        ...GROUND_PUMPKINS.flatMap((pumpkin) => {
          const scale = pumpkin.scale;
          const flip = "flip" in pumpkin && pumpkin.flip;
          return [
            buildPlaceObject2({
              depth: depth++,
              charId: props.gourd,
              x: pumpkin.x,
              y: pumpkin.y,
              scaleX: flip ? -scale : scale,
              scaleY: scale,
            }),
            buildPlaceObject2({
              depth: depth++,
              charId: props.face,
              x: pumpkin.x + (flip ? -FACE_OFFSET.x : FACE_OFFSET.x) * scale,
              y: pumpkin.y + FACE_OFFSET.y * scale,
              scaleX: flip ? -scale : scale,
              scaleY: scale,
            }),
          ];
        }),
      ];

  console.log(
    `swinging lanterns dropped: ${swingsDropped}   railing runs reverted: ${runsReverted}   ` +
      `tree cobwebs dropped: ${treeWebsDropped}   added: ${additions.length ? `${TOWER_WEBS.length} webs, ${GROUND_PUMPKINS.length} gourds` : "already there"}`,
  );
  if (swingsDropped === 0 && runsReverted === 0 && treeWebsDropped === 0 && additions.length === 0) {
    console.log("the square already matches the reference.");
    return;
  }
  if (verify) {
    console.log("verify only - no file written.");
    return;
  }

  const showFrame = keptDecor.findIndex((tag) => tag.code === TAG_SHOW_FRAME);
  keptDecor.splice(showFrame === -1 ? keptDecor.length - 1 : showFrame, 0, ...additions);
  swf.tags[decorIndex] = rebuildSprite(swf.tags[decorIndex], keptDecor);
  swf.tags[roomIndex] = rebuildSprite(swf.tags[roomIndex], roomRebuilt);

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
