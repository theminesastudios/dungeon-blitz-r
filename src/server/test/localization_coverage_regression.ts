import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { localizeUnknownTurkishText } from '../data/TurkishTextLocalizer';

type SwzEntry = {
    rootName: string;
    xml: string;
};

const VISIBLE_TAGS_BY_ROOT: Record<string, Set<string>> = {
    BuildingTypes: new Set(['DisplayName', 'UpgradeDescription']),
    ConsumableTypes: new Set(['Description', 'DisplayName']),
    CharmTypes: new Set(['Description', 'DisplayName']),
    DoorTypes: new Set(['LockedMessage']),
    DyeTypes: new Set(['DisplayName']),
    EggTypes: new Set(['DisplayName']),
    GearTypes: new Set(['Description', 'DisplayName']),
    LevelTypes: new Set(['DisplayName']),
    LockboxTypes: new Set(['Description', 'DisplayName']),
    MagicTypes: new Set(['Description', 'DisplayName']),
    MaterialTypes: new Set(['DisplayName']),
    MissionGroups: new Set(['DisplayName']),
    MissionTypes: new Set([
        'ActiveText',
        'Description',
        'DisplayName',
        'OfferText',
        'PraiseText',
        'PreReqText',
        'ProgressText',
        'ReturnText',
        'TrackerReturn',
        'TrackerText'
    ]),
    MonsterPowerTypes: new Set(['DisplayName']),
    MountTypes: new Set(['DisplayName']),
    PetTypes: new Set(['BonusInfo', 'DisplayName']),
    PlayerPowerTypes: new Set(['Description', 'DisplayName', 'UpgradeDescription']),
    PowerModTypes: new Set(['Description', 'DisplayName']),
    RoyalStoreTypes: new Set(['Description', 'DisplayName']),
    StatueTypes: new Set(['DisplayName', 'FlavorText'])
};

const POWER_TEXT_ROOTS = new Set(['MonsterPowerTypes', 'PlayerPowerTypes', 'PowerModTypes']);
const QUALITY_CHECK_ROOTS = new Set([
    'BuildingTypes',
    'ConsumableTypes',
    'GearTypes',
    'MaterialTypes',
    'PetTypes',
    'PlayerPowerTypes',
    'RoyalStoreTypes'
]);
const FORBIDDEN_VISIBLE_TEXT = [
    /\bTurkce aciklama\b/,
    /\bYerel Esya\b/,
    /\bYerel Yetenek\b/,
    /\bUnlocks\b/,
    /\btraining\b/,
    /\brecipes\b/,
    /\bguarantee\b/,
    /\bPotion\b/,
    /\bClones have\b/,
    /\bSpeed Penalty removed\b/,
    /\bDefense Penalty removed\b/,
    /\bDurability\b/,
    /\bCooldown\b/,
    /\bDefense Boost\b/,
    /\bHealth Regen\b/,
    /\bExplosion damage\b/,
    /\bExplosion\b/,
    /\bSaniye Bekleme\b/,
    /\bincreased Hate\b/,
    /\bfight with you\b/,
    /\bfollows you\b/,
    /\bthat follows\b/,
    /\bTetik used\b/,
    /\bEntangles\b/,
    /\breceived\b/,
    /\bCreatures\b/,
    /\bMax Can\b/,
    /\bOpening vurus\b/,
    /\bStealth Bonus\b/,
    /\bTrail\b/,
    /\bdebuffed\b/i,
    /\banother\b/,
    /\bAtilma Hasar\b/
];
const FORBIDDEN_GEAR_NAME_TEXT = /\b(?:Rapier|Offhand|Feet|Sash|Bio|Ice|Dress|Mummy|Jackal|Priest|Hulk|Giant|Scarab|Cyclops|Treant|Abom|Intro|Saber|Scepter|Nature|Shoes|Hands|Hood|Lockbox01|Sword30|Shield30|Armor30|Boots30|Gloves30|Hat30)\b/;

function rotateKey(key: number, shift: number): number {
    return (((key << (32 - shift)) >>> 0) | (key >>> shift)) >>> 0;
}

