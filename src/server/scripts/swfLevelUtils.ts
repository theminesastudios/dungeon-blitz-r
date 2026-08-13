/**
 * Structural SWF helpers for level authoring.
 *
 * `swfPatchUtils.ts` edits ActionScript bytecode in place; this module works one
 * level up, on the tag stream: it copies character tags between level SWFs with
 * new character ids, rewrites the SymbolClass table, renames ABC constant-pool
 * strings (which is how an unused exported class is repurposed without writing
 * new bytecode) and assembles DefineSprite tags.
 */
import * as fs from "fs";
import * as zlib from "zlib";

export class SwfLevelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwfLevelError";
  }
}

export interface SwfTag {
  code: number;
  data: Buffer;
}

export interface SwfFile {
  signature: "CWS" | "FWS";
  version: number;
  /** Raw FrameSize RECT plus frame rate and frame count, copied verbatim. */
  header: Buffer;
  tags: SwfTag[];
}

export const TAG_END = 0;
export const TAG_SHOW_FRAME = 1;
export const TAG_DEFINE_SHAPE = 2;
export const TAG_PLACE_OBJECT = 4;
export const TAG_REMOVE_OBJECT = 5;
export const TAG_DEFINE_TEXT = 11;
export const TAG_START_SOUND = 15;
export const TAG_DEFINE_BUTTON2 = 34;
export const TAG_DEFINE_EDIT_TEXT = 37;
export const TAG_DEFINE_SPRITE = 39;
export const TAG_FRAME_LABEL = 43;
export const TAG_DEFINE_FONT_ALIGN_ZONES = 73;
export const TAG_CSM_TEXT_SETTINGS = 74;
export const TAG_DEFINE_FONT_NAME = 88;
export const TAG_SYMBOL_CLASS = 76;
export const TAG_PLACE_OBJECT2 = 26;
export const TAG_PLACE_OBJECT3 = 70;
export const TAG_DO_ABC = 82;
export const TAG_DO_ABC_DEPRECATED = 72;

const CHARACTER_TAGS = new Set([2, 4, 6, 10, 11, 13, 20, 21, 22, 32, 34, 35, 36, 39, 46, 48, 75, 83, 84]);

// ---------------------------------------------------------------------------
// File level IO
// ---------------------------------------------------------------------------

export function readSwfFile(filePath: string): SwfFile {
  const raw = fs.readFileSync(filePath);
  const signature = raw.subarray(0, 3).toString("ascii");
  if (signature !== "CWS" && signature !== "FWS") {
    throw new SwfLevelError(`${filePath}: unsupported SWF signature ${signature}`);
  }
  const body = signature === "CWS" ? zlib.inflateSync(raw.subarray(8)) : Buffer.from(raw.subarray(8));
  const nbits = body[0] >> 3;
  const headerLength = Math.ceil((5 + nbits * 4) / 8) + 4;
  return {
    signature,
    version: raw[3],
    header: Buffer.from(body.subarray(0, headerLength)),
    tags: splitTags(body, headerLength),
  };
}

export function writeSwfFile(filePath: string, swf: SwfFile): void {
  const body = Buffer.concat([swf.header, ...swf.tags.map(encodeTag)]);
  const header = Buffer.alloc(8);
  header.write(swf.signature, 0, 3, "ascii");
  header[3] = swf.version;
  header.writeUInt32LE(body.length + 8, 4);
  const payload =
    swf.signature === "CWS" ? zlib.deflateSync(body, { level: 9 }) : body;
  fs.writeFileSync(filePath, Buffer.concat([header, payload]));
}

export function splitTags(buffer: Buffer, start: number): SwfTag[] {
  const tags: SwfTag[] = [];
  let offset = start;
  while (offset + 2 <= buffer.length) {
    const header = buffer.readUInt16LE(offset);
    offset += 2;
    const code = header >> 6;
    let length = header & 0x3f;
    if (length === 0x3f) {
      if (offset + 4 > buffer.length) throw new SwfLevelError(`truncated long tag ${code}`);
      length = buffer.readUInt32LE(offset);
      offset += 4;
    }
    if (offset + length > buffer.length) throw new SwfLevelError(`tag ${code} overruns container`);
    tags.push({ code, data: Buffer.from(buffer.subarray(offset, offset + length)) });
    offset += length;
    if (code === TAG_END) break;
  }
  return tags;
}

