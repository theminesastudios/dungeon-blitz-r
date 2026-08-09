import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

class PatchError extends Error {}

type SwfTag = { code: number; data: Buffer };

const DEFAULT_SWF = path.resolve(
  __dirname,
  "../../client/content/localhost/p/cbp/LevelsHome.swf",
);
const TEMPLAR_FINAL = "a_Animation_Templar_Final";
const CASTLE_FIRE_WHITE = "a_Animation_CastleFireWhite";
const FLAME_DEPTHS = [7, 13, 19, 25] as const;
const JUSTICAR_FINAL = "a_Animation_Justicar10";
const JUSTICAR_FLAMES = [
  { spriteId: 908, sourceDepth: 3, parentDepths: [2, 6] as const },
  { spriteId: 917, sourceDepth: 2, parentDepths: [10, 13] as const },
] as const;

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
    } else if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: npm exec ts-node scripts/patch-levelshome-templar-castle-fire-timeline.ts [--verify] [--swf <path>]");
      process.exit(0);
    } else {
      throw new PatchError(`Unknown argument: ${arg}`);
    }
  }
  return { swfPath, verify };
}

function splitTags(buffer: Buffer, start: number): SwfTag[] {
  const tags: SwfTag[] = [];
  let offset = start;
  while (offset + 2 <= buffer.length) {
    const header = buffer.readUInt16LE(offset);
    offset += 2;
    const code = header >> 6;
    let length = header & 0x3f;
    if (length === 0x3f) {
      if (offset + 4 > buffer.length) throw new PatchError(`Truncated long SWF tag ${code}.`);
      length = buffer.readUInt32LE(offset);
      offset += 4;
    }
    if (offset + length > buffer.length) throw new PatchError(`SWF tag ${code} exceeds its container.`);
    tags.push({ code, data: Buffer.from(buffer.subarray(offset, offset + length)) });
    offset += length;
    if (code === 0) break;
  }
  return tags;
}

function encodeTag(tag: SwfTag): Buffer {
  if (tag.data.length < 0x3f) {
    const header = Buffer.alloc(2);
    header.writeUInt16LE((tag.code << 6) | tag.data.length, 0);
    return Buffer.concat([header, tag.data]);
  }
  const header = Buffer.alloc(6);
  header.writeUInt16LE((tag.code << 6) | 0x3f, 0);
  header.writeUInt32LE(tag.data.length, 2);
  return Buffer.concat([header, tag.data]);
}

function tagStreamStart(body: Buffer): number {
  const nbits = body[0] >> 3;
  return Math.ceil((5 + nbits * 4) / 8) + 4;
}

function decodeSwf(swfPath: string): { raw: Buffer; body: Buffer; signature: string; version: number } {
  const raw = fs.readFileSync(swfPath);
  const signature = raw.subarray(0, 3).toString("ascii");
  if (signature !== "CWS" && signature !== "FWS") throw new PatchError(`Unsupported SWF signature ${signature}.`);
  const body = signature === "CWS" ? zlib.inflateSync(raw.subarray(8)) : Buffer.from(raw.subarray(8));
  if (raw.readUInt32LE(4) !== body.length + 8) throw new PatchError("LevelsHome.swf has an invalid FileLength.");
  return { raw, body, signature, version: raw[3] };
}

function encodeSwf(signature: string, version: number, body: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.write(signature, 0, 3, "ascii");
  header[3] = version;
  header.writeUInt32LE(body.length + 8, 4);
  return signature === "CWS"
    ? Buffer.concat([header, zlib.deflateSync(body, { level: 9 })])
    : Buffer.concat([header, body]);
}

function symbolMap(tags: SwfTag[]): Map<string, number> {
  const symbols = new Map<string, number>();
  for (const tag of tags.filter((candidate) => candidate.code === 76)) {
    let offset = 0;
    const count = tag.data.readUInt16LE(offset);
    offset += 2;
    for (let index = 0; index < count; index += 1) {
      const characterId = tag.data.readUInt16LE(offset);
      offset += 2;
      const start = offset;
      while (offset < tag.data.length && tag.data[offset] !== 0) offset += 1;
      if (offset >= tag.data.length) throw new PatchError("Unterminated SymbolClass name.");
      symbols.set(tag.data.subarray(start, offset).toString("utf8"), characterId);
      offset += 1;
    }
  }
  return symbols;
}

function spriteTag(tags: SwfTag[], characterId: number): SwfTag {
  const matches = tags.filter((tag) => tag.code === 39 && tag.data.readUInt16LE(0) === characterId);
  if (matches.length !== 1) throw new PatchError(`Expected one DefineSprite ${characterId}, found ${matches.length}.`);
  return matches[0];
}

function placeObject2(tag: SwfTag): { depth: number; characterId: number | null; characterOffset: number | null } | null {
  if (tag.code !== 26 || tag.data.length < 3) return null;
  const flags = tag.data[0];
  const depth = tag.data.readUInt16LE(1);
  if ((flags & 0x02) === 0) return { depth, characterId: null, characterOffset: null };
  if (tag.data.length < 5) throw new PatchError("Truncated PlaceObject2 character ID.");
  return { depth, characterId: tag.data.readUInt16LE(3), characterOffset: 3 };
}

