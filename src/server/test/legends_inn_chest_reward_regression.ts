/// <reference types="node" />

/**
 * The Legends' Inn boss chest: gold scaled by the stage every time, and three
 * catalysts once a week each.
 *
 * Five things about it have to hold, and none of them is obvious from the code
 * that pays it out:
 *
 *   - the stage chest is told apart from the dungeon's *own* chests by where it
 *     stands, because the SWF build renames chest classes so every stage can carry
 *     the large gold chest and the class therefore proves nothing;
 *   - a week's catalyst is claimed once per character, not once per chest, or a
 *     nine-stage run would pay it nine times;
 *   - the gold is not on that lock and is paid by every chest;
 *   - the gold follows the stage the player is standing in, so walking the whole
 *     road beats farming the first chest;
 *   - and the week turns over.
 */
import { strict as assert } from 'assert';
import * as path from 'path';
import { LevelConfig } from '../core/LevelConfig';
import { LegendsInn } from '../core/LegendsInn';
import {
    LEGENDS_INN_CHEST_GOLD_PER_STAGE,
    LEGENDS_INN_WEEKLY_REWARDS,
    LegendsInnChest,
    claimChestOpening,
    getChestGold,
    getSideChestGold,
    getWeekKey,
    resetChestOpenings
} from '../core/LegendsInnChest';

const dataDir = path.resolve(__dirname, '..', 'data');
LevelConfig.load(dataDir);
LegendsInn.load(dataDir);

const stage = LegendsInn.getStage('LegendsInn1Hard');
assert.ok(stage, 'LegendsInn1Hard should be a known stage');
assert.ok(stage!.chest, 'every stage should record where its boss chest was placed');

// --- the chest is identified by position, not by EntType --------------------
{
    const atChest = { name: 'TreasureChestLarge', x: stage!.chest.x, y: stage!.chest.y };
    assert.equal(
        LegendsInnChest.isStageChest('LegendsInn1Hard', atChest),
        true,
        'the chest the build placed must be recognised'
    );

    // The same class, three rooms away: one of the dungeon's own chests.
    assert.equal(
        LegendsInnChest.isStageChest('LegendsInn1Hard', { ...atChest, x: stage!.chest.x + 4000 }),
        false,
        "a chest elsewhere in the level is the dungeon's own and must not pay"
    );

    // The right place, but not a chest.
    assert.equal(
        LegendsInnChest.isStageChest('LegendsInn1Hard', { ...atChest, name: 'CastleLizard1Hard' }),
        false,
        'a hostile standing where the chest is must not pay'
    );

    // The right chest, in a level this feature does not own.
    assert.equal(
        LegendsInnChest.isStageChest('GoblinRiverDungeon', atChest),
        false,
        'chests outside Legends\' Inn must not pay'
    );

    // An opening whose entity the session never registered. All the request
    // carries is the point the loot was asked for, and that point is the chest.
    assert.equal(
        LegendsInnChest.isStageChest('LegendsInn1Hard', null, { x: stage!.chest.x, y: stage!.chest.y }),
        true,
        'a chest with no resolvable source entity must still pay - otherwise it pays nothing at all'
    );
    // ...but the boss dies 200px away, and must never open the chest by dying.
    assert.equal(
        LegendsInnChest.isStageChest('LegendsInn1Hard', null, { x: stage!.chest.x + 200, y: stage!.chest.y }),
        false,
        'the nameless fallback must not reach as far as the boss anchor'
    );
}

// --- the dungeon's own chests pay a share of the stage ----------------------
{
    const elsewhere = { name: 'TreasureChestMedium', x: stage!.chest.x + 4000, y: stage!.chest.y };
    assert.equal(
        LegendsInnChest.isSideChest('LegendsInn1Hard', elsewhere),
        true,
        "a borrowed dungeon's own chest is a side chest and pays gold"
    );
    assert.equal(
        LegendsInnChest.isSideChest('LegendsInn1Hard', { name: 'TreasureChestLarge', x: stage!.chest.x, y: stage!.chest.y }),
        false,
        'the boss chest is paid in full by takePayout and must not be paid twice'
    );
    assert.equal(
        LegendsInnChest.isSideChest('LegendsInn1Hard', { ...elsewhere, name: 'CastleLizard1Hard' }),
        false,
        'a hostile is not a chest'
    );
    assert.equal(
        LegendsInnChest.isSideChest('GoblinRiverDungeon', elsewhere),
        false,
        "chests outside Legends' Inn keep their own loot tables"
    );

    const client: any = { character: { name: 'SideChestTester' }, currentLevel: 'LegendsInn9Hard' };
    const side = LegendsInnChest.takeSidePayout(client);
    assert.equal(
        side.gold,
        getSideChestGold(9),
        'a side chest pays its own stage, so the later stages are worth more here too'
    );
    assert.ok(side.gold > 0, 'a side chest must never pay nothing - that is the bug it exists to fix');
    assert.ok(
        side.gold < getChestGold(9),
        'the chest behind the boss must still be the one the stage is walked for'
    );
}

