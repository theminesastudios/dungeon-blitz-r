import { strict as assert } from 'assert';
import path from 'path';
import { Character } from '../database/Database';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { EntityState } from '../core/Entity';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { CombatHandler } from '../handlers/CombatHandler';
import { LevelHandler } from '../handlers/LevelHandler';
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
    if (!GameData.getEntType('Devourer')) {
        GameData.load(dataDir);
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

function buildPowerHitPayload(targetId: number, sourceId: number, damage: number, powerId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(targetId);
    bb.writeMethod4(sourceId);
    bb.writeMethod24(damage);
    bb.writeMethod4(powerId);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildBuffTickDotPayload(targetId: number, sourceId: number, damage: number, powerId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(targetId);
    bb.writeMethod9(sourceId);
    bb.writeMethod9(powerId);
    bb.writeMethod45(damage);
    bb.writeMethod20(5, 0);
    return bb.toBuffer();
}

function buildIncrementalStatePayload(entityId: number, entState: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod45(0);
    bb.writeMethod45(0);
    bb.writeMethod45(0);
    bb.writeMethod6(entState, 2);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
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

async function killEnemyByState(
    client: FakeClient,
    entityId: number,
    entityName: string,
    extra: Record<string, unknown> = {}
): Promise<void> {
    const entity = {
        id: entityId,
        name: entityName,
        isPlayer: false,
        team: 2,
        hp: 1,
        entState: EntityState.ACTIVE,
        ...extra
    };
    client.entities.set(entityId, entity);
    await LevelHandler.handleEntityIncrementalUpdate(
        client as never,
        buildIncrementalStatePayload(entityId, EntityState.DEAD)
    );
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

async function testGetSpiderFangsProgressesOnSwampSpiderKills(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.GetSpiderFangs)]: {
            state: 1,
            currCount: 8
        }
    }, 'SwampRoadNorth');

    await destroyEnemy(client, 8451, 'SwampSpider');
    await destroyEnemy(client, 8452, 'SwampSpiderGiant');

    assert.equal(
        Number(client.character.missions[String(MissionID.GetSpiderFangs)]?.currCount ?? 0),
        10,
        'Get Spider Fangs should count swamp spider kills toward the fang total'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.GetSpiderFangs)]?.state ?? 0),
        2,
        'Get Spider Fangs should become ready to turn in once enough spiders are slain'
    );
    assert.deepEqual(
        client.sentPackets
            .filter((packet) => packet.id === 0x83)
            .map((packet) => decodeMissionProgressPacket(packet.payload)),
        [
            { missionId: MissionID.GetSpiderFangs, progress: 1 },
            { missionId: MissionID.GetSpiderFangs, progress: 1 }
        ],
        'Get Spider Fangs should emit additive mission progress packets for spider kills'
    );
    assert.equal(
        decodeMissionCompletePacket(
            client.sentPackets.find((packet) => packet.id === 0x86)!.payload
        ),
        MissionID.GetSpiderFangs,
        'Get Spider Fangs should notify the client once the fang objective is complete'
    );
}

async function testBannersOfTheTuataraProgressesOnLizardBannerKills(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.GetLizardBanners)]: {
            state: 1,
            currCount: 4
        }
    }, 'SwampRoadNorth');

    await destroyEnemy(client, 8461, 'LizardBanner');

    assert.equal(
        Number(client.character.missions[String(MissionID.GetLizardBanners)]?.currCount ?? 0),
        5,
        'Banners of the Tuatara should count LizardBanner kills toward the banner total'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.GetLizardBanners)]?.state ?? 0),
        2,
        'Banners of the Tuatara should become ready to turn in after enough banners are collected'
    );
    assert.deepEqual(
        client.sentPackets
            .filter((packet) => packet.id === 0x83)
            .map((packet) => decodeMissionProgressPacket(packet.payload)),
        [{ missionId: MissionID.GetLizardBanners, progress: 1 }],
        'Banners of the Tuatara should emit additive mission progress packets for banner kills'
    );
    assert.equal(
        decodeMissionCompletePacket(
            client.sentPackets.find((packet) => packet.id === 0x86)!.payload
        ),
        MissionID.GetLizardBanners,
        'Banners of the Tuatara should notify the client once the banner objective is complete'
    );
}

