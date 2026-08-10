import * as path from 'path';
import * as crypto from 'crypto';
import * as fs from 'fs';
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
const CLEAR_THE_BANDITS_MISSION_ID = 11;
const INDEX_HTML = path.resolve(__dirname, '..', '..', 'client', 'content', 'localhost', 'index.html');
const TRACKER_TITLE = 'Clear the Bandits';
const TOP_QUEST_TITLE = 'Clear the bandits';
const TRACKER_DESCRIPTION = 'Defeat 20 human bandits in Felbridge.';
const TRACKER_COUNT_SUFFIX = '/20';

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

function branch(opcode: number, fromOffset: number, targetOffset: number): Buffer {
    return Buffer.concat([Buffer.from([opcode]), encodeS24(targetOffset - (fromOffset + 4))]);
}

function encodeString(value: string): Buffer {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([writeU30(bytes.length), bytes]);
}

function findTrackerBody(swfPath: string) {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const trackerIndex = classIndexByName(abc, 'class_112');
    if (trackerIndex === null) {
        throw new PatchError('Could not find the quest tracker class.');
    }
    const methodIdx = methodIdxForTrait(abc.instances[trackerIndex].traits, abc, 'OnRefreshScreen');
    if (methodIdx === null) {
        throw new PatchError('Could not find the quest tracker refresh method.');
    }
    const body = abc.methodBodies.get(methodIdx);
    if (!body) {
        throw new PatchError('Quest tracker refresh method has no body.');
    }
    return { ctx, abc, body };
}

function findMissionParserBody(swfPath: string) {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const contactNameString = abc.stringValues.indexOf('ContactName');
    const matches = [...abc.methodBodies.values()].filter((candidate) => {
        const code = ctx.body.subarray(candidate.codeStart, candidate.codeStart + candidate.codeLen);
        try {
            return disassemble(code, 'mission-parser-search').some((instruction) =>
                instruction.opcode === 0x2c && instruction.operands[0]?.[1] === contactNameString
            );
        } catch {
            return false;
        }
    });
    if (matches.length !== 1) {
        throw new PatchError(`Expected one mission definition XML parser, found ${matches.length}.`);
    }
    return { ctx, abc, body: matches[0] };
}

function findMethodOperand(code: Buffer, names: string[], opcode: number, name: string): number {
    const matches = disassemble(code, `class_112.OnRefreshScreen.${name}`)
        .filter((instruction) => instruction.opcode === opcode && u30OperandName(instruction, names) === name)
        .map((instruction) => instruction.operands[0]?.[1])
        .filter((value): value is number => value !== undefined);
    const unique = [...new Set(matches)];
    if (unique.length !== 1) {
        throw new PatchError(`Expected one ${name} operand in the tracker method, found ${unique.length}.`);
    }
    return unique[0];
}

function findDynamicMissionLookup(code: Buffer, names: string[]): number {
    const instructions = disassemble(code, 'class_112.OnRefreshScreen.lookup');
    for (let index = 0; index < instructions.length - 3; index += 1) {
        if (
            instructions[index].opcode === 0x66 &&
            u30OperandName(instructions[index], names) === 'mMissionInfoList' &&
            instructions[index + 3].opcode === 0x66
        ) {
            const operand = instructions[index + 3].operands[0];
            if (operand?.[0] === 'u30') {
                return operand[1];
            }
        }
    }
    throw new PatchError('Could not find the mission-list dynamic lookup multiname.');
}

function findInsertionOffset(code: Buffer, names: string[]): number {
    const instructions = disassemble(code, 'class_112.OnRefreshScreen.insertion');
    for (let index = 0; index < instructions.length - 3; index += 1) {
        if (
            instructions[index].opcode === 0x60 &&
            u30OperandName(instructions[index], names) === 'var_1' &&
            instructions[index + 1].opcode === 0x66 &&
            u30OperandName(instructions[index + 1], names) === 'mTrackedMission' &&
            instructions[index + 3].opcode === 0xd7
        ) {
            return instructions[index + 3].offset + instructions[index + 3].size;
        }
    }
    throw new PatchError('Could not find the tracked-mission initialization point.');
}

