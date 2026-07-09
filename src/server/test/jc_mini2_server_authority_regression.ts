import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { Entity, EntityState, EntityTeam } from '../core/Entity';
import { NpcLoader } from '../data/NpcLoader';
import { EntityHandler } from '../handlers/EntityHandler';
import { CombatHandler } from '../handlers/CombatHandler';
import { LevelHandler } from '../handlers/LevelHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { getSharedDungeonProgressTotals } from '../core/SharedDungeonProgress';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { getLevelScopeKey } from '../core/LevelScope';

// The East Wing (Valhaven / JadeCity JC_Mini2) boss "Tanja, The 2nd Daughter"
// must be a server-authoritative entity shared by the whole party, mirroring
// the JC_Mini1Hard (West Wing) authority model.

const TANJA_CANONICAL_ID = 920004;
const TANJA_HARD_CANONICAL_ID = 925004;
const TANJA_BOSS_NAME = 'Tanja, The 2nd Daughter';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    character: { name: string; level: number; class?: string; MasterClass?: number; CurrentLevel?: { name: string; x: number; y: number } };
    currentLevel: string;
    levelInstanceId: string;
    syncAnchorStartedAt: number;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    userId: number;
    authoritativeMaxHp: number;
    authoritativeCurrentHp: number;
    processedRewardSources: Set<string>;
    pendingLoot: Map<number, any>;
    knownEntityIds: Set<number>;
    entityIdAliases: Map<number, number>;
    sharedEntityRemoteUpdateDeferredIds: Set<number>;
    startedRoomEvents: Set<string>;
    entities: Map<number, any>;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('JC_Mini2')) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
    if (NpcLoader.getRawNpcsForLevel('JC_Mini2').length === 0) {
        NpcLoader.load(dataDir);
    }
}

