import { strict as assert } from 'assert';
import * as path from 'path';
import { LevelConfig } from '../core/LevelConfig';
import { MissionDialogueLoader } from '../data/MissionDialogueLoader';
import { NpcDialogueLoader } from '../data/NpcDialogueLoader';
import { MissionLoader } from '../data/MissionLoader';
import { NpcLoader } from '../data/NpcLoader';
import { MissionID } from '../data/runtime';
import { MissionHandler } from '../handlers/MissionHandler';
import { NpcHandler } from '../handlers/NpcHandler';
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
    startedRoomEvents: Set<string>;
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
    };
    entities: Map<number, unknown>;
    pendingMissionTurnIns: Set<number>;
    sentPackets: SentPacket[];
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
    send?: (id: number, payload: Buffer) => void;
    socket?: { destroyed: boolean };
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('TutorialBoat')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.ClearYourHouse)) {
        MissionLoader.load(dataDir);
    }
    if (!MissionDialogueLoader.isLoaded()) {
        MissionDialogueLoader.load(dataDir);
    }
    if (!NpcDialogueLoader.isLoaded()) {
        NpcDialogueLoader.load(dataDir);
    }
    if (!NpcLoader.getNpcsForLevel('NewbieRoad').length) {
        NpcLoader.load(dataDir);
    }
}

function createFakeClient(
    currentLevel: string,
    missions: Record<string, Record<string, number>>,
    questTrackerState: number
): FakeClient {
    const sentPackets: SentPacket[] = [];

    return {
        token: 7001,
        currentLevel,
        levelInstanceId: 'quest-flow',
        currentRoomId: 0,
        playerSpawned: true,
        startedRoomEvents: new Set<string>(),
        userId: null,
        character: {
            name: 'QuestFlowTester',
            level: 2,
            xp: 0,
            gold: 0,
            CurrentLevel: { name: currentLevel, x: 0, y: 0 },
            PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 },
            missions,
            questTrackerState
        },
        entities: new Map(),
        pendingMissionTurnIns: new Set<number>(),
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createLevelCompletePacket(
    completionPercent: number,
    bonusScoreTotal: number,
    goldReward: number,
    remainingKills: number,
    requiredKills: number,
    stars: number
): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(completionPercent);
    bb.writeMethod9(bonusScoreTotal);
    bb.writeMethod9(goldReward);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(remainingKills);
    bb.writeMethod9(requiredKills);
    bb.writeMethod9(stars);
    return bb.toBuffer();
}

function createNpcTalkPacket(npcId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(npcId);
    return bb.toBuffer();
}

function decodeStartSkitPacket(payload: Buffer): { npcId: number; dialogueId: number; missionId: number } {
    const br = new BitReader(payload);
    return {
        npcId: br.readMethod4(),
        dialogueId: br.readMethod6(3),
        missionId: br.readMethod4()
    };
}

function decodeNpcBubblePacket(payload: Buffer): { npcId: number; text: string } {
    const br = new BitReader(payload);
    return {
        npcId: br.readMethod4(),
        text: br.readMethod13()
    };
}

async function testTutorialBoatCompletionPersistsDungeonHoverStats(): Promise<void> {
    const client = createFakeClient(
        'TutorialBoat',
        {
            [String(MissionID.DefendTheShip)]: {
                state: 1,
                currCount: 0
            }
        },
        0
    );

    await MissionHandler.handleSetLevelComplete(
        client as never,
        createLevelCompletePacket(100, 209, 155, 0, 1, 5)
    );

    const mission = client.character.missions[String(MissionID.DefendTheShip)];
    assert.equal(Number(mission?.state ?? 0), 2, 'Lost at Sea should become ready to turn in');
    assert.equal(Number(mission?.Tier ?? 0) > 0, true, 'Lost at Sea should persist the completed star count');
    assert.equal(Number(mission?.highscore ?? 0) > 0, true, 'Lost at Sea should persist the completed total score');
    assert.equal(Number(mission?.Time ?? 0) > 0, true, 'Lost at Sea should persist completion time metadata');
}

