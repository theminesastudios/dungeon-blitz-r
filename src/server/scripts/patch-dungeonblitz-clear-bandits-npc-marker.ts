import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import {
    applyPatchesToBody,
    BytePatch,
    classIndexByName,
    disassemble,
    ensureBackup,
    methodIdxForTrait,
    parseAbc,
    parseSwf,
    PatchError,
    readU30,
    u30OperandName,
    writeSwf,
    writeU30
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
const INDEX_HTML = path.resolve(__dirname, '..', '..', 'client', 'content', 'localhost', 'index.html');
const CLEAR_THE_BANDITS_MISSION_ID = 11;
const SEE_THE_WARDEN_MISSION_ID = 32;
const CLEAR_THE_BANDITS_COMPLETE_COUNT = 20;
const FELGUARD_CONTACT_NAME = 'Felguard';
const FELGUARD_MAP_X = 699;
const FELGUARD_MAP_Y = 314;
const MARKER_ASSETS = new Map([
    ['const_449', 'a_Notify_NewQuest'],
    ['const_599', 'a_Notify_ActiveQuest'],
    ['const_482', 'a_Notify_ReturnQuest']
]);

function parseArgs(argv: string[]): { swfPath: string; verify: boolean } {
    let swfPath = DEFAULT_SWF;
    let verify = false;
    for (let index = 2; index < argv.length; index += 1) {
        const arg = argv[index];
        if (arg === '--verify') {
            verify = true;
        } else if (arg === '--swf' || arg === '-s') {
            swfPath = path.resolve(argv[++index] ?? '');
        } else {
            throw new Error(`Unknown argument: ${arg}`);
        }
    }
    return { swfPath, verify };
}

function encodeS24(value: number): Buffer {
    if (value < -0x800000 || value > 0x7fffff) {
        throw new PatchError(`s24 out of range: ${value}`);
    }
    const out = Buffer.alloc(3);
    out.writeIntLE(value, 0, 3);
    return out;
}

function opU30(opcode: number, value: number): Buffer {
    return Buffer.concat([Buffer.from([opcode]), writeU30(value)]);
}

function opU30U30(opcode: number, first: number, second: number): Buffer {
    return Buffer.concat([Buffer.from([opcode]), writeU30(first), writeU30(second)]);
}

function pushByte(value: number): Buffer {
    return Buffer.from([0x24, value & 0xff]);
}

function encodeString(value: string): Buffer {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([writeU30(bytes.length), bytes]);
}

function branch(opcode: number, fromOffset: number, targetOffset: number): Buffer {
    return Buffer.concat([Buffer.from([opcode]), encodeS24(targetOffset - (fromOffset + 4))]);
}

function ensureFelguardString(swfPath: string): void {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    if (abc.stringValues.includes(FELGUARD_CONTACT_NAME)) {
        return;
    }
    const patches: BytePatch[] = [{
        key: 'felguard-string-count',
        start: abc.stringCountPos,
        end: abc.stringCountEnd,
        data: writeU30(abc.stringValues.length + 1),
        detail: 'reserve the Felguard contact string'
    }, {
        key: 'felguard-string-value',
        start: abc.stringPoolEnd,
        end: abc.stringPoolEnd,
        data: encodeString(FELGUARD_CONTACT_NAME),
        detail: 'add the Felguard contact string'
    }];
    ensureBackup(swfPath);
    const patched = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, patched.body, patched.delta);
    const verified = parseAbc(parseSwf(swfPath));
    if (!verified.stringValues.includes(FELGUARD_CONTACT_NAME)) {
        throw new PatchError('Could not add the Felguard contact string.');
    }
    console.log(`${path.basename(swfPath)} patched with the Felguard contact string.`);
}

function assertInstanceSlotType(
    abc: ReturnType<typeof parseAbc>,
    className: string,
    slotName: string,
    expectedType: string
): void {
    const classIndex = classIndexByName(abc, className);
    if (classIndex === null) {
        throw new PatchError(`Could not find ${className} while checking ${slotName}.`);
    }
    const trait = abc.instances[classIndex].traits.find((candidate) =>
        abc.multinameNames[candidate.nameIdx] === slotName && candidate.typeNameIdx !== undefined
    );
    const actualType = trait?.typeNameIdx === undefined
        ? undefined
        : abc.multinameNames[trait.typeNameIdx];
    if (actualType !== expectedType) {
        throw new PatchError(
            `${className}.${slotName} type changed unexpectedly: ${actualType ?? 'missing'} (expected ${expectedType}).`
        );
    }
}

function findMarkerContext(swfPath: string) {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const gameIndex = classIndexByName(abc, 'Game');
    if (gameIndex === null) {
        throw new PatchError('Could not find Game.');
    }
    const resolverMethodIdx = methodIdxForTrait(abc.instances[gameIndex].traits, abc, 'method_793');
    if (resolverMethodIdx === null) {
        throw new PatchError('Could not find the NPC mission-marker resolver.');
    }
    const resolverBody = abc.methodBodies.get(resolverMethodIdx);
    if (!resolverBody) {
        throw new PatchError('The NPC mission-marker resolver has no method body.');
    }
    const resolverMethodInfo = abc.methodInfos[resolverMethodIdx];
    if (
        !resolverMethodInfo ||
        resolverMethodInfo.paramTypes.length !== 1 ||
        abc.multinameNames[resolverMethodInfo.paramTypes[0]] !== 'class_35' ||
        abc.multinameNames[resolverMethodInfo.returnType] !== 'uint'
    ) {
        throw new PatchError('The NPC mission-marker resolver signature changed unexpectedly.');
    }

    const entityIndex = classIndexByName(abc, 'Entity');
    if (entityIndex === null) {
        throw new PatchError('Could not find Entity.');
    }
    const markerMethodIdx = methodIdxForTrait(abc.instances[entityIndex].traits, abc, 'method_397');
    if (markerMethodIdx === null) {
        throw new PatchError('Could not find the NPC mission-marker renderer.');
    }
    const markerBody = abc.methodBodies.get(markerMethodIdx);
    if (!markerBody) {
        throw new PatchError('The NPC mission-marker renderer has no method body.');
    }
    const markerMethodInfo = abc.methodInfos[markerMethodIdx];
    if (
        !markerMethodInfo ||
        markerMethodInfo.paramTypes.length !== 1 ||
        abc.multinameNames[markerMethodInfo.paramTypes[0]] !== 'uint' ||
        abc.multinameNames[markerMethodInfo.returnType] !== 'void'
    ) {
        throw new PatchError('The NPC mission-marker renderer signature changed unexpectedly.');
    }
    assertInstanceSlotType(abc, 'Entity', 'cue', 'a_Cue');
    assertInstanceSlotType(abc, 'Entity', 'var_1', 'Game');
    assertInstanceSlotType(abc, 'a_Cue', 'characterName', 'String');
    assertInstanceSlotType(abc, 'Mission', 'currCount', 'uint');
    return { ctx, abc, markerBody, resolverBody };
}

function findUniqueOperand(code: Buffer, names: string[], opcode: number, name: string): number {
    const matches = disassemble(code, `Game.method_793.${name}`)
        .filter((instruction) => instruction.opcode === opcode && u30OperandName(instruction, names) === name)
        .map((instruction) => instruction.operands[0]?.[1])
        .filter((value): value is number => value !== undefined);
    const unique = [...new Set(matches)];
    if (unique.length !== 1) {
        throw new PatchError(`Expected one ${name} operand in the marker resolver, found ${unique.length}.`);
    }
    return unique[0];
}

function findUniqueMultiname(names: string[], name: string): number {
    const matches = names
        .map((candidate, index) => candidate === name ? index : -1)
        .filter((index) => index >= 0);
    if (matches.length !== 1) {
        throw new PatchError(`Expected one ${name} multiname, found ${matches.length}.`);
    }
    return matches[0];
}

function findInsertionOffset(code: Buffer, label = 'Entity.method_397'): number {
    const instructions = disassemble(code, `${label}.insertion`);
    for (let index = 0; index < instructions.length - 1; index += 1) {
        if (instructions[index].opcode === 0xd0 && instructions[index + 1].opcode === 0x30) {
            return instructions[index + 1].offset + instructions[index + 1].size;
        }
    }
    throw new PatchError(`Could not find ${label} scope initialization.`);
}

type MarkerOperands = {
    cue: number;
    contactName: number;
    game: number;
    missionList: number;
    dynamicLookup: number;
    missionClass: number;
    entityClass: number;
    missionState: number;
    missionProgress: number;
    missionCompleteState: number;
    missionClaimedState: number;
    newMarkerState: number;
    activeMarkerState: number;
    returnMarkerState: number;
    missionIsComplete: number;
};

function buildMarkerGuard(
    insertionOffset: number,
    felguardStringIndex: number,
    operands: MarkerOperands
): Buffer {
    const chunks: Buffer[] = [];
    let length = 0;
    const emit = (buffer: Buffer): number => {
        const offset = length;
        chunks.push(buffer);
        length += buffer.length;
        return offset;
    };
    const placeholder = (): { index: number; offset: number } => {
        const index = chunks.length;
        const offset = emit(Buffer.alloc(4));
        return { index, offset };
    };
    const patchBranch = (
        placeholderInfo: { index: number; offset: number },
        opcode: number,
        targetOffset: number
    ): void => {
        chunks[placeholderInfo.index] = branch(
            opcode,
            insertionOffset + placeholderInfo.offset,
            insertionOffset + targetOffset
        );
    };

    // Entity.method_397 is called for every NPC marker refresh, even when the
    // load-sensitive MissionTypes metadata has no Mission 11 contact entry.
    emit(Buffer.from([0xd0]));
    emit(opU30(0x66, operands.cue));
    const ifCueMissing = placeholder();
    emit(Buffer.from([0xd0]));
    emit(opU30(0x66, operands.cue));
    emit(opU30(0x66, operands.contactName));
    emit(opU30(0x2c, felguardStringIndex));
    emit(Buffer.from([0xab])); // equals
    const ifOtherNpc = placeholder();

    // Mission 11 remains absent from the load-sensitive client MissionTypes XML,
    // but its runtime Mission entry is still created by the normal mission packets.
    emit(opU30(0x60, operands.game));
    emit(opU30(0x66, operands.missionList));
    emit(pushByte(CLEAR_THE_BANDITS_MISSION_ID));
    emit(opU30(0x66, operands.dynamicLookup));
    emit(opU30(0x80, operands.missionClass)); // coerce Mission
    emit(Buffer.from([0xd6])); // setlocal2; original code reinitializes it on fall-through
    emit(Buffer.from([0xd2]));
    const ifMissionExists = placeholder();

    // No Mission 11 entry means the quest has not been accepted. Once its real
    // prerequisite is claimed, use the standard yellow new-quest exclamation.
    emit(opU30(0x60, operands.game));
    emit(pushByte(SEE_THE_WARDEN_MISSION_ID));
    emit(opU30U30(0x46, operands.missionIsComplete, 1));
    const ifPrerequisiteMissing = placeholder();
    emit(opU30(0x60, operands.entityClass));
    emit(opU30(0x66, operands.newMarkerState));
    emit(Buffer.from([0xd5])); // setlocal1: marker renderer input state
    const afterNewMarker = placeholder();

    const missionExistsOffset = length;
    // Claimed must win over the 20/20 fallback so the marker disappears after turn-in.
    emit(Buffer.from([0xd2]));
    emit(opU30(0x66, operands.missionState));
    emit(opU30(0x60, operands.missionClass));
    emit(opU30(0x66, operands.missionClaimedState));
    emit(Buffer.from([0xab]));
    const ifAlreadyClaimed = placeholder();

    emit(Buffer.from([0xd2]));
    emit(opU30(0x66, operands.missionState));
    emit(opU30(0x60, operands.missionClass));
    emit(opU30(0x66, operands.missionCompleteState));
    emit(Buffer.from([0xab]));
    const ifReadyState = placeholder();

    // Mission 11 has no load-sensitive class_13 metadata. Treat its authoritative
    // 20/20 runtime counter as ready too, even if the completion packet arrived
    // before the marker renderer was refreshed.
    emit(Buffer.from([0xd2]));
    emit(opU30(0x66, operands.missionProgress));
    emit(pushByte(CLEAR_THE_BANDITS_COMPLETE_COUNT));
    const ifReadyProgress = placeholder();

    emit(opU30(0x60, operands.entityClass));
    emit(opU30(0x66, operands.activeMarkerState));
    emit(Buffer.from([0xd5]));
    const afterActiveMarker = placeholder();

    const readyToTurnInOffset = length;
    emit(opU30(0x60, operands.entityClass));
    emit(opU30(0x66, operands.returnMarkerState));
    emit(Buffer.from([0xd5]));
    const afterReturnMarker = placeholder();

    // Restore the renderer's scratch local before entering the original code.
    const cleanupOffset = length;
    emit(Buffer.from([0x27, 0xd6])); // pushfalse; setlocal2
    const originalRendererOffset = length;
    patchBranch(ifCueMissing, 0x12, originalRendererOffset); // iffalse
    patchBranch(ifOtherNpc, 0x12, originalRendererOffset); // iffalse
    patchBranch(ifMissionExists, 0x11, missionExistsOffset); // iftrue
    patchBranch(ifPrerequisiteMissing, 0x12, cleanupOffset);
    patchBranch(afterNewMarker, 0x10, cleanupOffset);
    patchBranch(ifAlreadyClaimed, 0x11, cleanupOffset);
    patchBranch(ifReadyState, 0x11, readyToTurnInOffset);
    patchBranch(ifReadyProgress, 0x18, readyToTurnInOffset); // ifge: currCount >= 20
    patchBranch(afterActiveMarker, 0x10, cleanupOffset);
    patchBranch(afterReturnMarker, 0x10, cleanupOffset);
    return Buffer.concat(chunks);
}

