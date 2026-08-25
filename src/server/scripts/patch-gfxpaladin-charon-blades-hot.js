/**
 * Charon's Blades blade art: a four-step heat ramp.
 *
 * Viperblade's Charon's Blades already swaps the player's weapons for
 * `a_Sword_SeekingBlades` (right blade) and `a_Offhand_SeekingBlades` (left
 * blade), both in Gfx_Paladin_1.swf. Those are single-frame sprites that each
 * place one shape: 879 for the right blade, 883 for the left.
 *
 * The Abomination Spider's `a_TalonPowerOn` / `a_TalonOn` / `a_TalonPowerOff`
 * are not separate artwork -- they are one talon shape with a red-hot overlay
 * alpha-tweened in and out, and that tween is driven by the spider's own
 * animation sequence. The player rig has no such sequence, and
 * `SuperAnimData.method_866` flattens the whole character into one cached
 * bitmap per animation frame (`method_982`), so a blade cannot be recoloured
 * frame by frame at runtime. Every intermediate tone has to be its own symbol,
 * which the client then selects by CustomArt name -- see
 * patch-dungeonblitz-charon-blades-phases.
 *
 * So the tween becomes a four-step ramp. This script builds levels 1..4, each
 * the Charon blade shape behind a progressively hotter CXFORMWITHALPHA, level 4
 * being full ember. Level 0 is the stock steel art and needs no symbol.
 *
 * Why placeholders instead of new symbols: a new symbol needs a matching AS3
 * class in the SWF's ABC, because SuperAnimData resolves art by class name. The
 * eight classes below are unreferenced dev leftovers -- none of their names
 * appears in Game.swz, Login.swz or the loose XML -- so retargeting them keeps
 * this a pure art edit with no ABC surgery.
 *
 * Four is not an arbitrary number: Gfx_Paladin_1.swf has exactly four unused
 * `a_Offhand_*` classes (against 37 unused `a_Sword_*`), so the left blade caps
 * the ramp. That happens to match the performance ceiling too, since each level
 * is a distinct GfxType and therefore its own character bake.
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SWF = path.resolve(
  __dirname,
  "..",
  "..",
  "client",
  "content",
  "localhost",
  "p",
  "cbp",
  "Gfx_Paladin_1.swf",
);

const LEVELS = 4;

const RIGHT_BLADE_SHAPE = 879;
const LEFT_BLADE_SHAPE = 883;

// The stock blade sprites. Their PlaceObject2 supplies the matrix, so every
// level sits exactly where the stock blade sits rather than where whichever
// placeholder weapon used to sit.
const RIGHT_BLADE_SOURCE = 880; // a_Sword_SeekingBlades
const LEFT_BLADE_SOURCE = 884; // a_Offhand_SeekingBlades

// level -> the two dead placeholder sprites that carry it.
// Keep in step with HOT_SETS in patch-dungeonblitz-charon-blades-phases.ts.
const RAMP = [
  { level: 1, sword: 148, offhand: 1350, names: "SWORD00PLACEHOLDER + OFFHAND00PLACEHOLDER" },
  { level: 2, sword: 267, offhand: 1316, names: "MACE00PLACEHOLDER + OffhandSabre02" },
  { level: 3, sword: 395, offhand: 1282, names: "AXE00PLACEHOLDER + OffhandScepter03" },
  { level: 4, sword: 1232, offhand: 1274, names: "RAPIER00PLACEHOLDER + OffhandScepter07" },
];

// out = in * mult / 256 + add, per channel, interpolated from identity at
// level 0 to full ember at level 4.
//
// The work is done by the multipliers, not by an additive term. An additive red
// lifts the near-black outlines by exactly as much as the light metal, which
// collapses the blade's tonal range and reads in game as a flat red slab with
// no linework -- an early build did that with red +100 and it looked
// painted-over rather than hot. Scaling keeps every tone's ratio, so the
// outlines stay dark and the highlights carry the glow.
//
// Green is held above blue, which is what makes the top of the ramp read as
// ember rather than pure crimson: the mid greys pick up an orange cast while
// the existing red veins, already blue-free, saturate straight to #FF0000.
const EMBER = { redMult: 384, greenMult: 64, blueMult: 51, redAdd: 8 };

// Interpolating the multipliers linearly puts almost all of the visible change
// in the last step -- levels 1 to 3 came out nearly identical. Easing the
// parameter spreads the heat evenly across the four steps instead.
const RAMP_EASE = 0.65;

function rampCxform(level) {
  const t = Math.pow(level / LEVELS, RAMP_EASE);
  const lerp = (from, to) => Math.round(from + (to - from) * t);
  return {
    redMult: lerp(256, EMBER.redMult),
    greenMult: lerp(256, EMBER.greenMult),
    blueMult: lerp(256, EMBER.blueMult),
    alphaMult: 256,
    redAdd: lerp(0, EMBER.redAdd),
    greenAdd: 0,
    blueAdd: 0,
    alphaAdd: 0,
  };
}

class BitWriter {
  constructor() {
    this.bits = [];
  }
  ub(value, n) {
    for (let i = n - 1; i >= 0; i -= 1) this.bits.push((value >> i) & 1);
    return this;
  }
  sb(value, n) {
    return this.ub(value < 0 ? value + (1 << n) : value, n);
  }
  toBuffer() {
    while (this.bits.length % 8 !== 0) this.bits.push(0);
    const out = Buffer.alloc(this.bits.length / 8);
    this.bits.forEach((bit, i) => {
      if (bit) out[i >> 3] |= 0x80 >> (i & 7);
    });
    return out;
  }
}

/** Bits needed to hold every term as a *signed* value, which is how SB[] reads them. */
function signedBits(values) {
  let nbits = 2;
  for (const value of values) {
    while (value > (1 << (nbits - 1)) - 1 || value < -(1 << (nbits - 1))) nbits += 1;
  }
  if (nbits > 15) throw new Error(`Colour transform needs ${nbits} bits; Nbits is a UB[4] field.`);
  return nbits;
}

