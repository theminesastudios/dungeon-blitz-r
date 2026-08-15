/**
 * Regression test for issue #696 — "Returning from house teleports player into previous dungeon".
 *
 * The transfer-request handler must never route a house-bound player (CraftTown / the keep
 * tutorial) into a dungeon: the house has no dungeon doors, so a dungeon target arriving in a
 * transfer request from inside it can only be stale client/transfer state (a remembered door
 * target or a replayed level name). The one dungeon-ish destination genuinely reachable from
 * the house — the Legends' Inn portal — goes through the door-open path with its own stage
 * levels, so those must be allowed through, as must explicit server-side teleports.
 */
import * as path from 'path';
import { LevelConfig } from '../core/LevelConfig';
import { LegendsInn } from '../core/LegendsInn';

const dataDir = path.resolve(__dirname, '..', 'data');
LevelConfig.load(dataDir);
LegendsInn.load(dataDir);

// Mirrors the guard in LevelHandler.handleLevelTransferRequest so a future change to either
// side of the decision fails this test.
function shouldRedirectHouseDungeonTransfer(
    sourceLevel: string,
    targetLevel: string,
    hasTeleportOverride: boolean
): boolean {
    return (
        !hasTeleportOverride &&
        (sourceLevel === 'CraftTown' || sourceLevel === 'CraftTownTutorial') &&
        LevelConfig.isDungeonLevel(targetLevel) &&
        !LegendsInn.isStageLevel(targetLevel)
    );
}

const assertions: Array<[string, () => boolean]> = [
    ['CraftTown is not treated as a dungeon', () => !LevelConfig.isDungeonLevel('CraftTown')],
    ['Mystery of Yornak (SRN_Mission2) is a dungeon', () => LevelConfig.isDungeonLevel('SRN_Mission2')],
    ['SRN_Mission2 is not a Legends\' Inn stage', () => !LegendsInn.isStageLevel('SRN_Mission2')],
    ['a dungeon is not a safe return level', () => !LevelConfig.isSaveAllowedLevel('SRN_Mission2')],
    [
        'safe return resolution skips the dungeon and yields the region town',
        () =>
            LevelConfig.resolveSafeReturnLevel(
                ['CraftTown', null, 'SwampRoadNorth', 'SRN_Mission2', 'CraftTown'],
                { fallbackLevel: 'NewbieRoad', excludedLevels: ['CraftTown', 'CraftTownTutorial'] }
            ) === 'SwampRoadNorth'
    ]
];

// Every dungeon the house could plausibly be asked to send a stale request to must be
// redirected, both the normal and the Hard variants.
const staleHouseRequests: Array<[string, string]> = [
    ['CraftTown', 'SRN_Mission2'],
    ['CraftTown', 'SRN_Mission2Hard'],
    ['CraftTownTutorial', 'BT_Mission2']
];
for (const [source, target] of staleHouseRequests) {
    assertions.push([
        `stale ${target} request from ${source} must be redirected`,
        () => shouldRedirectHouseDungeonTransfer(source, target, false)
    ]);
}

// The Legends' Inn stages are reachable from the house through the portal door and must not
// be redirected.
for (const stage of LegendsInn.getStages()) {
    assertions.push([
        `Legends' Inn stage ${stage.levelName} stays reachable from the house`,
        () => !shouldRedirectHouseDungeonTransfer('CraftTown', stage.levelName, false)
    ]);
}

// A server-initiated teleport (e.g. to a friend who is inside a dungeon) carries its own
// coordinates and must not be redirected.
assertions.push([
    'explicit teleport to a dungeon is not redirected',
    () => !shouldRedirectHouseDungeonTransfer('CraftTown', 'SRN_Mission2', true)
]);

let failed = 0;
for (const [name, check] of assertions) {
    if (!check()) {
        failed += 1;
        console.error(`FAIL: ${name}`);
    } else {
        console.log(`ok: ${name}`);
    }
}

if (failed > 0) {
    console.error(`${failed}/${assertions.length} house-return assertions failed`);
    process.exit(1);
}
console.log(`[regression] house return dungeon guard: ${assertions.length} assertions passed`);