function branchAdjustmentPatches(
    body: ReturnType<typeof findMarkerContext>['markerBody'],
    code: Buffer,
    insertionOffset: number,
    insertionLength: number,
    preserveBranchesToInsertion = false
): BytePatch[] {
    const patches: BytePatch[] = [];
    for (const instruction of disassemble(code, 'Entity.method_397.branches')) {
        const operand = instruction.operands[0];
        if (!operand || operand[0] !== 's24') {
            continue;
        }
        const target = instruction.offset + instruction.size + operand[1];
        let next = operand[1];
        if (instruction.offset < insertionOffset && target >= insertionOffset) {
            if (preserveBranchesToInsertion && target === insertionOffset) {
                continue;
            }
            next += insertionLength;
        } else if (instruction.offset >= insertionOffset && target < insertionOffset) {
            next -= insertionLength;
        } else {
            continue;
        }
        patches.push({
            key: `npc-marker-branch-${instruction.offset}`,
            start: body.codeStart + instruction.offset + 1,
            end: body.codeStart + instruction.offset + instruction.size,
            data: encodeS24(next),
            detail: 'adjust NPC marker resolver branch across Mission 11 guard'
        });
    }
    return patches;
}

function verifyBranchTargets(code: Buffer): void {
    const instructions = disassemble(code, 'Clear the Bandits NPC marker');
    const offsets = new Set(instructions.map((instruction) => instruction.offset));
    offsets.add(code.length);
    for (const instruction of instructions) {
        for (const operand of instruction.operands) {
            if (operand[0] !== 's24') {
                continue;
            }
            const target = instruction.offset + instruction.size + operand[1];
            if (!offsets.has(target)) {
                throw new PatchError(
                    `NPC marker resolver has an invalid branch from ${instruction.offset} to ${target}.`
                );
            }
        }
    }
}

function verifyMarkerAssets(swfPath: string): void {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const entityIndex = classIndexByName(abc, 'Entity');
    if (entityIndex === null) {
        throw new PatchError('Could not find Entity while verifying mission marker assets.');
    }
    const methodIdx = methodIdxForTrait(abc.instances[entityIndex].traits, abc, 'method_397');
    const body = methodIdx === null ? undefined : abc.methodBodies.get(methodIdx);
    if (!body) {
        throw new PatchError('Could not find the Entity mission-marker renderer.');
    }
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const instructions = disassemble(code, 'Entity.method_397.marker-assets');
    for (const [stateName, assetName] of MARKER_ASSETS) {
        const assetIndex = abc.stringValues.indexOf(assetName);
        const assetInstruction = instructions.find((instruction) =>
            instruction.opcode === 0x2c && instruction.operands[0]?.[1] === assetIndex
        );
        if (!assetInstruction) {
            throw new PatchError(`NPC marker renderer is missing ${assetName}.`);
        }
        const stateUsedNearby = instructions.some((instruction) =>
            instruction.offset >= assetInstruction.offset - 40 &&
            instruction.offset < assetInstruction.offset &&
            instruction.opcode === 0x60 &&
            u30OperandName(instruction, abc.multinameNames) === stateName
        );
        if (!stateUsedNearby) {
            throw new PatchError(`${stateName} no longer selects ${assetName}.`);
        }
    }
}

function hasCompleteProgressFallback(
    instructions: ReturnType<typeof disassemble>,
    names: string[]
): boolean {
    return instructions.some((instruction, index) =>
        instruction.opcode === 0x66 &&
        u30OperandName(instruction, names) === 'currCount' &&
        instructions[index + 1]?.opcode === 0x24 &&
        instructions[index + 1]?.operands[0]?.[1] === CLEAR_THE_BANDITS_COMPLETE_COUNT &&
        instructions[index + 2]?.opcode === 0x18
    );
}

function hasMarkerPatch(
    abc: ReturnType<typeof parseAbc>,
    code: Buffer
): boolean {
    const felguardIndex = abc.stringValues.indexOf(FELGUARD_CONTACT_NAME);
    if (felguardIndex < 0) {
        return false;
    }
    const instructions = disassemble(code, 'Clear the Bandits NPC marker verify');
    const hasPushString = instructions.some((instruction) =>
        instruction.opcode === 0x2c && instruction.operands[0]?.[1] === felguardIndex
    );
    const pushedBytes = new Set(
        instructions
            .filter((instruction) => instruction.opcode === 0x24)
            .map((instruction) => instruction.operands[0]?.[1])
    );
    const requiredNames = new Set([
        'cue',
        'characterName',
        'var_1',
        'mMissionInfoList',
        'MissionIsComplete',
        'currCount',
        'const_58',
        'const_72',
        'const_449',
        'const_599',
        'const_482'
    ]);
    const usedNames = new Set(
        instructions
            .filter((instruction) => instruction.operands[0]?.[0] === 'u30')
            .map((instruction) => u30OperandName(instruction, abc.multinameNames))
            .filter((name): name is string => Boolean(name))
    );
    const hasGlobalMissionLookup = instructions.some((instruction, index) =>
        instruction.opcode === 0x60 &&
        u30OperandName(instruction, abc.multinameNames) === 'var_1' &&
        instructions[index + 1]?.opcode === 0x66 &&
        u30OperandName(instructions[index + 1], abc.multinameNames) === 'mMissionInfoList' &&
        instructions[index + 2]?.opcode === 0x24 &&
        instructions[index + 2]?.operands[0]?.[1] === CLEAR_THE_BANDITS_MISSION_ID
    );
    return hasPushString &&
        hasGlobalMissionLookup &&
        pushedBytes.has(CLEAR_THE_BANDITS_MISSION_ID) &&
        pushedBytes.has(SEE_THE_WARDEN_MISSION_ID) &&
        pushedBytes.has(CLEAR_THE_BANDITS_COMPLETE_COUNT) &&
        hasCompleteProgressFallback(instructions, abc.multinameNames) &&
        [...requiredNames].every((name) => usedNames.has(name));
}

function verifyNpcMarker(swfPath: string): void {
    const { ctx, abc, markerBody } = findMarkerContext(swfPath);
    const code = ctx.body.subarray(markerBody.codeStart, markerBody.codeStart + markerBody.codeLen);
    if (!hasMarkerPatch(abc, code)) {
        throw new PatchError(`${path.basename(swfPath)} is missing the Clear the Bandits NPC marker flow.`);
    }
    const maxStack = readU30(ctx.body, markerBody.maxStackPos, 'NPC marker max stack')[0];
    if (maxStack < 5) {
        throw new PatchError(`NPC marker renderer max stack is unexpectedly low: ${maxStack}.`);
    }
    if (markerBody.exceptionCount !== 0) {
        throw new PatchError('NPC marker renderer unexpectedly contains an exception table.');
    }
    verifyBranchTargets(code);
    verifyMarkerAssets(swfPath);
    console.log(`${path.basename(swfPath)} Clear the Bandits NPC marker verify ok.`);
}

function patchNpcMarker(swfPath: string): void {
    const { ctx, abc, markerBody, resolverBody } = findMarkerContext(swfPath);
    const code = ctx.body.subarray(markerBody.codeStart, markerBody.codeStart + markerBody.codeLen);
    const resolverCode = ctx.body.subarray(
        resolverBody.codeStart,
        resolverBody.codeStart + resolverBody.codeLen
    );
    if (hasMarkerPatch(abc, code)) {
        console.log(`${path.basename(swfPath)} already has the Clear the Bandits NPC marker flow.`);
        return;
    }
    if (markerBody.exceptionCount !== 0) {
        throw new PatchError('NPC marker renderer has an unexpected exception table.');
    }

    const insertionOffset = findInsertionOffset(code);
    const felguardStringIndex = abc.stringValues.indexOf(FELGUARD_CONTACT_NAME) >= 0
        ? abc.stringValues.indexOf(FELGUARD_CONTACT_NAME)
        : abc.stringValues.length;
    const mapContext = findMapContext(swfPath);
    const mapCode = mapContext.ctx.body.subarray(
        mapContext.body.codeStart,
        mapContext.body.codeStart + mapContext.body.codeLen
    );
    const operands: MarkerOperands = {
        cue: findUniqueMultiname(abc.multinameNames, 'cue'),
        contactName: findUniqueMultiname(abc.multinameNames, 'characterName'),
        game: findUniqueOperand(mapCode, abc.multinameNames, 0x60, 'var_1'),
        missionList: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'mMissionInfoList'),
        dynamicLookup: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, '*'),
        missionClass: findUniqueOperand(resolverCode, abc.multinameNames, 0x60, 'Mission'),
        entityClass: findUniqueOperand(resolverCode, abc.multinameNames, 0x60, 'Entity'),
        missionState: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'var_145'),
        missionProgress: findUniqueMultiname(abc.multinameNames, 'currCount'),
        missionCompleteState: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'const_58'),
        missionClaimedState: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'const_72'),
        newMarkerState: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'const_449'),
        activeMarkerState: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'const_599'),
        returnMarkerState: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'const_482'),
        missionIsComplete: findUniqueMultiname(abc.multinameNames, 'MissionIsComplete')
    };
    const guard = buildMarkerGuard(insertionOffset, felguardStringIndex, operands);
    const patches: BytePatch[] = [];
    if (abc.stringValues.indexOf(FELGUARD_CONTACT_NAME) < 0) {
        patches.push({
            key: 'npc-marker-string-count',
            start: abc.stringCountPos,
            end: abc.stringCountEnd,
            data: writeU30(abc.stringValues.length + 1),
            detail: 'reserve the Felguard NPC marker string'
        }, {
            key: 'npc-marker-string',
            start: abc.stringPoolEnd,
            end: abc.stringPoolEnd,
            data: encodeString(FELGUARD_CONTACT_NAME),
            detail: 'add the Felguard NPC marker string'
        });
    }
    patches.push({
        key: 'npc-marker-code-length',
        start: markerBody.codeLenPos,
        end: markerBody.codeStart,
        data: writeU30(markerBody.codeLen + guard.length),
        detail: 'update NPC marker renderer code length'
    }, {
        key: 'npc-marker-guard',
        start: markerBody.codeStart + insertionOffset,
        end: markerBody.codeStart + insertionOffset,
        data: guard,
        detail: 'map Mission 11 to exclamation, question and green check markers'
    }, ...branchAdjustmentPatches(markerBody, code, insertionOffset, guard.length));

    ensureBackup(swfPath);
    const patched = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, patched.body, patched.delta);
    verifyNpcMarker(swfPath);
    console.log(`${path.basename(swfPath)} patched with the Clear the Bandits NPC marker flow.`);
}

