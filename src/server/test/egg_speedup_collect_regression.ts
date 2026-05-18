import { strict as assert } from 'assert';
import path from 'path';
import { Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { PetConfig } from '../core/PetConfig';
import { PetHandler } from '../handlers/PetHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { ConsumableID } from '../data/runtime/Consumables';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    userId: number;
    character: Character;
    characters: Character[];
    sentPackets: SentPacket[];
    sendBitBuffer(id: number, bb: BitBuffer): void;
};

function createCharacter(): Character {
    return {
        name: 'NeoEgg',
        class: 'Paladin',
        gender: 'male',
        level: 20,
        gold: 100000,
        mammothIdols: 50,
        showHigher: false,
        pets: [],
        trainingPet: [],
        OwnedEggsID: ['1', '5'] as unknown as number[],
        EggHachery: {
            EggID: '5',
            ReadyTime: Math.floor(Date.now() / 1000) + 86400,
            slotIndex: '1'
        },
        activeEggCount: 1,
        EggResetTime: Math.floor(Date.now() / 1000) + 3600,
        CurrentLevel: { name: 'CraftTown', x: 360, y: 1460 },
        PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 }
    };
}

function createClient(): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = createCharacter();

    return {
        userId: 7,
        character,
        characters: [character],
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createEggSpeedupPacket(idolCost: number): Buffer {
    const bb = new BitBuffer();
    bb.writeMethod9(idolCost);
    return bb.toBuffer();
}

function parseConsumableUpdate(payload: Buffer): { consumableId: number; count: number } {
    const br = new BitReader(payload);
    return {
        consumableId: br.readMethod6(5),
        count: br.readMethod4()
    };
}

function parseConsumableReward(payload: Buffer): { consumableId: number; amount: number; suppress: boolean } {
    const br = new BitReader(payload);
    return {
        consumableId: br.readMethod6(5),
        amount: br.readMethod4(),
        suppress: br.readMethod15()
    };
}

function getCompleteCollectiblePetCollection(): Array<{ typeID: number; special_id: number; level: number; xp: number }> {
    const collectiblePetIds = PetConfig.PET_TYPES
        .map((pet) => ({
            id: Number(pet?.PetID ?? 0),
            name: String(pet?.PetName ?? '')
        }))
        .filter((pet) => pet.id > 0 && pet.name !== 'CodexDragon')
        .map((pet) => pet.id);

    assert.equal(collectiblePetIds.length, 70, 'test fixture should match the 70 collectible pet types');
    return collectiblePetIds.map((typeID, index) => ({
        typeID,
        special_id: index + 1,
        level: 1,
        xp: 0
    }));
}

async function withMockedCharacterSave<T>(fn: () => Promise<T>): Promise<T> {
    const originalLoadCharacters = JsonAdapter.prototype.loadCharacters;
    const originalSaveCharacters = JsonAdapter.prototype.saveCharacters;
    JsonAdapter.prototype.loadCharacters = async function(userId: number): Promise<Character[]> {
        assert.equal(userId, 7);
        return [createCharacter()];
    };
    JsonAdapter.prototype.saveCharacters = async function(userId: number, characters: Character[]): Promise<void> {
        assert.equal(userId, 7);
        assert.ok(Array.isArray(characters));
    };

    try {
        return await fn();
    } finally {
        JsonAdapter.prototype.loadCharacters = originalLoadCharacters;
        JsonAdapter.prototype.saveCharacters = originalSaveCharacters;
    }
}

async function testEggSpeedupAndCollectAcceptStringBackedIds(): Promise<void> {
    const client = createClient();
    const expectedEggPets = new Set(
        PetConfig.getHatchablePetsForEgg(5).map((pet) => Number(pet?.PetID ?? 0))
    );

    await withMockedCharacterSave(async () => {
        await PetHandler.handleEggSpeedUp(client as never, createEggSpeedupPacket(13));
    });

    assert.equal(client.character.mammothIdols, 37, 'speedup should deduct the idol cost');
    assert.equal(Number(client.character.EggHachery?.ReadyTime ?? -1), 0, 'speedup should mark the egg as ready');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xE7), true, 'speedup should replay the hatch-start packet');

    await withMockedCharacterSave(async () => {
        await PetHandler.handleCollectHatchedEgg(client as never, Buffer.alloc(0));
    });

    assert.equal(client.character.pets?.length ?? 0, 1, 'collect should grant the hatched pet');
    assert.equal(
        expectedEggPets.has(Number(client.character.pets?.[0]?.typeID ?? 0)),
        true,
        'collect should grant a valid hatch result for the egg type'
    );
    assert.deepEqual(client.character.OwnedEggsID, [1], 'collect should remove the hatched egg slot');
    assert.equal(Number(client.character.EggHachery?.EggID ?? -1), 0, 'collect should reset the hatchery state');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x37), true, 'collect should send the new pet reward packet');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xE5), true, 'collect should refresh hatchery contents');
}

async function testCollectHatchedEggGrantsPetFoodWhenAllPetsOwned(): Promise<void> {
    const client = createClient();
    client.character.pets = getCompleteCollectiblePetCollection();
    client.character.consumables = [];
    client.character.EggHachery = {
        EggID: 5,
        ReadyTime: 0,
        slotIndex: 1
    };

    const initialPetCount = client.character.pets.length;

    await withMockedCharacterSave(async () => {
        await PetHandler.handleCollectHatchedEgg(client as never, Buffer.alloc(0));
    });

    assert.equal(client.character.pets.length, initialPetCount, 'complete pet collections should not receive duplicate pets from eggs');
    assert.deepEqual(client.character.OwnedEggsID, [1], 'hatched egg should still be consumed');
    assert.equal(Number(client.character.EggHachery?.EggID ?? -1), 0, 'hatchery should reset after Pet Food fallback');
    assert.deepEqual(client.character.consumables, [
        {
            consumableID: ConsumableID.PetFood,
            count: 1
        }
    ]);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x37), false, 'Pet Food fallback should not send a new pet packet');

    const updatePacket = client.sentPackets.find((packet) => packet.id === 0x10C);
    const rewardPacket = client.sentPackets.find((packet) => packet.id === 0x10B);
    assert.ok(updatePacket, 'Pet Food fallback should refresh consumable inventory');
    assert.ok(rewardPacket, 'Pet Food fallback should send a reward packet');
    assert.deepEqual(parseConsumableUpdate(updatePacket!.payload), {
        consumableId: ConsumableID.PetFood,
        count: 1
    });
    assert.deepEqual(parseConsumableReward(rewardPacket!.payload), {
        consumableId: ConsumableID.PetFood,
        amount: 1,
        suppress: false
    });
    assert.equal(client.sentPackets.some((packet) => packet.id === 0xE5), true, 'collect should refresh hatchery contents');
}

async function main(): Promise<void> {
    PetConfig.load(path.resolve(__dirname, '..', 'data'));
    await testEggSpeedupAndCollectAcceptStringBackedIds();
    await testCollectHatchedEggGrantsPetFoodWhenAllPetsOwned();
    console.log('egg_speedup_collect_regression: ok');
}

void main().catch((error) => {
    console.error('egg_speedup_collect_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