async function testRescueAnnaCompletionLeavesFindAnnasFatherAvailableOnAnna(): Promise<void> {
    const client = createFakeClient(
        'TutorialDungeon',
        {
            [String(MissionID.MeetTheTown)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1
            },
            [String(MissionID.RescueAnna)]: {
                state: 1,
                currCount: 0
            }
        },
        100
    );

    await MissionHandler.handleSetLevelComplete(
        client as never,
        createLevelCompletePacket(100, 209, 155, 0, 1, 5)
    );

    const rescueAnna = client.character.missions[String(MissionID.RescueAnna)];
    assert.equal(Number(rescueAnna?.state ?? 0), 3, 'Goblin Kidnappers should be marked claimed after completion');
    assert.equal(Number(rescueAnna?.Tier ?? 0) > 0, true, 'Goblin Kidnappers should persist the completed star count');
    assert.equal(
        Number(rescueAnna?.highscore ?? 0) > 0,
        true,
        'Goblin Kidnappers should persist the completed total score'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.FindAnnasFather)]?.state ?? 0),
        2,
        "Find Anna's Father should be primed as Anna's ready follow-up as soon as Goblin Kidnappers finishes"
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x85),
        true,
        "dungeon completion should sync Anna's follow-up marker to the client"
    );

    const nextMission = (NpcHandler as any).findBestMission(client.character, 'nranna03');
    assert.deepEqual(
        nextMission,
        {
            missionId: MissionID.FindAnnasFather,
            dialogueId: 2,
            state: 2,
            primedContactOffer: true
        },
        'Anna should keep the follow-up offer dialogue while the primed marker is waiting to be shown'
    );
}

async function testPrimedFindAnnasFatherBlocksMayorUntilAnnaShowsOffer(): Promise<void> {
    const client = createFakeClient(
        'NewbieRoad',
        {
            [String(MissionID.MeetTheTown)]: {
                state: 3,
                claimed: 1,
                complete: 1
            },
            [String(MissionID.RescueAnna)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1
            },
            [String(MissionID.FindAnnasFather)]: {
                state: 2,
                currCount: -1
            }
        },
        100
    );
    client.character.CurrentLevel = { name: 'NewbieRoad', x: 3158, y: 479 };

    client.sentPackets.length = 0;
    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(5825250));

    assert.equal(
        Number(client.character.missions[String(MissionID.FindAnnasFather)]?.state ?? 0),
        2,
        "Mayor should not claim Find Anna's Father before Anna has shown the follow-up offer"
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x84),
        false,
        "Mayor should not show the mission-complete reward UI before Anna's offer dialogue"
    );

    client.sentPackets.length = 0;
    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(6218466));

    assert.equal(
        Number(client.character.missions[String(MissionID.FindAnnasFather)]?.currCount ?? 0),
        0,
        "Talking to Anna should clear the primed follow-up sentinel after showing the offer"
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x85),
        false,
        'Anna should not re-send the mission-added packet when the primed follow-up is already synced'
    );

    const skitPacket = client.sentPackets.find((packet) => packet.id === 0x7B);
    assert.ok(skitPacket, 'Anna should still start the follow-up offer skit after the dungeon completion prime');
    assert.deepEqual(
        decodeStartSkitPacket(skitPacket!.payload),
        {
            npcId: 6218466,
            dialogueId: 2,
            missionId: MissionID.FindAnnasFather
        },
        "Anna should keep using Find Anna's Father offer dialogue while the primed follow-up marker is active"
    );
}

