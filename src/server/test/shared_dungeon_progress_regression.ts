import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import {
    getOrCreateSharedDungeonProgressState,
    noteSharedDungeonHostileDestroyed,
    noteSharedDungeonHostileState,
    resolveSharedDungeonProgressAuthorityToken
} from '../core/SharedDungeonProgress';
import { CombatHandler } from '../handlers/CombatHandler';
import { EntityHandler } from '../handlers/EntityHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    userId: number | null;
    playerSpawned: boolean;
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    clientEntID: number;
    character: {
        name: string;
        level: number;
        CurrentLevel: { name: string; x: number; y: number };
        PreviousLevel: { name: string; x: number; y: number };
        missions: Record<string, { state: number; currCount?: number }>;
        questTrackerState: number;
    };
    characters: any[];
    knownEntityIds: Set<number>;
    entities: Map<number, any>;
    startedRoomEvents: Set<string>;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureLevelConfigLoaded(): void {
    if (!LevelConfig.has('GoblinRiverDungeon')) {
        LevelConfig.load(path.resolve(__dirname, '../data'));
    }
}

function createClient(token: number, name: string): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = {
        name,
        level: 10,
        CurrentLevel: { name: 'GoblinRiverDungeon', x: 0, y: 0 },
        PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 },
        missions: {},
        questTrackerState: 0
    };

    return {
        token,
        userId: token,
        playerSpawned: true,
        currentLevel: 'GoblinRiverDungeon',
        levelInstanceId: 'goblin-shared',
        currentRoomId: 1,
        clientEntID: 0,
        character,
        characters: [character],
        knownEntityIds: new Set<number>(),
        entities: new Map<number, any>(),
        startedRoomEvents: new Set<string>(),
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createQuestProgressPacket(progress: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(progress);
    return bb.toBuffer();
}

function createRoomStatePacket(roomId: number, cameraId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(roomId);
    bb.writeMethod9(cameraId);
    return bb.toBuffer();
}

function createRoomActionPacket(roomId: number, actionId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(roomId);
    bb.writeMethod9(actionId);
    return bb.toBuffer();
}

function createRoomInfoPacket(roomId: number, entityId: number, label: string, state: number, detail: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(roomId);
    bb.writeMethod9(entityId);
    bb.writeMethod26(label);
    bb.writeMethod9(state);
    bb.writeMethod26(detail);
    return bb.toBuffer();
}

function createRoomUnlockPacket(roomId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(roomId);
    return bb.toBuffer();
}

function createRoomEventStartPacket(roomId: number, flag: boolean = true): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(roomId);
    bb.writeMethod15(flag);
    return bb.toBuffer();
}

function createLevelCompletePacket(progress: number = 100, remainingKills: number = 0, requiredKills: number = 1): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(progress);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(remainingKills);
    bb.writeMethod9(requiredKills);
    bb.writeMethod9(3);
    return bb.toBuffer();
}

function createDestroyEntityPacket(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(entityId);
    return bb.toBuffer();
}

function parseQuestProgress(payload: Buffer): number {
    const br = new BitReader(payload);
    return br.readMethod4();
}

function parseRoomEventStart(payload: Buffer): { roomId: number; flag: boolean } {
    const br = new BitReader(payload);
    return {
        roomId: br.readMethod4(),
        flag: br.readMethod15()
    };
}

function parseRoomAction(payload: Buffer): { roomId: number; actionId: number } {
    const br = new BitReader(payload);
    return {
        roomId: br.readMethod4(),
        actionId: br.readMethod4()
    };
}

function parseRoomInfo(payload: Buffer): { roomId: number; entityId: number; label: string; state: number; detail: string } {
    const br = new BitReader(payload);
    return {
        roomId: br.readMethod4(),
        entityId: br.readMethod4(),
        label: br.readMethod26(),
        state: br.readMethod4(),
        detail: br.readMethod26()
    };
}

