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

function resolveBaseSwfPath(): string {
    const candidates = [
        path.resolve(__dirname, '../../client/content/localhost/p/cbp/DungeonBlitz.swf'),
        path.resolve(__dirname, '../../../client/content/localhost/p/cbp/DungeonBlitz.swf'),
        path.resolve(process.cwd(), 'src/client/content/localhost/p/cbp/DungeonBlitz.swf'),
        path.resolve(process.cwd(), '../client/content/localhost/p/cbp/DungeonBlitz.swf')
    ];

    return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

const BASE_SWF_PATH = resolveBaseSwfPath();
const MULTIPLAYER_HOST = Config.MULTIPLAYER_HOST;
const LOCAL_REFRESH_URL = 'http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbv';
const MULTIPLAYER_REFRESH_URL = `http://${MULTIPLAYER_HOST}/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbv`;
const LEGACY_REFRESH_URL = '/p/cbp/DungeonBlitz.swf?fv=cbw&gv=cbv';
const BITMAPDATA_TOTAL_PIXELS = 16777215;
const CLASS82_SCENE_CACHE_SAFE_PIXELS = 4194304;
const CLASS72_FLOAT_TEXT_SAFE_PIXELS = 262144;
const CLASS82_MAX_SCENE_CACHE_SCALE = 16;
const SUPERANIM_METHOD200_SAFE_PIXELS = 16384;
const SUPERANIM_METHOD982_SAFE_PIXELS = 4194304;
const SUPERANIM_METHOD982_SAFE_AXIS = 8191;
const SUPERANIM_METHOD806_FULLSCREEN_ENTITY_BITMAP_SIZE = 3072;
const SAFE_SCREEN_BITMAP_WIDTH = 2048;
const SAFE_SCREEN_BITMAP_HEIGHT = 1152;

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

function setLocalOperand(instruction: Instruction | undefined): number | null {
    if (!instruction) {
        return null;
    }
    if (instruction.opcode >= 0xd4 && instruction.opcode <= 0xd7) {
        return instruction.opcode - 0xd4;
    }
    if (instruction.opcode === 0x63 && instruction.operands[0]?.[0] === 'u30') {
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

function findPropertyBitmapDataConstructorIndex(
    instructions: Instruction[],
    names: string[],
    widthName: string,
    heightName: string
): number {
    return instructions.findIndex((instruction, index) => {
        const widthSelf = instructions[index + 1];
        const width = instructions[index + 2];
        const heightSelf = instructions[index + 3];
        const height = instructions[index + 4];
        const pushTrue = instructions[index + 5];
        const construct = instructions[index + 6];

        return (
            instruction.opcode === 0x5d &&
            u30OperandName(instruction, names) === 'BitmapData' &&
            widthSelf?.opcode === 0xd0 &&
            width?.opcode === 0x66 &&
            u30OperandName(width, names) === widthName &&
            heightSelf?.opcode === 0xd0 &&
            height?.opcode === 0x66 &&
            u30OperandName(height, names) === heightName &&
            pushTrue?.opcode === 0x26 &&
            construct?.opcode === 0x4a &&
            u30OperandName(construct, names) === 'BitmapData' &&
            construct.operands[1]?.[1] === 3
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

    const guardWindow = instructions.slice(Math.max(0, constructorIndex - 75), constructorIndex);
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

    const guardWindow = instructions.slice(Math.max(0, constructorIndex - 75), constructorIndex);
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
                abc.intValues[pushIntOperand[1]] === CLASS82_SCENE_CACHE_SAFE_PIXELS &&
                guardWindow[index + 4]?.opcode === 0xaf
            );
        }),
        true,
        'class_82.method_193 must enforce the scene-cache BitmapData safe pixel limit'
    );
    assert.equal(
        instructions.some((instruction, index) => {
            if (instruction.opcode !== 0x66 || u30OperandName(instruction, abc.multinameNames) !== 'var_2825') {
                return false;
            }
            const window = instructions.slice(index + 1, index + 8);
            const divisorIndex = window.findIndex((candidate) =>
                candidate.opcode === 0x24 && candidate.operands[0]?.[1] === 1
            );
            return divisorIndex >= 0 &&
                window[divisorIndex + 1]?.opcode === 0xa3 &&
                window.some((candidate) => setLocalOperand(candidate) === 6);
        }),
        true,
        'class_82.method_193 must preserve normal cache render scale before BitmapData allocation'
    );
    assert.equal(
        guardWindow.filter((instruction) => instruction.opcode === 0x25 && instruction.operands[0]?.[1] === 128).length >= 2,
        true,
        'class_82.method_193 fallback must use a visible 128x128 BitmapData instead of 1x1'
    );
    assert.equal(
        instructions.some((instruction, index) =>
            getLocalOperand(instruction) === 6 &&
            getLocalOperand(instructions[index + 1]) === 6 &&
            instructions[index + 2]?.opcode === 0xab &&
            instructions[index + 3]?.opcode === 0x12 &&
            getLocalOperand(instructions[index + 4]) === 6 &&
            instructions[index + 5]?.opcode === 0x24 &&
            instructions[index + 5]?.operands[0]?.[1] === 0 &&
            instructions[index + 6]?.opcode === 0xaf &&
            instructions[index + 7]?.opcode === 0x12 &&
            getLocalOperand(instructions[index + 8]) === 6 &&
            instructions[index + 9]?.opcode === 0x24 &&
            instructions[index + 9]?.operands[0]?.[1] === CLASS82_MAX_SCENE_CACHE_SCALE &&
            instructions[index + 10]?.opcode === 0xaf &&
            instructions[index + 11]?.opcode === 0x11
        ),
        true,
        'class_82.method_193 must clamp invalid transition cache scale before width/height calculation'
    );
}

function assertClass72FloatTextBitmapDataGuardWindow(swfPath: string): void {
    const { abc, instructions } = getInstanceMethodCode(swfPath, 'class_72', 'method_1943');
    const widthLocal = 14;
    const heightLocal = 15;
    const constructorIndex = findBitmapDataConstructorIndex(
        instructions,
        abc.multinameNames,
        widthLocal,
        heightLocal
    );
    assert.notEqual(constructorIndex, -1, 'class_72.method_1943 BitmapData constructor must use guarded dimensions');

    const guardWindow = instructions.slice(Math.max(0, constructorIndex - 85), constructorIndex);
    assert.equal(
        guardWindow.filter((instruction) => instruction.opcode === 0x25 && instruction.operands[0]?.[1] === 8191).length >= 2,
        true,
        'class_72.method_1943 must enforce Flash\'s 8191 BitmapData axis limit'
    );
    assert.equal(
        guardWindow.some((instruction, index) => (
            getLocalOperand(instruction) === widthLocal &&
            getLocalOperand(guardWindow[index + 1]) === heightLocal &&
            guardWindow[index + 2]?.opcode === 0xa2 &&
            guardWindow[index + 3]?.opcode === 0x25 &&
            guardWindow[index + 3]?.operands[0]?.[1] === CLASS72_FLOAT_TEXT_SAFE_PIXELS &&
            guardWindow[index + 4]?.opcode === 0xaf
        )),
        true,
        'class_72.method_1943 must enforce the floating text BitmapData safe pixel limit'
    );
    assert.equal(
        guardWindow.filter((instruction) => instruction.opcode === 0x25 && instruction.operands[0]?.[1] === 128).length >= 2,
        true,
        'class_72.method_1943 fallback must use a visible 128x128 BitmapData instead of 1x1'
    );
    assert.equal(
        guardWindow.some((instruction) => instruction.opcode === 0x68 && u30OperandName(instruction, abc.multinameNames) === 'var_1344'),
        true,
        'class_72.method_1943 fallback must avoid caching clipped oversized float text'
    );
}

function assertClass23BitmapDataGuardWindow(swfPath: string): void {
    const { abc, instructions } = getInstanceMethodCode(swfPath, 'class_23', 'method_942');
    const widthName = 'var_1707';
    const heightName = 'var_2152';
    const constructorIndex = findPropertyBitmapDataConstructorIndex(
        instructions,
        abc.multinameNames,
        widthName,
        heightName
    );
    assert.notEqual(constructorIndex, -1, 'class_23.method_942 BitmapData constructor not found');

    const guardWindow = instructions.slice(Math.max(0, constructorIndex - 75), constructorIndex);
    assert.equal(
        guardWindow.some((instruction, index) =>
            instruction.opcode === 0xd0 &&
            guardWindow[index + 1]?.opcode === 0x66 &&
            u30OperandName(guardWindow[index + 1], abc.multinameNames) === widthName &&
            guardWindow[index + 2]?.opcode === 0xd0 &&
            guardWindow[index + 3]?.opcode === 0x66 &&
            u30OperandName(guardWindow[index + 3], abc.multinameNames) === widthName &&
            guardWindow[index + 4]?.opcode === 0xab &&
            guardWindow[index + 5]?.opcode === 0x12
        ),
        true,
        'class_23.method_942 must reject NaN cache widths'
    );
    assert.equal(
        guardWindow.some((instruction, index) =>
            instruction.opcode === 0xd0 &&
            guardWindow[index + 1]?.opcode === 0x66 &&
            u30OperandName(guardWindow[index + 1], abc.multinameNames) === heightName &&
            guardWindow[index + 2]?.opcode === 0xd0 &&
            guardWindow[index + 3]?.opcode === 0x66 &&
            u30OperandName(guardWindow[index + 3], abc.multinameNames) === heightName &&
            guardWindow[index + 4]?.opcode === 0xab &&
            guardWindow[index + 5]?.opcode === 0x12
        ),
        true,
        'class_23.method_942 must reject NaN cache heights'
    );
    assert.equal(
        guardWindow.filter((instruction) => instruction.opcode === 0x25 && instruction.operands[0]?.[1] === 8191).length >= 2,
        true,
        'class_23.method_942 must enforce Flash\'s 8191 BitmapData axis limit'
    );
    assert.equal(
        guardWindow.some((instruction, index) => {
            const pushIntOperand = guardWindow[index + 5]?.operands[0];
            return (
                instruction.opcode === 0xd0 &&
                guardWindow[index + 1]?.opcode === 0x66 &&
                u30OperandName(guardWindow[index + 1], abc.multinameNames) === widthName &&
                guardWindow[index + 2]?.opcode === 0xd0 &&
                guardWindow[index + 3]?.opcode === 0x66 &&
                u30OperandName(guardWindow[index + 3], abc.multinameNames) === heightName &&
                guardWindow[index + 4]?.opcode === 0xa2 &&
                guardWindow[index + 5]?.opcode === 0x2d &&
                pushIntOperand?.[0] === 'u30' &&
                abc.intValues[pushIntOperand[1]] === BITMAPDATA_TOTAL_PIXELS &&
                guardWindow[index + 6]?.opcode === 0xaf
            );
        }),
        true,
        'class_23.method_942 must enforce the BitmapData total pixel limit'
    );
    assert.equal(
        guardWindow.some((instruction, index) =>
            instruction.opcode === 0xd0 &&
            guardWindow[index + 1]?.opcode === 0x25 &&
            guardWindow[index + 1]?.operands[0]?.[1] === 512 &&
            guardWindow[index + 2]?.opcode === 0x68 &&
            u30OperandName(guardWindow[index + 2], abc.multinameNames) === widthName
        ),
        true,
        'class_23.method_942 fallback must reset cache width to 512'
    );
    assert.equal(
        guardWindow.some((instruction, index) =>
            instruction.opcode === 0xd0 &&
            guardWindow[index + 1]?.opcode === 0x25 &&
            guardWindow[index + 1]?.operands[0]?.[1] === 512 &&
            guardWindow[index + 2]?.opcode === 0x68 &&
            u30OperandName(guardWindow[index + 2], abc.multinameNames) === heightName
        ),
        true,
        'class_23.method_942 fallback must reset cache height to 512'
    );
}

function assertGameMethod1947SafeScreenBitmapData(swfPath: string): void {
    const { abc, instructions } = getInstanceMethodCode(swfPath, 'Game', 'method_1947');
    const constructorIndex = instructions.findIndex((instruction, index) =>
        instruction.opcode === 0x5d &&
        u30OperandName(instruction, abc.multinameNames) === 'BitmapData' &&
        instructions[index + 1]?.opcode === 0x25 &&
        instructions[index + 1]?.operands[0]?.[1] === SAFE_SCREEN_BITMAP_WIDTH &&
        instructions[index + 2]?.opcode === 0x25 &&
        instructions[index + 2]?.operands[0]?.[1] === SAFE_SCREEN_BITMAP_HEIGHT
    );

    assert.notEqual(
        constructorIndex,
        -1,
        'Game.method_1947 screen BitmapData allocation must use safe fixed dimensions'
    );
}

function assertGameMethod1325SuperAnimTickGuard(swfPath: string): void {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const classIndex = classIndexByName(abc, 'Game');
    assert.notEqual(classIndex, null, 'Game class not found');

    const methodIdx = methodIdxForTrait(abc.instances[classIndex!].traits, abc, 'method_1325');
    assert.notEqual(methodIdx, null, 'Game.method_1325 not found');

    const methodBody = abc.methodBodies.get(methodIdx!);
    assert.ok(methodBody, 'Game.method_1325 body not found');

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const instructions = disassemble(code, 'Game.method_1325');
    const method105Index = instructions.findIndex(
        (instruction) => instruction.opcode === 0x46 && u30OperandName(instruction, abc.multinameNames) === 'method_105'
    );
    assert.notEqual(method105Index, -1, 'Game.method_1325 SuperAnimInstance.method_105 call not found');

    const rangeStart = instructions[method105Index - 1];
    const rangeEnd = instructions[method105Index + 6];
    assert.ok(rangeStart, 'Game.method_1325 method_105 try range start not found');
    assert.ok(rangeEnd, 'Game.method_1325 method_105 try range end not found');
    const from = rangeStart.offset;
    const to = rangeEnd.offset + rangeEnd.size;
    assert.equal(
        methodBody.exceptions.some((exception) => exception.from === from && exception.to === to),
        true,
        'Game.method_1325 must catch SuperAnimInstance.method_105 crashes'
    );
    assert.equal(
        instructions.some((instruction) => instruction.opcode === 0x5a),
        true,
        'Game.method_1325 catch handler must bind the caught error'
    );
    assert.equal(
        instructions.some((instruction) => instruction.opcode === 0x4f && u30OperandName(instruction, abc.multinameNames) === 'DestroySuperAnimInstance'),
        true,
        'Game.method_1325 catch handler must destroy the failed SuperAnimInstance'
    );
}

function assertGameMethod527DamageFloatersClamped(swfPath: string): void {
    const { abc, instructions } = getInstanceMethodCode(swfPath, 'Game', 'method_527');
    assert.equal(
        instructions.some((instruction) =>
            instruction.opcode === 0x4a &&
            u30OperandName(instruction, abc.multinameNames) === 'class_72' &&
            instruction.operands[1]?.[1] === 10
        ),
        true,
        'Game.method_527 must create damage floaters'
    );
    assert.equal(
        instructions.some((instruction) => instruction.opcode === 0x25 && instruction.operands[0]?.[1] === 4000000),
        true,
        'Game.method_527 must cap displayed damage at 4,000,000'
    );
    assert.equal(
        instructions.filter((instruction) => instruction.opcode === 0x46 && u30OperandName(instruction, abc.multinameNames) === 'min').length >= 3,
        true,
        'Game.method_527 must clamp damage text and screen bounds with Math.min'
    );
    assert.equal(
        instructions.filter((instruction) => instruction.opcode === 0x46 && u30OperandName(instruction, abc.multinameNames) === 'max').length >= 2,
        true,
        'Game.method_527 must clamp damage text coordinates with Math.max'
    );
}

function assertInstanceMethodNullGuard(swfPath: string, className: string, methodName: string): void {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const classIndex = classIndexByName(abc, className);
    assert.notEqual(classIndex, null, `${className} class not found`);

    const methodIdx = methodIdxForTrait(abc.instances[classIndex!].traits, abc, methodName);
    assert.notEqual(methodIdx, null, `${className}.${methodName} not found`);

    const methodBody = abc.methodBodies.get(methodIdx!);
    assert.ok(methodBody, `${className}.${methodName} body not found`);

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    assert.equal(
        methodBody.exceptions.some((exception) => {
            const handler = code.subarray(exception.target);
            return exception.from === 0 && handler[0] === 0x29 && handler.includes(0x47);
        }),
        true,
        `${className}.${methodName} must catch stale/null references and return`
    );
}

function assertInstanceBooleanMethodFalseNullGuard(swfPath: string, className: string, methodName: string): void {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const classIndex = classIndexByName(abc, className);
    assert.notEqual(classIndex, null, `${className} class not found`);

    const methodIdx = methodIdxForTrait(abc.instances[classIndex!].traits, abc, methodName);
    assert.notEqual(methodIdx, null, `${className}.${methodName} not found`);

    const methodBody = abc.methodBodies.get(methodIdx!);
    assert.ok(methodBody, `${className}.${methodName} body not found`);

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    assert.equal(
        methodBody.exceptions.some((exception) => {
            const handler = code.subarray(exception.target);
            return exception.from === 0 && handler[0] === 0x29 && handler.includes(0x4f) && code[code.length - 2] === 0x27 && code[code.length - 1] === 0x48;
        }),
        true,
        `${className}.${methodName} must catch stale/null references and return false`
    );
}

function assertMainMethod561DoesNotClampMaxScale(swfPath: string): void {
    const { instructions } = getInstanceMethodCode(swfPath, 'Main', 'method_561');
    const maxScaleAssignment = instructions.find((instruction, index) =>
        instruction.opcode === 0x2f &&
        instructions[index + 1]?.opcode === 0x75 &&
        instructions[index + 2]?.opcode === 0xd7 &&
        instructions[index + 3]?.opcode === 0xd3 &&
        instructions[index + 4]?.opcode === 0x2f &&
        instructions[index + 5]?.opcode === 0x0c
    );

    assert.equal(
        maxScaleAssignment,
        undefined,
        'Main.method_561 must not clamp fullscreen fit scale back to 1.25'
    );
}

function assertDungeonQuestHelperPrefersDungeonProgress(swfPath: string): void {
    const { abc, instructions } = getInstanceMethodCode(swfPath, 'Game', 'SelectMissionToTrack');
    const hasDungeonGuard = instructions.some((instruction, index) => {
        const window = instructions.slice(index, index + 16);
        return (
            instruction.opcode === 0xd0 &&
            window[1]?.opcode === 0x66 &&
            u30OperandName(window[1], abc.multinameNames) === 'level' &&
            window.some((item) => item.opcode === 0x66 && u30OperandName(item, abc.multinameNames) === 'bInstanced') &&
            window.some((item) => item.opcode === 0x68 && u30OperandName(item, abc.multinameNames) === 'mTrackedMission') &&
            window.some((item) => item.opcode === 0x66 && u30OperandName(item, abc.multinameNames) === 'screenQuestTracker') &&
            window.some((item) => item.opcode === 0x4f && u30OperandName(item, abc.multinameNames) === 'Refresh') &&
            window.some((item) => item.opcode === 0x47)
        );
    });

    assert.equal(
        hasDungeonGuard,
        true,
        'Game.SelectMissionToTrack must clear only visual tracked missions in instanced dungeons'
    );
}

function assertSuperAnimMethod200BitmapDataGuard(swfPath: string): void {
    assertBitmapDataGuardWindow(swfPath, 10, 11, 'SuperAnimData.method_200 direct allocation');
    assertBitmapDataGuardWindow(swfPath, 25, 26, 'SuperAnimData.method_200 cropped allocation');
}

function assertSuperAnimMethod806FullscreenBitmapData(swfPath: string): void {
    const { abc, instructions } = getStaticMethodCode(swfPath, 'SuperAnimData', 'method_806');
    const forcedEntityBitmapCount = instructions.filter((instruction, index) =>
        instruction.opcode === 0x5d &&
        u30OperandName(instruction, abc.multinameNames) === 'BitmapData' &&
        instructions[index + 1]?.opcode === 0x25 &&
        instructions[index + 1]?.operands[0]?.[1] === SUPERANIM_METHOD806_FULLSCREEN_ENTITY_BITMAP_SIZE &&
        instructions[index + 2]?.opcode === 0x25 &&
        instructions[index + 2]?.operands[0]?.[1] === SUPERANIM_METHOD806_FULLSCREEN_ENTITY_BITMAP_SIZE &&
        instructions[index + 3]?.opcode === 0x26 &&
        instructions[index + 4]?.opcode === 0x24 &&
        instructions[index + 4]?.operands[0]?.[1] === 0 &&
        instructions[index + 5]?.opcode === 0x4a &&
        u30OperandName(instructions[index + 5], abc.multinameNames) === 'BitmapData' &&
        instructions[index + 5]?.operands[1]?.[1] === 4
    ).length;

    assert.equal(
        forcedEntityBitmapCount,
        2,
        'SuperAnimData.method_806 fullscreen entity BitmapData allocations must use safe fixed dimensions'
    );
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
        guardWindow.filter((instruction) => instruction.opcode === 0x25 && instruction.operands[0]?.[1] === SUPERANIM_METHOD982_SAFE_AXIS).length >= 2,
        true,
        'SuperAnimData.method_982 must enforce the safe output BitmapData axis limit'
    );
    assert.equal(
        guardWindow.filter((instruction) => instruction.opcode === 0x24 && instruction.operands[0]?.[1] === 1).length >= 2,
        true,
        'SuperAnimData.method_982 unsafe fallback must collapse to a 1x1 BitmapData instead of live sprite artifacts'
    );
}

function assertSuperAnimMethod866LiveFallbackCleanup(swfPath: string): void {
    const { abc, instructions } = getInstanceMethodCode(swfPath, 'SuperAnimData', 'method_866');

    assert.equal(
        instructions.some((instruction, index) =>
            instruction.opcode === 0x46 &&
            u30OperandName(instruction, abc.multinameNames) === 'method_982' &&
            setLocalOperand(instructions[index + 2]) === 11 &&
            getLocalOperand(instructions[index + 3]) === 11 &&
            instructions[index + 4]?.opcode === 0x12 &&
            getLocalOperand(instructions[index + 5]) === 11 &&
            instructions[index + 6]?.opcode === 0x66 &&
            u30OperandName(instructions[index + 6], abc.multinameNames) === 'bitmapData' &&
            instructions[index + 7]?.opcode === 0x12 &&
            getLocalOperand(instructions[index + 8]) === 11 &&
            instructions[index + 9]?.opcode === 0x66 &&
            u30OperandName(instructions[index + 9], abc.multinameNames) === 'bitmapData' &&
            instructions[index + 10]?.opcode === 0x66 &&
            u30OperandName(instructions[index + 10], abc.multinameNames) === 'width' &&
            instructions[index + 11]?.opcode === 0x24 &&
            instructions[index + 11].operands[0]?.[1] === 1 &&
            instructions[index + 12]?.opcode === 0x17
        ),
        true,
        'SuperAnimData.method_866 must reject method_982 1x1 fallback bitmaps before caching frames'
    );

    assert.equal(
        instructions.some((instruction, index) =>
            getLocalOperand(instruction) === 11 &&
            instructions[index + 1]?.opcode === 0x11 &&
            getLocalOperand(instructions[index + 2]) === 4 &&
            instructions[index + 3]?.opcode === 0x20 &&
            instructions[index + 4]?.opcode === 0x61 &&
            u30OperandName(instructions[index + 4], abc.multinameNames) === 'bitmapData'
        ),
        true,
        'SuperAnimData.method_866 must clear stale Bitmap.bitmapData when method_982 falls back to live sprites'
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

function testBaseAndLocalVariantKeepClass23BitmapDataGuard(): void {
    assertClass23BitmapDataGuardWindow(BASE_SWF_PATH);
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertClass23BitmapDataGuardWindow(tempPath);
    });
}

function testBaseAndLocalVariantKeepClass72FloatTextBitmapDataGuard(): void {
    assertClass72FloatTextBitmapDataGuardWindow(BASE_SWF_PATH);
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertClass72FloatTextBitmapDataGuardWindow(tempPath);
    });
}

