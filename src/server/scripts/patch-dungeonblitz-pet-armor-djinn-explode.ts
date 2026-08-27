import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import {
  applyPatchesToBody,
  BytePatch,
  classIndexByName,
  disassemble,
  ensureBackup,
  Instruction,
  methodIdxForTrait,
  parseAbc,
  parseSwf,
  PatchError,
  readU30,
  SwfContext,
  writeSwf,
  writeU30,
} from "./swfPatchUtils";
import { parseSwz, writeSwz } from "./swzPatchUtils";

/**
 * Falcon / Pixie armor reduction + Djinn explosion (issue #721).
 *
 * 1. Falcon and Pixie pets shred armor. Their power's AddTargetBuff list gains a
 *    `PetArmorBane` entry (a new BuffType with no base defense values), and a new
 *    PowerModType (ModID 1100, BuffProperty MeleeDefense,MagicDefense) lets a
 *    runtime-injected mod carry the actual number. In CombatState.method_1192
 *    (the AddTargetBuff application loop) a block is inserted at the point where
 *    the buff's mods vector is about to be handed to AddBuff: when the buff is
 *    PetArmorBane, the caster's summoner (the player, via
 *    this.var_1.GetEntFromID(this.var_3.summonerId)) is asked for the equipped
 *    pet's level (`mEquipPet.var_23`), and a mod of `-level/200` (0.5% per pet
 *    level: 0.5% at level 1, 10% at level 20) is pushed for both properties.
 *    The existing Buff cache math adds mod values to the BuffType base, and the
 *    base is 0, so the reduction is exactly the level-scaled value.
 *
 *    The level is read from the summoner at cast time rather than stamped onto
 *    the pet Entity: Entity.var_64 doubles as the level index into the static
 *    stat tables (meleeDamage, magicDamage, armorClass, maxHP), so writing a pet
 *    level into it would silently re-scale the pet's combat stats everywhere
 *    ResetEntType runs.
 *
 * 2. Djinn pets explode on expiry. Entity.method_1770 only runs its explosion
 *    block when `entType.entName == "Decoy"` (the mage's decoy); the Djinn pets
 *    are "PetDjinnRed/Yellow/Blue/Green", so they expired silently. The gate's
 *    `ifne` (not-equal -> skip) is re-pointed to an appended check that also
 *    lets an entity through when `entName.indexOf("PetDjinn") == 0`; every
 *    other summoned entity skips the explosion block. The power
 *    lookup inside the block falls back to the base "DecoyExplode" power when
 *    the entity's power has no level suffix (SummonPet has none), so the Djinn
 *    gets the base explosion: RangedAoE radius 300, x1.5 physical damage, cast
 *    by the summoner, once per pet duration (the Djinn also carries
 *    PetDjinnInvulnerability, so it cannot be farmed for mid-fight explosions).
 *
 * The XML edits (PlayerBuffTypes / PlayerPowerTypes / PowerModTypes) are applied
 * to the source XML files and to the matching chunks inside cbq/Game.swz, the
 * served copy.
 *
 * Run with --verify to check that every change is already present, without
 * writing anything. All offsets below were verified against the committed
 * DungeonBlitz.swf; surrounding-instruction checks fail loudly if the pool or
 * code drifts.
 */

type Operand = Array<[Instruction["operands"][number][0], number]>;

const OP = {
  jump: 0x10,
  iffalse: 0x12,
  ifne: 0x14,
  pushbyte: 0x24,
  pushshort: 0x25,
  pop: 0x29,
  dup: 0x2a,
  pushstring: 0x2c,
  construct: 0x42,
  callproperty: 0x46,
  constructprop: 0x4a,
  callpropvoid: 0x4f,
  newarray: 0x53,
  findpropstrict: 0x5d,
  getlex: 0x60,
  getlocal: 0x62,
  setlocal: 0x63,
  getproperty: 0x66,
  coerce: 0x80,
  subtract: 0xa1,
  divide: 0xa3,
} as const;

type Emitted =
  | { label: string }
  | { opcode: number; operands?: Operand; branchTo?: string; pop?: number; push?: number };

const DEFAULT_SWF = path.resolve(
  __dirname,
  "..",
  "..",
  "client",
  "content",
  "localhost",
  "p",
  "cbp",
  "DungeonBlitz.swf",
);
const XML_DIR = path.resolve(__dirname, "..", "..", "client", "content", "xml");
const CBQ_DIR = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "p", "cbq");
const INDEX_HTML = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "index.html");

// ---- XML payloads ----------------------------------------------------------

