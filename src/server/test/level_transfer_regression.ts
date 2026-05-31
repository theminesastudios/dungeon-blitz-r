import { strict as assert } from 'assert';
import * as net from 'net';
import * as path from 'path';
import { Client } from '../core/Client';
import { Character } from '../database/Database';
import { GlobalState } from '../core/GlobalState';
import { CharacterHandler } from '../handlers/CharacterHandler';
import { EntityHandler } from '../handlers/EntityHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { PetHandler } from '../handlers/PetHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { LevelConfig } from '../core/LevelConfig';
import { MissionID } from '../data/runtime';
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
        dungeonRuntimeLevel: 0,
        entryLevel: '',
        entryX: 0,
        entryY: 0,
        entryHasCoord: false,
        syncAnchorStartedAt: 0,
        syncAnchorToken: 0,
        syncAnchorCharacterName: '',
        currentRoomId: 0,
        lastDoorId: -1,
        lastDoorTargetLevel: '',
        playerSpawned: false,
        mountTransferGraceUntil: 0,
        startedRoomEvents: new Set<string>(),
        knownEntityIds: new Set<number>(),
        pendingLoot: new Map(),
        processedRewardSources: new Set<string>(),
        triggeredLevelStates: new Set<string>(),
        sentPackets,
        armPendingTransferGrace() {
            return undefined;
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        },
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload });
        }
    };
}

function createOpenDoorPacket(doorId: number): Buffer {
    const bb = new BitBuffer();
    bb.writeMethod9(doorId);
    return bb.toBuffer();
}

function createDoorStateRequestPacket(doorId: number): Buffer {
    const bb = new BitBuffer();
    bb.writeMethod9(doorId);
    return bb.toBuffer();
}

function createLevelTransferPacket(token: number, targetLevel: string): Buffer {
    const bb = new BitBuffer();
    bb.writeMethod9(token);
    bb.writeMethod13(targetLevel);
    return bb.toBuffer();
}

function readMethod91(br: BitReader): number {
    const prefix = br.readMethod20(3);
    return br.readMethod20((prefix + 1) * 2);
}

function parseDoorStatePacket(payload: Buffer): { doorId: number; state: number; target: string; stars?: number } {
    const br = new BitReader(payload);
    const doorState = {
        doorId: br.readMethod4(),
        state: readMethod91(br),
        target: br.readMethod13()
    };
    if (doorState.state === 3) {
        return {
            ...doorState,
            stars: br.readMethod20(4)
        };
    }

    return doorState;
}

function parseDoorTargetPacket(payload: Buffer): { doorId: number; target: string } {
    const br = new BitReader(payload);
    return {
        doorId: br.readMethod4(),
        target: br.readMethod13()
    };
}

function parseRoomThoughtPacket(payload: Buffer): { entityId: number; text: string } {
    const br = new BitReader(payload);
    return {
        entityId: br.readMethod4(),
        text: br.readMethod13()
    };
}

function parseMountEquipPacket(payload: Buffer): { entityId: number; mountId: number } {
    const br = new BitReader(payload);
    return {
        entityId: br.readMethod4(),
        mountId: br.readMethod6(7)
    };
}