function buildCxform(c) {
  // CXFORMWITHALPHA: HasAddTerms UB[1], HasMultTerms UB[1], Nbits UB[4],
  // then 4 mult SB[Nbits] followed by 4 add SB[Nbits].
  //
  // Nbits is sized from the terms rather than fixed: at a fixed 10 an over-1.0
  // multiplier silently wraps (512 reads back as -512, and the blade renders
  // black), which is a bug that already cost one build.
  const nbits = signedBits([
    c.redMult, c.greenMult, c.blueMult, c.alphaMult,
    c.redAdd, c.greenAdd, c.blueAdd, c.alphaAdd,
  ]);
  const w = new BitWriter();
  w.ub(1, 1).ub(1, 1).ub(nbits, 4);
  w.sb(c.redMult, nbits).sb(c.greenMult, nbits).sb(c.blueMult, nbits).sb(c.alphaMult, nbits);
  w.sb(c.redAdd, nbits).sb(c.greenAdd, nbits).sb(c.blueAdd, nbits).sb(c.alphaAdd, nbits);
  return w.toBuffer();
}

function mkTag(code, data) {
  if (data.length < 0x3f) {
    const h = Buffer.alloc(2);
    h.writeUInt16LE((code << 6) | data.length, 0);
    return Buffer.concat([h, data]);
  }
  const h = Buffer.alloc(6);
  h.writeUInt16LE((code << 6) | 0x3f, 0);
  h.writeUInt32LE(data.length, 2);
  return Buffer.concat([h, data]);
}

function load(file) {
  const raw = fs.readFileSync(file);
  const sig = raw.slice(0, 3).toString("latin1");
  if (sig === "CWS") return { sig, head: Buffer.from(raw.slice(0, 8)), body: zlib.inflateSync(raw.slice(8)) };
  if (sig === "FWS") return { sig, head: Buffer.from(raw.slice(0, 8)), body: Buffer.from(raw.slice(8)) };
  throw new Error(`Unsupported SWF signature ${sig}`);
}

function save(file, swf) {
  const head = Buffer.from(swf.head);
  head.writeUInt32LE(8 + swf.body.length, 4);
  const payload = swf.sig === "CWS" ? zlib.deflateSync(swf.body, { level: 9 }) : swf.body;
  fs.writeFileSync(file, Buffer.concat([head, payload]));
}

function rectLen(body) {
  return Math.ceil((5 + (body[0] >> 3) * 4) / 8);
}

function walkTags(body) {
  let pos = rectLen(body) + 4;
  const out = [];
  while (pos < body.length - 1) {
    const tagStart = pos;
    const th = body.readUInt16LE(pos);
    pos += 2;
    const code = th >> 6;
    let len = th & 0x3f;
    if (len === 0x3f) {
      len = body.readUInt32LE(pos);
      pos += 4;
    }
    out.push({ code, len, dataStart: pos, tagStart, tagEnd: pos + len });
    pos += len;
    if (code === 0) break;
  }
  return out;
}

