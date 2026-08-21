/// <reference types="node" />

import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import * as path from 'path';
import { Client } from '../core/Client';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';
import { MovementAuthority } from '../core/MovementAuthority';
import { DungeonSpawnLoader } from '../data/DungeonSpawnLoader';
import { CombatHandler } from '../handlers/CombatHandler';
import { EntityHandler } from '../handlers/EntityHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { PacketRouter } from '../network/packetRouter';

// Reported from a live two-player East Wing run: "we used the door and now we cannot see
// each other even though we are standing in the same place, and the party frame shows the
// wrong distance". The distance is a symptom -- the party frame measures against the
// viewer's own copy of the other body, so a body that was destroyed (or never sent) leaves
// a stale entity behind that the frame keeps reading.
//
// Two defects produced it, and both are races a door makes routine rather than rare:
//
//   1. a door is two TCP connections, and when the old socket's close handler ran *after*
//      the new session had spawned it tore down the successor's body by character-name
//      match -- and the destroy went to everyone except the player who used the door,
//   2. player visibility was two independent one-shot half-exchanges, so either half
//      failing left the pair one-way for the rest of the run with nothing to retry it.
const DUNGEON_LEVEL = 'JC_Mini2';
const INSTANCE_ID = 'player-visibility';
const SCOPE = getLevelScopeKey(DUNGEON_LEVEL, INSTANCE_ID);

class FakeSocket extends EventEmitter {
    destroyed = false;
    readyState = 'open';
    remoteAddress = '127.0.0.1';
    remotePort = 12345;
    cork(): void {}
    uncork(): void {}
    write(): boolean { return true; }
    end(): void { this.readyState = 'closed'; }
}

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has(DUNGEON_LEVEL)) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
}

// The authored room layout of the dungeon, which is what tells a door apart from a sprint.
function ensureDungeonRoomsLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    ensureDataLoaded();
    if (!DungeonSpawnLoader.hasLevel(DUNGEON_LEVEL)) {
        DungeonSpawnLoader.load(dataDir);
    }
}

function createClient(name: string, token: number, level: number): Client {
    const client = new Client(new FakeSocket() as never, new PacketRouter());
    client.userId = token;
    client.character = {
        name,
        level,
        xp: 0,
        CurrentLevel: { name: DUNGEON_LEVEL, x: 1000, y: 1000 }
    } as never;
    client.token = token;
    client.currentLevel = DUNGEON_LEVEL;
    client.levelInstanceId = INSTANCE_ID;
    client.currentRoomId = 1;
    client.clientEntID = token + 1000;
    client.playerSpawned = true;
    GlobalState.sessionsByToken.set(token, client);
    GlobalState.refreshSessionIndexes(client);
    return client;
}

function seedStandingBody(client: Client): void {
    client.entities.set(client.clientEntID, {
        id: client.clientEntID,
        isPlayer: true,
        name: client.character?.name,
        x: 14000,
        y: 5000,
        groundedX: 14000,
        groundedY: 5000,
        groundedLevel: DUNGEON_LEVEL,
        groundedAbsolute: true
    });
}

function resetState(): void {
    for (const client of Array.from(GlobalState.sessionsByToken.values())) {
        GlobalState.removeSessionIndexes(client);
    }
    GlobalState.sessionsByToken.clear();
    GlobalState.sessionsByCharacterName.clear();
    GlobalState.levelEntities.clear();
}

/**
 * The close handler of the connection the player just left must not delete the body its own
 * successor has already spawned. `removeOwnedEntities` matches player bodies by character
 * name, and the name is identical on both sides of a door.
 */
function testClosingSessionDoesNotDestroyItsSuccessorsBody(): void {
    const walker = createClient('Lanorut', 76001, 22);
    const walkerEntityId = walker.clientEntID;
    const levelMap = new Map<number, any>();
    GlobalState.levelEntities.set(SCOPE, levelMap);
    levelMap.set(walkerEntityId, {
        id: walkerEntityId,
        name: 'Lanorut',
        isPlayer: true,
        x: 14000,
        y: 5000
    });

    // The door: a new connection for the same character logs in and spawns before the old
    // socket's close handler runs.
    const successor = createClient('Lanorut', 76002, 22);
    const successorEntityId = successor.clientEntID;
    levelMap.set(successorEntityId, {
        id: successorEntityId,
        name: 'Lanorut',
        isPlayer: true,
        x: 14100,
        y: 5000
    });
    GlobalState.sessionsByCharacterName.set('lanorut', successor);

    const removed = EntityHandler.removeOwnedEntities(walker);

    assert.ok(
        !removed.includes(successorEntityId),
        'the closing session must not destroy the body its successor already spawned'
    );
    assert.equal(
        levelMap.has(successorEntityId),
        true,
        'the successor body must survive the old connection closing behind it'
    );
    assert.ok(removed.includes(walkerEntityId), 'the closing session must still clean up its own body');
}

/**
 * Player visibility is symmetric: one pass draws each pair on both screens, so whichever
 * half of the exchange was not possible on the first try is simply done on the next.
 */
function testPlayerVisibilityIsExchangedBothWays(): void {
    const host = createClient('Telahair', 78001, 50);
    const joiner = createClient('Lanorut', 78002, 22);
    seedStandingBody(host);
    seedStandingBody(joiner);

    const sent: Array<{ viewer: string; subject: number }> = [];
    const originalSendEntity = (EntityHandler as any).sendEntity;
    (EntityHandler as any).sendEntity = (viewer: Client, entity: any) => {
        sent.push({ viewer: String(viewer.character?.name ?? '?'), subject: Number(entity?.id ?? 0) });
    };
    try {
        (EntityHandler as any).syncPlayerVisibilityInScope(joiner);
    } finally {
        (EntityHandler as any).sendEntity = originalSendEntity;
    }

    assert.ok(
        sent.some((entry) => entry.viewer === 'Lanorut' && entry.subject === host.clientEntID),
        'the joiner must be sent the party member already standing there'
    );
    assert.ok(
        sent.some((entry) => entry.viewer === 'Telahair' && entry.subject === joiner.clientEntID),
        'the party member must be sent the joiner in the same pass'
    );
}

/**
 * Seeding another client with a player body is a spawn, and the client only snaps a spawn
 * onto floor within a short ray. An airborne sample outside that window is accepted as-is
 * and the body falls, so it is refused and left to the retry.
 */
