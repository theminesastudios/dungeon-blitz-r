/**
 * Regression test for the aggro buff (issue #700).
 *
 * v1.11.0 halved the server AI aggro radii (240/360/180/260 -> 120/180/90/130),
 * which left server-driven enemies standing still until the player was almost on
 * top of them. Boss-melee aggro (90) ended up *below* melee attack range (95)
 * and ranged aggro (180) below ranged attack range (300), so a pulled enemy
 * swung in place instead of closing the gap.
 *
 * The radii are restored here, and this test locks in both the constants and the
 * wake-and-chase behaviour at distances the halved values could not reach: a
 * melee minion at 200px (halved 120 could not pull it), a ranged minion at 320px
 * (halved 180 could not), and a melee boss at 150px (halved 90 could not).
 */
import * as path from 'path';
import { AILogic } from '../core/AILogic';
import { CombatHandler } from '../handlers/CombatHandler';
import { EntityState, EntityTeam } from '../core/Entity';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';

const dataDir = path.resolve(__dirname, '..', 'data');
LevelConfig.load(dataDir);
GameData.load(dataDir);

function createPlayer(currentLevel: string, x: number, y = 0): any {
    return {
        token: 88_001,
        userId: 88_001,
        clientEntID: 88_101,
        playerSpawned: true,
        currentLevel,
        levelInstanceId: 'aggro-regression',
        currentRoomId: 4,
        authoritativeCurrentHp: 100,
        character: { name: 'AggroTarget', CurrentLevel: { name: currentLevel, x, y } },
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
        entState: EntityState.SLEEP,
        aiIdleAtHome: true,
        aggroTargetEntityId: 0,
        aggroTargetToken: 0,
        lastCombatActivityAt: 0,
        ...extras
    };
}

// A sleeping enemy at the origin is given one AI tick with a player standing
// `distance` px away in the same room. Returns the enemy so callers can assert
// whether it woke and started chasing.
function tickAtDistance(name: string, levelName: string, scope: string, distance: number, extras: Record<string, unknown> = {}): any {
    const player = createPlayer(levelName, distance);
    const npc = createNpc(name, extras);
    AILogic.updateNpc(npc, [player], scope);
    return npc;
}

const assertions: Array<[string, () => boolean]> = [
    [
        'melee aggro radius is restored to 240, not the halved 120',
        () => AILogic.MELEE_AGGRO_RADIUS === 240
    ],
    [
        'ranged aggro radius is restored to 360, not the halved 180',
        () => AILogic.RANGED_AGGRO_RADIUS === 360
    ],
    [
        'boss melee aggro radius is restored to 180, not the halved 90',
        () => AILogic.BOSS_MELEE_AGGRO_RADIUS === 180
    ],
    [
        'boss ranged aggro radius is restored to 260, not the halved 130',
        () => AILogic.BOSS_RANGED_AGGRO_RADIUS === 260
    ],
    [
        'server boss radii stay aligned with CombatHandler (melee)',
        () => AILogic.BOSS_MELEE_AGGRO_RADIUS === (CombatHandler as any).BOSS_MELEE_AGGRO_RADIUS
    ],
    [
        'server boss radii stay aligned with CombatHandler (ranged)',
        () => AILogic.BOSS_RANGED_AGGRO_RADIUS === (CombatHandler as any).BOSS_RANGED_AGGRO_RADIUS
    ],
    [
        'melee aggro exceeds melee attack range so enemies close the gap before swinging',
        () => AILogic.MELEE_AGGRO_RADIUS > AILogic.ATTACK_RANGE
    ],
    [
        'ranged aggro exceeds ranged attack range so ranged enemies engage from range',
        () => AILogic.RANGED_AGGRO_RADIUS > AILogic.RANGED_ATTACK_RANGE
    ],
    [
        'a melee minion wakes and chases a player 200px away (halved 120 could not pull)',
        () => {
            const npc = tickAtDistance('GoblinBrute', 'OMM_Mission2', 'OMM_Mission2#aggro-regression', 200);
            return npc.entState === EntityState.ACTIVE && npc.x > 0;
        }
    ],
    [
        'a ranged minion wakes and chases a player 320px away (halved 180 could not pull)',
        () => {
            const npc = tickAtDistance('Ghoul', 'JC_Mini2', 'JC_Mini2#aggro-regression', 320);
            return npc.entState === EntityState.ACTIVE && npc.x > 0;
        }
    ],
    [
        'a melee boss wakes and chases a player 150px away (halved 90 could not pull)',
        () => {
            const npc = tickAtDistance('CyclopsChieftain', 'OMM_Mission3', 'OMM_Mission3#aggro-regression', 150);
            return npc.entState === EntityState.ACTIVE && npc.x > 0;
        }
    ]
];

let failed = 0;
for (const [name, check] of assertions) {
    if (!check()) {
        failed += 1;
        console.error(`FAIL: ${name}`);
    } else {
        console.log(`ok: ${name}`);
    }
}

if (failed > 0) {
    console.error(`${failed}/${assertions.length} aggro radius assertions failed`);
    process.exit(1);
}
console.log(`[regression] aggro radii: ${assertions.length} assertions passed`);
