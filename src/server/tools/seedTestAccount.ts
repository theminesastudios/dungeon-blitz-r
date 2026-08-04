/// <reference types="node" />

/**
 * Seeds the local-only playtest account: test@theminesa.studio with six characters,
 * one maxed and one brand new for each of the three classes.
 *
 * Local only, deliberately. It writes a known password and a character with every
 * unlock in the game, which is a gift to anyone who can reach it -- so it refuses to
 * run against a multiplayer server rather than trusting whoever typed the command.
 *
 *   npm run seed:test-account
 *   TEST_ACCOUNT_PASSWORD=something npm run seed:test-account
 */

import * as path from 'path';
import { Config } from '../core/config';
import { CharacterTemplates } from '../core/CharacterTemplates';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { BuildingID, MasterClassID } from '../core/Enums';
import { JsonAdapter } from '../database/JsonAdapter';
import { Character } from '../database/Database';
import { hashPlaintextPasswordForClient } from '../auth/PasswordAuth';

export const TEST_ACCOUNT_EMAIL = 'test@theminesa.studio';
const DEFAULT_PASSWORD = 'testtest';

// PLAYER_XP_THRESHOLDS[51] is 4294967295, the uint32 sentinel that makes level 51
// unreachable, so 50 is the real cap and index 50 is the XP that sits exactly on it.
// (CombatHandler.PLAYER_HITPOINTS runs to 55, but those rows are dead.)
const MAX_LEVEL = 50;

// MissionHandler.MISSION_CLAIMED -- turned in and rewarded, not merely completed.
const MISSION_CLAIMED = 3;

// Every upgradeable building maxes at 10 in BuildingTypes.json, and both
// ForgeHandler.getAuthoritativeForgeRank and AbilityHandler.getAuthoritativeTomeRank
// clamp there. The Keep is the exception: it has no upgrade rows at all, and
// WorldEnter.sanitizeBuildingStatsForClient force-zeroes it on every write, so leaving
// it at 0 is what the client will see regardless.
const MAX_BUILDING_RANK = 10;
const CLASS_TOWERS: Record<string, BuildingID[]> = {
    Mage: [BuildingID.FrostwardenTower, BuildingID.FlameseerTower, BuildingID.NecromancerTower],
    Paladin: [BuildingID.JusticarTower, BuildingID.SentinelTower, BuildingID.TemplarTower],
    Rogue: [BuildingID.ExecutionerTower, BuildingID.ShadowwalkerTower, BuildingID.SoulthiefTower]
};

// One masterclass per character; WorldEnter.resolveMasterClass would otherwise infer it
// from the highest-ranked tower, and all three are maxed here.
const CLASS_MASTERCLASS: Record<string, MasterClassID> = {
    Mage: MasterClassID.Frostwarden,
    Paladin: MasterClassID.Justicar,
    Rogue: MasterClassID.Executioner
};

// The level-30 unique lockbox set, in equippedGears slot order:
// [0] Armor, [1] Gloves, [2] Boots, [3] Hat, [4] Weapon, [5] Off-hand
// (EquipmentHandler.SLOT_TO_GEAR_INDEX). Source ids: LockboxHandler.CLASS_GEAR_IDS.
const CLASS_EQUIPPED_GEAR: Record<string, number[]> = {
    Mage: [1168, 1169, 1170, 1167, 1165, 1166],
    Paladin: [1180, 1181, 1182, 1179, 1177, 1178],
    Rogue: [1174, 1175, 1176, 1173, 1171, 1172]
};

// TalentHandler.MAX_TALENT_POINTS_PER_CLASS, across the three trees.
const MAX_TALENT_POINTS = 50;
// craftTalentPoints is five 4-bit values packed into one uint20, so 15 is the ceiling;
// 10 is what the shipped maxed character uses.
const MAX_CRAFT_TALENT_POINTS = [10, 10, 10, 10, 10];
// GearInventory.normalizeTier snaps anything at or above 2 down to 2.
const MAX_GEAR_TIER = 2;
// WorldEnter writes gearSets.length with 4 bits. At 16 it writes 0 and the client reads no
// sets while the server keeps emitting them -- every later field misaligns and the client
// dies. The patched client only draws 10 rows, so that is the real ceiling and
// GearSetHandler.MAX_GEAR_SETS agrees.
const MAX_GEAR_SETS = 10;

