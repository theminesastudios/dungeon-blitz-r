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
    pendingDungeonCompletionScope?: string;
    pendingDungeonCompletionWaitForCutsceneEnd?: boolean;
    pendingDungeonCompletionPayload?: Buffer | null;
    pendingDungeonCompletionTimer?: NodeJS.Timeout | null;
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
    if (!LevelConfig.has('BT_Mission1Hard')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.DefeatBanditCampHard)) {
        MissionLoader.load(dataDir);
    }
    if (!GameData.getEntType('BanditTwinAHard')) {
        GameData.load(dataDir);
    }
}

function createClient(): FakeClient {
    const sentPackets: SentPacket[] = [];
    return {
        token: 48804,
        currentLevel: 'BT_Mission1Hard',
        levelInstanceId: 'bandit-camp-hard',
        currentRoomId: 1,
        playerSpawned: true,
        forcedDungeonCompletionScope: '',
        pendingDungeonCompletionTimer: null,
        userId: null,
        character: {
            name: 'BanditCampTester',
            level: 26,
            xp: 0,
            CurrentLevel: { name: 'BT_Mission1Hard', x: 0, y: 0 },
            PreviousLevel: { name: 'BridgeTownHard', x: 0, y: 0 },
            missions: {
                [String(MissionID.DefeatBanditCampHard)]: {
                    state: 1,
                    currCount: 0
                }
            },
            questTrackerState: 55
        },
        entities: new Map(),
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createBanditTwin(id: number, name: string, defeated: boolean): Record<string, unknown> {
    return {
        id,
        name,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        entRank: 'Boss',
        entState: defeated ? EntityState.DEAD : EntityState.ACTIVE,
        dead: defeated,
        hp: defeated ? 0 : 500,
        roomId: 1
    };
}

function setLevelEntities(client: FakeClient, entities: Array<[number, unknown]>): void {
    const entityMap = new Map<number, unknown>(entities);
    client.entities = entityMap;
    GlobalState.levelEntities.set(`${client.currentLevel}#${client.levelInstanceId}`, entityMap);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testDreadBanditCampWaitsForBothTwinsAndCinematic(): Promise<void> {
    const client = createClient();
    const levelScope = `${client.currentLevel}#${client.levelInstanceId}`;
    const twinA = createBanditTwin(9401, 'BanditTwinAHard', true);
    const twinB = createBanditTwin(9402, 'BanditTwinBHard', false);
    setLevelEntities(client, [
        [9401, twinA],
        [9402, twinB]
    ]);

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, twinA);
    await sleep(0);

    assert.equal(
        String(client.pendingDungeonCompletionScope ?? ''),
        '',
        'Dread Bandit Camp should not queue dungeon completion after only one Bandit Twin dies'
    );
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x87), false);

    Object.assign(twinB, {
        entState: EntityState.DEAD,
        dead: true,
        hp: 0
    });

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, twinB);
    await sleep(0);

    assert.equal(
        String(client.pendingDungeonCompletionScope ?? ''),
        levelScope,
        'Dread Bandit Camp should queue completion only after both Bandit Twins die'
    );
    assert.equal(
        Boolean(client.pendingDungeonCompletionWaitForCutsceneEnd),
        true,
        'Dread Bandit Camp should wait for the post-death cinematic before showing completion'
    );
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x87), false);

    MissionHandler.noteDungeonCutsceneEnd(client as never, 1);
    await sleep(0);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        true,
        'Dread Bandit Camp should show completion when the post-death cinematic ends'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.DefeatBanditCampHard)]?.state ?? 0),
        2,
        'Dread Bandit Camp should complete the mission after both bosses and the cinematic release'
    );
}

async function main(): Promise<void> {
    ensureDataLoaded();
    await testDreadBanditCampWaitsForBothTwinsAndCinematic();
    GlobalState.levelEntities.delete('BT_Mission1Hard#bandit-camp-hard');
    console.log('bandit_camp_completion_regression: ok');
}

void main().catch((error) => {
    console.error('bandit_camp_completion_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
