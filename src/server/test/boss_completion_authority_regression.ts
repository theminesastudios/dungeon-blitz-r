import { strict as assert } from 'assert';
import * as path from 'path';
import { CombatHandler } from '../handlers/CombatHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { EntityState, EntityTeam } from '../core/Entity';

type FakeClient = {
    token: number;
    userId: number | null;
    character: any;
    characters: any[];
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId?: number;
    clientEntID?: number;
    playerSpawned: boolean;
    keepTutorialState?: any;
    entities: Map<number, any>;
    knownEntityIds?: Set<number>;
    startedRoomEvents?: Set<string>;
    processedRewardSources?: Set<string>;
    sentPackets: Array<{ id: number; payload: Buffer }>;
    sendBitBuffer(id: number, bb: any): void;
    send(id: number, payload: Buffer): void;
};

function ensureLevelConfigLoaded(): void {
    if (!LevelConfig.has('TutorialDungeon')) {
        LevelConfig.load(path.resolve(__dirname, '../data'));
    }
}

function createClient(token: number): FakeClient {
    const sentPackets: Array<{ id: number; payload: Buffer }> = [];
    return {
        token,
        userId: token,
        character: { name: `Hero${token}`, CurrentLevel: { name: 'TutorialDungeon', x: 0, y: 0 } },
        characters: [],
        currentLevel: 'TutorialDungeon',
        levelInstanceId: 'party-run',
        currentRoomId: 0,
        clientEntID: token + 10000,
        playerSpawned: true,
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        startedRoomEvents: new Set<string>(),
        processedRewardSources: new Set<string>(),
        sentPackets,
        sendBitBuffer(id: number, bb: any) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        },
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload });
        }
    };
}

function createEntityDestroyPacket(entityId: number): Buffer {
    const bb = new BitBuffer();
    bb.writeMethod9(entityId);
    return bb.toBuffer();
}

