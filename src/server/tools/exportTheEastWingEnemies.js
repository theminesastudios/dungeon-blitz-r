#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '../../..');
const serverDataDir = path.resolve(__dirname, '../data');
const swfPath = path.join(repoRoot, 'src/client/content/localhost/p/cbp/LevelsJC.swf');
const exportDir = path.join(repoRoot, 'build/ffdec-the-east-wing');
const outputPath = path.join(serverDataDir, 'dungeonSpawns/levelsJC_the_east_wing.enemies.json');
const ffdecCandidates = [
    process.env.FFDEC_PATH,
    '/Applications/FFDec.app/Contents/Resources/ffdec.sh',
    '/Applications/FFDec.app/Contents/MacOS/ffdec',
    'ffdec'
].filter(Boolean);

const target = {
    levelId: 'levelsJC',
    levelName: 'JC_Mini2',
    dungeonName: 'The East Wing',
    levelClass: 'a_Level_JCMini2',
    sourceSwf: 'src/client/content/localhost/p/cbp/LevelsJC.swf',
    roomClasses: [
        'a_Room_JCMini2_01',
        'a_Room_JCMini2_02',
        'a_Room_JCMini2_03',
        'a_Room_JCMini2_04'
    ],
    canonicalIdBase: 920000
};

class BitStream {
    constructor(buffer, byteOffset = 0) {
        this.buffer = buffer;
        this.bitOffset = byteOffset * 8;
    }

    readUnsigned(bitCount) {
        let value = 0;
        for (let index = 0; index < bitCount; index++) {
            const byte = this.buffer[this.bitOffset >> 3];
            const shift = 7 - (this.bitOffset & 7);
            value = (value << 1) | ((byte >> shift) & 1);
            this.bitOffset++;
        }
        return value;
    }

    readSigned(bitCount) {
        const value = this.readUnsigned(bitCount);
        const sign = 1 << (bitCount - 1);
        return (value & sign) ? value - (1 << bitCount) : value;
    }

    alignByte() {
        this.bitOffset = Math.ceil(this.bitOffset / 8) * 8;
    }

    get byteOffset() {
        return this.bitOffset >> 3;
    }
}

function resolveFfdec() {
    for (const candidate of ffdecCandidates) {
        if (path.isAbsolute(candidate) && fs.existsSync(candidate)) {
            return candidate;
        }

        const result = spawnSync(candidate, ['-help'], { encoding: 'utf8' });
        if (!result.error && result.status === 0) {
            return candidate;
        }
    }

    throw new Error('FFDec was not found. Set FFDEC_PATH or install FFDec.app.');
}

function runFfdecExport() {
    const ffdec = resolveFfdec();
    fs.rmSync(exportDir, { recursive: true, force: true });
    fs.mkdirSync(exportDir, { recursive: true });

    const classes = [target.levelClass, ...target.roomClasses].join(',');
    const result = spawnSync(ffdec, [
        '-cli',
        '-selectclass',
        classes,
        '-export',
        'script',
        exportDir,
        swfPath
    ], {
        cwd: repoRoot,
        encoding: 'utf8'
    });

    if (result.status !== 0) {
        throw new Error([
            `FFDec export failed with status ${result.status}.`,
            result.stdout,
            result.stderr
        ].filter(Boolean).join('\n'));
    }
}

function readActionScript(className) {
    const filePath = path.join(exportDir, 'scripts', `${className}.as`);
    if (!fs.existsSync(filePath)) {
        throw new Error(`Expected exported script not found: ${filePath}`);
    }
    return fs.readFileSync(filePath, 'utf8');
}