function createFakeClient(name: string, levelName: string, instanceId: string, token: number, roomId: number): FakeClient {
    const sentPackets: SentPacket[] = [];
    return {
        token,
        character: {
            name,
            level: 50,
            class: 'mage',
            MasterClass: 0,
            CurrentLevel: { name: levelName, x: 100, y: 200 }
        },
        currentLevel: levelName,
        levelInstanceId: instanceId,
        syncAnchorStartedAt: token,
        currentRoomId: roomId,
        playerSpawned: true,
        clientEntID: token + 1000,
        userId: token,
        authoritativeMaxHp: 5000,
        authoritativeCurrentHp: 5000,
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        sharedEntityRemoteUpdateDeferredIds: new Set<number>(),
        startedRoomEvents: new Set<string>(),
        entities: new Map<number, any>(),
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, bb: BitBuffer) {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function attachPlayer(client: FakeClient): void {
    const scope = getLevelScopeKey(client.currentLevel, client.levelInstanceId);
    const player = {
        ...Entity.fromCharacter(client.clientEntID, client.character as any, {
            x: 100,
            y: 200,
            team: EntityTeam.PLAYER,
            entState: EntityState.ACTIVE,
            roomId: client.currentRoomId
        }),
        ownerToken: client.token,
        ownerUserId: client.userId,
        hp: client.authoritativeCurrentHp,
        maxHp: client.authoritativeMaxHp
    };
    client.entities.set(client.clientEntID, player);
    client.knownEntityIds.add(client.clientEntID);

    let levelMap = GlobalState.levelEntities.get(scope);
    if (!levelMap) {
        levelMap = new Map<number, any>();
        GlobalState.levelEntities.set(scope, levelMap);
    }
    levelMap.set(client.clientEntID, player);
}

function setParty(...clients: FakeClient[]): void {
    const partyId = 7702;
    const members = clients.map((client) => client.character.name);
    for (const client of clients) {
        GlobalState.partyByMember.set(client.character.name.toLowerCase(), partyId);
    }
    GlobalState.partyGroups.set(partyId, {
        id: partyId,
        leader: members[0],
        members,
        locked: false
    });
}

function buildPowerHitPayload(targetId: number, sourceId: number, damage: number, powerId: number = 77): Buffer {
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

function buildPowerCastPayload(sourceId: number, powerId: number = 77): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(sourceId);
    bb.writeMethod4(powerId);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildClientHostileFullUpdate(
    entityId: number,
    name: string,
    x: number,
    y: number,
    roomId: number
): Buffer {
    const payload = (EntityHandler as any).buildEntityFullUpdatePayload({
        id: entityId,
        name,
        isPlayer: false,
        x,
        y,
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

function buildIncrementalUpdatePayload(entityId: number, deltaX: number, deltaY: number, entState: number = EntityState.ACTIVE): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod45(deltaX);
    bb.writeMethod45(deltaY);
    bb.writeMethod45(0);
    bb.writeMethod6(entState, 2);
    bb.writeMethod15(false);
    bb.writeMethod15(true);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildQuestProgressPayload(progress: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(Math.max(0, Math.round(Number(progress) || 0)));
    return bb.toBuffer();
}

function buildLevelCompletePayload(completionPercent: number, remainingKills: number, requiredKills: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(Math.max(0, Math.round(Number(completionPercent) || 0)));
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(Math.max(0, Math.round(Number(remainingKills) || 0)));
    bb.writeMethod9(Math.max(1, Math.round(Number(requiredKills) || 1)));
    bb.writeMethod9(3);
    return bb.toBuffer();
}

function buildRoomEventPayload(roomId: number, flag: boolean = false): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(Math.max(0, Math.round(Number(roomId) || 0)));
    bb.writeMethod15(flag);
    return bb.toBuffer();
}

async function finishEastWingPostDeathCutscene(...clients: FakeClient[]): Promise<void> {
    for (const client of clients) {
        LevelHandler.handleRoomEventStart(client as never, buildRoomEventPayload(3, false));
    }
    for (const client of clients) {
        LevelHandler.handleRoomClose(client as never, buildRoomEventPayload(3, false));
        await waitForPendingTimers();
    }
}

function parseEntityState(payload: Buffer): { entityId: number; entState: number } {
    const br = new BitReader(payload);
    const entityId = br.readMethod4();
    br.readMethod45();
    br.readMethod45();
    br.readMethod45();
    return {
        entityId,
        entState: br.readMethod6(2)
    };
}

function parseHpDelta(payload: Buffer): { entityId: number; delta: number } {
    const br = new BitReader(payload);
    return {
        entityId: br.readMethod4(),
        delta: br.readMethod45()
    };
}

function parseDestroy(payload: Buffer): { entityId: number; immediate: boolean } {
    const br = new BitReader(payload);
    return {
        entityId: br.readMethod4(),
        immediate: br.readMethod15()
    };
}

function parseQuestProgress(payload: Buffer): number {
    const br = new BitReader(payload);
    return br.readMethod4();
}

function rankPacketCount(client: FakeClient): number {
    return client.sentPackets.filter((packet) => packet.id === 0x87).length;
}

function waitForPendingTimers(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 5));
}

function getHostiles(scope: string): any[] {
    return Array.from(GlobalState.levelEntities.get(scope)?.values() ?? [])
        .filter((entity) => !entity.isPlayer && Number(entity.team ?? 0) === EntityTeam.ENEMY);
}

function attachProxy(client: FakeClient, localId: number, name: string, x: number, y: number, roomId: number): void {
    EntityHandler.handleEntityFullUpdate(client as never, buildClientHostileFullUpdate(localId, name, x, y, roomId));
}

function assertLocalDeadPacket(client: FakeClient, localEntityId: number, message: string): void {
    const packet = client.sentPackets.find((candidate) => {
        if (candidate.id !== 0x07) {
            return false;
        }
        const state = parseEntityState(candidate.payload);
        return state.entityId === localEntityId && state.entState === EntityState.DEAD;
    });
    assert.ok(packet, message);
}

function setupTwoPlayers(
    levelName: string,
    instanceId: string,
    rooms: { zeusRoom?: number; telahairRoom?: number } = {}
): { zeus: FakeClient; telahair: FakeClient; scope: string } {
    const zeus = createFakeClient('Zeus', levelName, instanceId, 13933, rooms.zeusRoom ?? 1);
    const telahair = createFakeClient('Telahair', levelName, instanceId, 63188, rooms.telahairRoom ?? 3);
    // Match the live failing setup: Telahair owns/leads the party, Zeus joins.
    setParty(telahair, zeus);
    attachPlayer(zeus);
    attachPlayer(telahair);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    GlobalState.sessionsByToken.set(telahair.token, telahair as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    EntityHandler.sendInitialLevelEntities(telahair as never, telahair.currentLevel);
    return { zeus, telahair, scope: getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId) };
}

function setupTwoPlayersInBossRoom(levelName: string, instanceId: string): { zeus: FakeClient; telahair: FakeClient; scope: string } {
    return setupTwoPlayers(levelName, instanceId, { zeusRoom: 3, telahairRoom: 3 });
}

function assertEastWingRoster(scope: string, tanjaCanonicalId: number, tanjaName: string): void {
    const hostiles = getHostiles(scope);
    assert.equal(hostiles.length, 5, 'The East Wing should seed exactly five canonical hostiles');
    for (const hostile of hostiles) {
        assert.equal(hostile.clientSpawned, false, `${hostile.name} should be server canonical`);
        assert.equal(hostile.level, 50, `${hostile.name} should be level 50`);
        assert.ok(Number(hostile.maxHp ?? 0) > 100, `${hostile.name} should have level-50 maxHp`);
        assert.equal(hostile.hp, hostile.maxHp, `${hostile.name} should start at full canonical HP`);
    }
    const tanja = GlobalState.levelEntities.get(scope)?.get(tanjaCanonicalId);
    assert.ok(tanja, `${tanjaName} canonical should exist`);
    assert.equal(tanja.name, tanjaName, 'Tanja should use the TowerGuard2 enemy type');
    assert.equal(Boolean(tanja.roomBoss), true, 'Tanja should keep roomBoss metadata');
    assert.equal(Boolean(tanja.isRoomBoss), true, 'Tanja should be marked as room boss');
    assert.equal(tanja.roomBossName, TANJA_BOSS_NAME, 'Tanja should carry the boss nameplate');
    assert.equal(tanja.roomId, 3, 'Tanja should live in the boss arena room');
    assert.equal(tanja.x, 11978, 'Tanja spawn X should match the level SWF cue');
    assert.equal(tanja.y, 4756, 'Tanja spawn Y should match the level SWF cue');
}

function testSeedRosters(): void {
    const { scope } = setupTwoPlayers('JC_Mini2', 'jc-mini2-roster');
    assertEastWingRoster(scope, TANJA_CANONICAL_ID, 'TowerGuard2');
}

function testHardSeedRosterAndProxyMapping(): void {
    const { zeus, scope } = setupTwoPlayers('JC_Mini2Hard', 'jc-mini2-hard-roster');
    assertEastWingRoster(scope, TANJA_HARD_CANONICAL_ID, 'TowerGuard2Hard');

    attachProxy(zeus, 510004, 'TowerGuard2Hard', 11978, 4756, 3);
    assert.equal(
        EntityHandler.resolveEntityAlias(zeus as never, 510004),
        TANJA_HARD_CANONICAL_ID,
        'hard-mode Tanja proxy should map to the hard canonical boss'
    );
    assert.equal(GlobalState.levelEntities.get(scope)?.has(510004), false, 'hard-mode local Tanja proxy must not enter canonical level map');
}

async function testSharedTanjaFightDeathAndNoRespawn(): Promise<void> {
    const { zeus, telahair, scope } = setupTwoPlayersInBossRoom('JC_Mini2', 'jc-mini2-tanja-fight');
    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;

    attachProxy(zeus, 500004, 'TowerGuard2', 11978, 4756, 3);
    attachProxy(telahair, 600004, 'TowerGuard2', 11978, 4756, 3);
    assert.equal(EntityHandler.resolveEntityAlias(zeus as never, 500004), TANJA_CANONICAL_ID, 'starter local Tanja proxy should map to canonical Tanja');
    assert.equal(EntityHandler.resolveEntityAlias(telahair as never, 600004), TANJA_CANONICAL_ID, 'joiner local Tanja proxy should map to the same canonical Tanja');
    assert.equal(GlobalState.levelEntities.get(scope)?.has(500004), false, 'starter local Tanja proxy must not enter canonical level map');
    assert.equal(GlobalState.levelEntities.get(scope)?.has(600004), false, 'joiner local Tanja proxy must not enter canonical level map');

    const tanja = GlobalState.levelEntities.get(scope)?.get(TANJA_CANONICAL_ID);
    assert.ok(tanja, 'canonical Tanja should exist after proxy attach');
    assert.equal(zeus.entities.get(500004)?.maxHp, tanja.maxHp, 'starter proxy cache maxHp should match canonical Tanja maxHp');
    assert.equal(telahair.entities.get(600004)?.maxHp, tanja.maxHp, 'joiner proxy cache maxHp should match canonical Tanja maxHp');

    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    const hpBefore = Math.round(Number(tanja.hp ?? 0));
    await CombatHandler.handlePowerCast(zeus as never, buildPowerCastPayload(zeus.clientEntID));
    await CombatHandler.handlePowerHit(zeus as never, buildPowerHitPayload(500004, zeus.clientEntID, 1000));
    assert.ok(Math.round(Number(tanja.hp ?? 0)) < hpBefore, 'starter power hit should reduce shared canonical Tanja HP');
    assert.equal(telahair.entities.get(600004)?.hp, tanja.hp, 'joiner proxy cache should converge to shared Tanja HP after starter hit');

    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    const remainingHp = Math.round(Number(tanja.hp ?? 0));
    await CombatHandler.handlePowerCast(telahair as never, buildPowerCastPayload(telahair.clientEntID));
    await CombatHandler.handlePowerHit(telahair as never, buildPowerHitPayload(600004, telahair.clientEntID, remainingHp + 999));
    assert.equal(tanja.hp, 0, 'lethal hit should set shared canonical Tanja HP to zero');
    assert.equal(tanja.dead, true, 'lethal hit should kill canonical Tanja');
    assertLocalDeadPacket(telahair, 600004, 'attacker should receive DEAD for its local Tanja proxy');
    assertLocalDeadPacket(zeus, 500004, 'party viewer should receive DEAD for its local Tanja proxy');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x78 && parseHpDelta(packet.payload).entityId === 500004 && parseHpDelta(packet.payload).delta < 0),
        true,
        'party viewer should receive HP zero correction when Tanja dies on the other screen'
    );
    // The viewer's client simulates remote hits with its own damage rolls, so
    // its displayed HP can sit above the server-side estimate. The death
    // correction must be a lethal floor (>= maxHp) so no sliver of HP survives
    // on the party member's screen and both deaths land on the same frame.
    const tanjaMaxHp = Math.round(Number(tanja.maxHp ?? 0));
    assert.ok(tanjaMaxHp > 0, 'Tanja should carry a canonical maxHp');
    assert.equal(
        zeus.sentPackets.some((packet) =>
            packet.id === 0x78 &&
            parseHpDelta(packet.payload).entityId === 500004 &&
            parseHpDelta(packet.payload).delta <= -tanjaMaxHp
        ),
        true,
        'party viewer death correction must floor local Tanja HP to zero regardless of local sim drift'
    );
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === 500004),
        true,
        'party viewer local Tanja proxy should be destroyed after the shared death'
    );

    // Re-entry into the still-active instance must not resurrect the dead boss.
    const late = createFakeClient('LateJoiner', 'JC_Mini2', zeus.levelInstanceId, 77777, 3);
    setParty(zeus, telahair, late);
    attachPlayer(late);
    GlobalState.sessionsByToken.set(late.token, late as never);
    EntityHandler.sendInitialLevelEntities(late as never, late.currentLevel);
    assert.equal(getLevelScopeKey(late.currentLevel, late.levelInstanceId), scope, 'rejoining party member should share the canonical scope');
    assert.equal(GlobalState.levelEntities.get(scope)?.get(TANJA_CANONICAL_ID)?.dead, true, 'rejoin must not reset dead canonical Tanja');

    late.sentPackets.length = 0;
    attachProxy(late, 700004, 'TowerGuard2', 11978, 4756, 3);
    assert.equal(late.entities.has(700004), false, 'rejoining player must not keep a live client-side Tanja duplicate');
    assertLocalDeadPacket(late, 700004, 'rejoining player should receive DEAD for the already-killed Tanja');
    assert.equal(
        late.sentPackets.some((packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === 700004),
        true,
        'rejoining player local Tanja duplicate should be destroyed instead of respawning'
    );
    assert.equal(rankPacketCount(late), 0, 'late rejoin before post-death cutscene finish must not receive rank/stat UI');
}

