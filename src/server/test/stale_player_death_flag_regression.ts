import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';

// A living player must not drop into the death pose on a party member's screen.
//
// `updatePlayerTargetAfterHit` answered `killed: true` whenever the target's stored body already
// carried the dead flag. `killed` is what makes `handlePowerHit` broadcast `EntityState.DEAD`, so
// once that flag went stale -- the player revived on their own screen and nothing cleared the
// server's copy -- every subsequent hit re-broadcast the death. On the other member's screen the
// player lay in the death pose with a full health bar on their own. Reported from The East Wing,
// with the victim at 46957/68109.
//
// Two rules come out of that and both are pinned here:
//   1. `killed` means "this hit killed them", never "they were already dead".
//   2. A dead flag contradicted by the client's own reported health is stale, and is cleared.

const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'handlers', 'CombatHandler.ts'),
    'utf8'
);

const body = (() => {
    const start = source.indexOf('private static updatePlayerTargetAfterHit');
    assert.ok(start >= 0, 'updatePlayerTargetAfterHit not found');
    const end = source.indexOf('const requestedDamage', start);
    assert.ok(end > start, 'end of the early-exit section not found');
    return source.slice(start, end);
})();

function testAlreadyDeadIsNeverReportedAsAKill(): void {
    // Every early return in the section before damage is applied describes a target that was
    // already down. None of them may claim the hit killed anyone.
    const killedAnswers = body.match(/killed:\s*[^,\n]+/g) ?? [];
    assert.ok(killedAnswers.length >= 2, 'expected the early exits to still be there');
    for (const answer of killedAnswers) {
        assert.ok(
            /killed:\s*false/.test(answer),
            `an early exit still reports a kill: "${answer.trim()}" -- this re-broadcasts EntityState.DEAD on every hit`
        );
    }
}

function testStaleDeathFlagIsCleared(): void {
    assert.ok(
        body.includes('authoritativeCurrentHp'),
        'a dead flag must be checked against the health the client itself reports'
    );
    assert.ok(
        /body\.dead\s*=\s*false/.test(body),
        'a dead flag contradicted by live health must be cleared, not just ignored'
    );
}