function createEntityFullUpdatePacket(entity: {
    id: number;
    x: number;
    y: number;
    v?: number;
    name: string;
    team: number;
    isPlayer?: boolean;
    entState?: number;
    facingLeft?: boolean;
    running?: boolean;
    jumping?: boolean;
    dropping?: boolean;
    backpedal?: boolean;
}): Buffer {
    return (EntityHandler as any).buildEntityFullUpdatePayload({
        id: entity.id,
        x: entity.x,
        y: entity.y,
        v: entity.v ?? 0,
        name: entity.name,
        team: entity.team,
        isPlayer: Boolean(entity.isPlayer),
        renderDepthOffset: 0,
        entState: entity.entState ?? 0,
        facingLeft: Boolean(entity.facingLeft),
        running: Boolean(entity.running),
        jumping: Boolean(entity.jumping),
        dropping: Boolean(entity.dropping),
        backpedal: Boolean(entity.backpedal)
    });
}

function setPartyLeader(leader: FakeClient, ...members: FakeClient[]): void {
    const partyId = 77;
    const names = [leader, ...members].map((client) => client.character.name);
    GlobalState.partyGroups.set(partyId, {
        id: partyId,
        leader: leader.character.name,
        members: names,
        locked: false
    });
    for (const client of [leader, ...members]) {
        GlobalState.partyByMember.set(client.character.name.toLowerCase(), partyId);
    }
}

async function testGoblinRiverQuestProgressStaysIncompleteBeforeHostilesExist(): Promise<void> {
    const solo = createClient(800, 'Solo');

    GlobalState.sessionsByToken.set(solo.token, solo as never);

    await LevelHandler.handleQuestProgressUpdate(solo as never, createQuestProgressPacket(100));

    assert.equal(solo.character.questTrackerState, 11, 'dungeon progress should start at the Goblin River intro baseline before any shared hostile authority exists');
    assert.deepEqual(
        solo.sentPackets.filter((packet) => packet.id === 0xB7).map((packet) => parseQuestProgress(packet.payload)),
        [11],
        'the server should keep the client at the Goblin River intro baseline until shared dungeon hostiles exist'
    );

    await MissionHandler.handleSetLevelComplete(solo as never, createLevelCompletePacket());

    assert.equal(
        solo.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'the dungeon should not complete before shared dungeon authority and progress are established'
    );
}