async function testTanjaCanonicalDeathFanoutSingleKill(
    lethalSourceName: 'Zeus' | 'Telahair',
    instanceId: string
): Promise<void> {
    const { zeus, telahair, scope } = setupTwoPlayersInBossRoom('JC_Mini2', instanceId);
    attachProxy(zeus, 520004, 'TowerGuard2', 11978, 4756, 3);
    attachProxy(telahair, 620004, 'TowerGuard2', 11978, 4756, 3);

    const source = lethalSourceName === 'Zeus' ? zeus : telahair;
    const viewer = lethalSourceName === 'Zeus' ? telahair : zeus;
    const sourceLocalId = lethalSourceName === 'Zeus' ? 520004 : 620004;
    const viewerLocalId = lethalSourceName === 'Zeus' ? 620004 : 520004;
    const viewerDuplicateId = lethalSourceName === 'Zeus' ? 629999 : 529999;
    const tanja = GlobalState.levelEntities.get(scope)?.get(TANJA_CANONICAL_ID);
    assert.ok(tanja, 'canonical Tanja should exist before lethal hit');

    viewer.entities.set(viewerDuplicateId, {
        id: viewerDuplicateId,
        name: 'TowerGuard2',
        roomBoss: true,
        isRoomBoss: true,
        roomBossName: TANJA_BOSS_NAME,
        team: EntityTeam.ENEMY,
        isPlayer: false,
        clientSpawned: true,
        hp: Number(tanja.maxHp ?? 1),
        maxHp: Number(tanja.maxHp ?? 1),
        entState: EntityState.ACTIVE,
        roomId: 3,
        x: 11978,
        y: 4756
    });

    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    await CombatHandler.handlePowerCast(source as never, buildPowerCastPayload(source.clientEntID));
    await CombatHandler.handlePowerHit(source as never, buildPowerHitPayload(sourceLocalId, source.clientEntID, 999999));
    await waitForPendingTimers();

    assert.equal(tanja.hp, 0, 'canonical Tanja HP must clamp to zero on first lethal hit');
    assert.equal(tanja.dead, true, 'canonical Tanja must be dead after first lethal hit');
    assert.equal(Boolean(tanja.bossDeathCommitted), true, 'canonical boss death must be committed once');
    assert.equal(Math.max(0, Math.round(Number(tanja.deathVersion ?? 0))), 1, 'canonical boss death should have one death version');

    assertLocalDeadPacket(source, sourceLocalId, 'lethal source should receive DEAD for its own local Tanja');
    assertLocalDeadPacket(viewer, viewerLocalId, 'other boss-room player should receive DEAD for registered local Tanja immediately');
    assertLocalDeadPacket(viewer, viewerDuplicateId, 'other boss-room player should receive DEAD for extra local Tanja duplicate immediately');
    assert.equal(
        viewer.sentPackets.some((packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === viewerDuplicateId),
        true,
        'extra local Tanja duplicate should be destroyed by the first canonical death'
    );
    assert.equal(viewer.entities.has(viewerDuplicateId), false, 'extra local Tanja duplicate must not stay alive in viewer cache');

    const zeusProgress = Math.round(Number((zeus.character as any).questTrackerState ?? -1));
    const telahairProgress = Math.round(Number((telahair.character as any).questTrackerState ?? -2));
    assert.equal(zeusProgress, telahairProgress, 'single canonical death should mirror the same progress to both players');
    assert.equal(zeusProgress, 25, 'single Tanja death should award the shared East Wing boss progress floor');
    const sharedState = GlobalState.levelQuestProgress.get(scope);
    assert.equal(Boolean(sharedState?.bossDeathCommitted), true, 'shared East Wing state must record committed boss death');
    assert.equal(Boolean(sharedState?.postDeathCutsceneStarted), true, 'boss death should arm the shared post-death cutscene gate');
    assert.equal(Boolean(sharedState?.postDeathCutsceneFinished), false, 'post-death cutscene must not be finished on boss death');
    assert.equal(rankPacketCount(zeus), 0, 'Zeus must not receive rank/stat UI before the post-death cutscene ends');
    assert.equal(rankPacketCount(telahair), 0, 'Telahair must not receive rank/stat UI before the post-death cutscene ends');

    await finishEastWingPostDeathCutscene(zeus, telahair);
    assert.equal(Boolean(sharedState?.postDeathCutsceneFinished), true, 'shared post-death cutscene should finish after both boss-room players close it');
    assert.equal(Boolean(sharedState?.completionFinalized), true, 'completion should finalize only after the post-death cutscene finishes');
    assert.equal(rankPacketCount(zeus), 1, 'Zeus should receive rank/stat UI after the shared post-death cutscene');
    assert.equal(rankPacketCount(telahair), 1, 'Telahair should receive rank/stat UI after the shared post-death cutscene');

    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    await CombatHandler.handlePowerCast(viewer as never, buildPowerCastPayload(viewer.clientEntID));
    await CombatHandler.handlePowerHit(viewer as never, buildPowerHitPayload(viewerDuplicateId, viewer.clientEntID, 999999));
    await waitForPendingTimers();
    assert.equal(Math.max(0, Math.round(Number(tanja.deathVersion ?? 0))), 1, 'late local Tanja hit must not commit a second boss death');
    assert.equal(rankPacketCount(zeus), 0, 'late local Tanja hit must not duplicate Zeus rank UI');
    assert.equal(rankPacketCount(telahair), 0, 'late local Tanja hit must not duplicate Telahair rank UI');
    assert.equal(
        Math.round(Number((zeus.character as any).questTrackerState ?? -1)),
        zeusProgress,
        'late local Tanja hit must not change shared progress for Zeus'
    );
    assert.equal(
        Math.round(Number((telahair.character as any).questTrackerState ?? -1)),
        zeusProgress,
        'late local Tanja hit must not change shared progress for Telahair'
    );
}

// Strict East Wing authority must not accept combat mutations for seed-outside
// mirror hostiles. The generated server roster owns this level's hostile state.
async function testStrictEastWingRejectsSeedOutsideMirrorHostiles(): Promise<void> {
    const { zeus, telahair, scope } = setupTwoPlayers('JC_Mini2', 'jc-mini2-mirror-death-sweep');

    const firstLocalId = 33186039;
    attachProxy(telahair, firstLocalId, 'ImperialMagi', 16200, 4700, 2);
    assert.equal(GlobalState.levelEntities.get(scope)?.has(firstLocalId), false, 'seed-outside hostile must not become a shared mirror canonical');
    assert.equal(telahair.entities.has(firstLocalId), false, 'owner seed-outside hostile should be destroyed locally');
    assert.equal(EntityHandler.resolveEntityAlias(telahair as never, firstLocalId), firstLocalId, 'seed-outside hostile must not alias to a canonical enemy');
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === firstLocalId),
        true,
        'owner seed-outside hostile should receive immediate destroy'
    );

    // Re-reported/generated local copies must also stay outside canonical state.
    attachProxy(telahair, 33710327, 'ImperialMagi', 16200, 4700, 2);
    attachProxy(zeus, 15905179, 'ImperialMagi', 16200, 4700, 2);
    attachProxy(zeus, 15999999, 'ImperialMagi', 16200, 4700, 2);
    assert.equal(GlobalState.levelEntities.get(scope)?.has(33710327), false, 'regenerated owner hostile must not enter canonical state');
    assert.equal(GlobalState.levelEntities.get(scope)?.has(15905179), false, 'viewer seed-outside hostile must not enter canonical state');
    assert.equal(GlobalState.levelEntities.get(scope)?.has(15999999), false, 'regenerated viewer hostile must not enter canonical state');
    assert.equal(EntityHandler.resolveEntityAlias(zeus as never, 15905179), 15905179, 'viewer seed-outside hostile must not alias to a random canonical');
    assert.equal(EntityHandler.resolveEntityAlias(zeus as never, 15999999), 15999999, 'regenerated viewer seed-outside hostile must not alias to a random canonical');

    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    const totalsBefore = getSharedDungeonProgressTotals(scope);
    await CombatHandler.handlePowerCast(telahair as never, buildPowerCastPayload(telahair.clientEntID));
    await CombatHandler.handlePowerHit(telahair as never, buildPowerHitPayload(firstLocalId, telahair.clientEntID, 999999));
    assert.deepEqual(getSharedDungeonProgressTotals(scope), totalsBefore, 'seed-outside hostile hit must not mutate shared progress totals');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x0D),
        false,
        'rejected seed-outside hit must not fan out canonical destroys'
    );
}

