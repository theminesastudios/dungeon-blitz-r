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

// Must agree with CombatHandler.SOULTHIEFT_MAX_HP_RATE (0.01).
const MAX_HP_RATE_DEN = 100;

const MASTER_CLASS_NAME = "Soulthief";

/** Headroom for the block's own operand stack use, added to the method's max_stack. */
const STACK_HEADROOM = 6;

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
    divide: 0xa3,
} as const;

type Emitted = { label: string } | { opcode: number; operands?: Array<[string, number]>; branchTo?: string; pop?: number; push?: number };

const getlocal = (index: number): Emitted =>
    index <= 3 ? { opcode: 0xd0 + index, push: 1 } : { opcode: OP.getlocal, operands: [["u30", index]], push: 1 };
const get = (mn: number): Emitted => ({ opcode: OP.getproperty, operands: [["u30", mn]], pop: 1, push: 1 });
const getLex = (mn: number): Emitted => ({ opcode: OP.getlex, operands: [["u30", mn]], push: 1 });
const pushStr = (idx: number): Emitted => ({ opcode: OP.pushstring, operands: [["u30", idx]], push: 1 });
const pushShort = (value: number): Emitted => ({ opcode: OP.pushshort, operands: [["u30", value]], push: 1 });
const pushByte = (value: number): Emitted => ({ opcode: 0x24, operands: [["s8", value]], push: 1 });
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

// ---- the bonus block --------------------------------------------------------

