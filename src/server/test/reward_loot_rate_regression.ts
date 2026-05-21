import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { getClientLevelScope } from '../core/LevelScope';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { RewardHandler } from '../handlers/RewardHandler';

type FakeClient = {
    token: number;
    userId: number | null;
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    character: any;
    characters: any[];
    authoritativeMaxHp: number;
    authoritativeCurrentHp: number;
    processedRewardSources: Set<string>;
    pendingLoot: Map<number, any>;
    knownEntityIds: Set<number>;
    entities: Map<number, any>;
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, payload: BitBuffer) => void;
};

function ensureGameDataLoaded(): void {
    const dataDirCandidates = [
        path.resolve(__dirname, '../data'),
        path.resolve(__dirname, '../../data')
    ];
    const dataDir = dataDirCandidates.find((candidate) => fs.existsSync(path.join(candidate, 'EntTypes.json')))
        ?? dataDirCandidates[0];
    if (!GameData.getEntType('GoblinBrute')) {
        GameData.load(dataDir);
    }
}

function createFakeClient(token: number, name: string): FakeClient {
    return {
        token,
        userId: null,
        currentLevel: 'GoblinRiverDungeon',
        levelInstanceId: '',
        currentRoomId: 1,
        playerSpawned: true,
        clientEntID: token + 1000,
        character: {
            name,
            level: 20,
            class: 'Mage',
            xp: 0,
            gold: 0,
            materials: [],
            inventoryGears: [],
            equippedGears: [],
            OwnedDyes: []
        },
        characters: [],
        authoritativeMaxHp: 100,
        authoritativeCurrentHp: 100,
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entities: new Map<number, any>(),
        send() {},
        sendBitBuffer() {}
    };
}

function buildGrantRewardPayload(
    sourceId: number,
    options: {
        dropItem?: boolean;
        itemMultiplier?: number;
        dropGear?: boolean;
        gearMultiplier?: number;
        dropMaterial?: boolean;
    } = {}
): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(0);
    bb.writeMethod4(sourceId);
    bb.writeMethod15(Boolean(options.dropItem));
    bb.writeMethod309(options.itemMultiplier ?? 1);
    bb.writeMethod15(Boolean(options.dropGear));
    bb.writeMethod309(options.gearMultiplier ?? 1);
    bb.writeMethod15(Boolean(options.dropMaterial));
    bb.writeMethod15(false);
    bb.writeMethod4(0);
    bb.writeMethod4(0);
    bb.writeMethod4(0);
    bb.writeMethod4(0);
    bb.writeMethod24(120);
    bb.writeMethod24(220);
    bb.writeMethod15(false);
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

async function withMockedRandom(values: number[], fn: () => Promise<void>): Promise<void> {
    const originalRandom = Math.random;
    let index = 0;
    Math.random = () => values[Math.min(index++, values.length - 1)] ?? 0;

    try {
        await fn();
    } finally {
        Math.random = originalRandom;
    }
}

function findLoot(client: FakeClient, key: 'gear' | 'material' | 'dye'): any {
    return Array.from(client.pendingLoot.values()).find((reward) => Number(reward?.[key] ?? 0) > 0) ?? null;
}

function hasItemLoot(client: FakeClient): boolean {
    return Array.from(client.pendingLoot.values()).some((reward) =>
        Number(reward?.gear ?? 0) > 0 ||
        Number(reward?.material ?? 0) > 0 ||
        Number(reward?.dye ?? 0) > 0
    );
}

function hasGoldLoot(client: FakeClient): boolean {
    return Array.from(client.pendingLoot.values()).some((reward) => Number(reward?.gold ?? 0) > 0);
}

function getMaterialRarity(materialId: number): string {
    return String(GameData.MATERIALS.find((material) => Number(material.MaterialID ?? 0) === materialId)?.Rarity ?? '');
}

function assertTierWeights(
    actual: Array<{ tier: number; weight: number }>,
    expected: Array<{ tier: number; weight: number }>,
    label: string
): void {
    assert.equal(actual.length, expected.length, `${label} should define the expected number of rarity bands`);
    for (let index = 0; index < expected.length; index++) {
        assert.equal(actual[index]?.tier, expected[index]?.tier, `${label} tier ${index} should match`);
        assert.ok(
            Math.abs(Number(actual[index]?.weight ?? 0) - expected[index]!.weight) < 1e-12,
            `${label} tier ${index} weight should match`
        );
    }
}

