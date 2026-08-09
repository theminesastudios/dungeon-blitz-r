import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import { ensureBackup, PatchError } from "./swfPatchUtils";

const DEFAULT_SWF = path.resolve(
  __dirname,
  "..",
  "..",
  "client",
  "content",
  "localhost",
  "p",
  "cbp",
  "UI_4.swf",
);

// The Gear Manager's gear-set column is the am_GearSets sprite: six copies of
// one row clip, stacked at 51px intervals down the left card. ScreenArmory
// walks am_GearSet0..am_GearSet<count-1> by name, so raising the count in
// DungeonBlitz.swf (patch-dungeonblitz-gear-manager-slots.ts) without adding
// the clips here makes the constructor dereference null.
//
// Ten rows do not fit at the original size, and the card around them is a fixed
// shape, so the rows are scaled to 60% and re-pitched to match. The numbers
// below keep the block's outer box where it was: with the row clip's local
// bounds of x[-42,1001] y[-42,1000], ten rows at 0.6 span x 43.8..645.4 and
// y 28.8..6162 against the original 44..1087 and 29..6181.

const ROW_COUNT = 10;
const ROW_SCALE = 0.6;
const ROW_PITCH = 612;
const ROW_FIRST_X = 69;
const ROW_FIRST_Y = 54;
const ROW_DEPTH_STEP = 46;
const ROW_NAME_PREFIX = "am_GearSet";

const TAG_END = 0;
const TAG_SHOW_FRAME = 1;
const TAG_PLACE_OBJECT2 = 26;
const TAG_DEFINE_SPRITE = 39;

interface Swf {
  signature: "CWS" | "FWS";
  version: number;
  body: Buffer;
}

interface RowPlacement {
  charId: number;
  depth: number;
  name: string;
  scale: number;
  tx: number;
  ty: number;
}

interface GearSetsSprite {
  spriteId: number;
  tagStart: number;
  tagEnd: number;
  frameCount: number;
  rows: RowPlacement[];
  trailing: Buffer;
}

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;

  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  ts-node src/server/scripts/patch-ui4-gear-manager-slots.ts [--verify] [--swf <path>]",
        "",
        `Rebuilds the am_GearSets sprite in UI_4.swf with ${ROW_COUNT} rows scaled to`,
        "fit the existing Gear Manager card. Pair it with",
        "patch-dungeonblitz-gear-manager-slots.ts.",
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function readSwf(filePath: string): Swf {
  const raw = fs.readFileSync(filePath);
  const signature = raw.subarray(0, 3).toString("ascii");
  if (signature !== "CWS" && signature !== "FWS") {
    throw new PatchError(`Unsupported SWF signature: ${signature}`);
  }
  return {
    signature,
    version: raw[3],
    body: signature === "CWS" ? zlib.inflateSync(raw.subarray(8)) : Buffer.from(raw.subarray(8)),
  };
}

function writeSwfFile(filePath: string, swf: Swf, body: Buffer): void {
  const header = Buffer.alloc(8);
  header.write(swf.signature, 0, "ascii");
  header[3] = swf.version;
  header.writeUInt32LE(8 + body.length, 4);
  fs.writeFileSync(
    filePath,
    swf.signature === "CWS" ? Buffer.concat([header, zlib.deflateSync(body)]) : Buffer.concat([header, body]),
  );
}

class BitReader {
  private bit = 0;

  constructor(private readonly buffer: Buffer, private readonly start: number) {}

  read(count: number): number {
    let value = 0;
    for (let index = 0; index < count; index += 1) {
      const byte = this.buffer[this.start + (this.bit >> 3)];
      value = value * 2 + ((byte >> (7 - (this.bit & 7))) & 1);
      this.bit += 1;
    }
    return value;
  }

  readSigned(count: number): number {
    if (count === 0) {
      return 0;
    }
    const value = this.read(count);
    return value >= 2 ** (count - 1) ? value - 2 ** count : value;
  }

  get end(): number {
    return this.start + Math.ceil(this.bit / 8);
  }
}

class BitWriter {
  private readonly bits: number[] = [];

  write(value: number, count: number): void {
    for (let index = count - 1; index >= 0; index -= 1) {
      this.bits.push((value >> index) & 1);
    }
  }

  writeSigned(value: number, count: number): void {
    this.write(value < 0 ? value + 2 ** count : value, count);
  }

  toBuffer(): Buffer {
    const bytes: number[] = [];
    for (let index = 0; index < this.bits.length; index += 8) {
      let byte = 0;
      for (let offset = 0; offset < 8; offset += 1) {
        byte = (byte << 1) | (this.bits[index + offset] ?? 0);
      }
      bytes.push(byte);
    }
    return Buffer.from(bytes);
  }
}

