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

// Reported on Dread Goblin Camp: the boss dies, the ending dialogue plays out
// and closes, and the rank plate still arrives a beat or two later. The rank
// screen is supposed to follow the cutscene end.
//
// Two separate things kept it from doing so, and both are covered here.
const LEVEL_NAME = 'GoblinRiverDungeonHard';
const CUTSCENE_ROOM_ID = 7;

type FakeClient = Record<string, unknown>;

// A well-formed SetLevelComplete body, so a flush that reaches the real handler
// parses cleanly instead of throwing on an empty buffer. Mirrors the server's
// own buildSyntheticLevelCompletePacket.
function syntheticLevelCompletePayload(): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(100);
    for (let i = 0; i < 6; i += 1) {
        bb.writeMethod9(0);
    }
    bb.writeMethod9(1);
    bb.writeMethod9(3);
    return bb.toBuffer();
}

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has(LEVEL_NAME)) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
    MissionLoader.load(dataDir);
}

function createFakeClient(token: number): FakeClient {
    const character = {
        name: `plate-delay-${token}`,
        CurrentLevel: { name: LEVEL_NAME, x: 0, y: 0 },
        PreviousLevel: { name: 'NewbieRoadHard', x: 0, y: 0 },
        missions: {},
        questTrackerState: 0,
        level: 50,
        xp: 0,
        gold: 0
    };

    return {
        currentLevel: LEVEL_NAME,
        levelInstanceId: `plate-delay-${token}`,
        currentRoomId: CUTSCENE_ROOM_ID,
        token,
        userId: null,
        playerSpawned: true,
        clientEntID: token + 1000,
        character,
        characters: [character],
        entities: new Map(),
        knownEntityIds: new Set(),
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
        scheduleCharacterSave() {
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

// evaluate() recovers objectives straight from the scope's entities, so a boss
// seeded dead counts as defeated before anything registers it. Bosses therefore
// start alive and `killBoss` is what stands in for the destroy packet landing.
function createBoss(id: number, name: string): any {
    return {
        id,
        name,
        EntName: name,
        characterName: `,${name}`,
        clientSpawned: false,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        roomId: CUTSCENE_ROOM_ID,
        hp: 194_940,
        maxHp: 194_940,
        dead: false,
        destroyed: false,
        entState: EntityState.ACTIVE
    };
}

function killBoss(boss: any): any {
    boss.hp = 0;
    boss.dead = true;
    boss.destroyed = true;
    boss.entState = EntityState.DEAD;
    return boss;
}

function seedRun(token: number): {
    client: FakeClient;
    scope: string;
    bosses: any[];
    registerDefeats: () => void;
} {
    const condition = DungeonCompletionConditions.get(LEVEL_NAME);
    assert(condition, `${LEVEL_NAME}: missing completion condition`);

    const client = createFakeClient(token);
    const scope = getClientLevelScope(client as never);
    assert(scope, `${LEVEL_NAME}: could not resolve a level scope`);

    const bosses = (condition.bossGroups ?? []).map((group, index) =>
        createBoss(70_000 + token * 10 + index, group[0])
    );
    GlobalState.levelEntities.set(scope, new Map(bosses.map((boss) => [boss.id, boss])));
    // Enrollment reads the live session table, so the client has to be visible
    // there before the objectives are met or the scheduler skips it entirely.
    GlobalState.sessionsByToken.set(token, client as never);

    return {
        client,
        scope,
        bosses,
        registerDefeats: () => bosses.forEach((boss) => {
            DungeonCompletionSystem.noteEntityDefeated(scope, killBoss(boss));
        })
    };
}

function seedFinishedRun(token: number): { client: FakeClient; scope: string } {
    const run = seedRun(token);
    run.registerDefeats();
    return { client: run.client, scope: run.scope };
}

function cleanup(client: FakeClient, scope: string): void {
    const timer = client.pendingDungeonCompletionTimer as NodeJS.Timeout | null;
    if (timer) {
        clearTimeout(timer);
    }
    GlobalState.sessionsByToken.delete(Number(client.token));
    DungeonCompletionSystem.reset(scope);
    GlobalState.levelEntities.delete(scope);
}

// The ordering the player actually hits. The boss's own destroy packet arrives
// *after* the skit that plays over it, so at close time the objectives are not
// met and the close has no gate to release. The run then becomes ready on the
// boss-death path — which used to arm the full 1.5s settle window even though
// the cutscene it was waiting on had already finished.
async function testPlateFollowsACutsceneThatClosedBeforeTheLastKill(): Promise<void> {
    const { client, scope, bosses } = seedRun(9_004);

    MissionHandler.noteDungeonCutsceneStart(client as never, CUTSCENE_ROOM_ID);
    MissionHandler.noteDungeonCutsceneEnd(client as never, CUTSCENE_ROOM_ID);

    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        false,
        'the run counted its objectives before the boss destroy packet arrived'
    );
    assert.ok(
        DungeonCompletionSystem.hasObservedCutsceneEnd(scope),
        'the cutscene close was not recorded on the run'
    );
    assert.equal(
        Number(client.pendingDungeonCompletionSettleMs),
        0,
        'the close armed a settle window on a run it could not complete'
    );

    // The boss destroy packet lands: the run becomes ready here, not at close.
    await MissionHandler.handleForcedDungeonBossCompletion(client as never, killBoss(bosses[0]));

    assert.equal(
        DungeonCompletionSystem.evaluate(scope).ready,
        true,
        'the run did not become ready once the boss was registered'
    );
    assert.equal(
        Number(client.pendingDungeonCompletionSettleMs),
        0,
        'a run whose cutscene had already closed still armed the skit-settle window'
    );
    assert.ok(
        Number(client.pendingDungeonCompletionNotBeforeAt) <= Date.now(),
        'the plate was held behind a not-before deadline after its cutscene ended'
    );

    cleanup(client, scope);
}

// The end-to-end guarantee the player cares about: boss dead, its ending skit
// plays and closes, and the rank plate lands with no settle timer left behind.
function testCutsceneEndPlatesImmediatelyWhenBossAlreadyDead(): void {
    const { client, scope } = seedFinishedRun(9_009);
    const payload = syntheticLevelCompletePayload();

    // The boss-death schedule arms its 1.5s settle window.
    MissionHandler.scheduleDungeonCompletion(client as never, payload);
    assert.equal(
        String(client.pendingDungeonCompletionScope),
        scope,
        'the boss-death schedule did not arm a pending completion'
    );

    // The ending skit plays over the dead boss and closes.
    MissionHandler.noteDungeonCutsceneStart(client as never, CUTSCENE_ROOM_ID);
    MissionHandler.noteDungeonCutsceneEnd(client as never, CUTSCENE_ROOM_ID);

    assert.equal(
        String(client.pendingDungeonCompletionScope),
        '',
        'the rank plate did not fire the instant the cutscene closed'
    );
    assert.equal(
        client.pendingDungeonCompletionTimer,
        null,
        'a settle timer was left armed after the cutscene had already closed'
    );

    cleanup(client, scope);
}

// Trailing chatter after the close must not re-arm the settle window on a ready
// run: the skit-activity path flushes instead of pushing the plate back out.
function testTrailingSkitAfterCloseFlushesInsteadOfDeferring(): void {
    const { client, scope } = seedFinishedRun(9_010);
    const payload = syntheticLevelCompletePayload();

    MissionHandler.scheduleDungeonCompletion(client as never, payload);
    // Record a cutscene close on the run without letting the close path itself
    // flush, so the skit-activity guard is what has to catch it.
    DungeonCompletionSystem.noteCutsceneStart(scope, CUTSCENE_ROOM_ID, Date.now(), true, true);
    DungeonCompletionSystem.noteCutsceneEnd(scope, CUTSCENE_ROOM_ID, Date.now() + 50);
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).ready,
        true,
        'the run was not ready after its cutscene closed'
    );
    assert.equal(
        String(client.pendingDungeonCompletionScope),
        scope,
        'the pending completion was cleared before the skit-activity path ran'
    );

    // A trailing dialogue/social packet arrives after the close.
    MissionHandler.noteDungeonSkitActivity(client as never);

    assert.equal(
        String(client.pendingDungeonCompletionScope),
        '',
        'a post-cutscene skit packet re-armed the settle window instead of plating'
    );

    cleanup(client, scope);
}

