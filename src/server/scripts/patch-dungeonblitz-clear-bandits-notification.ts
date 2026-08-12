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
const CLEAR_THE_BANDITS_TITLE = 'Clear the bandits';
const CLEAR_THE_BANDITS_EXP = 300;
const CLEAR_THE_BANDITS_GOLD = 500;
const NEW_QUEST_FLOATER = 'var_2159';
const COMPLETE_QUEST_FLOATER = 'var_2059';
const NEW_QUEST_SYMBOL = 'a_NewQuestFloater';
const NEW_QUEST_PANEL = 'am_Panel';

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

function findBodyWithProperty(
    parsed: ReturnType<typeof parseAbc>,
    bodyData: Buffer,
    propertyName: string
) {
    const matches = [...parsed.methodBodies.values()].filter((body) => {
        const code = bodyData.subarray(body.codeStart, body.codeStart + body.codeLen);
        try {
            return disassemble(code, `${propertyName}-handler-search`).some((instruction) =>
                instruction.opcode === 0x66 && u30OperandName(instruction, parsed.multinameNames) === propertyName
            );
        } catch {
            return false;
        }
    });
    if (matches.length !== 1) {
        throw new PatchError(`Expected one ${propertyName} handler, found ${matches.length}.`);
    }
    return matches[0];
}

function findTraitBody(
    parsed: ReturnType<typeof parseAbc>,
    className: string,
    methodName: string
) {
    const classIndex = classIndexByName(parsed, className);
    if (classIndex === null) {
        throw new PatchError(`Could not find ${className}.`);
    }
    const methodIdx = methodIdxForTrait(parsed.instances[classIndex].traits, parsed, methodName);
    if (methodIdx === null) {
        throw new PatchError(`Could not find ${className}.${methodName}.`);
    }
    const body = parsed.methodBodies.get(methodIdx);
    if (!body) {
        throw new PatchError(`${className}.${methodName} has no method body.`);
    }
    return body;
}

function findUniqueOperand(
    code: Buffer,
    names: string[],
    opcode: number,
    propertyName: string,
    label: string
): number {
    const values = disassemble(code, label)
        .filter((instruction) =>
            instruction.opcode === opcode && u30OperandName(instruction, names) === propertyName
        )
        .map((instruction) => instruction.operands[0]?.[1])
        .filter((value): value is number => value !== undefined);
    const unique = [...new Set(values)];
    if (unique.length !== 1) {
        throw new PatchError(`Expected one ${propertyName} operand in ${label}, found ${unique.length}.`);
    }
    return unique[0];
}

function findFloaterInsertionOffset(code: Buffer, names: string[], floaterName: string): number {
    const instructions = disassemble(code, `${floaterName}-insertion`);
    const propertyIndex = instructions.findIndex((instruction) =>
        instruction.opcode === 0x66 && u30OperandName(instruction, names) === floaterName
    );
    const receiver = instructions[propertyIndex - 1];
    if (propertyIndex < 1 || receiver.opcode !== 0xd0) {
        throw new PatchError(`Could not find the ${floaterName} Display receiver.`);
    }
    return receiver.offset;
}

function buildMissionMetadataGuard(
    insertionOffset: number,
    missionLocal: number,
    titleStringIndex: number,
    multinames: { missionId: number; displayName: number; exp: number; gold: number }
): Buffer {
    const chunks: Buffer[] = [];
    let length = 0;
    const emit = (buffer: Buffer): number => {
        const offset = length;
        chunks.push(buffer);
        length += buffer.length;
        return offset;
    };

    const local = (): Buffer => missionLocal <= 3
        ? Buffer.from([0xd0 + missionLocal])
        : opU30(0x62, missionLocal);

    emit(local());
    emit(opU30(0x66, multinames.missionId));
    emit(pushByte(CLEAR_THE_BANDITS_MISSION_ID));
    const skipIndex = chunks.length;
    const skipOffset = emit(Buffer.alloc(4));

    emit(local());
    emit(opU30(0x2c, titleStringIndex));
    emit(opU30(0x61, multinames.displayName));
    emit(local());
    emit(opU30(0x25, CLEAR_THE_BANDITS_EXP));
    emit(opU30(0x61, multinames.exp));
    emit(local());
    emit(opU30(0x25, CLEAR_THE_BANDITS_GOLD));
    emit(opU30(0x61, multinames.gold));

    chunks[skipIndex] = branch(
        0x14,
        insertionOffset + skipOffset,
        insertionOffset + length
    );
    return Buffer.concat(chunks);
}

