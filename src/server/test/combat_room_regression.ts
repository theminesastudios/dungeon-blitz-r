import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { CombatHandler } from '../handlers/CombatHandler';
import { Entity, EntityState } from '../core/Entity';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';

const NEPHIT_QUEST_LEVELS = ['GhostBossDungeon', 'GhostBossDungeonHard'] as const;

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

function parseEntityStateId(payload: Buffer): number {
    const br = new BitReader(payload);
    return br.readMethod4();
}

function parsePowerHitDamage(payload: Buffer): number {
    const br = new BitReader(payload);
    br.readMethod4();
    br.readMethod4();
    return br.readMethod24();
}

function parsePowerHitTargetId(payload: Buffer): number {
    const br = new BitReader(payload);
    return br.readMethod4();
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

async function testTutorialDungeonUnknownSourcePowerCastIsIgnored(): Promise<void> {
    const roomCreator = createFakeClient(116, 'Alpha', 1);
    const joiner = createFakeClient(117, 'Beta', 1);

    roomCreator.currentLevel = 'TutorialDungeon';
    joiner.currentLevel = 'TutorialDungeon';
    roomCreator.levelInstanceId = 'tutorial-shared';
    joiner.levelInstanceId = 'tutorial-shared';

    attachPlayerEntity(roomCreator);
    attachPlayerEntity(joiner);
    GlobalState.partyByMember.set('alpha', 6);
    GlobalState.partyByMember.set('beta', 6);
    GlobalState.sessionsByToken.set(roomCreator.token, roomCreator as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);

    await CombatHandler.handlePowerCast(roomCreator as never, buildPowerCastPayload(991001, 77));

    assert.equal(
        joiner.sentPackets.some((packet) => packet.id === 0x09 || packet.id === 0x0F),
        false,
        'tutorial remote-cast re-entry with an unknown helper/projectile source should not be relayed again'
    );
}

async function testPowerHitFollowsPartyAudience(): Promise<void> {
    const sender = createFakeClient(200, 'Alpha', 1);
    const partyOtherRoom = createFakeClient(201, 'Beta', 5);
    const sameRoomStranger = createFakeClient(202, 'Gamma', 1);
    const otherRoomStranger = createFakeClient(203, 'Delta', 8);

    sender.currentLevel = 'GoblinRiverDungeon';
    partyOtherRoom.currentLevel = 'GoblinRiverDungeon';
    sameRoomStranger.currentLevel = 'GoblinRiverDungeon';
    otherRoomStranger.currentLevel = 'GoblinRiverDungeon';

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

async function testRemotePlayerPowerHitIsIgnored(): Promise<void> {
    const owner = createFakeClient(205, 'Alpha', 1);
    const mirror = createFakeClient(206, 'Beta', 1);

    owner.currentLevel = 'GoblinRiverDungeon';
    mirror.currentLevel = 'GoblinRiverDungeon';

    attachPlayerEntity(owner);
    attachPlayerEntity(mirror);

    GlobalState.partyByMember.set('alpha', 12);
    GlobalState.partyByMember.set('beta', 12);

    const hostile = {
        id: 5051,
        name: 'SharedGoblin',
        isPlayer: false,
        x: 10,
        y: 15,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: owner.token,
        roomId: owner.currentRoomId,
        hp: 100,
        maxHp: 100
    };
    GlobalState.levelEntities.get(getClientLevelScope(owner as never))?.set(hostile.id, hostile);

    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(mirror.token, mirror as never);

    await CombatHandler.handlePowerHit(mirror as never, buildPowerHitPayload(hostile.id, owner.clientEntID, 40, 77));

    assert.equal(hostile.hp, 100, 'remote client should not be allowed to apply another player source hit');
    assert.equal(owner.sentPackets.some((packet) => packet.id === 0x0A), false);
    assert.equal(mirror.sentPackets.some((packet) => packet.id === 0x0A), false);

    await CombatHandler.handlePowerHit(owner as never, buildPowerHitPayload(hostile.id, owner.clientEntID, 40, 77));

    assert.equal(hostile.hp, 60, 'owning player hit should still apply once');
    assert.equal(mirror.sentPackets.some((packet) => packet.id === 0x0A), true);
}

async function testForeignOwnedPowerHitSourceIsIgnored(): Promise<void> {
    const creator = createFakeClient(207, 'Creator', 1);
    const joiner = createFakeClient(208, 'Joiner', 1);

    creator.currentLevel = 'GoblinRiverDungeon';
    joiner.currentLevel = 'GoblinRiverDungeon';
    creator.levelInstanceId = 'party-run';
    joiner.levelInstanceId = 'party-run';

    attachPlayerEntity(creator);
    attachPlayerEntity(joiner);
    GlobalState.partyByMember.set('creator', 19);
    GlobalState.partyByMember.set('joiner', 19);

    const creatorOwnedHelper = {
        id: 5071,
        name: 'MageHelper',
        isPlayer: false,
        x: 100,
        y: 200,
        v: 0,
        team: 1,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: creator.token,
        summonerId: creator.clientEntID,
        roomId: creator.currentRoomId
    };
    const hostile = {
        id: 5072,
        name: 'GoblinClub',
        isPlayer: false,
        x: 140,
        y: 200,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: creator.token,
        ownerPartyId: 19,
        roomId: creator.currentRoomId,
        hp: 50,
        maxHp: 50
    };

    const levelMap = GlobalState.levelEntities.get(getClientLevelScope(creator as never));
    levelMap?.set(creatorOwnedHelper.id, creatorOwnedHelper);
    levelMap?.set(hostile.id, hostile);
    creator.knownEntityIds.add(creatorOwnedHelper.id);
    creator.knownEntityIds.add(hostile.id);
    joiner.knownEntityIds.add(creatorOwnedHelper.id);
    joiner.knownEntityIds.add(hostile.id);
    GlobalState.sessionsByToken.set(creator.token, creator as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);

    await CombatHandler.handlePowerHit(joiner as never, buildPowerHitPayload(hostile.id, creatorOwnedHelper.id, 50, 77));

    assert.equal(hostile.hp, 50, 'joiner packets cannot apply damage through a creator-owned source entity');
    assert.equal((hostile as any).dead, undefined);
    assert.equal(creator.sentPackets.some((packet) => packet.id === 0x0A), false);
    assert.equal(joiner.sentPackets.some((packet) => packet.id === 0x0A), false);
}

async function testPartySharedHostileHitDoesNotEchoToNonOwnerAttacker(): Promise<void> {
    const creator = createFakeClient(209, 'Creator', 1);
    const joiner = createFakeClient(210, 'Joiner', 1);

    creator.currentLevel = 'GoblinRiverDungeon';
    joiner.currentLevel = 'GoblinRiverDungeon';
    creator.levelInstanceId = 'party-run';
    joiner.levelInstanceId = 'party-run';

    attachPlayerEntity(creator);
    attachPlayerEntity(joiner);
    GlobalState.partyByMember.set('creator', 20);
    GlobalState.partyByMember.set('joiner', 20);

    const hostile = {
        id: 5073,
        name: 'GoblinClub',
        isPlayer: false,
        x: 140,
        y: 200,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: creator.token,
        ownerPartyId: 20,
        roomId: creator.currentRoomId,
        hp: 1000,
        maxHp: 1000
    };

    GlobalState.levelEntities.get(getClientLevelScope(creator as never))?.set(hostile.id, hostile);
    creator.knownEntityIds.add(hostile.id);
    joiner.knownEntityIds.add(hostile.id);
    GlobalState.sessionsByToken.set(creator.token, creator as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);

    await CombatHandler.handlePowerHit(joiner as never, buildPowerHitPayload(hostile.id, joiner.clientEntID, 400, 77));

    assert.equal(hostile.hp, 600);
    assert.equal((hostile as any).dead, false);
    assert.equal(
        joiner.sentPackets.some((packet) => packet.id === 0x0A && parsePowerHitTargetId(packet.payload) === hostile.id),
        false,
        'non-owner attacker should not receive its own hit back and double-apply local damage'
    );
    assert.equal(
        creator.sentPackets.some((packet) => packet.id === 0x0A && parsePowerHitTargetId(packet.payload) === hostile.id),
        true,
        'room creator still receives the shared hostile hit'
    );
}

async function testPrematureSharedHostileDestroyIsRejectedWhileServerHpPositive(): Promise<void> {
    const creator = createFakeClient(211, 'Creator', 1);
    const joiner = createFakeClient(212, 'Joiner', 1);

    creator.currentLevel = 'GoblinRiverDungeon';
    joiner.currentLevel = 'GoblinRiverDungeon';
    creator.levelInstanceId = 'party-run';
    joiner.levelInstanceId = 'party-run';

    attachPlayerEntity(creator);
    attachPlayerEntity(joiner);
    GlobalState.partyByMember.set('creator', 21);
    GlobalState.partyByMember.set('joiner', 21);

    const hostile = {
        id: 5074,
        name: 'GoblinClub',
        isPlayer: false,
        x: 140,
        y: 200,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: creator.token,
        ownerPartyId: 21,
        roomId: creator.currentRoomId,
        hp: 600,
        maxHp: 1000
    };

    GlobalState.levelEntities.get(getClientLevelScope(creator as never))?.set(hostile.id, hostile);
    creator.knownEntityIds.add(hostile.id);
    joiner.knownEntityIds.add(hostile.id);
    GlobalState.sessionsByToken.set(creator.token, creator as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);

    const destroy = new BitBuffer(false);
    destroy.writeMethod4(hostile.id);
    destroy.writeMethod15(false);
    await CombatHandler.handleEntityDestroy(joiner as never, destroy.toBuffer());

    assert.equal(GlobalState.levelEntities.get(getClientLevelScope(creator as never))?.has(hostile.id), true);
    assert.equal(hostile.hp, 600);
    assert.equal((hostile as any).dead, undefined);
    assert.equal(
        creator.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntityId(packet.payload) === hostile.id),
        false,
        'premature client destroy should not be relayed while authoritative enemy HP is still positive'
    );
}

async function testBakedOutdoorHostileHitsStayOwnerLocal(): Promise<void> {
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
        false,
        'party mates should not receive private outdoor hostile combat sync'
    );
    assert.equal(
        sameRoomStranger.sentPackets.some((packet) => packet.id === 0x0A || packet.id === 0x0F),
        false,
        'same-room strangers should still not receive private outdoor hostile combat packets'
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
        ownerToken: victim.token,
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
    assert.equal(
        sameRoomWatcher.sentPackets.some((packet) => packet.id === 0x3A),
        false,
        'hostile hits should not emit a separate HP delta because the power-hit packet already drives the client damage display'
    );
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
        victim.sentPackets.some((packet) => packet.id === 0x3A),
        false,
        'local player should only receive the hostile power-hit packet so the damage is shown once'
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

async function testHostileHitsDoNotEchoPowerHitBackToLocalVictimWhenDamageMatches(): Promise<void> {
    const victim = createFakeClient(320, 'VictimEcho', 2);
    const sameRoomWatcher = createFakeClient(321, 'WatcherEcho', 2);
    const otherRoomWatcher = createFakeClient(322, 'WatcherOther', 9);

    attachPlayerEntity(victim);
    attachPlayerEntity(sameRoomWatcher);
    attachPlayerEntity(otherRoomWatcher);

    const npc = {
        id: 8124,
        name: 'EnemyGoblinLite',
        isPlayer: false,
        x: 24,
        y: 20,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: victim.token,
        roomId: victim.currentRoomId,
        hp: 100
    };
    GlobalState.levelEntities.get(getClientLevelScope(victim as never))?.set(npc.id, npc);

    GlobalState.sessionsByToken.set(victim.token, victim as never);
    GlobalState.sessionsByToken.set(sameRoomWatcher.token, sameRoomWatcher as never);
    GlobalState.sessionsByToken.set(otherRoomWatcher.token, otherRoomWatcher as never);

    await CombatHandler.handlePowerHit(victim as never, buildPowerHitPayload(victim.clientEntID, npc.id, 1, 55));

    assert.equal(
        victim.sentPackets.some((packet) => packet.id === 0x0A),
        false,
        'the local victim already simulated the hostile hit and should not receive a duplicate power-hit echo'
    );
    assert.equal(
        victim.sentPackets.some((packet) => packet.id === 0x3A),
        false,
        'matching hostile damage should not need a follow-up HP correction packet'
    );
    assert.equal(
        sameRoomWatcher.sentPackets.some((packet) => packet.id === 0x0A),
        true,
        'same-room viewers still need the hostile hit for synchronization'
    );
    assert.equal(
        otherRoomWatcher.sentPackets.some((packet) => packet.id === 0x0A || packet.id === 0x3A),
        false,
        'other rooms should still stay isolated from hostile combat packets'
    );
}

async function testRemoteHostileHitAgainstPlayerIsIgnored(): Promise<void> {
    const victim = createFakeClient(330, 'VictimAuthority', 2);
    const mirror = createFakeClient(331, 'MirrorAuthority', 2);

    attachPlayerEntity(victim);
    attachPlayerEntity(mirror);

    const npc = {
        id: 8130,
        name: 'EnemyGoblinAuthority',
        isPlayer: false,
        x: 24,
        y: 20,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: mirror.token,
        roomId: victim.currentRoomId,
        hp: 100
    };
    GlobalState.levelEntities.get(getClientLevelScope(victim as never))?.set(npc.id, npc);

    GlobalState.sessionsByToken.set(victim.token, victim as never);
    GlobalState.sessionsByToken.set(mirror.token, mirror as never);

    await CombatHandler.handlePowerHit(mirror as never, buildPowerHitPayload(victim.clientEntID, npc.id, 25, 55));

    assert.equal(victim.authoritativeCurrentHp, 100, 'remote hostile hit report should not damage another player');
    assert.equal(victim.sentPackets.some((packet) => packet.id === 0x0A), false);
    assert.equal(mirror.sentPackets.some((packet) => packet.id === 0x0A), false);

    await CombatHandler.handlePowerHit(victim as never, buildPowerHitPayload(victim.clientEntID, npc.id, 25, 55));

    assert.equal(victim.authoritativeCurrentHp, 75, 'victim-authored hostile hit should still apply once');
    assert.equal(mirror.sentPackets.some((packet) => packet.id === 0x0A), true);
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

    assert.equal(watcher.sentPackets.some((packet) => packet.id === 0x07 && parseEntityStateId(packet.payload) === hostile.id), true);
    assert.equal(watcher.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntityId(packet.payload) === hostile.id), false);
    assert.equal(watcher.knownEntityIds.has(hostile.id), false);
}

async function testOutdoorEntityDestroyStaysOwnerLocal(): Promise<void> {
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
        false,
        'party mates should not receive private outdoor hostile destroy sync'
    );
    assert.equal(
        sameRoomStranger.sentPackets.some((packet) => packet.id === 0x0D),
        false,
        'non-party players should not receive private outdoor hostile destroy sync from another client'
    );
    assert.equal(partyOtherRoom.entities.has(hostile.id), true, 'party member local hostile should stay untouched');
    assert.equal(sameRoomStranger.entities.has(hostile.id), true, 'non-party local hostile should stay untouched');
}