async function testGoblinRiverQuestProgressFollowsHostileOwnerAuthority(): Promise<void> {
    const authority = createClient(801, 'Leader');
    const joiner = createClient(802, 'Member');

    GlobalState.sessionsByToken.set(authority.token, authority as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    setPartyLeader(authority, joiner);
    GlobalState.levelEntities.set('GoblinRiverDungeon#goblin-shared', new Map<number, any>([
        [
            5001,
            {
                id: 5001,
                name: 'GoblinClub',
                isPlayer: false,
                team: 2,
                entState: 0,
                hp: 100,
                clientSpawned: true,
                ownerToken: authority.token,
                ownerPartyId: 77,
                roomId: 1
            }
        ],
        [
            5002,
            {
                id: 5002,
                name: 'GoblinDagger',
                isPlayer: false,
                team: 2,
                entState: 6,
                hp: 0,
                dead: true,
                clientSpawned: true,
                ownerToken: authority.token,
                ownerPartyId: 77,
                roomId: 1
            }
        ]
    ]));

    await LevelHandler.handleQuestProgressUpdate(joiner as never, createQuestProgressPacket(100));

    assert.equal(joiner.character.questTrackerState, 56, 'joiner progress should be recomputed from the server hostile state on top of the Goblin River intro baseline');
    assert.equal(authority.character.questTrackerState, 56, 'leader progress should follow the same shared server-computed baseline-adjusted state');
    assert.deepEqual(
        joiner.sentPackets.filter((packet) => packet.id === 0xB7).map((packet) => parseQuestProgress(packet.payload)),
        [56],
        'joiner should be corrected to the shared server-computed progress'
    );
}

async function testGoblinRiverLevelCompleteWaitsForSharedProgressCompletion(): Promise<void> {
    const authority = createClient(811, 'Leader');
    const joiner = createClient(812, 'Member');

    GlobalState.sessionsByToken.set(authority.token, authority as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    setPartyLeader(authority, joiner);
    GlobalState.levelEntities.set('GoblinRiverDungeon#goblin-shared', new Map<number, any>([
        [
            5101,
            {
                id: 5101,
                name: 'GoblinArmorAxe',
                isPlayer: false,
                team: 2,
                entState: 0,
                hp: 100,
                clientSpawned: true,
                ownerToken: authority.token,
                ownerPartyId: 77,
                roomId: 1
            }
        ]
    ]));

    await MissionHandler.handleSetLevelComplete(joiner as never, createLevelCompletePacket());

    assert.equal(
        joiner.sentPackets.some((packet) => packet.id === 0x87),
        false,
        'joiner should not complete the dungeon while server-computed progress is incomplete'
    );

    await LevelHandler.handleQuestProgressUpdate(joiner as never, createQuestProgressPacket(100));
    assert.equal(joiner.character.questTrackerState, 11, 'joiner false completion should still stay at the Goblin River intro baseline before the server sees the hostile die');

    const hostile = GlobalState.levelEntities.get('GoblinRiverDungeon#goblin-shared')?.get(5101);
    assert.ok(hostile, 'canonical hostile should exist');
    hostile.hp = 0;
    hostile.dead = true;
    hostile.entState = 6;

    LevelHandler.refreshSharedDungeonQuestProgress('GoblinRiverDungeon#goblin-shared');
    await MissionHandler.handleSetLevelComplete(authority as never, createLevelCompletePacket());

    assert.equal(
        authority.sentPackets.some((packet) => packet.id === 0x87),
        true,
        'leader should complete the dungeon once server-computed shared progress reaches 100%'
    );
    assert.deepEqual(
        joiner.sentPackets.filter((packet) => packet.id === 0xB7).map((packet) => parseQuestProgress(packet.payload)).slice(-1),
        [100],
        'joiner should receive the shared server-computed 100% progress before completion'
    );
}

async function testGoblinRiverPartyLeaderBecomesSharedAuthority(): Promise<void> {
    const leader = createClient(803, 'Leader');
    const follower = createClient(804, 'Member');

    GlobalState.sessionsByToken.set(leader.token, leader as never);
    GlobalState.sessionsByToken.set(follower.token, follower as never);
    setPartyLeader(leader, follower);
    GlobalState.levelEntities.set('GoblinRiverDungeon#goblin-follower-authority', new Map<number, any>([
        [
            5003,
            {
                id: 5003,
                name: 'GoblinClub',
                isPlayer: false,
                team: 2,
                entState: 0,
                hp: 100,
                clientSpawned: true,
                ownerToken: follower.token,
                ownerPartyId: 77,
                roomId: 1
            }
        ],
        [
            5004,
            {
                id: 5004,
                name: 'GoblinDagger',
                isPlayer: false,
                team: 2,
                entState: 6,
                hp: 0,
                dead: true,
                clientSpawned: true,
                ownerToken: follower.token,
                ownerPartyId: 77,
                roomId: 1
            }
        ]
    ]));
    leader.levelInstanceId = 'goblin-follower-authority';
    follower.levelInstanceId = 'goblin-follower-authority';

    await LevelHandler.handleQuestProgressUpdate(leader as never, createQuestProgressPacket(100));

    assert.equal(
        resolveSharedDungeonProgressAuthorityToken('GoblinRiverDungeon#goblin-follower-authority'),
        leader.token,
        'shared dungeon authority should prefer the scoped party leader when party-owned hostiles drive the dungeon state'
    );
    assert.equal(leader.character.questTrackerState, 56);
    assert.equal(follower.character.questTrackerState, 56);
}

async function testGoblinRiverFollowerFirstHostileResetsProgressWithoutLeaderJoin(): Promise<void> {
    const follower = createClient(821, 'Member');
    follower.character.questTrackerState = 100;
    follower.levelInstanceId = 'goblin-follower-first';

    GlobalState.sessionsByToken.set(follower.token, follower as never);
    GlobalState.partyGroups.set(77, {
        id: 77,
        leader: 'Leader',
        members: ['Leader', 'Member'],
        locked: false
    });
    GlobalState.partyByMember.set('member', 77);

    EntityHandler.handleEntityFullUpdate(
        follower as never,
        createEntityFullUpdatePacket({
            id: 5201,
            x: 180,
            y: 240,
            name: 'GoblinArmorAxe',
            team: 2
        })
    );

    assert.equal(
        follower.character.questTrackerState,
        11,
        'first canonical follower hostile should force the shared Goblin River intro baseline without waiting for the leader'
    );
    assert.deepEqual(
        follower.sentPackets.filter((packet) => packet.id === 0xB7).map((packet) => parseQuestProgress(packet.payload)),
        [11],
        'first canonical follower hostile should immediately correct the local client progress'
    );
}

async function testGoblinRiverCameraBumpingProgressPromotionSharesPartySnapshot(): Promise<void> {
    for (const levelName of ['GoblinRiverDungeon', 'GoblinRiverDungeonHard'] as const) {
        const leader = createClient(841, 'Leader');
        const follower = createClient(842, 'Member');
        const stranger = createClient(843, 'Stranger');
        const instanceId = `goblin-camera-bump-${levelName}`;
        const levelScope = `${levelName}#${instanceId}`;

        leader.currentLevel = levelName;
        follower.currentLevel = levelName;
        stranger.currentLevel = levelName;
        leader.levelInstanceId = instanceId;
        follower.levelInstanceId = instanceId;
        stranger.levelInstanceId = instanceId;

        GlobalState.sessionsByToken.set(leader.token, leader as never);
        GlobalState.sessionsByToken.set(follower.token, follower as never);
        GlobalState.sessionsByToken.set(stranger.token, stranger as never);
        setPartyLeader(leader, follower);

        GlobalState.levelEntities.set(levelScope, new Map<number, any>([
            [
                5301,
                {
                    id: 5301,
                    name: 'GoblinClub',
                    isPlayer: false,
                    team: 2,
                    entState: 0,
                    hp: 100,
                    clientSpawned: true,
                    ownerToken: follower.token,
                    ownerPartyId: 77,
                    roomId: 1
                }
            ],
            [
                5302,
                {
                    id: 5302,
                    name: 'GoblinDagger',
                    isPlayer: false,
                    team: 2,
                    entState: 6,
                    hp: 0,
                    dead: true,
                    clientSpawned: true,
                    ownerToken: follower.token,
                    ownerPartyId: 77,
                    roomId: 1
                }
            ]
        ]));

        await LevelHandler.handleQuestProgressUpdate(leader as never, createQuestProgressPacket(65));

        assert.equal(
            leader.character.questTrackerState,
            65,
            `${levelName} non-authority party leader should be able to promote the shared CameraBumping percent`
        );
        assert.equal(
            follower.character.questTrackerState,
            65,
            `${levelName} follower should receive the promoted CameraBumping percent immediately`
        );
        assert.equal(
            getOrCreateSharedDungeonProgressState(levelScope)?.progress,
            65,
            `${levelName} shared dungeon snapshot should keep the promoted CameraBumping percent`
        );

        await LevelHandler.handleQuestProgressUpdate(stranger as never, createQuestProgressPacket(80));

        assert.equal(
            getOrCreateSharedDungeonProgressState(levelScope)?.progress,
            65,
            `${levelName} non-party strangers in the same scope must not influence the shared CameraBumping percent`
        );
    }
}

async function testGoblinRiverPromotedCameraBumpingProgressDoesNotRegress(): Promise<void> {
    const leader = createClient(851, 'Leader');
    const follower = createClient(852, 'Member');
    leader.levelInstanceId = 'goblin-camera-bump-regress';
    follower.levelInstanceId = 'goblin-camera-bump-regress';

    GlobalState.sessionsByToken.set(leader.token, leader as never);
    GlobalState.sessionsByToken.set(follower.token, follower as never);
    setPartyLeader(leader, follower);
    GlobalState.levelEntities.set('GoblinRiverDungeon#goblin-camera-bump-regress', new Map<number, any>([
        [
            5401,
            {
                id: 5401,
                name: 'GoblinClub',
                isPlayer: false,
                team: 2,
                entState: 0,
                hp: 100,
                clientSpawned: true,
                ownerToken: follower.token,
                ownerPartyId: 77,
                roomId: 1
            }
        ],
        [
            5402,
            {
                id: 5402,
                name: 'GoblinDagger',
                isPlayer: false,
                team: 2,
                entState: 6,
                hp: 0,
                dead: true,
                clientSpawned: true,
                ownerToken: follower.token,
                ownerPartyId: 77,
                roomId: 1
            }
        ]
    ]));

    await LevelHandler.handleQuestProgressUpdate(leader as never, createQuestProgressPacket(65));
    await LevelHandler.handleQuestProgressUpdate(follower as never, createQuestProgressPacket(56));

    assert.equal(
        getOrCreateSharedDungeonProgressState('GoblinRiverDungeon#goblin-camera-bump-regress')?.progress,
        65,
        'stale follower tutorial progress should not overwrite the promoted CameraBumping snapshot'
    );

    LevelHandler.refreshSharedDungeonQuestProgress('GoblinRiverDungeon#goblin-camera-bump-regress');

    assert.equal(
        leader.character.questTrackerState,
        65,
        'shared dungeon refresh should keep the promoted CameraBumping percent'
    );
    assert.equal(
        follower.character.questTrackerState,
        65,
        'followers should remain on the promoted CameraBumping percent after refresh'
    );
    assert.deepEqual(
        follower.sentPackets.filter((packet) => packet.id === 0xB7).map((packet) => parseQuestProgress(packet.payload)).slice(-2),
        [65, 65],
        'refresh should rebroadcast the promoted CameraBumping snapshot instead of regressing to the coarse baseline'
    );
}

async function testGoblinRiverTreasureChestDestroyDoesNotPolluteCameraBumpingProgress(): Promise<void> {
    const leader = createClient(856, 'Leader');
    const follower = createClient(857, 'Member');
    const levelScope = 'GoblinRiverDungeon#goblin-camera-bump-chest';

    leader.levelInstanceId = 'goblin-camera-bump-chest';
    follower.levelInstanceId = 'goblin-camera-bump-chest';

    GlobalState.sessionsByToken.set(leader.token, leader as never);
    GlobalState.sessionsByToken.set(follower.token, follower as never);
    setPartyLeader(leader, follower);

    const chest = {
        id: 5450,
        name: 'TreasureChestEmpty',
        isPlayer: false,
        team: 2,
        entState: 0,
        hp: 1,
        clientSpawned: true,
        ownerToken: follower.token,
        ownerPartyId: 77,
        roomId: 3
    };
    const goblinAlive = {
        id: 5451,
        name: 'GoblinClub',
        isPlayer: false,
        team: 2,
        entState: 0,
        hp: 100,
        clientSpawned: true,
        ownerToken: leader.token,
        ownerPartyId: 77,
        roomId: 4
    };
    const goblinDead = {
        id: 5452,
        name: 'GoblinDagger',
        isPlayer: false,
        team: 2,
        entState: 6,
        hp: 0,
        dead: true,
        clientSpawned: true,
        ownerToken: leader.token,
        ownerPartyId: 77,
        roomId: 4
    };

    noteSharedDungeonHostileState(levelScope, chest.id, chest);
    noteSharedDungeonHostileDestroyed(levelScope, chest.id, chest);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [goblinAlive.id, goblinAlive],
        [goblinDead.id, goblinDead]
    ]));

    await LevelHandler.handleQuestProgressUpdate(leader as never, createQuestProgressPacket(56));

    assert.equal(
        getOrCreateSharedDungeonProgressState(levelScope)?.trackedHostileIds?.has(chest.id),
        false,
        'destroyed treasure chests before the parrot cutscene must not remain in shared hostile totals'
    );
    assert.equal(
        leader.character.questTrackerState,
        56,
        'Camera Bumping coarse progress should be computed only from real hostiles after a pre-cutscene chest break'
    );
    assert.equal(
        follower.character.questTrackerState,
        56,
        'party followers should stay on the same Camera Bumping progress after the pre-cutscene chest break'
    );
    assert.deepEqual(
        follower.sentPackets.filter((packet) => packet.id === 0xB7).map((packet) => parseQuestProgress(packet.payload)).slice(-1),
        [56],
        'the corrected shared progress should broadcast immediately instead of leaving the follower pinned behind the chest break'
    );
}