function testAirborneBodyWithNoFloorSampleIsNotSeeded(): void {
    const airborne = {
        id: 12345,
        isPlayer: true,
        x: 14000,
        y: 3200,
        airborne: true
    };
    assert.equal(
        (EntityHandler as any).withGroundedBodyPosition(airborne, DUNGEON_LEVEL),
        null,
        'an airborne body with no floor sample must not be drawn on a remote screen at all'
    );

    // Standing, but with no sample yet: the live point is the client's own report, so it is
    // usable and must not be refused.
    const standing = { id: 12345, isPlayer: true, x: 14000, y: 5000 };
    assert.equal(
        (EntityHandler as any).withGroundedBodyPosition(standing, DUNGEON_LEVEL),
        standing,
        'a standing body with no stored sample should still be sent as reported'
    );

    const liftedToFloor = {
        id: 12345,
        isPlayer: true,
        x: 14000,
        y: 3200,
        airborne: true,
        groundedX: 14000,
        groundedY: 5000,
        groundedLevel: DUNGEON_LEVEL,
        groundedAbsolute: true
    };
    const placed = (EntityHandler as any).withGroundedBodyPosition(liftedToFloor, DUNGEON_LEVEL);
    assert.equal(placed.y, 5000, 'a body drawn on another screen must go on the confirmed floor sample');
    assert.equal(liftedToFloor.y, 3200, 'the live entity must not be rewritten by the outgoing copy');
}

/**
 * The retry must not be pinned to the scope captured when it was scheduled. The scope guard
 * moves a session onto the party's instance after it spawns, and a retry cancelled because
 * the scope "changed" is a retry cancelled exactly when it was needed -- the run where the
 * leader never receives the member who walked through the door.
 */
function testVisibilityResyncSurvivesAScopeChange(): void {
    const host = createClient('Telahair', 79001, 50);
    const joiner = createClient('Lanorut', 79002, 22);
    seedStandingBody(host);
    seedStandingBody(joiner);

    const scheduled: Array<() => void> = [];
    const originalSetTimeout = global.setTimeout;
    (global as any).setTimeout = (fn: () => void) => {
        scheduled.push(fn);
        return { unref() {} };
    };
    try {
        EntityHandler.schedulePlayerVisibilityResync(joiner);
    } finally {
        (global as any).setTimeout = originalSetTimeout;
    }
    assert.ok(scheduled.length > 0, 'a resync pass should be scheduled');

    // The scope guard adopts the party instance after the joiner spawned.
    host.levelInstanceId = 'adopted-instance';
    joiner.levelInstanceId = 'adopted-instance';
    GlobalState.refreshSessionIndexes(host);
    GlobalState.refreshSessionIndexes(joiner);

    const sent: Array<{ viewer: string; subject: number }> = [];
    const originalSendEntity = (EntityHandler as any).sendEntity;
    (EntityHandler as any).sendEntity = (viewer: Client, entity: any) => {
        sent.push({ viewer: String(viewer.character?.name ?? '?'), subject: Number(entity?.id ?? 0) });
    };
    try {
        for (const fire of scheduled) {
            fire();
        }
    } finally {
        (EntityHandler as any).sendEntity = originalSendEntity;
    }

    assert.ok(
        sent.some((entry) => entry.viewer === 'Telahair' && entry.subject === joiner.clientEntID),
        'the retry must still run after the scope guard moved the session, or the leader never gets the member'
    );
}

/**
 * A client tearing its level down emits `0x0D` for everything it was holding, including the
 * other players. Relaying that deleted the peer's body on every other screen, and nothing
 * ever re-seeded it -- with the party frame still drawing a headshot and a distance off the
 * destroyed entity, which is what made it look like a UI bug rather than a missing body.
 */
async function testClientCannotDestroyAnotherPlayersBody(): Promise<void> {
    const host = createClient('Telahair', 81001, 50);
    const joiner = createClient('Lanorut', 81002, 22);
    seedStandingBody(host);
    seedStandingBody(joiner);
    joiner.entities.set(host.clientEntID, {
        id: host.clientEntID,
        isPlayer: true,
        name: 'Telahair',
        team: 1,
        x: 14000,
        y: 5000
    });

    const levelMap = new Map<number, any>();
    GlobalState.levelEntities.set(SCOPE, levelMap);
    levelMap.set(host.clientEntID, host.entities.get(host.clientEntID));

    joiner.knownEntityIds.add(host.clientEntID);

    const relayed: number[] = [];
    const originalBroadcast = (CombatHandler as any).broadcastToSameLevel;
    (CombatHandler as any).broadcastToSameLevel = (_scope: string, packetId: number) => {
        relayed.push(packetId);
    };
    const sentToJoiner: number[] = [];
    joiner.send = ((packetId: number) => {
        sentToJoiner.push(packetId);
    }) as never;
    try {
        // The joiner's client reports that it dropped the host's body while unloading.
        const bb = new BitBuffer(false);
        bb.writeMethod4(host.clientEntID);
        bb.writeMethod15(true);
        await CombatHandler.handleEntityDestroy(joiner as never, bb.toBuffer());
    } finally {
        (CombatHandler as any).broadcastToSameLevel = originalBroadcast;
    }

    // In a server-authority level the report does not even need relaying to do damage: the
    // unresolved-entity path confirms the deletion straight back to the reporting client and
    // drops the id from `knownEntityIds`, so nothing ever re-seeds that body for them.
    assert.equal(
        sentToJoiner.includes(0x0D),
        false,
        'the server must not confirm the deletion of another player body back to the reporter'
    );
    assert.equal(
        joiner.entities.has(host.clientEntID),
        true,
        'the peer body must stay in the reporting client s entity set'
    );
    assert.equal(
        joiner.knownEntityIds.has(host.clientEntID),
        true,
        'forgetting the id would stop anything from ever re-seeding that body'
    );
    assert.equal(
        relayed.includes(0x0D),
        false,
        'one client must not be able to destroy another player body on everybody else s screen'
    );
    assert.equal(
        levelMap.has(host.clientEntID),
        true,
        'the host body must survive a peer client reporting it as dropped'
    );
}

/**
 * The report is not merely ignored -- the client really has thrown its copy away, so the body
 * is drawn again. Ignoring it alone would leave that screen empty while `knownEntityIds` still
 * claimed the id was there, which suppresses every later reconcile.
 */