async function testTutorialDungeonLocalEnemyKillSyncsToPartyEquivalent(): Promise<void> {
    const sender = createFakeClient(430, 'Alpha', 1);
    const watcher = createFakeClient(431, 'Beta', 1);

    sender.currentLevel = 'TutorialDungeon';
    watcher.currentLevel = 'TutorialDungeon';
    sender.levelInstanceId = 'tutorial-shared';
    watcher.levelInstanceId = 'tutorial-shared';

    attachPlayerEntity(sender);
    attachPlayerEntity(watcher);
    GlobalState.partyByMember.set('alpha', 8);
    GlobalState.partyByMember.set('beta', 8);

    const senderHostile = {
        id: 7301,
        name: 'IntroGoblinClub',
        isPlayer: false,
        x: 100,
        y: 200,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: sender.token,
        roomId: sender.currentRoomId,
        hp: 50,
        maxHp: 50
    };
    const watcherHostile = {
        ...senderHostile,
        id: 8301,
        ownerToken: watcher.token,
        hp: 50,
        maxHp: 50
    };

    sender.entities.set(senderHostile.id, senderHostile);
    watcher.entities.set(watcherHostile.id, watcherHostile);
    GlobalState.levelEntities.get(getClientLevelScope(sender as never))?.set(senderHostile.id, senderHostile);
    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(watcher.token, watcher as never);

    await CombatHandler.handlePowerHit(sender as never, buildPowerHitPayload(senderHostile.id, sender.clientEntID, 9999, 77));

    assert.equal(watcher.sentPackets.some((packet) => packet.id === 0x07 && parseEntityStateId(packet.payload) === watcherHostile.id), true);
    assert.equal(
        watcher.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntityId(packet.payload) === watcherHostile.id),
        false,
        'party watcher should not receive immediate destroy before its local death animation can play'
    );
    assert.equal(watcher.entities.get(watcherHostile.id)?.dead, true);
}

