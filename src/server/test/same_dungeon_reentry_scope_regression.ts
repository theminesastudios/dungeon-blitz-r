/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { LevelHandler } from '../handlers/LevelHandler';

// Reported from a live two-player run: walking through a door inside a dungeon
// reloads the map and the party member is gone -- "we get teleported to parallel
// universes". After that both players fight their own hostiles, and the hostiles
// one player's client owns keep killing the other player's session for real,
// while that player's own screen shows nothing hitting them.
//
// Cause: a door whose target level is not mapped resolves to the level the player
// is already standing in (LevelHandler.handleOpenDoor), so the client re-enters
// the same dungeon through the full transfer path. clearTransferState wipes
// levelInstanceId, and buildTransferSyncState only ever restored it from a
// teleport override or a party anchor -- so a player reloading alone (no anchor
// resolvable at that instant) came back in a brand new instance of the dungeon
// they never left. Scope key is `levelName#levelInstanceId`, so a new instance is
// a new entity map: no shared hostiles, no shared party member.
const DUNGEON_LEVEL = 'JC_Mission3';
const OVERWORLD_LEVEL = 'DreadCemeteryHill';
const INSTANCE_ID = '21950';

function createClient(currentLevel: string, levelInstanceId: string): any {
    return {
        userId: 21950,
        token: 21950,
        character: {
            name: 'AlexMercer',
            level: 50,
            xp: 0,
            CurrentLevel: { name: currentLevel, x: 1000, y: 1000 },
            questTrackerState: 0
        },
        currentLevel,
        levelInstanceId,
        entryLevel: OVERWORLD_LEVEL,
        entryX: 1000,
        entryY: 1000,
        entryHasCoord: true,
        currentRoomId: 3,
        playerSpawned: true,
        clientEntID: 21950,
        entities: new Map<number, any>(),
        startedRoomEvents: new Set<string>(),
        syncAnchorStartedAt: 1,
        syncAnchorToken: 21950,
        syncAnchorCharacterName: 'AlexMercer',
        playSessionStartedAt: 1
    };
}

function buildSyncState(client: any, targetLevel: string): any {
    return (LevelHandler as any).buildTransferSyncState(client, targetLevel, null);
}

function testSameDungeonReloadKeepsInstance(): void {
    const client = createClient(DUNGEON_LEVEL, INSTANCE_ID);
    const syncState = buildSyncState(client, DUNGEON_LEVEL);

    assert.ok(syncState, 'reloading the current dungeon produced no sync state');
    assert.equal(
        syncState.levelInstanceId,
        INSTANCE_ID,
        'an in-dungeon door reload dropped the player into a new dungeon instance'
    );
}

function testFreshEntryStillGetsANewInstance(): void {
    const client = createClient(OVERWORLD_LEVEL, '');
    const syncState = buildSyncState(client, DUNGEON_LEVEL);

    assert.equal(
        syncState?.levelInstanceId ?? undefined,
        undefined,
        'entering a dungeon from outside must not inherit an instance id'
    );
}

// Leaving a dungeon and walking back in is a new run, so the stale instance the
// player was carrying must not follow them in.
function testReentryFromOutsideDoesNotInheritStaleInstance(): void {
    const client = createClient(OVERWORLD_LEVEL, INSTANCE_ID);
    const syncState = buildSyncState(client, DUNGEON_LEVEL);

    assert.equal(
        syncState?.levelInstanceId ?? undefined,
        undefined,
        'a stale instance id followed the player back into a fresh dungeon run'
    );
}

function run(): void {
    LevelConfig.load(path.join(__dirname, '..', 'data'));
    assert.equal(LevelConfig.isDungeonLevel(DUNGEON_LEVEL), true, `${DUNGEON_LEVEL} is not a dungeon level`);

    const savedSessions = new Map(GlobalState.sessionsByToken);
    GlobalState.sessionsByToken.clear();
    try {
        testSameDungeonReloadKeepsInstance();
        testFreshEntryStillGetsANewInstance();
        testReentryFromOutsideDoesNotInheritStaleInstance();
    } finally {
        GlobalState.sessionsByToken.clear();
        for (const [token, session] of savedSessions) {
            GlobalState.sessionsByToken.set(token, session);
        }
    }

    console.log('same dungeon reentry scope regression passed');
}

run();
