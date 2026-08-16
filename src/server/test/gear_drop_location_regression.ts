/**
 * Regression test for issue #715 — "Change the drop location for Black Rose
 * Mire Devourers".
 *
 * The gear drop-location table lives in DungeonBlitz.swf (extracted by
 * GameData.loadGearDropLocationMaps): each realm+level gear set drops in
 * exactly one dungeon. The gear sheet had the Black Rose Mire Devourers
 * (realm "Devourer", level 8) dropping in The Great Green Svath
 * (SRN_Mission7); issue #715 moves them to Mystery of the Yornak
 * (SRN_Mission2). The Emerald Glade Devourers (realm "Devourer", level 19)
 * must stay in the Emerald Glades (EG_Mission2) — the issue explicitly warns
 * not to confuse the two.
 */
import { strict as assert } from 'assert';
import * as path from 'path';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('SRN_Mission2')) {
        LevelConfig.load(dataDir);
    }
    if (Object.keys(GameData.ENTTYPES).length === 0) {
        GameData.load(dataDir);
    }
}

function realmDropDungeons(): Record<string, Set<string>> {
    return (GameData as any).REALM_DROP_DUNGEON_BY_SOURCE_LEVEL as Record<string, Set<string>>;
}

function bossDropDungeons(): Record<string, string> {
    return (GameData as any).BOSS_DROP_DUNGEON_BY_SOURCE as Record<string, string>;
}

function testDevourer8DropsInYornak(): void {
    const dungeons = realmDropDungeons()['devourer8'];
    assert.ok(dungeons, 'realm drop map must contain a devourer8 entry');
    assert.ok(
        dungeons.has('srnmission2'),
        'Devourer (level 8) gear must drop in Mystery of the Yornak (SRN_Mission2)'
    );
    assert.ok(
        !dungeons.has('srnmission7'),
        'Devourer (level 8) gear must no longer drop in The Great Green Svath (SRN_Mission7)'
    );
    assert.equal(
        dungeons.size,
        1,
        'Devourer (level 8) gear must drop in exactly one dungeon'
    );
}

function testEmeraldGladeDevourersUnchanged(): void {
    const dungeons = realmDropDungeons()['devourer19'];
    assert.ok(dungeons, 'realm drop map must contain a devourer19 entry');
    assert.ok(
        dungeons.has('egmission2'),
        'Emerald Glade Devourers (level 19) must keep dropping in the Emerald Glades (EG_Mission2)'
    );
}

function testDevourerGreatBossUnchanged(): void {
    assert.equal(
        bossDropDungeons()['devourergreat'],
        'srnmission6',
        'DevourerGreat boss gear drop dungeon must stay SRN_Mission6'
    );
}

function testGearDropAllowedInYornakNotSvath(): void {
    const isAllowed = (GameData as any).isGearDropAllowedForSource as (
        gearId: number,
        context: { entName: string; realm: string; currentLevel?: string | null },
        source: string
    ) => boolean;

    // AxeDevourer8 (GearID 82) is realm Devourer, level 8.
    const context = (currentLevel: string) => ({
        entName: 'Devourer',
        realm: 'Devourer',
        currentLevel
    });

    assert.equal(
        isAllowed(82, context('SRN_Mission2'), 'realm'),
        true,
        'Devourer gear must drop in Mystery of the Yornak'
    );
    assert.equal(
        isAllowed(82, context('SRN_Mission7'), 'realm'),
        false,
        'Devourer gear must not drop in The Great Green Svath'
    );
}

async function main(): Promise<void> {
    ensureDataLoaded();
    testDevourer8DropsInYornak();
    testEmeraldGladeDevourersUnchanged();
    testDevourerGreatBossUnchanged();
    testGearDropAllowedInYornakNotSvath();
    console.log('gear_drop_location_regression: ok');
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
