/**
 * Takes the big green glows out of the Hallow's Eve square.
 *
 * The seasonal scene ships with five torch lights along the foot of the ruins - four
 * still (`a_EB_NewTorchLight1`) and one animated (`a_Animation_EB_NewTorchLight`) -
 * which draw as wide round green auras over the skull lanterns in the wall. They read
 * as blobs at this size and the square is already lit by its own fire, so they go.
 *
 * ## Why they were hard to find
 *
 * They are not `PlaceObject2` placements and they carry **no character id**. Each is a
 * `PlaceObject3` with the `HasClassName` flag: the tag names an AS3 class and Flash
 * instantiates it. `parsePlace` reports `charId: null` for them and nothing in the
 * SWF's own character table matches, so scanning the room's artwork for green fills
 * turns up the rift and the besom fire and nothing else - the glows are simply not in
 * this file. The classes live in `caa/Library01.swf`, a shared library the client
 * loads alongside the level, which is why they draw at all.
 *
 * Their scene coordinates put them at room-local (809, -222), (166, -226),
 * (364, -228), (564, -508) and (601, -207): the wall, the tower's foot and the pole.
 *
 * Dropping them is safe. They are unnamed, and the scene character they sit in
 * (`1955`) is an imported copy bound to no class - so there is no generated member to
 * leave dangling, which is the trap that makes deleting a *cue* placement crash a
 * room.
 *
 * ## It undoes the relight, so run them as a pair
 *
 * These lights turned out to be the lanterns' only light, and taking them away left a
 * patch of unlit art behind each skull -
 * `patch-levelssrn-hallows-eve-relight-lanterns.ts` puts a smaller one back. This
 * script cannot tell a small one from an original, so running it again strips the
 * small ones too. Always run the two in order:
 *
 *     strip-torch-glows && relight-lanterns --scale <n>
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-strip-torch-glows.ts [--verify]
 *
 * Re-runnable: it stops when the scene has none left.
 */
import * as path from "path";
import {
  SwfFile,
  SwfLevelError,
  SwfTag,
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
/** The depth the square's seasonal scene sits on inside the room. */
const SCENE_DEPTH = 124;

/** Any class whose name matches this is one of the glows. */
const GLOW_CLASS = /EB_NewTorchLight/;

/**
 * The class name a `PlaceObject3` carries, or null when it places a character.
 *
 * Flag layout, in order: byte one is the same as `PlaceObject2`'s, byte two adds
 * `HasFilterList` (0x01) up to `HasClassName` (0x08); the class name, when present,
 * comes straight after the depth and before everything else.
 */
function placedClassName(tag: SwfTag): string | null {
  if (tag.code !== TAG_PLACE_OBJECT3) return null;
  if ((tag.data[1] & 0x08) === 0) return null;
  let end = 4;
  while (end < tag.data.length && tag.data[end] !== 0) end += 1;
  return tag.data.subarray(4, end).toString("utf8");
}

function spriteIndexFor(swf: SwfFile, charId: number): number {
  const index = swf.tags.findIndex((tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === charId);
  if (index === -1) throw new SwfLevelError(`character ${charId} is not a sprite`);
  return index;
}

/** The imported seasonal scene, found through the composite the room places it in. */
function sceneCharacter(swf: SwfFile): number {
  const room = readSymbolClasses(swf).find((entry) => entry.name === HOST_ROOM);
  if (!room) throw new SwfLevelError(`LevelsSRN.swf has no ${HOST_ROOM}`);
  const composite = spriteInnerTags(swf.tags[spriteIndexFor(swf, room.id)])
    .filter((tag) => tag.code === TAG_PLACE_OBJECT2 || tag.code === TAG_PLACE_OBJECT3)
    .map((tag) => parsePlace(tag))
    .find((place) => place.depth === SCENE_DEPTH);
  if (!composite || composite.charId === null) {
    throw new SwfLevelError(`${HOST_ROOM} has nothing on depth ${SCENE_DEPTH}; the square is not dressed`);
  }
  // The composite holds the mask on depth 1 and the scene above it.
  const scene = spriteInnerTags(swf.tags[spriteIndexFor(swf, composite.charId)])
    .filter((tag) => tag.code === TAG_PLACE_OBJECT2 || tag.code === TAG_PLACE_OBJECT3)
    .map((tag) => parsePlace(tag))
    .filter((place) => place.charId !== null)
    .pop();
  if (!scene || scene.charId === null) throw new SwfLevelError("the scene composite is empty");
  return scene.charId;
}

function main(): void {
  const verify = process.argv.includes("--verify");
  const swf = readSwfFile(SRN_SWF);
  const sceneId = sceneCharacter(swf);
  const sceneIndex = spriteIndexFor(swf, sceneId);
  const inner = spriteInnerTags(swf.tags[sceneIndex]);

  const glows = inner.filter((tag) => {
    const className = placedClassName(tag);
    return className !== null && GLOW_CLASS.test(className);
  });
  if (glows.length === 0) {
    console.log(`the square's scene (character ${sceneId}) carries no torch glows.`);
    return;
  }
  for (const tag of glows) {
    const place = parsePlace(tag);
    console.log(`  ${placedClassName(tag)} on depth ${place.depth} - removing`);
  }
  console.log(`${glows.length} glows to drop from character ${sceneId}`);
  if (verify) {
    console.log('verify only - no file written.');
    return;
  }

  swf.tags[sceneIndex] = rebuildSprite(
    swf.tags[sceneIndex],
    inner.filter((tag) => !glows.includes(tag)),
  );
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
