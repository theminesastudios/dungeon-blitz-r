import { strict as assert } from 'assert';
import * as path from 'path';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime/MissionID';
import { NpcHandler } from '../handlers/NpcHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type TestCharacter = {
    name: string;
    level: number;
    xp: number;
    gold: number;
    questTrackerState?: number;
    CurrentLevel: { name: string; x: number; y: number };
    missions: Record<number, Record<string, any>>;
};

type FakeClient = {
    character: TestCharacter;
    characters: TestCharacter[];
    currentLevel: string;
    entities: Map<number, any>;
    pendingMissionTurnIns: Set<number>;
    sentPackets: SentPacket[];
    userId?: number;
    socket: { destroyed: boolean };
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureMissionDataLoaded(): void {
    MissionLoader.load(path.resolve(__dirname, '../data'));
}

function createFakeClient(currentLevel: string, character: TestCharacter): FakeClient {
    const sentPackets: SentPacket[] = [];

    return {
        character,
        characters: [character],
        currentLevel,
        entities: new Map<number, any>(),
        pendingMissionTurnIns: new Set<number>(),
        sentPackets,
        socket: { destroyed: false },
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function buildTalkToNpcPacket(npcId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(npcId);
    return bb.toBuffer();
}

function buildLevelCompletePacket(): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(100);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(1);
    bb.writeMethod9(3);
    return bb.toBuffer();
}

async function flushAsyncWork(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

async function testClaimedQuestDoesNotAutoAcceptFollowup(): Promise<void> {
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = ((fn: (...args: any[]) => void) => {
        fn();
        return 0 as never;
    }) as unknown as typeof global.setTimeout;

    try {
        const character: TestCharacter = {
            name: 'QuestHero',
            level: 2,
            xp: 0,
            gold: 0,
            CurrentLevel: { name: 'NewbieRoad', x: 0, y: 0 },
            missions: {
                [MissionID.DefendTheShip]: { state: 2, currCount: 1 }
            }
        };
        const client = createFakeClient('NewbieRoad', character);
        const npcId = 1001;

        client.entities.set(npcId, {
            id: npcId,
            characterName: 'CaptainFink'
        });

        await NpcHandler.handleTalkToNpc(client as never, buildTalkToNpcPacket(npcId));
        await flushAsyncWork();

        assert.equal(character.missions[MissionID.DefendTheShip].state, 3, 'turned-in mission should be claimed');
        assert.equal(
            character.missions[MissionID.MeetTheTown],
            undefined,
            'follow-up mission should stay not started until the next conversation'
        );
        assert.equal(
            client.sentPackets.some((packet) => packet.id === 0x85),
            false,
            'turn-in should not push a follow-up mission-added packet'
        );

        await NpcHandler.handleTalkToNpc(client as never, buildTalkToNpcPacket(npcId));
        const meetTheTown = character.missions[MissionID.MeetTheTown] as Record<string, any> | undefined;

        assert.ok(meetTheTown, 'next quest should be accepted on the second talk');
        assert.equal(
            meetTheTown.state,
            2,
            'next quest should be accepted only when talking again and start in ready-to-turn-in state'
        );
        assert.equal(
            client.sentPackets.some((packet) => packet.id === 0x85),
            true,
            'accepting the follow-up on the second talk should send mission-added'
        );
    } finally {
        global.setTimeout = originalSetTimeout;
    }
}

async function testDungeonCompletionLeavesNextNpcQuestAvailable(): Promise<void> {
    const character: TestCharacter = {
        name: 'QuestHero',
        level: 2,
        xp: 0,
        gold: 0,
        questTrackerState: 100,
        CurrentLevel: { name: 'TutorialDungeon', x: 0, y: 0 },
        missions: {
            [MissionID.MeetTheTown]: { state: 3, claimed: 1, complete: 1 },
            [MissionID.RescueAnna]: { state: 1, currCount: 0 }
        }
    };
    const client = createFakeClient('TutorialDungeon', character);

    await MissionHandler.handleSetLevelComplete(client as never, buildLevelCompletePacket());

    assert.equal(character.missions[MissionID.RescueAnna].state, 3, 'completed dungeon mission should be claimed');
    assert.equal(
        character.missions[MissionID.FindAnnasFather],
        undefined,
        'follow-up quest should remain available instead of auto-starting'
    );

    const nextMission = (NpcHandler as any).findBestMission(character, 'nranna03');
    assert.deepEqual(
        nextMission,
        {
            missionId: MissionID.FindAnnasFather,
            dialogueId: 2,
            state: 0
        },
        'Anna should advertise the next quest as available after Rescue Anna is completed'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x85),
        false,
        'dungeon completion should not auto-send a mission-added packet for the next quest'
    );

    const annaClient = createFakeClient('NewbieRoad', character);
    const annaNpcId = 6218466;
    annaClient.entities.set(annaNpcId, {
        id: annaNpcId,
        character_name: 'AnnaOutside'
    });

    await NpcHandler.handleTalkToNpc(annaClient as never, buildTalkToNpcPacket(annaNpcId));

    const findAnnasFather = character.missions[MissionID.FindAnnasFather] as Record<string, any> | undefined;
    assert.ok(findAnnasFather, 'AnnaOutside should accept the follow-up quest in NewbieRoad');
    assert.equal(
        findAnnasFather.state,
        2,
        'FindAnnasFather should start when talking to AnnaOutside after RescueAnna is claimed'
    );
}

function testNpcFallbackBubblePacketUsesReadableRoomThoughtFormat(): void {
    const character: TestCharacter = {
        name: 'QuestHero',
        level: 2,
        xp: 0,
        gold: 0,
        CurrentLevel: { name: 'NewbieRoad', x: 0, y: 0 },
        missions: {}
    };
    const client = createFakeClient('NewbieRoad', character);

    (NpcHandler as any).sendNpcBubble(client, 6218466, 'Test fallback line');

    assert.equal(client.sentPackets.length, 1, 'fallback bubble should send one packet');
    assert.equal(client.sentPackets[0]?.id, 0x76, 'fallback bubble should use room-thought packet');

    const reader = new BitReader(client.sentPackets[0]!.payload);
    assert.equal(reader.readMethod4(), 6218466);
    assert.equal(reader.readMethod13(), 'Test fallback line');
}

function testMissionStateReplayOnLoginRestoresOnlyActiveMissions(): void {
    const character: TestCharacter = {
        name: 'QuestHero',
        level: 3,
        xp: 0,
        gold: 0,
        questTrackerState: 100,
        CurrentLevel: { name: 'NewbieRoad', x: 0, y: 0 },
        missions: {
            [MissionID.DefendTheShip]: { state: 3, currCount: 1, claimed: 1, complete: 1 },
            [MissionID.FindAnnasFather]: { state: 1, currCount: 0 }
        }
    };
    const client = createFakeClient('NewbieRoad', character);

    MissionHandler.syncMissionStateOnLogin(client as never);

    const missionAddedPackets = client.sentPackets.filter((packet) => packet.id === 0x85);
    const missionProgressPackets = client.sentPackets.filter((packet) => packet.id === 0x83);
    const missionCompletePackets = client.sentPackets.filter((packet) => packet.id === 0x86);
    const missionCompleteUiPackets = client.sentPackets.filter((packet) => packet.id === 0x84);

    assert.equal(missionAddedPackets.length, 2, 'login replay should include active and claimed missions');
    assert.equal(missionProgressPackets.length, 0, 'zero-progress active missions should not emit progress packets');
    assert.equal(missionCompletePackets.length, 1, 'claimed missions should be marked complete after login replay');
    assert.equal(missionCompleteUiPackets.length, 1, 'claimed dungeon missions should get placeholder completion UI');

    const addedClaimedMission = new BitReader(missionAddedPackets[0]!.payload);
    assert.equal(addedClaimedMission.readMethod4(), MissionID.DefendTheShip);
    assert.equal(addedClaimedMission.readMethod15(), false, 'claimed missions should replay as non-active');

    const addedFindAnnasFather = new BitReader(missionAddedPackets[1]!.payload);
    assert.equal(addedFindAnnasFather.readMethod4(), MissionID.FindAnnasFather);
    assert.equal(addedFindAnnasFather.readMethod15(), true, 'active missions should replay as active');

    const completedClaimedMission = new BitReader(missionCompletePackets[0]!.payload);
    assert.equal(completedClaimedMission.readMethod4(), MissionID.DefendTheShip);

    const completedUi = new BitReader(missionCompleteUiPackets[0]!.payload);
    assert.equal(completedUi.readMethod4(), MissionID.DefendTheShip);
    assert.equal(completedUi.readMethod15(), true);
    assert.equal(completedUi.readMethod6(4), 3);
    assert.equal(completedUi.readMethod4(), 0);
}

async function main(): Promise<void> {
    ensureMissionDataLoaded();
    await testClaimedQuestDoesNotAutoAcceptFollowup();
    await testDungeonCompletionLeavesNextNpcQuestAvailable();
    testNpcFallbackBubblePacketUsesReadableRoomThoughtFormat();
    testMissionStateReplayOnLoginRestoresOnlyActiveMissions();
    console.log('quest_completion_flow_regression: ok');
}

void main().catch((error) => {
    console.error('quest_completion_flow_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