function createPowerHitPacket(targetId: number, sourceId: number, damage: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(targetId);
    bb.writeMethod4(sourceId);
    bb.writeMethod24(damage);
    bb.writeMethod4(77);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function createEntityStatePacket(entityId: number, entState: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod45(0);
    bb.writeMethod45(0);
    bb.writeMethod45(0);
    bb.writeMethod6(entState, 2);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

async function testBossCompletionUsesAuthorityClientWhenKillerIsNotAuthority(): Promise<void> {
    ensureLevelConfigLoaded();

    const killer = createClient(1001);
    const authority = createClient(2002);

    GlobalState.sessionsByToken.set(killer.token, killer as never);
    GlobalState.sessionsByToken.set(authority.token, authority as never);

    const levelScope = `${killer.currentLevel}#${killer.levelInstanceId}`;
    const bossId = 500;
    const bossEntity = {
        name: 'SomeBoss',
        isPlayer: false,
        clientSpawned: true,
        team: EntityTeam.ENEMY,
        ownerToken: authority.token
    };

    killer.entities.set(bossId, bossEntity);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([[bossId, bossEntity]]));

    const originalEnemyDefeat = MissionHandler.handleEnemyDefeatMissionProgress;
    const originalForcedCompletion = MissionHandler.handleForcedDungeonBossCompletion;
    const invokedTokens: number[] = [];

    MissionHandler.handleEnemyDefeatMissionProgress = async () => undefined;
    MissionHandler.handleForcedDungeonBossCompletion = async (client: any) => {
        invokedTokens.push(Number(client?.token ?? 0));
    };

    try {
        await CombatHandler.handleEntityDestroy(killer as never, createEntityDestroyPacket(bossId));
    } finally {
        MissionHandler.handleEnemyDefeatMissionProgress = originalEnemyDefeat;
        MissionHandler.handleForcedDungeonBossCompletion = originalForcedCompletion;
    }

    assert.deepEqual(invokedTokens, [authority.token]);
}

async function testLiveRequiredBossDestroyIsIgnored(): Promise<void> {
    ensureLevelConfigLoaded();

    const client = createClient(3003);
    client.currentLevel = 'JC_Mission1';
    client.character.CurrentLevel = { name: 'JC_Mission1', x: 0, y: 0 };

    GlobalState.sessionsByToken.set(client.token, client as never);

    const levelScope = `${client.currentLevel}#${client.levelInstanceId}`;
    const bossId = 601;
    const bossEntity = {
        id: bossId,
        name: 'ImperialChampion',
        isPlayer: false,
        clientSpawned: true,
        team: EntityTeam.ENEMY,
        hp: 100,
        maxHp: 100,
        entState: EntityState.ACTIVE,
        dead: false,
        ownerToken: client.token
    };

    GlobalState.levelEntities.set(levelScope, new Map<number, any>([[bossId, bossEntity]]));

    const originalEnemyDefeat = MissionHandler.handleEnemyDefeatMissionProgress;
    const originalForcedCompletion = MissionHandler.handleForcedDungeonBossCompletion;
    const invokedTokens: number[] = [];

    MissionHandler.handleEnemyDefeatMissionProgress = async () => undefined;
    MissionHandler.handleForcedDungeonBossCompletion = async (completionClient: any) => {
        invokedTokens.push(Number(completionClient?.token ?? 0));
    };

    try {
        await CombatHandler.handleEntityDestroy(client as never, createEntityDestroyPacket(bossId));
    } finally {
        MissionHandler.handleEnemyDefeatMissionProgress = originalEnemyDefeat;
        MissionHandler.handleForcedDungeonBossCompletion = originalForcedCompletion;
    }

    assert.deepEqual(invokedTokens, []);
    assert.equal(GlobalState.levelEntities.get(levelScope)?.has(bossId), true);
}

async function testLiveRequiredBossDeadStateIsIgnored(): Promise<void> {
    ensureLevelConfigLoaded();

    const client = createClient(4004);
    client.currentLevel = 'JC_Mission1';
    client.character.CurrentLevel = { name: 'JC_Mission1', x: 0, y: 0 };

    GlobalState.sessionsByToken.set(client.token, client as never);

    const levelScope = `${client.currentLevel}#${client.levelInstanceId}`;
    const bossId = 602;
    const bossEntity = {
        id: bossId,
        name: 'ImperialChampion',
        isPlayer: false,
        clientSpawned: true,
        team: EntityTeam.ENEMY,
        hp: 100,
        maxHp: 100,
        entState: EntityState.ACTIVE,
        dead: false,
        ownerToken: client.token
    };

    GlobalState.levelEntities.set(levelScope, new Map<number, any>([[bossId, bossEntity]]));

    const originalEnemyDefeat = MissionHandler.handleEnemyDefeatMissionProgress;
    const originalForcedCompletion = MissionHandler.handleForcedDungeonBossCompletion;
    const invokedTokens: number[] = [];

    MissionHandler.handleEnemyDefeatMissionProgress = async () => undefined;
    MissionHandler.handleForcedDungeonBossCompletion = async (completionClient: any) => {
        invokedTokens.push(Number(completionClient?.token ?? 0));
    };

    try {
        await LevelHandler.handleEntityIncrementalUpdate(client as never, createEntityStatePacket(bossId, EntityState.DEAD));
    } finally {
        MissionHandler.handleEnemyDefeatMissionProgress = originalEnemyDefeat;
        MissionHandler.handleForcedDungeonBossCompletion = originalForcedCompletion;
    }

    assert.deepEqual(invokedTokens, []);
    assert.equal(Boolean(GlobalState.levelEntities.get(levelScope)?.get(bossId)?.dead), false);
    assert.equal(Number(GlobalState.levelEntities.get(levelScope)?.get(bossId)?.entState), EntityState.ACTIVE);
}

async function testContributedClientSpawnedBossDestroyCompletes(): Promise<void> {
    ensureLevelConfigLoaded();

    const client = createClient(5005);
    client.currentLevel = 'SRN_Mission1';
    client.character.CurrentLevel = { name: 'SRN_Mission1', x: 0, y: 0 };

    GlobalState.sessionsByToken.set(client.token, client as never);

    const levelScope = `${client.currentLevel}#${client.levelInstanceId}`;
    const bossId = 603;
    const bossEntity = {
        id: bossId,
        name: 'LizardLord',
        isPlayer: false,
        clientSpawned: true,
        team: EntityTeam.ENEMY,
        entRank: 'Boss',
        hp: 100,
        maxHp: 100,
        entState: EntityState.ACTIVE,
        dead: false,
        ownerToken: client.token
    };
    const playerEntity = {
        id: client.clientEntID,
        name: client.character.name,
        isPlayer: true,
        team: EntityTeam.PLAYER,
        entState: EntityState.ACTIVE,
        dead: false
    };

    client.entities.set(client.clientEntID!, playerEntity);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [client.clientEntID!, playerEntity],
        [bossId, bossEntity]
    ]));

    const originalEnemyDefeat = MissionHandler.handleEnemyDefeatMissionProgress;
    const originalForcedCompletion = MissionHandler.handleForcedDungeonBossCompletion;
    const invokedTokens: number[] = [];

    MissionHandler.handleEnemyDefeatMissionProgress = async () => undefined;
    MissionHandler.handleForcedDungeonBossCompletion = async (completionClient: any) => {
        invokedTokens.push(Number(completionClient?.token ?? 0));
    };

    try {
        await CombatHandler.handlePowerHit(client as never, createPowerHitPacket(bossId, client.clientEntID!, 5));
        await CombatHandler.handleEntityDestroy(client as never, createEntityDestroyPacket(bossId));
    } finally {
        MissionHandler.handleEnemyDefeatMissionProgress = originalEnemyDefeat;
        MissionHandler.handleForcedDungeonBossCompletion = originalForcedCompletion;
    }

    assert.deepEqual(invokedTokens, [client.token]);
    assert.notEqual(GlobalState.levelEntities.get(levelScope)?.has(bossId), true);
}

