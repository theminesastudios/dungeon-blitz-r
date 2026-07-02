import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { CombatHandler } from '../handlers/CombatHandler';
import { EntityHandler } from '../handlers/EntityHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { SocialHandler } from '../handlers/SocialHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { getLevelScopeKey } from '../core/LevelScope';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    character: { name: string; level: number; dialogueLanguage?: string; CurrentLevel?: { name: string; x: number; y: number } };
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    startedRoomEvents: Set<string>;
    triggeredLevelStates: Set<string>;
    entities: Map<number, any>;
    entityIdAliases: Map<number, number>;
    activeDungeonCutsceneScope: string;
    activeDungeonCutsceneRoomId: number;
    activeDungeonCutsceneJoinedAtDialogIndex: number;
    activeDungeonCutsceneLocalDialogIndex: number;
    lastDungeonCutsceneStartScope: string;
    lastDungeonCutsceneStartAt: number;
    lastDungeonCutsceneEndScope: string;
    lastDungeonCutsceneEndAt: number;
    pendingDungeonCompletionScope: string;
    pendingDungeonCompletionWaitForCutsceneEnd: boolean;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('JC_Mission3')) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
}

function createFakeClient(name: string, token: number): FakeClient {
    const sentPackets: SentPacket[] = [];
    return {
        token,
        character: {
            name,
            level: 50,
            dialogueLanguage: 'en',
            CurrentLevel: { name: 'JC_Mission3', x: 1000, y: 1000 }
        },
        currentLevel: 'JC_Mission3',
        levelInstanceId: 'cinematic-sync',
        currentRoomId: 2,
        playerSpawned: true,
        clientEntID: token + 1000,
        startedRoomEvents: new Set<string>(),
        triggeredLevelStates: new Set<string>(),
        entities: new Map<number, any>(),
        entityIdAliases: new Map<number, number>(),
        activeDungeonCutsceneScope: '',
        activeDungeonCutsceneRoomId: 0,
        activeDungeonCutsceneJoinedAtDialogIndex: 0,
        activeDungeonCutsceneLocalDialogIndex: 0,
        lastDungeonCutsceneStartScope: '',
        lastDungeonCutsceneStartAt: 0,
        lastDungeonCutsceneEndScope: '',
        lastDungeonCutsceneEndAt: 0,
        pendingDungeonCompletionScope: '',
        pendingDungeonCompletionWaitForCutsceneEnd: false,
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createKeepClient(name: string, token: number): FakeClient {
    const client = createFakeClient(name, token);
    client.currentLevel = 'NR_Tales1Keep';
    client.levelInstanceId = 'keep-solo-cinematic';
    client.character.CurrentLevel = { name: 'NR_Tales1Keep', x: 1000, y: 1000 };
    return client;
}

function buildRoomEventStartPayload(roomId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(roomId);
    bb.writeMethod15(true);
    return bb.toBuffer();
}

function buildRoomClosePayload(roomId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(roomId);
    return bb.toBuffer();
}

function buildRoomStatePayload(roomId: number, cameraId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(roomId);
    bb.writeMethod9(cameraId);
    return bb.toBuffer();
}

function buildRoomPlaySoundPayload(roomId: number, soundName: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(roomId);
    bb.writeMethod26(soundName);
    bb.writeMethod9(100);
    return bb.toBuffer();
}

function buildRoomBossInfoPayload(roomId: number, bossId: number, bossName: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(roomId);
    bb.writeMethod9(bossId);
    bb.writeMethod26(bossName);
    bb.writeMethod9(0);
    bb.writeMethod26('');
    return bb.toBuffer();
}

function buildRoomThoughtPayload(entityId: number, text: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod13(text);
    return bb.toBuffer();
}

function buildEmoteBeginPayload(entityId: number, emote: string): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod13(emote);
    return bb.toBuffer();
}

function buildEmoteEndPayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    return bb.toBuffer();
}