async function testHardBannersOfTheTuataraProgressesOnLizardBannerKills(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.GetLizardBannersHard)]: {
            state: 1,
            currCount: 9
        }
    }, 'SwampRoadNorthHard');

    await destroyEnemy(client, 8462, 'LizardBannerHard');

    assert.equal(
        Number(client.character.missions[String(MissionID.GetLizardBannersHard)]?.currCount ?? 0),
        10,
        'Hard Banners of the Tuatara should count LizardBannerHard kills toward the banner total'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.GetLizardBannersHard)]?.state ?? 0),
        2,
        'Hard Banners of the Tuatara should become ready to turn in after enough banners are collected'
    );
    assert.deepEqual(
        client.sentPackets
            .filter((packet) => packet.id === 0x83)
            .map((packet) => decodeMissionProgressPacket(packet.payload)),
        [{ missionId: MissionID.GetLizardBannersHard, progress: 1 }],
        'Hard Banners of the Tuatara should emit additive mission progress packets for banner kills'
    );
    assert.equal(
        decodeMissionCompletePacket(
            client.sentPackets.find((packet) => packet.id === 0x86)!.payload
        ),
        MissionID.GetLizardBannersHard,
        'Hard Banners of the Tuatara should notify the client once the banner objective is complete'
    );
}

async function testTuataraGreatHelmsProgressesOnLizardHeavyKills(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.GetLizardGreatHelm)]: {
            state: 1,
            currCount: 8
        }
    }, 'SwampRoadNorth');

    await destroyEnemy(client, 8463, 'GreatLizardHeavy2');
    await destroyEnemy(client, 8464, 'LizardHeavy');

    assert.equal(
        Number(client.character.missions[String(MissionID.GetLizardGreatHelm)]?.currCount ?? 0),
        9,
        'Get Tuatara Great Helms should count LizardHeavy kills toward the helm total'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.GetLizardGreatHelm)]?.state ?? 0),
        1,
        'Get Tuatara Great Helms should remain active when only one LizardHeavy helm is collected'
    );
    assert.deepEqual(
        client.sentPackets
            .filter((packet) => packet.id === 0x83)
            .map((packet) => decodeMissionProgressPacket(packet.payload)),
        [{ missionId: MissionID.GetLizardGreatHelm, progress: 1 }],
        'Get Tuatara Great Helms should emit additive mission progress packets only for LizardHeavy kills'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x86),
        false,
        'Get Tuatara Great Helms should not complete from ignored GreatLizard kills'
    );
}

async function testHardTuataraGreatHelmsProgressesOnLizardHeavyKills(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.GetLizardGreatHelmHard)]: {
            state: 1,
            currCount: 19
        }
    }, 'SwampRoadNorthHard');

    await destroyEnemy(client, 8465, 'LizardHeavyHard');

    assert.equal(
        Number(client.character.missions[String(MissionID.GetLizardGreatHelmHard)]?.currCount ?? 0),
        20,
        'Hard Get Tuatara Great Helms should count LizardHeavyHard kills toward the helm total'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.GetLizardGreatHelmHard)]?.state ?? 0),
        2,
        'Hard Get Tuatara Great Helms should become ready to turn in after enough helms are collected'
    );
    assert.deepEqual(
        client.sentPackets
            .filter((packet) => packet.id === 0x83)
            .map((packet) => decodeMissionProgressPacket(packet.payload)),
        [{ missionId: MissionID.GetLizardGreatHelmHard, progress: 1 }],
        'Hard Get Tuatara Great Helms should emit additive mission progress packets for LizardHeavyHard kills'
    );
    assert.equal(
        decodeMissionCompletePacket(
            client.sentPackets.find((packet) => packet.id === 0x86)!.payload
        ),
        MissionID.GetLizardGreatHelmHard,
        'Hard Get Tuatara Great Helms should notify the client once the helm objective is complete'
    );
}