async function testPeerBodyIsRedrawnAfterAClientReportsDroppingIt(): Promise<void> {
    const host = createClient('Telahair', 82001, 50);
    const joiner = createClient('Lanorut', 82002, 22);
    seedStandingBody(host);
    seedStandingBody(joiner);
    joiner.knownEntityIds.add(host.clientEntID);
    // The scope's level map is where the server recognises a body as a player's, exactly as
    // `buildPlayerSnapshot` leaves it in production.
    const levelMap = new Map<number, any>();
    GlobalState.levelEntities.set(SCOPE, levelMap);
    levelMap.set(host.clientEntID, host.entities.get(host.clientEntID));

    const reseeded: number[] = [];
    const originalSendEntity = (EntityHandler as any).sendEntity;
    (EntityHandler as any).sendEntity = (viewer: Client, entity: any) => {
        if (viewer === joiner) {
            reseeded.push(Number(entity?.id ?? 0));
        }
    };
    try {
        const bb = new BitBuffer(false);
        bb.writeMethod4(host.clientEntID);
        bb.writeMethod15(true);
        await CombatHandler.handleEntityDestroy(joiner as never, bb.toBuffer());
    } finally {
        (EntityHandler as any).sendEntity = originalSendEntity;
    }

    assert.ok(
        reseeded.includes(host.clientEntID),
        'the body the client says it dropped must be drawn again for that client'
    );
}

/**
 * Visibility is a standing invariant, not a one-shot event: a body lost after the spawn
 * retries have stopped comes back, and a scope where everyone can already see everyone sends
 * nothing (a re-seed is a spawn, so re-sending known bodies would reset animations).
 */
function testReconcileOnlyRedrawsMissingBodies(): void {
    const host = createClient('Telahair', 83001, 50);
    const joiner = createClient('Lanorut', 83002, 22);
    seedStandingBody(host);
    seedStandingBody(joiner);

    const sent: Array<{ viewer: string; subject: number }> = [];
    const originalSendEntity = (EntityHandler as any).sendEntity;
    (EntityHandler as any).sendEntity = (viewer: Client, entity: any) => {
        sent.push({ viewer: String(viewer.character?.name ?? '?'), subject: Number(entity?.id ?? 0) });
        viewer.knownEntityIds.add(Number(entity?.id ?? 0));
    };
    try {
        // "Already drawn" means drawn *by this pass* -- an id another path marked known is not
        // evidence anything reached the screen, which is the whole point of the record.
        (EntityHandler as any).syncPlayerVisibilityInScope(joiner);
        sent.length = 0;

        EntityHandler.reconcilePlayerVisibilityInScope(joiner);
        assert.equal(sent.length, 0, 'a scope where everyone is already drawn must send nothing');

        // The joiner's screen loses the host body.
        joiner.knownEntityIds.delete(host.clientEntID);
        EntityHandler.reconcilePlayerVisibilityInScope(joiner);
    } finally {
        (EntityHandler as any).sendEntity = originalSendEntity;
    }

    assert.deepEqual(
        sent.map((entry) => `${entry.viewer}:${entry.subject}`),
        [`Lanorut:${host.clientEntID}`],
        'exactly the missing body should be redrawn, and only for the screen missing it'
    );
}

/**
 * The scope index must follow the session through a door on its own.
 *
 * Everything fanned out to "the other people standing here" reads
 * `sessionsByLevelScope` -- movement relay above all. A caller that moved a session and
 * forgot `refreshSessionIndexes` dropped that player out of the index for the rest of the
 * run, and the visible result was a party member who appeared once and then never moved
 * again on the other screen: the body arrived (visibility scans live sessions) but not one
 * movement packet followed it.
 */
function testScopeIndexFollowsTheSessionThroughADoor(): void {
    const walker = createClient('Lanorut', 84001, 22);
    assert.ok(
        GlobalState.getSessionsInLevelScope(SCOPE).has(walker),
        'a spawned session should be in its own scope index to begin with'
    );

    // A door: the three scope fields are written, and nothing calls refreshSessionIndexes.
    walker.currentLevel = 'JC_Mini1Hard';
    walker.levelInstanceId = 'through-the-door';
    walker.currentRoomId = 4;

    const newScope = getLevelScopeKey('JC_Mini1Hard', 'through-the-door');
    assert.equal(
        GlobalState.getSessionsInLevelScope(SCOPE).has(walker),
        false,
        'the session must not be left behind in the scope it walked out of'
    );
    assert.ok(
        GlobalState.getSessionsInLevelScope(newScope).has(walker),
        'the session must appear in the scope it walked into without anyone reindexing by hand'
    );
}

/**
 * A room change is a single large jump that never arrives as relayable movement deltas, so
 * unless the server pushes the authoritative body the other clients keep drawing it exactly
 * where it was -- the player left standing in the room they walked out of for the rest of the
 * run, which is what "the other player does not change room for the party" looks like.
 */
function testRoomChangePushesThePlayerToEveryoneElse(): void {
    const host = createClient('Telahair', 85001, 50);
    const walker = createClient('Lanorut', 85002, 22);
    seedStandingBody(host);
    seedStandingBody(walker);

    const sent: Array<{ viewer: string; subject: number }> = [];
    const originalSendEntity = (EntityHandler as any).sendEntity;
    (EntityHandler as any).sendEntity = (viewer: Client, entity: any) => {
        sent.push({ viewer: String(viewer.character?.name ?? '?'), subject: Number(entity?.id ?? 0) });
    };
    try {
        (LevelHandler as any).cacheRoomId(walker, 3);
    } finally {
        (EntityHandler as any).sendEntity = originalSendEntity;
    }

    assert.equal(walker.currentRoomId, 3, 'the room change should be recorded');
    assert.ok(
        sent.some((entry) => entry.viewer === 'Telahair' && entry.subject === walker.clientEntID),
        'changing room must push the moving player to the other screens, not leave them in the old room'
    );
}

/**
 * The floor sample belongs to the room it was measured in, and is only tagged with the level.
 *
 * Inside a dungeon the room changes while the level does not, so the old room's floor point
 * stays "confirmed" and every path that prefers a confirmed sample over the live position
 * re-pins the body to the room the player walked out of -- invisible to the player who moved,
 * permanent for everyone else. Pushing the body on a room change without clearing it first
 * just re-sends the stale point, which is why the push alone moved nobody.
 */
function testRoomChangeDropsTheOldRoomsFloorSample(): void {
    const host = createClient('Telahair', 86001, 50);
    const walker = createClient('Lanorut', 86002, 22);
    seedStandingBody(host);
    seedStandingBody(walker);

    // The walker is now standing somewhere else entirely; only the sample is stale.
    const body = walker.entities.get(walker.clientEntID);
    body.x = 20000;
    body.y = 9000;

    const placed: Array<{ x: number; y: number }> = [];
    const originalSendEntity = (EntityHandler as any).sendEntity;
    (EntityHandler as any).sendEntity = (viewer: Client, entity: any) => {
        if (viewer === host && Number(entity?.id ?? 0) === walker.clientEntID) {
            placed.push({ x: Number(entity.x), y: Number(entity.y) });
        }
    };
    try {
        (LevelHandler as any).cacheRoomId(walker, 3);
        // The immediate push builds a fresh snapshot and was always correct. The damage was
        // done by the passes that follow it: they read the stored body, which keeps the floor
        // sample, so each one dragged the player back into the room they had left.
        (EntityHandler as any).syncPlayerVisibilityInScope(walker);
    } finally {
        (EntityHandler as any).sendEntity = originalSendEntity;
    }

    assert.ok(placed.length > 1, 'both the room-change push and the resync pass should have drawn the body');
    for (const point of placed) {
        assert.notEqual(
            `${point.x},${point.y}`,
            '14000,5000',
            'the body must not be re-pinned to the floor sample measured in the room it left'
        );
        assert.equal(point.x, 20000, 'the live position is the honest answer once the sample is gone');
        assert.equal(point.y, 9000, 'the live position is the honest answer once the sample is gone');
    }
}

