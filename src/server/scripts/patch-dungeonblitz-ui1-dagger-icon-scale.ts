import * as path from "path";
import {
  appendCharacterTag,
  characterBounds,
  characterTagsById,
  encodeMatrix,
  encodeTag,
  ensureBackup,
  maxCharacterId,
  readSwfFile,
  readSymbolClasses,
  spriteInnerTags,
  SwfLevelError,
  SwfTag,
  TAG_DEFINE_SPRITE,
  TAG_PLACE_OBJECT2,
  TAG_PLACE_OBJECT3,
  writeSwfFile,
  writeSymbolClasses,
} from "./swfLevelUtils";
import type { Matrix } from "./swfLevelUtils";

/**
 * The entity status readout (Entity.method_1667) draws each status icon by instantiating
 * the class that BuffType.method_1811's category table names, then addChild's it with no
 * scaling -- so the icon renders at its sprite's natural art size. a_PowerIcon_PoisonDagger
 * is a full-size power-bar icon (~34x40px), while the a_StatusIcon_* family is ~19x19px,
 * which is why the dagger icon looked oversized next to the other status icons.
 *
 * Shrinking the sprite itself would shrink the hotbar's power button too: class_58
 * rasterizes power icons through class_4.method_639 at their natural art size. So instead
 * this patch clones the dagger sprite at 0.48 scale under a new exported class name
 * (a_StatusIcon_PoisonDagger) and leaves the original a_PowerIcon_PoisonDagger untouched
 * for the hotbar. The readout repoint lives in patch-dungeonblitz-dagger-poison-icon.ts,
 * which switches BuffType.method_1811's AttackUp case to the scaled clone.
 *
 * The clone keeps every inner tag of the source sprite (placements, frames) and only
 * rescales each placement matrix by the same factor -- scale, skew and translation alike
 * -- so the artwork's proportions and layout are preserved exactly. It is registered in
 * the SymbolClass table under its own character id, which is chosen past the file's
 * current maximum so nothing collides.
 */

const DEFAULT_UI1 = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "UI_1.swf",
);

const SOURCE_CLASS = "a_PowerIcon_PoisonDagger";
const CLONE_CLASS = "a_StatusIcon_PoisonDagger";
/** a_StatusIcon_* art is ~18.7px; the dagger sprite is ~39.8px tall. */
const SCALE = 0.48;

// ---------------------------------------------------------------------------
// Minimal MATRIX reader (mirrors swfLevelUtils.readMatrix) so a placement's
// matrix bytes can be located and replaced without disturbing the rest of the
// tag (colour transform, ratio, clip depth, ...).
// ---------------------------------------------------------------------------

class BitReader {
  private bit = 0;
  constructor(private readonly buf: Buffer, public offset: number) {}
  ub(count: number): number {
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      value = (value << 1) | ((this.buf[this.offset] >> (7 - this.bit)) & 1);
      this.bit += 1;
      if (this.bit === 8) {
        this.bit = 0;
        this.offset += 1;
      }
    }
    return value >>> 0;
  }
  sb(count: number): number {
    if (count === 0) return 0;
    const value = this.ub(count);
    return value & (1 << (count - 1)) ? value - (1 << count) : value;
  }
  align(): void {
    if (this.bit !== 0) {
      this.bit = 0;
      this.offset += 1;
    }
  }
}

function readMatrixAt(buf: Buffer, offset: number): { matrix: Matrix; end: number } {
  const reader = new BitReader(buf, offset);
  const matrix: Matrix = {
    scaleX: 1,
    scaleY: 1,
    rotateSkew0: 0,
    rotateSkew1: 0,
    translateX: 0,
    translateY: 0,
  };
  if (reader.ub(1)) {
    const bits = reader.ub(5);
    matrix.scaleX = reader.sb(bits) / 65536;
    matrix.scaleY = reader.sb(bits) / 65536;
  }
  if (reader.ub(1)) {
    const bits = reader.ub(5);
    matrix.rotateSkew0 = reader.sb(bits) / 65536;
    matrix.rotateSkew1 = reader.sb(bits) / 65536;
  }
  const translateBits = reader.ub(5);
  matrix.translateX = reader.sb(translateBits);
  matrix.translateY = reader.sb(translateBits);
  reader.align();
  return { matrix, end: reader.offset };
}

