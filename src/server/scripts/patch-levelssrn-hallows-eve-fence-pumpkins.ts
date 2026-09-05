/**
 * Spikes jack-o'-lanterns on the square's iron railing.
 *
 * The railing the player looks through is four `am_Foreground_1` runs of one
 * character - two cropped rail tiles side by side - lifted into the scenery
 * foreground so it always draws over everything. A lantern placed anywhere else in
 * the room would therefore be drawn *behind* it, which reads as a pumpkin sitting in
 * a field behind a fence rather than one pushed down onto a spike.
 *
 * So the lanterns go **inside the run**, on a depth above the tiles. Everything then
 * follows from one detail: the run is drawn as a single layer, so a lantern covers the
 * spike wherever the two overlap. Seat it a little way *below* the spike's point and
 * the point stands proud of the gourd - which is exactly the read wanted, the iron
 * coming out of the top. `TIP_CLEARANCE` is that gap.
 *
 * ## Where the spikes are
 *
 * Read off the artwork rather than guessed, and the guess was wrong twice over. Each
 * run holds two tiles of the cropped rail at x -443.4 and -184, scaled 2.857, so a tile
 * is 259.4 wide and carries four spikes - but their points are neither on the top edge
 * of the crop nor level with one another. `SPIKES` carries what walking the scene's
 * own shapes inside the crop actually returns.
 *
 * ## Why two variants
 *
 * A run is 591 room pixels wide and the four placements repeat the same character. One
 * set of lanterns would therefore repeat on a 591-pixel beat, which the eye picks up
 * immediately across a screen that shows two runs at a time. `VARIANTS` gives two
 * different pairs of spikes and the runs alternate between them, so the beat is 1182
 * and the spacing along the fence reads as irregular: in the square itself the
 * lanterns land at room x 167, 466, 686 and 991.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-fence-pumpkins.ts
 *          [--verify] [--out <swf>]
 *
 * Re-runnable: it checks whether the runs still share one character.
 */
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
  appendCharacterTag,
  buildPlaceObject2,
  characterBounds,
  encodeTag,
  ensureBackup,
  maxCharacterId,
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
const FENCE_INSTANCE = "am_Foreground_1";
/** Only the railing runs, not the empty marker sprites that share the instance name. */
const FENCE_MIN_WIDTH = 1000;

/** How wide a tile is, in run pixels, and how many the run holds. */
const TILE_WIDTH = 259.4;
const TILES_PER_RUN = 2;

/**
 * Every spike point in a tile, in run pixels.
 *
 * **Measured, not assumed.** The tile is a masked window - `char 2016` clips a scene
 * placed at (-635.4, -221) to x 0..90.8, y -34..0 - so the crop maps to the scene's
 * own 635.4..726.2 / 187..221. Walking the scene's shapes for the topmost drawn point
 * in each quarter of that box gives the four points; the tile's placement (x, 226.7,
 * scale 2.857) puts them here.
 *
 * **The four are not level with each other** - the fence is drawn with 13 pixels of
 * wobble between the shortest spike and the tallest - and a single average height is
 * what buried the first attempt: a gourd seated for the high spikes swallowed the
 * points of the low ones whole. Each lantern is seated on its own point.
 */
const SPIKES = [
  { x: -410.8, y: 133.0 },
  { x: -341.3, y: 145.8 },
  { x: -283.7, y: 132.3 },
  { x: -217.6, y: 140.4 },
];

/**
 * How much of the spike is left showing above the gourd.
 *
 * About the height of the arrow head, so what stands proud reads as the point that
 * went through rather than as a stray sliver of iron.
 */
const TIP_CLEARANCE = 18;

/** The lantern's size inside the run. The run itself is then placed at 1.14. */
const PUMPKIN_SCALE = 0.55;

/** How tall the gourd is drawn, upward from its own origin. */
const GOURD_HEIGHT = 102.55;

/** Where the carved face sits on the gourd, in the gourd's own pixels. */
const FACE_OFFSET = { x: 12.9, y: -7.1 };

/**
 * Which spikes each variant carries, counted from the run's left-hand end.
 *
 * Two per run: a third crowds them, and the fence is meant to read as a fence with
 * lanterns on it rather than as a row of lanterns.
 */
const VARIANTS: number[][] = [
  [1, 6],
  [2, 5],
];

/** A spike's point, in run pixels. The run holds `TILES_PER_RUN` copies of the tile. */
function spikeAt(index: number): { x: number; y: number } {
  const spike = SPIKES[index % SPIKES.length];
  return { x: spike.x + TILE_WIDTH * Math.floor(index / SPIKES.length), y: spike.y };
}

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
  if (!bounds) throw new SwfLevelError(`character ${charId} has no bounds`);
  return `${Math.round((bounds.xMax - bounds.xMin) / 20)}x${Math.round((bounds.yMax - bounds.yMin) / 20)}`;
}

/**
 * The imported lantern halves, matched by the size of the art they came from.
 *
 * They carry no class and their ids moved when they were imported, so there is
 * nothing else to find them by. They live in the swinging lantern now - the swing
 * patch lifted them out of the still composite.
 */
