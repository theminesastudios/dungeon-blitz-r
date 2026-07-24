import { strict as assert } from 'assert';
import * as path from 'path';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { GlobalState } from '../core/GlobalState';
import { LevelConfig } from '../core/LevelConfig';
import { getClientLevelScope } from '../core/LevelScope';
import { CombatHandler } from '../handlers/CombatHandler';

// A Dread run reuses the normal dungeon's SWF and the normal EntTypes entry:
// `SwampKingHard` carries the same Level and HitPoints as `SwampKing`. The extra
// difficulty lives in the level, whose mapId sits a fixed number of tiers above
// the normal level's baseId. The server used to size hostiles from the EntType
// level alone, so it modelled every Dread boss with its normal-mode health pool
// and declared it dead once the party had dealt normal-mode damage — the run
// ended with the boss still visibly alive, and the "defeated" boss never
// regenerated after a player death.
const HOSTILE_BASE_HITPOINTS = [
    100, 4920, 5580, 6020, 6520, 7040, 7580, 8180, 8800, 9480, 10180, 10960, 11740, 12640, 13540, 14540,
    15560, 16660, 17860, 19120, 20440, 21860, 23360, 24960, 26680, 28460, 30380, 32420, 34580, 36900, 39320,
    41920, 44660, 47560, 50660, 53940, 57420, 61080, 64980, 69120, 73520, 78160, 83100, 88300, 93820, 99700,
    105880, 112460, 119400, 126760, 134560
] as const;

function expectedMaxHp(bossName: string, levelName: string): number {
    const entType = GameData.getEntType(bossName) ?? {};
    const entLevel = Math.round(Number(entType.Level));
    const hitPointScale = Number(entType.HitPoints);
    const tier = entLevel + LevelConfig.getHardDungeonEnemyLevelOffset(levelName);
    return Math.round(HOSTILE_BASE_HITPOINTS[tier] * hitPointScale);
}

function createClient(token: number, levelName: string): any {
    const client: any = {
        token,
        userId: token,
        currentLevel: levelName,
        levelInstanceId: `dread-scaling-${levelName}`,
        currentRoomId: 4,
        playerSpawned: true,
        clientEntID: token,
        character: {
            name: `DreadScaling${token}`,
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
        send(): void { /* test stub */ },
        sendBitBuffer(): void { /* test stub */ },
        scheduleCharacterSave(): void { /* test stub */ }
    };
    client.characters = [client.character];
    return client;
}

// A boss the client has spawned but whose max HP the server has not been told:
// exactly the case where the server has to derive the pool itself.
function bossWithoutExplicitMaxHp(id: number, name: string, hp: number): any {
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
        dead: false,
        destroyed: false,
        entState: EntityState.ACTIVE,
        lastCombatActivityAt: 1,
        lastCombatRegenTickAt: 0
    };
}

function resolveServerMaxHp(levelName: string, bossName: string, token: number): number {
    const client = createClient(token, levelName);
    const scope = getClientLevelScope(client);
    const boss = bossWithoutExplicitMaxHp(token + 500, bossName, 1_000);

    client.entities.set(client.clientEntID, {
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
    });
    client.entities.set(boss.id, boss);
    GlobalState.levelEntities.set(scope, new Map([[boss.id, boss]]));
    GlobalState.sessionsByToken.set(client.token, client);

    try {
        // The death-regen tick is the cheapest public path that makes the server
        // commit to a max HP for a hostile it has to size itself.
        CombatHandler.notePlayerDeathState(client, 30_000);
        return Math.round(Number(boss.maxHp ?? 0));
    } finally {
        GlobalState.sessionsByToken.delete(client.token);
        GlobalState.levelEntities.delete(scope);
    }
}

function testDreadLevelsRaiseTheEnemyTier(): void {
    // The three authored Dread jumps: Wolf's End +35, Black Rose Mire +25 and
    // every other region +15.
    assert.equal(LevelConfig.getHardDungeonEnemyLevelOffset('TutorialDungeonHard'), 35);
    assert.equal(LevelConfig.getHardDungeonEnemyLevelOffset('GhostBossDungeonHard'), 35);
    assert.equal(LevelConfig.getHardDungeonEnemyLevelOffset('SRN_Mission2Hard'), 25);
    assert.equal(LevelConfig.getHardDungeonEnemyLevelOffset('BT_Mission1Hard'), 15);
    assert.equal(LevelConfig.getHardDungeonEnemyLevelOffset('OMM_Mission12Hard'), 15);

    // Normal dungeons and overworld levels must keep sizing hostiles exactly as
    // before, so the offset has to stay zero for everything that is not a Dread
    // dungeon.
    assert.equal(LevelConfig.getHardDungeonEnemyLevelOffset('SRN_Mission2'), 0);
    assert.equal(LevelConfig.getHardDungeonEnemyLevelOffset('BT_Mission1'), 0);
    assert.equal(LevelConfig.getHardDungeonEnemyLevelOffset('NewbieRoadHard'), 0);
    assert.equal(LevelConfig.getHardDungeonEnemyLevelOffset('NR_Tales1Keep'), 0);
    assert.equal(LevelConfig.getHardDungeonEnemyLevelOffset(''), 0);
}

function testDreadBossIsSizedAtItsDreadTier(): void {
    const cases: Array<{ display: string; level: string; boss: string; token: number }> = [
        { display: 'Dread Mystery of the Yornak', level: 'SRN_Mission2Hard', boss: 'SwampKingHard', token: 81_001 },
        { display: 'Dread Goblin Kidnappers', level: 'TutorialDungeonHard', boss: 'GoblinBoss1Hard', token: 81_002 },
        { display: 'Dread Death to Meylour', level: 'OMM_Mission12Hard', boss: 'MagmaCyclopsBossHard', token: 81_003 }
    ];

    for (const testCase of cases) {
        const serverMaxHp = resolveServerMaxHp(testCase.level, testCase.boss, testCase.token);
        assert.equal(
            serverMaxHp,
            expectedMaxHp(testCase.boss, testCase.level),
            `${testCase.display}: the server did not size the boss at its Dread tier`
        );

        const normalMaxHp = HOSTILE_BASE_HITPOINTS[Math.round(Number(GameData.getEntType(testCase.boss)?.Level))] *
            Number(GameData.getEntType(testCase.boss)?.HitPoints);
        assert.ok(
            serverMaxHp > normalMaxHp,
            `${testCase.display}: the Dread boss still has its normal-mode health pool, so the run ends early`
        );
    }
}

function testNormalBossKeepsItsAuthoredHealth(): void {
    const serverMaxHp = resolveServerMaxHp('SRN_Mission2', 'SwampKing', 81_101);
    assert.equal(
        serverMaxHp,
        expectedMaxHp('SwampKing', 'SRN_Mission2'),
        'a normal-mode boss must keep the health pool it always had'
    );
}

function main(): void {
    LevelConfig.load(path.resolve(__dirname, '../data'));
    GameData.load(path.resolve(__dirname, '../data'));
    testDreadLevelsRaiseTheEnemyTier();
    testDreadBossIsSizedAtItsDreadTier();
    testNormalBossKeepsItsAuthoredHealth();
    console.log('dread_hostile_health_scaling_regression: ok');
}

main();
