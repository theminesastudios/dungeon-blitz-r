import { strict as assert } from 'assert';
import * as path from 'path';
import {
    noteDungeonRunCast,
    noteDungeonRunChestOpened,
    noteDungeonRunEntitySeen,
    noteDungeonRunHit,
    noteDungeonRunKill,
    syncClientDungeonRunState
} from '../core/DungeonRunStats';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { getSharedDungeonProgressState } from '../core/SharedDungeonProgress';
import { CombatHandler } from '../handlers/CombatHandler';
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
    userId: number | null;
    playerSpawned: boolean;
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    clientEntID: number;
    character: {
        name: string;
        level: number;
        CurrentLevel: { name: string; x: number; y: number };
        PreviousLevel: { name: string; x: number; y: number };
        missions: Record<string, { state: number; currCount?: number }>;
        questTrackerState: number;
    };
    characters: any[];
    entities: Map<number, any>;
    dungeonRun: any;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureLevelConfigLoaded(): void {
    if (!LevelConfig.has('GoblinRiverDungeon')) {
        LevelConfig.load(path.resolve(__dirname, '../data'));
    }
    if (!GameData.getEntType('GoblinClub')) {
        GameData.load(path.resolve(__dirname, '../data'));
    }
}

function createClient(token: number, name: string, levelName: string = 'GoblinRiverDungeon'): FakeClient {
    const sentPackets: SentPacket[] = [];
    const levelInstanceId = levelName === 'GoblinRiverDungeon'
        ? 'goblin-shared'
        : levelName === 'GoblinRiverDungeonHard'
            ? 'goblin-hard-shared'
            : `${levelName.toLowerCase()}-shared`;
    const character = {
        name,
        level: 10,
        CurrentLevel: { name: levelName, x: 0, y: 0 },
        PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 },
        missions: {},
        questTrackerState: 0
    };

    return {
        token,
        userId: token,
        playerSpawned: true,
        currentLevel: levelName,
        levelInstanceId,
        currentRoomId: 1,
        clientEntID: token + 9000,
        character,
        characters: [character],
        entities: new Map<number, any>(),
        dungeonRun: null,
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createQuestProgressPacket(progress: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(progress);
    return bb.toBuffer();
}

function createLevelCompletePacket(progress: number = 100, remainingKills: number = 0, requiredKills: number = 1): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(progress);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(remainingKills);
    bb.writeMethod9(requiredKills);
    bb.writeMethod9(3);
    return bb.toBuffer();
}

function parseQuestProgress(payload: Buffer): number {
    const br = new BitReader(payload);
    return br.readMethod4();
}

function parseDungeonComplete(payload: Buffer): {
    stars: number;
    resultBar: number;
    rank: number;
    kills: number;
    accuracy: number;
    deaths: number;
    treasure: number;
    timeBonus: number;
} {
    const br = new BitReader(payload);
    return {
        stars: br.readMethod6(4),
        resultBar: br.readMethod4(),
        rank: br.readMethod4(),
        kills: br.readMethod4(),
        accuracy: br.readMethod4(),
        deaths: br.readMethod4(),
        treasure: br.readMethod4(),
        timeBonus: br.readMethod4()
    };
}

