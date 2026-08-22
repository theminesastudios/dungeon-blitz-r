import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// A party viewer must not be sent damage it already applied itself.
//
// A power cast is relayed to the whole scope and every client simulates the hit on its own copy.
// The server-authority health broadcast allowed for that only on the ATTACKER's screen; every
// other member was sent the raw canonical delta on top of the hit they had already run, so their
// copy drained at twice the rate of the enemy the server was holding.
//
// Live proof, with only Telahair swinging:
//   dealt=79557  pool=161472
//   by=[Telahair:79557/79557 hits=7 | Lanorut:0/163230 hits=0]
//   packets=[Telahair:self=27/seen=40, Lanorut:self=0/seen=46]
// Lanorut never swung once and still took 163230 off his own copy -- two times 79557. His copy
// ran out at half the pool, his client announced the kill, and the enemy was buried at 49%.
// Solo runs were clean because solo there is no viewer.
//
// `convergePartySharedHostileHealthToParty` has always passed the same expected local delta for
// the source AND the viewers; this pins the server-authority path to the same rule.

const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'handlers', 'CombatHandler.ts'),
    'utf8'
);

function sliceBetween(from: string, to: string): string {
    const start = source.indexOf(from);
    assert.ok(start >= 0, `anchor not found: ${from}`);
    const end = source.indexOf(to, start);
    assert.ok(end > start, `end anchor not found after ${from}: ${to}`);
    return source.slice(start, end);
}

function testViewersGetTheSameAllowanceAsTheAttacker(): void {
    const body = sliceBetween(
        'const expectedLocalDamage = options.alreadyApplied',
        'const preHitSnapshot');
    assert.ok(
        body.includes('options.appliedByEveryViewer'),
        'a viewer that is not the attacker must still be credited with the hit it simulated itself'
    );
    assert.equal(
        /:\s*0;/.test(body),
        false,
        'crediting non-attacker viewers with zero is what doubled the damage on their screen'
    );
}

function testPowerHitPassesTheAllowance(): void {
    const call = sliceBetween("'powerhit',", 'convergedTokens: serverAuthorityNpcConvergedTokens');
    assert.ok(
        call.includes('appliedByEveryViewer'),
        'the power-hit broadcast must declare the damage every viewer already applied'
    );
    assert.ok(
        call.includes('resolution.appliedDamage'),
        'the allowance must be the damage actually applied to the canonical, not the requested amount'
    );
}

function testPartySharedPathStillAgreesOnBothSides(): void {
    // The rule this fix copies. If this ever regresses to a one-sided allowance, the two paths
    // have diverged again and the same bug is back on the other road.
    const call = sliceBetween(
        'partySharedHostileHealthRelay.snapshots,',
        ');');
    const deltaArgs = call.match(/-displayRelayDamage/g) ?? [];
    assert.equal(
        deltaArgs.length,
        2,
        'the party-shared path must keep expecting the hit on the source AND the viewer side'
    );
}

function main(): void {
    testViewersGetTheSameAllowanceAsTheAttacker();
    testPowerHitPassesTheAllowance();
    testPartySharedPathStillAgreesOnBothSides();
    console.log('party_viewer_double_damage_regression: ok');
}

main();