function signedBitsNeeded(value: number): number {
  let count = 1;
  while (value < -(2 ** (count - 1)) || value > 2 ** (count - 1) - 1) {
    count += 1;
  }
  return count;
}

function readMatrix(buffer: Buffer, start: number): { scaleX: number; tx: number; ty: number; end: number } {
  const reader = new BitReader(buffer, start);
  let scaleX = 1;
  if (reader.read(1)) {
    const bits = reader.read(5);
    scaleX = reader.readSigned(bits) / 65536;
    reader.readSigned(bits);
  }
  if (reader.read(1)) {
    const bits = reader.read(5);
    reader.readSigned(bits);
    reader.readSigned(bits);
  }
  const translateBits = reader.read(5);
  const tx = reader.readSigned(translateBits);
  const ty = reader.readSigned(translateBits);
  return { scaleX, tx, ty, end: reader.end };
}

function writeMatrix(scale: number, tx: number, ty: number): Buffer {
  const fixed = Math.round(scale * 65536);
  const scaleBits = signedBitsNeeded(fixed);
  const translateBits = Math.max(signedBitsNeeded(tx), signedBitsNeeded(ty));

  const writer = new BitWriter();
  writer.write(1, 1);
  writer.write(scaleBits, 5);
  writer.writeSigned(fixed, scaleBits);
  writer.writeSigned(fixed, scaleBits);
  writer.write(0, 1);
  writer.write(translateBits, 5);
  writer.writeSigned(tx, translateBits);
  writer.writeSigned(ty, translateBits);
  return writer.toBuffer();
}

function readTagHeader(buffer: Buffer, at: number): { type: number; dataStart: number; dataEnd: number } {
  const header = buffer.readUInt16LE(at);
  let pos = at + 2;
  let length = header & 0x3f;
  if (length === 0x3f) {
    length = buffer.readUInt32LE(pos);
    pos += 4;
  }
  return { type: header >> 6, dataStart: pos, dataEnd: pos + length };
}

