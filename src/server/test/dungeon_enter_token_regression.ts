import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { CharacterHandler } from '../handlers/CharacterHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    userId: number;
    token: number;
    character: any;
    characters: any[];
    currentLevel: string;
    levelInstanceId: string;
    syncAnchorStartedAt: number;
    syncAnchorToken: number;
    syncAnchorCharacterName: string;
    playerSpawned: boolean;
    clientEntID: number;
    entities: Map<number, any>;
    startedRoomEvents: Set<string>;
    sentPackets: SentPacket[];
    socket?: { destroyed?: boolean; readyState?: string };
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('JC_Mission3')) {
        LevelConfig.load(dataDir);
    }
}

function createCharacter(name: string, className: string): any {
    return {
        name,
        class: className,
        gender: 'male',
        level: 50,
        xp: 0,
        gold: 0,
        craftXP: 0,
        DragonOre: 0,
        mammothIdols: 0,
        CurrentLevel: { name: 'JC_Mission3', x: 1000, y: 1000 },
        PreviousLevel: { name: 'DreadCemeteryHill', x: 1000, y: 1000 },
        DungeonSnapshot: {
            levelName: 'JC_Mission3',
            x: 1000,
            y: 1000,
            hasCoord: true,
            entryLevel: 'DreadCemeteryHill',
            entryX: 1000,
            entryY: 1000,
            entryHasCoord: true,
            currentRoomId: 1,
            startedRoomIds: [1],
            savedAt: Date.now()
        },
        equippedGears: [],
        inventoryGears: [],
        materials: {},
        consumables: [],
        charms: [],
        dyes: [],
        magicForge: {},
        missions: {},
        questTrackerState: 0
    };
}

