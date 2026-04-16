import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { CommandHandler } from '../handlers/CommandHandler';
import { RewardHandler } from '../handlers/RewardHandler';
import { getClientLevelScope } from '../core/LevelScope';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { getVisibleConsumableCount } from '../utils/ConsumableState';

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
    characters: any[];
    authoritativeMaxHp: number;
    authoritativeCurrentHp: number;
    activePotionDrainAtMs: number;
    processedRewardSources: Set<string>;
    pendingLoot: Map<number, any>;
    knownEntityIds: Set<number>;
    entities: Map<number, any>;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, payload: BitBuffer) => void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('TutorialDungeon')) {
        LevelConfig.load(dataDir);
    }
    if (GameData.CONSUMABLES.length === 0 || GameData.CHARMS.length === 0) {
        GameData.load(dataDir);
    }
}

function createClient(): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character: any = {
        name: 'Delta',
        class: 'Mage',
        level: 20,
        activeConsumableID: 0,
        queuedConsumableID: 0,
        CurrentLevel: {
            name: 'CraftTown',
            x: 12,
            y: 24
        },
        consumables: [
            { consumableID: 6, count: 2 }
        ]
    };

    return {
        token: 77,
        userId: null,
        currentLevel: 'CraftTown',
        levelInstanceId: '',
        currentRoomId: 0,
        playerSpawned: true,
        clientEntID: 4001,
        character,
        characters: [character],
        authoritativeMaxHp: 100,
        authoritativeCurrentHp: 100,
        activePotionDrainAtMs: 0,
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entities: new Map<number, any>([
            [4001, { id: 4001, x: 12, y: 24, activeConsumableId: 0, hp: 100, maxHp: 100 }]
        ]),
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, payload: BitBuffer) {
            sentPackets.push({ id, payload: payload.toBuffer() });
        }
    };
}

function buildQueuePotionPayload(consumableId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod20(5, consumableId);
    return bb.toBuffer();
}

function buildActivatePotionPayload(entityId: number, consumableId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(entityId);
    bb.writeMethod20(5, consumableId);
    return bb.toBuffer();
}

function buildCombatStatsPayload(meleeDamage: number, magicDamage: number, maxHp: number, scale: number, revision: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(meleeDamage);
    bb.writeMethod9(magicDamage);
    bb.writeMethod9(maxHp);
    bb.writeMethod20(4, scale);
    bb.writeMethod9(revision);
    return bb.toBuffer();
}

function buildLinkUpdaterPayload(clientElapsed: number = 0): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod24(clientElapsed);
    bb.writeMethod15(false);
    bb.writeMethod24(0);
    return bb.toBuffer();
}

function parsePotionState(payload: Buffer): { entityId: number; consumableId: number } {
    const br = new BitReader(payload);
    return {
        entityId: br.readMethod4(),
        consumableId: br.readMethod6(5)
    };
}

