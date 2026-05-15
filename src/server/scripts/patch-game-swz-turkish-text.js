#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEFAULT_SWZ = path.join('src', 'client', 'content', 'localhost', 'p', 'cbq', 'Game.swz');
const DEFAULT_TR_SWZ = path.join('src', 'client', 'content', 'localhost', 'p', 'cbq', 'Game.tr.swz');
const XML_ROOT = path.join('src', 'client', 'content', 'xml');

const TRANSLATABLE_TAGS = new Set([
    'ActiveText',
    'Description',
    'DisplayName',
    'OfferText',
    'PraiseText',
    'ProgressText',
    'ReturnText',
    'TrackerReturn',
    'TrackerText',
    'UpgradeDescription'
]);

const MISSION_DIALOGUE_TAGS = new Set(['OfferText', 'ActiveText', 'ReturnText', 'PraiseText']);
const TRANSLATABLE_TAG_PATTERN = [...TRANSLATABLE_TAGS].join('|');
const TRANSLATABLE_TAG_REGEX = new RegExp(`<(${TRANSLATABLE_TAG_PATTERN})>([\\s\\S]*?)<\\/\\1>`, 'g');

function repoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function resolvePath(root, value) {
    if (value) {
        return path.isAbsolute(value) ? value : path.join(root, value);
    }

    const trSwzPath = path.join(root, DEFAULT_TR_SWZ);
    return fs.existsSync(trSwzPath) ? trSwzPath : path.join(root, DEFAULT_SWZ);
}

function rotateKey(key, shift) {
    return (((key << (32 - shift)) >>> 0) | (key >>> shift)) >>> 0;
}