const PET_ARMOR_BUFF = `\t<BuffType BuffName="PetArmorBane">\n\t\t<BuffID>748</BuffID>\n\t\t<Attack>true</Attack>\n\t\t<Duration>5000</Duration>\n\t\t<StackCount>1</StackCount>\n\t\t<BuffLoc>Head</BuffLoc>\n\t\t<BuffIcon>a_StatusIcon_DefenseDown</BuffIcon>\n\t\t<GfxType>\n\t\t\t<AnimScale>0.5</AnimScale>\n\t\t\t<AnimFile>SFX_1.swf</AnimFile>\n\t\t\t<AnimClass>a_Debuff_Armor</AnimClass>\n\t\t</GfxType>\n\t</BuffType>\n`;

const PET_ARMOR_MOD = `\t<PowerModType>\n\t\t<ModName>PetArmorBane1</ModName>\n\t\t<ModID>1100</ModID>\n\t\t<DisplayName>Pet Armor Bane</DisplayName>\n\t\t<Description>Pet attacks shred enemy armor</Description>\n\t\t<ModType>Buff</ModType>\n\t\t<BuffName>PetArmorBane</BuffName>\n\t\t<BuffProperty>MeleeDefense,MagicDefense</BuffProperty>\n\t\t<BuffValue>0,0</BuffValue>\n\t\t<IconName>a_Signet_ArmorDmg01</IconName>\n\t</PowerModType>\n`;

function patchBuffsXml(xml: string): string {
  if (xml.includes(`BuffName="PetArmorBane"`)) {
    return xml;
  }
  return xml.replace("</PlayerBuffTypes>", `${PET_ARMOR_BUFF}</PlayerBuffTypes>`);
}

function patchModsXml(xml: string): string {
  if (xml.includes("<ModID>1100</ModID>")) {
    return xml;
  }
  return xml.replace("</PowerModTypes>", `${PET_ARMOR_MOD}</PowerModTypes>`);
}

function patchPowersXml(xml: string): string {
  let next = xml;
  for (const powerName of ["PetFalcon", "PetFairy"]) {
    next = next.replace(
      new RegExp(`(<Power PowerName="${powerName}">[\\s\\S]*?<AddTargetBuff>)([^<]*)(</AddTargetBuff>[\\s\\S]*?</Power>)`),
      (match: string, pre: string, buffs: string, post: string) =>
        buffs.includes("PetArmorBane") ? match : `${pre}${buffs},PetArmorBane${post}`,
    );
  }
  return next;
}

// ---- bytecode utilities ----------------------------------------------------

function writeS24(value: number): Buffer {
  const out = Buffer.alloc(3);
  let encoded = value;
  if (encoded < 0) {
    encoded += 1 << 24;
  }
  out[0] = encoded & 0xff;
  out[1] = (encoded >>> 8) & 0xff;
  out[2] = (encoded >>> 16) & 0xff;
  return out;
}

function isBranchOpcode(opcode: number): boolean {
  return opcode >= 0x0c && opcode <= 0x1a;
}

function operandBytes(kind: Operand[0][0], value: number): Buffer {
  if (kind === "u30") {
    return writeU30(value);
  }
  if (kind === "s8") {
    return Buffer.from([value & 0xff]);
  }
  if (kind === "s24") {
    return writeS24(value);
  }
  throw new PatchError(`Unsupported operand kind ${kind}`);
}

interface PoolInfo {
  strings: string[];
  stringCountPos: number;
  stringCountEnd: number;
  stringPoolEnd: number;
}

