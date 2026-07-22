import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { CombatHandler } from '../handlers/CombatHandler';
import { RewardHandler } from '../handlers/RewardHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';

function createClient(token: number, instanceId: string, levelName: string = 'JC_Mission9'): any {
    const client: any = {
        token,
        userId: token,
        currentLevel: levelName,
        levelInstanceId: instanceId,
        currentRoomId: 4,
        playerSpawned: true,
        clientEntID: token,
        character: {
            name: `BossTester${token}`,
            class: 'mage',
            level: 30,
            xp: 0,
            gold: 0,
            CurrentLevel: { name: levelName, x: 5_000, y: 5_000 }
        },
        characters: [],
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        sharedEntityRemoteUpdateDeferredIds: new Set<number>(),
        pendingLoot: new Map<number, any>(),
        processedRewardSources: new Set<string>(),
        enemyDeathRegenArmed: false,
        authoritativeMaxHp: 1_000,
        authoritativeCurrentHp: 1_000,
        combatStatsDirty: false,
        lastCombatStatsSyncedAt: Date.now(),
        pendingRespawnRequest: null,
        sentPacketIds: [] as number[],
        send(id: number): void { this.sentPacketIds.push(id); },
        sendBitBuffer(id: number): void { this.sentPacketIds.push(id); },
        scheduleCharacterSave(): void { /* test stub */ }
    };
    client.characters = [client.character];
    return client;
}

function playerEntity(client: any, dead: boolean = false): any {
    return {
        id: client.clientEntID,
        isPlayer: true,
        team: EntityTeam.PLAYER,
        roomId: 4,
        x: 5_000,
        y: 5_000,
        hp: dead ? 0 : 1_000,
        maxHp: 1_000,
        dead,
        entState: dead ? EntityState.DEAD : EntityState.ACTIVE
    };
}

function bossEntity(id: number, hp: number = 400, name: string = 'RisenBandit'): any {
    return {
        id,
        name,
        entRank: 'Boss',
        isPlayer: false,
        team: EntityTeam.ENEMY,
        roomId: 4,
        x: 0,
        y: 0,
        hp,
        maxHp: 1_000,
        healthDelta: hp - 1_000,
        health_delta: hp - 1_000,
        dead: hp <= 0,
        destroyed: false,
        entState: hp <= 0 ? EntityState.DEAD : EntityState.ACTIVE,
        lastCombatActivityAt: 1,
        lastCombatRegenTickAt: 0
    };
}

function seed(client: any, boss: any): string {
    const scope = getClientLevelScope(client);
    const player = playerEntity(client);
    client.entities.set(client.clientEntID, player);
    client.entities.set(boss.id, boss);
    GlobalState.levelEntities.set(scope, new Map([
        [client.clientEntID, { ...player }],
        [boss.id, boss]
    ]));
    GlobalState.sessionsByToken.set(client.token, client);
    return scope;
}

function clear(client: any, scope: string): void {
    GlobalState.sessionsByToken.delete(client.token);
    GlobalState.levelEntities.delete(scope);
}

function testReportedBossesOnlyRestoreAfterPlayerDeath(): void {
    const affectedLevels = [
        ['Svagg\'s Last Stand', 'BT_Mission2', 'BanditBoss'],
        ['Dread Svagg\'s Last Stand', 'BT_Mission2Hard', 'BanditBossHard'],
        ['Embodiment of Evil', 'CH_Mission5', 'DemonMaligner'],
        ['Dread Embodiment of Evil', 'CH_Mission5Hard', 'DemonMalignerHard'],
        ['Last Stand (Castle Hocke)', 'AC_Mission5', 'AncientDragonBlack'],
        ['Dread Last Stand (Castle Hocke)', 'AC_Mission5Hard', 'AncientDragonBlackHard']
    ] as const;

    affectedLevels.forEach(([displayName, levelName, bossName], index) => {
        const client = createClient(71_001 + index, `boss-death-only-${levelName}`, levelName);
        const boss = bossEntity(72_001 + index, 400, bossName);
        const scope = seed(client, boss);
        try {
            (CombatHandler as any).processHostileOutOfCombatRegen(scope, boss, 10_000);
            assert.equal(boss.hp, 400, `${displayName} regenerated while the player was alive`);
            assert.equal(
                client.sentPacketIds.includes(0x78),
                false,
                `${displayName} emitted a heal packet while the player was alive`
            );

            // The death reset is paced, not a snap: the tick that observes the
            // death restores one 5% step, and the bar climbs from there while
            // the player stays down.
            CombatHandler.notePlayerDeathState(client, 20_000);
            assert.equal(boss.hp, 450, `${displayName} did not take its first restore step after the player died`);
            assert.equal(boss.dead, false, `${displayName} became terminal during its player-death reset`);
            assert.equal(
                client.sentPacketIds.includes(0x78),
                true,
                `${displayName} did not emit a heal packet after the player died`
            );

            for (let tick = 1; tick <= 12; tick++) {
                CombatHandler.processOutOfCombatRegen(scope, 20_000 + tick * 1_000);
            }
            assert.equal(boss.hp, boss.maxHp, `${displayName} never finished restoring while the player stayed dead`);
        } finally {
            clear(client, scope);
        }
    });
}

