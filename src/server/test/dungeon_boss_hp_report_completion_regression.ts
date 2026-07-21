import { strict as assert } from 'assert';
import * as path from 'path';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { CombatHandler } from '../handlers/CombatHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

type FakeClient = {
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    token: number;
    userId: number;
    playerSpawned: boolean;
    clientEntID: number;
    character: any;
    entities: Map<number, any>;
    entityIdAliases: Map<number, number>;
    activeDungeonCutsceneScope: string;
    activeDungeonCutsceneRoomId: number;
    lastDungeonCutsceneStartAt: number;
};

function buildHpDeltaPayload(entityId: number, amount: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod24(amount);
    return bb.toBuffer();
}

function buildDestroyEntityPayload(entityId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod4(entityId);
    bb.writeMethod15(true);
    return bb.toBuffer();
}

function createClient(levelName: string, ordinal: number): FakeClient {
    return {
        currentLevel: levelName,
        levelInstanceId: `boss-hp-report-${ordinal}`,
        currentRoomId: 12,
        token: 70_000 + ordinal,
        userId: 80_000 + ordinal,
        playerSpawned: true,
        clientEntID: 90_000 + ordinal,
        character: {
            name: `BossHpReporter${ordinal}`,
            CurrentLevel: { name: levelName, x: 0, y: 0 },
            missions: {}
        },
        entities: new Map<number, any>(),
        entityIdAliases: new Map<number, number>(),
        activeDungeonCutsceneScope: '',
        activeDungeonCutsceneRoomId: 0,
        lastDungeonCutsceneStartAt: 0
    };
}

function createBoss(id: number, name: string): any {
    return {
        id,
        name,
        EntName: name,
        characterName: `,${name}`,
        character_name: `,${name}`,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        roomId: 12,
        clientSpawned: true,
        hp: 1000,
        maxHp: 1000,
        healthDelta: 0,
        health_delta: 0,
        dead: false,
        destroyed: false,
        entState: EntityState.ACTIVE
    };
}

function seedBosses(client: FakeClient, bosses: any[]): string {
    const scope = getClientLevelScope(client as never);
    const levelMap = new Map<number, any>();
    for (const boss of bosses) {
        client.entities.set(boss.id, boss);
        levelMap.set(boss.id, boss);
    }
    GlobalState.levelEntities.set(scope, levelMap);
    return scope;
}

function clearRun(client: FakeClient): void {
    const scope = getClientLevelScope(client as never);
    DungeonCompletionSystem.reset(scope);
    GlobalState.levelEntities.delete(scope);
    GlobalState.levelQuestProgress.delete(scope);
    GlobalState.sessionsByToken.delete(client.token);
}

function testAuthoredBossHpReportDuringDefeatCutscene(
    levelName: string,
    bossName: string,
    ordinal: number
): void {
    const client = createClient(levelName, ordinal);
    const boss = createBoss(10_000 + ordinal, bossName);
    const scope = seedBosses(client, [boss]);
    GlobalState.sessionsByToken.set(client.token, client as never);
    client.activeDungeonCutsceneScope = scope;
    client.activeDungeonCutsceneRoomId = boss.roomId;
    client.lastDungeonCutsceneStartAt = Date.now();
    DungeonCompletionSystem.noteCutsceneStart(scope, boss.roomId, client.lastDungeonCutsceneStartAt);

    CombatHandler.handleCharRegen(client as never, buildHpDeltaPayload(boss.id, -400));
    assert.equal(boss.hp, 1000, `${levelName}: non-lethal client HP telemetry mutated canonical HP`);
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        false,
        `${levelName}: non-lethal client HP report completed the boss objective`
    );

    CombatHandler.handleCharRegen(client as never, buildHpDeltaPayload(boss.id, -400));
    assert.equal(boss.hp, 1000, `${levelName}: second non-lethal client HP telemetry mutated canonical HP`);
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        false,
        `${levelName}: cumulative non-lethal client HP reports completed the boss objective early`
    );

    CombatHandler.handleCharRegen(client as never, buildHpDeltaPayload(boss.id, -200));
    assert.equal(boss.hp, 0, `${levelName}: lethal required-boss HP report did not reach canonical state`);
    assert.equal(boss.dead, true, `${levelName}: lethal required-boss HP report did not mark the boss dead`);
    assert.equal(boss.clientDefeatVerified, true, `${levelName}: lethal boss report was not verified`);
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        true,
        `${levelName}: lethal boss report never reached dungeon completion`
    );
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).ready,
        false,
        `${levelName}: completed before the authored boss defeat cutscene`
    );

    assert.equal(
        DungeonCompletionSystem.evaluate(scope).ready,
        false,
        `${levelName}: completed while the authored defeat cutscene was active`
    );
    assert.equal(
        DungeonCompletionSystem.noteCutsceneEnd(scope, boss.roomId, Date.now() + 1),
        true,
        `${levelName}: did not become ready after the authored defeat cutscene ended`
    );

    clearRun(client);
}

function testMultiBossHpReportsRequireEveryBoss(): void {
    const client = createClient('AC_Mission5Hard', 3);
    const blackDragon = createBoss(10_103, 'AncientDragonBlackHard');
    const silverDragon = createBoss(10_104, 'AncientDragonSilverHard');
    const scope = seedBosses(client, [blackDragon, silverDragon]);

    CombatHandler.handleCharRegen(client as never, buildHpDeltaPayload(blackDragon.id, -1000));
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).ready,
        false,
        'multi-boss dungeon completed after only the first required boss HP report'
    );

    CombatHandler.handleCharRegen(client as never, buildHpDeltaPayload(silverDragon.id, -1000));
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).ready,
        true,
        'multi-boss dungeon did not complete after every required boss HP report'
    );

    clearRun(client);
}

