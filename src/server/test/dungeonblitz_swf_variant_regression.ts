import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { buildDungeonBlitzSwfVariantBuffer } from '../core/DungeonBlitzSwf';
import { Config } from '../core/config';
import {
    classIndexByName,
    disassemble,
    methodIdxForTrait,
    parseAbc,
    parseSwf,
    u30OperandName
} from '../scripts/swfPatchUtils';
import type { Instruction } from '../scripts/swfPatchUtils';

const BASE_SWF_PATH = path.resolve(__dirname, '../../client/content/localhost/p/cbp/DungeonBlitz.swf');
const MULTIPLAYER_HOST = Config.MULTIPLAYER_HOST;
const SWF_RUNTIME_VERSION = '20260517-class82-bitmapdata';
const LOCAL_REFRESH_URL = `http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp&rv=${SWF_RUNTIME_VERSION}`;
const MULTIPLAYER_REFRESH_URL = `http://${MULTIPLAYER_HOST}/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp&rv=${SWF_RUNTIME_VERSION}`;
const LEGACY_REFRESH_URL = '/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp';
const BITMAPDATA_TOTAL_PIXELS = 16777215;
const SUPERANIM_METHOD200_SAFE_PIXELS = 65536;
const SUPERANIM_METHOD982_SAFE_PIXELS = 65536;

function getStringMatches(swfPath: string, target: string): number[] {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const matches: number[] = [];

    for (let index = 1; index < abc.stringValues.length; index++) {
        if (abc.stringValues[index] === target) {
            matches.push(index);
        }
    }

    return matches;
}

function getStringMatchCount(swfPath: string, target: string): number {
    return getStringMatches(swfPath, target).length;
}

function getMountedSpeedBranchOpcode(swfPath: string): number {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const classIndex = classIndexByName(abc, 'CombatState');
    assert.notEqual(classIndex, null, 'CombatState class not found');

    const methodIdx = methodIdxForTrait(abc.instances[classIndex!].traits, abc, 'method_960');
    assert.notEqual(methodIdx, null, 'CombatState.method_960 not found');

    const methodBody = abc.methodBodies.get(methodIdx!);
    assert.ok(methodBody, 'CombatState.method_960 body not found');

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const instructions = disassemble(code, 'CombatState.method_960');
    const mountedGuardIndex = instructions.findIndex(
        (instruction, index) =>
            u30OperandName(instruction, abc.multinameNames) === 'var_270'
    );
    assert.notEqual(mountedGuardIndex, -1, 'Mounted guard not found');

    const dungeonFlag = instructions.find(
        (instruction, index) =>
            index > mountedGuardIndex! &&
            instruction.opcode === 0x66 &&
            u30OperandName(instruction, abc.multinameNames) === 'bInstanced'
    );
    return dungeonFlag ? dungeonFlag.opcode : -1;
}

function getLocalOperand(instruction: Instruction | undefined): number | null {
    if (!instruction) {
        return null;
    }
    if (instruction.opcode >= 0xd0 && instruction.opcode <= 0xd3) {
        return instruction.opcode - 0xd0;
    }
    if (instruction.opcode === 0x62 && instruction.operands[0]?.[0] === 'u30') {
        return instruction.operands[0][1];
    }
    return null;
}

function getStaticMethodCode(swfPath: string, className: string, methodName: string) {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const classIndex = classIndexByName(abc, className);
    assert.notEqual(classIndex, null, `${className} class not found`);

    const methodIdx = methodIdxForTrait(abc.classTraits[classIndex!], abc, methodName);
    assert.notEqual(methodIdx, null, `${className}.${methodName} not found`);

    const methodBody = abc.methodBodies.get(methodIdx!);
    assert.ok(methodBody, `${className}.${methodName} body not found`);

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    return {
        abc,
        instructions: disassemble(code, `${className}.${methodName}`)
    };
}

function getInstanceMethodCode(swfPath: string, className: string, methodName: string) {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const classIndex = classIndexByName(abc, className);
    assert.notEqual(classIndex, null, `${className} class not found`);

    const methodIdx = methodIdxForTrait(abc.instances[classIndex!].traits, abc, methodName);
    assert.notEqual(methodIdx, null, `${className}.${methodName} not found`);

    const methodBody = abc.methodBodies.get(methodIdx!);
    assert.ok(methodBody, `${className}.${methodName} body not found`);

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    return {
        abc,
        instructions: disassemble(code, `${className}.${methodName}`)
    };
}

