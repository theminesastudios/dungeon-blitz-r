import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

export class SwzPatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwzPatchError";
  }
}

export interface SwzChunk {
  index: number;
  xml: string;
}

export interface SwzContext {
  path: string;
  key: number;
  chunks: SwzChunk[];
}

function rotateKey(key: number, shift: number): number {
  return ((key << (32 - shift)) | (key >>> shift)) >>> 0;
}

export function defaultLoginSwzPath(): string {
  return path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "Login.swz");
}

export function ensureBackup(filePath: string): string {
  const backupPath = `${filePath}.bak`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
  }
  return backupPath;
}

export function parseSwz(filePath: string): SwzContext {
  const raw = fs.readFileSync(filePath);
  if (raw.length < 8) {
    throw new SwzPatchError("SWZ too short");
  }

  let pos = 0;
  const key = raw.readUInt32BE(pos);
  pos += 4;
  const chunkCount = raw.readUInt32BE(pos);
  pos += 4;
  let rollingKey = key >>> 0;
  const chunks: SwzChunk[] = [];

  for (let index = 0; index < chunkCount; index += 1) {
    if (pos + 4 > raw.length) {
      throw new SwzPatchError(`Chunk ${index} length field overruns file`);
    }
    const encodedLen = raw.readUInt32BE(pos);
    pos += 4;
    if (encodedLen < 0 || pos + encodedLen > raw.length) {
      throw new SwzPatchError(`Chunk ${index} data overruns file`);
    }

    const compressed = Buffer.alloc(encodedLen);
    for (let i = 0; i < encodedLen; i += 1) {
      const shift = i & 7;
      compressed[i] = raw[pos + i] ^ (rollingKey & 0xff);
      rollingKey = rotateKey(rollingKey, shift);
    }
    pos += encodedLen;

    let inflated: Buffer;
    try {
      inflated = zlib.inflateSync(compressed);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new SwzPatchError(`Failed to inflate chunk ${index}: ${message}`);
    }

    chunks.push({
      index,
      xml: inflated.toString("utf8"),
    });
  }

  return {
    path: filePath,
    key,
    chunks,
  };
}

export function writeSwz(ctx: SwzContext): void {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(8);
  header.writeUInt32BE(ctx.key >>> 0, 0);
  header.writeUInt32BE(ctx.chunks.length, 4);
  parts.push(header);

  let rollingKey = ctx.key >>> 0;
  for (const chunk of ctx.chunks) {
    const compressed = zlib.deflateSync(Buffer.from(chunk.xml, "utf8"));
    const len = Buffer.alloc(4);
    len.writeUInt32BE(compressed.length, 0);
    parts.push(len);

    const encoded = Buffer.alloc(compressed.length);
    for (let i = 0; i < compressed.length; i += 1) {
      const shift = i & 7;
      encoded[i] = compressed[i] ^ (rollingKey & 0xff);
      rollingKey = rotateKey(rollingKey, shift);
    }
    parts.push(encoded);
  }

  fs.writeFileSync(ctx.path, Buffer.concat(parts));
}
