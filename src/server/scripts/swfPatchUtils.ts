import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";

export class PatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PatchError";
  }
}

export type OperandKind = "u30" | "s24" | "s8";

export interface BytePatch {
  key: string;
  start: number;
  end: number;
  data: Buffer;
  detail: string;
}

export interface SwfContext {
  path: string;
  signature: "CWS" | "FWS";
  version: number;
  body: Buffer;
  doabcTagType: number;
  doabcLenFieldPos: number;
  doabcLen: number;
  abcStart: number;
}

export interface TraitInfo {
  nameIdx: number;
  kindId: number;
  methodIdx: number | null;
}

export interface InstanceInfo {
  classNameIdx: number;
  iinitMethodIdx: number;
  traits: TraitInfo[];
}

export interface MethodBodyInfo {
  methodIdx: number;
  maxStackPos: number;
  localCountPos: number;
  maxScopeDepthPos: number;
  maxScopeDepth: number;
  codeLenPos: number;
  codeStart: number;
  codeLen: number;
  exceptionCountPos: number;
  exceptionCount: number;
  exceptions: Array<{
    from: number;
    to: number;
    target: number;
    type: number;
    name: number;
  }>;
  traitsCountPos: number;
}

export interface AbcParseResult {
  intValues: number[];
  doubleValues: number[];
  stringValues: string[];
  stringCountPos: number;
  stringPoolEndPos: number;
  stringLenPositions: number[];
  stringDataPositions: number[];
  multinameNames: string[];
  instances: InstanceInfo[];
  classTraits: TraitInfo[][];
  methodBodies: Map<number, MethodBodyInfo>;
}

export interface Instruction {
  offset: number;
  opcode: number;
  operands: Array<[OperandKind, number]>;
  size: number;
}

const OPCODE_INFO = new Map<number, OperandKind[]>();

function initOpcodeInfo(): void {
  const noArgs = [
    0x01, 0x02, 0x03, 0x07, 0x09, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x21, 0x23, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x2b, 0x30, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x3b, 0x3c, 0x3d, 0x3e, 0x47,
    0x48, 0x50, 0x51, 0x52, 0x57, 0x64, 0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78,
    0x81, 0x82, 0x83, 0x84, 0x85, 0x87, 0x88, 0x89, 0x8e, 0x90, 0x91, 0x93, 0x95, 0x96, 0x97, 0xa0,
    0xa1, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xab, 0xac, 0xad, 0xae, 0xaf,
    0xb0, 0xb1, 0xb3, 0xb4, 0xc0, 0xc1, 0xc4, 0xc5, 0xc6, 0xc7, 0xd0, 0xd1, 0xd2, 0xd3, 0xd4,
    0xd5, 0xd6, 0xd7,
  ];
  const u30Args = [
    0x04, 0x05, 0x06, 0x08, 0x25, 0x2c, 0x2d, 0x2e, 0x2f, 0x31, 0x40, 0x41, 0x42, 0x49, 0x53,
    0x55, 0x56, 0x58, 0x59, 0x5a, 0x5d, 0x5e, 0x5f, 0x60, 0x61, 0x62, 0x63, 0x65, 0x66, 0x68,
    0x6a, 0x6c, 0x6d, 0x6e, 0x6f, 0x80, 0x86, 0x92, 0x94, 0xb2, 0xc2, 0xc3, 0xf0, 0xf1, 0xf2,
  ];
  const s24Args = [0x0c, 0x0d, 0x0e, 0x0f, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a];
  const u30u30Args = [0x43, 0x44, 0x45, 0x46, 0x4a, 0x4c, 0x4e, 0x4f];

  for (const opcode of noArgs) {
    OPCODE_INFO.set(opcode, []);
  }
  for (const opcode of u30Args) {
    OPCODE_INFO.set(opcode, ["u30"]);
  }
  for (const opcode of s24Args) {
    OPCODE_INFO.set(opcode, ["s24"]);
  }
  for (const opcode of u30u30Args) {
    OPCODE_INFO.set(opcode, ["u30", "u30"]);
  }
  OPCODE_INFO.set(0x24, ["s8"]);
  OPCODE_INFO.set(0x32, ["u30", "u30"]);
  OPCODE_INFO.set(0xef, ["s8", "u30", "s8", "u30"]);
}

