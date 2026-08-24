/**
 * Charon's Blades blood drip: builds the looping drip animation into SFX_1.swf.
 *
 * The companion data patch (patch_gameswz_charon_blood_drip) hangs this off the
 * SeekingBlades buff's GfxType at BuffLoc Feet, so the engine spawns and loops it
 * for exactly as long as the form is up -- no client code, no timer, no state.
 *
 * Why it is anchored at the feet rather than at the blade: the character is
 * flattened into one cached bitmap per animation frame, and the engine's GFX
 * anchors are TargetCenter / Feet / TargetFeet / Ground / TargetHit / TargetPos /
 * Center / TargetHead / Socket. There is no weapon or hand anchor, and the blade
 * tip only exists inside the baked bitmap, so nothing can be pinned to it. Feet
 * is the anchor that makes the part the request actually cares about exact --
 * the drop reaching the floor -- because the sprite's own origin sits on the
 * ground. The fall therefore starts at a fixed height standing in for the blade
 * rather than at the blade itself.
 *
 * The host class is a dead one: `a_Conflagration_old` is exported by SFX_1.swf
 * but its name appears nowhere in Game.swz, Login.swz or the loose XML, so
 * rebuilding its timeline costs nothing and needs no new AS3 class (art is
 * resolved by class name, so a brand new symbol would need one).
 */

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const SWF = path.resolve(
  __dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "SFX_1.swf",
);

/** Dead class whose timeline becomes the drip. Referenced by the swz patch. */
const HOST_CLASS = "a_Conflagration_old";

const TWIP = 20;

// Geometry, in pixels, with the origin on the ground between the character's
// feet (BuffLoc Feet).
//
// One entry per blade tip, for a character facing right. These were read off the
// `--calibrate` ruler rather than estimated: the ruler draws a mark every 20
// units along the ground, so a screenshot gives the tip's coordinate directly,
// with no stage-scale conversion to get wrong. Guessing from screen pixels had
// put the short blade's stream on the character's thigh, where it read as a
// wound rather than a drip.
//
// The blades point opposite ways, so these offsets are asymmetric and large --
// which is why they are one-sided and not mirrored. Facing is handled instead by
// patch-dungeonblitz-charon-drip-facing, which flips the whole sprite in
// Buff.UpdatePos when the character turns; a mirrored copy at this reach would
// hang in open air rather than hiding behind the body.
// The x values came straight off the ruler and land correctly. The heights did
// not: the vertical arm of the ruler is hidden behind the character, since
// BuffLoc Feet draws the whole animation behind it, so these were derived from
// the horizontal scale instead and read a little low. Raised by 17 with the gap
// between the two blades kept intact.
const BLADES = [
  { name: "main", x: 125, y: -64 }, // the long blade, held out front
  { name: "offhand", x: -87, y: -57 }, // the short blade, back the other side
];
const FALL_TO = -2; // the drop's own tip sits just above the origin on landing
const DROP_COLOR = { r: 0x9b, g: 0x00, b: 0x11, a: 0xff };
const SPLAT_COLOR = { r: 0x7a, g: 0x00, b: 0x0d, a: 0xff };

// Frame budget. The SWF runs at its own rate; these counts were picked to read as
// "a bead gathers, falls, and bursts" with a beat of stillness before the loop.
const GATHER_FRAMES = 5;
const FALL_FRAMES = 13;
const SPLAT_FRAMES = 4;
const REST_FRAMES = 8;

const CYCLE = GATHER_FRAMES + FALL_FRAMES + SPLAT_FRAMES + REST_FRAMES;

/** Drops in flight per blade, running one behind the other off the same tip. */
const DROPS_PER_BLADE = 3;

/**
 * Every stream is an independent copy of the same cycle, started at a different
 * point in it. Within a blade they are spaced a third of a cycle apart, so a new
 * bead forms roughly as the one before it lands; the two blades are offset by
 * half that again so the six never fall in step.
 */
const STREAMS = BLADES.flatMap((blade, bladeIndex) =>
  Array.from({ length: DROPS_PER_BLADE }, (_unused, n) => {
    const ordinal = bladeIndex * DROPS_PER_BLADE + n;
    return {
      label: `${blade.name}#${n + 1}`,
      x: blade.x,
      from: blade.y,
      phase: Math.round(
        (n * CYCLE) / DROPS_PER_BLADE + (bladeIndex * CYCLE) / (DROPS_PER_BLADE * BLADES.length),
      ) % CYCLE,
      dropDepth: 1 + ordinal * 2,
      splatDepth: 2 + ordinal * 2,
    };
  }),
);