async function testTutorialDungeonLocalEnemyHitUsesAttackersLocalEntityWhenIdsCollide(): Promise<void> {
    const sender = createFakeClient(435, 'Alpha', 1);
    const watcher = createFakeClient(436, 'Beta', 1);

    sender.currentLevel = 'TutorialDungeon';
    watcher.currentLevel = 'TutorialDungeon';
    sender.levelInstanceId = 'tutorial-shared';
    watcher.levelInstanceId = 'tutorial-shared';

    attachPlayerEntity(sender);
    attachPlayerEntity(watcher);
    GlobalState.partyByMember.set('alpha', 88);
    GlobalState.partyByMember.set('beta', 88);

    const sharedLocalId = 7351;
    const senderHostile = {
        id: sharedLocalId,
        name: 'IntroGoblinClub',
        isPlayer: false,
        x: 100,
        y: 200,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: sender.token,
        roomId: sender.currentRoomId,
        hp: 50,
        maxHp: 50
    };
    const watcherHostile = {
        ...senderHostile,
        ownerToken: watcher.token,
        hp: 50,
        maxHp: 50
    };

    sender.entities.set(sharedLocalId, senderHostile);
    watcher.entities.set(sharedLocalId, watcherHostile);
    GlobalState.levelEntities.get(getClientLevelScope(sender as never))?.set(sharedLocalId, watcherHostile);
    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(watcher.token, watcher as never);

    await CombatHandler.handlePowerHit(sender as never, buildPowerHitPayload(sharedLocalId, sender.clientEntID, 20, 77));

    assert.equal(sender.entities.get(sharedLocalId)?.hp, 30, 'attacker local enemy should receive the hit even when the global id points at another owner');
    assert.equal(watcher.entities.get(sharedLocalId)?.hp, 30, 'party local equivalent should receive the same hit');
    assert.equal(
        watcher.sentPackets.some((packet) => packet.id === 0x0A),
        true,
        'party watcher should receive a translated authoritative hit for its matching local tutorial enemy'
    );
    assert.equal(
        watcher.sentPackets.some((packet) =>
            packet.id === 0x0A &&
            parsePowerHitTargetId(packet.payload) === sharedLocalId &&
            parsePowerHitDamage(packet.payload) === 20
        ),
        true,
        'translated tutorial hit should target the watcher local enemy id with authoritative damage'
    );
}

