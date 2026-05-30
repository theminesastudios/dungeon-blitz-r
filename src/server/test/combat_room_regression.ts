import { strict as assert } from 'assert';
import * as path from 'path';
import { GlobalState } from '../core/GlobalState';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { CombatHandler } from '../handlers/CombatHandler';
import { EntityHandler } from '../handlers/EntityHandler';
import { Entity, EntityState, EntityTeam } from '../core/Entity';
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
    entityIdAliases: Map<number, number>;
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
        entityIdAliases: new Map<number, number>(),
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

function buildBuffTickDotPayload(targetId: number, sourceId: number, powerId: number, damage: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(targetId);
    bb.writeMethod4(sourceId);
    bb.writeMethod4(powerId);
    bb.writeMethod45(damage);
    bb.writeMethod20(5, 0);
    return bb.toBuffer();
}

function buildDestroyEntityPayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod15(true);
    return bb.toBuffer();
}

function buildEntityFullUpdatePayload(
    entityId: number,
    name: string,
    options: {
        x?: number;
        y?: number;
        v?: number;
        team?: number;
        isPlayer?: boolean;
        entState?: number;
        characterName?: string;
        roomId?: number;
    } = {}
): Buffer {
    const payload = (EntityHandler as any).buildEntityFullUpdatePayload({
        id: entityId,
        name,
        isPlayer: options.isPlayer ?? true,
        x: options.x ?? 0,
        y: options.y ?? 0,
        v: options.v ?? 0,
        team: options.team ?? EntityTeam.PLAYER,
        renderDepthOffset: 0,
        characterName: options.characterName ?? '',
        entState: options.entState ?? EntityState.ACTIVE,
        facingLeft: false,
        running: false,
        jumping: false,
        dropping: false,
        backpedal: false,
        roomId: options.roomId ?? -1
    });
    return Buffer.concat([payload, Buffer.from([0])]);
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

function parsePowerHitDamage(payload: Buffer): number {
    const br = new BitReader(payload);
    br.readMethod4();
    br.readMethod4();
    return br.readMethod24();
}

function parsePowerHitIds(payload: Buffer): { targetId: number; sourceId: number; damage: number } {
    const br = new BitReader(payload);
    return {
        targetId: br.readMethod4(),
        sourceId: br.readMethod4(),
        damage: br.readMethod24()
    };
}

function parseBuffTickDotIds(payload: Buffer): { targetId: number; sourceId: number; powerId: number; damage: number } {
    const br = new BitReader(payload);
    return {
        targetId: br.readMethod4(),
        sourceId: br.readMethod4(),
        powerId: br.readMethod4(),
        damage: Math.abs(br.readMethod45())
    };
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
        ownerPartyId: 1,
        summonerId: sender.clientEntID,
        roomId: sender.currentRoomId,
        hp: 100
    };
    GlobalState.levelEntities.get(getClientLevelScope(sender as never))?.set(hostile.id, hostile);
    sender.knownEntityIds.add(hostile.id);
    partyOtherRoom.knownEntityIds.add(hostile.id);

    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(partyOtherRoom.token, partyOtherRoom as never);
    GlobalState.sessionsByToken.set(sameRoomStranger.token, sameRoomStranger as never);
    GlobalState.sessionsByToken.set(otherRoomStranger.token, otherRoomStranger as never);

    await CombatHandler.handlePowerHit(sender as never, buildPowerHitPayload(hostile.id, sender.clientEntID, 42, 77));

    assert.equal(partyOtherRoom.sentPackets.some((packet) => packet.id === 0x0A), true);
    assert.equal(sameRoomStranger.sentPackets.some((packet) => packet.id === 0x0A), false);
    assert.equal(otherRoomStranger.sentPackets.some((packet) => packet.id === 0x0A), false);
}