function parseStringLiteral(rawValue) {
    const quote = rawValue[0];
    const body = rawValue.slice(1, -1);
    return body.replace(/\\(['"\\])/g, '$1').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\t/g, '\t').replace(new RegExp(`\\\\${quote}`, 'g'), quote);
}

function getLineNumber(source, index) {
    return source.slice(0, index).split(/\r?\n/).length;
}

function getSymbolId(source, className) {
    const match = source.match(/\[Embed\([^\]]*symbol="symbol(\d+)"/);
    if (!match) {
        throw new Error(`Could not find Embed symbol id for ${className}`);
    }
    return Number(match[1]);
}

function parseRoomScript(className) {
    const source = readActionScript(className);
    const symbolId = getSymbolId(source, className);
    const fields = new Map();
    const declarationRegex = /public\s+var\s+([A-Za-z_$][\w$]*):ac_([A-Za-z_$][\w$]*)\s*;/g;
    let declaration;

    while ((declaration = declarationRegex.exec(source)) !== null) {
        fields.set(declaration[1], {
            sourceVar: declaration[1],
            type: declaration[2],
            sourceLine: getLineNumber(source, declaration.index),
            props: {}
        });
    }

    const assignmentRegex = /this\.([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\s*=\s*((?:"(?:\\.|[^"\\])*")|(?:'(?:\\.|[^'\\])*'))\s*;/g;
    let assignment;
    while ((assignment = assignmentRegex.exec(source)) !== null) {
        const field = fields.get(assignment[1]);
        if (!field) {
            continue;
        }
        field.props[assignment[2]] = parseStringLiteral(assignment[3]);
    }

    return {
        className,
        symbolId,
        roomId: Number(className.match(/_(\d+)$/)?.[1] ?? 0),
        fields: Array.from(fields.values())
    };
}

function loadEntTypes() {
    const entTypesPath = path.join(serverDataDir, 'EntTypes.json');
    const raw = JSON.parse(fs.readFileSync(entTypesPath, 'utf8').replace(/^\uFEFF/, ''));
    const rows = raw?.EntTypes?.EntType;
    if (!Array.isArray(rows)) {
        throw new Error(`Unexpected EntTypes shape in ${entTypesPath}`);
    }

    const byName = new Map();
    for (const row of rows) {
        if (row?.EntName) {
            byName.set(String(row.EntName), row);
        }
    }
    return byName;
}

function isHostileEntType(typeName, entTypes) {
    if (/TreasureChest|Chest|Dummy|Parrot|Helper|Objective|Target/i.test(typeName)) {
        return false;
    }

    const entType = entTypes.get(typeName) ?? {};
    const behavior = String(entType.Behavior ?? '');
    if (/TreasureChest|Dummy|Parrot|Helper|Objective|Target/i.test(behavior)) {
        return false;
    }

    const rank = String(entType.EntRank ?? '');
    const directEnemy = new Set(['Minion', 'Lieutenant', 'MiniBoss', 'Boss']);
    return directEnemy.has(rank) ||
        Number(entType.HitPoints ?? 0) > 0.5 ||
        Number(entType.ExpMult ?? 0) > 0 ||
        Number(String(entType.GoldDrop ?? '0').split(',')[0]) > 0;
}

function decompressSwf(filePath) {
    const raw = fs.readFileSync(filePath);
    const signature = raw.slice(0, 3).toString('ascii');
    if (signature === 'FWS') {
        return raw;
    }
    if (signature === 'CWS') {
        return Buffer.concat([raw.slice(0, 8), zlib.inflateSync(raw.slice(8))]);
    }
    throw new Error(`Unsupported SWF signature ${signature}`);
}

function skipRect(buffer, byteOffset) {
    const bits = new BitStream(buffer, byteOffset);
    const bitCount = bits.readUnsigned(5);
    bits.readSigned(bitCount);
    bits.readSigned(bitCount);
    bits.readSigned(bitCount);
    bits.readSigned(bitCount);
    bits.alignByte();
    return bits.byteOffset;
}

function readMatrix(buffer, byteOffset) {
    const bits = new BitStream(buffer, byteOffset);
    const matrix = {
        scaleX: 1,
        scaleY: 1,
        rotateSkew0: 0,
        rotateSkew1: 0,
        x: 0,
        y: 0
    };

    if (bits.readUnsigned(1)) {
        const bitCount = bits.readUnsigned(5);
        matrix.scaleX = bits.readSigned(bitCount) / 65536;
        matrix.scaleY = bits.readSigned(bitCount) / 65536;
    }
    if (bits.readUnsigned(1)) {
        const bitCount = bits.readUnsigned(5);
        matrix.rotateSkew0 = bits.readSigned(bitCount) / 65536;
        matrix.rotateSkew1 = bits.readSigned(bitCount) / 65536;
    }

    const translateBits = bits.readUnsigned(5);
    matrix.x = bits.readSigned(translateBits) / 20;
    matrix.y = bits.readSigned(translateBits) / 20;
    bits.alignByte();
    return { matrix, nextOffset: bits.byteOffset };
}

function skipColorTransformWithAlpha(buffer, byteOffset) {
    const bits = new BitStream(buffer, byteOffset);
    const hasAdd = bits.readUnsigned(1);
    const hasMult = bits.readUnsigned(1);
    const bitCount = bits.readUnsigned(4);
    if (hasMult) {
        bits.readSigned(bitCount);
        bits.readSigned(bitCount);
        bits.readSigned(bitCount);
        bits.readSigned(bitCount);
    }
    if (hasAdd) {
        bits.readSigned(bitCount);
        bits.readSigned(bitCount);
        bits.readSigned(bitCount);
        bits.readSigned(bitCount);
    }
    bits.alignByte();
    return bits.byteOffset;
}

function readCString(buffer, byteOffset) {
    let end = byteOffset;
    while (end < buffer.length && buffer[end] !== 0) {
        end++;
    }
    return {
        value: buffer.slice(byteOffset, end).toString('utf8'),
        nextOffset: end + 1
    };
}

function readTagHeader(buffer, byteOffset) {
    const raw = buffer.readUInt16LE(byteOffset);
    let nextOffset = byteOffset + 2;
    const code = raw >> 6;
    let length = raw & 0x3f;
    if (length === 0x3f) {
        length = buffer.readUInt32LE(nextOffset);
        nextOffset += 4;
    }
    return {
        code,
        length,
        bodyOffset: nextOffset,
        nextOffset: nextOffset + length
    };
}

function parsePlaceObject2(buffer, bodyOffset) {
    let offset = bodyOffset;
    const flags = buffer[offset++];
    const depth = buffer.readUInt16LE(offset);
    offset += 2;
    let characterId = null;
    let matrix = null;
    let name = '';

    if (flags & 0x02) {
        characterId = buffer.readUInt16LE(offset);
        offset += 2;
    }
    if (flags & 0x04) {
        const result = readMatrix(buffer, offset);
        matrix = result.matrix;
        offset = result.nextOffset;
    }
    if (flags & 0x08) {
        offset = skipColorTransformWithAlpha(buffer, offset);
    }
    if (flags & 0x10) {
        offset += 2;
    }
    if (flags & 0x20) {
        const result = readCString(buffer, offset);
        name = result.value;
        offset = result.nextOffset;
    }

    return {
        depth,
        characterId,
        matrix,
        name
    };
}

function parseSprites(buffer, startOffset, endOffset, sprites) {
    let offset = startOffset;
    while (offset < endOffset) {
        const tag = readTagHeader(buffer, offset);
        if (tag.code === 0) {
            break;
        }

        if (tag.code === 39) {
            const spriteId = buffer.readUInt16LE(tag.bodyOffset);
            const frameCount = buffer.readUInt16LE(tag.bodyOffset + 2);
            const placements = [];
            parseSpriteTags(buffer, tag.bodyOffset + 4, tag.nextOffset, sprites, placements);
            sprites.set(spriteId, { spriteId, frameCount, placements });
        }

        offset = tag.nextOffset;
    }
}

function parseSpriteTags(buffer, startOffset, endOffset, sprites, placements) {
    let offset = startOffset;
    while (offset < endOffset) {
        const tag = readTagHeader(buffer, offset);
        if (tag.code === 0) {
            break;
        }

        if (tag.code === 26) {
            placements.push(parsePlaceObject2(buffer, tag.bodyOffset));
        } else if (tag.code === 39) {
            const spriteId = buffer.readUInt16LE(tag.bodyOffset);
            const frameCount = buffer.readUInt16LE(tag.bodyOffset + 2);
            const childPlacements = [];
            parseSpriteTags(buffer, tag.bodyOffset + 4, tag.nextOffset, sprites, childPlacements);
            sprites.set(spriteId, { spriteId, frameCount, placements: childPlacements });
        }

        offset = tag.nextOffset;
    }
}

function parseSwfSprites(filePath) {
    const buffer = decompressSwf(filePath);
    let offset = skipRect(buffer, 8);
    offset += 4;
    const sprites = new Map();
    parseSprites(buffer, offset, buffer.length, sprites);
    return sprites;
}

function roundPosition(value) {
    return Math.round(Number(value) * 100) / 100;
}

function buildSpawnKey(enemy) {
    return [
        target.levelId,
        target.dungeonName.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase(),
        `room:${enemy.roomId}`,
        `index:${enemy.spawnIndex}`,
        `type:${enemy.type}`,
        `pos:${Math.round(enemy.x)}:${Math.round(enemy.y)}`
    ].join('|');
}

function buildRegistry() {
    runFfdecExport();

    const entTypes = loadEntTypes();
    const roomScripts = target.roomClasses.map(parseRoomScript);
    const levelScript = readActionScript(target.levelClass);
    const levelSymbolId = getSymbolId(levelScript, target.levelClass);
    const sprites = parseSwfSprites(swfPath);
    const levelSprite = sprites.get(levelSymbolId);
    if (!levelSprite) {
        throw new Error(`Could not find level sprite ${levelSymbolId}`);
    }

    const roomPlacementsByCharacterId = new Map();
    for (const placement of levelSprite.placements) {
        if (!placement.characterId || !placement.matrix) {
            continue;
        }
        roomPlacementsByCharacterId.set(placement.characterId, placement);
    }

    const enemies = [];
    for (const room of roomScripts) {
        const roomSprite = sprites.get(room.symbolId);
        const roomPlacement = roomPlacementsByCharacterId.get(room.symbolId);
        if (!roomSprite || !roomPlacement?.matrix) {
            throw new Error(`Missing room sprite placement for ${room.className} symbol ${room.symbolId}`);
        }

        const placementsByName = new Map(
            roomSprite.placements
                .filter((placement) => placement.name && placement.matrix)
                .map((placement) => [placement.name, placement])
        );

        for (const field of room.fields) {
            if (!isHostileEntType(field.type, entTypes)) {
                continue;
            }

            const placement = placementsByName.get(field.sourceVar);
            if (!placement?.matrix) {
                throw new Error(`Missing cue placement ${field.sourceVar} in ${room.className}`);
            }

            const entType = entTypes.get(field.type) ?? {};
            const rank = String(entType.EntRank ?? '');
            const boss = rank === 'Boss' || field.sourceVar === 'am_Boss';
            const enemy = {
                id: target.canonicalIdBase + enemies.length + 1,
                canonicalId: target.canonicalIdBase + enemies.length + 1,
                spawnIndex: enemies.length,
                type: field.type,
                name: field.type,
                x: roundPosition(roomPlacement.matrix.x + placement.matrix.x),
                y: roundPosition(roomPlacement.matrix.y + placement.matrix.y),
                roomId: room.roomId,
                groupId: null,
                waveId: null,
                triggerId: null,
                level: null,
                requiredForClear: true,
                boss,
                miniboss: rank === 'MiniBoss',
                scripted: false,
                sourceRoom: room.className,
                sourceVar: field.sourceVar,
                sourceLine: field.sourceLine,
                sourceSymbolId: room.symbolId,
                sourceCharacterId: placement.characterId,
                depth: placement.depth
            };

            const displayName = String(field.props.displayName ?? '').trim();
            if (displayName) {
                enemy.displayName = displayName;
            }
            if (boss) {
                enemy.roomBoss = true;
                enemy.isRoomBoss = true;
                enemy.displayName = enemy.displayName || field.type;
                enemy.roomBossName = enemy.displayName;
            }

            for (const key of [
                'characterName',
                'dramaAnim',
                'itemDrop',
                'sayOnActivate',
                'sayOnAlert',
                'sayOnBloodied',
                'sayOnDeath',
                'sayOnInteract',
                'sayOnSpawn',
                'sleepAnim'
            ]) {
                const value = String(field.props[key] ?? '').trim();
                if (value) {
                    enemy[key] = value;
                }
            }

            enemy.spawnKey = buildSpawnKey(enemy);
            enemies.push(enemy);
        }
    }

    return {
        levelId: target.levelId,
        levelName: target.levelName,
        dungeonName: target.dungeonName,
        source: {
            swf: target.sourceSwf,
            levelClass: target.levelClass,
            roomClasses: target.roomClasses,
            extractor: 'src/server/tools/exportTheEastWingEnemies.js'
        },
        generatedFromScript: true,
        coordinates: 'absolute world pixels from SWF room placement MATRIX plus enemy cue MATRIX',
        canonicalIdBase: target.canonicalIdBase,
        enemies
    };
}

function validateRegistry(registry) {
    const expectedCount = 5;
    if (registry.enemies.length !== expectedCount) {
        throw new Error(`Expected ${expectedCount} enemies, found ${registry.enemies.length}`);
    }

    const requiredCount = registry.enemies.filter((enemy) => enemy.requiredForClear).length;
    if (requiredCount !== expectedCount) {
        throw new Error(`Expected ${expectedCount} requiredForClear enemies, found ${requiredCount}`);
    }

    const bossCount = registry.enemies.filter((enemy) => enemy.boss || enemy.miniboss).length;
    if (bossCount !== 1) {
        throw new Error(`Expected one boss/miniboss, found ${bossCount}`);
    }

    const spawnKeys = new Set();
    const ids = new Set();
    for (const enemy of registry.enemies) {
        if (spawnKeys.has(enemy.spawnKey)) {
            throw new Error(`Duplicate spawnKey ${enemy.spawnKey}`);
        }
        if (ids.has(enemy.canonicalId)) {
            throw new Error(`Duplicate canonicalId ${enemy.canonicalId}`);
        }
        spawnKeys.add(enemy.spawnKey);
        ids.add(enemy.canonicalId);
    }
}

function main() {
    const registry = buildRegistry();
    validateRegistry(registry);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(registry, null, 2)}\n`);
    console.log(`[EastWingExport] wrote ${outputPath}`);
    console.log(`[EastWingExport] enemies=${registry.enemies.length} requiredForClear=${registry.enemies.filter((enemy) => enemy.requiredForClear).length} bosses=${registry.enemies.filter((enemy) => enemy.boss || enemy.miniboss).length}`);
}

main();