function testFindAnnasFatherUsesOverworldAnnaContact(): void {
    const missionDef = MissionLoader.getMissionDef(MissionID.FindAnnasFather);
    assert.equal(
        missionDef?.ContactName,
        'AnnaOutside',
        "Find Anna's Father should anchor to Anna's overworld NPC for map and minimap markers"
    );
    assert.equal(
        NpcLoader.getNpcsForLevel('NewbieRoad').some((npc) => String((npc as { character_name?: string }).character_name ?? '') === 'AnnaOutside'),
        true,
        "NewbieRoad should contain the AnnaOutside NPC used by Find Anna's Father's marker"
    );
}

async function testRescueAnnaRerunRefreshesDungeonHoverStats(): Promise<void> {
    const client = createFakeClient(
        'TutorialDungeon',
        {
            [String(MissionID.MeetTheTown)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1
            },
            [String(MissionID.RescueAnna)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1,
                Tier: 6,
                highscore: 80000,
                Time: 111111
            }
        },
        100
    );

    await MissionHandler.handleSetLevelComplete(
        client as never,
        createLevelCompletePacket(100, 209122, 155, 0, 1, 10)
    );

    const rescueAnna = client.character.missions[String(MissionID.RescueAnna)];
    assert.equal(Number(rescueAnna?.state ?? 0), 3, 'Goblin Kidnappers rerun should remain claimed');
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x86),
        false,
        'replaying an already-cleared dungeon should not re-send the mission-complete packet'
    );
    assert.equal(
        Number(rescueAnna?.highscore ?? 0) !== 80000,
        true,
        'Goblin Kidnappers rerun should replace the old stored score with the latest result'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x84),
        false,
        'replaying an already-cleared dungeon should not fire the mission-complete hover packet again'
    );
}

async function testRescueAnnaLowerScoreRerunKeepsBestHoverStats(): Promise<void> {
    const client = createFakeClient(
        'TutorialDungeon',
        {
            [String(MissionID.MeetTheTown)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1
            },
            [String(MissionID.RescueAnna)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1,
                Tier: 9,
                highscore: 120000,
                Time: 111111
            }
        },
        100
    );

    await MissionHandler.handleSetLevelComplete(
        client as never,
        createLevelCompletePacket(100, 1000, 10, 0, 1, 1)
    );

    const rescueAnna = client.character.missions[String(MissionID.RescueAnna)];
    assert.equal(Number(rescueAnna?.Tier ?? 0), 9, 'a weaker rerun should keep the best stored star count');
    assert.equal(Number(rescueAnna?.highscore ?? 0), 120000, 'a weaker rerun should keep the best stored score');

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x84),
        false,
        'a weaker rerun should not fire the mission-complete hover packet again'
    );
}

async function testCaptainFinkRepairsLostAtSeaTurnInForCurrentPlayer(): Promise<void> {
    const client = createFakeClient('CraftTown', {}, 100);
    client.character.CurrentLevel = { name: 'CraftTown', x: 360, y: 1460 };
    client.character.PreviousLevel = { name: 'NewbieRoad', x: 1421, y: 826 };
    client.character.level = 10;
    client.entities.set(77, { id: 77, characterName: 'CaptainFink' });

    const originalSetTimeout = global.setTimeout;
    (global as any).setTimeout = ((() => 0) as unknown) as typeof setTimeout;

    try {
        await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(77));
    } finally {
        (global as any).setTimeout = originalSetTimeout;
    }

    assert.equal(
        Number(client.character.missions[String(MissionID.DefendTheShip)]?.state ?? 0),
        2,
        'Captain Fink interaction should repair Goblin Assault into ready-to-turn-in for broken current players'
    );
    assert.equal(
        client.pendingMissionTurnIns.has(MissionID.DefendTheShip),
        true,
        'Captain Fink should immediately offer the repaired Lost at Sea turn-in flow'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x7B),
        true,
        'Captain Fink should start the mission turn-in dialogue after repairing the quest state'
    );
}

