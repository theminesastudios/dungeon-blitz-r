import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { TutorialDungeonMechanics } from '../core/TutorialDungeonMechanics';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { MissionLoader } from '../data/MissionLoader';
import { NpcLoader } from '../data/NpcLoader';
import { MissionID } from '../data/runtime';
import { LevelHandler } from '../handlers/LevelHandler';
import { CombatHandler } from '../handlers/CombatHandler';
import { EntityHandler } from '../handlers/EntityHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { RewardHandler } from '../handlers/RewardHandler';

type SentPacket = { id: number; payload: Buffer };

type FakeClient = {
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    token: number;
    userId: null;
    playerSpawned: boolean;
    clientEntID: number;
    character: any;
    characters: any[];
    sentPackets: SentPacket[];
    entities: Map<number, any>;
    knownEntityIds: Set<number>;
    entityIdAliases: Map<number, number>;
    pendingLoot: Map<number, any>;
    processedRewardSources: Set<string>;
    startedRoomEvents: Set<string>;
    triggeredLevelStates: Set<string>;
    pendingDungeonCompletionScope: string;
    pendingDungeonCompletionRequestedAt: number;
    pendingDungeonCompletionLastSkitAt: number;
    pendingDungeonCompletionNotBeforeAt: number;
    pendingDungeonCompletionSettleMs: number;
    pendingDungeonCompletionPayload: Buffer | null;
    pendingDungeonCompletionTimer: NodeJS.Timeout | null;
    pendingDungeonCompletionFlushActive: boolean;
    activeDungeonCutsceneScope: string;
    activeDungeonCutsceneRoomId: number;
    activeDungeonCutsceneJoinedAtDialogIndex: number;
    activeDungeonCutsceneLocalDialogIndex: number;
    lastDungeonCutsceneStartScope: string;
    lastDungeonCutsceneStartAt: number;
    lastDungeonCutsceneEndScope: string;
    lastDungeonCutsceneEndAt: number;
    armPendingTransferGrace(): void;
    send(id: number, payload: Buffer): void;
    sendBitBuffer(id: number, bb: BitBuffer): void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('TutorialDungeon')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.RescueAnna)) {
        MissionLoader.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
    NpcLoader.load(dataDir);
}

function createFakeClient(name: string, token: number): FakeClient {
    const sentPackets: SentPacket[] = [];
    const character = {
        name,
        CurrentLevel: { name: 'TutorialDungeon', x: 22600, y: 2950 },
        PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 },
        missions: {
            [String(MissionID.RescueAnna)]: {
                state: 1,
                currCount: 0
            }
        },
        questTrackerState: 11,
        level: 12,
        xp: 0,
        gold: 0
    };

    return {
        currentLevel: 'TutorialDungeon',
        levelInstanceId: `goblin-kidnappers-${token}`,
        currentRoomId: 11,
        token,
        userId: null,
        playerSpawned: true,
        clientEntID: token + 1000,
        character,
        characters: [character],
        sentPackets,
        entities: new Map(),
        knownEntityIds: new Set(),
        entityIdAliases: new Map(),
        pendingLoot: new Map(),
        processedRewardSources: new Set(),
        startedRoomEvents: new Set(),
        triggeredLevelStates: new Set(),
        pendingDungeonCompletionScope: '',
        pendingDungeonCompletionRequestedAt: 0,
        pendingDungeonCompletionLastSkitAt: 0,
        pendingDungeonCompletionNotBeforeAt: 0,
        pendingDungeonCompletionSettleMs: 0,
        pendingDungeonCompletionPayload: null,
        pendingDungeonCompletionTimer: null,
        pendingDungeonCompletionFlushActive: false,
        activeDungeonCutsceneScope: '',
        activeDungeonCutsceneRoomId: 0,
        activeDungeonCutsceneJoinedAtDialogIndex: 0,
        activeDungeonCutsceneLocalDialogIndex: 0,
        lastDungeonCutsceneStartScope: '',
        lastDungeonCutsceneStartAt: 0,
        lastDungeonCutsceneEndScope: '',
        lastDungeonCutsceneEndAt: 0,
        armPendingTransferGrace() {
            return undefined;
        },
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function bossEntity(hp: number = 0, maxHp: number = 1000): any {
    return {
        id: TutorialDungeonMechanics.TAG_UGO_BOSS_ID,
        name: 'GoblinBoss1',
        displayName: 'Tag Ugo',
        isPlayer: false,
        roomId: 11,
        team: EntityTeam.ENEMY,
        entState: hp <= 0 ? EntityState.DEAD : EntityState.ACTIVE,
        hp,
        maxHp,
        dead: hp <= 0,
        clientDefeatVerified: true
    };
}

function annaChainEntity(): any {
    return {
        id: TutorialDungeonMechanics.ANNA_CHAIN_ID,
        name: 'Chains03',
        isPlayer: false,
        roomId: 11,
        team: EntityTeam.ENEMY,
        entState: EntityState.DEAD,
        hp: 0,
        maxHp: 100,
        dead: true,
        clientDefeatVerified: true
    };
}

function entity(id: number, name: string): any {
    return {
        id,
        name,
        isPlayer: false,
        roomId: 2,
        team: EntityTeam.ENEMY,
        entState: EntityState.DEAD,
        hp: 0,
        maxHp: 100,
        dead: true,
        clientDefeatVerified: true
    };
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

function buildRoomEventPayload(roomId: number, includeStartFlag: boolean): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(roomId);
    if (includeStartFlag) {
        bb.writeMethod15(true);
    }
    return bb.toBuffer();
}

function buildHostileFullUpdate(entityId: number, name: string, roomId: number): Buffer {
    const payload = (EntityHandler as any).buildEntityFullUpdatePayload({
        id: entityId,
        name,
        isPlayer: false,
        x: 1500,
        y: 900,
        v: 0,
        team: EntityTeam.ENEMY,
        renderDepthOffset: 0,
        characterName: '',
        dramaAnim: '',
        sleepAnim: '',
        summonerId: 0,
        powerId: 0,
        entState: EntityState.ACTIVE,
        facingLeft: false,
        running: false,
        jumping: false,
        dropping: false,
        backpedal: false,
        roomId
    });
    return Buffer.concat([payload, Buffer.from([0])]);
}

function buildDestroyEntityPayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod15(true);
    return bb.toBuffer();
}

function buildEntityDeadIncrementalPayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod45(0);
    bb.writeMethod45(0);
    bb.writeMethod45(0);
    bb.writeMethod6(EntityState.DEAD, 2);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildPowerCastPayload(sourceId: number, powerId: number = 100): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(sourceId);
    bb.writeMethod4(powerId);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildPowerHitPayload(targetId: number, sourceId: number, damage: number, powerId: number = 100): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(targetId);
    bb.writeMethod4(sourceId);
    bb.writeMethod24(damage);
    bb.writeMethod4(powerId);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildGrantRewardPayload(sourceId: number, receiverId: number, gold: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(receiverId);
    bb.writeMethod9(sourceId);
    bb.writeMethod15(true);
    bb.writeMethod309(1);
    bb.writeMethod15(false);
    bb.writeMethod309(1);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(gold);
    bb.writeMethod24(11228);
    bb.writeMethod24(2381);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function levelStateSnapshots(client: FakeClient): string[] {
    return client.sentPackets
        .filter((packet) => packet.id === 0x40)
        .map((packet) => {
            const br = new BitReader(packet.payload);
            br.readMethod26();
            return br.readMethod26();
        });
}

function shareScope(...clients: FakeClient[]): void {
    const instanceId = clients[0].levelInstanceId;
    for (const client of clients) {
        client.levelInstanceId = instanceId;
        GlobalState.sessionsByToken.set(client.token, client as never);
    }
}

function packetCount(client: FakeClient, packetId: number): number {
    return client.sentPackets.filter((packet) => packet.id === packetId).length;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function resetFor(client: FakeClient): void {
    const scope = getClientLevelScope(client as never);
    TutorialDungeonMechanics.resetState(scope);
    GlobalState.levelEntities.delete(scope);
    GlobalState.levelQuestProgress.delete(scope);
    DungeonCompletionSystem.reset(scope);
    GlobalState.dungeonCutscenes.clear();
    GlobalState.sessionsByToken.clear();
    GlobalState.partyGroups.clear();
    GlobalState.partyByMember.clear();
    if (client.pendingDungeonCompletionTimer) {
        clearTimeout(client.pendingDungeonCompletionTimer);
        client.pendingDungeonCompletionTimer = null;
    }
}

function testPartyLeaderSideEnemiesRemainClientPrivate(): void {
    const leader = createFakeClient('PartyLeader', 61006);
    const member = createFakeClient('PartyMember', 61007);
    resetFor(leader);
    member.levelInstanceId = leader.levelInstanceId;
    GlobalState.sessionsByToken.set(leader.token, leader as never);
    GlobalState.sessionsByToken.set(member.token, member as never);
    GlobalState.partyGroups.set(900, {
        id: 900,
        leader: leader.character.name,
        members: [leader.character.name, member.character.name],
        locked: false
    });
    GlobalState.partyByMember.set('partyleader', 900);
    GlobalState.partyByMember.set('partymember', 900);

    const sideEnemyId = 7001001;
    EntityHandler.handleEntityFullUpdate(
        leader as never,
        buildHostileFullUpdate(sideEnemyId, 'GoblinDagger', 2)
    );

    const localSideEnemy = leader.entities.get(sideEnemyId);
    assert.equal(localSideEnemy?.clientSpawned, true, 'party leader side enemy must remain client-owned');
    assert.equal(localSideEnemy?.hybridCanonicalHostile, undefined, 'side enemy must not become a server canonical');
    assert.equal(
        GlobalState.levelEntities.get(getClientLevelScope(leader as never))?.has(sideEnemyId) ?? false,
        false,
        'party leader side enemy must not enter authoritative shared dungeon state'
    );
    assert.equal(
        EntityHandler.shouldMirrorClientSpawnEntityToParty('TutorialDungeon', localSideEnemy),
        false,
        'side enemy must not be mirrored through the party server path'
    );
    assert.equal(packetCount(member, 0x08), 0, 'side enemy must not be spawned for another party member');
    assert.equal(
        EntityHandler.shouldMirrorClientSpawnEntityToParty('TutorialDungeon', {
            ...localSideEnemy,
            id: TutorialDungeonMechanics.TAG_UGO_BOSS_ID,
            name: 'GoblinBoss1'
        }),
        true,
        'Tag Ugo must remain the only party-shared hostile'
    );
}

function testOnlyTagUgoIsServerSpawned(): void {
    for (const levelName of ['TutorialDungeon', 'TutorialDungeonHard']) {
        const serverNpcs = NpcLoader.getNpcsForLevel(levelName);
        assert.equal(serverNpcs.length, 1, `${levelName} should retain exactly one server-spawned entity`);
        assert.equal(serverNpcs[0].id, TutorialDungeonMechanics.TAG_UGO_BOSS_ID);
        assert.equal(serverNpcs[0].name, 'GoblinBoss1');
        assert.equal(serverNpcs[0].team, EntityTeam.ENEMY);
        assert.equal(serverNpcs[0].boss, true);
        assert.equal(serverNpcs[0].serverOnlyObjective, false);
    }
}

function testTagUgoUsesCanonicalServerStatsAndHpSync(): void {
    const client = createFakeClient('CanonicalTagUgo', 61008);
    const bossNpc = NpcLoader.getNpcsForLevel('TutorialDungeon')
        .find((npc) => npc.id === TutorialDungeonMechanics.TAG_UGO_BOSS_ID);
    assert.ok(bossNpc, 'Tag Ugo server NPC should be available');
    assert.equal(
        EntityHandler.usesServerAuthorityHostiles('TutorialDungeon'),
        true,
        'Goblin Kidnappers should use the same canonical hostile authority contract as East Wing'
    );

    const canonicalBoss = (EntityHandler as any).createServerAuthorityEntityFromNpc(
        client,
        'TutorialDungeon',
        bossNpc
    );
    assert.equal(canonicalBoss.id, TutorialDungeonMechanics.TAG_UGO_BOSS_ID);
    assert.equal(canonicalBoss.clientSpawned, false);
    assert.equal(canonicalBoss.level, EntityHandler.SERVER_AUTHORITY_ENTITY_LEVEL);
    assert.ok(canonicalBoss.maxHp > 0, 'Tag Ugo should receive canonical server max HP');
    assert.equal(canonicalBoss.hp, canonicalBoss.maxHp, 'Tag Ugo should begin at canonical full HP');
    assert.equal(
        (CombatHandler as any).isServerAuthoritySyncNpc(
            getClientLevelScope(client as never),
            canonicalBoss
        ),
        true,
        'Tag Ugo should use authoritative multiplayer HP synchronization'
    );
}

function testTagUgoUsesOneClientVisualBackedByCanonicalServerBoss(): void {
    const client = createFakeClient('TagUgoVisual', 61009);
    resetFor(client);
    GlobalState.sessionsByToken.set(client.token, client as never);

    EntityHandler.sendInitialLevelEntities(client as never, 'TutorialDungeon');

    const scope = getClientLevelScope(client as never);
    const levelMap = GlobalState.levelEntities.get(scope);
    const canonicalBoss = levelMap?.get(TutorialDungeonMechanics.TAG_UGO_BOSS_ID);
    assert.ok(canonicalBoss, 'Tag Ugo canonical server boss should be seeded for the dungeon run');
    assert.equal(canonicalBoss.clientSpawned, false);
    assert.equal(
        packetCount(client, 0x0F),
        0,
        'canonical Tag Ugo must remain hidden so it cannot duplicate the cinematic client cue'
    );

    client.sentPackets.length = 0;
    EntityHandler.handleEntityFullUpdate(
        client as never,
        buildHostileFullUpdate(TutorialDungeonMechanics.TAG_UGO_BOSS_ID, 'GoblinBoss1', 11)
    );

    const visualBoss = client.entities.get(TutorialDungeonMechanics.TAG_UGO_BOSS_ID);
    assert.ok(visualBoss, 'the cinematic client cue should become the sole local Tag Ugo visual');
    assert.equal(visualBoss.clientSpawned, true);
    assert.equal(visualBoss.canonicalEntityId, TutorialDungeonMechanics.TAG_UGO_BOSS_ID);
    assert.equal(visualBoss.level, EntityHandler.SERVER_AUTHORITY_ENTITY_LEVEL);
    assert.equal(visualBoss.maxHp, canonicalBoss.maxHp, 'visual boss should inherit canonical server stats');
    assert.equal(visualBoss.hp, canonicalBoss.hp, 'visual boss should inherit canonical server HP');
    assert.equal(
        Array.from(levelMap?.values() ?? []).filter((entity: any) =>
            Number(entity?.id ?? 0) === TutorialDungeonMechanics.TAG_UGO_BOSS_ID
        ).length,
        1,
        'the shared dungeon state should contain exactly one Tag Ugo boss'
    );
    assert.equal(packetCount(client, 0x78), 1, 'client visual should receive one canonical initial HP sync');
    assert.equal(packetCount(client, 0x0F), 0, 'proxy attachment must not send another visible boss spawn');
}

async function testBossDefeatWaitsForAnnaChain(): Promise<void> {
    const client = createFakeClient('KidnapperRunner', 61001);
    resetFor(client);
    GlobalState.sessionsByToken.set(client.token, client as never);

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, bossEntity());

    const state = TutorialDungeonMechanics.getClientState(client as never);
    assert.equal(state?.bossDefeated, true, 'Tag Ugo should be recorded as defeated');
    assert.equal(state?.annaFreed, false, 'Anna rescue should still be incomplete');
    assert.equal(client.pendingDungeonCompletionScope, '', 'boss defeat alone must not schedule completion');
    assert.equal(packetCount(client, 0x87), 0, 'boss defeat alone must not emit rank result');
}

async function testAnnaChainCompletesAfterBoss(): Promise<void> {
    const client = createFakeClient('AnnaRescuer', 61002);
    resetFor(client);
    GlobalState.sessionsByToken.set(client.token, client as never);

    const scope = getClientLevelScope(client as never);
    await MissionHandler.handleForcedDungeonBossCompletion(client as never, bossEntity());
    MissionHandler.noteDungeonCutsceneStart(client as never, 11);
    await MissionHandler.handleForcedDungeonObjectiveCompletion(client as never, annaChainEntity());

    assert.equal(client.pendingDungeonCompletionScope, '', 'completion must wait in the shared state, not a client timer');
    DungeonCompletionSystem.noteClientCompletionSignal(
        scope,
        DungeonCompletionSystem.getParticipantKey(client as never),
        100
    );
    const beforeCutsceneEnd = DungeonCompletionSystem.evaluate(scope);
    assert.equal(beforeCutsceneEnd.ready, false, 'client completion signal must not bypass the active end cutscene');
    assert.equal(beforeCutsceneEnd.reason, 'cutscene_gate_pending');
    assert.equal(packetCount(client, 0x87), 0, 'rank result must remain hidden until the end cutscene finishes');

    MissionHandler.noteDungeonCutsceneEnd(client as never, 11);
    await sleep(5);

    assert.equal(DungeonCompletionSystem.evaluate(scope).objectivesMet, true);
    assert.equal(packetCount(client, 0x87), 1, 'final rescue should emit one rank result');

    await MissionHandler.handleForcedDungeonObjectiveCompletion(client as never, annaChainEntity());
    await sleep(5);
    assert.equal(packetCount(client, 0x87), 1, 'duplicate chain defeat should not emit duplicate rank result');
}

function testScriptedObjectiveStateIsIdempotent(): void {
    const client = createFakeClient('ScriptedState', 61003);
    resetFor(client);

    let events = TutorialDungeonMechanics.noteEntityDefeated(client as never, entity(3268190, 'Chains02'));
    assert.deepEqual(events, ['early_chain_broken']);
    events = TutorialDungeonMechanics.noteEntityDefeated(client as never, entity(3268190, 'Chains02'));
    assert.deepEqual(events, [], 'chain state should be idempotent by entity id');

    TutorialDungeonMechanics.noteEntityDefeated(client as never, entity(4841054, 'IntroDummy1'));
    TutorialDungeonMechanics.noteEntityDefeated(client as never, entity(4906590, 'IntroDummy2'));
    TutorialDungeonMechanics.noteEntityDefeated(client as never, entity(4972126, 'IntroDummy3'));
    TutorialDungeonMechanics.noteEntityDefeated(client as never, entity(3989086, 'TreasureChestEmpty'));

    const state = TutorialDungeonMechanics.getClientState(client as never);
    assert.equal(state?.dummyOneDefeated, true);
    assert.equal(state?.dummyTwoDefeated, true);
    assert.equal(state?.dummyThreeDefeated, true);
    assert.equal(state?.bossChestOpened, true);
}

function testBossIntroAndThresholdsAreServerTracked(): void {
    const client = createFakeClient('BossIntro', 61004);
    resetFor(client);
    GlobalState.sessionsByToken.set(client.token, client as never);

    LevelHandler.handleRoomBossInfo(
        client as never,
        buildRoomBossInfoPayload(11, TutorialDungeonMechanics.TAG_UGO_BOSS_ID, 'Tag Ugo')
    );
    TutorialDungeonMechanics.noteBossHealth(client as never, bossEntity(790, 1000));
    TutorialDungeonMechanics.noteBossHealth(client as never, bossEntity(490, 1000));
    TutorialDungeonMechanics.noteBossHealth(client as never, bossEntity(320, 1000));
    TutorialDungeonMechanics.noteBossHealth(client as never, bossEntity(300, 1000));

    const state = TutorialDungeonMechanics.getClientState(client as never);
    assert.equal(state?.bossIntroStarted, true);
    assert.equal(state?.bossWave80, true);
    assert.equal(state?.bossWave50, true);
    assert.equal(state?.bossWave33, true);
    assert.equal(state?.events.filter((event) => event === 'boss_wave_33').length, 1);
}

async function testEarlyChainBroadcastAndLateJoinSnapshot(): Promise<void> {
    const playerOne = createFakeClient('ChainBreaker', 61101);
    const playerTwo = createFakeClient('ChainWitness', 61102);
    const lateJoiner = createFakeClient('ChainLateJoiner', 61103);
    const playerOneChainRuntimeId = 710001;
    const playerTwoChainRuntimeId = 720001;
    const lateJoinerChainRuntimeId = 730001;
    playerOne.currentRoomId = 1;
    playerTwo.currentRoomId = 1;
    lateJoiner.currentRoomId = 1;
    resetFor(playerOne);
    shareScope(playerOne, playerTwo);

    EntityHandler.handleEntityFullUpdate(playerOne as never, buildHostileFullUpdate(playerOneChainRuntimeId, 'Chains02', 1));
    EntityHandler.handleEntityFullUpdate(playerTwo as never, buildHostileFullUpdate(playerTwoChainRuntimeId, 'Chains02', 1));
    playerOne.sentPackets.length = 0;
    playerTwo.sentPackets.length = 0;

    LevelHandler.handleEntityIncrementalUpdate(playerOne as never, buildEntityDeadIncrementalPayload(playerOneChainRuntimeId));
    const scope = getClientLevelScope(playerOne as never);
    const state = TutorialDungeonMechanics.getState(scope);
    assert.equal(state?.earlyChainsBroken, true);
    assert.equal(state?.parrotFreed, true);
    assert.equal(state?.revision, 1);
    assert.equal(packetCount(playerTwo, 0x0D), 1, 'same-scope peer should receive authoritative chain destruction');
    assert.ok(levelStateSnapshots(playerTwo).some((snapshot) => snapshot.includes('earlyChain=1') && snapshot.includes('parrotFreed=1')));

    lateJoiner.levelInstanceId = playerOne.levelInstanceId;
    GlobalState.sessionsByToken.set(lateJoiner.token, lateJoiner as never);
    EntityHandler.handleEntityFullUpdate(lateJoiner as never, buildHostileFullUpdate(lateJoinerChainRuntimeId, 'Chains02', 1));
    assert.equal(packetCount(lateJoiner, 0x0D), 1, 'late joiner should receive terminal cue state only after its room cue is ready');
    assert.ok(levelStateSnapshots(lateJoiner).some((snapshot) => snapshot.includes('earlyChain=1') && snapshot.includes('parrotFreed=1')));

    await CombatHandler.handleEntityDestroy(playerOne as never, buildDestroyEntityPayload(playerOneChainRuntimeId));
    assert.equal(state?.revision, 1, 'replayed chain destroy must not advance the authoritative revision');
}

async function testOrderedDummiesOpenGateForLateJoiner(): Promise<void> {
    const playerOne = createFakeClient('DummyRunner', 61201);
    const lateJoiner = createFakeClient('DummyLateJoiner', 61202);
    playerOne.currentRoomId = 2;
    lateJoiner.currentRoomId = 2;
    resetFor(playerOne);
    shareScope(playerOne);

    for (const [id, name] of [[4841054, 'IntroDummy1'], [4906590, 'IntroDummy2'], [4972126, 'IntroDummy3']] as const) {
        EntityHandler.handleEntityFullUpdate(playerOne as never, buildHostileFullUpdate(id, name, 2));
        await CombatHandler.handleEntityDestroy(playerOne as never, buildDestroyEntityPayload(id));
    }
    const scope = getClientLevelScope(playerOne as never);
    const state = TutorialDungeonMechanics.getState(scope);
    assert.equal(state?.dummyOneDefeated, true);
    assert.equal(state?.dummyTwoDefeated, true);
    assert.equal(state?.dummyThreeDefeated, true);
    assert.equal(state?.room2GateOpen, true);
    assert.equal(state?.room2CollisionDisabled, true);

    lateJoiner.levelInstanceId = playerOne.levelInstanceId;
    GlobalState.sessionsByToken.set(lateJoiner.token, lateJoiner as never);
    EntityHandler.handleEntityFullUpdate(lateJoiner as never, buildHostileFullUpdate(4841054, 'IntroDummy1', 2));
    assert.ok(levelStateSnapshots(lateJoiner).some((snapshot) =>
        snapshot.includes('d1=1') && snapshot.includes('d2=1') && snapshot.includes('d3=1') && snapshot.includes('gate=1')
    ));
}

async function testSharedTagUgoHpDeathAndReplayDedupe(): Promise<void> {
    const playerOne = createFakeClient('BossFighterOne', 61301);
    const playerTwo = createFakeClient('BossFighterTwo', 61302);
    playerOne.currentRoomId = 11;
    playerTwo.currentRoomId = 11;
    resetFor(playerOne);
    shareScope(playerOne, playerTwo);
    EntityHandler.sendInitialLevelEntities(playerOne as never, 'TutorialDungeon');
    EntityHandler.handleEntityFullUpdate(playerOne as never, buildHostileFullUpdate(TutorialDungeonMechanics.TAG_UGO_BOSS_ID, 'GoblinBoss1', 11));
    EntityHandler.handleEntityFullUpdate(playerTwo as never, buildHostileFullUpdate(TutorialDungeonMechanics.TAG_UGO_BOSS_ID, 'GoblinBoss1', 11));

    const scope = getClientLevelScope(playerOne as never);
    const canonicalBoss = GlobalState.levelEntities.get(scope)?.get(TutorialDungeonMechanics.TAG_UGO_BOSS_ID);
    assert.ok(canonicalBoss);
    const initialHp = Number(canonicalBoss.hp);
    await CombatHandler.handlePowerCast(playerOne as never, buildPowerCastPayload(playerOne.clientEntID));
    const hit = buildPowerHitPayload(TutorialDungeonMechanics.TAG_UGO_BOSS_ID, playerOne.clientEntID, 100);
    await CombatHandler.handlePowerHit(playerOne as never, hit);
    assert.equal(Number(canonicalBoss.hp), initialHp - 100);
    assert.equal(playerOne.entities.get(TutorialDungeonMechanics.TAG_UGO_BOSS_ID)?.hp, canonicalBoss.hp);
    assert.equal(playerTwo.entities.get(TutorialDungeonMechanics.TAG_UGO_BOSS_ID)?.hp, canonicalBoss.hp);
    const hpAfterFirstHit = Number(canonicalBoss.hp);
    await CombatHandler.handlePowerHit(playerOne as never, hit);
    assert.equal(Number(canonicalBoss.hp), hpAfterFirstHit, 'replayed hit from the same cast must be ignored');

    await CombatHandler.handlePowerCast(playerTwo as never, buildPowerCastPayload(playerTwo.clientEntID, 101));
    await CombatHandler.handlePowerHit(
        playerTwo as never,
        buildPowerHitPayload(TutorialDungeonMechanics.TAG_UGO_BOSS_ID, playerTwo.clientEntID, Number(canonicalBoss.maxHp) + 1, 101)
    );
    assert.equal(canonicalBoss.dead, true);
    assert.equal(canonicalBoss.destroyed, true);
    assert.equal(canonicalBoss.bossDeathCommitted, true);
    assert.equal(canonicalBoss.bossRespawnBlocked, true);
    assert.equal(Math.round(Number(canonicalBoss.deathVersion)), 1, 'Tag Ugo death must commit once');
    assert.equal(packetCount(playerOne, 0x0D) > 0, true);
    assert.equal(packetCount(playerTwo, 0x0D) > 0, true);

    const lateJoiner = createFakeClient('BossLateJoiner', 61303);
    lateJoiner.currentRoomId = 11;
    lateJoiner.levelInstanceId = playerOne.levelInstanceId;
    GlobalState.sessionsByToken.set(lateJoiner.token, lateJoiner as never);
    EntityHandler.handleEntityFullUpdate(lateJoiner as never, buildHostileFullUpdate(TutorialDungeonMechanics.TAG_UGO_BOSS_ID, 'GoblinBoss1', 11));
    assert.equal(packetCount(lateJoiner, 0x0D), 1, 'late joiner must receive the Tag Ugo tombstone');
}

function testChestRewardIsOncePerEligibleParticipant(): void {
    const opener = createFakeClient('ChestOpener', 61401);
    const peer = createFakeClient('ChestPeer', 61402);
    opener.currentRoomId = 5;
    peer.currentRoomId = 5;
    resetFor(opener);
    shareScope(opener, peer);
    EntityHandler.handleEntityFullUpdate(opener as never, buildHostileFullUpdate(TutorialDungeonMechanics.TUTORIAL_CHEST_ID, 'TreasureChestEmpty', 5));
    EntityHandler.handleEntityFullUpdate(peer as never, buildHostileFullUpdate(TutorialDungeonMechanics.TUTORIAL_CHEST_ID, 'TreasureChestEmpty', 5));

    const payload = buildGrantRewardPayload(TutorialDungeonMechanics.TUTORIAL_CHEST_ID, opener.clientEntID, 4);
    RewardHandler.handleGrantReward(opener as never, payload);
    assert.equal(opener.pendingLoot.size, 1);
    assert.equal(peer.pendingLoot.size, 1);
    const openerLootCount = opener.pendingLoot.size;
    const peerLootCount = peer.pendingLoot.size;
    RewardHandler.handleGrantReward(peer as never, buildGrantRewardPayload(TutorialDungeonMechanics.TUTORIAL_CHEST_ID, peer.clientEntID, 4));
    assert.equal(opener.pendingLoot.size, openerLootCount);
    assert.equal(peer.pendingLoot.size, peerLootCount);

    const lateJoiner = createFakeClient('ChestLateJoiner', 61403);
    lateJoiner.currentRoomId = 5;
    lateJoiner.levelInstanceId = opener.levelInstanceId;
    GlobalState.sessionsByToken.set(lateJoiner.token, lateJoiner as never);
    EntityHandler.handleEntityFullUpdate(lateJoiner as never, buildHostileFullUpdate(TutorialDungeonMechanics.TUTORIAL_CHEST_ID, 'TreasureChestEmpty', 5));
    RewardHandler.handleGrantReward(lateJoiner as never, buildGrantRewardPayload(TutorialDungeonMechanics.TUTORIAL_CHEST_ID, lateJoiner.clientEntID, 4));
    assert.equal(lateJoiner.pendingLoot.size, 0, 'late joiner should see the opened chest without receiving a retroactive reward');
}

function testCutscenePhaseAndOwnerDepartureAreServerOwned(): void {
    const owner = createFakeClient('PresentationOwner', 61501);
    const peer = createFakeClient('PresentationPeer', 61502);
    owner.currentRoomId = 11;
    peer.currentRoomId = 11;
    resetFor(owner);
    shareScope(owner, peer);
    const scope = getClientLevelScope(owner as never);
    const cutsceneStart = buildRoomEventPayload(11, true);
    LevelHandler.handleRoomEventStart(owner as never, cutsceneStart);
    LevelHandler.handleRoomEventStart(peer as never, cutsceneStart);
    assert.equal(TutorialDungeonMechanics.getSnapshot(scope)?.cutscenePhase, 'active');
    EntityHandler.sendTutorialDungeonWorldSnapshot(peer as never, 'late_cutscene_join');
    assert.ok(levelStateSnapshots(peer).some((snapshot) => snapshot.includes('cutscene=active')));
    const sharedCutscene = GlobalState.dungeonCutscenes.get(`${scope}:11`);
    assert.equal(sharedCutscene?.participantKeys?.size, 2);
    LevelHandler.handleRoomClose(owner as never, buildRoomEventPayload(11, false));
    assert.equal(sharedCutscene?.active, true, 'one player closing presentation must not complete shared world phase');
    assert.equal(TutorialDungeonMechanics.getSnapshot(scope)?.cutscenePhase, 'active');

    GlobalState.sessionsByToken.delete(owner.token);
    DungeonCompletionSystem.releaseParticipant(owner as never);
    assert.ok(TutorialDungeonMechanics.getState(scope), 'presentation owner leaving must not transfer or destroy world authority');
    assert.equal(sharedCutscene?.participantKeys?.size, 1, 'departing presentation owner must leave the close barrier');
    LevelHandler.handleRoomClose(peer as never, buildRoomEventPayload(11, false));
    assert.equal(TutorialDungeonMechanics.getSnapshot(scope)?.cutscenePhase, 'completed');

    GlobalState.sessionsByToken.delete(peer.token);
    DungeonCompletionSystem.releaseParticipant(peer as never);
    assert.equal(GlobalState.tutorialDungeonWorldStates.has(scope), false, 'last participant should release the scope-owned snapshot');
}

async function testCompletionAndRankAreOncePerEligibleParticipant(): Promise<void> {
    const playerOne = createFakeClient('CompletionPlayerOne', 61601);
    const playerTwo = createFakeClient('CompletionPlayerTwo', 61602);
    resetFor(playerOne);
    shareScope(playerOne, playerTwo);
    const scope = getClientLevelScope(playerOne as never);

    await MissionHandler.handleForcedDungeonBossCompletion(playerOne as never, bossEntity());
    MissionHandler.noteDungeonCutsceneStart(playerOne as never, 11);
    await MissionHandler.handleForcedDungeonObjectiveCompletion(playerOne as never, annaChainEntity());
    DungeonCompletionSystem.noteClientCompletionSignal(
        scope,
        DungeonCompletionSystem.getParticipantKey(playerOne as never),
        100
    );
    DungeonCompletionSystem.noteClientCompletionSignal(
        scope,
        DungeonCompletionSystem.getParticipantKey(playerTwo as never),
        100
    );
    MissionHandler.noteDungeonCutsceneEnd(playerTwo as never, 11);
    await sleep(5);

    assert.equal(packetCount(playerOne, 0x87), 1, 'player one should receive one rank result');
    assert.equal(packetCount(playerTwo, 0x87), 1, 'player two should receive one rank result');
    assert.equal(
        DungeonCompletionSystem.getState(scope)?.completedParticipants.size,
        2,
        'both stable participant keys should be finalized'
    );

    await MissionHandler.handleForcedDungeonBossCompletion(playerTwo as never, bossEntity());
    await MissionHandler.handleForcedDungeonObjectiveCompletion(playerTwo as never, annaChainEntity());
    DungeonCompletionSystem.noteClientCompletionSignal(
        scope,
        DungeonCompletionSystem.getParticipantKey(playerOne as never),
        100
    );
    MissionHandler.noteDungeonCutsceneEnd(playerOne as never, 11);
    await sleep(5);
    assert.equal(packetCount(playerOne, 0x87), 1, 'replayed completion must not duplicate player one rank');
    assert.equal(packetCount(playerTwo, 0x87), 1, 'replayed completion must not duplicate player two rank');
    assert.equal(
        TutorialDungeonMechanics.getSnapshot(scope)?.completionPhase,
        'completed',
        'replayed completion signals must not regress the canonical completion phase'
    );
}

async function main(): Promise<void> {
    ensureDataLoaded();
    testOnlyTagUgoIsServerSpawned();
    testTagUgoUsesCanonicalServerStatsAndHpSync();
    testTagUgoUsesOneClientVisualBackedByCanonicalServerBoss();
    testPartyLeaderSideEnemiesRemainClientPrivate();
    await testBossDefeatWaitsForAnnaChain();
    await testAnnaChainCompletesAfterBoss();
    testScriptedObjectiveStateIsIdempotent();
    testBossIntroAndThresholdsAreServerTracked();
    await testEarlyChainBroadcastAndLateJoinSnapshot();
    await testOrderedDummiesOpenGateForLateJoiner();
    await testSharedTagUgoHpDeathAndReplayDedupe();
    testChestRewardIsOncePerEligibleParticipant();
    testCutscenePhaseAndOwnerDepartureAreServerOwned();
    await testCompletionAndRankAreOncePerEligibleParticipant();
    console.log('goblin_kidnappers_server_authority_regression: ok');
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