function missionCount(multinames: Record<string, number>): Buffer {
    return Buffer.concat([
        opU30(0x60, multinames.var1),
        opU30(0x66, multinames.missionList),
        pushByte(CLEAR_THE_BANDITS_MISSION_ID),
        opU30(0x66, multinames.dynamicLookup),
        opU30(0x66, multinames.currCount)
    ]);
}

function buildTrackerGuard(
    insertionOffset: number,
    multinames: Record<string, number>,
    strings: { title: number; description: number; suffix: number }
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

    emit(Buffer.from([0xd3])); // getlocal3: tracked mission definition
    const ifNoTrackedMission = placeholder();
    emit(Buffer.from([0xd3]));
    emit(opU30(0x66, multinames.missionId));
    emit(pushByte(CLEAR_THE_BANDITS_MISSION_ID));
    const ifOtherMission = placeholder();

    emit(Buffer.from([0xd0]));
    emit(opU30(0x66, multinames.progressBar));
    emit(opU30U30(0x4f, multinames.show, 0));

    emit(Buffer.from([0xd0]));
    emit(opU30(0x66, multinames.progressBar));
    emit(missionCount(multinames));
    emit(pushByte(20));
    emit(Buffer.from([0xa3])); // divide: currCount / 20
    emit(opU30(0x61, multinames.healthPercent));

    emit(Buffer.from([0xd0]));
    emit(opU30(0x66, multinames.progressText));
    emit(opU30(0x5d, multinames.stringClass));
    emit(missionCount(multinames));
    emit(opU30U30(0x46, multinames.stringClass, 1));
    emit(opU30(0x2c, strings.suffix));
    emit(Buffer.from([0xa0])); // add strings
    emit(opU30U30(0x4f, multinames.setText, 1));

    emit(Buffer.from([0xd0]));
    emit(opU30(0x66, multinames.descriptionField));
    emit(opU30(0x2c, strings.description));
    emit(opU30U30(0x4f, multinames.setText, 1));

    emit(Buffer.from([0xd0]));
    emit(opU30(0x66, multinames.titleField));
    emit(opU30(0x2c, strings.title));
    emit(opU30U30(0x4f, multinames.setText, 1));
    emit(Buffer.from([0x47])); // returnvoid

    const afterGuard = length;
    chunks[ifNoTrackedMission.index] = branch(0x12, insertionOffset + ifNoTrackedMission.offset, insertionOffset + afterGuard);
    chunks[ifOtherMission.index] = branch(0x14, insertionOffset + ifOtherMission.offset, insertionOffset + afterGuard);
    return Buffer.concat(chunks);
}

function branchAdjustmentPatches(
    body: ReturnType<typeof findTrackerBody>['body'],
    code: Buffer,
    insertionOffset: number,
    insertionLength: number
): BytePatch[] {
    const patches: BytePatch[] = [];
    for (const instruction of disassemble(code, 'class_112.OnRefreshScreen.branches')) {
        const operand = instruction.operands[0];
        if (!operand || operand[0] !== 's24') {
            continue;
        }
        const target = instruction.offset + instruction.size + operand[1];
        let next = operand[1];
        if (instruction.offset < insertionOffset && target >= insertionOffset) {
            next += insertionLength;
        } else if (instruction.offset >= insertionOffset && target < insertionOffset) {
            next -= insertionLength;
        } else {
            continue;
        }
        patches.push({
            key: `tracker-branch-${instruction.offset}`,
            start: body.codeStart + instruction.offset + 1,
            end: body.codeStart + instruction.offset + instruction.size,
            data: encodeS24(next),
            detail: 'adjust quest tracker branch across custom mission guard'
        });
    }
    return patches;
}