async function testCaptainFinkTurnInClaimsFirstThenOffersWashedAshoreOnSecondTalk(): Promise<void> {
    const client = createFakeClient(
        'NewbieRoad',
        {
            [String(MissionID.DefendTheShip)]: {
                state: 2,
                currCount: 1
            }
        },
        100
    );
    client.character.CurrentLevel = { name: 'NewbieRoad', x: 1421, y: 826 };
    client.entities.set(88, { id: 88, characterName: 'CaptainFink' });
    client.socket = { destroyed: false };

    const originalSetTimeout = global.setTimeout;
    (global as any).setTimeout = ((fn: (...args: any[]) => void) => {
        fn();
        return 0;
    }) as unknown as typeof setTimeout;

    try {
        await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(88));
    } finally {
        (global as any).setTimeout = originalSetTimeout;
    }

    assert.equal(
        Number(client.character.missions[String(MissionID.DefendTheShip)]?.state ?? 0),
        3,
        'first Captain Fink talk should only claim Goblin Assault'
    );
    assert.equal(
        client.character.missions[String(MissionID.MeetTheTown)],
        undefined,
        'Washed Ashore should not auto-start during the same Captain Fink reward turn-in'
    );
    assert.equal(
        client.sentPackets.some(
            (packet) =>
                packet.id === 0x85 &&
                Number(client.character.missions[String(MissionID.MeetTheTown)]?.state ?? 0) !== 0
        ),
        false,
        'claiming Goblin Assault should not send a Washed Ashore mission-added packet yet'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x84),
        true,
        'claiming Goblin Assault should still show the mission-complete reward UI'
    );

    client.sentPackets.length = 0;
    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(88));

    assert.equal(
        Number(client.character.missions[String(MissionID.MeetTheTown)]?.state ?? 0),
        2,
        'the second Captain Fink talk should accept Washed Ashore'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x85),
        true,
        'accepting Washed Ashore on the second talk should send the mission-added packet'
    );

    client.sentPackets.length = 0;
    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(88));

    const skitPacket = client.sentPackets.find((packet) => packet.id === 0x7B);
    assert.ok(
        skitPacket,
        'talking to Captain Fink after accepting Washed Ashore should still start a mission skit'
    );
    assert.deepEqual(
        decodeStartSkitPacket(skitPacket!.payload),
        {
            npcId: 88,
            dialogueId: 3,
            missionId: MissionID.MeetTheTown
        },
        'Captain Fink should continue with Washed Ashore active dialogue after the mission is accepted'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x85),
        false,
        're-talking to Captain Fink after accepting Washed Ashore should not re-add the mission'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x84),
        false,
        're-talking to Captain Fink after accepting Washed Ashore should not show reward UI'
    );
}

async function testMayorTurnInClaimsWashedAshoreThenOffersRescueAnnaOnSecondTalk(): Promise<void> {
    const client = createFakeClient(
        'NewbieRoad',
        {
            [String(MissionID.DefendTheShip)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1
            },
            [String(MissionID.MeetTheTown)]: {
                state: 2,
                currCount: 1
            }
        },
        100
    );
    client.character.CurrentLevel = { name: 'NewbieRoad', x: 3334, y: 470 };
    client.entities.set(5825250, { id: 5825250, characterName: 'NR_Mayor01' });

    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(5825250));

    assert.equal(
        Number(client.character.missions[String(MissionID.MeetTheTown)]?.state ?? 0),
        3,
        'the first Mayor talk should only claim Washed Ashore'
    );
    assert.equal(
        client.character.missions[String(MissionID.RescueAnna)],
        undefined,
        'Goblin Kidnappers should not auto-start during the same Mayor reward turn-in'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x84),
        true,
        'claiming Washed Ashore should still show the mission-complete reward UI'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x85),
        false,
        'claiming Washed Ashore should not send a Goblin Kidnappers mission-added packet yet'
    );

    client.sentPackets.length = 0;
    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(5825250));

    assert.equal(
        Number(client.character.missions[String(MissionID.RescueAnna)]?.state ?? 0),
        1,
        'the second Mayor talk should accept Goblin Kidnappers'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x85),
        true,
        'accepting Goblin Kidnappers on the second talk should send the mission-added packet'
    );

    client.sentPackets.length = 0;
    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(5825250));

    const skitPacket = client.sentPackets.find((packet) => packet.id === 0x7B);
    assert.ok(
        skitPacket,
        'talking to Mayor after accepting Goblin Kidnappers should still start a mission skit'
    );
    assert.deepEqual(
        decodeStartSkitPacket(skitPacket!.payload),
        {
            npcId: 5825250,
            dialogueId: 3,
            missionId: MissionID.RescueAnna
        },
        'Mayor should continue with Goblin Kidnappers active dialogue after the mission is accepted'
    );
}