function testGearRarityWeightsScaleByRank(): void {
    const normal = createFakeClient(9, 'Iota');
    const hard = createFakeClient(10, 'Kappa');
    hard.currentLevel = 'GoblinRiverDungeonHard';

    const getWeights = (client: FakeClient, rank: string) =>
        (RewardHandler as any).getGearTierWeights(client as never, rank) as Array<{ tier: number; weight: number }>;

    assertTierWeights(getWeights(normal, 'Lieutenant'), [
        { tier: 0, weight: 1 - ((1 / 250) / 0.03) },
        { tier: 1, weight: (1 / 250) / 0.03 },
        { tier: 2, weight: 0 }
    ], 'normal lieutenant gear');
    assertTierWeights(getWeights(normal, 'MiniBoss'), [
        { tier: 0, weight: 1 - ((1 / 60) / 0.10) },
        { tier: 1, weight: (1 / 60) / 0.10 },
        { tier: 2, weight: 0 }
    ], 'normal miniboss gear');
    assertTierWeights(getWeights(normal, 'Boss'), [
        { tier: 0, weight: 1 - (1 / 15) },
        { tier: 1, weight: 1 / 15 },
        { tier: 2, weight: 0 }
    ], 'normal boss gear');

    assertTierWeights(getWeights(hard, 'Lieutenant'), [
        { tier: 0, weight: 1 - ((1 / 100) / 0.03) - ((1 / 333) / 0.03) },
        { tier: 1, weight: (1 / 100) / 0.03 },
        { tier: 2, weight: (1 / 333) / 0.03 }
    ], 'hard lieutenant gear');
    assertTierWeights(getWeights(hard, 'MiniBoss'), [
        { tier: 0, weight: 1 - ((1 / 40) / 0.10) - ((1 / 100) / 0.10) },
        { tier: 1, weight: (1 / 40) / 0.10 },
        { tier: 2, weight: (1 / 100) / 0.10 }
    ], 'hard miniboss gear');
    assertTierWeights(getWeights(hard, 'Boss'), [
        { tier: 0, weight: 1 - (1 / 5) - (1 / 25) },
        { tier: 1, weight: 1 / 5 },
        { tier: 2, weight: 1 / 25 }
    ], 'hard boss gear');

    assertTierWeights(getWeights(normal, 'MysteryRank'), [
        { tier: 0, weight: 1 },
        { tier: 1, weight: 0 },
        { tier: 2, weight: 0 }
    ], 'normal fallback gear');
    assertTierWeights(getWeights(hard, 'MysteryRank'), [
        { tier: 0, weight: 0.65 },
        { tier: 1, weight: 0.30 },
        { tier: 2, weight: 0.05 }
    ], 'hard fallback gear');
}

async function testSimpleLootMinionDoesNotDropGear(): Promise<void> {
    const alpha = createFakeClient(1, 'Alpha');
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);

    const sourceId = 9001;
    addLevelEntity(alpha, {
        id: sourceId,
        name: 'GoblinDagger',
        isPlayer: false,
        team: 2,
        x: 120,
        y: 220
    });
    setContributors(getClientLevelScope(alpha as never), sourceId, ['alpha']);

    await withMockedRandom([0.0, 0.0, 0.0, 0.0], async () => {
        await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, {
            dropItem: true,
            itemMultiplier: 10,
            dropGear: true
        }));
    });

    assert.equal(findLoot(alpha, 'gear'), null, 'SimpleLoot minions should not create gear lootdrops');
}