async function testNephitsQuestLocalEnemyHitUsesPrivateLocalSync(): Promise<void> {
    for (const [index, levelName] of NEPHIT_QUEST_LEVELS.entries()) {
        const sender = createFakeClient(455 + (index * 10), `Alpha${index}`, 1);
        const watcher = createFakeClient(456 + (index * 10), `Beta${index}`, 1);
        const instanceId = `nephit-shared-${index}`;

        sender.currentLevel = levelName;
        watcher.currentLevel = levelName;
        sender.levelInstanceId = instanceId;
        watcher.levelInstanceId = instanceId;

        attachPlayerEntity(sender);
        attachPlayerEntity(watcher);
        GlobalState.partyByMember.set(sender.character!.name.toLowerCase(), 93 + index);
        GlobalState.partyByMember.set(watcher.character!.name.toLowerCase(), 93 + index);

        const senderHostile = {
            id: 7400 + index,
            name: index === 0 ? 'NephitLargeEye' : 'NephitLargeEyeHard',
            isPlayer: false,
            x: 500,
            y: 300,
            v: 0,
            team: 2,
            entState: EntityState.ACTIVE,
            clientSpawned: true,
            ownerToken: sender.token,
            roomId: sender.currentRoomId,
            hp: 80,
            maxHp: 80
        };
        const watcherHostile = {
            ...senderHostile,
            id: 8400 + index,
            ownerToken: watcher.token,
            hp: 80,
            maxHp: 80
        };

        sender.entities.set(senderHostile.id, senderHostile);
        watcher.entities.set(watcherHostile.id, watcherHostile);
        GlobalState.levelEntities.get(getClientLevelScope(sender as never))?.set(senderHostile.id, senderHostile);
        GlobalState.sessionsByToken.set(sender.token, sender as never);
        GlobalState.sessionsByToken.set(watcher.token, watcher as never);

        await CombatHandler.handlePowerHit(sender as never, buildPowerHitPayload(senderHostile.id, sender.clientEntID, 25, 77));

        assert.equal(sender.entities.get(senderHostile.id)?.hp, 55, `${levelName} attacker local enemy should receive authoritative damage`);
        assert.equal(watcher.entities.get(watcherHostile.id)?.hp, 55, `${levelName} party local equivalent should receive the same authoritative damage`);
        assert.equal(
            watcher.sentPackets.some((packet) =>
                packet.id === 0x0A &&
                parsePowerHitTargetId(packet.payload) === watcherHostile.id &&
                parsePowerHitDamage(packet.payload) === 25
            ),
            true,
            `${levelName} watcher should receive a translated hit for its local Nephit enemy id`
        );
    }
}

