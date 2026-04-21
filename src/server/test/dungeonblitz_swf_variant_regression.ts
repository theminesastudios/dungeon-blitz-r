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

const BASE_SWF_PATH = path.resolve(__dirname, '../../client/content/localhost/p/cbp/DungeonBlitz.swf');
const MULTIPLAYER_HOST = Config.MULTIPLAYER_HOST;
const MULTIPLAYER_REFRESH_URL = `http://${MULTIPLAYER_HOST}/p/cbp/DungeonBlitz.swf?fv=cbq&gv=cbp`;

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

function main(): void {
    testLocalVariantUsesLocalhostAndPort8000();
    testMultiplayerVariantUsesRemoteHostAndDefaultAssetPath();
    testVariantRemovesDungeonMountSpeedGate();
    console.log('dungeonblitz_swf_variant_regression: ok');
}

main();
