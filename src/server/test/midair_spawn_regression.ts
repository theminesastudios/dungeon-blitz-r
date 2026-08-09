import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import * as path from 'path';
import { Entity, EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { getLevelScopeKey } from '../core/LevelScope';
import { inheritGroundedSample, isEntityAirborne, noteGroundedSample } from '../core/GroundedPosition';
import { RegionPositionPersistence } from '../core/RegionPositionPersistence';

/*
 * A player must never be placed on a point that has no floor under it.
 *
 * The server has no collision: entity.x/y is a running sum of movement deltas and its
 * `airborne` flag is whatever the last 0x07 carried. Two paths trusted it anyway --
 * party anchor spawns dropped a joining player onto a mid-jump team mate, and a level
 * with no authored spawn recorded the airborne arrival position as the save point.
 */
const LEVEL = 'JadeCity';
const GROUND_Y = 1_058;
// The two save-allowed levels in level_config.json with no DEFAULT_SPAWNS entry.
const UNAUTHORED_LEVEL = 'SwampRoadConnection';

function createPlayer(token: number, levelName: string = LEVEL, groundY: number = GROUND_Y): any {
    const client: any = {
        token,
        userId: token,
        clientEntID: token + 100,
        playerSpawned: true,
        currentLevel: levelName,
        levelInstanceId: '',
        currentRoomId: 1,
        authoritativeMaxHp: 5_000,
        authoritativeCurrentHp: 5_000,
        character: {
            name: `Anchor${token}`,
            level: 50,
            class: 'mage',
            MasterClass: 0,
            CurrentLevel: { name: levelName, x: 10_430, y: groundY }
        },
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map(),
        processedRewardSources: new Set(),
        pendingLoot: new Map(),
        sharedEntityRemoteUpdateDeferredIds: new Set(),
        entities: new Map(),
        movementAuthority: null,
        sentPackets: [] as Array<{ id: number }>,
        send(id: number) { this.sentPackets.push({ id }); },
        sendBitBuffer(id: number) { this.sentPackets.push({ id }); }
    };

    const playerEntity: any = {
        ...Entity.fromCharacter(client.clientEntID, client.character, {
            x: 10_430,
            y: groundY,
            team: EntityTeam.PLAYER,
            entState: EntityState.ACTIVE,
            roomId: 1
        }),
        ownerToken: token,
        isPlayer: true,
        hp: 5_000,
        maxHp: 5_000
    };

    client.entities.set(client.clientEntID, playerEntity);
    client.knownEntityIds.add(client.clientEntID);

    const scope = getLevelScopeKey(client.currentLevel, client.levelInstanceId);
    GlobalState.levelEntities.set(scope, new Map([[client.clientEntID, playerEntity]]) as any);
    GlobalState.sessionsByToken.set(token, client);
    GlobalState.refreshSessionIndexes(client);
    return client;
}

function buildMovePayload(
    entityId: number,
    deltaX: number,
    deltaY: number,
    options: { jumping?: boolean; dropping?: boolean; airborne?: boolean; velocityY?: number } = {}
): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod45(deltaX);
    bb.writeMethod45(deltaY);
    bb.writeMethod45(0);
    bb.writeMethod6(EntityState.ACTIVE, 2);
    bb.writeMethod15(false); // bLeft
    bb.writeMethod15(false); // bRunning
    bb.writeMethod15(Boolean(options.jumping));
    bb.writeMethod15(Boolean(options.dropping));
    bb.writeMethod15(false); // bBackpedal
    bb.writeMethod15(Boolean(options.airborne));
    if (options.airborne) {
        bb.writeMethod24(Math.round(Number(options.velocityY ?? -900)));
    }
    return bb.toBuffer();
}