interface Mn {
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
 * Stack in:  [.., Game, amount]
 * Stack out: [.., Game, amount + bonus]
 *
 * where bonus is Math.round(this.maxHP / 100) when the local player is the Soulthief who
 * landed a damaging direct power hit, and nothing happens otherwise.
 */
function buildFloaterBlock(mn: Mn, soulthiefStr: number): { code: Buffer; maxDepth: number } {
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
        // amount += Math.round(this.maxHP / 100); `this` is the victim, so this is the target pool.
        getLex(mn.Math),
        getlocal(0),
        get(mn.maxHP),
        pushShort(MAX_HP_RATE_DEN),
        { opcode: OP.divide, pop: 2, push: 1 },
        callProp(mn.round, 1),
        { opcode: OP.add, pop: 2, push: 1 },
        { label: "skip" },
    ];
    return assemble(program, 1, 1);
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
function findFloaterAnchors(instructions: Instruction[], mn: Mn): number[] {
    const anchors: number[] = [];
    for (let i = 0; i < instructions.length; i += 1) {
        const inst = instructions[i];
        if (inst.opcode !== 0x4f || inst.operands[0]?.[1] !== mn.method_527) {
            continue;
        }
        let receiver = -1;
        for (let j = i - 1; j >= 1; j -= 1) {
            if (
                instructions[j].opcode === 0x66 &&
                instructions[j].operands[0]?.[1] === mn.var_1 &&
                instructions[j - 1].opcode === 0xd0
            ) {
                receiver = j - 1;
                break;
            }
        }
        if (receiver < 0) {
            throw new PatchError(`No Game receiver push found for the method_527 call at +${inst.offset}.`);
        }
        let anchor = -1;
        for (let j = receiver + 1; j < i; j += 1) {
            if (
                instructions[j].opcode === 0xd0 &&
                instructions[j + 1]?.opcode === 0x66 &&
                instructions[j + 1].operands[0]?.[1] === mn.gfx
            ) {
                anchor = instructions[j].offset;
                break;
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

/**
 * Insert `data` at each offset in `ats` (ascending) and re-target every branch across the
 * insertions. A branch whose target is at or past an insertion point moves by the bytes
 * inserted before that target; the instruction doing the branching moves by the bytes
 * inserted before it.
 */
function spliceInsertMany(code: Buffer, instructions: Instruction[], ats: number[], data: Buffer): Buffer {
    const sorted = [...ats].sort((a, b) => a - b);
    const shiftFor = (offset: number, inclusive: boolean): number =>
        sorted.filter((at) => (inclusive ? at <= offset : at < offset)).length * data.length;

    const chunks: Buffer[] = [];
    let cursor = 0;
    for (const at of sorted) {
        chunks.push(code.subarray(cursor, at), data);
        cursor = at;
    }
    chunks.push(code.subarray(cursor));
    const patched = Buffer.concat(chunks);

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
        // A branch into an anchor must land on the inserted block, not after it, so the
        // block runs on that path too: targets at an anchor shift by the insertions strictly
        // before them.
        const newTarget = oldTarget + shiftFor(oldTarget, false);
        const newOffset = inst.offset + shiftFor(inst.offset, true);
        writeS24(newTarget - (newOffset + inst.size)).copy(patched, newOffset + 1);
    }
    return patched;
}

function patchSwf(swfPath: string, verifyOnly: boolean): void {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);

    const pool = parsePool(ctx);
    const { indexOf: strIndexOf, patches } = appendStrings(pool, [MASTER_CLASS_NAME]);
    const soulthiefStr = strIndexOf.get(MASTER_CLASS_NAME);
    if (soulthiefStr === undefined) {
        throw new PatchError(`Could not resolve the ${MASTER_CLASS_NAME} string constant.`);
    }

    const mn = resolveMultinames(abc);
    const { code: block, maxDepth } = buildFloaterBlock(mn, soulthiefStr);

    const body = methodBody(abc, "Entity", "TakeDamage");
    if (body.exceptionCount !== 0) {
        throw new PatchError("Entity.TakeDamage has exception handlers; the inserts are not safe.");
    }
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const instructions = disassemble(code, "Entity.TakeDamage");
    const anchors = findFloaterAnchors(instructions, mn);

    // The block is inserted immediately *before* the anchor, and the anchor scan re-finds the
    // same x-argument start on an already-patched file, so look backwards from it.
    const carriesBlock = (at: number): boolean =>
        at >= block.length && code.subarray(at - block.length, at).equals(block);
    const alreadyPatched = anchors.every(carriesBlock);
    if (alreadyPatched) {
        console.log(`${swfPath}: Entity.TakeDamage already carries the Soulthief floater bonus at all 3 sites.`);
    } else if (verifyOnly) {
        throw new PatchError(`${swfPath}: verify failed; the Soulthief floater bonus is missing or needs updating.`);
    } else {
        if (anchors.some(carriesBlock)) {
            throw new PatchError(
                "Entity.TakeDamage carries the Soulthief floater bonus at some but not all sites; restore the .bak and re-run.",
            );
        }
        const patchedCode = spliceInsertMany(code, instructions, anchors, block);

        const [maxStack, maxStackEnd] = readU30(ctx.body, body.maxStackPos, "Entity.TakeDamage.max_stack");
        const neededStack = maxStack + Math.max(STACK_HEADROOM, maxDepth);
        patches.push(
            {
                key: "Entity.TakeDamage.max_stack",
                start: body.maxStackPos,
                end: maxStackEnd,
                data: writeU30(neededStack),
                detail: `raise max_stack for the inserted block (${maxStack} -> ${neededStack})`,
            },
            {
                key: "Entity.TakeDamage.code",
                start: body.codeStart,
                end: body.codeStart + body.codeLen,
                data: patchedCode,
                detail: `insert the Soulthief floater bonus at 3 sites (${block.length} bytes each)`,
            },
            {
                key: "Entity.TakeDamage.codeLen",
                start: body.codeLenPos,
                end: body.codeStart,
                data: writeU30(patchedCode.length),
                detail: `update Entity.TakeDamage code length (${body.codeLen} -> ${patchedCode.length})`,
            },
        );
        console.log(
            `${swfPath}: inserted the Soulthief floater bonus into Entity.TakeDamage at +${anchors.join(", +")} ` +
                `(${block.length} bytes each, max_stack ${maxStack} -> ${neededStack}).`,
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
