import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { GameData } from '../core/GameData';
import { PetConfig } from '../core/PetConfig';
import { MissionHandler } from '../handlers/MissionHandler';
import { PetHandler } from '../handlers/PetHandler';
import { RewardHandler } from '../handlers/RewardHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = { id: number; payload: Buffer };

function ensureDataLoaded(): void {
    const sourceDataDir = path.resolve(__dirname, '../data');
    const compiledDataDir = path.resolve(__dirname, '../../data');
    const dataDir = fs.existsSync(path.join(sourceDataDir, 'pet_types.json'))
        ? sourceDataDir
        : compiledDataDir;

    if (PetConfig.PET_TYPES.length === 0) {
        PetConfig.load(dataDir);
    }
    if (GameData.PLAYER_XP_THRESHOLDS.length === 0) {
        GameData.load(dataDir);
    }
}

function createClient(options: { activeExpPet?: boolean; passiveExpPet?: boolean } = {}): any {
    const sentPackets: SentPacket[] = [];
    const pets: any[] = [];
    const restingPets: any[] = [];
    let activePet: any = {};

    if (options.activeExpPet) {
        pets.push({ typeID: 43, special_id: 1001, level: 10, xp: 0 });
        activePet = { typeID: 43, special_id: 1001 };
    }
    if (options.passiveExpPet) {
        pets.push({ typeID: 44, special_id: 1002, level: 5, xp: 0 });
        restingPets.push({ typeID: 44, special_id: 1002 });
    }

    const character = {
        name: 'PetBonusTester',
        class: 'Mage',
        level: 1,
        xp: 0,
        gold: 0,
        pets,
        activePet,
        restingPets,
        equippedGears: [],
        consumables: []
    };

    return {
        token: 7001,
        userId: null,
        currentLevel: 'NewbieRoad',
        currentRoomId: 1,
        playerSpawned: true,
        clientEntID: 0,
        character,
        characters: [character],
        entities: new Map<number, any>(),
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, payload: BitBuffer) {
            sentPackets.push({ id, payload: payload.toBuffer() });
        }
    };
}

function readAmount(client: any, packetId: number): number {
    const packet = client.sentPackets.find((entry: SentPacket) => entry.id === packetId);
    assert.ok(packet, `expected packet 0x${packetId.toString(16)}`);
    return new BitReader(packet.payload).readMethod4();
}

function testActiveExpPetBoostsPlayerAndPetXp(): void {
    const client = createClient({ activeExpPet: true });

    const granted = RewardHandler.grantExperience(client, 100);

    assert.equal(granted, 119, 'level 10 EXP pet should add its 19% bonus');
    assert.equal(client.character.xp, 119);
    assert.equal(client.character.level, 2, 'boosted XP should update the player level');
    assert.equal(client.character.pets[0].xp, 119, 'active pet XP should follow the final player XP grant');
    assert.equal(readAmount(client, 0x2B), 119, 'player XP packet should contain the boosted amount');
    assert.equal(readAmount(client, 0xF2), 119, 'pet XP packet should contain the boosted amount');
    assert.ok(
        client.sentPackets.some((entry: SentPacket) => entry.id === 0xFB),
        'a level change should request fresh player combat stats'
    );
}

function testPassiveExpPetAlsoContributes(): void {
    const client = createClient({ passiveExpPet: true });

    const granted = RewardHandler.grantExperience(client, 100);

    assert.equal(granted, 114, 'level 5 passive EXP pet should add its 14% bonus');
    assert.equal(client.character.xp, 114);
    assert.equal(
        client.sentPackets.some((entry: SentPacket) => entry.id === 0xF2),
        false,
        'only the active pet should receive pet XP'
    );
}

function testMissionXpUsesThePetAwareGrantPath(): void {
    const client = createClient({ activeExpPet: true });

    (MissionHandler as any).grantMissionRewards(client, {
        ExpRewardValue: 100,
        GoldRewardValue: 0
    });

    assert.equal(client.character.xp, 119, 'mission XP should include the equipped EXP-pet bonus');
    assert.equal(readAmount(client, 0x2B), 119);
}

function testAllPetBonusKindsResolveFromEquippedSlots(): void {
    const client = createClient({ activeExpPet: true, passiveExpPet: true });
    client.character.pets.push(
        { typeID: 15, special_id: 1003, level: 10, xp: 0 },
        { typeID: 29, special_id: 1004, level: 10, xp: 0 }
    );
    client.character.restingPets.push(
        { typeID: 15, special_id: 1003 },
        { typeID: 29, special_id: 1004 }
    );

    const bonuses = PetHandler.getEquippedPetBonusRates(client.character);

    assert.equal(bonuses.expBonus, 0.33);
    assert.equal(bonuses.goldFind, 0.19);
    assert.equal(bonuses.craftFind, 0.19);
    assert.equal(bonuses.itemFind, 0);
}

function main(): void {
    ensureDataLoaded();
    testActiveExpPetBoostsPlayerAndPetXp();
    testPassiveExpPetAlsoContributes();
    testMissionXpUsesThePetAwareGrantPath();
    testAllPetBonusKindsResolveFromEquippedSlots();
    console.log('pet_bonus_regression passed');
}

main();