// The live failure was a split state after Tanja died once: rank/progress/boss
// death were each driven by different local state. A single canonical Tanja
// death should now deliver rank UI consistently while preserving shared partial
// progress.
async function testSharedProgressAndCompletionPropagation(): Promise<void> {
    const { zeus, telahair, scope } = setupTwoPlayersInBossRoom('JC_Mini2', 'jc-mini2-completion-sync');

    const totalsBefore = getSharedDungeonProgressTotals(scope);
    assert.ok(
        totalsBefore.total >= 5,
        `shared progress must track the five server-authority seeds (got total=${totalsBefore.total})`
    );
    assert.equal(totalsBefore.defeated, 0, 'no seed should start defeated');

    // Kill Tanja through the normal proxy flow.
    attachProxy(zeus, 520004, 'TowerGuard2', 11978, 4756, 3);
    attachProxy(telahair, 620004, 'TowerGuard2', 11978, 4756, 3);
    const tanja = GlobalState.levelEntities.get(scope)?.get(TANJA_CANONICAL_ID);
    assert.ok(tanja, 'canonical Tanja should exist');
    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    await CombatHandler.handlePowerCast(telahair as never, buildPowerCastPayload(telahair.clientEntID));
    await CombatHandler.handlePowerHit(telahair as never, buildPowerHitPayload(620004, telahair.clientEntID, 999999));
    await waitForPendingTimers();
    assert.equal(tanja.dead, true, 'Tanja should be dead on the server');

    const totalsAfter = getSharedDungeonProgressTotals(scope);
    assert.ok(totalsAfter.defeated >= 1, 'Tanja death must count toward shared progress');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0xB7),
        true,
        'party member should receive the shared progress broadcast after the kill'
    );
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0xB7),
        true,
        'party owner should receive the shared progress broadcast after the kill'
    );
    const zeusProgress = Math.round(Number((zeus.character as any).questTrackerState ?? -1));
    const telahairProgress = Math.round(Number((telahair.character as any).questTrackerState ?? -2));
    assert.equal(zeusProgress, telahairProgress, 'both party members must share the same progress percentage');
    assert.equal(zeusProgress, 25, 'Tanja death should broadcast the shared East Wing 25% progress floor');

    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    await LevelHandler.handleQuestProgressUpdate(zeus as never, buildQuestProgressPayload(0));
    assert.equal(
        Math.round(Number((zeus.character as any).questTrackerState ?? -1)),
        zeusProgress,
        'party member stale 0% progress packet must be corrected back to shared progress'
    );
    assert.equal(
        Math.round(Number((telahair.character as any).questTrackerState ?? -1)),
        zeusProgress,
        'party owner must keep the same shared progress after member stale progress packet'
    );
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0xB7 && parseQuestProgress(packet.payload) === zeusProgress),
        true,
        'party member should receive corrected shared progress after stale 0%'
    );
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0xB7 && parseQuestProgress(packet.payload) === zeusProgress),
        true,
        'party owner should receive corrected shared progress after member stale 0%'
    );

    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    await MissionHandler.handleSetLevelComplete(zeus as never, buildLevelCompletePayload(100, 0, totalsBefore.total));
    assert.equal(
        rankPacketCount(zeus),
        0,
        'party member local completion packet must be deferred until the post-death cutscene ends'
    );
    assert.equal(
        rankPacketCount(telahair),
        0,
        'party owner must not receive relayed rank/stat UI before the post-death cutscene ends'
    );
    assert.equal(
        String((zeus as any).completedDungeonCompletionScope ?? ''),
        '',
        'party member completion must not finalize before the post-death cutscene ends'
    );
    assert.equal(
        String((telahair as any).completedDungeonCompletionScope ?? ''),
        '',
        'party owner completion must not finalize before the post-death cutscene ends'
    );

    await finishEastWingPostDeathCutscene(zeus, telahair);
    assert.equal(rankPacketCount(zeus), 1, 'party member should receive rank/stat UI after the shared post-death cutscene');
    assert.equal(rankPacketCount(telahair), 1, 'party owner should receive rank/stat UI after the shared post-death cutscene');
    assert.equal(
        String((zeus as any).completedDungeonCompletionScope ?? ''),
        scope,
        'party member should finalize after the shared post-death cutscene'
    );
    assert.equal(
        String((telahair as any).completedDungeonCompletionScope ?? ''),
        scope,
        'party owner should finalize after the shared post-death cutscene'
    );
    assert.equal(
        Math.round(Number((zeus.character as any).questTrackerState ?? -1)),
        zeusProgress,
        'party member progress must stay on the shared partial value after rejected completion'
    );
    assert.equal(
        Math.round(Number((telahair.character as any).questTrackerState ?? -1)),
        zeusProgress,
        'party owner progress must stay on the shared partial value after rejected completion'
    );

    zeus.sentPackets.length = 0;
    attachProxy(zeus, 529999, 'TowerGuard2', 11978, 4756, 3);
    assert.equal(zeus.entities.has(529999), false, 'party member must not keep a respawned Tanja after shared death');
    assertLocalDeadPacket(zeus, 529999, 'party member respawned Tanja duplicate should be force-destroyed');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === 529999),
        true,
        'party member respawned Tanja duplicate should receive destroy'
    );

    assert.equal(
        rankPacketCount(zeus) > 0 && Math.round(Number((zeus.character as any).questTrackerState ?? 0)) === 0,
        false,
        'impossible mixed state must not occur for Zeus: stats visible with 0% progress'
    );
    assert.equal(
        Math.round(Number((telahair.character as any).questTrackerState ?? 0)) === zeusProgress && tanja.dead,
        true,
        'Telahair should remain in the coherent partial-progress, boss-dead state after shared completion UI'
    );
}

