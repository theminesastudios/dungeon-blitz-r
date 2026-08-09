import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { BuildingID, MasterClassID } from '../core/Enums';
import { buildDungeonBlitzSwfVariantBuffer } from '../core/DungeonBlitzSwf';
import { BuildingHandler } from '../handlers/BuildingHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import {
    classIndexByName,
    disassemble,
    methodIdxForTrait,
    parseAbc,
    parseSwf,
    readU30,
    u30OperandName
} from '../scripts/swfPatchUtils';

type SwfTag = { code: number; data: Buffer };
type SentPacket = { id: number; payload: Buffer };
type ScheduledTimer = { callback: () => void; delayMs: number };

function splitTags(buffer: Buffer, start: number): SwfTag[] {
    const tags: SwfTag[] = [];
    let offset = start;
    while (offset + 2 <= buffer.length) {
        const header = buffer.readUInt16LE(offset);
        offset += 2;
        const code = header >> 6;
        let length = header & 0x3f;
        if (length === 0x3f) {
            length = buffer.readUInt32LE(offset);
            offset += 4;
        }
        assert.ok(offset + length <= buffer.length, `SWF tag ${code} must stay within the file`);
        tags.push({ code, data: buffer.subarray(offset, offset + length) });
        offset += length;
        if (code === 0) break;
    }
    return tags;
}

function readLevelsHome(): { tags: SwfTag[]; symbols: Map<number, string> } {
    const swfPath = path.resolve(__dirname, '../../client/content/localhost/p/cbp/LevelsHome.swf');
    const raw = fs.readFileSync(swfPath);
    const signature = raw.subarray(0, 3).toString('ascii');
    assert.ok(signature === 'CWS' || signature === 'FWS');
    const body = signature === 'CWS' ? zlib.inflateSync(raw.subarray(8)) : raw.subarray(8);
    assert.equal(raw.readUInt32LE(4), body.length + 8, 'LevelsHome SWF FileLength must be valid');

    const rectBits = body[0] >> 3;
    const tags = splitTags(body, Math.ceil((5 + rectBits * 4) / 8) + 4);
    const symbols = new Map<number, string>();
    for (const tag of tags.filter((candidate) => candidate.code === 76)) {
        let offset = 0;
        const count = tag.data.readUInt16LE(offset);
        offset += 2;
        for (let index = 0; index < count; index += 1) {
            const characterId = tag.data.readUInt16LE(offset);
            offset += 2;
            const nameStart = offset;
            while (tag.data[offset] !== 0) offset += 1;
            symbols.set(characterId, tag.data.subarray(nameStart, offset).toString('utf8'));
            offset += 1;
        }
    }
    return { tags, symbols };
}

function placedCharacter(tag: SwfTag): { depth: number; characterId: number } | null {
    if (tag.code !== 26 && tag.code !== 70) return null;
    const flags = tag.data[0];
    const flags2 = tag.code === 70 ? tag.data[1] : 0;
    let offset = tag.code === 70 ? 2 : 1;
    const depth = tag.data.readUInt16LE(offset);
    offset += 2;
    if (tag.code === 70 && (flags2 & 0x08) !== 0) {
        while (tag.data[offset] !== 0) offset += 1;
        offset += 1;
    }
    return (flags & 0x02) !== 0 ? { depth, characterId: tag.data.readUInt16LE(offset) } : null;
}

function placedCharacterId(tag: SwfTag): number | null {
    return placedCharacter(tag)?.characterId ?? null;
}

function characterFramesAtDepths(
    sprite: { frameCount: number; tags: SwfTag[] },
    depths: readonly number[]
): Map<number, number>[] {
    const active = new Map<number, number>();
    const frames: Map<number, number>[] = [];
    for (const tag of sprite.tags) {
        const place = placedCharacter(tag);
        if (place && depths.includes(place.depth)) active.set(place.depth, place.characterId);
        if (tag.code === 28 && tag.data.length >= 2) active.delete(tag.data.readUInt16LE(0));
        if (tag.code === 1) frames.push(new Map(active));
    }
    assert.equal(frames.length, sprite.frameCount);
    return frames;
}