function parseEnterWorldLevelPacket(payload: Buffer): { mapLevel: number; baseLevel: number; internalName: string } {
    const br = new BitReader(payload);
    br.readMethod4();
    br.readMethod4();
    br.readMethod13();
    const hasOldCoord = br.readMethod15();
    if (hasOldCoord) {
        br.readMethod4();
        br.readMethod4();
    }
    br.readMethod13();
    br.readMethod4();
    br.readMethod13();
    const mapLevel = br.readMethod6(6);
    const baseLevel = br.readMethod6(6);
    const internalName = br.readMethod13();

    return { mapLevel, baseLevel, internalName };
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
        const dataDir = path.resolve(__dirname, '../data');
        LevelConfig.load(dataDir);
        MissionLoader.load(dataDir);
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

function testStorePendingTransferTokenKeepsTokenCharInSyncAndRequestsExtendedState(): void {
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
    assert.equal(
        GlobalState.pendingExtended.get(50001),
        false,
        'storePendingTransferToken should preserve the explicit sendExtended flag it was given'
    );
}

function testStorePendingTransferTokenSkipsExtendedStateForTransfers(): void {
    const character = createCharacter('Hero');

    (LevelHandler as any).storePendingTransferToken(
        50003,
        character,
        41,
        'NewbieRoad',
        'NewbieRoad',
        1273,
        1441,
        true,
        false,
        null
    );

    assert.equal(
        GlobalState.pendingExtended.get(50003),
        false,
        'level transfers should not request the extended player-data payload because the client keeps it in memory and duplicate sends duplicate inventory'
    );
}

function testCraftTownTransfersKeepCompactPlayerPayload(): void {
    assert.equal(
        (LevelHandler as any).shouldSendExtendedOnTransfer('CraftTown'),
        false,
        'CraftTown transfers should keep the compact payload because repeated extended payloads duplicate client-side pet and inventory lists'
    );
    assert.equal(
        (LevelHandler as any).shouldSendExtendedOnTransfer('NewbieRoad'),
        false,
        'ordinary overworld transfers should keep the compact payload'
    );
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
    assert.equal(syncState.x, 0);
    assert.equal(syncState.y, 0);
    assert.equal(syncState.hasCoord, false);
    assert.equal(syncState.syncAnchorToken, leader.token);
    assert.equal(syncState.syncAnchorCharacterName, 'Leader');
    assert.equal(syncState.syncAnchorStartedAt, 1111);
    assert.equal(syncState.levelInstanceId, 'party-run-88');
    assert.equal(syncState.syncEntryLevel, 'NewbieRoad');
    assert.equal(syncState.syncRoomId, 15);
    assert.deepEqual(syncState.syncStartedRoomIds, [0, 5, 15]);
}

function testFindActiveTransferSessionPrefersNamedCharacterOverSameUserIndex(): void {
    const fleerpuh = {
        token: 6201,
        userId: 41,
        character: createCharacter('Fleerpuh'),
        characters: [],
        entities: new Map<number, any>(),
        currentLevel: 'CraftTown',
        entryLevel: '',
        currentRoomId: 0,
        startedRoomEvents: new Set<string>(),
        clientEntID: 201,
        lastDoorId: 0,
        lastDoorTargetLevel: '',
        playerSpawned: true
    };
    const alt = {
        token: 6202,
        userId: 41,
        character: createCharacter('FleerpuhAlt'),
        characters: [],
        entities: new Map<number, any>(),
        currentLevel: 'GoblinRiverDungeon',
        levelInstanceId: 'same-account-run',
        entryLevel: 'NewbieRoad',
        currentRoomId: 3,
        startedRoomEvents: new Set<string>(['GoblinRiverDungeon:3']),
        clientEntID: 202,
        lastDoorId: 0,
        lastDoorTargetLevel: '',
        playerSpawned: true
    };
    const staleUserIndexSession = {
        token: 6203,
        userId: 41,
        character: createCharacter('StaleUserIndexOnly')
    };

    GlobalState.sessionsByUserId.set(41, staleUserIndexSession as never);
    GlobalState.sessionsByToken.set(fleerpuh.token, fleerpuh as never);
    GlobalState.sessionsByToken.set(alt.token, alt as never);
    GlobalState.sessionsByCharacterName.set('fleerpuh', fleerpuh as never);
    GlobalState.sessionsByCharacterName.set('fleerpuhalt', alt as never);

    const resolvedFleerpuh = (LevelHandler as any).findActiveTransferSession(41, 'Fleerpuh');
    const resolvedAlt = (LevelHandler as any).findActiveTransferSession(41, 'FleerpuhAlt');
    const userFallback = (LevelHandler as any).findActiveTransferSession(41, '');

    assert.equal(resolvedFleerpuh, fleerpuh);
    assert.equal(resolvedAlt, alt);
    assert.equal(
        userFallback,
        fleerpuh,
        'user-level fallback should derive from active token sessions when no character name is available'
    );
}

function testBuildTransferSyncStateAllowsSameAccountDifferentCharacterPartyAnchor(): void {
    const follower = createClient();
    follower.userId = 41;
    follower.character = createCharacter('FleerpuhAlt');
    follower.currentLevel = 'CraftTown';
    follower.playerSpawned = true;

    const leader = {
        token: 6301,
        userId: 41,
        character: createCharacter('Fleerpuh'),
        characters: [],
        entities: new Map<number, any>([[301, { x: 1800, y: 2600 }]]),
        currentLevel: 'GoblinRiverDungeon',
        levelInstanceId: 'same-account-party-run',
        entryLevel: 'NewbieRoad',
        syncAnchorStartedAt: 2222,
        currentRoomId: 4,
        startedRoomEvents: new Set<string>(['GoblinRiverDungeon:4']),
        clientEntID: 301,
        lastDoorId: 0,
        lastDoorTargetLevel: '',
        playerSpawned: true
    };

    GlobalState.sessionsByToken.set(leader.token, leader as never);
    GlobalState.partyByMember.set('fleerpuhalt', 101);
    GlobalState.partyByMember.set('fleerpuh', 101);

    const syncState = (LevelHandler as any).buildTransferSyncState(follower, 'GoblinRiverDungeon', null);

    assert.ok(syncState);
    assert.equal(syncState.levelInstanceId, 'same-account-party-run');
    assert.equal(syncState.syncAnchorToken, leader.token);
    assert.equal(syncState.syncAnchorCharacterName, 'Fleerpuh');
    assert.equal(syncState.syncRoomId, 4);
    assert.deepEqual(syncState.syncStartedRoomIds, [4]);
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
}

function testVeinsOfMeylourFreshEntryUsesBeginningSpawnOverride(): void {
    const client = createClient();
    client.character = createCharacter('VeinsRunner');
    client.currentLevel = 'OldMineMountain';
    client.playerSpawned = true;

    const syncState = (LevelHandler as any).buildTransferSyncState(client, 'OMM_Mission8', null);

    assert.ok(syncState);
    assert.equal(syncState.hasCoord, true);
    assert.equal(syncState.x, 2375);
    assert.equal(syncState.y, 849);
    assert.equal(syncState.syncRoomId, undefined);
    assert.deepEqual(syncState.syncStartedRoomIds, []);
}

function testVeinsOfMeylourPartyEntryPreservesAnchorProgress(): void {
    const follower = createClient();
    follower.character = createCharacter('VeinsFollower');
    follower.currentLevel = 'OldMineMountain';
    follower.playerSpawned = true;

    const leader = {
        token: 6010,
        userId: 61,
        character: createCharacter('VeinsLeader'),
        characters: [],
        entities: new Map<number, any>([[191, { x: 22382, y: 4147 }]]),
        currentLevel: 'OMM_Mission8',
        levelInstanceId: 'veins-party-run',
        entryLevel: 'OldMineMountain',
        syncAnchorStartedAt: 4444,
        currentRoomId: 12,
        startedRoomEvents: new Set<string>(['OMM_Mission8:1', 'OMM_Mission8:12']),
        clientEntID: 191,
        lastDoorId: 0,
        lastDoorTargetLevel: '',
        playerSpawned: true
    };

    GlobalState.sessionsByToken.set(leader.token, leader as never);
    GlobalState.partyByMember.set('veinsfollower', 98);
    GlobalState.partyByMember.set('veinsleader', 98);

    const syncState = (LevelHandler as any).buildTransferSyncState(follower, 'OMM_Mission8', null);

    assert.ok(syncState);
    assert.equal(syncState.hasCoord, false);
    assert.equal(syncState.levelInstanceId, 'veins-party-run');
    assert.equal(syncState.syncAnchorToken, leader.token);
    assert.equal(syncState.syncRoomId, 12);
    assert.deepEqual(syncState.syncStartedRoomIds, [1, 12]);
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
    assert.equal(syncState.x, 0);
    assert.equal(syncState.y, 0);
    assert.equal(syncState.hasCoord, false);
    assert.equal(syncState.levelInstanceId, 'party-run-pending');
    assert.equal(syncState.syncAnchorStartedAt, 900);
    assert.equal(syncState.syncAnchorToken, 7001);
    assert.equal(syncState.syncAnchorCharacterName, 'Leader');
    assert.equal(syncState.syncEntryLevel, 'NewbieRoad');
    assert.equal(syncState.syncRoomId, 12);
    assert.deepEqual(syncState.syncStartedRoomIds, [0, 12]);
}

function testBuildTransferSyncStatePreservesExistingDungeonEntryLevel(): void {
    const client = createClient();
    client.character = createCharacter('KeepRunner');
    client.currentLevel = 'CraftTownTutorial';
    client.entryLevel = 'WolfsEnd';
    client.playerSpawned = true;

    const syncState = (LevelHandler as any).buildTransferSyncState(client, 'CraftTown', null);

    assert.equal(syncState, null);
}

function testResolveTransferSourceLevelPrefersLiveSessionLevel(): void {
    const client = createClient();
    client.currentLevel = 'CraftTownTutorial';
    client.character = createCharacter('KeepRunner');

    const resolved = (LevelHandler as any).resolveTransferSourceLevel(client, client.character);

    assert.equal(resolved, 'CraftTownTutorial');
}

function testResolveCraftTownReturnLevelRejectsCraftTownLoop(): void {
    const client = createClient();
    client.entryLevel = 'CraftTown';
    const character = createCharacter('KeepRunner');
    character.CurrentLevel = { name: 'CraftTown', x: 918, y: 1440 };
    character.PreviousLevel = { name: 'WolfsEnd', x: 1210, y: 880 };

    const resolved = (LevelHandler as any).resolveCraftTownReturnLevel(
        client,
        character,
        'CraftTownTutorial',
        {
            x: 0,
            y: 0,
            hasCoord: false,
            syncEntryLevel: 'CraftTown'
        }
    );

    assert.equal(resolved, 'NewbieRoad');
}

function testResolveCraftTownReturnLevelRejectsCraftTownTutorialLoop(): void {
    const client = createClient();
    client.currentLevel = 'CraftTownTutorial';
    client.entryLevel = 'CraftTownTutorial';
    const character = createCharacter('KeepRunner');
    character.CurrentLevel = { name: 'CraftTownTutorial', x: -6886, y: 1623 };
    character.PreviousLevel = { name: 'CraftTownTutorial', x: -6886, y: 1623 };

    const resolved = (LevelHandler as any).resolveCraftTownReturnLevel(
        client,
        character,
        'CraftTownTutorial',
        {
            x: 0,
            y: 0,
            hasCoord: false,
            syncEntryLevel: 'CraftTownTutorial'
        }
    );

    assert.equal(resolved, 'NewbieRoad');
}

function testSyncTransferSourcePositionFromLiveEntityUsesOverworldCoords(): void {
    const character = createCharacter('Hero');
    character.CurrentLevel = { name: 'NewbieRoad', x: 1421, y: 826 };

    (LevelHandler as any).syncTransferSourcePositionFromLiveEntity(
        character,
        'NewbieRoad',
        { x: 13816.4, y: 605.2 }
    );

    assert.deepEqual(character.CurrentLevel, { name: 'NewbieRoad', x: 13816, y: 605 });
}

function testSyncTransferSourcePositionFromLiveEntityDoesNotOverwriteDungeonReturnPoint(): void {
    const character = createCharacter('Hero');
    character.CurrentLevel = { name: 'NewbieRoad', x: 13816, y: 605 };

    (LevelHandler as any).syncTransferSourcePositionFromLiveEntity(
        character,
        'GhostBossDungeon',
        { x: 512, y: 768 }
    );

    assert.deepEqual(
        character.CurrentLevel,
        { name: 'NewbieRoad', x: 13816, y: 605 },
        'dungeon transfers should preserve the safe return point already stored in CurrentLevel'
    );
}

function testResolveDungeonExitSpawnUsesRecordedDungeonEntryCoords(): void {
    const client = createClient();
    client.currentLevel = 'GhostBossDungeon';
    client.entryLevel = 'NewbieRoad';
    client.entryX = 13816;
    client.entryY = 605;
    client.entryHasCoord = true;

    const character = createCharacter('Hero');
    character.CurrentLevel = { name: 'GhostBossDungeon', x: 0, y: 0 };
    character.PreviousLevel = { name: 'NewbieRoad', x: 1421, y: 826 };

    const spawn = (LevelHandler as any).resolveDungeonExitSpawn(
        client,
        character,
        'GhostBossDungeon',
        'NewbieRoad',
        null
    );

    assert.deepEqual(spawn, { x: 13816, y: 605, hasCoord: true });
}

function testResolveDungeonExitSpawnUsesCraftTownTutorialStartPoint(): void {
    const client = createClient();
    client.currentLevel = 'CraftTown';

    const character = createCharacter('KeepRunner');
    character.CurrentLevel = { name: 'CraftTown', x: 918, y: 1440 };
    character.PreviousLevel = { name: 'NewbieRoad', x: 1210, y: 880 };

    const spawn = (LevelHandler as any).resolveDungeonExitSpawn(
        client,
        character,
        'CraftTown',
        'CraftTownTutorial',
        null
    );

    assert.deepEqual(spawn, { x: -6886, y: 1623, hasCoord: true });
}

function testResolveDungeonExitSpawnIgnoresStaleCraftTownTutorialSavedCoords(): void {
    const client = createClient();
    client.currentLevel = 'CraftTown';

    const character = createCharacter('KeepRunner');
    character.CurrentLevel = { name: 'CraftTownTutorial', x: 19450, y: 980 };
    character.PreviousLevel = { name: 'CraftTownTutorial', x: 19380, y: 960 };

    const spawn = (LevelHandler as any).resolveDungeonExitSpawn(
        client,
        character,
        'CraftTown',
        'CraftTownTutorial',
        null
    );

    assert.deepEqual(spawn, { x: -6886, y: 1623, hasCoord: true });
}

function testCemeteryHillSpawnUsesAuthoredPlayerSpawn(): void {
    const character = createCharacter('HillScout');
    character.CurrentLevel = { name: 'BridgeTown', x: 10400, y: 520 };

    assert.deepEqual(
        LevelConfig.getSpawn('CemeteryHill'),
        { x: 7469, y: 385 },
        'Cemetery Hill should have an authored spawn instead of falling back to the SWF sky origin'
    );

    assert.deepEqual(
        LevelConfig.getSpawnCoordinates(character, 'BridgeTown', 'CemeteryHill'),
        { x: 7469, y: 385, hasCoord: true },
        'BridgeTown -> Cemetery Hill should land beside the Cemetery Hill entrance'
    );
}

function testCemeteryHillZeroSavedCoordsFallBackToAuthoredSpawn(): void {
    const character = createCharacter('HillScout');
    character.CurrentLevel = { name: 'CemeteryHill', x: 0, y: 0 };
    character.PreviousLevel = { name: 'BridgeTown', x: 3944, y: 838 };

    assert.deepEqual(
        LevelConfig.getSpawnCoordinates(character, 'BridgeTown', 'CemeteryHill'),
        { x: 7469, y: 385, hasCoord: true },
        'stale Cemetery Hill (0, 0) saves should not keep centering the camera in the sky'
    );
}

function testEmeraldGladesDreadPortalSpawnsAtGate(): void {
    const character = createCharacter('GladeScout');
    character.CurrentLevel = { name: 'EmeraldGlades', x: 2200, y: 2300 };
    character.PreviousLevel = { name: 'OldMineMountain', x: 18552, y: 4021 };

    assert.deepEqual(
        LevelConfig.getSpawnCoordinates(character, 'EmeraldGlades', 'EmeraldGladesHard', 300),
        { x: 2331, y: 2251, hasCoord: true },
        'Emerald Glades -> Dread Emerald Glades should land at the matching Dreadfold gate'
    );
}

function testEmeraldGladesDreadPortalReturnSpawnsAtGate(): void {
    const character = createCharacter('GladeScout');
    character.CurrentLevel = { name: 'EmeraldGladesHard', x: 2200, y: 2300 };
    character.PreviousLevel = { name: 'OldMineMountainHard', x: 18552, y: 4021 };

    assert.deepEqual(
        LevelConfig.getSpawnCoordinates(character, 'EmeraldGladesHard', 'EmeraldGlades', 300),
        { x: 2331, y: 2251, hasCoord: true },
        'Dread Emerald Glades -> Emerald Glades should land at the matching Dreadfold gate'
    );
}

function testDoorAwareTravelSpawnUsesTargetPortalFromSwfData(): void {
    const character = createCharacter('TravelScout');

    assert.deepEqual(
        LevelConfig.getSpawnCoordinates(character, 'ShazariDesert', 'Castle', 1),
        { x: 16059, y: 1656, hasCoord: true },
        'Shazari Desert door 1 should land at Castle Hocke door 4, not Castle Hocke default spawn'
    );

    assert.deepEqual(
        LevelConfig.getSpawnCoordinates(character, 'ShazariDesertHard', 'CastleHard', 1),
        { x: 16059, y: 1656, hasCoord: true },
        'Dread Shazari Desert door 1 should land at Dread Castle Hocke door 4'
    );

    assert.deepEqual(
        LevelConfig.getSpawnCoordinates(character, 'CemeteryHill', 'BridgeTown', 1),
        { x: 6365, y: 1880, hasCoord: true },
        'Cemetery Hill door 1 should land at Felbridge door 2'
    );

    assert.deepEqual(
        LevelConfig.getSpawnCoordinates(character, 'CemeteryHillHard', 'BridgeTownHard', 1),
        { x: 6365, y: 1880, hasCoord: true },
        'Dread Cemetery Hill door 1 should land at Dread Felbridge door 2'
    );
}

function testDoorAwareTravelSpawnDistinguishesMultipleDoorsToSameMap(): void {
    const character = createCharacter('TravelScout');

    assert.deepEqual(
        LevelConfig.getSpawnCoordinates(character, 'CemeteryHill', 'BridgeTown', 3),
        { x: 13666, y: 500, hasCoord: true },
        'Cemetery Hill door 3 should land at Felbridge door 5 instead of reusing Felbridge door 2/default spawn'
    );

    assert.deepEqual(
        LevelConfig.getSpawnCoordinates(character, 'BridgeTown', 'CemeteryHill', 2),
        { x: 7419, y: 372, hasCoord: true },
        'Felbridge door 2 should land at Cemetery Hill door 1'
    );

    assert.deepEqual(
        LevelConfig.getSpawnCoordinates(character, 'BridgeTown', 'CemeteryHill', 5),
        { x: 19328, y: -1090, hasCoord: true },
        'Felbridge door 5 should land at Cemetery Hill door 3, proving map-level fallback no longer masks the second portal'
    );

    assert.deepEqual(
        LevelConfig.getSpawnCoordinates(character, 'BridgeTownHard', 'CemeteryHillHard', 5),
        { x: 19328, y: -1090, hasCoord: true },
        'Dread Felbridge door 5 should land at Dread Cemetery Hill door 3'
    );
}

function testDoorAwareDreadPortalSpawnUsesTargetPortal(): void {
    const character = createCharacter('DreadScout');

    assert.deepEqual(
        LevelConfig.getSpawnCoordinates(character, 'JadeCity', 'JadeCityHard', 300),
        { x: 19337, y: -682, hasCoord: true },
        'Valhaven Dreadfold gate should land at the matching Dread Valhaven gate instead of the city default spawn'
    );

    assert.deepEqual(
        LevelConfig.getSpawnCoordinates(character, 'JadeCityHard', 'JadeCity', 300),
        { x: 19337, y: -682, hasCoord: true },
        'Dread Valhaven return gate should land at the matching Valhaven gate'
    );
}

function testDoorAwareStoryGatewayOverridesResolvedTargets(): void {
    const character = createCharacter('StoryScout');

    assert.deepEqual(
        LevelConfig.getSpawnCoordinates(character, 'BridgeTown', 'Castle', 3),
        { x: -1280, y: -1940, hasCoord: true },
        'Felbridge Castle Hocke gateway resolves to Castle door 1 after the story gate opens'
    );

    assert.deepEqual(
        LevelConfig.getSpawnCoordinates(character, 'ShazariDesert', 'JadeCity', 2),
        { x: 10399, y: 1043, hasCoord: true },
        'Shazari Valhaven gateway resolves to Jade City door 1 after the story gate opens'
    );

    assert.deepEqual(
        LevelConfig.getSpawnCoordinates(character, 'BridgeTown', 'SwampRoadConnection', 1),
        { x: 10588, y: 456, hasCoord: true },
        'Felbridge Arachnae gateway resolves to Swamp Road Connection door 2 after the story gate opens'
    );
}

function testTravelSpawnWithoutDoorContextUsesSavedOrDefaultTargetSpawn(): void {
    const character = createCharacter('FallbackScout');

    assert.deepEqual(
        LevelConfig.getSpawnCoordinates(character, 'BridgeTown', 'SwampRoadConnection'),
        { x: 0, y: 0, hasCoord: true },
        'without an active source door, travel no longer uses the old manual map-level safety fallback'
    );
}

function testResolvedTransferUsesDoorAwareSpawnOnlyForActiveDoorTarget(): void {
    const character = createCharacter('TransferScout');
    const client = createClient();
    client.currentLevel = 'ShazariDesert';
    client.lastDoorId = 1;
    client.lastDoorTargetLevel = 'Castle';

    assert.deepEqual(
        (LevelHandler as any).resolveDungeonExitSpawn(client, character, 'ShazariDesert', 'Castle', null),
        { x: 16059, y: 1656, hasCoord: true },
        'active Shazari Desert door transfer should use the matching Castle Hocke portal spawn'
    );

    client.currentLevel = 'BridgeTown';
    client.lastDoorId = 5;
    client.lastDoorTargetLevel = 'Castle';

    assert.deepEqual(
        (LevelHandler as any).resolveDungeonExitSpawn(client, character, 'BridgeTown', 'SwampRoadConnection', null),
        { x: 0, y: 0, hasCoord: true },
        'a stale lastDoorId must not act as a door-aware spawn when it does not target this transfer'
    );
}

function testRecoveredTransferTokenPreservesDoorTravelContext(): void {
    const character = createCharacter('RecoveredValhavenRunner');
    character.CurrentLevel = { name: 'JadeCity', x: 10399, y: 1043 };
    GlobalState.usedTransferTokens.set(6200, {
        character,
        userId: 41,
        targetLevel: 'JadeCity',
        previousLevel: 'CraftTown',
        sourceDoorId: 300,
        sourceDoorLevel: 'JadeCity',
        sourceDoorTargetLevel: 'JadeCityHard'
    });

    const recoveredClient = createClient();
    const recovered = (LevelHandler as any).recoverTransferSessionState(recoveredClient, 6200);

    assert.ok(recovered);
    assert.equal(recoveredClient.currentLevel, 'JadeCity');
    assert.equal(recoveredClient.lastDoorId, 300);
    assert.equal(recoveredClient.lastDoorTargetLevel, 'JadeCityHard');
    assert.deepEqual(
        (LevelHandler as any).resolveDungeonExitSpawn(
            recoveredClient,
            character,
            'JadeCity',
            'JadeCityHard',
            null
        ),
        { x: 19337, y: -682, hasCoord: true },
        'a transfer recovered on a new socket should still use the fixed door 300 portal spawn'
    );
}

function testCemeteryHillGeneralSvenDoorTargetsMiniMission9(): void {
    const client = createClient();
    client.currentLevel = 'CemeteryHill';
    client.character = createCharacter('HillRunner');
    client.character.CurrentLevel = { name: 'CemeteryHill', x: 12000, y: 900 };
    const missionDef = MissionLoader.findPrimaryMissionByDungeon('CH_MiniMission9');
    assert.ok(missionDef);
    client.character.missions = {
        [String(missionDef.MissionID)]: {
            state: 1,
            currCount: 0
        }
    };

    assert.equal(LevelConfig.has('CH_MiniMission9'), true, 'General Sven Hocke dungeon must exist in level_config');
    assert.equal(LevelConfig.isDungeonLevel('CH_MiniMission9'), true, 'General Sven Hocke should be treated as a dungeon');

    LevelHandler.handleOpenDoor(client as never, createOpenDoorPacket(209));

    assert.equal(client.lastDoorId, 209);
    assert.equal(
        client.lastDoorTargetLevel,
        'CH_MiniMission9',
        'Cemetery Hill door 209 should start a transfer to General Sven Hocke, not fall back to CemeteryHill'
    );
    const doorTargetPacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x2E);
    assert.ok(doorTargetPacket);
    assert.deepEqual(parseDoorTargetPacket(doorTargetPacket.payload), {
        doorId: 209,
        target: 'CH_MiniMission9'
    });
}

