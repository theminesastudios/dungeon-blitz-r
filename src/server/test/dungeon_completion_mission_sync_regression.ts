import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { LevelHandler } from '../handlers/LevelHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

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
    userId: number | null;
    character: {
        name: string;
        level: number;
        xp?: number;
        gold?: number;
        CurrentLevel: { name: string; x: number; y: number };
        PreviousLevel: { name: string; x: number; y: number };
        missions: Record<string, Record<string, number>>;
        questTrackerState: number;
        lastCompletedDungeonLevel?: string;
    };
    characters?: any[];
    entities: Map<number, unknown>;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('DreamDragonDungeon') || !LevelConfig.has('CH_MiniMission1')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.SlayTheDragon) || !MissionLoader.getMissionDef(MissionID.ClearMini1)) {
        MissionLoader.load(dataDir);
    }
}

function createFakeClient(): FakeClient {
    const sentPackets: SentPacket[] = [];

    return {
        token: 7777,
        currentLevel: 'DreamDragonDungeon',
        levelInstanceId: 'dragon-flow',
        currentRoomId: 1,
        playerSpawned: true,
        forcedDungeonCompletionScope: 'DreamDragonDungeon#dragon-flow',
        userId: null,
        character: {
            name: 'DragonFlowTester',
            level: 2,
            xp: 0,
            gold: 0,
            CurrentLevel: { name: 'DreamDragonDungeon', x: 0, y: 0 },
            PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 },
            missions: {
                [String(MissionID.KillNephit)]: {
                    state: 3,
                    currCount: 1,
                    claimed: 1,
                    complete: 1
                },
                [String(MissionID.SlayTheDragon)]: {
                    state: 1,
                    currCount: 0
                }
            },
            questTrackerState: 100
        },
        entities: new Map(),
        sentPackets,
        send(id: number, payload: Buffer): void {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createForgottenForgeClient(): FakeClient {
    const client = createFakeClient();
    client.currentLevel = 'OMM_Mission6';
    client.levelInstanceId = 'forgotten-forge-flow';
    client.forcedDungeonCompletionScope = 'OMM_Mission6#forgotten-forge-flow';
    client.character.name = 'ForgottenForgeTester';
    client.character.level = 17;
    client.character.CurrentLevel = { name: 'OMM_Mission6', x: 0, y: 0 };
    client.character.PreviousLevel = { name: 'OldMineMountain', x: 189, y: 1335 };
    client.character.missions = {
        [String(MissionID.DeliverToSwamp)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        [String(MissionID.AbandonedArmory)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        }
    };
    client.character.questTrackerState = 100;
    client.sentPackets.length = 0;
    return client;
}

function createLordTillyRestClient(): FakeClient {
    const client = createFakeClient();
    client.currentLevel = 'CH_Mission4';
    client.levelInstanceId = 'lord-tilly-rest-flow';
    client.forcedDungeonCompletionScope = 'CH_Mission4#lord-tilly-rest-flow';
    client.character.name = 'LordTillyRestTester';
    client.character.level = 12;
    client.character.CurrentLevel = { name: 'CH_Mission4', x: 0, y: 0 };
    client.character.PreviousLevel = { name: 'CemeteryHill', x: 7469, y: 385 };
    client.character.missions = {
        [String(MissionID.JackalTreasure)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        [String(MissionID.MissingPappy)]: {
            state: 1,
            currCount: 0
        }
    };
    client.character.questTrackerState = 100;
    client.sentPackets.length = 0;
    return client;
}

function createMeyloursEmbersClient(): FakeClient {
    const client = createFakeClient();
    client.currentLevel = 'OMM_Mission11';
    client.levelInstanceId = 'meylours-embers-flow';
    client.forcedDungeonCompletionScope = 'OMM_Mission11#meylours-embers-flow';
    client.character.name = 'MeyloursEmbersTester';
    client.character.level = 18;
    client.character.xp = 0;
    client.character.gold = 0;
    client.character.CurrentLevel = { name: 'OMM_Mission11', x: 0, y: 0 };
    client.character.PreviousLevel = { name: 'OldMineMountain', x: 189, y: 1335 };
    client.character.missions = {
        [String(MissionID.DeliverToSwamp)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        [String(MissionID.DragonsQuarry)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        [String(MissionID.CutToTheHeart)]: {
            state: 1,
            currCount: 0
        }
    };
    client.character.questTrackerState = 100;
    client.sentPackets.length = 0;
    return client;
}

function createCemeteryMiniClient(): FakeClient {
    const client = createFakeClient();
    client.currentLevel = 'CH_MiniMission1';
    client.levelInstanceId = 'lady-ellen-full-clear-flow';
    client.forcedDungeonCompletionScope = '';
    client.character.name = 'LadyEllenFullClearTester';
    client.character.level = 11;
    client.character.CurrentLevel = { name: 'CH_MiniMission1', x: 0, y: 0 };
    client.character.PreviousLevel = { name: 'CemeteryHill', x: 7469, y: 385 };
    client.character.missions = {
        [String(MissionID.DeliverToSwamp)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        }
    };
    client.character.questTrackerState = 72;
    client.sentPackets.length = 0;
    client.characters = [client.character];
    return client;
}

function createValhavenDungeonChainClient(
    currentLevel: string,
    activeMissionId: MissionID,
    prerequisiteMissionIds: MissionID[]
): FakeClient {
    const client = createFakeClient();
    client.currentLevel = currentLevel;
    client.levelInstanceId = `${currentLevel.toLowerCase()}-story-chain-flow`;
    client.forcedDungeonCompletionScope = `${currentLevel}#${client.levelInstanceId}`;
    client.character.name = `${currentLevel}StoryChainTester`;
    client.character.level = currentLevel.endsWith('Hard') ? 33 : 30;
    client.character.CurrentLevel = { name: currentLevel, x: 0, y: 0 };
    client.character.PreviousLevel = {
        name: currentLevel.endsWith('Hard') ? 'JadeCityHard' : 'JadeCity',
        x: 10430,
        y: 1058
    };
    client.character.missions = {
        [String(MissionID.DeliverToSwamp)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        }
    };
    for (const missionId of prerequisiteMissionIds) {
        client.character.missions[String(missionId)] = {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        };
    }
    client.character.missions[String(activeMissionId)] = {
        state: 1,
        currCount: 0
    };
    client.character.questTrackerState = 100;
    client.sentPackets.length = 0;
    seedDefeatedValhavenBosses(client, currentLevel.endsWith('Hard'));
    return client;
}

function seedDefeatedValhavenBosses(client: FakeClient, hardMode: boolean): void {
    const firstBossName = hardMode ? 'GreaterBoneGolemHard' : 'GreaterBoneGolem';
    const secondBossName = hardMode ? 'GreaterBoneGolem2Hard' : 'GreaterBoneGolem2';
    const levelScope = getClientLevelScope(client as never);
    const bosses = new Map<number, unknown>([
        [
            9101,
            {
                id: 9101,
                name: firstBossName,
                isPlayer: false,
                team: EntityTeam.ENEMY,
                entRank: 'Boss',
                entState: EntityState.DEAD,
                hp: 0,
                dead: true,
                clientSpawned: true,
                playerDamageContributed: true,
                ownerToken: client.token,
                roomId: 6
            }
        ],
        [
            9102,
            {
                id: 9102,
                name: secondBossName,
                isPlayer: false,
                team: EntityTeam.ENEMY,
                entRank: 'Boss',
                entState: EntityState.DEAD,
                hp: 0,
                dead: true,
                clientSpawned: true,
                playerDamageContributed: true,
                ownerToken: client.token,
                roomId: 6
            }
        ]
    ]);
    client.entities = bosses;
    GlobalState.levelEntities.set(levelScope, bosses);
    (client as any).dungeonRun = {
        levelScope,
        bossKilled: true,
        bossDefeatTime: Date.now() - 1000
    };
    (client as any).lastDungeonCutsceneEndScope = levelScope;
    (client as any).lastDungeonCutsceneEndAt = Date.now();
}

function createCompletedValhavenFullClearClient(currentLevel: string, missionId: MissionID): FakeClient {
    const client = createFakeClient();
    client.currentLevel = currentLevel;
    client.levelInstanceId = `${currentLevel.toLowerCase()}-repeat-entry-flow`;
    client.forcedDungeonCompletionScope = '';
    client.character.name = `${currentLevel}RepeatEntryTester`;
    client.character.level = currentLevel.endsWith('Hard') ? 33 : 30;
    client.character.CurrentLevel = { name: currentLevel, x: 0, y: 0 };
    client.character.PreviousLevel = {
        name: currentLevel.endsWith('Hard') ? 'JadeCityHard' : 'JadeCity',
        x: 10430,
        y: 1058
    };
    client.character.missions = {
        [String(MissionID.DeliverToSwamp)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        [String(missionId)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1,
            Time: 77,
            highscore: 1000,
            Tier: 3
        }
    };
    client.character.questTrackerState = 64;
    client.sentPackets.length = 0;
    client.characters = [client.character];
    return client;
}

function createAcceptedStormshardFullClearClient(currentLevel: string, missionId: MissionID): FakeClient {
    const client = createFakeClient();
    client.currentLevel = currentLevel;
    client.levelInstanceId = `${currentLevel.toLowerCase()}-full-clear-flow`;
    client.forcedDungeonCompletionScope = '';
    client.character.name = `${currentLevel}FullClearTester`;
    client.character.level = currentLevel.endsWith('Hard') ? 32 : 17;
    client.character.CurrentLevel = { name: currentLevel, x: 0, y: 0 };
    client.character.PreviousLevel = {
        name: currentLevel.endsWith('Hard') ? 'OldMineMountainHard' : 'OldMineMountain',
        x: 189,
        y: 1335
    };
    client.character.missions = {
        [String(MissionID.DeliverToSwamp)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        [String(missionId)]: {
            state: 1,
            currCount: 0
        }
    };
    client.character.questTrackerState = 64;
    client.sentPackets.length = 0;
    return client;
}

function createLevelCompletePacket(progress: number = 100, remainingKills: number = 0, requiredKills: number = 1): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(progress);
    bb.writeMethod9(209122);
    bb.writeMethod9(155);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(remainingKills);
    bb.writeMethod9(requiredKills);
    bb.writeMethod9(10);
    return bb.toBuffer();
}

function createQuestProgressPacket(progress: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(progress);
    return bb.toBuffer();
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeMissionAddedPacket(payload: Buffer): { missionId: number; active: number } {
    const br = new BitReader(payload);
    return {
        missionId: br.readMethod4(),
        active: br.readMethod6(1)
    };
}

function decodeMissionCompleteUiPacket(payload: Buffer): { missionId: number; stars: number; score: number } {
    const br = new BitReader(payload);
    return {
        missionId: br.readMethod4(),
        stars: br.readMethod15() ? br.readMethod6(4) : 0,
        score: br.readMethod4()
    };
}

async function testDungeonCompletionSyncsReadyMissionStateImmediately(): Promise<void> {
    const client = createFakeClient();
    client.character.questTrackerState = 64;

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket(5, 19, 20));

    assert.equal(
        Number(client.character.missions[String(MissionID.SlayTheDragon)]?.state ?? 0),
        2,
        "The Dragon's Dream should become ready to turn in after dungeon completion"
    );

    const missionAdded = client.sentPackets.find((packet) => packet.id === 0x85);
    assert.ok(
        missionAdded,
        'dungeon completion should push an immediate mission snapshot so the client quest flow updates without relogging'
    );
    assert.deepEqual(
        decodeMissionAddedPacket(missionAdded!.payload),
        {
            missionId: MissionID.SlayTheDragon,
            active: 0
        },
        'ready-to-turn-in dungeon missions should be sent back as inactive snapshots immediately after completion'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x86),
        true,
        'dungeon completion should still emit the mission-complete packet'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x84),
        false,
        'dungeon completion should not show the reward UI for missions that still require an NPC turn-in'
    );
    assert.equal(
        client.character.questTrackerState,
        100,
        'dungeon completion should move the live quest tracker state to 100 immediately'
    );
    assert.equal(
        client.character.lastCompletedDungeonLevel,
        'DreamDragonDungeon',
        'dungeon completion should remember which exact dungeon supplied the global 100% tracker state'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0xB7),
        true,
        'even low incoming progress should be overridden so the client shows the dungeon as finished immediately'
    );
}

async function testLordTillyRestWaitsForNpcRewardClaim(): Promise<void> {
    const client = createLordTillyRestClient();

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket(100, 0, 1));

    assert.equal(
        Number(client.character.missions[String(MissionID.MissingPappy)]?.state ?? 0),
        2,
        "Lord Tilly's Rest should become ready to turn in after dungeon completion"
    );
    assert.equal(
        client.character.missions[String(MissionID.MissingPappy)]?.claimed,
        undefined,
        "Lord Tilly's Rest should not be marked claimed before talking to the return NPC"
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x86),
        true,
        "Lord Tilly's Rest should still emit the mission-complete notification"
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x84),
        false,
        "Lord Tilly's Rest should not open the reward UI until the return NPC turn-in"
    );
}

async function testDungeonCompletionDoesNotCreateUnstartedMission(): Promise<void> {
    const client = createForgottenForgeClient();

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket(100, 0, 1));

    assert.equal(
        Number(client.character.missions[String(MissionID.ForgottenForge)]?.state ?? 0),
        0,
        'dungeon completion should not create a Forgotten Forge mission that the character never accepted'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.ForgottenForge)]?.currCount ?? 0),
        0,
        'unstarted dungeon missions should not be shown as 1/1 after completion'
    );
    assert.equal(
        client.character.lastCompletedDungeonLevel,
        undefined,
        'unstarted dungeon completion should not overwrite the last completed mission turn-in target'
    );

    const missionAdded = client.sentPackets.find((packet) => packet.id === 0x85);
    assert.equal(
        missionAdded,
        undefined,
        'unstarted dungeon completion should not send a surprise mission snapshot'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x84),
        false,
        'unstarted dungeon completion should not emit a mission reward UI'
    );
}