function buildPowerHitPayload(targetId: number, sourceId: number, damage: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(targetId);
    bb.writeMethod4(sourceId);
    bb.writeMethod24(damage);
    bb.writeMethod4(77);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function packetCount(client: FakeClient, packetId: number): number {
    return client.sentPackets.filter((packet) => packet.id === packetId).length;
}

function testSharedDungeonCinematicRunsOnceFromOwner(): void {
    const mage = createFakeClient('Mage', 91001);
    const rogue = createFakeClient('Rogue', 92002);
    GlobalState.sessionsByToken.set(mage.token, mage as never);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);

    const scope = getLevelScopeKey(mage.currentLevel, mage.levelInstanceId);
    LevelHandler.handleRoomEventStart(mage as never, buildRoomEventStartPayload(2));

    assert.equal(packetCount(rogue, 0xA5), 0, 'first cutscene start should not show borders for party viewers behind the trigger');
    assert.equal(mage.activeDungeonCutsceneScope, scope, 'owner should record active cutscene scope');
    assert.equal(rogue.activeDungeonCutsceneScope, '', 'viewer should not join the cutscene before entering locally');

    mage.sentPackets.length = 0;
    rogue.sentPackets.length = 0;
    SocialHandler.handleRoomThought(mage as never, buildRoomThoughtPayload(101, 'The dragon wakes.'));
    assert.equal(packetCount(mage, 0x76), 1, 'owner cutscene bubble should still echo locally');
    assert.equal(packetCount(rogue, 0x76), 0, 'owner cutscene bubble should not relay to party viewers');
    LevelHandler.handleRoomStateUpdate(mage as never, buildRoomStatePayload(2, 7));
    assert.equal(packetCount(rogue, 0xA9), 0, 'owner cutscene camera should not relay to party viewers behind the trigger');
    LevelHandler.handlePlaySound(mage as never, buildRoomPlaySoundPayload(2, 'CutsceneWarning'));
    assert.equal(packetCount(rogue, 0xA8), 0, 'owner cutscene sound should not relay to party viewers behind the trigger');
    SocialHandler.handleEmoteBegin(mage as never, buildEmoteBeginPayload(mage.clientEntID, 'Talk'));
    SocialHandler.handleEmoteEnd(mage as never, buildEmoteEndPayload(mage.clientEntID));
    assert.equal(packetCount(rogue, 0x7e), 0, 'owner cutscene emote begin should not relay to party viewers behind the trigger');
    assert.equal(packetCount(rogue, 0x7f), 0, 'owner cutscene emote end should not relay to party viewers behind the trigger');

    mage.sentPackets.length = 0;
    rogue.sentPackets.length = 0;
    LevelHandler.handleRoomEventStart(rogue as never, buildRoomEventStartPayload(2));
    SocialHandler.handleRoomThought(rogue as never, buildRoomThoughtPayload(101, 'The dragon wakes.'));
    SocialHandler.handleRoomThought(rogue as never, buildRoomThoughtPayload(101, 'A second warning.'));
    LevelHandler.handleRoomStateUpdate(rogue as never, buildRoomStatePayload(2, 7));
    LevelHandler.handlePlaySound(rogue as never, buildRoomPlaySoundPayload(2, 'CutsceneWarning'));
    SocialHandler.handleEmoteBegin(rogue as never, buildEmoteBeginPayload(rogue.clientEntID, 'Talk'));
    SocialHandler.handleEmoteEnd(rogue as never, buildEmoteEndPayload(rogue.clientEntID));
    LevelHandler.handleRoomClose(rogue as never, buildRoomClosePayload(2));

    assert.equal(packetCount(mage, 0xA5), 0, 'late viewer start should not restart the cutscene for the owner');
    assert.equal(packetCount(rogue, 0xA5), 1, 'late viewer should receive its own cutscene border start');
    assert.equal(packetCount(mage, 0x76), 0, 'late viewer cutscene bubbles should not relay back to the owner');
    assert.equal(packetCount(rogue, 0x76), 1, 'late viewer should skip stale lines and continue from the joined dialog index');
    assert.equal(packetCount(mage, 0xA9), 0, 'late viewer camera timeline should not relay');
    assert.equal(packetCount(mage, 0xA8), 0, 'late viewer sound timeline should not relay');
    assert.equal(packetCount(mage, 0x7e), 0, 'late viewer emote begin timeline should not relay');
    assert.equal(packetCount(mage, 0x7f), 0, 'late viewer emote end timeline should not relay');
    assert.equal(packetCount(mage, 0xA6), 0, 'late viewer close should not end the owner timeline early');

    mage.sentPackets.length = 0;
    rogue.sentPackets.length = 0;
    LevelHandler.handleRoomClose(mage as never, buildRoomClosePayload(2));

    assert.equal(packetCount(rogue, 0xA6), 1, 'owner cutscene close should relay to the viewer');
    assert.equal(mage.activeDungeonCutsceneScope, '', 'owner active cutscene should clear after close');
    assert.equal(rogue.activeDungeonCutsceneScope, '', 'viewer active cutscene should clear after close');

    mage.sentPackets.length = 0;
    rogue.sentPackets.length = 0;
    LevelHandler.handleRoomEventStart(rogue as never, buildRoomEventStartPayload(2));
    SocialHandler.handleRoomThought(rogue as never, buildRoomThoughtPayload(101, 'The dragon wakes.'));
    LevelHandler.handleRoomClose(rogue as never, buildRoomClosePayload(2));

    assert.equal(packetCount(mage, 0xA5), 0, 'completed cutscene should not start again');
    assert.equal(packetCount(mage, 0x76), 0, 'completed cutscene should not replay duplicate bubbles');
    assert.equal(packetCount(mage, 0xA6), 0, 'completed cutscene should not close again');
}

