import { strict as assert } from 'assert';
import path from 'path';
import { RegionPositionPersistence } from '../core/RegionPositionPersistence';
import { LevelConfig } from '../core/LevelConfig';

/**
 * Recovered alongside core/RegionPositionPersistence.ts, whose TypeScript source had been
 * lost -- only the compiled dist copy survived, so builds from source shipped without it and
 * disconnects stopped recording where the player was standing.
 */
function main(): void {
    LevelConfig.load(path.resolve(process.cwd(), 'data'));

    const saves: string[] = [];
    const client: any = {
        userId: 7,
        currentLevel: 'JadeCity',
        character: { name: 'Neodevils', CurrentLevel: { name: 'JadeCity', x: 0, y: 0 } },
        scheduleCharacterSave(reason: string) {
            saves.push(reason);
        }
    };

    assert.equal(RegionPositionPersistence.record(client, { x: 8372, y: -2129 }, 'movement', { force: true }), true);
    assert.deepEqual(client.character.LastRegionPosition.levelName, 'JadeCity');
    assert.equal(client.character.LastRegionPosition.x, 8372);
    assert.equal(saves.length, 1, 'accepted region movement should queue a character save');

    client.character.CurrentLevel = { name: 'JadeCity', x: 0, y: 0 };
    assert.equal(RegionPositionPersistence.restore(client.character), true);
    assert.deepEqual(client.character.CurrentLevel, { name: 'JadeCity', x: 8372, y: -2129 });

    client.currentLevel = 'JC_Mini2';
    assert.equal(
        RegionPositionPersistence.record(client, { x: 1, y: 2 }, 'movement', { force: true }),
        false,
        'dungeon positions must not overwrite normal-region return locations'
    );
    assert.equal(client.character.LastRegionPosition.levelName, 'JadeCity');

    // A disconnect must not be swallowed by the movement throttle -- it is the write that
    // matters most, and it lands within milliseconds of the movement saves before it.
    client.currentLevel = 'JadeCity';
    RegionPositionPersistence.forget(client);
    assert.equal(RegionPositionPersistence.record(client, { x: 100, y: 200 }, 'movement', { force: true }), true);
    assert.equal(
        RegionPositionPersistence.record(client, { x: 300, y: 400 }, 'disconnect', { persist: false }),
        true,
        'a disconnect write must bypass the movement throttle'
    );
    assert.equal(client.character.LastRegionPosition.x, 300);
    assert.deepEqual(client.character.CurrentLevel, { name: 'JadeCity', x: 300, y: 400 });

    console.log('region_position_persistence_regression: ok');
}

main();
