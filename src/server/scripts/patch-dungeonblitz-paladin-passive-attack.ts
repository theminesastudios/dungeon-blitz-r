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
    u30OperandName,
    writeSwf,
    writeU30,
} from "./swfPatchUtils";

/**
 * The two Paladin discipline passives, as what they actually say they are: a bigger Attack.
 *
 *   Sentinel: 0.1% of maximum Health is converted into Attack.
 *   Justicar: 5%   of Expertise      is converted into Attack.
 *
 * WHY THIS IS A CLIENT PATCH AND NOT SERVER CODE. Both passives were server-side first, added
 * onto the damage of every hit in CombatHandler.handlePowerHit, and from inside the game they
 * did nothing. The client computes its own damage, draws its own number, and on every level
 * where it spawned the enemy it also owns that enemy's health and decides when it dies -- so a
 * number the server added afterwards was invisible and, on those levels, had no effect at all.
 * The attempts to deliver it after the fact each failed in their own way:
 *
 *   - Adding it to class_91.method_175 changed the combat *log* line, not the floater (the
 *     floater is Game.method_527, from Entity.TakeDamage), so the player still saw nothing.
 *   - Sending the difference as a negative PKTTYPE_CHAR_REGEN made the target take a second,
 *     separate hit, which the client drew as its own damage number: the bonus showed up as an
 *     absurd extra floater beside every swing.
 *
 * There is exactly one number, and the client is the one that computes it, so the conversion
 * belongs where Attack is read.
 *
 * WHERE. CombatState.method_1192 is the per-hit damage computation, and it is the only one:
 *
 *     local28 = local20 ? local20 : this.var_3.meleeDamage;   // Attack
 *     local21 = Math.round(local12 * local28);                // BaseDamageMult * Attack
 *     Game.var_172(power, this.var_3, target, local21, ...);  // and on to the target/server
 *
 * A block is spliced in directly after `setlocal 28`, so every power picks the conversion up
 * and each power's own BaseDamageMult multiplies it, exactly as real Attack behaves. Since the
 * hit the client reports to the server already carries it, the server needs no rewrite, and
 * nothing anywhere double-counts. CombatState.method_1393 (the Armory's damage estimate) and
 * method_72/method_304 read meleeDamage too but are not the hit itself, and are left alone --
 * the Armory keeps showing the base Attack, which is why the passives are spelled out on the
 * ConcussionBolt and AxeFlurry tooltips.
 *
 * The block:
 *
 *     if (this.var_3) {
 *         if (this.var_3.mMasterClass == "Sentinel")      local28 += Math.round(this.var_3.maxHP / 1000);
 *         else if (this.var_3.mMasterClass == "Justicar") local28 += Math.round(this.var_3.magicDamage / 20);
 *     }
 *
 * Entry and exit stack depth 0, forward branches only, and it touches nothing but local 28 --
 * the same rules the other hand-written ABC blocks in this repo follow. var_3 is the entity
 * the CombatState belongs to, so the MasterClass test is what keeps this to the two Paladin
 * disciplines; every other class and every monster falls straight through.
 *
 * Run with --verify to check the block is present without writing anything.
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

// Must agree with CombatHandler's documented rates: 0.1% of max HP, 5% of Expertise. Written
// as divisors because the block may only use integer operands -- a double would have to be
// appended to the constant pool.
const SENTINEL_MAX_HP_DIVISOR = 1000;
const JUSTICAR_EXPERTISE_DIVISOR = 20;

// Entity.mMasterClass holds the LOWERCASE internal key, never the display label. Game's cinit
// builds `const_85[const_21[i] = "justicar"] = "Justicar"` -- const_21 is what an entity
// carries, const_85 is what the UI prints -- and every comparison the client makes itself
// ("soulthief", "flameseer", "shadowwalker"...) uses the lowercase side.
//
// This is not a detail. A capitalized literal assembles and inserts perfectly and then never
// matches, so the passive silently does nothing, and the block looks correct in every P-code
// export you take of it. Both earlier attempts at these passives died here.
const SENTINEL_KEY = "sentinel";
const JUSTICAR_KEY = "justicar";
// The capitalized spelling, kept only so a SWF carrying the broken block can be recognised
// and have it replaced rather than gaining a second one.
const LEGACY_KEYS: Array<[string, string]> = [["Sentinel", "Justicar"]];

const OP = {
    jump: 0x10,
    iffalse: 0x12,
    ifne: 0x14,
    pushbyte: 0x24,
    pushshort: 0x25,
    pushstring: 0x2c,
    convert_i: 0x73,
    callproperty: 0x46,
    getlex: 0x60,
    getlocal: 0x62,
    setlocal: 0x63,
    getproperty: 0x66,
    add: 0xa0,
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

/** Label fixups plus a stack-depth check, the same assembler the other block patches use. */
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
        offset += item.branchTo ? 3 : (item.operands ?? []).reduce((sum, [kind, value]) => sum + operandBytes(kind, value).length, 0);
    }

    let depth = 0;
    let maxDepth = 0;
    for (const item of program) {
        if ("label" in item) {
            continue;
        }
        depth -= item.pop ?? 0;
        if (depth < 0) {
            throw new PatchError(`Stack underflow at opcode 0x${item.opcode.toString(16)}`);
        }
        depth += item.push ?? 0;
        maxDepth = Math.max(maxDepth, depth);
    }
    if (depth !== 0) {
        throw new PatchError(`Block does not end at stack depth 0 (ends at ${depth}).`);
    }
    if (maxDepth > 6) {
        throw new PatchError(`Block needs ${maxDepth} stack slots; the host method budget is smaller.`);
    }

    const chunks: Buffer[] = [];
    offset = 0;
    for (const item of program) {
        if ("label" in item) {
            continue;
        }
        const head = Buffer.from([item.opcode]);
        if (item.branchTo) {
            const target = labels.get(item.branchTo);
            if (target === undefined) {
                throw new PatchError(`Unknown label ${item.branchTo}`);
            }
            const size = 4;
            chunks.push(head, writeS24(target - (offset + size)));
            offset += size;
            continue;
        }
        const operands = (item.operands ?? []).map(([kind, value]) => operandBytes(kind, value));
        chunks.push(head, ...operands);
        offset += 1 + operands.reduce((sum, buffer) => sum + buffer.length, 0);
    }
    return Buffer.concat(chunks);
}

