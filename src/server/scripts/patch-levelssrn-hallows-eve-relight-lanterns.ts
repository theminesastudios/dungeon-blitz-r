/**
 * Puts a small light back on each of the square's skull lanterns.
 *
 * `patch-levelssrn-hallows-eve-strip-torch-glows.ts` took five `a_EB_NewTorchLight`
 * placements out of the seasonal scene because they drew as wide round green auras.
 * They were, but they were also the **only** light those lanterns had: each one sat
 * over the dark backing the lantern is drawn with, and taking it away left a hard
 * dark patch behind every skull - the same four places, which is what gave it away.
 *
 * So they come back. `DEFAULT_SCALE` is what fraction of the original size they come
 * back at, and **the default is 1.0 - the size they were** - because that is the only
 * setting that covers the backing: half was tried, then 0.8, and the patch showed at
 * both. The light and the thing it hides are the same size, which is what an artist
 * drawing a lamp would do. Anything smaller trades the aura for a dark rectangle.
 *
 * The knob is kept because the trade is a matter of taste, not correctness. Anything
 * between about 0.3 and 1.0 works; the smaller it is, the more of the backing shows.
 *
 * ## Keeping them centred
 *
 * The light is drawn *down-right* of its own origin, 90 by 90 in its own pixels, so
 * scaling it about that origin walks it up and to the left. Each placement's
 * translation is therefore moved by `45 * (scale - newScale)` on both axes, which
 * pins the middle of the light exactly where it was.
 *
 * The original tags are read back out of git - `ORIGINAL_REF` - rather than rebuilt,
 * because they are `PlaceObject3` with a class name and a colour transform (that
 * transform is what makes the light green) and nothing here should have to
 * re-derive either.
 *
 * Usage: npm exec ts-node scripts/patch-levelssrn-hallows-eve-relight-lanterns.ts
 *          [--verify] [--scale 0.5] [--ref <git ref>]
 *
 * Re-runnable: it stops when the scene already carries lights.
 */
import { execFileSync } from "child_process";
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

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..");
const SRN_RELATIVE = "src/client/content/localhost/p/cbp/LevelsSRN.swf";
const SRN_SWF = path.join(REPO_ROOT, SRN_RELATIVE);

const HOST_ROOM = "a_Room_SRN04";
const SCENE_DEPTH = 124;
const GLOW_CLASS = /EB_NewTorchLight/;

/** Where the lights are read from: the last commit that still had them. */
const ORIGINAL_REF = "HEAD";

/** How big the light is now, as a fraction of what it was. */
const DEFAULT_SCALE = 1.0;

/** The light's own size, which is what the centring correction is worked out from. */
const LIGHT_SIZE = 90;

function spriteIndexFor(swf: SwfFile, charId: number): number {
  const index = swf.tags.findIndex((tag) => tag.code === TAG_DEFINE_SPRITE && tag.data.readUInt16LE(0) === charId);
  if (index === -1) throw new SwfLevelError(`character ${charId} is not a sprite`);
  return index;
}

function placedClassName(tag: SwfTag): string | null {
  if (tag.code !== TAG_PLACE_OBJECT3) return null;
  if ((tag.data[1] & 0x08) === 0) return null;
  let end = 4;
  while (end < tag.data.length && tag.data[end] !== 0) end += 1;
  return tag.data.subarray(4, end).toString("utf8");
}

/** The imported seasonal scene, reached through the composite the room places it in. */
function sceneCharacter(swf: SwfFile): number {
  const room = readSymbolClasses(swf).find((entry) => entry.name === HOST_ROOM);
  if (!room) throw new SwfLevelError(`LevelsSRN.swf has no ${HOST_ROOM}`);
  const composite = spriteInnerTags(swf.tags[spriteIndexFor(swf, room.id)])
    .filter((tag) => tag.code === TAG_PLACE_OBJECT2 || tag.code === TAG_PLACE_OBJECT3)
    .map((tag) => parsePlace(tag))
    .find((place) => place.depth === SCENE_DEPTH);
  if (!composite || composite.charId === null) throw new SwfLevelError(`${HOST_ROOM} has no scene on depth ${SCENE_DEPTH}`);
  const scene = spriteInnerTags(swf.tags[spriteIndexFor(swf, composite.charId)])
    .filter((tag) => tag.code === TAG_PLACE_OBJECT2 || tag.code === TAG_PLACE_OBJECT3)
    .map((tag) => parsePlace(tag))
    .filter((place) => place.charId !== null)
    .pop();
  if (!scene || scene.charId === null) throw new SwfLevelError("the scene composite is empty");
  return scene.charId;
}

/**
 * Rewrites a light's matrix: scaled down, and shifted so its middle does not move.
 *
 * The matrix sits after the two flag bytes, the depth and the class name, and the
 * fields after it are copied through untouched - the colour transform among them,
 * which is the whole reason these are read back rather than rebuilt.
 */
