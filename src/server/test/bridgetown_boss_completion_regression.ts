import assert from 'assert';
import path from 'path';
import { DungeonCompletionConditions } from '../core/DungeonCompletionConditions';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope, getLevelScopeKey } from '../core/LevelScope';
import { LevelHandler } from '../handlers/LevelHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

// Both Felbridge bugs come straight out of LevelsBT.swf.
//
// Bandit Camp (BT_Mission1 / a_Room_BTM01RBanditCampBoss) is a two-slot boss
// room: am_Boss = ac_BanditTwinB ("Delexa") and am_Boss2 = ac_BanditTwinA
// ("Pelanda"), both `a_Cue` owned. When one twin's death never publishes a full
// entity to the server the run's objectives can never be met, the queued
// completion is dropped, and the rank plate never opens even though the defeat
// cutscene ("12 End") already played. BossFight's 0xAD room-boss-clear is the
// authored proof that every boss slot in the room hit zero HP.
//
// Svagg's Last Stand (BT_Mission2 / a_Room_BTM02ROldHeroesBoss) authors only
// am_Boss = ac_BanditBoss, but PhaseFight runs Ambush("am_WaveFour") once Svagg
// is at 1% HP, and that ambush carries am_Boss2 = ac_GriffonStar — "Wrath", the
// griffon Svagg summons with `sayOnDeath = "Wrath, avenge me!"`. The defeat
// cutscene opens on that griffon ("4 Boss2 Rawk!"), so Svagg's death alone must
// not end the run.

