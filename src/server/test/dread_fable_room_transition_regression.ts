/// <reference types="node" />

import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { LevelConfig } from '../core/LevelConfig';
import { MovementAuthority, MovementAuthorityClient } from '../core/MovementAuthority';

type FakeClient = MovementAuthorityClient & {
    disconnected: boolean;
};

function createClient(grace: 'none' | 'room' | 'cutscene'): FakeClient {
    const now = MovementAuthority.nowMs();
    const client: FakeClient = {
        userId: 9,
        token: 13461,
        character: { name: 'Jutsu', equippedMount: 0 },
        currentLevel: 'JC_Mission5Hard',
        movementAuthority: MovementAuthority.createState('dread_fable_test'),
        pendingTransferUntil: 0,
        mountTransferGraceUntil: 0,
        roomTransitionGraceUntil: grace === 'room' ? now + 4_000 : 0,
        activeDungeonCutsceneScope: grace === 'cutscene' ? 'JC_Mission5Hard#13461' : '',
        clientEntID: 9001,
        disconnected: false,
        socket: {
            destroy(): void {
                client.disconnected = true;
            }
        }
    };

    MovementAuthority.reset(client, 'level_spawn', 2869, 680, now);
    return client;
}

function moveTo(client: FakeClient, x: number, y: number, nowMs: number = MovementAuthority.nowMs()) {
    const state = client.movementAuthority;
    return MovementAuthority.validateIncrementalMovement(
        client,
        { x: state.lastAcceptedX, y: state.lastAcceptedY },
        x - state.lastAcceptedX,
        y - state.lastAcceptedY,
        nowMs
    );
}

function main(): void {
    LevelConfig.load(path.resolve(__dirname, '../data'));

    const levelHandlerSource = fs.readFileSync(path.resolve(__dirname, '../handlers/LevelHandler.ts'), 'utf8');
    assert.match(
        levelHandlerSource,
        /static handleRoomClose[\s\S]*?MovementAuthority\.resetFromEntity\(client,[\s\S]*?MovementAuthority\.armRoomTransitionGrace\(client, LevelHandler\.ROOM_TRANSITION_GRACE_MS\)/,
        'closing a dungeon cinematic must reset movement score and preserve room-transition grace for the source client'
    );

    // Exact transitions from the failing live run. Both are authored room/portal
    // moves and must not add anti-teleport score or close the connection.
    const roomTransition = createClient('room');
    const dreamRoomMove = moveTo(roomTransition, 22282, 171);
    assert.equal(dreamRoomMove.accepted, true);
    assert.equal(dreamRoomMove.reason, 'transition_grace');
    assert.equal(dreamRoomMove.speedViolationScore, 0);
    assert.equal(roomTransition.disconnected, false);

    const bossCutscene = createClient('cutscene');
    const bossRoomMove = moveTo(bossCutscene, 17191, 2706);
    assert.equal(bossRoomMove.accepted, true);
    assert.equal(bossRoomMove.reason, 'transition_grace');
    assert.equal(bossRoomMove.speedViolationScore, 0);
    assert.equal(bossCutscene.disconnected, false);

    // handleRoomClose arms this window after clearing the cinematic scope.
    const closedCutscene = createClient('none');
    const cutsceneEndAt = MovementAuthority.nowMs();
    MovementAuthority.armRoomTransitionGrace(closedCutscene, 4_000, cutsceneEndAt);
    const postCloseMove = moveTo(closedCutscene, 24412, 1579, cutsceneEndAt + 1);
    assert.equal(postCloseMove.accepted, true);
    assert.equal(postCloseMove.reason, 'transition_grace');

    // The live client then emitted its next ordinary sample about six seconds
    // later. Dungeon packet coalescing must measure that travel over its bounded
    // four-second budget rather than the old one-second ceiling.
    closedCutscene.roomTransitionGraceUntil = 0;
    const sparseDungeonMove = moveTo(closedCutscene, 22032, 61, cutsceneEndAt + 6_001);
    assert.equal(sparseDungeonMove.accepted, true);
    assert.equal(sparseDungeonMove.reason, 'accepted');
    assert.equal(sparseDungeonMove.speedViolationScore, 0);

    // The larger allowance is only available while the server has an authored
    // transition signal. The same displacement remains a violation otherwise.
    const untrustedMove = createClient('none');
    const rejected = moveTo(untrustedMove, 22282, 171);
    assert.equal(rejected.accepted, false);
    assert.equal(rejected.reason, 'teleport_delta');
    assert.equal(rejected.speedViolationScore, 4);

    // Preserve a finite ceiling even during a room transition.
    const excessiveMove = createClient('room');
    const excessive = moveTo(excessiveMove, 30000, 680);
    assert.equal(excessive.accepted, false);
    assert.equal(excessive.reason, 'teleport_delta');

    console.log('dread_fable_room_transition_regression: ok');
}

main();
