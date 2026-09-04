/**
 * Draws a room out of a level SWF as an SVG, so a placement can be *looked at*
 * before it is written.
 *
 * Dressing a room is the one job where reading tags is not enough. A prop's numbers
 * say nothing about whether it hangs off a branch or floats beside one, whether it
 * covers the fence behind it, or whether the strip under the railing is empty - and
 * every round of "run the patch, load the game, screenshot, guess again" costs the
 * person at the keyboard. This walks the room's display list the way Flash would and
 * writes out an SVG, which any browser will render.
 *
 * What it understands: `DefineShape` 1/2/3/4 (solid fills, gradients flattened to
 * their middle stop, bitmap fills drawn flat grey), `DefineSprite`, `PlaceObject2/3`
 * matrices and colour transforms, and clip depths (as SVG `clipPath`, which is what
 * keeps the masked seasonal scene from spilling past its window). Only the first
 * frame of any timeline is drawn, so an animation shows the pose it starts in.
 *
 * Coordinates in the output are **room-local pixels** - the same numbers the patch
 * scripts place with - so a point read off the drawing can be pasted straight into a
 * layout table.
 *
 * Usage:
 *   npm exec ts-node scripts/dev-render-room.ts --room a_Room_SRN04 [--swf LevelsSRN.swf]
 *       [--out build/room.html] [--view -80,-720,2400,900] [--mark 680,-476 --mark ...]
 *       [--grid 50] [--detail 1.5] [--no-clip]
 */
import * as fs from "fs";
import * as path from "path";
import {
  characterBounds,
  SwfFile,
  SwfLevelError,
  SwfTag,
  characterTagsById,
  parsePlace,
  readSwfFile,
  readSymbolClasses,
  spriteInnerTags,
  TAG_DEFINE_SPRITE,
  TAG_PLACE_OBJECT2,
  TAG_PLACE_OBJECT3,
  TAG_SHOW_FRAME,
} from "./swfLevelUtils";

const CLIENT_CONTENT = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p");

const TAG_DEFINE_SHAPE2 = 22;
const TAG_DEFINE_SHAPE3 = 32;
const TAG_DEFINE_SHAPE4 = 83;
const SHAPE_TAGS = new Set([2, TAG_DEFINE_SHAPE2, TAG_DEFINE_SHAPE3, TAG_DEFINE_SHAPE4]);

/** A bit-level reader over a tag payload. SWF packs styles in bytes and edges in bits. */
class Reader {
  pos = 0;
  private bitBuf = 0;
  private bitPos = 0;

  constructor(public data: Buffer) {}

