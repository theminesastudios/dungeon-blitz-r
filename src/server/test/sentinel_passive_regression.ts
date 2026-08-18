/**
 * Regression test for the Sentinel passive (issue #726).
 *
 * The passive -- "your melee attacks also strike for 0.3% of your maximum Health
 * and 30% of your Defense" -- is applied server-side on every melee hit
 * (CombatHandler.getSentinelMaxHpBonus). The Defense term reads the player's
 * declared armorClass from packet 0xFC, which is exactly the channel Defense
 * charms act through: the client folds each charm's ArmorBonus into Entity.armorClass,
 * sends it, and the server turns 30% of it into bonus damage.
 *
 * This test locks in that chain so a future change cannot silently detach the
 * passive from Defense again: the rates, the melee power list, the class gate,
 * the old-client zero-Defense fallback, and the specific numbers a Defense charm
 * must produce (an Onyx10's +28 Defense is 30% of 28 = +8 damage on the armor term).
 *
 * The display twin of this test is the client patch
 * patch-dungeonblitz-sentinel-passive-display.ts, which shows the same bonus in
 * the damage floaters; the rates here and the helper there must agree.
 */
import * as path from 'path';
import * as fs from 'fs';
import { CombatHandler } from '../handlers/CombatHandler';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { MasterClassID } from '../core/Enums';

const dataDir = path.resolve(__dirname, '..', 'data');
LevelConfig.load(dataDir);
GameData.load(dataDir);

const XML = path.resolve(__dirname, '..', '..', 'client', 'content', 'xml', 'PlayerPowerTypes.xml');

function powerIdByName(name: string): number {
    const block = fs.readFileSync(XML, 'utf8').match(new RegExp(`<Power PowerName="${name}">[\\s\\S]*?<\\/Power>`));
    const id = Number(block?.[0]?.match(/<PowerID>([^<]*)<\/PowerID>/)?.[1] ?? NaN);
    if (!Number.isFinite(id) || id <= 0) {
        throw new Error(`PlayerPowerTypes.xml has no PowerID for ${name}`);
    }
    return id;
}

const SF_MELEE_ID = powerIdByName('SFMelee1');
const SF_COMBO_ID = powerIdByName('SFMeleeCombo1');
const SWORD_MELEE_ID = powerIdByName('SwordMelee');
const PUNCH_MELEE_ID = powerIdByName('PunchMelee');
const SF_RANGED_ID = powerIdByName('SFRanged1');

// The level-50 Paladin reference numbers the passive was tuned against.
const MAX_HP = 122_000;
const BASE_ARMOR = 1_680;
const ONYX10_ARMOR_BONUS = 28;

function sentinelSession(armorClass: number, masterClass: number = MasterClassID.Sentinel): any {
    return {
        character: { MasterClass: masterClass, CurrentLevel: { name: 'AC_Mission1', x: 0, y: 0 } },
        authoritativeMaxHp: MAX_HP,
        authoritativeArmorClass: armorClass
    };
}

const getBonus = (session: any, powerId: number, damage: number): number =>
    (CombatHandler as any).getSentinelMaxHpBonus(session, powerId, damage) as number;

const meleePowerIds: Set<number> = (CombatHandler as any).getSentinelMeleePowerIds();

const assertions: Array<[string, () => boolean]> = [
    [
        'the max HP rate is 0.3%',
        () => (CombatHandler as any).SENTINEL_MAX_HP_RATE === 0.003
    ],
    [
        'the Defense rate is 30%',
        () => (CombatHandler as any).SENTINEL_ARMOR_RATE === 0.3
    ],
    [
        'the melee power set resolves from PlayerPowerTypes.xml',
        () => meleePowerIds.size > 0
    ],
    [
        'Sentinel Form melee (SFMelee) is covered',
        () => meleePowerIds.has(SF_MELEE_ID)
    ],
    [
        'Sentinel Form combo (SFMeleeCombo) is covered',
        () => meleePowerIds.has(SF_COMBO_ID)
    ],
    [
        'the weapon melee swing (SwordMelee) is covered',
        () => meleePowerIds.has(SWORD_MELEE_ID)
    ],
    [
        'the unarmed swing (PunchMelee) is covered',
        () => meleePowerIds.has(PUNCH_MELEE_ID)
    ],
    [
        'the Sentinel ranged attack (SFRanged) is not covered',
        () => !meleePowerIds.has(SF_RANGED_ID)
    ],
    [
        'the passive hits for 0.3% of max HP plus 30% of Defense',
        () => getBonus(sentinelSession(BASE_ARMOR), SF_MELEE_ID, 5_264)
            === Math.round(0.003 * MAX_HP) + Math.round(0.3 * BASE_ARMOR)
    ],
    [
        'an Onyx10 Defense charm (+28 Defense) adds 30% of 28 to the armor term',
        () => {
            const without = getBonus(sentinelSession(BASE_ARMOR), SF_MELEE_ID, 5_264);
            const withCharm = getBonus(sentinelSession(BASE_ARMOR + ONYX10_ARMOR_BONUS), SF_MELEE_ID, 5_264);
            return withCharm - without === Math.round(0.3 * ONYX10_ARMOR_BONUS);
        }
    ],
    [
        'Defense scales the passive point for point at 30%',
        () => {
            const low = getBonus(sentinelSession(1_000), SF_MELEE_ID, 5_264);
            const high = getBonus(sentinelSession(1_100), SF_MELEE_ID, 5_264);
            return high - low === Math.round(0.3 * 100);
        }
    ],
    [
        'a Justicar gets nothing from the same melee swing',
        () => getBonus(sentinelSession(BASE_ARMOR, MasterClassID.Justicar), SWORD_MELEE_ID, 5_264) === 0
    ],
    [
        'a Templar gets nothing from the same melee swing',
        () => getBonus(sentinelSession(BASE_ARMOR, MasterClassID.Templar), SWORD_MELEE_ID, 5_264) === 0
    ],
    [
        'a Sentinel ranged bolt gets no melee passive',
        () => getBonus(sentinelSession(BASE_ARMOR), SF_RANGED_ID, 5_264) === 0
    ],
    [
        'a zero declared Defense (old client) keeps the max HP half only',
        () => getBonus(sentinelSession(0), SF_MELEE_ID, 5_264) === Math.round(0.003 * MAX_HP)
    ],
    [
        'a non-damaging hit gets no passive',
        () => getBonus(sentinelSession(BASE_ARMOR), SF_MELEE_ID, 0) === 0
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
    console.error(`${failed}/${assertions.length} sentinel passive assertions failed`);
    process.exit(1);
}
console.log(`[regression] sentinel passive: ${assertions.length} assertions passed`);
