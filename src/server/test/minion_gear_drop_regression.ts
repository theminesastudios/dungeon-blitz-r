import { strict as assert } from 'assert';
import * as path from 'path';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { RewardHandler } from '../handlers/RewardHandler';

function createClient(currentLevel: string = 'GoblinRiverDungeon'): any {
    const character = {
        name: 'MinionGearTester',
        class: 'mage',
        level: 12,
        gold: 0,
        CurrentLevel: { name: currentLevel, x: 100, y: 100 }
    };

    return {
        token: 93001,
        userId: 93001,
        currentLevel,
        levelInstanceId: 'minion-gear-drop-regression',
        currentRoomId: 1,
        playerSpawned: true,
        clientEntID: 93001,
        authoritativeMaxHp: 1000,
        character,
        characters: [character],
        pendingLoot: new Map<number, any>(),
        processedRewardSources: new Set<string>(),
        entities: new Map<number, any>(),
        send(): void { /* test stub */ },
        sendBitBuffer(): void { /* test stub */ },
        scheduleCharacterSave(): void { /* test stub */ }
    };
}

function assertNearlyEqual(actual: number, expected: number, message: string): void {
    assert.ok(Math.abs(actual - expected) < 0.000001, `${message}: expected ${expected}, got ${actual}`);
}

function rewardRequest(sourceId: number): any {
    return {
        receiverId: 93001,
        sourceId,
        dropItem: true,
        itemMultiplier: 1,
        dropGear: true,
        gearMultiplier: 1,
        dropMaterial: true,
        dropTrove: false,
        exp: 0,
        petExp: 0,
        hpGain: 0,
        gold: 0,
        worldX: 100,
        worldY: 100,
        combo: 0
    };
}

function main(): void {
    const dataDir = path.resolve(__dirname, '../data');
    LevelConfig.load(dataDir);
    GameData.load(dataDir);

    GameData.ENTTYPES.GuaranteedGearMinion = {
        EntName: 'GuaranteedGearMinion',
        EntRank: 'Minion',
        Level: '3',
        RewardClass: 'RandomItem',
        ItemDropChance: '1',
        Realm: 'Goblin'
    };

    const client = createClient();
    const originalRandom = Math.random;
    Math.random = () => 0;
    try {
        const minionResult = (RewardHandler as any).maybeOverrideDungeonReward(
            client,
            { id: 1, name: 'GuaranteedGearMinion', isPlayer: false },
            rewardRequest(1)
        );
        assert.equal(minionResult.gearId, 0, 'minion enemies must not roll gear even with ItemDropChance=1');
        assert.equal(minionResult.gearTier, 0, 'minion enemies must not assign a gear tier');

        const lieutenantResult = (RewardHandler as any).maybeOverrideDungeonReward(
            client,
            { id: 2, name: 'GoblinBrute', isPlayer: false },
            rewardRequest(2)
        );
        assert.ok(lieutenantResult.gearId > 0, 'Lieutenant/elite gear drops should remain unchanged');

        const hardBossClient = createClient('GoblinRiverDungeonHard');
        const normalBossWeights = (RewardHandler as any).getGearTierWeights(client, 'Boss', 1);
        assertNearlyEqual(normalBossWeights.find((entry: any) => entry.tier === 0)?.weight ?? 0, 14 / 15, 'normal boss common weight');
        assertNearlyEqual(normalBossWeights.find((entry: any) => entry.tier === 1)?.weight ?? 0, 1 / 15, 'normal boss rare weight');
        assertNearlyEqual(normalBossWeights.find((entry: any) => entry.tier === 2)?.weight ?? 0, 0, 'normal boss legendary weight');

        const hardBossWeights = (RewardHandler as any).getGearTierWeights(hardBossClient, 'Boss', 1);
        assertNearlyEqual(hardBossWeights.find((entry: any) => entry.tier === 0)?.weight ?? 0, 103 / 120, 'hard boss common weight');
        assertNearlyEqual(hardBossWeights.find((entry: any) => entry.tier === 1)?.weight ?? 0, 1 / 8, 'hard boss rare weight');
        assertNearlyEqual(hardBossWeights.find((entry: any) => entry.tier === 2)?.weight ?? 0, 1 / 60, 'hard boss legendary weight');

        const normalBossOverflowWeights = (RewardHandler as any).getGearTierWeights(client, 'Boss', 3);
        assertNearlyEqual(normalBossOverflowWeights.find((entry: any) => entry.tier === 0)?.weight ?? 0, 4 / 5, 'normal boss overflow common weight');
        assertNearlyEqual(normalBossOverflowWeights.find((entry: any) => entry.tier === 1)?.weight ?? 0, 1 / 5, 'normal boss overflow rare weight');
        assertNearlyEqual(normalBossOverflowWeights.find((entry: any) => entry.tier === 2)?.weight ?? 0, 0, 'normal boss overflow legendary weight');

        const hardBossOverflowWeights = (RewardHandler as any).getGearTierWeights(hardBossClient, 'Boss', 5);
        assertNearlyEqual(hardBossOverflowWeights.find((entry: any) => entry.tier === 0)?.weight ?? 0, 7 / 24, 'hard boss overflow common weight');
        assertNearlyEqual(hardBossOverflowWeights.find((entry: any) => entry.tier === 1)?.weight ?? 0, 5 / 8, 'hard boss overflow rare weight');
        assertNearlyEqual(hardBossOverflowWeights.find((entry: any) => entry.tier === 2)?.weight ?? 0, 1 / 12, 'hard boss overflow legendary weight');

        const cappedHardBossOverflowWeights = (RewardHandler as any).getGearTierWeights(hardBossClient, 'Boss', 8);
        assertNearlyEqual(cappedHardBossOverflowWeights.find((entry: any) => entry.tier === 0)?.weight ?? 0, 0, 'capped hard boss overflow common weight');
        assertNearlyEqual(cappedHardBossOverflowWeights.find((entry: any) => entry.tier === 1)?.weight ?? 0, 15 / 17, 'capped hard boss overflow rare weight');
        assertNearlyEqual(cappedHardBossOverflowWeights.find((entry: any) => entry.tier === 2)?.weight ?? 0, 2 / 17, 'capped hard boss overflow legendary weight');

        Math.random = () => 0.5;
        assert.equal((RewardHandler as any).resolveGearTier(hardBossClient, 'Boss', 1), 0, 'hard boss gear should not always be legendary');
        Math.random = () => 0.9;
        assert.equal((RewardHandler as any).resolveGearTier(hardBossClient, 'Boss', 1), 1, 'hard boss rare tier threshold changed');
        Math.random = () => 0.99;
        assert.equal((RewardHandler as any).resolveGearTier(hardBossClient, 'Boss', 1), 2, 'hard boss legendary tier threshold changed');
    } finally {
        Math.random = originalRandom;
        delete GameData.ENTTYPES.GuaranteedGearMinion;
    }

    console.log('minion_gear_drop_regression: ok');
}

main();