initOpcodeInfo();

function requireBounds(data: Buffer, pos: number, width: number, ctx: string): void {
  if (pos < 0 || pos + width > data.length) {
    throw new PatchError(`Out-of-bounds read at ${pos} (${ctx})`);
  }
}

export function readU30(data: Buffer, start: number, ctx: string): [number, number] {
  let pos = start;
  let value = 0;
  let shift = 0;
  for (let i = 0; i < 5; i += 1) {
    requireBounds(data, pos, 1, ctx);
    const byte = data[pos];
    pos += 1;
    value |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      return [value >>> 0, pos];
    }
    shift += 7;
  }
  return [value >>> 0, pos];
}

function readS32(data: Buffer, start: number, ctx: string): [number, number] {
  let pos = start;
  let value = 0;
  let shift = 0;
  let last = 0;
  for (let i = 0; i < 5; i += 1) {
    requireBounds(data, pos, 1, ctx);
    const byte = data[pos];
    pos += 1;
    last = byte;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) {
      break;
    }
  }
  if (shift < 32 && (last & 0x40) !== 0) {
    value |= -(1 << shift);
  }
  return [value, pos];
}

function readS24(data: Buffer, pos: number, ctx: string): [number, number] {
  requireBounds(data, pos, 3, ctx);
  let value = data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16);
  if ((value & 0x800000) !== 0) {
    value -= 0x1000000;
  }
  return [value, pos + 3];
}

function readCString(data: Buffer, pos: number, end: number, ctx: string): [string, number] {
  const start = pos;
  while (pos < end && data[pos] !== 0) {
    pos += 1;
  }
  if (pos >= end) {
    throw new PatchError(`Unterminated cstring (${ctx})`);
  }
  return [data.subarray(start, pos).toString("utf8"), pos + 1];
}

export function writeU30(value: number): Buffer {
  if (value < 0) {
    throw new PatchError(`u30 cannot encode negative value ${value}`);
  }
  const out: number[] = [];
  let rest = value >>> 0;
  while (true) {
    let byte = rest & 0x7f;
    rest >>>= 7;
    if (rest !== 0) {
      byte |= 0x80;
    }
    out.push(byte);
    if (rest === 0) {
      return Buffer.from(out);
    }
  }
}

export function parseSwf(filePath: string): SwfContext {
  const raw = fs.readFileSync(filePath);
  if (raw.length < 8) {
    throw new PatchError("SWF too short");
  }

  const signature = raw.subarray(0, 3).toString("ascii");
  const version = raw[3];
  let body: Buffer;
  if (signature === "CWS") {
    body = zlib.inflateSync(raw.subarray(8));
  } else if (signature === "FWS") {
    body = Buffer.from(raw.subarray(8));
  } else {
    throw new PatchError(`Unsupported SWF signature: ${signature}`);
  }

  const nbits = body[0] >> 3;
  let pos = Math.floor((5 + nbits * 4 + 7) / 8) + 4;
  let doabcTagType = -1;
  let doabcLenFieldPos = -1;
  let doabcLen = -1;
  let abcStart = -1;

  while (pos < body.length) {
    requireBounds(body, pos, 2, "tag header");
    const tagCodeAndLen = body.readUInt16LE(pos);
    pos += 2;
    const tagType = tagCodeAndLen >> 6;
    let tagLen = tagCodeAndLen & 0x3f;
    const tagLenFieldPos = pos;
    if (tagLen === 0x3f) {
      requireBounds(body, pos, 4, "long tag length");
      tagLen = body.readUInt32LE(pos);
      pos += 4;
    }
    const tagDataStart = pos;
    const tagDataEnd = tagDataStart + tagLen;
    if (tagDataEnd > body.length) {
      throw new PatchError(`Tag ${tagType} overruns body`);
    }
    if ((tagType === 82 || tagType === 72) && abcStart === -1) {
      if (tagType === 82) {
        requireBounds(body, tagDataStart, 4, "DoABC2 flags");
        const [, afterName] = readCString(body, tagDataStart + 4, tagDataEnd, "DoABC2 name");
        abcStart = afterName;
      } else {
        abcStart = tagDataStart;
      }
      doabcTagType = tagType;
      doabcLenFieldPos = tagLenFieldPos;
      doabcLen = tagLen;
    }
    pos = tagDataEnd;
  }

  if (abcStart === -1) {
    throw new PatchError("No DoABC/DoABC2 tag found");
  }

  return {
    path: filePath,
    signature: signature as "CWS" | "FWS",
    version,
    body,
    doabcTagType,
    doabcLenFieldPos,
    doabcLen,
    abcStart,
  };
}

