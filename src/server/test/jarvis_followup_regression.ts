import { strict as assert } from 'assert';
import * as path from 'path';
import { LevelConfig } from '../core/LevelConfig';
import { MissionDialogueLoader } from '../data/MissionDialogueLoader';
import { MissionLoader } from '../data/MissionLoader';
import { NpcDialogueLoader } from '../data/NpcDialogueLoader';
import { NpcLoader } from '../data/NpcLoader';
import { MissionID } from '../data/runtime';
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
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('NewbieRoad')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.GetGoblinNoserings)) {
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
        token: 9102,
        currentLevel,
        levelInstanceId: 'jarvis-followup',
        currentRoomId: 0,
        playerSpawned: true,
        startedRoomEvents: new Set<string>(),
        userId: null,
        character: {
            name: 'JarvisTester',
            level: 4,
            xp: 0,
            gold: 0,
            CurrentLevel: { name: currentLevel, x: 12858, y: 2299 },
            PreviousLevel: { name: currentLevel, x: 12858, y: 2299 },
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

async function testJarvisTurnInClaimsRecoverRingsThenOffersGoblinTakedownOnSecondTalk(): Promise<void> {
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
                state: 2,
                currCount: 5
            }
        },
        100
    );
    client.entities.set(4121314, { id: 4121314, characterName: 'NR_Villager02' });

    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(4121314));

    assert.equal(
        Number(client.character.missions[String(MissionID.GetGoblinNoserings)]?.state ?? 0),
        3,
        'the first Jarvis talk should only claim Recover Rings'
    );
    assert.equal(
        client.character.missions[String(MissionID.KillGoblins)],
        undefined,
        'Goblin Takedown should not auto-start during the same Jarvis reward turn-in'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x84),
        true,
        'claiming Recover Rings should still show the mission-complete reward UI'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x85),
        false,
        'claiming Recover Rings should not send a Goblin Takedown mission-added packet yet'
    );

    client.sentPackets.length = 0;
    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(4121314));

    assert.equal(
        Number(client.character.missions[String(MissionID.KillGoblins)]?.state ?? 0),
        1,
        'the second Jarvis talk should accept Goblin Takedown'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x85),
        true,
        'accepting Goblin Takedown on the second talk should send the mission-added packet'
    );

    client.sentPackets.length = 0;
    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(4121314));

    const skitPacket = client.sentPackets.find((packet) => packet.id === 0x7B);
    assert.ok(
        skitPacket,
        'talking to Jarvis after accepting Goblin Takedown should still start a mission skit'
    );
    assert.deepEqual(
        decodeStartSkitPacket(skitPacket!.payload),
        {
            npcId: 4121314,
            dialogueId: 3,
            missionId: MissionID.KillGoblins
        },
        'Jarvis should continue with Goblin Takedown active dialogue after the mission is accepted'
    );
}

async function testAnnaTurnInClaimsLastOfTheGoblinsThenOffersNephitsQuestOnSecondTalk(): Promise<void> {
    const client = createFakeClient(
        'NewbieRoad',
        {
            [String(MissionID.ClearYourHouse)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1
            },
            [String(MissionID.GoblinRiver)]: {
                state: 2,
                currCount: 1
            }
        },
        100
    );
    client.entities.set(4186850, { id: 4186850, characterName: 'NR_QuestAnna01' });

    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(4186850));

    assert.equal(
        Number(client.character.missions[String(MissionID.GoblinRiver)]?.state ?? 0),
        3,
        'the first Anna talk should only claim Last of the Goblins'
    );
    assert.equal(
        client.character.missions[String(MissionID.KillNephit)],
        undefined,
        "Nephit's Quest should not auto-start during the same Anna reward turn-in"
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x84),
        true,
        'claiming Last of the Goblins should still show the mission-complete reward UI'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x85),
        false,
        "claiming Last of the Goblins should not send a Nephit's Quest mission-added packet yet"
    );

    client.sentPackets.length = 0;
    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(4186850));

    assert.equal(
        Number(client.character.missions[String(MissionID.KillNephit)]?.state ?? 0),
        1,
        "the second Anna talk should accept Nephit's Quest"
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x85),
        true,
        "accepting Nephit's Quest on the second talk should send the mission-added packet"
    );

    client.sentPackets.length = 0;
    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(4186850));

    const skitPacket = client.sentPackets.find((packet) => packet.id === 0x7B);
    assert.ok(
        skitPacket,
        "talking to Anna after accepting Nephit's Quest should still start a mission skit"
    );
    assert.deepEqual(
        decodeStartSkitPacket(skitPacket!.payload),
        {
            npcId: 4186850,
            dialogueId: 3,
            missionId: MissionID.KillNephit
        },
        "Anna should continue with Nephit's Quest active dialogue after the mission is accepted"
    );
}

async function testAnnaOffersDragonsDreamWithFreshDungeonTracker(): Promise<void> {
    const client = createFakeClient(
        'NewbieRoad',
        {
            [String(MissionID.KillNephit)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1
            }
        },
        100
    );
    client.entities.set(4186851, { id: 4186851, characterName: 'NR_QuestAnna02' });

    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(4186851));

    assert.equal(
        Number(client.character.missions[String(MissionID.SlayTheDragon)]?.state ?? 0),
        1,
        "talking to Anna after Nephit's Quest should accept The Dragon's Dream"
    );
    assert.equal(
        client.character.questTrackerState,
        0,
        "accepting a new dungeon mission should clear stale completion progress from the previous dungeon"
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x85),
        true,
        "accepting The Dragon's Dream should send the mission-added packet"
    );

    client.sentPackets.length = 0;
    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(4186851));

    const skitPacket = client.sentPackets.find((packet) => packet.id === 0x7B);
    assert.ok(
        skitPacket,
        "talking to Anna again after accepting The Dragon's Dream should keep the mission active"
    );
    assert.deepEqual(
        decodeStartSkitPacket(skitPacket!.payload),
        {
            npcId: 4186851,
            dialogueId: 3,
            missionId: MissionID.SlayTheDragon
        },
        "Anna should not treat The Dragon's Dream as completed immediately after it is accepted"
    );
}

async function main(): Promise<void> {
    ensureDataLoaded();
    await testJarvisTurnInClaimsRecoverRingsThenOffersGoblinTakedownOnSecondTalk();
    await testAnnaTurnInClaimsLastOfTheGoblinsThenOffersNephitsQuestOnSecondTalk();
    await testAnnaOffersDragonsDreamWithFreshDungeonTracker();
    console.log('jarvis_followup_regression: ok');
}

void main().catch((error) => {
    console.error('jarvis_followup_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
