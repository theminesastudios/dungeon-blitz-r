import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

/**
 * Makes the gear tooltip's PowerRune line (`am_PowerTypeName`) able to render multiple lines.
 *
 * The field ships `multiline=false autoSize=false`, so the multi-line Descriptions that
 * `patch-mystic-rogue-power-mods.ts` writes for the Mystic items would collapse to one line. This
 * flips two bits in the DefineEditText tags that define the field:
 *
 *  - Multiline: embedded "\n" characters start new lines.
 *  - AutoSize:  the field grows to fit its content instead of clipping at the authored bounds.
 *
 * WordWrap deliberately stays off — with it on, a stock item whose one-line description is wider
 * than the authored bounds would suddenly wrap and overlap the proc lines. Without it, stock
 * single-line tooltips render exactly as before; only text that actually contains newlines changes.
 *
 * The flips are in-place single-byte ORs, so no tag length, offset, or checksum shifts.
 * `class_101` never assigns these properties at runtime (verified), so the tag bits stick.
 */
const TARGETS: Array<{ file: string; characterIds: number[] }> = [
  // Both files carry the tooltip art (two placements each: hover card and comparison card).
  { file: "UI_1.swf", characterIds: [394, 1875] },
  { file: "UI_4.swf", characterIds: [3903, 3920] },
];

const DEFINE_EDIT_TEXT = 37;
const FLAG1_MULTILINE = 0x20;
const FLAG2_AUTOSIZE = 0x40;

// DefineEditText flag bits used to locate the Leading field.
const FLAG1_HAS_FONT = 0x01;
const FLAG1_HAS_TEXT_COLOR = 0x04;
const FLAG1_HAS_MAX_LENGTH = 0x02;
const FLAG2_HAS_FONT_CLASS = 0x80;
const FLAG2_HAS_LAYOUT = 0x20;

/**
 * Leading (twips) is the extra space *between* lines. This was once -70 (a 3.5px squeeze) to cram the
 * six-ability Mystic block into a fixed-height card, which left the ability lines visibly crammed
 * versus a stock card's roomy rows. The card now grows to fit its content (see the am_Base sizing in
 * patch-dungeonblitz-mystic-rarity.ts), so the squeeze is no longer needed: 0 restores the authored
 * ~14px pitch and the block just makes the card a little taller. Leading only affects multi-line
 * text, so every stock single-line PowerRune tooltip renders byte-for-byte as before. Tunable — a
 * small positive value opens the rows up further to match the comparison card's spacing.
 */
const TARGET_LEADING = 80;

const UI_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp");

function parseArgs(argv: string[]): { verify: boolean } {
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npx ts-node src/server/scripts/patch-ui-tooltip-multiline.ts [--verify]",
        "",
        "Flips Multiline+AutoSize on the gear tooltip's am_PowerTypeName DefineEditText fields",
        "in UI_1.swf and UI_4.swf so multi-line PowerRune descriptions render.",
      ].join("\n"));
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { verify };
}

interface Swf {
  compressed: boolean;
  version: number;
  body: Buffer;
}

function readSwf(filePath: string): Swf {
  const raw = fs.readFileSync(filePath);
  const signature = raw.subarray(0, 3).toString("ascii");
  if (signature !== "FWS" && signature !== "CWS") {
    throw new Error(`${filePath}: not an SWF (signature ${signature}).`);
  }
  const body = signature === "CWS" ? zlib.inflateSync(raw.subarray(8)) : Buffer.from(raw.subarray(8));
  return { compressed: signature === "CWS", version: raw[3], body };
}

function writeSwfFile(filePath: string, swf: Swf): void {
  const header = Buffer.alloc(8);
  header.write(swf.compressed ? "CWS" : "FWS", 0, "ascii");
  header[3] = swf.version;
  header.writeUInt32LE(8 + swf.body.length, 4);
  const payload = swf.compressed ? zlib.deflateSync(swf.body) : swf.body;
  fs.writeFileSync(filePath, Buffer.concat([header, payload]));
}

/** Offset of the first tag: past the frame-size RECT, frame rate and frame count. */
function firstTagOffset(body: Buffer): number {
  const nbits = body[0] >> 3;
  const rectBytes = Math.ceil((5 + 4 * nbits) / 8);
  return rectBytes + 4;
}

/**
 * Flips the flags on one DefineEditText body in place. Layout: CharacterID (u16), Bounds (RECT),
 * then two flag bytes. Returns false when the bits were already set.
 */
