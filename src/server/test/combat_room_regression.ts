import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { CombatHandler } from '../handlers/CombatHandler';
import { Entity, EntityState } from '../core/Entity';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    currentLevel: string;
    levelInstanceId?: string;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    userId: number | null;
    character: { name: string; level: number; class?: string; MasterClass?: number } | null;
    authoritativeMaxHp: number;
    authoritativeCurrentHp: number;
    processedRewardSources: Set<string>;
    pendingLoot: Map<number, any>;
    knownEntityIds: Set<number>;
    entities: Map<number, any>;
    sentPackets: SentPacket[];
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, payload: BitBuffer) => void;
};

function ensureLevelConfigLoaded(): void {
    if (!LevelConfig.has('TutorialDungeon')) {
        LevelConfig.load(path.resolve(__dirname, '../data'));
    }
}

function createFakeClient(token: number, name: string, roomId: number): FakeClient {
    const sentPackets: SentPacket[] = [];

    return {
        token,
        currentLevel: 'BridgeTown',
        levelInstanceId: '',
        currentRoomId: roomId,
        playerSpawned: true,
        clientEntID: token + 1000,
        userId: token,
        character: { name, level: 10, class: 'mage', MasterClass: 0 },
        authoritativeMaxHp: 100,
        authoritativeCurrentHp: 100,
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entities: new Map<number, any>(),
        sentPackets,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, payload: BitBuffer) {
            sentPackets.push({ id, payload: payload.toBuffer() });
        }
    };
}

type PowerCastPayloadOptions = {
    hasTargetEntity?: boolean;
    hasTargetPos?: boolean;
    targetX?: number;
    targetY?: number;
    isProjectile?: boolean;
    projectileId?: number;
    isPersistent?: boolean;
    hasComboData?: boolean;
    comboIsMelee?: boolean;
    comboId?: number;
};

