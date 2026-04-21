import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { NpcLoader } from '../data/NpcLoader';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { CombatHandler } from '../handlers/CombatHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

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
    forcedDungeonCompletionScope: string;
    knownEntityIds: Set<number>;
    character: {
        name: string;
        level: number;
        xp?: number;
        gold?: number;
        CurrentLevel: { name: string; x: number; y: number };
        PreviousLevel: { name: string; x: number; y: number };
        missions: Record<string, { state: number; currCount?: number; claimed?: number; complete?: number }>;
        questTrackerState: number;
    };
    characters: any[];
    entities: Map<number, any>;
    dungeonRun: any;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('GoblinRiverDungeon') || !LevelConfig.has('GhostBossDungeon')) {
        LevelConfig.load(dataDir);
    }
    if (!GameData.getEntType('GoblinBoss2') || !GameData.getEntType('NephitLargeEye')) {
        GameData.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.GoblinRiver) || !MissionLoader.getMissionDef(MissionID.KillNephit)) {
        MissionLoader.load(dataDir);
    }
    if (!NpcLoader.getNpcsForLevel('GoblinRiverDungeon').length) {
        NpcLoader.load(dataDir);
    }
}

function createClient(levelName: string, missionId: MissionID, characterName: string): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = {
        name: characterName,
        level: 5,
        xp: 0,
        gold: 0,
        CurrentLevel: { name: levelName, x: 0, y: 0 },
        PreviousLevel: { name: 'NewbieRoad', x: 12509, y: 2299 },
        missions: {
            [String(missionId)]: {
                state: 1,
                currCount: 0
            }
        },
        questTrackerState: 7
    };

    return {
        token: 9301,
        userId: null,
        playerSpawned: true,
        currentLevel: levelName,
        levelInstanceId: `${levelName}-boss-complete`,
        currentRoomId: 1,
        clientEntID: 19301,
        forcedDungeonCompletionScope: '',
        knownEntityIds: new Set<number>(),
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

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

async function testGoblinRiverBossKillForcesDungeonCompleteScreen(): Promise<void> {
    const client = createClient('GoblinRiverDungeon', MissionID.GoblinRiver, 'GoblinBossTester');
    const levelScope = `${client.currentLevel}#${client.levelInstanceId}`;
    const remainingHostile = {
        id: 6401,
        name: 'GoblinClub',
        isPlayer: false,
        team: 2,
        entState: 0,
        hp: 10,
        clientSpawned: true,
        ownerToken: client.token,
        roomId: 1
    };
    const boss = {
        id: 6402,
        name: 'GoblinBoss2',
        isPlayer: false,
        team: 2,
        entRank: 'Boss',
        entState: 6,
        hp: 0,
        dead: true,
        clientSpawned: true,
        ownerToken: client.token,
        roomId: 1
    };

    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [remainingHostile.id, { ...remainingHostile }]
    ]));

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'killing GoblinBoss2 should defer dungeon completion long enough for post-boss skits to play'
    );

    MissionHandler.noteDungeonSkitActivity(client as never);
    await sleep(Math.max(25, MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS - 250));

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'recent skit activity should keep the dungeon completion screen from cutting off dialogue'
    );

    await sleep(400);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        true,
        'killing GoblinBoss2 should still force the dungeon completion screen after the skit window settles'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.GoblinRiver)]?.state ?? 0),
        2,
        'forcing Goblin River completion should move Last of the Goblins to ready-to-turn-in'
    );
    assert.equal(
        Number(client.character.questTrackerState ?? 0),
        100,
        'forcing Goblin River completion should push the quest tracker to 100%'
    );
    assert.deepEqual(
        client.character.CurrentLevel,
        client.character.PreviousLevel,
        'forcing Goblin River completion should move the character back to the safe previous level'
    );
}

async function testNephitBossKillForcesDungeonCompleteScreen(): Promise<void> {
    const client = createClient('GhostBossDungeon', MissionID.KillNephit, 'NephitBossTester');
    const levelScope = `${client.currentLevel}#${client.levelInstanceId}`;
    const remainingHostile = {
        id: 7401,
        name: 'GhostMinion',
        isPlayer: false,
        team: 2,
        entState: 0,
        hp: 10,
        clientSpawned: true,
        ownerToken: client.token,
        roomId: 1
    };
    const boss = {
        id: 7402,
        name: 'NephitLargeEye',
        isPlayer: false,
        team: 2,
        entRank: 'Boss',
        entState: 6,
        hp: 0,
        dead: true,
        clientSpawned: true,
        ownerToken: client.token,
        roomId: 1
    };

    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [remainingHostile.id, { ...remainingHostile }]
    ]));

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, boss);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'killing Nephit should not immediately interrupt any trailing dungeon dialogue'
    );

    await sleep(MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS + 100);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        true,
        'killing Nephit should still force the dungeon completion screen once the defer window expires'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.KillNephit)]?.state ?? 0),
        2,
        'forcing GhostBossDungeon completion should move Nephit\'s Quest to ready-to-turn-in'
    );
    assert.equal(
        Number(client.character.questTrackerState ?? 0),
        100,
        'forcing GhostBossDungeon completion should push the quest tracker to 100%'
    );
    assert.deepEqual(
        client.character.CurrentLevel,
        client.character.PreviousLevel,
        'forcing GhostBossDungeon completion should move the character back to the safe previous level'
    );
}