type SpawnMarkerOperands = {
    cue: number;
    characterName: number;
    game: number;
    missionList: number;
    dynamicLookup: number;
    missionClass: number;
    missionState: number;
    missionProgress: number;
    missionCompleteState: number;
    missionClaimedState: number;
    entityClass: number;
    noMarkerState: number;
    newMarkerState: number;
    activeMarkerState: number;
    returnMarkerState: number;
    missionIsComplete: number;
};

function findNpcSpawnMarkerContext(swfPath: string) {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const entityIndex = classIndexByName(abc, 'Entity');
    const gameIndex = classIndexByName(abc, 'Game');
    if (entityIndex === null || gameIndex === null) {
        throw new PatchError('Could not find Entity or Game while locating the NPC spawn marker flow.');
    }
    const body = abc.methodBodies.get(abc.instances[entityIndex].iinitMethodIdx);
    const resolverMethodIdx = methodIdxForTrait(abc.instances[gameIndex].traits, abc, 'method_793');
    const resolverBody = resolverMethodIdx === null ? undefined : abc.methodBodies.get(resolverMethodIdx);
    if (!body || !resolverBody) {
        throw new PatchError('The Entity constructor or mission-marker resolver is incomplete.');
    }
    assertInstanceSlotType(abc, 'Entity', 'cue', 'a_Cue');
    assertInstanceSlotType(abc, 'Entity', 'var_1', 'Game');
    assertInstanceSlotType(abc, 'a_Cue', 'characterName', 'String');
    assertInstanceSlotType(abc, 'Mission', 'currCount', 'uint');
    return { ctx, abc, body, resolverBody };
}

function findSpawnMarkerInsertionPoint(
    code: Buffer,
    names: string[]
): { insertionOffset: number; markerLocal: number } {
    const instructions = disassemble(code, 'Entity.iinit.spawn-marker');
    const calls = instructions
        .map((instruction, index) => ({ instruction, index }))
        .filter(({ instruction }) =>
            instruction.opcode === 0x4f &&
            u30OperandName(instruction, names) === 'method_397' &&
            instruction.operands[1]?.[1] === 1
        );
    if (calls.length !== 1) {
        throw new PatchError(`Expected one Entity constructor marker call, found ${calls.length}.`);
    }
    const { index } = calls[0];
    const receiver = instructions[index - 2];
    const marker = instructions[index - 1];
    if (
        receiver?.opcode !== 0xd0 ||
        marker?.opcode !== 0x62 ||
        marker.operands[0]?.[1] === undefined
    ) {
        throw new PatchError('Entity constructor marker call no longer uses this and a marker-state local.');
    }
    return {
        insertionOffset: receiver.offset,
        markerLocal: marker.operands[0][1]
    };
}

function buildSpawnMarkerGuard(
    insertionOffset: number,
    markerLocal: number,
    scratchLocal: number,
    felguardStringIndex: number,
    operands: SpawnMarkerOperands
): Buffer {
    const chunks: Buffer[] = [];
    let length = 0;
    const emit = (buffer: Buffer): number => {
        const offset = length;
        chunks.push(buffer);
        length += buffer.length;
        return offset;
    };
    const placeholder = (): { index: number; offset: number } => {
        const index = chunks.length;
        const offset = emit(Buffer.alloc(4));
        return { index, offset };
    };
    const patchBranch = (
        placeholderInfo: { index: number; offset: number },
        opcode: number,
        targetOffset: number
    ): void => {
        chunks[placeholderInfo.index] = branch(
            opcode,
            insertionOffset + placeholderInfo.offset,
            insertionOffset + targetOffset
        );
    };

    // This runs after the constructor's normal class_35 lookup and immediately
    // before its standard Entity.method_397 call. Felguard has no class_35 row,
    // so the normal path leaves markerLocal at Entity.const_282 (no marker).
    emit(Buffer.from([0xd0]));
    emit(opU30(0x66, operands.cue));
    const ifCueMissing = placeholder();
    emit(Buffer.from([0xd0]));
    emit(opU30(0x66, operands.cue));
    emit(opU30(0x66, operands.characterName));
    emit(opU30(0x2c, felguardStringIndex));
    emit(Buffer.from([0xab]));
    const ifOtherNpc = placeholder();

    emit(Buffer.from([0xd0]));
    emit(opU30(0x66, operands.game));
    emit(opU30(0x66, operands.missionList));
    emit(pushByte(CLEAR_THE_BANDITS_MISSION_ID));
    emit(opU30(0x66, operands.dynamicLookup));
    emit(opU30(0x80, operands.missionClass));
    emit(opU30(0x63, scratchLocal));
    emit(opU30(0x62, scratchLocal));
    const ifMissionExists = placeholder();

    emit(Buffer.from([0xd0]));
    emit(opU30(0x66, operands.game));
    emit(pushByte(SEE_THE_WARDEN_MISSION_ID));
    emit(opU30U30(0x46, operands.missionIsComplete, 1));
    const ifPrerequisiteMissing = placeholder();
    emit(opU30(0x60, operands.entityClass));
    emit(opU30(0x66, operands.newMarkerState));
    emit(opU30(0x63, markerLocal));
    const afterNewMarker = placeholder();

    const missionExistsOffset = length;
    emit(opU30(0x62, scratchLocal));
    emit(opU30(0x66, operands.missionState));
    emit(opU30(0x60, operands.missionClass));
    emit(opU30(0x66, operands.missionClaimedState));
    emit(Buffer.from([0xab]));
    const ifClaimed = placeholder();

    emit(opU30(0x62, scratchLocal));
    emit(opU30(0x66, operands.missionState));
    emit(opU30(0x60, operands.missionClass));
    emit(opU30(0x66, operands.missionCompleteState));
    emit(Buffer.from([0xab]));
    const ifReadyState = placeholder();

    emit(opU30(0x62, scratchLocal));
    emit(opU30(0x66, operands.missionProgress));
    emit(pushByte(CLEAR_THE_BANDITS_COMPLETE_COUNT));
    const ifReadyProgress = placeholder();

    emit(opU30(0x60, operands.entityClass));
    emit(opU30(0x66, operands.activeMarkerState));
    emit(opU30(0x63, markerLocal));
    const afterActiveMarker = placeholder();

    const readyOffset = length;
    emit(opU30(0x60, operands.entityClass));
    emit(opU30(0x66, operands.returnMarkerState));
    emit(opU30(0x63, markerLocal));
    const afterReadyMarker = placeholder();

    const noMarkerOffset = length;
    emit(opU30(0x60, operands.noMarkerState));
    emit(opU30(0x63, markerLocal));

    const endOffset = length;
    patchBranch(ifCueMissing, 0x12, endOffset);
    patchBranch(ifOtherNpc, 0x12, endOffset);
    patchBranch(ifMissionExists, 0x11, missionExistsOffset);
    patchBranch(ifPrerequisiteMissing, 0x12, noMarkerOffset);
    patchBranch(afterNewMarker, 0x10, endOffset);
    patchBranch(ifClaimed, 0x11, noMarkerOffset);
    patchBranch(ifReadyState, 0x11, readyOffset);
    patchBranch(ifReadyProgress, 0x18, readyOffset);
    patchBranch(afterActiveMarker, 0x10, endOffset);
    patchBranch(afterReadyMarker, 0x10, endOffset);
    return Buffer.concat(chunks);
}

function hasNpcSpawnMarkerPatch(
    abc: ReturnType<typeof parseAbc>,
    code: Buffer
): boolean {
    const felguardStringIndex = abc.stringValues.indexOf(FELGUARD_CONTACT_NAME);
    if (felguardStringIndex < 0) return false;
    const instructions = disassemble(code, 'Entity.iinit.spawn-marker.verify');
    const rendererIndex = instructions.findIndex((instruction) =>
        instruction.opcode === 0x4f &&
        u30OperandName(instruction, abc.multinameNames) === 'method_397' &&
        instruction.operands[1]?.[1] === 1
    );
    const guardIndex = instructions.findIndex((instruction, index) =>
        instruction.opcode === 0xd0 &&
        instructions[index + 1]?.opcode === 0x66 &&
        u30OperandName(instructions[index + 1], abc.multinameNames) === 'cue' &&
        instructions[index + 2]?.opcode === 0x12 &&
        instructions[index + 3]?.opcode === 0xd0 &&
        instructions[index + 4]?.opcode === 0x66 &&
        u30OperandName(instructions[index + 4], abc.multinameNames) === 'cue' &&
        instructions[index + 5]?.opcode === 0x66 &&
        u30OperandName(instructions[index + 5], abc.multinameNames) === 'characterName' &&
        instructions[index + 6]?.opcode === 0x2c &&
        instructions[index + 6]?.operands[0]?.[1] === felguardStringIndex
    );
    const usedNames = new Set(instructions
        .slice(Math.max(0, guardIndex), rendererIndex < 0 ? undefined : rendererIndex)
        .filter((instruction) => instruction.operands[0]?.[0] === 'u30')
        .map((instruction) => u30OperandName(instruction, abc.multinameNames))
        .filter((name): name is string => Boolean(name)));
    const metadataMissEntersGuard = guardIndex >= 0 && instructions.some((instruction, index) => {
        if (
            instruction.offset >= instructions[guardIndex].offset ||
            instruction.opcode !== 0x12 ||
            instruction.operands[0]?.[0] !== 's24'
        ) {
            return false;
        }
        const target = instruction.offset + instruction.size + instruction.operands[0][1];
        return target === instructions[guardIndex].offset &&
            instructions.slice(Math.max(0, index - 4), index).some((candidate) =>
                candidate.opcode === 0x80 &&
                u30OperandName(candidate, abc.multinameNames) === 'class_35'
            );
    });
    return guardIndex >= 0 && rendererIndex > guardIndex &&
        metadataMissEntersGuard &&
        hasCompleteProgressFallback(
            instructions.slice(guardIndex, rendererIndex),
            abc.multinameNames
        ) &&
        ['mMissionInfoList', 'const_282', 'const_449', 'const_599', 'const_482']
            .every((name) => usedNames.has(name));
}

function verifyNpcSpawnMarker(swfPath: string): void {
    const { ctx, abc, body } = findNpcSpawnMarkerContext(swfPath);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (!hasNpcSpawnMarkerPatch(abc, code)) {
        throw new PatchError(`${path.basename(swfPath)} is missing the Felguard spawn marker flow.`);
    }
    if (body.exceptionCount !== 0) {
        throw new PatchError('Entity constructor unexpectedly contains an exception table.');
    }
    verifyBranchTargets(code);
    verifyMarkerAssets(swfPath);
    console.log(`${path.basename(swfPath)} Clear the Bandits spawn marker verify ok.`);
}