async function testAcceptedForgottenForgeCompletionWaitsForTurnIn(): Promise<void> {
    const client = createForgottenForgeClient();
    client.character.missions[String(MissionID.ForgottenForge)] = {
        state: 1,
        currCount: 0
    };

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket(100, 0, 1));

    assert.equal(
        Number(client.character.missions[String(MissionID.ForgottenForge)]?.state ?? 0),
        2,
        'accepted Forgotten Forge should become ready to turn in after completion'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.ForgottenForge)]?.currCount ?? 0),
        1,
        'accepted Forgotten Forge should persist completed objective count'
    );
    assert.equal(
        client.character.lastCompletedDungeonLevel,
        'OMM_Mission6',
        'accepted Forgotten Forge should remember the completed dungeon level for turn-in repair'
    );

    const missionAdded = client.sentPackets.find((packet) => packet.id === 0x85);
    assert.ok(missionAdded, 'accepted dungeon completion should sync the ready-to-turn-in mission snapshot');
    assert.deepEqual(decodeMissionAddedPacket(missionAdded!.payload), {
        missionId: MissionID.ForgottenForge,
        active: 0
    });
}

async function testMeyloursEmbersClaimsAdohiRewardAndPrimesGlades(): Promise<void> {
    const client = createMeyloursEmbersClient();

    await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket(100, 0, 1));

    assert.equal(
        Number(client.character.missions[String(MissionID.CutToTheHeart)]?.state ?? 0),
        3,
        "Meylour's Embers should be claimed immediately after the dungeon completes"
    );
    assert.equal(
        client.character.missions[String(MissionID.CutToTheHeart)]?.claimed,
        1,
        "Meylour's Embers should not wait for another Adohi turn-in"
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.HeadToTheGlades)]?.state ?? 0),
        2,
        'Emerald Glades should be primed as the next travel quest'
    );
    assert.ok(Number(client.character.xp ?? 0) >= 5, 'Adohi reward XP should be granted');
    assert.ok(Number(client.character.gold ?? 0) >= 5, 'Adohi reward gold should be granted');

    const gladesAdded = client.sentPackets.find((packet) => {
        if (packet.id !== 0x85) {
            return false;
        }
        return decodeMissionAddedPacket(packet.payload).missionId === MissionID.HeadToTheGlades;
    });
    assert.ok(gladesAdded, 'Emerald Glades should be pushed to the client after Meylour completes');
    assert.deepEqual(decodeMissionAddedPacket(gladesAdded!.payload), {
        missionId: MissionID.HeadToTheGlades,
        active: 0
    });
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x84),
        true,
        'Meylour completion should still show the Adohi mission reward UI'
    );
}

