/// <reference types="node" />

import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import { CastRateAuthority } from '../core/CastRateAuthority';

/*
 * A Cheat Engine speedhack inflates getTimer(), which is the clock the client gates its own
 * casting on -- both the "one animation at a time" rule (CombatState:1666) and every power
 * cooldown (`var_114[powerID] = mTimeThisTick + coolDownTime`). Everything the player casts
 * then arrives two to ten times faster, and the server used to relay all of it and apply
 * the damage that followed.
 *
 * The half of this that matters is the false positives. Refusing an honest cast means an
 * ability that silently does nothing, so most of what follows is honest rotations that must
 * survive untouched.
 *
 * Real power IDs, so the PlayerPowerTypes.xml parse is under test too:
 *   28  Cleave       castTime "400,100,100,100,100"  no cooldown  -- the melee combo
 *   284 Fury1        instant, 10s cooldown
 *   289 PainEater1   instant, 15s cooldown
 *   329 ShieldFlurry instant, 0.1s cooldown -- the fastest legitimate repeat in the game
 */

const CLEAVE = 28;
const FURY = 284;
const PAIN_EATER = 289;
const SHIELD_FLURRY = 329;
const END_SENTINEL_FORM = 448;
const SENTINEL_FORM_1 = 455;
const SENTINEL_FORM_10 = 464;
const SENTINEL_FORM_MELEE_1 = 465;
const SENTINEL_FORM_MELEE_COMBO_1 = 472;
const SENTINEL_FORM_RANGED_1 = 479;

function createClient(): any {
    return {
        userId: 4_040,
        currentLevel: 'CraftTown',
        character: { name: 'Smith' },
        castRate: CastRateAuthority.createState()
    };
}

/** One melee combo: the opening swing, then four fast follow-ups. */
const MELEE_COMBO_GAPS_MS = [400, 100, 100, 100, 100];

function assertLoaded(): void {
    assert.equal(
        CastRateAuthority.isDisabled(),
        false,
        'PlayerPowerTypes.xml must be readable from the server, or nothing here is being tested'
    );
}

// Five minutes of uninterrupted melee at exactly the speed the animations allow.
function testHonestMeleeComboNeverRefused(): void {
    const client = createClient();
    let now = 1_000_000;

    for (let combo = 0; combo < 300; combo += 1) {
        for (const gap of MELEE_COMBO_GAPS_MS) {
            now += gap;
            assert.ok(
                CastRateAuthority.chargeCast(client, CLEAVE, now),
                `honest melee combo refused at t=${now}`
            );
        }
    }
    assert.equal(client.castRate.violations, 0, 'honest melee must not score a single violation');
}

/*
 * The case that kills a naive shared budget: cooldowns run in parallel, so two abilities on
 * ten- and fifteen-second cooldowns can legitimately fire in the same second, over and over.
 * Charging their cooldowns to one budget would refuse this.
 */
function testHonestAbilityRotationNeverRefused(): void {
    const client = createClient();
    let now = 1_000_000;

    for (let cycle = 0; cycle < 20; cycle += 1) {
        assert.ok(CastRateAuthority.chargeCast(client, FURY, now), `Fury refused on cycle ${cycle}`);
        assert.ok(CastRateAuthority.chargeCast(client, PAIN_EATER, now + 200), `PainEater refused on cycle ${cycle}`);
        // Both are off cooldown again well before the next cycle.
        now += 20_000;
    }
    assert.equal(client.castRate.violations, 0, 'an honest ability rotation must not score a violation');
}

// ShieldFlurry is the fastest legitimate repeat there is: a 100ms cooldown, spammed.
function testFastestLegitimateSpamSurvives(): void {
    const client = createClient();
    let now = 1_000_000;

    for (let cast = 0; cast < 200; cast += 1) {
        now += 100;
        assert.ok(
            CastRateAuthority.chargeCast(client, SHIELD_FLURRY, now),
            `ShieldFlurry at its authored 100ms cooldown refused at t=${now}`
        );
    }
    assert.equal(client.castRate.violations, 0, 'the fastest authored repeat in the game must not score a violation');
}

