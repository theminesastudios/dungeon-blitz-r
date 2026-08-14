import { strict as assert } from 'assert';
import { GlobalState } from '../core/GlobalState';
import { EntityState, EntityTeam } from '../core/Entity';
import { CombatHandler } from '../handlers/CombatHandler';
import { EntityHandler } from '../handlers/EntityHandler';
import { getLevelScopeKey } from '../core/LevelScope';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

const LEVEL = 'JC_Mission3';
const INSTANCE = 'plague-transfer-regression';
const SCOPE = getLevelScopeKey(LEVEL, INSTANCE);

function enemy(id: number, x: number, y: number): any {
    return {
        id,
        name: `PlagueTarget${id}`,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        x,
        y,
        hp: 1000,
        maxHp: 1000,
        entState: EntityState.ACTIVE,
        activeBuffs: {}
    };
}

// LinkUpdater.method_1262 writes PKTTYPE_ENT_ADD_BUFF in this exact wire order.
// Keep this independent of CombatHandler.buildAddBuffPacket so source/target inversions regress loudly.
function clientAddBuffWire(targetId: number, sourceId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(targetId);
    bb.writeMethod9(sourceId);
    bb.writeMethod9(729);
    bb.writeMethod9(5941);
    bb.writeMethod9(777);
    bb.writeMethod9(1);
    bb.writeMethod15(true);
    bb.writeMethod9(1);
    bb.writeMethod9(393);
    bb.writeMethod9(1);
    bb.writeMethod309(0.2);
    return bb.toBuffer();
}

function clientRemoveBuffWire(targetId: number, sourceId: number, buffId: number = 729): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(targetId);
    bb.writeMethod9(sourceId);
    bb.writeMethod9(buffId);
    return bb.toBuffer();
}