function buildPowerCastPayload(sourceId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(sourceId);
    bb.writeMethod4(1703);
    bb.writeMethod15(true);
    bb.writeMethod15(true);
    bb.writeMethod24(100);
    bb.writeMethod24(100);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function assertDungeonCompleteMatchesTracker(client: FakeClient, payload: Buffer): void {
    const result = parseDungeonComplete(payload);
    const summary = client.dungeonRun?.finalizedStats?.scoreSummary;
    assert.ok(summary, 'shared-progress completion should finalize tracker score summary');
    assert.equal(result.kills, summary.finalStat.kills, 'kill score should come from the authoritative tracker');
    assert.equal(result.accuracy, summary.finalStat.accuracy, 'accuracy should come from the authoritative tracker');
    assert.equal(result.deaths, summary.finalStat.deaths, 'death score should come from the authoritative tracker');
    assert.equal(result.treasure, summary.finalStat.treasure, 'treasure score should come from the authoritative tracker');
    assert.equal(result.timeBonus, summary.finalStat.timeBonus, 'time bonus should come from the authoritative tracker');
}

function setPartyLeader(leader: FakeClient, ...members: FakeClient[]): void {
    const partyId = 77;
    const names = [leader, ...members].map((client) => client.character.name);
    GlobalState.partyGroups.set(partyId, {
        id: partyId,
        leader: leader.character.name,
        members: names,
        locked: false
    });
    for (const client of [leader, ...members]) {
        GlobalState.partyByMember.set(client.character.name.toLowerCase(), partyId);
    }
}

async function testGoblinRiverQuestProgressStaysIncompleteBeforeHostilesExist(): Promise<void> {
    const solo = createClient(800, 'Solo');

    GlobalState.sessionsByToken.set(solo.token, solo as never);

    await LevelHandler.handleQuestProgressUpdate(solo as never, createQuestProgressPacket(100));

    assert.equal(solo.character.questTrackerState, 11, 'dungeon progress should start at the Goblin River intro baseline before any shared hostile authority exists');
    assert.deepEqual(
        solo.sentPackets.filter((packet) => packet.id === 0xB7).map((packet) => parseQuestProgress(packet.payload)),
        [11],
        'the server should keep the client at the Goblin River intro baseline until shared dungeon hostiles exist'
    );

    await MissionHandler.handleSetLevelComplete(solo as never, createLevelCompletePacket());

    assert.equal(
        solo.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'the dungeon should not complete before shared dungeon authority and progress are established'
    );
}

async function testGoblinRiverQuestProgressFollowsHostileOwnerAuthority(): Promise<void> {
    const authority = createClient(801, 'Leader');
    const joiner = createClient(802, 'Member');

    GlobalState.sessionsByToken.set(authority.token, authority as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    setPartyLeader(authority, joiner);
    GlobalState.levelEntities.set('GoblinRiverDungeon#goblin-shared', new Map<number, any>([
        [
            5001,
            {
                id: 5001,
                name: 'GoblinClub',
                isPlayer: false,
                team: 2,
                entState: 0,
                hp: 100,
                clientSpawned: true,
                ownerToken: authority.token,
                ownerPartyId: 77,
                roomId: 1
            }
        ],
        [
            5002,
            {
                id: 5002,
                name: 'GoblinDagger',
                isPlayer: false,
                team: 2,
                entState: 6,
                hp: 0,
                dead: true,
                clientSpawned: true,
                ownerToken: authority.token,
                ownerPartyId: 77,
                roomId: 1
            }
        ]
    ]));

    await LevelHandler.handleQuestProgressUpdate(joiner as never, createQuestProgressPacket(100));

    assert.equal(joiner.character.questTrackerState, 56, 'joiner progress should be recomputed from the server hostile state on top of the Goblin River intro baseline');
    assert.equal(authority.character.questTrackerState, 56, 'leader progress should follow the same shared server-computed baseline-adjusted state');
    assert.deepEqual(
        joiner.sentPackets.filter((packet) => packet.id === 0xB7).map((packet) => parseQuestProgress(packet.payload)),
        [56],
        'joiner should be corrected to the shared server-computed progress'
    );
}

async function testGoblinRiverLevelCompleteWaitsForSharedProgressCompletion(): Promise<void> {
    const authority = createClient(811, 'Leader');
    const joiner = createClient(812, 'Member');

    GlobalState.sessionsByToken.set(authority.token, authority as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    setPartyLeader(authority, joiner);
    GlobalState.levelEntities.set('GoblinRiverDungeon#goblin-shared', new Map<number, any>([
        [
            5101,
            {
                id: 5101,
                name: 'GoblinArmorAxe',
                isPlayer: false,
                team: 2,
                entState: 0,
                hp: 100,
                clientSpawned: true,
                ownerToken: authority.token,
                ownerPartyId: 77,
                roomId: 1
            }
        ]
    ]));

    await MissionHandler.handleSetLevelComplete(joiner as never, createLevelCompletePacket());

    assert.equal(
        joiner.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'joiner should not complete the dungeon while server-computed progress is incomplete'
    );

    await LevelHandler.handleQuestProgressUpdate(joiner as never, createQuestProgressPacket(100));
    assert.equal(joiner.character.questTrackerState, 11, 'joiner false completion should still stay at the Goblin River intro baseline before the server sees the hostile die');

    const hostile = GlobalState.levelEntities.get('GoblinRiverDungeon#goblin-shared')?.get(5101);
    assert.ok(hostile, 'canonical hostile should exist');
    hostile.hp = 0;
    hostile.dead = true;
    hostile.entState = 6;

    LevelHandler.refreshSharedDungeonQuestProgress('GoblinRiverDungeon#goblin-shared');
    await MissionHandler.handleSetLevelComplete(authority as never, createLevelCompletePacket());

    assert.equal(
        authority.sentPackets.some((packet) => packet.id === 0x87),
        true,
        'leader should complete the dungeon once server-computed shared progress reaches 100%'
    );
    assert.deepEqual(
        joiner.sentPackets.filter((packet) => packet.id === 0xB7).map((packet) => parseQuestProgress(packet.payload)).slice(-1),
        [100],
        'joiner should receive the shared server-computed 100% progress before completion'
    );
}

async function testGoblinRiverFinalPacketUsesTrackerSummaryWithoutFallbackStats(): Promise<void> {
    const authority = createClient(821, 'Leader');
    const levelScope = 'GoblinRiverDungeon#goblin-shared';
    const hostileAlive = {
        id: 5201,
        name: 'GoblinClub',
        isPlayer: false,
        team: 2,
        entState: 0,
        hp: 100,
        clientSpawned: true,
        ownerToken: authority.token,
        roomId: 1
    };
    const hostileDead = {
        ...hostileAlive,
        hp: 0,
        dead: true,
        entState: 6
    };

    GlobalState.sessionsByToken.set(authority.token, authority as never);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [hostileAlive.id, { ...hostileAlive }]
    ]));

    syncClientDungeonRunState(authority as never);
    authority.entities.set(hostileAlive.id, { ...hostileAlive });
    noteDungeonRunEntitySeen(authority as never, hostileAlive.id, hostileAlive);
    noteDungeonRunCast(authority as never, {
        sourceId: authority.clientEntID,
        projectileId: null,
        isPersistent: false
    });

    authority.entities.set(hostileDead.id, { ...hostileDead });
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [hostileDead.id, { ...hostileDead }]
    ]));
    noteDungeonRunKill(getClientLevelScope(authority as never), [authority.character.name], hostileDead.id, hostileDead);

    LevelHandler.refreshSharedDungeonQuestProgress(levelScope);
    const sharedState = getSharedDungeonProgressState(levelScope);
    assert.equal(
        sharedState?.liveStatsByCharacter?.get('leader')?.totalScore,
        authority.dungeonRun.scoreSummary.finalStat.total,
        'shared dungeon progress should keep a live tracker snapshot alongside percent progress'
    );
    await MissionHandler.handleSetLevelComplete(authority as never, createLevelCompletePacket(100, 0, 1));

    const resultPacket = authority.sentPackets.find((packet) => packet.id === 0x87);
    assert.ok(resultPacket, 'shared-progress dungeon completion should still send 0x87');
    assertDungeonCompleteMatchesTracker(authority, resultPacket!.payload);

    const result = parseDungeonComplete(resultPacket!.payload);
    assert.equal(
        result.accuracy,
        authority.dungeonRun.finalizedStats!.scoreSummary.unlockedCap.accuracy,
        'Wolf\'s End full clears should clamp accuracy to the max bucket instead of relying on legacy fallback values'
    );
    assert.notEqual(result.accuracy, 50, 'accuracy should not fall back to the legacy default');
}