function findBitmapDataConstructorIndex(
    instructions: Instruction[],
    names: string[],
    widthLocal: number,
    heightLocal: number
): number {
    return instructions.findIndex((instruction, index) => {
        const width = instructions[index + 1];
        const height = instructions[index + 2];
        const pushTrue = instructions[index + 3];
        const pushZero = instructions[index + 4];
        const construct = instructions[index + 5];

        return (
            instruction.opcode === 0x5d &&
            u30OperandName(instruction, names) === 'BitmapData' &&
            getLocalOperand(width) === widthLocal &&
            getLocalOperand(height) === heightLocal &&
            pushTrue?.opcode === 0x26 &&
            pushZero?.opcode === 0x24 &&
            pushZero.operands[0]?.[1] === 0 &&
            construct?.opcode === 0x4a &&
            u30OperandName(construct, names) === 'BitmapData' &&
            construct.operands[1]?.[1] === 4
        );
    });
}

function assertBitmapDataGuardWindow(
    swfPath: string,
    widthLocal: number,
    heightLocal: number,
    label: string
): void {
    const { abc, instructions } = getStaticMethodCode(swfPath, 'SuperAnimData', 'method_200');
    const constructorIndex = findBitmapDataConstructorIndex(
        instructions,
        abc.multinameNames,
        widthLocal,
        heightLocal
    );
    assert.notEqual(constructorIndex, -1, `${label} BitmapData constructor not found`);

    const guardWindow = instructions.slice(Math.max(0, constructorIndex - 55), constructorIndex);
    assert.equal(
        guardWindow.filter((instruction) => instruction.opcode === 0x25 && instruction.operands[0]?.[1] === 8191).length >= 2,
        true,
        `${label} must enforce Flash's 8191 BitmapData axis limit`
    );
    assert.equal(
        guardWindow.some((instruction, index) => {
            const pushIntOperand = guardWindow[index + 3]?.operands[0];
            return (
                getLocalOperand(instruction) === widthLocal &&
                getLocalOperand(guardWindow[index + 1]) === heightLocal &&
                guardWindow[index + 2]?.opcode === 0xa2 &&
                guardWindow[index + 3]?.opcode === 0x2d &&
                pushIntOperand?.[0] === 'u30' &&
                abc.intValues[pushIntOperand[1]] === SUPERANIM_METHOD200_SAFE_PIXELS &&
                guardWindow[index + 4]?.opcode === 0xaf
            );
        }),
        true,
        `${label} must enforce the BitmapData total pixel limit`
    );
    assert.equal(
        guardWindow.filter((instruction) => instruction.opcode === 0x25 && instruction.operands[0]?.[1] === 128).length >= 2,
        true,
        `${label} fallback must use a visible 128x128 BitmapData instead of 1x1`
    );
}

function assertClass82BitmapDataGuardWindow(swfPath: string): void {
    const { abc, instructions } = getInstanceMethodCode(swfPath, 'class_82', 'method_193');
    const widthLocal = 8;
    const heightLocal = 9;
    const constructorIndex = findBitmapDataConstructorIndex(
        instructions,
        abc.multinameNames,
        widthLocal,
        heightLocal
    );
    assert.notEqual(constructorIndex, -1, 'class_82.method_193 BitmapData constructor not found');

    const guardWindow = instructions.slice(Math.max(0, constructorIndex - 55), constructorIndex);
    assert.equal(
        guardWindow.filter((instruction) => instruction.opcode === 0x25 && instruction.operands[0]?.[1] === 8191).length >= 2,
        true,
        'class_82.method_193 must enforce Flash\'s 8191 BitmapData axis limit'
    );
    assert.equal(
        guardWindow.some((instruction, index) => {
            const pushIntOperand = guardWindow[index + 3]?.operands[0];
            return (
                getLocalOperand(instruction) === widthLocal &&
                getLocalOperand(guardWindow[index + 1]) === heightLocal &&
                guardWindow[index + 2]?.opcode === 0xa2 &&
                guardWindow[index + 3]?.opcode === 0x2d &&
                pushIntOperand?.[0] === 'u30' &&
                abc.intValues[pushIntOperand[1]] === BITMAPDATA_TOTAL_PIXELS &&
                guardWindow[index + 4]?.opcode === 0xaf
            );
        }),
        true,
        'class_82.method_193 must enforce the BitmapData total pixel limit'
    );
    assert.equal(
        instructions.some((instruction, index) =>
            instruction.opcode === 0x66 &&
            u30OperandName(instruction, abc.multinameNames) === 'var_2825' &&
            instructions[index + 1]?.opcode === 0x24 &&
            instructions[index + 1]?.operands[0]?.[1] === 2 &&
            instructions[index + 2]?.opcode === 0xa3 &&
            instructions[index + 3]?.opcode === 0x75
        ),
        true,
        'class_82.method_193 must halve cache render scale before BitmapData allocation'
    );
}

function assertSuperAnimMethod200BitmapDataGuard(swfPath: string): void {
    assertBitmapDataGuardWindow(swfPath, 10, 11, 'SuperAnimData.method_200 direct allocation');
    assertBitmapDataGuardWindow(swfPath, 25, 26, 'SuperAnimData.method_200 cropped allocation');
}

