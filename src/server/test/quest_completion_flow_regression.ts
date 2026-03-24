import { strict as assert } from 'assert';
import * as path from 'path';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime/MissionID';
import { NpcHandler } from '../handlers/NpcHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

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

async function main(): Promise<void> {
    ensureMissionDataLoaded();
    await testClaimedQuestDoesNotAutoAcceptFollowup();
    await testDungeonCompletionLeavesNextNpcQuestAvailable();
    console.log('quest_completion_flow_regression: ok');
}

void main().catch((error) => {
    console.error('quest_completion_flow_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