// Clearing the flag on the server is only half of it: death was broadcast, so coming back must
// be broadcast too. An HP delta cannot move a body out of the death animation.
function testRevivalIsAnnouncedToTheParty(): void {
    assert.ok(
        source.includes('announcePlayerRevivedIfWasDead'),
        'a player coming back from a dead-flagged body must be announced to the other screens'
    );
    const helper = source.slice(source.indexOf('private static announcePlayerRevivedIfWasDead'));
    assert.ok(
        helper.slice(0, 2200).includes('EntityState.ACTIVE'),
        'the revival announcement must send an ACTIVE state, the only packet that changes the pose'
    );
    // Unfiltered, for the same reason the death drain is: a screen holding the corpse is exactly
    // the screen the usual filters refuse to address.
    assert.ok(
        helper.slice(0, 2200).includes('getSessionsInLevelScope'),
        'the revival must reach every session in the scope, not go through the filtered broadcast'
    );
    const callSites = (source.match(/announcePlayerRevivedIfWasDead\(/g) || []).length;
    assert.ok(
        callSites >= 4,
        `every path that clears a death flag must announce it (found ${callSites} references)`
    );
}

// A death state may never contradict the health the server is holding.
function testDeathStateIsRefusedForALivingPlayer(): void {
    const guard = source.slice(source.indexOf('private static broadcastPlayerState'));
    const head = guard.slice(0, 4200);
    assert.ok(
        head.includes('DeathStateRefused'),
        'broadcastPlayerState must refuse a DEAD state for a player that still has health'
    );
    // The player's own client is the authority on their health. The server's `entity.hp` is a
    // running subtraction and is the figure that drifts -- a hit counted twice drives it to zero
    // while the player is untouched on their own screen, which is the full-bar death pose.
    const decidingFigure = head.slice(head.indexOf('const clientHp'), head.indexOf('if (aliveHp > 0)'));
    assert.ok(
        decidingFigure.includes('authoritativeCurrentHp'),
        "the guard must decide on the client's own reported health, not the server's running subtraction"
    );
    assert.ok(
        decidingFigure.includes('recordedDead'),
        'an unreported health must fall back to the RECORDED death state, not to a raw hp number'
    );
}

// A genuine death must still get through the guard above, and it only can if the death is
// recorded before it is announced -- `notePlayerDeathState` is what zeroes the deciding figure.
function testEveryDeathPathRecordsBeforeAnnouncing(): void {
    const announcements = [...source.matchAll(/broadcastPlayerState\([^)]*EntityState\.DEAD/g)];
    assert.ok(announcements.length >= 1, 'the death announcement must still exist');
    for (const match of announcements) {
        const preceding = source.slice(Math.max(0, match.index! - 700), match.index!);
        assert.ok(
            preceding.includes('notePlayerDeathState'),
            'a death announcement without a preceding notePlayerDeathState would be refused by the guard'
        );
    }
}

// A player's death is announced off the health their own client reports, never off the server's
// running subtraction. That figure drifts to zero while the player is untouched on their own
// screen, so announcing from the hit path fired a DEAD on hits that killed nobody -- the death
// animation started, the revival announcement undid it, and the next hit repeated it. The player
// never fell over and never stopped "dying".
function testHitPathDoesNotAnnounceDeath(): void {
    const start = source.indexOf('if (resolution.killed) {');
    assert.ok(start >= 0, 'the player-kill branch of handlePowerHit not found');
    const branch = source.slice(start, source.indexOf('}', source.indexOf('EquipmentHandler.broadcastGearChange', start)));
    assert.equal(
        /broadcastPlayerState\([^)]*EntityState\.DEAD/.test(branch),
        false,
        "the hit path must not announce a player's death -- their own client does"
    );
}

// A party frame is driven by HP deltas, and a death is a state packet carrying no health. So the
// last slice of health has to go out as a delta or the dead player keeps a full bar on every
// other screen while their own shows the revive prompt at 0.
function testDeathEmptiesTheBarOnOtherScreens(): void {
    const note = source.slice(source.indexOf('static notePlayerDeathState'));
    const head = note.slice(0, 7400);
    assert.ok(
        head.includes('CLIENT_HEAL_PACKET_ID'),
        'recording a death must also send the remaining health as a delta, or party frames stay full'
    );
    assert.ok(
        head.indexOf('CLIENT_HEAL_PACKET_ID') < head.indexOf('entity.hp = 0'),
        'the remaining health must be read and sent BEFORE it is zeroed here'
    );
    // Scope-wide, not room-scoped: a party frame shows a member wherever they are, so a member
    // who died in another room would otherwise keep a full bar for the rest of the run.
    assert.ok(
        head.includes('getSessionsInLevelScope'),
        'the death delta must reach every session in the dungeon scope, unfiltered'
    );
    // Sized by the full pool, not the server's remainder: the two sides disagree on the exact
    // figure, so a delta sized from the remainder leaves a sliver of health on the frame.
    assert.ok(
        head.includes('drainAmount'),
        'the death delta must be sized to empty the bar outright, not to the server remainder'
    );
    // Unconditional: gating on a non-zero remainder is why the FIRST death of a run never emptied
    // the frame (nothing had tracked that player's health yet) while the second one did.
    assert.equal(
        head.includes('if (remainingHp > 0)'),
        false,
        'the death drain must not be gated on the server having tracked a remainder'
    );
}

// A spawn places a body; it does not decide whether that body is alive. The stored entity carries
// sticky death flags (nothing rewrites them until a movement packet arrives), so drawing it as-is
// put untouched players face-down on every screen that drew them.
function testPlayerSpawnNeverCarriesDeath(): void {
    const entitySource = fs.readFileSync(
        path.resolve(__dirname, '..', 'handlers', 'EntityHandler.ts'),
        'utf8'
    );
    const i = entitySource.indexOf('Entity.fromCharacter(subject.clientEntID');
    assert.ok(i >= 0, 'the player spawn call was not found');
    const preceding = entitySource.slice(Math.max(0, i - 1400), i);
    assert.ok(
        preceding.includes('dead: false'),
        'a player spawn must place a living body -- death is announced separately'
    );
    assert.ok(
        preceding.includes('EntityState.ACTIVE'),
        'a player spawn must clear the stored entState as well as the dead flag'
    );
}

// Zero-from-unknown and zero-from-dead look identical in a health figure. On level entry none of
// the sources are populated, so the first health packet resolved to zero and the player was
// declared dead before taking a hit -- death pose at 0% progress, and empty party frames because
// the death drains the whole pool from every other screen.
function testEntryZeroIsNotADeath(): void {
    const i = source.indexOf('if (nextHp <= 0');
    assert.ok(i >= 0, 'the client health-report death branch was not found');
    const condition = source.slice(i, source.indexOf(')', i) + 1);
    assert.ok(
        condition.includes('currentHp > 0'),
        'a death here must require health to have been there first, or entry reads as a death'
    );
}
function main(): void {
    testAlreadyDeadIsNeverReportedAsAKill();
    testStaleDeathFlagIsCleared();
    testRevivalIsAnnouncedToTheParty();
    testDeathStateIsRefusedForALivingPlayer();
    testEveryDeathPathRecordsBeforeAnnouncing();
    testDeathEmptiesTheBarOnOtherScreens();
    testHitPathDoesNotAnnounceDeath();
    testPlayerSpawnNeverCarriesDeath();
    testEntryZeroIsNotADeath();
    console.log('stale_player_death_flag_regression: ok');
}

main();
