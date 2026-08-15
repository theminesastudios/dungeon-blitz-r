import * as fs from "fs";
import * as zlib from "zlib";

const raw = fs.readFileSync("../client/content/localhost/p/cbp/UI_1.swf");
const signature = raw.subarray(0, 3).toString("ascii");
const body = signature === "CWS" ? zlib.inflateSync(raw.subarray(8)) : Buffer.from(raw.subarray(8));

function readRectEnd(data: Buffer, pos: number): number {
  const nbits = data[pos] >> 3;
  let bitPos = pos * 8 + 5;
  const readBits = (count: number): number => {
    let value = 0;
    for (let i = 0; i < count; i += 1) {
      const byte = data[bitPos >> 3];
      const bit = (byte >> (7 - (bitPos & 7))) & 1;
      bitPos += 1;
      value = (value << 1) | bit;
    }
    return value;
  };
  for (let i = 0; i < 4; i += 1) readBits(nbits);
  return Math.ceil(bitPos / 8);
}

function tags(data: Buffer, start: number, end: number): Array<{ type: number; start: number; data: Buffer }> {
  const out: Array<{ type: number; start: number; data: Buffer }> = [];
  let pos = start;
  while (pos + 2 <= end && pos + 2 <= data.length) {
    const h = data.readUInt16LE(pos);
    const type = h >> 6;
    let len = h & 0x3f;
    let headEnd = pos + 2;
    if (len === 0x3f) {
      len = data.readUInt32LE(pos + 2);
      headEnd = pos + 6;
    }
    if (headEnd + len > end) break;
    out.push({ type, start: pos, data: data.subarray(headEnd, headEnd + len) });
    pos = headEnd + len;
  }
  return out;
}

const rectEnd = readRectEnd(body, 0);
const tagStart = rectEnd + 4;
const topTags = tags(body, tagStart, body.length);

// Find DefineSprite 2157
const dag = topTags.find((t) => t.type === 39 && t.data.readUInt16LE(0) === 2157);
if (!dag) throw new Error("sprite 2157 not found");
console.log("sprite 2157 tag start at body offset", dag.start, "len", dag.data.length);
const stream = dag.data.subarray(4); // skip charId + frameCount

for (const t of tags(stream, 0, stream.length)) {
  const d = t.data;
  const hex = d.toString("hex");
  if (t.type === 26 || t.type === 70) {
    const flags = d[0];
    let p = 1;
    const flags2 = t.type === 70 ? d[1] : 0;
    if (t.type === 70) p = 2;
    const depth = d.readUInt16LE(p);
    p += 2;
    let charId: number | null = null;
    let charIdOff: number | null = null;
    if (flags & 0x02) {
      charId = d.readUInt16LE(p);
      charIdOff = p;
      p += 2;
    }
    let matrixStart: number | null = null;
    if (flags & 0x04) matrixStart = p;
    console.log(
      `type=${t.type} len=${d.length} flags=0x${flags.toString(16)} flags2=${flags2} depth=${depth} ` +
        `charId=${charId} charIdOff=${charIdOff} matrixStart=${matrixStart}`,
    );
    console.log(`  hex=${hex}`);
  } else {
    console.log(`type=${t.type} len=${d.length}`);
  }
}
