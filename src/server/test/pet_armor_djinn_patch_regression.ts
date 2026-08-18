/**
 * Regression tests for the #721 pet patch defects (issue "Falcon and Pixie pets
 * should inflict armor reduction... Djinn pets should do AoE damage after
 * duration"), fixed in the follow-up:
 *
 *  1. The shipped PetArmorBane mod was `level/200 - 0` (positive) instead of
 *     `0 - level/200`: AVM2 `subtract` computes second-popped minus top, so the
 *     zero has to be pushed before the division result. A positive buff feeds
 *     `damage *= (1 - buffedMeleeDefense)` and GRANTS the mob armor.
 *  2. The appended Djinn gate's `ifne` had s24 0, so both the branch and the
 *     fall-through landed on the jump into the explosion block: every pet
 *     exploded on expiry and skipped the normal despawn (pets usable once per
 *     area). The ifne must target the expiry-handled jump (+4).
 *
 * The tests execute the emitted AVM2 blocks with a small interpreter and assert
 * the actual values / branch targets, so a sign regression fails loudly.
 */
import { strict as assert } from 'assert';
import { disassemble, Instruction } from '../scripts/swfPatchUtils';
import { djinnAppendBlock, petArmorModBlock } from '../scripts/patch-dungeonblitz-pet-armor-djinn-explode';

// ---- tiny AVM2 interpreter for the emitted PetArmorBane mod block ----------

type StackValue = any;

interface MockEntity {
    [key: string]: any;
}

function runPetArmorBlock(level: number, legacy: boolean): number[] {
    const petArmorBaneStr = 1;
    const block = petArmorModBlock(petArmorBaneStr, legacy);
    const insts = disassemble(block, 'petArmorModBlock');
    const byOffset = new Map<number, Instruction>();
    for (const inst of insts) {
        byOffset.set(inst.offset, inst);
    }

    const pushedValues: number[] = [];
    // The Number-typed vector is the _eaValue one whose pushes we record; the
    // class_140-typed vector is _eaMods (the mod objects, not interesting here).
    const vector = (typeArg: unknown) => ({
        push: (value: number) => {
            if (Array.isArray(typeArg) && typeArg[0] === Number) {
                pushedValues.push(value);
            }
        },
    });
    const class140 = () => ({ modId: 1100, values: null as unknown });
    const summoner: MockEntity = { mEquipPet: { var_23: level } };
    const game = { GetEntFromID: () => summoner };
    const caster: MockEntity = { summonerId: 7 };
    const thisEnt: MockEntity = { var_1: game, var_3: caster };
    const buffType = { buffName: 'PetArmorBane' };

    const strings: string[] = ['', 'PetArmorBane'];
    const mn = new Map<number, string>([
        [1, 'var_1'],
        [9, 'Number'],
        [12, 'Vector'],
        [31, 'var_3'],
        [182, 'buffName'],
        [224, 'GetEntFromID'],
        [245, 'var_23'],
        [358, 'class_140'],
        [363, 'mEquipPet'],
        [399, 'summonerId'],
        [13127, 'push'],
    ]);
    const globals = new Map<string, unknown>([
        ['Vector', vector],
        ['Number', Number],
        ['class_140', class140],
    ]);

    const locals = new Map<number, StackValue>();
    locals.set(0, thisEnt);
    locals.set(52, buffType);
    const stack: StackValue[] = [];
    const pcAt = (offset: number): number => offset;

    let pc = 0;
    let guard = 0;
    while (pc < block.length && guard++ < 500) {
        const inst = byOffset.get(pc);
        assert.ok(inst, `no instruction at ${pc}`);
        const [kind0, v0] = inst.operands[0] ?? [];
        const s24 = (): number => {
            assert.equal(inst.operands[0][0], 's24', `expected s24 at ${pc}`);
            return inst.operands[0][1];
        };
        const branch = (targetRel: number): void => {
            pc = pcAt(inst.offset + inst.size + targetRel);
        };

        switch (inst.opcode) {
            case 0x10: // jump
                branch(s24());
                break;
            case 0x11: // iftrue
                if (stack.pop()) {
                    branch(s24());
                } else {
                    pc = pcAt(inst.offset + inst.size);
                }
                break;
            case 0x12: // iffalse
                if (!stack.pop()) {
                    branch(s24());
                } else {
                    pc = pcAt(inst.offset + inst.size);
                }
                break;
            case 0x14: // ifne
                {
                    const b = stack.pop();
                    const a = stack.pop();
                    if (a !== b) {
                        branch(s24());
                    } else {
                        pc = pcAt(inst.offset + inst.size);
                    }
                }
                break;
            case 0x24: // pushbyte
                stack.push(inst.operands[0][1]);
                pc = pcAt(inst.offset + inst.size);
                break;
            case 0x25: // pushshort
                stack.push(inst.operands[0][1]);
                pc = pcAt(inst.offset + inst.size);
                break;
            case 0x29: // pop
                stack.pop();
                pc = pcAt(inst.offset + inst.size);
                break;
            case 0x2a: // dup
                stack.push(stack[stack.length - 1]);
                pc = pcAt(inst.offset + inst.size);
                break;
            case 0x2c: // pushstring
                stack.push(strings[inst.operands[0][1]]);
                pc = pcAt(inst.offset + inst.size);
                break;
            case 0x42: // construct (single operand: arg count)
                {
                    const n = inst.operands[0][1];
                    const args = stack.splice(stack.length - n, n);
                    const obj = stack.pop(); // generic-instantiation object
                    const ctor = stack.pop();
                    stack.push((ctor as any)(obj, ...args));
                    pc = pcAt(inst.offset + inst.size);
                }
                break;
            case 0x46: // callproperty
                {
                    const name = mn.get(inst.operands[0][1])!;
                    const n = inst.operands[1][1];
                    const args = stack.splice(stack.length - n, n);
                    const receiver = stack.pop();
                    stack.push((receiver as any)[name](...args));
                    pc = pcAt(inst.offset + inst.size);
                }
                break;
            case 0x4a: // constructprop
                {
                    const n = inst.operands[1][1];
                    const args = stack.splice(stack.length - n, n);
                    const ctor = stack.pop();
                    stack.push((ctor as any)(...args));
                    pc = pcAt(inst.offset + inst.size);
                }
                break;
            case 0x4f: // callpropvoid
                {
                    const name = mn.get(inst.operands[0][1])!;
                    const n = inst.operands[1][1];
                    const args = stack.splice(stack.length - n, n);
                    const receiver = stack.pop();
                    (receiver as any)[name](...args);
                    pc = pcAt(inst.offset + inst.size);
                }
                break;
            case 0x53: // newarray
                {
                    const n = inst.operands[0][1];
                    const items = stack.splice(stack.length - n, n);
                    stack.push(items);
                    pc = pcAt(inst.offset + inst.size);
                }
                break;
            case 0x5d: // findpropstrict
                stack.push(globals.get(mn.get(inst.operands[0][1])!)!);
                pc = pcAt(inst.offset + inst.size);
                break;
            case 0x60: // getlex
                stack.push(globals.get(mn.get(inst.operands[0][1])!)!);
                pc = pcAt(inst.offset + inst.size);
                break;
            case 0x62: // getlocal
                stack.push(locals.get(inst.operands[0][1]));
                pc = pcAt(inst.offset + inst.size);
                break;
            case 0xd0: // getlocal0
            case 0xd1: // getlocal1
            case 0xd2: // getlocal2
            case 0xd3: // getlocal3
                stack.push(locals.get(inst.opcode - 0xd0));
                pc = pcAt(inst.offset + inst.size);
                break;
            case 0x63: // setlocal
                locals.set(inst.operands[0][1], stack.pop());
                pc = pcAt(inst.offset + inst.size);
                break;
            case 0x66: // getproperty
                {
                    const name = mn.get(inst.operands[0][1])!;
                    const obj = stack.pop();
                    stack.push(obj ? obj[name] : undefined);
                    pc = pcAt(inst.offset + inst.size);
                }
                break;
            case 0x80: // coerce
                pc = pcAt(inst.offset + inst.size);
                break;
            case 0xa1: // subtract
                {
                    const b = stack.pop();
                    const a = stack.pop();
                    stack.push(a - b);
                    pc = pcAt(inst.offset + inst.size);
                }
                break;
            case 0xa3: // divide
                {
                    const b = stack.pop();
                    const a = stack.pop();
                    stack.push(a / b);
                    pc = pcAt(inst.offset + inst.size);
                }
                break;
            default:
                assert.fail(`unhandled opcode 0x${inst.opcode.toString(16)} at ${pc}`);
        }
    }
    assert.ok(guard < 500, 'interpreter did not terminate');
    return pushedValues;
}