async function testGoblinRiverTreasureChestDestroyRelaysAsSharedObjectNotPartyHostile(): Promise<void> {
    const leader = createClient(8571, 'Leader');
    const follower = createClient(8572, 'Member');
    const stranger = createClient(8573, 'Stranger');
    const levelScope = 'GoblinRiverDungeon#goblin-camera-bump-chest-destroy';

    leader.levelInstanceId = 'goblin-camera-bump-chest-destroy';
    follower.levelInstanceId = 'goblin-camera-bump-chest-destroy';
    stranger.levelInstanceId = 'goblin-camera-bump-chest-destroy';

    GlobalState.sessionsByToken.set(leader.token, leader as never);
    GlobalState.sessionsByToken.set(follower.token, follower as never);
    GlobalState.sessionsByToken.set(stranger.token, stranger as never);
    setPartyLeader(leader, follower);

    const chest = {
        id: 5455,
        name: 'TreasureChestEmpty',
        isPlayer: false,
        team: 2,
        entState: 0,
        hp: 1,
        clientSpawned: true,
        ownerToken: follower.token,
        ownerPartyId: 77,
        roomId: 3
    };

    GlobalState.levelEntities.set(levelScope, new Map<number, any>([[chest.id, { ...chest }]]));
    leader.entities.set(chest.id, { ...chest });
    follower.entities.set(chest.id, { ...chest });
    stranger.entities.set(chest.id, { ...chest });

    await CombatHandler.handleEntityDestroy(follower as never, createDestroyEntityPacket(chest.id));

    assert.equal(
        leader.sentPackets.some((packet) => packet.id === 0x0D),
        true,
        'party leader should receive the chest destroy as a shared object update'
    );
    assert.equal(
        stranger.sentPackets.some((packet) => packet.id === 0x0D),
        true,
        'same-scope strangers should also receive the chest destroy instead of the chest being treated as a party-only hostile'
    );
    assert.equal(
        getOrCreateSharedDungeonProgressState(levelScope)?.trackedHostileIds?.has(chest.id),
        false,
        'shared dungeon hostile tracking must stay clean after the chest destroy path'
    );
}