async function testDevourerTeethProgressesFromDevourerRealmKills(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.GetDevourerTeeth)]: {
            state: 1,
            currCount: 8
        }
    }, 'SwampRoadNorth');

    await destroyEnemy(client, 8465, 'Devourer');
    await destroyEnemy(client, 8466, 'DevourerHeavy');
    await destroyEnemy(client, 8467, 'DevourerMiniBoss');

    assert.equal(
        Number(client.character.missions[String(MissionID.GetDevourerTeeth)]?.currCount ?? 0),
        10,
        'Get Devourer Teeth should count only larger Devourer-realm kills toward the tooth total'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.GetDevourerTeeth)]?.state ?? 0),
        2,
        'Get Devourer Teeth should become ready to turn in after enough teeth are collected'
    );
    assert.deepEqual(
        client.sentPackets
            .filter((packet) => packet.id === 0x83)
            .map((packet) => decodeMissionProgressPacket(packet.payload)),
        [
            { missionId: MissionID.GetDevourerTeeth, progress: 1 },
            { missionId: MissionID.GetDevourerTeeth, progress: 1 }
        ],
        'Get Devourer Teeth should emit additive mission progress packets for larger Devourer kills'
    );
    assert.equal(
        decodeMissionCompletePacket(
            client.sentPackets.find((packet) => packet.id === 0x86)!.payload
        ),
        MissionID.GetDevourerTeeth,
        'Get Devourer Teeth should notify the client once the tooth objective is complete'
    );
}

async function testHardDevourerTeethProgressesFromDevourerRealmKills(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.GetDevourerTeethHard)]: {
            state: 1,
            currCount: 19
        }
    }, 'SwampRoadNorthHard');

    await destroyEnemy(client, 8467, 'DevourerShootingHard');

    assert.equal(
        Number(client.character.missions[String(MissionID.GetDevourerTeethHard)]?.currCount ?? 0),
        20,
        'Hard Get Devourer Teeth should count Devourer-realm kills toward the tooth total'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.GetDevourerTeethHard)]?.state ?? 0),
        2,
        'Hard Get Devourer Teeth should become ready to turn in after enough teeth are collected'
    );
    assert.deepEqual(
        client.sentPackets
            .filter((packet) => packet.id === 0x83)
            .map((packet) => decodeMissionProgressPacket(packet.payload)),
        [{ missionId: MissionID.GetDevourerTeethHard, progress: 1 }],
        'Hard Get Devourer Teeth should emit additive mission progress packets for Devourer kills'
    );
    assert.equal(
        decodeMissionCompletePacket(
            client.sentPackets.find((packet) => packet.id === 0x86)!.payload
        ),
        MissionID.GetDevourerTeethHard,
        'Hard Get Devourer Teeth should notify the client once the tooth objective is complete'
    );
}