// The master classes each base class can become, so a maxed character learns their
// abilities too. AbilityTypes.json tags each ability with the specialisation that owns it.
const CLASS_SPECIALISATIONS: Record<string, string[]> = {
    Mage: ['Mage', 'Frostwarden', 'Flameseer', 'Necromancer'],
    Paladin: ['Paladin', 'Justicar', 'Sentinel', 'Templar'],
    Rogue: ['Rogue', 'Executioner', 'ShadowWalker', 'Soulthief']
};

// Comfortably inside writeMethod4's 32-bit ceiling, and obviously synthetic at a glance
// so nobody mistakes a seeded character for a real one.
const MAXED_CURRENCIES = {
    gold: 999_999_999,
    mammothIdols: 99_999,
    DragonOre: 99_999,
    DragonKeys: 9_999,
    SilverSigils: 9_999
};

function readJson<T>(relativePath: string): T {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(path.join(Config.DATA_DIR, 'data', relativePath)) as T;
}

function asArray(value: unknown): any[] {
    return Array.isArray(value) ? value : Object.values(value ?? {});
}

function buildCompletedMissions(): Record<string, Record<string, number>> {
    const missions: Record<string, Record<string, number>> = {};
    for (const mission of asArray(readJson('MissionTypes.json'))) {
        const missionId = Math.round(Number(mission?.MissionID ?? 0));
        if (missionId <= 0) {
            continue;
        }

        // MissionHandler.setMissionState writes claimed/complete alongside the state once
        // a mission is turned in; without them the client shows a claimable reward it has
        // already been paid for.
        const entry: Record<string, number> = {
            state: MISSION_CLAIMED,
            currCount: Math.max(1, Math.round(Number(mission?.CompleteCount ?? 1))),
            claimed: 1,
            complete: 1
        };

        // Dungeon missions carry a best-run record. Tier is the star rating, clamped to 10
        // server-side and written with 4 bits.
        if (String(mission?.Dungeon ?? '').trim() || String(mission?.Timed ?? '').trim()) {
            entry.Tier = 10;
            entry.highscore = 200_000;
            entry.Time = Math.floor(Date.now() / 1000);
        }

        missions[String(missionId)] = entry;
    }
    return missions;
}

function buildLearnedAbilities(className: string): Array<{ abilityID: number; rank: number }> {
    const owned = new Set(
        (CLASS_SPECIALISATIONS[className] ?? [className]).map((name) => name.toLowerCase())
    );
    // AbilityTypes.json stores one row per rank, so the highest row per id is its max rank.
    const bestRankById = new Map<number, number>();
    for (const ability of asArray(readJson('AbilityTypes.json'))) {
        const owner = String(ability?.Class ?? ability?.BaseClass ?? '').trim().toLowerCase();
        if (owner !== 'any' && !owned.has(owner)) {
            continue;
        }
        const abilityId = Math.round(Number(ability?.AbilityID ?? 0));
        const rank = Math.round(Number(ability?.Rank ?? 0));
        if (abilityId <= 0 || rank <= 0) {
            continue;
        }
        bestRankById.set(abilityId, Math.max(bestRankById.get(abilityId) ?? 0, rank));
    }

    return [...bestRankById.entries()]
        .sort(([left], [right]) => left - right)
        .map(([abilityID, rank]) => ({ abilityID, rank }));
}

