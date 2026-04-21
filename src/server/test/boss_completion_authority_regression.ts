import { strict as assert } from 'assert';
import * as path from 'path';
import { CombatHandler } from '../handlers/CombatHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { EntityTeam } from '../core/Entity';

type FakeClient = {
    token: number;
    userId: number | null;
    character: any;
    characters: any[];
    currentLevel: string;
    levelInstanceId: string;
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

async function main(): Promise<void> {
    await testBossCompletionUsesAuthorityClientWhenKillerIsNotAuthority();
    console.log('boss_completion_authority_regression: ok');
}

void main().catch((error) => {
    console.error('boss_completion_authority_regression: failed');
    console.error(error);
    process.exitCode = 1;
});