function parseTrait(data: Buffer, start: number, ctx: string): [TraitInfo, number] {
  let pos = start;
  let nameIdx: number;
  [nameIdx, pos] = readU30(data, pos, `${ctx}.trait.name`);
  requireBounds(data, pos, 1, `${ctx}.trait.kind`);
  const kind = data[pos];
  pos += 1;
  const kindId = kind & 0x0f;
  const attrs = kind >> 4;
  let methodIdx: number | null = null;

  if (kindId === 0 || kindId === 6) {
    [, pos] = readU30(data, pos, `${ctx}.trait.slot_id`);
    [, pos] = readU30(data, pos, `${ctx}.trait.type_name`);
    let vindex: number;
    [vindex, pos] = readU30(data, pos, `${ctx}.trait.vindex`);
    if (vindex !== 0) {
      requireBounds(data, pos, 1, `${ctx}.trait.vkind`);
      pos += 1;
    }
  } else if (kindId === 1 || kindId === 2 || kindId === 3) {
    [, pos] = readU30(data, pos, `${ctx}.trait.disp_id`);
    [methodIdx, pos] = readU30(data, pos, `${ctx}.trait.method`);
  } else if (kindId === 4) {
    [, pos] = readU30(data, pos, `${ctx}.trait.slot_id`);
    [, pos] = readU30(data, pos, `${ctx}.trait.classi`);
  } else if (kindId === 5) {
    [, pos] = readU30(data, pos, `${ctx}.trait.slot_id`);
    [, pos] = readU30(data, pos, `${ctx}.trait.functioni`);
  } else {
    throw new PatchError(`Unsupported trait kind id ${kindId} (${ctx})`);
  }

  if ((attrs & 0x04) !== 0) {
    let metadataCount: number;
    [metadataCount, pos] = readU30(data, pos, `${ctx}.trait.metadata_count`);
    for (let i = 0; i < metadataCount; i += 1) {
      [, pos] = readU30(data, pos, `${ctx}.trait.metadata[${i}]`);
    }
  }

  return [{ nameIdx, kindId, methodIdx }, pos];
}