async function testValhavenDungeonChainAutoAcceptsProdigalSon(): Promise<void> {
    const cases: Array<{
        level: string;
        completedMissionId: MissionID;
        followupMissionId: MissionID;
        prerequisites: MissionID[];
    }> = [
        {
            level: 'JC_Mission2',
            completedMissionId: MissionID.BackAlleyDeals,
            followupMissionId: MissionID.TheProdigalSon,
            prerequisites: [MissionID.MeetWithOdin]
        },
        {
            level: 'JC_Mission2Hard',
            completedMissionId: MissionID.BackAlleyDealsHard,
            followupMissionId: MissionID.TheProdigalSonHard,
            prerequisites: [MissionID.MeetWithOdinHard]
        }
    ];

    for (const testCase of cases) {
        const client = createValhavenDungeonChainClient(
            testCase.level,
            testCase.completedMissionId,
            testCase.prerequisites
        );

        await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket(100, 0, 1));
        if (String((client as any).pendingDungeonCompletionScope ?? '')) {
            MissionHandler.noteDungeonCutsceneEnd(client as never, 6);
            await sleep(MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS + 100);
        }

        assert.equal(
            Number(client.character.missions[String(testCase.completedMissionId)]?.state ?? 0),
            3,
            `${testCase.level} should claim the completed Valhaven chain mission`
        );
        assert.equal(
            Number(client.character.missions[String(testCase.followupMissionId)]?.state ?? 0),
            1,
            `${testCase.level} should auto-accept The Prodigal Son before transferring to its dungeon`
        );

        const followupAdded = client.sentPackets.find((packet) => {
            if (packet.id !== 0x85) {
                return false;
            }
            return decodeMissionAddedPacket(packet.payload).missionId === testCase.followupMissionId;
        });
        assert.ok(followupAdded, `${testCase.level} should push The Prodigal Son quest to the client`);
        assert.deepEqual(decodeMissionAddedPacket(followupAdded!.payload), {
            missionId: testCase.followupMissionId,
            active: 1
        });
    }
}