async function testTutorialDungeonPrivateLocalHitDoesNotRetargetDeadEquivalent(): Promise<void> {
    const sender = createFakeClient(445, 'Alpha', 1);
    const watcher = createFakeClient(446, 'Beta', 1);

    sender.currentLevel = 'TutorialDungeon';
    watcher.currentLevel = 'TutorialDungeon';
    sender.levelInstanceId = 'tutorial-shared';
    watcher.levelInstanceId = 'tutorial-shared';

    attachPlayerEntity(sender);
    attachPlayerEntity(watcher);
    GlobalState.partyByMember.set('alpha', 91);
    GlobalState.partyByMember.set('beta', 91);

    const senderHostile = {
        id: 7381,
        name: 'IntroGoblinClub',
        isPlayer: false,
        x: 100,
        y: 200,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: sender.token,
        roomId: sender.currentRoomId,
        hp: 50,
        maxHp: 50
    };
    const watcherDeadEquivalent = {
        ...senderHostile,
        id: 8381,
        ownerToken: watcher.token,
        hp: 0,
        maxHp: 50,
        dead: true,
        entState: EntityState.DEAD
    };
    const watcherNearbyHostile = {
        ...senderHostile,
        id: 8382,
        ownerToken: watcher.token,
        x: 120,
        hp: 50,
        maxHp: 50
    };

    sender.entities.set(senderHostile.id, senderHostile);
    watcher.entities.set(watcherDeadEquivalent.id, watcherDeadEquivalent);
    watcher.entities.set(watcherNearbyHostile.id, watcherNearbyHostile);
    GlobalState.levelEntities.get(getClientLevelScope(sender as never))?.set(senderHostile.id, senderHostile);
    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(watcher.token, watcher as never);

    await CombatHandler.handlePowerHit(sender as never, buildPowerHitPayload(senderHostile.id, sender.clientEntID, 20, 77));

    assert.equal(sender.entities.get(senderHostile.id)?.hp, 30);
    assert.equal(watcher.entities.get(watcherDeadEquivalent.id)?.dead, true);
    assert.equal(
        watcher.entities.get(watcherNearbyHostile.id)?.hp,
        50,
        'private-local sync should not redirect damage from a dead equivalent to another nearby same-name enemy'
    );
    assert.equal(
        watcher.sentPackets.some((packet) => packet.id === 0x0A && parsePowerHitTargetId(packet.payload) === watcherNearbyHostile.id),
        false,
        'watcher should not receive a translated hit for the nearby unhit enemy'
    );
}