async function testRandomItemLieutenantUsesItemDropChanceForGear(): Promise<void> {
    const alpha = createFakeClient(2, 'Beta');
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);

    const sourceId = 9002;
    addLevelEntity(alpha, {
        id: sourceId,
        name: 'GoblinBrute',
        isPlayer: false,
        team: 2,
        x: 120,
        y: 220
    });
    setContributors(getClientLevelScope(alpha as never), sourceId, ['beta']);

    await withMockedRandom([0.5, 0.99, 0.05, 0.99], async () => {
        await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, {
            dropGear: false,
            dropItem: false
        }));
    });

    assert.equal(findLoot(alpha, 'gear'), null, 'Lieutenant gear should not drop when the 3% roll fails, even if the packet omitted the gear flag');

    alpha.pendingLoot.clear();
    alpha.processedRewardSources.clear();

    await withMockedRandom([0.5, 0.99, 0.02, 0.0, 0.99], async () => {
        await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, {
            dropGear: false,
            dropItem: false
        }));
    });

    assert.ok(findLoot(alpha, 'gear'), 'Lieutenant gear should still drop when the 3% roll succeeds and the packet omitted the gear flag');
}

async function testPacketMultiplierAlreadyIncludesGearFind(): Promise<void> {
    const alpha = createFakeClient(7, 'Eta');
    alpha.character.equippedGears = [{ gearID: 1177, tier: 0, runes: [1, 0, 0], colors: [0, 0] }];
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);

    const sourceId = 9007;
    addLevelEntity(alpha, {
        id: sourceId,
        name: 'GoblinBrute',
        isPlayer: false,
        team: 2,
        x: 120,
        y: 220
    });
    setContributors(getClientLevelScope(alpha as never), sourceId, ['eta']);

    await withMockedRandom([0.5, 0.99, 0.0424], async () => {
        await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, {
            itemMultiplier: 1.41,
            dropGear: true
        }));
    });

    assert.equal(
        findLoot(alpha, 'gear'),
        null,
        'gear chance should use the packet multiplier without adding server-side find again'
    );
}

async function testMapEnemiesDoNotDropItemLoot(): Promise<void> {
    const alpha = createFakeClient(8, 'Theta');
    alpha.currentLevel = 'NewbieRoad';
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);

    const sourceId = 9008;
    addLevelEntity(alpha, {
        id: sourceId,
        name: 'GoblinBoss1',
        isPlayer: false,
        team: 2,
        x: 120,
        y: 220
    });
    setContributors(getClientLevelScope(alpha as never), sourceId, ['theta']);

    await withMockedRandom([0.0, 0.0, 0.0, 0.0, 0.0, 0.0], async () => {
        await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, {
            dropItem: true,
            itemMultiplier: 10,
            dropGear: true,
            gearMultiplier: 10,
            dropMaterial: true
        }));
    });

    assert.equal(hasItemLoot(alpha), false, 'map enemies should not queue gear, material, or dye lootdrops');
}

async function testEnemyMaterialDropsWithoutExplicitDropFlag(): Promise<void> {
    const alpha = createFakeClient(3, 'Gamma');
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);

    const sourceId = 9003;
    addLevelEntity(alpha, {
        id: sourceId,
        name: 'GoblinBoss1',
        isPlayer: false,
        team: 2,
        x: 120,
        y: 220,
        hp: 0,
        maxHp: 100,
        dead: true
    });
    setContributors(getClientLevelScope(alpha as never), sourceId, ['gamma']);

    await withMockedRandom([0.0, 0.99, 0.0, 0.99], async () => {
        await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, {
            dropMaterial: false,
            gearMultiplier: 1
        }));
    });

    assert.ok(findLoot(alpha, 'material'), 'enemy material should still drop when the boss roll succeeds and the packet omitted the material flag');
}

async function testLiveEnemyStillUsesDungeonDropTablesForDefeatedPlayer(): Promise<void> {
    const alpha = createFakeClient(9, 'Iota');
    alpha.authoritativeCurrentHp = 0;
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);

    const sourceId = 9009;
    addLevelEntity(alpha, {
        id: sourceId,
        name: 'GoblinBoss1',
        isPlayer: false,
        team: 2,
        x: 120,
        y: 220,
        hp: 100,
        maxHp: 100,
        dead: false
    });
    setContributors(getClientLevelScope(alpha as never), sourceId, ['iota']);

    await withMockedRandom([0.0, 0.0, 0.0, 0.0, 0.0, 0.0], async () => {
        await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, {
            dropItem: false,
            dropGear: false,
            dropMaterial: false,
            itemMultiplier: 10,
            gearMultiplier: 10
        }));
    });

    assert.equal(hasItemLoot(alpha), true, 'live dungeon enemies should still use server-side item/material drop tables even when the player is defeated');
    assert.equal(hasGoldLoot(alpha), false, 'false reward packets should not fall through to fallback gold');
}