function assertAuthoredFinalTowerTimelines(): void {
    const { tags, symbols } = readLevelsHome();
    const spriteById = new Map<number, { frameCount: number; tags: SwfTag[] }>();
    for (const tag of tags.filter((candidate) => candidate.code === 39)) {
        spriteById.set(tag.data.readUInt16LE(0), {
            frameCount: tag.data.readUInt16LE(2),
            tags: splitTags(tag.data, 4)
        });
    }

    const idFor = (name: string): number => {
        const entry = [...symbols.entries()].find(([, candidate]) => candidate === name);
        assert.ok(entry, `${name} must remain linked in LevelsHome.swf`);
        return entry[0];
    };

    const justicar = spriteById.get(idFor('a_Animation_Justicar10'));
    assert.ok(justicar);
    assert.equal(justicar.frameCount, 16);
    const justicarChildren = justicar.tags.map(placedCharacterId).filter((id): id is number => id !== null);
    const justicarFlameA = spriteById.get(908);
    const justicarFlameB = spriteById.get(917);
    assert.ok(justicarFlameA);
    assert.ok(justicarFlameB);
    const justicarFlameAFrames = characterFramesAtDepths(justicarFlameA, [3]).map((frame) => frame.get(3));
    const justicarFlameBFrames = characterFramesAtDepths(justicarFlameB, [2]).map((frame) => frame.get(2));
    assert.equal(new Set(justicarFlameAFrames).size, 8);
    assert.equal(new Set(justicarFlameBFrames).size, 8);
    const justicarFrames = characterFramesAtDepths(justicar, [2, 6, 10, 13]);
    for (let frame = 0; frame < justicar.frameCount; frame += 1) {
        for (const depth of [2, 6]) {
            assert.equal(
                justicarFrames[frame].get(depth),
                justicarFlameAFrames[frame],
                `Justicar flame type A at depth ${depth} must advance with frame ${frame + 1}`
            );
        }
        for (const depth of [10, 13]) {
            assert.equal(
                justicarFrames[frame].get(depth),
                justicarFlameBFrames[frame],
                `Justicar flame type B at depth ${depth} must advance with frame ${frame + 1}`
            );
        }
    }
    assert.equal(justicarChildren.includes(908), false, 'Justicar must not retain nested flame sprite 908');
    assert.equal(justicarChildren.includes(917), false, 'Justicar must not retain nested flame sprite 917');
    assert.equal(justicarChildren.includes(idFor('Flameloops01copy')), false);
    assert.equal(justicarChildren.includes(idFor('Flameloops02copy')), false);

    const templar = spriteById.get(idFor('a_Animation_Templar_Final'));
    assert.ok(templar);
    assert.equal(templar.frameCount, 20);
    assert.deepEqual(
        [...symbols.values()].filter((name) =>
            name.includes('Castle') && name.includes('Fire') && name.includes('White')
        ),
        ['a_Animation_CastleFireWhite'],
        'The Castle+Fire+White runtime selector must identify only Templar\'s four small flames'
    );
    const buildingTypes = fs.readFileSync(
        path.resolve(__dirname, '../../client/content/xml/BuildingTypes.xml'),
        'utf8'
    );
    const artNames = [...buildingTypes.matchAll(/<Art>([^<]+)<\/Art>/g)].map((match) => match[1]);
    assert.deepEqual(
        artNames.filter((name) => name.includes('Templar') && name.includes('Final')),
        ['a_Upgrade_Tower_TemplarFinal'],
        'Templar+Final must identify only the final Templar building art'
    );
    const castleFireId = idFor('a_Animation_CastleFireWhite');
    const castleFire = spriteById.get(castleFireId);
    assert.ok(castleFire);
    assert.equal(castleFire.frameCount, 16);
    const sourceFlameFrames = characterFramesAtDepths(castleFire, [4]).map((frame) => frame.get(4));
    assert.equal(new Set(sourceFlameFrames).size, 8, 'CastleFireWhite must retain its eight static flame drawings');
    const flameDepths = [7, 13, 19, 25] as const;
    const templarFlameFrames = characterFramesAtDepths(templar, flameDepths);
    for (let frame = 0; frame < templar.frameCount; frame += 1) {
        for (const depth of flameDepths) {
            assert.equal(
                templarFlameFrames[frame].get(depth),
                sourceFlameFrames[frame % sourceFlameFrames.length],
                `Templar flame at depth ${depth} must advance with parent frame ${frame + 1}`
            );
        }
    }
    assert.equal(
        templar.tags.map(placedCharacterId).includes(castleFireId),
        false,
        'Templar final must not leave nested flame MovieClips for SuperAnim to freeze'
    );
}