async function testGoblinRiverFullClearMaxesTrackedStats(
    levelName: 'GoblinRiverDungeon' | 'GoblinRiverDungeonHard',
    elapsedMs: number = 0,
    packetProgress: number = 100
): Promise<{ totalScore: number; rank: number; timeBonus: number }> {
    const authority = createClient(830, 'Leader', levelName);
    const levelScope = getClientLevelScope(authority as never);
    const hostileA = {
        id: 5301,
        name: 'GoblinClub',
        isPlayer: false,
        team: 2,
        entState: 0,
        hp: 100,
        clientSpawned: true,
        ownerToken: authority.token,
        roomId: 1
    };
    const hostileB = {
        ...hostileA,
        id: 5302,
        name: 'GoblinDagger'
    };
    const chest = {
        id: 5303,
        name: 'TreasureChestEmpty',
        isPlayer: false,
        team: 0,
        entState: 0,
        hp: 1,
        clientSpawned: true,
        ownerToken: authority.token,
        roomId: 1
    };

    GlobalState.sessionsByToken.set(authority.token, authority as never);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [hostileA.id, { ...hostileA }],
        [hostileB.id, { ...hostileB }],
        [chest.id, { ...chest }]
    ]));

    syncClientDungeonRunState(authority as never);
    if (elapsedMs > 0) {
        const runStart = Date.now() - elapsedMs;
        authority.dungeonRun.entryStartTime = runStart;
        authority.dungeonRun.runStartTime = runStart;
        authority.dungeonRun.entryAccumulator.startTime = runStart;
    }
    authority.entities.set(hostileA.id, { ...hostileA });
    authority.entities.set(hostileB.id, { ...hostileB });
    authority.entities.set(chest.id, { ...chest });
    noteDungeonRunEntitySeen(authority as never, hostileA.id, hostileA);
    noteDungeonRunEntitySeen(authority as never, hostileB.id, hostileB);
    noteDungeonRunEntitySeen(authority as never, chest.id, chest);

    noteDungeonRunCast(authority as never, {
        sourceId: authority.clientEntID,
        hasTargetPos: true,
        projectileId: null,
        isPersistent: false
    });
    noteDungeonRunHit(authority as never, {
        sourceId: authority.clientEntID,
        targetId: hostileA.id,
        targetEntity: hostileA,
        damage: 25
    });

    const hostileADead = { ...hostileA, hp: 0, dead: true, entState: 6 };
    const hostileBDead = { ...hostileB, hp: 0, dead: true, entState: 6 };
    authority.entities.set(hostileA.id, hostileADead);
    authority.entities.set(hostileB.id, hostileBDead);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [hostileA.id, hostileADead],
        [hostileB.id, hostileBDead],
        [chest.id, { ...chest }]
    ]));
    noteDungeonRunKill(levelScope, [authority.character.name], hostileADead.id, hostileADead);

    noteDungeonRunCast(authority as never, {
        sourceId: authority.clientEntID,
        hasTargetPos: true,
        projectileId: null,
        isPersistent: false
    });
    noteDungeonRunHit(authority as never, {
        sourceId: authority.clientEntID,
        targetId: hostileB.id,
        targetEntity: hostileB,
        damage: 25
    });
    noteDungeonRunKill(levelScope, [authority.character.name], hostileBDead.id, hostileBDead);
    noteDungeonRunChestOpened(authority as never, chest.id, chest);

    LevelHandler.refreshSharedDungeonQuestProgress(levelScope);
    await MissionHandler.handleSetLevelComplete(authority as never, createLevelCompletePacket(packetProgress, 0, 2));

    const resultPacket = authority.sentPackets.find((packet) => packet.id === 0x87);
    assert.ok(resultPacket, `${levelName} should send the dungeon completion packet`);
    assertDungeonCompleteMatchesTracker(authority, resultPacket!.payload);

    const result = parseDungeonComplete(resultPacket!.payload);
    const unlockedCap = authority.dungeonRun.finalizedStats!.scoreSummary.unlockedCap;
    assert.equal(result.kills, unlockedCap.kills, `${levelName} full clear should max kills`);
    assert.equal(result.accuracy, unlockedCap.accuracy, `${levelName} full clear without misses should max accuracy`);
    assert.equal(result.treasure, unlockedCap.treasure, `${levelName} full clear with all chests should max treasure`);
    assert.equal(result.deaths, unlockedCap.deaths, `${levelName} full clear should max deaths as part of the full-clear override`);
    return {
        totalScore: authority.dungeonRun.finalizedStats!.scoreSummary.finalStat.total,
        rank: result.rank,
        timeBonus: result.timeBonus
    };
}