function parsePool(ctx: SwfContext): PoolInfo {
  const d = ctx.body;
  let pos = ctx.abcStart + 4;
  let count: number;

  [count, pos] = readU30(d, pos, "pool.int");
  for (let i = 1; i < count; i += 1) {
    [, pos] = readU30(d, pos, "pool.int[]");
  }
  [count, pos] = readU30(d, pos, "pool.uint");
  for (let i = 1; i < count; i += 1) {
    [, pos] = readU30(d, pos, "pool.uint[]");
  }
  [count, pos] = readU30(d, pos, "pool.double");
  pos += 8 * (count - 1);

  const stringCountPos = pos;
  [count, pos] = readU30(d, pos, "pool.string");
  const stringCountEnd = pos;
  const strings = [""];
  for (let i = 1; i < count; i += 1) {
    let len: number;
    [len, pos] = readU30(d, pos, "pool.string[].len");
    strings.push(d.subarray(pos, pos + len).toString("utf8"));
    pos += len;
  }
  const stringPoolEnd = pos;

  [count, pos] = readU30(d, pos, "pool.ns");
  for (let i = 1; i < count; i += 1) {
    pos += 1;
    [, pos] = readU30(d, pos, "pool.ns[].name");
  }
  [count, pos] = readU30(d, pos, "pool.nsset");
  for (let i = 1; i < count; i += 1) {
    let entries: number;
    [entries, pos] = readU30(d, pos, "pool.nsset[].count");
    for (let j = 0; j < entries; j += 1) {
      [, pos] = readU30(d, pos, "pool.nsset[][]");
    }
  }
  [count, pos] = readU30(d, pos, "pool.mn");
  for (let i = 1; i < count; i += 1) {
    const kind = d[pos];
    pos += 1;
    if (kind === 0x07 || kind === 0x0d) {
      [, pos] = readU30(d, pos, "mn.ns");
      [, pos] = readU30(d, pos, "mn.name");
    } else if (kind === 0x0f || kind === 0x10) {
      [, pos] = readU30(d, pos, "mn.name");
    } else if (kind === 0x11 || kind === 0x12) {
      // runtime multiname, no operands
    } else if (kind === 0x09 || kind === 0x0e) {
      [, pos] = readU30(d, pos, "mn.name");
      [, pos] = readU30(d, pos, "mn.nsset");
    } else if (kind === 0x1b || kind === 0x1c) {
      [, pos] = readU30(d, pos, "mn.nsset");
    } else if (kind === 0x1d) {
      [, pos] = readU30(d, pos, "mn.qname");
      let params: number;
      [params, pos] = readU30(d, pos, "mn.params");
      for (let j = 0; j < params; j += 1) {
        [, pos] = readU30(d, pos, "mn.param[]");
      }
    } else {
      throw new PatchError(`Unsupported multiname kind 0x${kind.toString(16)} at ${i}`);
    }
  }
  return { strings, stringCountPos, stringCountEnd, stringPoolEnd };
}

function appendStrings(pool: PoolInfo, wanted: string[]): { indexOf: Map<string, number>; patches: BytePatch[] } {
  const indexOf = new Map<string, number>();
  const missing: string[] = [];
  for (const value of wanted) {
    const existing = pool.strings.indexOf(value);
    if (existing > 0) {
      indexOf.set(value, existing);
      continue;
    }
    if (!missing.includes(value)) {
      missing.push(value);
    }
  }
  if (missing.length === 0) {
    return { indexOf, patches: [] };
  }

  let nextIndex = pool.strings.length;
  const chunks: Buffer[] = [];
  for (const value of missing) {
    const bytes = Buffer.from(value, "utf8");
    chunks.push(writeU30(bytes.length), bytes);
    indexOf.set(value, nextIndex);
    nextIndex += 1;
  }

  return {
    indexOf,
    patches: [
      {
        key: "abc.string_pool.append",
        start: pool.stringPoolEnd,
        end: pool.stringPoolEnd,
        data: Buffer.concat(chunks),
        detail: `append ${missing.length} string constants`,
      },
      {
        key: "abc.string_count",
        start: pool.stringCountPos,
        end: pool.stringCountEnd,
        data: writeU30(nextIndex),
        detail: `string_count -> ${nextIndex}`,
      },
    ],
  };
}

function assemble(program: Emitted[]): Buffer {
  const labels = new Map<string, number>();
  let offset = 0;
  for (const item of program) {
    if ("label" in item) {
      if (labels.has(item.label)) {
        throw new PatchError(`Duplicate label ${item.label}`);
      }
      labels.set(item.label, offset);
      continue;
    }
    offset += 1;
    if (item.branchTo) {
      offset += 3;
    } else {
      for (const [kind, value] of item.operands ?? []) {
        offset += operandBytes(kind, value).length;
      }
    }
  }

  const depthAt = new Map<string, number>();
  let depth = 0;
  let maxDepth = 0;
  let reachable = true;
  for (const item of program) {
    if ("label" in item) {
      const known = depthAt.get(item.label);
      if (known === undefined) {
        if (!reachable) {
          throw new PatchError(`Label ${item.label} is unreachable`);
        }
        depthAt.set(item.label, depth);
      } else {
        if (reachable && known !== depth) {
          throw new PatchError(`Stack depth mismatch at ${item.label}: ${known} vs ${depth}`);
        }
        depth = known;
      }
      reachable = true;
      continue;
    }
    if (!reachable) {
      throw new PatchError("Unreachable instruction in emitted block");
    }
    depth -= item.pop ?? 0;
    if (depth < 0) {
      throw new PatchError("Emitted block underflows the operand stack");
    }
    depth += item.push ?? 0;
    maxDepth = Math.max(maxDepth, depth);
    if (item.branchTo) {
      const known = depthAt.get(item.branchTo);
      if (known === undefined) {
        depthAt.set(item.branchTo, depth);
      } else if (known !== depth) {
        throw new PatchError(`Stack depth mismatch branching to ${item.branchTo}: ${known} vs ${depth}`);
      }
      if (item.opcode === OP.jump) {
        reachable = false;
      }
    }
  }
  if (reachable && depth !== 0) {
    throw new PatchError(`Emitted block leaves ${depth} values on the stack`);
  }
  if (maxDepth > 8) {
    throw new PatchError(`Emitted block needs stack ${maxDepth}, budget is 8`);
  }

  const chunks: Buffer[] = [];
  const fixups: Array<{ pos: number; target: string }> = [];
  offset = 0;
  for (const item of program) {
    if ("label" in item) {
      continue;
    }
    const parts: Buffer[] = [Buffer.from([item.opcode])];
    offset += 1;
    if (item.branchTo) {
      parts.push(Buffer.alloc(3));
      fixups.push({ pos: offset, target: item.branchTo });
      offset += 3;
    } else {
      for (const [kind, value] of item.operands ?? []) {
        const bytes = operandBytes(kind, value);
        parts.push(bytes);
        offset += bytes.length;
      }
    }
    chunks.push(Buffer.concat(parts));
  }

  const assembled = Buffer.concat(chunks);
  for (const fixup of fixups) {
    const target = labels.get(fixup.target);
    if (target === undefined) {
      throw new PatchError(`Unknown branch label ${fixup.target}`);
    }
    writeS24(target - (fixup.pos + 3)).copy(assembled, fixup.pos);
  }
  return assembled;
}