function testBaseAndLocalVariantKeepSuperAnimMethod982BitmapDataGuard(): void {
    assertSuperAnimMethod982BitmapDataGuard(BASE_SWF_PATH);
    assertSuperAnimMethod866LiveFallbackCleanup(BASE_SWF_PATH);
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertSuperAnimMethod982BitmapDataGuard(tempPath);
        assertSuperAnimMethod866LiveFallbackCleanup(tempPath);
    });
}

function testBaseAndLocalVariantKeepSuperAnimMethod806FullscreenBitmapData(): void {
    assertSuperAnimMethod806FullscreenBitmapData(BASE_SWF_PATH);
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertSuperAnimMethod806FullscreenBitmapData(tempPath);
    });
}

function testBaseAndLocalVariantKeepGameMethod1947SafeScreenBitmapData(): void {
    assertGameMethod1947SafeScreenBitmapData(BASE_SWF_PATH);
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertGameMethod1947SafeScreenBitmapData(tempPath);
    });
}

function testBaseAndLocalVariantKeepGameMethod1325SuperAnimTickGuard(): void {
    assertGameMethod1325SuperAnimTickGuard(BASE_SWF_PATH);
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertGameMethod1325SuperAnimTickGuard(tempPath);
    });
}

function testBaseAndLocalVariantKeepDamageFloatersClamped(): void {
    assertGameMethod527DamageFloatersClamped(BASE_SWF_PATH);
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertGameMethod527DamageFloatersClamped(tempPath);
    });
}

