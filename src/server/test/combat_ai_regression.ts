import { strict as assert } from 'assert';
import * as path from 'path';
import { AILogic } from '../core/AILogic';
import { LevelConfig } from '../core/LevelConfig';
import { EntityState } from '../core/Entity';

type FakeClient = {
    clientEntID: number;
    currentRoomId: number;
    authoritativeCurrentHp: number;
    entities: Map<number, any>;
    character: {
        CurrentLevel: { x: number; y: number };
    };
};

function createPlayer(x: number, y: number, roomId: number, entityId: number = 3001): FakeClient {
    return {
        clientEntID: entityId,
        currentRoomId: roomId,
        authoritativeCurrentHp: 1000,
        entities: new Map<number, any>([
            [entityId, { id: entityId, isPlayer: true, entState: EntityState.ACTIVE, dead: false, hp: 1000 }]
        ]),
        character: {
            CurrentLevel: { x, y }
        }
    };
}

function createNpc(overrides: Record<string, unknown>): any {
    return {
        id: 2001,
        name: 'GoblinDagger',
        team: 2,
        x: 0,
        y: 0,
        hp: 100,
        maxHp: 100,
        roomId: 1,
        ...overrides
    };
}

function ensureLevelConfigLoaded(): void {
    if (!LevelConfig.has('TutorialDungeon')) {
        LevelConfig.load(path.resolve(__dirname, '../data'));
    }
}

function testOutdoorMeleeAggroStillUsesRoomProximity(): void {
    const npc = createNpc({});

    AILogic.updateNpc(npc, [createPlayer(220, 0, 1) as never], 'BridgeTown');

    assert.equal(
        npc.x > 0,
        true,
        'outdoor melee enemies should still aggro a nearby player in the same room'
    );
}

function testUnhitMeleeMobDoesNotAggroFromRoomProximity(): void {
    const npc = createNpc({});

    AILogic.updateNpc(npc, [createPlayer(220, 0, 1) as never], 'TutorialDungeon');

    assert.equal(
        npc.x,
        0,
        'unhit melee enemies should not wake just because the player is nearby in the same room'
    );
}

function testPulledMeleeAggroStillUsesLocalRoomRadius(): void {
    const player = createPlayer(220, 0, 1);
    const npc = createNpc({
        lastCombatActivityAt: Date.now(),
        aggroTargetEntityId: player.clientEntID
    });

    AILogic.updateNpc(npc, [player as never], 'TutorialDungeon');

    assert.equal(
        npc.x > 0,
        true,
        'pulled melee enemies should still chase the player who hit them in the same room'
    );
}

function testPullOnlyMovesTheHitMob(): void {
    const player = createPlayer(220, 0, 1);
    const pulled = createNpc({
        id: 2001,
        lastCombatActivityAt: Date.now(),
        aggroTargetEntityId: player.clientEntID
    });
    const idle = createNpc({ id: 2002, x: 20 });

    AILogic.updateNpc(pulled, [player as never], 'TutorialDungeon');
    AILogic.updateNpc(idle, [player as never], 'TutorialDungeon');

    assert.equal(pulled.x > 0, true, 'the hit mob should chase');
    assert.equal(idle.x, 20, 'nearby unhit room mobs should remain idle');
}

function testPulledMobKeepsHitPlayerAsTarget(): void {
    const hitter = createPlayer(-220, 0, 1, 3001);
    const bystander = createPlayer(120, 0, 1, 3002);
    const npc = createNpc({
        lastCombatActivityAt: Date.now(),
        aggroTargetEntityId: hitter.clientEntID
    });

    AILogic.updateNpc(npc, [bystander as never, hitter as never], 'TutorialDungeon');

    assert.equal(
        npc.x < 0,
        true,
        'pulled enemies should chase the player who hit them instead of the nearest same-room player'
    );
}

function testBossAggroUsesShorterRadius(): void {
    const npc = createNpc({
        name: 'TestBoss',
        entRank: 'Boss'
    });

    AILogic.updateNpc(npc, [createPlayer(220, 0, 1) as never], 'BridgeTown');

    assert.equal(
        npc.x,
        0,
        'boss-like enemies should not aggro at the old broad melee radius'
    );
}

function testBossAggroRequiresKnownSameRoom(): void {
    const npc = createNpc({
        name: 'TestBoss',
        entRank: 'Boss',
        roomId: -1
    });

    AILogic.updateNpc(npc, [createPlayer(30, 0, -1) as never], 'BridgeTown');

    assert.equal(
        npc.x,
        0,
        'boss-like enemies should not aggro when either side lacks a known matching room'
    );
}

function testBossIgnoresDeadPlayerInSameRoom(): void {
    const deadPlayer = createPlayer(120, 0, 1);
    deadPlayer.authoritativeCurrentHp = 0;
    deadPlayer.entities.get(deadPlayer.clientEntID)!.entState = EntityState.DEAD;
    deadPlayer.entities.get(deadPlayer.clientEntID)!.dead = true;
    const npc = createNpc({
        name: 'TestBoss',
        entRank: 'Boss'
    });

    AILogic.updateNpc(npc, [deadPlayer as never], 'BridgeTown');

    assert.equal(npc.x, 0, 'boss-like enemies should not chase a dead same-room player');
    assert.equal(Number(npc.nextAttack ?? 0), 0, 'boss-like enemies should not attack a dead same-room player');
}

function testPulledMobDropsDeadAggroTarget(): void {
    const deadPlayer = createPlayer(80, 0, 1);
    deadPlayer.authoritativeCurrentHp = 0;
    const npc = createNpc({
        lastCombatActivityAt: Date.now(),
        aggroTargetEntityId: deadPlayer.clientEntID,
        aggroTargetToken: 123,
        nextAttack: Date.now()
    });

    AILogic.updateNpc(npc, [deadPlayer as never], 'TutorialDungeon');

    assert.equal(npc.x, 0, 'pulled enemies should not chase a dead aggro target');
    assert.equal(Number(npc.aggroTargetEntityId ?? 0), 0, 'dead aggro targets should be cleared');
    assert.equal(Number(npc.nextAttack ?? 0), 0, 'clearing a dead aggro target should stop pending attacks');
}

function main(): void {
    ensureLevelConfigLoaded();
    testOutdoorMeleeAggroStillUsesRoomProximity();
    testUnhitMeleeMobDoesNotAggroFromRoomProximity();
    testPulledMeleeAggroStillUsesLocalRoomRadius();
    testPullOnlyMovesTheHitMob();
    testPulledMobKeepsHitPlayerAsTarget();
    testBossAggroUsesShorterRadius();
    testBossAggroRequiresKnownSameRoom();
    testBossIgnoresDeadPlayerInSameRoom();
    testPulledMobDropsDeadAggroTarget();
    console.log('combat_ai_regression: ok');
}

try {
    main();
} catch (error) {
    console.error('combat_ai_regression: failed');
    console.error(error);
    process.exitCode = 1;
}
