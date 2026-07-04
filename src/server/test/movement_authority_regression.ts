import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import { GlobalState } from '../core/GlobalState';
import { MovementAuthority, MovementAuthorityClient } from '../core/MovementAuthority';
import { getLevelScopeKey } from '../core/LevelScope';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = MovementAuthorityClient & {
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    entities: Map<number, any>;
    entityIdAliases: Map<number, number>;
    knownEntityIds: Set<number>;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function createClient(name: string, token: number): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = {
        name,
        equippedMount: 0,
        CurrentLevel: { name: 'NewbieRoad', x: 0, y: 0 }
    };

    return {
        userId: token,
        token,
        character,
        currentLevel: 'NewbieRoad',
        levelInstanceId: 'movement-test',
        currentRoomId: 1,
        playerSpawned: true,
        clientEntID: token,
        entities: new Map<number, any>(),
        entityIdAliases: new Map<number, number>(),
        knownEntityIds: new Set<number>(),
        movementAuthority: MovementAuthority.createState(),
        pendingTransferUntil: 0,
        mountTransferGraceUntil: 0,
        activeDungeonCutsceneScope: '',
        sentPackets,
        socket: {},
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createPlayerEntity(client: FakeClient): any {
    return {
        id: client.clientEntID,
        name: client.character?.name,
        ownerCharacterName: client.character?.name,
        ownerUserId: client.userId,
        ownerToken: client.token,
        isPlayer: true,
        team: 1,
        x: 0,
        y: 0,
        v: 0,
        entState: 0,
        facingLeft: false,
        bRunning: true,
        roomId: client.currentRoomId
    };
}

function buildMovementPayload(entityId: number, dx: number, dy: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod45(dx);
    bb.writeMethod45(dy);
    bb.writeMethod45(0);
    bb.writeMethod6(0, 2);
    bb.writeMethod15(false);
    bb.writeMethod15(true);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function testNormalMovementPasses(): void {
    const client = createClient('Runner', 1001);
    const entity = createPlayerEntity(client);
    MovementAuthority.reset(client, 'spawn', 0, 0, 1000);

    let result = MovementAuthority.validateIncrementalMovement(client, entity, 25, 0, 1033);
    assert.equal(result.accepted, true, 'normal 30fps movement should pass');
    entity.x += 25;

    result = MovementAuthority.validateIncrementalMovement(client, entity, 12, 0, 1049);
    assert.equal(result.accepted, true, 'normal 60fps movement should pass');
}

function testLagSpikeWithinTolerancePasses(): void {
    const client = createClient('LagRunner', 1002);
    const entity = createPlayerEntity(client);
    MovementAuthority.reset(client, 'spawn', 0, 0, 1000);

    const result = MovementAuthority.validateIncrementalMovement(client, entity, 800, 0, 2000);
    assert.equal(result.accepted, true, 'lag spike movement inside server-time allowance should pass');
}

function testSpeedhackAndTeleportReject(): void {
    const client = createClient('FastRunner', 1003);
    const entity = createPlayerEntity(client);
    MovementAuthority.reset(client, 'spawn', 0, 0, 1000);

    let result = MovementAuthority.validateIncrementalMovement(client, entity, 180, 0, 1033);
    assert.equal(result.accepted, false, '5x speedhack-sized movement should be rejected');
    assert.equal(result.reason, 'speed_delta');

    result = MovementAuthority.validateIncrementalMovement(client, entity, 5000, 0, 2033);
    assert.equal(result.accepted, false, 'teleport-sized movement should be rejected without grace');
    assert.equal(result.reason, 'teleport_delta');
}

function testTransferGraceAndReset(): void {
    const client = createClient('TransferRunner', 1004);
    const entity = createPlayerEntity(client);
    MovementAuthority.reset(client, 'spawn', 0, 0, 1000);

    client.pendingTransferUntil = 2500;
    let result = MovementAuthority.validateIncrementalMovement(client, entity, 5000, 0, 1100);
    assert.equal(result.accepted, true, 'transfer grace should allow a spawn-sized movement correction');

    MovementAuthority.reset(client, 'door_transfer', 100, 200, 3000);
    entity.x = 100;
    entity.y = 200;
    result = MovementAuthority.validateIncrementalMovement(client, entity, 20, 0, 3033);
    assert.equal(result.accepted, true, 'movement validation should reset cleanly after transfer');
}

function testInvalidMovementIsNotBroadcast(): void {
    const source = createClient('Fireboy', 2001);
    const viewer = createClient('Watergirl', 2002);
    const sourceEntity = createPlayerEntity(source);
    const viewerEntity = createPlayerEntity(viewer);
    source.entities.set(source.clientEntID, sourceEntity);
    viewer.entities.set(source.clientEntID, { ...sourceEntity });
    viewer.entities.set(viewer.clientEntID, viewerEntity);
    source.knownEntityIds.add(source.clientEntID);
    viewer.knownEntityIds.add(source.clientEntID);
    viewer.knownEntityIds.add(viewer.clientEntID);

    const scope = getLevelScopeKey(source.currentLevel, source.levelInstanceId);
    GlobalState.levelEntities.set(scope, new Map<number, any>([
        [source.clientEntID, sourceEntity],
        [viewer.clientEntID, viewerEntity]
    ]));
    GlobalState.sessionsByToken.set(source.token, source as never);
    GlobalState.sessionsByToken.set(viewer.token, viewer as never);

    MovementAuthority.reset(source, 'spawn', 0, 0);
    LevelHandler.handleEntityIncrementalUpdate(source as never, buildMovementPayload(source.clientEntID, 1000, 0));

    assert.equal(sourceEntity.x, 0, 'invalid movement should not mutate accepted server position');
    assert.equal(viewer.sentPackets.filter((packet) => packet.id === 0x07).length, 0, 'invalid movement should not be broadcast to other clients');
    assert.ok(source.sentPackets.some((packet) => packet.id === 0x07), 'source should receive a correction packet');
}

function main(): void {
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const levelEntities = new Map(GlobalState.levelEntities);

    try {
        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        testNormalMovementPasses();
        testLagSpikeWithinTolerancePasses();
        testSpeedhackAndTeleportReject();
        testTransferGraceAndReset();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        testInvalidMovementIsNotBroadcast();
        console.log('movement_authority_regression: ok');
    } finally {
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.levelEntities = levelEntities;
    }
}

void main();