function patchNpcSpawnMarker(swfPath: string): void {
    const { ctx, abc, body, resolverBody } = findNpcSpawnMarkerContext(swfPath);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (hasNpcSpawnMarkerPatch(abc, code)) {
        console.log(`${path.basename(swfPath)} already resolves the Felguard marker during NPC construction.`);
        return;
    }
    if (body.exceptionCount !== 0) {
        throw new PatchError('Entity constructor has an unexpected exception table.');
    }
    const resolverCode = ctx.body.subarray(
        resolverBody.codeStart,
        resolverBody.codeStart + resolverBody.codeLen
    );
    const felguardStringIndex = abc.stringValues.indexOf(FELGUARD_CONTACT_NAME);
    if (felguardStringIndex < 0) {
        throw new PatchError('Felguard string is missing before spawn marker patching.');
    }
    const insertionPoint = findSpawnMarkerInsertionPoint(code, abc.multinameNames);
    const [currentLocalCount, localCountEnd] = readU30(ctx.body, body.localCountPos, 'Entity constructor locals');
    const [currentMaxStack, maxStackEnd] = readU30(ctx.body, body.maxStackPos, 'Entity constructor stack');
    const operands: SpawnMarkerOperands = {
        cue: findUniqueOperand(code, abc.multinameNames, 0x66, 'cue'),
        characterName: findUniqueOperand(code, abc.multinameNames, 0x66, 'characterName'),
        game: findUniqueOperand(code, abc.multinameNames, 0x66, 'var_1'),
        missionList: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'mMissionInfoList'),
        dynamicLookup: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, '*'),
        missionClass: findUniqueOperand(resolverCode, abc.multinameNames, 0x60, 'Mission'),
        missionState: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'var_145'),
        missionProgress: findUniqueMultiname(abc.multinameNames, 'currCount'),
        missionCompleteState: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'const_58'),
        missionClaimedState: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'const_72'),
        entityClass: findUniqueOperand(resolverCode, abc.multinameNames, 0x60, 'Entity'),
        noMarkerState: findUniqueOperand(code, abc.multinameNames, 0x60, 'const_282'),
        newMarkerState: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'const_449'),
        activeMarkerState: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'const_599'),
        returnMarkerState: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'const_482'),
        missionIsComplete: findUniqueMultiname(abc.multinameNames, 'MissionIsComplete')
    };
    const guard = buildSpawnMarkerGuard(
        insertionPoint.insertionOffset,
        insertionPoint.markerLocal,
        currentLocalCount,
        felguardStringIndex,
        operands
    );
    const patches: BytePatch[] = [{
        key: 'spawn-marker-code-length',
        start: body.codeLenPos,
        end: body.codeStart,
        data: writeU30(body.codeLen + guard.length),
        detail: 'update Entity constructor code length for the Felguard marker'
    }, {
        key: 'spawn-marker-guard',
        start: body.codeStart + insertionPoint.insertionOffset,
        end: body.codeStart + insertionPoint.insertionOffset,
        data: guard,
        detail: 'resolve Mission 11 before the constructor renders the Felguard marker'
    }, {
        key: 'spawn-marker-local-count',
        start: body.localCountPos,
        end: localCountEnd,
        data: writeU30(currentLocalCount + 1),
        detail: 'reserve the Felguard spawn marker Mission local'
    }, ...branchAdjustmentPatches(
        body,
        code,
        insertionPoint.insertionOffset,
        guard.length,
        true
    )];
    if (currentMaxStack < 4) {
        patches.push({
            key: 'spawn-marker-max-stack',
            start: body.maxStackPos,
            end: maxStackEnd,
            data: writeU30(4),
            detail: 'raise Entity constructor max stack for the Felguard marker'
        });
    }
    const patched = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, patched.body, patched.delta);
    verifyNpcSpawnMarker(swfPath);
    console.log(`${path.basename(swfPath)} patched to resolve the Felguard marker during NPC construction.`);
}

type ContactMarkerOperands = {
    characterName: number;
    missionList: number;
    dynamicLookup: number;
    missionClass: number;
    missionState: number;
    missionProgress: number;
    missionCompleteState: number;
    missionClaimedState: number;
    entityClass: number;
    newMarkerState: number;
    activeMarkerState: number;
    returnMarkerState: number;
    missionIsComplete: number;
    renderMarker: number;
};

function findContactMarkerContext(swfPath: string) {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const gameIndex = classIndexByName(abc, 'Game');
    if (gameIndex === null) {
        throw new PatchError('Could not find Game while locating the NPC contact refresh.');
    }
    const contactMethodIdx = methodIdxForTrait(abc.instances[gameIndex].traits, abc, 'method_195');
    const resolverMethodIdx = methodIdxForTrait(abc.instances[gameIndex].traits, abc, 'method_793');
    if (contactMethodIdx === null || resolverMethodIdx === null) {
        throw new PatchError('Could not find the standard NPC contact marker methods.');
    }
    const body = abc.methodBodies.get(contactMethodIdx);
    const resolverBody = abc.methodBodies.get(resolverMethodIdx);
    const methodInfo = abc.methodInfos[contactMethodIdx];
    if (!body || !resolverBody || !methodInfo) {
        throw new PatchError('The NPC contact marker methods are incomplete.');
    }
    if (
        methodInfo.paramTypes.length !== 1 ||
        abc.multinameNames[methodInfo.paramTypes[0]] !== 'String' ||
        abc.multinameNames[methodInfo.returnType] !== 'void'
    ) {
        throw new PatchError('Game.method_195 signature changed unexpectedly.');
    }
    assertInstanceSlotType(abc, 'Mission', 'currCount', 'uint');
    return { ctx, abc, body, resolverBody };
}

function findContactMarkerInsertionPoint(
    code: Buffer,
    names: string[]
): { insertionOffset: number; loopOffset: number } {
    const instructions = disassemble(code, 'Game.method_195.marker-state');
    for (let index = 0; index < instructions.length - 3; index += 1) {
        if (
            instructions[index].opcode === 0x66 &&
            u30OperandName(instructions[index], names) === 'cue' &&
            instructions[index + 1].opcode === 0x80 &&
            u30OperandName(instructions[index + 1], names) === 'a_Cue' &&
            instructions[index + 2].opcode === 0xd6
        ) {
            const loopInstruction = instructions.slice(index + 3).find((instruction) => instruction.opcode === 0x32);
            if (!loopInstruction) {
                throw new PatchError('Could not locate the Game.method_195 entity loop continuation.');
            }
            return {
                insertionOffset: instructions[index + 3].offset,
                loopOffset: loopInstruction.offset
            };
        }
    }
    throw new PatchError('Could not locate the populated Entity cue in Game.method_195.');
}

function buildContactMarkerGuard(
    insertionOffset: number,
    originalLoopOffset: number,
    felguardStringIndex: number,
    operands: ContactMarkerOperands
): Buffer {
    const chunks: Buffer[] = [];
    let length = 0;
    const emit = (buffer: Buffer): number => {
        const offset = length;
        chunks.push(buffer);
        length += buffer.length;
        return offset;
    };
    const placeholder = (): { index: number; offset: number } => {
        const index = chunks.length;
        const offset = emit(Buffer.alloc(4));
        return { index, offset };
    };
    const patchBranch = (
        placeholderInfo: { index: number; offset: number },
        opcode: number,
        targetOffset: number
    ): void => {
        chunks[placeholderInfo.index] = branch(
            opcode,
            insertionOffset + placeholderInfo.offset,
            insertionOffset + targetOffset
        );
    };

    // Run before the standard class_35/contact filters. Felguard has no class_35
    // row, and both targeted and general refreshes must still reach this branch.
    emit(Buffer.from([0xd2]));
    const ifCueMissing = placeholder();
    emit(Buffer.from([0xd2]));
    emit(opU30(0x66, operands.characterName));
    emit(opU30(0x2c, felguardStringIndex));
    emit(Buffer.from([0xab]));
    const ifOtherContact = placeholder();

    emit(Buffer.from([0xd0]));
    emit(opU30(0x66, operands.missionList));
    emit(pushByte(CLEAR_THE_BANDITS_MISSION_ID));
    emit(opU30(0x66, operands.dynamicLookup));
    emit(opU30(0x80, operands.missionClass));
    emit(opU30(0x63, 11));
    emit(opU30(0x62, 11));
    const ifMissionExists = placeholder();

    emit(Buffer.from([0xd0]));
    emit(pushByte(SEE_THE_WARDEN_MISSION_ID));
    emit(opU30U30(0x46, operands.missionIsComplete, 1));
    const ifPrerequisiteMissing = placeholder();
    emit(opU30(0x60, operands.entityClass));
    emit(opU30(0x66, operands.newMarkerState));
    emit(Buffer.from([0xd7])); // setlocal3: marker state passed to Entity.method_397
    const afterNewMarker = placeholder();

    const noMarkerOffset = length;
    emit(pushByte(0));
    emit(Buffer.from([0xd7]));
    const afterNoMarker = placeholder();

    const missionExistsOffset = length;
    emit(opU30(0x62, 11));
    emit(opU30(0x66, operands.missionState));
    emit(opU30(0x60, operands.missionClass));
    emit(opU30(0x66, operands.missionClaimedState));
    emit(Buffer.from([0xab]));
    const ifClaimed = placeholder();

    emit(opU30(0x62, 11));
    emit(opU30(0x66, operands.missionState));
    emit(opU30(0x60, operands.missionClass));
    emit(opU30(0x66, operands.missionCompleteState));
    emit(Buffer.from([0xab]));
    const ifReadyState = placeholder();

    emit(opU30(0x62, 11));
    emit(opU30(0x66, operands.missionProgress));
    emit(pushByte(CLEAR_THE_BANDITS_COMPLETE_COUNT));
    const ifReadyProgress = placeholder();

    emit(opU30(0x60, operands.entityClass));
    emit(opU30(0x66, operands.activeMarkerState));
    emit(Buffer.from([0xd7]));
    const afterActiveMarker = placeholder();

    const readyOffset = length;
    emit(opU30(0x60, operands.entityClass));
    emit(opU30(0x66, operands.returnMarkerState));
    emit(Buffer.from([0xd7]));
    const afterReadyMarker = placeholder();

    const claimedOffset = length;
    emit(pushByte(0));
    emit(Buffer.from([0xd7]));

    const renderOffset = length;
    emit(opU30(0x62, 4)); // matched Entity
    emit(Buffer.from([0xd3])); // resolved marker state
    emit(opU30U30(0x4f, operands.renderMarker, 1));
    const jumpToLoopIndex = chunks.length;
    const jumpToLoopOffset = emit(Buffer.alloc(4));

    const originalContactFlowOffset = length;
    patchBranch(ifCueMissing, 0x12, originalContactFlowOffset);
    patchBranch(ifOtherContact, 0x12, originalContactFlowOffset);
    patchBranch(ifMissionExists, 0x11, missionExistsOffset);
    patchBranch(ifPrerequisiteMissing, 0x12, noMarkerOffset);
    patchBranch(afterNewMarker, 0x10, renderOffset);
    patchBranch(afterNoMarker, 0x10, renderOffset);
    patchBranch(ifClaimed, 0x11, claimedOffset);
    patchBranch(ifReadyState, 0x11, readyOffset);
    patchBranch(ifReadyProgress, 0x18, readyOffset);
    patchBranch(afterActiveMarker, 0x10, renderOffset);
    patchBranch(afterReadyMarker, 0x10, renderOffset);
    chunks[jumpToLoopIndex] = branch(
        0x10,
        insertionOffset + jumpToLoopOffset,
        originalLoopOffset + length
    );
    return Buffer.concat(chunks);
}