function buildPowerCastPayload(sourceId: number, powerId: number, options: PowerCastPayloadOptions = {}): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(sourceId);
    bb.writeMethod4(powerId);
    bb.writeMethod15(Boolean(options.hasTargetEntity));
    bb.writeMethod15(Boolean(options.hasTargetPos));
    if (options.hasTargetPos) {
        bb.writeMethod24(Math.round(options.targetX ?? 0));
        bb.writeMethod24(Math.round(options.targetY ?? 0));
    }
    bb.writeMethod15(Boolean(options.isProjectile));
    if (options.isProjectile) {
        bb.writeMethod4(Math.max(0, Math.round(options.projectileId ?? 1)));
    }
    bb.writeMethod15(Boolean(options.isPersistent));
    bb.writeMethod15(Boolean(options.hasComboData));
    if (options.hasComboData) {
        bb.writeMethod15(Boolean(options.comboIsMelee));
        bb.writeMethod4(Math.max(0, Math.round(options.comboId ?? 1)));
    }
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function buildPowerHitPayload(targetId: number, sourceId: number, damage: number, powerId: number): Buffer {
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

function buildPlayerEntity(session: FakeClient): any {
    return {
        ...Entity.fromCharacter(session.clientEntID, session.character as any, {
            x: 0,
            y: 0,
            team: 1,
            entState: EntityState.ACTIVE,
            roomId: session.currentRoomId
        }),
        ownerToken: session.token,
        ownerUserId: session.userId ?? 0,
        roomId: session.currentRoomId,
        hp: session.authoritativeCurrentHp,
        maxHp: session.authoritativeMaxHp
    };
}

function attachPlayerEntity(session: FakeClient): void {
    const entity = buildPlayerEntity(session);
    session.entities.set(session.clientEntID, entity);
    session.knownEntityIds.add(session.clientEntID);

    const levelScope = getClientLevelScope(session as never);
    let levelMap = GlobalState.levelEntities.get(levelScope);
    if (!levelMap) {
        levelMap = new Map<number, any>();
        GlobalState.levelEntities.set(levelScope, levelMap);
    }
    levelMap.set(session.clientEntID, entity);
}

function parseDestroyEntityId(payload: Buffer): number {
    const br = new BitReader(payload);
    return br.readMethod4();
}

function parsePowerHitDamage(payload: Buffer): number {
    const br = new BitReader(payload);
    br.readMethod4();
    br.readMethod4();
    return br.readMethod24();
}

function parsePowerCastPayload(payload: Buffer): {
    sourceId: number;
    powerId: number;
    hasTargetEntity: boolean;
    hasTargetPos: boolean;
    targetX: number | null;
    targetY: number | null;
    projectileId: number | null;
    isPersistent: boolean;
    comboIsMelee: boolean | null;
    comboId: number | null;
} {
    const br = new BitReader(payload);
    const sourceId = br.readMethod4();
    const powerId = br.readMethod4();
    const hasTargetEntity = br.readMethod15();
    const hasTargetPos = br.readMethod15();
    const targetX = hasTargetPos ? br.readMethod24() : null;
    const targetY = hasTargetPos ? br.readMethod24() : null;
    const projectileId = br.readMethod15() ? br.readMethod4() : null;
    const isPersistent = br.readMethod15();
    const hasComboData = br.readMethod15();
    const comboIsMelee = hasComboData ? br.readMethod15() : null;
    const comboId = hasComboData ? br.readMethod4() : null;

    return {
        sourceId,
        powerId,
        hasTargetEntity,
        hasTargetPos,
        targetX,
        targetY,
        projectileId,
        isPersistent,
        comboIsMelee,
        comboId
    };
}

async function testPowerCastReachesPartyAcrossRooms(): Promise<void> {
    const sender = createFakeClient(100, 'Alpha', 3);
    const partyOtherRoom = createFakeClient(101, 'Beta', 7);
    const sameRoomStranger = createFakeClient(102, 'Gamma', 3);
    const otherRoomStranger = createFakeClient(103, 'Delta', 9);

    attachPlayerEntity(sender);
    attachPlayerEntity(partyOtherRoom);
    attachPlayerEntity(sameRoomStranger);
    attachPlayerEntity(otherRoomStranger);

    GlobalState.partyByMember.set('alpha', 1);
    GlobalState.partyByMember.set('beta', 1);

    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(partyOtherRoom.token, partyOtherRoom as never);
    GlobalState.sessionsByToken.set(sameRoomStranger.token, sameRoomStranger as never);
    GlobalState.sessionsByToken.set(otherRoomStranger.token, otherRoomStranger as never);

    await CombatHandler.handlePowerCast(sender as never, buildPowerCastPayload(sender.clientEntID, 77));

    assert.deepEqual(
        partyOtherRoom.sentPackets.map((packet) => packet.id),
        [0x0F, 0x09],
        'party mate in another room should receive seed + cast'
    );
    assert.deepEqual(
        sameRoomStranger.sentPackets.map((packet) => packet.id),
        [0x0F, 0x09],
        'non-party player in same room should still receive cast'
    );
    assert.equal(otherRoomStranger.sentPackets.length, 0, 'non-party player in another room should not receive cast');
}

async function testDirectTargetPowerCastGetsSafeTargetPos(): Promise<void> {
    const sender = createFakeClient(110, 'Alpha', 3);
    const partyOtherRoom = createFakeClient(111, 'Beta', 7);
    const sameRoomStranger = createFakeClient(112, 'Gamma', 3);

    attachPlayerEntity(sender);
    attachPlayerEntity(partyOtherRoom);
    attachPlayerEntity(sameRoomStranger);

    const senderEntity = sender.entities.get(sender.clientEntID);
    if (senderEntity) {
        senderEntity.x = 100;
        senderEntity.y = 200;
        senderEntity.facingLeft = false;
    }
    GlobalState.levelEntities.get(getClientLevelScope(sender as never))?.set(sender.clientEntID, senderEntity);

    const hostile = {
        id: 6101,
        name: 'IntroGoblin',
        isPlayer: false,
        x: 260,
        y: 210,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        roomId: sender.currentRoomId,
        hp: 100
    };
    GlobalState.levelEntities.get(getClientLevelScope(sender as never))?.set(hostile.id, hostile);

    GlobalState.partyByMember.set('alpha', 4);
    GlobalState.partyByMember.set('beta', 4);

    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(partyOtherRoom.token, partyOtherRoom as never);
    GlobalState.sessionsByToken.set(sameRoomStranger.token, sameRoomStranger as never);

    await CombatHandler.handlePowerCast(
        sender as never,
        buildPowerCastPayload(sender.clientEntID, 1703, {
            hasTargetEntity: true,
            hasComboData: true,
            comboIsMelee: true,
            comboId: 2
        })
    );

    assert.deepEqual(
        partyOtherRoom.sentPackets.map((packet) => packet.id),
        [0x0F, 0x09],
        'party mate should receive a safe relayed cast for direct-target melee powers'
    );
    assert.deepEqual(
        sameRoomStranger.sentPackets.map((packet) => packet.id),
        [0x0F, 0x09],
        'same-room viewers should also receive the safe relayed cast'
    );

    const partyCast = parsePowerCastPayload(partyOtherRoom.sentPackets[1]!.payload);
    assert.equal(partyCast.sourceId, sender.clientEntID);
    assert.equal(partyCast.powerId, 1703);
    assert.equal(partyCast.hasTargetEntity, true);
    assert.equal(partyCast.hasTargetPos, true, 'direct-target cast should gain a synthetic target point');
    assert.equal(partyCast.targetX, hostile.x);
    assert.equal(partyCast.targetY, hostile.y);
    assert.equal(partyCast.comboIsMelee, true);
    assert.equal(partyCast.comboId, 2, 'melee combo data should be preserved');
}

async function testUnsafeRangedDirectTargetPowerCastStillSuppresses(): Promise<void> {
    const sender = createFakeClient(113, 'Alpha', 3);
    const partyOtherRoom = createFakeClient(114, 'Beta', 7);
    const sameRoomStranger = createFakeClient(115, 'Gamma', 3);

    attachPlayerEntity(sender);
    attachPlayerEntity(partyOtherRoom);
    attachPlayerEntity(sameRoomStranger);

    GlobalState.partyByMember.set('alpha', 5);
    GlobalState.partyByMember.set('beta', 5);

    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(partyOtherRoom.token, partyOtherRoom as never);
    GlobalState.sessionsByToken.set(sameRoomStranger.token, sameRoomStranger as never);

    await CombatHandler.handlePowerCast(
        sender as never,
        buildPowerCastPayload(sender.clientEntID, 362, {
            hasTargetEntity: true
        })
    );

    assert.equal(
        partyOtherRoom.sentPackets.some((packet) => packet.id === 0x09 || packet.id === 0x0F),
        false,
        'target-dependent ranged powers should stay suppressed because the protocol does not include the target entity id'
    );
    assert.equal(
        sameRoomStranger.sentPackets.some((packet) => packet.id === 0x09 || packet.id === 0x0F),
        false,
        'same-room viewers should also skip unsafe target-dependent ranged casts'
    );
}

async function testPowerHitFollowsPartyAudience(): Promise<void> {
    const sender = createFakeClient(200, 'Alpha', 1);
    const partyOtherRoom = createFakeClient(201, 'Beta', 5);
    const sameRoomStranger = createFakeClient(202, 'Gamma', 1);
    const otherRoomStranger = createFakeClient(203, 'Delta', 8);

    sender.currentLevel = 'TutorialDungeon';
    partyOtherRoom.currentLevel = 'TutorialDungeon';
    sameRoomStranger.currentLevel = 'TutorialDungeon';
    otherRoomStranger.currentLevel = 'TutorialDungeon';

    attachPlayerEntity(sender);
    attachPlayerEntity(partyOtherRoom);
    attachPlayerEntity(sameRoomStranger);
    attachPlayerEntity(otherRoomStranger);

    GlobalState.partyByMember.set('alpha', 1);
    GlobalState.partyByMember.set('beta', 1);

    const hostile = {
        id: 5001,
        name: 'SharedGoblin',
        isPlayer: false,
        x: 10,
        y: 15,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: sender.token,
        summonerId: sender.clientEntID,
        roomId: sender.currentRoomId,
        hp: 100
    };
    GlobalState.levelEntities.get(getClientLevelScope(sender as never))?.set(hostile.id, hostile);

    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(partyOtherRoom.token, partyOtherRoom as never);
    GlobalState.sessionsByToken.set(sameRoomStranger.token, sameRoomStranger as never);
    GlobalState.sessionsByToken.set(otherRoomStranger.token, otherRoomStranger as never);

    await CombatHandler.handlePowerHit(sender as never, buildPowerHitPayload(hostile.id, sender.clientEntID, 42, 77));

    assert.equal(partyOtherRoom.sentPackets.some((packet) => packet.id === 0x0A), true);
    assert.equal(sameRoomStranger.sentPackets.some((packet) => packet.id === 0x0A), false);
    assert.equal(otherRoomStranger.sentPackets.some((packet) => packet.id === 0x0A), false);
}

async function testBakedOutdoorHostileHitsReachPartyMirrorsOnly(): Promise<void> {
    const sender = createFakeClient(210, 'Alpha', 1);
    const partyOtherRoom = createFakeClient(211, 'Beta', 5);
    const sameRoomStranger = createFakeClient(212, 'Gamma', 1);

    sender.currentLevel = 'NewbieRoad';
    partyOtherRoom.currentLevel = 'NewbieRoad';
    sameRoomStranger.currentLevel = 'NewbieRoad';

    attachPlayerEntity(sender);
    attachPlayerEntity(partyOtherRoom);
    attachPlayerEntity(sameRoomStranger);

    GlobalState.partyByMember.set('alpha', 3);
    GlobalState.partyByMember.set('beta', 3);

    const hostile = {
        id: 5101,
        name: 'IntroGoblin',
        isPlayer: false,
        x: 15,
        y: 25,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: sender.token,
        roomId: sender.currentRoomId,
        hp: 100
    };
    GlobalState.levelEntities.get(getClientLevelScope(sender as never))?.set(hostile.id, hostile);
    partyOtherRoom.entities.set(hostile.id, { ...hostile, ownerToken: partyOtherRoom.token, roomId: partyOtherRoom.currentRoomId });
    partyOtherRoom.knownEntityIds.add(hostile.id);
    sameRoomStranger.entities.set(hostile.id, { ...hostile, ownerToken: sameRoomStranger.token, roomId: sameRoomStranger.currentRoomId });
    sameRoomStranger.knownEntityIds.add(hostile.id);

    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(partyOtherRoom.token, partyOtherRoom as never);
    GlobalState.sessionsByToken.set(sameRoomStranger.token, sameRoomStranger as never);

    await CombatHandler.handlePowerHit(sender as never, buildPowerHitPayload(hostile.id, sender.clientEntID, 42, 77));

    assert.equal(
        partyOtherRoom.sentPackets.some((packet) => packet.id === 0x0A || packet.id === 0x0F),
        true,
        'party mates with a matching local outdoor mob should receive the combat sync without a remote spawn packet'
    );
    assert.equal(
        sameRoomStranger.sentPackets.some((packet) => packet.id === 0x0A || packet.id === 0x0F),
        false,
        'same-room strangers should still not receive baked hostile combat packets'
    );
}

async function testHostileHitsLeavePlayersAliveAndStayRoomScoped(): Promise<void> {
    const victim = createFakeClient(300, 'Victim', 2);
    const sameRoomWatcher = createFakeClient(303, 'WatcherSameRoom', 2);
    const partyOtherRoom = createFakeClient(301, 'Buddy', 7);
    const otherRoomStranger = createFakeClient(302, 'Watcher', 9);

    attachPlayerEntity(victim);
    attachPlayerEntity(sameRoomWatcher);
    attachPlayerEntity(partyOtherRoom);
    attachPlayerEntity(otherRoomStranger);

    GlobalState.partyByMember.set('victim', 2);
    GlobalState.partyByMember.set('buddy', 2);

    const npc = {
        id: 8123,
        name: 'EnemyGoblin',
        isPlayer: false,
        x: 20,
        y: 20,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        roomId: victim.currentRoomId,
        hp: 100
    };
    GlobalState.levelEntities.get(getClientLevelScope(victim as never))?.set(npc.id, npc);

    GlobalState.sessionsByToken.set(victim.token, victim as never);
    GlobalState.sessionsByToken.set(sameRoomWatcher.token, sameRoomWatcher as never);
    GlobalState.sessionsByToken.set(partyOtherRoom.token, partyOtherRoom as never);
    GlobalState.sessionsByToken.set(otherRoomStranger.token, otherRoomStranger as never);

    await CombatHandler.handlePowerHit(victim as never, buildPowerHitPayload(victim.clientEntID, npc.id, 120, 55));

    const victimEntity = victim.entities.get(victim.clientEntID);
    assert.equal(victim.authoritativeCurrentHp, 1);
    assert.equal(victimEntity?.dead, false);
    assert.equal(victimEntity?.entState, EntityState.ACTIVE);
    assert.equal(
        sameRoomWatcher.sentPackets.some((packet) => packet.id === 0x0F),
        true,
        'same-room watchers should be seeded before receiving hostile combat packets'
    );
    assert.equal(sameRoomWatcher.sentPackets.some((packet) => packet.id === 0x3A), true);
    assert.equal(sameRoomWatcher.sentPackets.some((packet) => packet.id === 0x0A), true);
    assert.equal(
        sameRoomWatcher.sentPackets.some((packet) => packet.id === 0x07),
        false,
        'hostile hits should not broadcast a death state when the player is clamped at 1 HP'
    );
    const victimHitPacket = victim.sentPackets.find((packet) => packet.id === 0x0A);
    const watcherHitPacket = sameRoomWatcher.sentPackets.find((packet) => packet.id === 0x0A);
    assert.notEqual(victimHitPacket, undefined, 'local player should receive the hostile hit packet');
    assert.notEqual(watcherHitPacket, undefined, 'same-room viewers should receive the hostile hit packet');
    assert.equal(
        parsePowerHitDamage(victimHitPacket!.payload),
        99,
        'local player should receive the clamped damage value instead of a lethal hit'
    );
    assert.equal(
        parsePowerHitDamage(watcherHitPacket!.payload),
        99,
        'same-room viewers should receive the same clamped damage value for synchronization'
    );
    assert.equal(
        victim.sentPackets.some((packet) => packet.id === 0x07),
        false,
        'local player should not receive its own 0x07 state echo because the Flash client treats it as a remote entity update'
    );
    assert.equal(
        partyOtherRoom.sentPackets.some((packet) => packet.id === 0x0A || packet.id === 0x3A || packet.id === 0x07),
        false,
        'party members in a different room should not receive hostile NPC combat packets from outside their room'
    );
    assert.equal(otherRoomStranger.sentPackets.some((packet) => packet.id === 0x3A), false);

    const incoming = new BitBuffer(false);
    incoming.writeMethod4(victim.clientEntID);
    incoming.writeMethod24(11240);
    incoming.writeMethod15(false);

    await CombatHandler.handleRespawnBroadcast(victim as never, incoming.toBuffer());

    assert.equal(victim.authoritativeCurrentHp, 11240);
    assert.equal(victim.entities.get(victim.clientEntID)?.dead, false);
    assert.equal(sameRoomWatcher.sentPackets.some((packet) => packet.id === 0x82), true);
    assert.equal(otherRoomStranger.sentPackets.some((packet) => packet.id === 0x82), true);
}

async function testEntityDestroyClearsKnownEntityCache(): Promise<void> {
    const sender = createFakeClient(400, 'Alpha', 2);
    const watcher = createFakeClient(401, 'Beta', 2);

    sender.currentLevel = 'TutorialDungeon';
    watcher.currentLevel = 'TutorialDungeon';

    attachPlayerEntity(sender);
    attachPlayerEntity(watcher);
    GlobalState.partyByMember.set('alpha', 7);
    GlobalState.partyByMember.set('beta', 7);

    const hostile = {
        id: 9300,
        name: 'SharedGoblin',
        isPlayer: false,
        x: 0,
        y: 0,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: sender.token,
        summonerId: sender.clientEntID,
        roomId: sender.currentRoomId
    };
    GlobalState.levelEntities.get(getClientLevelScope(sender as never))?.set(hostile.id, hostile);
    watcher.entities.set(hostile.id, { ...hostile, ownerToken: watcher.token, roomId: watcher.currentRoomId });
    watcher.knownEntityIds.add(hostile.id);

    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(watcher.token, watcher as never);

    const bb = new BitBuffer(false);
    bb.writeMethod4(hostile.id);
    bb.writeMethod15(false);
    await CombatHandler.handleEntityDestroy(sender as never, bb.toBuffer());

    assert.equal(watcher.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntityId(packet.payload) === hostile.id), true);
    assert.equal(watcher.knownEntityIds.has(hostile.id), false);
}

