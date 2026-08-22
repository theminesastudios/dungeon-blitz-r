import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

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

// Issue #729 follow-up: gear-set names longer than ~12 characters are stored
// fine (see patch-dungeonblitz-gear-set-name-length.ts) but the row label
// visually clips, because every am_GearSet row places the same edit text
// (character 1279 "am_SlideOutName") with a 2120-twip-wide bounds RECT.
//
// Widen Xmax 2080 -> 4095. Both values fit the RECT's existing 13-bit signed
// fields, so the tag keeps its byte length and nothing else in the file moves.
// 4095 twips (~205px) roughly doubles the visible characters; a full 32-char
// name still clips rather than colliding with the socket panel.
const CHAR_ID = 1279;
const OLD_XMAX = 2080;
const NEW_XMAX = 4095;

interface SwfFile {
  signature: string;
  version: number;
  body: Buffer;
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
        "  ts-node src/server/scripts/patch-ui4-gear-set-name-width.ts [--verify] [--swf <path>]",
        "",
        `Widens the Gear Manager row label (edit text ${CHAR_ID}) from ${OLD_XMAX} to ${NEW_XMAX} twips.`,
      ].join("\n"));
      process.exit(0);
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { swfPath, verify };
}

function parseSwfFile(filePath: string): SwfFile {
  const raw = fs.readFileSync(filePath);
  const signature = raw.subarray(0, 3).toString("ascii");
  if (signature !== "CWS" && signature !== "FWS") {
    throw new Error(`Unsupported SWF signature: ${signature}`);
  }
  return {
    signature,
    version: raw[3],
    body: signature === "CWS" ? zlib.inflateSync(raw.subarray(8)) : Buffer.from(raw.subarray(8)),
  };
}

function writeSwfFile(filePath: string, swf: SwfFile, body: Buffer): void {
  const header = Buffer.alloc(8);
  header.write(swf.signature, 0, "ascii");
  header[3] = swf.version;
  header.writeUInt32LE(8 + body.length, 4);
  fs.writeFileSync(
    filePath,
    swf.signature === "CWS" ? Buffer.concat([header, zlib.deflateSync(body)]) : Buffer.concat([header, body]),
  );
}

function ensureBackup(filePath: string): void {
  const backup = `${filePath}.bak`;
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(filePath, backup);
  }
}

// Walks the tag stream and returns the body offsets of every DefineEditTextTag.
function firstTagOffset(body: Buffer): number {
  // Skip the header's stage RECT (bit-packed) plus frame rate and frame count.
  const nBits = body[0] >> 3;
  return ((5 + 4 * nBits + 7) >> 3) + 4;
}

function defineEditTextTags(body: Buffer): number[] {
  const tags: number[] = [];
  let pos = firstTagOffset(body);
  while (pos + 2 <= body.length) {
    const codeAndLength = body.readUInt16LE(pos);
    const code = codeAndLength >> 6;
    let length = codeAndLength & 0x3f;
    let headerSize = 2;
    if (length === 0x3f) {
      if (pos + 6 > body.length) {
        break;
      }
      length = body.readUInt32LE(pos + 2);
      headerSize = 6;
    }
    if (code === 37) {
      // DefineEditTextTag
      tags.push(pos + headerSize);
    }
    pos += headerSize + length;
  }
  return tags;
}

// DefineEditText: CharacterID UI16, then a byte-aligned bounds RECT whose four
// signed fields share 5 bits of nBits with Xmin. With the stock nBits=13 the
// Xmax field sits at bit 18.
class BitFieldReaderWriter {
  constructor(private buffer: Buffer, private bitOffset: number) {}

  readSigned(bits: number): number {
    let value = 0;
    for (let index = 0; index < bits; index += 1) {
      const bit = (this.buffer[this.bitOffset >> 3] >> (7 - (this.bitOffset & 7))) & 1;
      value = (value << 1) | bit;
      this.bitOffset += 1;
    }
    if (value >= 1 << (bits - 1)) {
      value -= 1 << bits;
    }
    return value;
  }

  writeSigned(bits: number, value: number): void {
    for (let index = bits - 1; index >= 0; index -= 1) {
      const bit = (value >> index) & 1;
      const byteIndex = this.bitOffset >> 3;
      const mask = 1 << (7 - (this.bitOffset & 7));
      if (bit) {
        this.buffer[byteIndex] |= mask;
      } else {
        this.buffer[byteIndex] &= ~mask & 0xff;
      }
      this.bitOffset += 1;
    }
  }
}

export function patchGearSetNameWidth(swfPath: string, verifyOnly = false): void {
  const swf = parseSwfFile(swfPath);
  const sites = defineEditTextTags(swf.body).filter((bodyOffset) => swf.body.readUInt16LE(bodyOffset) === CHAR_ID);
  if (sites.length !== 1) {
    throw new Error(`Expected exactly one DefineEditText with characterID ${CHAR_ID}, found ${sites.length}.`);
  }

  const rectOffset = sites[0] + 2;
  const nBits = swf.body[rectOffset] >> 3;
  if (nBits !== 13) {
    throw new Error(`Edit text ${CHAR_ID} bounds use nBits=${nBits}, expected 13.`);
  }

  const fields = new BitFieldReaderWriter(swf.body, rectOffset * 8 + 5);
  const xmin = fields.readSigned(nBits);
  const xmax = fields.readSigned(nBits);
  const ymin = fields.readSigned(nBits);
  const ymax = fields.readSigned(nBits);

  const fingerprint = `${xmin},${xmax},${ymin},${ymax}`;
  if (xmax !== OLD_XMAX && xmax !== NEW_XMAX) {
    throw new Error(`Edit text ${CHAR_ID} bounds are (${fingerprint}), expected xmax ${OLD_XMAX} or ${NEW_XMAX}.`);
  }
  // Guard against the id being reused by different art after an upstream rebuild.
  if (xmin !== -40 || ymin !== -40 || ymax !== 464) {
    throw new Error(`Edit text ${CHAR_ID} bounds are (${fingerprint}), expected -40,${OLD_XMAX},-40,464.`);
  }

  const alreadyPatched = xmax === NEW_XMAX;
  if (!verifyOnly && !alreadyPatched) {
    ensureBackup(swfPath);
    new BitFieldReaderWriter(swf.body, rectOffset * 8 + 5 + nBits).writeSigned(nBits, NEW_XMAX);
    writeSwfFile(swfPath, swf, swf.body);
  }

  const check = parseSwfFile(swfPath);
  const checkSites = defineEditTextTags(check.body).filter((bodyOffset) => check.body.readUInt16LE(bodyOffset) === CHAR_ID);
  const checkFields = new BitFieldReaderWriter(check.body, checkSites[0] * 8 + 2 * 8 + 5 + nBits);
  const checkXmax = checkFields.readSigned(nBits);
  if (checkXmax !== NEW_XMAX) {
    throw new Error(`Gear set name width verification failed: xmax is ${checkXmax}`);
  }

  const verb = verifyOnly ? "Verified" : alreadyPatched ? "Already patched" : "Patched";
  console.log(`${verb} gear set row label width (${OLD_XMAX} -> ${NEW_XMAX} twips) in ${swfPath}`);
}

if (require.main === module) {
  try {
    const { swfPath, verify } = parseArgs(process.argv);
    patchGearSetNameWidth(swfPath, verify);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