async function testTowerTuataraOneHpBossDestroyCompletes(): Promise<void> {
    ensureLevelConfigLoaded();

    const client = createClient(6006);
    client.currentLevel = 'SRN_Mission1';
    client.character.CurrentLevel = { name: 'SRN_Mission1', x: 0, y: 0 };

    GlobalState.sessionsByToken.set(client.token, client as never);

    const levelScope = `${client.currentLevel}#${client.levelInstanceId}`;
    const bossId = 604;
    const bossEntity = {
        id: bossId,
        name: 'LizardLord',
        isPlayer: false,
        clientSpawned: true,
        team: EntityTeam.ENEMY,
        entRank: 'Boss',
        hp: 1,
        maxHp: 100,
        entState: EntityState.ACTIVE,
        dead: false,
        ownerToken: client.token
    };

    GlobalState.levelEntities.set(levelScope, new Map<number, any>([[bossId, bossEntity]]));

    const originalEnemyDefeat = MissionHandler.handleEnemyDefeatMissionProgress;
    const originalForcedCompletion = MissionHandler.handleForcedDungeonBossCompletion;
    const invokedTokens: number[] = [];

    MissionHandler.handleEnemyDefeatMissionProgress = async () => undefined;
    MissionHandler.handleForcedDungeonBossCompletion = async (completionClient: any) => {
        invokedTokens.push(Number(completionClient?.token ?? 0));
    };

    try {
        await CombatHandler.handleEntityDestroy(client as never, createEntityDestroyPacket(bossId));
    } finally {
        MissionHandler.handleEnemyDefeatMissionProgress = originalEnemyDefeat;
        MissionHandler.handleForcedDungeonBossCompletion = originalForcedCompletion;
    }

    assert.deepEqual(invokedTokens, [client.token]);
    assert.notEqual(GlobalState.levelEntities.get(levelScope)?.has(bossId), true);
}

async function main(): Promise<void> {
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const levelEntities = new Map(GlobalState.levelEntities);
    try {
        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();

        await testBossCompletionUsesAuthorityClientWhenKillerIsNotAuthority();
        await testLiveRequiredBossDestroyIsIgnored();
        await testLiveRequiredBossDeadStateIsIgnored();
        await testContributedClientSpawnedBossDestroyCompletes();
        await testTowerTuataraOneHpBossDestroyCompletes();
    } finally {
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.levelEntities = levelEntities;
    }
    console.log('boss_completion_authority_regression: ok');
}

void main().catch((error) => {
    console.error('boss_completion_authority_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
