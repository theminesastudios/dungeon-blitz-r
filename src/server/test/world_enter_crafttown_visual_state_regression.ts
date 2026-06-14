import { strict as assert } from 'assert';
import { BitReader } from '../network/protocol/bitReader';
import { LevelConfig } from '../core/LevelConfig';
import { WorldEnter } from '../utils/WorldEnter';

function createCharacter(): any {
    const futureReadyTime = Math.floor(Date.now() / 1000) + 86400;

    return {
        name: 'Alpha',
        class: 'paladin',
        gender: 'male',
        MasterClass: 0,
        magicForge: {
            stats_by_building: {
                '1': 4,
                '2': 3,
                '12': 5,
                '13': 2
            }
        },
        buildingUpgrade: {
            buildingID: 12,
            rank: 4,
            ReadyTime: futureReadyTime
        }
    };
}

function decodeCraftTownVisualData(packet: Buffer) {
    const br = new BitReader(packet);

    br.readMethod4();
    br.readMethod4();
    br.readMethod13();

    const hasOldCoord = br.readMethod20(1) === 1;
    if (hasOldCoord) {
        br.readMethod4();
        br.readMethod4();
    }

    br.readMethod13();
    br.readMethod4();
    br.readMethod13();
    br.readMethod20(6);
    br.readMethod20(6);
    const newInternal = br.readMethod13();
    br.readMethod13();
    br.readMethod13();
    const isDungeon = br.readMethod20(1) === 1;

    const hasNewCoord = br.readMethod20(1) === 1;
    let newX = 0;
    let newY = 0;
    if (hasNewCoord) {
        newX = br.readMethod45();
        newY = br.readMethod45();
    }

    const isCraftTown = br.readMethod20(1) === 1;
    let transferToken = 0;
    let masterClassId = 0;
    let forgeRank = 0;
    let keepRank = 0;
    let towerRank = 0;
    let tomeRank = 0;
    let barnRank = 0;
    let scaffoldingLevel = 0;
    if (isCraftTown) {
        transferToken = br.readMethod4();
        masterClassId = br.readMethod20(4);
        forgeRank = br.readMethod20(5);
        keepRank = br.readMethod20(5);
        towerRank = br.readMethod20(5);
        tomeRank = br.readMethod20(5);
        barnRank = br.readMethod20(5);
        scaffoldingLevel = br.readMethod20(5);
    }

    return {
        newInternal,
        isDungeon,
        hasNewCoord,
        newX,
        newY,
        isCraftTown,
        transferToken,
        masterClassId,
        forgeRank,
        keepRank,
        towerRank,
        tomeRank,
        barnRank,
        scaffoldingLevel
    };
}

function buildCraftTownPacket(levelName: string, character: any = createCharacter()): Buffer {
    const levelSpec = LevelConfig.get(levelName);
    return WorldEnter.buildEnterWorldPacket(
        77,
        0,
        '',
        false,
        0,
        0,
        'localhost',
        8080,
        'LevelsHome.swf',
        1,
        1,
        levelName,
        '',
        '',
        levelSpec.isDungeon,
        true,
        10,
        20,
        character
    ).toBuffer();
}

function testCraftTownTutorialSuppressesKeepUpgradeVisuals(): void {
    const decoded = decodeCraftTownVisualData(buildCraftTownPacket('CraftTownTutorial'));

    assert.equal(decoded.newInternal, 'CraftTownTutorial');
    assert.equal(decoded.isDungeon, true, 'tutorial keep should enter as a dungeon so dungeon UI state replaces home tutorial alerts');
    assert.equal(decoded.hasNewCoord, true, 'tutorial keep should keep its authored spawn coordinates');
    assert.equal(decoded.newX, 10);
    assert.equal(decoded.newY, 20);
    assert.equal(decoded.isCraftTown, false, 'tutorial should use its authored ruined room art instead of live Home building visuals');
    assert.equal(decoded.keepRank, 0, 'tutorial keep should not send live keep ranks');
    assert.equal(decoded.scaffoldingLevel, 0, 'tutorial keep should not inherit live scaffolding state');
}