// The mirror: with no cutscene on record, trailing chatter must still hold the
// plate behind the settle window, or the rank screen lands on top of it.
function testTrailingSkitWithoutACutsceneKeepsDeferring(): void {
    const { client, scope } = seedFinishedRun(9_011);
    const payload = syntheticLevelCompletePayload();

    MissionHandler.scheduleDungeonCompletion(client as never, payload);
    assert.equal(
        DungeonCompletionSystem.hasObservedCutsceneEnd(scope),
        false,
        'a run with no cutscene reported one as closed'
    );

    MissionHandler.noteDungeonSkitActivity(client as never);

    assert.equal(
        String(client.pendingDungeonCompletionScope),
        scope,
        'a skit packet plated a run whose closing chatter was still playing'
    );

    cleanup(client, scope);
}

// The exact live trace: a cutscene the server sees start and close, but that
// resolves no boss (bossSceneAtStart false) and closes *before* the boss death
// packet lands. The observed close alone could not release the gate at close
// time (objectives not met), and the reorder tolerance did not recognise it
// (not a boss scene), so the run sat on the missing-cutscene grace — the ~2.5s
// the player watched. The observed 0xA6 close must release the gate the moment
// the boss death arrives.
async function testObservedCloseReleasesGateWhenBossDiesAfterIt(): Promise<void> {
    const { client, scope, bosses } = seedRun(9_012);
    const boss = bosses[0];

    const now = Date.now();
    DungeonCompletionSystem.noteCutsceneStart(scope, CUTSCENE_ROOM_ID, now, false, false);
    DungeonCompletionSystem.noteCutsceneEnd(scope, CUTSCENE_ROOM_ID, now + 50);
    // What cinematicEndedAt / closeObservedForScope read from.
    client.lastDungeonCutsceneEndScope = scope;
    client.lastDungeonCutsceneEndAt = now + 50;

    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        false,
        'objectives were met before the boss death registered'
    );

    await MissionHandler.handleForcedDungeonBossCompletion(client as never, killBoss(boss));

    assert.equal(
        DungeonCompletionSystem.evaluate(scope).ready,
        true,
        'the observed cutscene close did not release the gate once the boss died'
    );
    assert.equal(
        String(client.pendingDungeonCompletionScope),
        '',
        'the rank plate did not fire immediately after the boss died on a closed cutscene'
    );

    cleanup(client, scope);
}

