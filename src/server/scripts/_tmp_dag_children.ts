import * as fs from "fs";
import * as zlib from "zlib";
import { parsePlace } from "./swfLevelUtils";

const raw = fs.readFileSync("../client/content/localhost/p/cbp/UI_1.swf");
const sig = raw.subarray(0, 3).toString("ascii");
const body = sig === "CWS" ? zlib.inflateSync(raw.subarray(8)) : Buffer.from(raw.subarray(8));

function rectByteLen(buf: Buffer, offset: number): number {
  return Math.ceil((5 + (buf[offset] >> 3) * 4) / 8);
}

function parseTags(buf: Buffer, start: number, end: number) {
  const out: Array<{ code: number; dataStart: number; end: number; data: Buffer }> = [];
  let off = start;
  while (off < end - 1) {
    const th = buf.readUInt16LE(off);
    const code = th >> 6;
    let len = th & 0x3f;
    let hl = 2;
    if (len === 0x3f) { len = buf.readUInt32LE(off + 2); hl = 6; }
    out.push({ code, dataStart: off + hl, end: off + hl + len, data: buf.subarray(off + hl, off + hl + len) });
    off += hl + len;
    if (code === 0) break;
  }
  return out;
}

const tags = parseTags(body, rectByteLen(body, 0) + 4, body.length);
const spriteIds = new Set(tags.filter((t) => t.code === 39).map((t) => t.data.readUInt16LE(0)));
console.log("total sprites:", spriteIds.size);
console.log("has 182:", spriteIds.has(182), " has 256:", spriteIds.has(256), " has 2155:", spriteIds.has(2155), " has 2156:", spriteIds.has(2156));

// exports map
const exportsMap = new Map<number, string[]>();
for (const t of tags) {
  if (t.code === 56 || t.code === 76) {
    const count = t.data.readUInt16LE(0);
    let p = 2;
    for (let i = 0; i < count && p < t.data.length; i += 1) {
      const id = t.data.readUInt16LE(p);
      p += 2;
      const end = t.data.indexOf(0, p);
      const name = t.data.subarray(p, end).toString("utf8");
      p = end + 1;
      const list = exportsMap.get(id) ?? [];
      list.push(name);
      exportsMap.set(id, list);
    }
  }
}
console.log("export 182:", exportsMap.get(182));
console.log("export 256:", exportsMap.get(256));
console.log("export 2155:", exportsMap.get(2155));
console.log("export 2156:", exportsMap.get(2156));

// Decode the dagger sprite 2157's stream
const dag = tags.find((t) => t.code === 39 && t.data.readUInt16LE(0) === 2157)!;
const stream = dag.data.subarray(4);
const sub = parseTags(stream, 0, stream.length);
console.log("\nsprite 2157 stream tags:", sub.map((t) => t.code).join(","));
for (const t of sub) {
  if (t.code !== 26 && t.code !== 70) continue;
  const d = t.data;
  const flags = d[0];
  let p = 1;
  const flags2 = t.code === 70 ? d[1] : 0;
  if (t.code === 70) p = 2;
  const depth = d.readUInt16LE(p);
  p += 2;
  let charId: number | null = null;
  let matrixStart = -1;
  // two conventions:
  // A (dye patch): charId right after depth
  const aCharId = flags & 0x02 ? d.readUInt16LE(p) : null;
  // B (spec, HasImage at flags2&0x01): skip image id u16 before charId
  let pB = p;
  if (t.code === 70 && (flags2 & 0x01)) pB += 2;
  const bCharId = flags & 0x02 ? d.readUInt16LE(pB) : null;
  if (flags & 0x02) {
    charId = bCharId ?? aCharId;
    matrixStart = (flags & 0x04) ? pB + 2 : -1;
  }
  console.log(`  tag ${t.code} depth=${depth} convA_charId=${aCharId} convB_charId=${bCharId} matrixStart=${matrixStart}`);
  if (matrixStart > 0) {
    // use repo parsePlace to decode the whole placement
    const info = parsePlace({ code: t.code, data: d } as never);
    const m = info.matrix;
    console.log(`    matrix: sx=${m?.scaleX} sy=${m?.scaleY} r0=${m?.rotateSkew0} r1=${m?.rotateSkew1} tx=${m?.translateX} ty=${m?.translateY}`);
  }
}
