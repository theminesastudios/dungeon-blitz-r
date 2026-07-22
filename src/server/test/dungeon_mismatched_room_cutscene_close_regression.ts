/// <reference types="node" />

import { strict as assert } from 'assert';
import * as path from 'path';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { MissionLoader } from '../data/MissionLoader';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

// The Mouth of Meylour was reported as "boss dies, rank screen never appears".
// A live trace showed the boss resolving correctly (isRequiredBoss: true,
// objectivesMet: true) and the run stalling purely on cutscene_gate_pending,
// with no cutscene close ever reaching the completion system.
//
// The cause: noteDungeonCutsceneEnd bails out early when a close is booked
// against a room other than the one it recorded as active. That guard is right
// for cutscene bookkeeping — a close for room A must not end the skit playing
// in room B — but it also skipped the ending-gate release, so the run sat out
// the full 120s cinematic safety net.
//
// dungeon_ending_cutscene_close_completion_regression covers the same release at
// the DungeonCompletionSystem level and passed throughout, which is exactly why
// this survived: the system function worked, the handler never called it.
const REPORTED_LEVELS = [
    'BT_Mission3',
    'BT_Mission3Hard'
] as const;

const ACTIVE_CUTSCENE_ROOM_ID = 7;
const MISMATCHED_CLOSE_ROOM_ID = 3;

type FakeClient = Record<string, unknown>;

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('BT_Mission3')) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
    MissionLoader.load(dataDir);
}

function createFakeClient(levelName: string, token: number): FakeClient {
    const character = {
        name: `tester-${token}`,
        CurrentLevel: { name: levelName, x: 0, y: 0 },
        PreviousLevel: { name: 'BridgeTown', x: 0, y: 0 },
        missions: {},
        questTrackerState: 0,
        level: 30,
        xp: 0,
        gold: 0
    };

    return {
        currentLevel: levelName,
        levelInstanceId: `mismatched-close-${token}`,
        currentRoomId: ACTIVE_CUTSCENE_ROOM_ID,
        token,
        userId: null,
        playerSpawned: true,
        clientEntID: token + 1000,
        character,
        characters: [character],
        entities: new Map(),
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
        lastDungeonCutsceneStartScope: '',
        lastDungeonCutsceneStartAt: 0,
        lastDungeonCutsceneEndScope: '',
        lastDungeonCutsceneEndAt: 0,
        armPendingTransferGrace() {
            return undefined;
        },
        send() {
            return undefined;
        },
        sendBitBuffer(_id: number, _bb: BitBuffer) {
            return undefined;
        }
    };
}

function createDeadBoss(id: number, name: string): any {
    return {
        id,
        name,
        EntName: name,
        characterName: `,${name}`,
        clientSpawned: false,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        roomId: ACTIVE_CUTSCENE_ROOM_ID,
        hp: 0,
        maxHp: 1000,
        dead: true,
        destroyed: true,
        entState: EntityState.DEAD
    };
}

function seedRunWithDeadBosses(levelName: string, token: number): {
    client: FakeClient;
    scope: string;
} {
    const condition = DungeonCompletionConditions.get(levelName);
    assert(condition, `${levelName}: missing completion condition`);
    assert.equal(
        condition.cutscene?.requiredAfterObjectives,
        true,
        `${levelName}: no longer gates completion on an ending cinematic`
    );

    const client = createFakeClient(levelName, token);
    const scope = getClientLevelScope(client as never);
    assert(scope, `${levelName}: could not resolve a level scope`);

    const bosses = (condition.bossGroups ?? []).map((group, index) =>
        createDeadBoss(90_000 + token * 10 + index, group[0])
    );
    GlobalState.levelEntities.set(scope, new Map(bosses.map((boss) => [boss.id, boss])));
    bosses.forEach((boss) => DungeonCompletionSystem.noteEntityDefeated(scope, boss));

    return { client, scope };
}