async function testLastHostileDeathForcesDungeonCompleteWithoutBossRank(): Promise<void> {
    const client = createClient('GoblinRiverDungeon', MissionID.GoblinRiver, 'FallbackBossTester');
    const levelScope = `${client.currentLevel}#${client.levelInstanceId}`;
    const finalEnemy = {
        id: 8402,
        name: 'GoblinClub',
        isPlayer: false,
        team: 2,
        entRank: 'Minion',
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
        true,
        'killing the last remaining hostile in a dungeon should complete the run even if the final enemy is not tagged Boss'
    );
}

async function testNonBossKillDoesNotForceCompletionWhileHostilesRemain(): Promise<void> {
    const client = createClient('GoblinRiverDungeon', MissionID.GoblinRiver, 'NonBossGateTester');
    const levelScope = `${client.currentLevel}#${client.levelInstanceId}`;
    const remainingHostile = {
        id: 8501,
        name: 'GoblinHatchet',
        isPlayer: false,
        team: 2,
        entState: 0,
        hp: 10,
        dead: false,
        clientSpawned: true,
        ownerToken: client.token,
        roomId: 1
    };
    const defeatedAdd = {
        id: 8502,
        name: 'GoblinClub',
        isPlayer: false,
        team: 2,
        entRank: 'Minion',
        entState: 6,
        hp: 0,
        dead: true,
        clientSpawned: true,
        ownerToken: client.token,
        roomId: 1
    };

    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [remainingHostile.id, { ...remainingHostile }]
    ]));

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, defeatedAdd);
    await sleep(MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS + 100);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'non-boss enemies should not force dungeon completion while live hostiles still remain in the instance'
    );
}

async function testBossDeadStateForcesDungeonCompletionBeforeDisappear(): Promise<void> {
    const client = createClient('GoblinRiverDungeon', MissionID.GoblinRiver, 'DeadStateBossTester');
    const levelScope = getClientLevelScope(client as never);
    const boss = {
        id: 8602,
        name: 'GoblinBoss2',
        isPlayer: false,
        team: 2,
        entRank: 'Boss',
        entState: 0,
        hp: 1,
        dead: false,
        clientSpawned: true,
        ownerToken: client.token,
        roomId: 1
    };

    GlobalState.sessionsByToken.set(client.token, client as never);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [boss.id, boss]
    ]));

    await CombatHandler.handlePowerHit(
        client as never,
        buildPowerHitPayload(boss.id, client.clientEntID, 5, 77)
    );

    assert.equal(
        Number(client.character.missions[String(MissionID.GoblinRiver)]?.state ?? 0),
        1,
        'boss dead state should schedule completion, not instantly mutate mission state before the skit settle window'
    );

    await sleep(MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS + 100);

    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x87),
        true,
        'dungeon completion should trigger from the boss dead state without waiting for entity destroy'
    );
    assert.equal(
        Number(client.character.missions[String(MissionID.GoblinRiver)]?.state ?? 0),
        2,
        'boss dead state should complete the dungeon mission once the settle window ends'
    );

    const completionCountBeforeDestroy = client.sentPackets.filter((packet) => packet.id === 0x87).length;
    const destroyPacket = new BitBuffer(false);
    destroyPacket.writeMethod4(boss.id);
    destroyPacket.writeMethod15(false);
    await CombatHandler.handleEntityDestroy(client as never, destroyPacket.toBuffer());

    assert.equal(
        client.sentPackets.filter((packet) => packet.id === 0x87).length,
        completionCountBeforeDestroy,
        'the later disappear event should not trigger dungeon completion a second time after dead-state completion'
    );
}

async function main(): Promise<void> {
    ensureDataLoaded();
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const levelEntities = new Map(GlobalState.levelEntities);

    try {
        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        await testGoblinRiverBossKillForcesDungeonCompleteScreen();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        await testNephitBossKillForcesDungeonCompleteScreen();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        await testLastHostileDeathForcesDungeonCompleteWithoutBossRank();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        await testNonBossKillDoesNotForceCompletionWhileHostilesRemain();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        await testBossDeadStateForcesDungeonCompletionBeforeDisappear();
        console.log('goblin_river_completion_regression: ok');
    } finally {
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.levelEntities = levelEntities;
    }
}

void main().catch((error) => {
    console.error('goblin_river_completion_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
