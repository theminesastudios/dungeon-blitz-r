import * as path from "path";
import { readSwfFile, characterTagsById, splitTags, SwfTag } from "./swfLevelUtils";

function readCString(data: Buffer, pos: number): [string, number] {
  const start = pos;
  while (pos < data.length && data[pos] !== 0) pos += 1;
  return [data.subarray(start, pos).toString("utf8"), pos + 1];
}

function readU16(data: Buffer, pos: number): [number, number] { return [data.readUInt16LE(pos), pos + 2]; }

// MATRIX: scale(s), rotate(s), translate(fixed 8.8 or 16.16)
function skipMatrix(data: Buffer, pos: number): number {
  const first = data[pos];
  const hasScale = (first & 0x80) !== 0;
  const hasRotate = (first & 0x40) !== 0;
  const nbits = first & 0x1f;
  let bits = nbits;
  let p = pos + 1;
  if (hasScale) {
    const len = Math.ceil((bits + 5) / 8) * 2; // 2 values
    p += len;
  }
  if (hasRotate) {
    const len = Math.ceil((bits + 5) / 8) * 2;
    p += len;
  }
  // translate: 2 x (nbits + 8) bits
  p += Math.ceil((bits + 8) / 8) * 2;
  return p;
}

function skipCxform(data: Buffer, pos: number): number {
  const first = data[pos];
  const hasAdd = (first & 0x80) !== 0;
  const hasMult = (first & 0x40) !== 0;
  const nbits = first & 0x1f;
  let p = pos + 1;
  const nvals = (hasAdd ? 4 : 0) + (hasMult ? 4 : 0);
  if (nvals > 0) p += Math.ceil((nbits * nvals) / 8);
  return p;
}

function parsePlace(data: SwfTag): { charId: number | null; name: string; depth: number } {
  const isP3 = data.code === 70;
  let pos = 1; // flags
  if (isP3) pos += 1; // flags2
  const flags = data.data[0];
  const flags2 = isP3 ? data.data[1] : 0;
  const [depth, p1] = readU16(data.data, pos);
  pos = p1;
  let charId: number | null = null;
  if (flags & 0x02) { const [id, p] = readU16(data.data, pos); charId = id; pos = p; }
  if (flags & 0x01) pos = skipMatrix(data.data, pos);       // matrix
  if (flags & 0x04) pos = skipCxform(data.data, pos);        // color transform
  if (flags & 0x08) pos += 1;                                 // ratio
  let name = "";
  if (flags & 0x10) { const [n, p] = readCString(data.data, pos); name = n; pos = p; } // name
  return { charId, name, depth };
}

const swf = readSwfFile(path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "UI_1.swf"));
const chars = characterTagsById(swf);

function dumpSprite(id: number, label: string): void {
  const tag = chars.get(id);
  if (!tag || tag.code !== 39) { console.log(`${label} (chid ${id}): not a sprite`); return; }
  const frameCount = tag.data.readUInt16LE(2);
  console.log(`\n${label} (chid ${id}): frameCount=${frameCount}, dataLen=${tag.data.length}`);
  const inner = splitTags(tag.data, 4);
  for (const t of inner) {
    if (t.code === 26 || t.code === 70) {
      const p = parsePlace(t);
      console.log(`  PlaceObject${t.code === 70 ? 3 : 2} charId=${p.charId} depth=${p.depth} name=${JSON.stringify(p.name)}`);
    } else if (t.code === 39) {
      console.log(`  DefineSprite chid=${t.data.readUInt16LE(0)}`);
    } else if (t.code === 43) {
      const [l] = readCString(t.data, 2);
      console.log(`  FrameLabel "${l}"`);
    } else if (t.code === 0) break;
  }
}

dumpSprite(2565, "a_HealthHeart");
for (const id of [2560, 2562, 2564]) dumpSprite(id, `sub-sprite ${id}`);