async function testMayorUsesJsonFallbackDialogueWhenNoQuestMatches(): Promise<void> {
    const client = createFakeClient('NewbieRoad', {}, 0);
    client.character.CurrentLevel = { name: 'NewbieRoad', x: 3334, y: 470 };
    client.entities.set(5825250, { id: 5825250, characterName: 'NR_Mayor01' });

    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(5825250));

    const bubblePacket = client.sentPackets.find((packet) => packet.id === 0x76);
    assert.ok(bubblePacket, 'Mayor should fall back to a regular NPC bubble when no quest matches');

    assert.deepEqual(
        decodeNpcBubblePacket(bubblePacket!.payload).npcId,
        5825250,
        'Mayor fallback bubble should target the talked NPC'
    );

    const mayorLines = new Set(NpcDialogueLoader.getLinesForNpc('NewbieRoad', 'nrmayor01', client.character as never));
    assert.ok(
        mayorLines.has(decodeNpcBubblePacket(bubblePacket!.payload).text),
        'Mayor fallback bubble should come from the JSON-backed Wolf\'s End dialogue pool'
    );
}

async function testMayorTurnInClaimsFindAnnasFatherThenOffersKeepQuestOnSecondTalk(): Promise<void> {
    const client = createFakeClient(
        'NewbieRoad',
        {
            [String(MissionID.DefendTheShip)]: {
                state: 3,
                claimed: 1,
                complete: 1
            },
            [String(MissionID.MeetTheTown)]: {
                state: 3,
                claimed: 1,
                complete: 1
            },
            [String(MissionID.RescueAnna)]: {
                state: 3,
                claimed: 1,
                complete: 1
            },
            [String(MissionID.FindAnnasFather)]: {
                state: 2,
                currCount: 1
            }
        },
        100
    );
    client.character.CurrentLevel = { name: 'NewbieRoad', x: 3334, y: 470 };
    client.entities.set(5825250, { id: 5825250, characterName: 'NR_Mayor01' });

    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(5825250));

    assert.equal(
        Number(client.character.missions[String(MissionID.FindAnnasFather)]?.state ?? 0),
        3,
        'the first Mayor talk should only claim Find Anna\'s Father'
    );
    assert.equal(
        client.character.missions[String(MissionID.ClearYourHouse)],
        undefined,
        'I Claim This Keep should not auto-start during the same Mayor reward turn-in'
    );

    client.sentPackets.length = 0;
    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(5825250));

    assert.equal(
        Number(client.character.missions[String(MissionID.ClearYourHouse)]?.state ?? 0),
        1,
        'the second Mayor talk should accept I Claim This Keep'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x85),
        true,
        'accepting I Claim This Keep on the second talk should send the mission-added packet'
    );

    client.sentPackets.length = 0;
    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(5825250));

    const skitPacket = client.sentPackets.find((packet) => packet.id === 0x7B);
    assert.ok(
        skitPacket,
        'talking to Mayor after accepting I Claim This Keep should still start a mission skit'
    );
    assert.deepEqual(
        decodeStartSkitPacket(skitPacket!.payload),
        {
            npcId: 5825250,
            dialogueId: 3,
            missionId: MissionID.ClearYourHouse
        },
        'Mayor should continue with the keep quest active dialogue after the mission is accepted'
    );
}

