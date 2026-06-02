import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime/MissionID';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type FakeClient = {
    token: number;
    userId: number | null;
    character: any;
    characters: any[];
    currentLevel: string;
    levelInstanceId: string;
    forcedDungeonCompletionScope: string;
    completedDungeonCompletionScope: string;
    finalizingDungeonCompletionScope: string;
    pendingDungeonCompletionFlushActive: boolean;
    playerSpawned: boolean;
    entities: Map<number, any>;
    knownEntityIds: Set<number>;
    sentPackets: Array<{ id: number; payload: Buffer }>;
    sendBitBuffer(id: number, bb: BitBuffer): void;
    send(id: number, payload: Buffer): void;
};

function ensureDataLoaded(): void {
    const sourceDataDir = path.resolve(__dirname, '../data');
    const compiledDataDir = path.resolve(__dirname, '../../data');
    const dataDir = fs.existsSync(path.join(sourceDataDir, 'level_config.json'))
        ? sourceDataDir
        : compiledDataDir;

    if (!LevelConfig.has('AC_Mission6')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.Capstone)) {
        MissionLoader.load(dataDir);
    }
    if (!GameData.getEntType('NephitLargeEye')) {
        GameData.load(dataDir);
    }
}

function createClient(flowId: string): FakeClient {
    const sentPackets: Array<{ id: number; payload: Buffer }> = [];
    const character = {
        name: `CapstoneTester-${flowId}`,
        CurrentLevel: { name: 'AC_Mission6', x: 0, y: 0 },
        missions: {
            [String(MissionID.Capstone)]: { state: 1, currCount: 0 }
        },
        questTrackerState: 0
    };

    return {
        token: 9601,
        userId: null,
        character,
        characters: [character],
        currentLevel: 'AC_Mission6',
        levelInstanceId: `capstone-${flowId}`,
        forcedDungeonCompletionScope: '',
        completedDungeonCompletionScope: '',
        finalizingDungeonCompletionScope: '',
        pendingDungeonCompletionFlushActive: false,
        playerSpawned: true,
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        },
        send(id: number, payload: Buffer): void {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        }
    };
}

function createLevelCompletePacket(progress: number = 100, remainingKills: number = 0, requiredKills: number = 1): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(progress);
    bb.writeMethod9(5000);
    bb.writeMethod9(100);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(remainingKills);
    bb.writeMethod9(requiredKills);
    bb.writeMethod9(10);
    return bb.toBuffer();
}

function addEntity(client: FakeClient, entity: any): void {
    client.entities.set(entity.id, entity);
    const levelScope = getClientLevelScope(client as never);
    let levelEntities = GlobalState.levelEntities.get(levelScope);
    if (!levelEntities) {
        levelEntities = new Map<number, any>();
        GlobalState.levelEntities.set(levelScope, levelEntities);
    }
    levelEntities.set(entity.id, entity);
}

function createNephitBoss(defeated: boolean): any {
    return {
        id: 96001,
        name: 'NephitLargeEye',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entRank: 'Boss',
        entState: defeated ? EntityState.DEAD : EntityState.ACTIVE,
        hp: defeated ? 0 : 500,
        maxHp: 1000,
        dead: defeated,
        clientSpawned: true,
        playerDamageContributed: true,
        ownerToken: 9601,
        roomId: 7
    };
}

async function testForcedCompletionDoesNotBypassLiveCapstoneBoss(): Promise<void> {
    const client = createClient('forced-live-boss');
    const levelScope = getClientLevelScope(client as never);
    const boss = createNephitBoss(false);
    addEntity(client, boss);
    client.forcedDungeonCompletionScope = levelScope;

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket());

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'forced completion must not show the Capstone completion screen while Nephit is alive'
    );
    assert.equal(
        client.completedDungeonCompletionScope,
        '',
        'live required boss must not finalize Capstone completion'
    );
    assert.equal(
        String((client as any).pendingDungeonCompletionScope ?? ''),
        '',
        'live required boss must not schedule deferred Capstone completion'
    );
}

async function testForcedCompletionAllowsDefeatedCapstoneBoss(): Promise<void> {
    const client = createClient('forced-dead-boss');
    const levelScope = getClientLevelScope(client as never);
    const boss = createNephitBoss(true);
    addEntity(client, boss);
    client.forcedDungeonCompletionScope = levelScope;

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket());

    assert.equal(
        String((client as any).pendingDungeonCompletionScope ?? ''),
        levelScope,
        'defeated Capstone boss should schedule completion after the post-death cutscene'
    );
    assert.equal(
        Boolean((client as any).pendingDungeonCompletionWaitForCutsceneEnd),
        true,
        'defeated Capstone boss should wait for the post-death cutscene before the completion screen'
    );
    assert.equal(
        client.completedDungeonCompletionScope,
        '',
        'post-death cutscene completion should not finalize before the cutscene release'
    );
}

async function main(): Promise<void> {
    ensureDataLoaded();
    await testForcedCompletionDoesNotBypassLiveCapstoneBoss();
    await testForcedCompletionAllowsDefeatedCapstoneBoss();
    console.log('capstone_completion_objectives_regression: ok');
}

void main().catch((error) => {
    console.error('capstone_completion_objectives_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
