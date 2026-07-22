import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { PetConfig } from '../core/PetConfig';
import { PetHandler } from '../handlers/PetHandler';
import { RewardHandler } from '../handlers/RewardHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type SentPacket = { id: number; payload: Buffer };

const MAGNET_PET_ID = 72;
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
        name: 'MagnetTester',
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

function magnetGoldPosition(client: any, fallback: { x: number; y: number }): { x: number; y: number } {
    return (RewardHandler as any).resolveMagnetGoldDropPosition(client, fallback);
}

function testMagnetPetIsRecognizedOnlyWhenEquipped(): void {
    assert.ok(
        PetConfig.getPetDef(MAGNET_PET_ID)?.LootMagnet,
        `pet ${MAGNET_PET_ID} should be flagged as a loot magnet in pet_types.json`
    );
    assert.equal(PetHandler.hasEquippedLootMagnetPet(createCharacter(MAGNET_PET_ID)), true);
    assert.equal(PetHandler.hasEquippedLootMagnetPet(createCharacter(1)), false);
    assert.equal(PetHandler.hasEquippedLootMagnetPet(createCharacter(0)), false);
}

function testMagnetPetInRestingSlotStillCollects(): void {
    const character = createCharacter(1);
    character.pets.push({ typeID: MAGNET_PET_ID, special_id: 901, level: 5, xp: 0 });
    character.restingPets = [{ typeID: MAGNET_PET_ID, special_id: 901 }];

    assert.equal(
        PetHandler.hasEquippedLootMagnetPet(character),
        true,
        'passive pet slots grant their bonus, so the magnet should work from a resting slot too'
    );
}

function testMaterialsAreGrantedWithoutAGroundDrop(): void {
    const client = createFakeClient(createCharacter(MAGNET_PET_ID));

    spawnLoot(client, { material: 17 });

    assert.deepEqual(client.character.materials, [{ materialID: 17, count: 1 }]);
    assert.equal(client.pendingLoot.size, 0, 'magnet loot should never wait for a walk-over pickup');
    assert.equal(
        client.sentPackets.some((packet: SentPacket) => packet.id === LOOTDROP_PACKET),
        false,
        'magnet loot should not spawn a lootdrop on the ground'
    );
    assert.equal(client.sentPackets.some((packet: SentPacket) => packet.id === MATERIAL_REWARD_PACKET), true);
}

function testGoldStillDropsOnTheGroundForTheVisiblePickup(): void {
    const client = createFakeClient(createCharacter(MAGNET_PET_ID));

    spawnLoot(client, { gold: 250 });

    assert.equal(client.character.gold, 0, 'gold must stay uncredited until the player walks over it');
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

function testGoldDropsAtThePlayersFeetWhenTheMagnetPetIsEquipped(): void {
    const killSite = { x: 4000, y: 900 };
    const client = createFakeClient(createCharacter(MAGNET_PET_ID));
    client.entities = new Map([[42, { id: 42, x: 1234, y: 567 }]]);

    assert.deepEqual(
        magnetGoldPosition(client, killSite),
        { x: 1234, y: 567 },
        'gold should land on the player so the client picks it up immediately'
    );
}

function testGoldKeepsTheKillSiteWithoutTheMagnetPet(): void {
    const killSite = { x: 4000, y: 900 };
    const client = createFakeClient(createCharacter(1));
    client.entities = new Map([[42, { id: 42, x: 1234, y: 567 }]]);

    assert.deepEqual(magnetGoldPosition(client, killSite), killSite);
}

function testGoldFallsBackToTheKillSiteWhenPositionIsUnknown(): void {
    const killSite = { x: 4000, y: 900 };

    const noEntities = createFakeClient(createCharacter(MAGNET_PET_ID));
    noEntities.entities = new Map();
    assert.deepEqual(magnetGoldPosition(noEntities, killSite), killSite, 'missing entity must not drop loot at 0,0');

    const unspawned = createFakeClient(createCharacter(MAGNET_PET_ID));
    unspawned.entities = new Map([[42, { id: 42, x: 0, y: 0 }]]);
    assert.deepEqual(unspawned.entities.size, 1);
    assert.deepEqual(magnetGoldPosition(unspawned, killSite), killSite, 'an unpositioned entity must not drop loot at 0,0');

    const noEntityId = createFakeClient(createCharacter(MAGNET_PET_ID));
    noEntityId.clientEntID = 0;
    noEntityId.entities = new Map([[42, { id: 42, x: 1234, y: 567 }]]);
    assert.deepEqual(magnetGoldPosition(noEntityId, killSite), killSite);
}

function testRepeatedMaterialDropsStackOnTheSameEntry(): void {
    const client = createFakeClient(createCharacter(MAGNET_PET_ID));

    spawnLoot(client, { material: 17 });
    spawnLoot(client, { material: 17 });
    spawnLoot(client, { material: 18 });

    assert.deepEqual(client.character.materials, [
        { materialID: 17, count: 2 },
        { materialID: 18, count: 1 }
    ]);
}

function testGearHealthAndDyeStillDropOnTheGround(): void {
    const client = createFakeClient(createCharacter(MAGNET_PET_ID));

    spawnLoot(client, { gear: 5, tier: 1 });
    spawnLoot(client, { health: 40 });
    spawnLoot(client, { dye: 3 });

    assert.equal(client.pendingLoot.size, 3, 'only materials are magnet-eligible');
    assert.equal(
        client.sentPackets.filter((packet: SentPacket) => packet.id === LOOTDROP_PACKET).length,
        3
    );
}

function testWithoutTheMagnetPetLootStillDropsNormally(): void {
    const client = createFakeClient(createCharacter(1));

    spawnLoot(client, { gold: 250 });
    spawnLoot(client, { material: 17 });

    assert.equal(client.character.gold, 0, 'gold must not be credited before pickup');
    assert.deepEqual(client.character.materials, []);
    assert.equal(client.pendingLoot.size, 2);
    assert.equal(
        client.sentPackets.filter((packet: SentPacket) => packet.id === LOOTDROP_PACKET).length,
        2
    );
}

function main(): void {
    ensureDataLoaded();
    testMagnetPetIsRecognizedOnlyWhenEquipped();
    testMagnetPetInRestingSlotStillCollects();
    testMaterialsAreGrantedWithoutAGroundDrop();
    testGoldStillDropsOnTheGroundForTheVisiblePickup();
    testGoldDropsAtThePlayersFeetWhenTheMagnetPetIsEquipped();
    testGoldKeepsTheKillSiteWithoutTheMagnetPet();
    testGoldFallsBackToTheKillSiteWhenPositionIsUnknown();
    testRepeatedMaterialDropsStackOnTheSameEntry();
    testGearHealthAndDyeStillDropOnTheGround();
    testWithoutTheMagnetPetLootStillDropsNormally();
    console.log('pet_loot_magnet_regression passed');
}

main();
