import { strict as assert } from 'assert';
import * as path from 'path';
import { AILogic } from '../core/AILogic';
import { CombatHandler } from '../handlers/CombatHandler';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';

function createPlayer(currentLevel: string): any {
    return {
        token: 88_001,
        userId: 88_001,
        clientEntID: 88_101,
        playerSpawned: true,
        currentLevel,
        levelInstanceId: 'aggro-regression',
        currentRoomId: 4,
        authoritativeCurrentHp: 100,
        // Inside the melee aggro radius but outside melee attack range, so a pulled
        // enemy chases (moves) rather than standing still to swing.
        character: { name: 'AggroTarget', CurrentLevel: { name: currentLevel, x: 110, y: 0 } },
        entities: new Map<number, any>(),
        send(): void { /* test stub */ }
    };
}

function createNpc(name: string, extras: Record<string, unknown> = {}): any {
    return {
        id: 88_201,
        name,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        x: 0,
        y: 0,
        spawnX: 0,
        spawnY: 0,
        roomId: 4,
        hp: 100,
        maxHp: 100,
        entState: EntityState.ACTIVE,
        aggroTargetEntityId: 0,
        aggroTargetToken: 0,
        lastCombatActivityAt: 0,
        ...extras
    };
}

function main(): void {
    const dataDir = path.resolve(__dirname, '../data');
    LevelConfig.load(dataDir);
    GameData.load(dataDir);

    const dungeonPlayer = createPlayer('OMM_Mission2');
    const dungeonScope = 'OMM_Mission2#aggro-regression';
    const minion = createNpc('GoblinBrute');
    AILogic.updateNpc(minion, [dungeonPlayer], dungeonScope);
    assert.notEqual(minion.x, 0, 'dungeon minion did not proximity-pull');

    minion.x = 0;
    minion.lastCombatActivityAt = Date.now();
    AILogic.updateNpc(minion, [dungeonPlayer], dungeonScope);
    assert.notEqual(minion.x, 0, 'dungeon minion lost proximity aggro with a combat timestamp');

    // Boss aggro radius is below melee attack range, so a pulled boss swings in
    // place instead of moving. Assert the wake itself rather than a position
    // change, which keeps this covering live-room resolution under any tuning.
    const roomBoss = createNpc('GoblinMiniBoss', {
        id: 88_202, isRoomBoss: true, roomBossRoomId: 4, roomId: 2,
        x: 50, spawnX: 50, entState: EntityState.SLEEP, aiIdleAtHome: true
    });
    AILogic.updateNpc(roomBoss, [dungeonPlayer], dungeonScope);
    assert.equal(roomBoss.entState, EntityState.ACTIVE, 'dungeon miniboss did not use its live room when proximity-pulling');

    minion.aggroTargetEntityId = dungeonPlayer.clientEntID;
    minion.aggroTargetToken = dungeonPlayer.token;
    AILogic.updateNpc(minion, [dungeonPlayer], dungeonScope);
    assert.notEqual(minion.x, 0, 'explicitly hit dungeon minion did not activate');

    minion.x = 0;
    minion.aggroTargetEntityId = 999_999;
    minion.aggroTargetToken = 999_999;
    AILogic.updateNpc(minion, [dungeonPlayer], dungeonScope);
    assert.notEqual(minion.x, 0, 'hostile did not reacquire a nearby player after its recorded target disappeared');
    assert.equal(minion.aggroTargetEntityId, 0, 'missing aggro target was not cleared');

    const outdoorPlayer = createPlayer('NewbieRoad');
    const outdoorNpc = createNpc('GoblinBrute', { id: 88_203 });
    GlobalState.sessionsByToken.set(outdoorPlayer.token, outdoorPlayer);
    try {
        AILogic.updateNpc(outdoorNpc, [outdoorPlayer], 'NewbieRoad');
        assert.notEqual(outdoorNpc.x, 0, 'outdoor proximity aggro was disabled');
    } finally {
        GlobalState.sessionsByToken.delete(outdoorPlayer.token);
    }

    const originalBroadcast = CombatHandler.broadcastEntityViewPacket;
    let movementPackets = 0;
    CombatHandler.broadcastEntityViewPacket = ((_scope: string, _entity: any, packetId: number): void => {
        if (packetId === 0x07) movementPackets += 1;
    }) as typeof CombatHandler.broadcastEntityViewPacket;
    try {
        const abandonedNpc = createNpc('GoblinBrute', {
            id: 88_204,
            x: 300,
            spawnX: 25,
            spawnY: 10,
            aggroTargetEntityId: dungeonPlayer.clientEntID,
            aggroTargetToken: dungeonPlayer.token,
            nextAttack: Date.now() + 10_000
        });
        const abandonedAt = Date.now();
        // The first empty tick only arms the debounce: the enemy must hold position
        // so a player crossing a room boundary cannot drive an aggro/reset loop.
        AILogic.updateNpc(abandonedNpc, [], dungeonScope, abandonedAt);
        assert.equal(abandonedNpc.x, 300, 'enemy reset home before the debounce elapsed');
        assert.equal(movementPackets, 0, 'debounced reset emitted a packet on the first empty tick');

        // Once the room has stayed empty past the debounce, the reset lands.
        AILogic.updateNpc(abandonedNpc, [], dungeonScope, abandonedAt + AILogic.RESET_DEBOUNCE_MS + 1);
        assert.equal(abandonedNpc.x, 25, 'enemy did not return to its original X after its room emptied');
        assert.equal(abandonedNpc.y, 10, 'enemy did not return to its original Y after its room emptied');
        assert.equal(abandonedNpc.entState, EntityState.SLEEP, 'enemy did not sleep after returning home');
        assert.equal(abandonedNpc.aggroTargetEntityId, 0, 'room-exited enemy kept entity aggro');
        assert.equal(abandonedNpc.aggroTargetToken, 0, 'room-exited enemy kept token aggro');
        assert.equal(abandonedNpc.nextAttack, 0, 'room-exited enemy kept its attack timer');
        assert.equal(movementPackets, 1, 'room exit did not produce exactly one reset packet');
        AILogic.updateNpc(abandonedNpc, [], dungeonScope);
        assert.equal(movementPackets, 1, 'sleeping enemy emitted repeated reset packets');

        const farPlayer = createPlayer('OMM_Mission2');
        farPlayer.character.CurrentLevel.x = 3_000;
        const leashedNpc = createNpc('GoblinBrute', {
            id: 88_205,
            x: 100,
            spawnX: 0,
            aggroTargetEntityId: farPlayer.clientEntID,
            aggroTargetToken: farPlayer.token
        });
        AILogic.updateNpc(leashedNpc, [farPlayer], dungeonScope);
        assert.equal(Math.round(leashedNpc.x), 80, 'over-leashed enemy did not start returning home');
        assert.equal(leashedNpc.entState, EntityState.ACTIVE, 'returning enemy slept before reaching home');
        assert.equal(leashedNpc.aggroTargetEntityId, 0, 'returning enemy kept combat aggro');
        for (let i = 0; i < 4; i++) AILogic.updateNpc(leashedNpc, [farPlayer], dungeonScope);
        assert.equal(leashedNpc.x, 0, 'over-leashed enemy did not finish at its spawn X');
        assert.equal(leashedNpc.entState, EntityState.SLEEP, 'over-leashed enemy did not sleep at home');

        const sleepingNpc = createNpc('GoblinBrute', {
            id: 88_206,
            entState: EntityState.SLEEP,
            aiIdleAtHome: true
        });
        AILogic.updateNpc(sleepingNpc, [dungeonPlayer], dungeonScope);
        assert.equal(sleepingNpc.entState, EntityState.ACTIVE, 'nearby player did not wake a sleeping enemy');
        assert.notEqual(sleepingNpc.x, 0, 'woken enemy did not resume chasing');

        const stagedNpc = createNpc('IntroGoblinJumper', {
            id: 88_208,
            x: 40,
            spawnX: 10,
            entState: EntityState.DRAMA,
            spawnEntState: EntityState.DRAMA
        });
        const stagedAt = Date.now();
        AILogic.updateNpc(stagedNpc, [], dungeonScope, stagedAt);
        assert.equal(stagedNpc.x, 40, 'scripted enemy reset before the debounce elapsed');
        AILogic.updateNpc(stagedNpc, [], dungeonScope, stagedAt + AILogic.RESET_DEBOUNCE_MS + 1);
        assert.equal(stagedNpc.x, 10, 'scripted enemy did not return to its staged position');
        assert.equal(stagedNpc.entState, EntityState.DRAMA, 'scripted enemy lost its authored drama state');

        const emptyScope = 'OMM_Mission2#empty-ai-room';
        const emptyScopeNpc = createNpc('GoblinBrute', { id: 88_207, x: 75, spawnX: 5 });
        GlobalState.levelEntities.set(emptyScope, new Map([[emptyScopeNpc.id, emptyScopeNpc]]));
        // updateLevel reads the clock itself, so drop the debounce for this block:
        // it asserts that an empty scope resets a displaced enemy, not the timing.
        const originalDebounceMs = AILogic.RESET_DEBOUNCE_MS;
        (AILogic as any).RESET_DEBOUNCE_MS = 0;
        try {
            const result = AILogic.updateLevel(emptyScope);
            assert.equal(result.players, 0, 'empty scope unexpectedly found a player');
            assert.equal(emptyScopeNpc.x, 5, 'scope with no players preserved a displaced enemy');
            assert.equal(emptyScopeNpc.entState, EntityState.SLEEP, 'scope with no players preserved active AI');
        } finally {
            (AILogic as any).RESET_DEBOUNCE_MS = originalDebounceMs;
            GlobalState.levelEntities.delete(emptyScope);
        }
    } finally {
        CombatHandler.broadcastEntityViewPacket = originalBroadcast;
    }

    console.log('combat_ai_regression: ok');
}

main();