class BitWriter {
  constructor() {
    this.bits = [];
  }
  ub(value, n) {
    for (let i = n - 1; i >= 0; i -= 1) this.bits.push((value >>> i) & 1);
    return this;
  }
  sb(value, n) {
    return this.ub(value < 0 ? value + (1 << n) : value, n);
  }
  align() {
    while (this.bits.length % 8 !== 0) this.bits.push(0);
    return this;
  }
  toBuffer() {
    this.align();
    const out = Buffer.alloc(this.bits.length / 8);
    this.bits.forEach((bit, i) => {
      if (bit) out[i >> 3] |= 0x80 >> (i & 7);
    });
    return out;
  }
}

/** Bits needed to hold every value as a signed quantity. */
function signedBits(values) {
  let n = 2;
  for (const v of values) {
    while (v > (1 << (n - 1)) - 1 || v < -(1 << (n - 1))) n += 1;
  }
  return n;
}

function writeRect(w, xMin, xMax, yMin, yMax) {
  const bits = signedBits([xMin, xMax, yMin, yMax]);
  w.ub(bits, 5).sb(xMin, bits).sb(xMax, bits).sb(yMin, bits).sb(yMax, bits);
  return w;
}

/** A translate-only MATRIX. */
function matrixBytes(txPx, tyPx) {
  const w = new BitWriter();
  w.ub(0, 1); // HasScale
  w.ub(0, 1); // HasRotate
  const tx = Math.round(txPx * TWIP);
  const ty = Math.round(tyPx * TWIP);
  const bits = signedBits([tx, ty]);
  w.ub(bits, 5).sb(tx, bits).sb(ty, bits);
  return w.toBuffer();
}

/** A CXFORMWITHALPHA that only scales alpha. */
function alphaCxform(alpha255) {
  const w = new BitWriter();
  const terms = [256, 256, 256, alpha255];
  const bits = signedBits(terms);
  w.ub(0, 1).ub(1, 1).ub(bits, 4);
  for (const t of terms) w.sb(t, bits);
  return w.toBuffer();
}

/**
 * DefineShape3 holding one solid-filled closed polygon.
 *
 * Points are pixels relative to the shape's own origin. Only straight edges are
 * used: at this size a polygon reads exactly like a curve and it keeps the
 * encoder to the two record types that are hard to get wrong.
 */
function buildShape(shapeId, points, color) {
  const pts = points.map(([x, y]) => [Math.round(x * TWIP), Math.round(y * TWIP)]);
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);

  const w = new BitWriter();
  writeRect(w, Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys));
  w.align();

  const head = w.toBuffer();
  const fills = Buffer.concat([
    Buffer.from([1]), // FillStyleCount
    Buffer.from([0x00]), // solid
    Buffer.from([color.r, color.g, color.b, color.a]), // RGBA (DefineShape3)
    Buffer.from([0]), // LineStyleCount
  ]);

  const numFillBits = 1;
  const numLineBits = 0;
  const s = new BitWriter();
  s.ub(numFillBits, 4).ub(numLineBits, 4);

  // StyleChangeRecord: move to the first point and select fill style 1.
  const moveBits = signedBits([pts[0][0], pts[0][1]]);
  s.ub(0, 1); // TypeFlag: non-edge
  s.ub(0, 1); // StateNewStyles
  s.ub(0, 1); // StateLineStyle
  s.ub(1, 1); // StateFillStyle1
  s.ub(0, 1); // StateFillStyle0
  s.ub(1, 1); // StateMoveTo
  s.ub(moveBits, 5).sb(pts[0][0], moveBits).sb(pts[0][1], moveBits);
  s.ub(1, numFillBits); // FillStyle1 = 1

  // StraightEdgeRecords back around the polygon, closing on the first point.
  for (let i = 1; i <= pts.length; i += 1) {
    const from = pts[i - 1];
    const to = pts[i % pts.length];
    const dx = to[0] - from[0];
    const dy = to[1] - from[1];
    if (dx === 0 && dy === 0) continue;
    const n = Math.max(2, signedBits([dx, dy]));
    s.ub(1, 1); // TypeFlag: edge
    s.ub(1, 1); // StraightFlag
    s.ub(n - 2, 4); // NumBits
    s.ub(1, 1); // GeneralLineFlag
    s.sb(dx, n).sb(dy, n);
  }

  s.ub(0, 6); // EndShapeRecord
  const idBuf = Buffer.alloc(2);
  idBuf.writeUInt16LE(shapeId, 0);
  return mkTag(32, Buffer.concat([idBuf, head, fills, s.toBuffer()]));
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

