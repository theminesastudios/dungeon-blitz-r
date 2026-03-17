import { strict as assert } from 'assert';
import { Character } from '../database/Database';
import { GlobalState } from '../core/GlobalState';
import { normalizeCharacterKey } from '../core/SocialState';
import { SocialHandler } from '../handlers/SocialHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    userId: number | null;
    character: Character;
    characters: Character[];
    currentLevel: string;
    playerSpawned: boolean;
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
    sentPackets: SentPacket[];
};

function createCharacter(name: string, friends: Array<{ name: string; isRequest: boolean }> = []): Character {
    return {
        name,
        class: 'Paladin',
        gender: 'male',
        level: 1,
        friends: friends.map((entry) => ({ ...entry })),
        ignored: []
    };
}

function createFakeClient(name: string, friends: Array<{ name: string; isRequest: boolean }> = []): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = createCharacter(name, friends);

    return {
        userId: null,
        character,
        characters: [character],
        currentLevel: '',
        playerSpawned: false,
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function buildNamePacket(name: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod26(name);
    return bb.toBuffer();
}

function decodeFriendUpdate(payload: Buffer): { name: string; isRequest: boolean } {
    const br = new BitReader(payload);
    return {
        name: br.readMethod13(),
        isRequest: br.readMethod15()
    };
}

function decodeFriendRemoved(payload: Buffer): string {
    const br = new BitReader(payload);
    return br.readMethod13();
}

async function testAcceptPreservesExistingFriendKey(): Promise<void> {
    const requester = createFakeClient('Requester');
    const receiver = createFakeClient('Receiver', [{ name: 'requester', isRequest: true }]);

    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(requester.character.name), requester as never);

    await SocialHandler.handleFriendRequest(receiver as never, buildNamePacket('requester'));

    assert.deepEqual(receiver.character.friends, [{ name: 'requester', isRequest: false }]);
    assert.deepEqual(requester.character.friends, [{ name: 'Receiver', isRequest: false }]);

    const receiverUpdate = receiver.sentPackets
        .filter((packet) => packet.id === 0x92)
        .map((packet) => decodeFriendUpdate(packet.payload))
        .at(-1);

    assert.ok(receiverUpdate, 'receiver should get an incremental friend update');
    assert.equal(receiverUpdate?.name, 'requester');
    assert.equal(receiverUpdate?.isRequest, false);
}

async function testUnfriendUsesRemovedEntryKeyForReverseUpdate(): Promise<void> {
    const requester = createFakeClient('Requester', [{ name: 'receiver', isRequest: false }]);
    const receiver = createFakeClient('Receiver', [{ name: 'Requester', isRequest: false }]);

    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(requester.character.name), requester as never);

    await SocialHandler.handleUnfriend(receiver as never, buildNamePacket('Requester'));

    assert.deepEqual(receiver.character.friends, []);
    assert.deepEqual(requester.character.friends, []);

    const requesterRemoval = requester.sentPackets
        .filter((packet) => packet.id === 0x93)
        .map((packet) => decodeFriendRemoved(packet.payload))
        .at(-1);

    assert.equal(requesterRemoval, 'receiver');
}

async function main(): Promise<void> {
    const sessionsByCharacterName = new Map(GlobalState.sessionsByCharacterName);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const sessionsByUserId = new Map(GlobalState.sessionsByUserId);
    const tokenChar = new Map(GlobalState.tokenChar);
    const pendingWorld = new Map(GlobalState.pendingWorld);
    const pendingExtended = new Map(GlobalState.pendingExtended);
    const partyGroups = new Map(GlobalState.partyGroups);
    const partyByMember = new Map(GlobalState.partyByMember);
    const pendingTeleports = new Map(GlobalState.pendingTeleports);

    GlobalState.sessionsByCharacterName.clear();
    GlobalState.sessionsByToken.clear();
    GlobalState.sessionsByUserId.clear();
    GlobalState.tokenChar.clear();
    GlobalState.pendingWorld.clear();
    GlobalState.pendingExtended.clear();
    GlobalState.partyGroups.clear();
    GlobalState.partyByMember.clear();
    GlobalState.pendingTeleports.clear();

    try {
        await testAcceptPreservesExistingFriendKey();

        GlobalState.sessionsByCharacterName.clear();
        await testUnfriendUsesRemovedEntryKeyForReverseUpdate();
    } finally {
        GlobalState.sessionsByCharacterName = sessionsByCharacterName;
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.sessionsByUserId = sessionsByUserId;
        GlobalState.tokenChar = tokenChar;
        GlobalState.pendingWorld = pendingWorld;
        GlobalState.pendingExtended = pendingExtended;
        GlobalState.partyGroups = partyGroups;
        GlobalState.partyByMember = partyByMember;
        GlobalState.pendingTeleports = pendingTeleports;
    }

    console.log('friend_social_regression: ok');
}

void main().catch((error) => {
    console.error('friend_social_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