async function testClaimedRescueAnnaLetsAnnaOutsideOfferFindAnnasFather(): Promise<void> {
    const client = createFakeClient(
        'NewbieRoad',
        {
            [String(MissionID.MeetTheTown)]: {
                state: 3,
                claimed: 1,
                complete: 1
            },
            [String(MissionID.RescueAnna)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1
            }
        },
        100
    );
    client.character.CurrentLevel = { name: 'NewbieRoad', x: 3158, y: 479 };

    client.sentPackets.length = 0;
    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(6218466));

    assert.equal(
        Number(client.character.missions[String(MissionID.FindAnnasFather)]?.state ?? 0),
        2,
        "AnnaOutside should offer Find Anna's Father once Goblin Kidnappers is fully claimed"
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x85),
        true,
        "accepting Find Anna's Father from AnnaOutside should notify the client with a mission-added packet"
    );

    const skitPacket = client.sentPackets.find((packet) => packet.id === 0x7B);
    assert.ok(skitPacket, 'AnnaOutside should still start the mission offer dialogue');
    assert.deepEqual(
        decodeStartSkitPacket(skitPacket!.payload),
        {
            npcId: 6218466,
            dialogueId: 2,
            missionId: MissionID.FindAnnasFather
        },
        "AnnaOutside should use the Find Anna's Father offer dialogue after Goblin Kidnappers is turned in"
    );
}

async function testTurkishMissionDialogueUsesLocalizedRawText(): Promise<void> {
    const client = createFakeClient(
        'NewbieRoad',
        {
            [String(MissionID.DefendTheShip)]: {
                state: 3,
                claimed: 1,
                complete: 1
            },
            [String(MissionID.MeetTheTown)]: {
                state: 1,
                currCount: 0
            }
        },
        100
    );
    client.character.CurrentLevel = { name: 'NewbieRoad', x: 1421, y: 826 };
    (client.character as Record<string, unknown>).dialogueLanguage = 'tr';
    client.entities.set(88, { id: 88, characterName: 'CaptainFink' });

    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(88));

    const packet = client.sentPackets.find((entry) => entry.id === 0x76);
    assert.ok(packet, 'Turkish mission dialogue should be sent as a raw NPC skit packet');
    assert.equal(
        client.sentPackets.some((entry) => entry.id === 0x7B),
        false,
        'Turkish mission dialogue should not fall back to the English mission-id skit packet'
    );
    assert.equal(
        decodeNpcBubblePacket(packet!.payload).text,
        "Koyu haritada bulabilirsin.=@Gercekten hayatta kalanlar var mi diye bakmaya gidiyorum.=Doguya dogru ilerle, koyu bulacaksin.=Ben de Niobe'yi onarmaya calisirim.",
        'Captain Fink should speak the Turkish dialogue in ASCII form for the legacy client font set'
    );
}

async function testTurkishFallbackDialogueUsesLocalizedJsonLines(): Promise<void> {
    const client = createFakeClient('NewbieRoad', {}, 0);
    client.character.CurrentLevel = { name: 'NewbieRoad', x: 3334, y: 470 };
    (client.character as Record<string, unknown>).dialogueLanguage = 'tr';
    client.entities.set(5825250, { id: 5825250, characterName: 'NR_Mayor01' });

    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(5825250));

    const packet = client.sentPackets.find((entry) => entry.id === 0x76);
    assert.ok(packet, 'Turkish fallback dialogue should use the NPC raw text packet');

    const mayorLines = new Set(
        NpcDialogueLoader.getLinesForNpc('NewbieRoad', 'nrmayor01', client.character as never, 'tr')
    );
    assert.ok(
        mayorLines.has(decodeNpcBubblePacket(packet!.payload).text),
        'Mayor fallback text should come from the Turkish JSON dialogue pool'
    );
}