function verifyPetArmorSign(): void {
    // The fixed block must shred armor: 0 - level/200, i.e. 0.5% at level 1 and
    // 10% at level 20 -- both negative.
    assert.deepEqual(runPetArmorBlock(1, false), [-1 / 200, -1 / 200], 'level 1 must push -0.005 for both properties');
    assert.deepEqual(runPetArmorBlock(20, false), [-20 / 200, -20 / 200], 'level 20 must push -0.1 for both properties');

    // The legacy block reproduces the shipped bug: positive values that grant armor.
    assert.deepEqual(runPetArmorBlock(10, true), [10 / 200, 10 / 200], 'legacy block must still push +level/200');

    // Fixed and legacy must be the same length so the in-place upgrade is a
    // same-size splice.
    assert.equal(petArmorModBlock(1).length, petArmorModBlock(1, true).length, 'block lengths must match for same-size splice');
}

function verifyDjinnGateBranches(): void {
    const block = djinnAppendBlock();
    const legacy = djinnAppendBlock(true);
    assert.equal(block.length, 26, 'append block must be 26 bytes');
    assert.equal(block.length, legacy.length, 'legacy append must be same length');

    const insts = disassemble(block, 'djinnAppendBlock');
    const blockStart = 2150; // the block is appended at codeLen in the method body

    const ifne = insts.find((i) => i.opcode === 0x14);
    assert.ok(ifne, 'append must contain the ifne');
    assert.equal(ifne.operands[0][0], 's24');
    assert.equal(ifne.operands[0][1], 4, 'ifne must target +4 (the expiry-handled jump at 2172)');
    assert.equal(blockStart + ifne.offset + ifne.size + ifne.operands[0][1], 2172, 'non-Djinns must route to expiry handled');

    const jumps = insts.filter((i) => i.opcode === 0x10);
    assert.equal(jumps.length, 2, 'append must contain the two jumps');
    const targets = jumps.map((j) => blockStart + j.offset + j.size + j.operands[0][1]).sort((x, y) => x - y);
    assert.deepEqual(targets, [1748, 1942], 'jumps must land on the explosion block and expiry handled');

    // The legacy block's ifne lands on its own fall-through (the explosion jump),
    // which is the shipped bug.
    const legacyIfne = disassemble(legacy, 'djinnAppendBlock').find((i) => i.opcode === 0x14)!;
    assert.equal(legacyIfne.operands[0][1], 0, 'legacy ifne must reproduce the shipped s24 0');
}

function main(): void {
    verifyPetArmorSign();
    verifyDjinnGateBranches();
    console.log('pet_armor_djinn_patch_regression: ok');
}

main();