/**
 * The client has no reader for the 0x08 full update at all -- it only ever sends that packet.
 * So a remote body can be moved by exactly two things: relayed 0x07 deltas, or another 0x0F
 * spawn. A room change is a teleport that produces no deltas, which means a body drawn in the
 * old room stays there until the server draws it again, and the reconcile pass has to notice
 * that on its own rather than only looking for bodies that are missing entirely.
 */
function testReconcileRedrawsABodyLeftInTheWrongRoom(): void {
    const host = createClient('Telahair', 87001, 50);
    const walker = createClient('Lanorut', 87002, 22);
    seedStandingBody(host);
    seedStandingBody(walker);

    const sent: Array<{ viewer: string; subject: number }> = [];
    const originalSendEntity = (EntityHandler as any).sendEntity;
    (EntityHandler as any).sendEntity = (viewer: Client, entity: any) => {
        sent.push({ viewer: String(viewer.character?.name ?? '?'), subject: Number(entity?.id ?? 0) });
        // The real sendEntity marks the id known; the reconcile pass reads that back.
        viewer.knownEntityIds.add(Number(entity?.id ?? 0));
    };
    try {
        // Everyone drawn, everyone in room 1: a reconcile must be silent.
        (EntityHandler as any).syncPlayerVisibilityInScope(walker);
        sent.length = 0;
        EntityHandler.reconcilePlayerVisibilityInScope(walker);
        assert.equal(sent.length, 0, 'a scope where every body is drawn in the right room must send nothing');

        // The walker teleports to another room. No delta describes that jump.
        walker.currentRoomId = 4;
        EntityHandler.reconcilePlayerVisibilityInScope(walker);
    } finally {
        (EntityHandler as any).sendEntity = originalSendEntity;
    }

    assert.deepEqual(
        sent.map((entry) => `${entry.viewer}:${entry.subject}`),
        [`Telahair:${walker.clientEntID}`],
        'the body left behind in the old room must be redrawn, and only for the screen showing it there'
    );
}

/**
 * The invariant must not hang off a packet.
 *
 * Every earlier attempt did -- the spawn, two timed retries, a hook on the mover's own
 * movement update -- and a door is a full level reload onto a new connection, so each of those
 * paths has its own early returns and its own ordering against that reload. The sweep owes
 * nothing to any packet arriving: it draws what a screen is wrong about and is silent
 * otherwise.
 */
function testVisibilitySweepDrawsWhatPacketPathsMissed(): void {
    const host = createClient('Telahair', 88001, 50);
    const joiner = createClient('Lanorut', 88002, 22);
    seedStandingBody(host);
    seedStandingBody(joiner);

    const ticks: Array<() => void> = [];
    const originalSetInterval = global.setInterval;
    (global as any).setInterval = (fn: () => void) => {
        ticks.push(fn);
        return { unref() {} };
    };
    try {
        (EntityHandler as any).playerVisibilitySweep = null;
        EntityHandler.startPlayerVisibilitySweep();
    } finally {
        (global as any).setInterval = originalSetInterval;
    }
    assert.equal(ticks.length, 1, 'the sweep should register exactly one interval');

    const sent: Array<{ viewer: string; subject: number }> = [];
    const originalSendEntity = (EntityHandler as any).sendEntity;
    (EntityHandler as any).sendEntity = (viewer: Client, entity: any) => {
        sent.push({ viewer: String(viewer.character?.name ?? '?'), subject: Number(entity?.id ?? 0) });
        viewer.knownEntityIds.add(Number(entity?.id ?? 0));
    };
    try {
        // Nobody has been drawn to anybody: one tick fixes both screens.
        ticks[0]();
        assert.ok(
            sent.some((entry) => entry.viewer === 'Telahair' && entry.subject === joiner.clientEntID),
            'the sweep must draw the joiner for the party member'
        );
        assert.ok(
            sent.some((entry) => entry.viewer === 'Lanorut' && entry.subject === host.clientEntID),
            'the sweep must draw the party member for the joiner'
        );

        // Everything correct now: further ticks must be silent.
        sent.length = 0;
        ticks[0]();
        assert.equal(sent.length, 0, 'a sweep over correct screens must send nothing');
    } finally {
        (EntityHandler as any).sendEntity = originalSendEntity;
        (EntityHandler as any).playerVisibilitySweep = null;
    }
}

/**
 * The anchor decides whether two party members are even in the same dungeon.
 *
 * It used to read `GlobalState.getSessionsInParty`, which hands back whatever is in the party
 * index -- and an *incomplete* entry is indistinguishable from a correct one, so a party mate
 * missing from it means no anchor, which means this player keeps their own instance id. That
 * is a private run with its own copies of every enemy: same room, same spot, permanently
 * unable to see each other, and neither one's kills registering for the other.
 */
function testScopeAnchorFindsAPartyMateMissingFromTheIndex(): void {
    const host = createClient('Telahair', 89001, 50);
    const joiner = createClient('Lanorut', 89002, 22);
    host.levelInstanceId = 'the-real-run';
    joiner.levelInstanceId = 'a-private-run';
    host.syncAnchorStartedAt = 1;
    joiner.syncAnchorStartedAt = 2;

    const partyId = 4242;
    GlobalState.partyByMember.set('telahair', partyId);
    GlobalState.partyByMember.set('lanorut', partyId);
    GlobalState.partyGroups.set(partyId, {
        id: partyId,
        leader: 'Telahair',
        members: ['Telahair', 'Lanorut'],
        locked: false
    } as never);
    // The party index is stale: it exists but has lost the host, which is the shape that made
    // this fail silently rather than fall back to a scan.
    GlobalState.sessionsByPartyId.set(partyId, new Set([joiner]));

    try {
        const anchor = (EntityHandler as any).selectJcMini1PartyScopeAnchor(joiner, DUNGEON_LEVEL);
        assert.equal(
            anchor,
            host,
            'the anchor must be found by scanning live sessions, not by trusting the party index'
        );
    } finally {
        GlobalState.sessionsByPartyId.delete(partyId);
        GlobalState.partyGroups.delete(partyId);
        GlobalState.partyByMember.delete('telahair');
        GlobalState.partyByMember.delete('lanorut');
    }
}

