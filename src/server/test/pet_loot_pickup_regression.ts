import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { PetConfig } from '../core/PetConfig';
import { PetHandler } from '../handlers/PetHandler';
import { RewardHandler } from '../handlers/RewardHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

/**
 * Every reward type is a walk-over pickup. The loot pet fetches gold by physically running over it
 * client-side (Loot.method_1300, see patch-dungeonblitz-pet-fetches-loot.ts), so the server never
 * credits anything at drop time — not gold, and no longer materials either.
 */

type SentPacket = { id: number; payload: Buffer };

const LOOT_PET_ID = 72;
const LOOTDROP_PACKET = 0x32;
const GOLD_REWARD_PACKET = 0x35;
const MATERIAL_REWARD_PACKET = 0x34;

function ensureDataLoaded(): void {
    if (PetConfig.PET_TYPES.length === 0) {
        const sourceDataDir = path.resolve(__dirname, '../data');
        const compiledDataDir = path.resolve(__dirname, '../../data');
        PetConfig.load(fs.existsSync(path.join(sourceDataDir, 'pet_types.json')) ? sourceDataDir : compiledDataDir);
    }
}

function createFakeClient(character: any): any {
    const sentPackets: SentPacket[] = [];
    return {
        userId: null,
        token: 1,
        character,
        characters: [character],
        currentLevel: 'NewbieRoad',
        clientEntID: 42,
        entities: new Map(),
        pendingLoot: new Map<number, any>(),
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createCharacter(petTypeId: number): any {
    return {
        name: 'LootPetTester',
        gold: 0,
        materials: [],
        pets: petTypeId > 0 ? [{ typeID: petTypeId, special_id: 900, level: 10, xp: 0 }] : [],
        activePet: petTypeId > 0 ? { typeID: petTypeId, special_id: 900 } : { typeID: 0, special_id: 0 },
        restingPets: []
    };
}

function spawnLoot(client: any, reward: Record<string, number>): void {
    (RewardHandler as any).spawnLoot(client, 100, 200, reward, 0, 0, { reason: 'chest', caller: 'regression' });
}

function testNoServerSideAutoCollectionSurvives(): void {
    for (const name of ['isLootMagnetReward', 'grantMagnetCollectedLoot', 'resolveMagnetGoldDropPosition']) {
        assert.equal(
            typeof (RewardHandler as any)[name],
            'undefined',
            `${name} must stay gone: loot is claimed by walking over it, never credited at drop time`
        );
    }
    assert.equal(
        typeof (PetHandler as any).hasActiveLootMagnetPet,
        'undefined',
        'no pet shortcuts the ground drop any more'
    );
}

function testMaterialsDropOnTheGroundWithTheLootPetOut(): void {
    const client = createFakeClient(createCharacter(LOOT_PET_ID));

    spawnLoot(client, { material: 17 });

    assert.deepEqual(client.character.materials, [], 'materials must never be auto-added to the bag');
    assert.equal(client.pendingLoot.size, 1, 'a material waits to be walked over like any other drop');
    assert.equal(
        client.sentPackets.filter((packet: SentPacket) => packet.id === LOOTDROP_PACKET).length,
        1
    );
    assert.equal(
        client.sentPackets.some((packet: SentPacket) => packet.id === MATERIAL_REWARD_PACKET),
        false,
        'no material reward packet should fire at drop time'
    );
}

function testMaterialsDropOnTheGroundWithNoPetOut(): void {
    const character = createCharacter(1);
    character.pets.push({ typeID: LOOT_PET_ID, special_id: 901, level: 5, xp: 0 });
    character.restingPets = [{ typeID: LOOT_PET_ID, special_id: 901 }];
    const client = createFakeClient(character);

    spawnLoot(client, { material: 17 });

    assert.deepEqual(client.character.materials, []);
    assert.equal(client.pendingLoot.size, 1);
}

function testGoldDropsOnTheGroundForEitherCollector(): void {
    const client = createFakeClient(createCharacter(LOOT_PET_ID));

    spawnLoot(client, { gold: 250 });

    assert.equal(client.character.gold, 0, 'gold stays uncredited until pet or player walks over it');
    assert.equal(client.pendingLoot.size, 1, 'gold keeps its normal walk-over pickup');
    assert.equal(
        client.sentPackets.filter((packet: SentPacket) => packet.id === LOOTDROP_PACKET).length,
        1
    );
    assert.equal(
        client.sentPackets.some((packet: SentPacket) => packet.id === GOLD_REWARD_PACKET),
        false,
        'no gold reward packet should fire at drop time'
    );
}

function testEveryRewardTypeStillDropsOnTheGround(): void {
    const client = createFakeClient(createCharacter(LOOT_PET_ID));

    spawnLoot(client, { gear: 5, tier: 1 });
    spawnLoot(client, { health: 40 });
    spawnLoot(client, { dye: 3 });
    spawnLoot(client, { material: 17 });
    spawnLoot(client, { gold: 250 });

    assert.equal(client.pendingLoot.size, 5, 'nothing is collected for the player at drop time');
    assert.equal(
        client.sentPackets.filter((packet: SentPacket) => packet.id === LOOTDROP_PACKET).length,
        5
    );
}

function testRepeatedMaterialDropsEachGetTheirOwnPickup(): void {
    const client = createFakeClient(createCharacter(LOOT_PET_ID));

    spawnLoot(client, { material: 17 });
    spawnLoot(client, { material: 17 });
    spawnLoot(client, { material: 18 });

    assert.deepEqual(client.character.materials, []);
    assert.equal(client.pendingLoot.size, 3);
}

function main(): void {
    ensureDataLoaded();
    testNoServerSideAutoCollectionSurvives();
    testMaterialsDropOnTheGroundWithTheLootPetOut();
    testMaterialsDropOnTheGroundWithNoPetOut();
    testGoldDropsOnTheGroundForEitherCollector();
    testEveryRewardTypeStillDropsOnTheGround();
    testRepeatedMaterialDropsEachGetTheirOwnPickup();
    console.log('pet_loot_pickup_regression passed');
}

main();
