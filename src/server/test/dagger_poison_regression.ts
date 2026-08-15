/// <reference types="node" />

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// PoisonDagger / PoisonDagger1 apply DaggerPoison instead of ViperbladePoison, and the
// DaggerPoison buff itself carries 0.5 DoT per tick and 8 stacks. The dagger icon is three
// halves that are useless apart:
//
//   data  DaggerPoison's BuffIcon names the a_StatusIcon_AttackUp category -- the category
//         selector that makes the entity readout (Entity.method_1667) draw an icon at all
//         (patch_gameswz_dagger_poison.ts)
//   code  BuffType.method_1811's AttackUp case instantiates a_StatusIcon_PoisonDagger
//         instead of a_StatusIcon_AttackUp (patch-dungeonblitz-dagger-poison-icon.ts)
//   art   UI_1.swf exports a_StatusIcon_PoisonDagger, a 0.48-scale clone of the full-size
//         power icon a_PowerIcon_PoisonDagger, so the readout icon matches the ~19px
//         a_StatusIcon_* family without shrinking the hotbar's power button, which
//         rasterizes the original sprite at natural size
//         (patch-dungeonblitz-ui1-dagger-icon-scale.ts)
//
// The served Game.swz is patched separately from the loose XML, so both copies are checked
// here to catch a half-applied patch (see buff_data_client_load_regression for the pattern).
// a_StatusIcon_AttackUp must stay unique to DaggerPoison: any other buff that takes the
// category would silently render the dagger icon too, which the guard below fails on.
const XML_DIR = path.resolve(__dirname, '..', '..', 'client', 'content', 'xml');
const CBQ_DIR = path.resolve(__dirname, '..', '..', 'client', 'content', 'localhost', 'p', 'cbq');
const CBP_DIR = path.resolve(__dirname, '..', '..', 'client', 'content', 'localhost', 'p', 'cbp');
const SWF_PATH = path.join(CBP_DIR, 'DungeonBlitz.swf');
const UI1_PATH = path.join(CBP_DIR, 'UI_1.swf');

const DAGGER_POWERS = ['PoisonDagger', 'PoisonDagger1'];
const BUFF_ICON = 'a_StatusIcon_AttackUp';
const DAGGER_ICON_CLASS = 'a_StatusIcon_PoisonDagger';
const FULL_SIZE_ICON_CLASS = 'a_PowerIcon_PoisonDagger';
/** The clone must measure ~SCALE x the source sprite so the icon is ~19px tall. */
const CLONE_SCALE = 0.48;

function checkBuffs(xml: string, source: string): void {
    const block = xml.match(/<BuffType BuffName="DaggerPoison">[\s\S]*?<\/BuffType>/)?.[0];
    assert.ok(block, `${source}: DaggerPoison BuffType missing`);

    const field = (tag: string): string | undefined =>
        block?.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];

    assert.equal(field('DoTDamage'), '0.5', `${source}: DaggerPoison DoTDamage`);
    assert.equal(field('StackCount'), '8', `${source}: DaggerPoison StackCount`);
    assert.equal(field('BuffIcon'), BUFF_ICON, `${source}: DaggerPoison BuffIcon`);

    // Concentrated Venom's DoT multiplier keys on <Effect>Poisoned</Effect> (Buff.method_1572),
    // so the category change must not have displaced it.
    assert.equal(field('Effect'), 'Poisoned', `${source}: DaggerPoison Effect`);
}

function checkPowers(xml: string, source: string): void {
    for (const power of DAGGER_POWERS) {
        const block = xml.match(new RegExp(`<Power PowerName="${power}">[\\s\\S]*?</Power>`))?.[0];
        assert.ok(block, `${source}: ${power} Power missing`);

        const targetBuff = block?.match(/<AddTargetBuff>([^<]*)<\/AddTargetBuff>/)?.[1];
        assert.equal(targetBuff, 'DaggerPoison', `${source}: ${power} AddTargetBuff`);
    }

    assert.equal(
        (xml.match(/<AddTargetBuff>ViperbladePoison<\/AddTargetBuff>/g) ?? []).length,
        0,
        `${source}: no power should still target ViperbladePoison`
    );
}