async function testLaterSideQuestCollectiblesProgressFromEnemyRealms(): Promise<void> {
    const cases: Array<{
        missionId: MissionID;
        currentLevel: string;
        enemyName: string;
        startingCount: number;
        expectedLabel: string;
    }> = [
        {
            missionId: MissionID.RetrieveHeirlooms,
            currentLevel: 'CemeteryHill',
            enemyName: 'JackalAlpha',
            startingCount: 9,
            expectedLabel: 'Heirloom'
        },
        {
            missionId: MissionID.CollectRockShards,
            currentLevel: 'OldMineMountain',
            enemyName: 'RockHulk',
            startingCount: 9,
            expectedLabel: 'Alurite'
        },
        {
            missionId: MissionID.GatherDarkTotems,
            currentLevel: 'EmeraldGlades',
            enemyName: 'AshenDryad',
            startingCount: 9,
            expectedLabel: 'Dark Totem'
        },
        {
            missionId: MissionID.CollectImperialInsignias,
            currentLevel: 'JadeCity',
            enemyName: 'ImperialGuard',
            startingCount: 19,
            expectedLabel: 'Imperial Insignia'
        },
        {
            missionId: MissionID.CollectDemonTears,
            currentLevel: 'JadeCity',
            enemyName: 'ShadeWarrior',
            startingCount: 19,
            expectedLabel: 'Demon Tear'
        }
    ];

    for (const item of cases) {
        resetGlobalState();
        const client = createClient({
            [String(item.missionId)]: {
                state: 1,
                currCount: item.startingCount
            }
        }, item.currentLevel);

        await destroyEnemy(client, 8700 + item.missionId, item.enemyName);

        assert.equal(
            Number(client.character.missions[String(item.missionId)]?.currCount ?? 0),
            item.startingCount + 1,
            `${item.expectedLabel} should be granted immediately from ${item.enemyName}`
        );
        assert.deepEqual(
            client.sentPackets
                .filter((packet) => packet.id === 0x83)
                .map((packet) => decodeMissionProgressPacket(packet.payload)),
            [{ missionId: item.missionId, progress: 1 }],
            `${item.expectedLabel} should emit an additive mission progress packet on kill`
        );
    }
}

async function testStormshardSideQuestKillsProgressFromExplicitTargets(): Promise<void> {
    resetGlobalState();
    const spiderClient = createClient({
        [String(MissionID.SquashSomeSpiders)]: {
            state: 1,
            currCount: 14
        }
    }, 'OldMineMountain');

    await destroyEnemy(spiderClient, 8781, 'AbominationSpider');

    assert.equal(
        Number(spiderClient.character.missions[String(MissionID.SquashSomeSpiders)]?.currCount ?? 0),
        15,
        'Spider Stomp should count Stormshard abomination spiders'
    );
    assert.equal(
        Number(spiderClient.character.missions[String(MissionID.SquashSomeSpiders)]?.state ?? 0),
        2,
        'Spider Stomp should become ready to turn in once enough Stormshard spiders are defeated'
    );
    assert.deepEqual(
        spiderClient.sentPackets
            .filter((packet) => packet.id === 0x83)
            .map((packet) => decodeMissionProgressPacket(packet.payload)),
        [{ missionId: MissionID.SquashSomeSpiders, progress: 1 }],
        'Spider Stomp should emit an additive mission progress packet on spider kills'
    );

    resetGlobalState();
    const aluriteClient = createClient({
        [String(MissionID.CollectRockShards)]: {
            state: 1,
            currCount: 9
        }
    }, 'OMM_Mission8');
    aluriteClient.levelInstanceId = 'veins-alurite';

    await killEnemyByState(aluriteClient, 8782, 'MeylourHulk');

    assert.equal(
        Number(aluriteClient.character.missions[String(MissionID.CollectRockShards)]?.currCount ?? 0),
        10,
        'Collect Alurite should count Meylour Hulks inside Stormshard dungeons'
    );
    assert.equal(
        Number(aluriteClient.character.missions[String(MissionID.CollectRockShards)]?.state ?? 0),
        2,
        'Collect Alurite should become ready to turn in once enough hulks are defeated'
    );
    assert.deepEqual(
        aluriteClient.sentPackets
            .filter((packet) => packet.id === 0x83)
            .map((packet) => decodeMissionProgressPacket(packet.payload)),
        [{ missionId: MissionID.CollectRockShards, progress: 1 }],
        'Collect Alurite should emit an additive mission progress packet on hulk kills'
    );
}