// Only a standing packet may leave a grounded sample behind.
function testGroundedSampleTracksTheLastStandingPosition(): void {
    const client = createPlayer(77_001);
    LevelHandler.handleEntityIncrementalUpdate(client, buildMovePayload(client.clientEntID, 40, 0));

    const entity = client.entities.get(client.clientEntID);
    assert.equal(entity.groundedX, 10_470, 'walking records where the player stood');
    assert.equal(entity.groundedY, GROUND_Y);

    LevelHandler.handleEntityIncrementalUpdate(
        client,
        buildMovePayload(client.clientEntID, 20, -60, { airborne: true, jumping: true })
    );
    const jumping = client.entities.get(client.clientEntID);
    assert.equal(jumping.y, GROUND_Y - 60, 'the jump packet must be accepted, or this proves nothing');
    assert.equal(jumping.groundedX, 10_470, 'a jump must not move the grounded sample');
    assert.equal(jumping.groundedY, GROUND_Y);
}

/**
 * The helper every anchor spawn goes through.
 *
 * It answers with a confirmed sample or with nothing. "Nothing" is a good answer: the caller
 * falls back to the level's own spawn marker, which is floor by construction, where a
 * dead-reckoned guess is only floor by luck.
 */
function testAnchorPositionRefusesOpenAir(): void {
    assert.equal(LevelHandler.resolveGroundedAnchorPosition(null), null);

    assert.deepEqual(
        LevelHandler.resolveGroundedAnchorPosition({
            x: 5,
            y: 9,
            groundedX: 100,
            groundedY: 200,
            groundedAbsolute: true,
            airborne: true,
        }),
        { x: 100, y: 200 },
        'the confirmed sample wins over a live airborne position'
    );

    assert.equal(
        LevelHandler.resolveGroundedAnchorPosition({ x: 100, y: -848, airborne: true }),
        null,
        'no grounded sample and airborne means no safe spot'
    );
    assert.equal(
        LevelHandler.resolveGroundedAnchorPosition({ x: 100, y: -848, bJumping: true }),
        null,
        'mid-jump counts as airborne even if the airborne flag lagged'
    );
    assert.equal(
        LevelHandler.resolveGroundedAnchorPosition({ x: 100, y: -848, bDropping: true }),
        null,
        'dropping through a platform counts too'
    );

    assert.equal(
        LevelHandler.resolveGroundedAnchorPosition({ x: 640, y: 880 }),
        null,
        'a live position the client never confirmed is not a place to put a body'
    );
}

// A level with no authored spawn used to record the airborne arrival position itself.
function testAirborneArrivalNeverSavesOpenAir(): void {
    const client = createPlayer(77_002, UNAUTHORED_LEVEL, 600);
    client.character.CurrentLevel = { name: 'BridgeTown', x: 3_944, y: 838 };

    LevelHandler.handleEntityIncrementalUpdate(
        client,
        buildMovePayload(client.clientEntID, 0, -60, { airborne: true, jumping: true })
    );

    const entity = client.entities.get(client.clientEntID);
    assert.equal(entity.y, 540, 'the arrival packet must be accepted');
    assert.equal(
        LevelConfig.normalizeLevelName(client.character.CurrentLevel.name),
        LevelConfig.normalizeLevelName(UNAUTHORED_LEVEL),
        'the level still has to be recorded or a logout mid-fall rewinds the player'
    );
    assert.notEqual(client.character.CurrentLevel.y, 540, 'but never at the airborne y');
    assert.equal(client.character.CurrentLevel.x, 0, 'no authored spawn means no coordinates');
    assert.equal(client.character.CurrentLevel.y, 0);
}

