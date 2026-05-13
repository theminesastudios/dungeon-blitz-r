import { strict as assert } from 'assert';
import * as path from 'path';
import { GameData } from '../core/GameData';
import { LevelConfig } from '../core/LevelConfig';

function allDropGearIds(): number[] {
    const ids = new Set<number>();
    for (const dropIds of Object.values(GameData.GEAR_DATA.realm_drops)) {
        for (const gearId of dropIds) {
            ids.add(gearId);
        }
    }
    for (const dropIds of Object.values(GameData.GEAR_DATA.boss_drops)) {
        for (const gearId of dropIds) {
            ids.add(gearId);
        }
    }
    for (const gearId of GameData.GEAR_DATA.global_drops) {
        ids.add(gearId);
    }
    return Array.from(ids.values());
}

function excludedGearIdsExcept(...allowedGearIds: number[]): number[] {
    const allowed = new Set(allowedGearIds);
    return allDropGearIds().filter((gearId) => !allowed.has(gearId));
}

function testRealmDropsRequireMatchingDungeon(): void {
    const onlyHuman12MageGloves = excludedGearIdsExcept(522);
    assert.equal(
        GameData.getGearIdForEntity('BanditRogue', 'Mage', onlyHuman12MageGloves, 'BT_Mission1'),
        522,
        'Human12 realm gear should drop from Humans in Bandit Camp'
    );
    assert.equal(
        GameData.getGearIdForEntity('BanditRogue', 'Mage', onlyHuman12MageGloves, 'BT_Mission4'),
        0,
        'Human12 realm gear should not drop from Humans in another Felbridge dungeon'
    );

    const onlyHuman14MageFocus = excludedGearIdsExcept(512);
    assert.equal(
        GameData.getGearIdForEntity('MeylourMage', 'Mage', onlyHuman14MageFocus, 'BT_Mission4'),
        512,
        'Human14 realm gear should drop from Humans in Dereliction of Duty'
    );
    assert.equal(
        GameData.getGearIdForEntity('MeylourMage', 'Mage', onlyHuman14MageFocus, 'BT_Mission1'),
        0,
        'Human14 realm gear should not leak into Bandit Camp'
    );
}

function testMummyDropsRequireMausoleum(): void {
    const onlyMummy14MageBoots = excludedGearIdsExcept(426);
    assert.equal(
        GameData.getGearIdForEntity('Mummy', 'Mage', onlyMummy14MageBoots, 'CH_Mission6'),
        426,
        'Mummy14 realm gear should drop in Mausoleum of the Wise'
    );
    assert.equal(
        GameData.getGearIdForEntity('Mummy', 'Mage', onlyMummy14MageBoots, 'CH_Mission5'),
        0,
        'Mummy14 realm gear should not drop in a different Cemetery Hill dungeon'
    );
}

function testBossDropsRequireBossAndDungeon(): void {
    const onlyBanditTwinMageBoots = excludedGearIdsExcept(515);
    assert.equal(
        GameData.getGearIdForEntity('BanditTwinB', 'Mage', onlyBanditTwinMageBoots, 'BT_Mission1'),
        515,
        'BanditTwinB boss gear should drop from BanditTwinB in Bandit Camp'
    );
    assert.equal(
        GameData.getGearIdForEntity('BanditTwinBHard', 'Mage', onlyBanditTwinMageBoots, 'BT_Mission1Hard'),
        515,
        'hard-mode BanditTwinB should use the same boss source in the hard dungeon'
    );
    assert.equal(
        GameData.getGearIdForEntity('BanditTwinB', 'Mage', onlyBanditTwinMageBoots, 'BT_Mission4'),
        0,
        'BanditTwinB boss gear should not drop outside Bandit Camp'
    );
    assert.equal(
        GameData.getGearIdForEntity('BanditRogue', 'Mage', onlyBanditTwinMageBoots, 'BT_Mission1'),
        0,
        'boss gear should not drop from regular enemies in the same dungeon'
    );

    const onlyHuman14MageFocus = excludedGearIdsExcept(512);
    assert.equal(
        GameData.getGearIdForEntity('BanditTwinB', 'Mage', onlyHuman14MageFocus, 'BT_Mission1'),
        0,
        'bosses should not fall back to realm gear when boss gear is unavailable'
    );

    const onlyMummyBossMageFocus = excludedGearIdsExcept(422);
    assert.equal(
        GameData.getGearIdForEntity('MummyBoss', 'Mage', onlyMummyBossMageFocus, 'CH_Mission6'),
        422,
        'MummyBoss gear should drop from MummyBoss in Mausoleum of the Wise'
    );
    assert.equal(
        GameData.getGearIdForEntity('MummyBoss', 'Mage', onlyMummyBossMageFocus, 'CH_Mission5'),
        0,
        'MummyBoss gear should not drop in a different Cemetery Hill dungeon'
    );

    const onlySwampSpiderQueenMageHat = excludedGearIdsExcept(525);
    assert.equal(
        GameData.getGearIdForEntity('SwampSpiderQueen', 'Mage', onlySwampSpiderQueenMageHat, 'SwampRoadConnectionMission'),
        525,
        'the first boss entry in the client drop table should keep its authored dungeon'
    );
    assert.equal(
        GameData.getGearIdForEntity('SwampSpiderQueen', 'Mage', onlySwampSpiderQueenMageHat, 'SRN_Mission6'),
        0,
        'the first boss entry should not be shifted into the realm-location table'
    );
}

function main(): void {
    const dataDir = path.resolve(__dirname, '../data');
    LevelConfig.load(dataDir);
    GameData.load(dataDir);

    testRealmDropsRequireMatchingDungeon();
    testMummyDropsRequireMausoleum();
    testBossDropsRequireBossAndDungeon();

    console.log('gear_drop_source_regression passed');
}

main();