function hasContactMarkerPatch(
    abc: ReturnType<typeof parseAbc>,
    code: Buffer
): boolean {
    const felguardStringIndex = abc.stringValues.indexOf(FELGUARD_CONTACT_NAME);
    if (felguardStringIndex < 0) {
        return false;
    }
    const instructions = disassemble(code, 'Clear the Bandits contact marker verify');
    const pushedBytes = new Set(instructions
        .filter((instruction) => instruction.opcode === 0x24)
        .map((instruction) => instruction.operands[0]?.[1]));
    const usedNames = new Set(instructions
        .filter((instruction) => instruction.operands[0]?.[0] === 'u30')
        .map((instruction) => u30OperandName(instruction, abc.multinameNames))
        .filter((name): name is string => Boolean(name)));
    const felguardGuardOffset = instructions.findIndex((instruction, index) =>
        instruction.opcode === 0xd2 &&
        instructions[index + 1]?.opcode === 0x12 &&
        instructions[index + 2]?.opcode === 0xd2 &&
        instructions[index + 3]?.opcode === 0x66 &&
        u30OperandName(instructions[index + 3], abc.multinameNames) === 'characterName' &&
        instructions[index + 4]?.opcode === 0x2c &&
        instructions[index + 4]?.operands[0]?.[1] === felguardStringIndex &&
        instructions[index + 5]?.opcode === 0xab &&
        instructions[index + 6]?.opcode === 0x12
    );
    const metadataLookupOffset = instructions.findIndex((instruction, index) =>
        instruction.opcode === 0x60 &&
        u30OperandName(instruction, abc.multinameNames) === 'class_14' &&
        instructions[index + 1]?.opcode === 0x66 &&
        u30OperandName(instructions[index + 1], abc.multinameNames) === 'var_999'
    );
    const relativeRendererIndex = felguardGuardOffset < 0 || metadataLookupOffset <= felguardGuardOffset
        ? -1
        : instructions.slice(felguardGuardOffset, metadataLookupOffset).findIndex((instruction) =>
            instruction.opcode === 0x4f &&
            u30OperandName(instruction, abc.multinameNames) === 'method_397' &&
            instruction.operands[1]?.[1] === 1
        );
    const directRendererIndex = relativeRendererIndex < 0
        ? -1
        : felguardGuardOffset + relativeRendererIndex;
    const rendererJump = directRendererIndex >= felguardGuardOffset
        ? instructions[directRendererIndex + 1]
        : undefined;
    const rendererJumpTarget = rendererJump?.operands[0]?.[0] === 's24'
        ? rendererJump.offset + rendererJump.size + rendererJump.operands[0][1]
        : -1;
    const cueMissingBranch = felguardGuardOffset >= 0
        ? instructions[felguardGuardOffset + 1]
        : undefined;
    const cueMissingTarget = cueMissingBranch?.operands[0]?.[0] === 's24'
        ? cueMissingBranch.offset + cueMissingBranch.size + cueMissingBranch.operands[0][1]
        : -1;
    const otherContactBranch = felguardGuardOffset >= 0
        ? instructions[felguardGuardOffset + 6]
        : undefined;
    const otherContactTarget = otherContactBranch?.operands[0]?.[0] === 's24'
        ? otherContactBranch.offset + otherContactBranch.size + otherContactBranch.operands[0][1]
        : -1;
    const hasSafeDirectRendererPath = directRendererIndex >= felguardGuardOffset &&
        instructions[directRendererIndex - 2]?.opcode === 0x62 &&
        instructions[directRendererIndex - 2]?.operands[0]?.[1] === 4 &&
        instructions[directRendererIndex - 1]?.opcode === 0xd3 &&
        rendererJump?.opcode === 0x10 &&
        instructions.find((instruction) => instruction.offset === rendererJumpTarget)?.opcode === 0x32 &&
        cueMissingTarget === otherContactTarget &&
        instructions.find((instruction) => instruction.offset === otherContactTarget)?.opcode === 0x62 &&
        instructions.find((instruction) => instruction.offset === otherContactTarget)?.operands[0]?.[1] === 10;
    return hasSafeDirectRendererPath &&
        pushedBytes.has(CLEAR_THE_BANDITS_MISSION_ID) &&
        pushedBytes.has(SEE_THE_WARDEN_MISSION_ID) &&
        pushedBytes.has(CLEAR_THE_BANDITS_COMPLETE_COUNT) &&
        hasCompleteProgressFallback(instructions, abc.multinameNames) &&
        ['characterName', 'mMissionInfoList', 'currCount', 'const_58', 'const_72', 'const_449', 'const_599', 'const_482']
            .every((name) => usedNames.has(name));
}

function verifyNpcContactMarker(swfPath: string): void {
    const { ctx, abc, body } = findContactMarkerContext(swfPath);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (!hasContactMarkerPatch(abc, code)) {
        throw new PatchError(`${path.basename(swfPath)} is missing the Game contact marker flow.`);
    }
    if (readU30(ctx.body, body.localCountPos, 'contact marker local count')[0] < 12) {
        throw new PatchError('Game.method_195 does not reserve the Mission 11 scratch local.');
    }
    if (readU30(ctx.body, body.maxStackPos, 'contact marker max stack')[0] < 5) {
        throw new PatchError('Game.method_195 max stack is too low for Mission 11 marker resolution.');
    }
    if (body.exceptionCount !== 0) {
        throw new PatchError('Game.method_195 unexpectedly contains an exception table.');
    }
    verifyBranchTargets(code);
    verifyMarkerAssets(swfPath);
    console.log(`${path.basename(swfPath)} Clear the Bandits Game contact marker verify ok.`);
}

function patchNpcContactMarker(swfPath: string): void {
    const { ctx, abc, body, resolverBody } = findContactMarkerContext(swfPath);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (hasContactMarkerPatch(abc, code)) {
        console.log(`${path.basename(swfPath)} already resolves Mission 11 in Game.method_195.`);
        return;
    }
    if (body.exceptionCount !== 0) {
        throw new PatchError('Game.method_195 has an unexpected exception table.');
    }
    const resolverCode = ctx.body.subarray(
        resolverBody.codeStart,
        resolverBody.codeStart + resolverBody.codeLen
    );
    const felguardStringIndex = abc.stringValues.indexOf(FELGUARD_CONTACT_NAME);
    if (felguardStringIndex < 0) {
        throw new PatchError('Felguard string is missing before contact marker patching.');
    }
    const insertionPoint = findContactMarkerInsertionPoint(code, abc.multinameNames);
    const operands: ContactMarkerOperands = {
        characterName: findUniqueOperand(code, abc.multinameNames, 0x66, 'characterName'),
        missionList: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'mMissionInfoList'),
        dynamicLookup: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, '*'),
        missionClass: findUniqueOperand(resolverCode, abc.multinameNames, 0x60, 'Mission'),
        missionState: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'var_145'),
        missionProgress: findUniqueMultiname(abc.multinameNames, 'currCount'),
        missionCompleteState: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'const_58'),
        missionClaimedState: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'const_72'),
        entityClass: findUniqueOperand(resolverCode, abc.multinameNames, 0x60, 'Entity'),
        newMarkerState: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'const_449'),
        activeMarkerState: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'const_599'),
        returnMarkerState: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'const_482'),
        missionIsComplete: findUniqueMultiname(abc.multinameNames, 'MissionIsComplete'),
        renderMarker: findUniqueOperand(code, abc.multinameNames, 0x4f, 'method_397')
    };
    const guard = buildContactMarkerGuard(
        insertionPoint.insertionOffset,
        insertionPoint.loopOffset,
        felguardStringIndex,
        operands
    );
    const [currentLocalCount, localCountEnd] = readU30(ctx.body, body.localCountPos, 'contact marker locals');
    const [currentMaxStack, maxStackEnd] = readU30(ctx.body, body.maxStackPos, 'contact marker stack');
    const patches: BytePatch[] = [{
        key: 'contact-marker-code-length',
        start: body.codeLenPos,
        end: body.codeStart,
        data: writeU30(body.codeLen + guard.length),
        detail: 'update Game.method_195 code length'
    }, {
        key: 'contact-marker-guard',
        start: body.codeStart + insertionPoint.insertionOffset,
        end: body.codeStart + insertionPoint.insertionOffset,
        data: guard,
        detail: 'render Mission 11 before the missing Felguard contact metadata lookup'
    }, ...branchAdjustmentPatches(body, code, insertionPoint.insertionOffset, guard.length)];
    if (currentLocalCount < 12) {
        patches.push({
            key: 'contact-marker-local-count',
            start: body.localCountPos,
            end: localCountEnd,
            data: writeU30(12),
            detail: 'reserve Mission 11 contact marker scratch local'
        });
    }
    if (currentMaxStack < 5) {
        patches.push({
            key: 'contact-marker-max-stack',
            start: body.maxStackPos,
            end: maxStackEnd,
            data: writeU30(5),
            detail: 'raise Game.method_195 max stack for Mission 11 marker resolution'
        });
    }
    const patched = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, patched.body, patched.delta);
    verifyNpcContactMarker(swfPath);
    console.log(`${path.basename(swfPath)} patched to resolve Mission 11 in Game.method_195.`);
}

function findCompletionRefreshContext(swfPath: string) {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const gameIndex = classIndexByName(abc, 'Game');
    if (gameIndex === null) {
        throw new PatchError('Could not find Game while locating mission completion refresh.');
    }
    const methodIdx = methodIdxForTrait(abc.instances[gameIndex].traits, abc, 'method_1787');
    if (methodIdx === null) {
        throw new PatchError('Could not find the mission completion handler.');
    }
    const body = abc.methodBodies.get(methodIdx);
    const methodInfo = abc.methodInfos[methodIdx];
    if (!body || !methodInfo) {
        throw new PatchError('The mission completion handler is incomplete.');
    }
    if (
        methodInfo.paramTypes.length !== 1 ||
        abc.multinameNames[methodInfo.paramTypes[0]] !== 'uint' ||
        abc.multinameNames[methodInfo.returnType] !== 'void'
    ) {
        throw new PatchError('The mission completion handler signature changed unexpectedly.');
    }
    return { ctx, abc, body };
}

function findCompletionRefreshInsertionOffset(
    code: Buffer,
    names: string[]
): number {
    const instructions = disassemble(code, 'Game.method_1787.completion-refresh');
    for (let index = 0; index < instructions.length - 4; index += 1) {
        if (
            instructions[index].opcode === 0xd3 &&
            instructions[index + 1].opcode === 0x60 &&
            u30OperandName(instructions[index + 1], names) === 'Mission' &&
            instructions[index + 2].opcode === 0x66 &&
            u30OperandName(instructions[index + 2], names) === 'const_58' &&
            instructions[index + 3].opcode === 0x61 &&
            u30OperandName(instructions[index + 3], names) === 'var_145' &&
            instructions[index + 4].opcode === 0x10
        ) {
            return instructions[index + 4].offset;
        }
    }
    throw new PatchError('Could not locate the completed-mission state assignment.');
}

function buildCompletionRefreshGuard(
    insertionOffset: number,
    refreshContact: number
): Buffer {
    const beforeBranch = Buffer.concat([
        Buffer.from([0xd1]), // mission id argument
        pushByte(CLEAR_THE_BANDITS_MISSION_ID),
        Buffer.from([0xab]) // equals
    ]);
    const refresh = Buffer.concat([
        Buffer.from([0xd0]),
        opU30U30(0x4f, refreshContact, 0)
    ]);
    const branchOffset = insertionOffset + beforeBranch.length;
    const endOffset = branchOffset + 4 + refresh.length;
    return Buffer.concat([
        beforeBranch,
        branch(0x12, branchOffset, endOffset), // iffalse
        refresh
    ]);
}

