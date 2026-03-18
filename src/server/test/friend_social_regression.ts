import { strict as assert } from 'assert';
import * as path from 'path';
import { Character } from '../database/Database';
import { GlobalState } from '../core/GlobalState';
import { normalizeCharacterKey } from '../core/SocialState';
import { LevelConfig } from '../core/LevelConfig';
import { SocialHandler } from '../handlers/SocialHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    userId: number | null;
    character: Character;
    characters: Character[];
    currentLevel: string;
    entryLevel: string;
    currentRoomId: number;
    clientEntID: number;
    playerSpawned: boolean;
    startedRoomEvents: Set<string>;
    entities: Map<number, any>;
    lastDoorId: number;
    lastDoorTargetLevel: string;
    armPendingTransferGrace: () => void;
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
        token: Math.floor(Math.random() * 100000) + 1,
        userId: null,
        character,
        characters: [character],
        currentLevel: '',
        entryLevel: '',
        currentRoomId: 0,
        clientEntID: 0,
        playerSpawned: false,
        startedRoomEvents: new Set<string>(),
        entities: new Map<number, any>(),
        lastDoorId: -1,
        lastDoorTargetLevel: '',
        armPendingTransferGrace() {
            return;
        },
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

function ensureLevelConfigLoaded(): void {
    if (!LevelConfig.has('TutorialDungeon')) {
        LevelConfig.load(path.resolve(__dirname, '../data'));
    }
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

function testTeleportToPlayerCapturesDungeonAnchorState(): void {
    const caller = createFakeClient('Caller');
    const target = createFakeClient('Target');
    caller.token = 1001;
    caller.currentLevel = 'BridgeTown';
    caller.playerSpawned = true;
    caller.clientEntID = 4001;
    target.token = 1002;
    target.currentLevel = 'TutorialDungeon';
    target.entryLevel = 'NewbieRoad';
    target.currentRoomId = 15;
    target.playerSpawned = true;
    target.clientEntID = 4002;
    target.entities.set(target.clientEntID, { x: 1444, y: 2333 });
    target.startedRoomEvents = new Set([
        'TutorialDungeon:0',
        'TutorialDungeon:4',
        'TutorialDungeon:15',
        'OtherLevel:2'
    ]);

    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(caller.character.name), caller as never);
    GlobalState.sessionsByCharacterName.set(normalizeCharacterKey(target.character.name), target as never);

    const partyId = 77;
    GlobalState.partyGroups.set(partyId, {
        id: partyId,
        leader: caller.character.name,
        members: [caller.character.name, target.character.name],
        locked: false
    });
    GlobalState.partyByMember.set(normalizeCharacterKey(caller.character.name), partyId);
    GlobalState.partyByMember.set(normalizeCharacterKey(target.character.name), partyId);

    SocialHandler.handleTeleportToPlayer(caller as never, buildNamePacket(target.character.name));

    const pendingTeleport = GlobalState.pendingTeleports.get(caller.token);
    assert.ok(pendingTeleport);
    assert.equal(pendingTeleport?.targetLevel, 'TutorialDungeon');
    assert.equal(pendingTeleport?.x, 1444);
    assert.equal(pendingTeleport?.y, 2333);
    assert.equal(pendingTeleport?.syncAnchorToken, target.token);
    assert.equal(pendingTeleport?.syncAnchorCharacterName, target.character.name);
    assert.equal(pendingTeleport?.syncEntryLevel, 'NewbieRoad');
    assert.equal(pendingTeleport?.syncRoomId, 15);
    assert.deepEqual(pendingTeleport?.syncStartedRoomIds, [0, 4, 15]);
    assert.equal(caller.lastDoorTargetLevel, 'TutorialDungeon');
    assert.equal(caller.sentPackets.some((packet) => packet.id === 0x2E), true);
}

async function main(): Promise<void> {
    ensureLevelConfigLoaded();

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

        GlobalState.sessionsByCharacterName.clear();
        GlobalState.partyGroups.clear();
        GlobalState.partyByMember.clear();
        GlobalState.pendingTeleports.clear();
        testTeleportToPlayerCapturesDungeonAnchorState();
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