interface Mn {
    var_3: number;
    mMasterClass: number;
    maxHP: number;
    magicDamage: number;
    Math: number;
    round: number;
}

function resolveMultinames(abc: ReturnType<typeof parseAbc>): Mn {
    const out: Mn = { var_3: -1, mMasterClass: -1, maxHP: -1, magicDamage: -1, Math: -1, round: -1 };
    for (const key of Object.keys(out) as Array<keyof Mn>) {
        const idx = abc.multinameNames.indexOf(key);
        if (idx < 0) {
            throw new PatchError(`Multiname ${key} not found in the ABC pool.`);
        }
        out[key] = idx;
    }
    return out;
}

/** local<attackLocal> += Math.round(this.var_3.<stat> / divisor) */
function addConversion(mn: Mn, attackLocal: number, stat: number, divisor: number): Emitted[] {
    return [
        getlocal(attackLocal),
        getLex(mn.Math),
        getlocal(0),
        get(mn.var_3),
        get(stat),
        pushShort(divisor),
        { opcode: OP.divide, pop: 2, push: 1 },
        callProp(mn.round, 1),
        { opcode: OP.add, pop: 2, push: 1 },
        { opcode: OP.convert_i, pop: 1, push: 1 },
        setlocal(attackLocal),
    ];
}

function buildAttackBlock(mn: Mn, attackLocal: number, sentinelStr: number, justicarStr: number): Buffer {
    const masterClass: Emitted[] = [getlocal(0), get(mn.var_3), get(mn.mMasterClass)];
    return assemble([
        getlocal(0),
        get(mn.var_3),
        { opcode: OP.iffalse, branchTo: "done", pop: 1 },
        ...masterClass,
        pushStr(sentinelStr),
        { opcode: OP.ifne, branchTo: "justicar", pop: 2 },
        ...addConversion(mn, attackLocal, mn.maxHP, SENTINEL_MAX_HP_DIVISOR),
        { opcode: OP.jump, branchTo: "done" },
        { label: "justicar" },
        ...masterClass,
        pushStr(justicarStr),
        { opcode: OP.ifne, branchTo: "done", pop: 2 },
        ...addConversion(mn, attackLocal, mn.magicDamage, JUSTICAR_EXPERTISE_DIVISOR),
        { label: "done" },
    ]);
}

// ---- locating the hit's Attack ----------------------------------------------