async function testTutorialDungeonPrivateLocalRepeatedDeadHitDoesNotApplyRequestedDamage(): Promise<void> {
    const sender = createFakeClient(447, 'Alpha', 1);
    const watcher = createFakeClient(448, 'Beta', 1);

    sender.currentLevel = 'TutorialDungeon';
    watcher.currentLevel = 'TutorialDungeon';
    sender.levelInstanceId = 'tutorial-shared';
    watcher.levelInstanceId = 'tutorial-shared';

    attachPlayerEntity(sender);
    attachPlayerEntity(watcher);
    GlobalState.partyByMember.set('alpha', 92);
    GlobalState.partyByMember.set('beta', 92);

    const senderHostile = {
        id: 7391,
        name: 'IntroGoblinDagger',
        isPlayer: false,
        x: 140,
        y: 220,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: sender.token,
        roomId: sender.currentRoomId,
        hp: 20,
        maxHp: 20
    };
    const watcherEquivalent = {
        ...senderHostile,
        id: 8391,
        ownerToken: watcher.token,
        hp: 20,
        maxHp: 20
    };
    const watcherNearbyHostile = {
        ...senderHostile,
        id: 8392,
        ownerToken: watcher.token,
        x: 155,
        hp: 60,
        maxHp: 60
    };

    sender.entities.set(senderHostile.id, senderHostile);
    watcher.entities.set(watcherEquivalent.id, watcherEquivalent);
    watcher.entities.set(watcherNearbyHostile.id, watcherNearbyHostile);
    GlobalState.levelEntities.get(getClientLevelScope(sender as never))?.set(senderHostile.id, senderHostile);
    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(watcher.token, watcher as never);

    await CombatHandler.handlePowerHit(sender as never, buildPowerHitPayload(senderHostile.id, sender.clientEntID, 9999, 77));
    watcher.sentPackets.length = 0;

    await CombatHandler.handlePowerHit(sender as never, buildPowerHitPayload(senderHostile.id, sender.clientEntID, 9999, 77));

    assert.equal(sender.entities.get(senderHostile.id)?.dead, true);
    assert.equal(watcher.entities.get(watcherEquivalent.id)?.dead, true);
    assert.equal(
        watcher.entities.get(watcherNearbyHostile.id)?.hp,
        60,
        'a repeated dead-target hit should not apply requested damage to the next nearby same-name enemy'
    );
    assert.equal(
        watcher.sentPackets.some((packet) => packet.id === 0x0A || packet.id === 0x07 || packet.id === 0x0D),
        false,
        'repeated dead-target hit should not emit another damage/death sync'
    );
}

