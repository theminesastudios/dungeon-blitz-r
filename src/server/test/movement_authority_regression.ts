import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { MovementAuthority } from '../core/MovementAuthority';
import { CombatHandler } from '../handlers/CombatHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

function buildPowerCastPayload(sourceId: number, powerId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(sourceId);
    bb.writeMethod4(powerId);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildMovementPayload(entityId: number, deltaX: number, deltaY: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod45(deltaX);
    bb.writeMethod45(deltaY);
    bb.writeMethod45(0);
    bb.writeMethod6(EntityState.ACTIVE, 2);
    for (let index = 0; index < 6; index++) bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildPowerHitPayload(targetId: number, sourceId: number, damage: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(targetId);
    bb.writeMethod4(sourceId);
    bb.writeMethod24(damage);
    bb.writeMethod4(100);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function createClient(token: number, entityId: number, name: string): any {
    const sentPackets: Array<{ id: number; payload: Buffer }> = [];
    let destroyed = false;
    return {
        token,
        userId: token,
        playerSpawned: true,
        clientEntID: entityId,
        currentLevel: 'NewbieRoad',
        levelInstanceId: '',
        currentRoomId: 1,
        pendingTransferUntil: 0,
        mountTransferGraceUntil: 0,
        activeDungeonCutsceneScope: '',
        character: { name, equippedMount: 0, CurrentLevel: { name: 'NewbieRoad', x: 0, y: 0 } },
        entities: new Map<number, any>(),
        entityIdAliases: new Map<number, number>(),
        knownEntityIds: new Set<number>(),
        movementAuthority: MovementAuthority.createState(),
        sentPackets,
        send(id: number, payload: Buffer): void { sentPackets.push({ id, payload: Buffer.from(payload) }); },
        sendBitBuffer(id: number, bb: BitBuffer): void { sentPackets.push({ id, payload: bb.toBuffer() }); },
        socket: { destroy(): void { destroyed = true; } },
        get destroyed(): boolean { return destroyed; }
    };
}

async function main(): Promise<void> {
    LevelConfig.load(path.resolve(__dirname, '../data'));
    const client = createClient(97_001, 98_001, 'Dasher');
    const remote = createClient(97_002, 98_002, 'Remote');
    const ownEntity = { id: client.clientEntID, isPlayer: true, ownerToken: client.token, team: 1, x: 0, y: 0, entState: EntityState.ACTIVE };
    const remoteEntity = { id: remote.clientEntID, isPlayer: true, ownerToken: remote.token, team: 1, x: 100, y: 100, entState: EntityState.ACTIVE };
    const hostile = { id: 98_101, name: 'GoblinBrute', isPlayer: false, team: 2, roomId: 1, x: 100, y: 0, hp: 100, maxHp: 100, entState: EntityState.ACTIVE };
    client.entities.set(ownEntity.id, ownEntity);
    client.entities.set(remoteEntity.id, remoteEntity);
    remote.entities.set(remoteEntity.id, remoteEntity);
    const scope = getClientLevelScope(client);
    GlobalState.levelEntities.set(scope, new Map<number, any>([[ownEntity.id, ownEntity], [remoteEntity.id, remoteEntity], [hostile.id, hostile]]));
    GlobalState.sessionsByToken.set(client.token, client);
    GlobalState.sessionsByToken.set(remote.token, remote);

    try {
        const now = Date.now();
        MovementAuthority.reset(client, 'spawn', 0, 0, now);
        const ordinaryTeleport = MovementAuthority.validateIncrementalMovement(client, ownEntity, 1200, 0, now + 50);
        assert.equal(ordinaryTeleport.accepted, false, 'ordinary movement accepted a dash-sized teleport');

        MovementAuthority.reset(client, 'spawn', 0, 0, now);
        ownEntity.x = 0;
        ownEntity.y = 0;
        let acceptedHighRateDistance = 0;
        for (let index = 1; index <= 20; index++) {
            const result = MovementAuthority.validateIncrementalMovement(client, ownEntity, 100, 0, now + (index * 5));
            if (!result.accepted) {
                break;
            }
            ownEntity.x += 100;
            acceptedHighRateDistance += 100;
        }
        assert.equal(
            acceptedHighRateDistance <= 500,
            true,
            `high-rate movement packets created too much distance: ${acceptedHighRateDistance}`
        );

        MovementAuthority.reset(client, 'spawn', 0, 0, now);
        ownEntity.x = 0;
        ownEntity.y = 0;
        const normalStep = MovementAuthority.validateIncrementalMovement(client, ownEntity, 80, 0, now + 50);
        assert.equal(normalStep.accepted, true, 'normal server-timed movement was rejected');
        ownEntity.x += 80;
        const highRateReplay = MovementAuthority.validateIncrementalMovement(client, ownEntity, 300, 0, now + 60);
        assert.equal(highRateReplay.accepted, false, 'high-rate replayed movement packet gained extra distance');
        assert.equal(highRateReplay.reason, 'speed_delta');

        MovementAuthority.reset(client, 'spawn', 0, 0, now - 635);
        ownEntity.x = 0;
        ownEntity.y = 0;
        client.movementAuthority.movementBudgetDistance = 674;
        client.movementAuthority.movementBudgetUpdatedAtMs = now - 635;
        client.sentPackets.length = 0;
        LevelHandler.handleEntityIncrementalUpdate(client, buildMovementPayload(client.clientEntID, 1502, 0));
        assert.equal(ownEntity.x, 1020, 'speed_delta correction froze the authoritative player instead of advancing to the server budget cap');
        assert.equal(ownEntity.y, 0, 'capped speed_delta correction changed the wrong axis');
        assert.equal(
            client.sentPackets.some((packet: { id: number }) => packet.id === 0x07),
            true,
            'capped speed_delta correction did not tell the client to converge'
        );

        MovementAuthority.reset(client, 'spawn', 0, 0, now);
        ownEntity.x = 0;
        ownEntity.y = 0;
        const diagonalStep = MovementAuthority.validateIncrementalMovement(client, ownEntity, 360, 360, now + 200);
        assert.equal(diagonalStep.accepted, false, 'diagonal movement bypassed normalized distance budget');

        MovementAuthority.reset(client, 'spawn', 0, 0, now);
        ownEntity.x = 0;
        ownEntity.y = 0;
        const invalidNaN = MovementAuthority.validateIncrementalMovement(client, ownEntity, Number.NaN, 0, now + 100);
        assert.equal(invalidNaN.accepted, false, 'NaN movement delta was accepted');
        assert.equal(invalidNaN.reason, 'invalid_delta');

        const invalidInfinity = MovementAuthority.validateIncrementalMovement(client, ownEntity, 0, Number.POSITIVE_INFINITY, now + 100);
        assert.equal(invalidInfinity.accepted, false, 'Infinity movement delta was accepted');
        assert.equal(invalidInfinity.reason, 'invalid_delta');

        MovementAuthority.reset(client, 'spawn', 0, 0, now);
        ownEntity.x = 0;
        ownEntity.y = 0;
        const laggedMovement = MovementAuthority.validateIncrementalMovement(client, ownEntity, 850, 0, now + 1000);
        assert.equal(laggedMovement.accepted, true, 'server-time budget did not tolerate delayed normal movement');

        MovementAuthority.reset(client, 'spawn', 0, 0, now);
        ownEntity.x = 0;
        ownEntity.y = 0;
        const speedHack2x = MovementAuthority.validateIncrementalMovement(client, ownEntity, 1800, 0, now + 1000);
        assert.equal(speedHack2x.accepted, false, '2x speedhack movement was accepted');

        MovementAuthority.reset(client, 'spawn', 0, 0, now);
        ownEntity.x = 0;
        ownEntity.y = 0;
        const speedHack10x = MovementAuthority.validateIncrementalMovement(client, ownEntity, 9000, 0, now + 1000);
        assert.equal(speedHack10x.accepted, false, '10x speedhack movement was accepted');
        assert.equal(speedHack10x.reason, 'teleport_delta');

        MovementAuthority.reset(client, 'spawn', 0, 0, now);
        ownEntity.x = 0;
        ownEntity.y = 0;
        const unmountedBurst = MovementAuthority.validateIncrementalMovement(client, ownEntity, 400, 0, now + 250);
        assert.equal(unmountedBurst.accepted, false, 'unmounted speed budget allowed mount-speed movement');
        client.character.equippedMount = 1;
        MovementAuthority.reset(client, 'mount', 0, 0, now);
        const mountedBurst = MovementAuthority.validateIncrementalMovement(client, ownEntity, 400, 0, now + 250);
        assert.equal(mountedBurst.accepted, true, 'mounted speed budget rejected mount-speed movement');
        client.character.equippedMount = 0;

        client.movementSpeedMultiplier = 0.5;
        MovementAuthority.reset(client, 'slow', 0, 0, now);
        ownEntity.x = 0;
        ownEntity.y = 0;
        const slowedMovement = MovementAuthority.validateIncrementalMovement(client, ownEntity, 650, 0, now + 1000);
        assert.equal(slowedMovement.accepted, false, 'server-side slow multiplier did not reduce movement budget');
        const slowedValidMovement = MovementAuthority.validateIncrementalMovement(client, ownEntity, 450, 0, now + 1000);
        assert.equal(slowedValidMovement.accepted, true, 'server-side slow multiplier rejected valid slowed movement');
        client.movementSpeedMultiplier = 1;

        client.movementRootUntilMs = now + 1000;
        MovementAuthority.reset(client, 'root', 0, 0, now);
        ownEntity.x = 0;
        ownEntity.y = 0;
        const rootedMovement = MovementAuthority.validateIncrementalMovement(client, ownEntity, 10, 0, now + 100);
        assert.equal(rootedMovement.accepted, false, 'server-side root state allowed movement');
        client.movementRootUntilMs = 0;

        MovementAuthority.reset(client, 'spawn', 0, 0, now + 1000);
        ownEntity.x = 0;
        ownEntity.y = 0;
        const reorderedMovement = MovementAuthority.validateIncrementalMovement(client, ownEntity, 10, 0, now + 500);
        assert.equal(reorderedMovement.accepted, false, 'reordered movement timestamp was accepted');
        assert.equal(reorderedMovement.reason, 'reordered_movement_time');

        MovementAuthority.reset(client, 'spawn', 0, 0, Date.now());
        ownEntity.x = 0;
        ownEntity.y = 0;
        await CombatHandler.handlePowerCast(client, buildPowerCastPayload(client.clientEntID, 1394));
        const dashMovement = MovementAuthority.validateIncrementalMovement(client, ownEntity, 1200, 0, Date.now() + 50);
        assert.equal(dashMovement.accepted, true, 'validated Shadow Step cast did not grant one dash movement window');
        assert.equal(dashMovement.reason, 'mobility_grace');

        MovementAuthority.reset(client, 'spawn', 0, 0, Date.now());
        ownEntity.x = 0;
        ownEntity.y = 0;
        await CombatHandler.handlePowerCast(client, buildPowerCastPayload(remote.clientEntID, 1394));
        const spoofedDash = MovementAuthority.validateIncrementalMovement(client, ownEntity, 1200, 0, Date.now() + 50);
        assert.equal(spoofedDash.accepted, false, 'foreign-player dash cast granted movement authority');

        MovementAuthority.reset(client, 'spawn', 0, 0, now);
        ownEntity.x = 0;
        ownEntity.y = 0;
        client.pendingTransferUntil = now + 500;
        const transitionMovement = MovementAuthority.validateIncrementalMovement(client, ownEntity, 3000, 0, now + 10);
        assert.equal(transitionMovement.accepted, true, 'server-authorized transition movement was rejected');
        client.pendingTransferUntil = 0;

        LevelHandler.handleEntityIncrementalUpdate(client, buildMovementPayload(remote.clientEntID, 500, 0));
        assert.equal(remoteEntity.x, 100, 'client moved another player through packet 0x07');
        assert.equal(remoteEntity.y, 100, 'client changed another player vertical position through packet 0x07');

        await CombatHandler.handlePowerHit(client, buildPowerHitPayload(hostile.id, 99_999, 100));
        assert.equal(hostile.hp, 100, 'unknown combat source damaged a server-known entity');

        // Reported live as "dash skills freeze the game". A dash is authored as an Open
        // power that starts it and a Close power that lands it, and the Close half is the
        // one that moves the player. The hand-maintained id ranges cover ShadowStep
        // (1394-1405) but not ShadowStepClose1-10 (1406-1415), and miss MistWalkClose10
        // and AssassinateClose10 in the gaps between ranges -- so at rank the landing half
        // was scored as a teleport, and eight points of that quarantines movement for five
        // seconds before sixteen destroys the socket.
        for (const closePowerId of [1406, 1415, 1185, 1208]) {
            assert.equal(
                MovementAuthority.isMobilityPower(closePowerId),
                true,
                `dash close power ${closePowerId} gets no mobility grace, so landing it reads as a teleport`
            );
        }
        assert.equal(MovementAuthority.isMobilityPower(1394), true, 'Shadow Step lost its mobility grace');
        assert.equal(MovementAuthority.isMobilityPower(1323), true, 'Necrotic Surge lost its mobility grace');
        // The window is only meant for powers that actually displace the caster.
        assert.equal(MovementAuthority.isMobilityPower(5000), false, 'a non-mobility power was granted dash movement');

        MovementAuthority.reset(client, 'spawn', 0, 0, Date.now());
        ownEntity.x = 0;
        ownEntity.y = 0;
        await CombatHandler.handlePowerCast(client, buildPowerCastPayload(client.clientEntID, 1415));
        const closeDash = MovementAuthority.validateIncrementalMovement(client, ownEntity, 1200, 0, Date.now() + 50);
        assert.equal(closeDash.accepted, true, 'a rank 10 dash landing was rejected');
        assert.equal(closeDash.reason, 'mobility_grace');
    } finally {
        GlobalState.levelEntities.delete(scope);
        GlobalState.sessionsByToken.delete(client.token);
        GlobalState.sessionsByToken.delete(remote.token);
    }

    console.log('movement_authority_regression: ok');
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