// A run that never played a cutscene must keep its settle window: the closing
// chatter there has nothing gating it, so plating instantly would land the rank
// screen on top of it.
function testRunWithoutACutsceneIsNotTreatedAsFollowingOne(): void {
    const { client, scope } = seedFinishedRun(9_005);

    assert.equal(
        DungeonCompletionSystem.hasObservedCutsceneEnd(scope),
        false,
        'a run with no cutscene reported one as closed'
    );

    cleanup(client, scope);
}

// A cutscene that started and has not closed must not count as observed, or the
// plate lands underneath a skit that is still on screen.
function testRunningCutsceneIsNotTreatedAsClosed(): void {
    const { client, scope } = seedRun(9_006);

    MissionHandler.noteDungeonCutsceneStart(client as never, CUTSCENE_ROOM_ID);
    assert.equal(
        DungeonCompletionSystem.hasObservedCutsceneEnd(scope),
        false,
        'a cutscene still on screen was reported as closed'
    );

    cleanup(client, scope);
}

// The core of the fix, straight on the completion system: a boss scene that
// opened while its boss was still alive, closed, and had the boss's death land
// just after the close is the ending skit and makes the run ready. The
// reorder-tolerance branch used to require the scene to have been completable at
// its start, which a boss scene never is, so the run stalled with its dialogue
// already over.
function testBossSceneCloseBeforeTheKillReleasesTheGate(): void {
    const { client, scope, bosses } = seedRun(9_007);
    const boss = bosses[0];

    // Wall-clock timestamps: noteEntityDefeated stamps objectivesMetAt at
    // Date.now(), and the reorder tolerance is measured against it, so the
    // cutscene close has to sit on the same clock the way it does live.
    const now = Date.now();
    // Boss scene opens over a boss that is still alive: not eligible at start,
    // but it is a boss scene, so bossSceneAtStart is set.
    DungeonCompletionSystem.noteCutsceneStart(scope, CUTSCENE_ROOM_ID, now, false, true);
    DungeonCompletionSystem.noteCutsceneEnd(scope, CUTSCENE_ROOM_ID, now + 100);
    assert.equal(
        DungeonCompletionSystem.evaluate(scope, now + 150).objectivesMet,
        false,
        'the run counted its objectives before the boss death was registered'
    );

    // The boss death lands just after the close — the reordered case.
    killBoss(boss);
    DungeonCompletionSystem.noteEntityDefeated(scope, boss);
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).ready,
        true,
        'the boss-scene ending skit did not release the completion gate'
    );

    cleanup(client, scope);
}

// The guard that keeps that exemption honest: an intro cinematic resolves no
// boss (bossSceneAtStart false) and must not satisfy the post-boss ending gate,
// or a dungeon plates the instant its opening skit closes.
function testIntroCinematicDoesNotSatisfyTheEndingGate(): void {
    const { client, scope, bosses } = seedRun(9_008);
    const boss = bosses[0];

    // Opening cinematic on the same clock as the kill, but resolving no boss:
    // even within the reorder tolerance it must not count as the ending skit.
    const now = Date.now();
    DungeonCompletionSystem.noteCutsceneStart(scope, CUTSCENE_ROOM_ID, now, false, false);
    DungeonCompletionSystem.noteCutsceneEnd(scope, CUTSCENE_ROOM_ID, now + 100);

    killBoss(boss);
    DungeonCompletionSystem.noteEntityDefeated(scope, boss);
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).reason,
        'cutscene_gate_pending',
        'an intro cinematic was accepted as the post-boss ending skit'
    );

    cleanup(client, scope);
}

