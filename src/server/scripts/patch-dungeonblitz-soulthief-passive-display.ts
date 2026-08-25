#!/usr/bin/env node

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
    writeSwf,
    writeU30,
} from "./swfPatchUtils";

/**
 * Show the Soulthief passive in the damage floaters.
 *
 * The passive -- "every successful attack also strikes for 1% of the target's maximum
 * Health" -- is applied server-side in CombatHandler.getSoulthieftMaxHpBonus, because the
 * target's health pool is not a term the client's damage formula has. The server pushes the
 * extra health loss to the attacker as a negative 0x78 correction, so the health bar is
 * right, but the floating number the client draws is the one it computed locally, before the
 * server ever saw the hit. The passive read as doing nothing.
 *
 * This patch shows the bonus where the player looks. It is display only: the client's HP
 * arithmetic is untouched, the packet it reports is untouched, and the real damage still
 * comes from the server. An unpatched cached client simply keeps today's behavior.
 *
 * WHERE THE FLOATER ACTUALLY IS
 *
 * Not class_91.method_175, which is where patch-dungeonblitz-sentinel-passive-display.ts
 * puts the Sentinel bonus. That method forwards to class_142.method_175, and class_142 is
 * the *combat log and damage meter* -- it is the class that prints "Player received N damage
 * from X with Y" and accumulates the per-session damage counters. Verified by decompiling
 * both classes.
 *
 * The floating combat text is Game.method_527(amount, x, y, ...), and its only three callers
 * in the whole SWF are inside Entity.TakeDamage. `this` there is the victim, so this.maxHP is
 * the target pool the passive needs, and param3 is the attacker.
 *
 * THE THREE GATES, and why each one is the same boundary the server uses
 *
 *   - param1 > 0. The server only pays the bonus on damage (`damage <= 0` returns 0), and
 *     TakeDamage is also the heal path (a negative amount).
 *   - param4 != null. TakeDamage carries a PowerType for a direct hit and null for the
 *     damage-over-time ticks that Buff.method_1095 drives. The server adds the bonus in
 *     handlePowerHit only; the buff-tick handler does not, so a poison tick must not show it.
 *   - param3 === this.var_1.clientEnt (Entity.var_1 is Game; Game.clientEnt is the local
 *     player). Without it a party member watching a Soulthief would add the bonus on top of
 *     the relayed hit, which already carries the server's rewritten number -- the floater
 *     would read double on every screen but the attacker's.
 *
 * The rate mirrors CombatHandler.SOULTHIEFT_MAX_HP_RATE as an integer ratio so the block only
 * needs a pushshort. Keep them in lockstep or the floater and the health bar disagree.
 *
 * Mechanics: one self-contained block of raw AVM2 bytecode is inserted at each of the three
 * call sites, with no FFDec recompile -- recompiling Entity would drift the fixed offsets the
 * other byte-splice patches in this repo verify against. Each insertion point is the boundary
 * where the operand stack holds exactly [Game, amount]: the first `getlocal_0; getproperty
 * gfx` after the receiver push, which is the start of the x-coordinate argument. The block
 * turns that into [Game, amount + bonus] and touches nothing else.
 *
 * Two of the three anchors are also branch targets from the first site (the obfuscator
 * flattens the shared tail), which is safe: those branches join at the same stack shape, and
 * they leave from before the first anchor, so no path can run two blocks for one hit.
 *
 * Run with --verify to check that all three blocks and the pool strings are present, without
 * writing anything.
 */

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
const INDEX_HTML = path.resolve(__dirname, "..", "..", "client", "content", "localhost", "index.html");

// Must agree with CombatHandler.SOULTHIEFT_CURRENT_HP_RATE (0.01). Expressed as an integer
// divisor so the block only needs a pushshort. If the rate moves server-side and this does not,
// the floater promises a number the health bar will not deliver -- which is the whole failure
// this patch exists to end.
const CURRENT_HP_RATE_DEN = 100;

// A superseded release capped the bonus at a quarter of the hit. The cap is gone -- it took
// the passive away on exactly the high-health targets it exists for -- but the shape is kept
// here so a re-run recognises and replaces those bytes instead of stacking a block in front of
// them. See supersededBlocks.
const LEGACY_HIT_SHARE_CAP_DEN = 4;

/**
 * Argument counts that tell the client's own floater calls apart from this patch's.
 *
 * Entity.TakeDamage always passes all nine; the bonus floater passes the seven required ones
 * and leaves params eight and nine at their defaults. Without this distinction, re-running on
 * an already-patched SWF finds six call sites instead of three -- the block's own call looks
 * exactly like a real one.
 */