  align(): void {
    this.bitPos = 0;
  }
  u8(): number {
    this.align();
    return this.data[this.pos++];
  }
  u16(): number {
    this.align();
    const value = this.data.readUInt16LE(this.pos);
    this.pos += 2;
    return value;
  }
  ub(bits: number): number {
    let value = 0;
    for (let index = 0; index < bits; index += 1) {
      if (this.bitPos === 0) {
        this.bitBuf = this.data[this.pos++];
        this.bitPos = 8;
      }
      this.bitPos -= 1;
      value = value * 2 + ((this.bitBuf >> this.bitPos) & 1);
    }
    return value;
  }
  sb(bits: number): number {
    if (bits === 0) return 0;
    const value = this.ub(bits);
    return value >= 2 ** (bits - 1) ? value - 2 ** bits : value;
  }
  rect(): void {
    const bits = this.ub(5);
    this.ub(bits);
    this.ub(bits);
    this.ub(bits);
    this.ub(bits);
    this.align();
  }
  /** A MATRIX, which is *not* a RECT - getting these two confused silently desyncs everything after. */
  matrix(): void {
    if (this.ub(1)) {
      const bits = this.ub(5);
      this.ub(bits);
      this.ub(bits);
    }
    if (this.ub(1)) {
      const bits = this.ub(5);
      this.ub(bits);
      this.ub(bits);
    }
    const bits = this.ub(5);
    this.ub(bits);
    this.ub(bits);
    this.align();
  }
  rgb(alpha: boolean): string {
    const r = this.u8();
    const g = this.u8();
    const b = this.u8();
    const a = alpha ? this.u8() / 255 : 1;
    return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a.toFixed(3)})`;
  }
}

interface Segment {
  from: [number, number];
  to: [number, number];
  control: [number, number] | null;
}

interface ShapeDrawing {
  fills: Map<number, Segment[]>;
  strokes: Map<number, Segment[]>;
  fillColor: string[];
  lineColor: string[];
  lineWidth: number[];
}

/** Reads a fill style array, returning one CSS colour per style. */
function readFills(reader: Reader, alpha: boolean, extended: boolean): string[] {
  const colors: string[] = ["none"];
  let count = reader.u8();
  if (extended && count === 0xff) count = reader.u16();
  for (let index = 0; index < count; index += 1) {
    const type = reader.u8();
    if (type === 0x00) {
      colors.push(reader.rgb(alpha));
    } else if (type === 0x10 || type === 0x12 || type === 0x13) {
      // A gradient is flattened to its middle stop: this drawing is for judging
      // layout, and a two-tone sky reads the same as a graded one at this size.
      reader.matrix();
      const info = reader.u8();
      const stops = info & 0x0f;
      const picked: string[] = [];
      for (let stop = 0; stop < stops; stop += 1) {
        reader.u8();
        picked.push(reader.rgb(alpha));
      }
      if (type === 0x13) reader.u16(); // focal point
      colors.push(picked[Math.floor(picked.length / 2)] ?? "rgb(128,128,128)");
    } else if (type >= 0x40) {
      reader.u16();
      reader.matrix();
      colors.push("rgb(150,150,150)");
    } else {
      throw new SwfLevelError(`unsupported fill style ${type}`);
    }
  }
  return colors;
}

function readLines(reader: Reader, alpha: boolean, extended: boolean, shape4: boolean): { color: string[]; width: number[] } {
  const color: string[] = ["none"];
  const width: number[] = [0];
  let count = reader.u8();
  if (extended && count === 0xff) count = reader.u16();
  for (let index = 0; index < count; index += 1) {
    width.push(reader.u16() / 20);
    if (shape4) {
      const flags = reader.u16();
      const hasFill = (flags & 0x0008) !== 0;
      if ((flags & 0x0030) === 0x0020) reader.u16(); // miter limit
      if (hasFill) {
        color.push(readFills(reader, alpha, extended)[1] ?? "none");
      } else {
        color.push(reader.rgb(alpha));
      }
    } else {
      color.push(reader.rgb(alpha));
    }
  }
  return { color, width };
}

/**
 * Turns a shape tag into edges grouped by the style that paints them.
 *
 * An SWF edge does not belong to a path; it carries a fill on each *side*
 * (`fillStyle0` left, `fillStyle1` right) and the renderer is expected to sort the
 * soup out. So each edge is filed under both of its fills - reversed for the left
 * one - and `stitch` walks each group back into closed loops afterwards.
 */
export function readShape(tag: SwfTag): ShapeDrawing {
  const alpha = tag.code === TAG_DEFINE_SHAPE3 || tag.code === TAG_DEFINE_SHAPE4;
  const extended = tag.code !== 2;
  const shape4 = tag.code === TAG_DEFINE_SHAPE4;
  const reader = new Reader(tag.data);
  reader.u16();
  reader.rect();
  if (shape4) {
    reader.rect();
    reader.u8();
  }
  let fillColor = readFills(reader, alpha, extended);
  let lines = readLines(reader, alpha, extended, shape4);
  let fillBits = reader.ub(4);
  let lineBits = reader.ub(4);

  const fills = new Map<number, Segment[]>();
  const strokes = new Map<number, Segment[]>();
  const push = (map: Map<number, Segment[]>, style: number, segment: Segment): void => {
    if (style <= 0) return;
    const list = map.get(style) ?? [];
    list.push(segment);
    map.set(style, list);
  };

  let x = 0;
  let y = 0;
  let fill0 = 0;
  let fill1 = 0;
  let line = 0;
  for (;;) {
    if (reader.ub(1) === 0) {
      const flags = reader.ub(5);
      if (flags === 0) break;
      if (flags & 0x01) {
        const bits = reader.ub(5);
        // MoveTo is absolute, unlike every other coordinate in a shape record.
        x = reader.sb(bits);
        y = reader.sb(bits);
      }
      if (flags & 0x02) fill0 = reader.ub(fillBits);
      if (flags & 0x04) fill1 = reader.ub(fillBits);
      if (flags & 0x08) line = reader.ub(lineBits);
      if (flags & 0x10) {
        reader.align();
        const more = readFills(reader, alpha, extended);
        const moreLines = readLines(reader, alpha, extended, shape4);
        // New style arrays replace the old ones and restart the indices at 1.
        fillColor = more;
        lines = moreLines;
        fillBits = reader.ub(4);
        lineBits = reader.ub(4);
        fill0 = 0;
        fill1 = 0;
        line = 0;
      }
      continue;
    }
    const from: [number, number] = [x, y];
    let control: [number, number] | null = null;
    const straight = reader.ub(1);
    const bits = reader.ub(4) + 2;
    if (straight) {
      let dx = 0;
      let dy = 0;
      if (reader.ub(1)) {
        dx = reader.sb(bits);
        dy = reader.sb(bits);
      } else if (reader.ub(1)) {
        dy = reader.sb(bits);
      } else {
        dx = reader.sb(bits);
      }
      x += dx;
      y += dy;
    } else {
      control = [x + reader.sb(bits), y + reader.sb(bits)];
      x = control[0] + reader.sb(bits);
      y = control[1] + reader.sb(bits);
    }
    const to: [number, number] = [x, y];
    push(fills, fill1, { from, to, control });
    push(fills, fill0, { from: to, to: from, control });
    push(strokes, line, { from, to, control });
  }
  return { fills, strokes, fillColor, lineColor: lines.color, lineWidth: lines.width };
}

const key = (point: [number, number]): string => `${point[0]},${point[1]}`;

/**
 * Path coordinates, in whole pixels.
 *
 * The output is judged by eye at roughly a pixel per pixel, and a level's artwork
 * runs to thousands of edges: keeping two decimals triples the file for detail
 * nothing can see, and the preview will not open a file that large.
 */
const px = (twips: number): string => String(Math.round(twips / 20));

/**
 * How much of a shape's detail is thrown away, in pixels.
 *
 * An edge shorter than this is folded into the one before it, and a loop smaller
 * than twice this is dropped outright. Level artwork is drawn at a fidelity that
 * matters when a character fills the screen and is pure file size at the size a room
 * is looked at here - the town square's own tower shape alone is a third of a
 * megabyte written out faithfully, and the preview will not open the result.
 */
let detailTwips = 30;

/** Chains a style's edges back into closed loops and writes them as one path. */
function stitch(segments: Segment[]): string {
  const byStart = new Map<string, Segment[]>();
  for (const segment of segments) {
    const list = byStart.get(key(segment.from)) ?? [];
    list.push(segment);
    byStart.set(key(segment.from), list);
  }
  const used = new Set<Segment>();
  const parts: string[] = [];
  for (const segment of segments) {
    if (used.has(segment)) continue;
    used.add(segment);

    // Walk the loop first, then write it: the whole loop has to be in hand before
    // it can be measured against `detailTwips` and dropped.
    const loop: Segment[] = [segment];
    let current = segment;
    for (;;) {
      const next = (byStart.get(key(current.to)) ?? []).find((candidate) => !used.has(candidate));
      if (!next) break;
      used.add(next);
      loop.push(next);
      current = next;
    }
    const xs = loop.flatMap((edge) => [edge.from[0], edge.to[0]]);
    const ys = loop.flatMap((edge) => [edge.from[1], edge.to[1]]);
    if (Math.max(...xs) - Math.min(...xs) < detailTwips * 2 && Math.max(...ys) - Math.min(...ys) < detailTwips * 2) {
      continue;
    }
    let last = loop[0].from;
    let d = `M${px(last[0])} ${px(last[1])}`;
    for (const [index, edge] of loop.entries()) {
      const far =
        Math.abs(edge.to[0] - last[0]) >= detailTwips ||
        Math.abs(edge.to[1] - last[1]) >= detailTwips ||
        index === loop.length - 1;
      if (!far) continue;
      d += edge.control
        ? `Q${px(edge.control[0])} ${px(edge.control[1])} ${px(edge.to[0])} ${px(edge.to[1])}`
        : `L${px(edge.to[0])} ${px(edge.to[1])}`;
      last = edge.to;
    }
    parts.push(`${d}Z`);
  }
  return parts.join(" ");
}

function shapeToSvg(tag: SwfTag): string {
  const drawing = readShape(tag);
  const out: string[] = [];
  for (const [style, segments] of drawing.fills) {
    const color = drawing.fillColor[style] ?? "none";
    if (color === "none") continue;
    out.push(`<path fill="${color}" fill-rule="nonzero" d="${stitch(segments)}"/>`);
  }
  for (const [style, segments] of drawing.strokes) {
    const color = drawing.lineColor[style] ?? "none";
    if (color === "none") continue;
    const width = Math.max(drawing.lineWidth[style] ?? 1, 0.4);
    out.push(
      `<path fill="none" stroke="${color}" stroke-width="${width.toFixed(2)}" stroke-linecap="round" stroke-linejoin="round" d="${stitch(segments)}"/>`,
    );
  }
  return out.join("");
}

/** Whether a placement carries a clip depth, i.e. is a mask. Bit 6 of the first flags byte. */
function hasClipDepth(tag: SwfTag): boolean {
  return (tag.data[0] & 0x40) !== 0;
}

interface RenderOptions {
  clip: boolean;
}

/**
 * Renders one character - shape or sprite - into an SVG fragment.
 *
 * Every character is emitted once into `<defs>` and referenced with `<use>`
 * afterwards. A room places the same clump of grass a dozen times; inlining it a
 * dozen times turns a readable file into several megabytes the browser will not open.
 */
function defineCharacter(swf: SwfFile, id: number, options: RenderOptions, defs: Map<number, string>, depth = 0): void {
  if (defs.has(id)) return;
  defs.set(id, ""); // claimed up front, so a character that contains itself cannot loop
  const tag = characterTagsById(swf).get(id);
  if (!tag || depth > 12) return;
  if (SHAPE_TAGS.has(tag.code)) {
    try {
      defs.set(id, shapeToSvg(tag));
    } catch (error) {
      console.warn(`  character ${id}: ${(error as Error).message}`);
    }
    return;
  }
  if (tag.code !== TAG_DEFINE_SPRITE) return;

  const parts: string[] = [];
  let clipped = false;
  for (const inner of spriteInnerTags(tag)) {
    // Only the first frame: a level animation is drawn in the pose it starts in.
    if (inner.code === TAG_SHOW_FRAME) break;
    if (inner.code !== TAG_PLACE_OBJECT2 && inner.code !== TAG_PLACE_OBJECT3) continue;
    const place = parsePlace(inner);
    if (place.charId === null) continue;
    defineCharacter(swf, place.charId, options, defs, depth + 1);
    const matrix = place.matrix ?? { scaleX: 1, scaleY: 1, rotateSkew0: 0, rotateSkew1: 0, translateX: 0, translateY: 0 };
    const transform =
      `matrix(${matrix.scaleX.toFixed(4)},${matrix.rotateSkew0.toFixed(4)},${matrix.rotateSkew1.toFixed(4)},` +
      `${matrix.scaleY.toFixed(4)},${(matrix.translateX / 20).toFixed(2)},${(matrix.translateY / 20).toFixed(2)})`;
    if (hasClipDepth(inner)) {
      if (!options.clip) continue;
      // The clip depth itself is not read back: a mask always runs past the layers
      // it covers, so clipping the rest of the sprite gives the same picture.
      const clipId = `clip${id}_${place.depth}`;
      // A clipPath may only hold shapes, so the mask's paths are inlined with the
      // placement's matrix pushed onto each one. A `<use>` here renders as an empty
      // clip in some browsers, which silently hides everything it was meant to trim.
      const maskBody = (defs.get(place.charId) ?? "").split("<path ").join(`<path transform="${transform}" `);
      parts.push(
        `<clipPath id="${clipId}" clipPathUnits="userSpaceOnUse">${maskBody}</clipPath>`,
        `<g clip-path="url(#${clipId})">`,
      );
      clipped = true;
      continue;
    }
    parts.push(`<use href="#c${place.charId}" transform="${transform}"/>`);
  }
  if (clipped) parts.push("</g>");
  defs.set(id, parts.join(""));
}

interface Options {
  room: string;
  swf: string;
  out: string;
  view: [number, number, number, number] | null;
  marks: Array<{ x: number; y: number; label: string }>;
  grid: number;
  clip: boolean;
  /** Output width in pixels; the view is scaled to fit it. Handy for a pane that is narrower. */
  width: number | null;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    room: "a_Room_SRN04",
    swf: "LevelsSRN.swf",
    out: path.join("build", "room.html"),
    view: null,
    marks: [],
    grid: 100,
    clip: true,
    width: null,
  };
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = (): string => argv[++index];
    if (arg === "--room") options.room = next();
    else if (arg === "--swf") options.swf = next();
    else if (arg === "--out") options.out = next();
    else if (arg === "--grid") options.grid = Number(next());
    else if (arg === "--width") options.width = Number(next());
    else if (arg === "--detail") detailTwips = Number(next()) * 20;
    else if (arg === "--no-clip") options.clip = false;
    else if (arg === "--view") {
      const parts = next().split(",").map(Number);
      if (parts.length !== 4 || parts.some(Number.isNaN)) throw new SwfLevelError("--view wants x,y,width,height");
      options.view = [parts[0], parts[1], parts[2], parts[3]];
    } else if (arg === "--mark") {
      const [x, y, ...label] = next().split(",");
      options.marks.push({ x: Number(x), y: Number(y), label: label.join(",") });
    }
  }
  return options;
}

function main(): void {
  const options = parseArgs(process.argv);
  const swfPath = path.isAbsolute(options.swf)
    ? options.swf
    : fs.existsSync(options.swf)
      ? options.swf
      : path.join(CLIENT_CONTENT, "cbp", options.swf);
  const swf = readSwfFile(swfPath);
  // `--room` names a class; a bare character id is how an orphan - artwork bound to
  // nothing and placed nowhere, which is how seasonal SWFs ship whole scenes - is
  // reached, since it has no name to look up.
  const asId = /^[0-9]+$/.test(options.room) ? Number(options.room) : null;
  const symbol = asId
    ? { id: asId, name: `character ${asId}` }
    : readSymbolClasses(swf).find((entry) => entry.name === options.room);
  if (!symbol) throw new SwfLevelError(`${path.basename(swfPath)} has no ${options.room}`);

  console.log(`${options.room} is character ${symbol.id}`);
  const view = options.view ?? [-100, -800, 2500, 1000];

  /**
   * Only the room children that reach the view are drawn.
   *
   * A room is two thousand pixels of market road and the square is a corner of it;
   * emitting the rest produces a file the browser refuses to open. Culling is done on
   * the room's own children, which is where the big, far-apart pieces are.
   */
  const defs = new Map<number, string>();
  const uses: string[] = [];
  let culled = 0;
  const rootTag = characterTagsById(swf).get(symbol.id);
  if (!rootTag) throw new SwfLevelError(`no character ${symbol.id}`);
  if (rootTag.code !== TAG_DEFINE_SPRITE) {
    // A shape has no children to cull; draw it on its own.
    defineCharacter(swf, symbol.id, { clip: options.clip }, defs);
    uses.push(`<use href="#c${symbol.id}"/>`);
  }
  for (const inner of rootTag.code === TAG_DEFINE_SPRITE ? spriteInnerTags(rootTag) : []) {
    if (inner.code === TAG_SHOW_FRAME) break;
    if (inner.code !== TAG_PLACE_OBJECT2 && inner.code !== TAG_PLACE_OBJECT3) continue;
    const place = parsePlace(inner);
    if (place.charId === null) continue;
    const matrix = place.matrix ?? { scaleX: 1, scaleY: 1, rotateSkew0: 0, rotateSkew1: 0, translateX: 0, translateY: 0 };
    const bounds = characterBounds(swf, place.charId);
    if (bounds) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [bx, by] of [
        [bounds.xMin, bounds.yMin],
        [bounds.xMax, bounds.yMin],
        [bounds.xMin, bounds.yMax],
        [bounds.xMax, bounds.yMax],
      ]) {
        xs.push((matrix.scaleX * bx + matrix.rotateSkew1 * by + matrix.translateX) / 20);
        ys.push((matrix.rotateSkew0 * bx + matrix.scaleY * by + matrix.translateY) / 20);
      }
      const outside =
        Math.max(...xs) < view[0] ||
        Math.min(...xs) > view[0] + view[2] ||
        Math.max(...ys) < view[1] ||
        Math.min(...ys) > view[1] + view[3];
      if (outside) {
        culled += 1;
        continue;
      }
    }
    defineCharacter(swf, place.charId, { clip: options.clip }, defs);
    const transform =
      `matrix(${matrix.scaleX.toFixed(4)},${matrix.rotateSkew0.toFixed(4)},${matrix.rotateSkew1.toFixed(4)},` +
      `${matrix.scaleY.toFixed(4)},${(matrix.translateX / 20).toFixed(2)},${(matrix.translateY / 20).toFixed(2)})`;
    uses.push(`<use href="#c${place.charId}" transform="${transform}"/>`);
  }
  const defsSvg = [...defs].map(([id, svg]) => `<g id="c${id}">${svg}</g>`).join("");
  const body = `<defs>${defsSvg}</defs>${uses.join("")}`;
  console.log(`${defs.size} characters drawn, ${culled} room children culled outside the view`);

  const width = options.width ?? Math.min(1400, view[2]);
  const height = (width * view[3]) / view[2];

  const grid: string[] = [];
  if (options.grid > 0) {
    for (let x = Math.ceil(view[0] / options.grid) * options.grid; x < view[0] + view[2]; x += options.grid) {
      const major = x % (options.grid * 5) === 0;
      grid.push(
        `<line x1="${x}" y1="${view[1]}" x2="${x}" y2="${view[1] + view[3]}" stroke="#0af" stroke-opacity="${major ? 0.55 : 0.2}" stroke-width="${major ? 2 : 1}"/>`,
      );
      if (major) grid.push(`<text x="${x + 3}" y="${view[1] + 18}" font-size="16" fill="#08c">${x}</text>`);
    }
    for (let y = Math.ceil(view[1] / options.grid) * options.grid; y < view[1] + view[3]; y += options.grid) {
      const major = y % (options.grid * 5) === 0;
      grid.push(
        `<line x1="${view[0]}" y1="${y}" x2="${view[0] + view[2]}" y2="${y}" stroke="#0af" stroke-opacity="${major ? 0.55 : 0.2}" stroke-width="${major ? 2 : 1}"/>`,
      );
      if (major) grid.push(`<text x="${view[0] + 3}" y="${y - 5}" font-size="16" fill="#08c">${y}</text>`);
    }
  }
  const marks = options.marks
    .map(
      (mark) =>
        `<circle cx="${mark.x}" cy="${mark.y}" r="6" fill="none" stroke="#f0f" stroke-width="3"/>` +
        (mark.label ? `<text x="${mark.x + 9}" y="${mark.y - 6}" font-size="16" fill="#c0c">${mark.label}</text>` : ""),
    )
    .join("");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${view.join(" ")}" width="${width.toFixed(0)}" height="${height.toFixed(0)}">` +
    `<rect x="${view[0]}" y="${view[1]}" width="${view[2]}" height="${view[3]}" fill="#20242c"/>${body}${grid.join("")}${marks}</svg>`;
  fs.mkdirSync(path.dirname(options.out), { recursive: true });
  fs.writeFileSync(
    options.out,
    `<!doctype html><title>${options.room}</title><body style="margin:0;background:#181b21;color:#ccc;font:13px system-ui">` +
      `<div style="padding:6px 10px">${options.room} - room-local pixels, view ${view.join(" ")}</div>${svg}</body>`,
  );
  console.log(`wrote ${options.out}`);
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