function assertRuntimePreservesLargeTowerEffects(): void {
    const swfPath = path.resolve(__dirname, '../../client/content/localhost/p/cbp/DungeonBlitz.swf');
    const context = parseSwf(swfPath);
    const abc = parseAbc(context);
    const classIndex = classIndexByName(abc, 'SuperAnimData');
    assert.notEqual(classIndex, null);
    const methodIndex = methodIdxForTrait(abc.classTraits[classIndex!], abc, 'method_200');
    assert.notEqual(methodIndex, null);
    const methodBody = abc.methodBodies.get(methodIndex!);
    assert.ok(methodBody);

    const code = context.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const pushedIntValues = disassemble(code, 'SuperAnimData.method_200')
        .filter((instruction) => instruction.opcode === 0x2d)
        .map((instruction) => abc.intValues[instruction.operands[0][1]]);

    assert.ok(
        pushedIntValues.filter((value) => value === 16777215).length >= 2,
        'Both tower-effect BitmapData paths must retain Flash Player\'s full valid pixel area'
    );
    assert.equal(
        pushedIntValues.includes(16384),
        false,
        'Valid large tower effects must not be collapsed into the old 128x128 fallback cache'
    );
}

function assertRuntimeRetriesTransientTowerFrames(): void {
    const swfPath = path.resolve(__dirname, '../../client/content/localhost/p/cbp/DungeonBlitz.swf');
    const context = parseSwf(swfPath);
    const abc = parseAbc(context);
    const classIndex = classIndexByName(abc, 'Game');
    assert.notEqual(classIndex, null);
    const methodIndex = methodIdxForTrait(abc.instances[classIndex!].traits, abc, 'method_1325');
    assert.notEqual(methodIndex, null);
    const methodBody = abc.methodBodies.get(methodIndex!);
    assert.ok(methodBody);
    assert.ok(methodBody.exceptions.length > 0, 'SuperAnim render tick must retain its crash guard');

    const catchOffset = Math.min(...methodBody.exceptions.map((exception) => exception.target));
    const methodCode = context.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const catchNames = disassemble(methodCode.subarray(catchOffset), 'Game.method_1325.catch')
        .map((instruction) => u30OperandName(instruction, abc.multinameNames))
        .filter((name): name is string => name !== null);

    assert.ok(catchNames.includes('var_1220'), 'Transient bitmap failures must release the SuperAnim render lock');
    assert.equal(
        catchNames.includes('DestroySuperAnimInstance'),
        false,
        'A transient Home reload failure must not permanently destroy the tower animation'
    );
    assert.equal(
        catchNames.includes('splice'),
        false,
        'A transient Home reload failure must keep the tower animation registered for the next frame'
    );
}

function localIndex(instruction: ReturnType<typeof disassemble>[number] | undefined): number | null {
    if (!instruction) return null;
    if (instruction.opcode >= 0xd0 && instruction.opcode <= 0xd3) {
        return instruction.opcode - 0xd0;
    }
    if (instruction.opcode === 0x62 || instruction.opcode === 0x63) {
        return instruction.operands[0]?.[1] ?? null;
    }
    return null;
}