async function testGoblinRiverSharedProgressOverridesLowCompletionPacket(): Promise<void> {
    const result = await testGoblinRiverFullClearMaxesTrackedStats('GoblinRiverDungeon', 0, 99);
    assert.equal(result.totalScore > 0, true, 'shared-progress Wolf\'s End completions should still finalize when the packet progress lags behind the canonical progress');
}

async function testGoblinKidnappersAliasFullClearStillMaxesTrackedStats(): Promise<void> {
    const authority = createClient(835, 'Leader', 'GoblinKidnappers');
    const levelScope = getClientLevelScope(authority as never);
    const hostileA = {
        id: 5311,
        name: 'GoblinClub',
        isPlayer: false,
        team: 2,
        entState: 0,
        hp: 100,
        clientSpawned: true,
        ownerToken: authority.token,
        roomId: 1
    };
    const hostileB = {
        ...hostileA,
        id: 5312,
        name: 'GoblinDagger'
    };
    const chest = {
        id: 5313,
        name: 'TreasureChestEmpty',
        isPlayer: false,
        team: 0,
        entState: 0,
        hp: 1,
        clientSpawned: true,
        ownerToken: authority.token,
        roomId: 1
    };

    GlobalState.sessionsByToken.set(authority.token, authority as never);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [hostileA.id, { ...hostileA }],
        [hostileB.id, { ...hostileB }],
        [chest.id, { ...chest }]
    ]));

    syncClientDungeonRunState(authority as never);
    authority.entities.set(hostileA.id, { ...hostileA });
    authority.entities.set(hostileB.id, { ...hostileB });
    authority.entities.set(chest.id, { ...chest });
    noteDungeonRunEntitySeen(authority as never, hostileA.id, hostileA);
    noteDungeonRunEntitySeen(authority as never, hostileB.id, hostileB);
    noteDungeonRunEntitySeen(authority as never, chest.id, chest);

    noteDungeonRunCast(authority as never, {
        sourceId: authority.clientEntID,
        hasTargetPos: true,
        projectileId: null,
        isPersistent: false
    });
    noteDungeonRunHit(authority as never, {
        sourceId: authority.clientEntID,
        targetId: hostileA.id,
        targetEntity: hostileA,
        damage: 25
    });

    const hostileADead = { ...hostileA, hp: 0, dead: true, entState: 6 };
    const hostileBDead = { ...hostileB, hp: 0, dead: true, entState: 6 };
    authority.entities.set(hostileA.id, hostileADead);
    authority.entities.set(hostileB.id, hostileBDead);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [hostileA.id, hostileADead],
        [hostileB.id, hostileBDead],
        [chest.id, { ...chest }]
    ]));
    noteDungeonRunKill(levelScope, [authority.character.name], hostileADead.id, hostileADead);
    noteDungeonRunCast(authority as never, {
        sourceId: authority.clientEntID,
        hasTargetPos: true,
        projectileId: null,
        isPersistent: false
    });
    noteDungeonRunHit(authority as never, {
        sourceId: authority.clientEntID,
        targetId: hostileB.id,
        targetEntity: hostileB,
        damage: 25
    });
    noteDungeonRunKill(levelScope, [authority.character.name], hostileBDead.id, hostileBDead);
    noteDungeonRunChestOpened(authority as never, chest.id, chest);

    LevelHandler.refreshSharedDungeonQuestProgress(levelScope);
    await MissionHandler.handleSetLevelComplete(authority as never, createLevelCompletePacket(100, 0, 2));

    const resultPacket = authority.sentPackets.find((packet) => packet.id === 0x87);
    assert.ok(resultPacket, 'Goblin Kidnappers alias full clear should send the dungeon completion packet');
    assertDungeonCompleteMatchesTracker(authority, resultPacket!.payload);

    const result = parseDungeonComplete(resultPacket!.payload);
    const unlockedCap = authority.dungeonRun.finalizedStats!.scoreSummary.unlockedCap;
    assert.equal(result.kills, unlockedCap.kills, 'Goblin Kidnappers alias full clear should max kills');
    assert.equal(result.accuracy, unlockedCap.accuracy, 'Goblin Kidnappers alias full clear should max accuracy');
    assert.equal(result.treasure, unlockedCap.treasure, 'Goblin Kidnappers alias full clear should max treasure');
}