function verifyBranchTargets(code: Buffer, label: string): void {
    const instructions = disassemble(code, label);
    const instructionOffsets = new Set(instructions.map((instruction) => instruction.offset));
    instructionOffsets.add(code.length);
    for (const instruction of instructions) {
        for (const operand of instruction.operands) {
            if (operand[0] !== 's24') {
                continue;
            }
            const target = instruction.offset + instruction.size + operand[1];
            if (!instructionOffsets.has(target)) {
                throw new PatchError(
                    `${label} has an invalid branch from ${instruction.offset} to ${target}.`
                );
            }
        }
    }
}

function buildMissionMarkerMetadata(
    insertionOffset: number,
    multinames: Record<string, number>,
    strings: { felguard: number; prerequisite: number; bridgeTown: number; title: number }
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

    emit(opU30(0x62, 4)); // getlocal 4: parsed class_13 mission definition
    emit(opU30(0x66, multinames.missionId));
    emit(pushByte(CLEAR_THE_BANDITS_MISSION_ID));
    const ifOtherMission = placeholder();

    for (const [property, stringIndex] of [
        [multinames.contactName, strings.felguard],
        [multinames.returnName, strings.felguard],
        [multinames.prerequisite, strings.prerequisite],
        [multinames.zoneSet, strings.bridgeTown],
        [multinames.displayName, strings.title]
    ] as const) {
        emit(opU30(0x62, 4));
        emit(opU30(0x2c, stringIndex));
        emit(opU30(0x61, property));
    }

    const afterGuard = length;
    chunks[ifOtherMission.index] = branch(
        0x14,
        insertionOffset + ifOtherMission.offset,
        insertionOffset + afterGuard
    );
    return Buffer.concat(chunks);
}

function hasMissionMarkerPatch(abc: ReturnType<typeof parseAbc>, code: Buffer): boolean {
    const felguard = abc.stringValues.indexOf('Felguard');
    const prerequisite = abc.stringValues.indexOf('SeeTheWarden');
    const title = abc.stringValues.indexOf(TOP_QUEST_TITLE);
    if (felguard < 0 || prerequisite < 0 || title < 0) {
        return false;
    }
    const instructions = disassemble(code, 'class_13.method_18.marker.verify');
    const returnValue = instructions.find((instruction) => instruction.opcode === 0x48);
    if (!returnValue) {
        return false;
    }
    const activeInstructions = instructions.filter((instruction) => instruction.offset < returnValue.offset);
    return [felguard, prerequisite, title].every((stringIndex) =>
        activeInstructions.some((instruction) =>
            instruction.opcode === 0x2c && instruction.operands[0]?.[1] === stringIndex
        )
    );
}