function testBaseAndLocalVariantKeepEntityRenderNullGuards(): void {
    assertInstanceMethodNullGuard(BASE_SWF_PATH, 'Entity', 'method_1826');
    assertInstanceMethodNullGuard(BASE_SWF_PATH, 'Entity', 'method_853');
    assertInstanceMethodNullGuard(BASE_SWF_PATH, 'Entity', 'method_900');
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertInstanceMethodNullGuard(tempPath, 'Entity', 'method_1826');
        assertInstanceMethodNullGuard(tempPath, 'Entity', 'method_853');
        assertInstanceMethodNullGuard(tempPath, 'Entity', 'method_900');
    });
}

function testBaseAndLocalVariantKeepActivePowerNullGuard(): void {
    assertInstanceBooleanMethodFalseNullGuard(BASE_SWF_PATH, 'ActivePower', 'method_243');
    assertInstanceMethodNullGuard(BASE_SWF_PATH, 'ActivePower', 'method_1507');
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertInstanceBooleanMethodFalseNullGuard(tempPath, 'ActivePower', 'method_243');
        assertInstanceMethodNullGuard(tempPath, 'ActivePower', 'method_1507');
    });
}

function testBaseAndLocalVariantKeepChatBubbleNullGuard(): void {
    assertInstanceMethodNullGuard(BASE_SWF_PATH, 'ChatBubble', 'method_901');
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertInstanceMethodNullGuard(tempPath, 'ChatBubble', 'method_901');
    });
}