function testLoginRepairAcceptsMissingValhavenDungeonChainQuest(): void {
    const cases: Array<{
        currentLevel: string;
        completedMissionId: MissionID;
        followupMissionId: MissionID;
        prerequisites: MissionID[];
    }> = [
        {
            currentLevel: 'JadeCity',
            completedMissionId: MissionID.BackAlleyDeals,
            followupMissionId: MissionID.TheProdigalSon,
            prerequisites: [MissionID.MeetWithOdin]
        },
        {
            currentLevel: 'JadeCityHard',
            completedMissionId: MissionID.BackAlleyDealsHard,
            followupMissionId: MissionID.TheProdigalSonHard,
            prerequisites: [MissionID.MeetWithOdinHard]
        }
    ];

    for (const testCase of cases) {
        const client = createValhavenDungeonChainClient(
            testCase.currentLevel,
            testCase.completedMissionId,
            testCase.prerequisites
        );
        client.character.missions[String(testCase.completedMissionId)] = {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        };
        client.character.missions[String(MissionID.DefendTheShip)] = {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        };
        client.character.missions[String(MissionID.MeetTheTown)] = {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        };
        delete client.character.missions[String(testCase.followupMissionId)];

        const repair = MissionHandler.repairEarlyStoryOnLogin(client.character as never, testCase.currentLevel);

        assert.equal(repair.didMutate, true, `${testCase.currentLevel} login should repair the missing chained quest`);
        assert.equal(
            repair.addedMissionId,
            testCase.followupMissionId,
            `${testCase.currentLevel} login should report the repaired chained quest id`
        );
        assert.equal(
            Number(client.character.missions[String(testCase.followupMissionId)]?.state ?? 0),
            1,
            `${testCase.currentLevel} login should accept the missing chained quest`
        );
    }
}