/** The single PlaceObject2 inside a one-frame sprite. */
function readSpritePlacement(body, tag) {
  let pos = tag.dataStart + 4; // skip spriteId + frameCount
  while (pos < tag.tagEnd - 1) {
    const th = body.readUInt16LE(pos);
    pos += 2;
    const code = th >> 6;
    let len = th & 0x3f;
    if (len === 0x3f) {
      len = body.readUInt32LE(pos);
      pos += 4;
    }
    if (code === 26) {
      const flags = body[pos];
      if (!(flags & 0x02)) throw new Error("PlaceObject2 has no character id");
      if (!(flags & 0x04)) throw new Error("PlaceObject2 has no matrix");
      const depth = body.readUInt16LE(pos + 1);
      const charId = body.readUInt16LE(pos + 3);
      // Only valid while the source sprites carry no colour transform of their
      // own; if one ever does, its terms would have to be composed with ours.
      if (flags & 0x08) throw new Error("Source PlaceObject2 already carries a colour transform");
      const matrix = Buffer.from(body.slice(pos + 5, pos + len));
      return { depth, charId, matrix };
    }
    pos += len;
    if (code === 0) break;
  }
  throw new Error("No PlaceObject2 found in sprite");
}

function buildSprite(spriteId, placement, charId, cxform) {
  const place = Buffer.concat([
    Buffer.from([0x02 | 0x04 | 0x08]), // HasCharacter | HasMatrix | HasColorTransform
    (() => {
      const b = Buffer.alloc(4);
      b.writeUInt16LE(placement.depth, 0);
      b.writeUInt16LE(charId, 2);
      return b;
    })(),
    placement.matrix,
    cxform,
  ]);
  const header = Buffer.alloc(4);
  header.writeUInt16LE(spriteId, 0);
  header.writeUInt16LE(1, 2); // frameCount
  return mkTag(39, Buffer.concat([header, mkTag(26, place), mkTag(1, Buffer.alloc(0)), mkTag(0, Buffer.alloc(0))]));
}

function main() {
  const backup = `${SWF}.bak-charon-hot`;
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(SWF, backup);
    console.log(`backup -> ${path.basename(backup)}`);
  }

  const swf = load(backup); // always patch from the pristine copy, so reruns are idempotent
  const tags = walkTags(swf.body);

  const sprites = new Map();
  const shapeIds = new Set();
  const SHAPE_CODES = new Set([2, 22, 32, 83]);
  for (const tag of tags) {
    if (tag.code === 39) sprites.set(swf.body.readUInt16LE(tag.dataStart), tag);
    else if (SHAPE_CODES.has(tag.code)) shapeIds.add(swf.body.readUInt16LE(tag.dataStart));
  }

  for (const shape of [RIGHT_BLADE_SHAPE, LEFT_BLADE_SHAPE]) {
    if (!shapeIds.has(shape)) throw new Error(`Blade shape ${shape} not present in ${path.basename(SWF)}`);
  }

  // Placement is taken from the stock blades, not from the placeholders.
  const placements = {};
  for (const [key, id] of [["sword", RIGHT_BLADE_SOURCE], ["offhand", LEFT_BLADE_SOURCE]]) {
    const tag = sprites.get(id);
    if (!tag) throw new Error(`Stock blade sprite ${id} not found`);
    placements[key] = readSpritePlacement(swf.body, tag);
  }

  // spriteId -> replacement tag
  const replacements = new Map();
  for (const step of RAMP) {
    const cxform = buildCxform(rampCxform(step.level));
    for (const [key, shape] of [["sword", RIGHT_BLADE_SHAPE], ["offhand", LEFT_BLADE_SHAPE]]) {
      const spriteId = step[key];
      const tag = sprites.get(spriteId);
      if (!tag) throw new Error(`Placeholder sprite ${spriteId} not found in ${path.basename(SWF)}`);
      readSpritePlacement(swf.body, tag); // asserts the placeholder is the shape we think it is
      replacements.set(spriteId, buildSprite(spriteId, placements[key], shape, cxform));
    }
    const c = rampCxform(step.level);
    console.log(
      `level ${step.level}: sprites ${step.sword}+${step.offhand}  ` +
      `mult ${c.redMult}/${c.greenMult}/${c.blueMult} +${c.redAdd}  (${step.names})`,
    );
  }

  const pieces = [];
  let cursor = 0;
  let patched = 0;
  for (const tag of tags) {
    const replacement = tag.code === 39 ? replacements.get(swf.body.readUInt16LE(tag.dataStart)) : undefined;
    if (!replacement) continue;
    pieces.push(swf.body.slice(cursor, tag.tagStart), replacement);
    cursor = tag.tagEnd;
    patched += 1;
  }

  if (patched !== replacements.size) {
    throw new Error(`Expected ${replacements.size} sprites to patch, found ${patched}`);
  }

  pieces.push(swf.body.slice(cursor));
  swf.body = Buffer.concat(pieces);
  save(SWF, swf);
  console.log(`wrote ${path.basename(SWF)} (${patched} sprites across ${RAMP.length} levels)`);
}

if (require.main === module) main();
module.exports = { load, save, walkTags, mkTag, buildCxform, rampCxform, readSpritePlacement, buildSprite, RAMP, LEVELS, SWF };