function patchMissionMarkerMetadata(swfPath: string): void {
    const { ctx, abc, body } = findMissionParserBody(swfPath);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (hasMissionMarkerPatch(abc, code)) {
        console.log(`${path.basename(swfPath)} already has the Clear the Bandits NPC/map marker metadata.`);
        return;
    }
    if (body.exceptionCount !== 0) {
        throw new PatchError('Mission definition parser has an unexpected exception table.');
    }

    const instructions = disassemble(code, 'class_13.method_18.marker.insertion');
    const returnValues = instructions.filter((instruction) => instruction.opcode === 0x48);
    if (returnValues.length !== 1) {
        throw new PatchError(`Expected one mission parser returnvalue, found ${returnValues.length}.`);
    }
    const returnIndex = instructions.indexOf(returnValues[0]);
    const parsedMissionLoad = instructions[returnIndex - 1];
    if (
        !parsedMissionLoad ||
        parsedMissionLoad.opcode !== 0x62 ||
        parsedMissionLoad.operands[0]?.[1] !== 4
    ) {
        throw new PatchError('Mission parser does not load the parsed mission before returnvalue.');
    }
    const insertionOffset = parsedMissionLoad.offset;

    const addedStringValues: string[] = [];
    const stringIndex = (value: string): number => {
        const existingIndex = abc.stringValues.indexOf(value);
        if (existingIndex >= 0) {
            return existingIndex;
        }
        const pendingIndex = addedStringValues.indexOf(value);
        if (pendingIndex >= 0) {
            return abc.stringValues.length + pendingIndex;
        }
        addedStringValues.push(value);
        return abc.stringValues.length + addedStringValues.length - 1;
    };

    const felguardIndex = stringIndex('Felguard');
    const prerequisiteIndex = stringIndex('SeeTheWarden');
    const topQuestTitleIndex = stringIndex(TOP_QUEST_TITLE);
    const bridgeTownIndex = abc.stringValues.indexOf('BridgeTown');
    if (bridgeTownIndex < 0) {
        throw new PatchError('BridgeTown is missing from DungeonBlitz.swf.');
    }

    const marker = buildMissionMarkerMetadata(insertionOffset, {
        missionId: findMethodOperand(code, abc.multinameNames, 0x61, 'missionID'),
        contactName: findMethodOperand(code, abc.multinameNames, 0x61, 'var_160'),
        returnName: findMethodOperand(code, abc.multinameNames, 0x61, 'var_319'),
        prerequisite: findMethodOperand(code, abc.multinameNames, 0x61, 'var_2110'),
        zoneSet: findMethodOperand(code, abc.multinameNames, 0x61, 'var_431'),
        displayName: findMethodOperand(code, abc.multinameNames, 0x61, 'displayName')
    }, {
        felguard: felguardIndex,
        prerequisite: prerequisiteIndex,
        bridgeTown: bridgeTownIndex,
        title: topQuestTitleIndex
    });
    const patches: BytePatch[] = [];
    if (addedStringValues.length > 0) {
        patches.push({
            key: 'marker-string-count',
            start: abc.stringCountPos,
            end: abc.stringCountEnd,
            data: writeU30(abc.stringValues.length + addedStringValues.length),
            detail: 'reserve Clear the Bandits NPC/map marker strings'
        }, {
            key: 'marker-strings',
            start: abc.stringPoolEnd,
            end: abc.stringPoolEnd,
            data: Buffer.concat(addedStringValues.map(encodeString)),
            detail: 'add Clear the Bandits NPC/map marker strings'
        });
    }
    patches.push({
            key: 'marker-code-length',
            start: body.codeLenPos,
            end: body.codeStart,
            data: writeU30(body.codeLen + marker.length),
            detail: 'update mission parser code length'
        },
        {
            key: 'marker-metadata',
            start: body.codeStart + insertionOffset,
            end: body.codeStart + insertionOffset,
            data: marker,
            detail: 'attach mission 11 to Felguard and BridgeTown'
        },
        ...branchAdjustmentPatches(body, code, insertionOffset, marker.length)
    );

    ensureBackup(swfPath);
    const patched = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, patched.body, patched.delta);
    verifyMissionMarkerMetadata(swfPath);
    console.log(`${path.basename(swfPath)} patched with Clear the Bandits NPC/map marker metadata.`);
}

function verifyMissionMarkerMetadata(swfPath: string): void {
    const { ctx, abc, body } = findMissionParserBody(swfPath);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (!hasMissionMarkerPatch(abc, code)) {
        throw new PatchError(`${path.basename(swfPath)} is missing Clear the Bandits NPC/map marker metadata.`);
    }
    verifyBranchTargets(code, 'Clear the Bandits mission parser');
}

