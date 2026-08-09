import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import * as path from 'path';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { CombatHandler } from '../handlers/CombatHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

/*
 * Revive is a two-step handshake: the client asks with 0x77, and the server only answers
 * with 0x80 once it has fresh combat stats -- which a death almost never has, so every
 * revive goes through the deferred path. It used to wait on the client's 0xFC forever,
 * and a player whose reply never landed stayed dead with a revive button that did nothing.
 */

const RESPAWN_TIMEOUT_MS = 2_500;

function boolPacket(flag: boolean): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod15(flag);
    return bb.toBuffer();
}

function createClient(): any {
    return {
        token: 4_242,
        userId: 4_242,
        clientEntID: 501,
        playerSpawned: true,
        currentLevel: 'NewbieRoad',
        levelInstanceId: '',
        currentRoomId: 1,
        authoritativeMaxHp: 3_000,
        authoritativeCurrentHp: 0,
        combatStatsDirty: true,
        allowDirtyCombatStatsRegen: false,
        lastCombatStatsRefreshRequestAt: 0,
        lastCombatStatsSyncedAt: 0,
        pendingRespawnRequest: null,
        pendingRespawnTimer: null,
        respawnPotionCharged: false,
        enemyDeathRegenArmed: false,
        lastCombatActivityAt: 0,
        lastCombatRegenTickAt: 0,
        character: {
            name: 'Reviver',
            class: 'mage',
            level: 30,
            consumables: [],
            activeConsumableID: 0,
            queuedConsumableID: 0,
            CurrentLevel: { name: 'NewbieRoad', x: 1_421, y: 826 }
        },
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        sentPackets: [] as Array<{ id: number }>,
        send(id: number) { this.sentPackets.push({ id }); },
        sendBitBuffer(id: number) { this.sentPackets.push({ id }); }
    };
}

function respawnResponses(client: any): number {
    return client.sentPackets.filter((packet: { id: number }) => packet.id === 0x80).length;
}

// The whole point: a silent client must not be able to hold a player dead.
async function testSilentClientStillGetsRevived(): Promise<void> {
    const client = createClient();
    CombatHandler.handleRequestRespawn(client, boolPacket(false));

    assert.ok(client.pendingRespawnRequest, 'a stale-stats revive should defer, not answer immediately');
    assert.equal(respawnResponses(client), 0, 'no 0x80 before the combat stats round trip');

    await new Promise((resolve) => setTimeout(resolve, RESPAWN_TIMEOUT_MS + 400));

    assert.equal(respawnResponses(client), 1, 'the timeout must revive the player anyway');
    assert.equal(client.pendingRespawnRequest, null, 'pending request should be cleared');
    assert.equal(client.pendingRespawnTimer, null, 'timer should not be left armed');
}

// The normal path must still win the race and cancel the timeout.
async function testCombatStatsReplyRevivesOnceOnly(): Promise<void> {
    const client = createClient();
    CombatHandler.handleRequestRespawn(client, boolPacket(false));
    assert.equal(respawnResponses(client), 0);

    CombatHandler.completePendingRespawnAfterCombatStats(client);
    assert.equal(respawnResponses(client), 1, 'the client reply revives the player');
    assert.equal(client.pendingRespawnTimer, null, 'reply must disarm the timeout');

    await new Promise((resolve) => setTimeout(resolve, RESPAWN_TIMEOUT_MS + 400));
    assert.equal(respawnResponses(client), 1, 'the disarmed timeout must not revive a second time');
}

/*
 * A potion revive is billed at 0x77 and confirmed at 0x82. The gap between them is the
 * combat-stats handshake, which is unbounded and routinely longer than the 1.5s dedup
 * window inside tryConsumeRespawnPotion -- so a laggy multiplayer revive charged twice.
 */
function testPotionRevivelChargesExactlyOnce(): void {
    const resPotion = GameData.CONSUMABLES.find((entry: any) => String(entry?.Type ?? '') === 'ResPotion');
    if (!resPotion) {
        console.log('respawn_recovery_regression: no ResPotion in GameData, skipping potion check');
        return;
    }

    const potionId = Number((resPotion as any).ConsumableID);
    const client = createClient();
    client.character.consumables = [{ consumableID: potionId, count: 5 }];
    client.character.activeConsumableID = potionId;

    CombatHandler.handleRequestRespawn(client, boolPacket(true));
    const afterRequest = Number(client.character.consumables[0]?.count ?? 0);
    assert.equal(afterRequest, 4, 'the request half bills exactly one potion');
    assert.equal(client.respawnPotionCharged, true, 'the charge must be marked for the broadcast half');

    // Past the 1.5s dedup window: only the explicit charge marker can prevent a double bill.
    (client as any).lastRespawnPotionConsumeAtMs = Date.now() - 5_000;

    const broadcast = new BitBuffer(false);
    broadcast.writeMethod9(client.clientEntID);
    broadcast.writeMethod24(3_000);
    broadcast.writeMethod15(true);
    CombatHandler.handleRespawnBroadcast(client, broadcast.toBuffer());

    assert.equal(
        Number(client.character.consumables[0]?.count ?? 0),
        4,
        'the broadcast half must not bill a second potion for the same revive'
    );
    assert.equal(client.respawnPotionCharged, false, 'the charge marker resets for the next death');
}

async function main(): Promise<void> {
    const dataDir = path.resolve(__dirname, '../data');
    LevelConfig.load(dataDir);
    GameData.load(dataDir);

    testPotionRevivelChargesExactlyOnce();
    await testCombatStatsReplyRevivesOnceOnly();
    await testSilentClientStillGetsRevived();
    console.log('respawn_recovery_regression: ok');
}

void main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
});