async function testGoblinRiverRoomPacketHistoryPreservesRepeatedCameraBumpingPackets(): Promise<void> {
    const leader = createClient(858, 'Leader');
    const follower = createClient(859, 'Member');
    const levelScope = 'GoblinRiverDungeon#goblin-camera-bump-history';

    leader.levelInstanceId = 'goblin-camera-bump-history';
    follower.levelInstanceId = 'goblin-camera-bump-history';
    leader.currentRoomId = 4;
    follower.currentRoomId = 4;

    GlobalState.sessionsByToken.set(leader.token, leader as never);
    GlobalState.sessionsByToken.set(follower.token, follower as never);
    setPartyLeader(leader, follower);

    LevelHandler.handleRoomEventStart(leader as never, createRoomEventStartPacket(4, true));
    follower.sentPackets.length = 0;

    LevelHandler.handleRoomEventStart(leader as never, createRoomEventStartPacket(4, false));
    LevelHandler.handleActionUpdate(leader as never, createRoomActionPacket(4, 9));
    LevelHandler.handleActionUpdate(leader as never, createRoomActionPacket(4, 11));
    LevelHandler.handleRoomInfoUpdate(leader as never, createRoomInfoPacket(4, 7001, 'CameraBumpingHint', 1, 'LookLeft'));
    LevelHandler.handleRoomInfoUpdate(leader as never, createRoomInfoPacket(4, 7001, 'CameraBumpingHint', 2, 'LookRight'));

    const sharedState = getOrCreateSharedDungeonProgressState(levelScope);
    assert.ok(sharedState, 'room packet history shared state should exist');
    assert.equal(
        sharedState!.startedRoomIds?.has(4),
        true,
        'room-start packets should remain the source of truth for startedRoomIds'
    );
    assert.equal(
        sharedState!.roomPacketSnapshots?.size,
        5,
        'cutscene start and repeated same-room action/info packets should all remain in ordered history'
    );

    follower.sentPackets.length = 0;
    LevelHandler.syncSharedDungeonQuestProgressState(follower as never);

    assert.equal(
        follower.startedRoomEvents.has('GoblinRiverDungeon:4'),
        true,
        'cutscene replay should not remove the real room-start marker from the follower'
    );
    assert.deepEqual(
        follower.sentPackets
            .filter((packet) => [0xA5, 0xAA, 0xAB].includes(packet.id))
            .map((packet) => {
                if (packet.id === 0xA5) {
                    return { id: packet.id, payload: parseRoomEventStart(packet.payload) };
                }
                if (packet.id === 0xAA) {
                    return { id: packet.id, payload: parseRoomAction(packet.payload) };
                }
                return { id: packet.id, payload: parseRoomInfo(packet.payload) };
            }),
        [
            { id: 0xA5, payload: { roomId: 4, flag: false } },
            { id: 0xAA, payload: { roomId: 4, actionId: 9 } },
            { id: 0xAA, payload: { roomId: 4, actionId: 11 } },
            { id: 0xAB, payload: { roomId: 4, entityId: 7001, label: 'CameraBumpingHint', state: 1, detail: 'LookLeft' } },
            { id: 0xAB, payload: { roomId: 4, entityId: 7001, label: 'CameraBumpingHint', state: 2, detail: 'LookRight' } }
        ],
        'same-room cutscene/action/info packets should replay in original order without being overwritten'
    );
}

