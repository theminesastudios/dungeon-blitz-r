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

function testDungeonEnterWorldKeepsAuthoredBaseLevelForEnemyScaling(): void {
    const client = createClient();
    const character = createCharacter('Scaled');
    character.level = 50;
    character.CurrentLevel = { name: 'GoblinRiverDungeon', x: 0, y: 0 };
    character.PreviousLevel = { name: 'NewbieRoad', x: 1421, y: 826 };

    withMockedRandom(
        [(4099.5 / 0x10000)],
        () => {
            (CharacterHandler as any).sendEnterWorld(client, character);
        }
    );

    const enterWorldPacket = client.sentPackets.find((packet: { id: number }) => packet.id === 0x21);
    assert.ok(enterWorldPacket, 'character selection should send an enter-world packet');

    const decoded = parseEnterWorldLevelPacket(enterWorldPacket.payload);
    assert.equal(decoded.internalName, 'GoblinRiverDungeon');
    assert.equal(decoded.mapLevel, 50, 'dungeon map level should follow the player level');
    assert.equal(decoded.baseLevel, 3, 'dungeon base level must stay authored so enemies receive the map/base scaling delta');
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

        testDungeonEnterWorldKeepsAuthoredBaseLevelForEnemyScaling();

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
        testCemeteryHillGeneralSvenDoorTargetsMiniMission9();
        testLockedDungeonDoorReportsLockedAndDoesNotOpen();
        await testLockedDungeonTransferRequestIsBlocked();

        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
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
        testCompletedDungeonDoorShowsRepeatWithoutSavedTier();

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
    }

    console.log('level_transfer_regression: ok');
}

void main().catch((error) => {
    console.error('level_transfer_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
