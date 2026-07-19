#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const GAME_VARIANTS = ['Game.swz', 'Game.en.swz', 'Game.tr.swz'];

function repoRoot() {
    return path.resolve(__dirname, '..', '..', '..');
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
        entries.push({ rootName: xml.match(/<([A-Za-z0-9_:-]+)/)?.[1] || '', xml });
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
        for (let byteIndex = 0; byteIndex < compressed.length; byteIndex += 1) {
            const shift = byteIndex & 7;
            encoded[byteIndex] = compressed[byteIndex] ^ (key & 0xff);
            key = rotateKey(key, shift);
        }
        chunks.push(encoded);
    }

    return Buffer.concat(chunks);
}

function patchStatueXml(xml) {
    let changed = 0;
    const patched = xml.replace(/<Statue\b[\s\S]*?<\/Statue>/g, (entry) => {
        const id = Number(entry.match(/<StatueID>(\d+)<\/StatueID>/)?.[1] || 0);
        if (id < 1 || id > 4) {
            return entry;
        }
        return entry.replace(/<FlavorText>([\s\S]*?)<\/FlavorText>/, (tag, flavorText) => {
            const next = flavorText.replace(/=/g, ':');
            if (next !== flavorText) {
                changed += 1;
            }
            return `<FlavorText>${next}</FlavorText>`;
        });
    });
    return { patched, changed };
}

function assertPatched(xml, label) {
    let verified = 0;
    xml.replace(/<Statue\b[\s\S]*?<\/Statue>/g, (entry) => {
        const id = Number(entry.match(/<StatueID>(\d+)<\/StatueID>/)?.[1] || 0);
        if (id < 1 || id > 4) {
            return entry;
        }
        const flavorText = entry.match(/<FlavorText>([\s\S]*?)<\/FlavorText>/)?.[1] || '';
        if (flavorText.includes('=') || !flavorText.includes(':')) {
            throw new Error(`${label}: leaderboard statue ${id} is not configured as a paced skit`);
        }
        verified += 1;
        return entry;
    });
    if (verified !== 4) {
        throw new Error(`${label}: expected four leaderboard statues, found ${verified}`);
    }
}

function patchSwz(filePath, verifyOnly) {
    const decoded = decodeSwz(fs.readFileSync(filePath));
    let statueXml = '';
    let changed = 0;
    const entries = decoded.entries.map((entry) => {
        if (entry.rootName !== 'StatueTypes') {
            return entry;
        }
        const result = patchStatueXml(entry.xml);
        statueXml = result.patched;
        changed += result.changed;
        return { ...entry, xml: result.patched };
    });
    if (!statueXml) {
        throw new Error(`${filePath}: StatueTypes resource not found`);
    }
    assertPatched(statueXml, filePath);
    if (!verifyOnly && changed > 0) {
        fs.writeFileSync(filePath, encodeSwz(decoded.initialKey, entries));
    }
    return changed;
}

const verifyOnly = process.argv.includes('--verify');
const root = repoRoot();
const looseXmlPath = path.join(root, 'src', 'client', 'content', 'xml', 'StatueTypes.xml');
const looseResult = patchStatueXml(fs.readFileSync(looseXmlPath, 'utf8'));
assertPatched(looseResult.patched, looseXmlPath);
if (!verifyOnly && looseResult.changed > 0) {
    fs.writeFileSync(looseXmlPath, looseResult.patched);
}

for (const name of GAME_VARIANTS) {
    const swzPath = path.join(root, 'src', 'client', 'content', 'localhost', 'p', 'cbq', name);
    patchSwz(swzPath, verifyOnly);
}

console.log(`Leaderboard statue dialogue patch ${verifyOnly ? 'verified' : 'applied'}.`);