function testSharedDungeonBossInfoStartsBorderOnlyForSource(): void {
    const mage = createFakeClient('Mage', 91001);
    const rogue = createFakeClient('Rogue', 92002);
    GlobalState.sessionsByToken.set(mage.token, mage as never);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);

    LevelHandler.handleRoomBossInfo(mage as never, buildRoomBossInfoPayload(2, 500001, 'AncientDragonGoldMini'));

    assert.equal(packetCount(mage, 0xA5), 1, 'boss info should trigger cutscene border for the source client if room start has not arrived yet');
    assert.equal(packetCount(rogue, 0xA5), 0, 'boss info should not trigger cutscene borders for party viewers behind the trigger');
    assert.equal(packetCount(rogue, 0xAC), 1, 'boss info should still relay the boss bar packet to party viewers');

    mage.sentPackets.length = 0;
    rogue.sentPackets.length = 0;
    LevelHandler.handleRoomEventStart(mage as never, buildRoomEventStartPayload(2));

    assert.equal(packetCount(mage, 0xA5), 0, 'late owner room start should not replay cutscene border for source after boss info');
    assert.equal(packetCount(rogue, 0xA5), 0, 'late owner room start should not replay cutscene border for viewers after boss info');
}

function testSharedDungeonSuppressesOtherPlayerThoughtTargets(): void {
    const mage = createFakeClient('Mage', 91001);
    const rogue = createFakeClient('Rogue', 92002);
    GlobalState.sessionsByToken.set(mage.token, mage as never);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    mage.entities.set(mage.clientEntID, {
        id: mage.clientEntID,
        isPlayer: true,
        ownerToken: mage.token,
        name: mage.character.name
    });
    mage.entities.set(rogue.clientEntID, {
        id: rogue.clientEntID,
        isPlayer: true,
        ownerToken: rogue.token,
        name: rogue.character.name
    });

    const scope = getLevelScopeKey(mage.currentLevel, mage.levelInstanceId);
    LevelHandler.handleRoomEventStart(mage as never, buildRoomEventStartPayload(2));

    mage.sentPackets.length = 0;
    rogue.sentPackets.length = 0;
    SocialHandler.handleRoomThought(mage as never, buildRoomThoughtPayload(rogue.clientEntID, '@That is not my line.'));
    assert.equal(packetCount(mage, 0x76), 0, 'owner should not see local cutscene player bubbles over another player');
    assert.equal(packetCount(rogue, 0x76), 0, 'other player target should not receive the owner cutscene bubble');

    SocialHandler.handleRoomThought(mage as never, buildRoomThoughtPayload(mage.clientEntID, '@This is my line.'));
    assert.equal(packetCount(mage, 0x76), 1, 'owner should still see local cutscene bubbles over their own player');
    assert.equal(packetCount(rogue, 0x76), 0, 'own-player cutscene bubble should remain local to the owner');
    assert.equal(
        GlobalState.dungeonCutscenes.get(`${scope}:2`)?.dialogIndex,
        1,
        'suppressed other-player thoughts should not advance the shared dialog index'
    );
}

