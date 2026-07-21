/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { markRoomBossEntity } from '../core/RoomBossState';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type FakeClient = {
    token: number;
    userId: number;
    character: {
        name: string;
        level: number;
        class: string;
        CurrentLevel: { name: string; x: number; y: number };
    };
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    clientEntID: number;
    entities: Map<number, any>;
    knownEntityIds: Set<number>;
    entityIdAliases: Map<number, number>;
    sharedEntityRemoteUpdateDeferredIds: Set<number>;
    sentPacketIds: number[];
    send: (id: number) => void;
    sendBitBuffer: (id: number) => void;
};

function createClient(levelName: string, ordinal: number): FakeClient {
    return {
        token: 61_000 + ordinal,
        userId: 62_000 + ordinal,
        character: {
            name: `GoblinDiplomacy${ordinal}`,
            level: levelName.endsWith('Hard') ? 39 : 24,
            class: 'mage',
            CurrentLevel: { name: levelName, x: 0, y: 0 }
        },
        currentLevel: levelName,
        levelInstanceId: `goblin-diplomacy-${ordinal}`,
        currentRoomId: 11,
        playerSpawned: true,
        clientEntID: 63_000 + ordinal,
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        sharedEntityRemoteUpdateDeferredIds: new Set<number>(),
        sentPacketIds: [],
        send(id: number): void {
            this.sentPacketIds.push(id);
        },
        sendBitBuffer(id: number): void {
            this.sentPacketIds.push(id);
        }
    };
}

function createBoss(id: number, name: string, hp: number): any {
    return {
        id,
        name,
        EntName: name,
        characterName: `,${name}`,
        clientSpawned: true,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        roomId: 11,
        x: 3200,
        y: 800,
        v: 0,
        hp,
        maxHp: 1000,
        dead: false,
        destroyed: false,
        entState: EntityState.ACTIVE
    };
}

function buildDeadStatePayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod45(0);
    bb.writeMethod45(0);
    bb.writeMethod45(0);
    bb.writeMethod6(EntityState.DEAD, 2);
    for (let index = 0; index < 6; index += 1) {
        bb.writeMethod15(false);
    }
    return bb.toBuffer();
}

function verifyTerminalCanonicalBossWithoutMarker(): void {
    const client = createClient('SD_Mission4', 5);
    const levelScope = getClientLevelScope(client as never);
    const boss = createBoss(64_005, 'OasisVizier', 0);
    boss.clientSpawned = false;
    client.entities.set(boss.id, boss);
    GlobalState.levelEntities.set(levelScope, new Map([[boss.id, boss]]));
    GlobalState.sessionsByToken.set(client.token, client as never);

    LevelHandler.handleEntityIncrementalUpdate(client as never, buildDeadStatePayload(boss.id));
    assert.equal(
        DungeonCompletionSystem.evaluate(levelScope).reason,
        'cutscene_gate_pending',
        'terminal canonical Oasis Vizier without a marker did not reach completion'
    );

    DungeonCompletionSystem.reset(levelScope);
    GlobalState.levelEntities.delete(levelScope);
    GlobalState.sessionsByToken.delete(client.token);
}

function verifyClientBossDeath(
    levelName: string,
    bossName: string,
    ordinal: number,
    initialHp: number
): void {
    const client = createClient(levelName, ordinal);
    const levelScope = getClientLevelScope(client as never);
    const boss = createBoss(64_000 + ordinal, bossName, 1000);

    client.entities.set(boss.id, boss);
    GlobalState.levelEntities.set(levelScope, new Map([[boss.id, boss]]));
    GlobalState.sessionsByToken.set(client.token, client as never);

    // The boss-info marker can arrive before the entity cache is promoted or
    // copied. Recognition must therefore consult the scoped marker registry.
    const unmarkedCopy = { ...boss };
    GlobalState.levelEntities.get(levelScope)!.set(boss.id, unmarkedCopy);
    client.entities.set(boss.id, unmarkedCopy);
    markRoomBossEntity(levelScope, boss.id, boss.roomId, 'Dejih the Ogre-Magus');
    delete unmarkedCopy.isRoomBoss;
    delete unmarkedCopy.roomBoss;
    delete unmarkedCopy.roomBossRoomId;
    delete unmarkedCopy.roomBossName;

    const introStartedAt = 10_000 + ordinal * 10;
    DungeonCompletionSystem.noteCutsceneStart(levelScope, boss.roomId, introStartedAt);
    DungeonCompletionSystem.noteCutsceneEnd(levelScope, boss.roomId, introStartedAt + 1);

    const clone = createBoss(unmarkedCopy.id + 100, bossName, 0);
    clone.dead = true;
    clone.entState = EntityState.DEAD;
    DungeonCompletionSystem.noteEntityDefeated(levelScope, clone, introStartedAt + 2);
    assert.equal(
        DungeonCompletionSystem.evaluate(levelScope, introStartedAt + 3).objectivesMet,
        false,
        `${levelName}: unmarked pre-boss clone completed the dungeon`
    );

    unmarkedCopy.hp = initialHp;

    assert.equal(
        DungeonCompletionConditions.isClientAuthorityBoss(levelName, unmarkedCopy, levelScope),
        true,
        `${levelName}: scoped Ogre-Magus marker did not authorize the authored client boss`
    );
    assert.equal(unmarkedCopy.hp, initialHp, `${levelName}: unexpected cached boss HP before terminal state`);

    LevelHandler.handleEntityIncrementalUpdate(
        client as never,
        buildDeadStatePayload(unmarkedCopy.id)
    );

    assert.equal(unmarkedCopy.hp, 0, `${levelName}: client boss death was rejected while cached HP was positive`);
    assert.equal(unmarkedCopy.dead, true, `${levelName}: client boss death did not become terminal`);
    assert.equal(
        DungeonCompletionSystem.evaluate(levelScope).reason,
        'cutscene_gate_pending',
        `${levelName}: boss death did not reach the authored ending gate`
    );

    const startedAt = introStartedAt + 20;
    DungeonCompletionSystem.noteCutsceneStart(levelScope, boss.roomId, startedAt);
    assert.equal(
        DungeonCompletionSystem.noteCutsceneEnd(levelScope, boss.roomId, startedAt + 1),
        true,
        `${levelName}: summary did not become ready after the defeat cutscene`
    );

    DungeonCompletionSystem.reset(levelScope);
    GlobalState.levelEntities.delete(levelScope);
    GlobalState.sessionsByToken.delete(client.token);
}

function main(): void {
    LevelConfig.load(path.resolve(__dirname, '../data'));
    verifyClientBossDeath('SD_Mission4', 'OasisVizier', 1, 1000);
    verifyClientBossDeath('SD_Mission4Hard', 'OasisVizier', 2, 1000);
    verifyClientBossDeath('SD_Mission4', 'OasisVizier', 3, 0);
    verifyClientBossDeath('SD_Mission4Hard', 'OasisVizier', 4, 0);
    verifyTerminalCanonicalBossWithoutMarker();
    console.log('goblin_diplomacy_completion_regression: ok');
}

main();