async function testGoblinRiverFollowerCameraBumpingProgressStaysAtLeaderPercentThroughTutorial(): Promise<void> {
    const leader = createClient(860, 'Leader');
    const follower = createClient(861, 'Member');
    const levelScope = 'GoblinRiverDungeon#goblin-camera-bump-65';

    leader.levelInstanceId = 'goblin-camera-bump-65';
    follower.levelInstanceId = 'goblin-camera-bump-65';
    leader.currentRoomId = 4;
    follower.currentRoomId = 4;

    GlobalState.sessionsByToken.set(leader.token, leader as never);
    GlobalState.sessionsByToken.set(follower.token, follower as never);
    setPartyLeader(leader, follower);
    GlobalState.levelEntities.set(levelScope, new Map<number, any>([
        [
            5461,
            {
                id: 5461,
                name: 'GoblinClub',
                isPlayer: false,
                team: 2,
                entState: 0,
                hp: 100,
                clientSpawned: true,
                ownerToken: leader.token,
                ownerPartyId: 77,
                roomId: 4
            }
        ],
        [
            5462,
            {
                id: 5462,
                name: 'GoblinDagger',
                isPlayer: false,
                team: 2,
                entState: 6,
                hp: 0,
                dead: true,
                clientSpawned: true,
                ownerToken: leader.token,
                ownerPartyId: 77,
                roomId: 4
            }
        ]
    ]));

    const sharedState = getOrCreateSharedDungeonProgressState(levelScope);
    assert.ok(sharedState, 'camera bump shared state should exist');
    sharedState!.progress = 56;
    sharedState!.startedRoomIds = new Set<number>([0, 4]);

    LevelHandler.handleRoomEventStart(leader as never, createRoomEventStartPacket(4, false));
    await LevelHandler.handleQuestProgressUpdate(follower as never, createQuestProgressPacket(59));
    await LevelHandler.handleQuestProgressUpdate(leader as never, createQuestProgressPacket(65));
    await LevelHandler.handleQuestProgressUpdate(follower as never, createQuestProgressPacket(59));

    assert.equal(
        getOrCreateSharedDungeonProgressState(levelScope)?.progress,
        65,
        'stale follower progress during Camera Bumping should never pull the shared tutorial percent back below the leader'
    );
    assert.equal(
        leader.character.questTrackerState,
        65,
        'leader should preserve the full Camera Bumping tutorial percent'
    );
    assert.equal(
        follower.character.questTrackerState,
        65,
        'followers should stay synchronized with the leader percent through the full Camera Bumping tutorial'
    );
    assert.deepEqual(
        follower.sentPackets.filter((packet) => packet.id === 0xB7).map((packet) => parseQuestProgress(packet.payload)).slice(-3),
        [59, 65, 65],
        'follower should be corrected back to the leader-driven 65% instead of remaining pinned at 59%'
    );
}