export function parseAbc(ctx: SwfContext): AbcParseResult {
  const data = ctx.body;
  let pos = ctx.abcStart + 4;

  let count: number;
  [count, pos] = readU30(data, pos, "abc.int_count");
  const intValues = [0];
  for (let i = 1; i < count; i += 1) {
    let value: number;
    [value, pos] = readS32(data, pos, `abc.int[${i}]`);
    intValues.push(value);
  }

  [count, pos] = readU30(data, pos, "abc.uint_count");
  for (let i = 1; i < count; i += 1) {
    [, pos] = readU30(data, pos, `abc.uint[${i}]`);
  }

  [count, pos] = readU30(data, pos, "abc.double_count");
  const doubleValues = [NaN];
  for (let i = 1; i < count; i += 1) {
    requireBounds(data, pos, 8, `abc.double[${i}]`);
    doubleValues.push(data.readDoubleLE(pos));
    pos += 8;
  }

  let stringCount: number;
  const stringCountPos = pos;
  [stringCount, pos] = readU30(data, pos, "abc.string_count");
  const stringValues = [""];
  const stringLenPositions = [0];
  const stringDataPositions = [0];
  for (let i = 1; i < stringCount; i += 1) {
    const lenPos = pos;
    let strlen: number;
    [strlen, pos] = readU30(data, pos, `abc.string[${i}].len`);
    const dataPos = pos;
    requireBounds(data, pos, strlen, `abc.string[${i}]`);
    stringValues.push(data.subarray(pos, pos + strlen).toString("utf8"));
    stringLenPositions.push(lenPos);
    stringDataPositions.push(dataPos);
    pos += strlen;
  }
  const stringPoolEndPos = pos;

  [count, pos] = readU30(data, pos, "abc.namespace_count");
  for (let i = 1; i < count; i += 1) {
    requireBounds(data, pos, 1, `abc.namespace[${i}].kind`);
    pos += 1;
    [, pos] = readU30(data, pos, `abc.namespace[${i}].name`);
  }

  [count, pos] = readU30(data, pos, "abc.ns_set_count");
  for (let i = 1; i < count; i += 1) {
    let nsCount: number;
    [nsCount, pos] = readU30(data, pos, `abc.ns_set[${i}].count`);
    for (let j = 0; j < nsCount; j += 1) {
      [, pos] = readU30(data, pos, `abc.ns_set[${i}][${j}]`);
    }
  }

  let multinameCount: number;
  [multinameCount, pos] = readU30(data, pos, "abc.multiname_count");
  const multinameNames = [""];
  for (let i = 1; i < multinameCount; i += 1) {
    requireBounds(data, pos, 1, `abc.mn[${i}].kind`);
    const kind = data[pos];
    pos += 1;
    let name = "";
    let nameIdx = 0;
    if (kind === 0x07 || kind === 0x0d) {
      [, pos] = readU30(data, pos, `abc.mn[${i}].ns`);
      [nameIdx, pos] = readU30(data, pos, `abc.mn[${i}].name`);
    } else if (kind === 0x0f || kind === 0x10) {
      [nameIdx, pos] = readU30(data, pos, `abc.mn[${i}].name`);
    } else if (kind === 0x11 || kind === 0x12) {
      nameIdx = 0;
    } else if (kind === 0x09 || kind === 0x0e) {
      [nameIdx, pos] = readU30(data, pos, `abc.mn[${i}].name`);
      [, pos] = readU30(data, pos, `abc.mn[${i}].nsset`);
    } else if (kind === 0x1b || kind === 0x1c) {
      [nameIdx, pos] = readU30(data, pos, `abc.mn[${i}].name`);
    } else if (kind === 0x1d) {
      [, pos] = readU30(data, pos, `abc.mn[${i}].qname`);
      let paramCount: number;
      [paramCount, pos] = readU30(data, pos, `abc.mn[${i}].param_count`);
      for (let j = 0; j < paramCount; j += 1) {
        [, pos] = readU30(data, pos, `abc.mn[${i}].param[${j}]`);
      }
    } else {
      throw new PatchError(`Unsupported multiname kind 0x${kind.toString(16)} at index ${i}`);
    }
    if (nameIdx < stringValues.length) {
      name = stringValues[nameIdx];
    }
    multinameNames.push(name);
  }

  let methodCount: number;
  [methodCount, pos] = readU30(data, pos, "abc.method_count");
  for (let i = 0; i < methodCount; i += 1) {
    let paramCount: number;
    [paramCount, pos] = readU30(data, pos, `abc.method[${i}].param_count`);
    [, pos] = readU30(data, pos, `abc.method[${i}].return_type`);
    for (let j = 0; j < paramCount; j += 1) {
      [, pos] = readU30(data, pos, `abc.method[${i}].param_type[${j}]`);
    }
    [, pos] = readU30(data, pos, `abc.method[${i}].name`);
    requireBounds(data, pos, 1, `abc.method[${i}].flags`);
    const flags = data[pos];
    pos += 1;
    if ((flags & 0x08) !== 0) {
      let optionCount: number;
      [optionCount, pos] = readU30(data, pos, `abc.method[${i}].option_count`);
      for (let j = 0; j < optionCount; j += 1) {
        [, pos] = readU30(data, pos, `abc.method[${i}].option[${j}].val`);
        requireBounds(data, pos, 1, `abc.method[${i}].option[${j}].kind`);
        pos += 1;
      }
    }
    if ((flags & 0x80) !== 0) {
      for (let j = 0; j < paramCount; j += 1) {
        [, pos] = readU30(data, pos, `abc.method[${i}].param_name[${j}]`);
      }
    }
  }

  [count, pos] = readU30(data, pos, "abc.metadata_count");
  for (let i = 0; i < count; i += 1) {
    [, pos] = readU30(data, pos, `abc.metadata[${i}].name`);
    let itemCount: number;
    [itemCount, pos] = readU30(data, pos, `abc.metadata[${i}].item_count`);
    for (let j = 0; j < itemCount; j += 1) {
      [, pos] = readU30(data, pos, `abc.metadata[${i}].key[${j}]`);
      [, pos] = readU30(data, pos, `abc.metadata[${i}].val[${j}]`);
    }
  }

  let classCount: number;
  [classCount, pos] = readU30(data, pos, "abc.class_count");
  const instances: InstanceInfo[] = [];
  for (let i = 0; i < classCount; i += 1) {
    let classNameIdx: number;
    [classNameIdx, pos] = readU30(data, pos, `abc.instance[${i}].name`);
    [, pos] = readU30(data, pos, `abc.instance[${i}].super_name`);
    requireBounds(data, pos, 1, `abc.instance[${i}].flags`);
    const flags = data[pos];
    pos += 1;
    if ((flags & 0x08) !== 0) {
      [, pos] = readU30(data, pos, `abc.instance[${i}].protected_ns`);
    }
    let interfaceCount: number;
    [interfaceCount, pos] = readU30(data, pos, `abc.instance[${i}].interface_count`);
    for (let j = 0; j < interfaceCount; j += 1) {
      [, pos] = readU30(data, pos, `abc.instance[${i}].interface[${j}]`);
    }
    let iinitMethodIdx: number;
    [iinitMethodIdx, pos] = readU30(data, pos, `abc.instance[${i}].iinit`);
    let traitCount: number;
    [traitCount, pos] = readU30(data, pos, `abc.instance[${i}].trait_count`);
    const traits: TraitInfo[] = [];
    for (let j = 0; j < traitCount; j += 1) {
      let trait: TraitInfo;
      [trait, pos] = parseTrait(data, pos, `abc.instance[${i}]`);
      traits.push(trait);
    }
    instances.push({ classNameIdx, iinitMethodIdx, traits });
  }

  const classTraits: TraitInfo[][] = [];
  for (let i = 0; i < classCount; i += 1) {
    [, pos] = readU30(data, pos, `abc.class[${i}].cinit`);
    let traitCount: number;
    [traitCount, pos] = readU30(data, pos, `abc.class[${i}].trait_count`);
    const traits: TraitInfo[] = [];
    for (let j = 0; j < traitCount; j += 1) {
      let trait: TraitInfo;
      [trait, pos] = parseTrait(data, pos, `abc.class[${i}]`);
      traits.push(trait);
    }
    classTraits.push(traits);
  }

  [count, pos] = readU30(data, pos, "abc.script_count");
  for (let i = 0; i < count; i += 1) {
    [, pos] = readU30(data, pos, `abc.script[${i}].init`);
    let traitCount: number;
    [traitCount, pos] = readU30(data, pos, `abc.script[${i}].trait_count`);
    for (let j = 0; j < traitCount; j += 1) {
      [, pos] = parseTrait(data, pos, `abc.script[${i}]`);
    }
  }

  const methodBodies = new Map<number, MethodBodyInfo>();
  [count, pos] = readU30(data, pos, "abc.method_body_count");
  for (let i = 0; i < count; i += 1) {
    let methodIdx: number;
    [methodIdx, pos] = readU30(data, pos, `abc.body[${i}].method`);
    const maxStackPos = pos;
    [, pos] = readU30(data, pos, `abc.body[${i}].max_stack`);
    const localCountPos = pos;
    [, pos] = readU30(data, pos, `abc.body[${i}].local_count`);
    [, pos] = readU30(data, pos, `abc.body[${i}].init_scope_depth`);
    const maxScopeDepthPos = pos;
    let maxScopeDepth: number;
    [maxScopeDepth, pos] = readU30(data, pos, `abc.body[${i}].max_scope_depth`);
    const codeLenPos = pos;
    let codeLen: number;
    [codeLen, pos] = readU30(data, pos, `abc.body[${i}].code_length`);
    const codeStart = pos;
    pos += codeLen;

    const exceptionCountPos = pos;
    let exceptionCount: number;
    [exceptionCount, pos] = readU30(data, pos, `abc.body[${i}].exception_count`);
    const exceptions: MethodBodyInfo["exceptions"] = [];
    for (let j = 0; j < exceptionCount; j += 1) {
      let from: number;
      let to: number;
      let target: number;
      let type: number;
      let name: number;
      [from, pos] = readU30(data, pos, `abc.body[${i}].exception[${j}].from`);
      [to, pos] = readU30(data, pos, `abc.body[${i}].exception[${j}].to`);
      [target, pos] = readU30(data, pos, `abc.body[${i}].exception[${j}].target`);
      [type, pos] = readU30(data, pos, `abc.body[${i}].exception[${j}].type`);
      [name, pos] = readU30(data, pos, `abc.body[${i}].exception[${j}].name`);
      exceptions.push({ from, to, target, type, name });
    }

    const traitsCountPos = pos;
    methodBodies.set(methodIdx, {
      methodIdx,
      maxStackPos,
      localCountPos,
      maxScopeDepthPos,
      maxScopeDepth,
      codeLenPos,
      codeStart,
      codeLen,
      exceptionCountPos,
      exceptionCount,
      exceptions,
      traitsCountPos,
    });

    let traitCount: number;
    [traitCount, pos] = readU30(data, pos, `abc.body[${i}].trait_count`);
    for (let j = 0; j < traitCount; j += 1) {
      [, pos] = parseTrait(data, pos, `abc.body[${i}]`);
    }
  }

  return {
    intValues,
    doubleValues,
    stringValues,
    stringCountPos,
    stringPoolEndPos,
    stringLenPositions,
    stringDataPositions,
    multinameNames,
    instances,
    classTraits,
    methodBodies,
  };
}