function testDreadHopeSpringsDoorTargetsHardMission4(): void {
    const client = createClient();
    client.currentLevel = 'EmeraldGladesHard';
    client.character = createCharacter('DreadGladeRunner');
    client.character.CurrentLevel = { name: 'EmeraldGladesHard', x: 7800, y: 640 };
    client.character.missions = {
        [String(MissionID.HopeSpringsEternalHard)]: {
            state: 1,
            currCount: 0
        }
    };

    assert.equal(LevelConfig.has('EG_Mission4Hard'), true, 'Dread Hope Springs Eternal dungeon must exist in level_config');
    assert.equal(LevelConfig.isDungeonLevel('EG_Mission4Hard'), true, 'Dread Hope Springs Eternal should be treated as a dungeon');

    LevelHandler.handleOpenDoor(client as never, createOpenDoorPacket(104));

    assert.equal(client.lastDoorId, 104);
    assert.equal(
        client.lastDoorTargetLevel,
        'EG_Mission4Hard',
        'Dread Emerald Glades door 104 should start a transfer to Dread Hope Springs Eternal'
    );
    const doorTargetPacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x2E);
    assert.ok(doorTargetPacket);
    assert.deepEqual(parseDoorTargetPacket(doorTargetPacket.payload), {
        doorId: 104,
        target: 'EG_Mission4Hard'
    });
}

async function testDreadHopeSpringsTransferRequestEntersHardMission4(): Promise<void> {
    const client = createClient();
    client.token = 4104;
    client.currentLevel = 'EmeraldGladesHard';
    client.lastDoorId = 104;
    client.lastDoorTargetLevel = 'EG_Mission4Hard';
    client.character = createCharacter('DreadGladeRunner');
    client.character.CurrentLevel = { name: 'EmeraldGladesHard', x: 7800, y: 640 };
    client.character.missions = {
        [String(MissionID.HopeSpringsEternalHard)]: {
            state: 1,
            currCount: 0
        }
    };

    await LevelHandler.handleLevelTransferRequest(
        client as never,
        createLevelTransferPacket(4104, 'EG_Mission4Hard')
    );

    const enterWorldPacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x21);
    assert.ok(enterWorldPacket, 'accepted Dread Hope Springs transfer should send an enter-world packet');
    assert.equal(
        parseEnterWorldLevelPacket(enterWorldPacket.payload).internalName,
        'EG_Mission4Hard',
        'accepted Dread Hope Springs transfer should enter the hard dungeon instead of reloading Dread Emerald Glades'
    );
}

async function testDreadHopeSpringsTransferRequestRecoversFromCurrentLevelEcho(): Promise<void> {
    const client = createClient();
    client.token = 4105;
    client.currentLevel = 'EmeraldGladesHard';
    client.lastDoorId = 104;
    client.lastDoorTargetLevel = 'EG_Mission4Hard';
    client.character = createCharacter('DreadGladeRunner');
    client.character.CurrentLevel = { name: 'EmeraldGladesHard', x: 7800, y: 640 };
    client.character.missions = {
        [String(MissionID.HopeSpringsEternalHard)]: {
            state: 1,
            currCount: 0
        }
    };

    await LevelHandler.handleLevelTransferRequest(
        client as never,
        createLevelTransferPacket(4105, 'EmeraldGladesHard')
    );

    const enterWorldPacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x21);
    assert.ok(enterWorldPacket, 'current-level echoes after dungeon doors should still send an enter-world packet');
    assert.equal(
        parseEnterWorldLevelPacket(enterWorldPacket.payload).internalName,
        'EG_Mission4Hard',
        'current-level echoes after Dread Hope Springs should recover to the last accepted dungeon door target'
    );
}