function findLantern(swf: SwfFile): { gourd: number; face: number } {
  const pets = readSwfFile(PETS_SWF);
  const petSymbols = readSymbolClasses(pets);
  const wanted = (className: string): string => {
    const binding = petSymbols.find((entry) => entry.name === className);
    if (!binding) throw new SwfLevelError(`${path.basename(PETS_SWF)} has no ${className}`);
    return sizeOf(pets, binding.id);
  };
  const gourdSize = wanted("a_PumpkinHead");
  const faceSize = wanted("a_PumpkinFace");

  const swing = readSymbolClasses(swf).find((entry) => entry.name === "a_Animation_PumpkinSwing");
  if (!swing) throw new SwfLevelError("LevelsSRN.swf has no a_Animation_PumpkinSwing; run the swing patch first");

  let gourd: number | null = null;
  let face: number | null = null;
  for (const place of placementsOf(swf, swing.id)) {
    if (place.charId === null) continue;
    const size = sizeOf(swf, place.charId);
    if (size === gourdSize && gourd === null) gourd = place.charId;
    if (size === faceSize && face === null) face = place.charId;
  }
  if (gourd === null || face === null) throw new SwfLevelError("could not find the imported lantern halves");
  return { gourd, face };
}

function main(): void {
  const argv = process.argv;
  const verify = argv.includes("--verify");
  const outIndex = argv.indexOf("--out");
  const out = outIndex === -1 ? SRN_SWF : path.resolve(argv[outIndex + 1]);

  const swf = readSwfFile(SRN_SWF);
  const symbols = readSymbolClasses(swf);
  const room = symbols.find((entry) => entry.name === HOST_ROOM);
  if (!room) throw new SwfLevelError(`LevelsSRN.swf has no ${HOST_ROOM}`);

  const roomIndex = spriteIndexFor(swf, room.id);
  const runs = spriteInnerTags(swf.tags[roomIndex])
    .map((tag) => ({ tag, place: tag.code === TAG_PLACE_OBJECT2 || tag.code === TAG_PLACE_OBJECT3 ? parsePlace(tag) : null }))
    .filter(({ place }) => {
      if (!place || place.name !== FENCE_INSTANCE || place.charId === null) return false;
      const bounds = characterBounds(swf, place.charId);
      return Boolean(bounds && (bounds.xMax - bounds.xMin) / 20 >= FENCE_MIN_WIDTH);
    });
  if (runs.length === 0) throw new SwfLevelError(`${HOST_ROOM} has no railing runs`);

  const runChars = new Set(runs.map(({ place }) => place!.charId as number));
  if (runChars.size > 1) {
    console.log(`the runs already use ${runChars.size} characters - the lanterns are on.`);
    return;
  }
  const runChar = [...runChars][0];
  const lantern = findLantern(swf);
  console.log(`railing run character ${runChar} x${runs.length}; lantern ${lantern.gourd}/${lantern.face}`);

  for (const [index, run] of runs.entries()) {
    const spikes = VARIANTS[index % VARIANTS.length];
    const place = run.place!;
    const at = spikes
      .map((spike) => (place.matrix!.translateX / 20 + spikeAt(spike).x * place.matrix!.scaleX).toFixed(0))
      .join(", ");
    console.log(`  run on depth ${place.depth}: variant ${index % VARIANTS.length} - lanterns at room x ${at}`);
  }
  if (verify) {
    console.log(`verify only - would build ${VARIANTS.length} run variants`);
    return;
  }

  // One character per variant: the run's own tiles, then the lanterns over them.
  const runInner = spriteInnerTags(swf.tags[spriteIndexFor(swf, runChar)]);
  const tileDepths = placementsOf(swf, runChar).map((place) => place.depth);
  const variantChars = VARIANTS.map((spikes) => {
    const id = maxCharacterId(swf) + 1;
    let depth = Math.max(...tileDepths) + 1;
    const lanterns = spikes.flatMap((spike) => {
      const { x, y: tipY } = spikeAt(spike);
      // Seated on its own point, so that point clears the gourd by `TIP_CLEARANCE`.
      const y = tipY + TIP_CLEARANCE + GOURD_HEIGHT * PUMPKIN_SCALE;
      return [
        buildPlaceObject2({ depth: depth++, charId: lantern.gourd, x, y, scaleX: PUMPKIN_SCALE, scaleY: PUMPKIN_SCALE }),
        buildPlaceObject2({
          depth: depth++,
          charId: lantern.face,
          x: x + FACE_OFFSET.x * PUMPKIN_SCALE,
          y: y + FACE_OFFSET.y * PUMPKIN_SCALE,
          scaleX: PUMPKIN_SCALE,
          scaleY: PUMPKIN_SCALE,
        }),
      ];
    });
    const head = Buffer.alloc(4);
    head.writeUInt16LE(id, 0);
    head.writeUInt16LE(1, 2);
    // Before the ShowFrame, or the lanterns land on a second frame the sprite is one
    // frame too short to ever reach - drawn nowhere, with nothing to say why.
    const inner = [...runInner];
    const showFrame = inner.findIndex((tag) => tag.code === TAG_SHOW_FRAME);
    inner.splice(showFrame === -1 ? inner.length - 1 : showFrame, 0, ...lanterns);
    appendCharacterTag(swf, {
      code: TAG_DEFINE_SPRITE,
      data: Buffer.concat([head, ...inner.map(encodeTag)]),
    });
    return id;
  });

  let seen = 0;
  const rebuilt = spriteInnerTags(swf.tags[roomIndex]).map((tag) => {
    if (tag.code !== TAG_PLACE_OBJECT2 && tag.code !== TAG_PLACE_OBJECT3) return tag;
    const place = parsePlace(tag);
    if (place.name !== FENCE_INSTANCE || place.charId !== runChar) return tag;
    return repointPlacement(tag, variantChars[seen++ % variantChars.length]);
  });
  swf.tags[roomIndex] = rebuildSprite(swf.tags[roomIndex], rebuilt);
  console.log(`${seen} runs repointed at ${variantChars.length} variants (${variantChars.join(", ")})`);

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
