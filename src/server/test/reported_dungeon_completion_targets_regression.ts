/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
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
        token: 71_000 + ordinal,
        userId: 72_000 + ordinal,
        character: {
            name: `ReportedCompletion${ordinal}`,
            level: levelName.endsWith('Hard') ? 39 : 24,
            class: 'mage',
            CurrentLevel: { name: levelName, x: 0, y: 0 }
        },
        currentLevel: levelName,
        levelInstanceId: `reported-completion-${ordinal}`,
        currentRoomId: 9,
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

function createClientBoss(id: number, name: string): any {
    return {
        id,
        name,
        EntName: name,
        characterName: `,${name}`,
        clientSpawned: true,
        playerDamageContributed: true,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        roomId: 9,
        x: 3200,
        y: 800,
        v: 0,
        hp: 1000,
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

function verifyTerminalClientBossPacketCompletes(
    levelName: string,
    bossName: string,
    ordinal: number,
    expectsCutsceneGate: boolean
): void {
    const client = createClient(levelName, ordinal);
    const levelScope = getClientLevelScope(client as never);
    const boss = createClientBoss(74_000 + ordinal, bossName);

    client.entities.set(boss.id, boss);
    GlobalState.levelEntities.set(levelScope, new Map([[boss.id, boss]]));
    GlobalState.sessionsByToken.set(client.token, client as never);
    if (expectsCutsceneGate) {
        boss.isRoomBoss = true;
        boss.roomBoss = true;
        boss.roomBossRoomId = boss.roomId;
        boss.roomBossName = bossName;
        markRoomBossEntity(levelScope, boss.id, boss.roomId, bossName);
    }

    LevelHandler.handleEntityIncrementalUpdate(client as never, buildDeadStatePayload(boss.id));

    assert.equal(boss.hp, 0, `${levelName}: terminal client boss packet left ${bossName} HP positive`);
    assert.equal(boss.dead, true, `${levelName}: terminal client boss packet did not mark ${bossName} dead`);

    const afterDeath = DungeonCompletionSystem.evaluate(levelScope);
    if (expectsCutsceneGate) {
        assert.equal(afterDeath.reason, 'cutscene_gate_pending', `${levelName}: ${bossName} did not reach cutscene gate`);
        DungeonCompletionSystem.noteCutsceneStart(levelScope, boss.roomId, 10_000 + ordinal);
        assert.equal(
            DungeonCompletionSystem.noteCutsceneEnd(levelScope, boss.roomId, 10_001 + ordinal),
            true,
            `${levelName}: ${bossName} did not release after end cutscene`
        );
    } else {
        assert.equal(afterDeath.ready, true, `${levelName}: ${bossName} did not complete after terminal state`);
    }

    DungeonCompletionSystem.reset(levelScope);
    GlobalState.levelEntities.delete(levelScope);
    GlobalState.sessionsByToken.delete(client.token);
}

function main(): void {
    LevelConfig.load(path.resolve(__dirname, '../data'));
    // Was RaptorHorned/RaptorHorned2, i.e. ordinary desert raptors standing in for
    // Unearthing the Past's boss. That is the bug that fired the rank plate at 7%.
    verifyTerminalClientBossPacketCompletes('SD_Mission1', 'RageGuardian', 1, false);
    verifyTerminalClientBossPacketCompletes('SD_Mission1Hard', 'RageGuardianHard', 2, false);
    verifyTerminalClientBossPacketCompletes('SD_Mission1', 'Amenrahtep', 3, false);
    verifyTerminalClientBossPacketCompletes('SD_Mission1Hard', 'Amenrahtep', 4, false);
    verifyTerminalClientBossPacketCompletes('SD_Mission4', 'OasisVizierGreen', 5, true);
    verifyTerminalClientBossPacketCompletes('SD_Mission4Hard', 'OasisVizierGreenHard', 6, true);
    verifyTerminalClientBossPacketCompletes('JC_Mission5', 'NephitDragonMarker', 7, false);
    verifyTerminalClientBossPacketCompletes('JC_Mission5Hard', 'NephitDragonMarkerHard', 8, false);
    verifyTerminalClientBossPacketCompletes('JC_Mission10', 'DragonTemple', 9, false);
    verifyTerminalClientBossPacketCompletes('JC_Mission10Hard', 'DragonTempleHard', 10, false);
    console.log('reported_dungeon_completion_targets_regression: ok');
}

main();
