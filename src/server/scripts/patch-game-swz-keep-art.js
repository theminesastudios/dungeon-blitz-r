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

const BUILDING_TYPES_ROOT = 'BuildingTypes';
const KEEP_BUILDING_ID = '12';
const KEEP_RANK = '0';
const DESTROYED_ART = 'a_Upgrade_Keep_5';
const REPAIRED_ART = 'a_Upgrade_Keep_0';

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
            '  node src/server/scripts/patch-game-swz-keep-art.js [--verify] [--swz <path>]',
            '',
            'Patches the client BuildingTypes resource inside Game.swz so',
            'the keep BuildingID=12 Rank=0 art uses a_Upgrade_Keep_0.'
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

function patchBuildingTypesXml(xml) {
    const keepEntryPattern =
        /(<Building\s+BuildingName="Keep">[\s\S]*?<BuildingID>12<\/BuildingID>[\s\S]*?<Rank>0<\/Rank>[\s\S]*?<Art>)([^<]+)(<\/Art>)/;
    const match = xml.match(keepEntryPattern);
    if (!match) {
        throw new Error('Could not find keep BuildingID=12 Rank=0 entry in BuildingTypes');
    }

    const currentArt = String(match[2] || '').trim();
    if (currentArt === REPAIRED_ART) {
        return { xml, changed: false, currentArt };
    }

    if (currentArt !== DESTROYED_ART) {
        throw new Error(`Unexpected keep art: ${currentArt}`);
    }

    return {
        xml: xml.replace(keepEntryPattern, `$1${REPAIRED_ART}$3`),
        changed: true,
        currentArt
    };
}

function readCurrentKeepArt(swzPath) {
    const decoded = decodeSwz(fs.readFileSync(swzPath));
    const buildingTypes = decoded.entries.find((entry) => entry.rootName === BUILDING_TYPES_ROOT);
    if (!buildingTypes) {
        throw new Error('BuildingTypes resource not found in Game.swz');
    }

    const keepEntryPattern =
        /<Building\s+BuildingName="Keep">[\s\S]*?<BuildingID>12<\/BuildingID>[\s\S]*?<Rank>0<\/Rank>[\s\S]*?<Art>([^<]+)<\/Art>/;
    const match = buildingTypes.xml.match(keepEntryPattern);
    if (!match) {
        throw new Error('Could not read current keep art from BuildingTypes');
    }

    return String(match[1] || '').trim();
}

function main() {
    const args = parseArgs(process.argv);
    const repoRoot = resolveRepoRoot();
    const swzPath = resolvePath(repoRoot, args.swz);

    if (!fs.existsSync(swzPath)) {
        throw new Error(`Game.swz not found: ${swzPath}`);
    }

    if (args.verify) {
        console.log(readCurrentKeepArt(swzPath));
        return;
    }

    const decoded = decodeSwz(fs.readFileSync(swzPath));
    const targetIndex = decoded.entries.findIndex((entry) => entry.rootName === BUILDING_TYPES_ROOT);
    if (targetIndex === -1) {
        throw new Error('BuildingTypes resource not found in Game.swz');
    }

    const patched = patchBuildingTypesXml(decoded.entries[targetIndex].xml);
    if (!patched.changed) {
        console.log(`[patch-game-swz-keep-art] keep art already ${REPAIRED_ART}`);
        return;
    }

    decoded.entries[targetIndex] = {
        ...decoded.entries[targetIndex],
        xml: patched.xml
    };

    fs.writeFileSync(swzPath, encodeSwz(decoded.initialKey, decoded.entries));
    console.log(
        `[patch-game-swz-keep-art] patched keep art ${patched.currentArt} -> ${REPAIRED_ART} in ${swzPath}`
    );
}

main();
