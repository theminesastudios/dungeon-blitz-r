import { strict as assert } from 'assert';
import path from 'path';
import { Character } from '../database/Database';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { CombatHandler } from '../handlers/CombatHandler';
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
    clientEntID: number;
    userId: number | null;
    character: Character;
    characters?: Character[];
    authoritativeMaxHp: number;
    authoritativeCurrentHp: number;
    processedRewardSources: Set<string>;
    pendingLoot: Map<number, unknown>;
    knownEntityIds: Set<number>;
    entities: Map<number, any>;
    sentPackets: SentPacket[];
    send(id: number, payload: Buffer): void;
    sendBitBuffer(id: number, bb: BitBuffer): void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('NewbieRoad')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.GetGoblinNoserings)) {
        MissionLoader.load(dataDir);
    }
}

function resetGlobalState(): void {
    GlobalState.sessionsByToken.clear();
    GlobalState.sessionsByUserId.clear();
    GlobalState.sessionsByCharacterName.clear();
    GlobalState.partyGroups.clear();
    GlobalState.partyByMember.clear();
    GlobalState.levelEntities.clear();
    GlobalState.levelQuestProgress.clear();
    GlobalState.combatContributions.clear();
    GlobalState.entityLifeNonces.clear();
    GlobalState.entityLastRewardNonces.clear();
}

function createCharacter(
    missions: Record<string, Record<string, number>>,
    currentLevel: string = 'NewbieRoad'
): Character {
    return {
        name: 'QuestKillTester',
        class: 'Paladin',
        gender: 'male',
        level: 3,
        missions,
        questTrackerState: 100,
        CurrentLevel: { name: currentLevel, x: 0, y: 0 },
        PreviousLevel: { name: currentLevel, x: 0, y: 0 }
    };
}

function createClient(
    missions: Record<string, Record<string, number>>,
    currentLevel: string = 'NewbieRoad'
): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = createCharacter(missions, currentLevel);

    return {
        token: 9101,
        currentLevel,
        levelInstanceId: '',
        currentRoomId: 0,
        playerSpawned: true,
        clientEntID: 40101,
        userId: null,
        character,
        characters: [character],
        authoritativeMaxHp: 100,
        authoritativeCurrentHp: 100,
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, unknown>(),
        knownEntityIds: new Set<number>(),
        entities: new Map<number, any>(),
        sentPackets,
        send(id: number, payload: Buffer): void {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createDestroyEntityPacket(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function decodeMissionProgressPacket(payload: Buffer): { missionId: number; progress: number } {
    const br = new BitReader(payload);
    return {
        missionId: br.readMethod4(),
        progress: br.readMethod4()
    };
}

function decodeMissionCompletePacket(payload: Buffer): number {
    const br = new BitReader(payload);
    return br.readMethod4();
}

async function destroyEnemy(
    client: FakeClient,
    entityId: number,
    entityName: string,
    extra: Record<string, unknown> = {}
): Promise<void> {
    client.entities.set(entityId, {
        id: entityId,
        name: entityName,
        isPlayer: false,
        team: 2,
        ...extra
    });
    await CombatHandler.handleEntityDestroy(client as never, createDestroyEntityPacket(entityId));
}

async function testRecoverRingsProgressesOnGoblinBruteKills(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.GetGoblinNoserings)]: {
            state: 1,
            currCount: 0
        }
    });

    for (let index = 0; index < 5; index++) {
        await destroyEnemy(client, 5000 + index, 'GoblinBrute');
    }

    assert.equal(
        Number(client.character.missions[String(MissionID.GetGoblinNoserings)]?.currCount ?? 0),
        5,
        'Recover Rings should count each GoblinBrute kill toward the nosering total'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.GetGoblinNoserings)]?.state ?? 0),
        2,
        'Recover Rings should become ready to turn in after five GoblinBrute kills'
    );

    assert.deepEqual(
        client.sentPackets
            .filter((packet) => packet.id === 0x83)
            .map((packet) => decodeMissionProgressPacket(packet.payload)),
        [
            { missionId: MissionID.GetGoblinNoserings, progress: 1 },
            { missionId: MissionID.GetGoblinNoserings, progress: 1 },
            { missionId: MissionID.GetGoblinNoserings, progress: 1 },
            { missionId: MissionID.GetGoblinNoserings, progress: 1 },
            { missionId: MissionID.GetGoblinNoserings, progress: 1 }
        ],
        'Recover Rings should send delta progress packets because the client adds the value onto the visible counter'
    );
    assert.equal(
        decodeMissionCompletePacket(
            client.sentPackets.find((packet) => packet.id === 0x86)!.payload
        ),
        MissionID.GetGoblinNoserings,
        'Recover Rings should notify the client once the nosering objective is complete'
    );
}

