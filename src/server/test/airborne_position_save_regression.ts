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
        console.log('airborne_position_save_regression: ok');
    } finally {
        GlobalState.levelEntities = levelEntities as any;
        GlobalState.sessionsByToken = sessionsByToken as any;
    }
}

main();
