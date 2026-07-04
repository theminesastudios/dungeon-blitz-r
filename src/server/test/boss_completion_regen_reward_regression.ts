import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';
import { NpcLoader } from '../data/NpcLoader';
import { MissionID } from '../data/runtime';
import { CombatHandler } from '../handlers/CombatHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { RewardHandler } from '../handlers/RewardHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type SentPacket = { id: number; payload: Buffer };

type FakeClient = {
    token: number;
    userId: number | null;
    character: any;
    characters: any[];
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    authoritativeMaxHp: number;
    authoritativeCurrentHp: number;
    processedRewardSources: Set<string>;
    pendingLoot: Map<number, any>;
    knownEntityIds: Set<number>;
    entityIdAliases: Map<number, number>;
    sharedEntityRemoteUpdateDeferredIds: Set<number>;
    entities: Map<number, any>;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('BT_Mission2Hard')) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
    if (NpcLoader.getRawNpcsForLevel('BT_Mission2Hard').length === 0) {
        NpcLoader.load(dataDir);
    }
}

function resetGlobalState(): void {
    GlobalState.sessionsByToken.clear();
    GlobalState.sessionsByUserId.clear();
    GlobalState.sessionsByCharacterName.clear();
    GlobalState.partyGroups.clear();
    GlobalState.partyByMember.clear();
    GlobalState.levelEntities.clear();
    GlobalState.levelQuestProgress.clear();
    GlobalState.dungeonCutscenes.clear();
    GlobalState.deadServerAuthorityHostilesByScope.clear();
    GlobalState.combatContributions.clear();
    GlobalState.entityLifeNonces.clear();
    GlobalState.entityLastRewardNonces.clear();
}