async function testDreadValhavenGateTransferUsesDoorPortalSpawn(): Promise<void> {
    GlobalState.pendingWorld.clear();
    GlobalState.tokenChar.clear();

    const client = createClient();
    client.token = 4106;
    client.currentLevel = 'JadeCity';
    client.clientEntID = 9106;
    client.lastDoorId = 300;
    client.lastDoorTargetLevel = 'JadeCityHard';
    client.character = createCharacter('ValhavenRunner');
    client.character.CurrentLevel = { name: 'JadeCityHard', x: 10399, y: 1043 };
    client.character.PreviousLevel = { name: 'JadeCity', x: 10399, y: 1043 };
    client.character.missions = {
        [String(MissionID.Capstone)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        [String(MissionID.HeadToValhavenHard)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        }
    };
    client.entities.set(9106, { id: 9106, x: 10399, y: 1043 });

    await LevelHandler.handleLevelTransferRequest(
        client as never,
        createLevelTransferPacket(4106, 'JadeCityHard')
    );

    assert.deepEqual(
        client.character.CurrentLevel,
        { name: 'JadeCityHard', x: 19337, y: -682 },
        'Jade City Dreadfold gate should overwrite stale Dread Valhaven entrance saves with the door 300 portal spawn'
    );
}

async function testDreadValhavenGateTransferRecoversFromCurrentLevelEcho(): Promise<void> {
    GlobalState.pendingWorld.clear();
    GlobalState.tokenChar.clear();

    const client = createClient();
    client.token = 4107;
    client.currentLevel = 'JadeCity';
    client.clientEntID = 9107;
    client.lastDoorId = 300;
    client.lastDoorTargetLevel = 'JadeCityHard';
    client.character = createCharacter('ValhavenEchoRunner');
    client.character.CurrentLevel = { name: 'JadeCity', x: 10399, y: 1043 };
    client.character.missions = {
        [String(MissionID.Capstone)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        [String(MissionID.HeadToValhavenHard)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        }
    };
    client.entities.set(9107, { id: 9107, x: 10399, y: 1043 });

    await LevelHandler.handleLevelTransferRequest(
        client as never,
        createLevelTransferPacket(4107, 'JadeCity')
    );

    const enterWorldPacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x21);
    assert.ok(enterWorldPacket, 'current-level echo after the Valhaven Dreadfold gate should still transfer');
    assert.equal(
        parseEnterWorldLevelPacket(enterWorldPacket.payload).internalName,
        'JadeCityHard',
        'current-level echoes after the Valhaven Dreadfold gate should recover to Dread Valhaven'
    );

    assert.deepEqual(
        client.character.CurrentLevel,
        { name: 'JadeCityHard', x: 19337, y: -682 },
        'current-level echo after the Valhaven Dreadfold gate should still save the door 300 portal spawn'
    );
}

function testLockedDungeonDoorReportsLockedAndDoesNotOpen(): void {
    const client = createClient();
    client.currentLevel = 'CemeteryHill';
    client.clientEntID = 451;
    client.character = createCharacter('HillRunner');
    client.character.CurrentLevel = { name: 'CemeteryHill', x: 12000, y: 900 };

    LevelHandler.handleRequestDoorState(client as never, createDoorStateRequestPacket(209));

    const doorStatePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x42);
    assert.ok(doorStatePacket);
    assert.deepEqual(parseDoorStatePacket(doorStatePacket.payload), {
        doorId: 209,
        state: 4,
        target: 'CH_MiniMission9'
    });

    client.sentPackets.length = 0;
    LevelHandler.handleOpenDoor(client as never, createOpenDoorPacket(209));

    assert.equal(client.lastDoorId, -1);
    assert.equal(client.lastDoorTargetLevel, '');
    assert.equal(
        client.sentPackets.some((packet: { id: number }) => packet.id === 0x2E),
        false,
        'locked dungeon door must not start a transfer'
    );
    const blockedDoorStatePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x42);
    assert.ok(blockedDoorStatePacket);
    assert.deepEqual(parseDoorStatePacket(blockedDoorStatePacket.payload), {
        doorId: 209,
        state: 4,
        target: 'CH_MiniMission9'
    });
    const lockedDialoguePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x76);
    assert.ok(lockedDialoguePacket);
    assert.deepEqual(parseRoomThoughtPacket(lockedDialoguePacket.payload), {
        entityId: 451,
        text: "^tI haven't unlocked this dungeon yet."
    });
}

async function testLockedDungeonTransferRequestIsBlocked(): Promise<void> {
    const client = createClient();
    client.token = 3001;
    client.currentLevel = 'CemeteryHill';
    client.lastDoorId = 209;
    client.lastDoorTargetLevel = 'CH_MiniMission9';
    client.clientEntID = 451;
    client.character = createCharacter('HillRunner');
    client.character.CurrentLevel = { name: 'CemeteryHill', x: 12000, y: 900 };

    await LevelHandler.handleLevelTransferRequest(
        client as never,
        createLevelTransferPacket(3001, 'CH_MiniMission9')
    );

    assert.equal(
        client.sentPackets.some((packet: { id: number }) => packet.id === 0x21),
        false,
        'locked dungeon transfer request must not send an enter-world packet'
    );
    const lockedDialoguePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x76);
    assert.ok(lockedDialoguePacket);
    assert.deepEqual(parseRoomThoughtPacket(lockedDialoguePacket.payload), {
        entityId: 451,
        text: "^tI haven't unlocked this dungeon yet."
    });
}

async function testPartyTeleportCanJoinLockedDungeonTransfer(): Promise<void> {
    const client = createClient();
    client.token = 3002;
    client.userId = 42;
    client.currentLevel = 'CemeteryHill';
    client.lastDoorId = 0;
    client.lastDoorTargetLevel = 'CH_MiniMission9';
    client.clientEntID = 452;
    client.character = createCharacter('HillPartyJoiner');
    client.character.CurrentLevel = { name: 'CemeteryHill', x: 12100, y: 910 };

    GlobalState.pendingTeleports.set(client.token, {
        targetLevel: 'CH_MiniMission9',
        levelInstanceId: 'party-dungeon-join',
        x: 8800,
        y: 500,
        hasCoord: true,
        syncAnchorToken: 3003,
        syncAnchorCharacterName: 'HillPartyLeader',
        syncRoomId: 2,
        syncStartedRoomIds: [0, 2],
        syncQuestProgress: 25
    });

    await LevelHandler.handleLevelTransferRequest(
        client as never,
        createLevelTransferPacket(3002, 'CH_MiniMission9')
    );

    const enterWorldPacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x21);
    assert.ok(
        enterWorldPacket,
        'party teleport into an existing dungeon should bypass the starter unlock gate'
    );
    assert.equal(parseEnterWorldLevelPacket(enterWorldPacket.payload).internalName, 'CH_MiniMission9');

    const pendingTransfer = Array.from(GlobalState.pendingWorld.values()).find((entry) =>
        entry.character?.name === 'HillPartyJoiner' &&
        entry.targetLevel === 'CH_MiniMission9'
    );
    assert.ok(pendingTransfer, 'party join transfer should store reconnect state for the dungeon world');
    assert.equal(pendingTransfer?.levelInstanceId, 'party-dungeon-join');
    assert.equal(pendingTransfer?.syncRoomId, 2);
    assert.deepEqual(pendingTransfer?.syncStartedRoomIds, [0, 2]);
}

function testRecoverTransferSessionStateRepairsCraftTownEntryLoop(): void {
    const client = createClient();
    const character = createCharacter('KeepRunner');
    character.CurrentLevel = { name: 'CraftTown', x: 918, y: 1440 };
    character.PreviousLevel = { name: 'WolfsEnd', x: 1210, y: 880 };

    GlobalState.usedTransferTokens.set(61234, {
        character,
        userId: 41,
        targetLevel: 'CraftTown',
        previousLevel: 'CraftTown'
    });

    const recovered = (LevelHandler as any).recoverTransferSessionState(client, 61234);

    assert.ok(recovered);
    assert.equal(client.currentLevel, 'CraftTown');
    assert.equal(client.entryLevel, 'NewbieRoad');
}

function testCraftTownDoorFallsBackToPreviousOverworld(): void {
    const client = createClient();
    client.currentLevel = 'CraftTown';
    client.entryLevel = 'CraftTown';
    client.character = createCharacter('KeepRunner');
    client.character.PreviousLevel = { name: 'WolfsEnd', x: 1210, y: 880 };

    LevelHandler.handleOpenDoor(client as never, createOpenDoorPacket(0));

    assert.equal(client.lastDoorId, 0);
    assert.equal(client.lastDoorTargetLevel, 'NewbieRoad');
}

function testCraftTownDoor999FallsBackToPreviousOverworldAfterKeepCompletion(): void {
    const client = createClient();
    client.currentLevel = 'CraftTown';
    client.entryLevel = 'NewbieRoad';
    client.character = createCharacter('KeepRunner');
    client.character.CurrentLevel = { name: 'CraftTown', x: 918, y: 1440 };
    client.character.PreviousLevel = { name: 'WolfsEnd', x: 1210, y: 880 };
    client.character.missions = {
        '5': {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        }
    };

    LevelHandler.handleOpenDoor(client as never, createOpenDoorPacket(999));

    assert.equal(client.lastDoorId, 999);
    assert.equal(client.lastDoorTargetLevel, 'NewbieRoad');
}

function testHomeTransferRedirectsToKeepTutorialWhileQuestActive(): void {
    const client = createClient();
    client.character = createCharacter('KeepRunner');
    client.character.missions = {
        '5': {
            state: 1,
            currCount: 0
        }
    };

    const resolved = (LevelHandler as any).resolveKeepTutorialTransferTarget(client, 'CraftTown');

    assert.equal(resolved, 'CraftTownTutorial');
}

function testHomeTransferStaysInCraftTownAfterKeepQuestCompletion(): void {
    const client = createClient();
    client.character = createCharacter('KeepRunner');
    client.character.missions = {
        '5': {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        }
    };

    const resolved = (LevelHandler as any).resolveKeepTutorialTransferTarget(client, 'CraftTown');

    assert.equal(resolved, 'CraftTown');
}

function testCraftTownTutorialDoorFallsBackToPreviousOverworld(): void {
    const client = createClient();
    client.currentLevel = 'CraftTownTutorial';
    client.entryLevel = 'NewbieRoad';
    client.character = createCharacter('KeepRunner');
    client.character.CurrentLevel = { name: 'CraftTown', x: 918, y: 1440 };
    client.character.PreviousLevel = { name: 'WolfsEnd', x: 1210, y: 880 };

    LevelHandler.handleOpenDoor(client as never, createOpenDoorPacket(0));

    assert.equal(client.lastDoorId, 0);
    assert.equal(client.lastDoorTargetLevel, 'NewbieRoad');
}

function testFelbridgeDreadGateRequiresCapstoneClaim(): void {
    const client = createClient();
    client.currentLevel = 'BridgeTown';
    client.clientEntID = 451;
    client.character = createCharacter('FelbridgeRunner');
    client.character.level = 50;

    LevelHandler.handleRequestDoorState(client as never, createDoorStateRequestPacket(300));

    const doorStatePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x42);
    assert.ok(doorStatePacket);
    assert.deepEqual(parseDoorStatePacket(doorStatePacket.payload), {
        doorId: 300,
        state: 4,
        target: 'BridgeTownHard'
    });

    client.sentPackets.length = 0;
    LevelHandler.handleOpenDoor(client as never, createOpenDoorPacket(300));

    assert.equal(client.lastDoorId, -1);
    assert.equal(client.lastDoorTargetLevel, '');
    assert.equal(
        client.sentPackets.some((packet: { id: number }) => packet.id === 0x2E),
        false,
        'locked Felbridge dread gate must not start a transfer'
    );
    const blockedDoorStatePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x42);
    assert.ok(blockedDoorStatePacket);
    assert.deepEqual(parseDoorStatePacket(blockedDoorStatePacket.payload), {
        doorId: 300,
        state: 4,
        target: 'BridgeTownHard'
    });
    const lockedDialoguePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x76);
    assert.ok(lockedDialoguePacket);
    assert.deepEqual(parseRoomThoughtPacket(lockedDialoguePacket.payload), {
        entityId: 451,
        text: '^tA powerful magic seals this entrance.=^tI still need to learn more about the Sleeping Lands.'
    });
}

function testFelbridgeDreadGateReadyToTurnInDoesNotUnlock(): void {
    const client = createClient();
    client.currentLevel = 'BridgeTown';
    client.character = createCharacter('FelbridgeRunner');
    client.character.missions = {
        [String(MissionID.Capstone)]: {
            state: 2,
            currCount: 1
        }
    };

    LevelHandler.handleRequestDoorState(client as never, createDoorStateRequestPacket(300));

    const doorStatePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x42);
    assert.ok(doorStatePacket);
    assert.deepEqual(parseDoorStatePacket(doorStatePacket.payload), {
        doorId: 300,
        state: 4,
        target: 'BridgeTownHard'
    });
}