export function encodeTag(tag: SwfTag): Buffer {
  if (tag.data.length < 0x3f) {
    const header = Buffer.alloc(2);
    header.writeUInt16LE((tag.code << 6) | tag.data.length, 0);
    return Buffer.concat([header, tag.data]);
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE((tag.code << 6) | 0x3f, 0);
  header.writeUInt32LE(tag.data.length, 2);
  return Buffer.concat([header, tag.data]);
}

export function characterId(tag: SwfTag): number | null {
  return CHARACTER_TAGS.has(tag.code) && tag.data.length >= 2 ? tag.data.readUInt16LE(0) : null;
}

export function characterTagsById(swf: SwfFile): Map<number, SwfTag> {
  const map = new Map<number, SwfTag>();
  for (const tag of swf.tags) {
    const id = characterId(tag);
    if (id !== null) map.set(id, tag);
  }
  return map;
}

export function maxCharacterId(swf: SwfFile): number {
  let max = 0;
  for (const tag of swf.tags) {
    const id = characterId(tag);
    if (id !== null && id > max) max = id;
  }
  return max;
}

// ---------------------------------------------------------------------------
// SymbolClass
// ---------------------------------------------------------------------------

export interface SymbolBinding {
  id: number;
  name: string;
}

export function readSymbolClasses(swf: SwfFile): SymbolBinding[] {
  const bindings: SymbolBinding[] = [];
  for (const tag of swf.tags) {
    if (tag.code !== TAG_SYMBOL_CLASS) continue;
    let offset = 0;
    const count = tag.data.readUInt16LE(offset);
    offset += 2;
    for (let index = 0; index < count; index += 1) {
      const id = tag.data.readUInt16LE(offset);
      offset += 2;
      const start = offset;
      while (offset < tag.data.length && tag.data[offset] !== 0) offset += 1;
      bindings.push({ id, name: tag.data.subarray(start, offset).toString("utf8") });
      offset += 1;
    }
  }
  return bindings;
}

export function writeSymbolClasses(swf: SwfFile, bindings: SymbolBinding[]): void {
  const parts: Buffer[] = [Buffer.alloc(2)];
  parts[0].writeUInt16LE(bindings.length, 0);
  for (const binding of bindings) {
    const id = Buffer.alloc(2);
    id.writeUInt16LE(binding.id, 0);
    parts.push(id, Buffer.from(binding.name, "utf8"), Buffer.from([0]));
  }
  const data = Buffer.concat(parts);
  let replaced = false;
  swf.tags = swf.tags.filter((tag) => {
    if (tag.code !== TAG_SYMBOL_CLASS) return true;
    if (replaced) return false;
    tag.data = data;
    replaced = true;
    return true;
  });
  if (!replaced) throw new SwfLevelError("no SymbolClass tag to rewrite");
}

// ---------------------------------------------------------------------------
// PlaceObject parsing / building
// ---------------------------------------------------------------------------

export interface Matrix {
  scaleX: number;
  scaleY: number;
  rotateSkew0: number;
  rotateSkew1: number;
  translateX: number;
  translateY: number;
}

export interface PlaceInfo {
  code: number;
  depth: number;
  move: boolean;
  charId: number | null;
  /** Byte offset of the character id inside the tag payload, when present. */
  charIdOffset: number | null;
  name: string | null;
  matrix: Matrix | null;
}

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

class BitWriter {
  private bytes: number[] = [];
  private current = 0;
  private bit = 0;
  ub(count: number, value: number): void {
    for (let index = count - 1; index >= 0; index -= 1) {
      this.current = (this.current << 1) | ((value >> index) & 1);
      this.bit += 1;
      if (this.bit === 8) {
        this.bytes.push(this.current & 0xff);
        this.current = 0;
        this.bit = 0;
      }
    }
  }
  sb(count: number, value: number): void {
    this.ub(count, value < 0 ? value + (1 << count) : value);
  }
  toBuffer(): Buffer {
    if (this.bit !== 0) {
      this.bytes.push((this.current << (8 - this.bit)) & 0xff);
      this.current = 0;
      this.bit = 0;
    }
    return Buffer.from(this.bytes);
  }
}

function readMatrix(buf: Buffer, offset: number): { matrix: Matrix; end: number } {
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

function signedBitsNeeded(...values: number[]): number {
  let bits = 1;
  for (const value of values) {
    let needed = 1;
    while (value < -(2 ** (needed - 1)) || value > 2 ** (needed - 1) - 1) needed += 1;
    if (needed > bits) bits = needed;
  }
  return bits;
}

export function encodeMatrix(matrix: Matrix): Buffer {
  const writer = new BitWriter();
  const hasScale = matrix.scaleX !== 1 || matrix.scaleY !== 1;
  if (hasScale) {
    const sx = Math.round(matrix.scaleX * 65536);
    const sy = Math.round(matrix.scaleY * 65536);
    const bits = signedBitsNeeded(sx, sy);
    writer.ub(1, 1);
    writer.ub(5, bits);
    writer.sb(bits, sx);
    writer.sb(bits, sy);
  } else {
    writer.ub(1, 0);
  }
  const hasRotate = matrix.rotateSkew0 !== 0 || matrix.rotateSkew1 !== 0;
  if (hasRotate) {
    const r0 = Math.round(matrix.rotateSkew0 * 65536);
    const r1 = Math.round(matrix.rotateSkew1 * 65536);
    const bits = signedBitsNeeded(r0, r1);
    writer.ub(1, 1);
    writer.ub(5, bits);
    writer.sb(bits, r0);
    writer.sb(bits, r1);
  } else {
    writer.ub(1, 0);
  }
  const tx = Math.round(matrix.translateX);
  const ty = Math.round(matrix.translateY);
  const translateBits = signedBitsNeeded(tx, ty);
  writer.ub(5, translateBits);
  writer.sb(translateBits, tx);
  writer.sb(translateBits, ty);
  return writer.toBuffer();
}

function skipColorTransform(buf: Buffer, offset: number, withAlpha: boolean): number {
  const reader = new BitReader(buf, offset);
  const hasAdd = reader.ub(1);
  const hasMultiply = reader.ub(1);
  const bits = reader.ub(4);
  const fields = withAlpha ? 4 : 3;
  if (hasMultiply) for (let index = 0; index < fields; index += 1) reader.sb(bits);
  if (hasAdd) for (let index = 0; index < fields; index += 1) reader.sb(bits);
  reader.align();
  return reader.offset;
}

export function parsePlace(tag: SwfTag): PlaceInfo {
  const data = tag.data;
  let offset = 0;
  const flags = data[offset];
  offset += 1;
  let flags2 = 0;
  if (tag.code === TAG_PLACE_OBJECT3) {
    flags2 = data[offset];
    offset += 1;
  }
  const info: PlaceInfo = {
    code: tag.code,
    depth: data.readUInt16LE(offset),
    move: (flags & 0x01) !== 0,
    charId: null,
    charIdOffset: null,
    name: null,
    matrix: null,
  };
  offset += 2;
  if (tag.code === TAG_PLACE_OBJECT3) {
    if (flags2 & 0x01) {
      while (data[offset] !== 0) offset += 1;
      offset += 1;
    }
  }
  if (flags & 0x02) {
    info.charIdOffset = offset;
    info.charId = data.readUInt16LE(offset);
    offset += 2;
  }
  if (flags & 0x04) {
    const read = readMatrix(data, offset);
    info.matrix = read.matrix;
    offset = read.end;
  }
  if (flags & 0x08) offset = skipColorTransform(data, offset, true);
  if (flags & 0x10) offset += 2;
  if (flags & 0x20) {
    const start = offset;
    while (data[offset] !== 0) offset += 1;
    info.name = data.subarray(start, offset).toString("utf8");
  }
  return info;
}

/**
 * Moves an existing placement without disturbing anything else about it.
 *
 * Rebuilding the tag from `parsePlace` would be lossy: a placement carries an
 * instance name that room scripts bind by (`__id123_`), and may carry a colour
 * transform, a ratio or a clip depth that `buildPlaceObject2` does not model.
 * Splicing a freshly encoded matrix over the old one keeps every other byte, and
 * the length change is absorbed when the sprite is rebuilt.
 *
 * Returns the tag unchanged when it has no matrix to move.
 */
export function movePlacement(tag: SwfTag, dx: number, dy: number): SwfTag {
  if (tag.code !== TAG_PLACE_OBJECT2 && tag.code !== TAG_PLACE_OBJECT3) return tag;

  const data = tag.data;
  let offset = 1;
  if (tag.code === TAG_PLACE_OBJECT3) offset += 1;
  const flags = data[0];
  const flags2 = tag.code === TAG_PLACE_OBJECT3 ? data[1] : 0;
  offset += 2; // depth
  if (tag.code === TAG_PLACE_OBJECT3 && flags2 & 0x01) {
    while (data[offset] !== 0) offset += 1;
    offset += 1;
  }
  if (flags & 0x02) offset += 2; // character id
  if (!(flags & 0x04)) return tag;

  const start = offset;
  const read = readMatrix(data, start);
  const moved: Matrix = {
    ...read.matrix,
    translateX: read.matrix.translateX + Math.round(dx * 20),
    translateY: read.matrix.translateY + Math.round(dy * 20),
  };

  return {
    code: tag.code,
    data: Buffer.concat([data.subarray(0, start), encodeMatrix(moved), data.subarray(read.end)]),
  };
}

export interface PlacementSpec {
  depth: number;
  charId: number;
  name?: string;
  x?: number;
  y?: number;
  scaleX?: number;
  scaleY?: number;
}

/** Builds a minimal PlaceObject2 (character + matrix + optional instance name). */
export function buildPlaceObject2(spec: PlacementSpec): SwfTag {
  const matrix: Matrix = {
    scaleX: spec.scaleX ?? 1,
    scaleY: spec.scaleY ?? 1,
    rotateSkew0: 0,
    rotateSkew1: 0,
    translateX: Math.round((spec.x ?? 0) * 20),
    translateY: Math.round((spec.y ?? 0) * 20),
  };
  let flags = 0x02 | 0x04;
  if (spec.name) flags |= 0x20;
  const parts: Buffer[] = [Buffer.from([flags])];
  const depth = Buffer.alloc(4);
  depth.writeUInt16LE(spec.depth, 0);
  depth.writeUInt16LE(spec.charId, 2);
  parts.push(depth, encodeMatrix(matrix));
  if (spec.name) parts.push(Buffer.from(spec.name, "utf8"), Buffer.from([0]));
  return { code: TAG_PLACE_OBJECT2, data: Buffer.concat(parts) };
}

export interface SpriteSpec {
  id: number;
  frameCount?: number;
  placements: PlacementSpec[];
}

export function buildSprite(spec: SpriteSpec): SwfTag {
  const head = Buffer.alloc(4);
  head.writeUInt16LE(spec.id, 0);
  head.writeUInt16LE(spec.frameCount ?? 1, 2);
  const inner: Buffer[] = [head];
  for (const placement of spec.placements) inner.push(encodeTag(buildPlaceObject2(placement)));
  inner.push(encodeTag({ code: TAG_SHOW_FRAME, data: Buffer.alloc(0) }));
  inner.push(encodeTag({ code: TAG_END, data: Buffer.alloc(0) }));
  return { code: TAG_DEFINE_SPRITE, data: Buffer.concat(inner) };
}

/**
 * A DefineShape holding one solid-colour rectangle, in twips.
 *
 * Levels have no backdrop layer of their own - authored dungeons simply pack
 * their rooms tightly enough that the camera never sees past them. A generated
 * level cannot rely on that, and empty space renders as smeared garbage, so it
 * needs something opaque behind everything.
 */
export function buildSolidRectShape(id: number, bounds: Bounds, rgb: number): SwfTag {
  const head = Buffer.alloc(2);
  head.writeUInt16LE(id, 0);

  const rect = new BitWriter();
  const rectBits = signedBitsNeeded(bounds.xMin, bounds.xMax, bounds.yMin, bounds.yMax);
  rect.ub(5, rectBits);
  rect.sb(rectBits, bounds.xMin);
  rect.sb(rectBits, bounds.xMax);
  rect.sb(rectBits, bounds.yMin);
  rect.sb(rectBits, bounds.yMax);

  const styles = Buffer.from([
    1, // FillStyleCount
    0x00, // solid fill
    (rgb >> 16) & 0xff,
    (rgb >> 8) & 0xff,
    rgb & 0xff,
    0, // LineStyleCount
  ]);

  const shape = new BitWriter();
  shape.ub(4, 1); // NumFillBits
  shape.ub(4, 0); // NumLineBits

  // StyleChangeRecord: move to the top-left corner and select the fill.
  shape.ub(1, 0); // TypeFlag: non-edge
  shape.ub(1, 0); // StateNewStyles
  shape.ub(1, 0); // StateLineStyle
  shape.ub(1, 1); // StateFillStyle1
  shape.ub(1, 0); // StateFillStyle0
  shape.ub(1, 1); // StateMoveTo
  const moveBits = signedBitsNeeded(bounds.xMin, bounds.yMin);
  shape.ub(5, moveBits);
  shape.sb(moveBits, bounds.xMin);
  shape.sb(moveBits, bounds.yMin);
  shape.ub(1, 1); // FillStyle1 = first fill

  const width = bounds.xMax - bounds.xMin;
  const height = bounds.yMax - bounds.yMin;
  for (const [dx, dy] of [
    [width, 0],
    [0, height],
    [-width, 0],
    [0, -height],
  ]) {
    const edgeBits = Math.max(2, signedBitsNeeded(dx, dy));
    shape.ub(1, 1); // TypeFlag: edge
    shape.ub(1, 1); // StraightFlag
    shape.ub(4, edgeBits - 2);
    shape.ub(1, 1); // GeneralLineFlag
    shape.sb(edgeBits, dx);
    shape.sb(edgeBits, dy);
  }

  shape.ub(6, 0); // EndShapeRecord

  return {
    code: TAG_DEFINE_SHAPE,
    data: Buffer.concat([head, rect.toBuffer(), styles, shape.toBuffer()]),
  };
}

export function spriteInnerTags(tag: SwfTag): SwfTag[] {
  if (tag.code !== TAG_DEFINE_SPRITE) throw new SwfLevelError("not a DefineSprite");
  return splitTags(tag.data, 4);
}

export function rebuildSprite(tag: SwfTag, inner: SwfTag[]): SwfTag {
  return {
    code: TAG_DEFINE_SPRITE,
    data: Buffer.concat([tag.data.subarray(0, 4), ...inner.map(encodeTag)]),
  };
}

// ---------------------------------------------------------------------------
// Character dependency walk and cross-SWF import
// ---------------------------------------------------------------------------

/** Ids a tag points at, other than its own character id. */
function referencedIds(tag: SwfTag): number[] {
  const refs: number[] = [];
  switch (tag.code) {
    case TAG_DEFINE_SPRITE:
      for (const inner of spriteInnerTags(tag)) {
        if (inner.code === TAG_PLACE_OBJECT2 || inner.code === TAG_PLACE_OBJECT3) {
          const place = parsePlace(inner);
          if (place.charId !== null) refs.push(place.charId);
        } else if (inner.code === TAG_PLACE_OBJECT || inner.code === TAG_REMOVE_OBJECT) {
          refs.push(inner.data.readUInt16LE(0));
        } else if (inner.code === TAG_START_SOUND) {
          refs.push(inner.data.readUInt16LE(0));
        }
      }
      break;
    case TAG_DEFINE_EDIT_TEXT: {
      const offset = editTextFontIdOffset(tag);
      if (offset !== null) refs.push(tag.data.readUInt16LE(offset));
      break;
    }
    case TAG_DEFINE_TEXT:
      for (const fontId of defineTextFontIds(tag)) refs.push(fontId);
      break;
    default:
      break;
  }
  return refs;
}

const EDIT_TEXT_HAS_FONT = 0x0100;
const EDIT_TEXT_HAS_FONT_CLASS = 0x0080;

/** Offset of DefineEditText's FontID, or null when the field is absent. */
function editTextFontIdOffset(tag: SwfTag): number | null {
  // id u16, Bounds RECT, then a 16-bit flag field.
  const reader = new BitReader(tag.data, 2);
  const bits = reader.ub(5);
  for (let index = 0; index < 4; index += 1) reader.sb(bits);
  reader.align();
  const flags = tag.data.readUInt16BE(reader.offset);
  if ((flags & EDIT_TEXT_HAS_FONT) === 0 || (flags & EDIT_TEXT_HAS_FONT_CLASS) !== 0) return null;
  return reader.offset + 2;
}

function defineTextRecordOffsets(tag: SwfTag): number[] {
  // id u16, bounds RECT, matrix MATRIX, glyphBits u8, advanceBits u8, records...
  const reader = new BitReader(tag.data, 2);
  const bits = reader.ub(5);
  for (let index = 0; index < 4; index += 1) reader.sb(bits);
  reader.align();
  let offset = readMatrix(tag.data, reader.offset).end;
  const glyphBits = tag.data[offset];
  const advanceBits = tag.data[offset + 1];
  offset += 2;
  const fontIdOffsets: number[] = [];
  while (offset < tag.data.length) {
    const flags = tag.data[offset];
    offset += 1;
    if (flags === 0) break;
    const hasFont = (flags & 0x08) !== 0;
    const hasColor = (flags & 0x04) !== 0;
    const hasY = (flags & 0x02) !== 0;
    const hasX = (flags & 0x01) !== 0;
    if (hasFont) {
      fontIdOffsets.push(offset);
      offset += 2;
    }
    if (hasColor) offset += 4;
    if (hasX) offset += 2;
    if (hasY) offset += 2;
    if (hasFont) offset += 2;
    const glyphCount = tag.data[offset];
    offset += 1;
    const bitLength = glyphCount * (glyphBits + advanceBits);
    offset += Math.ceil(bitLength / 8);
  }
  return fontIdOffsets;
}

function defineTextFontIds(tag: SwfTag): number[] {
  return defineTextRecordOffsets(tag).map((offset) => tag.data.readUInt16LE(offset));
}

/**
 * Every character the given roots need, roots included.
 *
 * Shipped level SWFs contain placements pointing at characters that no longer
 * exist (LevelsBT.swf alone has 14). Flash ignores those, and so does this walk;
 * the dangling placements are dropped during the import instead of being
 * renumbered onto an unrelated character in the target file.
 */
export function collectDependencies(
  swf: SwfFile,
  roots: number[],
  exclude?: (id: number) => boolean,
): Set<number> {
  const byId = characterTagsById(swf);
  const seen = new Set<number>();
  const queue = [...roots];
  for (const root of roots) {
    if (!byId.has(root)) throw new SwfLevelError(`character ${root} is not defined in this SWF`);
  }
  while (queue.length > 0) {
    const id = queue.pop() as number;
    if (seen.has(id)) continue;
    const tag = byId.get(id);
    if (!tag) continue;
    seen.add(id);
    for (const ref of referencedIds(tag)) {
      if (exclude && exclude(ref)) continue;
      queue.push(ref);
    }
  }
  return seen;
}

/** Tags that decorate a character but carry no id of their own. */
function attachmentTagsFor(swf: SwfFile, ids: Set<number>): SwfTag[] {
  const extras: SwfTag[] = [];
  for (const tag of swf.tags) {
    if (tag.code === TAG_DEFINE_FONT_ALIGN_ZONES || tag.code === TAG_DEFINE_FONT_NAME || tag.code === TAG_CSM_TEXT_SETTINGS) {
      if (ids.has(tag.data.readUInt16LE(0))) extras.push(tag);
    }
  }
  return extras;
}

function remapTag(tag: SwfTag, map: Map<number, number>): SwfTag {
  const data = Buffer.from(tag.data);
  const self = characterId({ code: tag.code, data });
  if (self !== null && map.has(self)) data.writeUInt16LE(map.get(self) as number, 0);

  if (tag.code === TAG_DEFINE_FONT_ALIGN_ZONES || tag.code === TAG_DEFINE_FONT_NAME || tag.code === TAG_CSM_TEXT_SETTINGS) {
    const referenced = data.readUInt16LE(0);
    if (map.has(referenced)) data.writeUInt16LE(map.get(referenced) as number, 0);
    return { code: tag.code, data };
  }

  if (tag.code === TAG_DEFINE_SPRITE) {
    const inner: SwfTag[] = [];
    for (const child of splitTags(data, 4)) {
      const childData = Buffer.from(child.data);
      if (child.code === TAG_PLACE_OBJECT2 || child.code === TAG_PLACE_OBJECT3) {
        const place = parsePlace({ code: child.code, data: childData });
        if (place.charId !== null) {
          // A placement of a character we are not carrying over would otherwise
          // renumber onto an unrelated character in the target file.
          if (!map.has(place.charId)) continue;
          if (place.charIdOffset !== null) {
            childData.writeUInt16LE(map.get(place.charId) as number, place.charIdOffset);
          }
        }
      } else if (child.code === TAG_PLACE_OBJECT || child.code === TAG_REMOVE_OBJECT || child.code === TAG_START_SOUND) {
        const referenced = childData.readUInt16LE(0);
        if (!map.has(referenced)) continue;
        childData.writeUInt16LE(map.get(referenced) as number, 0);
      } else if (child.code === TAG_DEFINE_SPRITE) {
        inner.push(remapTag({ code: child.code, data: childData }, map));
        continue;
      }
      inner.push({ code: child.code, data: childData });
    }
    return { code: TAG_DEFINE_SPRITE, data: Buffer.concat([data.subarray(0, 4), ...inner.map(encodeTag)]) };
  }

  if (tag.code === TAG_DEFINE_EDIT_TEXT) {
    const offset = editTextFontIdOffset({ code: tag.code, data });
    if (offset !== null) {
      const referenced = data.readUInt16LE(offset);
      if (map.has(referenced)) data.writeUInt16LE(map.get(referenced) as number, offset);
    }
    return { code: tag.code, data };
  }

  if (tag.code === TAG_DEFINE_TEXT) {
    for (const offset of defineTextRecordOffsets({ code: tag.code, data })) {
      const referenced = data.readUInt16LE(offset);
      if (map.has(referenced)) data.writeUInt16LE(map.get(referenced) as number, offset);
    }
    return { code: tag.code, data };
  }

  return { code: tag.code, data };
}

export interface ImportResult {
  /** source character id -> destination character id */
  idMap: Map<number, number>;
  importedTags: SwfTag[];
}

/**
 * Copies `roots` and everything they depend on out of `source` and into `target`,
 * renumbering every character so nothing collides. Tags are inserted before the
 * target's SymbolClass tag so definitions precede their bindings.
 */
export function importCharacters(
  source: SwfFile,
  target: SwfFile,
  roots: number[],
  exclude?: (id: number) => boolean,
): ImportResult {
  const needed = collectDependencies(source, roots, exclude);
  const byId = characterTagsById(source);
  let nextId = maxCharacterId(target) + 1;
  const idMap = new Map<number, number>();
  for (const id of [...needed].sort((a, b) => a - b)) idMap.set(id, nextId++);

  // Preserve source order so a character is always defined before it is used.
  const ordered = source.tags.filter((tag) => {
    const id = characterId(tag);
    return id !== null && needed.has(id);
  });
  const importedTags = [...ordered, ...attachmentTagsFor(source, needed)].map((tag) => remapTag(tag, idMap));

  const symbolIndex = target.tags.findIndex((tag) => tag.code === TAG_SYMBOL_CLASS);
  const insertAt = symbolIndex === -1 ? target.tags.length - 1 : symbolIndex;
  target.tags.splice(insertAt, 0, ...importedTags);
  return { idMap, importedTags };
}

export function appendCharacterTag(target: SwfFile, tag: SwfTag): void {
  const symbolIndex = target.tags.findIndex((entry) => entry.code === TAG_SYMBOL_CLASS);
  const insertAt = symbolIndex === -1 ? target.tags.length - 1 : symbolIndex;
  target.tags.splice(insertAt, 0, tag);
}

// ---------------------------------------------------------------------------
// ABC constant-pool string renaming
// ---------------------------------------------------------------------------

function readU30(data: Buffer, pos: number): [number, number] {
  let result = 0;
  let shift = 0;
  for (let index = 0; index < 5; index += 1) {
    const byte = data[pos + index];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return [result >>> 0, pos + index + 1];
    shift += 7;
  }
  return [result >>> 0, pos + 5];
}

function writeU30(value: number): Buffer {
  const bytes: number[] = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return Buffer.from(bytes);
}

function skipU30(data: Buffer, pos: number, count: number): number {
  let offset = pos;
  for (let index = 0; index < count; index += 1) [, offset] = readU30(data, offset);
  return offset;
}

interface AbcTagLayout {
  tagIndex: number;
  abcStart: number;
}

function findAbcTag(swf: SwfFile): AbcTagLayout {
  for (let index = 0; index < swf.tags.length; index += 1) {
    const tag = swf.tags[index];
    if (tag.code === TAG_DO_ABC) {
      let offset = 4;
      while (tag.data[offset] !== 0) offset += 1;
      return { tagIndex: index, abcStart: offset + 1 };
    }
    if (tag.code === TAG_DO_ABC_DEPRECATED) return { tagIndex: index, abcStart: 0 };
  }
  throw new SwfLevelError("no DoABC tag found");
}

/**
 * Renames entries in the ABC string pool. Class names live there once, so this is
 * enough to turn an exported-but-unused symbol class into a class with a new name
 * without touching any bytecode.
 */
export function renameAbcStrings(swf: SwfFile, renames: Map<string, string>): number {
  const { tagIndex, abcStart } = findAbcTag(swf);
  const tag = swf.tags[tagIndex];
  const data = tag.data;

  let pos = abcStart + 4; // minor + major version
  let count: number;
  [count, pos] = readU30(data, pos);
  pos = skipU30(data, pos, Math.max(0, count - 1)); // integers
  [count, pos] = readU30(data, pos);
  pos = skipU30(data, pos, Math.max(0, count - 1)); // unsigned integers
  [count, pos] = readU30(data, pos);
  pos += Math.max(0, count - 1) * 8; // doubles

  const poolStart = pos;
  [count, pos] = readU30(data, pos);
  const strings: Buffer[] = [];
  for (let index = 1; index < count; index += 1) {
    let length: number;
    [length, pos] = readU30(data, pos);
    strings.push(Buffer.from(data.subarray(pos, pos + length)));
    pos += length;
  }
  const poolEnd = pos;

  // A class name usually appears twice: as the QName and as the protected
  // namespace URI. Both have to move together, so every match is replaced.
  let renamed = 0;
  const seen = new Set<string>();
  const rebuilt: Buffer[] = [writeU30(count)];
  for (const value of strings) {
    const text = value.toString("utf8");
    const replacement = renames.get(text);
    const out = replacement === undefined ? value : Buffer.from(replacement, "utf8");
    if (replacement !== undefined) {
      renamed += 1;
      seen.add(text);
    }
    rebuilt.push(writeU30(out.length), out);
  }
  const missing = [...renames.keys()].filter((name) => !seen.has(name));
  if (missing.length > 0) {
    throw new SwfLevelError(`ABC string pool is missing: ${missing.join(", ")}`);
  }
  for (const target of renames.values()) {
    if (strings.some((value) => value.toString("utf8") === target)) {
      throw new SwfLevelError(`ABC string pool already defines ${target}`);
    }
  }

  swf.tags[tagIndex] = {
    code: tag.code,
    data: Buffer.concat([data.subarray(0, poolStart), ...rebuilt, data.subarray(poolEnd)]),
  };
  return renamed;
}

export function readAbcStrings(swf: SwfFile): string[] {
  const { abcStart } = findAbcTag(swf);
  const data = swf.tags[findAbcTag(swf).tagIndex].data;
  let pos = abcStart + 4;
  let count: number;
  [count, pos] = readU30(data, pos);
  pos = skipU30(data, pos, Math.max(0, count - 1));
  [count, pos] = readU30(data, pos);
  pos = skipU30(data, pos, Math.max(0, count - 1));
  [count, pos] = readU30(data, pos);
  pos += Math.max(0, count - 1) * 8;
  [count, pos] = readU30(data, pos);
  const strings: string[] = [];
  for (let index = 1; index < count; index += 1) {
    let length: number;
    [length, pos] = readU30(data, pos);
    strings.push(data.subarray(pos, pos + length).toString("utf8"));
    pos += length;
  }
  return strings;
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

export interface Bounds {
  /** Twips. */
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

const SHAPE_TAGS = new Set([2, 22, 32, 83]);

/**
 * Union of a character's drawn area, in twips relative to its own origin.
 * Shapes carry a bounds RECT; sprites are unioned from their placements.
 */
export function characterBounds(
  swf: SwfFile,
  id: number,
  skip?: (childId: number) => boolean,
): Bounds | null {
  const byId = characterTagsById(swf);
  const cache = new Map<number, Bounds | null>();

  function walk(current: number, depth: number): Bounds | null {
    if (cache.has(current)) return cache.get(current) as Bounds | null;
    const tag = byId.get(current);
    if (!tag) return null;
    if (SHAPE_TAGS.has(tag.code)) {
      const reader = new BitReader(tag.data, 2);
      const bits = reader.ub(5);
      const box = { xMin: reader.sb(bits), xMax: reader.sb(bits), yMin: reader.sb(bits), yMax: reader.sb(bits) };
      cache.set(current, box);
      return box;
    }
    if (tag.code !== TAG_DEFINE_SPRITE || depth > 12) return null;
    cache.set(current, null); // cycle guard
    let box: Bounds | null = null;
    for (const inner of spriteInnerTags(tag)) {
      if (inner.code !== TAG_PLACE_OBJECT2 && inner.code !== TAG_PLACE_OBJECT3) continue;
      const place = parsePlace(inner);
      if (place.charId === null) continue;
      if (skip && skip(place.charId)) continue;
      const child = walk(place.charId, depth + 1);
      if (!child) continue;
      const matrix = place.matrix;
      const scaleX = matrix ? matrix.scaleX : 1;
      const scaleY = matrix ? matrix.scaleY : 1;
      const offsetX = matrix ? matrix.translateX : 0;
      const offsetY = matrix ? matrix.translateY : 0;
      const xs = [child.xMin * scaleX + offsetX, child.xMax * scaleX + offsetX];
      const ys = [child.yMin * scaleY + offsetY, child.yMax * scaleY + offsetY];
      const next: Bounds = {
        xMin: Math.min(...xs),
        xMax: Math.max(...xs),
        yMin: Math.min(...ys),
        yMax: Math.max(...ys),
      };
      box = box
        ? {
            xMin: Math.min(box.xMin, next.xMin),
            xMax: Math.max(box.xMax, next.xMax),
            yMin: Math.min(box.yMin, next.yMin),
            yMax: Math.max(box.yMax, next.yMax),
          }
        : next;
    }
    cache.set(current, box);
    return box;
  }

  return walk(id, 0);
}

/** Depth-first walk of a sprite's placements, reporting positions in pixels. */
export function walkPlacements(
  swf: SwfFile,
  rootId: number,
  visit: (info: { charId: number; name: string | null; x: number; y: number; depth: number }) => boolean | void,
  maxDepth = 4,
): void {
  const byId = characterTagsById(swf);
  function walk(id: number, offsetX: number, offsetY: number, depth: number): void {
    const tag = byId.get(id);
    if (!tag || tag.code !== TAG_DEFINE_SPRITE || depth > maxDepth) return;
    for (const inner of spriteInnerTags(tag)) {
      if (inner.code !== TAG_PLACE_OBJECT2 && inner.code !== TAG_PLACE_OBJECT3) continue;
      const place = parsePlace(inner);
      if (place.charId === null) continue;
      const x = offsetX + (place.matrix ? place.matrix.translateX / 20 : 0);
      const y = offsetY + (place.matrix ? place.matrix.translateY / 20 : 0);
      const descend = visit({ charId: place.charId, name: place.name, x, y, depth });
      if (descend) walk(place.charId, x, y, depth + 1);
    }
  }
  walk(rootId, 0, 0, 0);
}

export function ensureBackup(filePath: string): string {
  const backupPath = `${filePath}.bak`;
  if (!fs.existsSync(backupPath)) fs.copyFileSync(filePath, backupPath);
  return backupPath;
}