function decodeSwz(filePath: string): SwzEntry[] {
    const buffer = fs.readFileSync(filePath);
    let offset = 0;
    let key = buffer.readUInt32BE(offset) >>> 0;
    offset += 4;
    const count = buffer.readUInt32BE(offset);
    offset += 4;

    const entries: SwzEntry[] = [];
    for (let entryIndex = 0; entryIndex < count; entryIndex += 1) {
        const encodedLength = buffer.readUInt32BE(offset);
        offset += 4;
        const encoded = Buffer.alloc(encodedLength);

        for (let byteIndex = 0; byteIndex < encodedLength; byteIndex += 1) {
            const shift = byteIndex & 7;
            encoded[byteIndex] = buffer[offset++] ^ (key & 0xff);
            key = rotateKey(key, shift);
        }

        const xml = zlib.inflateSync(encoded).toString('utf8');
        entries.push({
            rootName: xml.match(/<([A-Za-z0-9_:-]+)/)?.[1] || '',
            xml
        });
    }

    return entries;
}

function decodeEntities(value: string): string {
    return value
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function normalizeValue(value: string): string {
    return decodeEntities(value).trim().replace(/\s+/g, ' ');
}

function visibleValues(xml: string, tags: Set<string>, englishOnly: boolean): string[] {
    const values: string[] = [];
    for (const match of xml.matchAll(/<([A-Za-z][A-Za-z0-9_]*)>([\s\S]*?)<\/\1>/g)) {
        const tagName = match[1];
        const value = normalizeValue(match[2]);
        if (!tags.has(tagName) || !value) {
            continue;
        }
        if (englishOnly && !/[A-Za-z]{2,}/.test(value)) {
            continue;
        }

        values.push(value);
    }

    return values;
}

function testGameSwzVisibleTextIsLocalized(): void {
    const root = path.resolve(__dirname, '../../..');
    const english = new Map(decodeSwz(path.join(root, 'src/client/content/localhost/p/cbq/Game.en.swz')).map((entry) => [entry.rootName, entry]));
    const turkish = new Map(decodeSwz(path.join(root, 'src/client/content/localhost/p/cbq/Game.tr.swz')).map((entry) => [entry.rootName, entry]));
    const unchanged: string[] = [];
    const nonAscii: string[] = [];
    const powerFallbacks: string[] = [];
    const lowQuality: string[] = [];

    for (const [rootName, tags] of Object.entries(VISIBLE_TAGS_BY_ROOT)) {
        const source = english.get(rootName);
        const target = turkish.get(rootName);
        if (!source || !target) {
            continue;
        }

        const allSourceValues = visibleValues(source!.xml, tags, false);
        const allTargetValues = visibleValues(target!.xml, tags, false);
        assert.equal(allTargetValues.length, allSourceValues.length, `${rootName} visible value count should stay stable`);

        for (let index = 0; index < allSourceValues.length; index += 1) {
            const sourceValue = allSourceValues[index];
            const targetValue = allTargetValues[index];
            if (!/[A-Za-z]{2,}/.test(sourceValue)) {
                continue;
            }
            if (sourceValue === targetValue) {
                unchanged.push(`${rootName}[${index}]: ${sourceValue}`);
            }
            if (/[çğıöşüÇĞİÖŞÜ]/.test(targetValue)) {
                nonAscii.push(`${rootName}[${index}]: ${targetValue}`);
            }
            if (POWER_TEXT_ROOTS.has(rootName) && /\b(?:Yerel Yetenek|Turkce aciklama)\b/.test(targetValue)) {
                powerFallbacks.push(`${rootName}[${index}]: ${targetValue}`);
            }
            if (QUALITY_CHECK_ROOTS.has(rootName) && FORBIDDEN_VISIBLE_TEXT.some((pattern) => pattern.test(targetValue))) {
                lowQuality.push(`${rootName}[${index}]: ${targetValue}`);
            }
        }
    }

    assert.deepEqual(unchanged.slice(0, 25), [], `visible Turkish SWZ values should not remain English: ${unchanged.slice(0, 25).join('\n')}`);
    assert.deepEqual(nonAscii.slice(0, 25), [], `Turkish SWZ values should be ASCII-safe: ${nonAscii.slice(0, 25).join('\n')}`);
    assert.deepEqual(powerFallbacks.slice(0, 25), [], `power text should not use placeholder fallback text: ${powerFallbacks.slice(0, 25).join('\n')}`);
    assert.deepEqual(lowQuality.slice(0, 25), [], `visible Turkish SWZ values should not contain known low-quality fragments: ${lowQuality.slice(0, 25).join('\n')}`);
}

function testStaticGearDisplayNamesAreLocalized(): void {
    const root = path.resolve(__dirname, '../../..');
    const gearXml = fs.readFileSync(path.join(root, 'src/client/content/xml/GearTypes.xml'), 'utf8');
    const badNames: string[] = [];
    for (const match of gearXml.matchAll(/<DisplayName>([\s\S]*?)<\/DisplayName>/g)) {
        const value = normalizeValue(match[1]);
        if (FORBIDDEN_GEAR_NAME_TEXT.test(value)) {
            badNames.push(value);
        }
    }

    assert.deepEqual(badNames.slice(0, 25), [], `static GearTypes display names should not contain raw English/code fragments: ${badNames.slice(0, 25).join('\n')}`);
}

function unescapeActionScriptString(value: string): string {
    return value
        .replace(/\\'/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\\\/g, '\\');
}

function addDialogueCandidate(raw: string, out: Set<string>): void {
    const value = unescapeActionScriptString(raw).trim();
    if (!/[A-Za-z]{2,}/.test(value)) {
        return;
    }

    for (const equalsPart of value.split('=')) {
        for (const colonPart of equalsPart.split(':')) {
            const clean = colonPart
                .replace(/^[@:]+/, '')
                .replace(/^(?:\s*<[^>]+>\s*)+/, '')
                .replace(/^\^t\s*/, '')
                .trim()
                .replace(/\s+/g, ' ');
            if (/[A-Za-z]{2,}/.test(clean)) {
                out.add(clean);
            }
        }
    }
}

function testExtractedDungeonDialogueCanBeLocalized(): void {
    const scriptRoot = path.resolve(__dirname, '../../../build/npc-dialogue-level-scripts/scripts');
    if (!fs.existsSync(scriptRoot)) {
        return;
    }

    const dialogueLines = new Set<string>();
    for (const file of fs.readdirSync(scriptRoot)) {
        if (!file.endsWith('.as')) {
            continue;
        }

        const source = fs.readFileSync(path.join(scriptRoot, file), 'utf8');
        for (const match of source.matchAll(/\.(sayOn(?:Activate|Alert|Bloodied|Death|Interact|Spawn))\s*=\s*"((?:\\.|[^"\\])*)"/g)) {
            addDialogueCandidate(match[2], dialogueLines);
        }
        for (const match of source.matchAll(/cutScene\w+\s*=\s*\[((?:.|\n)*?)\];/g)) {
            for (const stringMatch of match[1].matchAll(/"((?:\\.|[^"\\])*)"/g)) {
                const raw = unescapeActionScriptString(stringMatch[1]).trim();
                const cutscene = raw.match(/^\d+\s+([^\s]+)(?:\s+(.*))?$/);
                if (!cutscene || /^(Camera|SpawnCue)$/i.test(cutscene[1]) || !cutscene[2]) {
                    continue;
                }
                addDialogueCandidate(cutscene[2], dialogueLines);
            }
        }
    }

    const unchanged: string[] = [];
    const nonAscii: string[] = [];
    for (const line of dialogueLines) {
        const localized = localizeUnknownTurkishText(line);
        if (localized === line) {
            unchanged.push(line);
        }
        if (/[çğıöşüÇĞİÖŞÜ]/.test(localized)) {
            nonAscii.push(localized);
        }
    }

    assert.ok(dialogueLines.size > 1000, 'extracted dungeon dialogue inventory should be broad');
    assert.deepEqual(unchanged.slice(0, 25), [], `dungeon dialogue should not remain English: ${unchanged.slice(0, 25).join('\n')}`);
    assert.deepEqual(nonAscii.slice(0, 25), [], `dungeon dialogue should be ASCII-safe: ${nonAscii.slice(0, 25).join('\n')}`);
}

function main(): void {
    testGameSwzVisibleTextIsLocalized();
    testStaticGearDisplayNamesAreLocalized();
    testExtractedDungeonDialogueCanBeLocalized();
    console.log('localization_coverage_regression: ok');
}

main();