function decodeSwz(buffer) {
    let offset = 0;
    const initialKey = buffer.readUInt32BE(offset);
    let key = initialKey >>> 0;
    offset += 4;
    const count = buffer.readUInt32BE(offset);
    offset += 4;

    const entries = [];
    for (let entryIndex = 0; entryIndex < count; entryIndex++) {
        const encodedLength = buffer.readUInt32BE(offset);
        offset += 4;
        const encoded = Buffer.alloc(encodedLength);

        for (let byteIndex = 0; byteIndex < encodedLength; byteIndex++) {
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

    return { initialKey, entries };
}

function encodeSwz(initialKey, entries) {
    const chunks = [];
    const header = Buffer.alloc(8);
    header.writeUInt32BE(initialKey >>> 0, 0);
    header.writeUInt32BE(entries.length >>> 0, 4);
    chunks.push(header);

    let key = initialKey >>> 0;
    for (const entry of entries) {
        const compressed = zlib.deflateSync(Buffer.from(entry.xml, 'utf8'));
        const length = Buffer.alloc(4);
        length.writeUInt32BE(compressed.length >>> 0, 0);
        chunks.push(length);

        const encoded = Buffer.alloc(compressed.length);
        for (let byteIndex = 0; byteIndex < compressed.length; byteIndex++) {
            const shift = byteIndex & 7;
            encoded[byteIndex] = compressed[byteIndex] ^ (key & 0xff);
            key = rotateKey(key, shift);
        }
        chunks.push(encoded);
    }

    return Buffer.concat(chunks);
}

function decodeEntities(value) {
    return String(value ?? '')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function escapeXmlText(value) {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function normalizeKey(value) {
    return decodeEntities(value).trim().replace(/\s+/g, ' ');
}

function normalizeUnsupportedTurkishGlyphs(value) {
    return String(value ?? '')
        .replace(/ğ/g, 'g')
        .replace(/Ğ/g, 'G')
        .replace(/ş/g, 's')
        .replace(/Ş/g, 'S');
}

function loadTranslations(root) {
    const dialoguePath = path.join(root, 'src', 'server', 'data', 'DialogueTranslations.tr.json');
    const missionPath = path.join(root, 'src', 'server', 'data', 'MissionDialogues.tr.json');
    const dialogueRaw = JSON.parse(fs.readFileSync(dialoguePath, 'utf8')).translations || {};
    const missionRaw = JSON.parse(fs.readFileSync(missionPath, 'utf8')).missions || {};
    const translations = new Map();

    for (const [source, target] of Object.entries(dialogueRaw)) {
        const key = normalizeKey(source);
        const value = String(target ?? '').trim();
        if (key && value) {
            translations.set(key, value);
        }
    }

    return { translations, missions: missionRaw };
}

function translateValue(value, translations) {
    const decoded = decodeEntities(value);
    const exact = translations.get(normalizeKey(decoded));
    if (exact) {
        return exact;
    }

    if (!/[=]/.test(decoded)) {
        return null;
    }

    let changed = false;
    const translated = decoded
        .split(/(=@|=)/)
        .map((part) => {
            if (part === '=' || part === '=@') {
                return part;
            }

            const replacement = translations.get(normalizeKey(part));
            if (!replacement) {
                return part;
            }

            changed = true;
            return replacement;
        })
        .join('');

    return changed ? translated : null;
}

function patchMissionTypes(xml, translations, missions, stats) {
    return xml.replace(/<MissionType>[\s\S]*?<\/MissionType>/g, (entry) => {
        const missionId = entry.match(/<MissionID>(\d+)<\/MissionID>/)?.[1] || '';
        const missionDialogue = missions[missionId] || {};

        return entry.replace(TRANSLATABLE_TAG_REGEX, (match, tagName, value) => {
            const translated = MISSION_DIALOGUE_TAGS.has(tagName) && missionDialogue[tagName]
                ? missionDialogue[tagName]
                : translateValue(value, translations);
            const nextValue = normalizeUnsupportedTurkishGlyphs(translated || decodeEntities(value));
            if (normalizeKey(nextValue) === normalizeKey(value)) {
                return match;
            }

            stats.updated += 1;
            stats.byTag[tagName] = (stats.byTag[tagName] || 0) + 1;
            return `<${tagName}>${escapeXmlText(nextValue)}</${tagName}>`;
        });
    });
}

function patchGenericXml(xml, translations, stats) {
    return xml.replace(TRANSLATABLE_TAG_REGEX, (match, tagName, value) => {
        const translated = translateValue(value, translations);
        const nextValue = normalizeUnsupportedTurkishGlyphs(translated || decodeEntities(value));
        if (normalizeKey(nextValue) === normalizeKey(value)) {
            return match;
        }

        stats.updated += 1;
        stats.byTag[tagName] = (stats.byTag[tagName] || 0) + 1;
        return `<${tagName}>${escapeXmlText(nextValue)}</${tagName}>`;
    });
}

function patchXmlResource(xml, rootName, translations, missions, stats) {
    if (rootName === 'MissionTypes') {
        return patchMissionTypes(xml, translations, missions, stats);
    }

    return patchGenericXml(xml, translations, stats);
}

function patchSwz(swzPath, translations, missions, verifyOnly) {
    const decoded = decodeSwz(fs.readFileSync(swzPath));
    const stats = { updated: 0, byTag: {} };
    const entries = decoded.entries.map((entry) => ({
        ...entry,
        xml: patchXmlResource(entry.xml, entry.rootName, translations, missions, stats)
    }));

    if (!verifyOnly && stats.updated > 0) {
        fs.writeFileSync(swzPath, encodeSwz(decoded.initialKey, entries));
    }

    return stats;
}

function patchStaticXml(xmlRoot, translations, missions, verifyOnly) {
    const stats = { updated: 0, byTag: {} };
    if (!fs.existsSync(xmlRoot)) {
        return stats;
    }

    for (const file of fs.readdirSync(xmlRoot)) {
        if (!file.endsWith('.xml')) {
            continue;
        }

        const filePath = path.join(xmlRoot, file);
        const xml = fs.readFileSync(filePath, 'utf8');
        const rootName = xml.match(/<([A-Za-z0-9_:-]+)/)?.[1] || path.basename(file, '.xml');
        const before = stats.updated;
        const patched = patchXmlResource(xml, rootName, translations, missions, stats);
        if (!verifyOnly && stats.updated !== before) {
            fs.writeFileSync(filePath, patched);
        }
    }

    return stats;
}

function parseArgs(argv) {
    const args = {
        swz: '',
        xmlRoot: XML_ROOT,
        verify: false
    };

    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--swz') {
            args.swz = argv[++index] || '';
            continue;
        }
        if (arg === '--xml-root') {
            args.xmlRoot = argv[++index] || '';
            continue;
        }
        if (arg === '--verify') {
            args.verify = true;
            continue;
        }
        throw new Error(`Unknown argument: ${arg}`);
    }

    return args;
}

function main() {
    const args = parseArgs(process.argv);
    const root = repoRoot();
    const { translations, missions } = loadTranslations(root);
    const swzPath = resolvePath(root, args.swz);
    const xmlRoot = resolvePath(root, args.xmlRoot);

    const swzStats = patchSwz(swzPath, translations, missions, args.verify);
    const xmlStats = patchStaticXml(xmlRoot, translations, missions, args.verify);
    console.log(JSON.stringify({ swz: swzStats, xml: xmlStats }, null, 2));
}

main();