function testFelbridgeDreadGateOpensAfterCapstoneClaimedWithoutLevelRequirement(): void {
    const client = createClient();
    client.currentLevel = 'BridgeTown';
    client.character = createCharacter('FelbridgeRunner');
    client.character.level = 1;
    client.character.missions = {
        [String(MissionID.Capstone)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        }
    };

    LevelHandler.handleRequestDoorState(client as never, createDoorStateRequestPacket(300));

    const doorStatePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x42);
    assert.ok(doorStatePacket);
    assert.deepEqual(parseDoorStatePacket(doorStatePacket.payload), {
        doorId: 300,
        state: 1,
        target: 'BridgeTownHard'
    });

    client.sentPackets.length = 0;
    LevelHandler.handleOpenDoor(client as never, createOpenDoorPacket(300));

    assert.equal(client.lastDoorId, 300);
    assert.equal(client.lastDoorTargetLevel, 'BridgeTownHard');
    assert.equal(client.sentPackets.some((packet: { id: number }) => packet.id === 0x2E), true);
}

function testOtherDreadfoldGatesRequireCapstoneClaim(): void {
    const dreadfoldEntries = [
        { currentLevel: 'EmeraldGlades', targetLevel: 'EmeraldGladesHard' },
        { currentLevel: 'ShazariDesert', targetLevel: 'ShazariDesertHard' },
        { currentLevel: 'JadeCity', targetLevel: 'JadeCityHard' }
    ];

    for (const entry of dreadfoldEntries) {
        const client = createClient();
        client.currentLevel = entry.currentLevel;
        client.clientEntID = 451;
        client.character = createCharacter(`${entry.currentLevel}Runner`);
        client.character.level = 50;

        LevelHandler.handleRequestDoorState(client as never, createDoorStateRequestPacket(300));

        const doorStatePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x42);
        assert.ok(doorStatePacket);
        assert.deepEqual(parseDoorStatePacket(doorStatePacket.payload), {
            doorId: 300,
            state: 4,
            target: entry.targetLevel
        });

        client.sentPackets.length = 0;
        LevelHandler.handleOpenDoor(client as never, createOpenDoorPacket(300));

        assert.equal(client.lastDoorId, -1);
        assert.equal(client.lastDoorTargetLevel, '');
        assert.equal(
            client.sentPackets.some((packet: { id: number }) => packet.id === 0x2E),
            false,
            `${entry.currentLevel} dread gate must not start a transfer before Capstone is claimed`
        );
    }
}

function testOtherDreadfoldGatesOpenAfterCapstoneClaimedWithoutLevelRequirement(): void {
    const dreadfoldEntries = [
        { currentLevel: 'EmeraldGlades', targetLevel: 'EmeraldGladesHard' },
        { currentLevel: 'ShazariDesert', targetLevel: 'ShazariDesertHard' }
    ];

    for (const entry of dreadfoldEntries) {
        const client = createClient();
        client.currentLevel = entry.currentLevel;
        client.character = createCharacter(`${entry.currentLevel}Runner`);
        client.character.level = 1;
        client.character.missions = {
            [String(MissionID.Capstone)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1
            }
        };

        LevelHandler.handleRequestDoorState(client as never, createDoorStateRequestPacket(300));

        const doorStatePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x42);
        assert.ok(doorStatePacket);
        assert.deepEqual(parseDoorStatePacket(doorStatePacket.payload), {
            doorId: 300,
            state: 1,
            target: entry.targetLevel
        });

        client.sentPackets.length = 0;
        LevelHandler.handleOpenDoor(client as never, createOpenDoorPacket(300));

        assert.equal(client.lastDoorId, 300);
        assert.equal(client.lastDoorTargetLevel, entry.targetLevel);
        assert.equal(client.sentPackets.some((packet: { id: number }) => packet.id === 0x2E), true);
    }
}

function testDreadStoryAreaDoorsRequireClaimedStoryMission(): void {
    const storyAreaEntries = [
        {
            currentLevel: 'BridgeTownHard',
            doorId: 2,
            targetLevel: 'CemeteryHillHard',
            requiredMissionId: MissionID.OldHeroesNeverDieHard
        },
        {
            currentLevel: 'BridgeTownHard',
            doorId: 5,
            targetLevel: 'CemeteryHillHard',
            requiredMissionId: MissionID.OldHeroesNeverDieHard
        },
        {
            currentLevel: 'BridgeTownHard',
            doorId: 6,
            targetLevel: 'OldMineMountainHard',
            requiredMissionId: MissionID.DerelictionOfDutyHard
        }
    ];

    for (const entry of storyAreaEntries) {
        const client = createClient();
        client.currentLevel = entry.currentLevel;
        client.clientEntID = 451;
        client.character = createCharacter(`${entry.targetLevel}Runner`);
        client.character.level = 50;

        LevelHandler.handleRequestDoorState(client as never, createDoorStateRequestPacket(entry.doorId));

        const lockedDoorStatePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x42);
        assert.ok(lockedDoorStatePacket);
        assert.deepEqual(parseDoorStatePacket(lockedDoorStatePacket.payload), {
            doorId: entry.doorId,
            state: 4,
            target: entry.targetLevel
        });

        client.sentPackets.length = 0;
        client.character.missions = {
            [String(entry.requiredMissionId)]: {
                state: 2,
                currCount: 1
            }
        };

        LevelHandler.handleOpenDoor(client as never, createOpenDoorPacket(entry.doorId));

        assert.equal(client.lastDoorId, -1);
        assert.equal(client.lastDoorTargetLevel, '');
        assert.equal(
            client.sentPackets.some((packet: { id: number }) => packet.id === 0x2E),
            false,
            `${entry.targetLevel} door must not open while its story mission is only ready to turn in`
        );
        const blockedDialoguePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x76);
        assert.ok(blockedDialoguePacket);
        assert.deepEqual(parseRoomThoughtPacket(blockedDialoguePacket.payload), {
            entityId: 451,
            text: "^tI haven't unlocked this area yet."
        });

        client.sentPackets.length = 0;
        client.character.missions[String(entry.requiredMissionId)] = {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        };

        LevelHandler.handleRequestDoorState(client as never, createDoorStateRequestPacket(entry.doorId));

        const openDoorStatePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x42);
        assert.ok(openDoorStatePacket);
        assert.deepEqual(parseDoorStatePacket(openDoorStatePacket.payload), {
            doorId: entry.doorId,
            state: 1,
            target: entry.targetLevel
        });

        client.sentPackets.length = 0;
        LevelHandler.handleOpenDoor(client as never, createOpenDoorPacket(entry.doorId));

        assert.equal(client.lastDoorId, entry.doorId);
        assert.equal(client.lastDoorTargetLevel, entry.targetLevel);
        assert.equal(client.sentPackets.some((packet: { id: number }) => packet.id === 0x2E), true);
    }
}

async function testDreadStoryAreaTransferRequestRequiresClaimedStoryMission(): Promise<void> {
    const storyAreaTransfers = [
        {
            currentLevel: 'BridgeTownHard',
            doorId: 2,
            targetLevel: 'CemeteryHillHard',
            requiredMissionId: MissionID.OldHeroesNeverDieHard
        },
        {
            currentLevel: 'BridgeTownHard',
            doorId: 6,
            targetLevel: 'OldMineMountainHard',
            requiredMissionId: MissionID.DerelictionOfDutyHard
        }
    ];

    for (const entry of storyAreaTransfers) {
        const client = createClient();
        client.token = 4400 + entry.doorId;
        client.currentLevel = entry.currentLevel;
        client.clientEntID = 451;
        client.lastDoorId = entry.doorId;
        client.lastDoorTargetLevel = entry.targetLevel;
        client.character = createCharacter(`${entry.targetLevel}TransferRunner`);
        client.character.level = 50;
        client.character.CurrentLevel = { name: entry.currentLevel, x: 0, y: 0 };

        await LevelHandler.handleLevelTransferRequest(
            client as never,
            createLevelTransferPacket(client.token, entry.targetLevel)
        );

        assert.equal(
            client.sentPackets.some((packet: { id: number }) => packet.id === 0x21),
            false,
            `${entry.targetLevel} transfer request must be blocked before its story mission is claimed`
        );
        const blockedDialoguePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x76);
        assert.ok(blockedDialoguePacket);
        assert.deepEqual(parseRoomThoughtPacket(blockedDialoguePacket.payload), {
            entityId: 451,
            text: "^tI haven't unlocked this area yet."
        });

        client.sentPackets.length = 0;
        client.character.missions = {
            [String(entry.requiredMissionId)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1
            }
        };

        await LevelHandler.handleLevelTransferRequest(
            client as never,
            createLevelTransferPacket(client.token, entry.targetLevel)
        );

        assert.equal(
            client.sentPackets.some((packet: { id: number }) => packet.id === 0x21),
            true,
            `${entry.targetLevel} transfer request should proceed after its story mission is claimed`
        );
    }
}

function testValhavenDreadGateRequiresHardShazariProgression(): void {
    const client = createClient();
    client.currentLevel = 'JadeCity';
    client.character = createCharacter('ValhavenRunner');
    client.character.level = 50;
    client.character.missions = {
        [String(MissionID.Capstone)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        }
    };

    LevelHandler.handleRequestDoorState(client as never, createDoorStateRequestPacket(300));

    const lockedDoorStatePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x42);
    assert.ok(lockedDoorStatePacket);
    assert.deepEqual(parseDoorStatePacket(lockedDoorStatePacket.payload), {
        doorId: 300,
        state: 4,
        target: 'JadeCityHard'
    });

    client.sentPackets.length = 0;
    client.character.missions[String(MissionID.HeadToValhavenHard)] = {
        state: 3,
        currCount: 1,
        claimed: 1,
        complete: 1
    };

    LevelHandler.handleRequestDoorState(client as never, createDoorStateRequestPacket(300));

    const openDoorStatePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x42);
    assert.ok(openDoorStatePacket);
    assert.deepEqual(parseDoorStatePacket(openDoorStatePacket.payload), {
        doorId: 300,
        state: 1,
        target: 'JadeCityHard'
    });
}

function testDreadfoldReturnGatesStayOpenWithoutCapstone(): void {
    const dreadfoldReturns = [
        { currentLevel: 'BridgeTownHard', targetLevel: 'BridgeTown' },
        { currentLevel: 'EmeraldGladesHard', targetLevel: 'EmeraldGlades' },
        { currentLevel: 'ShazariDesertHard', targetLevel: 'ShazariDesert' },
        { currentLevel: 'JadeCityHard', targetLevel: 'JadeCity' }
    ];

    for (const entry of dreadfoldReturns) {
        const client = createClient();
        client.currentLevel = entry.currentLevel;
        client.character = createCharacter(`${entry.currentLevel}Runner`);

        LevelHandler.handleRequestDoorState(client as never, createDoorStateRequestPacket(300));

        const doorStatePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x42);
        assert.ok(doorStatePacket);
        assert.deepEqual(parseDoorStatePacket(doorStatePacket.payload), {
            doorId: 300,
            state: 1,
            target: entry.targetLevel
        });
    }
}