// The AttackUp category is repointed at the dagger icon in method_1811, so it must never be
// claimed by another buff: every other a_StatusIcon_* occurrence is fine, this one is not.
function checkIconExclusive(xml: string, source: string): void {
    for (const block of xml.match(/<BuffType BuffName="([^"]*)">[\s\S]*?<\/BuffType>/g) ?? []) {
        const name = block.match(/BuffName="([^"]*)"/)?.[1];
        if (name === 'DaggerPoison') continue;
        const icons = block.match(/<BuffIcon>([^<]*)<\/BuffIcon>/g) ?? [];
        for (const entry of icons) {
            for (const icon of entry.replace(/<\/?BuffIcon>/g, '').split(',')) {
                assert.notEqual(
                    icon,
                    BUFF_ICON,
                    `${source}: ${name} uses ${BUFF_ICON}, which now renders the dagger icon`
                );
            }
        }
    }
}

interface Bounds { xMin: number; xMax: number; yMin: number; yMax: number }

function scaledCloneMatches(source: Bounds, clone: Bounds): boolean {
    const tolerance = 3; // twips, for fixed-point rounding
    return (
        Math.abs(clone.xMin - source.xMin * CLONE_SCALE) <= tolerance &&
        Math.abs(clone.xMax - source.xMax * CLONE_SCALE) <= tolerance &&
        Math.abs(clone.yMin - source.yMin * CLONE_SCALE) <= tolerance &&
        Math.abs(clone.yMax - source.yMax * CLONE_SCALE) <= tolerance
    );
}

function checkUi1Clone(): void {
    if (!fs.existsSync(UI1_PATH)) return;
    const {
        readSwfFile, readSymbolClasses, characterTagsById, characterBounds,
    } = require('../scripts/swfLevelUtils') as typeof import('../scripts/swfLevelUtils');
    const ui1 = readSwfFile(UI1_PATH);
    const symbols = readSymbolClasses(ui1);
    const byId = characterTagsById(ui1);

    const source = symbols.find((binding) => binding.name === FULL_SIZE_ICON_CLASS);
    assert.ok(source, `UI_1.swf lost the full-size ${FULL_SIZE_ICON_CLASS} export`);
    const sourceBounds = characterBounds(ui1, source.id);
    assert.ok(sourceBounds, `UI_1.swf cannot measure ${FULL_SIZE_ICON_CLASS}`);

    const clone = symbols.find((binding) => binding.name === DAGGER_ICON_CLASS);
    assert.ok(
        clone,
        `UI_1.swf has no ${DAGGER_ICON_CLASS} export -- re-run patch-dungeonblitz-ui1-dagger-icon-scale.ts`
    );
    assert.notEqual(clone.id, source.id, `${DAGGER_ICON_CLASS} must be a distinct character`);
    const cloneBounds = characterBounds(ui1, clone.id);
    assert.ok(cloneBounds, `UI_1.swf cannot measure ${DAGGER_ICON_CLASS}`);
    assert.ok(
        scaledCloneMatches(sourceBounds, cloneBounds),
        `${DAGGER_ICON_CLASS} is not the ${CLONE_SCALE}x-scaled clone of ${FULL_SIZE_ICON_CLASS} ` +
            `(source ${JSON.stringify(sourceBounds)}, clone ${JSON.stringify(cloneBounds)})`
    );

    // The clone must render about the size of the a_StatusIcon_* family (~19px), not the
    // full-size power icon (~34x40px).
    const heightPx = (cloneBounds.yMax - cloneBounds.yMin) / 20;
    const widthPx = (cloneBounds.xMax - cloneBounds.xMin) / 20;
    assert.ok(heightPx <= 24, `${DAGGER_ICON_CLASS} renders ${heightPx.toFixed(1)}px tall; expected ~19px`);
    assert.ok(widthPx >= 12, `${DAGGER_ICON_CLASS} renders ${widthPx.toFixed(1)}px wide; expected ~16px`);
    console.log(`dagger_poison_regression: UI_1 ${DAGGER_ICON_CLASS} renders ${widthPx.toFixed(1)}x${heightPx.toFixed(1)}px`);
}