function timelineCharacters(sprite: SwfTag, depths: readonly number[]): Map<number, number>[] {
  const frameCount = sprite.data.readUInt16LE(2);
  const states: Map<number, number>[] = [];
  const active = new Map<number, number>();
  for (const tag of splitTags(sprite.data, 4)) {
    const place = placeObject2(tag);
    if (place?.characterId !== null && place?.characterId !== undefined && depths.includes(place.depth)) {
      active.set(place.depth, place.characterId);
    } else if (tag.code === 28 && tag.data.length >= 2) {
      active.delete(tag.data.readUInt16LE(0));
    }
    if (tag.code === 1) states.push(new Map(active));
  }
  if (states.length !== frameCount) throw new PatchError(`DefineSprite frame count mismatch: ${states.length} != ${frameCount}.`);
  return states;
}

function castleFireFrames(sprite: SwfTag): number[] {
  const states = timelineCharacters(sprite, [4]);
  const frames = states.map((state, index) => {
    const characterId = state.get(4);
    if (characterId === undefined) throw new PatchError(`CastleFireWhite frame ${index + 1} has no character at depth 4.`);
    return characterId;
  });
  if (new Set(frames).size !== 8) throw new PatchError("CastleFireWhite must contain eight distinct static flame shapes.");
  return frames;
}

function replacementPlace(depth: number, characterId: number): SwfTag {
  const data = Buffer.alloc(5);
  data[0] = 0x03; // Move + HasCharacter; preserve the existing matrix at this depth.
  data.writeUInt16LE(depth, 1);
  data.writeUInt16LE(characterId, 3);
  return { code: 26, data };
}

function expectedTemplarFrames(flameFrames: number[], count: number): number[] {
  return Array.from({ length: count }, (_, index) => flameFrames[index % flameFrames.length]);
}

function isPatched(templar: SwfTag, expected: number[], castleFireId: number): boolean {
  const states = timelineCharacters(templar, FLAME_DEPTHS);
  return states.length === expected.length && states.every((state, frame) =>
    FLAME_DEPTHS.every((depth) => state.get(depth) === expected[frame] && state.get(depth) !== castleFireId)
  );
}

function patchTemplarTimeline(templar: SwfTag, expected: number[], castleFireId: number): SwfTag {
  const frameCount = templar.data.readUInt16LE(2);
  if (frameCount !== expected.length) throw new PatchError("Unexpected Templar final frame count.");
  const output: SwfTag[] = [];
  let frame = 0;
  let replacements = 0;
  for (const original of splitTags(templar.data, 4)) {
    const tag = { code: original.code, data: Buffer.from(original.data) };
    const place = placeObject2(tag);
    if (
      frame === 0
      && place?.characterId === castleFireId
      && FLAME_DEPTHS.includes(place.depth as typeof FLAME_DEPTHS[number])
      && place.characterOffset !== null
    ) {
      tag.data.writeUInt16LE(expected[0], place.characterOffset);
      replacements += 1;
    }
    if (tag.code === 1) {
      if (frame > 0 && expected[frame] !== expected[frame - 1]) {
        for (const depth of FLAME_DEPTHS) output.push(replacementPlace(depth, expected[frame]));
      }
      frame += 1;
    }
    output.push(tag);
  }
  if (replacements !== FLAME_DEPTHS.length) {
    throw new PatchError(`Expected four initial CastleFireWhite placements, replaced ${replacements}.`);
  }
  return {
    code: 39,
    data: Buffer.concat([templar.data.subarray(0, 4), ...output.map(encodeTag)]),
  };
}

function isJusticarPatched(
  justicar: SwfTag,
  expectedBySprite: Map<number, number[]>,
): boolean {
  const depths = JUSTICAR_FLAMES.flatMap((flame) => [...flame.parentDepths]);
  const states = timelineCharacters(justicar, depths);
  return JUSTICAR_FLAMES.every((flame) => {
    const expected = expectedBySprite.get(flame.spriteId);
    return expected !== undefined && states.every((state, frame) =>
      flame.parentDepths.every((depth) =>
        state.get(depth) === expected[frame % expected.length] && state.get(depth) !== flame.spriteId
      )
    );
  });
}