function shrink(tag: SwfTag, factor: number): SwfTag {
  const nameEnd = (() => {
    let end = 4;
    while (end < tag.data.length && tag.data[end] !== 0) end += 1;
    return end + 1;
  })();

  // MATRIX: [hasScale, nbits, sx, sy][hasRotate, nbits, r0, r1][nbits, tx, ty]
  let bit = 0;
  let pos = nameEnd;
  const read = (count: number): number => {
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      value = value * 2 + ((tag.data[pos] >> (7 - bit)) & 1);
      bit += 1;
      if (bit === 8) { bit = 0; pos += 1; }
    }
    return value;
  };
  const signed = (count: number): number => {
    if (!count) return 0;
    const value = read(count);
    return value >= 2 ** (count - 1) ? value - 2 ** count : value;
  };
  let scaleX = 1;
  let scaleY = 1;
  if (read(1)) { const bits = read(5); scaleX = signed(bits) / 65536; scaleY = signed(bits) / 65536; }
  let rotate0 = 0;
  let rotate1 = 0;
  if (read(1)) { const bits = read(5); rotate0 = signed(bits) / 65536; rotate1 = signed(bits) / 65536; }
  const translateBits = read(5);
  const translateX = signed(translateBits) / 20;
  const translateY = signed(translateBits) / 20;
  const matrixEnd = bit === 0 ? pos : pos + 1;

  // Half the size it loses, on both axes, so the middle of the light stays put.
  const drift = (LIGHT_SIZE / 2) * (scaleX - scaleX * factor);
  const { encodeMatrix } = require("./swfLevelUtils") as typeof import("./swfLevelUtils");
  const matrix = encodeMatrix({
    scaleX: scaleX * factor,
    scaleY: scaleY * factor,
    rotateSkew0: rotate0 * factor,
    rotateSkew1: rotate1 * factor,
    translateX: Math.round((translateX + drift) * 20),
    translateY: Math.round((translateY + drift) * 20),
  });
  return {
    code: tag.code,
    data: Buffer.concat([tag.data.subarray(0, nameEnd), matrix, tag.data.subarray(matrixEnd)]),
  };
}

function main(): void {
  const argv = process.argv;
  const verify = argv.includes("--verify");
  const scaleIndex = argv.indexOf("--scale");
  const factor = scaleIndex === -1 ? DEFAULT_SCALE : Number(argv[scaleIndex + 1]);
  const refIndex = argv.indexOf("--ref");
  const ref = refIndex === -1 ? ORIGINAL_REF : argv[refIndex + 1];

  const swf = readSwfFile(SRN_SWF);
  const sceneId = sceneCharacter(swf);
  const sceneIndex = spriteIndexFor(swf, sceneId);
  const inner = spriteInnerTags(swf.tags[sceneIndex]);
  if (inner.some((tag) => GLOW_CLASS.test(placedClassName(tag) ?? ""))) {
    console.log("the lanterns are already lit.");
    return;
  }

  // The originals, out of the commit that still had them.
  const originalBytes = execFileSync("git", ["show", `${ref}:${SRN_RELATIVE}`], {
    cwd: REPO_ROOT,
    maxBuffer: 64 * 1024 * 1024,
  });
  const originalPath = path.join(REPO_ROOT, "build", "_relight_source.swf");
  require("fs").mkdirSync(path.dirname(originalPath), { recursive: true });
  require("fs").writeFileSync(originalPath, originalBytes);
  const original = readSwfFile(originalPath);
  require("fs").unlinkSync(originalPath);

  const lights = spriteInnerTags(original.tags[spriteIndexFor(original, sceneCharacter(original))])
    .filter((tag) => GLOW_CLASS.test(placedClassName(tag) ?? ""));
  if (lights.length === 0) throw new SwfLevelError(`${ref} carries no torch lights either`);

  const shrunk = lights.map((tag) => shrink(tag, factor));
  for (const [index, tag] of shrunk.entries()) {
    const before = parsePlace(lights[index]);
    const after = parsePlace(tag);
    console.log(
      `  ${placedClassName(tag)} depth ${after.depth}: ` +
        `${before.matrix!.scaleX.toFixed(2)} -> ${after.matrix!.scaleX.toFixed(2)}, ` +
        `(${(before.matrix!.translateX / 20).toFixed(0)}, ${(before.matrix!.translateY / 20).toFixed(0)}) -> ` +
        `(${(after.matrix!.translateX / 20).toFixed(0)}, ${(after.matrix!.translateY / 20).toFixed(0)})`,
    );
  }
  console.log(`${shrunk.length} lanterns relit at x${factor} of the original light`);
  if (verify) {
    console.log("verify only - no file written.");
    return;
  }

  // Back on the depths they had, which is above the wall and below the lantern.
  const rebuilt = [...inner];
  rebuilt.splice(Math.max(rebuilt.length - 2, 0), 0, ...shrunk);
  swf.tags[sceneIndex] = rebuildSprite(swf.tags[sceneIndex], rebuilt);

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