function testCraftTownPreservesLiveKeepUpgradeVisuals(): void {
    const decoded = decodeCraftTownVisualData(buildCraftTownPacket('CraftTown'));

    assert.equal(decoded.newInternal, 'CraftTown');
    assert.equal(decoded.isDungeon, false, 'town enter-world packet should not flag CraftTown as a dungeon');
    assert.equal(decoded.hasNewCoord, true, 'town enter-world packet should include explicit spawn coordinates');
    assert.equal(decoded.newX, 10);
    assert.equal(decoded.newY, 20);
    assert.equal(decoded.isCraftTown, true);
    assert.equal(decoded.keepRank, 0, 'town keep should use the supported repaired rank-zero art entry');
    assert.equal(decoded.scaffoldingLevel, 12, 'town keep should continue to use the live scaffolding state');
}

function testCraftTownSuppressesExpiredKeepUpgradeVisuals(): void {
    const character = createCharacter();
    character.buildingUpgrade = {
        buildingID: 12,
        rank: 4,
        ReadyTime: Math.floor(Date.now() / 1000) - 30
    };

    const decoded = decodeCraftTownVisualData(buildCraftTownPacket('CraftTown', character));

    assert.equal(decoded.scaffoldingLevel, 0, 'town enter-world packet should not show expired scaffolding');
}

function testCraftTownLevelConfigTreatsTownAsNonDungeon(): void {
    assert.equal(LevelConfig.get('CraftTown').isDungeon, false, 'CraftTown should not be treated as a dungeon level');
    assert.equal(LevelConfig.get('CraftTownTutorial').isDungeon, true, 'CraftTownTutorial should be treated as a dungeon level');
}

function testCraftTownTutorialPlayerDataSuppressesKeepUpgradeState(): void {
    const character = createCharacter();
    const safeStats = WorldEnter.getTutorialSafeBuildingStatsForLevel(character, 'CraftTownTutorial');
    const safeUpgrade = WorldEnter.getTutorialSafeBuildingUpgradeForLevel(character, 'CraftTownTutorial');

    assert.equal(Number(safeStats['12'] ?? safeStats[12]), 0, 'tutorial player data should suppress live keep rank');
    assert.equal(Number(safeUpgrade.buildingID ?? 0), 0, 'tutorial player data should suppress live scaffolding building id');
    assert.equal(Number(safeUpgrade.ReadyTime ?? 0), 0, 'tutorial player data should suppress live scaffolding timer');
}

function testCraftTownPlayerDataPreservesLiveKeepUpgradeState(): void {
    const character = createCharacter();
    const safeStats = WorldEnter.getTutorialSafeBuildingStatsForLevel(character, 'CraftTown');
    const safeUpgrade = WorldEnter.getTutorialSafeBuildingUpgradeForLevel(character, 'CraftTown');

    assert.equal(Number(safeStats['12'] ?? safeStats[12]), 0, 'town player data should use the supported repaired rank-zero art entry');
    assert.equal(Number(safeUpgrade.buildingID ?? 0), 12, 'town player data should keep the live scaffolding building id');
}

function testCraftTownPlayerDataSuppressesExpiredKeepUpgradeState(): void {
    const character = createCharacter();
    character.buildingUpgrade = {
        buildingID: 12,
        rank: 4,
        ReadyTime: Math.floor(Date.now() / 1000) - 30
    };

    const safeUpgrade = WorldEnter.getTutorialSafeBuildingUpgradeForLevel(character, 'CraftTown');

    assert.equal(Number(safeUpgrade.buildingID ?? 0), 0, 'town player data should not keep expired scaffolding building id');
    assert.equal(Number(safeUpgrade.ReadyTime ?? 0), 0, 'town player data should not keep expired scaffolding timer');
}

function main(): void {
    LevelConfig.load(require('path').resolve(__dirname, '..', 'data'));
    testCraftTownTutorialSuppressesKeepUpgradeVisuals();
    testCraftTownPreservesLiveKeepUpgradeVisuals();
    testCraftTownSuppressesExpiredKeepUpgradeVisuals();
    testCraftTownLevelConfigTreatsTownAsNonDungeon();
    testCraftTownTutorialPlayerDataSuppressesKeepUpgradeState();
    testCraftTownPlayerDataPreservesLiveKeepUpgradeState();
    testCraftTownPlayerDataSuppressesExpiredKeepUpgradeState();
    console.log('world_enter_crafttown_visual_state_regression: ok');
}

try {
    main();
} catch (error) {
    console.error('world_enter_crafttown_visual_state_regression: failed');
    console.error(error);
    process.exitCode = 1;
}
