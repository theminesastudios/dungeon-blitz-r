import * as path from "path";
import { readSwfFile, characterTagsById, splitTags, SwfTag, SwfFile } from "./swfLevelUtils";

function readCString(data: Buffer, pos: number): [string, number] {
  const start = pos;
  while (pos < data.length && data[pos] !== 0) pos += 1;
  return [data.subarray(start, pos).toString("utf8"), pos + 1];
}

function parsePlaceObject2(tag: SwfTag): { charId: number | null; name: string; depth: number } {
  const data = tag.data;
  const flags = data[0];
  let pos = 2;
  let depth = 0;
  while (pos < data.length) { const b = data[pos]; depth = (depth << 7) | (b & 0x7f); pos += 1; if (!(b & 0x80)) break; }
  let charId: number | null = null;
  if (flags & 0x02) {
    charId = data.readUInt16LE(pos); pos += 2;
  }
  // matrix/colorTransform etc. skipped by advancing via flag bits — do the cheap version: read name if present
  // We only need name for flag 0x40 and charId. To keep it simple, use a rough scanner: names are null-terminated strings.
  let name = "";
  if (flags & 0x40) {
    // find the name: after matrix (flag 0x01) and colorTransform (flag 0x04)... this is fiddly; scan forward for a printable run
    // PlaceObject2/3 layout: flags, depth, (hasMatrix: MATRIX), (hasColorTransform: CXFORM), (hasRatio 1 byte), (hasName: cstring), ...
    let offset = pos;
    const m = data;
    // We'll skip matrix (8-16 bytes) and cxform (variable) by searching for a null-terminated string near the end.
    const tail = m.subarray(offset);
    // crude: find longest printable ASCII run that looks like an instance name
    let best = "";
    let run = "";
    for (let i = 0; i < tail.length; i += 1) {
      const c = tail[i];
      if (c >= 0x20 && c < 0x7f) run += String.fromCharCode(c);
      else {
        if (run.length > best.length) best = run;
        run = "";
      }
    }
    name = best;
  }
  return { charId, name, depth };
}

const swf = readSwfFile(path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "UI_1.swf"));
const chars = characterTagsById(swf);
const hh = chars.get(2565);
if (!hh || hh.code !== 39) {
  console.log("a_HealthHeart (chid 2565) not found or not a DefineSprite");
} else {
  console.log("a_HealthHeart DefineSprite found, tag data length:", hh.data.length);
  const frameCount = hh.data.readUInt16LE(2);
  console.log("frameCount:", frameCount);
  const inner = splitTags(hh.data, 4); // spriteId u16, frameCount u16, then tags
  console.log("inner tags:", inner.length);
  for (const tag of inner) {
    if (tag.code === 39) {
      const id = tag.data.readUInt16LE(0);
      console.log(`  DefineSprite chid=${id}`);
    } else if (tag.code === 26 || tag.code === 70) {
      // PlaceObject2/3: try to extract instance name
      const p = parsePlaceObject2(tag);
      console.log(`  PlaceObject charId=${p.charId} depth=${p.depth} name=${JSON.stringify(p.name)}`);
    } else if (tag.code === 76) {
      let pos = 0;
      const count = tag.data.readUInt16LE(pos); pos += 2;
      for (let i = 0; i < count; i += 1) {
        const id = tag.data.readUInt16LE(pos); pos += 2;
        const [n, next] = readCString(tag.data, pos); pos = next;
        console.log(`  SymbolClass chid=${id} -> ${n}`);
      }
    } else if (tag.code === 43) {
      const [label] = readCString(tag.data, 2);
      console.log(`  FrameLabel: ${label}`);
    } else if (tag.code === 1) {
      // ShowFrame — count frames implicitly
    } else if (tag.code === 0) {
      break;
    }
  }
}

// Also list any sprite whose name starts with am_ or Status in UI_1 exports near HealthHeart
console.log("\n== UI_1 exported symbols containing am_ or Status ==");
for (const [id, tag] of chars) {
  if (tag.code !== 39) continue;
  // check SymbolClass
}
// SymbolClass listing
for (const tag of swf.tags) {
  if (tag.code !== 76) continue;
  let pos = 0;
  const count = tag.data.readUInt16LE(pos); pos += 2;
  for (let i = 0; i < count; i += 1) {
    const id = tag.data.readUInt16LE(pos); pos += 2;
    const [n, next] = readCString(tag.data, pos); pos = next;
    if (/am_|Status/i.test(n) && /Health/i.test(n)) console.log(`  chid ${id}: ${n}`);
  }
}
