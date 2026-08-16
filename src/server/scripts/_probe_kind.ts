import * as path from "path";
import { parseAbc, parseSwf } from "./swfPatchUtils";

const SWF = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "DungeonBlitz.swf");

const ctx = parseSwf(SWF);
const abc = parseAbc(ctx);
const data = ctx.body;

function u30(pos: number): [number, number] {
  let value = 0, shift = 0;
  for (let i = 0; i < 5; i++) {
    const b = data[pos];
    pos += 1;
    value |= (b & 0x7f) << shift;
    if ((b & 0x80) === 0) return [value >>> 0, pos];
    shift += 7;
  }
  return [value >>> 0, pos];
}

// Walk from the string pool end: namespaces, ns_sets, then multinames.
let pos = abc.stringPoolEnd;
const nsCount = u30(pos)[0];
pos = u30(pos)[1];
for (let i = 1; i < nsCount; i++) {
  pos += 1; // ns kind byte
  pos = u30(pos)[1]; // ns name
}
const nsSetCount = u30(pos)[0];
pos = u30(pos)[1];
for (let i = 1; i < nsSetCount; i++) {
  const c = u30(pos)[0];
  pos = u30(pos)[1];
  for (let j = 0; j < c; j++) pos = u30(pos)[1];
}
const mnCount = u30(pos)[0];
pos = u30(pos)[1];
const kinds = new Map<number, number>();
const names = new Map<number, string>();
for (let i = 1; i < mnCount; i++) {
  const kind = data[pos];
  pos += 1;
  let nameIdx = 0;
  if (kind === 0x07 || kind === 0x0d) {
    pos = u30(pos)[1]; // ns
    [nameIdx, pos] = u30(pos);
  } else if (kind === 0x0f || kind === 0x10) {
    [nameIdx, pos] = u30(pos);
  } else if (kind === 0x11 || kind === 0x12) {
    nameIdx = 0;
  } else if (kind === 0x09 || kind === 0x0e) {
    [nameIdx, pos] = u30(pos);
    pos = u30(pos)[1]; // nsset
  } else if (kind === 0x1b || kind === 0x1c) {
    [nameIdx, pos] = u30(pos);
  } else if (kind === 0x1d) {
    pos = u30(pos)[1]; // qname
    const pc = u30(pos)[0];
    pos = u30(pos)[1];
    for (let j = 0; j < pc; j++) pos = u30(pos)[1];
  } else {
    throw new Error(`kind 0x${kind.toString(16)} at ${i}`);
  }
  kinds.set(i, kind);
  names.set(i, nameIdx < abc.stringValues.length ? abc.stringValues[nameIdx] : "");
}

const kindNames: Record<number, string> = {
  0x07: "QName", 0x0d: "QNameA", 0x0f: "RTQName", 0x10: "RTQNameA",
  0x11: "RTQNameL", 0x12: "RTQNameLA", 0x09: "Multiname", 0x0e: "MultinameA",
  0x1b: "MultinameL", 0x1c: "MultinameLA", 0x1d: "GenericType",
};

for (const idx of [2907, 14142, 2859, 698, 8]) {
  console.log(`mn[${idx}]: kind=0x${kinds.get(idx)?.toString(16)} (${kindNames[kinds.get(idx) ?? 0] ?? "?"}) name="${names.get(idx)}"`);
}