async function testSideQuestEnemyKillsProgressInsideDungeonsOnDeadStateOnlyOnce(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.GetGoblinNoserings)]: {
            state: 1,
            currCount: 0
        }
    }, 'GoblinRiverDungeon');
    client.levelInstanceId = 'side-quest-dungeon';

    GlobalState.sessionsByToken.set(client.token, client as never);
    const levelScope = getClientLevelScope(client as never);
    const hostile = {
        id: 8501,
        name: 'GoblinBrute',
        isPlayer: false,
        team: 2,
        hp: 1,
        entState: 0,
        roomId: 0,
        ownerToken: client.token
    };
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [hostile.id, hostile]
    ]));

    await CombatHandler.handlePowerHit(
        client as never,
        buildPowerHitPayload(hostile.id, client.clientEntID, 5, 77)
    );

    assert.equal(
        Number(client.character.missions[String(MissionID.GetGoblinNoserings)]?.currCount ?? 0),
        0,
        'side-quest enemy kills inside dungeons should wait for the kill state instead of the lethal hit'
    );

    await LevelHandler.handleEntityIncrementalUpdate(
        client as never,
        buildIncrementalStatePayload(hostile.id, EntityState.DEAD)
    );

    assert.equal(
        Number(client.character.missions[String(MissionID.GetGoblinNoserings)]?.currCount ?? 0),
        1,
        'side-quest enemy kills inside dungeons should progress when the enemy enters the kill state'
    );

    await CombatHandler.handleEntityDestroy(client as never, createDestroyEntityPacket(hostile.id));

    assert.equal(
        Number(client.character.missions[String(MissionID.GetGoblinNoserings)]?.currCount ?? 0),
        1,
        'side-quest enemy kills inside dungeons should not count again on destroy'
    );
}

async function testSideQuestDotKillsProgressInsideDungeonsOnDeadStateOnlyOnce(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.GetGoblinNoserings)]: {
            state: 1,
            currCount: 0
        }
    }, 'GoblinRiverDungeon');
    client.levelInstanceId = 'side-quest-dot-dungeon';

    GlobalState.sessionsByToken.set(client.token, client as never);
    const levelScope = getClientLevelScope(client as never);
    const hostile = {
        id: 8502,
        name: 'GoblinBrute',
        isPlayer: false,
        team: 2,
        hp: 1,
        entState: 0,
        roomId: 0,
        ownerToken: client.token
    };
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [hostile.id, hostile]
    ]));

    await CombatHandler.handleBuffTickDot(
        client as never,
        buildBuffTickDotPayload(hostile.id, client.clientEntID, 5, 77)
    );

    assert.equal(
        Number(client.character.missions[String(MissionID.GetGoblinNoserings)]?.currCount ?? 0),
        0,
        'side-quest DoT kills inside dungeons should wait for the kill state instead of the lethal tick'
    );

    await LevelHandler.handleEntityIncrementalUpdate(
        client as never,
        buildIncrementalStatePayload(hostile.id, EntityState.DEAD)
    );

    assert.equal(
        Number(client.character.missions[String(MissionID.GetGoblinNoserings)]?.currCount ?? 0),
        1,
        'side-quest DoT kills inside dungeons should progress when the enemy enters the kill state'
    );

    await CombatHandler.handleEntityDestroy(client as never, createDestroyEntityPacket(hostile.id));

    assert.equal(
        Number(client.character.missions[String(MissionID.GetGoblinNoserings)]?.currCount ?? 0),
        1,
        'side-quest DoT kills inside dungeons should not count again on destroy'
    );
}

