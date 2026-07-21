import { strict as assert } from 'assert';
import fs from 'fs';
import path from 'path';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { CombatHandler } from '../handlers/CombatHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type SentPacket = { id: number; payload: Buffer };

function createSrnClient(): any {
    const sentPackets: SentPacket[] = [];
    const character = {
        name: 'SrnLatencyRunner',
        CurrentLevel: { name: 'SRN_Mission1', x: 100, y: 100 },
        PreviousLevel: { name: 'SwampRoadNorth', x: 100, y: 100 },
        missions: {},
        questTrackerState: 0,
        level: 20,
        xp: 0,
        gold: 0
    };
    return {
        currentLevel: 'SRN_Mission1',
        levelInstanceId: 'srn-latency-run',
        currentRoomId: 9,
        token: 73001,
        userId: null,
        playerSpawned: true,
        clientEntID: 73002,
        character,
        characters: [character],
        sentPackets,
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        pendingLoot: new Map<number, any>(),
        pendingDungeonCompletionScope: '',
        pendingDungeonCompletionRequestedAt: 0,
        pendingDungeonCompletionLastSkitAt: 0,
        pendingDungeonCompletionNotBeforeAt: 0,
        pendingDungeonCompletionSettleMs: 0,
        pendingDungeonCompletionPayload: null,
        pendingDungeonCompletionTimer: null,
        pendingDungeonCompletionFlushActive: false,
        activeDungeonCutsceneScope: '',
        activeDungeonCutsceneRoomId: 0,
        lastDungeonCutsceneStartScope: '',
        lastDungeonCutsceneStartAt: 0,
        lastDungeonCutsceneEndScope: '',
        lastDungeonCutsceneEndAt: 0,
        socket: { destroyed: false, write: () => true },
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        },
        armPendingTransferGrace() {
            return undefined;
        }
    };
}

function createDefeatedLizardLord(): any {
    return {
        id: 74001,
        name: 'LizardLord',
        characterName: ',LizardLord',
        isPlayer: false,
        roomId: 9,
        team: EntityTeam.ENEMY,
        entState: EntityState.DEAD,
        hp: 0,
        maxHp: 1000,
        dead: true,
        destroyed: true,
        clientSpawned: true,
        clientDefeatVerified: true,
        playerDamageContributed: true,
        lifeNonce: 1
    };
}

function testGameplayDiagnosticsAreRemoved(): void {
    assert.equal((CombatHandler as any).logMultiplayerSync, undefined);
    assert.equal((CombatHandler as any).logLootSync, undefined);
    assert.equal((CombatHandler as any).logPostDeathDrop, undefined);
    assert.equal((CombatHandler as any).logHpMutation, undefined);
    assert.equal((CombatHandler as any).logAliasInbound, undefined);
    assert.equal(fs.existsSync(path.resolve(__dirname, '..', 'core', 'Debug.ts')), false);
    assert.equal(fs.existsSync(path.resolve(__dirname, '..', 'utils', 'JcMini1AuthorityLog.ts')), false);
}

async function testSrnBossCompletionReservesAWindowForEndingSkits(): Promise<void> {
    const client = createSrnClient();
    const boss = createDefeatedLizardLord();
    const levelScope = getClientLevelScope(client);
    GlobalState.sessionsByToken.set(client.token, client);
    GlobalState.levelEntities.set(levelScope, new Map([[boss.id, boss]]));

    try {
        (CombatHandler as any).handleEnemyDefeatState(
            client,
            levelScope,
            boss.id,
            boss,
            { fromDestroy: true }
        );

        const state = DungeonCompletionSystem.getState(levelScope);
        assert(state, 'SRN completion observation was deferred out of the destroy transaction');
        assert.equal(state.phase, 'ready', 'SRN boss death did not make completion ready');
        assert.equal(
            client.sentPackets.filter((packet: SentPacket) => packet.id === 0x87).length,
            0,
            'SRN rank plate bypassed the ending-skit observation window'
        );
        assert(client.pendingDungeonCompletionTimer, 'SRN completion did not arm the ending-skit observation window');

        clearTimeout(client.pendingDungeonCompletionTimer);
        client.pendingDungeonCompletionTimer = null;
        client.pendingDungeonCompletionNotBeforeAt = Date.now() - 1;
        client.pendingDungeonCompletionLastSkitAt = Date.now() - 1;
        client.pendingDungeonCompletionSettleMs = 0;
        await (MissionHandler as any).flushPendingDungeonCompletion(client);

        assert.equal(state.phase, 'completed', 'SRN completion did not finalize after the skit window settled');
        assert.equal(
            client.sentPackets.filter((packet: SentPacket) => packet.id === 0x87).length,
            1,
            'SRN rank plate was not dispatched after the skit window settled'
        );

        (CombatHandler as any).handleEnemyDefeatState(
            client,
            levelScope,
            boss.id,
            boss,
            { fromDestroy: true }
        );
        assert.equal(
            client.sentPackets.filter((packet: SentPacket) => packet.id === 0x87).length,
            1,
            'duplicate SRN defeat generated a second completion plate'
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
    } finally {
        if (client.pendingDungeonCompletionTimer) {
            clearTimeout(client.pendingDungeonCompletionTimer);
        }
        DungeonCompletionSystem.reset(levelScope);
        GlobalState.levelEntities.delete(levelScope);
        GlobalState.sessionsByToken.delete(client.token);
    }
}

async function main(): Promise<void> {
    LevelConfig.load(path.resolve(__dirname, '..', 'data'));
    testGameplayDiagnosticsAreRemoved();
    await testSrnBossCompletionReservesAWindowForEndingSkits();
    console.log('runtime_hot_path_latency_regression: ok');
}

void main();