function cleanup(client: FakeClient, scope: string): void {
    const timer = client.pendingDungeonCompletionTimer as NodeJS.Timeout | null;
    if (timer) {
        clearTimeout(timer);
    }
    DungeonCompletionSystem.reset(scope);
    GlobalState.levelEntities.delete(scope);
}

// The reported failure: the ending skit closes against a room the client never
// recorded as active, and the rank screen never appears.
function verifyMismatchedRoomCloseReleasesTheRankScreen(levelName: string, token: number): void {
    const { client, scope } = seedRunWithDeadBosses(levelName, token);

    assert.equal(
        DungeonCompletionSystem.evaluate(scope).reason,
        'cutscene_gate_pending',
        `${levelName}: the run stalled on something other than the cutscene gate`
    );

    MissionHandler.noteDungeonCutsceneStart(client as never, ACTIVE_CUTSCENE_ROOM_ID);
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).ready,
        false,
        `${levelName}: the rank plate appeared underneath a running ending cinematic`
    );

    // The close the client actually sent, booked against a different room.
    MissionHandler.noteDungeonCutsceneEnd(client as never, MISMATCHED_CLOSE_ROOM_ID);

    assert.equal(
        DungeonCompletionSystem.evaluate(scope).ready,
        true,
        `${levelName}: a cutscene close from another room left the run gated, so the ` +
        `rank screen waits out the 120s cinematic safety net`
    );
    assert.equal(
        DungeonCompletionSystem.getState(scope)?.cutsceneFallbackReason,
        'close-observed',
        `${levelName}: the release was not attributed to the observed close`
    );

    cleanup(client, scope);
}

// The guard the early return exists for must survive: a mismatched close must
// not end the bookkeeping for the skit that is genuinely on screen.
function verifyMismatchedCloseLeavesTheOnScreenSkitRecorded(levelName: string, token: number): void {
    const { client, scope } = seedRunWithDeadBosses(levelName, token);

    MissionHandler.noteDungeonCutsceneStart(client as never, ACTIVE_CUTSCENE_ROOM_ID);
    MissionHandler.noteDungeonCutsceneEnd(client as never, MISMATCHED_CLOSE_ROOM_ID);

    assert.equal(
        client.activeDungeonCutsceneScope,
        scope,
        `${levelName}: a close from another room cleared the active cutscene scope`
    );
    assert.equal(
        client.activeDungeonCutsceneRoomId,
        ACTIVE_CUTSCENE_ROOM_ID,
        `${levelName}: a close from another room cleared the on-screen skit's room`
    );

    cleanup(client, scope);
}

// A closing skit must never complete a run whose bosses are still alive.
function verifyMismatchedCloseCannotCompleteAnUnfinishedRun(levelName: string, token: number): void {
    const client = createFakeClient(levelName, token);
    const scope = getClientLevelScope(client as never);
    GlobalState.levelEntities.set(scope, new Map());

    MissionHandler.noteDungeonCutsceneStart(client as never, ACTIVE_CUTSCENE_ROOM_ID);
    MissionHandler.noteDungeonCutsceneEnd(client as never, MISMATCHED_CLOSE_ROOM_ID);

    assert.equal(
        DungeonCompletionSystem.evaluate(scope).ready,
        false,
        `${levelName}: a cutscene close completed a run whose bosses were still alive`
    );
    assert.equal(
        DungeonCompletionSystem.getState(scope)?.cutsceneFallbackReason,
        '',
        `${levelName}: a pre-objective close armed the gate release`
    );

    cleanup(client, scope);
}

function main(): void {
    ensureDataLoaded();
    REPORTED_LEVELS.forEach((levelName, index) => {
        verifyMismatchedRoomCloseReleasesTheRankScreen(levelName, index + 1);
        verifyMismatchedCloseLeavesTheOnScreenSkitRecorded(levelName, index + 101);
        verifyMismatchedCloseCannotCompleteAnUnfinishedRun(levelName, index + 201);
    });
    console.log('dungeon_mismatched_room_cutscene_close_regression: ok');
}

main();