/**
 * The dungeon starter was visible to nobody who joined them, and the reverse worked fine.
 *
 * `ensureEntityKnown`, on the relay path, pulls a body in by sending the raw level-map
 * snapshot and marks the id known -- with none of the placement a real seed gets, at whatever
 * moment a relay happens to run, including while the joining client is still loading. If that
 * copy never lands, the id is known and this pass never drew it, so treating "known" as
 * "correct" left that screen empty for the whole run. It is asymmetric because the joiner's own
 * body *is* drawn properly by this pass, which is exactly what the live report showed.
 */
function testKnownButNeverDrawnBodyIsStillDrawn(): void {
    const starter = createClient('Telahair', 90001, 50);
    const joiner = createClient('Lanorut', 90002, 22);
    seedStandingBody(starter);
    seedStandingBody(joiner);

    // The relay path claimed the starter's body for the joiner's screen without this pass ever
    // drawing it -- the id is known, and nothing recorded a room for it.
    joiner.knownEntityIds.add(starter.clientEntID);
    assert.equal(
        joiner.drawnPlayerRoomIds.has(starter.clientEntID),
        false,
        'the relay path must not leave a drawn-room record behind'
    );

    const sent: Array<{ viewer: string; subject: number }> = [];
    const originalSendEntity = (EntityHandler as any).sendEntity;
    (EntityHandler as any).sendEntity = (viewer: Client, entity: any) => {
        sent.push({ viewer: String(viewer.character?.name ?? '?'), subject: Number(entity?.id ?? 0) });
        viewer.knownEntityIds.add(Number(entity?.id ?? 0));
    };
    try {
        EntityHandler.reconcilePlayerVisibilityInScope(joiner);
    } finally {
        (EntityHandler as any).sendEntity = originalSendEntity;
    }

    assert.ok(
        sent.some((entry) => entry.viewer === 'Lanorut' && entry.subject === starter.clientEntID),
        'a body marked known by another path but never drawn here must still be drawn'
    );
    assert.equal(
        joiner.drawnPlayerRoomIds.get(starter.clientEntID),
        starter.currentRoomId,
        'and drawing it must record the room, so the next pass is silent'
    );
}

/**
 * Exactly one thing places a player body, and a placed body is not redrawn.
 *
 * Every 0x0F rebuilds the body on the client, so two senders a second apart is a body being
 * destroyed and recreated rather than drawn -- which is how a working direction was broken by
 * "fixing" the other one. The relay path (`ensureEntityKnown`) must therefore never send or
 * claim a player body, and every path that does place one must leave the same record, or the
 * sweep will redraw what is already correct.
 */
function testOnlyTheVisibilityPassPlacesPlayerBodies(): void {
    const starter = createClient('Telahair', 91001, 50);
    const joiner = createClient('Lanorut', 91002, 22);
    seedStandingBody(starter);
    seedStandingBody(joiner);

    const levelMap = new Map<number, any>();
    GlobalState.levelEntities.set(SCOPE, levelMap);
    levelMap.set(starter.clientEntID, starter.entities.get(starter.clientEntID));

    const sent: Array<{ viewer: string; subject: number }> = [];
    const originalSendEntity = (EntityHandler as any).sendEntity;
    (EntityHandler as any).sendEntity = (viewer: Client, entity: any) => {
        sent.push({ viewer: String(viewer.character?.name ?? '?'), subject: Number(entity?.id ?? 0) });
        viewer.knownEntityIds.add(Number(entity?.id ?? 0));
    };
    try {
        // The relay path must not seed the starter's body. It still answers yes, because it is
        // also the gate for ordinary relays (health, movement, buffs) and a player is always
        // entitled to those -- withholding them would stop a party member's damage reaching
        // the other screens.
        const known = EntityHandler.ensureEntityKnown(joiner, DUNGEON_LEVEL, starter.clientEntID);
        assert.equal(known, true, 'the relay path must keep letting player updates through');
        assert.equal(sent.length, 0, 'the relay path must not send a player body at all');
        assert.equal(
            joiner.knownEntityIds.has(starter.clientEntID),
            false,
            'and it must not claim the body, or the visibility pass will think the screen is right'
        );

        // The visibility pass owns it: it draws it once and records it.
        EntityHandler.reconcilePlayerVisibilityInScope(joiner);
        assert.ok(
            sent.some((entry) => entry.viewer === 'Lanorut' && entry.subject === starter.clientEntID),
            'the visibility pass must draw the body the relay path refused to'
        );

        // And a second sweep must be silent -- a redraw here would rebuild the body.
        sent.length = 0;
        EntityHandler.reconcilePlayerVisibilityInScope(joiner);
        assert.equal(sent.length, 0, 'a placed body must not be redrawn by the next sweep');
    } finally {
        (EntityHandler as any).sendEntity = originalSendEntity;
    }
}

/**
 * `refreshPlayerSnapshot` really places bodies, so it has to leave the same record the sweep
 * reads. Without it every gear change, room change and spawn refresh would be followed a
 * second later by a redraw of a body that was already correct.
 */
function testSnapshotRefreshRecordsWhatItDrew(): void {
    const host = createClient('Telahair', 92001, 50);
    const joiner = createClient('Lanorut', 92002, 22);
    seedStandingBody(host);
    seedStandingBody(joiner);

    const sent: Array<{ viewer: string; subject: number }> = [];
    const originalSendEntity = (EntityHandler as any).sendEntity;
    (EntityHandler as any).sendEntity = (viewer: Client, entity: any) => {
        sent.push({ viewer: String(viewer.character?.name ?? '?'), subject: Number(entity?.id ?? 0) });
        viewer.knownEntityIds.add(Number(entity?.id ?? 0));
    };
    try {
        EntityHandler.refreshPlayerSnapshot(host);
        assert.ok(
            sent.some((entry) => entry.viewer === 'Lanorut' && entry.subject === host.clientEntID),
            'the snapshot refresh should have drawn the host for the joiner'
        );

        sent.length = 0;
        EntityHandler.reconcilePlayerVisibilityInScope(joiner);
        assert.equal(
            sent.filter((entry) => entry.subject === host.clientEntID).length,
            0,
            'the sweep must not redraw a body the snapshot refresh just placed'
        );
    } finally {
        (EntityHandler as any).sendEntity = originalSendEntity;
    }
}

