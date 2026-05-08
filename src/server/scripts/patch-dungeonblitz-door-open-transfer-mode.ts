import * as path from 'path';
import {
    classIndexByName,
    disassemble,
    ensureBackup,
    methodIdxForTrait,
    parseAbc,
    parseSwf,
    writeSwf
} from './swfPatchUtils';

const DEFAULT_SWF = path.resolve(
    __dirname,
    '..',
    '..',
    'client',
    'content',
    'localhost',
    'p',
    'cbp',
    'DungeonBlitz.swf'
);

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
    let swfPath = DEFAULT_SWF;
    let verify = false;

    for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--swf' || arg === '-s') {
            swfPath = path.resolve(argv[++index] || '');
            continue;
        }
        if (arg === '--verify') {
            verify = true;
            continue;
        }
        if (arg === '--help' || arg === '-h') {
            console.log([
                'Usage:',
                '  npx ts-node src/server/scripts/patch-dungeonblitz-door-open-transfer-mode.ts [--verify] [--swf <path>]',
                '',
                'Patches Game.OpenDoor so clicking a denied door does not put the client into transfer mode',
                'before the server has accepted the transfer with a door target packet.'
            ].join('\n'));
            process.exit(0);
        }

        throw new Error(`Unknown argument: ${arg}`);
    }

    return { swfPath, verify };
}

function findOpenDoorTransferModeWrite(swfPath: string): { bodyOffset: number; opcode: number } {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const gameClassIndex = classIndexByName(abc, 'Game');
    if (gameClassIndex === null) {
        throw new Error('Could not find Game class in DungeonBlitz SWF.');
    }

    const openDoorMethod = methodIdxForTrait(abc.instances[gameClassIndex].traits, abc, 'OpenDoor');
    if (openDoorMethod === null) {
        throw new Error('Could not find Game.OpenDoor method in DungeonBlitz SWF.');
    }

    const methodBody = abc.methodBodies.get(openDoorMethod);
    if (!methodBody) {
        throw new Error(`Could not find method body for Game.OpenDoor (${openDoorMethod}).`);
    }

    const code = ctx.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
    const instructions = disassemble(code, `Game.OpenDoor:${openDoorMethod}`);
    const mbTransferModeIndex = abc.multinameNames.findIndex((name) => name === 'mbTransferMode');
    if (mbTransferModeIndex < 0) {
        throw new Error('Could not find mbTransferMode multiname.');
    }

    for (let index = 0; index < instructions.length - 1; index += 1) {
        const instruction = instructions[index];
        const next = instructions[index + 1];
        if (
            (instruction.opcode === 0x26 || instruction.opcode === 0x27) &&
            next.opcode === 0x68 &&
            next.operands[0]?.[1] === mbTransferModeIndex
        ) {
            return {
                bodyOffset: methodBody.codeStart + instruction.offset,
                opcode: instruction.opcode
            };
        }
    }

    throw new Error('Could not find Game.OpenDoor mbTransferMode assignment.');
}

function patchSwf(swfPath: string, verify: boolean): void {
    const ctx = parseSwf(swfPath);
    const { bodyOffset, opcode } = findOpenDoorTransferModeWrite(swfPath);

    if (opcode === 0x27) {
        console.log(`${swfPath}: already patched (Game.OpenDoor keeps transfer mode false).`);
        return;
    }

    if (opcode !== 0x26) {
        throw new Error(`Unexpected opcode 0x${opcode.toString(16)} at body offset ${bodyOffset}.`);
    }

    if (verify) {
        throw new Error(`${swfPath}: verify failed; Game.OpenDoor still enables transfer mode before server acceptance.`);
    }

    ensureBackup(swfPath);
    ctx.body[bodyOffset] = 0x27;
    writeSwf(ctx, ctx.body, 0);
    console.log(`${swfPath}: patched Game.OpenDoor transfer-mode pre-arm.`);
}

const { swfPath, verify } = parseArgs(process.argv);
patchSwf(swfPath, verify);
