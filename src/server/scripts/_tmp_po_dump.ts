import * as fs from "fs";
import * as zlib from "zlib";

function parseSwfBody(filePath: string): { body: Buffer } {
  const raw = fs.readFileSync(filePath);
  const signature = raw.subarray(0, 3).toString("ascii");
  const body = signature === "CWS" ? zlib.inflateSync(raw.subarray(8)) : Buffer.from(raw.subarray(8));
  return { body };
}

function readRect(data: Buffer, pos: number): { end: number } {
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
  const signed = (count: number): number => {
    const v = readBits(count);
    return v & (1 << (count - 1)) ? v - (1 << count) : v;
  };
  signed(nbits); signed(nbits); signed(nbits); signed(nbits);
  return { end: Math.ceil(bitPos / 8) };
}

function tags(data: Buffer, start: number, end: number): Array<{ type: number; data: Buffer }> {
  const out: Array<{ type: number; data: Buffer }> = [];
  let pos = start;
  while (pos + 2 <= end && pos + 2 <= data.length) {
    const h = data.readUInt16LE(pos);
    pos += 2;
    const type = h >> 6;
    let len = h & 0x3f;
    if (len === 0x3f) {
      len = data.readUInt32LE(pos);
      pos += 4;
    }
    if (pos + len > end) break;
    out.push({ type, data: data.subarray(pos, pos + len) });
    pos += len;
  }
  return out;
}

const file = "../client/content/localhost/p/cbp/UI_1.swf";
const { body } = parseSwfBody(file);
const rect = readRect(body, 0);
const tagStart = rect.end + 4;

const sprites = new Map<number, Buffer>();
const exports_ = new Map<number, string[]>();
for (const t of tags(body, tagStart, body.length)) {
  if (t.type === 39) {
    const id = t.data.readUInt16LE(0);
    sprites.set(id, t.data.subarray(4));
  } else if (t.type === 56 || t.type === 76) {
    const count = t.data.readUInt16LE(0);
    let pos = 2;
    for (let i = 0; i < count && pos < t.data.length; i += 1) {
      const tagId = t.data.readUInt16LE(pos);
      pos += 2;
      const end = t.data.indexOf(0, pos);
      if (end < 0) break;
      const name = t.data.subarray(pos, end).toString("utf8");
      pos = end + 1;
      const list = exports_.get(tagId) ?? [];
      list.push(name);
      exports_.set(tagId, list);
    }
  }
}

const dag = [...exports_.entries()].find(([, n]) => n.includes("a_PowerIcon_PoisonDagger"));
if (!dag) throw new Error("dagger sprite not found");
console.log("dagger sprite id", dag[0], "names", dag[1]);
const stream = sprites.get(dag[0])!;
console.log("stream hex:", stream.subarray(0, 80).toString("hex"));

for (const t of tags(stream, 0, stream.length)) {
  if (t.type === 26 || t.type === 70) {
    const flags = t.data[0];
    console.log(
      `type=${t.type} len=${t.data.length} flags=0x${flags.toString(16)} ` +
      `flags2=${t.data[1] !== undefined ? "0x" + t.data[1].toString(16) : "-"} ` +
      `charId(u16@1)=${t.data.length > 2 ? t.data.readUInt16LE(1) : "-"} ` +
      `charId(u16@2)=${t.data.length > 3 ? t.data.readUInt16LE(2) : "-"} ` +
      `hex=${t.data.toString("hex")}`,
    );
  } else {
    console.log(`type=${t.type} len=${t.data.length}`);
  }
}
