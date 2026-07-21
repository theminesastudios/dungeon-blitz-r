import { strict as assert } from 'assert';
import * as path from 'path';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { RewardHandler } from '../handlers/RewardHandler';

function createClient(): any {
    const character = {
        name: 'MinionGearTester',
        class: 'mage',
        level: 12,
        gold: 0,
        CurrentLevel: { name: 'GoblinRiverDungeon', x: 100, y: 100 }
    };

    return {
        token: 93001,
        userId: 93001,
        currentLevel: 'GoblinRiverDungeon',
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
    } finally {
        Math.random = originalRandom;
        delete GameData.ENTTYPES.GuaranteedGearMinion;
    }

    console.log('minion_gear_drop_regression: ok');
}

main();