async function testRecoverRingsIgnoresNonBruteGoblinKills(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.GetGoblinNoserings)]: {
            state: 1,
            currCount: 0
        }
    });

    await destroyEnemy(client, 6001, 'IntroGoblin');

    assert.equal(
        Number(client.character.missions[String(MissionID.GetGoblinNoserings)]?.currCount ?? 0),
        0,
        'Recover Rings should ignore smaller goblins'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x83 || packet.id === 0x86),
        false,
        'Recover Rings should stay silent when an unrelated goblin dies'
    );
}

async function testGoblinTakedownProgressesOnAnyNewbieRoadGoblinKill(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.KillGoblins)]: {
            state: 1,
            currCount: 0
        }
    });

    await destroyEnemy(client, 7001, 'GoblinDagger');
    await destroyEnemy(client, 7002, 'GoblinShamanSkullHat');
    await destroyEnemy(client, 7003, 'GoblinMiniBoss');

    assert.equal(
        Number(client.character.missions[String(MissionID.KillGoblins)]?.currCount ?? 0),
        3,
        'Goblin Takedown should count different goblin enemy types from NewbieRoad'
    );
    assert.equal(
        client.sentPackets.filter((packet) => packet.id === 0x83).length,
        3,
        'Goblin Takedown should emit one mission-progress delta packet per goblin kill'
    );
    assert.deepEqual(
        client.sentPackets
            .filter((packet) => packet.id === 0x83)
            .map((packet) => decodeMissionProgressPacket(packet.payload)),
        [
            { missionId: MissionID.KillGoblins, progress: 1 },
            { missionId: MissionID.KillGoblins, progress: 1 },
            { missionId: MissionID.KillGoblins, progress: 1 }
        ],
        'Goblin Takedown should use additive mission progress packets for every goblin kill'
    );
}

async function testGoblinTakedownIgnoresNonGoblinKills(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.KillGoblins)]: {
            state: 1,
            currCount: 0
        }
    });

    await destroyEnemy(client, 8001, 'SkeletonClub');
    await destroyEnemy(client, 8002, 'Devourer');

    assert.equal(
        Number(client.character.missions[String(MissionID.KillGoblins)]?.currCount ?? 0),
        0,
        'Goblin Takedown should ignore non-goblin enemies from NewbieRoad'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x83 || packet.id === 0x86),
        false,
        'Goblin Takedown should not send progress or completion packets for non-goblin kills'
    );
}

async function testLootersCompletesOnGoblinThiefKill(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.RecoverMyStuff)]: {
            state: 1,
            currCount: 0
        }
    });

    await destroyEnemy(client, 8101, 'GoblinMiniBoss', {
        characterName: 'GoblinThief'
    });

    assert.equal(
        Number(client.character.missions[String(MissionID.RecoverMyStuff)]?.currCount ?? 0),
        1,
        'Looters should count the GoblinThief kill'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.RecoverMyStuff)]?.state ?? 0),
        2,
        'Looters should become ready to turn in after GoblinThief dies'
    );
    assert.deepEqual(
        client.sentPackets
            .filter((packet) => packet.id === 0x83)
            .map((packet) => decodeMissionProgressPacket(packet.payload)),
        [{ missionId: MissionID.RecoverMyStuff, progress: 1 }],
        'Looters should send a single additive mission progress packet'
    );
    assert.equal(
        decodeMissionCompletePacket(
            client.sentPackets.find((packet) => packet.id === 0x86)!.payload
        ),
        MissionID.RecoverMyStuff,
        'Looters should notify the client when the commander dies'
    );
}