function hasCompletionRefreshPatch(
    abc: ReturnType<typeof parseAbc>,
    code: Buffer
): boolean {
    const instructions = disassemble(code, 'Clear the Bandits completion refresh verify');
    return instructions.some((instruction, index) =>
        instruction.opcode === 0xd1 &&
        instructions[index + 1]?.opcode === 0x24 &&
        instructions[index + 1]?.operands[0]?.[1] === CLEAR_THE_BANDITS_MISSION_ID &&
        instructions[index + 2]?.opcode === 0xab &&
        instructions[index + 3]?.opcode === 0x12 &&
        instructions[index + 4]?.opcode === 0xd0 &&
        instructions[index + 5]?.opcode === 0x4f &&
        u30OperandName(instructions[index + 5], abc.multinameNames) === 'method_195' &&
        instructions[index + 5]?.operands[1]?.[1] === 0
    );
}

function verifyCompletionRefresh(swfPath: string): void {
    const { ctx, abc, body } = findCompletionRefreshContext(swfPath);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (!hasCompletionRefreshPatch(abc, code)) {
        throw new PatchError(`${path.basename(swfPath)} is missing the Felguard completion refresh.`);
    }
    if (body.exceptionCount !== 0) {
        throw new PatchError('Mission completion handler unexpectedly contains an exception table.');
    }
    verifyBranchTargets(code);
    console.log(`${path.basename(swfPath)} Clear the Bandits completion refresh verify ok.`);
}

function patchCompletionRefresh(swfPath: string): void {
    const { ctx, abc, body } = findCompletionRefreshContext(swfPath);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (hasCompletionRefreshPatch(abc, code)) {
        console.log(`${path.basename(swfPath)} already refreshes Felguard when Mission 11 completes.`);
        return;
    }
    if (body.exceptionCount !== 0) {
        throw new PatchError('Mission completion handler has an unexpected exception table.');
    }
    const insertionOffset = findCompletionRefreshInsertionOffset(code, abc.multinameNames);
    const refreshContact = findUniqueOperand(code, abc.multinameNames, 0x4f, 'method_195');
    const guard = buildCompletionRefreshGuard(insertionOffset, refreshContact);
    const patches: BytePatch[] = [{
        key: 'completion-refresh-code-length',
        start: body.codeLenPos,
        end: body.codeStart,
        data: writeU30(body.codeLen + guard.length),
        detail: 'update mission completion handler code length'
    }, {
        key: 'completion-refresh-guard',
        start: body.codeStart + insertionOffset,
        end: body.codeStart + insertionOffset,
        data: guard,
        detail: 'refresh Felguard immediately when Mission 11 becomes ready to turn in'
    }, ...branchAdjustmentPatches(body, code, insertionOffset, guard.length)];
    const patched = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, patched.body, patched.delta);
    verifyCompletionRefresh(swfPath);
    console.log(`${path.basename(swfPath)} patched to refresh Felguard on Mission 11 completion.`);
}

function findGameTransitionContext(
    swfPath: string,
    methodName: string,
    expectedParamTypes: string[]
) {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const gameIndex = classIndexByName(abc, 'Game');
    if (gameIndex === null) {
        throw new PatchError(`Could not find Game while locating ${methodName}.`);
    }
    const methodIdx = methodIdxForTrait(abc.instances[gameIndex].traits, abc, methodName);
    if (methodIdx === null) {
        throw new PatchError(`Could not find Game.${methodName}.`);
    }
    const body = abc.methodBodies.get(methodIdx);
    const methodInfo = abc.methodInfos[methodIdx];
    if (!body || !methodInfo) {
        throw new PatchError(`Game.${methodName} is incomplete.`);
    }
    const actualParamTypes = methodInfo.paramTypes.map((type) => abc.multinameNames[type]);
    if (
        actualParamTypes.length !== expectedParamTypes.length ||
        actualParamTypes.some((type, index) => type !== expectedParamTypes[index]) ||
        abc.multinameNames[methodInfo.returnType] !== 'void'
    ) {
        throw new PatchError(`Game.${methodName} signature changed unexpectedly.`);
    }
    return { ctx, abc, body };
}

function findMissionAddedRefreshInsertionOffset(code: Buffer, names: string[]): number {
    const instructions = disassemble(code, 'Game.method_1380.accept-refresh');
    for (let index = 0; index < instructions.length - 5; index += 1) {
        if (
            instructions[index].opcode === 0xd0 &&
            instructions[index + 1].opcode === 0x66 &&
            u30OperandName(instructions[index + 1], names) === 'mMissionInfoList' &&
            instructions[index + 2].opcode === 0xd1 &&
            instructions[index + 3].opcode === 0x62 &&
            instructions[index + 4].opcode === 0x61 &&
            u30OperandName(instructions[index + 4], names) === '*' &&
            instructions[index + 5].opcode === 0x10
        ) {
            return instructions[index + 5].offset;
        }
    }
    throw new PatchError('Could not locate the accepted Mission insertion.');
}

function findClaimRefreshInsertionOffset(code: Buffer, names: string[]): number {
    const instructions = disassemble(code, 'Game.method_1472.claim-refresh');
    for (let index = 0; index < instructions.length - 4; index += 1) {
        if (
            (instructions[index].opcode === 0xd0 ||
                instructions[index].opcode === 0xd1 ||
                instructions[index].opcode === 0xd2 ||
                instructions[index].opcode === 0xd3 ||
                instructions[index].opcode === 0x62) &&
            instructions[index + 1].opcode === 0x60 &&
            u30OperandName(instructions[index + 1], names) === 'Mission' &&
            instructions[index + 2].opcode === 0x66 &&
            u30OperandName(instructions[index + 2], names) === 'const_72' &&
            instructions[index + 3].opcode === 0x61 &&
            u30OperandName(instructions[index + 3], names) === 'var_145' &&
            instructions[index + 4].opcode === 0x10
        ) {
            return instructions[index + 4].offset;
        }
    }
    throw new PatchError('Could not locate the claimed-mission state assignment.');
}

function verifyTransitionRefresh(
    swfPath: string,
    methodName: string,
    expectedParamTypes: string[],
    label: string
): void {
    const { ctx, abc, body } = findGameTransitionContext(swfPath, methodName, expectedParamTypes);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (!hasCompletionRefreshPatch(abc, code)) {
        throw new PatchError(`${path.basename(swfPath)} is missing the Felguard ${label} refresh.`);
    }
    if (body.exceptionCount !== 0) {
        throw new PatchError(`Mission ${label} handler unexpectedly contains an exception table.`);
    }
    verifyBranchTargets(code);
    console.log(`${path.basename(swfPath)} Clear the Bandits ${label} refresh verify ok.`);
}

function patchTransitionRefresh(
    swfPath: string,
    methodName: string,
    expectedParamTypes: string[],
    label: string,
    findInsertionOffset: (code: Buffer, names: string[]) => number
): void {
    const { ctx, abc, body } = findGameTransitionContext(swfPath, methodName, expectedParamTypes);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (hasCompletionRefreshPatch(abc, code)) {
        console.log(`${path.basename(swfPath)} already refreshes Felguard on Mission 11 ${label}.`);
        return;
    }
    if (body.exceptionCount !== 0) {
        throw new PatchError(`Mission ${label} handler has an unexpected exception table.`);
    }
    const insertionOffset = findInsertionOffset(code, abc.multinameNames);
    const refreshContact = findUniqueOperand(code, abc.multinameNames, 0x4f, 'method_195');
    const guard = buildCompletionRefreshGuard(insertionOffset, refreshContact);
    const patches: BytePatch[] = [{
        key: `${label}-refresh-code-length`,
        start: body.codeLenPos,
        end: body.codeStart,
        data: writeU30(body.codeLen + guard.length),
        detail: `update Mission 11 ${label} handler code length`
    }, {
        key: `${label}-refresh-guard`,
        start: body.codeStart + insertionOffset,
        end: body.codeStart + insertionOffset,
        data: guard,
        detail: `refresh Felguard immediately on Mission 11 ${label}`
    }, ...branchAdjustmentPatches(body, code, insertionOffset, guard.length)];
    const patched = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, patched.body, patched.delta);
    verifyTransitionRefresh(swfPath, methodName, expectedParamTypes, label);
    console.log(`${path.basename(swfPath)} patched to refresh Felguard on Mission 11 ${label}.`);
}

function verifyAcceptanceRefresh(swfPath: string): void {
    verifyTransitionRefresh(swfPath, 'method_1380', ['uint', 'Boolean'], 'acceptance');
}

function patchAcceptanceRefresh(swfPath: string): void {
    patchTransitionRefresh(
        swfPath,
        'method_1380',
        ['uint', 'Boolean'],
        'acceptance',
        findMissionAddedRefreshInsertionOffset
    );
}

function verifyClaimRefresh(swfPath: string): void {
    verifyTransitionRefresh(swfPath, 'method_1472', ['uint', 'uint', 'uint'], 'claim');
}

function patchClaimRefresh(swfPath: string): void {
    patchTransitionRefresh(
        swfPath,
        'method_1472',
        ['uint', 'uint', 'uint'],
        'claim',
        findClaimRefreshInsertionOffset
    );
}

type PacketRefreshSpec = {
    methodName: string;
    handledMethodName: string;
    missionLocal: number;
    missionIds: number[];
    label: string;
};

const PACKET_REFRESH_SPECS: PacketRefreshSpec[] = [{
    methodName: 'method_1122',
    handledMethodName: 'method_1380',
    missionLocal: 2,
    missionIds: [CLEAR_THE_BANDITS_MISSION_ID],
    label: 'added-packet'
}, {
    methodName: 'method_1550',
    handledMethodName: 'method_1787',
    missionLocal: 2,
    missionIds: [CLEAR_THE_BANDITS_MISSION_ID],
    label: 'ready-packet'
}, {
    methodName: 'method_1294',
    handledMethodName: 'method_1472',
    missionLocal: 4,
    missionIds: [CLEAR_THE_BANDITS_MISSION_ID, SEE_THE_WARDEN_MISSION_ID],
    label: 'claimed-packet'
}];

function findPacketRefreshContext(swfPath: string, spec: PacketRefreshSpec) {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const updaterIndex = classIndexByName(abc, 'LinkUpdater');
    if (updaterIndex === null) {
        throw new PatchError('Could not find LinkUpdater.');
    }
    const methodIdx = methodIdxForTrait(abc.instances[updaterIndex].traits, abc, spec.methodName);
    if (methodIdx === null) {
        throw new PatchError(`Could not find LinkUpdater.${spec.methodName}.`);
    }
    const body = abc.methodBodies.get(methodIdx);
    const methodInfo = abc.methodInfos[methodIdx];
    if (!body || !methodInfo) {
        throw new PatchError(`LinkUpdater.${spec.methodName} is incomplete.`);
    }
    if (
        methodInfo.paramTypes.length !== 1 ||
        abc.multinameNames[methodInfo.paramTypes[0]] !== 'Packet' ||
        abc.multinameNames[methodInfo.returnType] !== 'void'
    ) {
        throw new PatchError(`LinkUpdater.${spec.methodName} signature changed unexpectedly.`);
    }
    return { ctx, abc, body };
}

function getLocalOpcode(local: number): Buffer {
    if (local >= 0 && local <= 3) {
        return Buffer.from([0xd0 + local]);
    }
    return opU30(0x62, local);
}