export function disassemble(code: Buffer, ctx: string): Instruction[] {
  const instructions: Instruction[] = [];
  let pos = 0;
  while (pos < code.length) {
    const offset = pos;
    const opcode = code[pos];
    pos += 1;
    const signature = OPCODE_INFO.get(opcode);
    if (signature === undefined) {
      throw new PatchError(`Unsupported opcode 0x${opcode.toString(16)} in ${ctx} at ${offset}`);
    }
    const operands: Array<[OperandKind, number]> = [];
    for (const operandType of signature) {
      if (operandType === "u30") {
        let value: number;
        [value, pos] = readU30(code, pos, `${ctx}@${offset}`);
        operands.push(["u30", value]);
      } else if (operandType === "s24") {
        let value: number;
        [value, pos] = readS24(code, pos, `${ctx}@${offset}`);
        operands.push(["s24", value]);
      } else {
        requireBounds(code, pos, 1, `${ctx}@${offset}`);
        operands.push(["s8", code.readInt8(pos)]);
        pos += 1;
      }
    }
    instructions.push({ offset, opcode, operands, size: pos - offset });
  }
  return instructions;
}

export function classIndexByName(abc: AbcParseResult, className: string): number | null {
  for (let i = 0; i < abc.instances.length; i += 1) {
    const classIdx = abc.instances[i].classNameIdx;
    if (classIdx < abc.multinameNames.length && abc.multinameNames[classIdx] === className) {
      return i;
    }
  }
  return null;
}