function run(): void {
    checkBuffs(fs.readFileSync(path.join(XML_DIR, 'PlayerBuffTypes.xml'), 'utf8'), 'PlayerBuffTypes.xml');
    checkPowers(fs.readFileSync(path.join(XML_DIR, 'PlayerPowerTypes.xml'), 'utf8'), 'PlayerPowerTypes.xml');
    checkIconExclusive(fs.readFileSync(path.join(XML_DIR, 'PlayerBuffTypes.xml'), 'utf8'), 'PlayerBuffTypes.xml');

    const swzPath = path.join(CBQ_DIR, 'Game.swz');
    if (fs.existsSync(swzPath)) {
        const { parseSwz } = require('../scripts/swzPatchUtils') as typeof import('../scripts/swzPatchUtils');
        const chunks = parseSwz(swzPath).chunks;
        const buffChunk = chunks.find((entry) => entry.xml.includes('<PlayerBuffTypes'));
        assert.ok(buffChunk, 'Game.swz carries no PlayerBuffTypes chunk');
        checkBuffs(buffChunk.xml, 'Game.swz PlayerBuffTypes');
        checkIconExclusive(buffChunk.xml, 'Game.swz PlayerBuffTypes');

        const powerChunk = chunks.find((entry) => entry.xml.includes('<PlayerPowerTypes'));
        assert.ok(powerChunk, 'Game.swz carries no PlayerPowerTypes chunk');
        checkPowers(powerChunk.xml, 'Game.swz PlayerPowerTypes');
    }

    checkUi1Clone();

    // The byte check itself lives in the patch script's --verify; the probe below is the
    // cheap pairing guard (same shape as sentinel_fury_low_energy_regression).
    if (fs.existsSync(SWF_PATH)) {
        const { parseSwf, parseAbc, disassemble, classIndexByName, methodIdxForTrait } =
            require('../scripts/swfPatchUtils') as typeof import('../scripts/swfPatchUtils');
        const ctx = parseSwf(SWF_PATH);
        const abc = parseAbc(ctx);
        const daggerIndex = abc.stringValues.indexOf(DAGGER_ICON_CLASS);
        assert.ok(
            daggerIndex >= 0,
            `DungeonBlitz.swf has no "${DAGGER_ICON_CLASS}" string -- the readout icon repoint is gone; re-run patch-dungeonblitz-dagger-poison-icon.ts`
        );

        const classIdx = classIndexByName(abc, 'BuffType');
        assert.ok(classIdx !== null, 'DungeonBlitz.swf lost the BuffType class');
        const methodIdx = methodIdxForTrait(
            [...abc.instances[classIdx].traits, ...(abc.classTraits[classIdx] ?? [])],
            abc,
            'method_1811'
        );
        assert.ok(methodIdx !== null, 'DungeonBlitz.swf lost BuffType.method_1811');
        const body = abc.methodBodies.get(methodIdx);
        assert.ok(body, 'DungeonBlitz.swf lost BuffType.method_1811 body');
        const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
        const instructions = disassemble(code, 'BuffType.method_1811');
        const pushed = instructions
            .filter((instruction) => instruction.opcode === 0x2c)
            .map((instruction) => abc.stringValues[instruction.operands[0]?.[1] ?? 0]);
        assert.equal(
            pushed.filter((name) => name === DAGGER_ICON_CLASS).length,
            1,
            'method_1811 must instantiate the scaled dagger class exactly once'
        );
        assert.equal(
            pushed.filter((name) => name === BUFF_ICON).length,
            0,
            'method_1811 must no longer push the vanilla AttackUp icon'
        );
    }

    console.log('dagger_poison_regression: ok');
}

run();