/**
 * The mid-air refusal must not be permanent, and that is what kept this one-way.
 *
 * `isEntityAirborne` reads flags on the *stored* body, and those are only rewritten by a
 * movement packet. A player who lands and then stands still keeps whatever the last packet
 * said -- often `airborne`/`dropping` from the landing itself -- and standing still produces
 * no further packets, so the body was refused on every pass forever while the reverse
 * direction worked perfectly. After a few passes the live position is the honest answer: the
 * player is demonstrably not moving, so it is where they are.
 */
function testStuckAirborneFlagDoesNotHideAPlayerForever(): void {
    const starter = createClient('Telahair', 93001, 50);
    const joiner = createClient('Lanorut', 93002, 22);
    seedStandingBody(joiner);
    // Landed, standing still, but the last movement packet said airborne -- and there is no
    // confirmed floor sample, so nothing can place this body the careful way.
    starter.entities.set(starter.clientEntID, {
        id: starter.clientEntID,
        isPlayer: true,
        name: 'Telahair',
        x: 14000,
        y: 5000,
        airborne: true
    });

    const sent: Array<{ viewer: string; subject: number; y: number }> = [];
    const originalSendEntity = (EntityHandler as any).sendEntity;
    (EntityHandler as any).sendEntity = (viewer: Client, entity: any) => {
        sent.push({
            viewer: String(viewer.character?.name ?? '?'),
            subject: Number(entity?.id ?? 0),
            y: Number(entity?.y)
        });
        viewer.knownEntityIds.add(Number(entity?.id ?? 0));
    };
    try {
        for (let tick = 0; tick < 6; tick++) {
            EntityHandler.reconcilePlayerVisibilityInScope(joiner);
        }
    } finally {
        (EntityHandler as any).sendEntity = originalSendEntity;
    }

    const drawn = sent.filter((entry) => entry.viewer === 'Lanorut' && entry.subject === starter.clientEntID);
    assert.ok(
        drawn.length > 0,
        'a body stuck behind an airborne flag must eventually be drawn, not hidden for the whole run'
    );
    assert.equal(drawn[0].y, 5000, 'and it must be drawn where the player actually is');
    assert.equal(drawn.length, 1, 'once drawn it must not be redrawn on every following pass');
}

/**
 * A player id must never collide with the id another client uses for its own body.
 *
 * When the server reallocates a colliding id it stores `local -> canonical` and migrates its
 * own bookkeeping, but the client goes on calling its own body by the original id -- and
 * nothing else records that, so the id looks free. Handing it out is the worst case: the
 * spawn reader finds that client's own body, destroys it and rebuilds it as somebody else,
 * then the client's next self update puts its own body back and destroys the copy. Neither
 * body survives on the other screen, both players still see themselves, and the party frame
 * reads 0ft because the entity filed under the other player's name is their own body.
 */
function testAPlayerIdNeverCollidesWithAnotherClientsOwnBodyId(): void {
    const host = createClient('Telahair', 94001, 50);
    const joiner = createClient('Lanorut', 94002, 22);
    // The joiner's client calls its own body 5; the server moved it to a canonical id and left
    // the alias behind. Id 5 is now invisible to every occupancy record except the alias.
    joiner.entityIdAliases.set(5, joiner.clientEntID);

    assert.equal(
        (EntityHandler as any).getLocalSelfEntityId(joiner),
        5,
        'the id a client calls its own body by must be recoverable from the alias'
    );
    assert.equal(
        (EntityHandler as any).isPlayerCanonicalIdFree(SCOPE, host, 5),
        false,
        'an id another client uses for its own body must never be handed out'
    );
    assert.equal(
        (EntityHandler as any).isPlayerEntityIdOccupiedByOther(SCOPE, host, 5),
        true,
        'and it must read as occupied when a colliding id is being reallocated'
    );

    // Belt and braces: even if the allocator were defeated, the body is not sent.
    host.clientEntID = 5;
    seedStandingBody(host);
    seedStandingBody(joiner);
    const sent: number[] = [];
    const originalSendEntity = (EntityHandler as any).sendEntity;
    (EntityHandler as any).sendEntity = (_viewer: Client, entity: any) => {
        sent.push(Number(entity?.id ?? 0));
    };
    try {
        (EntityHandler as any).sendPlayerBodyToViewer(joiner, host);
    } finally {
        (EntityHandler as any).sendEntity = originalSendEntity;
    }
    assert.equal(
        sent.includes(5),
        false,
        'a body must never go out under the id the receiving client uses for its own character'
    );
}

/**
 * The spawn fall must not be scored as a speed cheat.
 *
 * Numbers taken verbatim from the live log that finally pinned this down:
 *
 *   [MovementAuthority] rejected reason=speed_delta character=Telahair level=JC_Mini2
 *     old=15546,3049 attempted=15636,4646 elapsedMs=138 allowed=1425 actual=1600
 *
 * That is the drop from a dungeon spawn point to the floor: 90px across, 1597px down. Scored
 * against a *running* budget on the hypotenuse it is rejected, so the server's authoritative
 * position stayed at the top of the drop. The falling player's own client had landed and
 * looked fine; every other screen was handed the stuck position and drew the body ~1600px
 * above the room, off camera. The bodies were being drawn all along -- in the air.
 */
function testSpawnFallIsNotRejectedAsASpeedCheat(): void {
    const client: any = {
        userId: 9,
        character: { name: 'Telahair' },
        currentLevel: DUNGEON_LEVEL,
        movementAuthority: null
    };
    const entity = { x: 15546, y: 3049 };

    MovementAuthority.reset(client, 'test', entity.x, entity.y);
    const airborneResult = MovementAuthority.validateIncrementalMovement(
        client,
        entity,
        90,
        1597,
        MovementAuthority.nowMs() + 138,
        [0, 1597],
        true
    );
    assert.equal(
        airborneResult.accepted,
        true,
        'a falling body must be accepted: the vertical drop is gravity, not a run'
    );
    assert.equal(airborneResult.attemptedY, 4646, 'and it must land at the floor the client reported');

    // The horizontal budget is untouched: the same distance taken sideways while airborne is
    // still a speed cheat.
    const sprinting = { x: 15546, y: 3049 };
    const sprintClient: any = {
        userId: 9,
        character: { name: 'Telahair' },
        currentLevel: DUNGEON_LEVEL,
        movementAuthority: null
    };
    MovementAuthority.reset(sprintClient, 'test', sprinting.x, sprinting.y);
    const sideways = MovementAuthority.validateIncrementalMovement(
        sprintClient,
        sprinting,
        1597,
        0,
        MovementAuthority.nowMs() + 138,
        [0, 0],
        true
    );
    assert.equal(
        sideways.accepted,
        false,
        'airborne must not become a licence to cross the map horizontally'
    );
}