// The per-class gear id lists are generated enums, disjoint and 394 ids each.
function loadClassGearIds(className: string): number[] {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const module = require(`../data/runtime/${className}Gear`);
    const gearEnum = module[`${className}Gear`] ?? {};
    return [...new Set(
        Object.values(gearEnum)
            .map((value) => Math.round(Number(value)))
            .filter((value) => Number.isFinite(value) && value > 0)
    )].sort((a, b) => a - b);
}

function buildOwnedCollections(): Partial<Character> {
    const mounts = Object.values(GameData.MOUNT_IDS ?? {})
        .map((id) => Math.round(Number(id)))
        .filter((id) => id > 0);

    // PetHandler dedupes on `${typeID}:${special_id}` and caps pet level at 20.
    const pets = asArray(readJson('pet_types.json'))
        .map((pet: any) => Math.round(Number(pet?.PetID ?? pet?.petID ?? pet?.id ?? 0)))
        .filter((id) => id > 0);

    return {
        mounts: [...new Set(mounts)].sort((a, b) => a - b),
        pets: [...new Set(pets)]
            .sort((a, b) => a - b)
            .map((typeID) => ({ typeID, special_id: 1, level: 20, xp: 0 })),
        OwnedDyes: GameData.DYES.map((dye) => Math.round(Number(dye.id))).filter((id) => id > 0),
        charms: GameData.CHARMS
            .map((charm: any) => Math.round(Number(charm?.CharmID ?? 0)))
            .filter((id) => id > 0)
            .map((charmID) => ({ charmID, count: 99 })),
        materials: GameData.MATERIALS
            .map((material: any) => Math.round(Number(material?.MaterialID ?? 0)))
            .filter((id) => id > 0)
            .map((materialID) => ({ materialID, count: 999 })),
        consumables: GameData.CONSUMABLES
            .map((consumable: any) => Math.round(Number(consumable?.ConsumableID ?? 0)))
            .filter((id) => id > 0)
            .map((consumableID) => ({ consumableID, count: 99 }))
    };
}

export function buildMaxedCharacter(className: string, name: string): Character {
    const character = CharacterTemplates.get(className);
    if (!character) {
        throw new Error(`No character template for ${className}. Run from src/server so DATA_DIR resolves.`);
    }

    character.name = name;
    character.level = MAX_LEVEL;
    character.xp = GameData.PLAYER_XP_THRESHOLDS[MAX_LEVEL];
    Object.assign(character, MAXED_CURRENCIES, buildOwnedCollections());

    character.craftXP = 159_948; // ForgeHandler.FORGE_XP_CAP
    character.missions = buildCompletedMissions();
    character.questTrackerState = 100;
    character.learnedAbilities = buildLearnedAbilities(className);
    // Exactly three slots -- AbilityHandler.getActiveAbilities and the packet writer both
    // hard-truncate there, and anything not in learnedAbilities gets dropped on login.
    character.activeAbilities = character.learnedAbilities
        .slice(0, 3)
        .map((ability: { abilityID: number }) => ability.abilityID);

    character.MasterClass = CLASS_MASTERCLASS[className] ?? 0;
    character.talentPoints = { '1': MAX_TALENT_POINTS, '2': MAX_TALENT_POINTS, '3': MAX_TALENT_POINTS };
    character.craftTalentPoints = [...MAX_CRAFT_TALENT_POINTS];
    character.alertState = 15;

    const buildings: Record<string, number> = {
        [BuildingID.Tome]: MAX_BUILDING_RANK,
        [BuildingID.Forge]: MAX_BUILDING_RANK,
        [BuildingID.Keep]: 0,
        [BuildingID.Barn]: MAX_BUILDING_RANK
    };
    for (const tower of CLASS_TOWERS[className] ?? []) {
        buildings[String(tower)] = MAX_BUILDING_RANK;
    }
    character.magicForge = { ...character.magicForge, stats_by_building: buildings };

    // Own every piece of gear this class can wear, and wear the level-30 unique set.
    // EquipmentHandler rejects equipping anything absent from inventoryGears, so the
    // equipped ids have to appear in both.
    const classGearIds = loadClassGearIds(className);
    character.inventoryGears = classGearIds.map((gearID) => ({
        gearID,
        tier: MAX_GEAR_TIER,
        runes: [0, 0, 0],
        colors: [0, 0]
    }));
    character.equippedGears = (CLASS_EQUIPPED_GEAR[className] ?? []).map((gearID) => ({
        gearID,
        tier: MAX_GEAR_TIER,
        runes: [0, 0, 0],
        colors: [1, 1]
    }));

    // Never let a template ship more sets than the 3-bit length field can describe.
    const gearSets = Array.isArray(character.gearSets) ? character.gearSets : [];
    character.gearSets = gearSets.slice(0, MAX_GEAR_SETS);

    // Start them somewhere with an authored spawn rather than wherever the template left
    // off, so a seeded character never lands on a coordinate the level cannot hold.
    const spawn = LevelConfig.getSpawn('CraftTown');
    character.CurrentLevel = { name: 'CraftTown', x: spawn.x, y: spawn.y };
    character.PreviousLevel = { name: 'NewbieRoad', ...LevelConfig.getSpawn('NewbieRoad') };

    return character as Character;
}