// The same combo through a 5x speedhack. The burst credit covers the opening, then it stops.
function testSpeedhackedMeleeIsRefused(): void {
    const client = createClient();
    let now = 1_000_000;
    let accepted = 0;
    let refused = 0;

    for (let combo = 0; combo < 60; combo += 1) {
        for (const gap of MELEE_COMBO_GAPS_MS) {
            now += Math.round(gap / 5);
            if (CastRateAuthority.chargeCast(client, CLEAVE, now)) {
                accepted += 1;
            } else {
                refused += 1;
            }
        }
    }

    // An honest combo is five casts per 800ms, so 6.25/s. This run attempts 31/s.
    const elapsedSeconds = (now - 1_000_000) / 1000;
    const acceptedPerSecond = accepted / elapsedSeconds;
    assert.ok(refused > accepted, 'most of a 5x speedhack must be refused');
    assert.ok(
        acceptedPerSecond < 14,
        `a speedhack must be clamped near the honest melee rate, got ${acceptedPerSecond.toFixed(1)} casts/s`
    );
    // The tolerance is deliberately half, so what gets through is capped at twice honest
    // rather than driven to it. Tightening TOLERANCE is what closes the rest.
    assert.ok(
        acceptedPerSecond > 6,
        'the clamp should be the honest ceiling, not a lockout -- something is over-refusing'
    );
}

// A cooldown that has not really elapsed, because only the cheater's clock says so.
function testSpeedhackedCooldownIsRefused(): void {
    const client = createClient();
    const now = 1_000_000;

    assert.ok(CastRateAuthority.chargeCast(client, FURY, now), 'the first cast is always fine');
    assert.equal(
        CastRateAuthority.chargeCast(client, FURY, now + 2_000),
        false,
        'a 10s cooldown recast after 2s is a five-times clock, not a rotation'
    );
    assert.ok(
        CastRateAuthority.chargeCast(client, FURY, now + 10_000),
        'the same power must come back once the cooldown has honestly passed'
    );
}

/*
 * Refusing the cast is only half of it. 0x0A carries its own damage number and the server
 * applies it, so the hits from a refused cast have to be dropped too, and only for as long
 * as that cast would have been in flight.
 */
function testRefusedCastAlsoDropsItsHits(): void {
    const client = createClient();
    const now = 1_000_000;

    CastRateAuthority.chargeCast(client, FURY, now);
    assert.equal(
        CastRateAuthority.isHitBlocked(client, FURY, now),
        false,
        'an accepted cast must let its damage through'
    );

    CastRateAuthority.chargeCast(client, FURY, now + 2_000);
    assert.ok(
        CastRateAuthority.isHitBlocked(client, FURY, now + 2_000),
        'the damage from a refused cast must be dropped with it'
    );
    assert.equal(
        CastRateAuthority.isHitBlocked(client, CLEAVE, now + 2_000),
        false,
        'refusing one power must not block another'
    );
    assert.equal(
        CastRateAuthority.isHitBlocked(client, FURY, now + 3_100),
        false,
        'the block must expire with the cast it belonged to'
    );
}

/*
 * Sentinel Form is the exception to "the cooldown starts at the cast": the form has no
 * Duration and outlives its own 30s cooldown, so the lockout is re-stamped when the form ends.
 * A client that skips its half of that gets a tank stance with no downtime at all, which is
 * why the server keeps its own copy.
 *
 * The lockout is charged by the ENERGY the form spent, not by the time it was up: the form only
 * drains the mana bar when a swing lands (SFMelee/SFMeleeCombo/SFRanged each author a ManaCost),
 * so wall-clock time would over-charge a Sentinel who spends most of the form idle. Each swing
 * adds its ManaCost to the running total; the exit converts it at 300ms per point of energy, so
 * a full 100-point bar drained is the 30-second budget, floored at 10 seconds so a tap cannot be
 * spammed. The authority then applies its standard 50% tolerance -- the client presents the exact
 * client-side cooldown and an honest client is never refused.
 *
 *   447 SentinelForm    448 EndSentinelForm    455-464 SentinelForm1..10
 *   465 SFMelee1 (5 mana)    472 SFMeleeCombo1 (5 mana)    479 SFRanged1 (5 mana)
 */