/**
 * Every door and transition, not just the ones that move a room id.
 *
 * The redraw used to be keyed on `currentRoomId` changing, and a dungeon can run its whole
 * length reporting room 0 -- the live `[Visibility]` log showed `room=0` for both players, so
 * that trigger never fired for any door. What is always true of a door, a room transition or
 * any other teleport is that it produces no deltas the other clients can follow, so the jump
 * itself is the trigger and the room id is not consulted at all.
 */
function testEveryTransitionMarksTheBodyStaleEvenWithoutARoomChange(): void {
    const host = createClient('Telahair', 95001, 50);
    const walker = createClient('Lanorut', 95002, 22);
    seedStandingBody(host);
    seedStandingBody(walker);

    const sent: Array<{ viewer: string; subject: number }> = [];
    const originalSendEntity = (EntityHandler as any).sendEntity;
    (EntityHandler as any).sendEntity = (viewer: Client, entity: any) => {
        sent.push({ viewer: String(viewer.character?.name ?? '?'), subject: Number(entity?.id ?? 0) });
        viewer.knownEntityIds.add(Number(entity?.id ?? 0));
    };
    try {
        (EntityHandler as any).syncPlayerVisibilityInScope(walker);
        sent.length = 0;

        // Settled: nothing to do.
        EntityHandler.reconcilePlayerVisibilityInScope(walker);
        assert.equal(sent.length, 0, 'a settled scope must send nothing');

        // The walker goes through a door. The room id does not move -- this dungeon reports 0
        // throughout -- so only the transition itself can mark the body stale.
        assert.equal(walker.currentRoomId, host.currentRoomId, 'both players are in the same reported room');
        EntityHandler.markPlayerBodyNeedsRedraw(walker);
        EntityHandler.reconcilePlayerVisibilityInScope(walker);
    } finally {
        (EntityHandler as any).sendEntity = originalSendEntity;
    }

    assert.deepEqual(
        sent.map((entry) => `${entry.viewer}:${entry.subject}`),
        [`Telahair:${walker.clientEntID}`],
        'the transitioning body must be redrawn for the other screen, with no room change involved'
    );
}

/**
 * A door between two rooms of the same dungeon is not a speed cheat.
 *
 * This is the one that kept two East Wing players invisible to each other in every room after
 * the first. The grace that was supposed to cover a door is armed by `cacheRoomId`, and only
 * when the room *id* moves -- but this dungeon reports room 0 from the entrance to the boss,
 * so it was never armed and the reposition was scored against the run budget. Both lines below
 * are copied from a live capture:
 *
 *   [MovementAuthority] rejected reason=speed_delta character=Telahair level=JC_Mini2
 *     old=15254,3198 attempted=15541,4719 elapsedMs=983 allowed=1425 actual=1548
 *   [MovementAuthority] rejected reason=speed_delta character=Lanorut level=JC_Mini2
 *     old=15680,3066 attempted=15397,4719 elapsedMs=1015 allowed=1425 actual=1677
 *
 * Two players landing on the same authored floor of room 2, each refused. A refusal is not a
 * rubber-band the mover notices -- their own client has moved them and keeps sending small
 * deltas from the new room, which the server applies on top of the position it clamped them
 * back to -- so the server's copy of that body stays a room behind for the rest of the run,
 * and that is the point handed to every other screen.
 *
 * What may be accepted is bounded by the level's own authored room layout, so a sprint across
 * one long room is still `speed_delta`.
 */
function testADoorBetweenRoomsIsNotScoredAsASpeedCheat(): void {
    ensureDungeonRoomsLoaded();

    const doorJump = (from: [number, number], to: [number, number], gapMs: number, level = DUNGEON_LEVEL) => {
        const client: any = {
            userId: 9,
            token: 9,
            character: { name: 'Telahair' },
            currentLevel: level,
            movementAuthority: null
        };
        const entity = { x: from[0], y: from[1] };
        MovementAuthority.reset(client, 'test', from[0], from[1]);
        return MovementAuthority.validateIncrementalMovement(
            client,
            entity,
            to[0] - from[0],
            to[1] - from[1],
            MovementAuthority.nowMs() + gapMs,
            [0, 0],
            false
        );
    };

    for (const [from, to, gapMs] of [
        [[15254, 3198], [15541, 4719], 983],
        [[15680, 3066], [15397, 4719], 1015]
    ] as Array<[[number, number], [number, number], number]>) {
        const result = doorJump(from, to, gapMs);
        assert.equal(result.accepted, true, `the live door transition ${from} -> ${to} must be accepted`);
        assert.equal(result.reason, 'room_transition', 'and it must be recognised as a door, not merely tolerated');
        assert.equal(result.attemptedY, to[1], 'the player must end up on the floor their client reported');
    }

    // The bound. A jump of the same size that never leaves the room it started in is a cheat,
    // and so is one in a dungeon whose room layout the server does not know.
    assert.equal(
        doorJump([15100, 3200], [16400, 3200], 900).accepted,
        false,
        'crossing one room in a single packet is still a speed cheat'
    );
    assert.equal(
        doorJump([21450, 2959], [22952, 2959], 635, 'TutorialDungeon').accepted,
        false,
        'a level with no authored room registry must not authorise a teleport'
    );
}

/**
 * A door is two-sided, and the second side was missing.
 *
 * Walking through a door tears the old room down on the *mover's own* client, and it lets go
 * of everything that room held -- the other players included. Only the mover's body was ever
 * re-seeded; the peers were left to a server that still held a draw record for each of them,
 * so the sweep considered that screen correct and stayed silent for the rest of the run. The
 * mover walked into every later room alone.
 */
function testRoomTransitionRedrawsThePeersOnTheMoversOwnScreen(): void {
    const host = createClient('Telahair', 95101, 50);
    const walker = createClient('Lanorut', 95102, 22);
    seedStandingBody(host);
    seedStandingBody(walker);

    const sent: Array<{ viewer: string; subject: number }> = [];
    const originalSendEntity = (EntityHandler as any).sendEntity;
    (EntityHandler as any).sendEntity = (viewer: Client, entity: any) => {
        sent.push({ viewer: String(viewer.character?.name ?? '?'), subject: Number(entity?.id ?? 0) });
        viewer.knownEntityIds.add(Number(entity?.id ?? 0));
    };
    try {
        (EntityHandler as any).syncPlayerVisibilityInScope(walker);
        sent.length = 0;

        EntityHandler.markPeerBodiesNeedRedrawForViewer(walker);
        EntityHandler.reconcilePlayerVisibilityInScope(walker);
    } finally {
        (EntityHandler as any).sendEntity = originalSendEntity;
    }

    assert.deepEqual(
        sent.map((entry) => `${entry.viewer}:${entry.subject}`),
        [`Lanorut:${host.clientEntID}`],
        'the player who used the door must be sent the bodies their client dropped with the old room'
    );
}