function testSharedDungeonRoomThoughtSurvivesCurrentRoomDrift(): void {
    const mage = createFakeClient('Mage', 91001);
    const rogue = createFakeClient('Rogue', 92002);
    GlobalState.sessionsByToken.set(mage.token, mage as never);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);

    const scope = getLevelScopeKey(mage.currentLevel, mage.levelInstanceId);
    LevelHandler.handleRoomEventStart(mage as never, buildRoomEventStartPayload(2));
    mage.currentRoomId = 2003367144;

    mage.sentPackets.length = 0;
    rogue.sentPackets.length = 0;
    SocialHandler.handleRoomThought(mage as never, buildRoomThoughtPayload(mage.clientEntID, '@Still my local line.'));

    assert.equal(packetCount(mage, 0x76), 1, 'active cutscene room should be used when currentRoomId has drifted');
    assert.equal(packetCount(rogue, 0x76), 0, 'drifted currentRoomId should not fall back to global bubble relay');
    assert.equal(
        GlobalState.dungeonCutscenes.get(`${scope}:2`)?.dialogIndex,
        1,
        'drifted currentRoomId should still advance the canonical cutscene dialog index'
    );
    assert.equal(
        GlobalState.dungeonCutscenes.has(`${scope}:2003367144`),
        false,
        'drifted currentRoomId should not create a bogus shared cutscene state'
    );
}

function testJoinerRoomReplayDoesNotStartSharedCutscene(): void {
    const mage = createFakeClient('Mage', 91001);
    const rogue = createFakeClient('Rogue', 92002);
    const scope = getLevelScopeKey(mage.currentLevel, mage.levelInstanceId);
    mage.startedRoomEvents.add('JC_Mission3:2');
    mage.currentRoomId = 2;
    rogue.currentRoomId = 1;

    GlobalState.sessionsByToken.set(mage.token, mage as never);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);
    GlobalState.partyGroups.set(1001, {
        id: 1001,
        leader: mage.character.name,
        members: [mage.character.name, rogue.character.name],
        locked: false
    });
    GlobalState.partyByMember.set('mage', 1001);
    GlobalState.partyByMember.set('rogue', 1001);
    GlobalState.dungeonCutscenes.set(`${scope}:2`, {
        roomId: 2,
        ownerToken: mage.token,
        active: true,
        completed: false,
        startedAt: Date.now(),
        endedAt: 0,
        dialogIndex: 1
    });

    (EntityHandler as any).replayStartedDungeonRoomEventsToJoiner(rogue);

    assert.equal(packetCount(rogue, 0xA5), 0, 'joiner replay should not force active shared cutscene borders');
    assert.equal(rogue.currentRoomId, 1, 'joiner room id should not be moved into the anchor cutscene room');
    assert.equal(
        rogue.startedRoomEvents.has('JC_Mission3:2'),
        false,
        'joiner should not be marked as having entered the shared cutscene room'
    );
}

function testPostDeathCompletionCanReuseCompletedRoomCutscene(): void {
    const mage = createFakeClient('Mage', 91001);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    const scope = getLevelScopeKey(mage.currentLevel, mage.levelInstanceId);
    LevelHandler.handleRoomEventStart(mage as never, buildRoomEventStartPayload(2));
    LevelHandler.handleRoomClose(mage as never, buildRoomClosePayload(2));
    assert.equal(mage.activeDungeonCutsceneScope, '', 'pre-boss room cutscene should be completed before the boss death sequence');

    mage.pendingDungeonCompletionScope = scope;
    mage.pendingDungeonCompletionWaitForCutsceneEnd = true;
    mage.sentPackets.length = 0;

    LevelHandler.handleRoomEventStart(mage as never, buildRoomEventStartPayload(2));
    assert.equal(mage.activeDungeonCutsceneScope, scope, 'post-death boss cutscene should reopen a completed room cutscene');

    SocialHandler.handleRoomThought(mage as never, buildRoomThoughtPayload(101, 'The defector is beaten.'));
    assert.equal(packetCount(mage, 0x76), 1, 'post-death boss dialogue should relay while completion waits for the cutscene');
}