async function testPartyEchoedPowerHitDoesNotDoubleApplyDamage(): Promise<void> {
    const sender = createFakeClient(204, 'Alpha', 1);
    const partyOtherRoom = createFakeClient(205, 'Beta', 5);

    sender.currentLevel = 'TutorialDungeon';
    partyOtherRoom.currentLevel = 'TutorialDungeon';

    attachPlayerEntity(sender);
    attachPlayerEntity(partyOtherRoom);

    GlobalState.partyByMember.set('alpha', 4);
    GlobalState.partyByMember.set('beta', 4);

    const levelScope = getClientLevelScope(sender as never);
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
        ownerToken: sender.token,
        ownerPartyId: 4,
        summonerId: sender.clientEntID,
        roomId: sender.currentRoomId,
        hp: 100
    };
    GlobalState.levelEntities.get(levelScope)?.set(hostile.id, hostile);
    sender.knownEntityIds.add(hostile.id);
    partyOtherRoom.knownEntityIds.add(hostile.id);

    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(partyOtherRoom.token, partyOtherRoom as never);

    const alphaHit = buildPowerHitPayload(hostile.id, sender.clientEntID, 42, 77);
    await CombatHandler.handlePowerHit(sender as never, alphaHit);

    assert.equal(hostile.hp, 58, 'first player hit should apply once to the canonical shared enemy');
    assert.equal(
        partyOtherRoom.sentPackets.some((packet) => packet.id === 0x0A && parsePowerHitDamage(packet.payload) === 42),
        true,
        'party mate should see the first player hit'
    );

    sender.sentPackets.length = 0;
    partyOtherRoom.sentPackets.length = 0;

    await CombatHandler.handlePowerHit(partyOtherRoom as never, alphaHit);

    assert.equal(hostile.hp, 58, 'echoing another player sourceId should not apply damage a second time');
    assert.equal(sender.sentPackets.some((packet) => packet.id === 0x0A), false);
    assert.equal(partyOtherRoom.sentPackets.some((packet) => packet.id === 0x0A), false);

    await CombatHandler.handlePowerHit(partyOtherRoom as never, buildPowerHitPayload(hostile.id, partyOtherRoom.clientEntID, 10, 77));

    assert.equal(hostile.hp, 48, 'the party mate should still be able to apply their own hit');
    assert.equal(
        sender.sentPackets.some((packet) => packet.id === 0x0A && parsePowerHitDamage(packet.payload) === 10),
        true,
        'the original player should see the party mate own-source hit'
    );
}

