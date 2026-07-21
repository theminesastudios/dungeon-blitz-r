/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
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
        token: 71_000 + ordinal,
        userId: 72_000 + ordinal,
        character: {
            name: `RingOfFire${ordinal}`,
            level: levelName.endsWith('Hard') ? 42 : 27,
            class: 'mage',
            CurrentLevel: { name: levelName, x: 0, y: 0 }
        },
        currentLevel: levelName,
        levelInstanceId: `ring-of-fire-${ordinal}`,
        currentRoomId: 11,
        playerSpawned: true,
        clientEntID: 73_000 + ordinal,
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
        clientSpawned: false,
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

// Ring of Fire keeps requireRoomBossMarker, but the authored BrigandChamp can
// die before its room-boss marker lands. A terminal server-spawned canonical
// boss must still complete the dungeon, exactly like Goblin Diplomacy.
function verifyTerminalCanonicalBossWithoutMarker(levelName: string, ordinal: number): void {
    const client = createClient(levelName, ordinal);
    const levelScope = getClientLevelScope(client as never);
    const boss = createBoss(74_000 + ordinal, 'BrigandChamp', 0);
    client.entities.set(boss.id, boss);
    GlobalState.levelEntities.set(levelScope, new Map([[boss.id, boss]]));
    GlobalState.sessionsByToken.set(client.token, client as never);

    LevelHandler.handleEntityIncrementalUpdate(client as never, buildDeadStatePayload(boss.id));
    assert.equal(
        DungeonCompletionSystem.evaluate(levelScope).ready,
        true,
        `${levelName}: terminal canonical Brigand Champ without a marker did not complete the dungeon`
    );

    DungeonCompletionSystem.reset(levelScope);
    GlobalState.levelEntities.delete(levelScope);
    GlobalState.sessionsByToken.delete(client.token);
}

// The bypass is deliberately narrow: a live decoy must still be rejected so a
// pre-boss Brigand Champ copy cannot end the run early.
function verifyLiveCanonicalBossStillNeedsMarker(levelName: string, ordinal: number): void {
    const boss = createBoss(75_000 + ordinal, 'BrigandChamp', 1000);
    assert.equal(
        DungeonCompletionConditions.isRequiredBoss(levelName, boss, ''),
        false,
        `${levelName}: a live unmarked Brigand Champ satisfied final-boss recognition`
    );
}

function main(): void {
    LevelConfig.load(path.resolve(__dirname, '../data'));
    verifyTerminalCanonicalBossWithoutMarker('JC_Mission11', 1);
    verifyTerminalCanonicalBossWithoutMarker('JC_Mission11Hard', 2);
    verifyLiveCanonicalBossStillNeedsMarker('JC_Mission11', 3);
    verifyLiveCanonicalBossStillNeedsMarker('JC_Mission11Hard', 4);
    console.log('ring_of_fire_completion_regression: ok');
}

main();
