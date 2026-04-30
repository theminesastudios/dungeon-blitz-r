import { strict as assert } from 'assert';
import * as path from 'path';
import { Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { PetConfig } from '../core/PetConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { PetHandler } from '../handlers/PetHandler';
import { RewardHandler } from '../handlers/RewardHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    userId: number | null;
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    character: any;
    characters: Character[];
    authoritativeMaxHp: number;
    authoritativeCurrentHp: number;
    processedRewardSources: Set<string>;
    pendingLoot: Map<number, any>;
    knownEntityIds: Set<number>;
    entities: Map<number, any>;
    sentPackets: SentPacket[];
    send(id: number, payload: Buffer): void;
    sendBitBuffer(id: number, payload: BitBuffer): void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '..', 'data');
    if (PetConfig.PET_TYPES.length === 0 || PetConfig.EGG_TYPES.length === 0) {
        PetConfig.load(dataDir);
    }
    if (GameData.CONSUMABLES.length === 0) {
        GameData.load(dataDir);
    }
}

function createRewardClient(): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character: any = {
        name: 'Alpha',
        class: 'Mage',
        gender: 'male',
        level: 20,
        xp: 0,
        gold: 0,
        materials: [],
        inventoryGears: [],
        equippedGears: [],
        OwnedDyes: [],
        pets: [
            { typeID: 15, special_id: 7, level: 1, xp: 0 }
        ],
        activePet: {
            typeID: 15,
            special_id: 7
        }
    };

    return {
        token: 1,
        userId: null,
        currentLevel: 'TutorialDungeon',
        levelInstanceId: '',
        currentRoomId: 1,
        playerSpawned: true,
        clientEntID: 1001,
        character,
        characters: [character],
        authoritativeMaxHp: 100,
        authoritativeCurrentHp: 100,
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
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

function createCharmRewardClient(): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character: any = {
        name: 'Gamma',
        class: 'Paladin',
        gender: 'male',
        level: 20,
        xp: 0,
        gold: 0,
        materials: [],
        inventoryGears: [],
        equippedGears: [
            {
                gearID: 1177,
                tier: 0,
                runes: [15, 0, 0],
                colors: [0, 0]
            }
        ],
        OwnedDyes: [],
        pets: [],
        activePet: {
            typeID: 0,
            special_id: 0
        }
    };

    return {
        token: 3,
        userId: null,
        currentLevel: 'TutorialDungeon',
        levelInstanceId: '',
        currentRoomId: 1,
        playerSpawned: true,
        clientEntID: 1003,
        character,
        characters: [character],
        authoritativeMaxHp: 100,
        authoritativeCurrentHp: 100,
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
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

function createConsumableClient(): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character: any = {
        name: 'Beta',
        class: 'Paladin',
        gender: 'male',
        level: 20,
        gold: 1000,
        mammothIdols: 0,
        showHigher: false,
        pets: [
            { typeID: 1, special_id: 4, level: 3, xp: 500 }
        ],
        activePet: {
            typeID: 1,
            special_id: 4
        },
        consumables: [
            { consumableID: 10, count: 1 }
        ]
    };

    return {
        token: 2,
        userId: 2,
        currentLevel: 'CraftTown',
        levelInstanceId: '',
        currentRoomId: 1,
        playerSpawned: true,
        clientEntID: 1002,
        character,
        characters: [character],
        authoritativeMaxHp: 100,
        authoritativeCurrentHp: 100,
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
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

function buildGrantRewardPayload(sourceId: number, gold: number, exp: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(0);
    bb.writeMethod4(sourceId);
    bb.writeMethod15(false);
    bb.writeMethod309(1);
    bb.writeMethod15(false);
    bb.writeMethod309(1);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod4(exp);
    bb.writeMethod4(0);
    bb.writeMethod4(0);
    bb.writeMethod4(gold);
    bb.writeMethod24(120);
    bb.writeMethod24(220);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildUseConsumablePacket(consumableId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod20(5, consumableId);
    return bb.toBuffer();
}

function addLevelEntity(client: FakeClient, entity: any): void {
    const scope = getClientLevelScope(client as never);
    let levelMap = GlobalState.levelEntities.get(scope);
    if (!levelMap) {
        levelMap = new Map<number, any>();
        GlobalState.levelEntities.set(scope, levelMap);
    }
    levelMap.set(Number(entity.id), entity);
}

function setContributors(levelScope: string, sourceId: number, contributors: string[]): void {
    const key = `${levelScope}:${sourceId}:0`;
    const contributionMap = new Map<string, number>();
    for (const contributor of contributors) {
        contributionMap.set(contributor.toLowerCase(), 100);
    }
    GlobalState.combatContributions.set(key, contributionMap);
}

async function withMockedCharacterSave<T>(fn: () => Promise<T>): Promise<T> {
    const originalSaveCharacters = JsonAdapter.prototype.saveCharacters;
    JsonAdapter.prototype.saveCharacters = async function(): Promise<void> {
        return;
    };

    try {
        return await fn();
    } finally {
        JsonAdapter.prototype.saveCharacters = originalSaveCharacters;
    }
}

async function testRewardHandlerAppliesActivePetBonuses(): Promise<void> {
    const client = createRewardClient();
    GlobalState.sessionsByToken.set(client.token, client as never);

    const sourceId = 9100;
    addLevelEntity(client, {
        id: sourceId,
        name: 'IntroGoblin',
        isPlayer: false,
        team: 2,
        x: 120,
        y: 220
    });
    setContributors(getClientLevelScope(client as never), sourceId, ['alpha']);

    await RewardHandler.handleGrantReward(client as never, buildGrantRewardPayload(sourceId, 25, 20));

    const loot = Array.from(client.pendingLoot.values())[0];
    assert.equal(loot?.gold, 28, 'gold-find pet should increase gold rewards by pet level percent');
    assert.equal(client.character.xp, 20, 'gold-find pet should not alter XP rewards');
}

async function testRewardHandlerAppliesEquippedCharmFindBonuses(): Promise<void> {
    const client = createCharmRewardClient();
    GlobalState.sessionsByToken.set(client.token, client as never);

    const sourceId = 9200;
    addLevelEntity(client, {
        id: sourceId,
        name: 'IntroGoblin',
        isPlayer: false,
        team: 2,
        x: 120,
        y: 220
    });
    setContributors(getClientLevelScope(client as never), sourceId, ['gamma']);

    await RewardHandler.handleGrantReward(client as never, buildGrantRewardPayload(sourceId, 100, 20));

    const loot = Array.from(client.pendingLoot.values())[0];
    assert.equal(loot?.gold, 103, 'equipped gold-find charm should increase gold rewards by its rune bonus');
}

async function testPetFoodUsageLevelsAndUpdatesActivePet(): Promise<void> {
    const client = createConsumableClient();

    await withMockedCharacterSave(async () => {
        await PetHandler.handleUseConsumable(client as never, buildUseConsumablePacket(10));
    });

    const pet = client.character.pets[0];
    assert.equal(pet.xp, 60500, 'rare pet food should add its XP magnitude');
    assert.equal(pet.level, 4, 'rare pet food should grant one pet level');
    assert.equal(client.character.activePet.level, 4, 'active pet snapshot should stay in sync');
    assert.equal(client.character.consumables[0].count, 0, 'pet food should be consumed');

    const updatePacket = client.sentPackets.find((packet) => packet.id === 0x10C);
    assert.ok(updatePacket, 'pet food use should refresh consumable count');
    const updateReader = new BitReader(updatePacket!.payload);
    assert.equal(updateReader.readMethod6(5), 10);
    assert.equal(updateReader.readMethod4(), 0);

    const petXpPacket = client.sentPackets.find((packet) => packet.id === 0xF2);
    assert.ok(petXpPacket, 'pet food use should send a pet XP update');
    const petXpReader = new BitReader(petXpPacket!.payload);
    assert.equal(petXpReader.readMethod4(), 60000, 'pet XP update should send XP delta, not total XP');
}

async function main(): Promise<void> {
    ensureDataLoaded();

    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const levelEntities = new Map(GlobalState.levelEntities);
    const combatContributions = new Map(GlobalState.combatContributions);

    try {
        await testRewardHandlerAppliesActivePetBonuses();
        await testRewardHandlerAppliesEquippedCharmFindBonuses();
        await testPetFoodUsageLevelsAndUpdatesActivePet();
        console.log('pet_system_regression: ok');
    } finally {
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.levelEntities = levelEntities;
        GlobalState.combatContributions = combatContributions;
    }
}

void main().catch((error) => {
    console.error('pet_system_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
