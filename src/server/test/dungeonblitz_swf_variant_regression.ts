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
    readU30,
    u30OperandName
} from '../scripts/swfPatchUtils';
import type { Instruction } from '../scripts/swfPatchUtils';

const BASE_SWF_PATH = path.resolve(__dirname, '../../client/content/localhost/p/cbp/DungeonBlitz.swf');
const MULTIPLAYER_HOST = Config.MULTIPLAYER_HOST;
const MULTIPLAYER_REFRESH_URL = `http://${MULTIPLAYER_HOST}/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp`;
const METHOD_982_SAFE_TOTAL_PIXELS = 262144;
const BITMAPDATA_HARD_TOTAL_PIXELS = 16777215;

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

function getLocalOperand(instruction: Instruction): number | null {
    if (instruction.opcode >= 0xd0 && instruction.opcode <= 0xd3) {
        return instruction.opcode - 0xd0;
    }
    if (instruction.opcode === 0x62 && instruction.operands[0]?.[0] === 'u30') {
        return instruction.operands[0][1];
    }
    return null;
}

function setLocalOperand(instruction: Instruction): number | null {
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

function assertSuperAnimMethod982BitmapDataGuard(swfPath: string): void {
    const { abc, instructions } = getStaticMethodCode(swfPath, 'SuperAnimData', 'method_982');
    const constructorIndex = instructions.findIndex((instruction, index) => {
        const width = instructions[index + 1];
        const height = instructions[index + 2];
        const pushTrue = instructions[index + 3];
        const pushZero = instructions[index + 4];
        const construct = instructions[index + 5];

        return (
            instruction.opcode === 0x5d &&
            u30OperandName(instruction, abc.multinameNames) === 'BitmapData' &&
            getLocalOperand(width) === 11 &&
            getLocalOperand(height) === 12 &&
            pushTrue?.opcode === 0x26 &&
            pushZero?.opcode === 0x24 &&
            pushZero.operands[0]?.[1] === 0 &&
            construct?.opcode === 0x4a &&
            u30OperandName(construct, abc.multinameNames) === 'BitmapData' &&
            construct.operands[1]?.[1] === 4
        );
    });
    assert.notEqual(constructorIndex, -1, 'SuperAnimData.method_982 BitmapData constructor not found');

    const guardWindow = instructions.slice(Math.max(0, constructorIndex - 45), constructorIndex);
    assert.equal(
        guardWindow.filter((instruction) => instruction.opcode === 0x25 && instruction.operands[0]?.[1] === 8191).length >= 2,
        true,
        'SuperAnimData.method_982 guard must enforce the 8191 BitmapData axis limit'
    );
    assert.equal(
        instructions.some((instruction) => instruction.opcode === 0x25 && instruction.operands[0]?.[1] === 16777215),
        false,
        'SuperAnimData.method_982 guard must not encode the total pixel limit with pushshort'
    );
    assert.equal(
        guardWindow.some((instruction, index) => {
            const pushIntOperand = guardWindow[index + 3]?.operands[0];
            return (
                getLocalOperand(instruction) === 11 &&
                getLocalOperand(guardWindow[index + 1]) === 12 &&
                guardWindow[index + 2]?.opcode === 0xa2 &&
                guardWindow[index + 3]?.opcode === 0x2d &&
                pushIntOperand?.[0] === 'u30' &&
                abc.intValues[pushIntOperand[1]] === METHOD_982_SAFE_TOTAL_PIXELS &&
                guardWindow[index + 4]?.opcode === 0xaf
            );
        }),
        true,
        `SuperAnimData.method_982 guard must enforce the safe total pixel limit with pushint ${METHOD_982_SAFE_TOTAL_PIXELS}`
    );
}

function assertClass82Method193BitmapDataGuard(swfPath: string): void {
    const { abc, instructions } = getInstanceMethodCode(swfPath, 'class_82', 'method_193');
    const constructorIndex = instructions.findIndex((instruction, index) => {
        const width = instructions[index + 1];
        const height = instructions[index + 2];
        const pushTrue = instructions[index + 3];
        const pushZero = instructions[index + 4];
        const construct = instructions[index + 5];

        return (
            instruction.opcode === 0x5d &&
            u30OperandName(instruction, abc.multinameNames) === 'BitmapData' &&
            getLocalOperand(width) === 8 &&
            getLocalOperand(height) === 9 &&
            pushTrue?.opcode === 0x26 &&
            pushZero?.opcode === 0x24 &&
            pushZero.operands[0]?.[1] === 0 &&
            construct?.opcode === 0x4a &&
            u30OperandName(construct, abc.multinameNames) === 'BitmapData' &&
            construct.operands[1]?.[1] === 4
        );
    });
    assert.notEqual(constructorIndex, -1, 'class_82.method_193 BitmapData constructor not found');

    const guardWindow = instructions.slice(Math.max(0, constructorIndex - 45), constructorIndex);
    assert.equal(
        guardWindow.filter((instruction) => instruction.opcode === 0x25 && instruction.operands[0]?.[1] === 8191).length >= 2,
        true,
        'class_82.method_193 guard must enforce the 8191 BitmapData axis limit'
    );
    assert.equal(
        guardWindow.some((instruction, index) => {
            const pushIntOperand = guardWindow[index + 3]?.operands[0];
            return (
                getLocalOperand(instruction) === 8 &&
                getLocalOperand(guardWindow[index + 1]) === 9 &&
                guardWindow[index + 2]?.opcode === 0xa2 &&
                guardWindow[index + 3]?.opcode === 0x2d &&
                pushIntOperand?.[0] === 'u30' &&
                abc.intValues[pushIntOperand[1]] === BITMAPDATA_HARD_TOTAL_PIXELS &&
                guardWindow[index + 4]?.opcode === 0xaf
            );
        }),
        true,
        `class_82.method_193 guard must enforce the BitmapData total pixel limit with pushint ${BITMAPDATA_HARD_TOTAL_PIXELS}`
    );
    assert.equal(
        guardWindow.some((instruction, index) => instruction.opcode === 0x27 && guardWindow[index + 1]?.opcode === 0x48),
        true,
        'class_82.method_193 guard must return false instead of creating invalid cache bitmaps'
    );
}

function assertGameMethod1325SuperAnimCrashGuard(swfPath: string): void {
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
    const callIndex = instructions.findIndex((instruction) => (
        instruction.opcode === 0x46 &&
        u30OperandName(instruction, abc.multinameNames) === 'method_105' &&
        instruction.operands[1]?.[1] === 0
    ));
    assert.notEqual(callIndex, -1, 'Game.method_1325 SuperAnimInstance.method_105 call not found');

    const tryStart = instructions[callIndex - 1];
    const tryEnd = instructions[callIndex + 7];
    assert.equal(getLocalOperand(tryStart), 2, 'Game.method_1325 guard must start at SuperAnimInstance local');
    assert.equal(tryEnd?.opcode, 0x11, 'Game.method_1325 guard continuation branch not found');

    const errorName = abc.multinameNames.findIndex((name) => name === 'Error');
    const finishedName = abc.multinameNames.findIndex((name) => name === 'm_bFinished');
    assert.notEqual(errorName, -1, 'Error multiname not found');
    assert.notEqual(finishedName, -1, 'm_bFinished multiname not found');

    const guard = methodBody.exceptions.find((entry) => (
        entry.from === tryStart.offset &&
        entry.to === tryEnd.offset &&
        entry.type === errorName &&
        entry.target > tryEnd.offset &&
        entry.target < methodBody.codeLen
    ));
    assert.ok(guard, 'Game.method_1325 must catch SuperAnimInstance.method_105 render errors');
    const handlerStart = instructions.find((instruction) => instruction.offset === guard!.target);
    assert.equal(handlerStart?.opcode, 0xd0, 'Game.method_1325 catch handler must restore the Game scope');
    assert.equal(methodBody.maxScopeDepth >= 6, true, 'Game.method_1325 catch handler needs max_scope_depth >= 6');
    assert.equal(
        instructions.some((instruction) => (
            instruction.offset > guard!.target &&
            instruction.opcode === 0x61 &&
            instruction.operands[0]?.[1] === finishedName
        )),
        true,
        'Game.method_1325 crash guard must mark the SuperAnimInstance finished'
    );
}

function assertGameMethod930KeyboardNullGuard(swfPath: string): void {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const classIndex = classIndexByName(abc, 'Game');
    assert.notEqual(classIndex, null, 'Game class not found');

    const methodIdx = methodIdxForTrait(abc.instances[classIndex!].traits, abc, 'method_930');
    assert.notEqual(methodIdx, null, 'Game.method_930 not found');

    const methodBody = abc.methodBodies.get(methodIdx!);
    assert.ok(methodBody, 'Game.method_930 body not found');

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const instructions = disassemble(code, 'Game.method_930');
    const errorName = abc.multinameNames.findIndex((name) => name === 'Error');
    assert.notEqual(errorName, -1, 'Error multiname not found');

    const guard = methodBody.exceptions.find((entry) => (
        entry.from === 0 &&
        entry.type === errorName &&
        entry.target >= entry.to &&
        entry.target < methodBody.codeLen
    ));
    assert.ok(guard, 'Game.method_930 must catch early keyboard handler null errors');
    const handlerStart = instructions.find((instruction) => instruction.offset === guard!.target);
    assert.equal(handlerStart?.opcode, 0xd0, 'Game.method_930 catch handler must restore the Game scope');
    assert.equal(methodBody.maxScopeDepth >= 6, true, 'Game.method_930 catch handler needs max_scope_depth >= 6');
    assert.equal(
        instructions.some((instruction) => instruction.offset >= guard!.target && instruction.opcode === 0x47),
        true,
        'Game.method_930 keyboard null guard must return without crashing'
    );
}

function assertEntityMethod900DisplayNullGuard(swfPath: string): void {
    const { abc, instructions } = getInstanceMethodCode(swfPath, 'Entity', 'method_900');
    const guardIndex = instructions.findIndex((instruction, index) => {
        const getGfx = instructions[index + 1];
        const dup = instructions[index + 2];
        const missingGfxBranch = instructions[index + 3];
        const getDisplayObject = instructions[index + 4];
        const okBranch = instructions[index + 5];
        const missingDisplayReturn = instructions[index + 6];
        const missingGfxPop = instructions[index + 7];
        const missingGfxReturn = instructions[index + 8];

        return (
            instruction.opcode === 0xd0 &&
            getGfx?.opcode === 0x66 &&
            u30OperandName(getGfx, abc.multinameNames) === 'gfx' &&
            dup?.opcode === 0x2a &&
            missingGfxBranch?.opcode === 0x12 &&
            getDisplayObject?.opcode === 0x66 &&
            u30OperandName(getDisplayObject, abc.multinameNames) === 'm_TheDO' &&
            okBranch?.opcode === 0x11 &&
            missingDisplayReturn?.opcode === 0x47 &&
            missingGfxPop?.opcode === 0x29 &&
            missingGfxReturn?.opcode === 0x47
        );
    });
    assert.notEqual(guardIndex, -1, 'Entity.method_900 must return safely when gfx or m_TheDO is null');
}

function assertEntityMethod853VisualNullGuard(swfPath: string): void {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const classIndex = classIndexByName(abc, 'Entity');
    assert.notEqual(classIndex, null, 'Entity class not found');

    const methodIdx = methodIdxForTrait(abc.instances[classIndex!].traits, abc, 'method_853');
    assert.notEqual(methodIdx, null, 'Entity.method_853 not found');

    const methodBody = abc.methodBodies.get(methodIdx!);
    assert.ok(methodBody, 'Entity.method_853 body not found');

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const instructions = disassemble(code, 'Entity.method_853');
    const errorName = abc.multinameNames.findIndex((name) => name === 'Error');
    assert.notEqual(errorName, -1, 'Error multiname not found');

    const guard = methodBody.exceptions.find((entry) => (
        entry.from === 0 &&
        entry.type === errorName &&
        entry.target >= entry.to &&
        entry.target < methodBody.codeLen
    ));
    assert.ok(guard, 'Entity.method_853 must catch unsafe visual update null errors');
    const handlerStart = instructions.find((instruction) => instruction.offset === guard!.target);
    assert.equal(handlerStart?.opcode, 0xd0, 'Entity.method_853 catch handler must restore the Entity scope');
    assert.equal(methodBody.maxScopeDepth >= 6, true, 'Entity.method_853 catch handler needs max_scope_depth >= 6');
    assert.equal(
        instructions.some((instruction) => instruction.offset >= guard!.target && instruction.opcode === 0x47),
        true,
        'Entity.method_853 visual null guard must return without crashing'
    );
}

function assertEntityTakeDamageVisualNullGuard(swfPath: string): void {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const classIndex = classIndexByName(abc, 'Entity');
    assert.notEqual(classIndex, null, 'Entity class not found');

    const methodIdx = methodIdxForTrait(abc.instances[classIndex!].traits, abc, 'TakeDamage');
    assert.notEqual(methodIdx, null, 'Entity.TakeDamage not found');

    const methodBody = abc.methodBodies.get(methodIdx!);
    assert.ok(methodBody, 'Entity.TakeDamage body not found');

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const instructions = disassemble(code, 'Entity.TakeDamage');
    const errorName = abc.multinameNames.findIndex((name) => name === 'Error');
    assert.notEqual(errorName, -1, 'Error multiname not found');

    const displayAccesses = instructions.filter(
        (instruction) => u30OperandName(instruction, abc.multinameNames) === 'm_TheDO'
    );
    assert.equal(displayAccesses.length >= 6, true, 'Entity.TakeDamage damage floater display accesses not found');

    const firstDisplayOffset = displayAccesses[0].offset;
    const lastDisplayOffset = displayAccesses[displayAccesses.length - 1].offset;
    const guard = methodBody.exceptions.find((entry) => (
        entry.from < firstDisplayOffset &&
        entry.to > lastDisplayOffset &&
        entry.type === errorName &&
        entry.target >= entry.to &&
        entry.target < methodBody.codeLen
    ));
    assert.ok(guard, 'Entity.TakeDamage must catch unsafe damage floater display errors');
    const handlerStart = instructions.find((instruction) => instruction.offset === guard!.target);
    assert.equal(handlerStart?.opcode, 0xd0, 'Entity.TakeDamage catch handler must restore the Entity scope');
    assert.equal(methodBody.maxScopeDepth >= 6, true, 'Entity.TakeDamage catch handler needs max_scope_depth >= 6');
    assert.equal(
        instructions.some((instruction) => instruction.offset >= guard!.target && instruction.opcode === 0x10),
        true,
        'Entity.TakeDamage visual null guard must jump past unsafe damage floater code'
    );
}

function assertClass123Method1808RenderNullGuard(swfPath: string): void {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const classIndex = classIndexByName(abc, 'class_123');
    assert.notEqual(classIndex, null, 'class_123 class not found');

    const methodIdx = methodIdxForTrait(abc.instances[classIndex!].traits, abc, 'method_1808');
    assert.notEqual(methodIdx, null, 'class_123.method_1808 not found');

    const methodBody = abc.methodBodies.get(methodIdx!);
    assert.ok(methodBody, 'class_123.method_1808 body not found');

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const instructions = disassemble(code, 'class_123.method_1808');
    const errorName = abc.multinameNames.findIndex((name) => name === 'Error');
    assert.notEqual(errorName, -1, 'Error multiname not found');

    const guard = methodBody.exceptions.find((entry) => (
        entry.from === 0 &&
        entry.to === entry.target &&
        entry.type === errorName &&
        entry.target > 0 &&
        entry.target < methodBody.codeLen
    ));
    assert.ok(guard, 'class_123.method_1808 must catch render-cache null errors');
    const handlerStart = instructions.find((instruction) => instruction.offset === guard!.target);
    assert.equal(handlerStart?.opcode, 0xd0, 'class_123.method_1808 catch handler must restore the class_123 scope');
    assert.equal(methodBody.maxScopeDepth >= 6, true, 'class_123.method_1808 catch handler needs max_scope_depth >= 6');
    const [localCount] = readU30(ctx.body, methodBody.localCountPos, 'class_123.method_1808.local_count');
    assert.equal(localCount >= 35, true, 'class_123.method_1808 catch handler needs a catch local');
    assert.equal(
        instructions.some((instruction) => instruction.offset >= guard!.target && instruction.opcode === 0x47),
        true,
        'class_123.method_1808 render null guard must return without crashing'
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
        assert.equal(getStringMatchCount(tempPath, 'http://localhost:8000/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp'), 1);
        assert.equal(getStringMatchCount(tempPath, '/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp'), 0);
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
        assert.equal(getStringMatchCount(tempPath, '/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp'), 0);
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

function testBaseAndLocalVariantKeepSuperAnimBitmapDataGuard(): void {
    assertSuperAnimMethod982BitmapDataGuard(BASE_SWF_PATH);
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertSuperAnimMethod982BitmapDataGuard(tempPath);
    });
}

function testBaseAndLocalVariantKeepClass82BitmapDataGuard(): void {
    assertClass82Method193BitmapDataGuard(BASE_SWF_PATH);
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertClass82Method193BitmapDataGuard(tempPath);
    });
}