function testMindlessQueenDungeonRequiresAcceptedMission(): void {
    const testCases = [
        { currentLevel: 'SwampRoadNorth', targetLevel: 'SRN_Mission6', missionId: MissionID.SlayMindlessQueen },
        { currentLevel: 'SwampRoadNorthHard', targetLevel: 'SRN_Mission6Hard', missionId: MissionID.SlayMindlessQueenHard }
    ];

    for (const testCase of testCases) {
        const client = createClient();
        client.currentLevel = testCase.currentLevel;
        client.character = createCharacter(`${testCase.currentLevel}MindlessRunner`);
        client.character.level = 50;
        client.character.missions = {};

        LevelHandler.handleRequestDoorState(client as never, createDoorStateRequestPacket(106));

        const lockedDoorStatePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x42);
        assert.ok(lockedDoorStatePacket);
        assert.deepEqual(parseDoorStatePacket(lockedDoorStatePacket.payload), {
            doorId: 106,
            state: 4,
            target: testCase.targetLevel
        });

        client.sentPackets.length = 0;
        client.character.missions[String(testCase.missionId)] = {
            state: 1,
            currCount: 0
        };

        LevelHandler.handleRequestDoorState(client as never, createDoorStateRequestPacket(106));

        const openDoorStatePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x42);
        assert.ok(openDoorStatePacket);
        assert.deepEqual(parseDoorStatePacket(openDoorStatePacket.payload), {
            doorId: 106,
            state: 2,
            target: testCase.targetLevel
        });
    }
}

function testCompletedDungeonDoorShowsRepeatWithoutSavedTier(): void {
    const client = createClient();
    client.currentLevel = 'OldMineMountain';
    client.character = createCharacter('ForgeRunner');
    client.character.missions = {
        [String(MissionID.ForgottenForge)]: {
            state: 2,
            currCount: 1
        }
    };

    LevelHandler.handleRequestDoorState(client as never, createDoorStateRequestPacket(106));

    const doorStatePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x42);
    assert.ok(doorStatePacket);
    assert.deepEqual(parseDoorStatePacket(doorStatePacket.payload), {
        doorId: 106,
        state: 3,
        target: 'OMM_Mission6',
        stars: 1
    });
}

function testUnlockedForgottenForgeDoorOpensWithoutPersistedMission(): void {
    const client = createClient();
    client.currentLevel = 'OldMineMountain';
    client.character = createCharacter('ForgeRunner');
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

    LevelHandler.handleRequestDoorState(client as never, createDoorStateRequestPacket(106));

    const doorStatePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x42);
    assert.ok(doorStatePacket);
    assert.deepEqual(parseDoorStatePacket(doorStatePacket.payload), {
        doorId: 106,
        state: 2,
        target: 'OMM_Mission6'
    });

    client.sentPackets.length = 0;
    LevelHandler.handleOpenDoor(client as never, createOpenDoorPacket(106));

    assert.equal(client.lastDoorId, 106);
    assert.equal(client.lastDoorTargetLevel, 'OMM_Mission6');
    assert.equal(client.sentPackets.some((packet: { id: number }) => packet.id === 0x2E), true);
    assert.equal(
        client.character.missions[String(MissionID.ForgottenForge)],
        undefined,
        'opening an unlocked map dungeon should not persist a fake Forgotten Forge mission'
    );
}

function testUnearthingThePastDoorRequiresAcceptedSigginMission(): void {
    const client = createClient();
    client.currentLevel = 'ShazariDesert';
    client.character = createCharacter('SigginRunner');
    client.character.missions = {
        [String(MissionID.DeliverToSwamp)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        [String(MissionID.Capstone)]: {
            state: 3,
            currCount: 1,
            claimed: 1,
            complete: 1
        },
        [String(MissionID.IntoTheDepths)]: {
            state: 2,
            currCount: 0
        }
    };

    LevelHandler.handleRequestDoorState(client as never, createDoorStateRequestPacket(101));

    let doorStatePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x42);
    assert.ok(doorStatePacket);
    assert.deepEqual(parseDoorStatePacket(doorStatePacket.payload), {
        doorId: 101,
        state: 4,
        target: 'SD_Mission1'
    });

    client.sentPackets.length = 0;
    LevelHandler.handleOpenDoor(client as never, createOpenDoorPacket(101));

    assert.equal(client.lastDoorId, -1, 'Shazari first dungeon door should not transfer before Siggin assigns it');
    assert.equal(client.lastDoorTargetLevel, '');
    assert.equal(client.sentPackets.some((packet: { id: number }) => packet.id === 0x2E), false);

    client.character.missions[String(MissionID.TempleOfShadows)] = {
        state: 1,
        currCount: 0
    };

    client.sentPackets.length = 0;
    LevelHandler.handleRequestDoorState(client as never, createDoorStateRequestPacket(101));

    doorStatePacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x42);
    assert.ok(doorStatePacket);
    assert.deepEqual(parseDoorStatePacket(doorStatePacket.payload), {
        doorId: 101,
        state: 2,
        target: 'SD_Mission1'
    });
}

function testDisconnectRecoverySnapshotRepairsCraftTownEntryLoop(): void {
    const client = new Client(
        new net.Socket(),
        {
            handle: async () => undefined
        } as never
    );
    const character = createCharacter('Hero');
    character.CurrentLevel = { name: 'CraftTown', x: 918, y: 1440 };
    character.PreviousLevel = { name: 'WolfsEnd', x: 1210, y: 880 };

    client.userId = 41;
    client.authenticated = true;
    client.character = character;
    client.characters = [character];
    client.token = 18390;
    client.currentLevel = 'CraftTown';
    client.entryLevel = 'CraftTown';

    const snapshot = (client as any).createSessionCleanupSnapshot();
    (client as any).preserveTransferRecoveryState(snapshot);

    assert.equal(GlobalState.usedTransferTokens.get(18390)?.targetLevel, 'CraftTown');
    assert.equal(GlobalState.usedTransferTokens.get(18390)?.previousLevel, 'NewbieRoad');
    assert.equal(GlobalState.usedTransferTokens.get(18390)?.syncEntryLevel, 'NewbieRoad');
}