async function testCompletionWaitsForSharedPostDeathCutsceneBarrier(): Promise<void> {
    const { zeus, telahair, scope } = setupTwoPlayersInBossRoom('JC_Mini2', 'jc-mini2-postdeath-barrier');
    attachProxy(zeus, 520004, 'TowerGuard2', 11978, 4756, 3);
    attachProxy(telahair, 620004, 'TowerGuard2', 11978, 4756, 3);
    const tanja = GlobalState.levelEntities.get(scope)?.get(TANJA_CANONICAL_ID);
    assert.ok(tanja, 'canonical Tanja should exist');

    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    await CombatHandler.handlePowerCast(zeus as never, buildPowerCastPayload(zeus.clientEntID));
    await CombatHandler.handlePowerHit(zeus as never, buildPowerHitPayload(520004, zeus.clientEntID, 999999));
    await waitForPendingTimers();

    const sharedState = GlobalState.levelQuestProgress.get(scope);
    assert.equal(Boolean(tanja.dead), true, 'Tanja should be dead after lethal hit');
    assert.equal(Boolean(tanja.bossDeathCommitted), true, 'boss death should be committed once');
    assert.equal(Boolean(sharedState?.postDeathCutsceneStarted), true, 'shared post-death cutscene should be started/gated');
    assert.equal(Boolean(sharedState?.postDeathCutsceneFinished), false, 'post-death cutscene should still be open');
    assert.equal(rankPacketCount(zeus), 0, 'killer must not get rank UI on boss death');
    assert.equal(rankPacketCount(telahair), 0, 'party owner must not get rank UI on boss death');

    LevelHandler.handleRoomEventStart(telahair as never, buildRoomEventPayload(3, false));
    LevelHandler.handleRoomEventStart(zeus as never, buildRoomEventPayload(3, false));
    LevelHandler.handleRoomClose(zeus as never, buildRoomEventPayload(3, false));
    await waitForPendingTimers();
    assert.equal(Boolean(sharedState?.postDeathCutsceneFinished), false, 'one player closing early must not finish the shared post-death cutscene');
    assert.equal(rankPacketCount(zeus), 0, 'early closer must still not get rank UI');
    assert.equal(rankPacketCount(telahair), 0, 'other boss-room player must still not get rank UI');

    LevelHandler.handleRoomClose(telahair as never, buildRoomEventPayload(3, false));
    await waitForPendingTimers();
    assert.equal(Boolean(sharedState?.postDeathCutsceneFinished), true, 'post-death cutscene should finish after both expected players close');
    assert.equal(Boolean(sharedState?.completionFinalized), true, 'completion should finalize only after the barrier opens');
    assert.equal(rankPacketCount(zeus), 1, 'Zeus should receive rank UI after the shared cutscene finishes');
    assert.equal(rankPacketCount(telahair), 1, 'Telahair should receive rank UI after the shared cutscene finishes');
}

async function testLateJoinAfterEastWingCompletionReceivesMissingStats(): Promise<void> {
    const { zeus, telahair, scope } = setupTwoPlayersInBossRoom('JC_Mini2', 'jc-mini2-late-after-completion');
    attachProxy(zeus, 520004, 'TowerGuard2', 11978, 4756, 3);
    attachProxy(telahair, 620004, 'TowerGuard2', 11978, 4756, 3);
    const tanja = GlobalState.levelEntities.get(scope)?.get(TANJA_CANONICAL_ID);
    assert.ok(tanja, 'canonical Tanja should exist');

    await CombatHandler.handlePowerCast(telahair as never, buildPowerCastPayload(telahair.clientEntID));
    await CombatHandler.handlePowerHit(telahair as never, buildPowerHitPayload(620004, telahair.clientEntID, 999999));
    await waitForPendingTimers();
    await finishEastWingPostDeathCutscene(telahair, zeus);
    assert.equal(Boolean(GlobalState.levelQuestProgress.get(scope)?.completionFinalized), true, 'completion should be finalized before late re-entry');

    const late = createFakeClient('LateJoiner', 'JC_Mini2', zeus.levelInstanceId, 77777, 3);
    setParty(telahair, zeus, late);
    attachPlayer(late);
    GlobalState.sessionsByToken.set(late.token, late as never);
    late.sentPackets.length = 0;
    EntityHandler.sendInitialLevelEntities(late as never, late.currentLevel);
    await waitForPendingTimers();

    assert.equal(GlobalState.levelEntities.get(scope)?.get(TANJA_CANONICAL_ID)?.dead, true, 'late re-entry must not respawn Tanja');
    assert.equal(rankPacketCount(late), 1, 'late re-entry after completion should receive missing rank/stat UI');
    late.sentPackets.length = 0;
    attachProxy(late, 700004, 'TowerGuard2', 11978, 4756, 3);
    assert.equal(late.entities.has(700004), false, 'late re-entry after completion must not keep a live Tanja duplicate');
    assertLocalDeadPacket(late, 700004, 'late re-entry after completion should receive dead boss state');
}

async function testPostCompletionHostileDamageSuppressed(): Promise<void> {
    const { zeus, telahair, scope } = setupTwoPlayersInBossRoom('JC_Mini2', 'jc-mini2-post-completion-damage');
    attachProxy(zeus, 520004, 'TowerGuard2', 11978, 4756, 3);
    attachProxy(telahair, 620004, 'TowerGuard2', 11978, 4756, 3);

    const tanja = GlobalState.levelEntities.get(scope)?.get(TANJA_CANONICAL_ID);
    assert.ok(tanja, 'canonical Tanja should exist');
    await CombatHandler.handlePowerCast(telahair as never, buildPowerCastPayload(telahair.clientEntID));
    await CombatHandler.handlePowerHit(telahair as never, buildPowerHitPayload(620004, telahair.clientEntID, 999999));
    await waitForPendingTimers();
    await finishEastWingPostDeathCutscene(telahair, zeus);

    assert.equal(rankPacketCount(zeus), 1, 'party leader should have rank UI before post-completion damage test');
    assert.equal(rankPacketCount(telahair), 1, 'party member should have rank UI before post-completion damage test');
    assert.equal(Boolean(GlobalState.levelQuestProgress.get(scope)?.completionFinalized), true, 'shared completion must be finalized');

    const hostileSourceId = 920005;
    assert.ok(GlobalState.levelEntities.get(scope)?.get(hostileSourceId), 'remaining East Wing hostile should exist as a stale damage source');

    for (const client of [zeus, telahair]) {
        client.authoritativeCurrentHp = 5000;
        client.entities.get(client.clientEntID).hp = 5000;
        client.entities.get(client.clientEntID).dead = false;
        client.entities.get(client.clientEntID).entState = EntityState.ACTIVE;
        client.sentPackets.length = 0;

        await CombatHandler.handlePowerHit(client as never, buildPowerHitPayload(client.clientEntID, hostileSourceId, 999999));
        assert.equal(client.authoritativeCurrentHp, 5000, `${client.character.name} HP must not change after rank UI starts`);
        assert.equal(client.entities.get(client.clientEntID)?.dead, false, `${client.character.name} must not die from stale hostile damage after completion`);
        assert.equal(
            client.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === client.clientEntID),
            false,
            `${client.character.name} must not receive a death state from stale hostile damage after completion`
        );
    }
}

// The boss intro must be shared per dungeon instance: a solo-triggered intro
// is recorded so later party members skip a finished intro instead of
// replaying it, while current party members join an active intro.
async function testBossIntroSharedLifecycle(): Promise<void> {
    const instanceId = 'jc-mini2-intro-lifecycle';
    const zeus = createFakeClient('Zeus', 'JC_Mini2', instanceId, 13933, 3);
    attachPlayer(zeus);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);

    // Solo trigger records the shared intro state.
    LevelHandler.handleRoomEventStart(zeus as never, buildRoomEventPayload(3));
    const introState = GlobalState.dungeonCutscenes.get(`${scope}:3`);
    assert.ok(introState, 'solo boss intro trigger must record shared cutscene state');
    assert.equal(Boolean(introState.completed), false, 'intro should start active');

    // Solo close marks the shared intro finished.
    LevelHandler.handleRoomClose(zeus as never, buildRoomEventPayload(3));
    assert.equal(
        Boolean(GlobalState.dungeonCutscenes.get(`${scope}:3`)?.completed),
        true,
        'solo cutscene close must mark the shared intro finished'
    );

    // A party member arriving after the finished intro must not replay it.
    const telahair = createFakeClient('Telahair', 'JC_Mini2', instanceId, 63188, 3);
    setParty(zeus, telahair);
    attachPlayer(telahair);
    GlobalState.sessionsByToken.set(telahair.token, telahair as never);
    EntityHandler.sendInitialLevelEntities(telahair as never, telahair.currentLevel);
    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    LevelHandler.handleRoomEventStart(telahair as never, buildRoomEventPayload(3));
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0xA5),
        false,
        'finished boss intro must not restart for a late-arriving party member'
    );
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0xA5),
        false,
        'finished boss intro must not be re-relayed to players who already saw it'
    );

    // A current party member in the same dungeon instance must join a running
    // boss intro instead of bypassing it locally.
    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    LevelHandler.handleRoomEventStart(zeus as never, buildRoomEventPayload(2));
    assert.equal(Boolean(GlobalState.dungeonCutscenes.get(`${scope}:2`)?.active), true, 'second room intro should be active');
    LevelHandler.handleRoomEventStart(telahair as never, buildRoomEventPayload(2));
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0xA5),
        true,
        'current party member must receive the running boss intro start'
    );
    assert.equal(
        String((telahair as any).activeDungeonCutsceneScope ?? ''),
        scope,
        'current party member must become a shared intro participant'
    );
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0xAE),
        false,
        'current party member must not receive a targeting unlock while the shared intro is running'
    );
    assert.equal(Boolean(GlobalState.dungeonCutscenes.get(`${scope}:2`)?.active), true, 'intro must keep running for its owner');

    // Re-entry into an instance that carries cutscene state must PRESERVE it
    // (the East Wing reentry policy), so a returning player never replays a
    // finished intro within the same run.
    GlobalState.sessionsByToken.delete(telahair.token);
    GlobalState.sessionsByToken.delete(zeus.token);
    const freshRunner = createFakeClient('FreshRunner', 'JC_Mini2', instanceId, 77777, 0);
    GlobalState.sessionsByToken.set(freshRunner.token, freshRunner as never);
    (EntityHandler as any).resetServerAuthorityScopeForFreshRun(freshRunner, 'JC_Mini2', new Map<number, any>());
    assert.equal(
        Boolean(GlobalState.dungeonCutscenes.get(`${scope}:3`)?.completed),
        true,
        're-entry must preserve the finished intro state of the running instance'
    );
}

