import assert from 'assert';
import path from 'path';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope, getLevelScopeKey } from '../core/LevelScope';
import { LevelHandler } from '../handlers/LevelHandler';
import { MissionHandler } from '../handlers/MissionHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

function makeBoss(id: number, name: string): any {
    return {
        id,
        name,
        hp: 100,
        maxHp: 100,
        dead: false,
        destroyed: false,
        entState: EntityState.ACTIVE,
        team: EntityTeam.ENEMY,
        lifeNonce: 1
    };
}

function defeat(levelScope: string, boss: any, now: number): void {
    boss.hp = 0;
    boss.dead = true;
    boss.destroyed = true;
    boss.entState = EntityState.DEAD;
    DungeonCompletionSystem.noteEntityDefeated(levelScope, boss, now);
}

function revive(boss: any): void {
    boss.hp = boss.maxHp;
    boss.dead = false;
    boss.destroyed = false;
    boss.entState = EntityState.ACTIVE;
    boss.lifeNonce += 1;
}

function buildRoomPayload(roomId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(roomId);
    return bb.toBuffer();
}

function createClient(levelName: string, ordinal: number): any {
    return {
        token: 91_000 + ordinal,
        userId: 92_000 + ordinal,
        character: {
            name: `HidingOut${ordinal}`,
            level: levelName.endsWith('Hard') ? 39 : 24,
            class: 'mage',
            CurrentLevel: { name: levelName, x: 0, y: 0 }
        },
        currentLevel: levelName,
        levelInstanceId: `hiding-out-live-${ordinal}`,
        currentRoomId: 17,
        playerSpawned: true,
        clientEntID: 93_000 + ordinal,
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        sharedEntityRemoteUpdateDeferredIds: new Set<number>(),
        sentPacketIds: [] as number[],
        send(id: number): void { this.sentPacketIds.push(id); },
        sendBitBuffer(id: number): void { this.sentPacketIds.push(id); }
    };
}

function verifyBothBossesMustBeDown(levelName: string, ordinal: number): void {
    const condition = DungeonCompletionConditions.get(levelName);
    assert(condition, `${levelName}: missing completion condition`);
    assert.equal(condition.requireBossesCurrentlyDefeated, true);
    assert.equal(condition.simultaneousBossWindowMs, undefined);
    assert.equal(condition.bossGroups?.length, 2);

    const levelScope = getLevelScopeKey(levelName, `hiding-out-${ordinal}`);
    const first = makeBoss(90_000 + ordinal * 10, condition.bossGroups![0][0]);
    const second = makeBoss(90_001 + ordinal * 10, condition.bossGroups![1][0]);
    GlobalState.levelEntities.set(levelScope, new Map([[first.id, first], [second.id, second]]));

    defeat(levelScope, first, 1_000);
    assert.equal(DungeonCompletionSystem.evaluate(levelScope, 3_999).objectivesMet, false);

    revive(first);
    defeat(levelScope, second, 5_000);
    assert.equal(
        DungeonCompletionSystem.evaluate(levelScope, 5_001).objectivesMet,
        false,
        `${levelName}: completed while the first boss was alive again`
    );

    // The client accepts any tick where both bosses are down. Their final deaths
    // do not need to land inside the server's old three-second timestamp window.
    defeat(levelScope, first, 9_001);
    assert.equal(
        DungeonCompletionSystem.evaluate(levelScope, 9_002).objectivesMet,
        true,
        `${levelName}: did not accept both bosses being down after deaths more than three seconds apart`
    );
    assert.equal(
        DungeonCompletionSystem.evaluate(levelScope, 9_003).reason,
        'cutscene_gate_pending',
        `${levelName}: skipped its ending cinematic gate`
    );

    DungeonCompletionSystem.noteCutsceneStart(levelScope, 7, 9_004, true);
    assert.equal(DungeonCompletionSystem.noteCutsceneEnd(levelScope, 7, 9_005), true);
    assert.equal(DungeonCompletionSystem.evaluate(levelScope, 9_006).ready, true);

    DungeonCompletionSystem.reset(levelScope);
    GlobalState.levelEntities.delete(levelScope);
}

