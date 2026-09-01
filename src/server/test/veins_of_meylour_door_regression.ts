/** Regression coverage for issue #763: Veins of Meylour's door-108 route must resolve. */
import * as path from 'path';
import { LevelConfig } from '../core/LevelConfig';

const dataDir = path.resolve(__dirname, '..', 'data');
LevelConfig.load(dataDir);

const assertions: Array<[string, () => boolean]> = [
    [
        'Veins of Meylour door resolves to its dungeon',
        () => LevelConfig.getDoorTarget('OldMineMountain', 108) === 'OMM_Mission8'
    ],
    [
        'Dread Veins of Meylour door resolves to its dungeon',
        () => LevelConfig.getDoorTarget('OldMineMountainHard', 108) === 'OMM_Mission8Hard'
    ],
    [
        'Veins of Meylour remains classified as a dungeon',
        () => LevelConfig.isDungeonLevel(LevelConfig.getDoorTarget('OldMineMountain', 108))
    ],
    [
        'the authored entrance metadata points back to door 108',
        () => LevelConfig.getDungeonEntranceDoorId('OMM_Mission8', 'OldMineMountain') === 108
    ],
    [
        'the dungeon uses its safe authored entry coordinates',
        () => {
            const spawn = LevelConfig.getDungeonEntrySpawnOverride('OMM_Mission8');
            return spawn?.x === 2375 && spawn.y === 849;
        }
    ],
    [
        'other legacy door-108 omissions also resolve through DoorTypes',
        () => (
            LevelConfig.getDoorTarget('CemeteryHill', 108) === 'CH_Mission8' &&
            LevelConfig.getDoorTarget('JadeCity', 108) === 'JC_Mission8'
        )
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
    console.error(`${failed}/${assertions.length} Veins of Meylour door assertions failed`);
    process.exit(1);
}

console.log(`[regression] Veins of Meylour door routing: ${assertions.length} assertions passed`);