async function testBossIntroSharedTriggerDirections(): Promise<void> {
    const leaderFirst = setupTwoPlayersInBossRoom('JC_Mini2', 'jc-mini2-intro-leader-first');
    setParty(leaderFirst.zeus, leaderFirst.telahair);
    assert.equal(GlobalState.partyGroups.get(7702)?.leader, 'Zeus', 'Zeus must be the party leader for leader-first intro');
    leaderFirst.zeus.sentPackets.length = 0;
    leaderFirst.telahair.sentPackets.length = 0;
    LevelHandler.handleRoomEventStart(leaderFirst.zeus as never, buildRoomEventPayload(3));
    assert.equal(
        leaderFirst.telahair.sentPackets.some((packet) => packet.id === 0xA5),
        true,
        'party member must receive Tanja intro when the leader triggers it'
    );
    assert.equal(
        String((leaderFirst.telahair as any).activeDungeonCutsceneScope ?? ''),
        leaderFirst.scope,
        'party member must be marked as a Tanja intro participant when the leader triggers it'
    );

    const memberFirst = setupTwoPlayersInBossRoom('JC_Mini2', 'jc-mini2-intro-member-first');
    setParty(memberFirst.zeus, memberFirst.telahair);
    assert.equal(GlobalState.partyGroups.get(7702)?.leader, 'Zeus', 'Zeus must be the party leader for member-first intro');
    memberFirst.zeus.sentPackets.length = 0;
    memberFirst.telahair.sentPackets.length = 0;
    LevelHandler.handleRoomEventStart(memberFirst.telahair as never, buildRoomEventPayload(3));
    assert.equal(
        memberFirst.zeus.sentPackets.some((packet) => packet.id === 0xA5),
        true,
        'party leader must receive Tanja intro when the non-leader triggers it'
    );
    assert.equal(
        String((memberFirst.zeus as any).activeDungeonCutsceneScope ?? ''),
        memberFirst.scope,
        'party leader must be marked as a Tanja intro participant when the non-leader triggers it'
    );
}

async function testNonLeaderFirstEntryStartsIntroAndBlocksBossCombat(): Promise<void> {
    const { zeus, telahair, scope } = setupTwoPlayers('JC_Mini2', 'jc-mini2-nonleader-first-intro', {
        zeusRoom: 1,
        telahairRoom: 3
    });
    setParty(zeus, telahair);
    assert.equal(GlobalState.partyGroups.get(7702)?.leader, 'Zeus', 'Zeus must be the party leader for this regression');

    const tanja = GlobalState.levelEntities.get(scope)?.get(TANJA_CANONICAL_ID);
    assert.ok(tanja, 'canonical Tanja should exist');

    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    LevelHandler.handleRoomEventStart(telahair as never, buildRoomEventPayload(3));

    const introState = GlobalState.dungeonCutscenes.get(`${scope}:3`);
    assert.ok(introState?.active, 'non-leader first entry must start the shared Tanja intro');
    assert.equal(introState?.ownerToken, telahair.token, 'non-leader trigger must own the active shared intro');
    assert.equal(Boolean(introState?.completed), false, 'shared intro must not be completed at start');
    assert.equal(String((telahair as any).activeDungeonCutsceneScope ?? ''), scope, 'non-leader must enter the shared intro state');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0xA5),
        true,
        'leader must receive Tanja intro when the non-leader enters first'
    );
    assert.equal(
        String((zeus as any).activeDungeonCutsceneScope ?? ''),
        scope,
        'leader must be attached to the same shared intro state'
    );
    assert.equal(Boolean(tanja.untargetable), true, 'Tanja must be frozen while the non-leader-started intro is active');

    telahair.sentPackets.length = 0;
    attachProxy(telahair, 620004, 'TowerGuard2', 11978, 4756, 3);
    assert.equal(
        telahair.sentPackets.some((packet) => {
            if (packet.id !== 0xAE) {
                return false;
            }
            const br = new BitReader(packet.payload);
            return br.readMethod4() === 620004 && br.readMethod15() === true;
        }),
        true,
        'non-leader local Tanja proxy must stay untargetable during intro'
    );

    const hpBefore = telahair.authoritativeCurrentHp;
    await CombatHandler.handlePowerHit(telahair as never, buildPowerHitPayload(telahair.clientEntID, 620004, 999999));
    assert.equal(telahair.authoritativeCurrentHp, hpBefore, 'Tanja must not damage the non-leader while intro is active');
    assert.notEqual(telahair.entities.get(telahair.clientEntID)?.dead, true, 'non-leader must not die from intro-active Tanja damage');

    zeus.currentRoomId = 3;
    zeus.sentPackets.length = 0;
    LevelHandler.handleRoomEventStart(zeus as never, buildRoomEventPayload(3));
    assert.equal(
        Number((zeus as any).activeDungeonCutsceneJoinedAtDialogIndex ?? -1),
        0,
        'leader room-entry echo must join the current shared intro step'
    );
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0xA5),
        true,
        'leader actual room entry must receive a local intro start even if the eager shared packet was sent earlier'
    );
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0xAE),
        false,
        'leader entering during the active intro must not receive a targeting unlock'
    );

    LevelHandler.handleRoomClose(telahair as never, buildRoomEventPayload(3));
    assert.equal(Boolean(GlobalState.dungeonCutscenes.get(`${scope}:3`)?.active), true, 'non-leader close must wait for the leader watcher');
    assert.equal(Boolean(tanja.untargetable), true, 'Tanja must remain frozen until the leader also finishes');
    LevelHandler.handleRoomClose(zeus as never, buildRoomEventPayload(3));
    assert.equal(Boolean(GlobalState.dungeonCutscenes.get(`${scope}:3`)?.completed), true, 'shared intro must complete after both players close');
    assert.equal(Boolean(tanja.untargetable), false, 'Tanja combat must enable only after the shared intro finishes');
}

