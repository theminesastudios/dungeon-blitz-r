/**
 * Regression test for the house-exit return position: leaving the house (CraftTown or the
 * keep tutorial) must put the player back where they stood before entering, not at the
 * region's start point.
 *
 * The confirmed spawn (GroundedSpawns) is only refreshed on level entry, so a player who
 * walks across the region to the house gate carries a stale confirmed record pointing at the
 * region's spawn. Entering the house saves the last grounded position in the region
 * (PreviousLevel); getSpawnCoordinates must prefer it for a house exit, and every other
 * transfer keeps the existing preference order.
 */
import * as path from 'path';
import { LevelConfig } from '../core/LevelConfig';

const dataDir = path.resolve(__dirname, '..', 'data');
LevelConfig.load(dataDir);

// BridgeTown's authored spawn is 3944,838 -- the "start of Felbridge" the bug dumped players
// on. PreviousLevel holds where the player actually stood before entering the house.
const REGION_START = { x: 3944, y: 838 };
const RETURN_POSITION = { x: 9999, y: 8888 };

function makeCharacter(
    previous?: { name?: string; x?: number; y?: number },
    groundedSpawns?: Record<string, { x: number; y: number }>
): any {
    return {
        PreviousLevel: previous ?? { name: 'BridgeTown', ...RETURN_POSITION },
        GroundedSpawns: groundedSpawns ?? { BridgeTown: REGION_START }
    };
}

const assertions: Array<[string, () => boolean]> = [
    [
        'leaving the house returns to the saved position, not the stale confirmed spawn',
        () => {
            const spawn = LevelConfig.getSpawnCoordinates(makeCharacter(), 'CraftTown', 'BridgeTown');
            return spawn.hasCoord && spawn.x === RETURN_POSITION.x && spawn.y === RETURN_POSITION.y;
        }
    ],
    [
        'the keep tutorial exit also uses the saved return position',
        () => {
            const spawn = LevelConfig.getSpawnCoordinates(makeCharacter(), 'CraftTownTutorial', 'BridgeTown');
            return spawn.hasCoord && spawn.x === RETURN_POSITION.x && spawn.y === RETURN_POSITION.y;
        }
    ],
    [
        'a previous level that does not name the target region is ignored',
        () => {
            const spawn = LevelConfig.getSpawnCoordinates(
                makeCharacter({ name: 'NewbieRoad', x: 1421, y: 826 }),
                'CraftTown',
                'BridgeTown'
            );
            return spawn.hasCoord && spawn.x === REGION_START.x && spawn.y === REGION_START.y;
        }
    ],
    [
        'a plain region transfer does not prefer PreviousLevel',
        () => {
            const spawn = LevelConfig.getSpawnCoordinates(
                makeCharacter({ name: 'NewbieRoad', x: 1421, y: 826 }),
                'SwampRoadNorth',
                'BridgeTown'
            );
            return spawn.hasCoord && spawn.x === REGION_START.x && spawn.y === REGION_START.y;
        }
    ],
    [
        'a 0,0 previous position is not replayed as a return point',
        () => {
            const spawn = LevelConfig.getSpawnCoordinates(
                makeCharacter({ name: 'BridgeTown', x: 0, y: 0 }),
                'CraftTown',
                'BridgeTown'
            );
            return spawn.hasCoord && spawn.x === REGION_START.x && spawn.y === REGION_START.y;
        }
    ],
    [
        'a transfer to another house level is not treated as a return',
        () => {
            const spawn = LevelConfig.getSpawnCoordinates(makeCharacter(), 'CraftTown', 'CraftTownTutorial');
            return spawn.hasCoord && spawn.x === -6886 && spawn.y === 1623;
        }
    ],
    [
        'a dungeon target from the house is not given the previous region coordinates',
        () => {
            const spawn = LevelConfig.getSpawnCoordinates(makeCharacter(), 'CraftTown', 'SRN_Mission2');
            return !spawn.hasCoord;
        }
    ]
];

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
    console.error(`${failed}/${assertions.length} house-return position assertions failed`);
    process.exit(1);
}
console.log(`[regression] house return position: ${assertions.length} assertions passed`);
