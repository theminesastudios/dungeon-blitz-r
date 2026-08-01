/// <reference types="node" />

import { strict as assert } from 'assert';
import { CombatHandler } from '../handlers/CombatHandler';
import { MasterClassID } from '../core/Enums';

// Soulthieft is the Soulthief discipline passive: a hit carries a share of whatever the
// target's health pool is, so bigger enemies lose more per strike.
//
// It has to be resolved server-side. The bonus reads the target's max HP at the moment of
// the hit, and no buff property the client understands can express that -- BleedMultiplier,
// BoundMultiplier, MeleeDamage and the rest all scale the attacker's own numbers.
const bonusOf = (CombatHandler as any).getSoulthieftMaxHpBonus.bind(CombatHandler);

function soulthief(): any {
    return { character: { name: 'AlexMercer', MasterClass: MasterClassID.Soulthief } };
}

function executioner(): any {
    return { character: { name: 'AlexMercer', MasterClass: MasterClassID.Executioner } };
}

function testBonusScalesWithTargetHealthPool(): void {
    // 1% of a 100k pool is 1000, and the 4000 hit leaves plenty of headroom under the cap.
    assert.equal(bonusOf(soulthief(), { maxHp: 100_000 }, 4000), 1000);
    // Same hit, bigger enemy, bigger bite -- the whole point of the passive.
    assert.equal(bonusOf(soulthief(), { maxHp: 200_000 }, 4000), 2000);
}

// Without a cap the passive scales with the health pool, which is backwards for exactly the
// bosses that have the largest pools.
function testBonusNeverMoreThanDoublesTheHit(): void {
    assert.equal(bonusOf(soulthief(), { maxHp: 500_000 }, 1000), 1000);
    assert.equal(bonusOf(soulthief(), { maxHp: 1_000_000 }, 250), 250);
}

function testOnlySoulthievesGetIt(): void {
    assert.equal(bonusOf(executioner(), { maxHp: 100_000 }, 4000), 0);
    assert.equal(bonusOf({ character: { name: 'x' } }, { maxHp: 100_000 }, 4000), 0);
    assert.equal(bonusOf(null, { maxHp: 100_000 }, 4000), 0);
}

// A miss, a zero-damage utility hit, or a target the server has no health for must not
// invent damage out of the passive.
function testDegenerateInputsAddNothing(): void {
    assert.equal(bonusOf(soulthief(), { maxHp: 100_000 }, 0), 0);
    assert.equal(bonusOf(soulthief(), { maxHp: 0 }, 4000), 0);
    assert.equal(bonusOf(soulthief(), {}, 4000), 0);
    assert.equal(bonusOf(soulthief(), { maxHp: NaN }, 4000), 0);
    assert.equal(bonusOf(soulthief(), { maxHp: 100_000 }, -50), 0);
}

function run(): void {
    testBonusScalesWithTargetHealthPool();
    testBonusNeverMoreThanDoublesTheHit();
    testOnlySoulthievesGetIt();
    testDegenerateInputsAddNothing();
    console.log('soulthieft_max_hp_passive_regression: ok');
}

run();
