import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    forcedDungeonCompletionScope: string;
    pendingDungeonCompletionFlushActive?: boolean;
    userId: number | null;
    character: {
        name: string;
        level: number;
        xp: number;
        CurrentLevel: { name: string; x: number; y: number };
        PreviousLevel: { name: string; x: number; y: number };
        missions: Record<string, Record<string, number>>;
        questTrackerState: number;
        lastCompletedDungeonLevel?: string;
    };
    entities: Map<number, unknown>;
    sentPackets: SentPacket[];
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('AC_Mission1')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.DeepgardDragon)) {
        MissionLoader.load(dataDir);
    }
    if (!GameData.getEntType('AncientDragonGold')) {
        GameData.load(dataDir);
    }
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

function createClient(flowId: string): FakeClient {
    const sentPackets: SentPacket[] = [];
    return {
        token: 48801,
        currentLevel: 'AC_Mission1',
        levelInstanceId: `deepgard-${flowId}`,
        currentRoomId: 6,
        playerSpawned: true,
        forcedDungeonCompletionScope: '',
        userId: null,
        character: {
            name: `DeepgardTester-${flowId}`,
            level: 19,
            xp: 0,
            CurrentLevel: { name: 'AC_Mission1', x: 0, y: 0 },
            PreviousLevel: { name: 'AncientCastle', x: 0, y: 0 },
            missions: {
                [String(MissionID.DeepgardDragon)]: {
                    state: 1,
                    currCount: 0
                }
            },
            questTrackerState: 82
        },
        entities: new Map(),
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function setLevelEntities(client: FakeClient, entities: Array<[number, unknown]>): void {
    const scope = `${client.currentLevel}#${client.levelInstanceId}`;
    const entityMap = new Map<number, unknown>(entities);
    client.entities = entityMap;
    GlobalState.levelEntities.set(scope, entityMap);
}

function createDefeatedEntity(id: number, name: string, entRank: string = 'Boss'): Record<string, unknown> {
    return {
        id,
        name,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entRank,
        entState: EntityState.DEAD,
        dead: true,
        hp: 0,
        roomId: 6
    };
}

async function testGenericBossRankDoesNotCompleteMappedDungeon(): Promise<void> {
    const client = createClient('wrong-boss');
    setLevelEntities(client, [
        [8801, createDefeatedEntity(8801, 'WrongBoss')]
    ]);

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket());

    assert.equal(
        Number(client.character.missions[String(MissionID.DeepgardDragon)]?.state ?? 0),
        1,
        'Deepgard should ignore defeated boss-ranked entities that are not the mapped dungeon boss'
    );
    assert.equal(client.character.questTrackerState, 82);
    assert.equal(client.character.lastCompletedDungeonLevel, undefined);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x87), false);
}

async function testMappedBossCompletesDungeon(): Promise<void> {
    const client = createClient('mapped-boss');
    setLevelEntities(client, [
        [8802, createDefeatedEntity(8802, 'AncientDragonGold')]
    ]);
    client.forcedDungeonCompletionScope = `${client.currentLevel}#${client.levelInstanceId}`;
    client.pendingDungeonCompletionFlushActive = true;

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket());

    assert.equal(
        Number(client.character.missions[String(MissionID.DeepgardDragon)]?.state ?? 0),
        2,
        'Deepgard should complete after the mapped Ancient Dragon Gold boss is defeated'
    );
    assert.equal(client.character.questTrackerState, 100);
    assert.equal(client.character.lastCompletedDungeonLevel, 'AC_Mission1');
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x87), true);
}

async function main(): Promise<void> {
    ensureDataLoaded();
    await testGenericBossRankDoesNotCompleteMappedDungeon();
    await testMappedBossCompletesDungeon();
    GlobalState.levelEntities.delete('AC_Mission1#deepgard-wrong-boss');
    GlobalState.levelEntities.delete('AC_Mission1#deepgard-mapped-boss');
    console.log('dungeon_boss_entity_map_completion_regression: ok');
}

void main().catch((error) => {
    console.error('dungeon_boss_entity_map_completion_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