/**
 * A dead enemy is dead for the whole party, and stays that way.
 *
 * Death used to be delivered by a single broadcast at the moment it happened, so a member who
 * missed that one packet kept the body standing for the rest of the run -- the live report was
 * two enemies alive on one screen, none on the other, and clear progress 65% against 75%. The
 * dead set is reconciled every pass instead: anything the scope has buried that a viewer is
 * still holding gets the destroy again, and nothing is sent once the screens agree.
 */
function testDeadEnemiesAreReconciledForEveryPartyMember(): void {
    const killer = createClient('Telahair', 97001, 50);
    const laggard = createClient('Lanorut', 97002, 22);
    seedStandingBody(killer);
    seedStandingBody(laggard);

    const levelMap = new Map<number, any>();
    GlobalState.levelEntities.set(SCOPE, levelMap);
    const corpse = {
        id: 920001,
        name: 'GreaterDemonMaligner',
        team: 2,
        isPlayer: false,
        clientSpawned: false,
        hp: 0,
        maxHp: 1000,
        dead: true,
        destroyed: true,
        x: 14000,
        y: 5000
    };
    levelMap.set(corpse.id, corpse);

    // The laggard's screen is still holding the body; the killer's already let go.
    laggard.entities.set(corpse.id, { ...corpse });
    laggard.knownEntityIds.add(corpse.id);

    const destroyed: number[] = [];
    const deadState: number[] = [];
    const originalSend = laggard.send;
    laggard.send = ((packetId: number) => {
        if (packetId === 0x0D) {
            destroyed.push(packetId);
        }
        if (packetId === 0x07) {
            deadState.push(packetId);
        }
    }) as never;
    try {
        CombatHandler.reconcileDeadHostilesForScope(SCOPE);
        assert.equal(destroyed.length, 1, 'the corpse must be removed from the screen still holding it');
        // The destroy alone only reaches entities that have a brain -- the client's 0x0D reader
        // sets a flag on the brain and nothing else. The dead-state update is what lets the
        // engine retire a brainless copy through its own path, so both must go out.
        assert.equal(deadState.length, 1, 'the dead-state update must go out with the destroy');

        // And it must genuinely retry. Gating this on the server's own bookkeeping and clearing
        // it in the same pass made it send once per corpse and never again -- one-shot delivery
        // wearing a reconcile's clothes, which is the failure this mechanism exists to prevent.
        CombatHandler.reconcileDeadHostilesForScope(SCOPE);
        assert.equal(destroyed.length, 2, 'the pair must be re-sent while the corpse may still be up');

        // But it is bounded: it stops rather than becoming a permanent stream.
        for (let tick = 0; tick < 20; tick++) {
            CombatHandler.reconcileDeadHostilesForScope(SCOPE);
        }
        assert.ok(destroyed.length <= 6, `retries must stop, got ${destroyed.length}`);
        assert.equal(destroyed.length, deadState.length, 'every destroy goes out with its dead state');
    } finally {
        laggard.send = originalSend;
    }
}

/**
 * One run, one clear percentage.
 *
 * The number is computed once for the whole scope, so two members showing different bars (4%
 * against 7% in the live report, with the hostile snapshot proving both held the same five
 * enemies in the same scope) can only mean the broadcast did not reach one of them. It read
 * `sessionsByLevelScope`, the derived index that has dropped a live player in every other
 * fan-out in this system.
 */
function testSharedProgressReachesAMemberMissingFromTheScopeIndex(): void {
    const host = createClient('Telahair', 98001, 50);
    const joiner = createClient('Lanorut', 98002, 22);

    // The index has lost the joiner -- present but short, which is exactly how it fails.
    GlobalState.sessionsByLevelScope.set(SCOPE, new Set([host]));

    const got: Array<{ name: string; packetId: number }> = [];
    for (const client of [host, joiner]) {
        client.send = ((packetId: number) => {
            got.push({ name: String(client.character?.name ?? '?'), packetId });
        }) as never;
    }

    (LevelHandler as any).broadcastSharedDungeonQuestProgress(SCOPE, 42);

    assert.ok(
        got.some((entry) => entry.name === 'Lanorut' && entry.packetId === 0xB7),
        'the member missing from the scope index must still be sent the run s progress'
    );
    assert.equal(joiner.character?.questTrackerState, 42, 'and their stored progress must match the run');
    assert.equal(host.character?.questTrackerState, 42, 'both members are on the same number');
}

async function run(): Promise<void> {
    ensureDataLoaded();

    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const levelEntities = new Map(GlobalState.levelEntities);

    try {
        resetState();
        testScopeIndexFollowsTheSessionThroughADoor();
        resetState();
        testClosingSessionDoesNotDestroyItsSuccessorsBody();
        resetState();
        testPlayerVisibilityIsExchangedBothWays();
        resetState();
        testAirborneBodyWithNoFloorSampleIsNotSeeded();
        resetState();
        testVisibilityResyncSurvivesAScopeChange();
        resetState();
        await testClientCannotDestroyAnotherPlayersBody();
        resetState();
        await testPeerBodyIsRedrawnAfterAClientReportsDroppingIt();
        resetState();
        testReconcileOnlyRedrawsMissingBodies();
        resetState();
        testRoomChangePushesThePlayerToEveryoneElse();
        resetState();
        testRoomChangeDropsTheOldRoomsFloorSample();
        resetState();
        testReconcileRedrawsABodyLeftInTheWrongRoom();
        resetState();
        testVisibilitySweepDrawsWhatPacketPathsMissed();
        resetState();
        testScopeAnchorFindsAPartyMateMissingFromTheIndex();
        resetState();
        testKnownButNeverDrawnBodyIsStillDrawn();
        resetState();
        testOnlyTheVisibilityPassPlacesPlayerBodies();
        resetState();
        testSnapshotRefreshRecordsWhatItDrew();
        resetState();
        testStuckAirborneFlagDoesNotHideAPlayerForever();
        resetState();
        testAPlayerIdNeverCollidesWithAnotherClientsOwnBodyId();
        resetState();
        testSpawnFallIsNotRejectedAsASpeedCheat();
        resetState();
        testEveryTransitionMarksTheBodyStaleEvenWithoutARoomChange();
        resetState();
        testDeadEnemiesAreReconciledForEveryPartyMember();
        resetState();
        testSharedProgressReachesAMemberMissingFromTheScopeIndex();
        console.log('player visibility regression passed');
    } finally {
        resetState();
        GlobalState.sessionsByToken = sessionsByToken;
        for (const [scope, map] of levelEntities) {
            GlobalState.levelEntities.set(scope, map);
        }
    }
}

void run();