async function testSettleTheDeadProgressesOnCemeteryHillUndeadKills(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.SettleTheDead)]: {
            state: 1,
            currCount: 14
        }
    }, 'CemeteryHill');

    await destroyEnemy(client, 8601, 'Mummy');

    assert.equal(
        Number(client.character.missions[String(MissionID.SettleTheDead)]?.currCount ?? 0),
        15,
        'Settle the Dead should count Cemetery Hill undead kills'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.SettleTheDead)]?.state ?? 0),
        2,
        'Settle the Dead should become ready to turn in after enough undead kills'
    );
    assert.deepEqual(
        client.sentPackets
            .filter((packet) => packet.id === 0x83)
            .map((packet) => decodeMissionProgressPacket(packet.payload)),
        [{ missionId: MissionID.SettleTheDead, progress: 1 }],
        'Settle the Dead should emit additive progress packets for undead kills'
    );
    assert.equal(
        decodeMissionCompletePacket(
            client.sentPackets.find((packet) => packet.id === 0x86)!.payload
        ),
        MissionID.SettleTheDead,
        'Settle the Dead should notify the client when the objective is complete'
    );
}

async function testSettleTheDeadHardProgressesOnCemeteryHillDungeonUndeadKillState(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.SettleTheDeadHard)]: {
            state: 1,
            currCount: 29
        }
    }, 'CH_MiniMission7Hard');
    client.levelInstanceId = 'settle-the-dead-hard-dungeon';

    GlobalState.sessionsByToken.set(client.token, client as never);
    const levelScope = getClientLevelScope(client as never);
    const hostile = {
        id: 8602,
        name: 'InfusedSkeletonRogueHard',
        isPlayer: false,
        team: 2,
        hp: 1,
        entState: 0,
        roomId: 0,
        ownerToken: client.token
    };
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [hostile.id, hostile]
    ]));

    await CombatHandler.handlePowerHit(
        client as never,
        buildPowerHitPayload(hostile.id, client.clientEntID, 5, 77)
    );

    assert.equal(
        Number(client.character.missions[String(MissionID.SettleTheDeadHard)]?.currCount ?? 0),
        29,
        'hard Settle the Dead should wait for the kill state inside Cemetery Hill dungeons'
    );

    await LevelHandler.handleEntityIncrementalUpdate(
        client as never,
        buildIncrementalStatePayload(hostile.id, EntityState.DEAD)
    );

    assert.equal(
        Number(client.character.missions[String(MissionID.SettleTheDeadHard)]?.currCount ?? 0),
        30,
        'hard Settle the Dead should count hard Cemetery Hill undead kill states'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.SettleTheDeadHard)]?.state ?? 0),
        2,
        'hard Settle the Dead should become ready to turn in after enough undead kills'
    );
}

async function testSettleTheDeadIgnoresWispsAndOtherZones(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.SettleTheDead)]: {
            state: 1,
            currCount: 0
        }
    }, 'CemeteryHill');

    await destroyEnemy(client, 8603, 'WispRuby');

    assert.equal(
        Number(client.character.missions[String(MissionID.SettleTheDead)]?.currCount ?? 0),
        0,
        'Settle the Dead should not count Cemetery Hill wisps as risen dead'
    );

    client.currentLevel = 'JadeCity';
    client.character.CurrentLevel = { name: 'JadeCity', x: 0, y: 0 };
    await destroyEnemy(client, 8604, 'Mummy');

    assert.equal(
        Number(client.character.missions[String(MissionID.SettleTheDead)]?.currCount ?? 0),
        0,
        'Settle the Dead should not count undead kills outside Cemetery Hill'
    );
}

async function testCastleLizardProblemProgressesOnCastleLizardKills(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.SpiritProblem)]: {
            state: 1,
            currCount: 28
        }
    }, 'Castle');

    await killEnemyByState(client, 8601, 'SpiritImperialFootman1');
    await killEnemyByState(client, 8602, 'CastleLizard1');
    await killEnemyByState(client, 8603, 'CastleLizardHeavy2');

    assert.equal(
        Number(client.character.missions[String(MissionID.SpiritProblem)]?.currCount ?? 0),
        30,
        'A Lizard Problem should count CastleLizard enemies but ignore other Castle hostiles'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.SpiritProblem)]?.state ?? 0),
        2,
        'A Lizard Problem should become ready to turn in after enough Castle lizards are defeated'
    );
    assert.deepEqual(
        client.sentPackets
            .filter((packet) => packet.id === 0x83)
            .map((packet) => decodeMissionProgressPacket(packet.payload)),
        [
            { missionId: MissionID.SpiritProblem, progress: 1 },
            { missionId: MissionID.SpiritProblem, progress: 1 }
        ],
        'A Lizard Problem should emit additive progress packets for Castle lizard kills'
    );
    assert.equal(
        decodeMissionCompletePacket(
            client.sentPackets.find((packet) => packet.id === 0x86)!.payload
        ),
        MissionID.SpiritProblem,
        'A Lizard Problem should notify the client when the objective is complete'
    );
}