async function testOutdoorEntityDestroyReachesPartyMirrorsOnly(): Promise<void> {
    const sender = createFakeClient(410, 'Alpha', 1);
    const partyOtherRoom = createFakeClient(411, 'Beta', 5);
    const sameRoomStranger = createFakeClient(412, 'Gamma', 1);

    sender.currentLevel = 'NewbieRoad';
    partyOtherRoom.currentLevel = 'NewbieRoad';
    sameRoomStranger.currentLevel = 'NewbieRoad';

    attachPlayerEntity(sender);
    attachPlayerEntity(partyOtherRoom);
    attachPlayerEntity(sameRoomStranger);

    GlobalState.partyByMember.set('alpha', 6);
    GlobalState.partyByMember.set('beta', 6);

    const hostile = {
        id: 9401,
        name: 'IntroGoblin',
        isPlayer: false,
        x: 15,
        y: 25,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: sender.token,
        roomId: sender.currentRoomId
    };
    GlobalState.levelEntities.get(getClientLevelScope(sender as never))?.set(hostile.id, hostile);
    partyOtherRoom.entities.set(hostile.id, { ...hostile, ownerToken: partyOtherRoom.token, roomId: partyOtherRoom.currentRoomId });
    sameRoomStranger.entities.set(hostile.id, { ...hostile, ownerToken: sameRoomStranger.token, roomId: sameRoomStranger.currentRoomId });

    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(partyOtherRoom.token, partyOtherRoom as never);
    GlobalState.sessionsByToken.set(sameRoomStranger.token, sameRoomStranger as never);

    const bb = new BitBuffer(false);
    bb.writeMethod4(hostile.id);
    bb.writeMethod15(false);
    await CombatHandler.handleEntityDestroy(sender as never, bb.toBuffer());

    assert.equal(
        partyOtherRoom.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntityId(packet.payload) === hostile.id),
        true,
        'party mates with a matching local outdoor mob should receive the destroy sync'
    );
    assert.equal(
        sameRoomStranger.sentPackets.some((packet) => packet.id === 0x0D),
        false,
        'non-party players should not receive outdoor destroy sync from another client'
    );
    assert.equal(partyOtherRoom.entities.has(hostile.id), false, 'party mirror should be cleared from the server-side session cache');
    assert.equal(sameRoomStranger.entities.has(hostile.id), true, 'non-party local mirrors should stay untouched');
}