function writeTag(type: number, data: Buffer): Buffer {
  if (data.length < 0x3f) {
    const header = Buffer.alloc(2);
    header.writeUInt16LE((type << 6) | data.length, 0);
    return Buffer.concat([header, data]);
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE((type << 6) | 0x3f, 0);
  header.writeUInt32LE(data.length, 2);
  return Buffer.concat([header, data]);
}

function readCString(buffer: Buffer, start: number): { value: string; end: number } {
  let end = start;
  while (buffer[end] !== 0) {
    end += 1;
  }
  return { value: buffer.toString("utf8", start, end), end: end + 1 };
}

function decodeRow(buffer: Buffer, dataStart: number): RowPlacement | null {
  let pos = dataStart;
  const flags = buffer[pos];
  pos += 1;
  const depth = buffer.readUInt16LE(pos);
  pos += 2;
  if (!(flags & 0x02) || !(flags & 0x04) || !(flags & 0x20)) {
    return null;
  }
  const charId = buffer.readUInt16LE(pos);
  pos += 2;
  const matrix = readMatrix(buffer, pos);
  pos = matrix.end;
  if (flags & 0x08 || flags & 0x10) {
    // The shipped row placements carry neither a colour transform nor a ratio.
    return null;
  }
  const name = readCString(buffer, pos);
  return { charId, depth, name: name.value, scale: matrix.scaleX, tx: matrix.tx, ty: matrix.ty };
}

function encodeRow(row: RowPlacement): Buffer {
  const head = Buffer.alloc(5);
  head[0] = 0x02 | 0x04 | 0x20;
  head.writeUInt16LE(row.depth, 1);
  head.writeUInt16LE(row.charId, 3);
  return Buffer.concat([
    head,
    writeMatrix(row.scale, row.tx, row.ty),
    Buffer.from(`${row.name}\0`, "utf8"),
  ]);
}

function findGearSetsSprite(body: Buffer): GearSetsSprite {
  const found: GearSetsSprite[] = [];

  const walk = (start: number, end: number): void => {
    let pos = start;
    while (pos < end) {
      const tagStart = pos;
      const tag = readTagHeader(body, pos);
      if (tag.type === TAG_DEFINE_SPRITE) {
        const spriteId = body.readUInt16LE(tag.dataStart);
        const frameCount = body.readUInt16LE(tag.dataStart + 2);
        const rows: RowPlacement[] = [];
        let trailingStart = tag.dataEnd;
        let inner = tag.dataStart + 4;
        let sawRow = false;
        let clean = true;

        while (inner < tag.dataEnd) {
          const child = readTagHeader(body, inner);
          if (child.type === TAG_PLACE_OBJECT2) {
            const row = decodeRow(body, child.dataStart);
            if (row && row.name.startsWith(ROW_NAME_PREFIX)) {
              rows.push(row);
              sawRow = true;
              inner = child.dataEnd;
              continue;
            }
            if (sawRow) {
              clean = false;
            }
          } else if (sawRow && (child.type === TAG_SHOW_FRAME || child.type === TAG_END)) {
            trailingStart = inner;
            break;
          } else if (sawRow) {
            clean = false;
          }
          inner = child.dataEnd;
        }

        if (sawRow && clean) {
          found.push({
            spriteId,
            tagStart,
            tagEnd: tag.dataEnd,
            frameCount,
            rows,
            trailing: Buffer.from(body.subarray(trailingStart, tag.dataEnd)),
          });
        }
        walk(tag.dataStart + 4, tag.dataEnd);
      }
      pos = tag.dataEnd;
      if (tag.dataEnd <= tagStart) {
        break;
      }
    }
  };

  walk(headerEnd(body), body.length);

  if (found.length !== 1) {
    throw new PatchError(`Expected one am_GearSets sprite, found ${found.length}.`);
  }
  return found[0];
}

function headerEnd(body: Buffer): number {
  const nbits = body[0] >> 3;
  return Math.floor((5 + nbits * 4 + 7) / 8) + 4;
}

function desiredRows(charId: number): RowPlacement[] {
  const rows: RowPlacement[] = [];
  for (let index = 0; index < ROW_COUNT; index += 1) {
    rows.push({
      charId,
      depth: 1 + index * ROW_DEPTH_STEP,
      name: `${ROW_NAME_PREFIX}${index}`,
      scale: ROW_SCALE,
      tx: ROW_FIRST_X,
      ty: ROW_FIRST_Y + index * ROW_PITCH,
    });
  }
  return rows;
}

function rowsMatch(rows: RowPlacement[], wanted: RowPlacement[]): boolean {
  if (rows.length !== wanted.length) {
    return false;
  }
  return rows.every((row, index) => {
    const target = wanted[index];
    return (
      row.name === target.name &&
      row.charId === target.charId &&
      row.depth === target.depth &&
      row.tx === target.tx &&
      row.ty === target.ty &&
      Math.abs(row.scale - target.scale) < 1 / 65536
    );
  });
}

function inspect(swfPath: string): { swf: Swf; sprite: GearSetsSprite; wanted: RowPlacement[] } {
  const swf = readSwf(swfPath);
  const sprite = findGearSetsSprite(swf.body);

  const charIds = new Set(sprite.rows.map((row) => row.charId));
  if (charIds.size !== 1) {
    throw new PatchError(`am_GearSets rows use ${charIds.size} different clips, expected 1.`);
  }
  if (sprite.rows.length !== 6 && sprite.rows.length !== ROW_COUNT) {
    throw new PatchError(`am_GearSets has ${sprite.rows.length} rows, expected 6 or ${ROW_COUNT}.`);
  }

  return { swf, sprite, wanted: desiredRows(sprite.rows[0].charId) };
}

export function patchUi4GearManagerSlots(swfPath: string, verifyOnly = false): void {
  const first = inspect(swfPath);
  const alreadyPatched = rowsMatch(first.sprite.rows, first.wanted);

  if (!verifyOnly && !alreadyPatched) {
    const spriteHead = Buffer.alloc(4);
    spriteHead.writeUInt16LE(first.sprite.spriteId, 0);
    spriteHead.writeUInt16LE(first.sprite.frameCount, 2);

    const spriteData = Buffer.concat([
      spriteHead,
      ...first.wanted.map((row) => writeTag(TAG_PLACE_OBJECT2, encodeRow(row))),
      first.sprite.trailing,
    ]);

    const body = Buffer.concat([
      first.swf.body.subarray(0, first.sprite.tagStart),
      writeTag(TAG_DEFINE_SPRITE, spriteData),
      first.swf.body.subarray(first.sprite.tagEnd),
    ]);

    ensureBackup(swfPath);
    writeSwfFile(swfPath, first.swf, body);
  }

  const check = inspect(swfPath);
  if (!rowsMatch(check.sprite.rows, check.wanted)) {
    throw new PatchError(
      `am_GearSets verification failed: ${check.sprite.rows.length} rows ${check.sprite.rows
        .map((row) => `${row.name}@${row.tx},${row.ty}x${row.scale.toFixed(3)}`)
        .join(" ")}`,
    );
  }

  const verb = verifyOnly ? "Verified" : alreadyPatched ? "Already patched" : "Patched";
  console.log(`${verb} ${ROW_COUNT} am_GearSet rows at ${ROW_SCALE}x scale in ${swfPath}`);
}

if (require.main === module) {
  try {
    const { swfPath, verify } = parseArgs(process.argv);
    patchUi4GearManagerSlots(swfPath, verify);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