function removeLoadUnsafeMissionMarkerMetadata(swfPath: string): void {
    const { ctx, abc, body } = findMissionParserBody(swfPath);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (!hasMissionMarkerPatch(abc, code)) {
        console.log(`${path.basename(swfPath)} has no load-unsafe Clear the Bandits parser metadata.`);
        return;
    }

    const instructions = disassemble(code, 'class_13.ClearTheBandits.marker.rollback');
    const returnPosition = instructions.findIndex((instruction) => instruction.opcode === 0x48);
    const titleIndex = abc.stringValues.indexOf(TOP_QUEST_TITLE);
    const titlePosition = instructions.findIndex((instruction, index) =>
        index < returnPosition &&
        instruction.opcode === 0x2c &&
        instruction.operands[0]?.[1] === titleIndex
    );
    let missionGuardPosition = -1;
    for (let index = titlePosition - 1; index >= 2; index -= 1) {
        if (
            instructions[index].opcode === 0x24 &&
            instructions[index].operands[0]?.[1] === CLEAR_THE_BANDITS_MISSION_ID &&
            instructions[index + 1]?.opcode === 0x14 &&
            instructions[index - 1]?.opcode === 0x66 &&
            instructions[index - 2]?.opcode === 0x62 &&
            instructions[index - 2]?.operands[0]?.[1] === 4
        ) {
            missionGuardPosition = index - 2;
            break;
        }
    }
    const parsedMissionLoad = instructions[returnPosition - 1];
    if (missionGuardPosition < 0 || !parsedMissionLoad || parsedMissionLoad.opcode !== 0x62) {
        throw new PatchError('Could not locate the load-unsafe mission marker guard.');
    }

    const removalStart = instructions[missionGuardPosition].offset;
    const removalEnd = parsedMissionLoad.offset;
    const removalLength = removalEnd - removalStart;
    const branchPatches: BytePatch[] = [];
    for (const instruction of instructions) {
        if (instruction.offset >= removalStart && instruction.offset < removalEnd) {
            continue;
        }
        const operand = instruction.operands[0];
        if (!operand || operand[0] !== 's24') {
            continue;
        }
        const target = instruction.offset + instruction.size + operand[1];
        let next = operand[1];
        if (instruction.offset < removalStart && target >= removalEnd) {
            next -= removalLength;
        } else if (instruction.offset >= removalEnd && target < removalStart) {
            next += removalLength;
        } else {
            continue;
        }
        branchPatches.push({
            key: `marker-rollback-branch-${instruction.offset}`,
            start: body.codeStart + instruction.offset + 1,
            end: body.codeStart + instruction.offset + instruction.size,
            data: encodeS24(next),
            detail: 'restore mission parser branch after removing unsafe marker metadata'
        });
    }

    const patches: BytePatch[] = [
        {
            key: 'marker-rollback-code-length',
            start: body.codeLenPos,
            end: body.codeStart,
            data: writeU30(body.codeLen - removalLength),
            detail: 'restore mission parser code length'
        },
        {
            key: 'marker-rollback-code',
            start: body.codeStart + removalStart,
            end: body.codeStart + removalEnd,
            data: Buffer.alloc(0),
            detail: 'remove load-unsafe Clear the Bandits parser metadata'
        },
        ...branchPatches
    ];

    const patched = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, patched.body, patched.delta);

    const repaired = findMissionParserBody(swfPath);
    const repairedCode = repaired.ctx.body.subarray(
        repaired.body.codeStart,
        repaired.body.codeStart + repaired.body.codeLen
    );
    if (hasMissionMarkerPatch(repaired.abc, repairedCode)) {
        throw new PatchError('Load-unsafe mission marker metadata remained after rollback.');
    }
    verifyBranchTargets(repairedCode, 'repaired Clear the Bandits mission parser');
    console.log(`${path.basename(swfPath)} repaired by removing load-unsafe mission parser metadata.`);
}

function hasTrackerPatch(abc: ReturnType<typeof parseAbc>, code: Buffer): boolean {
    const hasStrings = [TRACKER_TITLE, TRACKER_DESCRIPTION, TRACKER_COUNT_SUFFIX]
        .every((value) => abc.stringValues.includes(value));
    if (!hasStrings) {
        return false;
    }
    const instructions = disassemble(code, 'class_112.OnRefreshScreen.verify');
    return instructions.some((instruction) =>
        instruction.opcode === 0x24 && instruction.operands[0]?.[1] === CLEAR_THE_BANDITS_MISSION_ID
    ) && instructions.some((instruction) =>
        instruction.opcode === 0x2c &&
        instruction.operands[0]?.[0] === 'u30' &&
        abc.stringValues[instruction.operands[0][1]] === TRACKER_TITLE
    );
}