async function testLiveFixedItemEnemyStillUsesDungeonDropTablesWhenPacketHasNoItemFlags(): Promise<void> {
    const alpha = createFakeClient(10, 'Kappa');
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);

    const sourceId = 9010;
    addLevelEntity(alpha, {
        id: sourceId,
        name: 'GoblinBoss1',
        isPlayer: false,
        team: 2,
        x: 120,
        y: 220,
        hp: 100,
        maxHp: 100,
        dead: false
    });
    setContributors(getClientLevelScope(alpha as never), sourceId, ['kappa']);

    await withMockedRandom([0.0, 0.0, 0.0, 0.0, 0.0, 0.0], async () => {
        await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, {
            dropItem: false,
            dropGear: false,
            dropMaterial: false,
            itemMultiplier: 10,
            gearMultiplier: 10
        }));
    });

    assert.equal(hasItemLoot(alpha), true, 'FixedItem dungeon enemies should still use server-side item/material drop tables when packet flags are false');
    assert.equal(hasGoldLoot(alpha), false, 'false FixedItem reward packets should not fall through to fallback gold');
}

async function testGearRarityTracksValueTier(): Promise<void> {
    const alpha = createFakeClient(4, 'Delta');
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);

    const sourceId = 9004;
    addLevelEntity(alpha, {
        id: sourceId,
        name: 'GoblinBrute',
        isPlayer: false,
        team: 2,
        x: 120,
        y: 220
    });
    setContributors(getClientLevelScope(alpha as never), sourceId, ['delta']);

    await withMockedRandom([0.5, 0.99, 0.02, 0.0, 0.10], async () => {
        await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, {
            dropGear: true
        }));
    });
    assert.equal(findLoot(alpha, 'gear')?.tier, 0, 'random-item common gear should map to tier 0');

    alpha.pendingLoot.clear();
    alpha.processedRewardSources.clear();

    await withMockedRandom([0.5, 0.99, 0.02, 0.0, 0.80], async () => {
        await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, {
            dropGear: true
        }));
    });
    assert.equal(findLoot(alpha, 'gear')?.tier, 0, 'normal random-item gear should still map to tier 0');

    alpha.pendingLoot.clear();
    alpha.processedRewardSources.clear();
    alpha.currentLevel = 'GoblinRiverDungeonHard';
    GlobalState.levelEntities.clear();
    addLevelEntity(alpha, {
        id: sourceId,
        name: 'GoblinBoss2Hard',
        isPlayer: false,
        team: 2,
        x: 120,
        y: 220
    });
    setContributors(getClientLevelScope(alpha as never), sourceId, ['delta']);

    await withMockedRandom([0.0, 0.99, 0.0, 0.0, 0.80], async () => {
        await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, {
            dropGear: true
        }));
    });
    assert.equal(findLoot(alpha, 'gear')?.tier, 1, 'hard fixed-item bosses should be able to produce rare gear');

    alpha.pendingLoot.clear();
    alpha.processedRewardSources.clear();

    await withMockedRandom([0.0, 0.99, 0.0, 0.0, 0.99], async () => {
        await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, {
            dropGear: true
        }));
    });
    assert.equal(findLoot(alpha, 'gear')?.tier, 2, 'hard fixed-item bosses should be able to produce legendary gear');
}

async function testOwnedGearDoesNotDropAgain(): Promise<void> {
    const alpha = createFakeClient(6, 'Zeta');
    alpha.character.inventoryGears = [{ gearID: 796, tier: 0, runes: [0, 0, 0], colors: [0, 0] }];
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);

    const sourceId = 9006;
    addLevelEntity(alpha, {
        id: sourceId,
        name: 'GoblinBrute',
        isPlayer: false,
        team: 2,
        x: 120,
        y: 220
    });
    setContributors(getClientLevelScope(alpha as never), sourceId, ['zeta']);

    await withMockedRandom([0.5, 0.99, 0.02, 0.0, 0.1], async () => {
        await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, {
            dropGear: true
        }));
    });

    assert.equal(
        Array.from(alpha.pendingLoot.values()).some((reward) => Number(reward?.gear ?? 0) === 796),
        false,
        'already-owned gear should be excluded from future enemy drops'
    );
}