/** Enter the form, swing `swings` times at 200ms gaps, then leave at `exitedAt`. */
function runSentinelFormUse(swings: number, exitedAt: number): any {
    const client = createClient();
    const now = 1_000_000;
    assert.ok(CastRateAuthority.chargeCast(client, SENTINEL_FORM_10, now), 'entering the form must be allowed');
    for (let swing = 0; swing < swings; swing += 1) {
        assert.ok(
            CastRateAuthority.chargeCast(client, SENTINEL_FORM_MELEE_1, now + 200 * (swing + 1)),
            `form swing ${swing} must be allowed`
        );
    }
    assert.ok(CastRateAuthority.chargeCast(client, END_SENTINEL_FORM, exitedAt), 'cancelling must always be allowed');
    return client;
}

/*
 * A form that runs long enough to outlast its own cast-time cooldown -- the case that broke --
 * while draining more than a full energy bar (21 swings x 5 mana = 105 energy) must still come
 * out with the full 30-second lockout, capped at the energy budget.
 */
function testLongSentinelFormUseGetsFullCooldown(): void {
    const now = 1_000_000;
    // A form long enough to outlast its own cast-time cooldown -- the case that broke.
    const exitedAt = now + 120_000;
    const client = runSentinelFormUse(21, exitedAt);

    assert.equal(
        CastRateAuthority.chargeCast(client, SENTINEL_FORM_10, exitedAt + 1_000),
        false,
        're-entering the form one second after leaving it must be refused'
    );
    // The lockout covers every rank, because the server does not track which one is owned.
    assert.equal(
        CastRateAuthority.chargeCast(client, SENTINEL_FORM_1, exitedAt + 1_000),
        false,
        'claiming a different rank must not dodge the lockout'
    );
    assert.equal(
        CastRateAuthority.chargeCast(client, SENTINEL_FORM_10, exitedAt + 14_900),
        false,
        'a full-bar burn must still be refused just short of the full lockout'
    );
    assert.ok(
        CastRateAuthority.chargeCast(client, SENTINEL_FORM_10, exitedAt + 15_100),
        'the form must come back once the full lockout has run'
    );
}

/*
 * Ten swings at 5 mana each spend half the energy bar, so the exit cooldown is half the
 * 30-second budget. The authority applies its standard 50% tolerance, so 15 seconds of cooldown
 * is enforced as 7.5 seconds here; the client presents the exact 15-second cooldown.
 */
function testCancellingEarlyRefundsCooldownProportionally(): void {
    const now = 1_000_000;
    const exitedAt = now + 6_000;
    const client = runSentinelFormUse(10, exitedAt);

    assert.equal(
        CastRateAuthority.chargeCast(client, SENTINEL_FORM_10, exitedAt + 7_400),
        false,
        '50 energy spent in the form must not be ready before its proportional lockout'
    );
    assert.ok(
        CastRateAuthority.chargeCast(client, SENTINEL_FORM_10, exitedAt + 7_600),
        'an early-cancelled form must return after its energy-proportional lockout'
    );
}

/*
 * More energy spent means a longer wait: 16 swings x 5 mana = 80 energy -> 24 seconds client-side,
 * enforced as 12 seconds here. The swing count, not the time in the form, is what moves the number.
 */
function testLaterCancelProducesLongerCooldown(): void {
    const now = 1_000_000;
    const exitedAt = now + 24_000;
    const client = runSentinelFormUse(16, exitedAt);

    assert.equal(
        CastRateAuthority.chargeCast(client, SENTINEL_FORM_10, exitedAt + 11_900),
        false,
        'spending more energy in Sentinel Form must produce a proportionally longer cooldown'
    );
    assert.ok(
        CastRateAuthority.chargeCast(client, SENTINEL_FORM_10, exitedAt + 12_100),
        'the longer proportional cooldown must still end at the expected time'
    );
}