async function testDungeonCombatDoesNotCrossInstanceScopes(): Promise<void> {
    const sender = createFakeClient(500, 'Alpha', 1);
    const stranger = createFakeClient(501, 'Beta', 1);

    sender.currentLevel = 'TutorialDungeon';
    sender.levelInstanceId = 'run-a';
    stranger.currentLevel = 'TutorialDungeon';
    stranger.levelInstanceId = 'run-b';

    attachPlayerEntity(sender);
    attachPlayerEntity(stranger);

    const hostile = {
        id: 9501,
        name: 'SoloGoblin',
        isPlayer: false,
        x: 10,
        y: 15,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: sender.token,
        summonerId: sender.clientEntID,
        roomId: sender.currentRoomId,
        hp: 100
    };
    GlobalState.levelEntities.get(getClientLevelScope(sender as never))?.set(hostile.id, hostile);

    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(stranger.token, stranger as never);

    await CombatHandler.handlePowerHit(sender as never, buildPowerHitPayload(hostile.id, sender.clientEntID, 42, 77));

    assert.equal(
        stranger.sentPackets.some((packet) => packet.id === 0x0A || packet.id === 0x0F),
        false,
        'players in different dungeon instances should not receive each other\'s combat sync'
    );
}

async function main(): Promise<void> {
    ensureLevelConfigLoaded();

    const sessionsByToken = new Map(GlobalState.sessionsByToken);
    const levelEntities = new Map(GlobalState.levelEntities);
    const partyByMember = new Map(GlobalState.partyByMember);
    const combatContributions = new Map(GlobalState.combatContributions);
    const entityLifeNonces = new Map(GlobalState.entityLifeNonces);
    const entityLastRewardNonces = new Map(GlobalState.entityLastRewardNonces);

    GlobalState.sessionsByToken.clear();
    GlobalState.levelEntities.clear();
    GlobalState.partyByMember.clear();
    GlobalState.combatContributions.clear();
    GlobalState.entityLifeNonces.clear();
    GlobalState.entityLastRewardNonces.clear();

    try {
        await testPowerCastReachesPartyAcrossRooms();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testDirectTargetPowerCastGetsSafeTargetPos();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testUnsafeRangedDirectTargetPowerCastStillSuppresses();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testPowerHitFollowsPartyAudience();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testBakedOutdoorHostileHitsReachPartyMirrorsOnly();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testHostileHitsLeavePlayersAliveAndStayRoomScoped();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testEntityDestroyClearsKnownEntityCache();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testOutdoorEntityDestroyReachesPartyMirrorsOnly();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testDungeonCombatDoesNotCrossInstanceScopes();
    } finally {
        GlobalState.sessionsByToken = sessionsByToken;
        GlobalState.levelEntities = levelEntities;
        GlobalState.partyByMember = partyByMember;
        GlobalState.combatContributions = combatContributions;
        GlobalState.entityLifeNonces = entityLifeNonces;
        GlobalState.entityLastRewardNonces = entityLastRewardNonces;
    }

    console.log('combat_room_regression: ok');
}

void main().catch((error) => {
    console.error('combat_room_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