function testSoloKeepCutsceneSkitIsNotSuppressedBySharedState(): void {
    const mage = createKeepClient('Mage', 91001);
    GlobalState.sessionsByToken.set(mage.token, mage as never);

    LevelHandler.handleRoomEventStart(mage as never, buildRoomEventStartPayload(2));
    LevelHandler.handleRoomClose(mage as never, buildRoomClosePayload(2));
    mage.sentPackets.length = 0;

    SocialHandler.handleRoomThought(mage as never, buildRoomThoughtPayload(101, 'I claim this keep.'));
    assert.equal(packetCount(mage, 0x76), 1, 'solo keep cutscene skits should not be suppressed by shared cinematic duplicate state');
}

async function testSharedDungeonCinematicSuppressesPlayerDamage(): Promise<void> {
    const mage = createFakeClient('Mage', 91001);
    const rogue = createFakeClient('Rogue', 92002);
    GlobalState.sessionsByToken.set(mage.token, mage as never);
    GlobalState.sessionsByToken.set(rogue.token, rogue as never);

    const scope = getLevelScopeKey(mage.currentLevel, mage.levelInstanceId);
    GlobalState.levelEntities.set(scope, new Map<number, any>([
        [500001, {
            id: 500001,
            name: 'AncientDragonGoldMini',
            isPlayer: false,
            team: 2,
            hp: 10000,
            maxHp: 10000,
            entState: 0,
            roomId: 2
        }]
    ]));

    LevelHandler.handleRoomEventStart(mage as never, buildRoomEventStartPayload(2));
    await CombatHandler.handlePowerHit(rogue as never, buildPowerHitPayload(500001, rogue.clientEntID, 9000));

    assert.equal(
        GlobalState.levelEntities.get(scope)?.get(500001)?.hp,
        10000,
        'player power hits during the shared cinematic should not damage the hostile'
    );
}

async function main(): Promise<void> {
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const partyGroups = new Map(GlobalState.partyGroups);
    const partyByMember = new Map(GlobalState.partyByMember);
    const dungeonCutscenes = new Map(GlobalState.dungeonCutscenes);
    const levelEntities = new Map(GlobalState.levelEntities);

    ensureDataLoaded();
    try {
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCutscenes.clear();
        GlobalState.levelEntities.clear();
        testSharedDungeonCinematicRunsOnceFromOwner();
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCutscenes.clear();
        GlobalState.levelEntities.clear();
        testSharedDungeonBossInfoStartsBorderOnlyForSource();
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCutscenes.clear();
        GlobalState.levelEntities.clear();
        testSharedDungeonSuppressesOtherPlayerThoughtTargets();
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCutscenes.clear();
        GlobalState.levelEntities.clear();
        testSharedDungeonRoomThoughtSurvivesCurrentRoomDrift();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyGroups.clear();
        GlobalState.partyByMember.clear();
        GlobalState.dungeonCutscenes.clear();
        GlobalState.levelEntities.clear();
        testJoinerRoomReplayDoesNotStartSharedCutscene();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyGroups.clear();
        GlobalState.partyByMember.clear();
        GlobalState.dungeonCutscenes.clear();
        GlobalState.levelEntities.clear();
        testPostDeathCompletionCanReuseCompletedRoomCutscene();
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCutscenes.clear();
        GlobalState.levelEntities.clear();
        testSoloKeepCutsceneSkitIsNotSuppressedBySharedState();
        GlobalState.sessionsByToken.clear();
        GlobalState.dungeonCutscenes.clear();
        GlobalState.levelEntities.clear();
        await testSharedDungeonCinematicSuppressesPlayerDamage();
        console.log('shared_dungeon_cinematic_regression: ok');
    } finally {
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.partyGroups = partyGroups;
        GlobalState.partyByMember = partyByMember;
        GlobalState.dungeonCutscenes = dungeonCutscenes;
        GlobalState.levelEntities = levelEntities;
    }
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