/**
 * Insert `data` at byte `at` and re-target every branch outside it. Branches
 * whose original target is in `stayTargets` are left pointing at that offset
 * (i.e. they land on the first byte of the inserted block) instead of being
 * shifted past it. This is the shape of the method_1192 insertion: the
 * `caster.var_18 == null` branch (pets) deliberately jumps INTO the block.
 */
function spliceInsertStay(
  originalCode: Buffer,
  instructions: Instruction[],
  at: number,
  data: Buffer,
  stayTargets: Set<number>,
): Buffer {
  const patched = Buffer.concat([originalCode.subarray(0, at), data, originalCode.subarray(at)]);
  const delta = data.length;
  const shift = (offset: number): number => (offset >= at ? offset + delta : offset);

  for (const inst of instructions) {
    if (!isBranchOpcode(inst.opcode) || inst.operands[0][0] !== "s24") {
      continue;
    }
    const oldTarget = inst.offset + inst.size + inst.operands[0][1];
    const newTarget = stayTargets.has(oldTarget) ? oldTarget : shift(oldTarget);
    const newOffset = shift(inst.offset);
    writeS24(newTarget - (newOffset + inst.size)).copy(patched, newOffset + 1);
  }
  return patched;
}

// ---- SWF bytecode patches --------------------------------------------------
// Multiname / string indices are constants of this committed client revision;
// they are re-validated against the surrounding instructions, so a drifted pool
// fails loudly instead of patching the wrong site.

const MN = {
  var_1: 1,
  var_3: 31,
  indexOf: 41,
  buffName: 182,
  GetEntFromID: 224,
  var_23: 245,
  mEquipPet: 363,
  summonerId: 399,
  class_140: 358,
  Vector: 12,
  Number: 9,
  push: 13127,
  coerceModList: 14157, // Vector.<class_140>
  coerceValueList: 14158, // Vector.<Number>
  coerceAssign: 14159, // Vector.<class_140>
};
const STR = {
  decoy: 3267,
  petDjinn: 4820,
};

const getlocal = (index: number): Emitted =>
  index <= 3 ? { opcode: 0xd0 + index, push: 1 } : { opcode: OP.getlocal, operands: [["u30", index]], push: 1 };
const setlocal = (index: number): Emitted =>
  index <= 3 ? { opcode: 0xd4 + index, pop: 1 } : { opcode: OP.setlocal, operands: [["u30", index]], pop: 1 };
const get = (mn: number): Emitted => ({ opcode: OP.getproperty, operands: [["u30", mn]], pop: 1, push: 1 });
const getLex = (mn: number): Emitted => ({ opcode: OP.getlex, operands: [["u30", mn]], push: 1 });
const pushStr = (idx: number): Emitted => ({ opcode: OP.pushstring, operands: [["u30", idx]], push: 1 });
const pushShort = (value: number): Emitted => ({ opcode: OP.pushshort, operands: [["u30", value]], push: 1 });
const callProp = (mn: number, args: number): Emitted => ({
  opcode: OP.callproperty,
  operands: [
    ["u30", mn],
    ["u30", args],
  ],
  pop: args + 1,
  push: 1,
});
const callVoid = (mn: number, args: number): Emitted => ({
  opcode: OP.callpropvoid,
  operands: [
    ["u30", mn],
    ["u30", args],
  ],
  pop: args + 1,
});

