import { strict as assert } from 'assert';
import { BitReader } from '../network/protocol/bitReader';
import { LevelConfig } from '../core/LevelConfig';
import { WorldEnter } from '../utils/WorldEnter';

function createCharacter(): any {
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
            ReadyTime: 999999999
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
    const transferToken = br.readMethod4();
    const masterClassId = br.readMethod20(4);
    const forgeRank = br.readMethod20(5);
    const keepRank = br.readMethod20(5);
    const towerRank = br.readMethod20(5);
    const tomeRank = br.readMethod20(5);
    const barnRank = br.readMethod20(5);
    const scaffoldingLevel = br.readMethod20(5);

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

function buildCraftTownPacket(levelName: string): Buffer {
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
        createCharacter()
    ).toBuffer();
}

function testCraftTownTutorialSuppressesKeepUpgradeVisuals(): void {
    const decoded = decodeCraftTownVisualData(buildCraftTownPacket('CraftTownTutorial'));

    assert.equal(decoded.newInternal, 'CraftTownTutorial');
    assert.equal(decoded.isCraftTown, true);
    assert.equal(decoded.keepRank, 0, 'tutorial keep should always render in the ruined baseline state');
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
    assert.equal(decoded.keepRank, 0, 'town keep should clamp unsupported keep ranks so the client does not crash');
    assert.equal(decoded.scaffoldingLevel, 12, 'town keep should continue to use the live scaffolding state');
}

function testCraftTownLevelConfigTreatsTownAsNonDungeon(): void {
    assert.equal(LevelConfig.get('CraftTown').isDungeon, false, 'CraftTown should not be treated as a dungeon level');
    assert.equal(LevelConfig.get('CraftTownTutorial').isDungeon, false, 'CraftTownTutorial should not be treated as a dungeon level');
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

    assert.equal(Number(safeStats['12'] ?? safeStats[12]), 0, 'town player data should clamp unsupported keep ranks');
    assert.equal(Number(safeUpgrade.buildingID ?? 0), 12, 'town player data should keep the live scaffolding building id');
}

function main(): void {
    LevelConfig.load(require('path').resolve(__dirname, '..', 'data'));
    testCraftTownTutorialSuppressesKeepUpgradeVisuals();
    testCraftTownPreservesLiveKeepUpgradeVisuals();
    testCraftTownLevelConfigTreatsTownAsNonDungeon();
    testCraftTownTutorialPlayerDataSuppressesKeepUpgradeState();
    testCraftTownPlayerDataPreservesLiveKeepUpgradeState();
    console.log('world_enter_crafttown_visual_state_regression: ok');
}

try {
    main();
} catch (error) {
    console.error('world_enter_crafttown_visual_state_regression: failed');
    console.error(error);
    process.exitCode = 1;
}