function findCustomTrackerGuard(
    abc: ReturnType<typeof parseAbc>,
    code: Buffer
): { instructions: ReturnType<typeof disassemble>; startOffset: number; endOffset: number } {
    const titleIndex = abc.stringValues.indexOf(TRACKER_TITLE);
    const instructions = disassemble(code, 'class_112.OnRefreshScreen.custom-guard');
    const titlePosition = instructions.findIndex((instruction) =>
        instruction.opcode === 0x2c && instruction.operands[0]?.[1] === titleIndex
    );
    if (titlePosition < 0) {
        throw new PatchError('Could not locate the Clear the Bandits tracker title.');
    }

    let startPosition = -1;
    for (let index = titlePosition - 1; index >= 0; index -= 1) {
        if (
            instructions[index].opcode === 0x24 &&
            instructions[index].operands[0]?.[1] === CLEAR_THE_BANDITS_MISSION_ID &&
            instructions[index + 1]?.opcode === 0x14
        ) {
            startPosition = Math.max(0, index - 4);
            break;
        }
    }
    const endPosition = instructions.findIndex(
        (instruction, index) => index > titlePosition && instruction.opcode === 0x47
    );
    if (startPosition < 0 || endPosition < 0) {
        throw new PatchError('Could not determine the Clear the Bandits tracker guard bounds.');
    }
    return {
        instructions,
        startOffset: instructions[startPosition].offset,
        endOffset: instructions[endPosition].offset + instructions[endPosition].size
    };
}

function customTrackerShowCalls(
    abc: ReturnType<typeof parseAbc>,
    code: Buffer
): ReturnType<typeof disassemble> {
    const guard = findCustomTrackerGuard(abc, code);
    return guard.instructions.filter((instruction) =>
        instruction.offset >= guard.startOffset &&
        instruction.offset < guard.endOffset &&
        instruction.opcode === 0x4f &&
        u30OperandName(instruction, abc.multinameNames) === 'Show'
    );
}

function removeLoadUnsafeTrackerCountVisibility(swfPath: string): void {
    const { ctx, abc, body } = findTrackerBody(swfPath);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const showCalls = customTrackerShowCalls(abc, code);
    if (showCalls.length === 1) {
        console.log(`${path.basename(swfPath)} already uses the load-safe tracker visibility.`);
        return;
    }
    if (showCalls.length !== 2) {
        throw new PatchError(`Expected one or two custom tracker Show calls, found ${showCalls.length}.`);
    }

    const instructions = disassemble(code, 'class_112.ClearTheBandits.count.rollback');
    const showPosition = instructions.findIndex((instruction) => instruction.offset === showCalls[1].offset);
    const localLoad = instructions[showPosition - 2];
    const progressTextLoad = instructions[showPosition - 1];
    if (
        !localLoad || localLoad.opcode !== 0xd0 ||
        !progressTextLoad || progressTextLoad.opcode !== 0x66 ||
        u30OperandName(progressTextLoad, abc.multinameNames) !== 'var_327'
    ) {
        throw new PatchError('Could not locate the numeric tracker visibility sequence.');
    }

    const removalStart = localLoad.offset;
    const removalEnd = showCalls[1].offset + showCalls[1].size;
    const removalLength = removalEnd - removalStart;
    const branchPatches: BytePatch[] = [];
    for (const instruction of instructions) {
        if (instruction.offset >= removalStart && instruction.offset < removalEnd) {
            continue;
        }
        const operand = instruction.operands[0];
        if (!operand || operand[0] !== 's24') {
            continue;
        }
        const target = instruction.offset + instruction.size + operand[1];
        let next = operand[1];
        if (instruction.offset < removalStart && target >= removalEnd) {
            next -= removalLength;
        } else if (instruction.offset >= removalEnd && target < removalStart) {
            next += removalLength;
        } else {
            continue;
        }
        branchPatches.push({
            key: `tracker-count-rollback-branch-${instruction.offset}`,
            start: body.codeStart + instruction.offset + 1,
            end: body.codeStart + instruction.offset + instruction.size,
            data: encodeS24(next),
            detail: 'restore tracker branch after removing unsafe numeric visibility'
        });
    }

    const patches: BytePatch[] = [
        {
            key: 'tracker-count-rollback-code-length',
            start: body.codeLenPos,
            end: body.codeStart,
            data: writeU30(body.codeLen - removalLength),
            detail: 'restore tracker code length'
        },
        {
            key: 'tracker-count-rollback-code',
            start: body.codeStart + removalStart,
            end: body.codeStart + removalEnd,
            data: Buffer.alloc(0),
            detail: 'remove load-unsafe numeric tracker visibility'
        },
        ...branchPatches
    ];

    const patched = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, patched.body, patched.delta);
    console.log(`${path.basename(swfPath)} restored to load-safe tracker visibility.`);
}