async function testCastleLizardProblemWaitsForKillStateAfterLethalHit(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.SpiritProblem)]: {
            state: 1,
            currCount: 0
        }
    }, 'Castle');
    client.levelInstanceId = 'castle-lizard-delay';

    GlobalState.sessionsByToken.set(client.token, client as never);
    const levelScope = getClientLevelScope(client as never);
    const hostile = {
        id: 8606,
        name: 'CastleLizard1',
        isPlayer: false,
        team: 2,
        hp: 1,
        maxHp: 1,
        entState: 0,
        ownerToken: client.token
    };
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [hostile.id, hostile]
    ]));

    await CombatHandler.handlePowerHit(
        client as never,
        buildPowerHitPayload(hostile.id, client.clientEntID, 5, 77)
    );

    assert.equal(
        Number(client.character.missions[String(MissionID.SpiritProblem)]?.currCount ?? 0),
        0,
        'A Lizard Problem should not progress from the lethal hit before the lizard kill state arrives'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x83 || packet.id === 0x86),
        false,
        'A Lizard Problem should stay silent until the visible Castle lizard kill state'
    );

    await LevelHandler.handleEntityIncrementalUpdate(
        client as never,
        buildIncrementalStatePayload(hostile.id, EntityState.DEAD)
    );

    assert.equal(
        Number(client.character.missions[String(MissionID.SpiritProblem)]?.currCount ?? 0),
        1,
        'A Lizard Problem should progress when the Castle lizard enters the kill state'
    );
    assert.deepEqual(
        client.sentPackets
            .filter((packet) => packet.id === 0x83)
            .map((packet) => decodeMissionProgressPacket(packet.payload)),
        [{ missionId: MissionID.SpiritProblem, progress: 1 }],
        'A Lizard Problem should emit one additive progress packet on kill state'
    );

    await CombatHandler.handleEntityDestroy(client as never, createDestroyEntityPacket(hostile.id));

    assert.equal(
        Number(client.character.missions[String(MissionID.SpiritProblem)]?.currCount ?? 0),
        1,
        'A Lizard Problem should not count the same Castle lizard again on destroy'
    );
}

async function testCastleLizardProblemWaitsForKillStateInsideDungeons(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.SpiritProblem)]: {
            state: 1,
            currCount: 0
        }
    }, 'AC_Mission1');
    client.levelInstanceId = 'castle-lizard-dungeon-delay';

    GlobalState.sessionsByToken.set(client.token, client as never);
    const levelScope = getClientLevelScope(client as never);
    const hostile = {
        id: 8607,
        name: 'CastleLizardHeavy1',
        isPlayer: false,
        team: 2,
        hp: 1,
        maxHp: 1,
        entState: 0,
        ownerToken: client.token
    };
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [hostile.id, hostile]
    ]));

    await CombatHandler.handlePowerHit(
        client as never,
        buildPowerHitPayload(hostile.id, client.clientEntID, 5, 77)
    );

    assert.equal(
        Number(client.character.missions[String(MissionID.SpiritProblem)]?.currCount ?? 0),
        0,
        'A Lizard Problem should not progress inside dungeons from the lethal hit before kill state'
    );

    await LevelHandler.handleEntityIncrementalUpdate(
        client as never,
        buildIncrementalStatePayload(hostile.id, EntityState.DEAD)
    );

    assert.equal(
        Number(client.character.missions[String(MissionID.SpiritProblem)]?.currCount ?? 0),
        1,
        'A Lizard Problem should progress inside dungeons when the Castle lizard enters the kill state'
    );
    assert.deepEqual(
        client.sentPackets
            .filter((packet) => packet.id === 0x83)
            .map((packet) => decodeMissionProgressPacket(packet.payload)),
        [{ missionId: MissionID.SpiritProblem, progress: 1 }],
        'A Lizard Problem should emit one additive dungeon progress packet on kill state'
    );

    await CombatHandler.handleEntityDestroy(client as never, createDestroyEntityPacket(hostile.id));

    assert.equal(
        Number(client.character.missions[String(MissionID.SpiritProblem)]?.currCount ?? 0),
        1,
        'A Lizard Problem should not count the same dungeon Castle lizard again on destroy'
    );
}