/**
 * The method_1192 injection: replaces the mods vector with a fresh one carrying
 * a PetArmorBane mod of -level/200 for both MeleeDefense and MagicDefense.
 * Entry/exit stack depth is 0; locals used (74, 75, 77) are free at this point
 * (the LeoneanAura block that follows reuses them later).
 */
function petArmorModBlock(petArmorBaneStr: number, legacyPositiveSign = false): Buffer {
  const defenseReduction = legacyPositiveSign
    ? [
        // Legacy bug: level / 200 - 0, which increases defense.
        getlocal(74),
        pushShort(200),
        { opcode: OP.divide, pop: 2, push: 1 } as Emitted,
        { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 } as Emitted,
        { opcode: OP.subtract, pop: 2, push: 1 } as Emitted,
      ]
    : [
        // Correct debuff: 0 - level / 200.
        { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 } as Emitted,
        getlocal(74),
        pushShort(200),
        { opcode: OP.divide, pop: 2, push: 1 } as Emitted,
        { opcode: OP.subtract, pop: 2, push: 1 } as Emitted,
      ];
  const program: Emitted[] = [
    // if (_loc52_.buffName != "PetArmorBane") skip the injection
    getlocal(52),
    get(MN.buffName),
    pushStr(petArmorBaneStr),
    { opcode: OP.ifne, branchTo: "skip", pop: 2 },
    // level = 0
    { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 },
    setlocal(74),
    // summoner = this.var_1.GetEntFromID(this.var_3.summonerId)
    getlocal(0),
    get(MN.var_1),
    getlocal(0),
    get(MN.var_3),
    get(MN.summonerId),
    callProp(MN.GetEntFromID, 1),
    { opcode: OP.dup, pop: 1, push: 2 },
    { opcode: OP.iffalse, branchTo: "skipSummoner", pop: 1 },
    // level = summoner.mEquipPet.var_23
    get(MN.mEquipPet),
    { opcode: OP.dup, pop: 1, push: 2 },
    { opcode: OP.iffalse, branchTo: "skipPet", pop: 1 },
    get(MN.var_23),
    setlocal(74),
    { opcode: OP.jump, branchTo: "levelDone" },
    { label: "skipSummoner" },
    { opcode: OP.pop, pop: 1 },
    { opcode: OP.jump, branchTo: "levelDone" },
    { label: "skipPet" },
    { opcode: OP.pop, pop: 1 },
    { label: "levelDone" },
    // _eaMods = new Vector.<class_140>()
    getLex(MN.Vector),
    getLex(MN.class_140),
    { opcode: OP.newarray, operands: [["u30", 1]], pop: 1, push: 1 },
    { opcode: OP.construct, operands: [["u30", 0]], pop: 2, push: 1 },
    { opcode: OP.coerce, operands: [["u30", MN.coerceModList]], pop: 1, push: 1 },
    setlocal(75),
    // _eaValue = new Vector.<Number>()
    getLex(MN.Vector),
    getLex(MN.Number),
    { opcode: OP.newarray, operands: [["u30", 1]], pop: 1, push: 1 },
    { opcode: OP.construct, operands: [["u30", 0]], pop: 2, push: 1 },
    { opcode: OP.coerce, operands: [["u30", MN.coerceValueList]], pop: 1, push: 1 },
    setlocal(77),
    // _eaValue.push(0 - level / 200)  (one value per BuffProperty: MeleeDefense, MagicDefense)
    getlocal(77),
    ...defenseReduction,
    callVoid(MN.push, 1),
    getlocal(77),
    ...defenseReduction,
    callVoid(MN.push, 1),
    // _eaMods.push(new class_140(1100, _eaValue))
    getlocal(75),
    { opcode: OP.findpropstrict, operands: [["u30", MN.class_140]], push: 1 },
    pushShort(1100),
    getlocal(77),
    {
      opcode: OP.constructprop,
      operands: [
        ["u30", MN.class_140],
        ["u30", 2],
      ],
      pop: 3,
      push: 1,
    },
    callVoid(MN.push, 1),
    // _loc16_ = _eaMods
    getlocal(75),
    { opcode: OP.coerce, operands: [["u30", MN.coerceAssign]], pop: 1, push: 1 },
    setlocal(16),
    { label: "skip" },
  ];
  return assemble(program);
}

/**
 * The appended Entity.method_1770 check: runs when the gate's `ifne` finds an
 * entity that is not "Decoy". Re-fetches entName and lets the explosion block
 * run when it starts with "PetDjinn"; otherwise behaves exactly like the old
 * not-equal path (jump straight to the "expiry handled" code at 1942).
 */