async function main(): Promise<void> {
    const sentPackets: Array<{ id: number; payload: Buffer }> = [];
    const client: any = {
        token: 88001,
        userId: 88001,
        character: { name: 'PlagueNecro' },
        currentLevel: LEVEL,
        levelInstanceId: INSTANCE,
        currentRoomId: 1,
        playerSpawned: true,
        clientEntID: 89001,
        knownEntityIds: new Set<number>([600001, 600002, 600003, 600004]),
        entityIdAliases: new Map<number, number>(),
        entities: new Map<number, any>(),
        sentPackets,
        send(id: number, payload: Buffer) { sentPackets.push({ id, payload: Buffer.from(payload) }); }
    };
    const dead = enemy(600001, 1000, 1000);
    const nearest = enemy(600002, 1180, 1000);
    const secondHop = enemy(600003, 1400, 1000);
    const outsideRadius = enemy(600004, 1000, 3001);
    const levelMap = new Map<number, any>([
        [dead.id, dead],
        [nearest.id, nearest],
        [secondHop.id, secondHop],
        [outsideRadius.id, outsideRadius]
    ]);
    GlobalState.levelEntities.set(SCOPE, levelMap);
    GlobalState.sessionsByToken.set(client.token, client);

    const packet = clientAddBuffWire(dead.id, client.clientEntID);
    const parsedWire = (CombatHandler as any).parseAddBuffPacket(packet);
    assert.equal(parsedWire.targetId, dead.id, 'the first AddBuff field is the target entity');
    assert.equal(parsedWire.sourceId, client.clientEntID, 'the second AddBuff field is the source entity');
    (CombatHandler as any).recordServerAuthorityBuffPacket(client, 0x0B, packet);
    const removal = new BitBuffer(false);
    removal.writeMethod9(dead.id);
    removal.writeMethod9(client.clientEntID);
    removal.writeMethod9(729);
    (CombatHandler as any).recordServerAuthorityBuffPacket(client, 0x0C, removal.toBuffer());
    assert.equal(Object.keys(dead.activeBuffs).length, 0, 'removed or dispelled Plague must not transfer later');
    for (let stack = 0; stack < 4; stack += 1) {
        (CombatHandler as any).recordServerAuthorityBuffPacket(client, 0x0B, packet);
    }
    const deadPlague = Object.values(dead.activeBuffs)[0] as any;
    assert.equal(deadPlague.buffId, 729);
    assert.equal(deadPlague.stackCount, 4, 'source target must track all Plague stacks');

    dead.dead = true;
    dead.hp = 0;
    dead.entState = EntityState.DEAD;
    (CombatHandler as any).clearCanonicalHostileBuffs(SCOPE, dead, 'death_cleanup_before_transfer');
    assert.equal(
        Object.keys(dead.activeBuffs).length,
        0,
        'normal death finalization clears the short-lived entity buff cache before defeat processing'
    );
    (CombatHandler as any).transferPlagueOnDefeat(client, SCOPE, dead.id, dead);

    assert.equal(Object.keys(dead.activeBuffs).length, 0, 'transferred Plague leaves the dead target');
    assert.equal(Object.keys(outsideRadius.activeBuffs).length, 0, 'targets outside 2000 radius are ignored');
    assert.equal(Object.keys(secondHop.activeBuffs).length, 0, 'only the nearest target receives Plague');
    const nearestPlague = Object.values(nearest.activeBuffs)[0] as any;
    assert.equal(nearestPlague.stackCount, 4, 'all stacks transfer to the nearest target');
    assert.ok(nearestPlague.expiresAt >= Date.now() + 8_500, 'transfer refreshes the nine-second duration');
    const transferredPacket = (CombatHandler as any).parseAddBuffPacket(Buffer.from(nearestPlague.payloadHex, 'hex'));
    assert.equal(transferredPacket.targetId, nearest.id);
    assert.equal(transferredPacket.sourceId, client.clientEntID, 'original caster remains the DoT source');
    assert.equal(transferredPacket.stackDelta, 1, 'transferred stacks use the natural one-stack AddBuff wire shape');
    assert.deepEqual(transferredPacket.mods, [{ id: 393, values: [0.20000000298023224] }]);
    assert.equal(
        sentPackets.filter((sent) =>
            sent.id === 0x0B &&
            (CombatHandler as any).parseAddBuffPacket(sent.payload)?.targetId === nearest.id
        ).length,
        4,
        'the owning client receives one visual AddBuff packet per preserved stack'
    );

    sentPackets.length = 0;
    await CombatHandler.handleBuffTickDot(client, (CombatHandler as any).buildBuffTickDotPayload({
        targetId: nearest.id,
        sourceId: client.clientEntID,
        powerId: 5941,
        damage: 100,
        rawDamage: -100,
        tailBits: 0
    }));
    assert.equal(nearest.hp, 900, 'a transferred Plague tick updates authoritative target HP');
    assert.equal(
        sentPackets.some((sent) => sent.id === 0x79),
        false,
        'the server does not echo a duplicate tick after the client already applied and reported it'
    );

    nearestPlague.expiresAt = Date.now() + 50;
    nearest.dead = true;
    nearest.hp = 0;
    nearest.entState = EntityState.DEAD;
    (CombatHandler as any).transferPlagueOnDefeat(client, SCOPE, nearest.id, nearest);
    const secondPlague = Object.values(secondHop.activeBuffs)[0] as any;
    assert.equal(secondPlague.stackCount, 4, 'stacks survive successive transfers');
    assert.ok(secondPlague.expiresAt >= Date.now() + 8_500, 'every hop refreshes duration');

    const lateScope = getLevelScopeKey(LEVEL, 'plague-late-lethal-add');
    const lateClient: any = {
        ...client,
        token: 88006,
        levelInstanceId: 'plague-late-lethal-add',
        clientEntID: 89006,
        knownEntityIds: new Set<number>([650001, 650002]),
        entityIdAliases: new Map<number, number>(),
        entities: new Map<number, any>(),
        sentPackets: [],
        send(id: number, payload: Buffer) { this.sentPackets.push({ id, payload: Buffer.from(payload) }); }
    };
    const lateDead = enemy(650001, 1000, 1000);
    const lateNearest = enemy(650002, 2900, 1000);
    GlobalState.levelEntities.set(lateScope, new Map([
        [lateDead.id, lateDead],
        [lateNearest.id, lateNearest]
    ]));
    GlobalState.sessionsByToken.set(lateClient.token, lateClient);
    lateDead.dead = true;
    lateDead.destroyed = true;
    lateDead.hp = 0;
    lateDead.entState = EntityState.DEAD;
    (CombatHandler as any).transferPlagueOnDefeat(lateClient, lateScope, lateDead.id, lateDead);
    assert.equal(lateDead.plagueTransferNonce, undefined, 'a death check before AddBuff must not consume the transfer nonce');
    await CombatHandler.handleAddBuff(lateClient, clientAddBuffWire(lateDead.id, lateClient.clientEntID));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(
        (Object.values(lateNearest.activeBuffs)[0] as any)?.stackCount,
        1,
        'Plague arriving just after lethal damage transfers to the nearest target'
    );
    assert.equal(Object.keys(lateDead.activeBuffs).length, 0, 'late lethal Plague is removed from the dead target after transfer');

    const tickOnlyDead = enemy(600005, 2000, 2000);
    const tickOnlyNearest = enemy(600006, 2250, 2000);
    levelMap.set(tickOnlyDead.id, tickOnlyDead);
    levelMap.set(tickOnlyNearest.id, tickOnlyNearest);
    (CombatHandler as any).recoverMissingPlagueFromDotTick(client, SCOPE, {
        targetId: tickOnlyDead.id,
        sourceId: client.clientEntID,
        powerId: 5941,
        damage: 777,
        rawDamage: -777,
        tailBits: 0
    });
    assert.equal(
        (Object.values(tickOnlyDead.activeBuffs)[0] as any)?.buffId,
        729,
        'a Plague DoT tick recovers a missing AddBuff snapshot'
    );
    tickOnlyDead.dead = true;
    tickOnlyDead.hp = 0;
    tickOnlyDead.entState = EntityState.DEAD;
    (CombatHandler as any).transferPlagueOnDefeat(client, SCOPE, tickOnlyDead.id, tickOnlyDead);
    assert.equal(
        (Object.values(tickOnlyNearest.activeBuffs)[0] as any)?.stackCount,
        1,
        'a recovered Plague snapshot transfers instead of being lost completely'
    );

    GlobalState.levelEntities.delete(SCOPE);
    GlobalState.sessionsByToken.delete(client.token);

    const localSentPackets: Array<{ id: number; payload: Buffer }> = [];
    const localDead = enemy(610001, 2000, 2000);
    const localNearest = enemy(610002, 2200, 2000);
    const localClient: any = {
        ...client,
        token: 88002,
        userId: 88002,
        clientEntID: 89002,
        knownEntityIds: new Set<number>([localDead.id, localNearest.id]),
        entityIdAliases: new Map<number, number>(),
        entities: new Map<number, any>([
            [localDead.id, localDead],
            [localNearest.id, localNearest]
        ]),
        sentPackets: localSentPackets,
        send(id: number, payload: Buffer) { localSentPackets.push({ id, payload: Buffer.from(payload) }); }
    };
    GlobalState.levelEntities.set(SCOPE, new Map<number, any>());
    GlobalState.sessionsByToken.set(localClient.token, localClient);

    const localPacket = clientAddBuffWire(localDead.id, localClient.clientEntID);
    for (let stack = 0; stack < 3; stack += 1) {
        await CombatHandler.handleAddBuff(localClient, localPacket);
    }
    assert.equal(
        (Object.values(localDead.activeBuffs)[0] as any)?.stackCount,
        3,
        'client-local hostiles must retain Plague state from the real AddBuff path'
    );

    // Real dungeon updates can replace the local entity object between AddBuff and death.
    // The transfer state must survive independently of that short-lived object instance.
    const replacementDead = { ...localDead, activeBuffs: {} };
    localClient.entities.set(localDead.id, replacementDead);

    const localDestroy = new BitBuffer(false);
    localDestroy.writeMethod9(localDead.id);
    await CombatHandler.handleEntityDestroy(localClient, localDestroy.toBuffer());
    assert.equal(localClient.entities.has(localDead.id), false, 'the real destroy path removes the defeated local hostile');
    const localTransferred = Object.values(localNearest.activeBuffs)[0] as any;
    assert.equal(localTransferred?.stackCount, 3, 'Plague transfers between client-local hostiles with stacks intact');
    assert.ok(
        localSentPackets.some((sent) =>
            sent.id === 0x0B &&
            (CombatHandler as any).parseAddBuffPacket(sent.payload)?.targetId === localNearest.id
        ),
        'the owning client directly receives a client-local Plague transfer'
    );

    GlobalState.levelEntities.delete(SCOPE);
    GlobalState.sessionsByToken.delete(localClient.token);

    const authorityLevel = 'JC_Mini2';
    const authorityScope = getLevelScopeKey(authorityLevel, INSTANCE);
    const authorityDead = enemy(620001, 3000, 3000);
    const authorityNearest = enemy(620002, 3240, 3000);
    const authoritySent: Array<{ id: number; payload: Buffer }> = [];
    const authorityClient: any = {
        ...client,
        token: 88003,
        userId: 88003,
        currentLevel: authorityLevel,
        clientEntID: 89003,
        knownEntityIds: new Set<number>([authorityDead.id, authorityNearest.id]),
        entityIdAliases: new Map<number, number>(),
        entities: new Map<number, any>([
            [authorityDead.id, authorityDead],
            [authorityNearest.id, authorityNearest]
        ]),
        sentPackets: authoritySent,
        send(id: number, payload: Buffer) { authoritySent.push({ id, payload: Buffer.from(payload) }); }
    };
    GlobalState.levelEntities.set(authorityScope, new Map<number, any>());
    GlobalState.sessionsByToken.set(authorityClient.token, authorityClient);
    await CombatHandler.handleAddBuff(
        authorityClient,
        clientAddBuffWire(authorityDead.id, authorityClient.clientEntID)
    );
    const authorityDestroy = new BitBuffer(false);
    authorityDestroy.writeMethod9(authorityDead.id);
    await CombatHandler.handleEntityDestroy(authorityClient, authorityDestroy.toBuffer());
    assert.equal(
        (Object.values(authorityNearest.activeBuffs)[0] as any)?.stackCount,
        1,
        'unresolved client-local hostiles in server-authority dungeons transfer before the early destroy return'
    );
    assert.ok(
        authoritySent.some((sent) =>
            sent.id === 0x0B &&
            (CombatHandler as any).parseAddBuffPacket(sent.payload)?.targetId === authorityNearest.id
        ),
        'the server-authority early-return path delivers the transferred Plague packet'
    );
    GlobalState.levelEntities.delete(authorityScope);
    GlobalState.sessionsByToken.delete(authorityClient.token);

    const initialAliasScope = getLevelScopeKey(authorityLevel, 'plague-initial-alias-instance');
    const initialDeadCanonical = {
        ...enemy(625001, 3000, 3000),
        dead: true,
        destroyed: true,
        hp: 0,
        entState: EntityState.DEAD
    };
    const initialRawTarget = {
        ...enemy(525001, 120, 100),
        name: initialDeadCanonical.name,
        canonicalEntityId: initialDeadCanonical.id,
        clientMovementReportCount: 4
    };
    const staleRemovalProxy = {
        ...enemy(525002, 160, 100),
        name: initialDeadCanonical.name,
        canonicalEntityId: initialDeadCanonical.id,
        clientMovementReportCount: 4
    };
    const initialAliasClient: any = {
        ...client,
        token: 88009,
        userId: 88009,
        currentLevel: authorityLevel,
        levelInstanceId: 'plague-initial-alias-instance',
        clientEntID: 89009,
        knownEntityIds: new Set<number>([
            initialDeadCanonical.id,
            initialRawTarget.id,
            staleRemovalProxy.id
        ]),
        entityIdAliases: new Map<number, number>([
            [initialRawTarget.id, initialDeadCanonical.id],
            [staleRemovalProxy.id, initialDeadCanonical.id]
        ]),
        entities: new Map<number, any>([
            [initialRawTarget.id, initialRawTarget],
            [staleRemovalProxy.id, staleRemovalProxy]
        ]),
        sentPackets: [],
        send(id: number, payload: Buffer) { this.sentPackets.push({ id, payload: Buffer.from(payload) }); }
    };
    GlobalState.levelEntities.set(initialAliasScope, new Map<number, any>([
        [initialDeadCanonical.id, initialDeadCanonical]
    ]));
    GlobalState.sessionsByToken.set(initialAliasClient.token, initialAliasClient);
    await CombatHandler.handleAddBuff(
        initialAliasClient,
        clientAddBuffWire(initialRawTarget.id, initialAliasClient.clientEntID)
    );
    assert.equal(
        (Object.values(initialRawTarget.activeBuffs)[0] as any)?.stackCount,
        1,
        'initial Plague application stays on the exact living raw target instead of a dead canonical alias'
    );
    assert.equal(
        Object.keys(initialDeadCanonical.activeBuffs).length,
        0,
        'initial Plague application is not recorded on the dead shared canonical entity'
    );
    initialAliasClient.entityIdAliases.set(staleRemovalProxy.id, initialRawTarget.id);
    await CombatHandler.handleRemoveBuff(
        initialAliasClient,
        clientRemoveBuffWire(staleRemovalProxy.id, initialAliasClient.clientEntID)
    );
    assert.equal(
        (Object.values(initialRawTarget.activeBuffs)[0] as any)?.stackCount,
        1,
        'a stale RemoveBuff from another raw proxy cannot erase Plague before its duration ends'
    );
    await CombatHandler.handleRemoveBuff(
        initialAliasClient,
        clientRemoveBuffWire(initialRawTarget.id, initialAliasClient.clientEntID)
    );
    assert.equal(
        Object.keys(initialRawTarget.activeBuffs).length,
        0,
        'the exact target can still remove its own Plague normally'
    );
    GlobalState.levelEntities.delete(initialAliasScope);
    GlobalState.sessionsByToken.delete(initialAliasClient.token);

    const aliasScope = getLevelScopeKey(authorityLevel, 'plague-alias-instance');
    const aliasDeadCanonical = enemy(630001, 3000, 3000);
    const aliasNearestCanonical = enemy(630002, 3240, 3000);
    const aliasDeadLocal = { ...enemy(530001, 100, 100), canonicalEntityId: aliasDeadCanonical.id };
    const aliasNearestLocal = {
        ...enemy(530002, 180, 100),
        canonicalEntityId: aliasDeadCanonical.id,
        // Reproduce canonical death mirroring: this distinct live proxy was falsely cached dead.
        dead: true,
        destroyed: true,
        hp: 0,
        entState: EntityState.DEAD
    };
    const aliasDeadDuplicate = {
        ...enemy(530003, 100, 100),
        canonicalEntityId: aliasDeadCanonical.id,
        dead: true,
        destroyed: true,
        hp: 0,
        entState: EntityState.DEAD
    };
    const priorDeadCanonical = {
        ...enemy(630010, 140, 100),
        dead: true,
        destroyed: true,
        hp: 0,
        entState: EntityState.DEAD
    };
    const priorDeadProxy = {
        ...enemy(530010, 140, 100),
        canonicalEntityId: priorDeadCanonical.id,
        dead: true,
        destroyed: true,
        hp: 0,
        entState: EntityState.DEAD
    };
    const aliasSent: Array<{ id: number; payload: Buffer }> = [];
    const aliasClient: any = {
        ...client,
        token: 88004,
        userId: 88004,
        currentLevel: authorityLevel,
        levelInstanceId: 'plague-alias-instance',
        clientEntID: 89004,
        knownEntityIds: new Set<number>([
            aliasDeadCanonical.id,
            aliasNearestCanonical.id,
            aliasDeadLocal.id,
            aliasNearestLocal.id,
            aliasDeadDuplicate.id,
            priorDeadCanonical.id,
            priorDeadProxy.id
        ]),
        entityIdAliases: new Map<number, number>([
            [aliasDeadLocal.id, aliasDeadCanonical.id],
            [aliasNearestLocal.id, aliasDeadCanonical.id],
            [aliasDeadDuplicate.id, aliasDeadCanonical.id],
            [priorDeadProxy.id, priorDeadCanonical.id]
        ]),
        entities: new Map<number, any>([
            [aliasDeadLocal.id, aliasDeadLocal],
            [aliasNearestLocal.id, aliasNearestLocal],
            [aliasDeadDuplicate.id, aliasDeadDuplicate],
            [priorDeadProxy.id, priorDeadProxy]
        ]),
        sentPackets: aliasSent,
        send(id: number, payload: Buffer) { aliasSent.push({ id, payload: Buffer.from(payload) }); }
    };
    GlobalState.levelEntities.set(aliasScope, new Map<number, any>([
        [aliasDeadCanonical.id, aliasDeadCanonical],
        [aliasNearestCanonical.id, aliasNearestCanonical],
        [priorDeadCanonical.id, priorDeadCanonical]
    ]));
    GlobalState.sessionsByToken.set(aliasClient.token, aliasClient);
    CombatHandler.markRawHostileDefeated(
        aliasClient,
        aliasScope,
        priorDeadCanonical.id,
        priorDeadCanonical
    );
    await CombatHandler.handleAddBuff(
        aliasClient,
        clientAddBuffWire(aliasDeadLocal.id, aliasClient.clientEntID)
    );
    aliasDeadCanonical.dead = true;
    aliasDeadCanonical.hp = 0;
    aliasDeadCanonical.entState = EntityState.DEAD;
    (CombatHandler as any).transferPlagueOnDefeat(
        aliasClient,
        aliasScope,
        aliasDeadCanonical.id,
        aliasDeadCanonical
    );
    assert.equal(
        (Object.values(aliasNearestLocal.activeBuffs)[0] as any)?.stackCount,
        1,
        'a distinct raw hostile remains independently eligible even when it shares an alias group'
    );
    assert.equal(
        (Object.values(aliasDeadLocal.activeBuffs)[0] as any)?.stackCount,
        1,
        'the dead local proxy keeps only its original snapshot and is not stacked as its own transfer target'
    );
    assert.ok(
        aliasClient.defeatedRawHostileIds.has(aliasDeadDuplicate.id),
        'all same-position aliases of the defeated body are permanently retired from later hops'
    );
    GlobalState.levelEntities.delete(aliasScope);
    GlobalState.sessionsByToken.delete(aliasClient.token);

    const visualAliasScope = getLevelScopeKey(authorityLevel, 'plague-visual-alias-instance');
    const visualDeadCanonical = enemy(635001, 3000, 3000);
    const visualNearestCanonical = {
        ...enemy(635002, 250, 100),
        // A shared canonical shadow can carry a raw proxy's latest coordinates. It is inserted
        // before the real proxy to reproduce the live tie that previously selected this id.
        lastClientMovementAt: Date.now(),
        lastClientMovementRawId: 535002,
        clientMovementReportCount: 3
    };
    const canonicalDecoy = enemy(635003, 3400, 3000);
    const visualNearestRawId = 535002;
    const visualDeadLocal = {
        ...enemy(535001, 100, 100),
        name: visualDeadCanonical.name,
        canonicalEntityId: visualDeadCanonical.id,
        clientMovementReportCount: 3
    };
    const visualNearestLocal = {
        ...enemy(visualNearestRawId, 250, 100),
        // Some dungeon proxies retain the canonical id in the object even though the map/wire id
        // is distinct. Transfers must address the map key that the client actually renders.
        id: visualNearestCanonical.id,
        name: visualNearestCanonical.name,
        canonicalEntityId: visualNearestCanonical.id,
        lastClientMovementAt: Date.now(),
        lastClientMovementRawId: visualNearestRawId,
        clientMovementReportCount: 3
    };
    const unrelatedSameNameDeadProxy = {
        ...enemy(535004, 10000, 100),
        name: visualDeadCanonical.name,
        dead: true,
        hp: 0,
        entState: EntityState.DEAD
    };
    const wrongRemoteCandidate = enemy(535005, 10050, 100);
    const staleSpawnNearest = enemy(635006, 7100, 3000);
    const livePositionNearest = {
        ...enemy(535007, 400, 100),
        name: visualNearestCanonical.name,
        canonicalEntityId: visualNearestCanonical.id,
        clientMovementReportCount: 3
    };
    const staleRawDecoy = {
        ...enemy(535008, 110, 100),
        // This is the exact failure mode from the live trace: a spawn-only proxy is physically
        // closer in stale server data, but it never joined the client's ongoing AI update stream.
        clientMovementReportCount: 1
    };
    const visualAliasClient: any = {
        ...client,
        token: 88007,
        userId: 88007,
        currentLevel: authorityLevel,
        levelInstanceId: 'plague-visual-alias-instance',
        clientEntID: 89007,
        knownEntityIds: new Set<number>([
            visualDeadCanonical.id,
            visualNearestCanonical.id,
            canonicalDecoy.id,
            visualDeadLocal.id,
            visualNearestRawId,
            unrelatedSameNameDeadProxy.id,
            wrongRemoteCandidate.id,
            staleSpawnNearest.id,
            livePositionNearest.id,
            staleRawDecoy.id
        ]),
        entityIdAliases: new Map<number, number>([
            [visualDeadLocal.id, visualDeadCanonical.id],
            [visualNearestRawId, visualNearestCanonical.id],
            [livePositionNearest.id, visualNearestCanonical.id],
            // Reproduce the live dungeon's polluted same-name alias table. This proxy is not the
            // creature that received Plague and must never be used as the transfer origin.
            [unrelatedSameNameDeadProxy.id, visualDeadCanonical.id]
        ]),
        entities: new Map<number, any>([
            [visualDeadLocal.id, visualDeadLocal],
            // Canonical-id client entries are stale authored-spawn copies in the affected dungeon.
            // The distinct local proxy below must replace this position for proximity checks.
            [visualNearestCanonical.id, visualNearestCanonical],
            [visualNearestRawId, visualNearestLocal],
            [unrelatedSameNameDeadProxy.id, unrelatedSameNameDeadProxy],
            [wrongRemoteCandidate.id, wrongRemoteCandidate],
            [livePositionNearest.id, livePositionNearest],
            [staleRawDecoy.id, staleRawDecoy]
        ]),
        sentPackets: [],
        send(id: number, payload: Buffer) { this.sentPackets.push({ id, payload: Buffer.from(payload) }); }
    };
    GlobalState.levelEntities.set(visualAliasScope, new Map<number, any>([
        [visualDeadCanonical.id, visualDeadCanonical],
        [visualNearestCanonical.id, visualNearestCanonical],
        [canonicalDecoy.id, canonicalDecoy],
        [staleSpawnNearest.id, staleSpawnNearest]
    ]));
    GlobalState.sessionsByToken.set(visualAliasClient.token, visualAliasClient);
    await CombatHandler.handleAddBuff(
        visualAliasClient,
        clientAddBuffWire(visualDeadLocal.id, visualAliasClient.clientEntID)
    );
    visualDeadCanonical.dead = true;
    visualDeadCanonical.hp = 0;
    visualDeadCanonical.entState = EntityState.DEAD;
    (CombatHandler as any).transferPlagueOnDefeat(
        visualAliasClient,
        visualAliasScope,
        visualDeadCanonical.id,
        visualDeadCanonical
    );
    assert.equal(
        (Object.values(visualNearestLocal.activeBuffs)[0] as any)?.stackCount,
        1,
        'transfer uses the owning client proxy when it is the current on-screen position'
    );
    assert.equal(
        Object.keys(canonicalDecoy.activeBuffs).length,
        0,
        'a farther canonical-only enemy does not replace the visually nearest proxy target'
    );
    assert.equal(
        Object.keys(wrongRemoteCandidate.activeBuffs).length,
        0,
        'an unrelated same-name dead proxy cannot become a false transfer origin'
    );
    assert.ok(
        visualAliasClient.sentPackets.some((sent: { id: number; payload: Buffer }) =>
            sent.id === 0x0B &&
            (CombatHandler as any).parseAddBuffPacket(sent.payload)?.targetId === visualNearestRawId
        ),
        'the owning client receives Plague on the exact local proxy selected by proximity'
    );
    assert.equal(
        (Object.values(visualNearestLocal.activeBuffs)[0] as any)?.observedRawTargetId,
        visualNearestRawId,
        'a transferred stack remembers the exact live proxy that visibly received it'
    );
    // Reproduce the intermittent live race: a later entity update reintroduces the old alias
    // after transfer. The promoted proxy must remain independently addressable or its next 0x79
    // tick resolves to the already-dead source and is discarded before damage is applied.
    visualAliasClient.entityIdAliases.set(visualNearestRawId, visualNearestCanonical.id);
    assert.equal(
        EntityHandler.resolveEntityAlias(visualAliasClient, visualNearestRawId),
        visualNearestRawId,
        'a promoted Plague target cannot be rebound to its former canonical alias'
    );
    visualAliasClient.entityIdAliases.set(wrongRemoteCandidate.id, visualNearestRawId);
    assert.equal(
        EntityHandler.resolveEntityLocalId(visualAliasClient, visualNearestRawId),
        visualNearestRawId,
        'inverse alias lookup cannot redirect a promoted Plague target to another raw proxy'
    );
    await CombatHandler.handleBuffTickDot(
        visualAliasClient,
        (CombatHandler as any).buildBuffTickDotPayload({
            targetId: visualNearestRawId,
            sourceId: visualAliasClient.clientEntID,
            powerId: 5941,
            damage: 100,
            rawDamage: -100,
            tailBits: 0
        })
    );
    assert.equal(
        visualNearestLocal.hp,
        visualNearestLocal.maxHp - 100,
        'a transferred Plague tick still damages the exact proxy after alias pollution returns'
    );
    assert.equal(
        visualAliasClient.entityIdAliases.get(livePositionNearest.id),
        visualNearestCanonical.id,
        'collecting same-name health copies cannot rewrite a distinct physical hostile onto the Plague target'
    );
    visualNearestCanonical.dead = true;
    visualNearestCanonical.hp = 0;
    visualNearestCanonical.entState = EntityState.DEAD;
    visualNearestLocal.dead = true;
    visualNearestLocal.hp = 0;
    visualNearestLocal.entState = EntityState.DEAD;
    (CombatHandler as any).transferPlagueOnDefeat(
        visualAliasClient,
        visualAliasScope,
        visualNearestRawId,
        visualNearestLocal
    );
    assert.equal(
        (Object.values(livePositionNearest.activeBuffs)[0] as any)?.stackCount,
        1,
        'the next transfer in a chain measures from the defeated proxy current position'
    );
    assert.equal(
        Object.keys(staleSpawnNearest.activeBuffs).length,
        0,
        'an enemy near the defeated target authored spawn point is not selected'
    );
    assert.equal(
        Object.keys(staleRawDecoy.activeBuffs).length,
        0,
        'a one-shot spawn proxy cannot outrank hostiles with continuous live position reports'
    );
    GlobalState.levelEntities.delete(visualAliasScope);
    GlobalState.sessionsByToken.delete(visualAliasClient.token);

    const deathAliasRaceLevel = 'JC_Mini1Hard';
    const deathAliasRaceScope = getLevelScopeKey(deathAliasRaceLevel, 'plague-death-alias-race');
    const deathAliasCanonical = {
        ...enemy(637001, 3000, 3000),
        ownerToken: 88008,
        aiOwnerToken: 88008,
        clientSpawned: false
    };
    const deathAliasRawA = {
        ...enemy(537001, 100, 100),
        canonicalEntityId: deathAliasCanonical.id,
        clientMovementReportCount: 8
    };
    const deathAliasRawB = {
        ...enemy(537002, 140, 100),
        canonicalEntityId: deathAliasCanonical.id,
        clientMovementReportCount: 8
    };
    const deathAliasRaceClient: any = {
        ...client,
        token: 88008,
        userId: 88008,
        currentLevel: deathAliasRaceLevel,
        levelInstanceId: 'plague-death-alias-race',
        clientEntID: 89008,
        knownEntityIds: new Set<number>([
            deathAliasCanonical.id,
            deathAliasRawA.id,
            deathAliasRawB.id
        ]),
        entityIdAliases: new Map<number, number>([
            [deathAliasRawA.id, deathAliasCanonical.id],
            [deathAliasRawB.id, deathAliasCanonical.id]
        ]),
        entities: new Map<number, any>([
            [deathAliasRawA.id, deathAliasRawA],
            [deathAliasRawB.id, deathAliasRawB]
        ]),
        sentPackets: [],
        send(id: number, payload: Buffer) { this.sentPackets.push({ id, payload: Buffer.from(payload) }); }
    };
    GlobalState.levelEntities.set(deathAliasRaceScope, new Map<number, any>([
        [deathAliasCanonical.id, deathAliasCanonical]
    ]));
    GlobalState.sessionsByToken.set(deathAliasRaceClient.token, deathAliasRaceClient);
    // Reproduce the lossy registry: B registered last, so a generic canonical death lookup would
    // destroy B even though A is the exact raw entity carrying Plague.
    EntityHandler.registerCanonicalHostileAlias(
        deathAliasRaceClient,
        deathAliasRaceScope,
        deathAliasCanonical,
        deathAliasRawA.id,
        'plague_death_alias_race_a'
    );
    EntityHandler.registerCanonicalHostileAlias(
        deathAliasRaceClient,
        deathAliasRaceScope,
        deathAliasCanonical,
        deathAliasRawB.id,
        'plague_death_alias_race_b'
    );
    await CombatHandler.handleAddBuff(
        deathAliasRaceClient,
        clientAddBuffWire(deathAliasRawA.id, deathAliasRaceClient.clientEntID)
    );
    deathAliasRaceClient.sentPackets.length = 0;
    (CombatHandler as any).finalizeHostileDeath(
        deathAliasRaceClient,
        deathAliasRaceScope,
        deathAliasCanonical.id,
        deathAliasCanonical,
        { includeAnchor: true, reason: 'plague_death_alias_race' }
    );
    const destroyedIds = deathAliasRaceClient.sentPackets
        .filter((sent: { id: number }) => sent.id === 0x0D)
        .map((sent: { payload: Buffer }) => new BitReader(sent.payload).readMethod4());
    assert.ok(
        destroyedIds.includes(deathAliasRawA.id),
        'the terminal correction destroys the exact plague-bearing raw entity A'
    );
    assert.ok(
        !destroyedIds.includes(deathAliasRawB.id),
        'A death must not be translated onto the freshly plagued raw entity B'
    );
    assert.ok(
        deathAliasRaceClient.entities.has(deathAliasRawB.id),
        'B remains present after receiving the transferred Plague stack'
    );
    assert.equal(
        (Object.values(deathAliasRawB.activeBuffs)[0] as any)?.stackCount,
        1,
        'B retains the transferred stack after A terminal correction'
    );
    GlobalState.levelEntities.delete(deathAliasRaceScope);
    GlobalState.sessionsByToken.delete(deathAliasRaceClient.token);

    const lethalScope = getLevelScopeKey(LEVEL, 'plague-lethal-finalize');
    const lethalDead = enemy(640001, 4000, 4000);
    const lethalNearest = enemy(640002, 4250, 4000);
    const lethalClient: any = {
        ...client,
        token: 88005,
        userId: 88005,
        levelInstanceId: 'plague-lethal-finalize',
        clientEntID: 89005,
        knownEntityIds: new Set<number>([lethalDead.id, lethalNearest.id]),
        entityIdAliases: new Map<number, number>(),
        entities: new Map<number, any>(),
        sentPackets: [],
        send(id: number, payload: Buffer) { this.sentPackets.push({ id, payload: Buffer.from(payload) }); }
    };
    GlobalState.levelEntities.set(lethalScope, new Map<number, any>([
        [lethalDead.id, lethalDead],
        [lethalNearest.id, lethalNearest]
    ]));
    GlobalState.sessionsByToken.set(lethalClient.token, lethalClient);
    await CombatHandler.handleAddBuff(
        lethalClient,
        clientAddBuffWire(lethalDead.id, lethalClient.clientEntID)
    );
    (CombatHandler as any).finalizeHostileDeath(
        lethalClient,
        lethalScope,
        lethalDead.id,
        lethalDead,
        { includeAnchor: true, reason: 'plague_lethal_dot_regression' }
    );
    assert.equal(
        (Object.values(lethalNearest.activeBuffs)[0] as any)?.stackCount,
        1,
        'the common lethal HP/DoT finalizer transfers Plague without relying on defeat-state processing'
    );
    GlobalState.levelEntities.delete(lethalScope);
    GlobalState.sessionsByToken.delete(lethalClient.token);
    console.log('plague battalion transfer regression passed');
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
