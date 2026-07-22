import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { CombatHandler } from '../handlers/CombatHandler';

// A dungeon boss whose killer died used to jump straight back to 100% in the
// single tick that observed the death. Felbridge shows it worst: Bandit Camp's
// twins and Svagg both sit at a sliver and blink to full. The reset trigger is
// unchanged — only a confirmed player death arms it — but the restore is now
// paced at 5% of max HP per one-second regen tick.
const REGEN_RATE = 0.05;
const REGEN_INTERVAL_MS = 1_000;

function createClient(token: number, levelName: string, instanceId: string): any {
    const client: any = {
        token,
        userId: token,
        currentLevel: levelName,
        levelInstanceId: instanceId,
        currentRoomId: 4,
        playerSpawned: true,
        clientEntID: token,
        character: {
            name: `RegenTester${token}`,
            class: 'rogue',
            level: 30,
            CurrentLevel: { name: levelName, x: 5_000, y: 5_000 }
        },
        entities: new Map<number, any>(),
        knownEntityIds: new Set<number>(),
        entityIdAliases: new Map<number, number>(),
        sharedEntityRemoteUpdateDeferredIds: new Set<number>(),
        enemyDeathRegenArmed: false,
        authoritativeMaxHp: 1_000,
        authoritativeCurrentHp: 1_000,
        sentPacketIds: [] as number[],
        send(id: number): void { this.sentPacketIds.push(id); },
        sendBitBuffer(id: number): void { this.sentPacketIds.push(id); },
        scheduleCharacterSave(): void { /* test stub */ }
    };
    client.characters = [client.character];
    return client;
}

function playerEntity(client: any): any {
    return {
        id: client.clientEntID,
        isPlayer: true,
        team: EntityTeam.PLAYER,
        roomId: 4,
        x: 5_000,
        y: 5_000,
        hp: 1_000,
        maxHp: 1_000,
        dead: false,
        entState: EntityState.ACTIVE
    };
}

function bossEntity(id: number, name: string, hp: number, maxHp: number): any {
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
        maxHp,
        healthDelta: hp - maxHp,
        health_delta: hp - maxHp,
        dead: false,
        destroyed: false,
        entState: EntityState.ACTIVE,
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

function verifyRestoreIsPaced(
    displayName: string,
    levelName: string,
    bossName: string,
    startHp: number,
    maxHp: number,
    ordinal: number
): void {
    const client = createClient(74_001 + ordinal, levelName, `death-regen-${levelName}`);
    const boss = bossEntity(75_001 + ordinal, bossName, startHp, maxHp);
    const scope = seed(client, boss);
    const step = Math.max(1, Math.round(maxHp * REGEN_RATE));

    try {
        CombatHandler.notePlayerDeathState(client, 30_000);
        assert.equal(
            boss.hp,
            startHp + step,
            `${displayName}: the death tick did not restore exactly one step`
        );
        assert.ok(
            boss.hp < boss.maxHp,
            `${displayName}: the boss still snapped to full on the tick the player died`
        );

        // Halfway through the climb the bar must still be partial — this is the
        // assertion that fails again if the restore ever goes back to one jump.
        const ticksToFull = Math.ceil((maxHp - startHp) / step);
        const halfway = Math.max(1, Math.floor(ticksToFull / 2));
        for (let tick = 1; tick <= halfway; tick++) {
            CombatHandler.processOutOfCombatRegen(scope, 30_000 + tick * REGEN_INTERVAL_MS);
        }
        assert.equal(
            boss.hp,
            Math.min(maxHp, startHp + step * (halfway + 1)),
            `${displayName}: the restore did not advance one step per regen tick`
        );

        for (let tick = halfway + 1; tick <= ticksToFull + 1; tick++) {
            CombatHandler.processOutOfCombatRegen(scope, 30_000 + tick * REGEN_INTERVAL_MS);
        }
        assert.equal(
            boss.hp,
            boss.maxHp,
            `${displayName}: the boss never finished restoring while its killer stayed dead`
        );
        assert.equal(boss.dead, false, `${displayName}: the boss went terminal while restoring`);
    } finally {
        clear(client, scope);
    }
}

function verifyRestoreStopsWhenThePlayerIsBackUp(): void {
    const client = createClient(74_050, 'BT_Mission1', 'death-regen-revive');
    const boss = bossEntity(75_050, 'BanditTwinA', 200, 1_000);
    const scope = seed(client, boss);

    try {
        CombatHandler.notePlayerDeathState(client, 40_000);
        assert.equal(boss.hp, 250, 'the first restore step never landed');

        CombatHandler.processOutOfCombatRegen(scope, 41_000);
        assert.equal(boss.hp, 300, 'the restore did not continue while the player was down');

        // The player is back on their feet: the arm drops and the boss keeps the
        // health it has clawed back rather than continuing to full.
        CombatHandler.notePlayerActiveMovementState(client, 42_000, true);
        CombatHandler.processOutOfCombatRegen(scope, 43_000);
        CombatHandler.processOutOfCombatRegen(scope, 44_000);
        assert.equal(boss.hp, 300, 'the boss kept restoring after its killer came back up');
    } finally {
        clear(client, scope);
    }
}

function main(): void {
    LevelConfig.load(path.resolve(__dirname, '../data'));
    verifyRestoreIsPaced('Bandit Camp (Delexa)', 'BT_Mission1', 'BanditTwinB', 120, 1_000, 1);
    verifyRestoreIsPaced('Bandit Camp (Pelanda)', 'BT_Mission1', 'BanditTwinA', 640, 1_000, 2);
    verifyRestoreIsPaced('Svagg\'s Last Stand (Svagg)', 'BT_Mission2', 'BanditBoss', 80, 2_000, 3);
    verifyRestoreIsPaced('Svagg\'s Last Stand (Wrath)', 'BT_Mission2', 'GriffonStar', 1_500, 2_000, 4);
    verifyRestoreIsPaced('Dread Bandit Camp', 'BT_Mission1Hard', 'BanditTwinAHard', 300, 4_000, 5);
    verifyRestoreStopsWhenThePlayerIsBackUp();
    console.log('boss_death_regen_pacing_regression: ok');
}

main();