function djinnAppendBlock(nonDjinnSkipOffset: number = 4): Buffer {
  // Appended at codeLen (2150). Offsets below are fixed: the append is inserted
  // at the method end and nothing else shifts (the gate patch is same-size).
  //   2150: getlocal0; 2151: getproperty entType; 2153: getproperty entName;
  //   2156: pushstring "PetDjinn"; 2159: callproperty indexOf,1; 2162: pushbyte 0
  //   2164: ifne +4 -> 2172 (not a Djinn: jump to expiry-handled)
  //   2168: jump -> 1748 (explosion block)
  //   2172: jump -> 1942 (expiry handled)
  const block = Buffer.concat([
    Buffer.from([0xd0]), // getlocal0
    Buffer.from([0x66, 0x24]), // getproperty entType (36)
    Buffer.from([0x66, 0xfd, 0x01]), // getproperty entName (253)
    Buffer.from([0x2c, ...writeU30(STR.petDjinn)]), // pushstring "PetDjinn"
    Buffer.from([0x46, ...writeU30(MN.indexOf), 0x01]), // callproperty indexOf, 1
    Buffer.from([0x24, 0x00]), // pushbyte 0
    Buffer.from([0x14]), // ifne -> skip (entName does not start with PetDjinn)
    writeS24(nonDjinnSkipOffset),
    Buffer.from([0x10]), // jump -> explosion block (1748)
    writeS24(1748 - 2172),
    Buffer.from([0x10]), // jump -> expiry handled (1942)
    writeS24(1942 - 2176),
  ]);
  if (block.length !== 26) {
    throw new PatchError(`djinn append block is ${block.length} bytes, expected 26`);
  }
  return block;
}