async function testGoblinRiverFullClearMissClickStillMaxesAccuracy(): Promise<void> {
    const authority = createClient(840, 'Leader');
    const levelScope = getClientLevelScope(authority as never);
    const hostile = {
        id: 5401,
        name: 'GoblinClub',
        isPlayer: false,
        team: 2,
        entState: 0,
        hp: 100,
        clientSpawned: true,
        ownerToken: authority.token,
        roomId: 1
    };

    GlobalState.sessionsByToken.set(authority.token, authority as never);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [hostile.id, { ...hostile }]
    ]));

    syncClientDungeonRunState(authority as never);
    authority.entities.set(hostile.id, { ...hostile });
    noteDungeonRunEntitySeen(authority as never, hostile.id, hostile);

    noteDungeonRunCast(authority as never, {
        sourceId: authority.clientEntID,
        hasTargetPos: true,
        projectileId: null,
        isPersistent: false
    });

    noteDungeonRunCast(authority as never, {
        sourceId: authority.clientEntID,
        hasTargetPos: true,
        projectileId: null,
        isPersistent: false
    });
    assert.equal(
        authority.dungeonRun.missedShots,
        1,
        'a second unresolved valid attack should immediately mark the previous attempt as a miss for live accuracy'
    );
    noteDungeonRunHit(authority as never, {
        sourceId: authority.clientEntID,
        targetId: hostile.id,
        targetEntity: hostile,
        damage: 25
    });

    const hostileDead = { ...hostile, hp: 0, dead: true, entState: 6 };
    authority.entities.set(hostile.id, hostileDead);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [hostile.id, hostileDead]
    ]));
    noteDungeonRunKill(levelScope, [authority.character.name], hostileDead.id, hostileDead);

    LevelHandler.refreshSharedDungeonQuestProgress(levelScope);
    await MissionHandler.handleSetLevelComplete(authority as never, createLevelCompletePacket(100, 0, 1));

    const resultPacket = authority.sentPackets.find((packet) => packet.id === 0x87);
    assert.ok(resultPacket, 'Goblin River miss-click scenario should complete');
    const result = parseDungeonComplete(resultPacket!.payload);
    const unlockedCap = authority.dungeonRun.finalizedStats!.scoreSummary.unlockedCap;
    assert.equal(result.accuracy, unlockedCap.accuracy, 'Wolf\'s End full clear should clamp accuracy to max even if the run had a miss click');
}