function patchTrackerCountVisibility(swfPath: string): void {
    const { ctx, abc, body } = findTrackerBody(swfPath);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (!hasTrackerPatch(abc, code)) {
        throw new PatchError('Cannot show numeric progress before the tracker patch is installed.');
    }
    const showCalls = customTrackerShowCalls(abc, code);
    if (showCalls.length >= 2) {
        console.log(`${path.basename(swfPath)} already shows numeric Clear the Bandits progress.`);
        return;
    }
    if (showCalls.length !== 1) {
        throw new PatchError(`Expected one custom tracker Show call, found ${showCalls.length}.`);
    }

    const insertionOffset = showCalls[0].offset + showCalls[0].size;
    const visibilityCode = Buffer.concat([
        Buffer.from([0xd0]),
        opU30(0x66, findMethodOperand(code, abc.multinameNames, 0x66, 'var_327')),
        opU30U30(0x4f, findMethodOperand(code, abc.multinameNames, 0x4f, 'Show'), 0)
    ]);
    const patches: BytePatch[] = [
        {
            key: 'tracker-count-code-length',
            start: body.codeLenPos,
            end: body.codeStart,
            data: writeU30(body.codeLen + visibilityCode.length),
            detail: 'update quest tracker code length for numeric progress visibility'
        },
        {
            key: 'tracker-count-show',
            start: body.codeStart + insertionOffset,
            end: body.codeStart + insertionOffset,
            data: visibilityCode,
            detail: 'show the Clear the Bandits numeric progress field'
        },
        ...branchAdjustmentPatches(body, code, insertionOffset, visibilityCode.length)
    ];

    ensureBackup(swfPath);
    const patched = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, patched.body, patched.delta);
    console.log(`${path.basename(swfPath)} patched to show Clear the Bandits progress as a number.`);
}

