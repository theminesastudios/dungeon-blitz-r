/// <reference types="node" />

import './helpers/disable_production_mongo';
import { strict as assert } from 'assert';
import * as path from 'path';
import { CharacterTemplates } from '../core/CharacterTemplates';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';
import { BuildingID } from '../core/Enums';
import { MissionID } from '../data/runtime';
import { WorldEnter } from '../utils/WorldEnter';
import { buildFreshCharacter, buildMaxedCharacter } from '../tools/seedTestAccount';

/*
 * The seeded playtest characters have to survive being serialized, because a character
 * that cannot be written is a character nobody can log into.
 *
 * Almost every field in the player-data packet is self-describing (writeMethod4) or
 * 0-bit terminated, so it tolerates any size. Three length fields are not: gearSets is
 * written with 4 bits, inventoryGears with 11, learnedAbilities with 7. Overflow one and
 * the count silently wraps -- the server keeps emitting entries the client never reads,
 * every later field misaligns, and the client dies somewhere unrelated. Building the real
 * packet is the only check that catches it.
 */

const CLASSES = ['Mage', 'Paladin', 'Rogue'];
const MAX_GEAR_SETS = 10;
const MAX_INVENTORY_GEARS = 2047;
const MAX_LEARNED_ABILITIES = 127;

function buildPacket(character: any): Buffer {
    // sendExtended is the full record -- the variant that carries every collection.
    return WorldEnter.buildPlayerDataPacket(character, 1, 0, 0, 'CraftTown', 0, 0, false, true).toBuffer();
}

function testMaxedCharactersSerialize(): void {
    for (const className of CLASSES) {
        const character: any = buildMaxedCharacter(className, `Max${className}`);

        assert.equal(character.level, 50, `${className}: level cap`);
        assert.equal(character.xp, GameData.PLAYER_XP_THRESHOLDS[50], `${className}: xp must sit on the cap`);
        assert.equal(
            Object.keys(character.missions).length,
            MissionID.ACTales6Embassy,
            `${className}: every mission claimed`
        );
        assert.equal(character.learnedAbilities.length, 39, `${className}: 9 base + 30 masterclass abilities`);
        assert.equal(character.activeAbilities.length, 3, `${className}: exactly three active slots`);

        // The ceilings that corrupt the packet rather than merely being wrong.
        assert.ok(
            (character.gearSets ?? []).length <= MAX_GEAR_SETS,
            `${className}: gearSets length is written with 4 bits`
        );
        assert.ok(
            character.inventoryGears.length <= MAX_INVENTORY_GEARS,
            `${className}: inventoryGears length is written with 11 bits`
        );
        assert.ok(
            character.learnedAbilities.length <= MAX_LEARNED_ABILITIES,
            `${className}: learnedAbilities length is written with 7 bits`
        );

        // Equipping is validated against ownership on login, so the worn set must also be
        // in the inventory or the character logs in naked.
        const ownedGearIds = new Set(character.inventoryGears.map((gear: any) => Number(gear.gearID)));
        for (const equipped of character.equippedGears) {
            assert.ok(
                ownedGearIds.has(Number(equipped.gearID)),
                `${className}: equipped gear ${equipped.gearID} must also be owned`
            );
        }

        // The Keep has no upgrade rows and is force-zeroed by the writer anyway; seeding it
        // non-zero would just be a lie in the save file.
        assert.equal(
            Number(character.magicForge.stats_by_building[String(BuildingID.Keep)] ?? 0),
            0,
            `${className}: the Keep has no ranks`
        );

        const packet = buildPacket(character);
        assert.ok(packet.length > 0, `${className}: maxed character must serialize`);
    }
}

function testFreshCharactersSerialize(): void {
    for (const className of CLASSES) {
        const character: any = buildFreshCharacter(className, `New${className}`);

        assert.equal(character.level, 1, `${className}: fresh character is level 1`);
        assert.equal(Number(character.xp ?? 0), 0, `${className}: and 0 xp`);
        assert.equal(Number(character.gold ?? 0), 0, `${className}: and 0 gold`);
        assert.equal(Number(character.mammothIdols ?? 0), 0, `${className}: and 0 idols`);

        const packet = buildPacket(character);
        assert.ok(packet.length > 0, `${className}: fresh character must serialize`);
    }
}

// A maxed character carries far more than a fresh one; if they serialize to the same size
// the builder silently did nothing.
function testMaxedCarriesMoreThanFresh(): void {
    const maxed = buildPacket(buildMaxedCharacter('Mage', 'MaxMage'));
    const fresh = buildPacket(buildFreshCharacter('Mage', 'NewMage'));
    assert.ok(
        maxed.length > fresh.length * 2,
        `a maxed character should dwarf a fresh one, got ${maxed.length} vs ${fresh.length} bytes`
    );
}

function main(): void {
    const dataDir = path.resolve(__dirname, '../data');
    LevelConfig.load(dataDir);
    GameData.load(dataDir);
    CharacterTemplates.load(dataDir);

    testMaxedCharactersSerialize();
    testFreshCharactersSerialize();
    testMaxedCarriesMoreThanFresh();
    console.log('test_account_seed_regression: ok');
}

main();