const CLIENT_FLOATER_ARG_COUNT = 9;
const BONUS_FLOATER_ARG_COUNT = 7;

/**
 * LOWERCASE, and that is not a style choice.
 *
 * Entity.mMasterClass is assigned in LinkUpdater.method_1172 as `Game.method_233(id)`, which
 * returns `Game.const_21[id]` -- and const_21 is built in Game's cinit as
 * `const_85[const_21[i] = "necromancer"] = "Necromancer"`, i.e. const_21 holds the lowercase
 * internal names and const_85 maps them to the capitalized display labels. The client's own
 * two comparisons agree: `mMasterClass == "frostwarden"`, twice, in LinkUpdater.
 *
 * A capitalized literal here compiles and inserts perfectly and then never matches, so the
 * passive silently does nothing -- which is exactly the state
 * patch-dungeonblitz-sentinel-passive-display.ts is still in, comparing against "Sentinel".
 *
 * The rogue disciplines are renamed for display in this build (executioner -> "Viperblade",
 * shadowwalker -> "Shadowstalker"); the internal keys are untouched, so "soulthief" is right.
 */
const MASTER_CLASS_NAME = "soulthief";

/** Headroom for the block's own operand stack use, added to the method's max_stack. */
const STACK_HEADROOM = 6;

/**
 * Entity.TakeDamage's max_stack in an unpatched client. Verified against the served SWF; the
 * patch asserts it before touching a file it has not written to, so a rebuilt client fails
 * loudly here rather than shipping a method whose declared stack is too small.
 */
const CLEAN_MAX_STACK = 12;

const OP = {
    jump: 0x10,
    iffalse: 0x12,
    ifne: 0x14,
    ifle: 0x16,
    pushshort: 0x25,
    pushstring: 0x2c,
    callproperty: 0x46,
    getlex: 0x60,
    getlocal: 0x62,
    getproperty: 0x66,
    add: 0xa0,
    subtract: 0xa1,
    divide: 0xa3,
    pushfalse: 0x27,
    callpropvoid: 0x4f,
} as const;

type Emitted = { label: string } | { opcode: number; operands?: Array<[string, number]>; branchTo?: string; pop?: number; push?: number };

const getlocal = (index: number): Emitted =>
    index <= 3 ? { opcode: 0xd0 + index, push: 1 } : { opcode: OP.getlocal, operands: [["u30", index]], push: 1 };
const get = (mn: number): Emitted => ({ opcode: OP.getproperty, operands: [["u30", mn]], pop: 1, push: 1 });
const getLex = (mn: number): Emitted => ({ opcode: OP.getlex, operands: [["u30", mn]], push: 1 });
const pushStr = (idx: number): Emitted => ({ opcode: OP.pushstring, operands: [["u30", idx]], push: 1 });
const pushShort = (value: number): Emitted => ({ opcode: OP.pushshort, operands: [["u30", value]], push: 1 });
const pushByte = (value: number): Emitted => ({ opcode: 0x24, operands: [["s8", value]], push: 1 });
const pushFalse = (): Emitted => ({ opcode: OP.pushfalse, push: 1 });
const callPropVoid = (mn: number, args: number): Emitted => ({
    opcode: OP.callpropvoid,
    operands: [
        ["u30", mn],
        ["u30", args],
    ],
    pop: args + 1,
});
const callProp = (mn: number, args: number): Emitted => ({
    opcode: OP.callproperty,
    operands: [
        ["u30", mn],
        ["u30", args],
    ],
    pop: args + 1,
    push: 1,
});

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