async function testMaterialRarityTracksValueTier(): Promise<void> {
    const alpha = createFakeClient(5, 'Epsilon');
    GlobalState.sessionsByToken.set(alpha.token, alpha as never);

    const sourceId = 9005;
    addLevelEntity(alpha, {
        id: sourceId,
        name: 'GoblinBoss1',
        isPlayer: false,
        team: 2,
        x: 120,
        y: 220,
        hp: 0,
        maxHp: 100,
        dead: true
    });
    setContributors(getClientLevelScope(alpha as never), sourceId, ['epsilon']);

    await withMockedRandom([0.5, 0.0, 0.10, 0.1], async () => {
        await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, {
            dropMaterial: true
        }));
    });
    assert.equal(getMaterialRarity(findLoot(alpha, 'material')?.material ?? 0), 'M', 'normal material roll should usually produce common material');

    alpha.pendingLoot.clear();
    alpha.processedRewardSources.clear();

    await withMockedRandom([0.5, 0.0, 0.90, 0.1], async () => {
        await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, {
            dropMaterial: true
        }));
    });
    assert.equal(getMaterialRarity(findLoot(alpha, 'material')?.material ?? 0), 'R', 'higher material rarity rolls should produce rare material');

    alpha.pendingLoot.clear();
    alpha.processedRewardSources.clear();
    alpha.currentLevel = 'GoblinRiverDungeonHard';
    GlobalState.levelEntities.clear();
    addLevelEntity(alpha, {
        id: sourceId,
        name: 'GoblinBoss1Hard',
        isPlayer: false,
        team: 2,
        x: 120,
        y: 220,
        hp: 0,
        maxHp: 100,
        dead: true
    });
    setContributors(getClientLevelScope(alpha as never), sourceId, ['epsilon']);

    await withMockedRandom([0.5, 0.0, 0.97, 0.1], async () => {
        await RewardHandler.handleGrantReward(alpha as never, buildGrantRewardPayload(sourceId, {
            dropMaterial: true
        }));
    });
    assert.equal(getMaterialRarity(findLoot(alpha, 'material')?.material ?? 0), 'L', 'hard material rolls should be able to produce legendary material');
}

async function main(): Promise<void> {
    ensureGameDataLoaded();

    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const levelEntities = new Map(GlobalState.levelEntities);
    const combatContributions = new Map(GlobalState.combatContributions);
    const entityLastRewardNonces = new Map(GlobalState.entityLastRewardNonces);

    try {
        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.combatContributions.clear();
        await testSimpleLootMinionDoesNotDropGear();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.combatContributions.clear();
        await testRandomItemLieutenantUsesItemDropChanceForGear();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.combatContributions.clear();
        await testPacketMultiplierAlreadyIncludesGearFind();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.combatContributions.clear();
        await testMapEnemiesDoNotDropItemLoot();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLastRewardNonces.clear();
        await testEnemyMaterialDropsWithoutExplicitDropFlag();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLastRewardNonces.clear();
        await testLiveEnemyStillUsesDungeonDropTablesForDefeatedPlayer();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLastRewardNonces.clear();
        await testLiveFixedItemEnemyStillUsesDungeonDropTablesWhenPacketHasNoItemFlags();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLastRewardNonces.clear();
        testGearRarityWeightsScaleByRank();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLastRewardNonces.clear();
        await testGearRarityTracksValueTier();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.combatContributions.clear();
        await testMaterialRarityTracksValueTier();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.combatContributions.clear();
        await testOwnedGearDoesNotDropAgain();

        console.log('reward_loot_rate_regression: ok');
    } finally {
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.levelEntities = levelEntities;
        GlobalState.combatContributions = combatContributions;
        GlobalState.entityLastRewardNonces = entityLastRewardNonces;
    }
}

void main().catch((error) => {
    console.error('reward_loot_rate_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