function methodBody(abc: ReturnType<typeof parseAbc>, className: string, methodName: string) {
    const ci = classIndexByName(abc, className);
    if (ci === null) {
        throw new PatchError(`Class ${className} not found.`);
    }
    const methodIdx = methodIdxForTrait(abc.instances[ci].traits, abc, methodName);
    if (methodIdx === null) {
        throw new PatchError(`${className}.${methodName} not found.`);
    }
    const body = abc.methodBodies.get(methodIdx);
    if (!body) {
        throw new PatchError(`${className}.${methodName} has no method body.`);
    }
    return body;
}

const localIndexOf = (inst: Instruction, setter: boolean): number => {
    const base = setter ? 0xd4 : 0xd0;
    if (inst.opcode === (setter ? OP.setlocal : OP.getlocal)) {
        return inst.operands.find(([kind]) => kind === "u30")?.[1] ?? -1;
    }
    return inst.opcode >= base && inst.opcode <= base + 3 ? inst.opcode - base : -1;
};

/**
 * The anchor is the shape of the damage line rather than a fixed offset:
 *
 *     getproperty meleeDamage ; convert_i ; setlocal N      // Attack for this hit
 *     ... getlex Math ; ... ; getlocal N ; multiply ...     // damage = mult * Attack
 *
 * Either half alone is too common to be safe -- meleeDamage is read in the Armory estimate
 * and elsewhere in this class -- so the match needs both: N is stored, and N is then
 * multiplied inside a Math call. The insert goes right after the store, and N is read out of
 * the match rather than assumed.
 *
 * The forward scan is deliberately tolerant of instructions between the two halves, because
 * once this patch is applied its own block sits exactly there; that is what makes --verify
 * (and a second run) find the same site instead of reporting the client changed.
 */
function findAttackLocal(
    instructions: Instruction[],
    names: string[],
): { insertAt: number; attackLocal: number } {
    const LOOKAHEAD = 48;
    for (let index = 0; index + 3 < instructions.length; index += 1) {
        const [load, convert, store] = instructions.slice(index, index + 3);
        if (load.opcode !== OP.getproperty || u30OperandName(load, names) !== "meleeDamage") {
            continue;
        }
        if (convert.opcode !== OP.convert_i) {
            continue;
        }
        const attackLocal = localIndexOf(store, true);
        if (attackLocal < 0) {
            continue;
        }

        let sawMath = false;
        for (let ahead = index + 3; ahead < Math.min(index + 3 + LOOKAHEAD, instructions.length); ahead += 1) {
            const inst = instructions[ahead];
            if (inst.opcode === OP.getlex && u30OperandName(inst, names) === "Math") {
                sawMath = true;
                continue;
            }
            if (!sawMath || inst.opcode !== 0xa2 /* multiply */) {
                continue;
            }
            if (localIndexOf(instructions[ahead - 1], false) === attackLocal) {
                return { insertAt: instructions[index + 3].offset, attackLocal };
            }
        }
    }
    throw new PatchError(
        "CombatState.method_1192: could not find the `meleeDamage -> setlocal N -> Math(... N * ...)` " +
        "damage line. The client changed; re-read the method before adjusting this matcher.",
    );
}

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

// ---- patching ---------------------------------------------------------------

