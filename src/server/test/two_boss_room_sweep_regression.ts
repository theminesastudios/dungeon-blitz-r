import assert from 'assert';
import path from 'path';
import { DungeonCompletionSystem } from '../core/DungeonCompletionSystem';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { MissionHandler } from '../handlers/MissionHandler';

// Svagg's Last Stand (BT_Mission2) authors two different bosses in one room:
// ac_BanditBoss ("Svagg") and the griffon he summons, ac_GriffonStar ("Wrath").
// Both must die for the run to finish.
//
// The boss-scene duplicate sweep matched entities against the *level's* whole
// boss-name set, so once BossFight announced Svagg it treated Wrath as a stale
// copy of him: deleted from the shared map, destroyed on every client, and its
// id aliased onto Svagg. Wrath could then never take damage or die, the run's
// objectives were never met, and the dungeon never ended. Every two-boss room
// has the same shape — the bandit twins, the bone golems, Dragon White and the
// Lion Lord — so the sweep must compare copies of the same boss only.

function makeBoss(id: number, name: string): any {
    return {
        id,
        name,
        EntName: name,
        isPlayer: false,
        team: EntityTeam.ENEMY,
        roomId: 11,
        hp: 1000,
        maxHp: 1000,
        dead: false,
        destroyed: false,
        entState: EntityState.ACTIVE,
        lifeNonce: 1
    };
}

function createClient(): any {
    return {
        token: 91_001,
        userId: 92_001,
        character: {
            name: 'SvaggSweep',
            level: 12,
            class: 'rogue',
            CurrentLevel: { name: 'BT_Mission2', x: 0, y: 0 }
        },
        currentLevel: 'BT_Mission2',
        levelInstanceId: 'two-boss-sweep',
        currentRoomId: 11,
        playerSpawned: true,
        clientEntID: 93_001,
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        sentPacketIds: [] as number[],
        send(id: number): void { this.sentPacketIds.push(id); },
        sendBitBuffer(id: number): void { this.sentPacketIds.push(id); }
    };
}

function defeat(levelScope: string, boss: any, now: number): void {
    boss.hp = 0;
    boss.dead = true;
    boss.destroyed = true;
    boss.entState = EntityState.DEAD;
    DungeonCompletionSystem.noteEntityDefeated(levelScope, boss, now);
}

function verifyTheSecondBossSurvivesTheBossSceneSweep(): void {
    const client = createClient();
    const levelScope = getClientLevelScope(client);
    const svagg = makeBoss(94_001, 'BanditBoss');
    const svaggCopy = makeBoss(94_002, 'BanditBoss');
    const wrath = makeBoss(94_003, 'GriffonStar');

    GlobalState.sessionsByToken.set(client.token, client);
    GlobalState.levelEntities.set(levelScope, new Map([
        [svagg.id, svagg],
        [svaggCopy.id, svaggCopy],
        [wrath.id, wrath]
    ]));
    for (const boss of [svagg, svaggCopy, wrath]) {
        client.entities.set(boss.id, boss);
        client.knownEntityIds.add(boss.id);
    }

    try {
        MissionHandler.sweepBossSceneDuplicates(levelScope, 'BT_Mission2', svagg.id, 'test');

        const scopeEntities = GlobalState.levelEntities.get(levelScope)!;
        assert.equal(scopeEntities.has(svagg.id), true, 'the sweep removed the announced boss');
        assert.equal(scopeEntities.has(svaggCopy.id), false, 'the stale Svagg copy survived the sweep');
        assert.equal(scopeEntities.has(wrath.id), true, 'the sweep deleted the second boss from the shared map');
        assert.equal(client.entities.has(wrath.id), true, 'the sweep destroyed the second boss on the client');
        assert.equal(
            client.entityIdAliases.has(wrath.id),
            false,
            'damage aimed at the second boss was re-pointed onto the first'
        );

        // The whole point of keeping Wrath: the run can still reach its objectives.
        defeat(levelScope, svagg, 1_000);
        assert.equal(
            DungeonCompletionSystem.evaluate(levelScope, 1_001).objectivesMet,
            false,
            'the run finished on Svagg alone'
        );
        defeat(levelScope, wrath, 2_000);
        assert.equal(
            DungeonCompletionSystem.evaluate(levelScope, 2_001).objectivesMet,
            true,
            'both bosses died and the run still had objectives pending'
        );
    } finally {
        DungeonCompletionSystem.reset(levelScope);
        GlobalState.levelEntities.delete(levelScope);
        GlobalState.sessionsByToken.delete(client.token);
    }
}

function main(): void {
    LevelConfig.load(path.resolve(__dirname, '../data'));
    verifyTheSecondBossSurvivesTheBossSceneSweep();
    console.log('two_boss_room_sweep_regression: ok');
}

main();