// ...and that placeholder must not be replayed as a real point at the world origin.
function testUnauthoredSpawnYieldsNoCoordinate(): void {
    const character: any = { CurrentLevel: { name: UNAUTHORED_LEVEL, x: 0, y: 0 } };
    const resolved = LevelConfig.getSpawnCoordinates(character, 'BridgeTown', UNAUTHORED_LEVEL);
    assert.equal(resolved.hasCoord, false, 'the client must place the player on its own spawn marker');

    // A level that does have an authored spawn is unaffected.
    const authored: any = { CurrentLevel: { name: 'JadeCity', x: 0, y: 0 } };
    const jade = LevelConfig.getSpawnCoordinates(authored, 'BridgeTown', 'JadeCity');
    assert.equal(jade.hasCoord, true);
    assert.equal(jade.x, 10_430, 'a 0,0 record falls through to the authored spawn');
    assert.equal(jade.y, 1_058);

    // A dead-reckoned CurrentLevel is no longer replayed as a place to stand. It is a sum of
    // movement deltas on a base the client silently corrects whenever it snaps a spawn onto
    // floor or lets one fall, so it can be anywhere relative to real floor -- and being wrong
    // compounded, because the next entry fell from the error the last one left behind.
    const deadReckoned: any = { CurrentLevel: { name: 'JadeCity', x: 12_777, y: 880 } };
    const ignored = LevelConfig.getSpawnCoordinates(deadReckoned, 'BridgeTown', 'JadeCity');
    assert.deepEqual(
        { x: ignored.x, y: ignored.y },
        { x: 10_430, y: 1_058 },
        'an unconfirmed coordinate falls through to the authored spawn, which is floor',
    );
}

/**
 * The only coordinate a spawn may replay is one the client reported standing on.
 *
 * `GroundedSpawns` is written from a standing full update -- the one packet carrying a
 * position the server did not compute for itself -- and nothing else is trusted, so the worst
 * case is "no confirmed point yet, use the authored spawn" rather than "drop them from the
 * height of last time's error".
 */
function testOnlyAConfirmedPositionIsReplayed(): void {
    const character: any = {};
    assert.equal(LevelConfig.getConfirmedSpawnForLevel(character, 'JadeCity'), null);

    assert.equal(LevelConfig.rememberConfirmedSpawn(character, 'JadeCity', 12_777, GROUND_Y), true);
    assert.deepEqual(
        LevelConfig.getConfirmedSpawnForLevel(character, 'JadeCity'),
        { x: 12_777, y: GROUND_Y },
    );

    const resolved = LevelConfig.getSpawnCoordinates(character, 'BridgeTown', 'JadeCity');
    assert.deepEqual(
        { x: resolved.x, y: resolved.y, hasCoord: resolved.hasCoord },
        { x: 12_777, y: GROUND_Y, hasCoord: true },
        'a confirmed point is what the player came back for',
    );

    // One level's confirmed point is never offered for another.
    assert.equal(LevelConfig.getConfirmedSpawnForLevel(character, 'BridgeTown'), null);
    const elsewhere = LevelConfig.getSpawnCoordinates(character, 'JadeCity', 'BridgeTown');
    assert.deepEqual({ x: elsewhere.x, y: elsewhere.y }, { x: 3_944, y: 838 }, 'authored spawn instead');

    // 0,0 is the placeholder every position reset writes; storing it would make a record look
    // real while pointing at the world origin.
    assert.equal(LevelConfig.rememberConfirmedSpawn(character, 'CraftTown', 0, 0), false);
    assert.equal(LevelConfig.getConfirmedSpawnForLevel(character, 'CraftTown'), null);
}

/** A dead-reckoned sample must never satisfy a caller that is about to place a body. */
function testAnchorsRequireAConfirmedSample(): void {
    const deadReckoned: any = {};
    noteGroundedSample(deadReckoned, 640, 880, false, LEVEL);
    assert.equal(
        LevelHandler.resolveGroundedAnchorPosition(deadReckoned, LEVEL),
        null,
        'the server computed this position, so it is not evidence of floor',
    );

    const confirmed: any = {};
    noteGroundedSample(confirmed, 640, 880, false, LEVEL, true);
    assert.deepEqual(
        LevelHandler.resolveGroundedAnchorPosition(confirmed, LEVEL),
        { x: 640, y: 880 },
        'the client reported standing here',
    );
    assert.equal(
        LevelHandler.resolveGroundedAnchorPosition(confirmed, 'CraftTown'),
        null,
        'and only for the level it was measured on',
    );

    // An airborne packet never becomes a confirmed point, whichever spelling it uses.
    const midJump: any = {};
    noteGroundedSample(midJump, 900, -200, true, LEVEL, true);
    assert.equal(LevelHandler.resolveGroundedAnchorPosition(midJump, LEVEL), null);
}