function testBuildTransferSyncStatePrefersEarliestPartyAnchorAcrossActiveAndPending(): void {
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
    assert.equal(syncState.levelInstanceId, 'party-run-early');
    assert.equal(syncState.syncAnchorStartedAt, 1000);
    assert.equal(syncState.syncAnchorToken, 7102);
    assert.equal(syncState.syncAnchorCharacterName, 'Scout');
    assert.equal(syncState.syncRoomId, 9);
    assert.deepEqual(syncState.syncStartedRoomIds, [0, 9]);
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

function testRestoreTransferredRoomProgressReplaysRoomEvents(): void {
    const client = createClient();
    client.currentLevel = 'BridgeTown';

    const restored = LevelHandler.restoreTransferredRoomProgress(client as never, {
        targetLevel: 'BridgeTown',
        syncRoomId: 7,
        syncStartedRoomIds: [1, 7]
    });

    assert.equal(restored, true);
    assert.equal(client.currentRoomId, 7);
    assert.equal(client.startedRoomEvents.has('BridgeTown:1'), true);
    assert.equal(client.startedRoomEvents.has('BridgeTown:7'), true);
    assert.deepEqual(client.sentPackets.map((packet: { id: number }) => packet.id), [0xA5, 0xA5]);
}

function testTutorialDungeonTransferredRoomProgressIsIgnored(): void {
    const client = createClient();
    client.currentLevel = 'TutorialDungeon';

    const restored = LevelHandler.restoreTransferredRoomProgress(client as never, {
        targetLevel: 'TutorialDungeon',
        syncRoomId: 15,
        syncStartedRoomIds: [0, 5, 15]
    });

    assert.equal(restored, false);
    LevelHandler.primeTutorialRoomEvents(client as never);

    assert.equal(client.startedRoomEvents.has('TutorialDungeon:0'), true);
    assert.equal(client.startedRoomEvents.has('TutorialDungeon:1'), true);
    assert.equal(client.startedRoomEvents.has('TutorialDungeon:4'), false);
    assert.deepEqual(client.sentPackets.map((packet: { id: number }) => packet.id), [0xA5, 0xA5]);
}

function testGoblinRiverTransferredRoomProgressIsIgnored(): void {
    const client = createClient();
    client.currentLevel = 'GoblinRiverDungeon';

    const restored = LevelHandler.restoreTransferredRoomProgress(client as never, {
        targetLevel: 'GoblinRiverDungeon',
        syncRoomId: 6,
        syncStartedRoomIds: [0, 3, 6]
    });

    assert.equal(restored, false, 'Goblin River should ignore transferred room-progress replay so every player starts at the intro state');
    assert.equal(client.currentRoomId, 0);
    assert.equal(client.startedRoomEvents.size, 0);
    assert.equal(client.sentPackets.length, 0);
}

function testCraftTownTutorialTransferredRoomProgressIsIgnored(): void {
    const client = createClient();
    client.currentLevel = 'CraftTownTutorial';

    const restored = LevelHandler.restoreTransferredRoomProgress(client as never, {
        targetLevel: 'CraftTownTutorial',
        syncRoomId: 6,
        syncStartedRoomIds: [0, 3, 6]
    });

    assert.equal(
        restored,
        false,
        'I Claim This Keep should ignore transferred room-progress replay so every entry starts at 0%'
    );
    assert.equal(client.currentRoomId, 0);
    assert.equal(client.startedRoomEvents.size, 0);
    assert.equal(client.sentPackets.length, 0);
}

function testPrepareGoblinRiverDungeonEntryStateResetsToIntroBaseline(): void {
    const client = createClient();
    client.currentLevel = 'GoblinRiverDungeon';
    client.currentRoomId = 6;
    client.startedRoomEvents.add('GoblinRiverDungeon:3');
    client.startedRoomEvents.add('GoblinRiverDungeon:6');
    client.character = {
        ...createCharacter('GoblinRunner'),
        questTrackerState: 100
    };

    LevelHandler.prepareGoblinRiverDungeonEntryState(client as never);

    assert.equal(client.currentRoomId, 0);
    assert.equal(client.startedRoomEvents.size, 0);
    assert.equal(client.character.questTrackerState, 11);
}

function testPrepareTutorialDungeonEntryStateResetsToIntroBaseline(): void {
    const client = createClient();
    client.currentLevel = 'TutorialDungeon';
    client.currentRoomId = 6;
    client.startedRoomEvents.add('TutorialDungeon:3');
    client.startedRoomEvents.add('TutorialDungeon:6');
    client.character = {
        ...createCharacter('TutorialRunner'),
        questTrackerState: 100
    };

    LevelHandler.prepareGoblinRiverDungeonEntryState(client as never);

    assert.equal(client.currentRoomId, 0);
    assert.equal(client.startedRoomEvents.size, 0);
    assert.equal(client.character.questTrackerState, 11);
}

function testPrepareCraftTownTutorialEntryStateResetsToIntroBaseline(): void {
    const client = createClient();
    client.currentLevel = 'CraftTownTutorial';
    client.currentRoomId = 6;
    client.startedRoomEvents.add('CraftTownTutorial:3');
    client.startedRoomEvents.add('CraftTownTutorial:6');
    client.character = {
        ...createCharacter('KeepRunner'),
        questTrackerState: 64
    };

    LevelHandler.prepareGoblinRiverDungeonEntryState(client as never);

    assert.equal(client.currentRoomId, 0);
    assert.equal(client.startedRoomEvents.size, 0);
    assert.equal(client.character.questTrackerState, 0);
}

async function testPrepareCraftTownTutorialEntryResetsActiveKeepQuestProgress(): Promise<void> {
    const client = createClient();
    client.currentLevel = 'CraftTownTutorial';
    client.character = {
        ...createCharacter('KeepRunner'),
        questTrackerState: 57,
        missions: {
            '5': {
                state: 1,
                currCount: 1,
                claimed: 1,
                complete: 1
            }
        }
    };

    await LevelHandler.prepareCraftTownTutorialEntry(client as never);

    assert.equal(Number(client.character.missions['5']?.state ?? 0), 1);
    assert.equal(Number(client.character.missions['5']?.currCount ?? 0), 0);
    assert.equal(client.character.missions['5']?.claimed, undefined);
    assert.equal(client.character.missions['5']?.complete, undefined);
    assert.equal(client.character.questTrackerState, 0);
    assert.equal(client.sentPackets.some((packet: { id: number }) => packet.id === 0x85), false);
    assert.equal(client.sentPackets.some((packet: { id: number }) => packet.id === 0xB7), true);
}

function testPrimeTutorialRoomEventsDoesNotConsumeTutorialDungeonTraversal(): void {
    const client = createClient();
    client.token = 8001;
    client.currentLevel = 'TutorialDungeon';
    client.playerSpawned = true;
    GlobalState.sessionsByToken.set(client.token, client as never);

    LevelHandler.primeTutorialRoomEvents(client as never);

    assert.equal(client.startedRoomEvents.has('TutorialDungeon:0'), true);
    assert.equal(client.startedRoomEvents.has('TutorialDungeon:1'), true);
    assert.equal(client.startedRoomEvents.has('TutorialDungeon:4'), false);
    assert.deepEqual(
        client.sentPackets.map((packet: { id: number }) => packet.id),
        [0xA5, 0xA5]
    );
}

function testTutorialDungeonTraversalTutorialStartsOnRoomFourEntry(): void {
    const client = createClient();
    client.token = 8002;
    client.currentLevel = 'TutorialDungeon';
    client.playerSpawned = true;
    GlobalState.sessionsByToken.set(client.token, client as never);

    (LevelHandler as any).cacheRoomId(client, 4);

    assert.equal(client.currentRoomId, 4);
    assert.equal(client.startedRoomEvents.has('TutorialDungeon:4'), true);
    assert.deepEqual(client.sentPackets.map((packet: { id: number }) => packet.id), [0xA5]);
}

function testRoomChangeReassertsMountedState(): void {
    const client = createClient();
    client.token = 8003;
    client.clientEntID = 412;
    client.currentLevel = 'CraftTown';
    client.currentRoomId = 1;
    client.playerSpawned = true;
    client.character = {
        ...createCharacter('MountedHero'),
        equippedMount: 37
    };

    const originalSessionsByToken = GlobalState.sessionsByToken;
    const originalSetTimeout = global.setTimeout;
    GlobalState.sessionsByToken = new Map([[client.token, client as never]]);
    global.setTimeout = ((fn: (...args: any[]) => void) => {
        fn();
        return 0 as any;
    }) as typeof setTimeout;

    try {
        (LevelHandler as any).cacheRoomId(client, 2);
    } finally {
        GlobalState.sessionsByToken = originalSessionsByToken;
        global.setTimeout = originalSetTimeout;
    }

    assert.equal(client.currentRoomId, 2, 'room cache should update the active room id');
    assert.ok(
        Number(client.mountTransferGraceUntil) > Date.now(),
        'room changes should arm mount travel grace for mounted players'
    );

    const mountPackets = client.sentPackets.filter((packet: { id: number; payload: Buffer }) => packet.id === 0xB2);
    assert.ok(mountPackets.length > 0, 'room changes should reassert the equipped mount to the local client');

    const parsed = parseMountEquipPacket(mountPackets[0].payload);
    assert.equal(parsed.entityId, 412);
    assert.equal(parsed.mountId, 37);
}

function testTransferSpawnDoesNotRespawnLocalPlayerEntity(): void {
    const client = createClient();
    client.token = 8005;
    client.userId = 41;
    client.clientEntID = 913;
    client.currentLevel = 'CraftTown';
    client.currentRoomId = 2;
    client.playerSpawned = false;
    client.character = {
        ...createCharacter('PetHero'),
        equippedMount: 37,
        activePet: {
            typeID: 21,
            special_id: 11
        }
    };

    const originalSessionsByToken = GlobalState.sessionsByToken;
    const originalSetTimeout = global.setTimeout;
    GlobalState.sessionsByToken = new Map([[client.token, client as never]]);
    global.setTimeout = ((fn: (...args: any[]) => void) => {
        fn();
        return 0 as any;
    }) as typeof setTimeout;

    try {
        const payload = (EntityHandler as any).buildEntityFullUpdatePayload({
            id: client.clientEntID,
            name: client.character.name,
            isPlayer: true,
            x: 640,
            y: 512,
            v: 0,
            team: 1,
            entState: 0
        });

        EntityHandler.handleEntityFullUpdate(client as never, payload);
    } finally {
        GlobalState.sessionsByToken = originalSessionsByToken;
        global.setTimeout = originalSetTimeout;
    }

    assert.equal(client.playerSpawned, true, 'first spawn should mark the transferred player as spawned');
    const selfEntityPackets = client.sentPackets.filter((packet: { id: number }) => packet.id === 0x0F);
    assert.equal(
        selfEntityPackets.length,
        0,
        'non-extended transfers must not resend the local player entity back to the same client'
    );

    const localEntity = client.entities.get(client.clientEntID);
    assert.equal(localEntity?.activePet?.typeID ?? localEntity?.activePet?.petID, 21);
    assert.equal(localEntity?.activePet?.special_id, 11);
    assert.equal(localEntity?.equippedMount, 37);

    const persistedEntity = GlobalState.levelEntities.get('CraftTown')?.get(client.clientEntID);
    assert.equal(persistedEntity?.activePet?.typeID ?? persistedEntity?.activePet?.petID, 21);
    assert.equal(persistedEntity?.activePet?.special_id, 11);
    assert.equal(persistedEntity?.equippedMount, 37);

    const mountPackets = client.sentPackets.filter((packet: { id: number }) => packet.id === 0xB2);
    assert.ok(mountPackets.length > 0, 'first spawn should still reassert the equipped mount');

    const parsedMount = parseMountEquipPacket(mountPackets[0].payload);
    assert.equal(parsedMount.entityId, 913);
    assert.equal(parsedMount.mountId, 37);
}

async function testDoorTransferIgnoresTransientMountClear(): Promise<void> {
    const client = createClient();
    client.token = 8004;
    client.clientEntID = 412;
    client.userId = 41;
    client.currentLevel = 'CraftTown';
    client.currentRoomId = 1;
    client.playerSpawned = true;
    client.character = {
        ...createCharacter('MountedHero'),
        equippedMount: 37
    };
    client.characters = [client.character];

    const mountClear = new BitBuffer();
    mountClear.writeMethod4(412);
    mountClear.writeMethod6(0, 7);

    LevelHandler.handleOpenDoor(client, createOpenDoorPacket(0));
    await PetHandler.handleMountEquipPacket(client, mountClear.toBuffer());

    assert.equal(client.character.equippedMount, 37, 'door transfers should ignore transient mount clear packets');
    assert.ok(
        Number(client.mountTransferGraceUntil) > Date.now(),
        'door transfers should arm mount travel grace before transient mount clear packets arrive'
    );
}

function testNormalizeMountStateKeepsEquippedMountOwned(): void {
    const character = createCharacter('MountedHero') as any;
    character.mounts = [12, 12];
    character.equippedMount = 37;

    const normalized = PetHandler.normalizeMountState(character);

    assert.deepEqual(normalized, [12, 37]);
    assert.deepEqual(character.mounts, [12, 37]);
}

function testTutorialDungeonDropTutorialStartsRoomFiveOnTraversalInput(): void {
    const client = createClient();
    client.currentLevel = 'TutorialDungeon';
    client.currentRoomId = 4;

    (LevelHandler as any).maybeTriggerTutorialDungeonDropTutorial(client, 7360, 2200, {
        bJumping: true,
        bDropping: false
    });

    assert.equal(client.startedRoomEvents.has('TutorialDungeon:5'), true);
    assert.deepEqual(client.sentPackets.map((packet: { id: number }) => packet.id), [0xA5]);
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

function testDungeonMapPacketLevelKeepsAuthoredBaseLevelForEnemyScaling(): void {
    const character = createCharacter('Scaled');
    character.level = 50;

    const resolvedMapLevel = (CharacterHandler as any).resolveDungeonMapPacketLevel(
        'GoblinRiverDungeon',
        LevelConfig.get('GoblinRiverDungeon').mapId,
        character
    );
    const resolvedBaseLevel = LevelConfig.get('GoblinRiverDungeon').baseId;

    assert.equal(resolvedMapLevel, 50, 'dungeon map level should follow the player level');
    assert.equal(resolvedBaseLevel, 3, 'dungeon base level must stay authored so enemies receive the map/base scaling delta');
}

function testDungeonMapPacketLevelUsesMaxLivePartyLevel(): void {
    const lowClient = createClient();
    const lowCharacter = createCharacter('Lowbie');
    lowCharacter.level = 12;
    lowClient.character = lowCharacter;

    const highClient = createClient();
    const highCharacter = createCharacter('Fifty');
    highCharacter.level = 50;
    highClient.token = 8501;
    highClient.character = highCharacter;

    GlobalState.sessionsByToken.set(highClient.token, highClient as never);
    GlobalState.partyByMember.set('lowbie', 851);
    GlobalState.partyByMember.set('fifty', 851);

    assert.equal(
        (CharacterHandler as any).resolveDungeonMapPacketLevel(
            'GoblinRiverDungeon',
            LevelConfig.get('GoblinRiverDungeon').mapId,
            lowCharacter,
            lowClient
        ),
        50,
        'character-select dungeon entry should use the highest live party level'
    );
    assert.equal(
        (LevelHandler as any).resolveDungeonMapPacketLevel(
            'GoblinRiverDungeon',
            LevelConfig.get('GoblinRiverDungeon').mapId,
            lowCharacter,
            lowClient
        ),
        50,
        'door-transfer dungeon entry should use the highest live party level'
    );
}

function testDoorTransferPartyJoinUsesAnchorRuntimeLevelForEnemyScaling(): void {
    const anchor = createClient();
    anchor.token = 9201;
    anchor.userId = 9201;
    anchor.character = createCharacter('Lowbie');
    anchor.character.level = 12;
    anchor.currentLevel = 'GoblinRiverDungeon';
    anchor.levelInstanceId = 'door-runtime-lock';
    anchor.dungeonRuntimeLevel = 12;
    anchor.playerSpawned = true;
    anchor.syncAnchorStartedAt = 2345;
    anchor.syncAnchorToken = anchor.token;
    anchor.syncAnchorCharacterName = 'Lowbie';

    const joiner = createClient();
    joiner.userId = 9202;
    joiner.character = createCharacter('Fifty');
    joiner.character.level = 50;
    joiner.currentLevel = 'NewbieRoad';

    GlobalState.sessionsByToken.set(anchor.token, anchor as never);
    GlobalState.partyByMember.set('lowbie', 920);
    GlobalState.partyByMember.set('fifty', 920);

    const syncState = (LevelHandler as any).buildTransferSyncState(joiner, 'GoblinRiverDungeon', null);
    assert.ok(syncState);
    assert.equal(syncState.levelInstanceId, 'door-runtime-lock');
    assert.equal(syncState.dungeonRuntimeLevel, 12);
}

function testEnterWorldRepairsUnsafeSavedDungeonLocation(): void {
    const client = createClient();
    const character = createCharacter('RecoveredValhavenCrawler');
    character.CurrentLevel = { name: 'JC_Mission1', x: 0, y: 0 };
    character.PreviousLevel = { name: 'WolfsEnd', x: 1210, y: 880 };

    withMockedRandom(
        [(4099.5 / 0x10000)],
        () => {
            (CharacterHandler as any).sendEnterWorld(client, character);
        }
    );

    const enterWorldPacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x21);
    assert.ok(enterWorldPacket, 'character selection should send an enter-world packet');
    const decoded = parseEnterWorldLevelPacket(enterWorldPacket.payload);
    assert.equal(decoded.internalName, 'JadeCity');
    assert.equal(character.CurrentLevel?.name, 'JadeCity');
    assert.notEqual(character.CurrentLevel?.name, 'JC_Mission1');
}

function testDungeonSafeReturnUsesExplicitEntryCoordinates(): void {
    const character = createCharacter('CrashRunner');
    character.CurrentLevel = { name: 'Castle', x: 16040, y: 1650 };
    character.PreviousLevel = { name: 'BridgeTown', x: 3944, y: 838 };

    const safeReturn = LevelConfig.resolveDungeonSafeReturn(
        'AC_Mission6',
        'Castle',
        character,
        { x: 16059, y: 1656, hasCoord: true }
    );

    assert.deepEqual(safeReturn, {
        level: 'Castle',
        x: 16059,
        y: 1656,
        hasCoord: true
    });
}

function testBuildTransferSyncStateKeepsTeleportCallerReturnPoint(): void {
    const client = createClient();
    client.currentLevel = 'Castle';
    client.clientEntID = 77;
    client.entities.set(77, { x: 15123, y: 1600 });
    client.character = createCharacter('PartyFollower');

    const leader = createClient();
    leader.token = 12345;
    leader.currentLevel = 'AC_Mission6';
    leader.character = createCharacter('PartyLeader');
    leader.playerSpawned = true;
    leader.levelInstanceId = 'dungeon-42';
    leader.entryLevel = 'JadeCity';
    leader.entryX = 10430;
    leader.entryY = 1058;
    leader.entryHasCoord = true;
    leader.currentRoomId = 3;
    leader.startedRoomEvents = new Set([
        'AC_Mission6:0',
        'AC_Mission6:1',
        'AC_Mission6:3'
    ]);
    leader.character.questTrackerState = 45;
    GlobalState.sessionsByToken.set(12345, leader as any);

    const syncState = (LevelHandler as any).buildTransferSyncState(
        client,
        'AC_Mission6',
        {
            targetLevel: 'AC_Mission6',
            levelInstanceId: 'dungeon-42',
            x: 8200,
            y: 400,
            hasCoord: true,
            syncAnchorToken: 12345,
            syncAnchorCharacterName: 'PartyLeader',
            syncRoomId: 3,
            syncStartedRoomIds: [0, 1, 3],
            syncQuestProgress: 45
        }
    );

    assert.equal(syncState.syncEntryLevel, 'Castle');
    assert.equal(syncState.syncEntryX, 15123);
    assert.equal(syncState.syncEntryY, 1600);
    assert.equal(syncState.syncEntryHasCoord, true);
    assert.equal(syncState.levelInstanceId, 'dungeon-42');
    assert.equal(syncState.syncRoomId, 3);
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

async function main(): Promise<void> {
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
    const pendingTeleports = new Map(GlobalState.pendingTeleports);

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

        testStorePendingTransferTokenKeepsTokenCharInSyncAndRequestsExtendedState();

        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.tokenChar.clear();

        testStorePendingTransferTokenSkipsExtendedStateForTransfers();

        testCraftTownTransfersKeepCompactPlayerPayload();

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

        testDungeonMapPacketLevelKeepsAuthoredBaseLevelForEnemyScaling();
        testDungeonMapPacketLevelUsesMaxLivePartyLevel();

        testDoorTransferPartyJoinUsesAnchorRuntimeLevelForEnemyScaling();

        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        testEnterWorldRepairsUnsafeSavedDungeonLocation();
        testDungeonSafeReturnUsesExplicitEntryCoordinates();
        testBuildTransferSyncStateKeepsTeleportCallerReturnPoint();

        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.usedTransferTokens.clear();
        GlobalState.tokenChar.clear();
        GlobalState.transferTokenAliases.clear();
        GlobalState.levelEntities.clear();

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

        testBuildTransferSyncStatePrefersPartyAnchorInDungeon();

        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.partyByMember.clear();

        testFindActiveTransferSessionPrefersNamedCharacterOverSameUserIndex();

        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.partyByMember.clear();

        testBuildTransferSyncStateAllowsSameAccountDifferentCharacterPartyAnchor();

        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.partyByMember.clear();

        testBuildTransferSyncStateSkipsStrangerDungeonInstance();

        GlobalState.sessionsByToken.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.partyByMember.clear();

        testVeinsOfMeylourFreshEntryUsesBeginningSpawnOverride();

        GlobalState.sessionsByToken.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.partyByMember.clear();

        testVeinsOfMeylourPartyEntryPreservesAnchorProgress();

        GlobalState.sessionsByToken.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.partyByMember.clear();

        testBuildTransferSyncStateUsesPendingPartyAnchorWhenLeaderStillTransferring();

        GlobalState.sessionsByToken.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.partyByMember.clear();

        testBuildTransferSyncStatePreservesExistingDungeonEntryLevel();

        testResolveTransferSourceLevelPrefersLiveSessionLevel();

        testResolveCraftTownReturnLevelRejectsCraftTownLoop();
        testResolveCraftTownReturnLevelRejectsCraftTownTutorialLoop();

        testSyncTransferSourcePositionFromLiveEntityUsesOverworldCoords();

        testSyncTransferSourcePositionFromLiveEntityDoesNotOverwriteDungeonReturnPoint();

        testResolveDungeonExitSpawnUsesRecordedDungeonEntryCoords();
        testResolveDungeonExitSpawnUsesCraftTownTutorialStartPoint();
        testResolveDungeonExitSpawnIgnoresStaleCraftTownTutorialSavedCoords();
        testCemeteryHillSpawnUsesAuthoredPlayerSpawn();
        testCemeteryHillZeroSavedCoordsFallBackToAuthoredSpawn();
        testEmeraldGladesDreadPortalSpawnsAtGate();
        testEmeraldGladesDreadPortalReturnSpawnsAtGate();
        testDoorAwareTravelSpawnUsesTargetPortalFromSwfData();
        testDoorAwareTravelSpawnDistinguishesMultipleDoorsToSameMap();
        testDoorAwareDreadPortalSpawnUsesTargetPortal();
        testDoorAwareStoryGatewayOverridesResolvedTargets();
        testTravelSpawnWithoutDoorContextUsesSavedOrDefaultTargetSpawn();
        testResolvedTransferUsesDoorAwareSpawnOnlyForActiveDoorTarget();
        testRecoveredTransferTokenPreservesDoorTravelContext();
        testCemeteryHillGeneralSvenDoorTargetsMiniMission9();
        testDreadHopeSpringsDoorTargetsHardMission4();
        await testDreadHopeSpringsTransferRequestEntersHardMission4();
        await testDreadHopeSpringsTransferRequestRecoversFromCurrentLevelEcho();
        await testDreadValhavenGateTransferUsesDoorPortalSpawn();
        await testDreadValhavenGateTransferRecoversFromCurrentLevelEcho();
        testLockedDungeonDoorReportsLockedAndDoesNotOpen();
        await testLockedDungeonTransferRequestIsBlocked();
        await testPartyTeleportCanJoinLockedDungeonTransfer();

        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.pendingTeleports.clear();
        GlobalState.usedTransferTokens.clear();
        GlobalState.tokenChar.clear();
        GlobalState.transferTokenAliases.clear();

        testRecoverTransferSessionStateRepairsCraftTownEntryLoop();

        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.usedTransferTokens.clear();
        GlobalState.tokenChar.clear();
        GlobalState.transferTokenAliases.clear();

        testCraftTownDoorFallsBackToPreviousOverworld();
        testCraftTownDoor999FallsBackToPreviousOverworldAfterKeepCompletion();
        testHomeTransferRedirectsToKeepTutorialWhileQuestActive();
        testHomeTransferStaysInCraftTownAfterKeepQuestCompletion();
        testCraftTownTutorialDoorFallsBackToPreviousOverworld();
        testFelbridgeDreadGateRequiresCapstoneClaim();
        testFelbridgeDreadGateReadyToTurnInDoesNotUnlock();
        testFelbridgeDreadGateOpensAfterCapstoneClaimedWithoutLevelRequirement();
        testOtherDreadfoldGatesRequireCapstoneClaim();
        testOtherDreadfoldGatesOpenAfterCapstoneClaimedWithoutLevelRequirement();
        testDreadStoryAreaDoorsRequireClaimedStoryMission();
        await testDreadStoryAreaTransferRequestRequiresClaimedStoryMission();
        testValhavenDreadGateRequiresHardShazariProgression();
        testDreadfoldReturnGatesStayOpenWithoutCapstone();
        testMindlessQueenDungeonRequiresAcceptedMission();
        testCompletedDungeonDoorShowsRepeatWithoutSavedTier();
        testUnlockedForgottenForgeDoorOpensWithoutPersistedMission();
        testUnearthingThePastDoorRequiresAcceptedSigginMission();

        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.usedTransferTokens.clear();
        GlobalState.tokenChar.clear();
        GlobalState.transferTokenAliases.clear();

        testDisconnectRecoverySnapshotRepairsCraftTownEntryLoop();

        testBuildTransferSyncStatePrefersEarliestPartyAnchorAcrossActiveAndPending();

        GlobalState.sessionsByToken.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.partyByMember.clear();

        testStorePendingTransferTokenCreatesSoloDungeonInstance();

        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.tokenChar.clear();

        testGoblinRiverTransferredRoomProgressIsIgnored();
        testCraftTownTutorialTransferredRoomProgressIsIgnored();

        testPrepareGoblinRiverDungeonEntryStateResetsToIntroBaseline();

        testPrepareTutorialDungeonEntryStateResetsToIntroBaseline();
        testPrepareCraftTownTutorialEntryStateResetsToIntroBaseline();
        await testPrepareCraftTownTutorialEntryResetsActiveKeepQuestProgress();

        testRestoreTransferredRoomProgressReplaysRoomEvents();

        testTutorialDungeonTransferredRoomProgressIsIgnored();

        testPrimeTutorialRoomEventsDoesNotConsumeTutorialDungeonTraversal();

        testTutorialDungeonTraversalTutorialStartsOnRoomFourEntry();

        testRoomChangeReassertsMountedState();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();

        testTransferSpawnDoesNotRespawnLocalPlayerEntity();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();

        await testDoorTransferIgnoresTransientMountClear();

        testNormalizeMountStateKeepsEquippedMountOwned();

        testTutorialDungeonDropTutorialStartsRoomFiveOnTraversalInput();
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
        GlobalState.pendingTeleports = pendingTeleports;
    }

    console.log('level_transfer_regression: ok');
}

void main().catch((error) => {
    console.error('level_transfer_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