function testBaseAndLocalVariantKeepMainMethod561UnclampedScale(): void {
    assertMainMethod561DoesNotClampMaxScale(BASE_SWF_PATH);
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertMainMethod561DoesNotClampMaxScale(tempPath);
    });
}

function testBaseAndLocalVariantKeepDungeonQuestHelperGuard(): void {
    assertDungeonQuestHelperPrefersDungeonProgress(BASE_SWF_PATH);
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertDungeonQuestHelperPrefersDungeonProgress(tempPath);
    });
}

function main(): void {
    testLocalVariantUsesLocalhostAndPort8000();
    testMultiplayerVariantUsesRemoteHostAndDefaultAssetPath();
    testVariantRemovesDungeonMountSpeedGate();
    testBaseAndLocalVariantKeepSuperAnimMethod200BitmapDataGuard();
    testBaseAndLocalVariantKeepClass82BitmapDataGuard();
    testBaseAndLocalVariantKeepClass23BitmapDataGuard();
    testBaseAndLocalVariantKeepClass72FloatTextBitmapDataGuard();
    testBaseAndLocalVariantKeepSuperAnimMethod806FullscreenBitmapData();
    testBaseAndLocalVariantKeepSuperAnimMethod982BitmapDataGuard();
    testBaseAndLocalVariantKeepGameMethod1947SafeScreenBitmapData();
    testBaseAndLocalVariantKeepGameMethod1325SuperAnimTickGuard();
    testBaseAndLocalVariantKeepDamageFloatersClamped();
    testBaseAndLocalVariantKeepEntityRenderNullGuards();
    testBaseAndLocalVariantKeepActivePowerNullGuard();
    testBaseAndLocalVariantKeepChatBubbleNullGuard();
    testBaseAndLocalVariantKeepMainMethod561UnclampedScale();
    testBaseAndLocalVariantKeepDungeonQuestHelperGuard();
    console.log('dungeonblitz_swf_variant_regression: ok');
}

main();