function assertSuperAnimMethod982BitmapDataGuard(swfPath: string): void {
    const { abc, instructions } = getStaticMethodCode(swfPath, 'SuperAnimData', 'method_982');
    const widthLocal = 11;
    const heightLocal = 12;
    const constructorIndex = findBitmapDataConstructorIndex(
        instructions,
        abc.multinameNames,
        widthLocal,
        heightLocal
    );
    assert.notEqual(constructorIndex, -1, 'SuperAnimData.method_982 output BitmapData constructor not found');

    const guardWindow = instructions.slice(Math.max(0, constructorIndex - 55), constructorIndex);
    assert.equal(
        guardWindow.some((instruction, index) => {
            const pushIntOperand = guardWindow[index + 3]?.operands[0];
            return (
                getLocalOperand(instruction) === widthLocal &&
                getLocalOperand(guardWindow[index + 1]) === heightLocal &&
                guardWindow[index + 2]?.opcode === 0xa2 &&
                guardWindow[index + 3]?.opcode === 0x2d &&
                pushIntOperand?.[0] === 'u30' &&
                abc.intValues[pushIntOperand[1]] === SUPERANIM_METHOD982_SAFE_PIXELS &&
                guardWindow[index + 4]?.opcode === 0xaf
            );
        }),
        true,
        'SuperAnimData.method_982 must enforce the safe output BitmapData total pixel limit'
    );
    assert.equal(
        guardWindow.filter((instruction) => instruction.opcode === 0x25 && instruction.operands[0]?.[1] === 128).length >= 4,
        true,
        'SuperAnimData.method_982 fallback must use a visible 128x128 BitmapData instead of 1x1'
    );
}

function withTempSwf(buffer: Buffer, callback: (tempPath: string) => void): void {
    const tempPath = path.join(os.tmpdir(), `dungeonblitz-variant-${process.pid}-${Date.now()}-${Math.random()}.swf`);
    fs.writeFileSync(tempPath, buffer);
    try {
        callback(tempPath);
    } finally {
        fs.rmSync(tempPath, { force: true });
    }
}

function testLocalVariantUsesLocalhostAndPort8000(): void {
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assert.equal(getStringMatchCount(tempPath, 'localhost'), 1);
        assert.equal(getStringMatchCount(tempPath, ':8000/p/'), 1);
        assert.equal(getStringMatchCount(tempPath, LOCAL_REFRESH_URL), 1);
        assert.equal(getStringMatchCount(tempPath, LEGACY_REFRESH_URL), 0);
        assert.equal(getStringMatchCount(tempPath, MULTIPLAYER_HOST), 0);
        assert.equal(getStringMatchCount(tempPath, '/p/'), 0);
    });
}

function testMultiplayerVariantUsesRemoteHostAndDefaultAssetPath(): void {
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'multiplayer');
    withTempSwf(buffer, (tempPath) => {
        assert.equal(getStringMatchCount(tempPath, MULTIPLAYER_HOST), 1);
        assert.equal(getStringMatchCount(tempPath, '/p/'), 1);
        assert.equal(getStringMatchCount(tempPath, MULTIPLAYER_REFRESH_URL), 1);
        assert.equal(getStringMatchCount(tempPath, LEGACY_REFRESH_URL), 0);
        assert.equal(getStringMatchCount(tempPath, 'localhost'), 0);
        assert.equal(getStringMatchCount(tempPath, ':8000/p/'), 0);
    });
}

function testVariantRemovesDungeonMountSpeedGate(): void {
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assert.equal(getMountedSpeedBranchOpcode(tempPath), -1);
    });
}

function testBaseAndLocalVariantKeepSuperAnimMethod200BitmapDataGuard(): void {
    assertSuperAnimMethod200BitmapDataGuard(BASE_SWF_PATH);
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertSuperAnimMethod200BitmapDataGuard(tempPath);
    });
}

function testBaseAndLocalVariantKeepClass82BitmapDataGuard(): void {
    assertClass82BitmapDataGuardWindow(BASE_SWF_PATH);
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertClass82BitmapDataGuardWindow(tempPath);
    });
}

function testBaseAndLocalVariantKeepSuperAnimMethod982BitmapDataGuard(): void {
    assertSuperAnimMethod982BitmapDataGuard(BASE_SWF_PATH);
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertSuperAnimMethod982BitmapDataGuard(tempPath);
    });
}

function main(): void {
    testLocalVariantUsesLocalhostAndPort8000();
    testMultiplayerVariantUsesRemoteHostAndDefaultAssetPath();
    testVariantRemovesDungeonMountSpeedGate();
    testBaseAndLocalVariantKeepSuperAnimMethod200BitmapDataGuard();
    testBaseAndLocalVariantKeepClass82BitmapDataGuard();
    testBaseAndLocalVariantKeepSuperAnimMethod982BitmapDataGuard();
    console.log('dungeonblitz_swf_variant_regression: ok');
}

main();