function patchSwf(swfPath: string, verify: boolean): void {
  const ctx = parseSwf(swfPath);
  const abc = parseAbc(ctx);
  const pool = parsePool(ctx);
  const { indexOf, patches } = appendStrings(pool, ["PetArmorBane"]);
  const petArmorBaneStr = indexOf.get("PetArmorBane");
  if (petArmorBaneStr === undefined) {
    throw new PatchError("Could not resolve PetArmorBane string index.");
  }

  const getMethod = (cls: string, method: string, site: string) => {
    const ci = classIndexByName(abc, cls);
    if (ci === undefined || ci === null) {
      throw new PatchError(`${site}: class ${cls} not found.`);
    }
    const mi = methodIdxForTrait(abc.instances[ci].traits, abc, method);
    if (mi === undefined || mi === null) {
      throw new PatchError(`${site}: ${cls}.${method} not found.`);
    }
    const body = abc.methodBodies.get(mi);
    if (!body) {
      throw new PatchError(`${site}: method body ${mi} not found.`);
    }
    return { mi, body };
  };

  // ---- Entity.method_1770 (m804): Djinn expiry explosion -------------------
  {
    const { body } = getMethod("Entity", "method_1770", "Djinn gate");
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (body.exceptionCount !== 0) {
      throw new PatchError("Entity.method_1770 has exception handlers; their ranges would need shifting.");
    }

    const append = djinnAppendBlock();
    const buggyAppend = djinnAppendBlock(0);
    // After a successful apply the stored codeLen already includes the append, so
    // the checks are position-relative (the gate patch is same-size, so the append
    // always starts at 2150 in the method body).
    const patched =
      code.length >= 2150 + append.length &&
      code.subarray(1744, 1748).equals(Buffer.from([0x14, 0x92, 0x01, 0x00])) &&
      code.subarray(2150, 2150 + append.length).equals(append);
    const hasBuggyDjinnGate =
      code.length >= 2150 + buggyAppend.length &&
      code.subarray(1744, 1748).equals(Buffer.from([0x14, 0x92, 0x01, 0x00])) &&
      code.subarray(2150, 2150 + buggyAppend.length).equals(buggyAppend);

    if (patched) {
      console.log(`${swfPath}: Entity.method_1770 Djinn gate already patched.`);
    } else if (hasBuggyDjinnGate && !verify) {
      patches.push({
        key: "Entity.method_1770.fixDjinnGate",
        start: body.codeStart + 2150,
        end: body.codeStart + 2150 + append.length,
        data: append,
        detail: "prevent non-Djinn summons from entering the Decoy explosion block",
      });
      console.log(`${swfPath}: corrected Entity.method_1770 Djinn gate.`);
    } else if (verify) {
      throw new PatchError(`${swfPath}: verify failed; Entity.method_1770 Djinn gate is missing.`);
    } else {
      // Sanity-check the exact gate site before touching it:
      // 1735: getlocal0; 1736: getproperty entType; 1738: getproperty entName;
      // 1741: pushstring "Decoy"; 1744: ifne <s24 -> 1942>
      const gate = code.subarray(1735, 1748);
      if (
        !gate
          .subarray(0, 9)
          .equals(Buffer.from([0xd0, 0x66, 0x24, 0x66, 0xfd, 0x01, 0x2c, ...writeU30(STR.decoy)]))
      ) {
        throw new PatchError(`Unexpected bytes at Entity.method_1770 +1735: ${gate.toString("hex")}`);
      }
      const gateS24 = code.subarray(1745, 1748);
      const oldTarget = 1748 + gateS24.readIntLE(0, 3);
      if (oldTarget !== 1942) {
        throw new PatchError(`Entity.method_1770 gate ifne targets ${oldTarget}, expected 1942.`);
      }

      patches.push(
        // Re-point the ifne from 1942 to the appended PetDjinn check at codeLen.
        { key: "Entity.method_1770.gate", start: body.codeStart + 1744, end: body.codeStart + 1748, data: Buffer.from([0x14, 0x92, 0x01, 0x00]), detail: "widen Decoy gate to PetDjinn entities" },
        { key: "Entity.method_1770.append", start: body.codeStart + body.codeLen, end: body.codeStart + body.codeLen, data: append, detail: `append PetDjinn gate check (${append.length} bytes)` },
        { key: "Entity.method_1770.codeLen", start: body.codeLenPos, end: body.codeStart, data: writeU30(body.codeLen + append.length), detail: `update Entity.method_1770 code length (${body.codeLen} -> ${body.codeLen + append.length})` },
      );
      console.log(`${swfPath}: patched Entity.method_1770 Djinn gate (+${append.length} bytes).`);
    }
  }

  // ---- CombatState.method_1192 (m3476): PetArmorBane level-scaled mod ------
  {
    const { body } = getMethod("CombatState", "method_1192", "Pet armor mod");
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (body.exceptionCount !== 0) {
      throw new PatchError("CombatState.method_1192 has exception handlers; their ranges would need shifting.");
    }

    const block = petArmorModBlock(petArmorBaneStr);
    const legacyPositiveBlock = petArmorModBlock(petArmorBaneStr, true);

    // The insertion point used to be the literal offset 3963. It is found by its anchor bytes
    // now, because another patch (patch-dungeonblitz-paladin-passive-attack) inserts earlier
    // in this same method and shifts every offset after it: a hardcoded 3963 turned into
    // "verify failed; PetArmorBane mod is missing" for a block that was sitting there intact,
    // 78 bytes further along. The anchor is the five bytes ending at the insertion point --
    // `setlocal 16` (the mods list) and the start of the LeoneanAura guard -- and it has to be
    // unique in the method, so a client change that duplicates it fails loudly.
    const ANCHOR = Buffer.from([0x80, 0xcc, 0x6e, 0x63, 0x10]);
    const anchorAt = code.indexOf(ANCHOR);
    if (anchorAt < 0 || code.indexOf(ANCHOR, anchorAt + 1) >= 0) {
      throw new PatchError(
        anchorAt < 0
          ? "CombatState.method_1192: the PetArmorBane insertion anchor was not found."
          : "CombatState.method_1192: the PetArmorBane insertion anchor is not unique.",
      );
    }
    const insertAt = anchorAt + ANCHOR.length;

    const patched = code.length >= insertAt + block.length && code.subarray(insertAt, insertAt + block.length).equals(block);
    const hasLegacyPositiveSign =
      code.length >= insertAt + legacyPositiveBlock.length &&
      code.subarray(insertAt, insertAt + legacyPositiveBlock.length).equals(legacyPositiveBlock);

    if (patched) {
      console.log(`${swfPath}: CombatState.method_1192 PetArmorBane mod already patched.`);
    } else if (hasLegacyPositiveSign && !verify) {
      patches.push({
        key: "CombatState.method_1192.fixPetArmorSign",
        start: body.codeStart + insertAt,
        end: body.codeStart + insertAt + legacyPositiveBlock.length,
        data: block,
        detail: "correct PetArmorBane from +level/200 defense to -level/200 defense",
      });
      console.log(`${swfPath}: corrected CombatState.method_1192 PetArmorBane sign.`);
    } else if (verify) {
      throw new PatchError(`${swfPath}: verify failed; CombatState.method_1192 PetArmorBane mod is missing.`);
    } else {
      // The insertion point sits between the `setlocal 16` that closes the mods list and the
      // LeoneanAura guard. The `caster.var_18 == null` branch just above it (pets) targets the
      // insertion point and must land on the first byte of the block; every other branch is
      // shifted by the generic rule.
      const instructions = disassemble(code, "m3476");
      const patchedCode = spliceInsertStay(code, instructions, insertAt, block, new Set([insertAt]));

      patches.push(
        // The whole body is replaced (not just the insertion point) so the
        // re-targeted branches written by spliceInsertStay are part of the patch.
        { key: "CombatState.method_1192.code", start: body.codeStart, end: body.codeStart + body.codeLen, data: patchedCode, detail: `inject level-scaled PetArmorBane mod (${block.length} bytes)` },
        { key: "CombatState.method_1192.codeLen", start: body.codeLenPos, end: body.codeStart, data: writeU30(patchedCode.length), detail: `update CombatState.method_1192 code length (${body.codeLen} -> ${patchedCode.length})` },
      );
      console.log(`${swfPath}: patched CombatState.method_1192 PetArmorBane mod (+${block.length} bytes).`);
    }
  }

  if (patches.length === 0) {
    return;
  }
  if (verify) {
    throw new PatchError(`${swfPath}: verify failed; SWF patches are missing.`);
  }
  ensureBackup(swfPath);
  const { body, delta } = applyPatchesToBody(ctx.body, patches);
  writeSwf(ctx, body, delta);
  syncClientRev(swfPath);
}

