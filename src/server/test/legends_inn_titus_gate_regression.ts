/// <reference types="node" />

/**
 * Titus stops a character at the Legends' Inn portal exactly once.
 *
 * The rule is easy to state and easy to get wrong in three ways, so all three are
 * pinned here:
 *
 *   - the *first* reach for the portal is refused, so nobody is inside the dungeon
 *     without having been told what is at the end of it;
 *   - the second is not, so nobody sits through the warning twice;
 *   - and he only stands in the way of the way *in*. The portals between stages
 *     have their own rule, and a player already in there has plainly had the
 *     conversation.
 */
import { strict as assert } from 'assert';
import * as path from 'path';
import { LevelConfig } from '../core/LevelConfig';
import { LegendsInn } from '../core/LegendsInn';
import {
    LEGENDS_INN_TITUS_ENTITY_ID,
    LEGENDS_INN_TITUS_WARNING,
    LegendsInnGate
} from '../core/LegendsInnGate';

const dataDir = path.resolve(__dirname, '..', 'data');
LevelConfig.load(dataDir);
LegendsInn.load(dataDir);

const firstStage = LegendsInn.getStages()[0]?.levelName ?? '';
assert.ok(firstStage, 'the dungeon should have a first stage to be stopped in front of');

/** Enough of a Client for the gate. */
function makeClient(levelName: string): any {
    return { currentLevel: levelName, character: { name: 'GateTester' } };
}

// --- the first reach is refused, the second is not --------------------------
{
    const client = makeClient('CraftTown');
    assert.equal(
        LegendsInnGate.shouldStopAtPortal(client, firstStage),
        true,
        'a character who has never been told must be stopped'
    );

    assert.equal(LegendsInnGate.markBriefed(client.character), true, 'the first stop records the briefing');
    assert.equal(
        LegendsInnGate.markBriefed(client.character),
        false,
        'a second stop must not re-record it - that is what keeps the save quiet'
    );
    assert.equal(
        LegendsInnGate.shouldStopAtPortal(client, firstStage),
        false,
        'the next reach for the portal goes straight through'
    );
}

// --- the briefing is remembered on the character ----------------------------
{
    const briefed = makeClient('CraftTown');
    LegendsInnGate.markBriefed(briefed.character);
    assert.equal(LegendsInnGate.isBriefed(briefed.character), true);

    // A different character on the same account starts again, because the warning
    // is addressed to whoever is about to walk in.
    const fresh = makeClient('CraftTown');
    assert.equal(LegendsInnGate.isBriefed(fresh.character), false);
    assert.equal(LegendsInnGate.shouldStopAtPortal(fresh, firstStage), true);
}

// --- only the way in --------------------------------------------------------
{
    const inside = makeClient(firstStage);
    const secondStage = LegendsInn.getStages()[1]?.levelName ?? '';
    assert.ok(secondStage, 'the dungeon should have a second stage');
    assert.equal(
        LegendsInnGate.shouldStopAtPortal(inside, secondStage),
        false,
        'the portal between two stages is not Titus\'s to hold'
    );

    const elsewhere = makeClient('CraftTown');
    assert.equal(
        LegendsInnGate.shouldStopAtPortal(elsewhere, 'NewbieRoad'),
        false,
        'a door that does not lead into Legends\' Inn must not be touched'
    );
    assert.equal(
        LegendsInnGate.shouldStopAtPortal(elsewhere, ''),
        false,
        'a door with no target must not be touched'
    );
}

// --- he is a real, clickable entity standing on the path --------------------
{
    const titus = LegendsInnGate.buildEntity();
    assert.equal(titus.id, LEGENDS_INN_TITUS_ENTITY_ID);
    assert.equal(LegendsInnGate.isTitus(titus.id), true);
    assert.equal(LegendsInnGate.isTitusEntity(titus), true);

    // The client will not offer an interact on an entity with no cue name, and
    // refuses one that is in DRAMA - so these two are load-bearing, not cosmetic.
    assert.ok(String(titus.characterName ?? '').length > 0, 'Titus needs a cue name to be clickable');
    assert.equal(titus.entState, 1, 'Titus must be asleep, not in drama, to be interactable');
    assert.equal(titus.untargetable, false, 'an untargetable entity cannot be talked to');

    // On the floor of the stone path: the same y the game itself lands a player on
    // when they come back out of the dungeon.
    assert.equal(titus.y, 1360, 'Titus stands on the measured floor line under the portal');
    assert.notEqual(titus.x, -240, 'and not on the arrival point returning players land on');

    assert.ok(LEGENDS_INN_TITUS_WARNING.includes('Telahair'), 'the warning names what is waiting');
    assert.ok(LegendsInnGate.getLine().length > 0, 'talking to him says something');
}

console.log('legends_inn_titus_gate_regression: ok');