async function testTutorialDungeonLocalEnemyHitSuppressesNonPlayerSourceDamageEcho(): Promise<void> {
    const sender = createFakeClient(437, 'Alpha', 1);
    const roomCreator = createFakeClient(438, 'Beta', 1);

    sender.currentLevel = 'TutorialDungeon';
    roomCreator.currentLevel = 'TutorialDungeon';
    sender.levelInstanceId = 'tutorial-shared';
    roomCreator.levelInstanceId = 'tutorial-shared';

    attachPlayerEntity(sender);
    attachPlayerEntity(roomCreator);
    GlobalState.partyByMember.set('alpha', 89);
    GlobalState.partyByMember.set('beta', 89);

    const helper = {
        id: 7360,
        name: 'ArrowProxy',
        isPlayer: false,
        x: 90,
        y: 200,
        v: 0,
        team: 1,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: sender.token,
        summonerId: sender.clientEntID,
        roomId: sender.currentRoomId
    };
    const senderHostile = {
        id: 7361,
        name: 'IntroGoblinClub',
        isPlayer: false,
        x: 100,
        y: 200,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: sender.token,
        roomId: sender.currentRoomId,
        hp: 50,
        maxHp: 50
    };
    const creatorHostile = {
        ...senderHostile,
        id: 8361,
        ownerToken: roomCreator.token,
        hp: 50,
        maxHp: 50
    };

    sender.entities.set(helper.id, helper);
    sender.entities.set(senderHostile.id, senderHostile);
    roomCreator.entities.set(creatorHostile.id, creatorHostile);
    const levelMap = GlobalState.levelEntities.get(getClientLevelScope(sender as never));
    levelMap?.set(helper.id, helper);
    levelMap?.set(senderHostile.id, senderHostile);
    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(roomCreator.token, roomCreator as never);

    await CombatHandler.handlePowerHit(sender as never, buildPowerHitPayload(senderHostile.id, helper.id, 20, 77));

    assert.equal(sender.entities.get(senderHostile.id)?.hp, 30);
    assert.equal(roomCreator.entities.get(creatorHostile.id)?.hp, 30);
    assert.equal(
        roomCreator.sentPackets.some((packet) => packet.id === 0x0A),
        false,
        'room creator should not receive a second private-local tutorial hit when the joiner hit source is a helper/projectile'
    );
}

async function testTutorialDungeonUnknownSourcePowerHitIsIgnored(): Promise<void> {
    const roomCreator = createFakeClient(439, 'Alpha', 1);
    const joiner = createFakeClient(443, 'Beta', 1);

    roomCreator.currentLevel = 'TutorialDungeon';
    joiner.currentLevel = 'TutorialDungeon';
    roomCreator.levelInstanceId = 'tutorial-shared';
    joiner.levelInstanceId = 'tutorial-shared';

    attachPlayerEntity(roomCreator);
    attachPlayerEntity(joiner);
    GlobalState.partyByMember.set('alpha', 90);
    GlobalState.partyByMember.set('beta', 90);

    const creatorHostile = {
        id: 8371,
        name: 'IntroGoblinClub',
        isPlayer: false,
        x: 100,
        y: 200,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: roomCreator.token,
        roomId: roomCreator.currentRoomId,
        hp: 50,
        maxHp: 50
    };

    roomCreator.entities.set(creatorHostile.id, creatorHostile);
    GlobalState.levelEntities.get(getClientLevelScope(roomCreator as never))?.set(creatorHostile.id, creatorHostile);
    GlobalState.sessionsByToken.set(roomCreator.token, roomCreator as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);

    await CombatHandler.handlePowerHit(roomCreator as never, buildPowerHitPayload(creatorHostile.id, 991002, 20, 77));

    assert.equal(roomCreator.entities.get(creatorHostile.id)?.hp, 50);
    assert.equal(creatorHostile.hp, 50);
    assert.equal(
        roomCreator.sentPackets.some((packet) => packet.id === 0x0A),
        false,
        'tutorial remote-hit re-entry with an unknown helper/projectile source should not apply a second hit'
    );
}