async function testGoblinRiverLateRoomSnapshotReplayRestoresTargetingTutorialState(): Promise<void> {
    const leader = createClient(861, 'Leader');
    const follower = createClient(862, 'Member');
    const levelScope = 'GoblinRiverDungeon#goblin-room4-snapshot';

    leader.levelInstanceId = 'goblin-room4-snapshot';
    follower.levelInstanceId = 'goblin-room4-snapshot';
    leader.currentRoomId = 4;
    follower.currentRoomId = 0;

    GlobalState.sessionsByToken.set(leader.token, leader as never);
    GlobalState.sessionsByToken.set(follower.token, follower as never);
    setPartyLeader(leader, follower);

    LevelHandler.handleRoomStateUpdate(leader as never, createRoomStatePacket(4, 1));
    LevelHandler.handleActionUpdate(leader as never, createRoomActionPacket(4, 9));
    LevelHandler.handleRoomInfoUpdate(leader as never, createRoomInfoPacket(4, 7001, 'TargetingTutorial', 1, 'AimNow'));
    LevelHandler.handleRoomUnlock(leader as never, createRoomUnlockPacket(4));

    follower.sentPackets.length = 0;
    follower.currentRoomId = 4;
    LevelHandler.syncSharedDungeonQuestProgressState(follower as never);

    assert.equal(
        getOrCreateSharedDungeonProgressState(levelScope)?.roomPacketSnapshots?.size,
        4,
        'shared dungeon state should preserve the late room snapshot packets for replay'
    );
    assert.deepEqual(
        follower.sentPackets.map((packet) => packet.id).filter((id) => [0xA9, 0xAA, 0xAB, 0xAD].includes(id)),
        [0xA9, 0xAA, 0xAB, 0xAD],
        'late followers should receive the stored room 4 camera/action/info/unlock packets when they reach the same room'
    );
}