export function methodIdxForTrait(
  traits: TraitInfo[],
  abc: AbcParseResult,
  methodName: string,
): number | null {
  for (const trait of traits) {
    if (trait.methodIdx === null) {
      continue;
    }
    if (trait.nameIdx < abc.multinameNames.length && abc.multinameNames[trait.nameIdx] === methodName) {
      return trait.methodIdx;
    }
  }
  return null;
}

export function u30OperandName(inst: Instruction, names: string[]): string | null {
  if (inst.operands.length === 0 || inst.operands[0][0] !== "u30") {
    return null;
  }
  const idx = inst.operands[0][1];
  return idx < names.length ? names[idx] : null;
}

export function applyPatches(body: Buffer, patches: BytePatch[]): number {
  const ordered = [...patches].sort((a, b) => b.start - a.start);
  let delta = 0;
  for (const patch of ordered) {
    if (patch.start < 0 || patch.end < patch.start || patch.end > body.length) {
      throw new PatchError(`Invalid patch range for ${patch.key}: ${patch.start}:${patch.end}`);
    }
    const before = body.subarray(0, patch.start);
    const after = body.subarray(patch.end);
    body = Buffer.concat([before, patch.data, after]);
    delta += patch.data.length - (patch.end - patch.start);
  }
  return delta;
}

