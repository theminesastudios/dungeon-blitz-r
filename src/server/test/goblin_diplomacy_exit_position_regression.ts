/** Goblin Diplomacy's authored return marker is outside the walkable Shazari terrain. */
import * as path from 'path';
import { LevelConfig } from '../core/LevelConfig';

const dataDir = path.resolve(__dirname, '..', 'data');
LevelConfig.load(dataDir);

const assertions: Array<[string, () => boolean]> = [
    [
        'normal Goblin Diplomacy clears targetDoor so explicit coordinates win',
        () => LevelConfig.getDungeonExitResponseDoorId('SD_Mission4', 'ShazariDesert') === 0
    ],
    [
        'Dread Goblin Diplomacy also clears targetDoor',
        () => LevelConfig.getDungeonExitResponseDoorId('SD_Mission4Hard', 'ShazariDesertHard') === 0
    ],
    [
        'normal Goblin Diplomacy returns to the confirmed floor beside door 104',
        () => {
            const spawn = LevelConfig.getDungeonExitSpawnOverride('SD_Mission4', 'ShazariDesert');
            return spawn?.x === 18900 && spawn.y === 2575;
        }
    ],
    [
        'Dread Goblin Diplomacy uses the same confirmed floor point',
        () => {
            const spawn = LevelConfig.getDungeonExitSpawnOverride('SD_Mission4Hard', 'ShazariDesertHard');
            return spawn?.x === 18900 && spawn.y === 2575;
        }
    ],
    [
        'the normal exit still resolves its authored entrance door',
        () => LevelConfig.getDungeonEntranceDoorId('SD_Mission4', 'ShazariDesert') === 104
    ],
    [
        'the Dread exit still resolves its authored entrance door',
        () => LevelConfig.getDungeonEntranceDoorId('SD_Mission4Hard', 'ShazariDesertHard') === 104
    ],
    [
        'unrelated Shazari dungeons keep authored door spawning',
        () => LevelConfig.getDungeonExitResponseDoorId('SD_Mission5', 'ShazariDesert') === 105
    ],
    [
        'normal and Dread destinations cannot be crossed',
        () => LevelConfig.getDungeonExitResponseDoorId('SD_Mission4', 'ShazariDesertHard') === null
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
    console.error(`${failed}/${assertions.length} Goblin Diplomacy exit assertions failed`);
    process.exit(1);
}
console.log(`[regression] Goblin Diplomacy exit position: ${assertions.length} assertions passed`);