function assertOnlyTemplarCastleFiresUseLiveSuperAnimFallback(): void {
    const swfPath = path.resolve(__dirname, '../../client/content/localhost/p/cbp/DungeonBlitz.swf');
    const context = parseSwf(swfPath);
    const abc = parseAbc(context);

    const levelClassIndex = classIndexByName(abc, 'Level');
    assert.notEqual(levelClassIndex, null);
    const replacementMethodIndex = methodIdxForTrait(
        abc.instances[levelClassIndex!].traits,
        abc,
        'method_1806'
    );
    assert.notEqual(replacementMethodIndex, null);
    const replacementBody = abc.methodBodies.get(replacementMethodIndex!);
    assert.ok(replacementBody);
    const replacementCode = context.body.subarray(
        replacementBody.codeStart,
        replacementBody.codeStart + replacementBody.codeLen
    );
    const replacementInstructions = disassemble(replacementCode, 'Level.method_1806');
    assert.equal(
        replacementInstructions.some((instruction) =>
            instruction.opcode === 0x2c
            && abc.stringValues[instruction.operands[0]?.[1] ?? -1] === 'a_Upgrade_Tower'
        ),
        false,
        'Discipline towers must stay registered with SuperAnim; bypassing registration freezes Sentinel'
    );

    const superAnimClassIndex = classIndexByName(abc, 'SuperAnimData');
    assert.notEqual(superAnimClassIndex, null);
    const renderMethodIndex = methodIdxForTrait(
        abc.instances[superAnimClassIndex!].traits,
        abc,
        'method_866'
    );
    assert.notEqual(renderMethodIndex, null);
    const renderBody = abc.methodBodies.get(renderMethodIndex!);
    assert.ok(renderBody);
    const renderCode = context.body.subarray(renderBody.codeStart, renderBody.codeStart + renderBody.codeLen);
    const instructions = disassemble(renderCode, 'SuperAnimData.method_866');

    const rasterizeIndex = instructions.findIndex((instruction, index) =>
        instruction.opcode === 0x5d
        && u30OperandName(instruction, abc.multinameNames) === 'method_982'
        && localIndex(instructions[index + 1]) === 9
        && instructions[index + 2]?.opcode === 0x46
        && u30OperandName(instructions[index + 2], abc.multinameNames) === 'method_982'
        && instructions[index + 3]?.opcode === 0x80
        && u30OperandName(instructions[index + 3], abc.multinameNames) === 'Bitmap'
        && instructions[index + 4]?.opcode === 0x63
        && localIndex(instructions[index + 4]) === 11
    );
    assert.ok(rasterizeIndex >= 0, 'SuperAnim bitmap conversion point must remain identifiable');
    assert.equal(
        instructions.slice(Math.max(0, rasterizeIndex - 40), rasterizeIndex).some((instruction) =>
            instruction.opcode === 0x2c
            && abc.stringValues[instruction.operands[0]?.[1] ?? -1] === 'Templar'
        ),
        false,
        'TemplarFinal must keep method_982 initialization instead of bypassing it'
    );

    const fallbackIndex = instructions.findIndex((instruction, index) =>
        localIndex(instruction) === 11
        && instructions[index + 1]?.opcode === 0x11
        && instructions.slice(index + 2, index + 18).some((candidate, relativeIndex, candidates) =>
            localIndex(candidate) === 3
            && localIndex(candidates[relativeIndex + 1]) === 9
            && candidates[relativeIndex + 2]?.opcode === 0x4f
            && u30OperandName(candidates[relativeIndex + 2], abc.multinameNames) === 'addChild'
        )
    );
    assert.ok(fallbackIndex >= 0, 'SuperAnim live-MovieClip fallback must remain available');
    const betweenRasterizeAndFallback = instructions.slice(rasterizeIndex + 5, fallbackIndex);
    const legacyGuardStrings = betweenRasterizeAndFallback
        .filter((instruction) => instruction.opcode === 0x2c)
        .map((instruction) => abc.stringValues[instruction.operands[0]?.[1] ?? -1]);
    assert.equal(
        legacyGuardStrings.includes('Templar'),
        false,
        'Baked Templar flames must use the same standard SuperAnim path as Sentinel'
    );
    assert.equal(
        legacyGuardStrings.includes('Castle') || legacyGuardStrings.includes('Justicar'),
        false,
        'No obsolete Home tower live-fallback selector may remain'
    );

    const addChildIndex = instructions.findIndex((instruction, index) =>
        index > fallbackIndex
        && localIndex(instruction) === 3
        && localIndex(instructions[index + 1]) === 9
        && instructions[index + 2]?.opcode === 0x4f
        && u30OperandName(instructions[index + 2], abc.multinameNames) === 'addChild'
    );
    assert.ok(addChildIndex >= 0, 'Live frame Sprite must still be attached');
    const afterAddChild = instructions.slice(addChildIndex + 3, addChildIndex + 180);
    const afterAddChildNames = afterAddChild
        .map((instruction) => u30OperandName(instruction, abc.multinameNames))
        .filter((name): name is string => name !== null);
    assert.equal(
        afterAddChildNames.includes('getChildAt'),
        false,
        'Runtime child traversal caused a Flash crash and must remain removed'
    );
    assert.equal(
        afterAddChildNames.includes('play'),
        false,
        'Injected MovieClip.play calls caused a Flash crash and must remain removed'
    );
    const [localCount] = readU30(context.body, renderBody.localCountPos, 'SuperAnimData.method_866.local_count');
    assert.equal(localCount, 20, 'SuperAnimData.method_866 must retain its original local count');
}

