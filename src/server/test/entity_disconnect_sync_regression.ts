import { strict as assert } from 'assert';
import { Character } from '../database/Database';
import { GlobalState } from '../core/GlobalState';
import { EntityHandler } from '../handlers/EntityHandler';
import { BitReader } from '../network/protocol/bitReader';
import { BitBuffer } from '../network/protocol/bitBuffer';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    userId: number | null;
    currentLevel: string;
    playerSpawned: boolean;
    clientEntID: number;
    character: Character;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function createCharacter(name: string): Character {
    return {
        name,
        class: 'Paladin',
        gender: 'male',
        level: 1
    };
}

function createFakeClient(
    name: string,
    token: number,
    currentLevel: string,
    playerSpawned: boolean,
    clientEntID: number
): FakeClient {
    const sentPackets: SentPacket[] = [];

    return {
        token,
        userId: null,
        currentLevel,
        playerSpawned,
        clientEntID,
        character: createCharacter(name),
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function decodeDestroyedEntityIds(packets: SentPacket[]): number[] {
    return packets
        .filter((packet) => packet.id === 0x0D)
        .map((packet) => {
            const br = new BitReader(packet.payload);
            const entityId = br.readMethod4();
            br.readMethod15();
            return entityId;
        });
}

function resetState(): void {
    GlobalState.sessionsByToken.clear();
    GlobalState.levelEntities.clear();
}

function testDisconnectBroadcastRemovesOwnedEntities(): void {
    resetState();

    const owner = createFakeClient('Hero', 101, 'CraftTown', true, 42);
    const watcher = createFakeClient('Watcher', 202, 'CraftTown', true, 77);

    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(watcher.token, watcher as never);
    GlobalState.levelEntities.set(
        'CraftTown',
        new Map<number, any>([
            [42, { id: 42, name: 'Hero', isPlayer: true }],
            [78, { id: 78, name: 'Watcher', isPlayer: true }],
            [99, { id: 99, name: 'Companion', clientSpawned: true, ownerToken: 101 }]
        ])
    );

    const removedEntityIds = EntityHandler.removeOwnedEntities(owner as never).sort((left, right) => left - right);
    const levelMap = GlobalState.levelEntities.get('CraftTown');

    assert.deepEqual(removedEntityIds, [42, 99]);
    assert.ok(levelMap, 'level should remain because watcher is still present');
    assert.equal(levelMap?.has(42), false);
    assert.equal(levelMap?.has(99), false);
    assert.equal(levelMap?.has(78), true);
    assert.deepEqual(decodeDestroyedEntityIds(watcher.sentPackets), [42, 99]);
}

function testDisconnectBroadcastFallsBackToPrimaryEntityId(): void {
    resetState();

    const owner = createFakeClient('Hero', 101, 'CraftTown', true, 42);
    const watcher = createFakeClient('Watcher', 202, 'CraftTown', true, 77);

    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(watcher.token, watcher as never);

    const removedEntityIds = EntityHandler.removeOwnedEntities(owner as never);

    assert.deepEqual(removedEntityIds, [42]);
    assert.deepEqual(decodeDestroyedEntityIds(watcher.sentPackets), [42]);
}

function main(): void {
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const levelEntities = new Map(GlobalState.levelEntities);

    try {
        testDisconnectBroadcastRemovesOwnedEntities();
        testDisconnectBroadcastFallsBackToPrimaryEntityId();
    } finally {
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.levelEntities = levelEntities;
    }

    console.log('entity_disconnect_sync_regression: ok');
}

try {
    main();
} catch (error) {
    console.error('entity_disconnect_sync_regression: failed');
    console.error(error);
    process.exitCode = 1;
}
