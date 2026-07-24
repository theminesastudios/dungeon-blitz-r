import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { MovementAuthority } from '../core/MovementAuthority';
import { TutorialDungeonMechanics } from '../core/TutorialDungeonMechanics';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { MissionLoader } from '../data/MissionLoader';
import { NpcLoader } from '../data/NpcLoader';
import { MissionID } from '../data/runtime';
import { clearOpenBossScene, markRoomBossEntity, noteBossSceneOpened } from '../core/RoomBossState';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { DialogueTranslationLoader } from '../data/DialogueTranslationLoader';
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
    authoritativeCurrentHp: number;
    authoritativeMaxHp: number;
    enemyDeathRegenArmed: boolean;
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
        class: 'mage',
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
        authoritativeCurrentHp: 1000,
        authoritativeMaxHp: 1000,
        enemyDeathRegenArmed: false,
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

function buildPlayerFullUpdate(client: FakeClient, x: number, y: number): Buffer {
    const payload = (EntityHandler as any).buildEntityFullUpdatePayload({
        id: client.clientEntID,
        name: client.character.name,
        isPlayer: true,
        x,
        y,
        v: 0,
        team: EntityTeam.PLAYER,
        renderDepthOffset: 0,
        characterName: client.character.name,
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
        roomId: client.currentRoomId
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

function buildEntityActiveIncrementalPayload(entityId: number, deltaX: number, deltaY: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod45(deltaX);
    bb.writeMethod45(deltaY);
    bb.writeMethod45(0);
    bb.writeMethod6(EntityState.ACTIVE, 2);
    bb.writeMethod15(false);
    bb.writeMethod15(true);
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

function parseHpDelta(payload: Buffer): { entityId: number; delta: number } {
    const br = new BitReader(payload);
    return {
        entityId: br.readMethod4(),
        delta: br.readMethod45()
    };
}

function shareScope(...clients: FakeClient[]): void {
    const instanceId = clients[0].levelInstanceId;
    for (const client of clients) {
        client.levelInstanceId = instanceId;
        GlobalState.sessionsByToken.set(client.token, client as never);
    }
}

function shareParty(partyId: number, ...clients: FakeClient[]): void {
    if (clients.length === 0) {
        return;
    }

    GlobalState.partyGroups.set(partyId, {
        id: partyId,
        leader: clients[0].character.name,
        members: clients.map((client) => client.character.name),
        locked: false
    });
    for (const client of clients) {
        GlobalState.partyByMember.set(String(client.character.name).toLowerCase(), partyId);
    }
}

function packetCount(client: FakeClient, packetId: number): number {
    return client.sentPackets.filter((packet) => packet.id === packetId).length;
}

function dungeonResultStars(client: FakeClient): number[] {
    return client.sentPackets
        .filter((packet) => packet.id === 0x87)
        .map((packet) => {
            const br = new BitReader(packet.payload);
            return br.readMethod6(4);
        });
}

function hpDeltasFor(client: FakeClient, entityId: number): number[] {
    return client.sentPackets
        .filter((packet) => packet.id === 0x78)
        .map((packet) => {
            const br = new BitReader(packet.payload);
            return {
                entityId: br.readMethod4(),
                delta: br.readMethod45()
            };
        })
        .filter((packet) => packet.entityId === entityId)
        .map((packet) => packet.delta);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function settleScheduledCompletion(client: FakeClient): Promise<void> {
    if (client.pendingDungeonCompletionTimer) {
        clearTimeout(client.pendingDungeonCompletionTimer);
        client.pendingDungeonCompletionTimer = null;
    }
    client.pendingDungeonCompletionNotBeforeAt = Date.now() - 1;
    client.pendingDungeonCompletionLastSkitAt = Date.now() - 1;
    client.pendingDungeonCompletionSettleMs = 0;
    await (MissionHandler as any).flushPendingDungeonCompletion(client);
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
    const serverNpcs = NpcLoader.getNpcsForLevel('TutorialDungeon');
    assert.equal(serverNpcs.length, 1, 'TutorialDungeon should retain exactly one server-spawned entity');
    assert.equal(serverNpcs[0].id, TutorialDungeonMechanics.TAG_UGO_BOSS_ID);
    assert.equal(serverNpcs[0].name, 'GoblinBoss1');
    assert.equal(serverNpcs[0].team, EntityTeam.ENEMY);
    assert.equal(serverNpcs[0].boss, true);
    assert.equal(serverNpcs[0].serverOnlyObjective, false);

    // This assertion used to cover TutorialDungeonHard too, which was wrong on
    // both counts. Dread Goblin Hideout is not in SERVER_AUTHORITY_HOSTILE_LEVELS
    // — its Tag Ugo is the client's own cue promoted to a hybrid canonical — and
    // it is built from a different room set, so the inherited spawn carried the
    // normal dungeon's name and coordinates. A live run put it on top of room
    // 09's treasure chest as a second, motionless Tag Ugo that also held the run
    // at objectives_pending forever. Dread must seed no server hostiles at all.
    assert.equal(
        NpcLoader.getNpcsForLevel('TutorialDungeonHard').length,
        0,
        'TutorialDungeonHard must not inherit the normal dungeon server spawns'
    );
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

async function testTagUgoDamageSyncDoesNotRefillVisibleBossBar(): Promise<void> {
    const client = createFakeClient('TagUgoHpViewer', 61013);
    client.currentRoomId = 11;
    resetFor(client);
    GlobalState.sessionsByToken.set(client.token, client as never);

    EntityHandler.sendInitialLevelEntities(client as never, 'TutorialDungeon');
    EntityHandler.handleEntityFullUpdate(
        client as never,
        buildHostileFullUpdate(TutorialDungeonMechanics.TAG_UGO_BOSS_ID, 'GoblinBoss1', 11)
    );

    const scope = getClientLevelScope(client as never);
    const canonicalBoss = GlobalState.levelEntities.get(scope)?.get(TutorialDungeonMechanics.TAG_UGO_BOSS_ID);
    assert.ok(canonicalBoss, 'Tag Ugo canonical server boss should exist for HP relay regression');
    const maxHp = Math.max(1, Math.round(Number(canonicalBoss.maxHp)));
    client.sentPackets.length = 0;

    await CombatHandler.handlePowerCast(client as never, buildPowerCastPayload(client.clientEntID, 100));
    await CombatHandler.handlePowerHit(
        client as never,
        buildPowerHitPayload(TutorialDungeonMechanics.TAG_UGO_BOSS_ID, client.clientEntID, 100)
    );

    assert.equal(Math.round(Number(canonicalBoss.hp)), maxHp - 100, 'canonical Tag Ugo HP should take server-authoritative damage');
    const deltas = hpDeltasFor(client, TutorialDungeonMechanics.TAG_UGO_BOSS_ID);
    assert.equal(
        deltas.some((delta) => delta >= maxHp),
        false,
        'damage sync must not refill the already-visible boss bar before applying damage'
    );
    assert.equal(
        deltas.some((delta) => delta < 0),
        true,
        'visible boss should receive a negative HP delta when canonical HP drops'
    );
    assert.equal(
        Math.round(Number(client.entities.get(TutorialDungeonMechanics.TAG_UGO_BOSS_ID)?.hp)),
        maxHp - 100,
        'viewer cache should match canonical Tag Ugo HP after damage sync'
    );
}

function testTagUgoDoesNotRegenWhenPlayerRevivedWithStaleZeroHp(): void {
    const client = createFakeClient('RevivedBossFighter', 61010);
    client.currentRoomId = 11;
    resetFor(client);
    GlobalState.sessionsByToken.set(client.token, client as never);

    EntityHandler.sendInitialLevelEntities(client as never, 'TutorialDungeon');
    const scope = getClientLevelScope(client as never);
    const canonicalBoss = GlobalState.levelEntities.get(scope)?.get(TutorialDungeonMechanics.TAG_UGO_BOSS_ID);
    assert.ok(canonicalBoss, 'Tag Ugo canonical server boss should be seeded for regen regression');

    canonicalBoss.hp = 500;
    canonicalBoss.maxHp = 1000;
    canonicalBoss.dead = false;
    canonicalBoss.entState = EntityState.ACTIVE;
    canonicalBoss.deathRegenArmedForPlayerKey = `${client.token}:${client.clientEntID}`;
    canonicalBoss.lastCombatActivityAt = 1;
    canonicalBoss.lastCombatRegenTickAt = 0;
    canonicalBoss.aggroTargetEntityId = client.clientEntID;
    canonicalBoss.aggroTargetToken = client.token;
    canonicalBoss.x = 22695;
    canonicalBoss.y = 2959;

    client.authoritativeCurrentHp = 0;
    client.enemyDeathRegenArmed = true;
    const activePlayerEntity = {
        id: client.clientEntID,
        isPlayer: true,
        roomId: 11,
        x: 22600,
        y: 2950,
        hp: 1000,
        maxHp: 1000,
        dead: false,
        entState: EntityState.ACTIVE
    };
    client.entities.set(client.clientEntID, activePlayerEntity);
    GlobalState.levelEntities.get(scope)?.set(client.clientEntID, { ...activePlayerEntity });

    (CombatHandler as any).processHostileOutOfCombatRegen(scope, canonicalBoss, 60_000);
    assert.equal(canonicalBoss.hp, 500, 'Tag Ugo regenerated while the player was alive with stale zero authoritative HP');
    assert.equal(
        String(canonicalBoss.deathRegenArmedForPlayerKey ?? ''),
        '',
        'stale player-death regen arm should be cleared once the player is active again'
    );
    assert.equal(canonicalBoss.aggroTargetEntityId, client.clientEntID, 'active boss aggro target should not be cleared as dead');
    assert.equal(canonicalBoss.aggroTargetToken, client.token, 'active boss aggro token should not be cleared as dead');
}

function testTagUgoDoesNotRegenAfterActiveMovementWithStaleSavedPositionAndZeroHp(): void {
    const client = createFakeClient('MovingBossFighter', 61012);
    client.currentRoomId = 11;
    client.character.CurrentLevel.x = 100;
    client.character.CurrentLevel.y = 100;
    resetFor(client);
    GlobalState.sessionsByToken.set(client.token, client as never);

    EntityHandler.sendInitialLevelEntities(client as never, 'TutorialDungeon');
    const scope = getClientLevelScope(client as never);
    const canonicalBoss = GlobalState.levelEntities.get(scope)?.get(TutorialDungeonMechanics.TAG_UGO_BOSS_ID);
    assert.ok(canonicalBoss, 'Tag Ugo canonical server boss should be seeded for live-movement regen regression');

    canonicalBoss.hp = 500;
    canonicalBoss.maxHp = 1000;
    canonicalBoss.dead = false;
    canonicalBoss.entState = EntityState.ACTIVE;
    canonicalBoss.deathRegenArmedForPlayerKey = `${client.token}:${client.clientEntID}`;
    canonicalBoss.lastCombatActivityAt = 1;
    canonicalBoss.lastCombatRegenTickAt = 0;
    canonicalBoss.aggroTargetEntityId = client.clientEntID;
    canonicalBoss.aggroTargetToken = client.token;
    canonicalBoss.x = 22695;
    canonicalBoss.y = 2959;

    client.authoritativeCurrentHp = 0;
    client.enemyDeathRegenArmed = true;
    const activePlayerEntity = {
        id: client.clientEntID,
        isPlayer: true,
        roomId: 11,
        x: 22600,
        y: 2950,
        hp: 0,
        maxHp: 1000,
        dead: false,
        entState: EntityState.ACTIVE
    };
    client.entities.set(client.clientEntID, activePlayerEntity);
    GlobalState.levelEntities.get(scope)?.set(client.clientEntID, { ...activePlayerEntity });

    LevelHandler.handleEntityIncrementalUpdate(
        client as never,
        buildEntityActiveIncrementalPayload(client.clientEntID, 10, 0)
    );
    assert.equal(client.authoritativeCurrentHp > 0, true, 'active owner movement did not repair stale zero player HP');

    (CombatHandler as any).processHostileOutOfCombatRegen(scope, canonicalBoss, 60_000);
    assert.equal(canonicalBoss.hp, 500, 'Tag Ugo regenerated while live entity position was in boss aggro');
    assert.equal(
        String(canonicalBoss.deathRegenArmedForPlayerKey ?? ''),
        '',
        'active owner movement should clear stale player-death regen arms'
    );
    assert.equal(canonicalBoss.aggroTargetEntityId, client.clientEntID, 'live player aggro should use scoped entity position, not stale saved coordinates');
}

function testTagUgoDoesNotRegenAfterActiveSelfFullUpdateWithStaleDeadState(): void {
    const client = createFakeClient('SpawnedBossFighter', 61013);
    client.currentRoomId = 11;
    client.character.CurrentLevel.x = 22600;
    client.character.CurrentLevel.y = 2950;
    resetFor(client);
    GlobalState.sessionsByToken.set(client.token, client as never);

    EntityHandler.sendInitialLevelEntities(client as never, 'TutorialDungeon');
    const scope = getClientLevelScope(client as never);
    const canonicalBoss = GlobalState.levelEntities.get(scope)?.get(TutorialDungeonMechanics.TAG_UGO_BOSS_ID);
    assert.ok(canonicalBoss, 'Tag Ugo canonical server boss should be seeded for full-update regen regression');

    canonicalBoss.hp = 500;
    canonicalBoss.maxHp = 1000;
    canonicalBoss.dead = false;
    canonicalBoss.entState = EntityState.ACTIVE;
    canonicalBoss.deathRegenArmedForPlayerKey = `${client.token}:${client.clientEntID}`;
    canonicalBoss.lastCombatActivityAt = 1;
    canonicalBoss.lastCombatRegenTickAt = 0;
    canonicalBoss.aggroTargetEntityId = client.clientEntID;
    canonicalBoss.aggroTargetToken = client.token;
    canonicalBoss.x = 22695;
    canonicalBoss.y = 2959;

    client.authoritativeCurrentHp = 0;
    client.enemyDeathRegenArmed = true;
    const staleDeadPlayerEntity = {
        id: client.clientEntID,
        name: client.character.name,
        isPlayer: true,
        roomId: 11,
        x: 100,
        y: 100,
        hp: 0,
        maxHp: 1000,
        dead: true,
        entState: EntityState.DEAD
    };
    client.entities.set(client.clientEntID, staleDeadPlayerEntity);
    GlobalState.levelEntities.get(scope)?.set(client.clientEntID, { ...staleDeadPlayerEntity });

    EntityHandler.handleEntityFullUpdate(
        client as never,
        buildPlayerFullUpdate(client, 22600, 2950)
    );

    assert.equal(client.authoritativeCurrentHp > 0, true, 'active owner full-update did not repair stale zero player HP');
    assert.equal(client.enemyDeathRegenArmed, false, 'active owner full-update should clear stale player-death regen arm');
    assert.equal(client.entities.get(client.clientEntID)?.dead, false, 'local player entity should be active after owner full-update');
    assert.equal(GlobalState.levelEntities.get(scope)?.get(client.clientEntID)?.dead, false, 'scoped player entity should be active after owner full-update');

    (CombatHandler as any).processHostileOutOfCombatRegen(scope, canonicalBoss, 60_000);
    assert.equal(canonicalBoss.hp, 500, 'Tag Ugo regenerated after an active owner full-update revived the combat presence');
    assert.equal(
        String(canonicalBoss.deathRegenArmedForPlayerKey ?? ''),
        '',
        'active owner full-update should clear stale player-death regen arms'
    );
}

function testTagUgoSeesPlayerAfterCappedSpeedCorrection(): void {
    const client = createFakeClient('CorrectedBossFighter', 61014);
    client.currentRoomId = 11;
    client.character.CurrentLevel.x = 100;
    client.character.CurrentLevel.y = 100;
    resetFor(client);
    GlobalState.sessionsByToken.set(client.token, client as never);

    EntityHandler.sendInitialLevelEntities(client as never, 'TutorialDungeon');
    const scope = getClientLevelScope(client as never);
    const canonicalBoss = GlobalState.levelEntities.get(scope)?.get(TutorialDungeonMechanics.TAG_UGO_BOSS_ID);
    assert.ok(canonicalBoss, 'Tag Ugo canonical server boss should be seeded for capped movement regression');

    canonicalBoss.hp = 500;
    canonicalBoss.maxHp = 1000;
    canonicalBoss.dead = false;
    canonicalBoss.entState = EntityState.ACTIVE;
    canonicalBoss.deathRegenArmedForPlayerKey = `${client.token}:${client.clientEntID}`;
    canonicalBoss.lastCombatActivityAt = 1;
    canonicalBoss.lastCombatRegenTickAt = 0;
    canonicalBoss.aggroTargetEntityId = client.clientEntID;
    canonicalBoss.aggroTargetToken = client.token;
    canonicalBoss.x = 22695;
    canonicalBoss.y = 2959;

    client.authoritativeCurrentHp = 0;
    client.enemyDeathRegenArmed = true;
    const activePlayerEntity = {
        id: client.clientEntID,
        isPlayer: true,
        roomId: 11,
        x: 21450,
        y: 2959,
        hp: 0,
        maxHp: 1000,
        dead: false,
        entState: EntityState.ACTIVE
    };
    client.entities.set(client.clientEntID, activePlayerEntity);
    GlobalState.levelEntities.get(scope)?.set(client.clientEntID, { ...activePlayerEntity });

    const now = Date.now();
    MovementAuthority.reset(client as never, 'stale_visible_client', 21450, 2959, now - 635);
    (client as any).movementAuthority.movementBudgetDistance = 674;
    (client as any).movementAuthority.movementBudgetUpdatedAtMs = now - 635;
    LevelHandler.handleEntityIncrementalUpdate(
        client as never,
        buildEntityActiveIncrementalPayload(client.clientEntID, 1502, 0)
    );

    const correctedPlayer = GlobalState.levelEntities.get(scope)?.get(client.clientEntID);
    assert.equal(
        Math.round(Number(correctedPlayer?.x)) > 21450,
        true,
        'speed correction should advance the authoritative player snapshot to the capped server position'
    );
    assert.equal(packetCount(client, 0x07) > 0, true, 'client should receive a movement correction after capped speed rejection');
    assert.equal(client.authoritativeCurrentHp > 0, true, 'active capped movement should repair stale zero player HP');

    canonicalBoss.x = Math.round(Number(correctedPlayer?.x));
    (CombatHandler as any).processHostileOutOfCombatRegen(scope, canonicalBoss, 60_000);
    assert.equal(canonicalBoss.hp, 500, 'Tag Ugo regenerated after the capped authoritative player position entered aggro');
    assert.equal(
        String(canonicalBoss.deathRegenArmedForPlayerKey ?? ''),
        '',
        'capped active movement should clear stale player-death regen arms'
    );
}

function testTagUgoStillRegensAfterActualPlayerDeath(): void {
    const client = createFakeClient('DeadBossFighter', 61011);
    client.currentRoomId = 11;
    resetFor(client);
    GlobalState.sessionsByToken.set(client.token, client as never);

    EntityHandler.sendInitialLevelEntities(client as never, 'TutorialDungeon');
    const scope = getClientLevelScope(client as never);
    const canonicalBoss = GlobalState.levelEntities.get(scope)?.get(TutorialDungeonMechanics.TAG_UGO_BOSS_ID);
    assert.ok(canonicalBoss, 'Tag Ugo canonical server boss should be seeded for death regen regression');

    canonicalBoss.hp = 500;
    canonicalBoss.maxHp = 1000;
    canonicalBoss.dead = false;
    canonicalBoss.entState = EntityState.ACTIVE;
    canonicalBoss.deathRegenArmedForPlayerKey = `${client.token}:${client.clientEntID}`;
    canonicalBoss.lastCombatActivityAt = 1;
    canonicalBoss.lastCombatRegenTickAt = 0;
    canonicalBoss.aggroTargetEntityId = client.clientEntID;
    canonicalBoss.aggroTargetToken = client.token;
    canonicalBoss.x = 22695;
    canonicalBoss.y = 2959;

    client.authoritativeCurrentHp = 0;
    client.enemyDeathRegenArmed = true;
    const deadPlayerEntity = {
        id: client.clientEntID,
        isPlayer: true,
        roomId: 11,
        x: 22600,
        y: 2950,
        hp: 0,
        maxHp: 1000,
        dead: true,
        entState: EntityState.DEAD
    };
    client.entities.set(client.clientEntID, deadPlayerEntity);
    GlobalState.levelEntities.get(scope)?.set(client.clientEntID, { ...deadPlayerEntity });

    (CombatHandler as any).processHostileOutOfCombatRegen(scope, canonicalBoss, 60_000);
    assert.equal(canonicalBoss.hp > 500, true, 'Tag Ugo should still regen after an actual player death');
}

async function testBossDefeatWaitsForDefeatCutscene(): Promise<void> {
    const client = createFakeClient('KidnapperRunner', 61001);
    resetFor(client);
    GlobalState.sessionsByToken.set(client.token, client as never);

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, bossEntity());

    const state = TutorialDungeonMechanics.getClientState(client as never);
    assert.equal(state?.bossDefeated, true, 'Tag Ugo should be recorded as defeated');
    assert.equal(state?.annaFreed, false, 'Anna rescue should still be incomplete');
    assert.equal(client.pendingDungeonCompletionScope, '', 'boss defeat must wait in shared cutscene state');
    assert.equal(packetCount(client, 0x87), 0, 'boss defeat must not emit rank result before the defeat cutscene');
}

async function testLateAnnaChainCannotDeadlockBossCompletion(): Promise<void> {
    const client = createFakeClient('AnnaRescuer', 61002);
    resetFor(client);
    GlobalState.sessionsByToken.set(client.token, client as never);

    const scope = getClientLevelScope(client as never);
    await MissionHandler.handleForcedDungeonBossCompletion(client as never, bossEntity());
    MissionHandler.noteDungeonCutsceneStart(client as never, 11);
    const beforeCutsceneEnd = DungeonCompletionSystem.evaluate(scope);
    assert.equal(beforeCutsceneEnd.ready, false, 'boss completion must not bypass the active end cutscene');
    assert.equal(beforeCutsceneEnd.reason, 'objectives_pending');
    assert.equal(packetCount(client, 0x87), 0, 'rank result must remain hidden until the end cutscene finishes');

    MissionHandler.noteDungeonCutsceneEnd(client as never, 11);
    await sleep(5);

    assert.equal(DungeonCompletionSystem.evaluate(scope).objectivesMet, false);
    assert.equal(packetCount(client, 0x87), 0, 'missing Anna chain objective must keep completion pending');

    await MissionHandler.handleForcedDungeonObjectiveCompletion(client as never, annaChainEntity());
    await settleScheduledCompletion(client);
    assert.equal(DungeonCompletionSystem.evaluate(scope).objectivesMet, true);
    assert.equal(packetCount(client, 0x87), 1, 'late chain state must complete once without deadlocking or duplicating');
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
    shareParty(61300, playerOne, playerTwo);
    EntityHandler.sendInitialLevelEntities(playerOne as never, 'TutorialDungeon');
    EntityHandler.handleEntityFullUpdate(playerOne as never, buildHostileFullUpdate(TutorialDungeonMechanics.TAG_UGO_BOSS_ID, 'GoblinBoss1', 11));
    EntityHandler.handleEntityFullUpdate(playerTwo as never, buildHostileFullUpdate(TutorialDungeonMechanics.TAG_UGO_BOSS_ID, 'GoblinBoss1', 11));

    const scope = getClientLevelScope(playerOne as never);
    const canonicalBoss = GlobalState.levelEntities.get(scope)?.get(TutorialDungeonMechanics.TAG_UGO_BOSS_ID);
    assert.ok(canonicalBoss);
    const initialHp = Number(canonicalBoss.hp);
    const maxHp = Number(canonicalBoss.maxHp);
    playerOne.sentPackets.length = 0;
    playerTwo.sentPackets.length = 0;
    await CombatHandler.handlePowerCast(playerOne as never, buildPowerCastPayload(playerOne.clientEntID));
    const hit = buildPowerHitPayload(TutorialDungeonMechanics.TAG_UGO_BOSS_ID, playerOne.clientEntID, 100);
    await CombatHandler.handlePowerHit(playerOne as never, hit);
    assert.equal(Number(canonicalBoss.hp), initialHp - 100);
    assert.equal(playerOne.entities.get(TutorialDungeonMechanics.TAG_UGO_BOSS_ID)?.hp, canonicalBoss.hp);
    assert.equal(playerTwo.entities.get(TutorialDungeonMechanics.TAG_UGO_BOSS_ID)?.hp, canonicalBoss.hp);
    const playerOneHpDeltas = hpDeltasFor(playerOne, TutorialDungeonMechanics.TAG_UGO_BOSS_ID);
    const playerTwoHpDeltas = hpDeltasFor(playerTwo, TutorialDungeonMechanics.TAG_UGO_BOSS_ID);
    assert.equal(
        playerOneHpDeltas.some((delta) => delta >= maxHp),
        false,
        'attacker should not receive a visible Tag Ugo refill before the authoritative damage correction'
    );
    assert.equal(
        playerOneHpDeltas.some((delta) => delta === -100),
        true,
        'attacker should receive a visible Tag Ugo damage correction after the first hit'
    );
    assert.equal(
        playerTwoHpDeltas.some((delta) => delta >= maxHp),
        false,
        'peer should not receive a visible Tag Ugo refill before the authoritative damage correction'
    );
    assert.equal(
        playerTwoHpDeltas.some((delta) => delta === -100),
        true,
        'peer should receive a visible Tag Ugo damage correction after the first hit'
    );
    const hpAfterFirstHit = Number(canonicalBoss.hp);
    await CombatHandler.handlePowerHit(playerOne as never, hit);
    assert.equal(Number(canonicalBoss.hp), hpAfterFirstHit, 'replayed hit from the same cast must be ignored');

    const playerTwoLootBeforeBossKill = playerTwo.pendingLoot.size;
    const playerOneLootBeforeBossKill = playerOne.pendingLoot.size;
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
    assert.ok(
        playerTwo.pendingLoot.size > playerTwoLootBeforeBossKill,
        'Tag Ugo death should grant boss loot to the killing player'
    );
    assert.ok(
        playerOne.pendingLoot.size > playerOneLootBeforeBossKill,
        'Tag Ugo death should grant boss loot to eligible party members in the same dungeon'
    );
    const playerTwoBossLoot = Array.from(playerTwo.pendingLoot.values());
    const playerOneBossLoot = Array.from(playerOne.pendingLoot.values());
    assert.ok(playerTwoBossLoot.some((reward: any) => Number(reward.gold ?? 0) > 0), 'Tag Ugo should drop gold');
    assert.ok(playerTwoBossLoot.some((reward: any) => Number(reward.health ?? 0) > 0), 'Tag Ugo should drop health');
    assert.ok(playerTwoBossLoot.some((reward: any) => Number(reward.material ?? 0) > 0), 'Tag Ugo should drop material');
    assert.ok(playerTwoBossLoot.some((reward: any) => Number(reward.gear ?? 0) > 0), 'Tag Ugo should drop gear');
    assert.ok(playerOneBossLoot.some((reward: any) => Number(reward.gold ?? 0) > 0), 'Tag Ugo should drop party-member gold');
    assert.ok(playerOneBossLoot.some((reward: any) => Number(reward.health ?? 0) > 0), 'Tag Ugo should drop party-member health');
    assert.ok(playerOneBossLoot.some((reward: any) => Number(reward.material ?? 0) > 0), 'Tag Ugo should drop party-member material');
    assert.ok(playerOneBossLoot.some((reward: any) => Number(reward.gear ?? 0) > 0), 'Tag Ugo should drop party-member gear');
    const playerTwoLootAfterBossKill = playerTwo.pendingLoot.size;
    const playerOneLootAfterBossKill = playerOne.pendingLoot.size;

    (playerOne as any).authoritativeCurrentHp = 0;
    (CombatHandler as any).armBossRegenForPlayerDeath(playerOne, Date.now(), true);
    (CombatHandler as any).processHostileOutOfCombatRegen(scope, canonicalBoss, Date.now() + 60_000);
    assert.equal(canonicalBoss.hp, 0, 'terminal Tag Ugo regenerated after a player death');
    assert.equal(canonicalBoss.dead, true, 'terminal Tag Ugo returned to an active state');
    assert.equal(
        String(canonicalBoss.deathRegenArmedForPlayerKey ?? ''),
        '',
        'terminal Tag Ugo kept a player-death regen arm'
    );

    const lateJoiner = createFakeClient('BossLateJoiner', 61303);
    lateJoiner.currentRoomId = 11;
    lateJoiner.levelInstanceId = playerOne.levelInstanceId;
    GlobalState.sessionsByToken.set(lateJoiner.token, lateJoiner as never);
    EntityHandler.handleEntityFullUpdate(lateJoiner as never, buildHostileFullUpdate(TutorialDungeonMechanics.TAG_UGO_BOSS_ID, 'GoblinBoss1', 11));
    assert.equal(packetCount(lateJoiner, 0x0D), 1, 'late joiner must receive the Tag Ugo tombstone');
    await MissionHandler.handleForcedDungeonBossCompletion(playerTwo as never, bossEntity());
    assert.equal(playerTwo.pendingLoot.size, playerTwoLootAfterBossKill, 'replayed Tag Ugo completion must not duplicate boss loot');
    assert.equal(playerOne.pendingLoot.size, playerOneLootAfterBossKill, 'replayed Tag Ugo completion must not duplicate party-member boss loot');
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
    await Promise.all([
        settleScheduledCompletion(playerOne),
        settleScheduledCompletion(playerTwo)
    ]);

    assert.equal(packetCount(playerOne, 0x87), 1, 'player one should receive one rank result');
    assert.equal(packetCount(playerTwo, 0x87), 1, 'player two should receive one rank result');
    assert.deepEqual(
        dungeonResultStars(playerOne),
        [10],
        'a fully completed Goblin Kidnappers run should award all five full stars'
    );
    assert.deepEqual(
        dungeonResultStars(playerTwo),
        [10],
        'each eligible participant should receive all five full stars after the authoritative full clear'
    );
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

// Dread Goblin Hideout is not server-authoritative, so Tag Ugo's visual is the
// client's own cue. When a second cue for the same encounter arrived, the server
// aliased it to the canonical but kept it as an extra local visual. That copy
// gets no AI and no health updates, so it stands still and holds every debuff
// forever — the second Tag Ugo in the boss scene. The owner of the canonical
// already renders it, so the stray must be destroyed on their client instead.
function testDreadTagUgoStrayCueIsDestroyedForItsOwner(): void {
    const client = createFakeClient('DreadTagUgoSolo', 61041);
    client.currentLevel = 'TutorialDungeonHard';
    client.character.CurrentLevel.name = 'TutorialDungeonHard';
    client.levelInstanceId = 'dread-tag-ugo-duplicate';
    client.currentRoomId = 11;
    resetFor(client);
    GlobalState.sessionsByToken.set(client.token, client as never);

    const scope = getClientLevelScope(client as never);
    const canonicalId = 4_500_001;
    const strayId = 4_500_002;
    const canonical = {
        id: canonicalId,
        name: 'GoblinBoss1Hard',
        team: EntityTeam.ENEMY,
        isPlayer: false,
        roomId: 11,
        x: 1500,
        y: 900,
        hp: 1000,
        maxHp: 1000,
        dead: false,
        entState: EntityState.ACTIVE,
        clientSpawned: false,
        hybridCanonicalHostile: true,
        ownerToken: client.token,
        ownerPartyId: 0,
        spawnKey: 'GoblinBoss1Hard:11:15:9'
    };
    GlobalState.levelEntities.set(scope, new Map([[canonicalId, canonical]]));

    client.sentPackets.length = 0;
    const suppressed = (EntityHandler as any).suppressDuplicateSharedClientSpawn(
        client,
        'TutorialDungeonHard',
        GlobalState.levelEntities.get(scope),
        {
            id: strayId,
            name: 'GoblinBoss1Hard',
            team: EntityTeam.ENEMY,
            isPlayer: false,
            roomId: 11,
            x: 1500,
            y: 900,
            hp: 1000,
            maxHp: 1000,
            dead: false,
            entState: EntityState.ACTIVE,
            clientSpawned: true
        }
    );

    assert.equal(suppressed, true, 'the stray Tag Ugo cue was not recognised as a duplicate');
    assert.equal(
        client.entities.has(strayId),
        false,
        'the motionless Tag Ugo visual was kept as a second local entity'
    );
    assert.equal(
        packetCount(client, 0x0D),
        1,
        'the owner was never told to destroy the stray Tag Ugo visual'
    );
    assert.equal(
        client.entityIdAliases.get(strayId),
        canonicalId,
        'damage sent under the stray Tag Ugo id would no longer reach the boss'
    );

    GlobalState.sessionsByToken.delete(client.token);
    GlobalState.levelEntities.delete(scope);
}

// Anna's chains are freed by a dialogue trigger, and the line arrives from the
// client. A Turkish client sends "Kasabaya geri donelim.", so matching only the
// English source left the Dread run's anna_freed objective permanently unmet:
// the boss died and the dungeon never finished.
function testAnnaReturnLineIsAcceptedInEveryLocale(): void {
    DialogueTranslationLoader.load(path.resolve(__dirname, '../data'));
    const englishLine = "Let's head back to town.";
    const turkishLine = DialogueTranslationLoader.translateText(englishLine, 'tr');
    assert.notEqual(
        turkishLine,
        englishLine,
        'the Turkish Anna return line is missing, so this regression cannot prove anything'
    );

    const isAnnaLine = (LevelHandler as any).isAnnaReturnToTownLine.bind(LevelHandler);
    assert.equal(isAnnaLine(englishLine), true, 'the English Anna return line stopped matching');
    assert.equal(isAnnaLine(turkishLine), true, 'a localized client could not finish Goblin Kidnappers');
    assert.equal(isAnnaLine('Some other line entirely.'), false, 'an unrelated line triggered dungeon completion');
}

// Dread Goblin Hideout is built from a_Level_GoblinBeachHard, which contains no
// NPCAnna and no Chains03 — there is no rescue and no tutorial in the Dread run.
// Giving it an anna_freed objective made the dungeon permanently uncompletable:
// the boss died and the rank screen never came.
function testDreadGoblinHideoutHasNoRescueObjective(): void {
    const condition = DungeonCompletionConditions.get('TutorialDungeonHard');
    assert.ok(condition, 'TutorialDungeonHard lost its completion condition');
    assert.deepEqual(
        condition.bossGroups,
        [['GoblinBoss1Hard']],
        'Dread Goblin Hideout must complete on its boss alone'
    );
    assert.equal(
        condition.entityObjectives ?? undefined,
        undefined,
        'Dread Goblin Hideout has no Anna and no chains, so it cannot gate on an entity objective'
    );

    // The normal dungeon does have the rescue and must keep gating on it.
    assert.equal(
        (DungeonCompletionConditions.get('TutorialDungeon')?.entityObjectives ?? []).some(
            (objective: { role: string }) => objective.role === 'anna_freed'
        ),
        true,
        'the normal Goblin Kidnappers rescue objective was lost'
    );
}

// The real Tag Ugo dies and the rank plate opens, but a second Tag Ugo stays on
// screen holding every debuff it was hit with — nothing drives or removes it.
// A dungeon authors exactly one of each required boss, so once the real one is
// down any same-named leftover is stale and must be taken off every screen.
async function testStaleTagUgoDuplicateIsRemovedOnBossDeath(): Promise<void> {
    const client = createFakeClient('DreadTagUgoLeftover', 61042);
    client.currentLevel = 'TutorialDungeonHard';
    client.character.CurrentLevel.name = 'TutorialDungeonHard';
    client.levelInstanceId = 'dread-tag-ugo-leftover';
    client.currentRoomId = 11;
    resetFor(client);
    GlobalState.sessionsByToken.set(client.token, client as never);

    const scope = getClientLevelScope(client as never);
    const realBossId = 4_600_001;
    const leftoverId = 4_600_002;
    const makeBoss = (id: number, dead: boolean): any => ({
        id,
        name: 'GoblinBoss1Hard',
        EntName: 'GoblinBoss1Hard',
        team: EntityTeam.ENEMY,
        isPlayer: false,
        roomId: 11,
        hp: dead ? 0 : 500,
        maxHp: 1000,
        dead,
        destroyed: dead,
        entState: dead ? EntityState.DEAD : EntityState.ACTIVE
    });
    const realBoss = makeBoss(realBossId, true);
    const leftover = makeBoss(leftoverId, false);
    GlobalState.levelEntities.set(scope, new Map([[realBossId, realBoss], [leftoverId, leftover]]));
    client.entities.set(leftoverId, leftover);
    client.knownEntityIds.add(leftoverId);
    client.sentPackets.length = 0;

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, realBoss);

    assert.equal(
        GlobalState.levelEntities.get(scope)?.has(leftoverId),
        false,
        'the stale Tag Ugo duplicate stayed in the shared dungeon state'
    );
    assert.equal(
        GlobalState.levelEntities.get(scope)?.has(realBossId),
        true,
        'the real Tag Ugo was removed instead of the duplicate'
    );
    assert.equal(
        client.entities.has(leftoverId),
        false,
        'the duplicate Tag Ugo visual was left on the player screen'
    );
    assert.equal(
        packetCount(client, 0x0D) > 0,
        true,
        'no destroy packet was sent for the leftover Tag Ugo'
    );

    GlobalState.sessionsByToken.delete(client.token);
    GlobalState.levelEntities.delete(scope);
}

// Clearing the copy on boss death left it standing through the entire fight. The
// client's boss-room packet names the entity its own BossFight drives, so that id
// is the authoritative real boss and the sweep can run as the scene opens.
function testDuplicateTagUgoIsClearedWhenTheBossSceneOpens(): void {
    const client = createFakeClient('DreadTagUgoScene', 61044);
    client.currentLevel = 'TutorialDungeonHard';
    client.character.CurrentLevel.name = 'TutorialDungeonHard';
    client.levelInstanceId = 'dread-tag-ugo-scene';
    client.currentRoomId = 11;
    resetFor(client);
    GlobalState.sessionsByToken.set(client.token, client as never);

    const scope = getClientLevelScope(client as never);
    const realBossId = 4_800_001;
    const duplicateId = 4_800_002;
    const makeBoss = (id: number): any => ({
        id,
        name: 'GoblinBoss1Hard',
        EntName: 'GoblinBoss1Hard',
        team: EntityTeam.ENEMY,
        isPlayer: false,
        roomId: 11,
        hp: 1000,
        maxHp: 1000,
        dead: false,
        destroyed: false,
        entState: EntityState.ACTIVE
    });
    const duplicate = makeBoss(duplicateId);
    GlobalState.levelEntities.set(scope, new Map([
        [realBossId, makeBoss(realBossId)],
        [duplicateId, duplicate]
    ]));
    client.entities.set(duplicateId, duplicate);
    client.knownEntityIds.add(duplicateId);
    client.sentPackets.length = 0;

    MissionHandler.removeDuplicateBossEntities(scope, 'TutorialDungeonHard', 'GoblinBoss1Hard', realBossId);

    assert.equal(
        GlobalState.levelEntities.get(scope)?.has(duplicateId),
        false,
        'the duplicate Tag Ugo survived the boss-scene sweep'
    );
    assert.equal(
        GlobalState.levelEntities.get(scope)?.has(realBossId),
        true,
        'the sweep removed the boss the client is actually fighting'
    );
    assert.equal(client.entities.has(duplicateId), false, 'the duplicate kept its local visual');
    assert.equal(packetCount(client, 0x0D) > 0, true, 'no destroy packet was sent for the duplicate');

    // An unknown marker id must never trigger deletions: without a trustworthy
    // anchor the sweep would be free to remove the real boss.
    const survivorScope = `${scope}-anchorless`;
    const survivor = makeBoss(4_800_003);
    GlobalState.levelEntities.set(survivorScope, new Map([[survivor.id, survivor]]));
    MissionHandler.removeDuplicateBossEntities(survivorScope, 'TutorialDungeonHard', 'GoblinBoss1Hard', 999_999);
    assert.equal(
        GlobalState.levelEntities.get(survivorScope)?.size,
        1,
        'an unanchored sweep deleted a boss'
    );

    GlobalState.sessionsByToken.delete(client.token);
    GlobalState.levelEntities.delete(scope);
    GlobalState.levelEntities.delete(survivorScope);
}

// The copy registers after BossFight has already announced the encounter, so the
// scene-open sweep never sees it and it stood in the boss scene until the boss
// died. Once the room boss is marked, a later cue for that same boss must be
// retired on arrival.
function testLateDuplicateTagUgoIsRetiredOnArrival(): void {
    const client = createFakeClient('DreadTagUgoLate', 61045);
    client.currentLevel = 'TutorialDungeonHard';
    client.character.CurrentLevel.name = 'TutorialDungeonHard';
    client.levelInstanceId = 'dread-tag-ugo-late';
    client.currentRoomId = 11;
    resetFor(client);
    GlobalState.sessionsByToken.set(client.token, client as never);

    const scope = getClientLevelScope(client as never);
    const realBossId = 4_900_001;
    const lateId = 4_900_002;
    const makeBoss = (id: number): any => ({
        id,
        name: 'GoblinBoss1Hard',
        EntName: 'GoblinBoss1Hard',
        team: EntityTeam.ENEMY,
        isPlayer: false,
        roomId: 11,
        hp: 1000,
        maxHp: 1000,
        dead: false,
        entState: EntityState.ACTIVE
    });
    const levelMap = new Map<number, any>([[realBossId, makeBoss(realBossId)]]);
    GlobalState.levelEntities.set(scope, levelMap);
    // BossFight has already named the entity it drives.
    markRoomBossEntity(scope, realBossId, 11, 'Tag Ugo');
    client.sentPackets.length = 0;

    const suppressed = (EntityHandler as any).suppressLateDuplicateRoomBossSpawn(
        client,
        'TutorialDungeonHard',
        levelMap,
        makeBoss(lateId),
        lateId
    );

    assert.equal(suppressed, true, 'a late Tag Ugo cue was allowed into the boss scene');
    assert.equal(client.entities.has(lateId), false, 'the late Tag Ugo kept a local visual');
    assert.equal(packetCount(client, 0x0D) > 0, true, 'the late Tag Ugo was never destroyed on the client');
    assert.equal(
        client.entityIdAliases.get(lateId),
        realBossId,
        'damage sent under the late id would not reach the real boss'
    );

    // Without a marked room boss there is no authoritative anchor, so nothing may
    // be retired — otherwise the first cue of a normal encounter would vanish.
    const anchorlessScope = `${scope}-anchorless`;
    const anchorlessMap = new Map<number, any>([[4_900_003, makeBoss(4_900_003)]]);
    GlobalState.levelEntities.set(anchorlessScope, anchorlessMap);
    const previousInstance = client.levelInstanceId;
    client.levelInstanceId = `${previousInstance}-anchorless`;
    assert.equal(
        (EntityHandler as any).suppressLateDuplicateRoomBossSpawn(
            client,
            'TutorialDungeonHard',
            anchorlessMap,
            makeBoss(4_900_004),
            4_900_004
        ),
        false,
        'a cue was retired with no marked room boss to anchor on'
    );
    client.levelInstanceId = previousInstance;

    GlobalState.sessionsByToken.delete(client.token);
    GlobalState.levelEntities.delete(scope);
    GlobalState.levelEntities.delete(anchorlessScope);
}

// The reported failure: in Dread Goblin Hideout the id BossFight announces does
// not resolve to a shared entity at all, so every anchor-based sweep bailed out
// silently and the motionless copy stood through the whole scene, disappearing
// only when the rank plate tore the level down. One visual per viewer is the rule
// that still holds without an anchor, so the sweep must enforce that on its own.
function testBossSceneSweepLeavesOneVisualPerViewerWithoutASharedAnchor(): void {
    const client = createFakeClient('DreadTagUgoUnanchored', 61046);
    client.currentLevel = 'TutorialDungeonHard';
    client.character.CurrentLevel.name = 'TutorialDungeonHard';
    client.levelInstanceId = 'dread-tag-ugo-unanchored';
    client.currentRoomId = 11;
    resetFor(client);
    GlobalState.sessionsByToken.set(client.token, client as never);

    const scope = getClientLevelScope(client as never);
    const announcedBossId = 5_100_001;
    const copyId = 5_100_002;
    const makeBoss = (id: number): any => ({
        id,
        name: 'GoblinBoss1Hard',
        EntName: 'GoblinBoss1Hard',
        team: EntityTeam.ENEMY,
        isPlayer: false,
        roomId: 11,
        hp: 1000,
        maxHp: 1000,
        dead: false,
        entState: EntityState.ACTIVE,
        clientSpawned: true
    });

    // The client drives both cues locally; the shared map never saw either of
    // them, which is exactly why the anchored sweeps could not act.
    GlobalState.levelEntities.set(scope, new Map());
    client.entities.set(announcedBossId, makeBoss(announcedBossId));
    client.entities.set(copyId, makeBoss(copyId));
    client.knownEntityIds.add(announcedBossId);
    client.knownEntityIds.add(copyId);
    client.sentPackets.length = 0;

    MissionHandler.sweepBossSceneDuplicates(scope, 'TutorialDungeonHard', announcedBossId, 'test');

    assert.equal(
        client.entities.has(announcedBossId),
        true,
        'the sweep destroyed the Tag Ugo the client is actually fighting'
    );
    assert.equal(
        client.entities.has(copyId),
        false,
        'the motionless Tag Ugo copy survived the scene-entry sweep'
    );
    assert.equal(packetCount(client, 0x0D) > 0, true, 'the copy was never destroyed on the client');
    assert.equal(
        client.entityIdAliases.get(copyId),
        announcedBossId,
        'damage sent under the copy id would no longer reach the boss'
    );

    // A viewer with a single visual must never be swept to zero: a party member's
    // local copy is the only boss they can see.
    const soloClient = createFakeClient('DreadTagUgoSoleVisual', 61047);
    soloClient.currentLevel = 'TutorialDungeonHard';
    soloClient.character.CurrentLevel.name = 'TutorialDungeonHard';
    soloClient.levelInstanceId = 'dread-tag-ugo-sole-visual';
    soloClient.currentRoomId = 11;
    resetFor(soloClient);
    GlobalState.sessionsByToken.set(soloClient.token, soloClient as never);
    const soloScope = getClientLevelScope(soloClient as never);
    const soloVisualId = 5_100_003;
    GlobalState.levelEntities.set(soloScope, new Map());
    soloClient.entities.set(soloVisualId, makeBoss(soloVisualId));
    soloClient.sentPackets.length = 0;

    MissionHandler.sweepBossSceneDuplicates(soloScope, 'TutorialDungeonHard', 9_999_999, 'test');
    assert.equal(
        soloClient.entities.has(soloVisualId),
        true,
        'the sweep left a party member with no boss to fight'
    );

    GlobalState.sessionsByToken.delete(client.token);
    GlobalState.sessionsByToken.delete(soloClient.token);
    GlobalState.levelEntities.delete(scope);
    GlobalState.levelEntities.delete(soloScope);
}

// Same failure seen from the arrival side: the copy registers after BossFight has
// opened the scene, and with no shared marker to anchor on it used to be accepted
// as a second local visual. While a scene is open, a client that already holds a
// boss visual must not be given another one.
function testSecondLocalBossVisualIsRetiredWhileTheSceneIsOpen(): void {
    const client = createFakeClient('DreadTagUgoSecondVisual', 61048);
    client.currentLevel = 'TutorialDungeonHard';
    client.character.CurrentLevel.name = 'TutorialDungeonHard';
    client.levelInstanceId = 'dread-tag-ugo-second-visual';
    client.currentRoomId = 11;
    resetFor(client);
    GlobalState.sessionsByToken.set(client.token, client as never);

    const scope = getClientLevelScope(client as never);
    const announcedBossId = 5_200_001;
    const copyId = 5_200_002;
    const makeBoss = (id: number): any => ({
        id,
        name: 'GoblinBoss1Hard',
        EntName: 'GoblinBoss1Hard',
        team: EntityTeam.ENEMY,
        isPlayer: false,
        roomId: 11,
        hp: 1000,
        maxHp: 1000,
        dead: false,
        entState: EntityState.ACTIVE,
        clientSpawned: true
    });
    const levelMap = new Map<number, any>();
    GlobalState.levelEntities.set(scope, levelMap);
    client.entities.set(announcedBossId, makeBoss(announcedBossId));
    client.sentPackets.length = 0;

    // No shared entity is ever marked here — only the announcement is recorded.
    noteBossSceneOpened(scope, 11, announcedBossId, 'Tag Ugo');

    const suppressed = (EntityHandler as any).suppressLateDuplicateRoomBossSpawn(
        client,
        'TutorialDungeonHard',
        levelMap,
        makeBoss(copyId),
        copyId
    );

    assert.equal(suppressed, true, 'a second Tag Ugo visual was accepted while the boss scene was open');
    assert.equal(client.entities.has(copyId), false, 'the second Tag Ugo kept a local visual');
    assert.equal(
        client.entityIdAliases.get(copyId),
        announcedBossId,
        'damage sent under the second id would not reach the real boss'
    );

    // The very entity BossFight announced must always be allowed through.
    assert.equal(
        (EntityHandler as any).suppressLateDuplicateRoomBossSpawn(
            client,
            'TutorialDungeonHard',
            levelMap,
            makeBoss(announcedBossId),
            announcedBossId
        ),
        false,
        'the announced Tag Ugo was retired as if it were a copy'
    );

    // A client with no boss visual yet must receive the cue, or a party member
    // joining the scene late would have nothing to fight.
    const joiner = createFakeClient('DreadTagUgoJoiner', 61049);
    joiner.currentLevel = 'TutorialDungeonHard';
    joiner.character.CurrentLevel.name = 'TutorialDungeonHard';
    joiner.levelInstanceId = 'dread-tag-ugo-second-visual';
    joiner.currentRoomId = 11;
    resetFor(joiner);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);
    assert.equal(
        (EntityHandler as any).suppressLateDuplicateRoomBossSpawn(
            joiner,
            'TutorialDungeonHard',
            levelMap,
            makeBoss(5_200_003),
            5_200_003
        ),
        false,
        'a joiner was denied their only Tag Ugo visual'
    );

    clearOpenBossScene(scope);
    GlobalState.sessionsByToken.delete(client.token);
    GlobalState.sessionsByToken.delete(joiner.token);
    GlobalState.levelEntities.delete(scope);
}

// The rank plate must follow the dialogue, not a timer. A run that is already
// ready when its ending skit closes has no cutscene gate left to release, so
// releaseEndingGateOnMismatchedRoomClose used to bail out on the very first
// check and do nothing at all — the plate then waited out whatever settle window
// the boss death had armed, which the player sees as several seconds of standing
// in a finished dungeon. Dread clients book these closes against odd room ids
// often enough that this is the common path.
async function testReadyRunPlatesImmediatelyOnAMismatchedRoomClose(): Promise<void> {
    const client = createFakeClient('ReadyRunMismatchedClose', 61050);
    resetFor(client);
    GlobalState.sessionsByToken.set(client.token, client as never);
    const scope = getClientLevelScope(client as never);

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, bossEntity());
    MissionHandler.noteDungeonCutsceneStart(client as never, 11);
    await MissionHandler.handleForcedDungeonObjectiveCompletion(client as never, annaChainEntity());
    DungeonCompletionSystem.noteClientCompletionSignal(
        scope,
        DungeonCompletionSystem.getParticipantKey(client as never),
        100
    );
    MissionHandler.noteDungeonCutsceneEnd(client as never, 11);
    await settleScheduledCompletion(client);
    assert.equal(packetCount(client, 0x87), 1, 'the harness run should have produced a rank result');

    // Second run: the ending skit closes against a different room than the one
    // the client is booked into, on a run that is already ready.
    const mismatched = createFakeClient('ReadyRunMismatchedCloseTwo', 61051);
    resetFor(mismatched);
    GlobalState.sessionsByToken.set(mismatched.token, mismatched as never);
    const mismatchedScope = getClientLevelScope(mismatched as never);

    await MissionHandler.handleForcedDungeonBossCompletion(mismatched as never, bossEntity());
    MissionHandler.noteDungeonCutsceneStart(mismatched as never, 11);
    await MissionHandler.handleForcedDungeonObjectiveCompletion(mismatched as never, annaChainEntity());
    DungeonCompletionSystem.noteClientCompletionSignal(
        mismatchedScope,
        DungeonCompletionSystem.getParticipantKey(mismatched as never),
        100
    );
    // The ending cutscene is what the run is waiting on, so it is not ready yet:
    // the close is the event that makes it ready, which is exactly why the close
    // must plate rather than hand the run to a settle timer.
    const beforeClose = DungeonCompletionSystem.evaluate(mismatchedScope);
    assert.equal(beforeClose.ready, false, 'the run should still be waiting on its ending cutscene');
    assert.equal(beforeClose.objectivesMet, true, 'the objectives should already be met before the close');
    assert.equal(beforeClose.reason, 'cutscene_gate_pending', `unexpected pre-close reason ${beforeClose.reason}`);
    assert.equal(packetCount(mismatched, 0x87), 0, 'the plate must not have been sent before the close');

    mismatched.activeDungeonCutsceneScope = mismatchedScope;
    mismatched.activeDungeonCutsceneRoomId = 11;
    MissionHandler.noteDungeonCutsceneEnd(mismatched as never, 97);

    // No settleScheduledCompletion: the close itself has to plate. Only the
    // inline dispatch's own microtask is awaited.
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(
        packetCount(mismatched, 0x87),
        1,
        'a mismatched-room close on a ready run left the rank plate waiting on a timer'
    );

    GlobalState.sessionsByToken.delete(client.token);
    GlobalState.sessionsByToken.delete(mismatched.token);
}

async function main(): Promise<void> {
    ensureDataLoaded();
    await testReadyRunPlatesImmediatelyOnAMismatchedRoomClose();
    testAnnaReturnLineIsAcceptedInEveryLocale();
    testDreadGoblinHideoutHasNoRescueObjective();
    testDuplicateTagUgoIsClearedWhenTheBossSceneOpens();
    testLateDuplicateTagUgoIsRetiredOnArrival();
    testBossSceneSweepLeavesOneVisualPerViewerWithoutASharedAnchor();
    testSecondLocalBossVisualIsRetiredWhileTheSceneIsOpen();
    await testStaleTagUgoDuplicateIsRemovedOnBossDeath();
    testOnlyTagUgoIsServerSpawned();
    testTagUgoUsesCanonicalServerStatsAndHpSync();
    testTagUgoUsesOneClientVisualBackedByCanonicalServerBoss();
    await testTagUgoDamageSyncDoesNotRefillVisibleBossBar();
    testTagUgoDoesNotRegenWhenPlayerRevivedWithStaleZeroHp();
    testTagUgoDoesNotRegenAfterActiveMovementWithStaleSavedPositionAndZeroHp();
    testTagUgoSeesPlayerAfterCappedSpeedCorrection();
    testTagUgoDoesNotRegenAfterActiveSelfFullUpdateWithStaleDeadState();
    testTagUgoStillRegensAfterActualPlayerDeath();
    testPartyLeaderSideEnemiesRemainClientPrivate();
    testDreadTagUgoStrayCueIsDestroyedForItsOwner();
    await testBossDefeatWaitsForDefeatCutscene();
    await testLateAnnaChainCannotDeadlockBossCompletion();
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
