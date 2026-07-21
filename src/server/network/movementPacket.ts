import { EntityState } from '../core/Entity';
import { BitBuffer } from './protocol/bitBuffer';
import { BitReader } from './protocol/bitReader';

type ActiveMovementPacket = {
    entityId: number;
    deltaX: number;
    deltaY: number;
    deltaVX: number;
    entState: number;
    bLeft: boolean;
    bRunning: boolean;
    bJumping: boolean;
    bDropping: boolean;
    bBackpedal: boolean;
    isAirborne: boolean;
    velocityY: number;
};

function parseActiveMovementPacket(data: Buffer): ActiveMovementPacket | null {
    try {
        const br = new BitReader(data);
        const packet: ActiveMovementPacket = {
            entityId: br.readMethod4(),
            deltaX: br.readMethod45(),
            deltaY: br.readMethod45(),
            deltaVX: br.readMethod45(),
            entState: br.readMethod6(2),
            bLeft: br.readMethod15(),
            bRunning: br.readMethod15(),
            bJumping: br.readMethod15(),
            bDropping: br.readMethod15(),
            bBackpedal: br.readMethod15(),
            isAirborne: br.readMethod15(),
            velocityY: 0
        };
        packet.velocityY = packet.isAirborne ? br.readMethod24() : 0;
        return packet.entState === EntityState.ACTIVE && packet.entityId > 0 ? packet : null;
    } catch {
        return null;
    }
}

function buildMovementPacket(packet: ActiveMovementPacket): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(packet.entityId);
    bb.writeMethod45(packet.deltaX);
    bb.writeMethod45(packet.deltaY);
    bb.writeMethod45(packet.deltaVX);
    bb.writeMethod6(packet.entState, 2);
    bb.writeMethod15(packet.bLeft);
    bb.writeMethod15(packet.bRunning);
    bb.writeMethod15(packet.bJumping);
    bb.writeMethod15(packet.bDropping);
    bb.writeMethod15(packet.bBackpedal);
    bb.writeMethod15(packet.isAirborne);
    if (packet.isAirborne) {
        bb.writeMethod24(packet.velocityY);
    }
    return bb.toBuffer();
}

export function getActiveMovementPacketKey(packetId: number, data: Buffer): string | null {
    if (packetId !== 0x07) {
        return null;
    }
    const packet = parseActiveMovementPacket(data);
    return packet ? `${packetId}:${packet.entityId}` : null;
}

export function mergeActiveMovementPackets(previous: Buffer, next: Buffer): Buffer | null {
    const left = parseActiveMovementPacket(previous);
    const right = parseActiveMovementPacket(next);
    if (!left || !right || left.entityId !== right.entityId) {
        return null;
    }

    return buildMovementPacket({
        ...right,
        deltaX: left.deltaX + right.deltaX,
        deltaY: left.deltaY + right.deltaY,
        deltaVX: left.deltaVX + right.deltaVX
    });
}
