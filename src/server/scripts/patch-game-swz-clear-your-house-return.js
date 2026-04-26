#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const DEFAULT_TARGET = path.join(
    'src',
    'client',
    'content',
    'localhost',
    'p',
    'cbq',
    'Game.swz'
);

const MISSION_TYPES_ROOT = 'MissionTypes';
const MISSION_NAME = 'ClearYourHouse';
const RETURN_NAME = 'NR_Mayor01';
const TRACKER_RETURN = 'Tell the Mayor the keep is cleared';
const RETURN_TEXT = 'You cleared the old keep? Then it is yours. We will help make it a proper home again.=@Thank you, Mayor. I will put it to good use.';

function parseArgs(argv) {
    const args = {
        swz: '',
        verify: false
    };

    for (let index = 2; index < argv.length; index++) {
        const arg = argv[index];
        if (arg === '--swz' || arg === '-s') {
            args.swz = argv[++index] || '';
            continue;
        }
        if (arg === '--verify') {
            args.verify = true;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            printHelp();
            process.exit(0);
        }
        throw new Error(`Unknown argument: ${arg}`);
    }

    return args;
}

function printHelp() {
    console.log(
        [
            'Usage:',
            '  node src/server/scripts/patch-game-swz-clear-your-house-return.js [--verify] [--swz <path>]',
            '',
            'Patches the client MissionTypes resource inside Game.swz so',
            'I Claim This Keep turns in to NR_Mayor01.'
        ].join('\n')
    );
}

function resolveRepoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
}

function resolvePath(repoRoot, value) {
    if (!value) {
        return path.join(repoRoot, DEFAULT_TARGET);
    }
    return path.isAbsolute(value) ? value : path.join(repoRoot, value);
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
        const match = xml.match(/<([A-Za-z0-9_:-]+)/);
        entries.push({
            rootName: match ? match[1] : '',
            xml
        });
    }

    return {
        initialKey,
        entries
    };
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

function findClearYourHouseEntry(xml) {
    const pattern = /<MissionType>[\s\S]*?<MissionName>ClearYourHouse<\/MissionName>[\s\S]*?<\/MissionType>/;
    const match = xml.match(pattern);
    if (!match) {
        throw new Error(`Could not find ${MISSION_NAME} in MissionTypes`);
    }

    return {
        entry: match[0],
        start: match.index,
        end: match.index + match[0].length
    };
}

function ensureTag(entry, tagName, value, insertAfterTag) {
    const tagPattern = new RegExp(`\\s*<${tagName}>[\\s\\S]*?<\\/${tagName}>`);
    if (tagPattern.test(entry)) {
        return entry.replace(tagPattern, `\n\t\t<${tagName}>${value}</${tagName}>`);
    }

    const insertPattern = new RegExp(`(<${insertAfterTag}>[\\s\\S]*?<\\/${insertAfterTag}>)`);
    if (!insertPattern.test(entry)) {
        throw new Error(`Could not insert ${tagName}; ${insertAfterTag} not found`);
    }

    return entry.replace(insertPattern, `$1\n\t\t<${tagName}>${value}</${tagName}>`);
}

function patchMissionTypesXml(xml) {
    const { entry, start, end } = findClearYourHouseEntry(xml);
    let nextEntry = entry;

    nextEntry = ensureTag(nextEntry, 'ReturnName', RETURN_NAME, 'ContactName');
    nextEntry = ensureTag(nextEntry, 'TrackerReturn', TRACKER_RETURN, 'TrackerText');
    nextEntry = ensureTag(nextEntry, 'ReturnText', RETURN_TEXT, 'ActiveText');

    if (nextEntry === entry) {
        return { xml, changed: false };
    }

    return {
        xml: `${xml.slice(0, start)}${nextEntry}${xml.slice(end)}`,
        changed: true
    };
}

function readCurrentReturn(swzPath) {
    const decoded = decodeSwz(fs.readFileSync(swzPath));
    const missionTypes = decoded.entries.find((entry) => entry.rootName === MISSION_TYPES_ROOT);
    if (!missionTypes) {
        throw new Error('MissionTypes resource not found in Game.swz');
    }

    const { entry } = findClearYourHouseEntry(missionTypes.xml);
    const returnName = entry.match(/<ReturnName>([^<]*)<\/ReturnName>/)?.[1] || '';
    const trackerReturn = entry.match(/<TrackerReturn>([^<]*)<\/TrackerReturn>/)?.[1] || '';
    const returnText = entry.match(/<ReturnText>([^<]*)<\/ReturnText>/)?.[1] || '';
    return { returnName, trackerReturn, returnText };
}

function main() {
    const args = parseArgs(process.argv);
    const repoRoot = resolveRepoRoot();
    const swzPath = resolvePath(repoRoot, args.swz);

    if (!fs.existsSync(swzPath)) {
        throw new Error(`Game.swz not found: ${swzPath}`);
    }

    if (args.verify) {
        console.log(JSON.stringify(readCurrentReturn(swzPath), null, 2));
        return;
    }

    const decoded = decodeSwz(fs.readFileSync(swzPath));
    const targetIndex = decoded.entries.findIndex((entry) => entry.rootName === MISSION_TYPES_ROOT);
    if (targetIndex === -1) {
        throw new Error('MissionTypes resource not found in Game.swz');
    }

    const patched = patchMissionTypesXml(decoded.entries[targetIndex].xml);
    if (!patched.changed) {
        console.log(`[patch-game-swz-clear-your-house-return] ${MISSION_NAME} already returns to ${RETURN_NAME}`);
        return;
    }

    decoded.entries[targetIndex] = {
        ...decoded.entries[targetIndex],
        xml: patched.xml
    };

    fs.writeFileSync(swzPath, encodeSwz(decoded.initialKey, decoded.entries));
    console.log(
        `[patch-game-swz-clear-your-house-return] patched ${MISSION_NAME} return metadata in ${swzPath}`
    );
}

main();