function placeObject2(depth, charId, txPx, tyPx, alpha255) {
  const hasCx = alpha255 !== undefined && alpha255 !== 255;
  let flags = 0x04; // HasMatrix
  if (charId !== undefined) flags |= 0x02; // HasCharacter
  else flags |= 0x01; // Move
  if (hasCx) flags |= 0x08; // HasColorTransform

  const parts = [Buffer.from([flags])];
  const d = Buffer.alloc(2);
  d.writeUInt16LE(depth, 0);
  parts.push(d);
  if (charId !== undefined) {
    const c = Buffer.alloc(2);
    c.writeUInt16LE(charId, 0);
    parts.push(c);
  }
  parts.push(matrixBytes(txPx, tyPx));
  if (hasCx) parts.push(alphaCxform(alpha255));
  return mkTag(26, Buffer.concat(parts));
}

function removeObject2(depth) {
  const d = Buffer.alloc(2);
  d.writeUInt16LE(depth, 0);
  return mkTag(28, d);
}

const showFrame = () => mkTag(1, Buffer.alloc(0));
const endTag = () => mkTag(0, Buffer.alloc(0));

/**
 * What one stream is doing `t` frames into its own cycle: a bead gathers at the
 * blade tip, falls with gravity, bursts on the ground, then a beat of nothing so
 * the loop reads as separate drips rather than a stream.
 */
function streamStateAt(t, stream, dropShape, splatShape) {
  if (t < GATHER_FRAMES) {
    const p = (t + 1) / GATHER_FRAMES;
    return [
      removeObject2(stream.dropDepth),
      removeObject2(stream.splatDepth),
      // The bead swells in on alpha; riding a shrinking offset sells the gather
      // at this size and keeps every matrix translate-only.
      placeObject2(stream.dropDepth, dropShape, stream.x, stream.from - (1 - p) * 3, Math.round(p * 255)),
    ];
  }

  if (t < GATHER_FRAMES + FALL_FRAMES) {
    const p = (t - GATHER_FRAMES + 1) / FALL_FRAMES;
    return [
      removeObject2(stream.dropDepth),
      placeObject2(stream.dropDepth, dropShape, stream.x, stream.from + (FALL_TO - stream.from) * p * p),
    ];
  }

  if (t < GATHER_FRAMES + FALL_FRAMES + SPLAT_FRAMES) {
    const p = (t - GATHER_FRAMES - FALL_FRAMES + 1) / SPLAT_FRAMES;
    return [
      removeObject2(stream.dropDepth),
      removeObject2(stream.splatDepth),
      placeObject2(stream.splatDepth, splatShape, stream.x, 0, Math.round((1 - p) * 220)),
    ];
  }

  if (t === GATHER_FRAMES + FALL_FRAMES + SPLAT_FRAMES) {
    return [removeObject2(stream.dropDepth), removeObject2(stream.splatDepth)];
  }
  return [];
}

/**
 * `--calibrate`: a static ruler instead of the drips.
 *
 * Reading the blade tips off a screenshot needs the stage scale, and estimating
 * it from the drop's own size and from where a stream landed disagreed by nearly
 * 2x. So rather than convert screen pixels to game units, this puts the units
 * themselves on screen: a mark every CAL_STEP along the ground and up the centre
 * line, with a splat marking the origin. Whichever mark a blade tip sits over is
 * its coordinate, read straight off, no scale involved.
 */
const CAL_STEP = 20;
const CAL_REACH = 180;

function buildCalibrationSprite(spriteId, dropShape, splatShape) {
  const parts = [];
  let depth = 1;

  // origin
  parts.push(placeObject2(depth++, splatShape, 0, 0));

  // along the ground, both ways
  for (let x = CAL_STEP; x <= CAL_REACH; x += CAL_STEP) {
    // every other mark is dimmed, so counting in pairs is easy at a glance
    const alpha = (x / CAL_STEP) % 2 === 0 ? 255 : 120;
    parts.push(placeObject2(depth++, dropShape, x, -10, alpha));
    parts.push(placeObject2(depth++, dropShape, -x, -10, alpha));
  }

  // up the centre line
  for (let y = CAL_STEP; y <= CAL_REACH; y += CAL_STEP) {
    const alpha = (y / CAL_STEP) % 2 === 0 ? 255 : 120;
    parts.push(placeObject2(depth++, dropShape, 0, -y, alpha));
  }

  parts.push(showFrame());
  const header = Buffer.alloc(4);
  header.writeUInt16LE(spriteId, 0);
  header.writeUInt16LE(1, 2);
  return {
    tag: mkTag(39, Buffer.concat([header, ...parts, endTag()])),
    frameCount: 1,
  };
}