function findPacketRefreshInsertionOffset(
    code: Buffer,
    names: string[],
    handledMethodName: string
): number {
    const instructions = disassemble(code, `LinkUpdater.${handledMethodName}.post-handler`);
    for (let index = 0; index < instructions.length - 1; index += 1) {
        if (
            instructions[index].opcode === 0x4f &&
            u30OperandName(instructions[index], names) === handledMethodName &&
            instructions[index + 1].opcode === 0x47
        ) {
            return instructions[index + 1].offset;
        }
    }
    throw new PatchError(`Could not locate the return after ${handledMethodName}.`);
}

function buildPacketRefreshGuard(
    insertionOffset: number,
    spec: PacketRefreshSpec,
    gameProperty: number,
    refreshContact: number
): Buffer {
    const chunks: Buffer[] = [];
    let length = 0;
    const emit = (buffer: Buffer): number => {
        const offset = length;
        chunks.push(buffer);
        length += buffer.length;
        return offset;
    };
    const placeholders: Array<{ index: number; offset: number; refreshOnTrue: boolean }> = [];
    for (let index = 0; index < spec.missionIds.length; index += 1) {
        emit(getLocalOpcode(spec.missionLocal));
        emit(pushByte(spec.missionIds[index]));
        emit(Buffer.from([0xab]));
        const placeholderIndex = chunks.length;
        const placeholderOffset = emit(Buffer.alloc(4));
        placeholders.push({
            index: placeholderIndex,
            offset: placeholderOffset,
            refreshOnTrue: index < spec.missionIds.length - 1
        });
    }
    const refreshOffset = length;
    emit(Buffer.from([0xd0]));
    emit(opU30(0x66, gameProperty));
    emit(opU30U30(0x4f, refreshContact, 0));
    const endOffset = length;
    for (const placeholderInfo of placeholders) {
        const opcode = placeholderInfo.refreshOnTrue ? 0x11 : 0x12;
        const target = placeholderInfo.refreshOnTrue ? refreshOffset : endOffset;
        chunks[placeholderInfo.index] = branch(
            opcode,
            insertionOffset + placeholderInfo.offset,
            insertionOffset + target
        );
    }
    return Buffer.concat(chunks);
}

function hasPacketRefreshPatch(
    abc: ReturnType<typeof parseAbc>,
    code: Buffer,
    spec: PacketRefreshSpec
): boolean {
    const instructions = disassemble(code, `Mission 11 ${spec.label} refresh verify`);
    const pushedIds = new Set(instructions
        .filter((instruction) => instruction.opcode === 0x24)
        .map((instruction) => instruction.operands[0]?.[1]));
    return spec.missionIds.every((missionId) => pushedIds.has(missionId)) &&
        instructions.some((instruction, index) =>
            instruction.opcode === 0x66 &&
            u30OperandName(instruction, abc.multinameNames) === 'var_1' &&
            instructions[index + 1]?.opcode === 0x4f &&
            u30OperandName(instructions[index + 1], abc.multinameNames) === 'method_195' &&
            instructions[index + 1]?.operands[1]?.[1] === 0
        );
}

function verifyPacketRefresh(swfPath: string, spec: PacketRefreshSpec): void {
    const { ctx, abc, body } = findPacketRefreshContext(swfPath, spec);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (!hasPacketRefreshPatch(abc, code, spec)) {
        throw new PatchError(`${path.basename(swfPath)} is missing the ${spec.label} Felguard refresh.`);
    }
    if (body.exceptionCount !== 0) {
        throw new PatchError(`${spec.methodName} unexpectedly contains an exception table.`);
    }
    verifyBranchTargets(code);
    console.log(`${path.basename(swfPath)} Clear the Bandits ${spec.label} refresh verify ok.`);
}

function patchPacketRefresh(swfPath: string, spec: PacketRefreshSpec): void {
    const { ctx, abc, body } = findPacketRefreshContext(swfPath, spec);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (hasPacketRefreshPatch(abc, code, spec)) {
        console.log(`${path.basename(swfPath)} already refreshes Felguard after ${spec.label}.`);
        return;
    }
    if (body.exceptionCount !== 0) {
        throw new PatchError(`${spec.methodName} has an unexpected exception table.`);
    }
    const insertionOffset = findPacketRefreshInsertionOffset(
        code,
        abc.multinameNames,
        spec.handledMethodName
    );
    const gameProperty = findUniqueOperand(code, abc.multinameNames, 0x66, 'var_1');
    const refreshContact = findUniqueMultiname(abc.multinameNames, 'method_195');
    const guard = buildPacketRefreshGuard(
        insertionOffset,
        spec,
        gameProperty,
        refreshContact
    );
    const [currentMaxStack, maxStackEnd] = readU30(ctx.body, body.maxStackPos, `${spec.label} stack`);
    const patches: BytePatch[] = [{
        key: `${spec.label}-code-length`,
        start: body.codeLenPos,
        end: body.codeStart,
        data: writeU30(body.codeLen + guard.length),
        detail: `update ${spec.methodName} code length`
    }, {
        key: `${spec.label}-refresh`,
        start: body.codeStart + insertionOffset,
        end: body.codeStart + insertionOffset,
        data: guard,
        detail: `refresh Felguard after Mission 11 ${spec.label} state is committed`
    }, ...branchAdjustmentPatches(body, code, insertionOffset, guard.length)];
    if (currentMaxStack < 3) {
        patches.push({
            key: `${spec.label}-max-stack`,
            start: body.maxStackPos,
            end: maxStackEnd,
            data: writeU30(3),
            detail: `raise ${spec.methodName} max stack for Felguard refresh`
        });
    }
    const patched = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, patched.body, patched.delta);
    verifyPacketRefresh(swfPath, spec);
    console.log(`${path.basename(swfPath)} patched to refresh Felguard after ${spec.label}.`);
}

function verifyPacketRefreshes(swfPath: string): void {
    for (const spec of PACKET_REFRESH_SPECS) {
        verifyPacketRefresh(swfPath, spec);
    }
}

function patchPacketRefreshes(swfPath: string): void {
    for (const spec of PACKET_REFRESH_SPECS) {
        patchPacketRefresh(swfPath, spec);
    }
}

type MapMarkerOperands = {
    mapName: number;
    game: number;
    missionList: number;
    dynamicLookup: number;
    missionClass: number;
    missionState: number;
    missionProgress: number;
    missionCompleteState: number;
    missionClaimedState: number;
    missionIsComplete: number;
    assetFactory: number;
    assetFactoryMethod: number;
    movieClipClass: number;
    gotoAndStop: number;
    markerLayer: number;
    addChild: number;
    mapOffsetX: number;
    mapOffsetY: number;
    mapScale: number;
    x: number;
    y: number;
};

function findMapContext(swfPath: string) {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const mapIndex = classIndexByName(abc, 'class_119');
    if (mapIndex === null) {
        throw new PatchError('Could not find the mission map screen.');
    }
    const methodIdx = methodIdxForTrait(abc.instances[mapIndex].traits, abc, 'OnRefreshScreen');
    if (methodIdx === null) {
        throw new PatchError('Could not find the mission map refresh method.');
    }
    const body = abc.methodBodies.get(methodIdx);
    const methodInfo = abc.methodInfos[methodIdx];
    if (!body || !methodInfo) {
        throw new PatchError('The mission map refresh method is incomplete.');
    }
    if (methodInfo.paramTypes.length !== 0 || abc.multinameNames[methodInfo.returnType] !== 'void') {
        throw new PatchError('The mission map refresh signature changed unexpectedly.');
    }
    assertInstanceSlotType(abc, 'class_119', 'var_608', 'MovieClip');
    assertInstanceSlotType(abc, 'Mission', 'currCount', 'uint');
    return { ctx, abc, body };
}

function findMapCleanupOffset(code: Buffer): number {
    const instructions = disassemble(code, 'class_119.OnRefreshScreen.cleanup');
    for (let index = instructions.length - 3; index >= 0; index -= 1) {
        if (
            instructions[index].opcode === 0x08 && instructions[index].operands[0]?.[1] === 31 &&
            instructions[index + 1].opcode === 0x08 && instructions[index + 1].operands[0]?.[1] === 30 &&
            instructions[index + 2].opcode === 0x47
        ) {
            return instructions[index].offset;
        }
    }
    throw new PatchError('Could not find the mission map final cleanup.');
}

function buildMapMarkerGuard(
    insertionOffset: number,
    assetString: number,
    bridgeTownString: number,
    operands: MapMarkerOperands
): Buffer {
    const chunks: Buffer[] = [];
    let length = 0;
    const emit = (buffer: Buffer): number => {
        const offset = length;
        chunks.push(buffer);
        length += buffer.length;
        return offset;
    };
    const placeholder = (): { index: number; offset: number } => {
        const index = chunks.length;
        const offset = emit(Buffer.alloc(4));
        return { index, offset };
    };
    const patchBranch = (
        placeholderInfo: { index: number; offset: number },
        opcode: number,
        targetOffset: number
    ): void => {
        chunks[placeholderInfo.index] = branch(
            opcode,
            insertionOffset + placeholderInfo.offset,
            insertionOffset + targetOffset
        );
    };

    // Keep the marker on the same local-zone map as Felguard.
    emit(Buffer.from([0xd0]));
    emit(opU30(0x66, operands.mapName));
    emit(opU30(0x2c, bridgeTownString));
    emit(Buffer.from([0xab]));
    const ifOtherMap = placeholder();

    // Resolve only the runtime Mission entry. Do not mutate the load-sensitive
    // class_13 metadata or any map-screen state during startup.
    emit(opU30(0x60, operands.game));
    emit(opU30(0x66, operands.missionList));
    emit(pushByte(CLEAR_THE_BANDITS_MISSION_ID));
    emit(opU30(0x66, operands.dynamicLookup));
    emit(opU30(0x80, operands.missionClass));
    emit(opU30(0x63, 30)); // loop scratch local is dead and killed immediately after this guard
    emit(opU30(0x62, 30));
    const ifMissionExists = placeholder();

    emit(opU30(0x60, operands.game));
    emit(pushByte(SEE_THE_WARDEN_MISSION_ID));
    emit(opU30U30(0x46, operands.missionIsComplete, 1));
    const ifPrerequisiteMissing = placeholder();
    emit(pushByte(5)); // standard new-quest map frame
    emit(opU30(0x63, 31));
    const afterNewFrame = placeholder();

    const missionExistsOffset = length;
    // Claimed must win over the 20/20 fallback so no icon remains after turn-in.
    emit(opU30(0x62, 30));
    emit(opU30(0x66, operands.missionState));
    emit(opU30(0x60, operands.missionClass));
    emit(opU30(0x66, operands.missionClaimedState));
    emit(Buffer.from([0xab]));
    const ifClaimed = placeholder();

    emit(opU30(0x62, 30));
    emit(opU30(0x66, operands.missionState));
    emit(opU30(0x60, operands.missionClass));
    emit(opU30(0x66, operands.missionCompleteState));
    emit(Buffer.from([0xab]));
    const ifReadyState = placeholder();

    // The runtime counter is authoritative for Mission 11. It also covers the
    // short window where 20/20 is present before the complete-state refresh.
    emit(opU30(0x62, 30));
    emit(opU30(0x66, operands.missionProgress));
    emit(pushByte(CLEAR_THE_BANDITS_COMPLETE_COUNT));
    const ifReadyProgress = placeholder();

    emit(pushByte(6)); // standard active-quest map frame
    emit(opU30(0x63, 31));
    const afterActiveFrame = placeholder();

    const readyToTurnInOffset = length;
    emit(pushByte(7)); // standard return/complete map frame
    emit(opU30(0x63, 31));

    const renderOffset = length;
    emit(opU30(0x60, operands.assetFactory));
    emit(opU30(0x2c, assetString));
    emit(opU30U30(0x46, operands.assetFactoryMethod, 1));
    emit(opU30(0x80, operands.movieClipClass));
    emit(opU30(0x63, 30));
    emit(opU30(0x62, 30));
    const ifAssetMissing = placeholder();
    emit(opU30(0x62, 30));
    emit(opU30(0x62, 31));
    emit(opU30U30(0x4f, operands.gotoAndStop, 1));

    // Match the normal map marker projection exactly: (anchor - mapOffset) * mapScale.
    emit(opU30(0x62, 30));
    emit(opU30(0x25, FELGUARD_MAP_X));
    emit(Buffer.from([0xd1]));
    emit(opU30(0x66, operands.mapOffsetX));
    emit(Buffer.from([0xa1])); // subtract
    emit(Buffer.from([0xd1]));
    emit(opU30(0x66, operands.mapScale));
    emit(Buffer.from([0xa2])); // multiply
    emit(opU30(0x61, operands.x));
    emit(opU30(0x62, 30));
    emit(opU30(0x25, FELGUARD_MAP_Y));
    emit(Buffer.from([0xd1]));
    emit(opU30(0x66, operands.mapOffsetY));
    emit(Buffer.from([0xa1]));
    emit(Buffer.from([0xd1]));
    emit(opU30(0x66, operands.mapScale));
    emit(Buffer.from([0xa2]));
    emit(opU30(0x61, operands.y));
    emit(Buffer.from([0xd0]));
    emit(opU30(0x66, operands.markerLayer));
    emit(opU30(0x62, 30));
    emit(opU30U30(0x4f, operands.addChild, 1));

    const originalCleanupOffset = length;
    patchBranch(ifOtherMap, 0x12, originalCleanupOffset);
    patchBranch(ifMissionExists, 0x11, missionExistsOffset);
    patchBranch(ifPrerequisiteMissing, 0x12, originalCleanupOffset);
    patchBranch(afterNewFrame, 0x10, renderOffset);
    patchBranch(ifClaimed, 0x11, originalCleanupOffset);
    patchBranch(ifReadyState, 0x11, readyToTurnInOffset);
    patchBranch(ifReadyProgress, 0x18, readyToTurnInOffset); // ifge: currCount >= 20
    patchBranch(afterActiveFrame, 0x10, renderOffset);
    patchBranch(ifAssetMissing, 0x12, originalCleanupOffset);
    return Buffer.concat(chunks);
}

