import { strict as assert } from 'assert';
import * as net from 'net';
import * as path from 'path';
import { Client } from '../core/Client';
import { Character } from '../database/Database';
import { GlobalState } from '../core/GlobalState';
import { CharacterHandler } from '../handlers/CharacterHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { LevelConfig } from '../core/LevelConfig';
import { MissionLoader } from '../data/MissionLoader';

function createCharacter(name: string): Character {
    return {
        name,
        class: 'Paladin',
        gender: 'male',
        level: 1,
        CurrentLevel: { name: 'CraftTown', x: 360, y: 1460 },
        PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 }
    };
}

function createClient(): any {
    const sentPackets: Array<{ id: number; payload: Buffer }> = [];
    return {
        token: 0,
        clientEntID: 0,
        userId: null,
        character: null,
        characters: [],
        entities: new Map(),
        currentLevel: '',
        levelInstanceId: '',
        entryLevel: '',
        syncAnchorStartedAt: 0,
        syncAnchorToken: 0,
        syncAnchorCharacterName: '',
        currentRoomId: 0,
        lastDoorId: -1,
        lastDoorTargetLevel: '',
        playerSpawned: false,
        startedRoomEvents: new Set<string>(),
        deferredRoomEventStarts: new Set<string>(),
        syncedQuestTrackerState: null,
        syncedDungeonMissionId: 0,
        syncedDungeonMissionState: 0,
        syncedDungeonMissionProgress: null,
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function parseMissionProgress(payload: Buffer): { missionId: number; progress: number } {
    const br = new BitReader(payload);
    return {
        missionId: br.readMethod4(),
        progress: br.readMethod4()
    };
}

function withMockedRandom(values: number[], fn: () => void): void {
    const originalRandom = Math.random;
    let nextIndex = 0;
    Math.random = () => values[Math.min(nextIndex++, values.length - 1)] ?? 0;

    try {
        fn();
    } finally {
        Math.random = originalRandom;
    }
}

function ensureLevelConfigLoaded(): void {
    if (!LevelConfig.has('TutorialDungeon')) {
        LevelConfig.load(path.resolve(__dirname, '../data'));
    }
    if (!MissionLoader.getMissionDef(3)) {
        MissionLoader.load(path.resolve(__dirname, '../data'));
    }
}

function testRecoverTransferSessionStateFromActiveToken(): void {
    const client = createClient();
    const activeCharacter = createCharacter('Hero');
    const activeSession = {
        userId: 41,
        character: activeCharacter,
        characters: [activeCharacter],
        currentLevel: 'CraftTown',
        entryLevel: '',
        syncAnchorStartedAt: 1234,
        lastDoorId: 2,
        lastDoorTargetLevel: 'NewbieRoad'
    };

    GlobalState.sessionsByToken.set(28514, activeSession as never);

    const recovered = (LevelHandler as any).recoverTransferSessionState(client, 28514);

    assert.ok(recovered);
    assert.equal(recovered.resolvedToken, 28514);
    assert.equal(client.userId, 41);
    assert.equal(client.character, activeCharacter);
    assert.equal(client.characters.length, 1);
    assert.equal(client.currentLevel, 'CraftTown');
    assert.equal(client.syncAnchorStartedAt, 1234);
    assert.equal(client.lastDoorTargetLevel, 'NewbieRoad');
}

function testRecoverTransferSessionStateFromUsedTokenAlias(): void {
    const client = createClient();
    const activeCharacter = createCharacter('Hero');
    const liveSession = {
        token: 43419,
        userId: 41,
        character: activeCharacter,
        characters: [activeCharacter],
        entities: new Map<number, any>([
            [99, { x: 800, y: 900 }]
        ]),
        currentLevel: 'CraftTown',
        entryLevel: '',
        syncAnchorStartedAt: 2222,
        currentRoomId: 4,
        startedRoomEvents: new Set<string>(['CraftTown:4']),
        clientEntID: 99,
        lastDoorId: 2,
        lastDoorTargetLevel: 'NewbieRoad',
        playerSpawned: true
    };

    GlobalState.usedTransferTokens.set(27212, {
        character: activeCharacter,
        userId: 41,
        targetLevel: 'CraftTown',
        previousLevel: 'NewbieRoad'
    });
    GlobalState.sessionsByToken.set(43419, liveSession as never);
    GlobalState.sessionsByUserId.set(41, liveSession as never);
    GlobalState.sessionsByCharacterName.set('hero', liveSession as never);

    const recovered = (LevelHandler as any).recoverTransferSessionState(client, 27212);

    assert.ok(recovered);
    assert.equal(recovered.resolvedToken, 43419);
    assert.equal(client.token, 43419);
    assert.equal(client.userId, 41);
    assert.equal(client.character, activeCharacter);
    assert.equal(client.clientEntID, 99);
    assert.equal(client.currentLevel, 'CraftTown');
    assert.equal(client.syncAnchorStartedAt, 2222);
    assert.equal(client.lastDoorTargetLevel, 'NewbieRoad');
    assert.equal(client.entities.get(99)?.x, 800);
    assert.equal(client.startedRoomEvents.has('CraftTown:4'), true);
}

function testRecoverTransferSessionStateFromLegacyAliasChain(): void {
    const client = createClient();
    const activeCharacter = createCharacter('Hero');
    const liveSession = {
        token: 50002,
        userId: 41,
        character: activeCharacter,
        characters: [activeCharacter],
        entities: new Map<number, any>([
            [99, { x: 640, y: 512 }]
        ]),
        currentLevel: 'TutorialDungeon',
        entryLevel: 'NewbieRoad',
        syncAnchorStartedAt: 3333,
        currentRoomId: 1,
        startedRoomEvents: new Set<string>(['TutorialDungeon:1', 'TutorialDungeon:5']),
        clientEntID: 99,
        lastDoorId: 101,
        lastDoorTargetLevel: 'TutorialDungeon',
        playerSpawned: true
    };

    GlobalState.transferTokenAliases.set(41324, 28480);
    GlobalState.transferTokenAliases.set(28480, 50002);
    GlobalState.sessionsByToken.set(50002, liveSession as never);
    GlobalState.sessionsByUserId.set(41, liveSession as never);
    GlobalState.sessionsByCharacterName.set('hero', liveSession as never);

    const recovered = (LevelHandler as any).recoverTransferSessionState(client, 41324);

    assert.ok(recovered);
    assert.equal(recovered.resolvedToken, 50002);
    assert.equal(client.token, 50002);
    assert.equal(client.userId, 41);
    assert.equal(client.character, activeCharacter);
    assert.equal(client.clientEntID, 99);
    assert.equal(client.currentLevel, 'TutorialDungeon');
    assert.equal(client.entryLevel, 'NewbieRoad');
    assert.equal(client.syncAnchorStartedAt, 3333);
    assert.equal(client.entities.get(99)?.x, 640);
    assert.equal(client.startedRoomEvents.has('TutorialDungeon:5'), true);
}

function testStorePendingTransferTokenKeepsTokenCharInSync(): void {
    const character = createCharacter('Hero');

    (LevelHandler as any).storePendingTransferToken(
        50001,
        character,
        41,
        'NewbieRoad',
        'CraftTown',
        1421,
        826,
        true,
        false,
        {
            x: 1421,
            y: 826,
            hasCoord: true,
            syncAnchorStartedAt: 1700,
            syncAnchorToken: 601,
            syncAnchorCharacterName: 'Leader',
            syncEntryLevel: 'NewbieRoad',
            syncRoomId: 9,
            syncStartedRoomIds: [2, 9]
        }
    );

    const pendingEntry = GlobalState.pendingWorld.get(50001);
    const tokenEntry = GlobalState.tokenChar.get(50001);

    assert.ok(pendingEntry);
    assert.equal(pendingEntry?.targetLevel, 'NewbieRoad');
    assert.equal(pendingEntry?.previousLevel, 'CraftTown');
    assert.equal(pendingEntry?.userId, 41);
    assert.equal(pendingEntry?.syncAnchorStartedAt, undefined);
    assert.equal(pendingEntry?.syncAnchorToken, 601);
    assert.equal(pendingEntry?.syncAnchorCharacterName, 'Leader');
    assert.equal(pendingEntry?.syncEntryLevel, 'NewbieRoad');
    assert.equal(pendingEntry?.syncRoomId, 9);
    assert.deepEqual(pendingEntry?.syncStartedRoomIds, [2, 9]);
    assert.equal(tokenEntry?.character, character);
    assert.equal(tokenEntry?.userId, 41);
    assert.equal(GlobalState.pendingExtended.get(50001), false);
}

function testBuildTransferSyncStatePrefersPartyAnchorInDungeon(): void {
    const follower = createClient();
    follower.character = createCharacter('Follower');
    follower.currentLevel = 'BridgeTown';
    follower.playerSpawned = true;

    const stranger = {
        token: 6001,
        userId: 51,
        character: createCharacter('Stranger'),
        characters: [],
        entities: new Map<number, any>([[91, { x: 100, y: 200 }]]),
        currentLevel: 'TutorialDungeon',
        entryLevel: 'NewbieRoad',
        currentRoomId: 2,
        startedRoomEvents: new Set<string>(['TutorialDungeon:2']),
        clientEntID: 91,
        lastDoorId: 0,
        lastDoorTargetLevel: '',
        playerSpawned: true
    };

    const leader = {
        token: 6002,
        userId: 52,
        character: createCharacter('Leader'),
        characters: [],
        entities: new Map<number, any>([[92, { x: 1777, y: 2888 }]]),
        currentLevel: 'TutorialDungeon',
        levelInstanceId: 'party-run-88',
        entryLevel: 'NewbieRoad',
        syncAnchorStartedAt: 1111,
        currentRoomId: 15,
        startedRoomEvents: new Set<string>(['TutorialDungeon:0', 'TutorialDungeon:5', 'TutorialDungeon:15']),
        clientEntID: 92,
        lastDoorId: 0,
        lastDoorTargetLevel: '',
        playerSpawned: true
    };

    GlobalState.sessionsByToken.set(stranger.token, stranger as never);
    GlobalState.sessionsByToken.set(leader.token, leader as never);
    GlobalState.partyByMember.set('follower', 88);
    GlobalState.partyByMember.set('leader', 88);

    const syncState = (LevelHandler as any).buildTransferSyncState(follower, 'TutorialDungeon', null);

    assert.ok(syncState);
    assert.equal(syncState.x, 1777);
    assert.equal(syncState.y, 2888);
    assert.equal(syncState.hasCoord, true);
    assert.equal(syncState.syncAnchorToken, leader.token);
    assert.equal(syncState.syncAnchorCharacterName, 'Leader');
    assert.equal(syncState.syncAnchorStartedAt, 1111);
    assert.equal(syncState.levelInstanceId, 'party-run-88');
    assert.equal(syncState.syncEntryLevel, 'NewbieRoad');
    assert.equal(syncState.syncRoomId, 15);
    assert.deepEqual(syncState.syncStartedRoomIds, [0, 5, 15]);
}

function testBuildTransferSyncStateSkipsStrangerDungeonInstance(): void {
    const follower = createClient();
    follower.character = createCharacter('Follower');
    follower.currentLevel = 'BridgeTown';
    follower.playerSpawned = true;

    const stranger = {
        token: 6003,
        userId: 53,
        character: createCharacter('Stranger'),
        characters: [],
        entities: new Map<number, any>([[93, { x: 1444, y: 2555 }]]),
        currentLevel: 'TutorialDungeon',
        levelInstanceId: 'solo-run-53',
        entryLevel: 'NewbieRoad',
        currentRoomId: 9,
        startedRoomEvents: new Set<string>(['TutorialDungeon:9']),
        clientEntID: 93,
        lastDoorId: 0,
        lastDoorTargetLevel: '',
        playerSpawned: true
    };

    GlobalState.sessionsByToken.set(stranger.token, stranger as never);

    const syncState = (LevelHandler as any).buildTransferSyncState(follower, 'TutorialDungeon', null);

    assert.ok(syncState, 'fresh dungeon entries should still get a root sync state');
    assert.equal(syncState.levelInstanceId, undefined, 'solo players should not inherit an unrelated dungeon instance');
    assert.equal(syncState.syncAnchorToken, undefined);
    assert.equal(syncState.syncAnchorCharacterName, undefined);
    assert.ok(Number(syncState.syncAnchorStartedAt) > 0, 'fresh dungeon entries should create a root anchor timestamp');
    assert.equal(syncState.syncQuestTrackerState, 0, 'fresh dungeon entries should reset run progress instead of using stale saved progress');
}

function testBuildTransferSyncStateUsesPendingPartyAnchorWhenLeaderStillTransferring(): void {
    const follower = createClient();
    follower.character = createCharacter('Follower');
    follower.currentLevel = 'BridgeTown';
    follower.playerSpawned = true;

    const leader = createCharacter('Leader');
    GlobalState.pendingWorld.set(7001, {
        character: leader,
        userId: 52,
        targetLevel: 'TutorialDungeon',
        levelInstanceId: 'party-run-pending',
        previousLevel: 'NewbieRoad',
        newX: 1777,
        newY: 2888,
        newHasCoord: true,
        syncAnchorStartedAt: 900,
        syncRoomId: 12,
        syncStartedRoomIds: [0, 12]
    });
    GlobalState.partyByMember.set('follower', 88);
    GlobalState.partyByMember.set('leader', 88);

    const syncState = (LevelHandler as any).buildTransferSyncState(follower, 'TutorialDungeon', null);

    assert.ok(syncState);
    assert.equal(syncState.x, 1777);
    assert.equal(syncState.y, 2888);
    assert.equal(syncState.hasCoord, true);
    assert.equal(syncState.levelInstanceId, 'party-run-pending');
    assert.equal(syncState.syncAnchorStartedAt, 900);
    assert.equal(syncState.syncAnchorToken, 7001);
    assert.equal(syncState.syncAnchorCharacterName, 'Leader');
    assert.equal(syncState.syncEntryLevel, 'NewbieRoad');
    assert.equal(syncState.syncRoomId, 12);
    assert.deepEqual(syncState.syncStartedRoomIds, [0, 12]);
}

function testBuildTransferSyncStateSeedsFreshDungeonMissionProgressAtZero(): void {
    const follower = createClient();
    follower.character = createCharacter('Follower');
    follower.character.questTrackerState = 100;
    follower.character.missions = {
        '3': {
            state: 1,
            currCount: 100
        }
    };
    follower.currentLevel = 'BridgeTown';
    follower.playerSpawned = true;

    const syncState = (LevelHandler as any).buildTransferSyncState(follower, 'TutorialDungeon', null);

    assert.ok(syncState);
    assert.equal(syncState.syncQuestTrackerState, 0);
    assert.equal(syncState.syncDungeonMissionId, 3);
    assert.equal(syncState.syncDungeonMissionState, 1);
    assert.equal(syncState.syncDungeonMissionProgress, 0);
}

function testBuildTransferSyncStatePrefersActivePartyAnchorOverPendingOwner(): void {
    const follower = createClient();
    follower.character = createCharacter('Follower');
    follower.currentLevel = 'BridgeTown';
    follower.playerSpawned = true;

    const lateActiveLeader = {
        token: 7101,
        userId: 53,
        character: createCharacter('Leader'),
        characters: [],
        entities: new Map<number, any>([[94, { x: 2100, y: 3100 }]]),
        currentLevel: 'TutorialDungeon',
        levelInstanceId: 'party-run-late',
        entryLevel: 'NewbieRoad',
        syncAnchorStartedAt: 2000,
        currentRoomId: 18,
        startedRoomEvents: new Set<string>(['TutorialDungeon:0', 'TutorialDungeon:18']),
        clientEntID: 94,
        lastDoorId: 0,
        lastDoorTargetLevel: '',
        playerSpawned: true
    };

    GlobalState.sessionsByToken.set(lateActiveLeader.token, lateActiveLeader as never);
    GlobalState.pendingWorld.set(7102, {
        character: createCharacter('Scout'),
        userId: 54,
        targetLevel: 'TutorialDungeon',
        levelInstanceId: 'party-run-early',
        previousLevel: 'NewbieRoad',
        newX: 1500,
        newY: 2500,
        newHasCoord: true,
        syncAnchorStartedAt: 1000,
        syncRoomId: 9,
        syncStartedRoomIds: [0, 9]
    });
    GlobalState.partyByMember.set('follower', 99);
    GlobalState.partyByMember.set('leader', 99);
    GlobalState.partyByMember.set('scout', 99);

    const syncState = (LevelHandler as any).buildTransferSyncState(follower, 'TutorialDungeon', null);

    assert.ok(syncState);
    assert.equal(syncState.levelInstanceId, 'party-run-late');
    assert.equal(syncState.syncAnchorStartedAt, 2000);
    assert.equal(syncState.syncAnchorToken, 7101);
    assert.equal(syncState.syncAnchorCharacterName, 'Leader');
    assert.equal(syncState.syncRoomId, 18);
    assert.deepEqual(syncState.syncStartedRoomIds, [0, 18]);
}

function testStorePendingTransferTokenCreatesSoloDungeonInstance(): void {
    const character = createCharacter('Hero');

    (LevelHandler as any).storePendingTransferToken(
        50002,
        character,
        41,
        'TutorialDungeon',
        'NewbieRoad',
        100,
        200,
        true,
        false,
        null
    );

    assert.equal(GlobalState.pendingWorld.get(50002)?.levelInstanceId, '50002');
    assert.ok(
        Number(GlobalState.pendingWorld.get(50002)?.syncAnchorStartedAt) > 0,
        'solo dungeon transfers should create a root anchor timestamp'
    );
}

function testStorePendingTransferTokenCreatesPartyDungeonInstance(): void {
    const character = createCharacter('Hero');
    GlobalState.partyByMember.set('hero', 144);

    (LevelHandler as any).storePendingTransferToken(
        50003,
        character,
        41,
        'TutorialDungeon',
        'NewbieRoad',
        100,
        200,
        true,
        false,
        null
    );

    assert.equal(GlobalState.pendingWorld.get(50003)?.levelInstanceId, 'party-144');
}

function testRestoreTransferredRoomProgressReplaysRoomEvents(): void {
    const client = createClient();
    client.currentLevel = 'TutorialDungeon';

    const restored = LevelHandler.restoreTransferredRoomProgress(client as never, {
        targetLevel: 'TutorialDungeon',
        syncRoomId: 7,
        syncStartedRoomIds: [1, 7]
    });

    assert.equal(restored, true);
    assert.equal(client.currentRoomId, 7);
    assert.equal(client.startedRoomEvents.has('TutorialDungeon:1'), true);
    assert.equal(client.startedRoomEvents.has('TutorialDungeon:7'), true);
    assert.equal(client.deferredRoomEventStarts.has('TutorialDungeon:1'), true);
    assert.equal(client.deferredRoomEventStarts.has('TutorialDungeon:7'), true);
    assert.deepEqual(client.sentPackets.map((packet: { id: number }) => packet.id), []);

    client.playerSpawned = true;
    LevelHandler.flushDeferredRoomEventStarts(client as never);

    assert.deepEqual(client.sentPackets.map((packet: { id: number }) => packet.id), [0xA5, 0xA5]);
}

function testPrimeTutorialRoomEventsSkipsSyncedProgress(): void {
    const client = createClient();
    client.currentLevel = 'TutorialDungeon';

    const restored = LevelHandler.restoreTransferredRoomProgress(client as never, {
        targetLevel: 'TutorialDungeon',
        syncRoomId: 15,
        syncStartedRoomIds: [0, 5, 15]
    });

    assert.equal(restored, true);
    LevelHandler.primeTutorialRoomEvents(client as never);

    assert.equal(client.startedRoomEvents.has('TutorialDungeon:1'), false, 'synced tutorial progress should not re-prime room 1');
    assert.deepEqual(client.sentPackets.map((packet: { id: number }) => packet.id), []);

    client.playerSpawned = true;
    LevelHandler.flushDeferredRoomEventStarts(client as never);

    assert.deepEqual(client.sentPackets.map((packet: { id: number }) => packet.id), [0xA5, 0xA5, 0xA5]);
}

function testFlushDeferredRoomEventsAfterPrimeWhenPlayerAlreadySpawned(): void {
    const client = createClient();
    client.currentLevel = 'TutorialDungeon';
    client.playerSpawned = true;

    LevelHandler.primeTutorialRoomEvents(client as never);

    assert.deepEqual(
        client.sentPackets.map((packet: { id: number }) => packet.id),
        [0xA5, 0xA5],
        'prime should immediately flush room starts when the local player already exists'
    );
}

function testDisconnectDuringDoorTransferPreservesRecoveryState(): void {
    const client = new Client(
        new net.Socket(),
        {
            handle: async () => undefined
        } as never
    );
    const character = createCharacter('Hero');

    client.userId = 41;
    client.authenticated = true;
    client.character = character;
    client.characters = [character];
    client.token = 10473;
    client.clientEntID = 88;
    client.currentLevel = 'CraftTown';
    client.entryLevel = 'NewbieRoad';
    client.lastDoorId = 2;
    client.lastDoorTargetLevel = 'TutorialDungeon';
    client.entities.set(88, { x: 512, y: 768 });
    client.armPendingTransferGrace();

    GlobalState.sessionsByToken.set(10473, client);

    const snapshot = (client as any).createSessionCleanupSnapshot();
    assert.equal((client as any).isTransferInProgressOnClose(snapshot), true);

    (client as any).preserveTransferRecoveryState(snapshot);
    (client as any).cleanupSessionState(snapshot, true);

    const tokenEntry = GlobalState.tokenChar.get(10473);
    const usedEntry = GlobalState.usedTransferTokens.get(10473);

    assert.ok(tokenEntry);
    assert.ok(usedEntry);
    assert.equal(GlobalState.sessionsByToken.has(10473), false);
    assert.equal(tokenEntry?.character, character);
    assert.equal(tokenEntry?.userId, 41);
    assert.equal(usedEntry?.targetLevel, 'CraftTown');
    assert.equal(usedEntry?.previousLevel, 'NewbieRoad');
    assert.equal(usedEntry?.newX, 512);
    assert.equal(usedEntry?.newY, 768);
    assert.equal(usedEntry?.newHasCoord, true);
    assert.equal(usedEntry?.syncAnchorStartedAt, undefined);
}

function testEnterWorldTokenSkipsTargetLevelEntityIds(): void {
    const client = {
        userId: 41,
        sendBitBuffer: () => undefined
    };
    const character = createCharacter('Scout');
    character.CurrentLevel = { name: 'NewbieRoad', x: 1421, y: 826 };
    character.PreviousLevel = { name: 'TutorialBoat', x: 0, y: 0 };

    GlobalState.levelEntities.set('NewbieRoad', new Map<number, any>([
        [2701, { id: 2701, name: 'IntroGoblin', isPlayer: false, clientSpawned: true }]
    ]));

    withMockedRandom(
        [
            (2701.5 / 0x10000),
            (4097.5 / 0x10000)
        ],
        () => {
            (CharacterHandler as any).sendEnterWorld(client, character);
        }
    );

    assert.equal(GlobalState.pendingWorld.has(2701), false, 'enter-world token should not reuse an existing target-level entity id');
    assert.equal(GlobalState.tokenChar.has(2701), false);
    assert.equal(GlobalState.pendingWorld.get(4097)?.targetLevel, 'NewbieRoad');
    assert.equal(GlobalState.tokenChar.get(4097)?.character, character);
}

function testEnterWorldUsesPartyDungeonInstanceWithoutActiveAnchor(): void {
    const character = createCharacter('Scout');
    character.CurrentLevel = { name: 'TutorialDungeon', x: 1421, y: 826 };
    character.PreviousLevel = { name: 'NewbieRoad', x: 0, y: 0 };

    const client = {
        userId: 41,
        character,
        sendBitBuffer: () => undefined
    };

    GlobalState.partyByMember.set('scout', 155);

    withMockedRandom(
        [
            (4101.5 / 0x10000)
        ],
        () => {
            (CharacterHandler as any).sendEnterWorld(client, character);
        }
    );

    assert.equal(GlobalState.pendingWorld.get(4101)?.levelInstanceId, 'party-155');
}

function testLevelTransferTokenSkipsTargetLevelEntityAndLivePlayerIds(): void {
    GlobalState.levelEntities.set('NewbieRoad', new Map<number, any>([
        [2701, { id: 2701, name: 'IntroGoblin', isPlayer: false, clientSpawned: true }]
    ]));
    GlobalState.sessionsByToken.set(9100, {
        currentLevel: 'NewbieRoad',
        clientEntID: 2702
    } as never);

    let allocatedToken = 0;
    withMockedRandom(
        [
            (2701.5 / 0x10000),
            (2702.5 / 0x10000),
            (4098.5 / 0x10000)
        ],
        () => {
            allocatedToken = (LevelHandler as any).allocateTransferToken('NewbieRoad');
        }
    );

    assert.equal(allocatedToken, 4098);
}

function testEnterWorldSyncsDungeonQuestTrackerStateFromPartyAnchor(): void {
    const character = createCharacter('Scout');
    character.CurrentLevel = { name: 'TutorialDungeon', x: 1421, y: 826 };
    character.PreviousLevel = { name: 'NewbieRoad', x: 0, y: 0 };
    character.questTrackerState = 100;

    const client = {
        userId: 41,
        character,
        sendBitBuffer: () => undefined
    };

    const anchorCharacter = createCharacter('Leader');
    anchorCharacter.CurrentLevel = { name: 'TutorialDungeon', x: 1500, y: 900 };
    anchorCharacter.PreviousLevel = { name: 'NewbieRoad', x: 0, y: 0 };
    anchorCharacter.questTrackerState = 62;
    anchorCharacter.missions = {
        '3': {
            state: 1,
            currCount: 62
        }
    };

    GlobalState.sessionsByToken.set(7001, {
        token: 7001,
        userId: 42,
        character: anchorCharacter,
        currentLevel: 'TutorialDungeon',
        levelInstanceId: 'party-instance',
        playerSpawned: true,
        currentRoomId: 9,
        syncAnchorStartedAt: 1234,
        syncAnchorToken: 7001,
        syncAnchorCharacterName: 'Leader',
        syncedQuestTrackerState: 62,
        startedRoomEvents: new Set<string>(['TutorialDungeon:0', 'TutorialDungeon:9'])
    } as never);
    GlobalState.partyByMember.set('leader', 55);
    GlobalState.partyByMember.set('scout', 55);

    withMockedRandom(
        [
            (4099.5 / 0x10000)
        ],
        () => {
            (CharacterHandler as any).sendEnterWorld(client, character);
        }
    );

    const pendingEntry = GlobalState.pendingWorld.get(4099);
    assert.ok(pendingEntry);
    assert.equal(pendingEntry?.levelInstanceId, 'party-instance');
    assert.equal(pendingEntry?.syncAnchorToken, 7001);
    assert.equal(pendingEntry?.syncQuestTrackerState, 62, 'joiner should inherit party dungeon progress instead of keeping stale personal progress');
    assert.equal(pendingEntry?.syncDungeonMissionId, 3);
    assert.equal(pendingEntry?.syncDungeonMissionProgress, 62);
    assert.equal(pendingEntry?.syncRoomId, 9);
    assert.deepEqual(pendingEntry?.syncStartedRoomIds, [0, 9]);
}

function testEnterWorldPrefersMostProgressedActiveDungeonPartyAnchor(): void {
    const character = createCharacter('Scout');
    character.CurrentLevel = { name: 'TutorialDungeon', x: 1421, y: 826 };
    character.PreviousLevel = { name: 'NewbieRoad', x: 0, y: 0 };

    const client = {
        userId: 41,
        character,
        sendBitBuffer: () => undefined
    };

    const earlyOwner = createCharacter('Owner');
    earlyOwner.CurrentLevel = { name: 'TutorialDungeon', x: 1000, y: 800 };
    earlyOwner.PreviousLevel = { name: 'NewbieRoad', x: 0, y: 0 };
    earlyOwner.questTrackerState = 25;

    const progressedMember = createCharacter('Runner');
    progressedMember.CurrentLevel = { name: 'TutorialDungeon', x: 1600, y: 900 };
    progressedMember.PreviousLevel = { name: 'NewbieRoad', x: 0, y: 0 };
    progressedMember.questTrackerState = 70;

    GlobalState.sessionsByToken.set(7201, {
        token: 7201,
        userId: 51,
        character: earlyOwner,
        currentLevel: 'TutorialDungeon',
        levelInstanceId: 'owner-instance',
        playerSpawned: true,
        currentRoomId: 3,
        syncAnchorStartedAt: 1000,
        syncAnchorToken: 7201,
        syncAnchorCharacterName: 'Owner',
        syncedQuestTrackerState: 25,
        startedRoomEvents: new Set<string>(['TutorialDungeon:0', 'TutorialDungeon:3'])
    } as never);
    GlobalState.sessionsByToken.set(7202, {
        token: 7202,
        userId: 52,
        character: progressedMember,
        currentLevel: 'TutorialDungeon',
        levelInstanceId: 'runner-instance',
        playerSpawned: true,
        currentRoomId: 8,
        syncAnchorStartedAt: 2000,
        syncAnchorToken: 7201,
        syncAnchorCharacterName: 'Owner',
        syncedQuestTrackerState: 70,
        startedRoomEvents: new Set<string>(['TutorialDungeon:0', 'TutorialDungeon:3', 'TutorialDungeon:5', 'TutorialDungeon:8'])
    } as never);
    GlobalState.partyByMember.set('owner', 77);
    GlobalState.partyByMember.set('runner', 77);
    GlobalState.partyByMember.set('scout', 77);

    withMockedRandom(
        [
            (4100.5 / 0x10000)
        ],
        () => {
            (CharacterHandler as any).sendEnterWorld(client, character);
        }
    );

    const pendingEntry = GlobalState.pendingWorld.get(4100);
    assert.ok(pendingEntry);
    assert.equal(pendingEntry?.levelInstanceId, 'runner-instance');
    assert.equal(pendingEntry?.syncQuestTrackerState, 70);
    assert.equal(pendingEntry?.syncRoomId, 8);
    assert.deepEqual(pendingEntry?.syncStartedRoomIds, [0, 3, 5, 8]);
}

function testMissionSyncUsesDungeonOwnerProgressOverride(): void {
    const client = createClient();
    const character = createCharacter('Scout');
    character.CurrentLevel = { name: 'TutorialDungeon', x: 1421, y: 826 };
    character.PreviousLevel = { name: 'NewbieRoad', x: 0, y: 0 };
    character.questTrackerState = 100;
    character.missions = {
        '3': {
            state: 1,
            currCount: 100
        }
    };

    client.character = character;
    client.currentLevel = 'TutorialDungeon';
    client.syncedQuestTrackerState = 18;
    client.syncedDungeonMissionId = 3;
    client.syncedDungeonMissionState = 1;
    client.syncedDungeonMissionProgress = 18;

    MissionHandler.syncMissionStateToClient(client as never);

    const missionProgressPacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x83);
    assert.ok(missionProgressPacket, 'mission progress packet should be emitted');
    assert.deepEqual(parseMissionProgress(missionProgressPacket!.payload), {
        missionId: 3,
        progress: 18
    });
}

function main(): void {
    ensureLevelConfigLoaded();

    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const sessionsByUserId = new Map(GlobalState.sessionsByUserId);
    const sessionsByCharacterName = new Map(GlobalState.sessionsByCharacterName);
    const pendingWorld = new Map(GlobalState.pendingWorld);
    const pendingExtended = new Map(GlobalState.pendingExtended);
    const usedTransferTokens = new Map(GlobalState.usedTransferTokens);
    const tokenChar = new Map(GlobalState.tokenChar);
    const transferTokenAliases = new Map(GlobalState.transferTokenAliases);
    const levelEntities = new Map(GlobalState.levelEntities);
    const partyByMember = new Map(GlobalState.partyByMember);

    GlobalState.sessionsByToken.clear();
    GlobalState.sessionsByUserId.clear();
    GlobalState.sessionsByCharacterName.clear();
    GlobalState.pendingWorld.clear();
    GlobalState.pendingExtended.clear();
    GlobalState.usedTransferTokens.clear();
    GlobalState.tokenChar.clear();
    GlobalState.transferTokenAliases.clear();
    GlobalState.levelEntities.clear();
    GlobalState.partyByMember.clear();

    try {
        testRecoverTransferSessionStateFromActiveToken();

        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.usedTransferTokens.clear();
        GlobalState.tokenChar.clear();
        GlobalState.transferTokenAliases.clear();

        testRecoverTransferSessionStateFromUsedTokenAlias();

        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.usedTransferTokens.clear();
        GlobalState.tokenChar.clear();
        GlobalState.transferTokenAliases.clear();

        testRecoverTransferSessionStateFromLegacyAliasChain();

        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.usedTransferTokens.clear();
        GlobalState.tokenChar.clear();
        GlobalState.transferTokenAliases.clear();
        GlobalState.levelEntities.clear();

        testStorePendingTransferTokenKeepsTokenCharInSync();

        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.tokenChar.clear();

        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.usedTransferTokens.clear();
        GlobalState.tokenChar.clear();
        GlobalState.transferTokenAliases.clear();
        GlobalState.levelEntities.clear();

        testDisconnectDuringDoorTransferPreservesRecoveryState();

        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.usedTransferTokens.clear();
        GlobalState.tokenChar.clear();
        GlobalState.transferTokenAliases.clear();
        GlobalState.levelEntities.clear();

        testEnterWorldTokenSkipsTargetLevelEntityIds();

        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.usedTransferTokens.clear();
        GlobalState.tokenChar.clear();
        GlobalState.transferTokenAliases.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();

        testEnterWorldUsesPartyDungeonInstanceWithoutActiveAnchor();

        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.usedTransferTokens.clear();
        GlobalState.tokenChar.clear();
        GlobalState.transferTokenAliases.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();

        testLevelTransferTokenSkipsTargetLevelEntityAndLivePlayerIds();

        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.usedTransferTokens.clear();
        GlobalState.tokenChar.clear();
        GlobalState.transferTokenAliases.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();

        testEnterWorldSyncsDungeonQuestTrackerStateFromPartyAnchor();

        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.usedTransferTokens.clear();
        GlobalState.tokenChar.clear();
        GlobalState.transferTokenAliases.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();

        testEnterWorldPrefersMostProgressedActiveDungeonPartyAnchor();

        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.usedTransferTokens.clear();
        GlobalState.tokenChar.clear();
        GlobalState.transferTokenAliases.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();

        testMissionSyncUsesDungeonOwnerProgressOverride();

        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.usedTransferTokens.clear();
        GlobalState.tokenChar.clear();
        GlobalState.transferTokenAliases.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();

        testBuildTransferSyncStatePrefersPartyAnchorInDungeon();

        GlobalState.sessionsByToken.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.partyByMember.clear();

        testBuildTransferSyncStateSkipsStrangerDungeonInstance();

        GlobalState.sessionsByToken.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.partyByMember.clear();

        testBuildTransferSyncStateUsesPendingPartyAnchorWhenLeaderStillTransferring();

        GlobalState.sessionsByToken.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.partyByMember.clear();

        testBuildTransferSyncStateSeedsFreshDungeonMissionProgressAtZero();

        GlobalState.sessionsByToken.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.partyByMember.clear();

        testBuildTransferSyncStatePrefersActivePartyAnchorOverPendingOwner();

        GlobalState.sessionsByToken.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.partyByMember.clear();

        testStorePendingTransferTokenCreatesSoloDungeonInstance();

        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.tokenChar.clear();
        GlobalState.partyByMember.clear();

        testStorePendingTransferTokenCreatesPartyDungeonInstance();

        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.tokenChar.clear();

        testRestoreTransferredRoomProgressReplaysRoomEvents();

        testPrimeTutorialRoomEventsSkipsSyncedProgress();

        testFlushDeferredRoomEventsAfterPrimeWhenPlayerAlreadySpawned();
    } finally {
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.sessionsByUserId = sessionsByUserId;
        GlobalState.sessionsByCharacterName = sessionsByCharacterName;
        GlobalState.pendingWorld = pendingWorld;
        GlobalState.pendingExtended = pendingExtended;
        GlobalState.usedTransferTokens = usedTransferTokens;
        GlobalState.tokenChar = tokenChar;
        GlobalState.transferTokenAliases = transferTokenAliases;
        GlobalState.levelEntities = levelEntities;
        GlobalState.partyByMember = partyByMember;
    }

    console.log('level_transfer_regression: ok');
}

try {
    main();
} catch (error) {
    console.error('level_transfer_regression: failed');
    console.error(error);
    process.exitCode = 1;
}