function patchJusticarTimeline(
  justicar: SwfTag,
  expectedBySprite: Map<number, number[]>,
): SwfTag {
  const frameCount = justicar.data.readUInt16LE(2);
  const output: SwfTag[] = [];
  const initialReplacements = new Map<number, number>();
  let frame = 0;
  for (const original of splitTags(justicar.data, 4)) {
    const tag = { code: original.code, data: Buffer.from(original.data) };
    const place = placeObject2(tag);
    if (frame === 0 && place?.characterId !== null && place?.characterId !== undefined && place.characterOffset !== null) {
      const flame = JUSTICAR_FLAMES.find((candidate) =>
        candidate.spriteId === place.characterId
        && candidate.parentDepths.includes(place.depth as never)
      );
      if (flame) {
        const expected = expectedBySprite.get(flame.spriteId);
        if (!expected) throw new PatchError(`Missing Justicar flame frames for sprite ${flame.spriteId}.`);
        tag.data.writeUInt16LE(expected[0], place.characterOffset);
        initialReplacements.set(flame.spriteId, (initialReplacements.get(flame.spriteId) ?? 0) + 1);
      }
    }
    if (tag.code === 1) {
      if (frame > 0) {
        for (const flame of JUSTICAR_FLAMES) {
          const expected = expectedBySprite.get(flame.spriteId);
          if (!expected) throw new PatchError(`Missing Justicar flame frames for sprite ${flame.spriteId}.`);
          if (expected[frame % expected.length] !== expected[(frame - 1) % expected.length]) {
            for (const depth of flame.parentDepths) {
              output.push(replacementPlace(depth, expected[frame % expected.length]));
            }
          }
        }
      }
      frame += 1;
    }
    output.push(tag);
  }
  for (const flame of JUSTICAR_FLAMES) {
    if (initialReplacements.get(flame.spriteId) !== flame.parentDepths.length) {
      throw new PatchError(`Expected two Justicar placements for sprite ${flame.spriteId}.`);
    }
  }
  if (frame !== frameCount) throw new PatchError("Unexpected Justicar final frame count.");
  return {
    code: 39,
    data: Buffer.concat([justicar.data.subarray(0, 4), ...output.map(encodeTag)]),
  };
}

function patchSwf(swfPath: string, verify: boolean): void {
  const decoded = decodeSwf(swfPath);
  const start = tagStreamStart(decoded.body);
  const tags = splitTags(decoded.body, start);
  const symbols = symbolMap(tags);
  const templarId = symbols.get(TEMPLAR_FINAL);
  const castleFireId = symbols.get(CASTLE_FIRE_WHITE);
  const justicarId = symbols.get(JUSTICAR_FINAL);
  if (templarId === undefined || castleFireId === undefined || justicarId === undefined) {
    throw new PatchError("Home tower flame symbols are missing.");
  }
  const templar = spriteTag(tags, templarId);
  const castleFire = spriteTag(tags, castleFireId);
  const justicar = spriteTag(tags, justicarId);
  const flameFrames = castleFireFrames(castleFire);
  const expected = expectedTemplarFrames(flameFrames, templar.data.readUInt16LE(2));
  const justicarFrames = new Map<number, number[]>();
  for (const flame of JUSTICAR_FLAMES) {
    const source = spriteTag(tags, flame.spriteId);
    const frames = timelineCharacters(source, [flame.sourceDepth]).map((state, index) => {
      const characterId = state.get(flame.sourceDepth);
      if (characterId === undefined) {
        throw new PatchError(`Justicar flame ${flame.spriteId} frame ${index + 1} has no static drawing.`);
      }
      return characterId;
    });
    if (frames.length !== 16 || new Set(frames).size !== 8) {
      throw new PatchError(`Justicar flame ${flame.spriteId} must contain eight drawings across 16 frames.`);
    }
    justicarFrames.set(flame.spriteId, frames);
  }
  const templarPatched = isPatched(templar, expected, castleFireId);
  const justicarPatched = isJusticarPatched(justicar, justicarFrames);
  if (templarPatched && justicarPatched) {
    console.log(`${swfPath}: already patched (Templar and Justicar flames are authored into parent timelines).`);
    return;
  }
  if (verify) throw new PatchError(`${swfPath}: verify failed; a Home tower still uses nested flame MovieClips.`);

  const patchedTemplar = templarPatched ? templar : patchTemplarTimeline(templar, expected, castleFireId);
  const patchedJusticar = justicarPatched ? justicar : patchJusticarTimeline(justicar, justicarFrames);
  const patchedTags = tags.map((tag) => {
    if (tag === templar) return patchedTemplar;
    if (tag === justicar) return patchedJusticar;
    return tag;
  });
  const patchedBody = Buffer.concat([decoded.body.subarray(0, start), ...patchedTags.map(encodeTag)]);
  const backup = `${swfPath}.bak`;
  if (!fs.existsSync(backup)) fs.copyFileSync(swfPath, backup);
  fs.writeFileSync(swfPath, encodeSwf(decoded.signature, decoded.version, patchedBody));

  const verified = decodeSwf(swfPath);
  const verifiedTags = splitTags(verified.body, tagStreamStart(verified.body));
  const verifiedTemplar = spriteTag(verifiedTags, templarId);
  const verifiedJusticar = spriteTag(verifiedTags, justicarId);
  if (
    !isPatched(verifiedTemplar, expected, castleFireId)
    || !isJusticarPatched(verifiedJusticar, justicarFrames)
  ) {
    throw new PatchError(`${swfPath}: patch write completed but timeline verification failed.`);
  }
  console.log(`${swfPath}: authored all four Justicar flames into the looping parent timeline.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