function makeBoss(id: number, name: string): any {
    return {
        id,
        name,
        EntName: name,
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

function buildRoomPayload(roomId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(roomId);
    return bb.toBuffer();
}

function createClient(levelName: string, ordinal: number): any {
    return {
        token: 81_000 + ordinal,
        userId: 82_000 + ordinal,
        character: {
            name: `Felbridge${ordinal}`,
            level: levelName.endsWith('Hard') ? 35 : 12,
            class: 'rogue',
            CurrentLevel: { name: levelName, x: 0, y: 0 }
        },
        currentLevel: levelName,
        levelInstanceId: `bridgetown-live-${ordinal}`,
        currentRoomId: 11,
        playerSpawned: true,
        clientEntID: 83_000 + ordinal,
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        sharedEntityRemoteUpdateDeferredIds: new Set<number>(),
        sentPacketIds: [] as number[],
        send(id: number): void { this.sentPacketIds.push(id); },
        sendBitBuffer(id: number): void { this.sentPacketIds.push(id); }
    };
}

// BT_Mission1: the twins are cue-owned, so a run where only one of them ever
// reaches the server must still finish on BossFight's room-boss-clear.
function verifyBanditCampFinishesOnTheRoomBossClear(levelName: string, ordinal: number): void {
    const condition = DungeonCompletionConditions.get(levelName);
    assert(condition, `${levelName}: missing completion condition`);
    assert.equal(condition.mode, 'bosses');
    assert.equal(condition.bossGroups?.length, 2, `${levelName}: both bandit twins must be required`);
    assert.equal(
        condition.acceptRoomBossClearSignal,
        true,
        `${levelName}: cue-owned twins need the authored room-boss-clear signal`
    );
    assert.equal(
        condition.cutscene?.requiredAfterObjectives,
        true,
        `${levelName}: the room authors cutSceneDefeatBoss, so the plate must wait for it`
    );

    const client = createClient(levelName, ordinal);
    const levelScope = getClientLevelScope(client);
    const reportedTwin = makeBoss(84_000 + ordinal * 10, condition.bossGroups![0][0]);
    GlobalState.levelEntities.set(levelScope, new Map([[reportedTwin.id, reportedTwin]]));
    GlobalState.sessionsByToken.set(client.token, client);

    try {
        defeat(levelScope, reportedTwin, 1_000);
        assert.equal(
            DungeonCompletionSystem.evaluate(levelScope, 1_001).objectivesMet,
            false,
            `${levelName}: one twin ended the encounter`
        );

        // The second twin never publishes an entity; 0xAD is the only proof.
        LevelHandler.handleRoomUnlock(client, buildRoomPayload(2315323404));
        const afterClear = DungeonCompletionSystem.evaluate(levelScope, 2_000);
        assert.equal(
            afterClear.objectivesMet,
            true,
            `${levelName}: the room-boss-clear did not satisfy the second twin`
        );
        assert.equal(
            afterClear.reason,
            'cutscene_gate_pending',
            `${levelName}: the rank plate skipped the defeat cutscene`
        );

        DungeonCompletionSystem.noteCutsceneStart(levelScope, 2315323404, 2_100, true);
        assert.equal(DungeonCompletionSystem.noteCutsceneEnd(levelScope, 2315323404, 2_200), true);
        assert.equal(
            DungeonCompletionSystem.evaluate(levelScope, 2_201).ready,
            true,
            `${levelName}: the run never opened its rank plate after the cutscene closed`
        );
    } finally {
        DungeonCompletionSystem.reset(levelScope);
        GlobalState.levelEntities.delete(levelScope);
        GlobalState.sessionsByToken.delete(client.token);
    }
}

// BT_Mission2: Svagg dying must not open the rank plate while Wrath is alive.
function verifySvaggWaitsForWrath(levelName: string, ordinal: number): void {
    const condition = DungeonCompletionConditions.get(levelName);
    assert(condition, `${levelName}: missing completion condition`);
    assert.equal(condition.mode, 'bosses');
    assert.equal(
        condition.bossGroups?.length,
        2,
        `${levelName}: the ambushed griffon must be a required boss`
    );
    assert.equal(
        condition.cutscene?.requiredAfterObjectives,
        true,
        `${levelName}: the room authors cutSceneDefeatBoss, so the plate must wait for it`
    );

    const levelScope = getLevelScopeKey(levelName, `svagg-${ordinal}`);
    const svagg = makeBoss(85_000 + ordinal * 10, condition.bossGroups![0][0]);
    const wrath = makeBoss(85_001 + ordinal * 10, condition.bossGroups![1][0]);
    GlobalState.levelEntities.set(levelScope, new Map([[svagg.id, svagg], [wrath.id, wrath]]));

    try {
        defeat(levelScope, svagg, 1_000);
        const afterSvagg = DungeonCompletionSystem.evaluate(levelScope, 1_001);
        assert.equal(
            afterSvagg.objectivesMet,
            false,
            `${levelName}: the rank plate opened while Wrath was still alive`
        );
        assert.equal(afterSvagg.ready, false, `${levelName}: completed on Svagg's death alone`);

        defeat(levelScope, wrath, 20_000);
        const afterWrath = DungeonCompletionSystem.evaluate(levelScope, 20_001);
        assert.equal(afterWrath.objectivesMet, true, `${levelName}: Wrath's death did not finish the objectives`);
        assert.equal(
            afterWrath.reason,
            'cutscene_gate_pending',
            `${levelName}: the rank plate skipped the defeat cutscene`
        );

        DungeonCompletionSystem.noteCutsceneStart(levelScope, 2315323404, 20_100, true);
        assert.equal(DungeonCompletionSystem.noteCutsceneEnd(levelScope, 2315323404, 20_200), true);
        assert.equal(
            DungeonCompletionSystem.evaluate(levelScope, 20_201).ready,
            true,
            `${levelName}: the run never opened its rank plate after the cutscene closed`
        );
    } finally {
        DungeonCompletionSystem.reset(levelScope);
        GlobalState.levelEntities.delete(levelScope);
    }
}

// The Hard rooms reuse the base ac_* classes, so a client report of the plain
// name has to resolve onto the Hard boss.
function verifyHardAliasesAcceptBaseNames(levelName: string, ordinal: number): void {
    const condition = DungeonCompletionConditions.get(levelName)!;
    const levelScope = getLevelScopeKey(levelName, `hard-alias-${ordinal}`);
    const bosses = (condition.bossGroups ?? []).map((group, index) =>
        makeBoss(86_000 + ordinal * 10 + index, group[0].replace(/Hard$/, ''))
    );
    GlobalState.levelEntities.set(levelScope, new Map(bosses.map((boss) => [boss.id, boss])));

    try {
        bosses.forEach((boss, index) => {
            assert.equal(
                DungeonCompletionConditions.getCanonicalBossName(levelName, boss, levelScope),
                condition.bossGroups![index][0],
                `${levelName}: a base-named ${boss.name} report was dropped`
            );
            defeat(levelScope, boss, 1_000 + index);
        });
        assert.equal(
            DungeonCompletionSystem.evaluate(levelScope, 2_000).objectivesMet,
            true,
            `${levelName}: base-named boss kills never satisfied the Hard objectives`
        );
    } finally {
        DungeonCompletionSystem.reset(levelScope);
        GlobalState.levelEntities.delete(levelScope);
    }
}

function main(): void {
    LevelConfig.load(path.resolve(__dirname, '../data'));
    verifyBanditCampFinishesOnTheRoomBossClear('BT_Mission1', 1);
    verifyBanditCampFinishesOnTheRoomBossClear('BT_Mission1Hard', 2);
    verifySvaggWaitsForWrath('BT_Mission2', 3);
    verifySvaggWaitsForWrath('BT_Mission2Hard', 4);
    verifyHardAliasesAcceptBaseNames('BT_Mission1Hard', 5);
    verifyHardAliasesAcceptBaseNames('BT_Mission2Hard', 6);
    console.log('bridgetown_boss_completion_regression: ok');
}

main();
