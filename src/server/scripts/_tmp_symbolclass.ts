import * as fs from "fs";
import * as zlib from "zlib";

const raw = fs.readFileSync("../client/content/localhost/p/cbp/UI_1.swf");
const sig = raw.subarray(0, 3).toString("ascii");
const body = sig === "CWS" ? zlib.inflateSync(raw.subarray(8)) : Buffer.from(raw.subarray(8));

function rectByteLen(buf: Buffer, offset: number): number {
  return Math.ceil((5 + (buf[offset] >> 3) * 4) / 8);
}

function parseTags(buf: Buffer, start: number, end: number) {
  const out: Array<{ code: number; start: number; dataStart: number; end: number; data: Buffer }> = [];
  let off = start;
  while (off < end - 1) {
    const th = buf.readUInt16LE(off);
    const code = th >> 6;
    let len = th & 0x3f;
    let hl = 2;
    if (len === 0x3f) { len = buf.readUInt32LE(off + 2); hl = 6; }
    out.push({ code, start: off, dataStart: off + hl, end: off + hl + len, data: buf.subarray(off + hl, off + hl + len) });
    off += hl + len;
    if (code === 0) break;
  }
  return out;
}

const tags = parseTags(body, rectByteLen(body, 0) + 4, body.length);
console.log("tag codes present:", [...new Set(tags.map((t) => t.code))].sort((a, b) => a - b).join(","));

for (const t of tags) {
  if (t.code !== 56 && t.code !== 76) continue; // ExportAssets / SymbolClass
  const d = t.data;
  const count = d.readUInt16LE(0);
  let p = 2;
  const entries: Array<[number, string]> = [];
  for (let i = 0; i < count && p < d.length; i += 1) {
    const id = d.readUInt16LE(p);
    p += 2;
    const end = d.indexOf(0, p);
    const name = d.subarray(p, end).toString("utf8");
    p = end + 1;
    entries.push([id, name]);
  }
  const dag = entries.filter(([, n]) => n.includes("PoisonDagger") || n.includes("StatusIcon"));
  console.log(`\ntag code ${t.code} len=${d.length} count=${count} at offset ${t.start} (body)`);
  console.log("  PoisonDagger/StatusIcon entries:", dag.map(([id, n]) => `${id}:${n}`).join(", "));
  console.log("  sample:", entries.slice(0, 3).map(([id, n]) => `${id}:${n}`).join(", "));
}