function branchAdjustmentPatches(
    body: ReturnType<typeof findBodyWithProperty>,
    code: Buffer,
    replacementStart: number,
    replacementEnd: number,
    replacementLength: number,
    keyPrefix: string
): BytePatch[] {
    const delta = replacementLength - (replacementEnd - replacementStart);
    const patches: BytePatch[] = [];
    for (const instruction of disassemble(code, `${keyPrefix}-branches`)) {
        const operand = instruction.operands[0];
        if (!operand || operand[0] !== 's24') {
            continue;
        }
        if (instruction.offset >= replacementStart && instruction.offset < replacementEnd) {
            continue;
        }

        const target = instruction.offset + instruction.size + operand[1];
        if (target > replacementStart && target < replacementEnd) {
            throw new PatchError(`${keyPrefix} has a branch into the replaced bytecode at ${target}.`);
        }

        const nextInstruction = instruction.offset < replacementStart
            ? instruction.offset
            : instruction.offset + delta;
        let nextTarget = target;
        if (target > replacementStart || (target >= replacementEnd && replacementEnd > replacementStart)) {
            nextTarget = target + delta;
        }
        if (target === replacementStart) {
            nextTarget = replacementStart;
        }
        const nextOperand = nextTarget - (nextInstruction + instruction.size);
        if (nextOperand === operand[1]) {
            continue;
        }
        patches.push({
            key: `${keyPrefix}-branch-${instruction.offset}`,
            start: body.codeStart + instruction.offset + 1,
            end: body.codeStart + instruction.offset + instruction.size,
            data: encodeS24(nextOperand),
            detail: `adjust ${keyPrefix} branch across popup metadata`
        });
    }
    return patches;
}

function findNewQuestConstructor(swfPath: string) {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const symbolIndex = abc.stringValues.indexOf(NEW_QUEST_SYMBOL);
    const panelIndex = abc.stringValues.indexOf(NEW_QUEST_PANEL);
    const matches = [...abc.methodBodies.values()].filter((body) => {
        const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
        try {
            const strings = disassemble(code, `new-quest-constructor-${body.methodIdx}`)
                .filter((instruction) => instruction.opcode === 0x2c)
                .map((instruction) => instruction.operands[0]?.[1]);
            return strings.includes(symbolIndex) && strings.includes(panelIndex);
        } catch {
            return false;
        }
    });
    if (matches.length !== 1) {
        throw new PatchError(`Expected one New Quest floater constructor, found ${matches.length}.`);
    }
    return { ctx, abc, body: matches[0] };
}

function removeLegacyTitleFallback(swfPath: string): void {
    const { ctx, abc, body } = findNewQuestConstructor(swfPath);
    const titleIndex = abc.stringValues.indexOf(CLEAR_THE_BANDITS_TITLE);
    if (titleIndex < 0) {
        return;
    }
    const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
    const instructions = disassemble(code, 'legacy-new-quest-title-fallback');
    const titlePosition = instructions.findIndex((instruction) =>
        instruction.opcode === 0x2c && instruction.operands[0]?.[1] === titleIndex
    );
    if (titlePosition < 0) {
        return;
    }
    const start = instructions[titlePosition - 3];
    const empty = instructions[titlePosition - 2];
    const condition = instructions[titlePosition - 1];
    const jump = instructions[titlePosition + 1];
    const suppliedValue = instructions[titlePosition + 2];
    if (
        !start || start.opcode !== 0xd1 ||
        !empty || empty.opcode !== 0x2c || abc.stringValues[empty.operands[0]?.[1] ?? -1] !== '' ||
        !condition || condition.opcode !== 0x14 ||
        !jump || jump.opcode !== 0x10 ||
        !suppliedValue || suppliedValue.opcode !== 0xd1
    ) {
        throw new PatchError('Found an unknown Clear the bandits patch in the New Quest constructor.');
    }
    const replacementStart = start.offset;
    const replacementEnd = suppliedValue.offset + suppliedValue.size;
    const replacement = Buffer.from([0xd1]);
    const delta = replacement.length - (replacementEnd - replacementStart);
    const patches: BytePatch[] = [
        {
            key: 'legacy-title-code-length',
            start: body.codeLenPos,
            end: body.codeStart,
            data: writeU30(body.codeLen + delta),
            detail: 'restore the New Quest constructor code length'
        },
        {
            key: 'legacy-title-fallback',
            start: body.codeStart + replacementStart,
            end: body.codeStart + replacementEnd,
            data: replacement,
            detail: 'remove the ineffective New Quest constructor title fallback'
        },
        ...branchAdjustmentPatches(
            body,
            code,
            replacementStart,
            replacementEnd,
            replacement.length,
            'legacy-title'
        )
    ];
    ensureBackup(swfPath);
    const patched = applyPatchesToBody(ctx.body, patches);
    writeSwf(ctx, patched.body, patched.delta);
    console.log(`${path.basename(swfPath)} removed the legacy New Quest title fallback.`);
}

