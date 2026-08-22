import { strict as assert } from 'assert';
import { CombatHandler } from '../handlers/CombatHandler';

// A client announcing a kill is only believed when the server's own enemy is nearly finished.
//
// Three doors accept a client-reported kill: the destroy in `handleEntityDestroy`, the lethal HP
// report in `recordClientHostileHpDelta`, and the incremental defeat-state report in
// `LevelHandler`. The first two asked for the canonical to be at or below HALF -- the middle of an
// ordinary fight -- and the third asked for nothing at all. So any client whose own copy ran out
// early buried the enemy for everybody: live, `dealt=64229` against a `pool=161472`, and
// `dealt=72728` against `pool=134560`, with the bar visibly part-full on the other screen.
//
// The shared fraction is the guard. It has to stay above the largest legitimate remainder on
// record (5072/26912 = 18.8%) and well below the middle of a fight.

function main(): void {
    const fraction = CombatHandler.CLIENT_REPORTED_KILL_MAX_REMAINDER_FRACTION;

    assert.ok(
        fraction > 0.188,
        'the guard must still accept the largest genuine end-of-fight remainder on record (5072/26912)'
    );
    assert.ok(
        fraction < 0.5,
        'half a pool is the middle of a fight, never corroboration of a kill'
    );

    // The two live burials this exists to refuse.
    const refusedCases = [
        { dealt: 64229, pool: 161472, name: 'GreaterDemonMaligner' },
        { dealt: 72728, pool: 134560, name: 'ImperialMagus' },
        { dealt: 20141, pool: 26912, name: 'BoneFiend' }
    ];
    for (const testCase of refusedCases) {
        const remainder = testCase.pool - testCase.dealt;
        const allowed = Math.max(1, Math.round(testCase.pool * fraction));
        assert.ok(
            remainder > allowed,
            `${testCase.name}: a burial with ${remainder}/${testCase.pool} left must be refused`
        );
    }

    // The end-of-fight reports the doors exist for must still be accepted.
    const acceptedCases = [
        { remainder: 3483, pool: 26912 },
        { remainder: 5072, pool: 26912 },
        { remainder: 89, pool: 6076 }
    ];
    for (const testCase of acceptedCases) {
        const allowed = Math.max(1, Math.round(testCase.pool * fraction));
        assert.ok(
            testCase.remainder <= allowed,
            `a genuine kill with ${testCase.remainder}/${testCase.pool} left must still be accepted`
        );
    }

    console.log('client_reported_kill_remainder_regression: ok');
}

main();