export function buildFreshCharacter(className: string, name: string): Character {
    // The class templates are already a level 1 character with 0 of everything, which is
    // exactly the second half of the pair. Only the name needs setting.
    const character = CharacterTemplates.get(className);
    if (!character) {
        throw new Error(`No character template for ${className}.`);
    }
    character.name = name;
    return character as Character;
}

async function main(): Promise<void> {
    if (Config.MULTIPLAYER_MODE) {
        console.error('[seed-test-account] Refusing to run: MULTIPLAYER_MODE is on.');
        console.error('[seed-test-account] This seeds a known password and a fully-unlocked character; it is for local play only.');
        process.exitCode = 1;
        return;
    }

    const password = process.env.TEST_ACCOUNT_PASSWORD || DEFAULT_PASSWORD;
    const dataDir = path.join(Config.DATA_DIR, 'data');
    LevelConfig.load(dataDir);
    GameData.load(dataDir);
    CharacterTemplates.load(dataDir);

    const db = new JsonAdapter();
    const passwordRecord = await hashPlaintextPasswordForClient(password);

    let account = await db.getAccount(TEST_ACCOUNT_EMAIL);
    if (account) {
        await db.updateAccountPassword(TEST_ACCOUNT_EMAIL, passwordRecord);
        console.log(`[seed-test-account] Reusing account ${TEST_ACCOUNT_EMAIL} (user_id ${account.user_id}); password reset.`);
    } else {
        account = await db.createAccount(TEST_ACCOUNT_EMAIL, passwordRecord);
        console.log(`[seed-test-account] Created account ${TEST_ACCOUNT_EMAIL} (user_id ${account.user_id}).`);
    }

    const characters: Character[] = [];
    for (const className of ['Mage', 'Paladin', 'Rogue']) {
        characters.push(buildMaxedCharacter(className, `Max${className}`));
        characters.push(buildFreshCharacter(className, `New${className}`));
    }

    await db.saveCharacters(account.user_id, characters);

    console.log(`[seed-test-account] Wrote ${characters.length} characters:`);
    for (const character of characters) {
        console.log(
            `  ${String(character.name).padEnd(12)} ${String(character.class).padEnd(8)} ` +
            `level ${String(character.level).padStart(2)}  ` +
            `${Object.keys(character.missions ?? {}).length} missions  ` +
            `${(character.learnedAbilities ?? []).length} abilities`
        );
    }
    console.log(`[seed-test-account] Log in as ${TEST_ACCOUNT_EMAIL} with the password you seeded.`);
}

// Only when run as a command. The character builders are imported by the regression
// test, and importing them must not write an account to disk as a side effect.
if (require.main === module) {
    void main().catch((err) => {
        console.error('[seed-test-account] Failed:', err);
        process.exitCode = 1;
    });
}