async function testNewbieRoadAffricFallbackUsesOriginalGuardedLines(): Promise<void> {
    const client = createFakeClient('NewbieRoad', {}, 0);
    client.character.CurrentLevel = { name: 'NewbieRoad', x: 4365, y: 640 };
    client.entities.set(6021858, { id: 6021858, name: 'NPCAffric' });

    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(6021858));

    const packet = client.sentPackets.find((entry) => entry.id === 0x76);
    assert.ok(packet, 'Affric should fall back to a regular NPC bubble when no quest matches');

    const affricLines = new Set(
        NpcDialogueLoader.getLinesForNpc('NewbieRoad', 'nraffric', client.character as never, 'en')
    );
    assert.ok(
        affricLines.has(decodeNpcBubblePacket(packet!.payload).text),
        'NewbieRoad Affric fallback should use the guarded asset-backed dialogue lines'
    );
}

async function testSwampRoadNorthAffricUsesSrnMayorDialogueKey(): Promise<void> {
    const client = createFakeClient('SwampRoadNorth', {}, 0);
    client.character.CurrentLevel = { name: 'SwampRoadNorth', x: 17589, y: 5358 };
    client.entities.set(6566469, { id: 6566469, name: 'NPCAffric' });

    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(6566469));

    const packet = client.sentPackets.find((entry) => entry.id === 0x76);
    assert.ok(packet, 'SwampRoadNorth Affric should fall back to a regular NPC bubble when no quest matches');

    const affricLines = new Set(
        NpcDialogueLoader.getLinesForNpc('SwampRoadNorth', 'srnmayor02', client.character as never, 'en')
    );
    assert.ok(
        affricLines.has(decodeNpcBubblePacket(packet!.payload).text),
        'SwampRoadNorth Affric should use the original SRN_Mayor02 dialogue pool'
    );
}

async function testNewbieRoadOdemDoesNotStartBlackRoseMireQuestEarly(): Promise<void> {
    const client = createFakeClient(
        'NewbieRoad',
        {
            [String(MissionID.RescueAnna)]: {
                state: 1,
                currCount: 0
            }
        },
        100
    );
    client.character.CurrentLevel = { name: 'NewbieRoad', x: 4620, y: 643 };
    client.entities.set(6087394, { id: 6087394, name: 'NPCOdem' });

    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(6087394));

    assert.equal(
        client.sentPackets.some((entry) => entry.id === 0x85),
        false,
        'NewbieRoad Odem should not assign a Black Rose Mire mission during the Goblin Kidnappers stage'
    );
    assert.equal(
        client.sentPackets.some((entry) => entry.id === 0x7B),
        false,
        'NewbieRoad Odem should not open a later-zone quest skit during the Goblin Kidnappers stage'
    );

    const packet = client.sentPackets.find((entry) => entry.id === 0x76);
    assert.ok(packet, 'NewbieRoad Odem should fall back to his regular NPC bubble');

    const odemLines = new Set(
        NpcDialogueLoader.getLinesForNpc('NewbieRoad', 'nrodem', client.character as never, 'en')
    );
    assert.ok(
        odemLines.has(decodeNpcBubblePacket(packet!.payload).text),
        'NewbieRoad Odem should speak his local fallback lines instead of assigning SwampRoadNorth quests'
    );
}

async function testSwampRoadNorthStoryNpcDoesNotAssignBeforeSwampUnlock(): Promise<void> {
    const client = createFakeClient(
        'SwampRoadNorth',
        {
            [String(MissionID.RescueAnna)]: {
                state: 1,
                currCount: 0
            }
        },
        100
    );
    client.character.CurrentLevel = { name: 'SwampRoadNorth', x: 16000, y: 4800 };
    client.entities.set(15001, { id: 15001, characterName: 'SRN_Mayor01' });

    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(15001));

    assert.equal(
        client.sentPackets.some((entry) => entry.id === 0x85),
        false,
        'SwampRoadNorth story NPCs should not assign quests before Deliver to Swamp is completed'
    );
    assert.equal(
        client.character.missions[String(MissionID.StopCastout)],
        undefined,
        'SwampRoadNorth story missions should remain locked before the NewbieRoad arc is finished'
    );
}