function patchSwf(swfPath: string): void {
    const { ctx, abc, body } = findTrackerBody(swfPath);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (hasTrackerPatch(abc, code)) {
        console.log(`${path.basename(swfPath)} already has the Clear the Bandits tracker patch.`);
        return;
    }
    if (body.exceptionCount !== 0) {
        throw new PatchError('Quest tracker refresh method has an unexpected exception table.');
    }

    const insertionOffset = findInsertionOffset(code, abc.multinameNames);
    const titleIndex = abc.stringValues.length;
    const descriptionIndex = titleIndex + 1;
    const suffixIndex = titleIndex + 2;
    const multinames = {
        var1: findMethodOperand(code, abc.multinameNames, 0x60, 'var_1'),
        missionList: findMethodOperand(code, abc.multinameNames, 0x66, 'mMissionInfoList'),
        dynamicLookup: findDynamicMissionLookup(code, abc.multinameNames),
        currCount: findMethodOperand(code, abc.multinameNames, 0x66, 'currCount'),
        missionId: findMethodOperand(code, abc.multinameNames, 0x66, 'missionID'),
        progressBar: findMethodOperand(code, abc.multinameNames, 0x66, 'var_480'),
        progressText: findMethodOperand(code, abc.multinameNames, 0x66, 'var_327'),
        descriptionField: findMethodOperand(code, abc.multinameNames, 0x66, 'var_458'),
        titleField: findMethodOperand(code, abc.multinameNames, 0x66, 'var_658'),
        show: findMethodOperand(code, abc.multinameNames, 0x4f, 'Show'),
        setText: findMethodOperand(code, abc.multinameNames, 0x4f, 'SetText'),
        healthPercent: findMethodOperand(code, abc.multinameNames, 0x61, 'mHealthPerc'),
        stringClass: findMethodOperand(code, abc.multinameNames, 0x5d, 'String')
    };
    const guard = buildTrackerGuard(insertionOffset, multinames, {
        title: titleIndex,
        description: descriptionIndex,
        suffix: suffixIndex
    });
    const addedStrings = Buffer.concat([
        encodeString(TRACKER_TITLE),
        encodeString(TRACKER_DESCRIPTION),
        encodeString(TRACKER_COUNT_SUFFIX)
    ]);
    const patches: BytePatch[] = [
        {
            key: 'tracker-string-count',
            start: abc.stringCountPos,
            end: abc.stringCountEnd,
            data: writeU30(abc.stringValues.length + 3),
            detail: 'reserve Clear the Bandits tracker strings'
        },
        {
            key: 'tracker-strings',
            start: abc.stringPoolEnd,
            end: abc.stringPoolEnd,
            data: addedStrings,
            detail: 'add Clear the Bandits tracker strings'
        },
        {
            key: 'tracker-max-stack',
            start: body.maxStackPos,
            end: body.localCountPos,
            data: writeU30(8),
            detail: 'raise quest tracker refresh stack capacity'
        },
        {
            key: 'tracker-code-length',
            start: body.codeLenPos,
            end: body.codeStart,
            data: writeU30(body.codeLen + guard.length),
            detail: 'update quest tracker refresh code length'
        },
        {
            key: 'tracker-guard',
            start: body.codeStart + insertionOffset,
            end: body.codeStart + insertionOffset,
            data: guard,
            detail: 'render Clear the Bandits in the HUD quest tracker'
        },
        ...branchAdjustmentPatches(body, code, insertionOffset, guard.length)
    ];

    ensureBackup(swfPath);
    const patched = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, patched.body, patched.delta);
    verifySwf(swfPath, false);
    console.log(`${path.basename(swfPath)} patched with the Clear the Bandits HUD tracker.`);
}

function verifySwf(swfPath: string, requireNumericProgress = true): void {
    const { ctx, abc, body } = findTrackerBody(swfPath);
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    if (!hasTrackerPatch(abc, code)) {
        throw new PatchError(`${path.basename(swfPath)} is missing the Clear the Bandits tracker patch.`);
    }
    const showCallCount = customTrackerShowCalls(abc, code).length;
    if (showCallCount < 1 || (requireNumericProgress && showCallCount !== 2)) {
        throw new PatchError(
            `${path.basename(swfPath)} is missing the Clear the Bandits numeric progress visibility.`
        );
    }
    verifyBranchTargets(code, 'Clear the Bandits HUD tracker');
    console.log(`${path.basename(swfPath)} Clear the Bandits tracker verify ok.`);
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
    verifySwf(swfPath);
    const marker = findMissionParserBody(swfPath);
    const markerCode = marker.ctx.body.subarray(marker.body.codeStart, marker.body.codeStart + marker.body.codeLen);
    if (hasMissionMarkerPatch(marker.abc, markerCode)) {
        throw new PatchError(`${path.basename(swfPath)} still has load-unsafe mission parser metadata.`);
    }
    verifyBranchTargets(markerCode, 'load-safe mission parser');
    syncClientRevision(swfPath, true);
} else {
    patchSwf(swfPath);
    patchTrackerCountVisibility(swfPath);
    removeLoadUnsafeMissionMarkerMetadata(swfPath);
    verifySwf(swfPath);
    syncClientRevision(swfPath, false);
}
