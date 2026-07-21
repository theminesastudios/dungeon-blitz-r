import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';
import { CombatHandler } from '../handlers/CombatHandler';

function createBoss(id: number, name: string, hp: number): any {
    return {
        id,
        name,
        EntName: name,
        displayName: 'Greater Bone Golem',
        roomBossName: 'Greater Bone Golem',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        roomId: 8,
        clientSpawned: true,
        hp,
        maxHp: 1000,
        healthDelta: hp - 1000,
        health_delta: hp - 1000,
        dead: hp <= 0,
        destroyed: false,
        entState: hp <= 0 ? EntityState.DEAD : EntityState.ACTIVE
    };
}

function testDamageToSurvivorDoesNotReviveDefeatedTwin(
    levelName: string,
    firstBossName: string,
    secondBossName: string
): void {
    const levelInstanceId = `back-alley-health-${levelName}`;
    const scope = getLevelScopeKey(levelName, levelInstanceId);
    const defeatedBoss = createBoss(81_001, firstBossName, 0);
    const survivingBoss = createBoss(81_002, secondBossName, 1000);
    const token = levelName.endsWith('Hard') ? 82_002 : 82_001;
    const client = {
        token,
        currentLevel: levelName,
        levelInstanceId,
        playerSpawned: true,
        clientEntID: token + 1000,
        character: {
            name: `${levelName}BossHealthTester`,
            CurrentLevel: { name: levelName, x: 0, y: 0 }
        },
        entityIdAliases: new Map<number, number>(),
        entities: new Map([
            [defeatedBoss.id, defeatedBoss],
            [survivingBoss.id, survivingBoss]
        ])
    };
    GlobalState.levelEntities.set(scope, new Map([
        [defeatedBoss.id, defeatedBoss],
        [survivingBoss.id, survivingBoss]
    ]));
    GlobalState.sessionsByToken.set(token, client as never);

    try {
        const resolution = (CombatHandler as any).updateNpcTargetAfterHit(scope, survivingBoss.id, 100);

        assert.equal(resolution.appliedDamage, 100, `${levelName}: surviving boss did not take the hit`);
        assert.equal(survivingBoss.hp, 900, `${levelName}: surviving boss HP was not updated`);
        assert.equal(
            defeatedBoss.hp,
            0,
            `${levelName}: damaging the surviving boss regenerated the defeated boss`
        );
        assert.equal(defeatedBoss.dead, true, `${levelName}: defeated boss was revived by its twin's health sync`);
        assert.equal(
            defeatedBoss.entState,
            EntityState.DEAD,
            `${levelName}: defeated boss returned to active combat state`
        );
    } finally {
        GlobalState.sessionsByToken.delete(token);
        GlobalState.levelEntities.delete(scope);
    }
}

function main(): void {
    const dataDir = path.resolve(__dirname, '../data');
    LevelConfig.load(dataDir);
    GameData.load(dataDir);

    testDamageToSurvivorDoesNotReviveDefeatedTwin(
        'JC_Mission2',
        'GreaterBoneGolem',
        'GreaterBoneGolem2'
    );
    testDamageToSurvivorDoesNotReviveDefeatedTwin(
        'JC_Mission2Hard',
        'GreaterBoneGolemHard',
        'GreaterBoneGolem2Hard'
    );

    console.log('back_alley_boss_health_regression: ok');
}

main();
