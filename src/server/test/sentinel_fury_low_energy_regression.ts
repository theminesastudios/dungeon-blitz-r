/// <reference types="node" />

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// Sentinel Form's burn phase -- red tint and +60% damage for the last 20 energy -- is two
// halves that are useless apart:
//
//   data  the SentinelFury BuffType, in PlayerBuffTypes (patch_gameswz_sentinel_fury_buff.ts)
//   code  the CombatState.method_960 prologue that puts it on and takes it off
//         (patch-dungeonblitz-sentinel-form-low-energy-fury.ts)
//
// Either one can be lost on its own: a rebuilt SWF drops the prologue, and a Game.swz rebuilt
// from an older source drops the buff. Neither loss announces itself -- the form simply stops
// turning red -- so the pairing is asserted here. The presence of the literal "SentinelFury"
// in the SWF's ABC string pool is the cheap proxy for "the prologue is installed"; the byte
// check itself lives in the patch script's own --verify.
const XML_PATH = path.resolve(__dirname, '..', '..', 'client', 'content', 'xml', 'PlayerBuffTypes.xml');
const POWER_XML_PATH = path.resolve(__dirname, '..', '..', 'client', 'content', 'xml', 'PlayerPowerTypes.xml');
const CBQ_DIR = path.resolve(__dirname, '..', '..', 'client', 'content', 'localhost', 'p', 'cbq');
const SWF_PATH = path.resolve(__dirname, '..', '..', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');

const BUFF_NAME = 'SentinelFury';

function buffBlock(xml: string, source: string): string {
    const block = xml.match(new RegExp(`<BuffType BuffName="${BUFF_NAME}">[\\s\\S]*?</BuffType>`))?.[0];
    assert.ok(block, `${source}: no ${BUFF_NAME} BuffType -- Sentinel Form's burn phase has no buff to apply`);
    return block;
}

function assertField(block: string, tag: string, expected: string, source: string): void {
    const value = block.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];
    assert.equal(value, expected, `${source}: ${BUFF_NAME} ${tag} is ${value}, expected ${expected}`);
}

function checkBuff(xml: string, source: string): void {
    const block = buffBlock(xml, source);

    // Sentinel Form overrides the melee *and* the ranged attack, so both fields carry the 60%
    // or half the form gets nothing out of the burn phase.
    assertField(block, 'MeleeDamage', '0.6', source);
    assertField(block, 'MagicDamage', '0.6', source);

    // EntTint is the whole visual. Without it the burn phase is invisible.
    const tint = block.match(/<EntTint>([^<]*)<\/EntTint>/)?.[1] ?? '';
    assert.ok(/^0x[0-9a-fA-F]{6}$/.test(tint), `${source}: ${BUFF_NAME} EntTint is "${tint}", expected a 0xRRGGBB colour`);
    const channels = parseInt(tint.slice(2), 16);
    const red = (channels >> 16) & 0xff;
    const green = (channels >> 8) & 0xff;
    const blue = channels & 0xff;
    assert.ok(
        red > green && red > blue,
        `${source}: ${BUFF_NAME} EntTint ${tint} is not a red tint (r=${red} g=${green} b=${blue})`
    );

    // Duration 0 means "until removed", which is what the per-tick code expects to own. A real
    // duration would expire the buff mid-form and it would never come back until energy
    // crossed the threshold again.
    assertField(block, 'Duration', '0', source);

    // AddBuff refuses a hostile buff aimed at yourself, and this one is self-applied.
    assertField(block, 'Attack', 'false', source);
}

// The return-to-normal effect (a_SentinelFormEnd) is authored cyan; without the tint it plays
// as a blue flash at the end of a red burn phase.
function checkEndFormTint(xml: string, source: string): void {
    const block = xml.match(/<Power PowerName="EndSentinelForm">[\s\S]*?<\/Power>/)?.[0];
    assert.ok(block, `${source}: no EndSentinelForm power`);

    const castGfx = block.match(/<CastGfx>[\s\S]*?<\/CastGfx>/)?.[0];
    assert.ok(castGfx, `${source}: EndSentinelForm has no CastGfx block to tint`);

    const tint = castGfx.match(/<Tint>([^<]*)<\/Tint>/)?.[1];
    assert.ok(tint, `${source}: EndSentinelForm CastGfx has no Tint -- the exit effect is back to blue`);
    const channels = parseInt(tint.replace(/^0x/i, ''), 16);
    const red = (channels >> 16) & 0xff;
    const green = (channels >> 8) & 0xff;
    const blue = channels & 0xff;
    assert.ok(
        red > green && red > blue,
        `${source}: EndSentinelForm CastGfx Tint ${tint} is not a red tint (r=${red} g=${green} b=${blue})`
    );
}

function run(): void {
    checkBuff(fs.readFileSync(XML_PATH, 'utf8'), 'PlayerBuffTypes.xml');
    checkEndFormTint(fs.readFileSync(POWER_XML_PATH, 'utf8'), 'PlayerPowerTypes.xml');

    // The served archive is what players load, and it is patched separately from the source XML.
    const swzPath = path.join(CBQ_DIR, 'Game.swz');
    if (fs.existsSync(swzPath)) {
        const { parseSwz } = require('../scripts/swzPatchUtils') as typeof import('../scripts/swzPatchUtils');
        const chunks = parseSwz(swzPath).chunks;

        const buffChunk = chunks.find((entry) => entry.xml.includes('<PlayerBuffTypes'));
        assert.ok(buffChunk, 'Game.swz carries no PlayerBuffTypes chunk');
        checkBuff(buffChunk.xml, 'Game.swz PlayerBuffTypes');

        const powerChunk = chunks.find((entry) => entry.xml.includes('<PlayerPowerTypes'));
        assert.ok(powerChunk, 'Game.swz carries no PlayerPowerTypes chunk');
        checkEndFormTint(powerChunk.xml, 'Game.swz PlayerPowerTypes');
    }

    if (fs.existsSync(SWF_PATH)) {
        const { parseSwf, parseAbc } = require('../scripts/swfPatchUtils') as typeof import('../scripts/swfPatchUtils');
        const abc = parseAbc(parseSwf(SWF_PATH));
        assert.ok(
            abc.stringValues.includes(BUFF_NAME),
            `DungeonBlitz.swf has no "${BUFF_NAME}" string -- the CombatState prologue that applies the buff is gone; re-run patch-dungeonblitz-sentinel-form-low-energy-fury.ts`
        );
    }

    console.log('sentinel_fury_low_energy_regression: ok');
}

run();