async function testCemeteryMiniDungeonStartsMissionOnEntry(): Promise<void> {
    const client = createCemeteryMiniClient();

    await MissionHandler.prepareFullClearDungeonEntry(client as never);
    MissionHandler.syncFullClearDungeonEntryMissionToClient(client as never);

    assert.equal(
        Number(client.character.missions[String(MissionID.ClearMini1)]?.state ?? 0),
        1,
        'Cemetery Hill mini tomb entry should start its matching clear mission'
    );
    assert.equal(
        Number(client.character.questTrackerState ?? -1),
        0,
        'Cemetery Hill mini tomb entry should reset the dungeon progress tracker'
    );
    const missionAdded = client.sentPackets.find((packet) => packet.id === 0x85);
    assert.ok(
        missionAdded,
        'Cemetery Hill mini tomb entry should push the active mission snapshot to the client'
    );
    assert.deepEqual(decodeMissionAddedPacket(missionAdded!.payload), {
        missionId: MissionID.ClearMini1,
        active: 1
    });
}

async function testCemeteryMiniDungeonCompletesOnlyFromFullClearProgress(): Promise<void> {
    const client = createCemeteryMiniClient();
    client.character.missions[String(MissionID.ClearMini1)] = {
        state: 1,
        currCount: 0
    };
    const levelScope = getClientLevelScope(client as never);
    const finalEnemy = {
        id: 91001,
        name: 'Mummy14',
        isPlayer: false,
        team: 2,
        entState: 6,
        hp: 0,
        dead: true,
        clientSpawned: true,
        ownerToken: client.token,
        roomId: 1
    };

    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>());

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, finalEnemy);
    await sleep(MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS + 100);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'Cemetery Hill mini tombs should not complete from last-hostile death alone'
    );

    await LevelHandler.handleQuestProgressUpdate(client as never, createQuestProgressPacket(100));
    await sleep(MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS + 100);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        true,
        'Cemetery Hill mini tombs should show the dungeon completion screen at 100% progress'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.ClearMini1)]?.state ?? 0),
        3,
        'Cemetery Hill mini tomb completion should claim the matching clear mission'
    );
}

