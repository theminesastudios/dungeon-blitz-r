import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = { id: number; payload: Buffer };
type FakeClient = {
    currentLevel: string;
    levelInstanceId: string;
    token: number;
    userId: null;
    playerSpawned: boolean;
    character: any;
    characters: any[];
    sentPackets: SentPacket[];
    entities: Map<number, any>;
    keepTutorialState: any;
    pendingDungeonCompletionScope: string;
    pendingDungeonCompletionRequestedAt: number;
    pendingDungeonCompletionLastSkitAt: number;
    pendingDungeonCompletionNotBeforeAt: number;
    pendingDungeonCompletionSettleMs: number;
    pendingDungeonCompletionPayload: Buffer | null;
    pendingDungeonCompletionForceSharedScope: string;
    pendingDungeonCompletionTimer: NodeJS.Timeout | null;
    pendingDungeonCompletionFlushActive: boolean;
    pendingDungeonCompletionWaitForCutsceneEnd: boolean;
    activeDungeonCutsceneScope: string;
    activeDungeonCutsceneRoomId: number;
    forcedDungeonCompletionScope: string;
    finalizingDungeonCompletionScope: string;
    completedDungeonCompletionScope: string;
    completedDungeonCompletionSentAt: number;
    lastDoorId: number;
    lastDoorTargetLevel: string;
    armPendingTransferGrace(): void;
    send(id: number, payload: Buffer): void;
    sendBitBuffer(id: number, bb: BitBuffer): void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('CraftTownTutorial')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.ClearYourHouse)) {
        MissionLoader.load(dataDir);
    }
}

