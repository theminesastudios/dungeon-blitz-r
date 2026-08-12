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

// Sentinel's melee swing carries a slice of the wearer's own health pool. The powers it rides
// are the Paladin weapon melee attacks, shared by all three disciplines -- which is why this
// is server-side: the server knows MasterClass where the shared weapon data cannot.
const sentinelBonusOf = (session: any, powerId: number, damage: number): number =>
    (CombatHandler as any).getSentinelMaxHpBonus(session, powerId, damage);

function sentinel(maxHp: number, armorClass: number = 0): any {
    return {
        character: { name: 'MaxPally', MasterClass: MasterClassID.Sentinel },
        authoritativeMaxHp: maxHp,
        authoritativeArmorClass: armorClass
    };
}

// PlayerPowerTypes: the Paladin weapon melee attacks, plus the Sentinel Form swing.
const SWORD_MELEE = 3;
const MACE_MELEE = 2;
const AXE_MELEE = 4;
const PUNCH_MELEE = 1;
const SF_MELEE_1 = 465;
const SF_MELEE_COMBO_1 = 472;
// The discipline's *ranged* attack, which is where the passive used to live (issue #670), and
// any other non-basic power.
const CONCUSSION_BOLT = 316;
const SHIELD_FLURRY = 329;

// 0.3% of max HP. Sized against the client's own stat tables: a level-50 Paladin runs about
// 122k max HP and 1,680 Defense against a 5,264 basic swing, so the two terms together are
// about 17% of a swing. The rates the issue opened with came to 14 damage.
function testSentinelMeleeCarriesHealthPool(): void {
    assert.equal(sentinelBonusOf(sentinel(60_000), SWORD_MELEE, 2000), 180);
    assert.equal(sentinelBonusOf(sentinel(120_000), SWORD_MELEE, 2000), 360);
    for (const powerId of [MACE_MELEE, AXE_MELEE, PUNCH_MELEE, SF_MELEE_1, SF_MELEE_COMBO_1]) {
        assert.equal(sentinelBonusOf(sentinel(60_000), powerId, 2000), 180, `power ${powerId} must carry the passive`);
    }
}

// Defense is the larger term despite being much the smaller stat -- stacking Defense has to
// out-damage stacking raw Health, or the passive does not say what the discipline is.
function testDefenseOutweighsHealthOnARealisticBuild(): void {
    const level50 = sentinelBonusOf(sentinel(122_596, 1680), SWORD_MELEE, 5264);
    assert.equal(level50, 368 + 504);
    assert.ok(504 > 368, 'the Defense term must be the larger of the two');
    assert.ok(level50 / 5264 > 0.1 && level50 / 5264 < 0.25, `expected 10-25% of a swing, got ${level50}`);
}

// The Defense half. It reads the client-declared armorClass that
// patch-dungeonblitz-combat-stats-armor appends to packet 0xFC.
function testSentinelMeleeCarriesDefense(): void {
    assert.equal(sentinelBonusOf(sentinel(60_000, 3000), SWORD_MELEE, 2000), 180 + 900);
    assert.equal(sentinelBonusOf(sentinel(0, 3000), SWORD_MELEE, 2000), 900);
}

// A client whose cached SWF predates the packet change sends no Defense at all. The Health
// half must still land rather than the whole passive going quiet.
function testSentinelPassiveSurvivesAnUnpatchedClient(): void {
    const stale = sentinel(60_000);
    delete stale.authoritativeArmorClass;
    assert.equal(sentinelBonusOf(stale, SWORD_MELEE, 2000), 180);
}

// The bolt is the bug this issue reported: a melee discipline's passive was firing on its
// ranged attack and nothing else.
function testSentinelBonusIsMeleeOnly(): void {
    assert.equal(sentinelBonusOf(sentinel(60_000), CONCUSSION_BOLT, 2000), 0);
    assert.equal(sentinelBonusOf(sentinel(60_000), SHIELD_FLURRY, 2000), 0);
}

function testSentinelBonusIsSentinelOnly(): void {
    const justicar = {
        character: { name: 'MaxPally', MasterClass: MasterClassID.Justicar },
        authoritativeMaxHp: 60_000
    };
    assert.equal(sentinelBonusOf(justicar, SWORD_MELEE, 2000), 0);
}

// Justicar: a tenth of Expertise added to Attack, expressed as a share of the hit because
// Attack is not a stat the server owns. 10% of 4000 Expertise against 2000 Attack is a fifth
// more Attack, so a 1000 hit lands 200 more.
const justicarBonusOf = (session: any, entity: any, damage: number): number =>
    (CombatHandler as any).getJusticarExpertiseBonus(session, entity, damage);

function justicar(): any {
    return { character: { name: 'MaxPally', MasterClass: MasterClassID.Justicar }, clientEntID: 0, entities: new Map() };
}

function testJusticarScalesTheHitByExpertise(): void {
    assert.equal(justicarBonusOf(justicar(), { meleeDamage: 2000, magicDamage: 4000 }, 1000), 200);
    assert.equal(justicarBonusOf(justicar(), { meleeDamage: 2000, magicDamage: 2000 }, 1000), 100);
    // Read off the session's own entity when the hit site has no level copy of the player.
    const session = justicar();
    session.clientEntID = 7;
    session.entities.set(7, { meleeDamage: 2000, magicDamage: 4000 });
    assert.equal(justicarBonusOf(session, null, 1000), 200);
}

function testJusticarBonusIsJusticarOnly(): void {
    assert.equal(justicarBonusOf(sentinel(60_000), { meleeDamage: 2000, magicDamage: 4000 }, 1000), 0);
    assert.equal(justicarBonusOf(null, { meleeDamage: 2000, magicDamage: 4000 }, 1000), 0);
}

// A player who has not reported stats yet must not have their hits zeroed or blown up by a
// division against nothing.
function testJusticarDegenerateStatsAddNothing(): void {
    assert.equal(justicarBonusOf(justicar(), { meleeDamage: 0, magicDamage: 4000 }, 1000), 0);
    assert.equal(justicarBonusOf(justicar(), { meleeDamage: 2000, magicDamage: 0 }, 1000), 0);
    assert.equal(justicarBonusOf(justicar(), {}, 1000), 0);
    assert.equal(justicarBonusOf(justicar(), { meleeDamage: 2000, magicDamage: 4000 }, 0), 0);
}

function run(): void {
    testSentinelMeleeCarriesHealthPool();
    testSentinelMeleeCarriesDefense();
    testDefenseOutweighsHealthOnARealisticBuild();
    testSentinelPassiveSurvivesAnUnpatchedClient();
    testSentinelBonusIsMeleeOnly();
    testSentinelBonusIsSentinelOnly();
    testJusticarScalesTheHitByExpertise();
    testJusticarBonusIsJusticarOnly();
    testJusticarDegenerateStatsAddNothing();
    testDerivesThePoolWhenTheEntityDoesNotCarryOne();
    testBonusScalesWithTargetHealthPool();
    testBonusNeverMoreThanDoublesTheHit();
    testOnlySoulthievesGetIt();
    testDegenerateInputsAddNothing();
    console.log('soulthieft_max_hp_passive_regression: ok');
}

run();
