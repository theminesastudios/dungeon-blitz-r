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
const bonusOf = (
    session: any,
    entity: any,
    damage: number,
    scope: string = 'NewbieRoad'
): number => (CombatHandler as any).getSoulthieftMaxHpBonus(session, entity, damage, scope);

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

// The bug this passive shipped with: it read entity.maxHp directly, and a client-spawned
// hostile never reports its health pool, so the field is empty on almost everything a rogue
// swings at and the passive quietly did nothing. The server's own resolver falls back to
// the EntTypes-derived pool, which is what makes it fire at all.
function testDerivesThePoolWhenTheEntityDoesNotCarryOne(): void {
    const derived = bonusOf(soulthief(), { name: 'GoblinDagger', hp: 4200 }, 4000, 'NewbieRoad');
    assert.ok(
        derived > 0,
        'a hostile without an explicit maxHp produced no Soulthieft bonus, which is the bug that shipped'
    );
}

// Sentinel's basic melee swing carries a slice of the wearer's own health pool. Unlike the
// weapon-data changes that ship with it, this one is genuinely Sentinel-only, because the
// server knows MasterClass where the shared weapon powers cannot.
const sentinelBonusOf = (session: any, powerId: number, damage: number): number =>
    (CombatHandler as any).getSentinelMaxHpBonus(session, powerId, damage);

function sentinel(maxHp: number): any {
    return {
        character: { name: 'MaxPally', MasterClass: MasterClassID.Sentinel },
        authoritativeMaxHp: maxHp
    };
}

const SWORD_MELEE = 3; // PlayerPowerTypes: SwordMelee
const SHIELD_FLURRY = 295; // any non-basic power id

function testSentinelBasicSwingCarriesHealthPool(): void {
    assert.equal(sentinelBonusOf(sentinel(60_000), SWORD_MELEE, 2000), 60);
    assert.equal(sentinelBonusOf(sentinel(120_000), SWORD_MELEE, 2000), 120);
}

function testSentinelBonusIsBasicMeleeOnly(): void {
    assert.equal(sentinelBonusOf(sentinel(60_000), SHIELD_FLURRY, 2000), 0);
}

function testSentinelBonusIsSentinelOnly(): void {
    const justicar = {
        character: { name: 'MaxPally', MasterClass: MasterClassID.Justicar },
        authoritativeMaxHp: 60_000
    };
    assert.equal(sentinelBonusOf(justicar, SWORD_MELEE, 2000), 0);
}

function run(): void {
    testSentinelBasicSwingCarriesHealthPool();
    testSentinelBonusIsBasicMeleeOnly();
    testSentinelBonusIsSentinelOnly();
    testDerivesThePoolWhenTheEntityDoesNotCarryOne();
    testBonusScalesWithTargetHealthPool();
    testBonusNeverMoreThanDoublesTheHit();
    testOnlySoulthievesGetIt();
    testDegenerateInputsAddNothing();
    console.log('soulthieft_max_hp_passive_regression: ok');
}

run();