// The full-update packet spells the airborne state `jumping`/`dropping`, so a check that
// only knew the 0x07 spelling read a mid-jump body as standing.
function testBothPacketSpellingsCountAsAirborne(): void {
    assert.equal(isEntityAirborne({ airborne: true }), true);
    assert.equal(isEntityAirborne({ bJumping: true }), true);
    assert.equal(isEntityAirborne({ bDropping: true }), true);
    assert.equal(isEntityAirborne({ jumping: true }), true, 'the full-update spelling counts');
    assert.equal(isEntityAirborne({ dropping: true }), true, 'the full-update spelling counts');
    assert.equal(isEntityAirborne({ x: 10, y: 20 }), false);

    assert.equal(
        LevelHandler.resolveGroundedAnchorPosition({ x: 100, y: -848, jumping: true }),
        null,
        'a mid-jump full update is not a place to put a body'
    );
}

// A full update rebuilds the player entity from scratch; the floor sample has to survive it,
// and so does the provenance that makes it usable as a spawn.
function testFullUpdateKeepsTheFloorSample(): void {
    const previous = {
        x: 900,
        y: -200,
        groundedX: 640,
        groundedY: 880,
        groundedLevel: LEVEL,
        groundedAbsolute: true,
    };

    const rebuiltMidJump: any = { x: 900, y: -200, jumping: true };
    inheritGroundedSample(rebuiltMidJump, previous);
    noteGroundedSample(rebuiltMidJump, 900, -200, true, LEVEL, true);
    assert.deepEqual(
        LevelHandler.resolveGroundedAnchorPosition(rebuiltMidJump, LEVEL),
        { x: 640, y: 880 },
        'the inherited sample must survive a full update sent in mid-air'
    );

    const rebuiltStanding: any = { x: 1_200, y: 880 };
    inheritGroundedSample(rebuiltStanding, previous);
    noteGroundedSample(rebuiltStanding, 1_200, 880, false, LEVEL, true);
    assert.deepEqual(
        LevelHandler.resolveGroundedAnchorPosition(rebuiltStanding, LEVEL),
        { x: 1_200, y: 880 },
        'a standing full update carries the client’s own absolute position and replaces the sample'
    );
}

// Leaving a level mid-jump must not file the airborne point as the way back in.
function testTransferSourcePositionRefusesOpenAir(): void {
    const character: any = { CurrentLevel: { name: LEVEL, x: 10_470, y: GROUND_Y } };
    const syncSourcePosition = (LevelHandler as any).syncTransferSourcePositionFromLiveEntity.bind(LevelHandler);

    syncSourcePosition(character, LEVEL, { x: 11_000, y: -848, jumping: true });
    assert.deepEqual(
        character.CurrentLevel,
        { name: LEVEL, x: 10_470, y: GROUND_Y },
        'taking a door mid-jump keeps the last grounded return point'
    );

    // A sample the server computed for itself is not a return point either, however grounded
    // its flags claim to be -- only one the client reported standing on.
    syncSourcePosition(character, LEVEL, { x: 11_000, y: -848, airborne: true, groundedX: 11_000, groundedY: GROUND_Y });
    assert.deepEqual(
        character.CurrentLevel,
        { name: LEVEL, x: 10_470, y: GROUND_Y },
        'a dead-reckoned floor sample under a falling body is not a return point'
    );

    syncSourcePosition(character, LEVEL, {
        x: 11_000,
        y: -848,
        airborne: true,
        groundedX: 11_000,
        groundedY: GROUND_Y,
        groundedLevel: LEVEL,
        groundedAbsolute: true,
    });
    assert.deepEqual(
        character.CurrentLevel,
        { name: LEVEL, x: 11_000, y: GROUND_Y },
        'the confirmed floor sample under a falling body is a valid return point'
    );

    // ...and a confirmed sample from another level is refused outright.
    syncSourcePosition(character, LEVEL, {
        x: 12_000,
        y: GROUND_Y,
        groundedX: 12_000,
        groundedY: GROUND_Y,
        groundedLevel: 'CraftTown',
        groundedAbsolute: true,
    });
    assert.deepEqual(
        character.CurrentLevel,
        { name: LEVEL, x: 11_000, y: GROUND_Y },
        'CraftTown floor is not a JadeCity return point'
    );
}