function testUnarmedLivingBossDoesNotRestoreAfterDisengaging(): void {
    const client = createClient(71_010, 'boss-disengage');
    const boss = bossEntity(72_010, 400);
    const scope = seed(client, boss);
    try {
        (CombatHandler as any).processHostileOutOfCombatRegen(scope, boss, 10_000);
        assert.equal(boss.hp, 400, 'a living boss regenerated without a player-death arm');
        assert.equal(client.sentPacketIds.includes(0x78), false, 'an unarmed boss emitted a heal packet');
    } finally {
        clear(client, scope);
    }
}

function testPlayerDeathRestoresLivingBossCompletely(): void {
    const client = createClient(71_002, 'boss-player-death');
    const boss = bossEntity(72_002, 350);
    const scope = seed(client, boss);
    try {
        CombatHandler.notePlayerDeathState(client, 10_000);
        assert.equal(boss.hp, 400, 'a living boss did not begin restoring after its player target died');
        assert.equal(boss.dead, false, 'a living boss became terminal during a player-death reset');

        for (let tick = 1; tick <= 13; tick++) {
            CombatHandler.processOutOfCombatRegen(scope, 10_000 + tick * 1_000);
        }
        assert.equal(boss.hp, boss.maxHp, 'a living boss did not fully reset while its player target stayed dead');
    } finally {
        clear(client, scope);
    }
}

function testTerminalBossCorpseNeverRegenerates(): void {
    const client = createClient(71_003, 'boss-terminal-death');
    const boss = bossEntity(72_003, 0);
    boss.destroyed = true;
    boss.deathFinalizedAt = 9_000;
    boss.finalDeathReason = 'regression_terminal_death';
    boss.deathRegenArmedForPlayerKey = `${client.token}:${client.clientEntID}`;
    const scope = seed(client, boss);
    const deadPlayer = playerEntity(client, true);
    client.entities.set(client.clientEntID, deadPlayer);
    GlobalState.levelEntities.get(scope)?.set(client.clientEntID, { ...deadPlayer });
    client.authoritativeCurrentHp = 0;
    client.enemyDeathRegenArmed = true;

    try {
        (CombatHandler as any).processHostileOutOfCombatRegen(scope, boss, 60_000);
        assert.equal(boss.hp, 0, 'a finalized boss corpse regenerated');
        assert.equal(boss.dead, true, 'a finalized boss corpse returned to active state');
        assert.equal(boss.destroyed, true, 'a finalized boss lost its destroyed marker');
        assert.equal(
            String(boss.deathRegenArmedForPlayerKey ?? ''),
            '',
            'a finalized boss retained a stale player-death regen arm'
        );
    } finally {
        clear(client, scope);
    }
}

function buildRespawnRequest(): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod15(false);
    return bb.toBuffer();
}

