import { strict as assert } from 'assert';
import { GearSetHandler } from '../handlers/GearSetHandler';
import { JsonAdapter } from '../database/JsonAdapter';
import { BitBuffer } from '../network/protocol/bitBuffer';

function createIndexPacket(index: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod20(3, index);
    return bb.toBuffer();
}

function createRenamePacket(index: number, name: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod20(3, index);
    bb.writeMethod26(name);
    return bb.toBuffer();
}

async function withMockedCharacterSave<T>(fn: (saved: { characters: any[] | null }) => Promise<T>): Promise<T> {
    const originalSaveCharacterSnapshot = JsonAdapter.prototype.saveCharacterSnapshot;
    const saved = { characters: null as any[] | null };
    JsonAdapter.prototype.saveCharacterSnapshot = async function(_userId: number, character: any): Promise<any[]> {
        saved.characters = [character];
        return saved.characters;
    };

    try {
        return await fn(saved);
    } finally {
        JsonAdapter.prototype.saveCharacterSnapshot = originalSaveCharacterSnapshot;
    }
}

function createClient(character: any): any {
    return {
        userId: 91,
        character,
        characters: [character]
    };
}

async function testCreateGearSetStartsEmpty(): Promise<void> {
    await withMockedCharacterSave(async (saved) => {
        const character: any = {
            name: 'GearHero',
            class: 'rogue',
            gender: 'male',
            level: 1,
            equippedGears: [
                { gearID: 101 },
                { gearID: 102 },
                { gearID: 103 },
                { gearID: 104 },
                { gearID: 105 },
                { gearID: 106 }
            ],
            gearSets: []
        };

        await GearSetHandler.handleCreateGearSet(createClient(character), createIndexPacket(0));

        assert.deepEqual(character.gearSets, [
            { name: 'GearSet 1', slots: [0, 0, 0, 0, 0, 0, 0] }
        ]);
        assert.deepEqual(saved.characters?.[0].gearSets, character.gearSets);
    });
}

async function testOverwriteGearSetSnapshotsCurrentEquipmentAndKeepsExistingName(): Promise<void> {
    await withMockedCharacterSave(async (saved) => {
        const character: any = {
            name: 'GearHero',
            class: 'rogue',
            gender: 'male',
            level: 1,
            equippedGears: [
                { gearID: 201 },
                { gearID: 202 },
                { gearID: 203 },
                { gearID: 204 },
                { gearID: 205 },
                { gearID: 206 }
            ],
            gearSets: [
                { name: 'Boss', slots: [0, 101, 102, 103, 104, 105, 106] }
            ]
        };

        await GearSetHandler.handleOverwriteGearSet(createClient(character), createIndexPacket(0));

        assert.deepEqual(character.gearSets[0], {
            name: 'Boss',
            slots: [0, 201, 202, 203, 204, 205, 206]
        });
        assert.deepEqual(saved.characters?.[0].gearSets, character.gearSets);
    });
}

async function testRenameGearSetPersistsName(): Promise<void> {
    await withMockedCharacterSave(async (saved) => {
        const character: any = {
            name: 'GearHero',
            class: 'rogue',
            gender: 'male',
            level: 1,
            gearSets: [
                { name: 'GearSet 1', slots: [0, 101, 102, 103, 104, 105, 106] }
            ]
        };

        await GearSetHandler.handleRenameGearSet(createClient(character), createRenamePacket(0, 'Dungeon'));

        assert.equal(character.gearSets[0].name, 'Dungeon');
        assert.equal(saved.characters?.[0].gearSets[0].name, 'Dungeon');
    });
}

async function testCreateGearSetDoesNotOverwriteExistingSet(): Promise<void> {
    await withMockedCharacterSave(async (saved) => {
        const character: any = {
            name: 'GearHero',
            class: 'rogue',
            gender: 'male',
            level: 1,
            gearSets: [
                { name: 'First', slots: [0, 1, 2, 3, 4, 5, 6] }
            ]
        };

        await GearSetHandler.handleCreateGearSet(createClient(character), createIndexPacket(0));

        assert.deepEqual(character.gearSets, [
            { name: 'First', slots: [0, 1, 2, 3, 4, 5, 6] }
        ]);
        assert.equal(saved.characters, null);
    });
}

async function main(): Promise<void> {
    await testCreateGearSetStartsEmpty();
    await testOverwriteGearSetSnapshotsCurrentEquipmentAndKeepsExistingName();
    await testRenameGearSetPersistsName();
    await testCreateGearSetDoesNotOverwriteExistingSet();
    console.log('gear_set_persistence_regression: ok');
}

main().catch((error) => {
    console.error('gear_set_persistence_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
