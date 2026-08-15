import * as fs from "fs";
import * as zlib from "zlib";

function parseSwfBody(filePath: string): { body: Buffer; version: number } {
  const raw = fs.readFileSync(filePath);
  const signature = raw.subarray(0, 3).toString("ascii");
  const body = signature === "CWS" ? zlib.inflateSync(raw.subarray(8)) : Buffer.from(raw.subarray(8));
  const version = raw[3];
  return { body, version };
}

function readRect(data: Buffer, pos: number): { x1: number; x2: number; y1: number; y2: number; end: number } {
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
  const x1 = signed(nbits);
  const x2 = signed(nbits);
  const y1 = signed(nbits);
  const y2 = signed(nbits);
  return { x1, x2, y1, y2, end: Math.ceil(bitPos / 8) };
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

interface Matrix {
  scaleX: number;
  scaleY: number;
  rot0: number;
  rot1: number;
  tx: number;
  ty: number;
}

function readMatrix(buf: Buffer, offset: number): { m: Matrix; end: number } {
  const reader = new BitReader(buf, offset);
  const m: Matrix = { scaleX: 1, scaleY: 1, rot0: 0, rot1: 0, tx: 0, ty: 0 };
  if (reader.ub(1)) {
    const bits = reader.ub(5);
    m.scaleX = reader.sb(bits) / 65536;
    m.scaleY = reader.sb(bits) / 65536;
  }
  if (reader.ub(1)) {
    const bits = reader.ub(5);
    m.rot0 = reader.sb(bits) / 65536;
    m.rot1 = reader.sb(bits) / 65536;
  }
  const translateBits = reader.ub(5);
  m.tx = reader.sb(translateBits);
  m.ty = reader.sb(translateBits);
  reader.align();
  return { m, end: reader.offset };
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

class SwfData {
  sprites = new Map<number, Buffer>();
  shapes = new Map<number, { x1: number; y1: number; x2: number; y2: number }>();
  exports = new Map<number, string[]>();

  constructor(body: Buffer) {
    for (const t of tags(body, 0, body.length)) {
      if (t.type === 39) {
        const id = t.data.readUInt16LE(0);
        this.sprites.set(id, t.data.subarray(4));
      } else if (t.type === 2 || t.type === 22 || t.type === 32 || t.type === 83) {
        const r = readRect(t.data, 2);
        this.shapes.set(t.data.readUInt16LE(0), { x1: r.x1, y1: r.y1, x2: r.x2, y2: r.y2 });
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
          const list = this.exports.get(tagId) ?? [];
          list.push(name);
          this.exports.set(tagId, list);
        }
      }
    }
  }

  /** Parse a PlaceObject2/3 payload following the repo's swfLevelUtils order. */
  placeInfo(t: { type: number; data: Buffer }): { charId: number | null; matrix: Matrix | null } {
    const data = t.data;
    let offset = 0;
    const flags = data[offset];
    offset += 1;
    let flags2 = 0;
    if (t.type === 70) {
      flags2 = data[offset];
      offset += 1;
    }
    offset += 2; // depth
    if (t.type === 70 && (flags2 & 0x01) !== 0) {
      // className string (per repo's parsePlace)
      while (offset < data.length && data[offset] !== 0) offset += 1;
      offset += 1;
    }
    let charId: number | null = null;
    if ((flags & 0x02) !== 0 && offset + 2 <= data.length) {
      charId = data.readUInt16LE(offset);
      offset += 2;
    }
    let matrix: Matrix | null = null;
    if ((flags & 0x04) !== 0 && offset < data.length) {
      const r = readMatrix(data, offset);
      matrix = r.m;
    }
    return { charId, matrix };
  }

  boundsOf(spriteId: number): { x1: number; y1: number; x2: number; y2: number } | null {
    const acc: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    const visitSprite = (id: number, m: Matrix, depth: number): void => {
      if (depth > 10) return;
      const stream = this.sprites.get(id);
      if (!stream) return;
      for (const t of tags(stream, 0, stream.length)) {
        if (t.type === 2 || t.type === 22 || t.type === 32 || t.type === 83) {
          const sh = this.shapes.get(t.data.readUInt16LE(0));
          if (sh) {
            const [a, b] = transform(m, sh.x1, sh.y1);
            const [c, d] = transform(m, sh.x2, sh.y2);
            acc.push({ x1: Math.min(a, c), y1: Math.min(b, d), x2: Math.max(a, c), y2: Math.max(b, d) });
          }
        } else if (t.type === 39) {
          visitSprite(t.data.readUInt16LE(0), m, depth + 1);
        } else if (t.type === 26 || t.type === 70) {
          const p = this.placeInfo(t);
          if (p.charId !== null) {
            let childM = m;
            if (p.matrix) {
              childM = {
                scaleX: m.scaleX * p.matrix.scaleX,
                scaleY: m.scaleY * p.matrix.scaleY,
                rot0: m.rot0 + p.matrix.rot0,
                rot1: m.rot1 + p.matrix.rot1,
                tx: m.tx + p.matrix.tx,
                ty: m.ty + p.matrix.ty,
              };
            }
            visitSprite(p.charId, childM, depth + 1);
          }
        }
      }
    };
    visitSprite(spriteId, { scaleX: 1, scaleY: 1, rot0: 0, rot1: 0, tx: 0, ty: 0 }, 0);
    if (acc.length === 0) return null;
    return {
      x1: Math.min(...acc.map((r) => r.x1)),
      y1: Math.min(...acc.map((r) => r.y1)),
      x2: Math.max(...acc.map((r) => r.x2)),
      y2: Math.max(...acc.map((r) => r.y2)),
    };
  }
}

function transform(m: Matrix, x: number, y: number): [number, number] {
  const nx = m.scaleX * x + m.rot0 * y + m.tx;
  const ny = m.rot1 * x + m.scaleY * y + m.ty;
  return [nx, ny];
}

for (const file of ["UI_1.swf", "UI_2.swf"]) {
  const p = `../client/content/localhost/p/cbp/${file}`;
  if (!fs.existsSync(p)) continue;
  const { body } = parseSwfBody(p);
  const rect = readRect(body, 0);
  const tagStart = rect.end + 4;
  const swf = new SwfData(body.subarray(tagStart));
  console.log(`\n=== ${file}: ${swf.sprites.size} sprites, ${swf.shapes.size} shapes ===`);
  const named: Array<[number, string[]]> = [];
  for (const [id, names] of swf.exports) named.push([id, names]);
  for (const [id, names] of named) {
    if (names.includes("a_PowerIcon_PoisonDagger")) {
      const b = swf.boundsOf(id);
      console.log(`DAGGER: sprite ${id} ${names.join(",")} bounds=${b ? JSON.stringify(b) : "null"}`);
    }
  }
  let shown = 0;
  for (const [id, names] of named.sort((a, b) => a[0] - b[0])) {
    const st = names.find((n) => n.startsWith("a_StatusIcon_"));
    if (!st) continue;
    const b = swf.boundsOf(id);
    if (b) {
      console.log(`status ${id} ${names.join(",")} bounds=${JSON.stringify(b)}`);
      shown += 1;
      if (shown >= 10) break;
    }
  }
}