// The second defect: the client's own SetLevelComplete reports 98% on this run,
// so it does not count as "cleared" and falls through to the lazy re-arm. That
// merge took the longer of the two settle windows, putting 1.5s back onto a
// schedule the cutscene close had just made immediate. A merge may only bring
// the plate forward, never push it back.
function testLateClientPacketCannotSlowAnImmediatePlate(): void {
    const { client, scope } = seedFinishedRun(9_001);
    const payload = syntheticLevelCompletePayload();

    MissionHandler.scheduleDungeonCompletion(client as never, payload, {
        initialDelayMs: 0,
        settleDelayMs: 0,
        replaceExistingSchedule: true
    });
    assert.equal(
        Number(client.pendingDungeonCompletionSettleMs),
        0,
        'the cutscene close did not arm an immediate plate'
    );
    const notBeforeAfterClose = Number(client.pendingDungeonCompletionNotBeforeAt);

    MissionHandler.scheduleDungeonCompletion(client as never, payload);

    assert.equal(
        Number(client.pendingDungeonCompletionSettleMs),
        0,
        'the client packet put the skit-settle window back on an immediate plate'
    );
    assert.ok(
        Number(client.pendingDungeonCompletionNotBeforeAt) <= notBeforeAfterClose,
        'the client packet pushed the plate deadline out'
    );

    cleanup(client, scope);
}

// The reverse order must keep working: a lazy schedule armed first, then the
// close, still ends up immediate.
function testCloseStillOverridesAnEarlierLazySchedule(): void {
    const { client, scope } = seedFinishedRun(9_002);
    const payload = syntheticLevelCompletePayload();

    MissionHandler.scheduleDungeonCompletion(client as never, payload);
    assert.equal(
        Number(client.pendingDungeonCompletionSettleMs),
        MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS,
        'the boss-death schedule did not arm its settle window'
    );

    MissionHandler.scheduleDungeonCompletion(client as never, payload, {
        initialDelayMs: 0,
        settleDelayMs: 0,
        replaceExistingSchedule: true
    });
    assert.equal(
        Number(client.pendingDungeonCompletionSettleMs),
        0,
        'the cutscene close failed to retire the earlier settle window'
    );

    cleanup(client, scope);
}

// Two ordinary schedules must still settle: taking the shorter window is about
// not undoing an immediate plate, not about dropping the window altogether.
function testOrdinarySchedulesKeepTheirSettleWindow(): void {
    const { client, scope } = seedFinishedRun(9_003);
    const payload = syntheticLevelCompletePayload();

    MissionHandler.scheduleDungeonCompletion(client as never, payload);
    MissionHandler.scheduleDungeonCompletion(client as never, payload);

    assert.equal(
        Number(client.pendingDungeonCompletionSettleMs),
        MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS,
        'a plain re-schedule lost the skit-settle window'
    );

    cleanup(client, scope);
}

// The backstop for a gate that clears with no event of its own: it must be far
// shorter than a skit window, and its hot phase must stay bounded.
function testReadyPollIsShorterThanASkitWindow(): void {
    assert.ok(
        MissionHandler.DUNGEON_COMPLETION_READY_POLL_MS < MissionHandler.DUNGEON_COMPLETION_SKIT_SETTLE_MS,
        'the ready poll is no shorter than a full skit-settle window'
    );
    assert.ok(
        MissionHandler.DUNGEON_COMPLETION_PLATE_HOT_WINDOW_MS > 0 &&
            MissionHandler.DUNGEON_COMPLETION_PLATE_HOT_WINDOW_MS <
                MissionHandler.DUNGEON_COMPLETION_MAX_DEFER_MS,
        'the hot-poll window is not bounded by the max defer window'
    );
}

async function main(): Promise<void> {
    ensureDataLoaded();
    await testPlateFollowsACutsceneThatClosedBeforeTheLastKill();
    testCutsceneEndPlatesImmediatelyWhenBossAlreadyDead();
    testTrailingSkitAfterCloseFlushesInsteadOfDeferring();
    testTrailingSkitWithoutACutsceneKeepsDeferring();
    await testObservedCloseReleasesGateWhenBossDiesAfterIt();
    testRunWithoutACutsceneIsNotTreatedAsFollowingOne();
    testRunningCutsceneIsNotTreatedAsClosed();
    testBossSceneCloseBeforeTheKillReleasesTheGate();
    testIntroCinematicDoesNotSatisfyTheEndingGate();
    testLateClientPacketCannotSlowAnImmediatePlate();
    testCloseStillOverridesAnEarlierLazySchedule();
    testOrdinarySchedulesKeepTheirSettleWindow();
    testReadyPollIsShorterThanASkitWindow();
    console.log('dungeon_completion_plate_delay_regression: ok');
}

void main();