async function testGoblinRiverAuthorityCompletionPromotesAllPartyMembersToOneHundred(): Promise<void> {
    const authority = createClient(831, 'Leader');
    const joiner = createClient(832, 'Member');
    authority.levelInstanceId = 'goblin-boss-finish';
    joiner.levelInstanceId = 'goblin-boss-finish';
    authority.character.questTrackerState = 96;
    joiner.character.questTrackerState = 96;

    GlobalState.sessionsByToken.set(authority.token, authority as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    setPartyLeader(authority, joiner);

    const sharedState = getOrCreateSharedDungeonProgressState('GoblinRiverDungeon#goblin-boss-finish');
    assert.ok(sharedState, 'shared dungeon progress state should exist');
    const verifiedSharedState = sharedState!;
    verifiedSharedState.authorityToken = authority.token;
    verifiedSharedState.trackedHostileIds ??= new Set<number>();
    verifiedSharedState.defeatedHostileIds ??= new Set<number>();
    for (let index = 1; index <= 25; index += 1) {
        verifiedSharedState.trackedHostileIds.add(index);
        if (index < 25) {
            verifiedSharedState.defeatedHostileIds.add(index);
        }
    }

    await MissionHandler.handleSetLevelComplete(authority as never, createLevelCompletePacket());

    assert.equal(authority.character.questTrackerState, 100, 'authority completion should close the shared dungeon progress at 100');
    assert.equal(joiner.character.questTrackerState, 100, 'all party members in scope should receive the same 100% shared dungeon completion state');
    assert.deepEqual(
        joiner.sentPackets.filter((packet) => packet.id === 0xB7).map((packet) => parseQuestProgress(packet.payload)).slice(-1),
        [100],
        'party members should receive the final 100% quest progress broadcast when authority completes the dungeon'
    );
}

async function main(): Promise<void> {
    ensureLevelConfigLoaded();

    const levelEntities = new Map(GlobalState.levelEntities);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const levelQuestProgress = new Map(GlobalState.levelQuestProgress);
    const partyByMember = new Map(GlobalState.partyByMember);
    const partyGroups = new Map(GlobalState.partyGroups);
    GlobalState.levelEntities.clear();
    GlobalState.sessionsByToken.clear();
    GlobalState.levelQuestProgress.clear();
    GlobalState.partyByMember.clear();
    GlobalState.partyGroups.clear();

    try {
        await testGoblinRiverQuestProgressStaysIncompleteBeforeHostilesExist();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverQuestProgressFollowsHostileOwnerAuthority();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverPartyLeaderBecomesSharedAuthority();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverLevelCompleteWaitsForSharedProgressCompletion();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverFollowerFirstHostileResetsProgressWithoutLeaderJoin();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverCameraBumpingProgressPromotionSharesPartySnapshot();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverPromotedCameraBumpingProgressDoesNotRegress();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverTreasureChestDestroyDoesNotPolluteCameraBumpingProgress();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverTreasureChestDestroyRelaysAsSharedObjectNotPartyHostile();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverRoomPacketHistoryPreservesRepeatedCameraBumpingPackets();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverFollowerCameraBumpingProgressStaysAtLeaderPercentThroughTutorial();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverLateRoomSnapshotReplayRestoresTargetingTutorialState();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.levelQuestProgress.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testGoblinRiverAuthorityCompletionPromotesAllPartyMembersToOneHundred();
    } finally {
        GlobalState.levelEntities = levelEntities;
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.levelQuestProgress = levelQuestProgress;
        GlobalState.partyByMember = partyByMember;
        GlobalState.partyGroups = partyGroups;
    }

    console.log('shared_dungeon_progress_regression: ok');
}

void main().catch((error) => {
    console.error('shared_dungeon_progress_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