function flipEditText(body: Buffer, tagStart: number, label: string): boolean {
  const nbits = body[tagStart + 2] >> 3;
  const rectBytes = Math.ceil((5 + 4 * nbits) / 8);
  const flags1Pos = tagStart + 2 + rectBytes;
  const flags2Pos = flags1Pos + 1;

  // Positional fingerprint: all four target fields carry HasText+HasFont+ReadOnly and HasLayout.
  // A wrong RECT skip would land on bytes that fail this and abort instead of corrupting art.
  const flags1 = body[flags1Pos];
  const flags2 = body[flags2Pos];
  if ((flags1 & 0x80) === 0 || (flags1 & 0x01) === 0 || (flags1 & 0x08) === 0) {
    throw new Error(`${label}: flag byte 1 is 0x${flags1.toString(16)}, expected HasText|ReadOnly|HasFont set.`);
  }
  if ((flags2 & 0x20) === 0) {
    throw new Error(`${label}: flag byte 2 is 0x${flags2.toString(16)}, expected HasLayout set.`);
  }

  // Leading (SI16) is the last HasLayout field. Walk the optional fields between the flags and it.
  let leadingPos: number | null = null;
  if ((flags2 & FLAG2_HAS_FONT_CLASS) !== 0) {
    throw new Error(`${label}: HasFontClass is set; the FontClass string parse is not implemented.`);
  }
  let cursor = flags2Pos + 1;
  if ((flags1 & FLAG1_HAS_FONT) !== 0) cursor += 4; // FontID u16 + FontHeight u16
  if ((flags1 & FLAG1_HAS_TEXT_COLOR) !== 0) cursor += 4; // RGBA
  if ((flags1 & FLAG1_HAS_MAX_LENGTH) !== 0) cursor += 2; // MaxLength u16
  if ((flags2 & FLAG2_HAS_LAYOUT) !== 0) {
    cursor += 1 + 2 + 2 + 2; // Align u8, LeftMargin u16, RightMargin u16, Indent u16
    leadingPos = cursor; // Leading SI16
  }

  const flagsAlready = (flags1 & FLAG1_MULTILINE) !== 0 && (flags2 & FLAG2_AUTOSIZE) !== 0;
  const leadingAlready = leadingPos !== null && body.readInt16LE(leadingPos) === TARGET_LEADING;
  body[flags1Pos] = flags1 | FLAG1_MULTILINE;
  body[flags2Pos] = flags2 | FLAG2_AUTOSIZE;
  if (leadingPos !== null) {
    body.writeInt16LE(TARGET_LEADING, leadingPos);
  }
  return !(flagsAlready && leadingAlready);
}

function patchFile(filePath: string, characterIds: number[], verify: boolean): number {
  const swf = readSwf(filePath);
  const body = swf.body;
  const wanted = new Set(characterIds);
  let flipped = 0;
  let seen = 0;

  let pos = firstTagOffset(body);
  while (pos + 2 <= body.length) {
    const codeAndLength = body.readUInt16LE(pos);
    const code = codeAndLength >> 6;
    let length = codeAndLength & 0x3f;
    let dataPos = pos + 2;
    if (length === 0x3f) {
      length = body.readUInt32LE(dataPos);
      dataPos += 4;
    }
    if (code === 0) break;

    if (code === DEFINE_EDIT_TEXT && length >= 5) {
      const characterId = body.readUInt16LE(dataPos);
      if (wanted.has(characterId)) {
        seen += 1;
        if (flipEditText(body, dataPos, `${path.basename(filePath)} #${characterId}`)) {
          flipped += 1;
        }
      }
    }
    pos = dataPos + length;
  }

  if (seen !== wanted.size) {
    throw new Error(`${path.basename(filePath)}: found ${seen} of ${wanted.size} target DefineEditText tags.`);
  }
  if (flipped > 0 && !verify) {
    const backupPath = `${filePath}.bak`;
    if (!fs.existsSync(backupPath)) fs.copyFileSync(filePath, backupPath);
    writeSwfFile(filePath, swf);
  }
  return flipped;
}

function run(): void {
  const { verify } = parseArgs(process.argv);
  const summary: string[] = [];
  let total = 0;

  for (const target of TARGETS) {
    const filePath = path.join(UI_DIR, target.file);
    const flipped = patchFile(filePath, target.characterIds, verify);
    summary.push(`${target.file}: ${flipped}/${target.characterIds.length} fields`);
    total += flipped;
  }

  if (total === 0) {
    console.log(`Already patched — ${summary.join("; ")}.`);
    return;
  }
  console.log(`${verify ? "WOULD PATCH" : "Patched"} — ${summary.join("; ")}.`);
}

run();
