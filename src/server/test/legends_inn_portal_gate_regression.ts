/// <reference types="node" />

/**
 * The Legends' Inn exit portal opens when the boss's *body* is gone, not when it
 * dies, and only once every boss the stage lists has fallen.
 *
 * Both halves have been wrong in play. Opening on the death packet put the portal
 * on screen while the boss was still falling over; opening on the first of two
 * boss cues would have let Bridgetown's twins be half-fought. The grace period is
 * the third case: the destroy packet belongs to the client, so a run whose killer
 * disconnects must still find a way out rather than being sealed in.
 */
import { strict as assert } from 'assert';
import * as path from 'path';
import { LevelConfig } from '../core/LevelConfig';
import { LegendsInn } from '../core/LegendsInn';

const dataDir = path.resolve(__dirname, '..', 'data');
LevelConfig.load(dataDir);
LegendsInn.load(dataDir);

/** Enough of a Client for the scope key and the level lookup. */
function makeClient(levelName: string, instanceId: string): any {
    return {
        currentLevel: levelName,
        levelInstanceId: instanceId,
        playerSpawned: false,
        knownEntityIds: new Set<number>(),
        entities: new Map<number, unknown>()
    };
}

function scopeOf(client: any): string {
    return `${client.currentLevel}#${client.levelInstanceId}`;
}

const singleBossStage = LegendsInn.getStage('LegendsInn1Hard');
assert.ok(singleBossStage, 'LegendsInn1Hard should be a known stage');
assert.equal(singleBossStage!.bosses.length, 1, 'stage 1 should have exactly one boss');

// --- death alone must not open the way -------------------------------------
{
    const client = makeClient('LegendsInn1Hard', 'gate-death-only');
    const scope = scopeOf(client);
    LegendsInn.resetScope(scope);

    LegendsInn.noteEntityDefeated(client, { name: singleBossStage!.bosses[0] });
    assert.equal(
        LegendsInn.isPortalOpen(scope),
        false,
        'the portal must not open while the boss body is still on the floor'
    );

    LegendsInn.noteEntityDestroyed(client, { name: singleBossStage!.bosses[0] });
    assert.equal(LegendsInn.isPortalOpen(scope), true, 'the portal opens once the body is gone');
    LegendsInn.resetScope(scope);
}

// --- a trash mob must not open anything ------------------------------------
{
    const client = makeClient('LegendsInn1Hard', 'gate-trash');
    const scope = scopeOf(client);
    LegendsInn.resetScope(scope);

    LegendsInn.noteEntityDefeated(client, { name: 'CastleLizard1Hard' });
    LegendsInn.noteEntityDestroyed(client, { name: 'CastleLizard1Hard' });
    assert.equal(LegendsInn.isPortalOpen(scope), false, 'a trash mob must not open the exit');
    LegendsInn.resetScope(scope);
}

// --- every boss the stage lists has to fall --------------------------------
{
    const twinStage = LegendsInn.getStages().find((stage) => stage.bosses.length > 1);
    if (twinStage) {
        const client = makeClient(twinStage.levelName, 'gate-twins');
        const scope = scopeOf(client);
        LegendsInn.resetScope(scope);

        LegendsInn.noteEntityDefeated(client, { name: twinStage.bosses[0] });
        LegendsInn.noteEntityDestroyed(client, { name: twinStage.bosses[0] });
        assert.equal(
            LegendsInn.isPortalOpen(scope),
            false,
            `${twinStage.levelName}: one of ${twinStage.bosses.length} bosses must not open the exit`
        );

        for (const boss of twinStage.bosses.slice(1)) {
            LegendsInn.noteEntityDefeated(client, { name: boss });
            LegendsInn.noteEntityDestroyed(client, { name: boss });
        }
        assert.equal(LegendsInn.isPortalOpen(scope), true, 'the exit opens once every boss is gone');
        LegendsInn.resetScope(scope);
    }
}

// --- a reused instance must not inherit the last run's open exit ------------
{
    const client = makeClient('LegendsInn1Hard', 'gate-reset');
    const scope = scopeOf(client);
    LegendsInn.resetScope(scope);

    LegendsInn.noteEntityDefeated(client, { name: singleBossStage!.bosses[0] });
    LegendsInn.noteEntityDestroyed(client, { name: singleBossStage!.bosses[0] });
    assert.equal(LegendsInn.isPortalOpen(scope), true);

    LegendsInn.resetScope(scope);
    assert.equal(LegendsInn.isPortalOpen(scope), false, 'a fresh run starts with the exit shut');

    // ...and the half-finished state is gone too, so the next run's first boss
    // death does not land on a set that already counts it.
    LegendsInn.noteEntityDestroyed(client, { name: singleBossStage!.bosses[0] });
    assert.equal(
        LegendsInn.isPortalOpen(scope),
        false,
        'a destroy with no death behind it must not open the exit on its own'
    );
    LegendsInn.resetScope(scope);
}

console.log('legends_inn_portal_gate_regression: ok');