// --- one opening is paid once, however many clients report it ---------------
{
    resetChestOpenings('LegendsInn1Hard#chest-dedupe');
    assert.equal(claimChestOpening('LegendsInn1Hard#chest-dedupe', 'chest:1'), true);
    assert.equal(
        claimChestOpening('LegendsInn1Hard#chest-dedupe', 'chest:1'),
        false,
        'a second report of the same opening must not pay a second time'
    );

    resetChestOpenings('LegendsInn1Hard#chest-dedupe');
    assert.equal(
        claimChestOpening('LegendsInn1Hard#chest-dedupe', 'chest:1'),
        true,
        'a fresh run in a reused instance breaks a fresh chest'
    );
    resetChestOpenings('LegendsInn1Hard#chest-dedupe');
}

// --- gold every time, catalysts once a week ---------------------------------
{
    const character: Record<string, unknown> = { name: 'ChestTester' };
    const client: any = { character, currentLevel: 'LegendsInn1Hard' };
    const monday = Date.UTC(2026, 7, 10, 12, 0, 0);

    const first = LegendsInnChest.takePayout(client, monday);
    assert.equal(first[0].gold, LEGENDS_INN_CHEST_GOLD_PER_STAGE, 'the stage-1 chest pays one step of gold');
    assert.equal(
        first.length,
        1 + LEGENDS_INN_WEEKLY_REWARDS.length,
        'the first chest of the week carries every catalyst'
    );
    for (const reward of LEGENDS_INN_WEEKLY_REWARDS) {
        const entry = first.find((row) => row.consumableId === reward.consumableId);
        assert.ok(entry, `${reward.label} should be in the first payout`);
        assert.ok(
            Number(entry!.carrierMaterialId) > 0,
            `${reward.label} needs a carrier material - the loot packet has no consumable slot`
        );
    }

    // Same week, next stage.
    const second = LegendsInnChest.takePayout(client, monday + 60 * 60 * 1000);
    assert.equal(second.length, 1, 'later chests in the same week pay gold only');
    assert.equal(second[0].gold, LEGENDS_INN_CHEST_GOLD_PER_STAGE, 'the gold is not on the weekly lock');

    // ...and it follows the stage, not the chest count.
    client.currentLevel = 'LegendsInn9Hard';
    const last = LegendsInnChest.takePayout(client, monday + 2 * 60 * 60 * 1000);
    assert.equal(
        last[0].gold,
        9 * LEGENDS_INN_CHEST_GOLD_PER_STAGE,
        "the last stage's chest pays nine steps"
    );
    client.currentLevel = 'LegendsInn1Hard';

    // Next week.
    const nextWeek = monday + 7 * 24 * 60 * 60 * 1000;
    assert.notEqual(getWeekKey(nextWeek), getWeekKey(monday), 'the week key must move');
    const third = LegendsInnChest.takePayout(client, nextWeek);
    assert.equal(
        third.length,
        1 + LEGENDS_INN_WEEKLY_REWARDS.length,
        'the catalysts come back when the week turns over'
    );
}

// --- every stage pays its own step, and stage 1 is the specified million ----
{
    assert.equal(getChestGold(1), 1_000_000, 'stage 1 pays the million the dungeon was specified around');
    const stages = LegendsInn.getStages();
    for (const stage of stages) {
        assert.equal(
            getChestGold(stage.stage),
            stage.stage * LEGENDS_INN_CHEST_GOLD_PER_STAGE,
            `${stage.levelName} should pay ${stage.stage} steps`
        );
    }
    assert.ok(
        getChestGold(stages.length) > getChestGold(1),
        'the last stage must be worth more than the first, or nobody walks the road'
    );
}

// --- the lock is per catalyst, not all-or-nothing ---------------------------
{
    const character: Record<string, unknown> = { name: 'PartialTester' };
    const now = Date.UTC(2026, 7, 12, 9, 0, 0);
    assert.equal(LegendsInnChest.claimWeekly(character, LEGENDS_INN_WEEKLY_REWARDS[0], now), true);

    const left = LegendsInnChest.getUnclaimedWeeklyRewards(character, now);
    assert.equal(
        left.length,
        LEGENDS_INN_WEEKLY_REWARDS.length - 1,
        'taking one catalyst must leave the others available this week'
    );
    assert.equal(
        left.some((reward) => reward.consumableId === LEGENDS_INN_WEEKLY_REWARDS[0].consumableId),
        false,
        'the taken catalyst is the one that is gone'
    );
}

// --- weeks start on Monday, UTC ---------------------------------------------
{
    const sunday = Date.UTC(2026, 7, 9, 23, 59, 0);
    const monday = Date.UTC(2026, 7, 10, 0, 1, 0);
    assert.notEqual(
        getWeekKey(sunday),
        getWeekKey(monday),
        'Sunday night and Monday morning are different weeks'
    );
    assert.equal(
        getWeekKey(monday),
        getWeekKey(Date.UTC(2026, 7, 16, 23, 0, 0)),
        'Monday and the Sunday after it are the same week'
    );
}

console.log('legends_inn_chest_reward_regression: ok');