async function testCompletedValhavenFullClearDoesNotRestartOnRepeatEntry(): Promise<void> {
    const repeatCases: Array<{ level: string; missionId: MissionID }> = [
        { level: 'JC_Mini1', missionId: MissionID.TheWestWing },
        { level: 'JC_Mini2', missionId: MissionID.TheEastWing },
        { level: 'JC_Mission8', missionId: MissionID.TacticalStrike },
        { level: 'JC_Mission10', missionId: MissionID.VaultHunter }
    ];

    for (const testCase of repeatCases) {
        const client = createCompletedValhavenFullClearClient(testCase.level, testCase.missionId);

        await MissionHandler.prepareFullClearDungeonEntry(client as never);
        MissionHandler.syncFullClearDungeonEntryMissionToClient(client as never);

        assert.equal(
            Number(client.character.missions[String(testCase.missionId)]?.state ?? 0),
            3,
            `${testCase.level} completed full-clear mission should remain claimed on repeat entry`
        );
        assert.equal(
            Number(client.character.questTrackerState ?? -1),
            0,
            `${testCase.level} repeat entry should reset run progress without reopening the completed quest`
        );
        assert.equal(
            client.sentPackets.some((packet) => packet.id === 0x85),
            false,
            `${testCase.level} repeat entry must not send MissionAdded for an already claimed Valhaven full-clear mission`
        );
    }
}

async function testStormshardFullClearDungeonsAcceptHundredPercentPacket(): Promise<void> {
    const testCases: Array<{ level: string; missionId: MissionID }> = [
        { level: 'OMM_Mission2', missionId: MissionID.GardenOfTheLost },
        { level: 'OMM_Mission5', missionId: MissionID.HuntedToTheEdge }
    ];

    for (const testCase of testCases) {
        const client = createAcceptedStormshardFullClearClient(testCase.level, testCase.missionId);
        const levelScope = getClientLevelScope(client as never);
        GlobalState.levelEntities.set(levelScope, new Map<number, any>([
            [9001, {
                id: 9001,
                name: 'RockHulk',
                team: 2,
                hp: 50,
                entState: 1,
                clientSpawned: true
            }]
        ]));

        await MissionHandler.handleSetLevelComplete(client as never, createLevelCompletePacket(100, 0, 1));
        GlobalState.levelEntities.delete(levelScope);

        assert.equal(
            Number(client.character.missions[String(testCase.missionId)]?.state ?? 0),
            2,
            `${testCase.level} should become ready to turn in from a 100% completion packet`
        );
        assert.equal(
            client.sentPackets.some((packet) => packet.id === 0x86),
            true,
            `${testCase.level} should emit mission-complete notification`
        );
        assert.equal(
            client.sentPackets.some((packet) => packet.id === 0x84),
            false,
            `${testCase.level} should still wait for its Moai turn-in reward`
        );
    }
}

async function main(): Promise<void> {
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const levelEntities = new Map(GlobalState.levelEntities);
    ensureDataLoaded();
    try {
        await testDungeonCompletionSyncsReadyMissionStateImmediately();
        await testLordTillyRestWaitsForNpcRewardClaim();
        await testDungeonCompletionDoesNotCreateUnstartedMission();
        await testAcceptedForgottenForgeCompletionWaitsForTurnIn();
        await testValhavenDungeonChainAutoAcceptsProdigalSon();
        testLoginRepairAcceptsMissingValhavenDungeonChainQuest();
        await testMeyloursEmbersClaimsAdohiRewardAndPrimesGlades();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        await testCemeteryMiniDungeonStartsMissionOnEntry();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        await testCemeteryMiniDungeonCompletesOnlyFromFullClearProgress();
        await testCompletedValhavenFullClearDoesNotRestartOnRepeatEntry();
        await testStormshardFullClearDungeonsAcceptHundredPercentPacket();
    } finally {
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.levelEntities = levelEntities;
    }
    console.log('dungeon_completion_mission_sync_regression: ok');
}

void main().catch((error) => {
    console.error('dungeon_completion_mission_sync_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