function scaledMatrix(matrix: Matrix, factor: number): Matrix {
  return {
    scaleX: matrix.scaleX * factor,
    scaleY: matrix.scaleY * factor,
    rotateSkew0: matrix.rotateSkew0 * factor,
    rotateSkew1: matrix.rotateSkew1 * factor,
    translateX: Math.round(matrix.translateX * factor),
    translateY: Math.round(matrix.translateY * factor),
  };
}

/**
 * Splices a rescaling matrix over a placement's existing matrix, keeping every
 * other byte of the tag. A placement without a matrix renders at identity, which
 * would leave that child at full size inside the scaled clone -- the dagger
 * sprite has none, so this refuses rather than guess.
 */
function scalePlacementTag(tag: SwfTag, factor: number): SwfTag {
  if (tag.code !== TAG_PLACE_OBJECT2 && tag.code !== TAG_PLACE_OBJECT3) return tag;

  const data = tag.data;
  const flags = data[0];
  let flags2 = 0;
  let offset = 1;
  if (tag.code === TAG_PLACE_OBJECT3) {
    flags2 = data[1];
    offset += 1;
  }
  offset += 2; // depth
  if (tag.code === TAG_PLACE_OBJECT3 && (flags2 & 0x01) !== 0) {
    while (data[offset] !== 0) offset += 1;
    offset += 1;
  }
  if ((flags & 0x02) !== 0) offset += 2; // character id
  if ((flags & 0x04) === 0) {
    throw new SwfLevelError("placement without a matrix; cannot scale this sprite's art");
  }

  const start = offset;
  const { matrix, end } = readMatrixAt(data, start);
  return {
    code: tag.code,
    data: Buffer.concat([
      data.subarray(0, start),
      encodeMatrix(scaledMatrix(matrix, factor)),
      data.subarray(end),
    ]),
  };
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function boundsOf(swf: ReturnType<typeof readSwfFile>, id: number): { xMin: number; xMax: number; yMin: number; yMax: number } {
  const bounds = characterBounds(swf, id);
  if (!bounds) throw new SwfLevelError(`character ${id} has no measurable bounds`);
  return bounds;
}

/** The clone must measure ~SCALE x the source sprite, on every edge. */
function cloneMatchesSource(clone: { xMin: number; xMax: number; yMin: number; yMax: number }, source: { xMin: number; xMax: number; yMin: number; yMax: number }): boolean {
  const tolerance = 3; // twips, for fixed-point rounding
  return (
    Math.abs(clone.xMin - source.xMin * SCALE) <= tolerance &&
    Math.abs(clone.xMax - source.xMax * SCALE) <= tolerance &&
    Math.abs(clone.yMin - source.yMin * SCALE) <= tolerance &&
    Math.abs(clone.yMax - source.yMax * SCALE) <= tolerance
  );
}

// ---------------------------------------------------------------------------
// Patch
// ---------------------------------------------------------------------------

function patchUi1DaggerIconScale(ui1Path: string, verifyOnly: boolean): number {
  const swf = readSwfFile(ui1Path);
  const symbols = readSymbolClasses(swf);

  const source = symbols.find((binding) => binding.name === SOURCE_CLASS);
  if (!source) throw new SwfLevelError(`"${SOURCE_CLASS}" is not exported by ${ui1Path}`);

  const sourceTag = characterTagsById(swf).get(source.id);
  if (!sourceTag || sourceTag.code !== TAG_DEFINE_SPRITE) {
    throw new SwfLevelError(`"${SOURCE_CLASS}" (character ${source.id}) is not a DefineSprite`);
  }
  const sourceBounds = boundsOf(swf, source.id);

  const cloneBinding = symbols.find((binding) => binding.name === CLONE_CLASS);
  if (cloneBinding) {
    const cloneTag = characterTagsById(swf).get(cloneBinding.id);
    if (!cloneTag || cloneTag.code !== TAG_DEFINE_SPRITE || !cloneMatchesSource(boundsOf(swf, cloneBinding.id), sourceBounds)) {
      throw new SwfLevelError(`"${CLONE_CLASS}" exists but is not the scaled dagger clone; refusing to patch a drifted UI_1.swf`);
    }
    console.log(JSON.stringify({ verify: verifyOnly, swf: ui1Path, alreadyPatched: true, cloneId: cloneBinding.id }, null, 2));
    console.log("No changes needed.");
    return 0;
  }

  // Frame count of the source sprite, for the clone header.
  const frameCount = sourceTag.data.readUInt16LE(2);

  const newId = maxCharacterId(swf) + 1;
  const inner = spriteInnerTags(sourceTag).map((tag) => scalePlacementTag(tag, SCALE));

  const head = Buffer.alloc(4);
  head.writeUInt16LE(newId, 0);
  head.writeUInt16LE(frameCount, 2);
  const cloneTag: SwfTag = {
    code: TAG_DEFINE_SPRITE,
    data: Buffer.concat([head, ...inner.map(encodeTag)]),
  };

  console.log(JSON.stringify(
    {
      verify: verifyOnly,
      swf: ui1Path,
      source: { id: source.id, bounds: sourceBounds },
      clone: { id: newId, class: CLONE_CLASS, scale: SCALE },
    },
    null,
    2,
  ));

  if (verifyOnly) {
    console.log("Patch required.");
    return 1;
  }

  ensureBackup(ui1Path);
  appendCharacterTag(swf, cloneTag);
  writeSymbolClasses(swf, [...symbols, { id: newId, name: CLONE_CLASS }]);
  writeSwfFile(ui1Path, swf);

  // Re-read and prove the patch landed before reporting success.
  const verified = readSwfFile(ui1Path);
  const verifiedBinding = readSymbolClasses(verified).find((binding) => binding.name === CLONE_CLASS);
  if (!verifiedBinding) throw new SwfLevelError(`failed to export ${CLONE_CLASS}`);
  const verifiedTag = characterTagsById(verified).get(verifiedBinding.id);
  if (!verifiedTag || verifiedTag.code !== TAG_DEFINE_SPRITE) {
    throw new SwfLevelError(`${CLONE_CLASS} does not point at a DefineSprite after patching`);
  }
  if (!cloneMatchesSource(boundsOf(verified, verifiedBinding.id), sourceBounds)) {
    throw new SwfLevelError("clone bounds do not match the scaled source after patching");
  }
  const originalStill = readSymbolClasses(verified).find((binding) => binding.name === SOURCE_CLASS);
  if (!originalStill || characterTagsById(verified).get(originalStill.id)?.code !== TAG_DEFINE_SPRITE) {
    throw new SwfLevelError("the original power icon was disturbed by the patch");
  }

  console.log("Patch apply complete.");
  return 0;
}

function parseArgs(argv: string[]): { ui1Path: string; verify: boolean } {
  let ui1Path = DEFAULT_UI1;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") ui1Path = path.resolve(argv[++index] || "");
    else if (arg === "--verify" || arg === "--dry-run") verify = true;
    else if (arg === "--help" || arg === "-h") {
      console.log(
        "Usage: ts-node patch-dungeonblitz-ui1-dagger-icon-scale.ts [--verify] [--swf <path>]\n" +
          "Clones the dagger power icon in UI_1.swf at 0.48 scale as a_StatusIcon_PoisonDagger\n" +
          "so the entity status readout can render it at status-icon size.",
      );
      process.exit(0);
    } else throw new SwfLevelError(`Unknown argument: ${arg}`);
  }
  return { ui1Path, verify };
}

function main(): number {
  const { ui1Path, verify } = parseArgs(process.argv);
  try {
    return patchUi1DaggerIconScale(ui1Path, verify);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch-dungeonblitz-ui1-dagger-icon-scale] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
