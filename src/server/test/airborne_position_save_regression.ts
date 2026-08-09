import { strict as assert } from 'assert';
import * as path from 'path';
import { Entity, EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { getLevelScopeKey } from '../core/LevelScope';

/*
 * A player must never be saved at a position they were only passing through.
 *
 * Every 0x07 movement packet used to overwrite the character's saved coordinates, airborne
 * ones included, so whatever was in flight when the player left the level became the point
 * they were returned to. Jade City had characters stored at y=-848 with no floor within
 * 1700px below -- coming back from a house or a dungeon replayed that fall every time.
 */
const LEVEL = 'JadeCity';
const GROUND_Y = 880;

function createPlayer(token: number): any {
    const client: any = {
        token,
        userId: token,
        clientEntID: token + 100,
        playerSpawned: true,
        currentLevel: LEVEL,
        levelInstanceId: '',
        currentRoomId: 1,
        authoritativeMaxHp: 5000,
        authoritativeCurrentHp: 5000,
        character: {
            name: 'Faller',
            level: 50,
            class: 'mage',
            MasterClass: 0,
            CurrentLevel: { name: LEVEL, x: 12_777, y: GROUND_Y }
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
            x: 12_777,
            y: GROUND_Y,
            team: EntityTeam.PLAYER,
            entState: EntityState.ACTIVE,
            roomId: 1
        }),
        // The floor sample a real client produces on arrival: its own absolute position, sent
        // in a standing full update, tagged with the level it was measured on. Only a sample
        // of that provenance may be replayed as a place to stand -- see core/GroundedPosition.
        groundedX: 12_777,
        groundedY: GROUND_Y,
        groundedLevel: LEVEL,
        groundedAbsolute: true,
        ownerToken: token,
        ownerUserId: token,
        hp: 5000,
        maxHp: 5000
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

function testGroundedMovementIsSaved(): void {
    const client = createPlayer(66_001);
    LevelHandler.handleEntityIncrementalUpdate(client, buildMovePayload(client.clientEntID, 40, 0));
    assert.equal(client.character.CurrentLevel.name, LEVEL);
    assert.equal(client.character.CurrentLevel.x, 12_817, 'walking on the ground still updates the save');
    assert.equal(client.character.CurrentLevel.y, GROUND_Y);
}

function testAirborneMovementIsNotSaved(): void {
    const client = createPlayer(66_002);
    // One tick of a jump. Repeated, these are what carried a character up to the y=-848 the
    // broken Jade City saves recorded.
    LevelHandler.handleEntityIncrementalUpdate(
        client,
        buildMovePayload(client.clientEntID, 20, -60, { airborne: true, jumping: true })
    );
    const airborneEntity = client.entities.get(client.clientEntID);
    assert.equal(airborneEntity.y, GROUND_Y - 60, 'the packet itself must be accepted, or this proves nothing');
    assert.equal(client.character.CurrentLevel.y, GROUND_Y, 'an airborne position must not become the return position');
    assert.equal(client.character.CurrentLevel.x, 12_777, 'and neither must the x it was passing over');

    // The first grounded packet after landing commits again, so the save self-heals: a
    // character carrying a bad position from before this fix keeps it only until they next
    // stand on something.
    LevelHandler.handleEntityIncrementalUpdate(client, buildMovePayload(client.clientEntID, 10, 0));
    const landed = client.entities.get(client.clientEntID);
    assert.equal(client.character.CurrentLevel.x, Math.round(landed.x), 'landing commits the position');
    assert.equal(client.character.CurrentLevel.y, Math.round(landed.y));
    assert.notEqual(client.character.CurrentLevel.x, 12_777, 'and it really did move');
}

function testDroppingThroughAPlatformIsNotSaved(): void {
    const client = createPlayer(66_003);
    LevelHandler.handleEntityIncrementalUpdate(
        client,
        buildMovePayload(client.clientEntID, 0, 60, { dropping: true, airborne: true, velocityY: 900 })
    );
    assert.equal(client.character.CurrentLevel.y, GROUND_Y, 'dropping through a soft platform is mid-air too');
}

// Arriving somewhere new while still falling must at least record the level, or logging out
// mid-fall would put the player back in the level they just left.
function testAirborneArrivalStillRecordsTheLevel(): void {
    const client = createPlayer(66_004);
    client.character.CurrentLevel = { name: 'CraftTown', x: 360, y: 1460 };
    LevelHandler.handleEntityIncrementalUpdate(
        client,
        buildMovePayload(client.clientEntID, 0, -60, { airborne: true, jumping: true })
    );
    assert.equal(client.character.CurrentLevel.name, LEVEL, 'the new level has to be recorded');
    const spawn = LevelConfig.getSpawn(LEVEL);
    assert.equal(client.character.CurrentLevel.x, Math.round(spawn.x), 'paired with the authored spawn');
    assert.equal(client.character.CurrentLevel.y, Math.round(spawn.y));
}

// The dungeon entry point is what a disconnect inside the dungeon returns the player to, and
// what walking back out puts them on. It must come from the grounded save, never from the live
// entity: the server has no collision, so entity.y is only a sum of movement deltas and its
// airborne flag is whatever the last packet carried. Trusting it dropped players through Dread
// Valhaven after they refreshed inside Dread The East Wing.
function testDungeonEntryUsesTheRecordedGroundedPosition(): void {
    const client = createPlayer(66_005);
    const entity = client.entities.get(client.clientEntID);
    entity.airborne = true;
    entity.y = GROUND_Y - 900;

    const syncState = (LevelHandler as any).buildTransferSyncState(client, 'JC_Mission1', null);
    assert.equal(syncState.syncEntryLevel, LEVEL);
    assert.equal(syncState.syncEntryHasCoord, true, 'the entry point still has to be recorded');
    assert.equal(syncState.syncEntryY, GROUND_Y, 'an airborne entry must not become the entry point');
    assert.equal(syncState.syncEntryX, 12_777);

    // A live position the server merely believes in does not win over the recorded one either:
    // an unflagged mid-air packet, a MovementAuthority correction the client ignored or a
    // coalesced burst all leave entity.y off the floor with airborne unset.
    entity.airborne = false;
    entity.x = 12_900;
    entity.y = GROUND_Y - 900;
    const staleSyncState = (LevelHandler as any).buildTransferSyncState(client, 'JC_Mission1', null);
    assert.equal(staleSyncState.syncEntryX, 12_777, 'the grounded save wins over the live entity');
    assert.equal(staleSyncState.syncEntryY, GROUND_Y);

    // No confirmed sample and no saved record for the source level either: the authored region
    // spawn is still a place the level puts players on, and the live entity is still not.
    delete entity.groundedX;
    delete entity.groundedY;
    delete entity.groundedLevel;
    delete entity.groundedAbsolute;
    client.character.CurrentLevel = { name: 'CraftTown', x: 360, y: 1460 };
    const spawn = LevelConfig.getSpawn(LEVEL);
    const fallbackSyncState = (LevelHandler as any).buildTransferSyncState(client, 'JC_Mission1', null);
    assert.equal(fallbackSyncState.syncEntryX, Math.round(spawn.x), 'falls back to the authored spawn');
    assert.equal(fallbackSyncState.syncEntryY, Math.round(spawn.y));
}

// The fall was reported in Valhaven first but nothing about it is regional, so every region a
// dungeon can be entered from has to reach a grounded entry point without consulting the live
// entity. Two of the 157 authored region->dungeon doors have no default spawn to fall back on
// (SwampRoadConnection), and those are covered by updateSavedLevelsOnTransfer instead: arriving
// in the region writes the door's authored spawn into CurrentLevel before its dungeon door is
// reachable, so the record is always there by the time it is needed.
function testEveryRegionReachesAGroundedEntryPoint(): void {
    const doorEntriesByTarget: Map<string, Array<{ sourceLevel: string; sourceDoorId: number }>> =
        (LevelConfig as any).DOOR_ENTRIES_BY_TARGET;
    const uncovered: string[] = [];
    let checked = 0;

    for (const [dungeon, entries] of doorEntriesByTarget) {
        if (!LevelConfig.isDungeonLevel(dungeon)) {
            continue;
        }
        for (const entry of entries) {
            const region = entry.sourceLevel;
            if (!LevelConfig.isSaveAllowedLevel(region)) {
                continue;
            }
            checked += 1;

            // A character who has never been recorded in the region: the authored default spawn
            // has to carry it.
            const bare = LevelConfig.resolveDungeonEntryCoordinates(dungeon, region, { name: 'Faller' });
            if (bare.hasCoord) {
                continue;
            }

            // No default spawn. Walking into the region must still leave a record behind, or the
            // entry point falls through to the live entity.
            const arrival: any = { name: 'Faller' };
            const doorSpawn = (LevelConfig as any).getDoorSpawn(region, entry.sourceDoorId) ??
                (LevelConfig as any).getDoorSpawn(region, 1);
            LevelConfig.updateSavedLevelsOnTransfer(
                arrival,
                'NewbieRoad',
                region,
                Math.round(Number(doorSpawn?.x ?? 0)),
                Math.round(Number(doorSpawn?.y ?? 0))
            );
            const afterArrival = LevelConfig.resolveDungeonEntryCoordinates(dungeon, region, arrival);
            if (!afterArrival.hasCoord || !doorSpawn) {
                uncovered.push(`${region} -> ${dungeon}`);
            }
        }
    }

    assert.ok(checked > 100, `expected the authored door table to be loaded, saw ${checked} pairs`);
    assert.deepEqual(uncovered, [], 'every region must reach a grounded dungeon entry point');
}

// Losing connection inside a dungeon must put the player back exactly where they last stood in
// the region, not on a coordinate the server reconstructed for them. Dungeons never write
// CurrentLevel, so that position is still on the character the whole time they are inside.
function testDungeonReturnKeepsTheLastPositionStoodOnInTheRegion(): void {
    // The region record is a confirmed floor point now: one the player's own client reported
    // standing on. CurrentLevel/PreviousLevel are dead-reckoned and no longer replayed.
    const char: any = {
        name: 'Faller',
        CurrentLevel: { name: 'JadeCityHard', x: 8_400, y: 1_058 },
        GroundedSpawns: { jadecityhard: { x: 8_400, y: 1_058, at: Date.now() } }
    };

    // An entry point that lost the floor -- the symptom being defended against.
    const airborneEntry = { x: 8_400, y: -848, hasCoord: true };
    const returned = LevelConfig.resolveDungeonSafeReturn('JC_Mini2Hard', 'JadeCityHard', char, airborneEntry);
    assert.ok(returned, 'a persistent dungeon must resolve a safe return');
    assert.equal(returned!.level, 'JadeCityHard');
    assert.equal(returned!.x, 8_400);
    assert.equal(returned!.y, 1_058, 'the position the player last stood on wins over the entry point');

    // Home works the same way: the confirmed point is kept per level, so being in CraftTown
    // does not lose the one earned in the region the dungeon was entered from.
    const homeChar: any = {
        name: 'Faller',
        CurrentLevel: { name: 'CraftTown', x: 360, y: 1_460 },
        PreviousLevel: { name: 'JadeCityHard', x: 9_100, y: 1_058 },
        GroundedSpawns: {
            crafttown: { x: 360, y: 1_460, at: Date.now() },
            jadecityhard: { x: 9_100, y: 1_058, at: Date.now() }
        }
    };
    const homeReturn = LevelConfig.resolveDungeonSafeReturn('JC_Mini2Hard', 'JadeCityHard', homeChar, airborneEntry);
    assert.equal(homeReturn!.x, 9_100, 'the region record is used even when it sits in PreviousLevel');
    assert.equal(homeReturn!.y, 1_058);

    // With no record for the region at all the entry point is still better than nothing.
    const bare: any = { name: 'Faller' };
    const fallback = LevelConfig.resolveDungeonSafeReturn('JC_Mini2Hard', 'JadeCityHard', bare, {
        x: 7_200,
        y: 1_058,
        hasCoord: true
    });
    assert.equal(fallback!.x, 7_200, 'the entry point remains the fallback');
    assert.equal(fallback!.y, 1_058);
}

function main(): void {
    const dataDir = path.resolve(__dirname, '../data');
    LevelConfig.load(dataDir);
    GameData.load(dataDir);

    const levelEntities = new Map(GlobalState.levelEntities);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    try {
        testGroundedMovementIsSaved();
        testAirborneMovementIsNotSaved();
        testDroppingThroughAPlatformIsNotSaved();
        testAirborneArrivalStillRecordsTheLevel();
        testDungeonEntryUsesTheRecordedGroundedPosition();
        testEveryRegionReachesAGroundedEntryPoint();
        testDungeonReturnKeepsTheLastPositionStoodOnInTheRegion();
        console.log('airborne_position_save_regression: ok');
    } finally {
        GlobalState.levelEntities = levelEntities as any;
        GlobalState.sessionsByToken = sessionsByToken as any;
    }
}

main();