async function testTutorialDungeonLocalEnemyDestroySyncsToPartyEquivalent(): Promise<void> {
    const sender = createFakeClient(440, 'Alpha', 1);
    const watcher = createFakeClient(441, 'Beta', 1);
    const stranger = createFakeClient(442, 'Gamma', 1);

    sender.currentLevel = 'TutorialDungeon';
    watcher.currentLevel = 'TutorialDungeon';
    stranger.currentLevel = 'TutorialDungeon';
    sender.levelInstanceId = 'tutorial-shared';
    watcher.levelInstanceId = 'tutorial-shared';
    stranger.levelInstanceId = 'tutorial-shared';

    attachPlayerEntity(sender);
    attachPlayerEntity(watcher);
    attachPlayerEntity(stranger);
    GlobalState.partyByMember.set('alpha', 9);
    GlobalState.partyByMember.set('beta', 9);

    const senderHostile = {
        id: 7401,
        name: 'IntroGoblinDagger',
        isPlayer: false,
        x: 140,
        y: 220,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: sender.token,
        roomId: sender.currentRoomId
    };
    const watcherHostile = { ...senderHostile, id: 8401, ownerToken: watcher.token };
    const strangerHostile = { ...senderHostile, id: 9401, ownerToken: stranger.token };

    sender.entities.set(senderHostile.id, senderHostile);
    watcher.entities.set(watcherHostile.id, watcherHostile);
    stranger.entities.set(strangerHostile.id, strangerHostile);
    GlobalState.levelEntities.get(getClientLevelScope(sender as never))?.set(senderHostile.id, senderHostile);
    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(watcher.token, watcher as never);
    GlobalState.sessionsByToken.set(stranger.token, stranger as never);

    const destroy = new BitBuffer(false);
    destroy.writeMethod4(senderHostile.id);
    destroy.writeMethod15(false);
    await CombatHandler.handleEntityDestroy(sender as never, destroy.toBuffer());

    assert.equal(
        watcher.sentPackets.some((packet) => packet.id === 0x07 && parseEntityStateId(packet.payload) === watcherHostile.id),
        true,
        'party watcher should receive death state for its own matching local tutorial enemy id'
    );
    assert.equal(
        watcher.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntityId(packet.payload) === watcherHostile.id),
        false,
        'party watcher should not receive immediate destroy before its local death animation can play'
    );
    assert.equal(stranger.sentPackets.some((packet) => packet.id === 0x0D), false);
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

        await testTutorialDungeonUnknownSourcePowerCastIsIgnored();

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

        await testRemotePlayerPowerHitIsIgnored();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testForeignOwnedPowerHitSourceIsIgnored();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testPartySharedHostileHitDoesNotEchoToNonOwnerAttacker();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testPrematureSharedHostileDestroyIsRejectedWhileServerHpPositive();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testBakedOutdoorHostileHitsStayOwnerLocal();

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

        await testHostileHitsDoNotEchoPowerHitBackToLocalVictimWhenDamageMatches();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testRemoteHostileHitAgainstPlayerIsIgnored();

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

        await testOutdoorEntityDestroyStaysOwnerLocal();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testTutorialDungeonLocalEnemyKillSyncsToPartyEquivalent();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testTutorialDungeonLocalEnemyHitUsesAttackersLocalEntityWhenIdsCollide();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testNephitsQuestLocalEnemyHitUsesPrivateLocalSync();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testTutorialDungeonPrivateLocalHitDoesNotRetargetDeadEquivalent();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testTutorialDungeonPrivateLocalRepeatedDeadHitDoesNotApplyRequestedDamage();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testTutorialDungeonLocalEnemyHitSuppressesNonPlayerSourceDamageEcho();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testTutorialDungeonUnknownSourcePowerHitIsIgnored();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testTutorialDungeonLocalEnemyDestroySyncsToPartyEquivalent();

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
