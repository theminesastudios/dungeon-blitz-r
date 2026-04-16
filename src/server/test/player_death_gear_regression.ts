import { strict as assert } from 'assert';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';
import { CombatHandler } from '../handlers/CombatHandler';
import { Entity, EntityState } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { getClientLevelScope } from '../core/LevelScope';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    userId: number | null;
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    character: any;
    authoritativeMaxHp: number;
    authoritativeCurrentHp: number;
    processedRewardSources: Set<string>;
    pendingLoot: Map<number, any>;
    knownEntityIds: Set<number>;
    entities: Map<number, any>;
    sentPackets: SentPacket[];
    keepTutorialState: null;
    send: (id: number, payload: Buffer) => void;
    sendBitBuffer: (id: number, payload: BitBuffer) => void;
};

function resetGlobalState(): void {
    GlobalState.sessionsByToken.clear();
    GlobalState.sessionsByUserId.clear();
    GlobalState.sessionsByCharacterName.clear();
    GlobalState.levelEntities.clear();
    GlobalState.levelQuestProgress.clear();
    GlobalState.combatContributions.clear();
    GlobalState.entityLifeNonces.clear();
    GlobalState.entityLastRewardNonces.clear();
}

function createClient(token: number, name: string, entityId: number): FakeClient {
    const sentPackets: SentPacket[] = [];

    return {
        token,
        userId: token,
        currentLevel: 'BridgeTown',
        levelInstanceId: '',
        currentRoomId: 1,
        playerSpawned: true,
        clientEntID: entityId,
        character: {
            name,
            class: 'Mage',
            level: 10,
            MasterClass: 0,
            equippedGears: [
                { gearID: 1177, tier: 2, runes: [101, 102, 103], colors: [4, 5] },
                { gearID: 1181, tier: 1, runes: [0, 0, 0], colors: [0, 0] },
                { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] },
                { gearID: 65, tier: 0, runes: [0, 0, 0], colors: [0, 0] },
                { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] },
                { gearID: 0, tier: 0, runes: [0, 0, 0], colors: [0, 0] }
            ]
        },
        authoritativeMaxHp: 100,
        authoritativeCurrentHp: 100,
        processedRewardSources: new Set<string>(),
        pendingLoot: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entities: new Map<number, any>(),
        sentPackets,
        keepTutorialState: null,
        send(id: number, payload: Buffer) {
            sentPackets.push({ id, payload: Buffer.from(payload) });
        },
        sendBitBuffer(id: number, payload: BitBuffer) {
            sentPackets.push({ id, payload: payload.toBuffer() });
        }
    };
}

function attachPlayer(client: FakeClient): void {
    const entity = {
        ...Entity.fromCharacter(client.clientEntID, client.character, {
            x: 0,
            y: 0,
            team: 1,
            entState: EntityState.ACTIVE,
            roomId: client.currentRoomId
        }),
        hp: client.authoritativeCurrentHp,
        maxHp: client.authoritativeMaxHp,
        roomId: client.currentRoomId,
        ownerToken: client.token
    };

    client.entities.set(client.clientEntID, entity);
    client.knownEntityIds.add(client.clientEntID);

    const levelScope = getClientLevelScope(client as never);
    let levelMap = GlobalState.levelEntities.get(levelScope);
    if (!levelMap) {
        levelMap = new Map<number, any>();
        GlobalState.levelEntities.set(levelScope, levelMap);
    }

    levelMap.set(client.clientEntID, entity);
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

function buildRespawnBroadcastPayload(entityId: number, healAmount: number, usedPotion: boolean = false): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod24(healAmount);
    bb.writeMethod15(usedPotion);
    return bb.toBuffer();
}

function parseGearUpdate(payload: Buffer): { entityId: number; slots: Array<{ present: boolean; gearId: number; tier: number }> } {
    const br = new BitReader(payload);
    const entityId = br.readMethod4();
    const slots = [];

    for (let i = 0; i < 6; i++) {
        const present = br.readMethod15();
        const hasGear = br.readMethod15();
        if (!present || !hasGear) {
            slots.push({ present, gearId: 0, tier: 0 });
            continue;
        }

        const gearId = br.readMethod6(11);
        const tier = br.readMethod6(2);
        br.readMethod6(16);
        br.readMethod6(16);
        br.readMethod6(16);
        br.readMethod6(8);
        br.readMethod6(8);
        slots.push({ present, gearId, tier });
    }

    return { entityId, slots };
}

async function testDeathAndRespawnResendFullGearPacket(): Promise<void> {
    resetGlobalState();

    const attacker = createClient(1, 'Attacker', 1001);
    const victim = createClient(2, 'Victim', 1002);

    attachPlayer(attacker);
    attachPlayer(victim);

    attacker.knownEntityIds.add(victim.clientEntID);
    victim.knownEntityIds.add(attacker.clientEntID);

    GlobalState.sessionsByToken.set(attacker.token, attacker as never);
    GlobalState.sessionsByToken.set(victim.token, victim as never);

    await CombatHandler.handlePowerHit(
        attacker as never,
        buildPowerHitPayload(victim.clientEntID, attacker.clientEntID, 100, 42)
    );

    const deathGearPackets = victim.sentPackets.filter((packet) => packet.id === 0xAF);
    assert.ok(deathGearPackets.length >= 1, 'victim should receive a full gear resync on death');

    const deathGear = parseGearUpdate(deathGearPackets[0].payload);
    assert.equal(deathGear.entityId, victim.clientEntID);
    assert.deepEqual(
        deathGear.slots.map((slot) => ({ gearId: slot.gearId, tier: slot.tier })),
        [
            { gearId: 1177, tier: 2 },
            { gearId: 1181, tier: 1 },
            { gearId: 0, tier: 0 },
            { gearId: 65, tier: 0 },
            { gearId: 0, tier: 0 },
            { gearId: 0, tier: 0 }
        ]
    );

    const attackerDeathView = attacker.sentPackets.filter((packet) => packet.id === 0xAF);
    assert.ok(attackerDeathView.length >= 1, 'other players should receive the victim gear resync on death');

    victim.sentPackets.length = 0;
    attacker.sentPackets.length = 0;

    await CombatHandler.handleRespawnBroadcast(
        victim as never,
        buildRespawnBroadcastPayload(victim.clientEntID, 100, false)
    );

    const respawnGearPackets = victim.sentPackets.filter((packet) => packet.id === 0xAF);
    assert.ok(respawnGearPackets.length >= 1, 'victim should receive a full gear resync on respawn');

    const attackerRespawnView = attacker.sentPackets.filter((packet) => packet.id === 0xAF);
    assert.ok(attackerRespawnView.length >= 1, 'other players should receive the victim gear resync on respawn');
}

async function main(): Promise<void> {
    await testDeathAndRespawnResendFullGearPacket();
    console.log('player_death_gear_regression: ok');
}

main().catch((error) => {
    console.error('player_death_gear_regression: failed');
    console.error(error);
    process.exitCode = 1;
}).finally(() => {
    resetGlobalState();
});