// Join-in-progress for the Tanja intro: the Flash client replays the intro
// locally when its own boss fight starts and keeps hostiles frozen only while
// its room stays in cutscene-border mode (cleared by any inbound 0xA6). The
// shared intro must therefore stay open until every active watcher has closed
// it, a late joiner must attach at the current dialog step, and a player who
// arrives after the finished intro must be closed out instead of replaying it.
async function testBossIntroLateJoinCloseBarrier(): Promise<void> {
    const { zeus, telahair, scope } = setupTwoPlayers('JC_Mini2', 'jc-mini2-intro-late-join', {
        zeusRoom: 3,
        telahairRoom: 1
    });
    const tanja = GlobalState.levelEntities.get(scope)?.get(TANJA_CANONICAL_ID);
    assert.ok(tanja, 'canonical Tanja should exist');

    // Player A reaches the boss room first and starts the shared intro.
    LevelHandler.handleRoomEventStart(zeus as never, buildRoomEventPayload(3));
    const introState = GlobalState.dungeonCutscenes.get(`${scope}:3`);
    assert.ok(introState?.active, 'intro must be active after the first trigger');
    assert.equal(Boolean(tanja.untargetable), true, 'Tanja must be frozen while the intro runs');
    assert.equal(introState?.introActiveClientTokens?.has(zeus.token), true, 'intro must track the triggering client');

    // The intro advances to dialog step 2 before the second player arrives.
    introState!.dialogIndex = 2;

    // The Flash client of a late joiner resets a remotely-opened border state
    // (spurious 0xA6) right before starting its own cutscene; that stale close
    // must not end the shared intro.
    telahair.currentRoomId = 3;
    LevelHandler.handleRoomClose(telahair as never, buildRoomEventPayload(3));
    assert.equal(
        Boolean(GlobalState.dungeonCutscenes.get(`${scope}:3`)?.active),
        true,
        'stale close from a client that never started its intro must not end the shared intro'
    );

    // The late joiner's own cutscene start joins at the current dialog step.
    telahair.sentPackets.length = 0;
    LevelHandler.handleRoomEventStart(telahair as never, buildRoomEventPayload(3));
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0xA5),
        true,
        'late joiner actual room entry must receive a local intro start at the shared current step'
    );
    assert.equal(String((telahair as any).activeDungeonCutsceneScope ?? ''), scope, 'late joiner must become an intro participant');
    assert.equal(
        Number((telahair as any).activeDungeonCutsceneJoinedAtDialogIndex ?? -1),
        2,
        'late joiner must join at the current shared dialog step'
    );
    assert.equal(introState?.introActiveClientTokens?.has(telahair.token), true, 'late joiner must be tracked as an active intro watcher');
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0xA6),
        false,
        'joining a running intro must not close the cutscene for the late joiner'
    );

    // A proxy attached while the intro runs must be delivered frozen.
    zeus.sentPackets.length = 0;
    attachProxy(zeus, 540004, 'TowerGuard2', 11978, 4756, 3);
    assert.equal(
        zeus.sentPackets.some((packet) => {
            if (packet.id !== 0xAE) {
                return false;
            }
            const br = new BitReader(packet.payload);
            return br.readMethod4() === 540004 && br.readMethod15() === true;
        }),
        true,
        'a boss proxy attached mid-intro must receive the untargetable freeze'
    );

    // Hostile damage against a watcher is rejected while the intro is active.
    const hpBefore = zeus.authoritativeCurrentHp;
    await CombatHandler.handlePowerHit(zeus as never, buildPowerHitPayload(zeus.clientEntID, 540004, 500));
    assert.equal(zeus.authoritativeCurrentHp, hpBefore, 'boss damage must be rejected while the shared intro is active');

    // The late joiner finishes first: the shared intro must stay open for the
    // player still watching.
    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    LevelHandler.handleRoomClose(telahair as never, buildRoomEventPayload(3));
    assert.equal(Boolean(GlobalState.dungeonCutscenes.get(`${scope}:3`)?.active), true, 'first finisher must not end the shared intro');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0xA6),
        false,
        'first finisher must not relay a cutscene end to the still-watching player'
    );
    assert.equal(Boolean(tanja.untargetable), true, 'Tanja must stay frozen until every watcher finishes');
    assert.equal(String((telahair as any).activeDungeonCutsceneScope ?? ''), '', 'first finisher must leave cutscene participant state');

    // Re-entering the still-active intro re-joins the barrier.
    telahair.sentPackets.length = 0;
    LevelHandler.handleRoomEventStart(telahair as never, buildRoomEventPayload(3));
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0xA5),
        true,
        'same-instance re-entry while intro is active must receive a fresh local intro start'
    );
    assert.equal(
        introState?.introClosedClientTokens?.has(telahair.token),
        false,
        're-joining the running intro must clear the stale closed mark'
    );
    assert.equal(String((telahair as any).activeDungeonCutsceneScope ?? ''), scope, 're-joining player must become a participant again');

    // The original trigger closes while the re-joined player still watches:
    // this is the exact live failure — the first player's close must not tear
    // down the late joiner's cutscene or unfreeze the boss.
    telahair.sentPackets.length = 0;
    LevelHandler.handleRoomClose(zeus as never, buildRoomEventPayload(3));
    assert.equal(Boolean(GlobalState.dungeonCutscenes.get(`${scope}:3`)?.active), true, 'trigger close must hold while the late joiner still watches');
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0xA6),
        false,
        'trigger close must not send a cutscene end to the late joiner mid-intro'
    );
    assert.equal(Boolean(tanja.untargetable), true, 'Tanja must stay frozen for the late joiner after the trigger finishes');

    // The last watcher closes: intro completes and the boss unfreezes.
    zeus.sentPackets.length = 0;
    LevelHandler.handleRoomClose(telahair as never, buildRoomEventPayload(3));
    assert.equal(Boolean(GlobalState.dungeonCutscenes.get(`${scope}:3`)?.completed), true, 'last close must complete the shared intro');
    assert.equal(Boolean(tanja.untargetable), false, 'Tanja must unfreeze after the shared intro finishes');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0xA6),
        false,
        'players who already finished must not receive another cutscene end at completion'
    );

    // A player entering after the finished intro is closed out immediately so
    // the local replay never runs, and the boss stays combat-ready.
    const late = createFakeClient('LateArrival', 'JC_Mini2', zeus.levelInstanceId, 88888, 3);
    setParty(zeus, telahair, late);
    attachPlayer(late);
    GlobalState.sessionsByToken.set(late.token, late as never);
    EntityHandler.sendInitialLevelEntities(late as never, late.currentLevel);
    late.sentPackets.length = 0;
    LevelHandler.handleRoomEventStart(late as never, buildRoomEventPayload(3));
    assert.equal(
        late.sentPackets.some((packet) => packet.id === 0xA5),
        false,
        'finished intro must not restart for a player entering afterwards'
    );
    assert.equal(
        late.sentPackets.some((packet) => packet.id === 0xA6),
        true,
        'player entering after the finished intro must receive an immediate close instead of a local replay'
    );
    assert.equal(Boolean(tanja.untargetable), false, 'the finished-intro skip must not re-freeze the boss');
}

// The post-death completion gate must release the stat/rank screen for the
// whole party once every expected player has acked (via room close OR its own
// level-complete report). A missing room-close from a skipped cutscene must
// not stall the gate.
async function testEastWingPostDeathCompletionGate(): Promise<void> {
    const { zeus, telahair, scope } = setupTwoPlayers('JC_Mini2', 'jc-mini2-postdeath-gate');
    (zeus as any).currentRoomId = 3;
    (telahair as any).currentRoomId = 3;

    (MissionHandler as any).ensureEastWingPostDeathGate(
        zeus,
        scope,
        { id: TANJA_CANONICAL_ID, roomId: 3 },
        'test'
    );
    const sharedState = GlobalState.levelQuestProgress.get(scope);
    assert.ok(sharedState?.bossDeathCommitted, 'gate must commit the boss death');
    assert.equal(Boolean(sharedState?.postDeathCutsceneFinished), false, 'gate should wait for player acks');
    assert.equal(
        (sharedState?.postDeathCutsceneExpectedTokens?.size ?? 0) >= 2,
        true,
        'both party members in the boss room must be expected to ack'
    );

    assert.equal(
        MissionHandler.noteEastWingPostDeathCutsceneAck(zeus as never, 3, 'room-close'),
        false,
        'gate must keep waiting while the other party member has not acked'
    );
    assert.equal(Boolean(sharedState?.postDeathCutsceneFinished), false, 'gate must not finish on the first ack');

    // The second player's own level-complete report counts as its ack even if
    // its room-close packet never arrives (e.g. it skipped the cutscene).
    assert.equal(
        MissionHandler.noteEastWingPostDeathCutsceneAck(telahair as never, 0, 'set-level-complete'),
        true,
        'level-complete ack from the last expected player must finish the gate'
    );
    assert.equal(Boolean(sharedState?.postDeathCutsceneFinished), true, 'gate must finish after all acks');
}