function createFakeClient(name: string, token: number): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = {
        name,
        CurrentLevel: { name: 'CraftTown', x: 918, y: 1440 },
        PreviousLevel: { name: 'WolfsEnd', x: 1210, y: 880 },
        missions: {
            [String(MissionID.ClearYourHouse)]: {
                state: 1,
                currCount: 0
            }
        },
        questTrackerState: 0,
        level: 1,
        xp: 0,
        gold: 0,
        magicForge: {
            stats_by_building: {
                '12': 0
            }
        },
        buildingUpgrade: {
            buildingID: 12,
            rank: 5,
            ReadyTime: 999999999
        }
    };

    return {
        currentLevel: 'CraftTownTutorial',
        levelInstanceId: 'keep-run',
        token,
        userId: null,
        playerSpawned: true,
        character,
        characters: [character],
        sentPackets,
        entities: new Map(),
        keepTutorialState: { bossDefeated: false },
        pendingDungeonCompletionScope: '',
        pendingDungeonCompletionRequestedAt: 0,
        pendingDungeonCompletionLastSkitAt: 0,
        pendingDungeonCompletionNotBeforeAt: 0,
        pendingDungeonCompletionSettleMs: 0,
        pendingDungeonCompletionPayload: null,
        pendingDungeonCompletionForceSharedScope: '',
        pendingDungeonCompletionTimer: null,
        pendingDungeonCompletionFlushActive: false,
        pendingDungeonCompletionWaitForCutsceneEnd: false,
        activeDungeonCutsceneScope: '',
        activeDungeonCutsceneRoomId: 0,
        forcedDungeonCompletionScope: '',
        finalizingDungeonCompletionScope: '',
        completedDungeonCompletionScope: '',
        completedDungeonCompletionSentAt: 0,
        lastDoorId: 0,
        lastDoorTargetLevel: '',
        armPendingTransferGrace() {
            return undefined;
        },
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function seedKeepStateWithAliveHelper(): void {
    GlobalState.levelEntities.set('CraftTownTutorial#keep-run', new Map([
        [
            7402,
            {
                id: 7402,
                name: 'GoblinDagger',
                isPlayer: false,
                roomId: 7,
                team: 2,
                entState: 1,
                hp: 100,
                dead: false
            }
        ]
    ]));
}

function bossDeathReport(): any {
    return {
        id: 7401,
        character_name: ',GoblinShamanHood',
        isPlayer: false,
        roomId: 7,
        team: 2,
        entState: 6,
        hp: 0,
        dead: true
    };
}

function decodeDoorTarget(payload: Buffer): { doorId: number; targetLevel: string } {
    const br = new BitReader(payload);
    return {
        doorId: br.readMethod4(),
        targetLevel: br.readMethod13()
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function testKeepBossDeathCompletesQuestAfterCutsceneDespiteAliveHelpers(): Promise<void> {
    const client = createFakeClient('KeepRunner', 7001);
    seedKeepStateWithAliveHelper();

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, bossDeathReport());

    assert.equal(client.keepTutorialState.bossDefeated, true, 'server should record Ranik as defeated');
    assert.equal(client.pendingDungeonCompletionScope, 'CraftTownTutorial#keep-run');
    assert.equal(client.pendingDungeonCompletionWaitForCutsceneEnd, true);
    assert.equal(client.sentPackets.some((packet) => packet.id === 0x87), false);

    MissionHandler.noteDungeonCutsceneStart(client as never, 7);
    MissionHandler.noteDungeonCutsceneEnd(client as never, 7);
    await sleep(0);

    assert.equal(client.sentPackets.some((packet) => packet.id === 0x87), false, 'keep completion should not show dungeon stats');
    assert.equal(Number(client.character.questTrackerState ?? 0), 100, 'quest tracker should update to 1/1');
    assert.equal(Number(client.character.missions[String(MissionID.ClearYourHouse)]?.state ?? 0), 3);
    assert.equal(Number(client.character.magicForge?.stats_by_building?.['12'] ?? 0), 5);
    assert.deepEqual(client.character.buildingUpgrade, { buildingID: 0, rank: 0, ReadyTime: 0 });

    const doorTarget = client.sentPackets.find((packet) => packet.id === 0x2E);
    assert.ok(doorTarget, 'completion should send the Home door target after the cutscene');
    assert.deepEqual(decodeDoorTarget(doorTarget.payload), { doorId: 2, targetLevel: 'CraftTown' });
}

async function testKeepBossDeathPropagatesCompletionToParty(): Promise<void> {
    const host = createFakeClient('KeepHost', 7101);
    const party = createFakeClient('KeepParty', 7102);
    seedKeepStateWithAliveHelper();
    GlobalState.sessionsByToken.set(host.token, host as never);
    GlobalState.sessionsByToken.set(party.token, party as never);

    await MissionHandler.handleForcedDungeonBossCompletion(host as never, bossDeathReport());
    MissionHandler.noteDungeonCutsceneStart(host as never, 7);
    MissionHandler.noteDungeonCutsceneEnd(host as never, 7);
    await sleep(0);

    for (const client of [host, party]) {
        assert.equal(Number(client.character.questTrackerState ?? 0), 100);
        assert.equal(Number(client.character.missions[String(MissionID.ClearYourHouse)]?.state ?? 0), 3);
        assert.equal(Number(client.character.magicForge?.stats_by_building?.['12'] ?? 0), 5);
        assert.equal(client.sentPackets.some((packet) => packet.id === 0xB7), true);
        assert.equal(client.sentPackets.some((packet) => packet.id === 0x2E), true);
        assert.equal(client.sentPackets.some((packet) => packet.id === 0x87), false);
    }
}

async function main(): Promise<void> {
    ensureDataLoaded();
    const levelEntities = new Map(GlobalState.levelEntities);
    const levelQuestProgress = new Map(GlobalState.levelQuestProgress);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);

    try {
        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        await testKeepBossDeathCompletesQuestAfterCutsceneDespiteAliveHelpers();

        GlobalState.levelEntities.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.sessionsByToken.clear();
        await testKeepBossDeathPropagatesCompletionToParty();
    } finally {
        GlobalState.levelEntities = levelEntities;
        GlobalState.levelQuestProgress = levelQuestProgress;
        GlobalState.sessionsByToken.clear();
        for (const [token, session] of sessionsByToken) {
            GlobalState.sessionsByToken.set(token, session);
        }
    }

    console.log('craft_town_tutorial_completion_regression: ok');
}

void main().catch((error) => {
    console.error('craft_town_tutorial_completion_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
