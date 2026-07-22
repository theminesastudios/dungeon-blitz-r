import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityTeam } from '../core/Entity';
import { EntityHandler } from '../handlers/EntityHandler';
import { CombatHandler } from '../handlers/CombatHandler';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { RewardHandler } from '../handlers/RewardHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

function buildReward(sourceId: number, receiverId: number, gold: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(receiverId);
    bb.writeMethod9(sourceId);
    bb.writeMethod15(false);
    bb.writeMethod309(0);
    bb.writeMethod15(false);
    bb.writeMethod309(0);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(gold);
    bb.writeMethod24(1200);
    bb.writeMethod24(800);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function createClient(): any {
    const sentPackets: Array<{ id: number; payload: Buffer }> = [];
    return {
        token: 96_001,
        userId: 96_001,
        playerSpawned: true,
        clientEntID: 96_001,
        currentLevel: 'JC_Mini1Hard',
        levelInstanceId: 'chest-reward-authority',
        currentRoomId: 3,
        character: { name: 'ChestTester', level: 50, gold: 0, CurrentLevel: { name: 'JC_Mini1Hard', x: 1200, y: 800 } },
        characters: [],
        entities: new Map<number, any>(),
        entityIdAliases: new Map<number, number>(),
        pendingLoot: new Map<number, any>(),
        processedRewardSources: new Set<string>(),
        sentPackets,
        send(id: number, payload: Buffer): void { sentPackets.push({ id, payload: Buffer.from(payload) }); },
        sendBitBuffer(id: number, bb: BitBuffer): void { sentPackets.push({ id, payload: bb.toBuffer() }); },
        scheduleCharacterSave(): void { /* test stub */ }
    };
}

function main(): void {
    const dataDir = path.resolve(__dirname, '../data');
    LevelConfig.load(dataDir);
    GameData.load(dataDir);

    const objectiveScope = 'CH_MiniMission2#objective-chest-identity';
    const canonicalChest = {
        id: 96_201,
        name: 'TreasureChestEmpty',
        team: EntityTeam.ENEMY,
        roomId: 4,
        x: 1000,
        y: 800,
        hybridCanonicalHostile: true,
        clientSpawned: false,
        ownerToken: 96_001,
        ownerPartyId: 700,
        spawnKey: `${objectiveScope}|room:4|type:treasurechestempty|pos:1000:800`
    };
    const distinctChest = {
        ...canonicalChest,
        id: 96_202,
        x: 1400,
        spawnKey: `${objectiveScope}|room:4|type:treasurechestempty|pos:1400:800`
    };
    const objectiveMap = new Map([[canonicalChest.id, canonicalChest]]);
    const distinctMatch = (EntityHandler as any).findSharedClientSpawnCanonicalMatch(
        'CH_MiniMission2',
        objectiveMap,
        700,
        4,
        distinctChest,
        96_001
    );
    assert.equal(distinctMatch, null, 'distinct completion chests collapsed onto one canonical entity');
    const duplicateMatch = (EntityHandler as any).findSharedClientSpawnCanonicalMatch(
        'CH_MiniMission2',
        objectiveMap,
        700,
        4,
        { ...distinctChest, spawnKey: canonicalChest.spawnKey },
        96_001
    );
    assert.equal(duplicateMatch, canonicalChest, 'the same completion chest no longer deduplicates by spawn key');
    assert.equal(
        (CombatHandler as any).isEquivalentHostileEntity(objectiveScope, canonicalChest, distinctChest),
        false,
        'combat health sync treated distinct completion chests as equivalent copies'
    );
    assert.equal(
        (CombatHandler as any).isEquivalentHostileEntity(
            objectiveScope,
            canonicalChest,
            { ...distinctChest, spawnKey: canonicalChest.spawnKey }
        ),
        true,
        'combat health sync stopped recognizing the same completion chest spawn'
    );

    const client = createClient();
    client.characters = [client.character];
    const scope = getClientLevelScope(client);
    const chest = { id: 96_101, name: 'TreasureChestEmpty', behavior: 'TreasureChest', team: EntityTeam.ENEMY, x: 1200, y: 800, roomId: 3 };
    const hostile = { id: 96_102, name: 'GoblinBrute', team: EntityTeam.ENEMY, x: 1200, y: 800, roomId: 3 };
    client.entities.set(chest.id, chest);
    client.entities.set(hostile.id, hostile);
    GlobalState.levelEntities.set(scope, new Map([[chest.id, chest], [hostile.id, hostile]]));
    GlobalState.sessionsByToken.set(client.token, client);

    try {
        const chestReward = buildReward(chest.id, client.clientEntID, 10);
        RewardHandler.handleGrantReward(client, chestReward);
        assert.equal(client.pendingLoot.size, 1, 'team-2 treasure chest was rejected as an enemy reward');
        assert.equal(client.sentPackets.filter((packet: any) => packet.id === 0x32).length, 1, 'chest did not emit its loot packet');

        RewardHandler.handleGrantReward(client, chestReward);
        assert.equal(client.pendingLoot.size, 1, 'duplicate chest packet created duplicate loot');

        RewardHandler.handleGrantReward(client, buildReward(99_999, client.clientEntID, 5000));
        assert.equal(client.pendingLoot.size, 1, 'unknown reward source created forged loot');

        RewardHandler.handleGrantReward(client, buildReward(hostile.id, client.clientEntID, 5000));
        assert.equal(client.pendingLoot.size, 1, 'legacy hostile packet bypassed canonical server loot authority');
    } finally {
        GlobalState.levelEntities.delete(scope);
        GlobalState.sessionsByToken.delete(client.token);
    }

    console.log('chest_reward_authority_regression: ok');
}

main();