function assertServedClientVariantIsValid(): void {
    const swfPath = path.resolve(__dirname, '../../client/content/localhost/p/cbp/DungeonBlitz.swf');
    const abc = parseAbc(parseSwf(swfPath));
    assert.equal(
        abc.stringValues.includes('a_Animation_Justicar10'),
        false,
        'The client must not contain the verifier-unsafe live-timeline class injection'
    );
    assert.equal(
        abc.stringValues.includes('a_Animation_Templar_Final'),
        false,
        'The client must not contain the verifier-unsafe live-timeline class injection'
    );
    const served = buildDungeonBlitzSwfVariantBuffer(swfPath, 'local', 'en');
    const body = served.subarray(0, 3).toString('ascii') === 'CWS'
        ? zlib.inflateSync(served.subarray(8))
        : served.subarray(8);
    assert.equal(served.readUInt32LE(4), body.length + 8, 'Served DungeonBlitz variant must keep a valid SWF length');
}

function createHomeClient(): { client: any; sentPackets: SentPacket[] } {
    const sentPackets: SentPacket[] = [];
    const client = {
        currentLevel: 'CraftTown',
        playerSpawned: true,
        craftTownHostCharacter: null,
        character: {
            class: 'paladin',
            MasterClass: MasterClassID.Justicar,
            magicForge: {
                stats_by_building: {
                    [BuildingID.Forge]: 10,
                    [BuildingID.Keep]: 10,
                    [BuildingID.SentinelTower]: 10,
                    [BuildingID.JusticarTower]: 10,
                    [BuildingID.TemplarTower]: 10,
                    [BuildingID.Tome]: 10,
                    [BuildingID.Barn]: 10
                }
            },
            buildingUpgrade: { buildingID: 0, rank: 0, ReadyTime: 0 }
        },
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
    return { client, sentPackets };
}

function buildingIdsFrom(packets: SentPacket[]): number[] {
    return packets
        .filter((packet) => packet.id === 0xDA)
        .map((packet) => new BitReader(packet.payload).readMethod6(5));
}

function assertHomeSpawnDoesNotRestartTowerTimelines(): void {
    const scheduled: ScheduledTimer[] = [];
    const originalSetTimeout = global.setTimeout;
    (global as any).setTimeout = ((callback: () => void, delayMs: number) => {
        scheduled.push({ callback, delayMs });
        return { unref(): void { return undefined; } };
    }) as typeof setTimeout;

    try {
        const { client, sentPackets } = createHomeClient();
        BuildingHandler.refreshCraftTownBuildingsOnSpawn(client);

        assert.deepEqual(
            buildingIdsFrom(sentPackets),
            [
                BuildingID.Forge,
                BuildingID.Keep,
                BuildingID.SentinelTower,
                BuildingID.TemplarTower,
                BuildingID.JusticarTower,
                BuildingID.Tome,
                BuildingID.Barn
            ],
            'Home spawn must initialize every class tower exactly once, with the active tower last'
        );
        assert.deepEqual(scheduled.map((timer) => timer.delayMs), [1200, 2800]);

        for (const timer of scheduled) timer.callback();
        const idsAfterRetries = buildingIdsFrom(sentPackets);
        for (const towerId of [BuildingID.SentinelTower, BuildingID.JusticarTower, BuildingID.TemplarTower]) {
            assert.equal(
                idsAfterRetries.filter((buildingId) => buildingId === towerId).length,
                1,
                `Delayed Home retries must not reconstruct running tower ${towerId}`
            );
        }

        const firstSpawnTimers = scheduled.slice();
        BuildingHandler.refreshCraftTownBuildingsOnSpawn(client);
        const packetCountAfterSecondSpawn = sentPackets.length;
        for (const timer of firstSpawnTimers) timer.callback();
        assert.equal(
            sentPackets.length,
            packetCountAfterSecondSpawn,
            'Delayed callbacks from an older Home generation must not affect a new Home instance'
        );
    } finally {
        global.setTimeout = originalSetTimeout;
    }
}

assertAuthoredFinalTowerTimelines();
assertRuntimePreservesLargeTowerEffects();
assertRuntimeRetriesTransientTowerFrames();
assertOnlyTemplarCastleFiresUseLiveSuperAnimFallback();
assertServedClientVariantIsValid();
assertHomeSpawnDoesNotRestartTowerTimelines();
console.log('Home discipline tower animation regression passed.');