/** The drip timeline, as a replacement DefineSprite body. */
function buildDripSprite(spriteId, dropShape, splatShape) {
  const frames = [];
  for (let frame = 0; frame < CYCLE; frame += 1) {
    const parts = [];
    for (const stream of STREAMS) {
      parts.push(...streamStateAt((frame + stream.phase) % CYCLE, stream, dropShape, splatShape));
    }
    parts.push(showFrame());
    frames.push(Buffer.concat(parts));
  }

  const header = Buffer.alloc(4);
  header.writeUInt16LE(spriteId, 0);
  header.writeUInt16LE(CYCLE, 2);
  return {
    tag: mkTag(39, Buffer.concat([header, ...frames, endTag()])),
    frameCount: CYCLE,
  };
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

function symbolClasses(body, tags) {
  const out = new Map();
  for (const tag of tags) {
    if (tag.code !== 76 && tag.code !== 56) continue;
    let o = tag.dataStart;
    const n = body.readUInt16LE(o);
    o += 2;
    for (let i = 0; i < n; i += 1) {
      const id = body.readUInt16LE(o);
      o += 2;
      let s = "";
      while (body[o] !== 0) {
        s += String.fromCharCode(body[o]);
        o += 1;
      }
      o += 1;
      out.set(s, id);
    }
  }
  return out;
}

const CHAR_TAGS = new Set([2, 22, 32, 83, 39, 46, 84, 20, 36, 6, 21, 35, 7, 34, 10, 48, 75, 37, 60]);

function main() {
  const backup = `${SWF}.bak-charon-drip`;
  if (!fs.existsSync(backup)) {
    fs.copyFileSync(SWF, backup);
    console.log(`backup -> ${path.basename(backup)}`);
  }

  const swf = load(backup); // patch from the pristine copy, so reruns are idempotent
  const tags = walkTags(swf.body);
  const classes = symbolClasses(swf.body, tags);

  const spriteId = classes.get(HOST_CLASS);
  if (spriteId === undefined) throw new Error(`${HOST_CLASS} is not exported by ${path.basename(SWF)}`);

  let maxId = 0;
  for (const tag of tags) {
    if (CHAR_TAGS.has(tag.code)) maxId = Math.max(maxId, swf.body.readUInt16LE(tag.dataStart));
  }
  const dropShape = maxId + 1;
  const splatShape = maxId + 2;

  // A teardrop: pointed at the top, full at the bottom.
  const drop = buildShape(dropShape, [
    [0, 0], [1.6, 3.4], [2.6, 6.2], [2.0, 8.4], [0, 9.4],
    [-2.0, 8.4], [-2.6, 6.2], [-1.6, 3.4],
  ], DROP_COLOR);

  // The burst: a flattened splash sitting on the ground line.
  const splat = buildShape(splatShape, [
    [-6.5, 0], [-3.2, -2.2], [0, -2.8], [3.2, -2.2], [6.5, 0],
    [3.4, 1.5], [0, 2.0], [-3.4, 1.5],
  ], SPLAT_COLOR);

  const CALIBRATE = process.argv.includes("--calibrate");
  const { tag: sprite, frameCount } = CALIBRATE
    ? buildCalibrationSprite(spriteId, dropShape, splatShape)
    : buildDripSprite(spriteId, dropShape, splatShape);

  const spriteTag = tags.find((t) => t.code === 39 && swf.body.readUInt16LE(t.dataStart) === spriteId);
  if (!spriteTag) throw new Error(`DefineSprite ${spriteId} (${HOST_CLASS}) not found`);

  // Shapes have to be defined before the sprite that places them.
  swf.body = Buffer.concat([
    swf.body.slice(0, spriteTag.tagStart),
    drop,
    splat,
    sprite,
    swf.body.slice(spriteTag.tagEnd),
  ]);

  save(SWF, swf);
  const summary = CALIBRATE
    ? `CALIBRATION ruler, marks every ${CAL_STEP} units out to ${CAL_REACH}`
    : `${frameCount} frames, shapes ${dropShape}/${splatShape}, ` +
      STREAMS.map((s) => `${s.label}@${s.x},${s.from}`).join(" ");
  console.log(`${path.basename(SWF)}: ${HOST_CLASS} (sprite ${spriteId}) -- ${summary}`);
}

if (require.main === module) main();
module.exports = { HOST_CLASS, SWF };