async function testGoblinRiverBossIntroLockSuppressesFalseMiss(): Promise<void> {
    const authority = createClient(850, 'Leader');
    const levelScope = getClientLevelScope(authority as never);
    const hostile = {
        id: 5501,
        name: 'GoblinShamanHood',
        isPlayer: false,
        team: 2,
        entState: 0,
        hp: 100,
        clientSpawned: true,
        ownerToken: authority.token,
        roomId: 1,
        untargetable: true
    };

    GlobalState.sessionsByToken.set(authority.token, authority as never);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [hostile.id, { ...hostile }]
    ]));

    syncClientDungeonRunState(authority as never);
    authority.entities.set(hostile.id, { ...hostile });
    noteDungeonRunEntitySeen(authority as never, hostile.id, hostile);

    (authority as any).goblinRiverBossIntroLockUntil = Date.now() + 10_000;
    await CombatHandler.handlePowerCast(authority as never, buildPowerCastPayload(authority.clientEntID));
    (authority as any).goblinRiverBossIntroLockUntil = 0;

    const activeHostile = { ...hostile, untargetable: false };
    authority.entities.set(hostile.id, activeHostile);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [hostile.id, activeHostile]
    ]));

    noteDungeonRunCast(authority as never, {
        sourceId: authority.clientEntID,
        hasTargetPos: true,
        projectileId: null,
        isPersistent: false
    });
    noteDungeonRunHit(authority as never, {
        sourceId: authority.clientEntID,
        targetId: hostile.id,
        targetEntity: activeHostile,
        damage: 25
    });

    const hostileDead = { ...activeHostile, hp: 0, dead: true, entState: 6 };
    authority.entities.set(hostile.id, hostileDead);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [hostile.id, hostileDead]
    ]));
    noteDungeonRunKill(levelScope, [authority.character.name], hostileDead.id, hostileDead);

    LevelHandler.refreshSharedDungeonQuestProgress(levelScope);
    await MissionHandler.handleSetLevelComplete(authority as never, createLevelCompletePacket(100, 0, 1));

    const resultPacket = authority.sentPackets.find((packet) => packet.id === 0x87);
    assert.ok(resultPacket, 'Goblin River boss intro lock scenario should complete');
    const result = parseDungeonComplete(resultPacket!.payload);
    const unlockedCap = authority.dungeonRun.finalizedStats!.scoreSummary.unlockedCap;
    assert.equal(result.accuracy, unlockedCap.accuracy, 'casts dropped during the boss intro lock should not turn into false misses');
}

