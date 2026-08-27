import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { LevelConfig } from '../core/LevelConfig';
import { getLevelScopeKey } from '../core/LevelScope';
import { CombatHandler } from '../handlers/CombatHandler';

function ensureDataLoaded(): void {
    if (!LevelConfig.has('JC_Mission2')) {
        LevelConfig.load(path.resolve(__dirname, '../data'));
    }
}

function createBoss(name: string): any {
    return {
        id: 100,
        name,
        EntName: name,
        entName: name,
        characterName: `,${name}`,
        isPlayer: false,
        clientSpawned: true,
        team: EntityTeam.ENEMY,
        roomId: 8,
        hp: 50,
        maxHp: 100,
        dead: false,
        destroyed: false,
        entState: EntityState.ACTIVE
    };
}

function shouldReject(
    levelName: string,
    bossName: string,
    amount: number,
    hasLivingPlayer: boolean
): boolean {
    const scope = getLevelScopeKey(levelName, `mortis-regen-${levelName}`);
    return Boolean((CombatHandler as any).shouldRejectLivingBossRegenReport(
        scope,
        createBoss(bossName),
        amount,
        hasLivingPlayer
    ));
}

function main(): void {
    ensureDataLoaded();

    for (const [levelName, mortisName] of [
        ['JC_Mission2', 'GreaterBoneGolem2'],
        ['JC_Mission2Hard', 'GreaterBoneGolem2Hard']
    ] as Array<[string, string]>) {
        assert.equal(
            shouldReject(levelName, mortisName, 5, true),
            true,
            `${levelName}: Mortis Golem must not regenerate while a player is alive`
        );
        assert.equal(
            shouldReject(levelName, mortisName, 5, false),
            false,
            `${levelName}: Mortis Golem may regenerate after the player has died`
        );
        assert.equal(
            shouldReject(levelName, mortisName, -5, true),
            false,
            `${levelName}: damage reports must not be rejected as regeneration`
        );
    }

    assert.equal(
        shouldReject('JC_Mission2', 'Skeleton3', 5, true),
        false,
        'ordinary enemies must not be treated as the Back Alley boss'
    );

    console.log('mortis_golem_regen_regression: ok');
}

main();