function testPlayerRespawnPreservesRunRewardLedger(): void {
    const client = createClient(71_004, 'boss-reward-ledger');
    const boss = bossEntity(72_004, 0);
    boss.destroyed = true;
    boss.deathFinalizedAt = 9_000;
    const scope = seed(client, boss);
    const rewardKey = `${scope}:boss-primary:${boss.id}`;
    client.processedRewardSources.add(rewardKey);
    GlobalState.entityLifeNonces.set(`${scope}:${boss.id}`, 3);
    GlobalState.entityLastRewardNonces.set(`${scope}:${boss.id}`, 2);

    try {
        CombatHandler.handleRequestRespawn(client, buildRespawnRequest());
        assert.equal(
            client.processedRewardSources.has(rewardKey),
            true,
            'player respawn erased the dungeon-run reward ledger'
        );
        assert.equal(
            GlobalState.entityLastRewardNonces.get(`${scope}:${boss.id}`),
            2,
            'player respawn erased the boss life reward nonce'
        );
    } finally {
        GlobalState.entityLifeNonces.delete(`${scope}:${boss.id}`);
        GlobalState.entityLastRewardNonces.delete(`${scope}:${boss.id}`);
        clear(client, scope);
    }
}

function testScriptedBossReviveOnlyKeepsHealthDrop(): void {
    const client = createClient(71_005, 'boss-scripted-revive');
    const boss = bossEntity(72_005, 0);
    const scope = seed(client, boss);
    const reward = {
        receiverId: client.clientEntID,
        sourceId: boss.id,
        dropItem: false,
        itemMultiplier: 0,
        dropGear: false,
        gearMultiplier: 0,
        dropMaterial: false,
        dropTrove: false,
        exp: 100,
        petExp: 0,
        hpGain: 25,
        gold: 10,
        worldX: 0,
        worldY: 0,
        combo: 0
    };

    try {
        const firstGranted = (RewardHandler as any).applyRewardToRecipient(
            client,
            reward,
            0,
            boss,
            { x: 0, y: 0 },
            { reason: 'legacy_enemy_reward', caller: 'boss_lifecycle_regression' }
        );
        const xpAfterFirstLife = client.character.xp;
        const firstLifeLoot = Array.from(client.pendingLoot.values());
        assert.equal(firstGranted, true, 'first boss life did not grant its authored reward');
        assert.equal(firstLifeLoot.some((entry: any) => entry.gold > 0), true, 'first boss life lost its primary gold drop');
        assert.equal(firstLifeLoot.some((entry: any) => entry.health > 0), true, 'first boss life lost its health drop');

        const secondGranted = (RewardHandler as any).applyRewardToRecipient(
            client,
            reward,
            1,
            boss,
            { x: 0, y: 0 },
            { reason: 'legacy_enemy_reward', caller: 'boss_lifecycle_regression' }
        );
        assert.equal(secondGranted, true, 'scripted revived boss lost its allowed health drop');
        assert.equal(client.character.xp, xpAfterFirstLife, 'scripted boss revive granted XP twice');
        const revivedLifeLoot = Array.from(client.pendingLoot.values()) as any[];
        revivedLifeLoot.splice(0, firstLifeLoot.length);
        assert.equal(revivedLifeLoot.length, 1, 'scripted boss revive granted more than one loot drop');
        assert.equal(revivedLifeLoot[0]?.health, 25, 'scripted boss revive did not keep exactly its authored health drop');
        assert.equal(revivedLifeLoot[0]?.gold ?? 0, 0, 'scripted boss revive granted gold twice');
        assert.equal(revivedLifeLoot[0]?.gear ?? 0, 0, 'scripted boss revive granted gear twice');
        assert.equal(revivedLifeLoot[0]?.material ?? 0, 0, 'scripted boss revive granted materials twice');
    } finally {
        clear(client, scope);
    }
}

function main(): void {
    const dataDir = path.resolve(__dirname, '../data');
    LevelConfig.load(dataDir);
    GameData.load(dataDir);

    testReportedBossesOnlyRestoreAfterPlayerDeath();
    testUnarmedLivingBossDoesNotRestoreAfterDisengaging();
    testPlayerDeathRestoresLivingBossCompletely();
    testTerminalBossCorpseNeverRegenerates();
    testPlayerRespawnPreservesRunRewardLedger();
    testScriptedBossReviveOnlyKeepsHealthDrop();
    console.log('boss_lifecycle_reward_regression: ok');
}

main();