async function testGoblinRiverFullClearLeavesTimeBonusAsPrimaryVariable(): Promise<void> {
    const fast = await testGoblinRiverFullClearMaxesTrackedStats('GoblinRiverDungeon', 60_000);

    GlobalState.levelEntities.clear();
    GlobalState.sessionsByToken.clear();
    GlobalState.levelQuestProgress.clear();
    GlobalState.partyByMember.clear();
    GlobalState.partyGroups.clear();

    const slow = await testGoblinRiverFullClearMaxesTrackedStats('GoblinRiverDungeon', 600_000);
    assert.equal(fast.timeBonus > slow.timeBonus, true, 'slower Wolf\'s End full clears should lose time bonus');
    assert.equal(fast.totalScore > slow.totalScore, true, 'with other buckets maxed, total score should fall only through time bonus');
    assert.equal(fast.rank <= slow.rank, true, 'slower Wolf\'s End full clears should not rank better than faster clears');
}

async function testGoblinRiverCompletionProgressFullClearOverridesIncompleteObservedKills(): Promise<void> {
    const authority = createClient(860, 'Leader');
    const levelScope = getClientLevelScope(authority as never);
    const hostileSeen = {
        id: 5601,
        name: 'GoblinClub',
        isPlayer: false,
        team: 2,
        entState: 6,
        hp: 0,
        dead: true,
        clientSpawned: true,
        ownerToken: authority.token,
        roomId: 1
    };

    GlobalState.sessionsByToken.set(authority.token, authority as never);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [hostileSeen.id, { ...hostileSeen }]
    ]));
    syncClientDungeonRunState(authority as never);
    authority.entities.set(hostileSeen.id, { ...hostileSeen });
    noteDungeonRunEntitySeen(authority as never, hostileSeen.id, hostileSeen);
    authority.dungeonRun.windowAccumulator.eligibleEnemyIds = new Set<number>([hostileSeen.id, 999999]);
    authority.dungeonRun.windowAccumulator.killedEnemyIds = new Set<number>([hostileSeen.id]);
    authority.dungeonRun.windowAccumulator.totalEnemiesEligible = 2;
    authority.dungeonRun.windowAccumulator.killedEnemies = 1;
    authority.dungeonRun.windowAccumulator.skippedEnemies = 1;

    await MissionHandler.handleSetLevelComplete(authority as never, createLevelCompletePacket(100, 0, 2));

    const resultPacket = authority.sentPackets.find((packet) => packet.id === 0x87);
    assert.ok(resultPacket, 'completion-progress-driven Wolf\'s End full clear should send 0x87');
    const result = parseDungeonComplete(resultPacket!.payload);
    const unlockedCap = authority.dungeonRun.finalizedStats!.scoreSummary.unlockedCap;
    assert.equal(result.kills, unlockedCap.kills, 'Wolf\'s End full clear should max kills from completion progress even if observed kill tracking was incomplete');
}