function hasMapMarkerPatch(abc: ReturnType<typeof parseAbc>, code: Buffer): boolean {
    const asset = abc.stringValues.indexOf('a_MapMarkerSimple');
    const instructions = disassemble(code, 'Clear the Bandits map marker verify');
    const bytes = new Set(instructions
        .filter((instruction) => instruction.opcode === 0x24)
        .map((instruction) => instruction.operands[0]?.[1]));
    const shorts = new Set(instructions
        .filter((instruction) => instruction.opcode === 0x25)
        .map((instruction) => instruction.operands[0]?.[1]));
    const assetUses = instructions.filter((instruction) =>
        instruction.opcode === 0x2c && instruction.operands[0]?.[1] === asset
    ).length;
    const hasProjection = (coordinate: number, offsetName: string, axisName: string): boolean =>
        instructions.some((instruction, index) =>
            instruction.opcode === 0x25 && instruction.operands[0]?.[1] === coordinate &&
            instructions[index + 1]?.opcode === 0xd1 &&
            instructions[index + 2]?.opcode === 0x66 &&
            u30OperandName(instructions[index + 2], abc.multinameNames) === offsetName &&
            instructions[index + 3]?.opcode === 0xa1 &&
            instructions[index + 4]?.opcode === 0xd1 &&
            instructions[index + 5]?.opcode === 0x66 &&
            u30OperandName(instructions[index + 5], abc.multinameNames) === 'var_586' &&
            instructions[index + 6]?.opcode === 0xa2 &&
            instructions[index + 7]?.opcode === 0x61 &&
            u30OperandName(instructions[index + 7], abc.multinameNames) === axisName
        );
    return assetUses >= 2 &&
        [
            CLEAR_THE_BANDITS_MISSION_ID,
            SEE_THE_WARDEN_MISSION_ID,
            CLEAR_THE_BANDITS_COMPLETE_COUNT,
            5,
            6,
            7
        ]
            .every((value) => bytes.has(value)) &&
        hasCompleteProgressFallback(instructions, abc.multinameNames) &&
        shorts.has(FELGUARD_MAP_X) && shorts.has(FELGUARD_MAP_Y) &&
        hasProjection(FELGUARD_MAP_X, 'var_1287', 'x') &&
        hasProjection(FELGUARD_MAP_Y, 'var_1208', 'y');
}

function verifyMapMarker(swfPath: string): void {
    const { ctx, abc, body } = findMapContext(swfPath);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (!hasMapMarkerPatch(abc, code)) {
        throw new PatchError(`${path.basename(swfPath)} is missing the Clear the Bandits map marker flow.`);
    }
    const maxStack = readU30(ctx.body, body.maxStackPos, 'map marker max stack')[0];
    if (maxStack < 5) {
        throw new PatchError(`Mission map max stack is unexpectedly low: ${maxStack}.`);
    }
    if (body.exceptionCount !== 0) {
        throw new PatchError('Mission map refresh unexpectedly contains an exception table.');
    }
    const unsafeMetadataWrites = disassemble(code, 'load-safe map marker').filter((instruction) =>
        instruction.opcode === 0x61 &&
        ['var_160', 'var_319', 'var_2110', 'var_431', 'displayName'].includes(
            u30OperandName(instruction, abc.multinameNames) ?? ''
        )
    );
    if (unsafeMetadataWrites.length > 0) {
        throw new PatchError('Mission map marker contains a load-unsafe mission metadata mutation.');
    }
    verifyBranchTargets(code);
    console.log(`${path.basename(swfPath)} Clear the Bandits map marker verify ok.`);
}

function patchMapMarker(swfPath: string): void {
    const { ctx, abc, body } = findMapContext(swfPath);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (hasMapMarkerPatch(abc, code)) {
        console.log(`${path.basename(swfPath)} already has the Clear the Bandits map marker flow.`);
        return;
    }
    if (body.exceptionCount !== 0) {
        throw new PatchError('Mission map refresh has an unexpected exception table.');
    }
    const markerContext = findMarkerContext(swfPath);
    const resolverCode = markerContext.ctx.body.subarray(
        markerContext.resolverBody.codeStart,
        markerContext.resolverBody.codeStart + markerContext.resolverBody.codeLen
    );
    const insertionOffset = findMapCleanupOffset(code);
    const assetString = abc.stringValues.indexOf('a_MapMarkerSimple');
    if (assetString < 0) {
        throw new PatchError('The standard a_MapMarkerSimple asset is missing.');
    }
    const bridgeTownString = abc.stringValues.indexOf('BridgeTown');
    if (bridgeTownString < 0) {
        throw new PatchError('BridgeTown is missing from the mission map.');
    }
    const operands: MapMarkerOperands = {
        mapName: findUniqueOperand(code, abc.multinameNames, 0x66, 'var_102'),
        game: findUniqueOperand(code, abc.multinameNames, 0x60, 'var_1'),
        missionList: findUniqueOperand(code, abc.multinameNames, 0x66, 'mMissionInfoList'),
        dynamicLookup: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, '*'),
        missionClass: findUniqueOperand(code, abc.multinameNames, 0x80, 'Mission'),
        missionState: findUniqueOperand(code, abc.multinameNames, 0x66, 'var_145'),
        missionProgress: findUniqueMultiname(abc.multinameNames, 'currCount'),
        missionCompleteState: findUniqueOperand(code, abc.multinameNames, 0x66, 'const_58'),
        missionClaimedState: findUniqueOperand(resolverCode, abc.multinameNames, 0x66, 'const_72'),
        missionIsComplete: findUniqueMultiname(abc.multinameNames, 'MissionIsComplete'),
        assetFactory: findUniqueOperand(code, abc.multinameNames, 0x60, 'class_4'),
        assetFactoryMethod: findUniqueOperand(code, abc.multinameNames, 0x46, 'method_16'),
        movieClipClass: findUniqueOperand(code, abc.multinameNames, 0x80, 'MovieClip'),
        gotoAndStop: findUniqueOperand(code, abc.multinameNames, 0x4f, 'gotoAndStop'),
        markerLayer: findUniqueOperand(code, abc.multinameNames, 0x66, 'var_608'),
        addChild: findUniqueOperand(code, abc.multinameNames, 0x4f, 'addChild'),
        mapOffsetX: findUniqueOperand(code, abc.multinameNames, 0x66, 'var_1287'),
        mapOffsetY: findUniqueOperand(code, abc.multinameNames, 0x66, 'var_1208'),
        mapScale: findUniqueOperand(code, abc.multinameNames, 0x66, 'var_586'),
        x: findUniqueOperand(code, abc.multinameNames, 0x61, 'x'),
        y: findUniqueOperand(code, abc.multinameNames, 0x61, 'y')
    };
    const guard = buildMapMarkerGuard(insertionOffset, assetString, bridgeTownString, operands);
    const patches: BytePatch[] = [{
        key: 'map-marker-code-length',
        start: body.codeLenPos,
        end: body.codeStart,
        data: writeU30(body.codeLen + guard.length),
        detail: 'update mission map refresh code length'
    }, {
        key: 'map-marker-guard',
        start: body.codeStart + insertionOffset,
        end: body.codeStart + insertionOffset,
        data: guard,
        detail: 'render Mission 11 directly through the standard map marker asset'
    }, ...branchAdjustmentPatches(body, code, insertionOffset, guard.length)];
    const patched = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, patched.body, patched.delta);
    verifyMapMarker(swfPath);
    console.log(`${path.basename(swfPath)} patched with the load-safe Clear the Bandits map marker flow.`);
}

function syncClientRevision(swfPath: string, verifyOnly: boolean): void {
    const digest = crypto.createHash('sha256').update(fs.readFileSync(swfPath)).digest('hex').slice(0, 12);
    const html = fs.readFileSync(INDEX_HTML, 'utf8');
    const expected = `clientrev=swf-${digest}`;
    if (verifyOnly) {
        if (!html.includes(expected)) {
            throw new PatchError(`index.html does not use ${expected}.`);
        }
        return;
    }
    const updated = html.replace(/clientrev=[^&`"'$]+/, expected);
    if (updated === html && !html.includes(expected)) {
        throw new PatchError('Could not update the DungeonBlitz client revision in index.html.');
    }
    if (updated !== html) {
        fs.writeFileSync(INDEX_HTML, updated, 'utf8');
    }
}

const { swfPath, verify } = parseArgs(process.argv);
if (verify) {
    verifyNpcContactMarker(swfPath);
    verifyNpcSpawnMarker(swfPath);
    verifyAcceptanceRefresh(swfPath);
    verifyCompletionRefresh(swfPath);
    verifyClaimRefresh(swfPath);
    verifyPacketRefreshes(swfPath);
    verifyMapMarker(swfPath);
    syncClientRevision(swfPath, true);
} else {
    ensureFelguardString(swfPath);
    patchNpcContactMarker(swfPath);
    patchNpcSpawnMarker(swfPath);
    patchAcceptanceRefresh(swfPath);
    patchCompletionRefresh(swfPath);
    patchClaimRefresh(swfPath);
    patchPacketRefreshes(swfPath);
    patchMapMarker(swfPath);
    syncClientRevision(swfPath, false);
}
