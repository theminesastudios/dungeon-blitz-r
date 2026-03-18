import { strict as assert } from 'assert';
import * as net from 'net';
import { Client } from '../core/Client';
import { Character } from '../database/Database';
import { GlobalState } from '../core/GlobalState';
import { LoginHandler } from '../handlers/LoginHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeWatcher = {
    token: number;
    userId: number | null;
    currentLevel: string;
    playerSpawned: boolean;
    socket: { destroyed: boolean };
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
};

function createCharacter(name: string): Character {
    return {
        name,
        class: 'Paladin',
        gender: 'male',
        level: 1,
        friends: [],
        ignored: [],
        guild: {}
    };
}

function createWatcher(token: number, currentLevel: string): FakeWatcher {
    const sentPackets: SentPacket[] = [];

    return {
        token,
        userId: null,
        currentLevel,
        playerSpawned: true,
        socket: { destroyed: false },
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
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

async function testResetForLoginCycleClearsStaleSessionMappings(): Promise<void> {
    const owner = new Client(
        new net.Socket(),
        {
            handle: async () => undefined
        } as never
    );

    const hero = createCharacter('Hero');
    owner.userId = 11;
    owner.authenticated = true;
    owner.characters = [hero];
    owner.character = hero;
    owner.token = 111;
    owner.clientEntID = 42;
    owner.currentLevel = 'CraftTown';
    owner.playerSpawned = true;

    const watcher = createWatcher(333, 'CraftTown');

    GlobalState.sessionsByToken.set(111, owner);
    GlobalState.sessionsByToken.set(222, owner);
    GlobalState.sessionsByToken.set(333, watcher as never);
    GlobalState.sessionsByUserId.set(11, owner);
    GlobalState.sessionsByUserId.set(12, owner);
    GlobalState.sessionsByCharacterName.set('hero', owner);
    GlobalState.sessionsByCharacterName.set('hero-stale', owner);
    GlobalState.levelEntities.set(
        'CraftTown',
        new Map<number, any>([
            [42, { id: 42, name: 'Hero', isPlayer: true }],
            [77, { id: 77, name: 'Watcher', isPlayer: true }]
        ])
    );

    await owner.resetForLoginCycle('account switch regression', { persistSnapshot: false });

    assert.equal(GlobalState.sessionsByToken.has(111), false);
    assert.equal(GlobalState.sessionsByToken.has(222), false);
    assert.equal(GlobalState.sessionsByToken.get(333), watcher);
    assert.equal(GlobalState.sessionsByUserId.has(11), false);
    assert.equal(GlobalState.sessionsByUserId.has(12), false);
    assert.equal(GlobalState.sessionsByCharacterName.has('hero'), false);
    assert.equal(GlobalState.sessionsByCharacterName.has('hero-stale'), false);
    assert.equal(GlobalState.levelEntities.get('CraftTown')?.has(42), false);
    assert.equal(GlobalState.levelEntities.get('CraftTown')?.has(77), true);
    assert.deepEqual(decodeDestroyedEntityIds(watcher.sentPackets), [42]);

    assert.equal(owner.authenticated, false);
    assert.equal(owner.userId, null);
    assert.equal(owner.character, null);
    assert.equal(owner.currentLevel, '');
    assert.equal(owner.token, 0);
    assert.equal(owner.playerSpawned, false);
    assert.equal(owner.clientEntID, 0);
}

async function testLoginVersionResetsExistingSessionBeforeChallenge(): Promise<void> {
    const sentPackets: SentPacket[] = [];
    const resetReasons: string[] = [];
    const bb = new BitBuffer(false);
    bb.writeMethod9(123);

    const fakeClient = {
        challengeStr: '',
        async resetForLoginCycle(reason: string) {
            resetReasons.push(reason);
        },
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        }
    } as unknown as Client;

    await LoginHandler.handleLoginVersion(fakeClient, bb.toBuffer());

    assert.deepEqual(resetReasons, ['login version']);
    assert.equal(sentPackets.at(0)?.id, 0x12);
}

async function main(): Promise<void> {
    const sessionsByCharacterName = new Map(GlobalState.sessionsByCharacterName);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const sessionsByUserId = new Map(GlobalState.sessionsByUserId);
    const levelEntities = new Map(GlobalState.levelEntities);
    const tokenChar = new Map(GlobalState.tokenChar);
    const pendingWorld = new Map(GlobalState.pendingWorld);
    const pendingExtended = new Map(GlobalState.pendingExtended);
    const pendingTeleports = new Map(GlobalState.pendingTeleports);
    const houseVisits = new Map(GlobalState.houseVisits);

    GlobalState.sessionsByCharacterName.clear();
    GlobalState.sessionsByToken.clear();
    GlobalState.sessionsByUserId.clear();
    GlobalState.levelEntities.clear();
    GlobalState.tokenChar.clear();
    GlobalState.pendingWorld.clear();
    GlobalState.pendingExtended.clear();
    GlobalState.pendingTeleports.clear();
    GlobalState.houseVisits.clear();

    try {
        await testResetForLoginCycleClearsStaleSessionMappings();

        GlobalState.sessionsByCharacterName.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByUserId.clear();
        GlobalState.levelEntities.clear();
        GlobalState.tokenChar.clear();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.pendingTeleports.clear();
        GlobalState.houseVisits.clear();

        await testLoginVersionResetsExistingSessionBeforeChallenge();
    } finally {
        GlobalState.sessionsByCharacterName = sessionsByCharacterName;
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.sessionsByUserId = sessionsByUserId;
        GlobalState.levelEntities = levelEntities;
        GlobalState.tokenChar = tokenChar;
        GlobalState.pendingWorld = pendingWorld;
        GlobalState.pendingExtended = pendingExtended;
        GlobalState.pendingTeleports = pendingTeleports;
        GlobalState.houseVisits = houseVisits;
    }

    console.log('account_switch_session_regression: ok');
}

void main().catch((error) => {
    console.error('account_switch_session_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