function popupMetadataState(swfPath: string) {
    const ctx = parseSwf(swfPath);
    const abc = parseAbc(ctx);
    const titleIndex = abc.stringValues.indexOf(CLEAR_THE_BANDITS_TITLE);
    const expBody = findTraitBody(abc, 'class_74', 'OnRefreshScreen');
    const expCode = ctx.body.subarray(expBody.codeStart, expBody.codeStart + expBody.codeLen);
    const expOperand = findUniqueOperand(expCode, abc.multinameNames, 0x66, 'var_1577', 'Complete Quest EXP');
    const goldOperand = findUniqueOperand(expCode, abc.multinameNames, 0x66, 'var_1572', 'Complete Quest gold');
    const newBody = findBodyWithProperty(abc, ctx.body, NEW_QUEST_FLOATER);
    const completeBody = findBodyWithProperty(abc, ctx.body, COMPLETE_QUEST_FLOATER);
    const hasGuard = (body: typeof newBody): boolean => {
        if (titleIndex < 0) {
            return false;
        }
        const code = ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
        const instructions = disassemble(code, `popup-metadata-${body.methodIdx}`);
        return instructions.some((instruction) =>
            instruction.opcode === 0x2c && instruction.operands[0]?.[1] === titleIndex
        ) && instructions.some((instruction) =>
            instruction.opcode === 0x25 && instruction.operands[0]?.[1] === CLEAR_THE_BANDITS_EXP
        ) && instructions.some((instruction) =>
            instruction.opcode === 0x25 && instruction.operands[0]?.[1] === CLEAR_THE_BANDITS_GOLD
        ) && instructions.some((instruction) =>
            instruction.opcode === 0x61 && instruction.operands[0]?.[1] === expOperand
        ) && instructions.some((instruction) =>
            instruction.opcode === 0x61 && instruction.operands[0]?.[1] === goldOperand
        );
    };
    return { ctx, abc, titleIndex, expOperand, goldOperand, newBody, completeBody, hasGuard };
}

function verifyBranchTargets(code: Buffer, label: string): void {
    const instructions = disassemble(code, label);
    const offsets = new Set(instructions.map((instruction) => instruction.offset));
    offsets.add(code.length);
    for (const instruction of instructions) {
        for (const operand of instruction.operands) {
            if (operand[0] !== 's24') {
                continue;
            }
            const target = instruction.offset + instruction.size + operand[1];
            if (!offsets.has(target)) {
                throw new PatchError(`${label} has an invalid branch from ${instruction.offset} to ${target}.`);
            }
        }
    }
}

function verifySwf(swfPath: string): void {
    const state = popupMetadataState(swfPath);
    if (!state.hasGuard(state.newBody) || !state.hasGuard(state.completeBody)) {
        throw new PatchError(`${path.basename(swfPath)} is missing Clear the bandits popup metadata.`);
    }
    for (const [label, body] of [
        ['New Quest handler', state.newBody],
        ['Complete Quest handler', state.completeBody]
    ] as const) {
        const code = state.ctx.body.subarray(body.codeStart, body.codeStart + body.codeLen);
        verifyBranchTargets(code, label);
    }
    const constructor = findNewQuestConstructor(swfPath);
    const constructorCode = constructor.ctx.body.subarray(
        constructor.body.codeStart,
        constructor.body.codeStart + constructor.body.codeLen
    );
    if (disassemble(constructorCode, 'New Quest constructor verify').some((instruction) =>
        instruction.opcode === 0x2c && constructor.abc.stringValues[instruction.operands[0]?.[1] ?? -1] === CLEAR_THE_BANDITS_TITLE
    )) {
        throw new PatchError('The legacy New Quest constructor fallback is still active.');
    }
    console.log(`${path.basename(swfPath)} Clear the bandits popup title/reward verify ok.`);
}