async function testDreamDragonSharedProgressBlocksBossOnlyCompletionUntilFullClear(): Promise<void> {
    const authority = createClient(870, 'Leader', 'DreamDragonDungeon');
    const levelScope = getClientLevelScope(authority as never);
    const preBossHostile = {
        id: 5701,
        name: 'GhostMinion',
        isPlayer: false,
        team: 2,
        entState: 0,
        hp: 100,
        clientSpawned: true,
        ownerToken: authority.token,
        roomId: 1
    };
    const boss = {
        id: 5702,
        name: 'DreamDragon',
        isPlayer: false,
        team: 2,
        entRank: 'Boss',
        entState: 0,
        hp: 100,
        clientSpawned: true,
        ownerToken: authority.token,
        roomId: 2
    };

    GlobalState.sessionsByToken.set(authority.token, authority as never);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [preBossHostile.id, { ...preBossHostile }],
        [boss.id, { ...boss }]
    ]));
    syncClientDungeonRunState(authority as never);
    authority.entities.set(preBossHostile.id, { ...preBossHostile });
    authority.entities.set(boss.id, { ...boss });
    noteDungeonRunEntitySeen(authority as never, preBossHostile.id, preBossHostile);
    noteDungeonRunEntitySeen(authority as never, boss.id, boss);

    const bossDead = { ...boss, hp: 0, dead: true, entState: 6 };
    authority.entities.set(boss.id, bossDead);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [preBossHostile.id, { ...preBossHostile }],
        [boss.id, bossDead]
    ]));
    noteDungeonRunKill(levelScope, [authority.character.name], bossDead.id, bossDead);

    LevelHandler.refreshSharedDungeonQuestProgress(levelScope);
    const partialSharedState = getSharedDungeonProgressState(levelScope);
    assert.equal(partialSharedState?.progress, 50, 'Dream Dragon shared progress should stay below 100 until all tracked hostiles are defeated');

    await MissionHandler.handleSetLevelComplete(authority as never, createLevelCompletePacket(100, 0, 2));
    assert.equal(
        authority.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'Dream Dragon boss-only completion should not finalize while shared progress still shows skipped enemies'
    );

    const preBossHostileDead = { ...preBossHostile, hp: 0, dead: true, entState: 6 };
    authority.entities.set(preBossHostile.id, preBossHostileDead);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [preBossHostile.id, preBossHostileDead],
        [boss.id, bossDead]
    ]));
    noteDungeonRunKill(levelScope, [authority.character.name], preBossHostileDead.id, preBossHostileDead);

    LevelHandler.refreshSharedDungeonQuestProgress(levelScope);
    const finalSharedState = getSharedDungeonProgressState(levelScope);
    assert.equal(finalSharedState?.progress, 100, 'Dream Dragon shared progress should reach 100 after the dungeon is fully cleared');

    await MissionHandler.handleSetLevelComplete(authority as never, createLevelCompletePacket(100, 0, 2));
    const resultPacket = authority.sentPackets.find((packet) => packet.id === 0x87);
    assert.ok(resultPacket, 'Dream Dragon full clear should complete once the shared progress reaches 100');
    assertDungeonCompleteMatchesTracker(authority, resultPacket!.payload);
}

async function main(): Promise<void> {
    ensureLevelConfigLoaded();

    const levelEntities = new Map(GlobalState.levelEntities);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const levelQuestProgress = new Map(GlobalState.levelQuestProgress);
    const partyByMember = new Map(GlobalState.partyByMember);
    const partyGroups = new Map(GlobalState.partyGroups);
    GlobalState.levelEntities.clear();
    GlobalState.sessionsByToken.clear();
    GlobalState.levelQuestProgress.clear();
    GlobalState.partyByMember.clear();
    GlobalState.partyGroups.clear();

    try {
        await testGoblinRiverQuestProgressStaysIncompleteBeforeHostilesExist();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverQuestProgressFollowsHostileOwnerAuthority();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverLevelCompleteWaitsForSharedProgressCompletion();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverFinalPacketUsesTrackerSummaryWithoutFallbackStats();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverFullClearMaxesTrackedStats('GoblinRiverDungeon');

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverFullClearMaxesTrackedStats('GoblinRiverDungeonHard');

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverSharedProgressOverridesLowCompletionPacket();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinKidnappersAliasFullClearStillMaxesTrackedStats();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverFullClearMissClickStillMaxesAccuracy();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverBossIntroLockSuppressesFalseMiss();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverFullClearLeavesTimeBonusAsPrimaryVariable();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverCompletionProgressFullClearOverridesIncompleteObservedKills();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testDreamDragonSharedProgressBlocksBossOnlyCompletionUntilFullClear();
    } finally {
        GlobalState.levelEntities = levelEntities;
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.levelQuestProgress = levelQuestProgress;
        GlobalState.partyByMember = partyByMember;
        GlobalState.partyGroups = partyGroups;
    }

    console.log('shared_dungeon_progress_regression: ok');
}

void main().catch((error) => {
    console.error('shared_dungeon_progress_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
