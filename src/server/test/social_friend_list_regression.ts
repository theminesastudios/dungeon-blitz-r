import { strict as assert } from 'assert';
import { MAX_FRIEND_ENTRIES, MAX_SOCIAL_NAME_BYTES } from '../core/SocialState';
import { SocialHandler } from '../handlers/SocialHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    character: any;
    sentPackets: SentPacket[];
    send(id: number, payload: Buffer): void;
    sendBitBuffer(id: number, bb: BitBuffer): void;
};

type DecodedFriend = {
    name: string;
    isRequest: boolean;
    isOnline: boolean;
    displayName: string | null;
    classId: number | null;
    level: number | null;
};

function createFakeClient(character: any): FakeClient {
    const sentPackets: SentPacket[] = [];
    return {
        character,
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function decodeFriendList(payload: Buffer): DecodedFriend[] {
    const br = new BitReader(payload);
    const count = br.readMethod4();
    const friends: DecodedFriend[] = [];

    for (let index = 0; index < count; index++) {
        const name = br.readMethod13();
        const isRequest = br.readMethod15();
        const isOnline = br.readMethod15();
        let displayName: string | null = null;
        let classId: number | null = null;
        let level: number | null = null;

        if (isOnline) {
            const hasCustomDisplayName = br.readMethod15();
            if (hasCustomDisplayName) {
                displayName = br.readMethod13();
            }
            classId = br.readMethod6(2);
            level = br.readMethod6(6);
        }

        friends.push({ name, isRequest, isOnline, displayName, classId, level });
    }

    return friends;
}

function utf8ByteLength(value: string): number {
    return Buffer.from(value, 'utf8').length;
}

function testMalformedSavedFriendsProduceBoundedPacket(): void {
    const veryLongName = `VeryLongFriendName_${'x'.repeat(MAX_SOCIAL_NAME_BYTES * 2)}`;
    const manyFriends = Array.from({ length: MAX_FRIEND_ENTRIES + 20 }, (_, index) => ({
        name: `Friend${index}`,
        isRequest: index % 2 === 0
    }));
    const character = {
        name: 'SocialTester',
        friends: [
            null,
            undefined,
            '',
            { name: '' },
            { name: { bad: true } },
            { name: '  Valid Friend  ', isRequest: true },
            { name: 'valid friend', isRequest: false },
            { name: 'Control\u0000Name\u0007', isRequest: false },
            { name: veryLongName, isRequest: false },
            ...manyFriends
        ]
    };
    const client = createFakeClient(character);

    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
        SocialHandler.handleRequestFriendList(client as never, Buffer.alloc(0));
    } finally {
        console.warn = originalWarn;
    }

    assert.equal(client.sentPackets.length, 1);
    assert.equal(client.sentPackets[0].id, 0xca);

    const friends = decodeFriendList(client.sentPackets[0].payload);
    assert.equal(friends.length, MAX_FRIEND_ENTRIES);
    assert.ok(friends.every((friend) => friend.name.length > 0), 'friend names sent to the client must be non-empty');
    assert.ok(
        friends.every((friend) => utf8ByteLength(friend.name) <= MAX_SOCIAL_NAME_BYTES),
        'friend names sent to the client must be byte-clamped'
    );
    assert.equal(
        friends.filter((friend) => friend.name.toLowerCase() === 'valid friend').length,
        1,
        'case-insensitive duplicate friend entries should be deduped'
    );
    assert.ok(friends.some((friend) => friend.name === 'Control Name'));
    assert.ok(friends.some((friend) => friend.name.startsWith('VeryLongFriendName_')));
    assert.ok(friends.every((friend) => !friend.isOnline), 'missing friend sessions should serialize as offline');
    assert.ok(Array.isArray(character.friends));
    assert.ok(character.friends.length <= MAX_FRIEND_ENTRIES);
}

function testMissingFriendArraySendsEmptyList(): void {
    const client = createFakeClient({
        name: 'EmptySocialTester'
    });

    SocialHandler.handleRequestFriendList(client as never, Buffer.alloc(0));

    assert.equal(client.sentPackets.length, 1);
    assert.equal(client.sentPackets[0].id, 0xca);
    assert.deepEqual(decodeFriendList(client.sentPackets[0].payload), []);
    assert.deepEqual(client.character.friends, []);
}

function testHugeInvalidFriendArraySendsEmptyList(): void {
    const client = createFakeClient({
        name: 'InvalidSocialTester',
        friends: Array.from({ length: MAX_FRIEND_ENTRIES * 20 }, () => ({ bad: true }))
    });

    const originalWarn = console.warn;
    console.warn = () => undefined;
    try {
        SocialHandler.handleRequestFriendList(client as never, Buffer.alloc(0));
    } finally {
        console.warn = originalWarn;
    }

    assert.equal(client.sentPackets.length, 1);
    assert.equal(client.sentPackets[0].id, 0xca);
    assert.deepEqual(decodeFriendList(client.sentPackets[0].payload), []);
    assert.deepEqual(client.character.friends, []);
}

testMalformedSavedFriendsProduceBoundedPacket();
testMissingFriendArraySendsEmptyList();
testHugeInvalidFriendArraySendsEmptyList();
console.log('social_friend_list_regression passed');