function verifyCueOwnedBossFinaleSignal(levelName: string, ordinal: number): void {
    const condition = DungeonCompletionConditions.get(levelName);
    assert(condition, `${levelName}: missing completion condition`);
    assert.equal(condition.acceptRoomBossClearSignal, true);

    const client = createClient(levelName, ordinal);
    const levelScope = getClientLevelScope(client);
    GlobalState.levelEntities.set(levelScope, new Map());
    GlobalState.sessionsByToken.set(client.token, client);

    // Reproduce the live failure: the cue-owned bosses are absent from the
    // server entity maps. BossFight's 0xAD still authoritatively reports that
    // both local boss slots reached zero HP.
    LevelHandler.handleRoomUnlock(client, buildRoomPayload(2472640124));
    const afterClear = DungeonCompletionSystem.evaluate(levelScope);
    assert.equal(afterClear.objectivesMet, true, `${levelName}: room boss clear did not satisfy both boss groups`);
    assert.equal(afterClear.reason, 'cutscene_gate_pending', `${levelName}: room boss clear skipped the finale gate`);
    assert.deepEqual(
        [...(DungeonCompletionSystem.getState(levelScope)?.defeatedBosses ?? [])],
        (condition.bossGroups ?? []).map((group) => group[0])
    );

    MissionHandler.noteDungeonCutsceneStart(client, 2472640124);
    const finale = DungeonCompletionSystem.getState(levelScope)?.cutscenesByRoom.get(2472640124);
    assert.equal(finale?.completionEligibleAtStart, true, `${levelName}: post-clear cutscene was mistaken for the intro`);
    assert.equal(DungeonCompletionSystem.noteCutsceneEnd(levelScope, 2472640124), true);
    assert.equal(DungeonCompletionSystem.evaluate(levelScope).ready, true, `${levelName}: finale close did not complete the run`);

    DungeonCompletionSystem.reset(levelScope);
    GlobalState.levelEntities.delete(levelScope);
    GlobalState.sessionsByToken.delete(client.token);
}

function verifyRoomBossClearIsExplicitlyScoped(): void {
    const client = createClient('JC_Mission10', 7);
    const levelScope = getClientLevelScope(client);
    GlobalState.levelEntities.set(levelScope, new Map());
    GlobalState.sessionsByToken.set(client.token, client);

    LevelHandler.handleRoomUnlock(client, buildRoomPayload(17));
    assert.equal(
        DungeonCompletionSystem.evaluate(levelScope).objectivesMet,
        false,
        'an unrelated dungeon accepted the Hiding Out room-boss-clear rule'
    );

    DungeonCompletionSystem.reset(levelScope);
    GlobalState.levelEntities.delete(levelScope);
    GlobalState.sessionsByToken.delete(client.token);
}

function verifyRoomBossClearOverridesStaleEntityCache(): void {
    const levelName = 'JC_Mission9';
    const condition = DungeonCompletionConditions.get(levelName)!;
    const client = createClient(levelName, 8);
    const levelScope = getClientLevelScope(client);
    const staleBosses = (condition.bossGroups ?? []).map((group, index) =>
        makeBoss(95_000 + index, group[0])
    );
    GlobalState.levelEntities.set(levelScope, new Map(staleBosses.map((boss) => [boss.id, boss])));
    GlobalState.sessionsByToken.set(client.token, client);

    LevelHandler.handleRoomUnlock(client, buildRoomPayload(2472640124));
    assert.equal(
        DungeonCompletionSystem.evaluate(levelScope).objectivesMet,
        true,
        'the authoritative room clear was overwritten by stale living boss copies'
    );

    DungeonCompletionSystem.reset(levelScope);
    GlobalState.levelEntities.delete(levelScope);
    GlobalState.sessionsByToken.delete(client.token);
}

function main(): void {
    LevelConfig.load(path.resolve(__dirname, '../data'));
    verifyBothBossesMustBeDown('JC_Mission9', 1);
    verifyBothBossesMustBeDown('JC_Mission9Hard', 2);
    verifyCueOwnedBossFinaleSignal('JC_Mission9', 5);
    verifyCueOwnedBossFinaleSignal('JC_Mission9Hard', 6);
    verifyRoomBossClearIsExplicitlyScoped();
    verifyRoomBossClearOverridesStaleEntityCache();
    console.log('hiding_out_completion_regression: ok');
}

main();