function operandBytes(kind: string, value: number): Buffer {
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

/**
 * Emit the program with label fixups, the same assembler the Sentinel display patch uses,
 * except that this block runs mid-expression: it enters with the pending `amount` already on
 * the stack and must leave exactly one value there. `entryDepth` models that.
 *
 * Returns the code and the peak depth, so the caller can raise the method's max_stack.
 */
function assemble(program: Emitted[], entryDepth: number, exitDepth: number): { code: Buffer; maxDepth: number } {
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
    let depth = entryDepth;
    let maxDepth = entryDepth;
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
    if (reachable && depth !== exitDepth) {
        throw new PatchError(`Emitted block leaves depth ${depth}, expected ${exitDepth}`);
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

    const code = Buffer.concat(chunks);
    for (const fixup of fixups) {
        const target = labels.get(fixup.target);
        if (target === undefined) {
            throw new PatchError(`Unknown branch label ${fixup.target}`);
        }
        writeS24(target - (fixup.pos + 3)).copy(code, fixup.pos);
    }
    return { code, maxDepth };
}

// ---- string pool helpers (same shape as the Sentinel display patch) ---------

interface PoolInfo {
    strings: string[];
    stringCountPos: number;
    stringCountEnd: number;
    stringPoolEnd: number;
}

function parsePool(ctx: ReturnType<typeof parseSwf>): PoolInfo {
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
    return { strings, stringCountPos, stringCountEnd, stringPoolEnd: pos };
}

// ---- the bonus block --------------------------------------------------------

interface Mn {
    min: number;
    currHP: number;
    var_1: number;
    clientEnt: number;
    mMasterClass: number;
    maxHP: number;
    gfx: number;
    method_527: number;
    Math: number;
    round: number;
}

function resolveMultinames(abc: ReturnType<typeof parseAbc>): Mn {
    const out: Mn = {
        min: -1,
        currHP: -1,
        var_1: -1,
        clientEnt: -1,
        mMasterClass: -1,
        maxHP: -1,
        gfx: -1,
        method_527: -1,
        Math: -1,
        round: -1,
    };
    for (const key of Object.keys(out) as Array<keyof Mn>) {
        const idx = abc.multinameNames.indexOf(key);
        if (idx < 0) {
            throw new PatchError(`Multiname ${key} not found in the ABC pool.`);
        }
        out[key] = idx;
    }
    return out;
}

/**
 * What the block reads and whether it clamps. Both axes have changed across releases, so a
 * re-run has to be able to rebuild any shape this patch has ever shipped -- see
 * supersededBlocks. Only `CURRENT_SHAPE` is ever written.
 */
interface BlockShape {
    /** The health slot the bonus is derived from. */
    source: "currHP" | "maxHP";
    /** Clamp the bonus to a quarter of the hit. */
    capped: boolean;
    /**
     * "merge" folds the bonus into the hit's own floating number, so the player sees one
     * total and can no longer read their own weapon damage. "separate" leaves the hit's
     * number alone and draws the bonus as a second floater beside it.
     */
    mode: "merge" | "separate";
}

const CURRENT_SHAPE: BlockShape = { source: "currHP", capped: false, mode: "separate" };

/** Where the bonus floater sits relative to the hit's own, in pixels. */
const BONUS_FLOATER_X_OFFSET = 46;
const BONUS_FLOATER_Y_OFFSET = 26;

/** Every shape this patch has written, newest first. Add to this list, never edit it in place. */
const SHIPPED_SHAPES: BlockShape[] = [
    { source: "currHP", capped: false, mode: "separate" },
    { source: "currHP", capped: false, mode: "merge" },
    { source: "maxHP", capped: false, mode: "merge" },
    { source: "maxHP", capped: true, mode: "merge" },
];

/**
 * Stack in:  [.., Game, amount]
 * Stack out: [.., Game, amount]   (mode "separate")
 *            [.., Game, amount + bonus]   (mode "merge", superseded)
 *
 * bonus is Math.round((this.currHP + param1) / 100) when the local player is the Soulthief who
 * landed a damaging direct power hit, and nothing happens otherwise.
 *
 * In "separate" mode the block leaves the pending argument untouched and instead makes its own
 * complete Game.method_527 call for the bonus, offset so the two numbers do not overlap. That
 * is the whole point: merging them meant the player could not read their own weapon damage at
 * all, only a total. The bonus floater borrows the hit's own colour local so it looks native.
 *
 * The extra call is stack-neutral -- receiver plus seven arguments, then callpropvoid -- so it
 * can sit in the middle of the argument expression it is inserted into. Params 8 and 9 are
 * optional and left at their defaults; param 9 is a grouping id, and passing the hit's would
 * risk the two floaters being pooled together.
 */
function buildFloaterBlock(
    mn: Mn,
    soulthiefStr: number,
    args: FloaterArgs,
    shape: BlockShape = CURRENT_SHAPE,
): { code: Buffer; maxDepth: number } {
    // this.currHP is the target's health *after* this hit: Entity.TakeDamage applies the blow
    // at +3054 (`this.currHP = this.currHP - param1`, its only write to that slot, and
    // unclamped) long before it reaches these floater calls. Reading currHP as-is would give
    // the post-hit health while the server reads the pre-hit health, so the two would disagree
    // on every single hit; adding param1 back recovers the exact value the server used. maxHP
    // needed no such correction, which is why this only appeared when the passive moved.
    const health: Emitted[] = shape.source === "currHP"
        ? [getlocal(0), get(mn.currHP), getlocal(1), { opcode: OP.add, pop: 2, push: 1 }]
        : [getlocal(0), get(mn.maxHP)];

    const bonus: Emitted[] = [
        ...(shape.capped ? [getLex(mn.Math)] : []),
        getLex(mn.Math),
        ...health,
        pushShort(CURRENT_HP_RATE_DEN),
        { opcode: OP.divide, pop: 2, push: 1 },
        callProp(mn.round, 1),
        ...(shape.capped
            ? [
                  getLex(mn.Math),
                  getlocal(1),
                  pushByte(LEGACY_HIT_SHARE_CAP_DEN),
                  { opcode: OP.divide, pop: 2, push: 1 } as Emitted,
                  callProp(mn.round, 1),
                  callProp(mn.min, 2),
              ]
            : []),
    ];

    // The hit's own position expressions, rebuilt from the operands lifted off the call site:
    //   x = this.gfx.m_TheDO.x + this.var_596
    //   y = this.gfx.m_TheDO.y - this.entType.height + this.var_351
    const [gfxA, doA, xProp, var596, gfxB, doB, yProp, entType, height, var351] = args.props;
    const position: Emitted[] = [
        getlocal(0), get(gfxA), get(doA), get(xProp),
        getlocal(0), get(var596),
        { opcode: OP.add, pop: 2, push: 1 },
        pushByte(BONUS_FLOATER_X_OFFSET),
        { opcode: OP.add, pop: 2, push: 1 },
        getlocal(0), get(gfxB), get(doB), get(yProp),
        getlocal(0), get(entType), get(height),
        { opcode: OP.subtract, pop: 2, push: 1 },
        getlocal(0), get(var351),
        { opcode: OP.add, pop: 2, push: 1 },
        pushByte(BONUS_FLOATER_Y_OFFSET),
        { opcode: OP.subtract, pop: 2, push: 1 },
    ];

    const payload: Emitted[] = shape.mode === "merge"
        ? [...bonus, { opcode: OP.add, pop: 2, push: 1 }]
        : [
              getlocal(0),
              get(mn.var_1),
              ...bonus,
              ...position,
              getlocal(args.colourLocal),
              pushFalse(),
              pushFalse(),
              pushFalse(),
              callPropVoid(mn.method_527, BONUS_FLOATER_ARG_COUNT),
          ];

    const program: Emitted[] = [
        // param1 (the amount) must be positive damage, not a heal.
        getlocal(1),
        pushByte(0),
        { opcode: OP.ifle, branchTo: "skip", pop: 2 },
        // param4 (PowerType) is null on the buff-tick path, which the server does not pay.
        getlocal(4),
        { opcode: OP.iffalse, branchTo: "skip", pop: 1 },
        // param3 (the attacker) must exist and must be this client's own player.
        getlocal(3),
        { opcode: OP.iffalse, branchTo: "skip", pop: 1 },
        getlocal(0),
        get(mn.var_1),
        get(mn.clientEnt),
        getlocal(3),
        { opcode: OP.ifne, branchTo: "skip", pop: 2 },
        getlocal(3),
        get(mn.mMasterClass),
        pushStr(soulthiefStr),
        { opcode: OP.ifne, branchTo: "skip", pop: 2 },
        ...payload,
        { label: "skip" },
    ];
    return assemble(program, 1, 1);
}

/**
 * Blocks a previously shipped release may have left in the SWF, so a re-run overwrites them
 * instead of stacking a second block in front of the same anchor -- which would pay the bonus
 * twice. Two axes have moved: what the bonus reads (max HP, then current HP), whether it is
 * clamped, and the discipline-name spelling (the first release compared against a capitalized
 * "Soulthief", which the client never assigns and so never matched).
 */
function supersededBlocks(
    abc: ReturnType<typeof parseAbc>,
    mn: Mn,
    args: FloaterArgs,
): Array<{ code: Buffer; maxDepth: number }> {
    const out: Array<{ code: Buffer; maxDepth: number }> = [];
    for (const name of [MASTER_CLASS_NAME, "Soulthief"]) {
        const idx = abc.stringValues.indexOf(name);
        if (idx <= 0) {
            continue;
        }
        for (const shape of SHIPPED_SHAPES) {
            const built = buildFloaterBlock(mn, idx, args, shape);
            if (!out.some((existing) => existing.code.equals(built.code))) {
                out.push(built);
            }
        }
    }
    return out;
}

// ---- SWF patching -----------------------------------------------------------

function methodBody(abc: ReturnType<typeof parseAbc>, className: string, methodName: string) {
    const ci = classIndexByName(abc, className);
    if (ci === null) {
        throw new PatchError(`Class ${className} not found.`);
    }
    const mi = methodIdxForTrait(abc.instances[ci].traits, abc, methodName);
    if (mi === null) {
        throw new PatchError(`${className}.${methodName} not found.`);
    }
    const body = abc.methodBodies.get(mi);
    if (!body) {
        throw new PatchError(`Method body for ${className}.${methodName} not found.`);
    }
    return body;
}

/**
 * Every floater call site's insertion point: the first `getlocal_0; getproperty gfx` after the
 * `getlocal_0; getproperty var_1` that pushed the Game receiver. At that byte the operand
 * stack holds exactly [Game, amount] and the x-coordinate argument is about to be built.
 */
/**
 * The x/y argument expressions each floater call builds, read out of the client's own
 * instruction stream rather than resolved by name.
 *
 * "x" and "y" are not names that can be looked up safely -- the pool has many -- and the exact
 * multiname a slot uses is the sort of thing a rebuilt client changes silently. Lifting the
 * operands from the real call site pins them to whatever that site uses, and asserting the
 * property order makes a changed client fail loudly here instead of drawing a floater at the
 * wrong coordinates.
 */
const FLOATER_POSITION_PROPS = [
    "gfx", "m_TheDO", "x", "var_596",
    "gfx", "m_TheDO", "y", "entType", "height", "var_351",
] as const;

interface FloaterArgs {
    /** getproperty operands, in FLOATER_POSITION_PROPS order. */
    props: number[];
    /** The local holding the colour argument the hit's own floater is drawn with. */
    colourLocal: number;
}

function resolveFloaterArgs(
    abc: ReturnType<typeof parseAbc>,
    instructions: Instruction[],
    mn: Mn,
    anchor: number,
    callIndex: number,
): FloaterArgs {
    const anchorIndex = instructions.findIndex((inst) => inst.offset === anchor);
    // method_527 takes nine arguments. The first three -- amount, x, y -- are expressions of
    // many instructions; params four through nine are always a single push each, so they are
    // exactly the last six instructions before the call. Scanning forwards for them instead
    // does not work: the obfuscator sprinkles `getlocal 40; dup; iffalse` opaque predicates
    // through the position expressions, and those look just like an argument push.
    const firstArgIndex = callIndex - 6;
    if (firstArgIndex <= anchorIndex || instructions[firstArgIndex].opcode !== OP.getlocal) {
        throw new PatchError(
            `The method_527 call at +${instructions[callIndex].offset} does not end with six single-push arguments.`,
        );
    }

    const props = instructions
        .slice(anchorIndex, firstArgIndex)
        .filter((inst) => inst.opcode === OP.getproperty)
        .map((inst) => inst.operands[0][1]);
    if (props.length !== FLOATER_POSITION_PROPS.length) {
        throw new PatchError(
            `Floater position expression at +${anchor} has ${props.length} properties, expected ${FLOATER_POSITION_PROPS.length}.`,
        );
    }
    props.forEach((idx, i) => {
        const actual = abc.multinameNames[idx];
        if (actual !== FLOATER_POSITION_PROPS[i]) {
            throw new PatchError(
                `Floater position expression at +${anchor}: property ${i} is "${actual}", expected "${FLOATER_POSITION_PROPS[i]}".`,
            );
        }
    });
    if (props[0] !== mn.gfx) {
        throw new PatchError(`Floater position expression at +${anchor} does not start at the gfx anchor.`);
    }

    return { props, colourLocal: instructions[firstArgIndex].operands[0][1] };
}

/**
 * Where the bonus block goes at each of the client's three floater calls: the byte at which the
 * operand stack holds exactly [Game, amount] and the x-coordinate argument is about to be
 * built.
 *
 * Found by counting backwards, not forwards, and that is deliberate. The obvious route -- scan
 * back to the `getlocal_0; getproperty var_1` that pushed the Game receiver, then forward to
 * the first `getlocal_0; getproperty gfx` -- works on a clean SWF and breaks on a patched one,
 * because the bonus block sits just before the anchor and pushes a Game receiver and a gfx
 * chain of its own. The scan would land inside the block it is supposed to be replacing.
 *
 * Counting back from the argument pushes has no such ambiguity. The last six instructions
 * before the call are params four through nine; before them sits the y expression, and before
 * that the x expression. Both open with `getlocal_0; getproperty gfx`, so the second such pair
 * encountered going backwards is the start of the x argument, whatever else is in the method.
 */
function findFloaterAnchors(instructions: Instruction[], mn: Mn): number[] {
    const anchors: number[] = [];
    for (let i = 0; i < instructions.length; i += 1) {
        const inst = instructions[i];
        if (
            inst.opcode !== OP.callpropvoid ||
            inst.operands[0]?.[1] !== mn.method_527 ||
            inst.operands[1]?.[1] !== CLIENT_FLOATER_ARG_COUNT
        ) {
            continue;
        }

        let seen = 0;
        let anchor = -1;
        for (let j = i - 6; j >= 1; j -= 1) {
            if (
                instructions[j - 1].opcode === 0xd0 &&
                instructions[j].opcode === OP.getproperty &&
                instructions[j].operands[0]?.[1] === mn.gfx
            ) {
                seen += 1;
                if (seen === 2) {
                    anchor = instructions[j - 1].offset;
                    break;
                }
            }
        }
        if (anchor < 0) {
            throw new PatchError(`No x-argument anchor found for the method_527 call at +${inst.offset}.`);
        }
        anchors.push(anchor);
    }
    if (anchors.length !== 3) {
        throw new PatchError(`Expected 3 Game.method_527 call sites in Entity.TakeDamage, found ${anchors.length}.`);
    }
    return anchors;
}

interface Edit {
    /** Byte where the block starts: the anchor, minus any superseded block being replaced. */
    at: number;
    /** Bytes of a superseded block to drop at `at`, or 0 for a fresh insert. */
    removeLen: number;
    insert: Buffer;
}

/**
 * Apply every edit and re-target the method's branches around them.
 *
 * An edit's net delta is `insert.length - removeLen`, so this covers a fresh insert
 * (removeLen 0), an in-place swap of equal size, and a retune that changes the block's length.
 *
 * Two rules carry the correctness:
 *   - A branch *target* shifts by the edits strictly before it, so a branch that used to land
 *     on the anchor lands on the block's first byte and the block runs on that path too. Two
 *     of the three anchors are exactly such targets.
 *   - A branch *instruction* shifts by the edits at or before it, so an instruction pushed
 *     back by its own block's insertion moves with it.
 *
 * Instructions inside a removed block are skipped: their bytes are gone, and their operands
 * describe an offset space that no longer exists.
 */
function spliceEdits(code: Buffer, instructions: Instruction[], edits: Edit[]): Buffer {
    const sorted = [...edits].sort((a, b) => a.at - b.at);
    for (let i = 1; i < sorted.length; i += 1) {
        if (sorted[i].at < sorted[i - 1].at + sorted[i - 1].removeLen) {
            throw new PatchError("Overlapping edits; the anchors are not what this patch assumes.");
        }
    }

    const deltaBefore = (offset: number, inclusive: boolean): number =>
        sorted
            .filter((edit) => (inclusive ? edit.at <= offset : edit.at < offset))
            .reduce((sum, edit) => sum + edit.insert.length - edit.removeLen, 0);
    // An instruction at the block's first byte belongs to the block and goes with it.
    const isRemovedInstruction = (offset: number): boolean =>
        sorted.some((edit) => offset >= edit.at && offset < edit.at + edit.removeLen);
    // A branch *target* at that same byte is the join point onto the block and stays valid --
    // it simply lands on the replacement. Only a target strictly inside the old block is lost.
    const isInsideRemoved = (offset: number): boolean =>
        sorted.some((edit) => offset > edit.at && offset < edit.at + edit.removeLen);

    const chunks: Buffer[] = [];
    let cursor = 0;
    for (const edit of sorted) {
        chunks.push(code.subarray(cursor, edit.at), edit.insert);
        cursor = edit.at + edit.removeLen;
    }
    chunks.push(code.subarray(cursor));
    const patched = Buffer.concat(chunks);

    for (const inst of instructions) {
        if (inst.opcode === 0x1b) {
            throw new PatchError("lookupswitch present; its case offsets would need re-targeting too.");
        }
        if (!isBranchOpcode(inst.opcode) || isRemovedInstruction(inst.offset)) {
            continue;
        }
        const operand = inst.operands.find(([kind]) => kind === "s24");
        if (!operand) {
            continue;
        }
        const oldTarget = inst.offset + inst.size + operand[1];
        if (isInsideRemoved(oldTarget)) {
            throw new PatchError(
                `A branch at +${inst.offset} targets +${oldTarget}, inside a block being replaced; ` +
                    "restore DungeonBlitz.swf from git and re-run so the block is inserted fresh.",
            );
        }
        const newTarget = oldTarget + deltaBefore(oldTarget, false);
        const newOffset = inst.offset + deltaBefore(inst.offset, true);
        writeS24(newTarget - (newOffset + inst.size)).copy(patched, newOffset + 1);
    }
    return patched;
}

function patchSwf(swfPath: string, verifyOnly: boolean): void {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);

    const pool = parsePool(ctx);
    // Deliberately NOT appendStrings. The discipline name has to be a constant the client
    // itself already uses, because the whole gate turns on string equality with a value the
    // client assigns. Appending a fresh literal would succeed, insert cleanly, and match
    // nothing -- a silent no-op is the one failure mode this patch cannot afford, so a
    // missing constant is a hard error instead.
    const patches: BytePatch[] = [];
    const soulthiefStr = pool.strings.indexOf(MASTER_CLASS_NAME);
    if (soulthiefStr <= 0) {
        throw new PatchError(
            `The string constant "${MASTER_CLASS_NAME}" is not in the ABC pool. Entity.mMasterClass ` +
                `holds Game.const_21[id], the lowercase internal discipline names; if that constant is ` +
                `gone the client has been rebuilt and this gate needs re-deriving, not appending.`,
        );
    }

    const mn = resolveMultinames(abc);

    const body = methodBody(abc, "Entity", "TakeDamage");
    if (body.exceptionCount !== 0) {
        throw new PatchError("Entity.TakeDamage has exception handlers; the inserts are not safe.");
    }
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const instructions = disassemble(code, "Entity.TakeDamage");
    const anchors = findFloaterAnchors(instructions, mn);

    // Every site builds its position arguments the same way, and the bonus floater borrows
    // them. Resolving per site and then insisting they agree keeps one block for all three --
    // if a future client makes them differ, that is a real change and it should stop here
    // rather than quietly draw one of the three floaters in the wrong place.
    const callIndexes = instructions
        .map((inst, index) => ({ inst, index }))
        .filter(({ inst }) =>
            inst.opcode === OP.callpropvoid &&
            inst.operands[0]?.[1] === mn.method_527 &&
            inst.operands[1]?.[1] === CLIENT_FLOATER_ARG_COUNT)
        .map(({ index }) => index);
    const perSiteArgs = anchors.map((anchor, i) => resolveFloaterArgs(abc, instructions, mn, anchor, callIndexes[i]));
    const args = perSiteArgs[0];
    if (!perSiteArgs.every((candidate) =>
        candidate.colourLocal === args.colourLocal &&
        candidate.props.every((prop, i) => prop === args.props[i]))) {
        throw new PatchError("The three floater call sites no longer build their arguments identically.");
    }

    const { code: block, maxDepth } = buildFloaterBlock(mn, soulthiefStr, args);

    // The block is inserted immediately *before* the anchor, and the anchor scan re-finds the
    // same x-argument start on an already-patched file, so look backwards from it.
    const carriesBlockOf = (candidate: Buffer, at: number): boolean =>
        at >= candidate.length && code.subarray(at - candidate.length, at).equals(candidate);
    const carriesBlock = (at: number): boolean => carriesBlockOf(block, at);

    // A shipped SWF may carry a superseded version of this block. The first release of this
    // patch compared mMasterClass against the capitalized "Soulthief", which the client never
    // assigns, so it inserted cleanly and matched nothing. Recognise those bytes and overwrite
    // them; without this the anchor scan would find the x-argument start *after* the dead block
    // and happily stack a second one on top of it.
    const legacyBlocks = supersededBlocks(abc, mn, args).filter((candidate) => !candidate.code.equals(block));
    const legacy = legacyBlocks.find((candidate) => anchors.every((at) => carriesBlockOf(candidate.code, at)));

    const alreadyPatched = anchors.every(carriesBlock);

    // max_stack is settled here rather than inside the insert branch, because "the bytes are
    // already right" is not the same as "the method declares enough stack for them". An earlier
    // release wrote a shallower block and bought less headroom; re-running with a deeper block
    // would have left the old, too-small value in place and the operand stack would overrun it.
    // AVM2 verifies max_stack, so that is not a wrong number on screen -- it is a VerifyError
    // and the class does not load at all.
    //
    // Writing an absolute value rather than adjusting the existing one makes every path -- fresh
    // insert, replace, re-run on an already-correct file -- land on the same number, so it can
    // neither creep upward nor be left behind.
    const [maxStack, maxStackEnd] = readU30(ctx.body, body.maxStackPos, "Entity.TakeDamage.max_stack");
    const neededStack = CLEAN_MAX_STACK + Math.max(STACK_HEADROOM, maxDepth);
    const isUnpatched = !legacy && !anchors.some(carriesBlock);
    if (isUnpatched && maxStack !== CLEAN_MAX_STACK) {
        throw new PatchError(
            `Entity.TakeDamage declares max_stack ${maxStack} on an unpatched SWF, expected ${CLEAN_MAX_STACK}. ` +
                "The client has been rebuilt; re-derive CLEAN_MAX_STACK before trusting this patch.",
        );
    }
    if (maxStack !== neededStack) {
        patches.push({
            key: "Entity.TakeDamage.max_stack",
            start: body.maxStackPos,
            end: maxStackEnd,
            data: writeU30(neededStack),
            detail: `set max_stack for the bonus block (${maxStack} -> ${neededStack})`,
        });
    }

    if (alreadyPatched && patches.length === 0) {
        console.log(`${swfPath}: Entity.TakeDamage already carries the Soulthief floater bonus at all 3 sites.`);
    } else if (alreadyPatched) {
        console.log(`${swfPath}: Entity.TakeDamage carries the Soulthief floater bonus; correcting max_stack.`);
    } else if (verifyOnly) {
        throw new PatchError(`${swfPath}: verify failed; the Soulthief floater bonus is missing or needs updating.`);
    } else {
        if (!legacy && anchors.some((at) => carriesBlock(at) || legacyBlocks.some((c) => carriesBlockOf(c.code, at)))) {
            throw new PatchError(
                "Entity.TakeDamage carries a Soulthief floater block at some but not all sites; " +
                    "restore DungeonBlitz.swf from git and re-run.",
            );
        }

        // Replacing and inserting are the same operation with different removal lengths, so
        // retuning a constant (which changes the block's length) is not a special case that
        // needs the SWF restored from git first. Getting this wrong is not subtle: the anchor
        // scan re-finds the x-argument start *after* an existing block, so a plain insert on an
        // already-patched file stacks a second block in front of the first and pays the bonus
        // twice.
        const patchedCode = spliceEdits(
            code,
            instructions,
            anchors.map((at) => ({
                at: at - (legacy?.code.length ?? 0),
                removeLen: legacy?.code.length ?? 0,
                insert: block,
            })),
        );

        patches.push({
            key: "Entity.TakeDamage.code",
            start: body.codeStart,
            end: body.codeStart + body.codeLen,
            data: patchedCode,
            detail: legacy
                ? `overwrite the superseded Soulthief floater bonus at 3 sites (${block.length} bytes each)`
                : `insert the Soulthief floater bonus at 3 sites (${block.length} bytes each)`,
        });
        if (patchedCode.length !== body.codeLen) {
            patches.push({
                key: "Entity.TakeDamage.codeLen",
                start: body.codeLenPos,
                end: body.codeStart,
                data: writeU30(patchedCode.length),
                detail: `update Entity.TakeDamage code length (${body.codeLen} -> ${patchedCode.length})`,
            });
        }
        console.log(
            `${swfPath}: ${legacy ? "overwrote the superseded" : "inserted the"} Soulthief floater bonus in ` +
                `Entity.TakeDamage at +${anchors.map((at) => at - block.length).join(", +")} ` +
                `(${block.length} bytes each, max_stack ${neededStack}).`,
        );
    }

    if (patches.length === 0) {
        return;
    }
    if (verifyOnly) {
        throw new PatchError(`${swfPath}: verify failed; SWF patches are missing.`);
    }
    ensureBackup(swfPath);
    const { body: patchedBody, delta } = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, patchedBody, delta);
    syncClientRev(swfPath);
}