async function testJarvisDoesNotAutoTurnInRecoverRingsWhileInProgress(): Promise<void> {
    const client = createFakeClient(
        'NewbieRoad',
        {
            [String(MissionID.ClearYourHouse)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1
            },
            [String(MissionID.GetGoblinNoserings)]: {
                state: 1,
                currCount: 0
            }
        },
        100
    );
    client.character.CurrentLevel = { name: 'NewbieRoad', x: 12858, y: 2299 };
    client.entities.set(4121314, { id: 4121314, characterName: 'NR_Villager02' });

    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(4121314));

    assert.equal(
        Number(client.character.missions[String(MissionID.GetGoblinNoserings)]?.state ?? 0),
        1,
        'Recover Rings should remain active until the goblin nosering objective is actually completed'
    );
    assert.equal(
        client.character.missions[String(MissionID.KillGoblins)],
        undefined,
        'Goblin Takedown should not auto-start before Recover Rings is properly turned in'
    );
    assert.equal(
        client.sentPackets.some((entry) => entry.id === 0x84),
        false,
        'Jarvis should not send the mission-complete UI for an in-progress Recover Rings quest'
    );

    const skitPacket = client.sentPackets.find((entry) => entry.id === 0x7B);
    assert.ok(skitPacket, 'Jarvis should continue with the active Recover Rings dialogue');
    assert.deepEqual(
        decodeStartSkitPacket(skitPacket!.payload),
        {
            npcId: 4121314,
            dialogueId: 3,
            missionId: MissionID.GetGoblinNoserings
        },
        'Jarvis should play the active Recover Rings dialogue instead of the turn-in dialogue'
    );
}

async function main(): Promise<void> {
    ensureDataLoaded();
    await testTutorialBoatCompletionPersistsDungeonHoverStats();
    await testRescueAnnaCompletionLeavesFindAnnasFatherAvailableOnAnna();
    await testPrimedFindAnnasFatherBlocksMayorUntilAnnaShowsOffer();
    testFindAnnasFatherUsesOverworldAnnaContact();
    await testRescueAnnaRerunRefreshesDungeonHoverStats();
    await testRescueAnnaLowerScoreRerunKeepsBestHoverStats();
    await testCaptainFinkRepairsLostAtSeaTurnInForCurrentPlayer();
    await testCaptainFinkTurnInClaimsFirstThenOffersWashedAshoreOnSecondTalk();
    await testMayorTurnInClaimsWashedAshoreThenOffersRescueAnnaOnSecondTalk();
    await testMayorUsesJsonFallbackDialogueWhenNoQuestMatches();
    await testMayorTurnInClaimsFindAnnasFatherThenOffersKeepQuestOnSecondTalk();
    await testClaimedRescueAnnaLetsAnnaOutsideOfferFindAnnasFather();
    await testTurkishMissionDialogueUsesLocalizedRawText();
    await testTurkishFallbackDialogueUsesLocalizedJsonLines();
    await testNewbieRoadAffricFallbackUsesOriginalGuardedLines();
    await testSwampRoadNorthAffricUsesSrnMayorDialogueKey();
    await testNewbieRoadOdemDoesNotStartBlackRoseMireQuestEarly();
    await testSwampRoadNorthStoryNpcDoesNotAssignBeforeSwampUnlock();
    await testJarvisDoesNotAutoTurnInRecoverRingsWhileInProgress();
    console.log('quest_flow_regression: ok');
}

void main().catch((error) => {
    console.error('quest_flow_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