function syncClientRev(swfPath: string): void {
  if (path.resolve(swfPath) !== DEFAULT_SWF || !fs.existsSync(INDEX_HTML)) {
    return;
  }
  const digest = crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
  const html = fs.readFileSync(INDEX_HTML, "utf8");
  const updated = html.replace(/clientrev=[^&`"'$]+/, `clientrev=swf-${digest}`);
  if (updated !== html) {
    fs.writeFileSync(INDEX_HTML, updated);
    console.log(`  index.html clientrev -> swf-${digest} (cache buster)`);
  }
}

// ---- XML + swz -------------------------------------------------------------

function patchXmlFile(fileName: string, patcher: (xml: string) => string, verify: boolean): boolean {
  const filePath = path.join(XML_DIR, fileName);
  const original = fs.readFileSync(filePath, "utf8");
  const patched = patcher(original);
  if (patched === original) {
    // No change produced: the file already carries the pet armor changes.
    return false;
  }
  if (verify) {
    throw new PatchError(`${filePath}: verify failed; ${fileName} is missing the pet armor changes.`);
  }
  fs.writeFileSync(filePath, patched, "utf8");
  console.log(`  ${fileName}: updated`);
  return true;
}

function patchSwzXml(verify: boolean): void {
  const swzPath = path.join(CBQ_DIR, "Game.swz");
  const ctx = parseSwz(swzPath);
  const patchers: Array<{ marker: string; patcher: (xml: string) => string }> = [
    { marker: "<PlayerBuffTypes", patcher: patchBuffsXml },
    { marker: "<PlayerPowerTypes", patcher: patchPowersXml },
    { marker: "<PowerModTypes", patcher: patchModsXml },
  ];
  let changed = false;
  for (const entry of patchers) {
    const chunk = ctx.chunks.find((c) => c.xml.includes(entry.marker));
    if (!chunk) {
      throw new PatchError(`Game.swz chunk ${entry.marker} not found.`);
    }
    const patched = entry.patcher(chunk.xml);
    if (patched !== chunk.xml) {
      changed = true;
      if (!verify) {
        chunk.xml = patched;
      }
    }
  }
  if (verify && changed) {
    throw new PatchError(`${swzPath}: verify failed; Game.swz is missing the pet armor changes.`);
  }
  if (!verify && changed) {
    ensureBackup(swzPath);
    writeSwz(ctx);
    console.log(`  Game.swz: updated`);
  }
}

// ---- main ------------------------------------------------------------------

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
  let swfPath = DEFAULT_SWF;
  let verify = false;
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--swf" || arg === "-s") {
      swfPath = path.resolve(argv[++index] || "");
      continue;
    }
    if (arg === "--verify" || arg === "--dry-run") {
      verify = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      console.log([
        "Usage:",
        "  npm exec tsx src/server/scripts/patch-dungeonblitz-pet-armor-djinn-explode.ts [--verify] [--swf <path>]",
        "",
        "Falcon/Pixie pets gain level-scaled armor reduction (petLevel/2 %) and Djinn",
        "pets explode for AoE damage when their duration expires (issue #721).",
      ].join("\n"));
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return { swfPath, verify };
}

function main(): number {
  const { swfPath, verify } = parseArgs(process.argv);
  try {
    let touched = 0;
    touched += patchXmlFile("PlayerBuffTypes.xml", patchBuffsXml, verify) ? 1 : 0;
    touched += patchXmlFile("PlayerPowerTypes.xml", patchPowersXml, verify) ? 1 : 0;
    touched += patchXmlFile("PowerModTypes.xml", patchModsXml, verify) ? 1 : 0;
    patchSwzXml(verify);
    patchSwf(swfPath, verify);
    console.log(
      verify
        ? touched === 0
          ? "All pet armor/Djinn changes present."
          : "Patch required."
        : "Patch apply complete.",
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[patch-dungeonblitz-pet-armor-djinn-explode] ${message}`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main());
}
