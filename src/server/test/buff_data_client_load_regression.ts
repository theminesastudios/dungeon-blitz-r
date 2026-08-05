/// <reference types="node" />

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// The client validates buff data while parsing it, and every one of those checks calls
// class_24.method_7, which is a bare `throw`. ResourceManager catches it, marks the whole
// stage failed, and the player gets "Load Failed: Game" with no way past it -- so a bad
// number in PlayerBuffTypes is not a balance wart, it is a client that will not start.
//
// This happened: the pet retune scaled durations by 1.5, which turned two 5000ms buffs into
// 7500ms against a 1000ms tick, and BuffType.as:803 refused the file. Balance patches touch
// these numbers constantly, so the invariants are asserted here rather than trusted.
const XML_PATH = path.resolve(__dirname, '..', '..', 'client', 'content', 'xml', 'PlayerBuffTypes.xml');
const CBQ_DIR = path.resolve(__dirname, '..', '..', 'client', 'content', 'localhost', 'p', 'cbq');

type Buff = { name: string; fields: Record<string, string> };

function parseBuffs(xml: string): Buff[] {
    const buffs: Buff[] = [];
    for (const block of xml.match(/<BuffType BuffName="[^"]*">[\s\S]*?<\/BuffType>/g) ?? []) {
        const name = block.match(/<BuffType BuffName="([^"]*)">/)?.[1] ?? '';
        // The authored template row carries placeholder values (a zero StackCount among
        // them) and is not a real buff.
        if (!name || name.includes('Template')) {
            continue;
        }

        const fields: Record<string, string> = {};
        for (const field of block.match(/<([A-Za-z]+)>([^<]*)<\/\1>/g) ?? []) {
            const tag = field.match(/^<([A-Za-z]+)>/)?.[1] ?? '';
            const value = field.match(/^<[A-Za-z]+>([^<]*)</)?.[1] ?? '';
            if (tag) {
                fields[tag] = value.trim();
            }
        }
        buffs.push({ name, fields });
    }

    return buffs;
}

// BuffType.as:803 -- "Buff TickLength must divide evenly into duration".
function assertTicksDivideDuration(buffs: Buff[], source: string): void {
    for (const buff of buffs) {
        const tick = Number(buff.fields.DoTTickLength ?? 0);
        const duration = Number(buff.fields.Duration ?? 0);
        if (!Number.isFinite(tick) || tick <= 0 || !Number.isFinite(duration) || duration <= 0) {
            continue;
        }

        assert.equal(
            duration % tick,
            0,
            `${source}: ${buff.name} has a ${duration}ms duration against a ${tick}ms tick, which makes the client refuse the whole Game stage`
        );
    }
}

// BuffType.as:305 and :317 -- "Magic/Melee Defense outside of valid range -1 to .99".
function assertDefenseInRange(buffs: Buff[], source: string): void {
    for (const buff of buffs) {
        for (const tag of ['MeleeDefense', 'MagicDefense']) {
            const raw = buff.fields[tag];
            if (raw === undefined || raw === '') {
                continue;
            }

            const value = Number(raw);
            assert.ok(
                Number.isFinite(value) && value >= -1 && value <= 0.99,
                `${source}: ${buff.name} ${tag} is ${raw}, outside the -1..0.99 the client accepts`
            );
        }
    }
}

// BuffType.as:799 -- "Stack count must be non-zero".
function assertStackCountsNonZero(buffs: Buff[], source: string): void {
    for (const buff of buffs) {
        const raw = buff.fields.StackCount;
        if (raw === undefined || raw === '') {
            continue;
        }

        assert.notEqual(Number(raw), 0, `${source}: ${buff.name} declares a zero StackCount, which the client refuses`);
    }
}

function check(xml: string, source: string): number {
    const buffs = parseBuffs(xml);
    assert.ok(buffs.length > 0, `${source}: parsed no buffs at all`);
    assertTicksDivideDuration(buffs, source);
    assertDefenseInRange(buffs, source);
    assertStackCountsNonZero(buffs, source);
    return buffs.length;
}

function run(): void {
    const count = check(fs.readFileSync(XML_PATH, 'utf8'), 'PlayerBuffTypes.xml');

    // The served archive is what players actually load, and it is patched separately from
    // the source XML -- checking only the source would miss a half-applied patch.
    const swzPath = path.join(CBQ_DIR, 'Game.swz');
    if (fs.existsSync(swzPath)) {
        const { parseSwz } = require('../scripts/swzPatchUtils') as typeof import('../scripts/swzPatchUtils');
        const chunk = parseSwz(swzPath).chunks.find((entry) => entry.xml.includes('<PlayerBuffTypes'));
        assert.ok(chunk, 'Game.swz carries no PlayerBuffTypes chunk');
        check(chunk.xml, 'Game.swz PlayerBuffTypes');
    }

    console.log(`buff_data_client_load_regression: ok (${count} buffs)`);
}

run();