async function testBoneyardMonsterCompletesOnGraveyardSkeletonKill(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.KillGraveyardSkeleton)]: {
            state: 1,
            currCount: 0
        }
    });

    await destroyEnemy(client, 8201, 'SkeletonKnight', {
        characterName: 'GraveyardSkeleton'
    });

    assert.equal(
        Number(client.character.missions[String(MissionID.KillGraveyardSkeleton)]?.currCount ?? 0),
        1,
        'Boneyard Monster should count the GraveyardSkeleton kill'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.KillGraveyardSkeleton)]?.state ?? 0),
        2,
        'Boneyard Monster should become ready to turn in after GraveyardSkeleton dies'
    );
    assert.deepEqual(
        client.sentPackets
            .filter((packet) => packet.id === 0x83)
            .map((packet) => decodeMissionProgressPacket(packet.payload)),
        [{ missionId: MissionID.KillGraveyardSkeleton, progress: 1 }],
        'Boneyard Monster should send a single additive mission progress packet'
    );
    assert.equal(
        decodeMissionCompletePacket(
            client.sentPackets.find((packet) => packet.id === 0x86)!.payload
        ),
        MissionID.KillGraveyardSkeleton,
        'Boneyard Monster should notify the client when the shrine boss dies'
    );
}

async function testLootersHardCompletesOnGoblinThiefHardKill(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.RecoverMyStuffHard)]: {
            state: 1,
            currCount: 0
        }
    }, 'NewbieRoadHard');

    await destroyEnemy(client, 8301, 'GoblinMiniBossHard', {
        characterName: 'GoblinThiefHard'
    });

    assert.equal(
        Number(client.character.missions[String(MissionID.RecoverMyStuffHard)]?.currCount ?? 0),
        1,
        'Looters hard mode should count GoblinThiefHard'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.RecoverMyStuffHard)]?.state ?? 0),
        2,
        'Looters hard mode should become ready to turn in after GoblinThiefHard dies'
    );
}

async function testRecoverWandsProgressesOnGoblinShamanKills(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.GetGoblinWands)]: {
            state: 1,
            currCount: 0
        }
    });

    await destroyEnemy(client, 8401, 'GoblinShamanHood');
    await destroyEnemy(client, 8402, 'GoblinShamanSkullHat');

    assert.equal(
        Number(client.character.missions[String(MissionID.GetGoblinWands)]?.currCount ?? 0),
        2,
        'Recover Wands should count both goblin shaman variants'
    );
    assert.deepEqual(
        client.sentPackets
            .filter((packet) => packet.id === 0x83)
            .map((packet) => decodeMissionProgressPacket(packet.payload)),
        [
            { missionId: MissionID.GetGoblinWands, progress: 1 },
            { missionId: MissionID.GetGoblinWands, progress: 1 }
        ],
        'Recover Wands should send additive mission progress packets for shaman kills'
    );
}

async function main(): Promise<void> {
    ensureDataLoaded();
    await testRecoverRingsProgressesOnGoblinBruteKills();
    await testRecoverRingsIgnoresNonBruteGoblinKills();
    await testGoblinTakedownProgressesOnAnyNewbieRoadGoblinKill();
    await testGoblinTakedownIgnoresNonGoblinKills();
    await testLootersCompletesOnGoblinThiefKill();
    await testBoneyardMonsterCompletesOnGraveyardSkeletonKill();
    await testLootersHardCompletesOnGoblinThiefHardKill();
    await testRecoverWandsProgressesOnGoblinShamanKills();
    console.log('mission_kill_progress_regression: ok');
}

void main().catch((error) => {
    console.error('mission_kill_progress_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