function parseConsumableUpdate(payload: Buffer): { consumableId: number; total: number } {
    const br = new BitReader(payload);
    return {
        consumableId: br.readMethod6(5),
        total: br.readMethod4()
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

async function testPotionQueueAndActivationRefreshState(): Promise<void> {
    const client = createClient();
    GlobalState.sessionsByToken.set(client.token, client as never);

    await CommandHandler.handleQueuePotion(client as never, buildQueuePotionPayload(6));
    assert.equal(client.character.queuedConsumableID, 6, 'queue potion should persist the queued consumable');

    await CommandHandler.handleActivatePotion(client as never, buildActivatePotionPayload(4001, 6));

    assert.equal(client.character.activeConsumableID, 6, 'activating potion should persist the active consumable');
    assert.equal(client.entities.get(4001)?.activeConsumableId, 6, 'activating potion should update the live entity state');

    const activePotionPacket = client.sentPackets.find((packet) => packet.id === 0x10D);
    const playerDataRefreshPacket = client.sentPackets.find((packet) => packet.id === 0x10);
    const combatRefreshPacket = client.sentPackets.find((packet) => packet.id === 0xFB);
    assert.ok(activePotionPacket, 'activating potion should broadcast the active consumable packet');
    assert.ok(combatRefreshPacket, 'activating potion should request a combat stat refresh so potion bonuses update immediately');
    assert.equal(playerDataRefreshPacket, undefined, 'activating potion should not resend the full player data packet');
    assert.deepEqual(parsePotionState(activePotionPacket!.payload), {
        entityId: 4001,
        consumableId: 6
    });
}

async function testDungeonPotionActivationConsumesOneBottleAndKeepsVisibleCharge(): Promise<void> {
    const client = createClient();
    client.currentLevel = 'TutorialDungeon';
    client.currentRoomId = 1;
    client.character.consumables = [{ consumableID: 6, count: 1 }];
    GlobalState.sessionsByToken.set(client.token, client as never);

    await CommandHandler.handleActivatePotion(client as never, buildActivatePotionPayload(4001, 6));

    assert.equal(client.character.activeConsumableID, 6, 'dungeon activation should keep the potion active');
    assert.equal(client.character.activeConsumableCharges, 5000, 'dungeon activation should reserve one active bottle');
    assert.equal(client.character.consumables[0].count, 0, 'dungeon activation should consume one spare bottle');
    assert.equal(
        getVisibleConsumableCount(client.character, 6),
        5000,
        'room/map reloads should still expose the active bottle charge when spare count reaches zero'
    );

    const updatePacket = client.sentPackets.find((packet) => packet.id === 0x10C);
    assert.ok(updatePacket, 'dungeon activation should refresh the visible potion count');
    assert.deepEqual(parseConsumableUpdate(updatePacket!.payload), {
        consumableId: 6,
        total: 5000
    });
}

async function testDungeonPotionHeartbeatDrainsHudCharge(): Promise<void> {
    const client = createClient();
    client.currentLevel = 'TutorialDungeon';
    client.currentRoomId = 1;
    client.character.activeConsumableID = 6;
    client.character.activeConsumableCharges = 5000;
    client.character.consumables = [{ consumableID: 6, count: 0 }];
    client.activePotionDrainAtMs = Date.now() - 6000;
    GlobalState.sessionsByToken.set(client.token, client as never);

    await CommandHandler.handleLinkUpdater(client as never, buildLinkUpdaterPayload(6000));

    assert.ok(
        Number(client.character.activeConsumableCharges ?? 0) < 5000,
        'dungeon heartbeats should drain the active potion charge so the HUD meter moves'
    );

    const updatePacket = client.sentPackets.find((packet) => packet.id === 0x10C);
    assert.ok(updatePacket, 'dungeon heartbeats should refresh the potion HUD count');
    assert.ok(
        parseConsumableUpdate(updatePacket!.payload).total < 5000,
        'drained potion charge should lower the visible HUD percentage'
    );
}

async function testDungeonHeartbeatMigratesAlreadyActivePotionIntoChargeModel(): Promise<void> {
    const client = createClient();
    client.currentLevel = 'TutorialDungeon';
    client.currentRoomId = 1;
    client.character.activeConsumableID = 6;
    client.character.consumables = [{ consumableID: 6, count: 2 }];
    client.activePotionDrainAtMs = Date.now() - 6000;
    GlobalState.sessionsByToken.set(client.token, client as never);

    await CommandHandler.handleLinkUpdater(client as never, buildLinkUpdaterPayload(6000));

    assert.ok(
        Number(client.character.activeConsumableCharges ?? 0) > 0,
        'already-active dungeon potions should be reserved into charge units on heartbeat'
    );
    assert.equal(client.character.consumables[0].count, 1, 'heartbeat migration should consume one spare bottle into the active slot');
}

async function testActiveDungeonPotionBonusesApplyToRewardMath(): Promise<void> {
    const client = createClient();
    client.currentLevel = 'TutorialDungeon';
    client.currentRoomId = 1;
    client.character.activeConsumableID = 12;
    client.character.activeConsumableCharges = 5000;
    client.character.consumables = [{ consumableID: 12, count: 0 }];
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
    setContributors(getClientLevelScope(client as never), sourceId, ['delta']);

    await RewardHandler.handleGrantReward(client as never, buildGrantRewardPayload(sourceId, 100, 20));

    assert.equal(client.character.xp, 35, 'triple-find potion should boost dungeon XP rewards');
    const loot = Array.from(client.pendingLoot.values()).find((entry) => Number(entry?.gold ?? 0) > 0);
    assert.equal(loot?.gold, 175, 'triple-find potion should boost dungeon gold rewards');
}

function testCombatStatSyncUpdatesAuthoritativeHealth(): void {
    const client = createClient();

    CommandHandler.handleSendCombatStats(client as never, buildCombatStatsPayload(123, 234, 9876, 3, 12));

    assert.equal(client.authoritativeMaxHp, 9876, 'combat stat sync should update the server max HP');
    assert.equal(client.authoritativeCurrentHp, 100, 'combat stat sync should clamp current HP against the new max HP');
    assert.equal(client.entities.get(4001)?.maxHp, 9876, 'combat stat sync should refresh the live entity max HP');
  }

async function main(): Promise<void> {
    ensureDataLoaded();
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const levelEntities = new Map(GlobalState.levelEntities);
    const combatContributions = new Map(GlobalState.combatContributions);
    try {
        await testPotionQueueAndActivationRefreshState();
        await testDungeonPotionActivationConsumesOneBottleAndKeepsVisibleCharge();
        await testDungeonPotionHeartbeatDrainsHudCharge();
        await testDungeonHeartbeatMigratesAlreadyActivePotionIntoChargeModel();
        await testActiveDungeonPotionBonusesApplyToRewardMath();
        testCombatStatSyncUpdatesAuthoritativeHealth();
        console.log('consumable_stat_sync_regression: ok');
    } finally {
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.levelEntities = levelEntities;
        GlobalState.combatContributions = combatContributions;
    }
}

void main().catch((error) => {
    console.error('consumable_stat_sync_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