async function testVeryLargePowerHitRelaysSafeDisplayDamage(): Promise<void> {
    const sender = createFakeClient(206, 'AlphaHighDamage', 1);
    const partyOtherRoom = createFakeClient(207, 'BetaHighDamage', 5);

    sender.currentLevel = 'TutorialDungeon';
    partyOtherRoom.currentLevel = 'TutorialDungeon';

    attachPlayerEntity(sender);
    attachPlayerEntity(partyOtherRoom);

    GlobalState.partyByMember.set('alphahighdamage', 6);
    GlobalState.partyByMember.set('betahighdamage', 6);

    const hostile: any = {
        id: 5071,
        name: 'HugeDamageTarget',
        isPlayer: false,
        x: 10,
        y: 15,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        roomId: sender.currentRoomId,
        hp: 250000,
        maxHp: 250000
    };
    GlobalState.levelEntities.get(getClientLevelScope(sender as never))?.set(hostile.id, hostile);
    sender.knownEntityIds.add(hostile.id);
    partyOtherRoom.knownEntityIds.add(hostile.id);

    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(partyOtherRoom.token, partyOtherRoom as never);

    await CombatHandler.handlePowerHit(sender as never, buildPowerHitPayload(hostile.id, sender.clientEntID, 5000000, 77));

    assert.equal(hostile.hp, 0, 'server-side combat should still apply the full lethal damage');
    assert.equal(hostile.dead, true, 'the high-damage hit should still kill the target');

    const relayedHit = partyOtherRoom.sentPackets.find((packet) => packet.id === 0x0A);
    assert.ok(relayedHit, 'party mate should receive the relayed hit');
    assert.equal(
        parsePowerHitDamage(relayedHit!.payload),
        4000000,
        'relayed Flash damage display should be capped at the client-safe display limit'
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

async function testHostileHitsCanKillPlayersAndStayRoomScoped(): Promise<void> {
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
    assert.equal(victim.authoritativeCurrentHp, 0);
    assert.equal(victimEntity?.dead, true);
    assert.equal(victimEntity?.entState, EntityState.DEAD);
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
        true,
        'hostile lethal hits should broadcast a player death state to same-room viewers'
    );
    const victimHitPacket = victim.sentPackets.find((packet) => packet.id === 0x0A);
    const watcherHitPacket = sameRoomWatcher.sentPackets.find((packet) => packet.id === 0x0A);
    assert.equal(
        victimHitPacket,
        undefined,
        'local player already simulated the hostile hit and should not receive an overkill echo'
    );
    assert.notEqual(watcherHitPacket, undefined, 'same-room viewers should receive the hostile hit packet');
    assert.equal(
        parsePowerHitDamage(watcherHitPacket!.payload),
        100,
        'same-room viewers should receive the lethal applied damage for synchronization'
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

async function testHostileDeathStateDoesNotEchoBackToLocalVictim(): Promise<void> {
    const victim = createFakeClient(330, 'VictimDeadEcho', 2);
    const sameRoomWatcher = createFakeClient(331, 'WatcherDeadEcho', 2);

    attachPlayerEntity(victim);
    attachPlayerEntity(sameRoomWatcher);

    const victimEntity = victim.entities.get(victim.clientEntID);
    victimEntity.hp = 0;
    victimEntity.dead = true;
    victimEntity.entState = EntityState.DEAD;
    victim.authoritativeCurrentHp = 0;

    const npc = {
        id: 8125,
        name: 'EnemyGoblinFinisher',
        isPlayer: false,
        x: 24,
        y: 20,
        v: 0,
        team: EntityTeam.ENEMY,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        roomId: victim.currentRoomId,
        hp: 100
    };
    GlobalState.levelEntities.get(getClientLevelScope(victim as never))?.set(npc.id, npc);

    GlobalState.sessionsByToken.set(victim.token, victim as never);
    GlobalState.sessionsByToken.set(sameRoomWatcher.token, sameRoomWatcher as never);

    await CombatHandler.handlePowerHit(victim as never, buildPowerHitPayload(victim.clientEntID, npc.id, 10, 55));

    assert.equal(
        victim.sentPackets.some((packet) => {
            if (packet.id !== 0x07) {
                return false;
            }
            const state = parseEntityState(packet.payload);
            return state.entityId === victim.clientEntID && state.entState === EntityState.DEAD;
        }),
        false,
        'local victim should not receive its own hostile death-state echo because LinkUpdater treats it as a remote entity update'
    );
    assert.equal(
        sameRoomWatcher.sentPackets.some((packet) => {
            if (packet.id !== 0x07) {
                return false;
            }
            const state = parseEntityState(packet.payload);
            return state.entityId === victim.clientEntID && state.entState === EntityState.DEAD;
        }),
        true,
        'same-room viewers should still receive the hostile death state'
    );
}

async function testPartySharedDungeonDestroyKeepsJoinerDeathState(): Promise<void> {
    const sender = createFakeClient(400, 'Alpha', 2);
    const watcher = createFakeClient(401, 'Beta', 2);

    sender.currentLevel = 'GhostBossDungeon';
    watcher.currentLevel = 'GhostBossDungeon';

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

    assert.equal(
        watcher.sentPackets.some((packet) => packet.id === 0x0D && parseDestroyEntityId(packet.payload) === hostile.id),
        false,
        'party joiners should not receive immediate remove packets for shared dungeon enemy death'
    );
    assert.equal(
        watcher.sentPackets.some((packet) => {
            if (packet.id !== 0x07) {
                return false;
            }
            const state = parseEntityState(packet.payload);
            return state.entityId === hostile.id && state.entState === EntityState.DEAD;
        }),
        true,
        'party joiners should receive a dead state so the enemy dies locally instead of disappearing'
    );
    assert.equal(watcher.knownEntityIds.has(hostile.id), false);
    assert.equal(watcher.entities.has(hostile.id), true, 'joiner local enemy record should remain for the death display');
    assert.equal(watcher.entities.get(hostile.id)?.dead, true);
    assert.equal(watcher.entities.get(hostile.id)?.entState, EntityState.DEAD);
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

async function testAliasedDungeonHostileHitUsesCanonicalEntity(): Promise<void> {
    const sender = createFakeClient(520, 'Alpha', 1);
    const partyOtherRoom = createFakeClient(521, 'Beta', 1);

    sender.currentLevel = 'TutorialDungeon';
    partyOtherRoom.currentLevel = 'TutorialDungeon';

    attachPlayerEntity(sender);
    attachPlayerEntity(partyOtherRoom);

    GlobalState.partyByMember.set('alpha', 8);
    GlobalState.partyByMember.set('beta', 8);

    const hostile = {
        id: 9701,
        name: 'SharedGoblin',
        isPlayer: false,
        x: 10,
        y: 15,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: sender.token,
        ownerPartyId: 8,
        summonerId: sender.clientEntID,
        roomId: sender.currentRoomId,
        hp: 100
    };
    GlobalState.levelEntities.get(getClientLevelScope(sender as never))?.set(hostile.id, hostile);
    sender.knownEntityIds.add(hostile.id);
    partyOtherRoom.entityIdAliases.set(8701, hostile.id);
    partyOtherRoom.knownEntityIds.add(hostile.id);
    partyOtherRoom.entities.set(8701, { ...hostile, id: 8701, sharedCanonicalId: hostile.id });

    GlobalState.sessionsByToken.set(sender.token, sender as never);
    GlobalState.sessionsByToken.set(partyOtherRoom.token, partyOtherRoom as never);

    await CombatHandler.handlePowerHit(partyOtherRoom as never, buildPowerHitPayload(8701, partyOtherRoom.clientEntID, 25, 77));

    assert.equal(hostile.hp, 75, 'hit against a local duplicate id should apply to the canonical hostile');
    const relayedHit = sender.sentPackets.find((packet) => packet.id === 0x0A);
    assert.ok(relayedHit, 'canonical hit should relay to the party peer');
    assert.deepEqual(
        parsePowerHitIds(relayedHit!.payload),
        { targetId: hostile.id, sourceId: partyOtherRoom.clientEntID, damage: 25 },
        'relayed hit should use the canonical target id, not the duplicate local id'
    );

    sender.sentPackets.length = 0;

    await CombatHandler.handleBuffTickDot(
        partyOtherRoom as never,
        buildBuffTickDotPayload(8701, partyOtherRoom.clientEntID, 88, 5)
    );

    assert.equal(hostile.hp, 70, 'DoT against a local duplicate id should apply to the canonical hostile');
    const relayedDot = sender.sentPackets.find((packet) => packet.id === 0x79);
    assert.ok(relayedDot, 'canonical DoT should relay to the party peer');
    assert.deepEqual(
        parseBuffTickDotIds(relayedDot!.payload),
        { targetId: hostile.id, sourceId: partyOtherRoom.clientEntID, powerId: 88, damage: 5 },
        'relayed DoT should use the canonical target id, not the duplicate local id'
    );
}

async function testSharedDungeonHostileCombatWaitsForJoinerAdoption(): Promise<void> {
    const owner = createFakeClient(530, 'Alpha', 1);
    const joiner = createFakeClient(531, 'Beta', 1);

    owner.currentLevel = 'TutorialDungeon';
    joiner.currentLevel = 'TutorialDungeon';

    attachPlayerEntity(owner);
    attachPlayerEntity(joiner);

    GlobalState.partyByMember.set('alpha', 9);
    GlobalState.partyByMember.set('beta', 9);

    const hostile = {
        id: 9801,
        name: 'SharedGoblin',
        isPlayer: false,
        x: 10,
        y: 15,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: owner.token,
        ownerPartyId: 9,
        roomId: owner.currentRoomId,
        hp: 100
    };
    GlobalState.levelEntities.get(getClientLevelScope(owner as never))?.set(hostile.id, hostile);
    owner.knownEntityIds.add(hostile.id);

    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);

    await CombatHandler.handlePowerHit(owner as never, buildPowerHitPayload(hostile.id, owner.clientEntID, 10, 77));

    assert.equal(
        joiner.sentPackets.some((packet) => packet.id === 0x0A),
        false,
        'joiner should not receive canonical hostile combat before adopting the shared hostile id'
    );

    joiner.sentPackets.length = 0;
    joiner.entityIdAliases.set(8801, hostile.id);
    joiner.knownEntityIds.add(hostile.id);
    joiner.entities.set(8801, { ...hostile, id: 8801, sharedCanonicalId: hostile.id });

    await CombatHandler.handlePowerHit(owner as never, buildPowerHitPayload(hostile.id, owner.clientEntID, 10, 77));

    const relayedHit = joiner.sentPackets.find((packet) => packet.id === 0x0A);
    assert.ok(relayedHit, 'joiner should receive shared hostile combat after canonical id adoption');
    assert.deepEqual(
        parsePowerHitIds(relayedHit!.payload),
        { targetId: 8801, sourceId: owner.clientEntID, damage: 10 },
        'joiner should receive shared hostile combat against its local enemy id'
    );
}

async function testSharedDungeonHostileDefeatUsesViewerLocalId(): Promise<void> {
    const owner = createFakeClient(540, 'Alpha', 1);
    const joiner = createFakeClient(541, 'Beta', 1);

    owner.currentLevel = 'TutorialDungeon';
    joiner.currentLevel = 'TutorialDungeon';

    attachPlayerEntity(owner);
    attachPlayerEntity(joiner);

    GlobalState.partyByMember.set('alpha', 10);
    GlobalState.partyByMember.set('beta', 10);

    const hostile = {
        id: 9901,
        name: 'SharedGoblin',
        isPlayer: false,
        x: 10,
        y: 15,
        v: 0,
        team: 2,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        ownerToken: owner.token,
        ownerPartyId: 10,
        roomId: owner.currentRoomId,
        hp: 100,
        maxHp: 100
    };
    GlobalState.levelEntities.get(getClientLevelScope(owner as never))?.set(hostile.id, hostile);
    owner.knownEntityIds.add(hostile.id);
    joiner.entityIdAliases.set(8901, hostile.id);
    joiner.knownEntityIds.add(hostile.id);
    joiner.entities.set(8901, { ...hostile, id: 8901, sharedCanonicalId: hostile.id });

    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(joiner.token, joiner as never);

    await CombatHandler.handleEntityDestroy(owner as never, buildDestroyEntityPayload(hostile.id));

    const defeatState = joiner.sentPackets.find((packet) => packet.id === 0x07);
    assert.ok(defeatState, 'joiner should receive a local death state for the shared hostile');
    assert.deepEqual(
        parseEntityState(defeatState!.payload),
        { entityId: 8901, entState: EntityState.DEAD },
        'shared hostile death state should use the joiner local enemy id'
    );
}

async function testPlayerFullUpdateCanonicalizesCollidingEntityIds(): Promise<void> {
    const alpha = createFakeClient(500, 'CanonAlpha', 2);
    const beta = createFakeClient(501, 'CanonBeta', 2);
    const rawPlayerId = 9101;

    GlobalState.sessionsByToken.set(alpha.token, alpha as never);
    GlobalState.sessionsByToken.set(beta.token, beta as never);

    EntityHandler.handleEntityFullUpdate(
        alpha as never,
        buildEntityFullUpdatePayload(rawPlayerId, alpha.character!.name, {
            x: 10,
            y: 20
        })
    );
    EntityHandler.handleEntityFullUpdate(
        beta as never,
        buildEntityFullUpdatePayload(rawPlayerId, beta.character!.name, {
            x: 30,
            y: 40
        })
    );

    const levelMap = GlobalState.levelEntities.get(getClientLevelScope(alpha as never));
    assert.ok(levelMap, 'level scope should have canonical player entities');
    assert.equal(alpha.clientEntID, rawPlayerId, 'first player should keep the raw entity id when it is free');
    assert.notEqual(beta.clientEntID, rawPlayerId, 'second player should be remapped away from the occupied raw id');
    assert.equal(beta.entityIdAliases.get(rawPlayerId), beta.clientEntID, 'second player should remember raw-to-canonical alias');
    assert.equal(levelMap!.get(alpha.clientEntID)?.ownerToken, alpha.token, 'first canonical entity should keep its owner');
    assert.equal(levelMap!.get(beta.clientEntID)?.ownerToken, beta.token, 'second canonical entity should keep its owner');
    assert.equal(levelMap!.get(rawPlayerId)?.ownerToken, alpha.token, 'remap must not overwrite the existing owner');
    assert.ok(beta.entities.has(beta.clientEntID), 'second session should store its player under the canonical id');
    assert.equal(beta.entities.has(rawPlayerId), false, 'second session should not keep a stale owned player at the raw id');
}

async function testCanonicalPlayerStateRelaysToTeammate(): Promise<void> {
    const victim = createFakeClient(510, 'CanonVictim', 2);
    const watcher = createFakeClient(511, 'CanonWatcher', 2);
    const rawPlayerId = 9201;

    GlobalState.partyByMember.set('canonvictim', 11);
    GlobalState.partyByMember.set('canonwatcher', 11);
    GlobalState.sessionsByToken.set(victim.token, victim as never);
    GlobalState.sessionsByToken.set(watcher.token, watcher as never);

    EntityHandler.handleEntityFullUpdate(
        watcher as never,
        buildEntityFullUpdatePayload(rawPlayerId, watcher.character!.name, {
        })
    );
    EntityHandler.handleEntityFullUpdate(
        victim as never,
        buildEntityFullUpdatePayload(rawPlayerId, victim.character!.name, {
        })
    );

    const hostile = {
        id: 9301,
        name: 'CanonicalGoblin',
        isPlayer: false,
        x: 24,
        y: 20,
        v: 0,
        team: EntityTeam.ENEMY,
        entState: EntityState.ACTIVE,
        clientSpawned: true,
        roomId: victim.currentRoomId,
        hp: 100
    };
    GlobalState.levelEntities.get(getClientLevelScope(victim as never))?.set(hostile.id, hostile);

    await CombatHandler.handlePowerHit(victim as never, buildPowerHitPayload(victim.clientEntID, hostile.id, 120, 55));

    const relayedDeath = watcher.sentPackets.find((packet) => {
        if (packet.id !== 0x07) {
            return false;
        }
        const state = parseEntityState(packet.payload);
        return state.entityId === victim.clientEntID && state.entState === EntityState.DEAD;
    });
    assert.ok(relayedDeath, 'teammate should receive the canonical remote player death state');
    assert.equal(
        watcher.sentPackets.some((packet) => packet.id === 0x07 && parseEntityState(packet.payload).entityId === rawPlayerId),
        false,
        'remote player death state should not use the stale raw id'
    );

    const correction = watcher.sentPackets.find((packet) => packet.id === 0x3A);
    if (correction) {
        assert.equal(parseHpDelta(correction.payload).entityId, victim.clientEntID);
    }
}

async function testEnemyDefeatNotSuppressedByViewerPlayerIdOverlap(): Promise<void> {
    const owner = createFakeClient(520, 'OverlapOwner', 2);
    const watcher = createFakeClient(521, 'OverlapWatcher', 2);

    owner.currentLevel = 'GhostBossDungeon';
    watcher.currentLevel = 'GhostBossDungeon';
    watcher.clientEntID = 9401;

    attachPlayerEntity(owner);
    attachPlayerEntity(watcher);
    GlobalState.partyByMember.set('overlapowner', 12);
    GlobalState.partyByMember.set('overlapwatcher', 12);

    const hostile = {
        id: 9501,
        name: 'OverlapSharedHostile',
        isPlayer: false,
        clientSpawned: true,
        x: 100,
        y: 100,
        v: 0,
        team: EntityTeam.ENEMY,
        entState: EntityState.ACTIVE,
        ownerToken: owner.token,
        ownerPartyId: 12,
        roomId: owner.currentRoomId,
        hp: 100,
        maxHp: 100
    };
    GlobalState.levelEntities.get(getClientLevelScope(owner as never))?.set(hostile.id, hostile);
    owner.knownEntityIds.add(hostile.id);
    watcher.entityIdAliases.set(watcher.clientEntID, hostile.id);
    watcher.knownEntityIds.add(hostile.id);
    watcher.entities.set(hostile.id, { ...hostile });

    GlobalState.sessionsByToken.set(owner.token, owner as never);
    GlobalState.sessionsByToken.set(watcher.token, watcher as never);

    await CombatHandler.handleEntityDestroy(owner as never, buildDestroyEntityPayload(hostile.id));

    assert.equal(watcher.entities.get(watcher.clientEntID)?.isPlayer, true, 'viewer player entity should not be mutated as the hostile');
    assert.notEqual(watcher.entities.get(watcher.clientEntID)?.entState, EntityState.DEAD, 'viewer player entity should not be killed by overlap cleanup');
    assert.equal(
        watcher.sentPackets.some((packet) => {
            if (packet.id !== 0x07) {
                return false;
            }
            const state = parseEntityState(packet.payload);
            return state.entityId === hostile.id && state.entState === EntityState.DEAD;
        }),
        true,
        'viewer should still receive the enemy death state even when the local alias overlaps its player id'
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

        await testPartyEchoedPowerHitDoesNotDoubleApplyDamage();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testVeryLargePowerHitRelaysSafeDisplayDamage();

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

        await testHostileHitsCanKillPlayersAndStayRoomScoped();

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

        await testHostileDeathStateDoesNotEchoBackToLocalVictim();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testPartySharedDungeonDestroyKeepsJoinerDeathState();

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

        await testDungeonCombatDoesNotCrossInstanceScopes();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testAliasedDungeonHostileHitUsesCanonicalEntity();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testSharedDungeonHostileCombatWaitsForJoinerAdoption();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testSharedDungeonHostileDefeatUsesViewerLocalId();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testPlayerFullUpdateCanonicalizesCollidingEntityIds();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testCanonicalPlayerStateRelaysToTeammate();

        GlobalState.sessionsByToken.clear();
        GlobalState.levelEntities.clear();
        GlobalState.partyByMember.clear();
        GlobalState.combatContributions.clear();
        GlobalState.entityLifeNonces.clear();
        GlobalState.entityLastRewardNonces.clear();

        await testEnemyDefeatNotSuppressedByViewerPlayerIdOverlap();
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