function testBaseAndLocalVariantKeepSuperAnimCrashGuard(): void {
    assertGameMethod1325SuperAnimCrashGuard(BASE_SWF_PATH);
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertGameMethod1325SuperAnimCrashGuard(tempPath);
    });
}

function testBaseAndLocalVariantKeepKeyboardNullGuard(): void {
    assertGameMethod930KeyboardNullGuard(BASE_SWF_PATH);
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertGameMethod930KeyboardNullGuard(tempPath);
    });
}

function testBaseAndLocalVariantKeepEntityDisplayNullGuard(): void {
    assertEntityMethod900DisplayNullGuard(BASE_SWF_PATH);
    assertEntityMethod853VisualNullGuard(BASE_SWF_PATH);
    assertEntityTakeDamageVisualNullGuard(BASE_SWF_PATH);
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertEntityMethod900DisplayNullGuard(tempPath);
        assertEntityMethod853VisualNullGuard(tempPath);
        assertEntityTakeDamageVisualNullGuard(tempPath);
    });
}

function testBaseAndLocalVariantKeepClass123RenderNullGuard(): void {
    assertClass123Method1808RenderNullGuard(BASE_SWF_PATH);
    const buffer = buildDungeonBlitzSwfVariantBuffer(BASE_SWF_PATH, 'local');
    withTempSwf(buffer, (tempPath) => {
        assertClass123Method1808RenderNullGuard(tempPath);
    });
}

function main(): void {
    testLocalVariantUsesLocalhostAndPort8000();
    testMultiplayerVariantUsesRemoteHostAndDefaultAssetPath();
    testVariantRemovesDungeonMountSpeedGate();
    testBaseAndLocalVariantKeepSuperAnimBitmapDataGuard();
    testBaseAndLocalVariantKeepClass82BitmapDataGuard();
    testBaseAndLocalVariantKeepSuperAnimCrashGuard();
    testBaseAndLocalVariantKeepKeyboardNullGuard();
    testBaseAndLocalVariantKeepEntityDisplayNullGuard();
    testBaseAndLocalVariantKeepClass123RenderNullGuard();
    console.log('dungeonblitz_swf_variant_regression: ok');
}

main();
