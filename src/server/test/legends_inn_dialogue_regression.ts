/// <reference types="node" />

/**
 * What Legends' Inn says, and who says it.
 *
 * The dungeon borrows nine shipped dungeons whole, so every line a room script
 * fires belongs to a quest nobody in here is on. Five things have to hold for the
 * replacement to read as one story rather than as nine:
 *
 *   - the *player* speaks story lines too, which is the half that was missing:
 *     the hero used to repeat whatever the borrowed dungeon's cutscene said;
 *   - a player line after a boss line is that boss line's written answer, so the
 *     hero is talking to the guardian rather than past it;
 *   - each stage's guardian has its own pool, so nine bosses are not one boss;
 *   - an ordinary hostile is stable - the same mob says the same thing every run;
 *   - and nothing outside a Legends' Inn stage is touched at all.
 */
import { strict as assert } from 'assert';
import * as path from 'path';
import { LevelConfig } from '../core/LevelConfig';
import { LegendsInn } from '../core/LegendsInn';
import { LegendsInnDialogue } from '../core/LegendsInnDialogue';

const dataDir = path.resolve(__dirname, '..', 'data');
LevelConfig.load(dataDir);
LegendsInn.load(dataDir);

const stages = LegendsInn.getStages();
assert.ok(stages.length >= 9, 'the tour should be nine stages long');

/** A session standing in `levelName`, with one hostile and one player body. */
function makeClient(levelName: string, bossName: string): any {
    const entities = new Map<number, Record<string, unknown>>([
        [10, { name: bossName }],
        [11, { name: 'CastleLizard1Hard' }],
        [99, { name: 'Someone', isPlayer: true }]
    ]);
    return { currentLevel: levelName, clientEntID: 99, entities };
}

// --- the player answers the guardian in front of them -----------------------
{
    const stage = stages[0];
    const client = makeClient(stage.levelName, stage.bosses[0]);

    const bossLine = LegendsInnDialogue.resolveLine(client, 10, 'Get them, boys!');
    assert.ok(bossLine, 'a stage boss must speak a story line');

    const reply = LegendsInnDialogue.resolveLine(client, 99, 'I have to find the goblin chief!');
    assert.ok(reply, 'the player must speak a story line, not the borrowed quest');
    assert.notEqual(reply, bossLine, 'the reply is the other half of the exchange, not an echo');

    // Same boss line again -> same reply. The exchange is written as a pair.
    assert.equal(
        LegendsInnDialogue.resolveLine(client, 99, 'Anything at all'),
        reply,
        "the hero's answer follows the guardian's last line, whatever the room asked for"
    );
}

// --- a reply cannot follow the player through a portal ----------------------
{
    const first = stages[0];
    const second = stages[1];
    const client = makeClient(first.levelName, first.bosses[0]);
    LegendsInnDialogue.resolveLine(client, 10, 'Something');

    client.currentLevel = second.levelName;
    const nextHold = LegendsInnDialogue.resolveLine(client, 99, 'Onward');
    assert.ok(nextHold, 'the player still speaks in the next hold');
    // Nothing has spoken in this hold yet, so the line is about the road rather
    // than an answer to a guardian who is a portal behind them.
    const roadLines = new Set(LegendsInnDialogue.getAllLines());
    assert.ok(roadLines.has(nextHold!), 'every line the module produces must come out of its own pools');
}

// --- nine guardians, nine pools ---------------------------------------------
{
    const spoken = new Set<string>();
    for (const stage of stages) {
        const client = makeClient(stage.levelName, stage.bosses[0]);
        const lines = new Set<string>();
        for (const authored of ['a', 'b', 'c', 'd', 'e', 'f']) {
            const line = LegendsInnDialogue.resolveLine(client, 10, authored);
            assert.ok(line, `${stage.levelName}'s boss must speak`);
            lines.add(line!);
        }
        for (const line of lines) {
            assert.equal(
                spoken.has(line),
                false,
                `${stage.levelName}'s guardian repeats a line another hold already used: ${line}`
            );
            spoken.add(line);
        }
    }
}

// --- an ordinary hostile is stable, and is not the boss ---------------------
{
    const stage = stages[0];
    const client = makeClient(stage.levelName, stage.bosses[0]);
    const first = LegendsInnDialogue.resolveLine(client, 11, 'Rawr');
    assert.ok(first, 'an ordinary hostile speaks too');
    assert.equal(
        LegendsInnDialogue.resolveLine(makeClient(stage.levelName, stage.bosses[0]), 11, 'Rawr'),
        first,
        'the same mob says the same thing every run, so the dungeon can be learned'
    );
}

// --- everything outside the dungeon is left alone ---------------------------
{
    const client = makeClient('GoblinRiverDungeon', 'GoblinBoss2');
    assert.equal(
        LegendsInnDialogue.resolveLine(client, 10, 'Get them, boys!'),
        null,
        "a shipped dungeon keeps its own dialogue"
    );
    assert.equal(
        LegendsInnDialogue.resolveLine(client, 99, 'I have to find the goblin chief!'),
        null,
        'and so does the player standing in it'
    );
}

// --- an unnameable speaker is left alone ------------------------------------
{
    const stage = stages[0];
    const client = makeClient(stage.levelName, stage.bosses[0]);
    assert.equal(
        LegendsInnDialogue.resolveLine(client, 12345, 'Who said that?'),
        null,
        'a line with no speaker cannot be given a speaker`s voice'
    );
}

console.log('legends_inn_dialogue_regression: ok');