async function testHardCastleLizardProblemProgressesOnHardCastleLizardKills(): Promise<void> {
    resetGlobalState();
    const client = createClient({
        [String(MissionID.SpiritProblemHard)]: {
            state: 1,
            currCount: 59
        }
    }, 'CastleHard');

    await killEnemyByState(client, 8604, 'SpiritImperialFootman1Hard');
    await killEnemyByState(client, 8605, 'CastleLizardCarnisaur1Hard');

    assert.equal(
        Number(client.character.missions[String(MissionID.SpiritProblemHard)]?.currCount ?? 0),
        60,
        'Hard A Lizard Problem should count hard CastleLizard enemies but ignore other CastleHard hostiles'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.SpiritProblemHard)]?.state ?? 0),
        2,
        'Hard A Lizard Problem should become ready to turn in after enough hard Castle lizards are defeated'
    );
    assert.deepEqual(
        client.sentPackets
            .filter((packet) => packet.id === 0x83)
            .map((packet) => decodeMissionProgressPacket(packet.payload)),
        [{ missionId: MissionID.SpiritProblemHard, progress: 1 }],
        'Hard A Lizard Problem should emit additive progress packets for hard Castle lizard kills'
    );
    assert.equal(
        decodeMissionCompletePacket(
            client.sentPackets.find((packet) => packet.id === 0x86)!.payload
        ),
        MissionID.SpiritProblemHard,
        'Hard A Lizard Problem should notify the client when the objective is complete'
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
    await testGetSpiderFangsProgressesOnSwampSpiderKills();
    await testBannersOfTheTuataraProgressesOnLizardBannerKills();
    await testHardBannersOfTheTuataraProgressesOnLizardBannerKills();
    await testTuataraGreatHelmsProgressesOnLizardHeavyKills();
    await testHardTuataraGreatHelmsProgressesOnLizardHeavyKills();
    await testDevourerTeethProgressesFromDevourerRealmKills();
    await testHardDevourerTeethProgressesFromDevourerRealmKills();
    await testLaterSideQuestCollectiblesProgressFromEnemyRealms();
    await testStormshardSideQuestKillsProgressFromExplicitTargets();
    await testSideQuestEnemyKillsProgressInsideDungeonsOnDeadStateOnlyOnce();
    await testSideQuestDotKillsProgressInsideDungeonsOnDeadStateOnlyOnce();
    await testSettleTheDeadProgressesOnCemeteryHillUndeadKills();
    await testSettleTheDeadHardProgressesOnCemeteryHillDungeonUndeadKillState();
    await testSettleTheDeadIgnoresWispsAndOtherZones();
    await testCastleLizardProblemProgressesOnCastleLizardKills();
    await testCastleLizardProblemWaitsForKillStateAfterLethalHit();
    await testCastleLizardProblemWaitsForKillStateInsideDungeons();
    await testHardCastleLizardProblemProgressesOnHardCastleLizardKills();
    console.log('mission_kill_progress_regression: ok');
}

void main().catch((error) => {
    console.error('mission_kill_progress_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