function patchSwf(swfPath: string): void {
    removeLegacyTitleFallback(swfPath);
    const state = popupMetadataState(swfPath);
    if (state.hasGuard(state.newBody) && state.hasGuard(state.completeBody)) {
        console.log(`${path.basename(swfPath)} already has Clear the bandits popup metadata.`);
        return;
    }
    if (state.hasGuard(state.newBody) || state.hasGuard(state.completeBody)) {
        throw new PatchError('Only one Clear the bandits popup handler is patched; refusing a partial rewrite.');
    }
    if (state.newBody.exceptionCount !== 0 || state.completeBody.exceptionCount !== 0) {
        throw new PatchError('A quest popup handler has an unexpected exception table.');
    }

    const titleIndex = state.titleIndex >= 0 ? state.titleIndex : state.abc.stringValues.length;
    const newCode = state.ctx.body.subarray(
        state.newBody.codeStart,
        state.newBody.codeStart + state.newBody.codeLen
    );
    const completeCode = state.ctx.body.subarray(
        state.completeBody.codeStart,
        state.completeBody.codeStart + state.completeBody.codeLen
    );
    const titleBody = findTraitBody(state.abc, 'class_65', 'OnRefreshScreen');
    const titleCode = state.ctx.body.subarray(titleBody.codeStart, titleBody.codeStart + titleBody.codeLen);
    const multinames = {
        missionId: findUniqueOperand(completeCode, state.abc.multinameNames, 0x66, 'missionID', 'Complete Quest handler'),
        displayName: findUniqueOperand(titleCode, state.abc.multinameNames, 0x66, 'displayName', 'New Quest title'),
        exp: state.expOperand,
        gold: state.goldOperand
    };
    const newOffset = findFloaterInsertionOffset(newCode, state.abc.multinameNames, NEW_QUEST_FLOATER);
    const completeOffset = findFloaterInsertionOffset(
        completeCode,
        state.abc.multinameNames,
        COMPLETE_QUEST_FLOATER
    );
    const newGuard = buildMissionMetadataGuard(newOffset, 3, titleIndex, multinames);
    const completeGuard = buildMissionMetadataGuard(completeOffset, 4, titleIndex, multinames);
    const patches: BytePatch[] = [];
    if (state.titleIndex < 0) {
        patches.push({
            key: 'popup-title-string-count',
            start: state.abc.stringCountPos,
            end: state.abc.stringCountEnd,
            data: writeU30(state.abc.stringValues.length + 1),
            detail: 'reserve the Clear the bandits popup title'
        }, {
            key: 'popup-title-string',
            start: state.abc.stringPoolEnd,
            end: state.abc.stringPoolEnd,
            data: encodeString(CLEAR_THE_BANDITS_TITLE),
            detail: 'add the Clear the bandits popup title'
        });
    }
    for (const [key, body, code, offset, guard] of [
        ['new-quest', state.newBody, newCode, newOffset, newGuard],
        ['complete-quest', state.completeBody, completeCode, completeOffset, completeGuard]
    ] as const) {
        patches.push({
            key: `${key}-code-length`,
            start: body.codeLenPos,
            end: body.codeStart,
            data: writeU30(body.codeLen + guard.length),
            detail: `update the ${key} handler code length`
        }, {
            key: `${key}-popup-metadata`,
            start: body.codeStart + offset,
            end: body.codeStart + offset,
            data: guard,
            detail: `populate Clear the bandits ${key} title and rewards`
        }, ...branchAdjustmentPatches(body, code, offset, offset, guard.length, key));
    }

    ensureBackup(swfPath);
    const patched = applyPatchesToBody(state.ctx.body, patches);
    writeSwf(state.ctx, patched.body, patched.delta);
    verifySwf(swfPath);
    console.log(`${path.basename(swfPath)} patched with Clear the bandits popup title/rewards.`);
}

function syncClientRevision(swfPath: string, verifyOnly: boolean): void {
    // sha1, not sha256: StaticServer.clientRevision derives the token browsers actually get with
    // sha1, and every other patch that writes this literal uses sha1 too. Hashing differently here
    // meant these three could never agree with the rest -- whoever synced last won and the others
    // failed verification forever, on any SWF change.
    const digest = crypto.createHash('sha1').update(fs.readFileSync(swfPath)).digest('hex').slice(0, 12);
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
    syncClientRevision(swfPath, true);
} else {
    patchSwf(swfPath);
    syncClientRevision(swfPath, false);
}