/*
 * Every kind of form attack feeds the same energy meter. Ten swings of each cost 50 energy and
 * must NOT trigger the old attack-penalty full lockout -- attacking in the form is what the
 * energy meter is for, so it shortens the wait relative to a no-attack full cooldown, not lengthens
 * it to a flat 30 seconds.
 */
function testAnySentinelFormAttackChargesEnergyCooldown(): void {
    for (const attack of [SENTINEL_FORM_MELEE_1, SENTINEL_FORM_MELEE_COMBO_1, SENTINEL_FORM_RANGED_1]) {
        const client = createClient();
        const now = 1_000_000;

        assert.ok(CastRateAuthority.chargeCast(client, SENTINEL_FORM_10, now));
        for (let swing = 0; swing < 10; swing += 1) {
            assert.ok(
                CastRateAuthority.chargeCast(client, attack, now + 200 * (swing + 1)),
                `Sentinel Form ${attack} swing must be allowed`
            );
        }
        const exitedAt = now + 6_000;
        assert.ok(CastRateAuthority.chargeCast(client, END_SENTINEL_FORM, exitedAt));

        assert.equal(
            CastRateAuthority.chargeCast(client, SENTINEL_FORM_10, exitedAt + 7_400),
            false,
            `Sentinel Form attack ${attack} must charge the energy-proportional cooldown`
        );
        assert.ok(
            CastRateAuthority.chargeCast(client, SENTINEL_FORM_10, exitedAt + 7_600),
            `the energy-proportional cooldown after ${attack} must eventually expire`
        );
    }
}

/*
 * An instant exit spends ~0 energy, so without a floor the transform could be re-entered for free
 * -- the spam the floor exists to stop. The ten-second floor is enforced as five seconds here.
 */
function testAttackFreeInstantExitStillCostsFloor(): void {
    const now = 1_000_000;
    const exitedAt = now + 1_000;
    const client = runSentinelFormUse(0, exitedAt);

    assert.equal(
        CastRateAuthority.chargeCast(client, SENTINEL_FORM_10, exitedAt + 4_900),
        false,
        'an attack-free instant exit must still pay the floor cooldown'
    );
    assert.ok(
        CastRateAuthority.chargeCast(client, SENTINEL_FORM_10, exitedAt + 5_100),
        'the floor cooldown must expire at the expected time'
    );
}

/*
 * An exit with no observed entry means the client skipped the re-stamp entirely -- treat it as a
 * full lockout, exactly as a form that burned the whole bar would earn.
 */
function testExitWithoutObservedEntryGetsFullLockout(): void {
    const client = createClient();
    const now = 1_000_000;
    const exitedAt = now + 1_000;
    assert.ok(CastRateAuthority.chargeCast(client, END_SENTINEL_FORM, exitedAt));

    assert.equal(
        CastRateAuthority.chargeCast(client, SENTINEL_FORM_10, exitedAt + 14_900),
        false,
        'an unobserved exit must not be re-enterable before the full lockout'
    );
    assert.ok(
        CastRateAuthority.chargeCast(client, SENTINEL_FORM_10, exitedAt + 15_100),
        'the full lockout after an unobserved exit must eventually expire'
    );
}

function main(): void {
    assertLoaded();
    testHonestMeleeComboNeverRefused();
    testHonestAbilityRotationNeverRefused();
    testFastestLegitimateSpamSurvives();
    testSpeedhackedMeleeIsRefused();
    testSpeedhackedCooldownIsRefused();
    testRefusedCastAlsoDropsItsHits();
    testLongSentinelFormUseGetsFullCooldown();
    testCancellingEarlyRefundsCooldownProportionally();
    testLaterCancelProducesLongerCooldown();
    testAnySentinelFormAttackChargesEnergyCooldown();
    testAttackFreeInstantExitStillCostsFloor();
    testExitWithoutObservedEntryGetsFullLockout();
    console.log('cast_rate_authority_regression: ok');
}

main();
