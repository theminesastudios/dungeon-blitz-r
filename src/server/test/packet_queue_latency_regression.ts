import { strict as assert } from 'assert';
import { EventEmitter } from 'events';
import { Client } from '../core/Client';
import { EntityState } from '../core/Entity';
import { PacketRouter } from '../network/packetRouter';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

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

function movement(entityId: number, deltaX: number, state: EntityState = EntityState.ACTIVE): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod45(deltaX);
    bb.writeMethod45(0);
    bb.writeMethod45(0);
    bb.writeMethod6(state, 2);
    for (let index = 0; index < 6; index++) bb.writeMethod15(false);
    return bb.toBuffer();
}

function frame(packetId: number, payload: Buffer): Buffer {
    const header = Buffer.alloc(4);
    header.writeUInt16BE(packetId, 0);
    header.writeUInt16BE(payload.length, 2);
    return Buffer.concat([header, payload]);
}

function readDeltaX(payload: Buffer): number {
    const br = new BitReader(payload);
    br.readMethod4();
    return br.readMethod45();
}

async function waitUntil(predicate: () => boolean, timeoutMs: number = 1000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
        assert(Date.now() < deadline, 'timed out waiting for packet queue');
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
}

async function main(): Promise<void> {
    const router = new PacketRouter();
    const socket = new FakeSocket();
    const client = new Client(socket as never, router);
    client.token = 991;
    const handled: string[] = [];
    const movementDeltas: number[] = [];
    let releaseFirstMovement: () => void = () => undefined;
    let firstMovementStarted = false;
    let movementCalls = 0;

    router.register(0x07, async (_client, payload) => {
        movementCalls += 1;
        movementDeltas.push(readDeltaX(payload));
        handled.push(`move:${readDeltaX(payload)}`);
        if (movementCalls === 1) {
            await new Promise<void>((resolve) => {
                releaseFirstMovement = resolve;
                firstMovementStarted = true;
            });
        }
    });
    router.register(0x0A, () => { handled.push('combat'); });

    socket.emit('data', frame(0x07, movement(77, 1)));
    await waitUntil(() => firstMovementStarted);

    const burst: Buffer[] = [];
    for (let index = 0; index < 100; index++) burst.push(frame(0x07, movement(77, 1)));
    burst.push(frame(0x0A, Buffer.from([1])));
    for (let index = 0; index < 100; index++) burst.push(frame(0x07, movement(77, 1)));
    socket.emit('data', Buffer.concat(burst));
    releaseFirstMovement();

    await waitUntil(() => handled.includes('combat') && client.getPacketQueueMetrics().currentDepth === 0);
    assert.deepEqual(handled.slice(0, 3), ['move:1', 'move:100', 'combat']);
    assert.equal(movementDeltas.reduce((sum, value) => sum + value, 0), 201);
    assert.equal(movementCalls, 3, 'movement was not coalesced around the combat barrier');
    assert(client.getPacketQueueMetrics().coalesced >= 198);
    assert.equal(router.getMetrics(0x0A)?.calls, 1);

    socket.emit('data', Buffer.concat([
        frame(0x07, movement(77, 1)),
        frame(0x07, movement(77, 0, EntityState.DEAD)),
        frame(0x07, movement(77, 1))
    ]));
    await waitUntil(() => client.getPacketQueueMetrics().currentDepth === 0);
    assert.equal(movementCalls, 6, 'DEAD movement state was incorrectly discarded');

    console.log('packet_queue_latency_regression: ok');
}

void main();