function testBossHealResetsAccumulatedClientDamage(): void {
    const client = createClient('OMM_Mission12', 30);
    const boss = createBoss(10_230, 'MagmaCyclopsBoss');
    const scope = seedBosses(client, [boss]);
    GlobalState.sessionsByToken.set(client.token, client as never);
    client.activeDungeonCutsceneScope = scope;
    client.activeDungeonCutsceneRoomId = boss.roomId;
    client.lastDungeonCutsceneStartAt = Date.now();
    DungeonCompletionSystem.noteCutsceneStart(scope, boss.roomId, 3000);

    CombatHandler.handleCharRegen(client as never, buildHpDeltaPayload(boss.id, -400));
    CombatHandler.handleCharRegen(client as never, buildHpDeltaPayload(boss.id, -400));
    (CombatHandler as any).resetClientReportedBossDamage(scope, boss);
    CombatHandler.handleCharRegen(client as never, buildHpDeltaPayload(boss.id, -200));
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        false,
        'boss regen did not clear stale accumulated client damage'
    );

    CombatHandler.handleCharRegen(client as never, buildHpDeltaPayload(boss.id, -800));
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        true,
        'fresh post-regen client damage did not verify the boss defeat'
    );

    clearRun(client);
}

function testPartyBossHpReportsAggregateAcrossParticipants(): void {
    const first = createClient('OMM_Mission12', 40);
    const second = createClient('OMM_Mission12', 41);
    second.levelInstanceId = first.levelInstanceId;
    const boss = createBoss(10_240, 'MagmaCyclopsBoss');
    const scope = seedBosses(first, [boss]);
    second.entities.set(boss.id, boss);
    GlobalState.sessionsByToken.set(first.token, first as never);
    GlobalState.sessionsByToken.set(second.token, second as never);
    DungeonCompletionSystem.noteCutsceneStart(scope, boss.roomId, Date.now());

    CombatHandler.handleCharRegen(first as never, buildHpDeltaPayload(boss.id, -600));
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        false,
        'one participant completed a shared boss with only partial reported damage'
    );
    CombatHandler.handleCharRegen(second as never, buildHpDeltaPayload(boss.id, -400));
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        true,
        'party damage reports did not aggregate to the shared boss max HP'
    );

    clearRun(first);
    GlobalState.sessionsByToken.delete(second.token);
}

async function testContributedBossDestroyOverridesStaleCanonicalHp(): Promise<void> {
    const client = createClient('OMM_Mission12Hard', 4);
    const boss = createBoss(10_204, 'MagmaCyclopsBossHard');
    const scope = seedBosses(client, [boss]);
    const combatHandler = CombatHandler as any;
    combatHandler.recordContribution(scope, boss.id, client, 250);

    await CombatHandler.handleEntityDestroy(client as never, buildDestroyEntityPayload(boss.id));

    assert.equal(boss.hp, 0, 'verified boss destroy did not override stale canonical HP');
    assert.equal(boss.dead, true, 'verified boss destroy did not mark the canonical boss dead');
    assert.equal(boss.destroyed, true, 'verified boss destroy did not finalize the canonical boss');
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).objectivesMet,
        true,
        'verified boss destroy never reached dungeon completion'
    );
    assert.equal(
        DungeonCompletionSystem.evaluate(scope).ready,
        false,
        'verified boss destroy bypassed the authored Meylour cutscene gate'
    );

    clearRun(client);
    GlobalState.combatContributions.clear();
}

async function main(): Promise<void> {
    const dataDir = path.resolve(__dirname, '../data');
    LevelConfig.load(dataDir);
    GameData.load(dataDir);

    const combatHandler = CombatHandler as any;
    const originalMissionWork = combatHandler.fireAndForgetMissionWork;
    combatHandler.fireAndForgetMissionWork = (): void => undefined;
    try {
        const authoredBossFlows = [
            ['OMM_Mission2', 'CaveWizard'],
            ['OMM_Mission2Hard', 'CaveWizardHard'],
            ['SwampRoadConnectionMission', 'Aracnae'],
            ['SwampRoadConnectionMissionHard', 'Aracnae'],
            ['OMM_Mission12', 'MagmaCyclopsBoss'],
            ['OMM_Mission12Hard', 'MagmaCyclopsBossHard'],
            ['AC_Mission1', 'AncientDragonGold'],
            ['AC_Mission1Hard', 'AncientDragonGoldHard']
        ] as const;
        authoredBossFlows.forEach(([levelName, bossName], index) =>
            testAuthoredBossHpReportDuringDefeatCutscene(levelName, bossName, index + 1)
        );
        testMultiBossHpReportsRequireEveryBoss();
        testBossHealResetsAccumulatedClientDamage();
        testPartyBossHpReportsAggregateAcrossParticipants();
        await testContributedBossDestroyOverridesStaleCanonicalHp();
    } finally {
        combatHandler.fireAndForgetMissionWork = originalMissionWork;
    }

    assert.equal(GlobalState.dungeonCompletions.size, 0, 'boss HP report regression leaked completion state');
    console.log('dungeon_boss_hp_report_completion_regression: ok');
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
