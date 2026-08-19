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
 * Show the Sentinel passive in the damage floaters (issue #726).
 *
 * The Sentinel passive ("your melee attacks also strike for 0.3% of your maximum
 * Health and 30% of your Defense") lives on the server: CombatHandler adds
 * getSentinelMaxHpBonus to every melee hit, because the server is the only side
 * that can tell a Sentinel from a Justicar or Templar by MasterClass. That works,
 * but the client draws its own floating damage numbers from the hits it computed
 * locally, before the server's bonus lands -- so equipping a Defense charm moved
 * the hit by 30% of the charm's Defense and the player could never see it. The
 * passive read as doing nothing at all.
 *
 * This patch shows the bonus where the player looks: the damage floaters. The
 * client's own numbers are display-only here -- the actual damage application
 * stays server-side, so there is no double counting and an older cached client
 * simply keeps today's behavior.
 *
 *   - The computation mirrors CombatHandler.SENTINEL_MAX_HP_RATE /
 *     SENTINEL_ARMOR_RATE (0.003 / 0.3) and the SENTINEL_MELEE_POWER_NAMES set,
 *     using 3 * maxHP / 1000 and 3 * armorClass / 10 so no double constants are
 *     needed. Keep them in lockstep or the floater and the health bar disagree.
 *   - The MasterClass check is the same boundary the server uses: without it,
 *     SwordMelee/MaceMelee/AxeMelee/PunchMelee would hand the bonus to every
 *     Justicar and Templar, not just Sentinels.
 *
 * Mechanics: two self-contained blocks of raw AVM2 bytecode are inserted with no
 * FFDec recompile, because recompiling CombatState (or any shared class) drifts
 * the fixed offsets that the byte-splice patches in this repo verify against
 * (pet armor / Djinn explosion in CombatState.method_1192, the Demon Maligner
 * regen gate in CombatState.method_1553) and materializes FFDec decompile
 * artifacts (e.g. the Demon Maligner guard duplicating nine times). This is the
 * same route those patches take, and it keeps every other patch byte-identical.
 *
 *   1. class_91.method_175 (Game.var_172, the dispatcher every melee-hit floater
 *      goes through -- CombatState.method_1192's impact number and
 *      Entity.TakeDamage's hit both call it): prepend a block that adds the
 *      bonus to param4 when param1.basePowerName is a melee power and param2
 *      (the attacker) is a Sentinel.
 *   2. CombatState.method_72 (the crit / proc floater renderer): insert a block
 *      after the obfuscator's local-declaration prologue that adds the bonus to
 *      param4 when param1 is ProcCriticalHit and this.var_3 (the player) is a
 *      Sentinel. The ProcCriticalHit floater only ever fires from the melee-hit
 *      branch of method_1192, so no power-id lookup is needed to prove the hit
 *      was melee; every other proc (ProcHeal, ProcLifethirst...) is gated out.
 *
 * Run with --verify to check that both blocks and the pool strings are present,
 * without writing anything.
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

// Must agree with CombatHandler.SENTINEL_MAX_HP_RATE and SENTINEL_ARMOR_RATE.
// Expressed as integer ratios so the block only needs pushshort operands.
const MAX_HP_RATE_NUM = 3;
const MAX_HP_RATE_DEN = 1000;
const ARMOR_RATE_NUM = 3;
const ARMOR_RATE_DEN = 10;

// Must agree with CombatHandler.SENTINEL_MELEE_POWER_NAMES (the server matches
// rank-suffixed variants too, but basePowerName is the base name on the client,
// so the six bases cover every rank).
const MELEE_POWER_NAMES = ["SwordMelee", "MaceMelee", "AxeMelee", "PunchMelee", "SFMelee", "SFMeleeCombo"];

const OP = {
    jump: 0x10,
    iftrue: 0x11,
    iffalse: 0x12,
    ifne: 0x14,
    pushbyte: 0x24,
    pushshort: 0x25,
    pushstring: 0x2c,
    callproperty: 0x46,
    getlex: 0x60,
    getlocal: 0x62,
    setlocal: 0x63,
    getproperty: 0x66,
    add: 0xa0,
    multiply: 0xa2,
    divide: 0xa3,
} as const;

type Emitted =
    | { label: string }
    | { opcode: number; operands?: Array<[string, number]>; branchTo?: string; pop?: number; push?: number };

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
 * Emit the program with label fixups and a stack-depth budget of 8, exactly like
 * patch-dungeonblitz-pet-armor-djinn-explode.ts's assembler.
 */
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

// ---- string pool helpers (same shape as the pet-armor patch) ----------------

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

// ---- bonus blocks -----------------------------------------------------------

interface Mn {
    basePowerName: number;
    mMasterClass: number;
    maxHP: number;
    armorClass: number;
    var_3: number;
    Math: number;
    round: number;
}

function resolveMultinames(abc: ReturnType<typeof parseAbc>): Mn {
    const out: Mn = { basePowerName: -1, mMasterClass: -1, maxHP: -1, armorClass: -1, var_3: -1, Math: -1, round: -1 };
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
 * The shared arithmetic: Math.round(3 * ent.maxHP / 1000) + Math.round(3 * ent.armorClass / 10),
 * where `entity` pushes the attacker Entity (param2 for the melee floater, this.var_3 for the
 * crit floater). Leaves the bonus on the stack.
 */
function computeBonus(mn: Mn, entity: Emitted[]): Emitted[] {
    return [
        getLex(mn.Math),
        { opcode: OP.pushbyte, operands: [["s8", MAX_HP_RATE_NUM]], push: 1 },
        ...entity,
        get(mn.maxHP),
        { opcode: OP.multiply, pop: 2, push: 1 },
        pushShort(MAX_HP_RATE_DEN),
        { opcode: OP.divide, pop: 2, push: 1 },
        callProp(mn.round, 1),
        getLex(mn.Math),
        { opcode: OP.pushbyte, operands: [["s8", ARMOR_RATE_NUM]], push: 1 },
        ...entity,
        get(mn.armorClass),
        { opcode: OP.multiply, pop: 2, push: 1 },
        pushShort(ARMOR_RATE_DEN),
        { opcode: OP.divide, pop: 2, push: 1 },
        callProp(mn.round, 1),
        { opcode: OP.add, pop: 2, push: 1 },
    ];
}

/**
 * param4 += bonus when param4 != 0, param1.basePowerName is a melee power and
 * param2 (the attacker) is a Sentinel. Entry/exit stack 0, uses only locals 1/2/4.
 */
function buildMeleeHitBlock(mn: Mn, strIdx: Record<string, number>, meleeStr: number[], nullGuards: boolean = true): Buffer {
    const program: Emitted[] = [
        getlocal(4),
        { opcode: 0x2a, pop: 1, push: 2 }, // dup
        { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 },
        { opcode: OP.ifne, branchTo: "compute", pop: 2 },
        { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 },
        { opcode: OP.jump, branchTo: "done" },
        { label: "compute" },
    ];
    // Null guard: if param1 (power info) is null, skip the bonus.
    if (nullGuards) {
        program.push(
            getlocal(1),
            { opcode: OP.iffalse, branchTo: "skip", pop: 1 },
        );
    }
    // melee power names: if basePowerName == name -> Sentinel check, else next name.
    for (let i = 0; i < MELEE_POWER_NAMES.length; i += 1) {
        if (i > 0) {
            program.push({ label: `next${i - 1}` });
        }
        program.push(
            getlocal(1),
            get(mn.basePowerName),
            pushStr(meleeStr[i]),
            { opcode: OP.ifne, branchTo: i < MELEE_POWER_NAMES.length - 1 ? `next${i}` : "notMelee", pop: 2 },
            { opcode: OP.jump, branchTo: "sentinelCheck" },
        );
    }
    program.push(
        { label: "notMelee" },
        { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 },
        { opcode: OP.jump, branchTo: "done" },
        { label: "sentinelCheck" },
    );
    // Null guard: if param2 (attacker entity) is null, skip the bonus.
    if (nullGuards) {
        program.push(
            getlocal(2),
            { opcode: OP.iffalse, branchTo: "skip", pop: 1 },
        );
    }
    program.push(
        getlocal(2),
        get(mn.mMasterClass),
        pushStr(strIdx.Sentinel),
        { opcode: OP.ifne, branchTo: "notSentinel", pop: 2 },
        ...computeBonus(mn, [getlocal(2)]),
        { opcode: OP.jump, branchTo: "done" },
        { label: "notSentinel" },
        { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 },
        ...(nullGuards
            ? [{ opcode: OP.jump, branchTo: "done" } as Emitted,
               { label: "skip" } as Emitted,
               { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 } as Emitted]
            : []),
        { label: "done" },
        { opcode: OP.add, pop: 2, push: 1 },
        setlocal(4),
    );
    return assemble(program);
}

/**
 * param4 += bonus when param4 != 0, param1 is ProcCriticalHit and this.var_3
 * (the player) is a Sentinel. Entry/exit stack 0, uses only locals 1/4.
 */
function buildCritBlock(mn: Mn, strIdx: Record<string, number>, procCriticalHitStr: number, nullGuards: boolean = true): Buffer {
    const entity: Emitted[] = [getlocal(0), get(mn.var_3)];
    const program: Emitted[] = [
        getlocal(4),
        { opcode: 0x2a, pop: 1, push: 2 }, // dup
        { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 },
        { opcode: OP.ifne, branchTo: "compute", pop: 2 },
        { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 },
        { opcode: OP.jump, branchTo: "done" },
        { label: "compute" },
    ];
    // Null guard: if param1 (power info) is null, skip the bonus.
    if (nullGuards) {
        program.push(
            getlocal(1),
            { opcode: OP.iffalse, branchTo: "skip", pop: 1 },
        );
    }
    program.push(
        getlocal(1),
        get(mn.basePowerName),
        pushStr(procCriticalHitStr),
        { opcode: OP.ifne, branchTo: "notProc", pop: 2 },
    );
    // Null guard: if this.var_3 (the player entity) is null, skip the bonus.
    if (nullGuards) {
        program.push(
            ...entity,
            { opcode: OP.iffalse, branchTo: "skip", pop: 1 },
        );
    }
    program.push(
        ...entity,
        get(mn.mMasterClass),
        pushStr(strIdx.Sentinel),
        { opcode: OP.ifne, branchTo: "notSentinel", pop: 2 },
        ...computeBonus(mn, entity),
        { opcode: OP.jump, branchTo: "done" },
        { label: "notProc" },
        { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 },
        { opcode: OP.jump, branchTo: "done" },
        { label: "notSentinel" },
        { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 },
        ...(nullGuards
            ? [{ opcode: OP.jump, branchTo: "done" } as Emitted,
               { label: "skip" } as Emitted,
               { opcode: OP.pushbyte, operands: [["s8", 0]], push: 1 } as Emitted]
            : []),
        { label: "done" },
        { opcode: OP.add, pop: 2, push: 1 },
        setlocal(4),
    );
    return assemble(program);
}

// ---- SWF patching -----------------------------------------------------------

function methodBody(abc: ReturnType<typeof parseAbc>, className: string, methodName: string, site: string) {
    const ci = classIndexByName(abc, className);
    if (ci === null) {
        throw new PatchError(`${site}: class ${className} not found.`);
    }
    const mi = methodIdxForTrait(abc.instances[ci].traits, abc, methodName);
    if (mi === null) {
        throw new PatchError(`${site}: ${className}.${methodName} not found.`);
    }
    const body = abc.methodBodies.get(mi);
    if (!body) {
        throw new PatchError(`${site}: method body for ${className}.${methodName} not found.`);
    }
    return { ci, mi, body };
}

/** The byte offset right after the obfuscator's 0xef local-declaration prologue (0 if none). */
function insertionPoint(code: Buffer, label: string): number {
    const instructions = disassemble(code, label);
    let insertAt = 0;
    for (const inst of instructions) {
        if (inst.opcode === 0xef) {
            insertAt = inst.offset + inst.size;
        }
    }
    return insertAt;
}

/**
 * Insert `data` at byte `at` and re-target every branch whose target is at or
 * past the insertion point by the delta. Branches before it keep their targets.
 */
function spliceInsert(code: Buffer, instructions: Instruction[], at: number, data: Buffer): Buffer {
    const patched = Buffer.concat([code.subarray(0, at), data, code.subarray(at)]);
    const delta = data.length;

    for (const inst of instructions) {
        if (inst.opcode === 0x1b) {
            throw new PatchError("lookupswitch present; its case offsets would need re-targeting too.");
        }
        if (!isBranchOpcode(inst.opcode)) {
            continue;
        }
        const operand = inst.operands.find(([kind]) => kind === "s24");
        if (!operand) {
            continue;
        }
        const oldTarget = inst.offset + inst.size + operand[1];
        if (oldTarget < at) {
            continue;
        }
        const newTarget = oldTarget + delta;
        const newOffset = inst.offset + (inst.offset >= at ? delta : 0);
        writeS24(newTarget - (newOffset + inst.size)).copy(patched, newOffset + 1);
    }
    return patched;
}

function patchSwf(swfPath: string, verifyOnly: boolean): void {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);

    const pool = parsePool(ctx);
    const { indexOf: strIndexOf, patches } = appendStrings(pool, MELEE_POWER_NAMES);
    const strIdx: Record<string, number> = {};
    for (const name of MELEE_POWER_NAMES) {
        const idx = strIndexOf.get(name);
        if (idx === undefined) {
            throw new PatchError(`Could not resolve melee power string ${name}.`);
        }
        strIdx[name] = idx;
    }
    const sentinelStr = abc.stringValues.indexOf("Sentinel");
    const procCriticalHitStr = abc.stringValues.indexOf("ProcCriticalHit");
    if (sentinelStr < 0 || procCriticalHitStr < 0) {
        throw new PatchError("Sentinel / ProcCriticalHit strings missing from the ABC pool.");
    }
    strIdx.Sentinel = sentinelStr;
    strIdx.ProcCriticalHit = procCriticalHitStr;
    const meleeStr = MELEE_POWER_NAMES.map((name) => {
        const idx = strIndexOf.get(name);
        if (idx === undefined) {
            throw new PatchError(`Could not resolve melee power string ${name}.`);
        }
        return idx;
    });

    const mn = resolveMultinames(abc);
    const meleeBlock = buildMeleeHitBlock(mn, strIdx, meleeStr, true);
    const oldMeleeBlock = buildMeleeHitBlock(mn, strIdx, meleeStr, false);
    const critBlock = buildCritBlock(mn, strIdx, procCriticalHitStr, true);
    const oldCritBlock = buildCritBlock(mn, strIdx, procCriticalHitStr, false);

    // ---- class_91.method_175: the dispatcher every melee-hit floater goes through ----
    {
        const { body } = methodBody(abc, "class_91", "method_175", "Melee floater");
        if (body.exceptionCount !== 0) {
            throw new PatchError("class_91.method_175 has exception handlers; the prepend is not safe.");
        }
        const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
        const alreadyNew = code.length >= meleeBlock.length && code.subarray(0, meleeBlock.length).equals(meleeBlock);
        const alreadyOld = !alreadyNew && code.length >= oldMeleeBlock.length && code.subarray(0, oldMeleeBlock.length).equals(oldMeleeBlock);
        if (alreadyNew) {
            console.log(`${swfPath}: class_91.method_175 already carries the Sentinel melee floater bonus with null guards.`);
        } else if (verifyOnly) {
            throw new PatchError(`${swfPath}: verify failed; the Sentinel melee floater bonus is missing or needs updating.`);
        } else {
            // Strip the old unguarded block if present, then prepend the new guarded block.
            const originalCode = alreadyOld ? code.subarray(oldMeleeBlock.length) : code;
            const patchedCode = Buffer.concat([meleeBlock, originalCode]);
            patches.push(
                {
                    key: "class_91.method_175.code",
                    start: body.codeStart,
                    end: body.codeStart + body.codeLen,
                    data: patchedCode,
                    detail: alreadyOld
                        ? `replace unguarded Sentinel melee floater bonus with null-guarded version (${meleeBlock.length} bytes)`
                        : `prepend Sentinel melee floater bonus with null guards (${meleeBlock.length} bytes)`,
                },
                {
                    key: "class_91.method_175.codeLen",
                    start: body.codeLenPos,
                    end: body.codeStart,
                    data: writeU30(patchedCode.length),
                    detail: `update class_91.method_175 code length (${body.codeLen} -> ${patchedCode.length})`,
                },
            );
            if (alreadyOld) {
                console.log(`${swfPath}: replaced unguarded Sentinel melee floater bonus with null-guarded version in class_91.method_175.`);
            } else {
                console.log(`${swfPath}: prepended Sentinel melee floater bonus with null guards to class_91.method_175 (+${meleeBlock.length} bytes).`);
            }
        }
    }

    // ---- CombatState.method_72: the crit / proc floater renderer ----
    {
        const { body } = methodBody(abc, "CombatState", "method_72", "Crit floater");
        if (body.exceptionCount !== 0) {
            throw new PatchError("CombatState.method_72 has exception handlers; the insert is not safe.");
        }
        const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
        const insertAt = insertionPoint(code, "CombatState.method_72");
        if (insertAt === 0) {
            throw new PatchError("CombatState.method_72 has no 0xef prologue to anchor the insert.");
        }
        const instructions = disassemble(code, "CombatState.method_72");
        const alreadyNew =
            code.length >= insertAt + critBlock.length && code.subarray(insertAt, insertAt + critBlock.length).equals(critBlock);
        const alreadyOld = !alreadyNew &&
            code.length >= insertAt + oldCritBlock.length && code.subarray(insertAt, insertAt + oldCritBlock.length).equals(oldCritBlock);
        if (alreadyNew) {
            console.log(`${swfPath}: CombatState.method_72 already carries the Sentinel crit floater bonus with null guards.`);
        } else if (verifyOnly) {
            throw new PatchError(`${swfPath}: verify failed; the Sentinel crit floater bonus is missing or needs updating.`);
        } else {
            // Strip the old unguarded block if present, then insert the new guarded block.
            let patchedCode: Buffer;
            if (alreadyOld) {
                // Remove old block, insert new one in its place.
                patchedCode = Buffer.concat([
                    code.subarray(0, insertAt),
                    critBlock,
                    code.subarray(insertAt + oldCritBlock.length),
                ]);
            } else {
                patchedCode = spliceInsert(code, instructions, insertAt, critBlock);
            }
            patches.push(
                {
                    key: "CombatState.method_72.code",
                    start: body.codeStart,
                    end: body.codeStart + body.codeLen,
                    data: patchedCode,
                    detail: alreadyOld
                        ? `replace unguarded Sentinel crit floater bonus with null-guarded version (${critBlock.length} bytes)`
                        : `insert Sentinel crit floater bonus with null guards (${critBlock.length} bytes)`,
                },
                {
                    key: "CombatState.method_72.codeLen",
                    start: body.codeLenPos,
                    end: body.codeStart,
                    data: writeU30(patchedCode.length),
                    detail: `update CombatState.method_72 code length (${body.codeLen} -> ${patchedCode.length})`,
                },
            );
            if (alreadyOld) {
                console.log(`${swfPath}: replaced unguarded Sentinel crit floater bonus with null-guarded version in CombatState.method_72.`);
            } else {
                console.log(`${swfPath}: inserted Sentinel crit floater bonus with null guards into CombatState.method_72 at +${insertAt} (${critBlock.length} bytes).`);
            }
        }
    }

    if (patches.length === 0) {
        return;
    }
    if (verifyOnly) {
        throw new PatchError(`${swfPath}: verify failed; SWF patches are missing.`);
    }
    ensureBackup(swfPath);
    const { body, delta } = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, body, delta);
    syncClientRev(swfPath);
}

// ---- index.html clientrev sync (same routine as the pet-armor patch) -------

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
            console.log([
                "Usage:",
                "  npx ts-node src/server/scripts/patch-dungeonblitz-sentinel-passive-display.ts [--verify] [--swf <path>]",
                "",
                "Shows the server-side Sentinel passive (0.3% of max HP + 30% of Defense on",
                "melee swings) in the client's damage floaters, so Defense charms visibly",
                "increase the Sentinel's M1 and melee moveset damage (issue #726).",
            ].join("\n"));
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
        console.log(verify ? "Sentinel passive display patch present." : "Sentinel passive display patch applied.");
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[patch-dungeonblitz-sentinel-passive-display] ${message}`);
        return 1;
    }
}

if (require.main === module) {
    process.exit(main());
}