function createFakeClient(name: string, token: number, userId: number, className: string): FakeClient {
    const character = createCharacter(name, className);
    const sentPackets: SentPacket[] = [];
    return {
        userId,
        token,
        character,
        characters: [character],
        currentLevel: 'JC_Mission3',
        levelInstanceId: String(token),
        syncAnchorStartedAt: token,
        syncAnchorToken: token,
        syncAnchorCharacterName: name,
        playerSpawned: true,
        clientEntID: token,
        entities: new Map<number, any>(),
        startedRoomEvents: new Set<string>(),
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function parseEnterWorldTransferToken(payload: Buffer): number {
    const br = new BitReader(payload);
    return br.readMethod4();
}

function testDungeonJoinerEnterWorldUsesOwnTransferToken(): void {
    const rogue = createFakeClient('AlexMercer', 21950, 21950, 'rogue');
    const mage = createFakeClient('Neodevils', 33485, 33485, 'mage');
    rogue.levelInstanceId = '21950';
    rogue.syncAnchorToken = rogue.token;
    rogue.syncAnchorCharacterName = rogue.character.name;
    rogue.entities.set(rogue.clientEntID, {
        id: rogue.clientEntID,
        isPlayer: true,
        x: 3400,
        y: 1200
    });

    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.partyGroups.set(8101, {
        id: 8101,
        leader: rogue.character.name,
        members: [rogue.character.name, mage.character.name],
        locked: false
    });
    GlobalState.partyByMember.set('alexmercer', 8101);
    GlobalState.partyByMember.set('neodevils', 8101);

    const beforeTokens = new Set(GlobalState.pendingWorld.keys());
    (CharacterHandler as any).sendEnterWorld(mage, mage.character);

    const enterWorldPacket = mage.sentPackets.find((packet) => packet.id === 0x21);
    assert.ok(enterWorldPacket, 'sendEnterWorld should emit a 0x21 packet');
    const newPendingTokens = Array.from(GlobalState.pendingWorld.keys()).filter((token) => !beforeTokens.has(token));
    assert.equal(newPendingTokens.length, 1, 'sendEnterWorld should create one pending token for the joiner');
    const joinerToken = newPendingTokens[0];
    const pendingEntry = GlobalState.pendingWorld.get(joinerToken);
    assert.ok(pendingEntry, 'joiner pending token should resolve to pending world entry');
    assert.equal(pendingEntry.syncAnchorToken, rogue.token, 'pending state should still remember the rogue sync anchor');
    assert.equal(pendingEntry.levelInstanceId, rogue.levelInstanceId, 'joiner should still share the rogue dungeon instance');
    assert.equal(pendingEntry.newX, 3500, 'joiner should spawn 100px beside the party anchor instead of dungeon start');
    assert.equal(pendingEntry.newY, 1200, 'joiner should spawn at the party anchor vertical position');
    assert.equal(pendingEntry.newHasCoord, true, 'joiner party-anchor spawn should use explicit coordinates');
    assert.equal(parseEnterWorldTransferToken(enterWorldPacket.payload), joinerToken, '0x21 must carry the joiner token, not the sync anchor token');
    assert.notEqual(joinerToken, rogue.token, 'joiner transfer token should remain distinct from rogue anchor token');
}

function testPartyDungeonTransferKeepsAnchorSpawnCoordinates(): void {
    const rogue = createFakeClient('AlexMercer', 61267, 21950, 'rogue');
    const mage = createFakeClient('Neodevils', 3614, 33485, 'mage');
    rogue.currentLevel = 'AC_Mission1';
    rogue.character.CurrentLevel = { name: 'AC_Mission1', x: 3400, y: 1200 };
    rogue.levelInstanceId = '61267';
    rogue.syncAnchorStartedAt = rogue.token;
    rogue.syncAnchorToken = rogue.token;
    rogue.syncAnchorCharacterName = rogue.character.name;
    rogue.entities.set(rogue.clientEntID, {
        id: rogue.clientEntID,
        isPlayer: true,
        x: 3400,
        y: 1200
    });
    mage.currentLevel = 'CemeteryHillHard';
    mage.character.CurrentLevel = { name: 'CemeteryHillHard', x: 1800, y: 950 };

    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.partyGroups.set(8101, {
        id: 8101,
        leader: rogue.character.name,
        members: [rogue.character.name, mage.character.name],
        locked: false
    });
    GlobalState.partyByMember.set('alexmercer', 8101);
    GlobalState.partyByMember.set('neodevils', 8101);

    const syncState = (LevelHandler as any).buildTransferSyncState(mage, 'AC_Mission1', null);
    assert.ok(syncState, 'party dungeon transfer should build sync state');
    assert.equal(syncState.levelInstanceId, rogue.levelInstanceId, 'joiner transfer should reuse the party anchor dungeon instance');
    assert.equal(syncState.syncAnchorToken, rogue.token, 'joiner transfer should remember the party anchor token');
    assert.equal(syncState.hasCoord, true, 'joiner transfer should preserve explicit party-anchor spawn coordinates');
    assert.equal(syncState.x, 3500, 'joiner transfer should spawn 100px beside the party anchor');
    assert.equal(syncState.y, 1200, 'joiner transfer should spawn at the party anchor vertical position');
}

function testReturningDungeonRootLogsPhysicalPartyAnchor(): void {
    const alex = createFakeClient('AlexMercer', 21927, 21950, 'rogue');
    const neodevils = createFakeClient('Neodevils', 8084, 21950, 'mage');
    alex.currentLevel = 'Castle';
    alex.character.CurrentLevel = { name: 'Castle', x: -1280, y: -1941 };
    alex.levelInstanceId = '';
    neodevils.currentLevel = 'AC_Mission1';
    neodevils.character.CurrentLevel = { name: 'AC_Mission1', x: -1584, y: -1875 };
    neodevils.levelInstanceId = '37629';
    neodevils.syncAnchorStartedAt = 37629;
    neodevils.syncAnchorToken = 37629;
    neodevils.syncAnchorCharacterName = 'AlexMercer';
    neodevils.entities.set(neodevils.clientEntID, {
        id: neodevils.clientEntID,
        isPlayer: true,
        x: -1584,
        y: -1875
    });

    GlobalState.sessionsByToken.set(neodevils.token, neodevils as never);
    GlobalState.partyGroups.set(8101, {
        id: 8101,
        leader: alex.character.name,
        members: [alex.character.name, neodevils.character.name],
        locked: false
    });
    GlobalState.partyByMember.set('alexmercer', 8101);
    GlobalState.partyByMember.set('neodevils', 8101);

    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
        logs.push(args.map(String).join(' '));
    };
    try {
        const syncState = (LevelHandler as any).buildTransferSyncState(alex, 'AC_Mission1', null);
        assert.ok(syncState, 'returning root should reuse the live party dungeon instance');
        assert.equal(syncState.levelInstanceId, neodevils.levelInstanceId, 'returning root should keep the shared dungeon instance');
        assert.equal(syncState.syncAnchorToken, 37629, 'returning root should preserve the original dungeon sync anchor');
        assert.equal(syncState.syncAnchorCharacterName, 'AlexMercer', 'sync anchor identity should still describe the dungeon root');
        assert.equal(syncState.x, -1484, 'returning root should spawn beside the live party member');
        assert.equal(syncState.y, -1875, 'returning root should use the live party member vertical position');
    } finally {
        console.log = originalLog;
    }

    assert.ok(
        logs.some((line) => line.includes('Party dungeon anchor spawn AlexMercer -> AC_Mission1 beside Neodevils at -1484,-1875')),
        'party anchor log should name the physical party member, not the inherited sync root'
    );
    assert.ok(
        logs.every((line) => !line.includes('Party dungeon anchor spawn AlexMercer -> AC_Mission1 beside AlexMercer')),
        'party anchor log should not report a self-anchor when coordinates came from another party member'
    );
}

function testClosedPartySessionsDoNotProvideDungeonAnchorCoordinates(): void {
    const alex = createFakeClient('AlexMercer', 21927, 21950, 'rogue');
    const closed = createFakeClient('ClosedFriend', 4444, 33485, 'mage');
    const live = createFakeClient('Neodevils', 8084, 99881, 'mage');
    alex.currentLevel = 'Castle';
    alex.levelInstanceId = '';
    closed.currentLevel = 'AC_Mission1';
    closed.levelInstanceId = '37629';
    closed.syncAnchorStartedAt = 1;
    closed.socket = { destroyed: true, readyState: 'closed' };
    closed.entities.set(closed.clientEntID, {
        id: closed.clientEntID,
        isPlayer: true,
        x: 100,
        y: 200
    });
    live.currentLevel = 'AC_Mission1';
    live.levelInstanceId = '37629';
    live.syncAnchorStartedAt = 2;
    live.entities.set(live.clientEntID, {
        id: live.clientEntID,
        isPlayer: true,
        x: 400,
        y: 500
    });

    GlobalState.sessionsByToken.set(closed.token, closed as never);
    GlobalState.sessionsByToken.set(live.token, live as never);
    GlobalState.partyGroups.set(8101, {
        id: 8101,
        leader: alex.character.name,
        members: [alex.character.name, closed.character.name, live.character.name],
        locked: false
    });
    GlobalState.partyByMember.set('alexmercer', 8101);
    GlobalState.partyByMember.set('closedfriend', 8101);
    GlobalState.partyByMember.set('neodevils', 8101);

    const syncState = (LevelHandler as any).buildTransferSyncState(alex, 'AC_Mission1', null);
    assert.ok(syncState, 'returning player should find the live party anchor');
    assert.equal(syncState.x, 500, 'closed party sessions must not supply stale anchor coordinates');
    assert.equal(syncState.y, 500, 'closed party sessions must not supply stale anchor coordinates');
}

function main(): void {
    const pendingWorld = new Map(GlobalState.pendingWorld);
    const pendingExtended = new Map(GlobalState.pendingExtended);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const sessionsByCharacterName = new Map(GlobalState.sessionsByCharacterName);
    const partyGroups = new Map(GlobalState.partyGroups);
    const partyByMember = new Map(GlobalState.partyByMember);
    const tokenChar = new Map(GlobalState.tokenChar);
    const usedTransferTokens = new Map(GlobalState.usedTransferTokens);

    ensureDataLoaded();
    try {
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.partyGroups.clear();
        GlobalState.partyByMember.clear();
        GlobalState.tokenChar.clear();
        GlobalState.usedTransferTokens.clear();
        testDungeonJoinerEnterWorldUsesOwnTransferToken();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.partyGroups.clear();
        GlobalState.partyByMember.clear();
        GlobalState.tokenChar.clear();
        GlobalState.usedTransferTokens.clear();
        testPartyDungeonTransferKeepsAnchorSpawnCoordinates();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.partyGroups.clear();
        GlobalState.partyByMember.clear();
        GlobalState.tokenChar.clear();
        GlobalState.usedTransferTokens.clear();
        testReturningDungeonRootLogsPhysicalPartyAnchor();
        GlobalState.pendingWorld.clear();
        GlobalState.pendingExtended.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.sessionsByCharacterName.clear();
        GlobalState.partyGroups.clear();
        GlobalState.partyByMember.clear();
        GlobalState.tokenChar.clear();
        GlobalState.usedTransferTokens.clear();
        testClosedPartySessionsDoNotProvideDungeonAnchorCoordinates();
        console.log('dungeon_enter_token_regression: ok');
    } finally {
        GlobalState.pendingWorld = pendingWorld;
        GlobalState.pendingExtended = pendingExtended;
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.sessionsByCharacterName = sessionsByCharacterName;
        GlobalState.partyGroups = partyGroups;
        GlobalState.partyByMember = partyByMember;
        GlobalState.tokenChar = tokenChar;
        GlobalState.usedTransferTokens = usedTransferTokens;
    }
}

void main();