// ---- index.html clientrev sync ---------------------------------------------

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

function clientRevIsCurrent(swfPath: string): boolean {
    if (path.resolve(swfPath) !== DEFAULT_SWF || !fs.existsSync(INDEX_HTML)) {
        return true;
    }
    const digest = crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
    return fs.readFileSync(INDEX_HTML, "utf8").includes(`clientrev=swf-${digest}`);
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
            console.log(
                [
                    "Usage:",
                    "  npx ts-node src/server/scripts/patch-dungeonblitz-soulthief-passive-display.ts [--verify] [--swf <path>]",
                    "",
                    "Shows the server-side Soulthief passive (1% of the target's maximum Health on",
                    "every successful attack) in the client's floating damage numbers.",
                ].join("\n"),
            );
            process.exit(0);
        }
        throw new PatchError(`Unknown argument: ${arg}`);
    }
    return { swfPath, verify };
}

function main(): number {
    const { swfPath, verify } = parseArgs(process.argv);
    try {
        patchSwf(swfPath, verify);
        if (verify && !clientRevIsCurrent(swfPath)) {
            throw new PatchError(
                "index.html clientrev does not match the SWF on disk, so players load a cached " +
                    "copy and none of the SWF patches take effect. Re-run this script without --verify.",
            );
        }
        console.log(verify ? "Soulthief passive display patch present." : "Soulthief passive display patch applied.");
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[patch-dungeonblitz-soulthief-passive-display] ${message}`);
        return 1;
    }
}

if (require.main === module) {
    process.exit(main());
}