export function applyPatchesToBody(originalBody: Buffer, patches: BytePatch[]): { body: Buffer; delta: number } {
  const ordered = [...patches].sort((a, b) => b.start - a.start);
  let body = Buffer.from(originalBody);
  let delta = 0;
  for (const patch of ordered) {
    if (patch.start < 0 || patch.end < patch.start || patch.end > body.length) {
      throw new PatchError(`Invalid patch range for ${patch.key}: ${patch.start}:${patch.end}`);
    }
    body = Buffer.concat([body.subarray(0, patch.start), patch.data, body.subarray(patch.end)]);
    delta += patch.data.length - (patch.end - patch.start);
  }
  return { body, delta };
}

export function writeSwf(ctx: SwfContext, outBody: Buffer, abcDelta: number): void {
  const body = Buffer.from(outBody);
  if (abcDelta !== 0) {
    body.writeUInt32LE(ctx.doabcLen + abcDelta, ctx.doabcLenFieldPos);
  }

  const header = Buffer.alloc(8);
  header.write(ctx.signature, 0, "ascii");
  header[3] = ctx.version;
  header.writeUInt32LE(8 + body.length, 4);

  const payload = ctx.signature === "CWS" ? Buffer.concat([header, zlib.deflateSync(body)]) : Buffer.concat([header, body]);
  fs.writeFileSync(ctx.path, payload);
}

export function ensureBackup(filePath: string): string {
  const backupPath = `${filePath}.bak`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(filePath, backupPath);
  }
  return backupPath;
}

export function defaultLevelsNrPath(): string {
  return path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbp", "LevelsNR.swf");
}