// Regression: if a combat packet lands while the shared boss intro cinematic
// is still active, a Flash client can restore its held boss actor afterwards
// (phantom "respawn"). The server must force-end the intro for every
// participant before boss combat/death packets land.
async function testBossDeathDuringIntroForcesCutsceneEnd(): Promise<void> {
    const instanceId = 'jc-mini2-intro-combat';
    const zeus = createFakeClient('Zeus', 'JC_Mini2', instanceId, 13933, 3);
    const telahair = createFakeClient('Telahair', 'JC_Mini2', instanceId, 63188, 3);
    setParty(zeus, telahair);
    attachPlayer(zeus);
    attachPlayer(telahair);
    GlobalState.sessionsByToken.set(zeus.token, zeus as never);
    GlobalState.sessionsByToken.set(telahair.token, telahair as never);
    EntityHandler.sendInitialLevelEntities(zeus as never, zeus.currentLevel);
    EntityHandler.sendInitialLevelEntities(telahair as never, telahair.currentLevel);
    const scope = getLevelScopeKey(zeus.currentLevel, zeus.levelInstanceId);
    assert.equal(GlobalState.partyGroups.get(7702)?.leader, 'Zeus', 'Zeus must be the party leader for this regression');

    // Party leader Zeus reaches the boss room first and starts the intro.
    LevelHandler.handleRoomEventStart(zeus as never, buildRoomEventPayload(3));
    assert.equal(Boolean(GlobalState.dungeonCutscenes.get(`${scope}:3`)?.active), true, 'boss intro should be active');
    assert.equal(String((zeus as any).activeDungeonCutsceneScope ?? ''), scope, 'leader should be an intro cutscene participant');
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0xA5),
        true,
        'non-leader must receive the shared boss intro when the leader starts it'
    );

    // Non-leader Telahair's own room-start echo must attach to the current
    // shared intro locally without bypassing state or unlocking the boss.
    telahair.sentPackets.length = 0;
    LevelHandler.handleRoomEventStart(telahair as never, buildRoomEventPayload(3));
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0xA5),
        true,
        'non-leader actual room entry must receive a local start for the active shared boss intro'
    );
    assert.equal(
        String((telahair as any).activeDungeonCutsceneScope ?? ''),
        scope,
        'non-leader must become a shared intro participant'
    );
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0xAE),
        false,
        'non-leader must not receive targeting unlocks while the shared intro is running'
    );

    // A stale/early Telahair attack packet kills Tanja while the shared intro
    // is still active; the server force-closes the intro before death packets.
    attachProxy(zeus, 530004, 'TowerGuard2', 11978, 4756, 3);
    attachProxy(telahair, 630004, 'TowerGuard2', 11978, 4756, 3);
    const tanja = GlobalState.levelEntities.get(scope)?.get(TANJA_CANONICAL_ID);
    assert.ok(tanja, 'canonical Tanja should exist');
    zeus.sentPackets.length = 0;
    telahair.sentPackets.length = 0;
    await CombatHandler.handlePowerCast(telahair as never, buildPowerCastPayload(telahair.clientEntID));
    await CombatHandler.handlePowerHit(telahair as never, buildPowerHitPayload(630004, telahair.clientEntID, 999999));

    assert.equal(tanja.dead, true, 'Tanja must die on the server');
    assert.equal(
        Boolean(GlobalState.dungeonCutscenes.get(`${scope}:3`)?.active),
        false,
        'boss intro must not stay active after the boss death'
    );
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0xA6),
        true,
        'leader must receive a forced cutscene end when the boss dies mid-intro'
    );
    assert.equal(
        telahair.sentPackets.some((packet) => packet.id === 0xA6),
        true,
        'non-leader must receive the same forced cutscene end when the boss dies mid-intro'
    );
    assert.equal(String((zeus as any).activeDungeonCutsceneScope ?? ''), '', 'leader must leave the cutscene participant state');
    assert.equal(String((telahair as any).activeDungeonCutsceneScope ?? ''), '', 'non-leader must leave the cutscene participant state');
    const cutsceneEndIndex = zeus.sentPackets.findIndex((packet) => packet.id === 0xA6);
    const deathStateIndex = zeus.sentPackets.findIndex(
        (packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === 530004 && parseEntityState(packet.payload).entState === EntityState.DEAD
    );
    assert.ok(deathStateIndex >= 0, 'leader must receive the canonical death for its local Tanja proxy');
    assert.ok(cutsceneEndIndex >= 0 && cutsceneEndIndex < deathStateIndex, 'cutscene end must be sent before the death packets');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === 530004),
        true,
        'leader local Tanja proxy must be destroyed on death'
    );

    // Respawn suppression stays intact for the leader after the forced end.
    zeus.sentPackets.length = 0;
    attachProxy(zeus, 531004, 'TowerGuard2', 11978, 4756, 3);
    assert.equal(zeus.entities.has(531004), false, 'a re-reported Tanja duplicate must not stay alive on the leader');
    assert.equal(
        zeus.sentPackets.some((packet) => packet.id === 0x0D && parseDestroy(packet.payload).entityId === 531004),
        true,
        'a re-reported Tanja duplicate must be force-destroyed for the leader'
    );
}

async function main(): Promise<void> {
    const levelEntities = new Map(GlobalState.levelEntities);
    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const levelQuestProgress = new Map(GlobalState.levelQuestProgress);
    const combatContributions = new Map(GlobalState.combatContributions);
    const entityLifeNonces = new Map(GlobalState.entityLifeNonces);
    const entityLastRewardNonces = new Map(GlobalState.entityLastRewardNonces);
    const partyByMember = new Map(GlobalState.partyByMember);
    const partyGroups = new Map(GlobalState.partyGroups);

    ensureDataLoaded();
    try {
        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        testSeedRosters();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        testHardSeedRosterAndProxyMapping();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testSharedTanjaFightDeathAndNoRespawn();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testTanjaCanonicalDeathFanoutSingleKill('Zeus', 'jc-mini2-tanja-fanout-zeus');

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testTanjaCanonicalDeathFanoutSingleKill('Telahair', 'jc-mini2-tanja-fanout-telahair');

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testStrictEastWingRejectsSeedOutsideMirrorHostiles();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testSharedProgressAndCompletionPropagation();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testCompletionWaitsForSharedPostDeathCutsceneBarrier();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testLateJoinAfterEastWingCompletionReceivesMissingStats();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        await testPostCompletionHostileDamageSuppressed();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.dungeonCutscenes.clear();
        await testBossIntroSharedLifecycle();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.dungeonCutscenes.clear();
        await testBossIntroSharedTriggerDirections();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.dungeonCutscenes.clear();
        await testNonLeaderFirstEntryStartsIntroAndBlocksBossCombat();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.dungeonCutscenes.clear();
        await testBossIntroLateJoinCloseBarrier();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.dungeonCutscenes.clear();
        await testEastWingPostDeathCompletionGate();

        GlobalState.levelEntities.clear();
        GlobalState.sessionsByToken.clear();
        GlobalState.partyByMember.clear();
        GlobalState.partyGroups.clear();
        GlobalState.dungeonCutscenes.clear();
        await testBossDeathDuringIntroForcesCutsceneEnd();

        console.log('jc_mini2_server_authority_regression: ok');
    } finally {
        GlobalState.levelEntities = levelEntities;
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.levelQuestProgress = levelQuestProgress;
        GlobalState.combatContributions = combatContributions;
        GlobalState.entityLifeNonces = entityLifeNonces;
        GlobalState.entityLastRewardNonces = entityLastRewardNonces;
        GlobalState.partyByMember = partyByMember;
        GlobalState.partyGroups = partyGroups;
    }
}

void main().catch((error) => {
    console.error('jc_mini2_server_authority_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