// The record replayed on the next login is the other way a player arrives in mid-air.
function testDisconnectSaveRefusesOpenAir(): void {
    const client: any = {
        userId: 77_003,
        currentLevel: LEVEL,
        character: {
            name: 'Faller',
            id: 77_003,
            CurrentLevel: { name: LEVEL, x: 10_430, y: GROUND_Y }
        }
    };

    RegionPositionPersistence.forget(client);
    assert.equal(
        RegionPositionPersistence.record(client, { x: 9_000, y: -2_129, airborne: true }, 'disconnect'),
        true,
        'the level still has to be recorded'
    );
    assert.deepEqual(
        { x: client.character.LastRegionPosition.x, y: client.character.LastRegionPosition.y },
        { x: 10_430, y: GROUND_Y },
        'a disconnect in mid-air saves the last standing point, not the fall'
    );

    RegionPositionPersistence.forget(client);
    RegionPositionPersistence.record(client, { x: 9_000, y: -2_129, airborne: true, groundedX: 9_000, groundedY: 700 }, 'disconnect');
    assert.deepEqual(
        { x: client.character.LastRegionPosition.x, y: client.character.LastRegionPosition.y },
        { x: 9_000, y: 700 },
        'the floor sample wins over both the live position and the older save'
    );

    // A saved record belonging to a different level is not a usable fallback.
    RegionPositionPersistence.forget(client);
    client.character.CurrentLevel = { name: 'BridgeTown', x: 3_944, y: 838 };
    delete client.character.LastRegionPosition;
    assert.equal(
        RegionPositionPersistence.record(client, { x: 9_000, y: -2_129, airborne: true }, 'disconnect'),
        false,
        'another level’s coordinates must never be filed under this one'
    );
}

function main(): void {
    const dataDir = path.resolve(__dirname, '../data');
    LevelConfig.load(dataDir);
    GameData.load(dataDir);

    const levelEntities = new Map(GlobalState.levelEntities);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    try {
        testGroundedSampleTracksTheLastStandingPosition();
        testAnchorPositionRefusesOpenAir();
        testAirborneArrivalNeverSavesOpenAir();
        testUnauthoredSpawnYieldsNoCoordinate();
        testOnlyAConfirmedPositionIsReplayed();
        testAnchorsRequireAConfirmedSample();
        testBothPacketSpellingsCountAsAirborne();
        testFullUpdateKeepsTheFloorSample();
        testTransferSourcePositionRefusesOpenAir();
        testDisconnectSaveRefusesOpenAir();
        console.log('midair_spawn_regression: ok');
    } finally {
        GlobalState.levelEntities.clear();
        for (const [key, value] of levelEntities) {
            GlobalState.levelEntities.set(key, value);
        }
        GlobalState.sessionsByToken.clear();
        for (const [key, value] of sessionsByToken) {
            GlobalState.sessionsByToken.set(key, value);
        }
    }
}

main();