function patchSwf(swfPath: string, verifyOnly: boolean): void {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);

    const stringIndex = (value: string): number => {
        const idx = abc.stringValues.indexOf(value);
        if (idx < 0) {
            throw new PatchError(`String "${value}" missing from the ABC pool.`);
        }
        return idx;
    };

    const mn = resolveMultinames(abc);
    const body = methodBody(abc, "CombatState", "method_1192");
    if (body.exceptionCount !== 0) {
        throw new PatchError("CombatState.method_1192 has exception handlers; the insert is not safe.");
    }

    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const instructions = disassemble(code, "CombatState.method_1192");
    const { insertAt, attackLocal } = findAttackLocal(instructions, abc.multinameNames);
    const block = buildAttackBlock(mn, attackLocal, stringIndex(SENTINEL_KEY), stringIndex(JUSTICAR_KEY));

    // A block written by an earlier revision of this patch, if one is there. It has to be
    // replaced, not prepended to, or the SWF would carry both.
    const staleBlock = LEGACY_KEYS
        .map(([sentinel, justicar]) => {
            const sentinelIdx = abc.stringValues.indexOf(sentinel);
            const justicarIdx = abc.stringValues.indexOf(justicar);
            return sentinelIdx < 0 || justicarIdx < 0
                ? null
                : buildAttackBlock(mn, attackLocal, sentinelIdx, justicarIdx);
        })
        .find((candidate): candidate is Buffer =>
            candidate !== null &&
            code.length >= insertAt + candidate.length &&
            code.subarray(insertAt, insertAt + candidate.length).equals(candidate),
        ) ?? null;

    if (code.length >= insertAt + block.length && code.subarray(insertAt, insertAt + block.length).equals(block)) {
        console.log(`${swfPath}: CombatState.method_1192 already converts Health/Expertise into Attack.`);
        if (verifyOnly && !clientRevIsCurrent(swfPath)) {
            throw new PatchError(
                "index.html clientrev does not match the SWF on disk, so players load a cached copy " +
                "and the patch reaches nobody. Re-run this script without --verify.",
            );
        }
        return;
    }
    if (verifyOnly) {
        throw new PatchError(`${swfPath}: verify failed; the Paladin Attack conversion is missing.`);
    }

    const patchedCode = staleBlock
        // Same length in every revision so far, but do not rely on it: drop the old block and
        // splice the new one in at the same point.
        ? Buffer.concat([
            code.subarray(0, insertAt),
            block,
            code.subarray(insertAt + staleBlock.length),
        ])
        : spliceInsert(code, instructions, insertAt, block);
    const patches: BytePatch[] = [
        {
            key: "CombatState.method_1192.code",
            start: body.codeStart,
            end: body.codeStart + body.codeLen,
            data: patchedCode,
            detail: staleBlock
                ? `replace the superseded Attack conversion (${block.length} bytes)`
                : `convert Health/Expertise into Attack for the hit (local ${attackLocal}, ${block.length} bytes)`,
        },
        {
            key: "CombatState.method_1192.codeLen",
            start: body.codeLenPos,
            end: body.codeStart,
            data: writeU30(patchedCode.length),
            detail: `update CombatState.method_1192 code length (${body.codeLen} -> ${patchedCode.length})`,
        },
    ];

    ensureBackup(swfPath);
    const { body: patchedBody, delta } = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, patchedBody, delta);
    console.log(
        `${swfPath}: CombatState.method_1192 now adds maxHP/${SENTINEL_MAX_HP_DIVISOR} (Sentinel) or ` +
        `magicDamage/${JUSTICAR_EXPERTISE_DIVISOR} (Justicar) to the hit's Attack at +${insertAt} (${block.length} bytes).`,
    );
    syncClientRev(swfPath);
}

// ---- index.html clientrev sync ----------------------------------------------

function currentDigest(swfPath: string): string {
    return crypto.createHash("sha1").update(fs.readFileSync(swfPath)).digest("hex").slice(0, 12);
}

function clientRevIsCurrent(swfPath: string): boolean {
    if (path.resolve(swfPath) !== DEFAULT_SWF || !fs.existsSync(INDEX_HTML)) {
        return true;
    }
    return fs.readFileSync(INDEX_HTML, "utf8").includes(`clientrev=swf-${currentDigest(swfPath)}`);
}

function syncClientRev(swfPath: string): void {
    if (path.resolve(swfPath) !== DEFAULT_SWF || !fs.existsSync(INDEX_HTML)) {
        return;
    }
    const digest = currentDigest(swfPath);
    const html = fs.readFileSync(INDEX_HTML, "utf8");
    const updated = html.replace(/clientrev=[^&`"'$]+/, `clientrev=swf-${digest}`);
    if (updated !== html) {
        fs.writeFileSync(INDEX_HTML, updated);
        console.log(`  index.html clientrev -> swf-${digest} (cache buster)`);
    }
}

// ---- main -------------------------------------------------------------------

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
                "  npx ts-node src/server/scripts/patch-dungeonblitz-paladin-passive-attack.ts [--verify] [--swf <path>]",
                "",
                "Converts 0.1% of a Sentinel's maximum Health, or 5% of a Justicar's Expertise,",
                "into Attack inside the client's own per-hit damage computation, so the bonus is",
                "part of the one damage number the player sees and the server is told about.",
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
        console.log(verify ? "Paladin passive Attack conversion present." : "Paladin passive Attack conversion applied.");
        return 0;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[patch-dungeonblitz-paladin-passive-attack] ${message}`);
        return 1;
    }
}

if (require.main === module) {
    process.exit(main());
}