function createFakeClient(levelName: string, instanceId: string, token: number = 701): FakeClient {
    const sentPackets: SentPacket[] = [];
    return {
        token,
        userId: null,
        character: {
            name: `Tester${token}`,
            level: 50,
            xp: 0,
            gold: 0,
            class: 'mage',
            MasterClass: 0,
            inventoryGears: [],
            equippedGears: [],
            OwnedDyes: [],
            CurrentLevel: { name: levelName, x: 1000, y: 1000 }
        },
        characters: [],
        currentLevel: levelName,
        levelInstanceId: instanceId,
        currentRoomId: 1,
        playerSpawned: true,
        clientEntID: token + 1000,
        authoritativeMaxHp: 5000,
        authoritativeCurrentHp: 5000,
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        sharedEntityRemoteUpdateDeferredIds: new Set<number>(),
        entities: new Map<number, any>(),
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createBossEntity(id: number, name: string, hp: number, maxHp: number): any {
    return {
        id,
        name,
        characterName: `,${name}`,
        character_name: `,${name}`,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        roomId: 1,
        x: 1200,
        y: 900,
        hp,
        maxHp,
        healthDelta: hp - maxHp,
        health_delta: hp - maxHp,
        entState: hp > 0 ? EntityState.ACTIVE : EntityState.DEAD,
        dead: hp <= 0,
        destroyed: hp <= 0,
        lastCombatActivityAt: Date.now() - 5_000,
        lastCombatRegenTickAt: 0
    };
}

function assertClientReportedCompletionNeedsBossEvidence(): void {
    const client = createFakeClient('BT_Mission2Hard', 'completion-gate');
    const scope = getLevelScopeKey(client.currentLevel, client.levelInstanceId);
    GlobalState.levelEntities.set(scope, new Map<number, any>());

    const accepted = (MissionHandler as any).canAcceptClientReportedDungeonCompletion(
        client,
        client.currentLevel,
        scope,
        true,
        100
    );

    assert.equal(accepted, false, 'boss dungeons must not accept client completion before boss defeat evidence');
}

function assertExplicitBossDungeonRequiresBossEvidence(): void {
    const client = createFakeClient('OMM_Mission7Hard', 'explicit-boss');
    const scope = getLevelScopeKey(client.currentLevel, client.levelInstanceId);
    GlobalState.levelEntities.set(scope, new Map<number, any>());

    const early = (MissionHandler as any).canAcceptClientReportedDungeonCompletion(
        client,
        client.currentLevel,
        scope,
        true,
        99
    );
    const complete = (MissionHandler as any).canAcceptClientReportedDungeonCompletion(
        client,
        client.currentLevel,
        scope,
        true,
        100
    );

    assert.equal(early, false, 'explicit boss dungeons must reject sub-100 completion');
    assert.equal(complete, false, 'explicit boss dungeons must reject 100 percent completion without boss evidence');
}

function assertFullClearOnlyDungeonRequiresFullProgress(): void {
    for (const levelName of ['AC_Mission3Hard', 'AC_Mission4Hard']) {
        const client = createFakeClient(levelName, `full-clear-${levelName}`);
        const scope = getLevelScopeKey(client.currentLevel, client.levelInstanceId);
        GlobalState.levelEntities.set(scope, new Map<number, any>());

        const early = (MissionHandler as any).canAcceptClientReportedDungeonCompletion(
            client,
            client.currentLevel,
            scope,
            true,
            99
        );
        const complete = (MissionHandler as any).canAcceptClientReportedDungeonCompletion(
            client,
            client.currentLevel,
            scope,
            true,
            100
        );

        assert.equal(early, false, `${levelName} must reject sub-100 completion`);
        assert.equal(complete, true, `${levelName} should accept 100 percent completion`);
    }
}

function assertRockHulkBossCountsForCollectRockShards(): void {
    const normal = (MissionHandler as any).matchesEnemyKillProgress(
        MissionID.CollectRockShards,
        {},
        ['RockHulkBoss'],
        'OMM_Mission2'
    );
    const hard = (MissionHandler as any).matchesEnemyKillProgress(
        MissionID.CollectRockShardsHard,
        {},
        ['RockHulkBoss'],
        'OMM_Mission2Hard'
    );

    assert.equal(normal, true, 'RockHulkBoss should count for normal Rock Hulk shard collection');
    assert.equal(hard, true, 'RockHulkBoss should count for dread Rock Hulk shard collection');
}

function assertDamagedBossRegensOutOfCombat(): void {
    const scope = getLevelScopeKey('BT_Mission2Hard', 'regen-live');
    const boss = createBossEntity(8801, 'BanditBossHard', 1000, 5000);
    GlobalState.levelEntities.set(scope, new Map<number, any>([[boss.id, boss]]));

    (CombatHandler as any).processHostileOutOfCombatRegen(scope, boss, Date.now());

    assert.ok(boss.hp > 1000, 'living damaged boss should regen after combat drops');
    assert.equal(boss.dead, false, 'living regen must not mark the boss dead');
}

function assertDeadBossDoesNotRegenOrClearRewardNonce(): void {
    const scope = getLevelScopeKey('BT_Mission2Hard', 'regen-dead');
    const deadBoss = {
        ...createBossEntity(8802, 'BanditBossHard', 0, 5000),
        lootDropped: true,
        deathRewardGrantedAt: Date.now(),
        clientDefeatVerified: true
    };
    GlobalState.levelEntities.set(scope, new Map<number, any>([[deadBoss.id, deadBoss]]));
    const entityKey = `${scope}:${deadBoss.id}`;
    GlobalState.entityLifeNonces.set(entityKey, 4);
    GlobalState.entityLastRewardNonces.set(entityKey, 3);

    (CombatHandler as any).processHostileOutOfCombatRegen(scope, deadBoss, Date.now());
    (CombatHandler as any).clearLevelEnemyRewardTrackingForRespawn(
        createFakeClient('BT_Mission2Hard', 'regen-dead', 702)
    );

    assert.equal(deadBoss.hp, 0, 'dead rewarded boss must not regen');
    assert.equal(deadBoss.dead, true, 'dead rewarded boss must stay dead');
    assert.equal(GlobalState.entityLastRewardNonces.get(entityKey), 3, 'respawn must preserve rewarded boss nonce');
}

function rewardTypes(client: FakeClient, startIndex: number): string[] {
    return Array.from(client.pendingLoot.values())
        .slice(startIndex)
        .map((reward) => {
            if (reward.gold) return 'gold';
            if (reward.health) return 'health';
            if (reward.gear) return 'gear';
            if (reward.material) return 'material';
            if (reward.dye) return 'dye';
            return 'unknown';
        });
}

function assertRevivableBossRepeatRewardIsHealthOnly(): void {
    const client = createFakeClient('JC_Mission9Hard', 'revivable-reward', 703);
    const scope = getLevelScopeKey(client.currentLevel, client.levelInstanceId);
    const source = createBossEntity(9101, 'RisenBanditHard', 0, 1);
    GlobalState.levelEntities.set(scope, new Map<number, any>([[source.id, source]]));
    client.entities.set(source.id, source);

    const reward = {
        receiverId: client.clientEntID,
        sourceId: source.id,
        dropItem: true,
        itemMultiplier: 1,
        dropGear: true,
        gearMultiplier: 1,
        dropMaterial: true,
        dropTrove: false,
        exp: 0,
        petExp: 0,
        hpGain: 25,
        gold: 100,
        worldX: 1200,
        worldY: 900,
        combo: 0
    };

    (RewardHandler as any).applyRewardToRecipient(client, reward, 1, source, { x: 1200, y: 900 }, {
        reason: 'unknown',
        caller: 'boss_completion_regen_reward_regression'
    });
    const afterFirstReward = client.pendingLoot.size;
    assert.ok(rewardTypes(client, 0).includes('gold'), 'first revivable boss death should keep its normal reward');

    (RewardHandler as any).applyRewardToRecipient(client, reward, 2, source, { x: 1200, y: 900 }, {
        reason: 'unknown',
        caller: 'boss_completion_regen_reward_regression'
    });

    assert.deepEqual(
        rewardTypes(client, afterFirstReward),
        ['health'],
        'repeat revivable boss rewards should only spawn health'
    );
}

ensureDataLoaded();
resetGlobalState();
assertClientReportedCompletionNeedsBossEvidence();
resetGlobalState();
assertExplicitBossDungeonRequiresBossEvidence();
resetGlobalState();
assertFullClearOnlyDungeonRequiresFullProgress();
resetGlobalState();
assertRockHulkBossCountsForCollectRockShards();
resetGlobalState();
assertDamagedBossRegensOutOfCombat();
resetGlobalState();
assertDeadBossDoesNotRegenOrClearRewardNonce();
resetGlobalState();
assertRevivableBossRepeatRewardIsHealthOnly();
resetGlobalState();

console.log('boss_completion_regen_reward_regression passed');
