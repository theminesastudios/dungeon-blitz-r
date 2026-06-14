import { strict as assert } from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { PetConfig } from '../core/PetConfig';
import { parseSwz } from '../scripts/swzPatchUtils';

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MODERN_ABILITY_UPGRADE_TIMES_SECONDS: Record<number, number> = {
    2: 2 * 60 * 60,
    3: 8 * 60 * 60,
    4: 16 * 60 * 60,
    5: 36 * 60 * 60,
    6: 42 * 60 * 60,
    7: 48 * 60 * 60,
    8: 56 * 60 * 60,
    9: 64 * 60 * 60,
    10: 72 * 60 * 60
};
const MODERN_BUILDING_UPGRADE_TIMES_SECONDS: Record<number, number> = {
    2: 4 * 60 * 60,
    3: 12 * 60 * 60,
    4: 24 * 60 * 60,
    5: 48 * 60 * 60,
    6: 56 * 60 * 60,
    7: 64 * 60 * 60,
    8: 72 * 60 * 60,
    9: 84 * 60 * 60,
    10: 96 * 60 * 60
};
const BASE_ABILITY_RANK_ONE_TIMES_SECONDS = [20, 40, 60, 80, 100, 120, 140, 160, 180] as const;
const BASE_MAGE_RANK_ONE_TIMES_SECONDS = [20, 40, 60, 80, 100, 120, 140, 180, 180] as const;
const BASE_PALADIN_RANK_ONE_TIMES_SECONDS = [20, 40, 60, 80, 100, 120, 180, 160, 180] as const;
const MASTERCLASS_RANK_ONE_TIMES_SECONDS = [45, 60, 75, 90, 105, 120, 135, 150, 165, 180] as const;

function getExpectedAbilityTime(rank: number, abilityId: number): number | undefined {
    if (rank !== 1) {
        return MODERN_ABILITY_UPGRADE_TIMES_SECONDS[rank];
    }
    if (abilityId >= 1 && abilityId <= 9) {
        return BASE_ABILITY_RANK_ONE_TIMES_SECONDS[abilityId - 1];
    }
    if (abilityId >= 10 && abilityId <= 18) {
        return BASE_MAGE_RANK_ONE_TIMES_SECONDS[abilityId - 10];
    }
    if (abilityId >= 19 && abilityId <= 27) {
        return BASE_PALADIN_RANK_ONE_TIMES_SECONDS[abilityId - 19];
    }
    if (abilityId >= 28 && abilityId <= 117) {
        return MASTERCLASS_RANK_ONE_TIMES_SECONDS[(abilityId - 28) % 10];
    }
    return undefined;
}

function getExpectedBuildingTime(rank: number, buildingId: number): number | undefined {
    if (rank !== 1) {
        return MODERN_BUILDING_UPGRADE_TIMES_SECONDS[rank];
    }
    if (buildingId === 1 || buildingId === 2) {
        return 45;
    }
    if (buildingId === 13) {
        return 150;
    }
    if (buildingId >= 3 && buildingId <= 11) {
        return 120;
    }
    return undefined;
}

function assertXmlUpgradeTimesMatchRankSchedule(xml: string, label: string): void {
    let seen = 0;
    const inheritedTypeIds: Record<string, number | undefined> = {};
    for (const blockMatch of xml.matchAll(/<(Building|Ability)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g)) {
        const block = blockMatch[0];
        const kind = blockMatch[1];
        const rank = Number(block.match(/<Rank>(\d+)<\/Rank>/)?.[1] ?? 0);
        const explicitTypeId = block.match(kind === 'Building'
            ? /<BuildingID>(\d+)<\/BuildingID>/
            : /<AbilityID>(\d+)<\/AbilityID>/)?.[1];
        if (explicitTypeId !== undefined) {
            inheritedTypeIds[kind] = Number(explicitTypeId);
        }
        const typeId = inheritedTypeIds[kind] ?? 0;
        const expected = kind === 'Building'
            ? getExpectedBuildingTime(rank, typeId)
            : getExpectedAbilityTime(rank, typeId);
        if (expected === undefined) {
            continue;
        }

        seen += 1;
        const value = Number(block.match(/<UpgradeTime>(\d+)<\/UpgradeTime>/)?.[1] ?? -1);
        assert.equal(value, expected, `${label} rank ${rank} should use ${expected}s`);
    }
    assert.ok(seen > 0, `${label} should contain ranked UpgradeTime values`);
}

function assertJsonUpgradeTimesMatchRankSchedule(filePath: string): void {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Array<Record<string, unknown>>;
    assert.ok(data.length > 0, `${path.basename(filePath)} should contain data`);
    const isBuilding = path.basename(filePath) === 'BuildingTypes.json';
    let seen = 0;
    for (const entry of data) {
        const rank = Number(entry.Rank ?? 0);
        const typeId = Number(isBuilding ? entry.BuildingID : entry.AbilityID);
        const expected = isBuilding
            ? getExpectedBuildingTime(rank, typeId)
            : getExpectedAbilityTime(rank, typeId);
        if (expected === undefined) {
            continue;
        }

        seen += 1;
        const value = Number(entry.UpgradeTime ?? 0);
        assert.equal(
            value,
            expected,
            `${path.basename(filePath)} ${entry.AbilityName ?? entry.BuildingName ?? 'entry'} rank ${entry.Rank ?? '?'} should use ${expected}s`
        );
    }
    assert.ok(seen > 0, `${path.basename(filePath)} should contain ranked UpgradeTime values`);
}

function assertLooseHomeTimersMatchRankSchedule(): void {
    const xmlDir = path.join(ROOT, 'src', 'client', 'content', 'xml');
    const dataDir = path.join(ROOT, 'src', 'server', 'data');

    for (const fileName of ['BuildingTypes.xml', 'AbilityTypes.xml']) {
        assertXmlUpgradeTimesMatchRankSchedule(
            fs.readFileSync(path.join(xmlDir, fileName), 'utf8'),
            fileName
        );
    }
    for (const fileName of ['BuildingTypes.json', 'AbilityTypes.json']) {
        assertJsonUpgradeTimesMatchRankSchedule(path.join(dataDir, fileName));
    }
}

function assertPackedGameTimersMatchRankSchedule(): void {
    const swzDir = path.join(ROOT, 'src', 'client', 'content', 'localhost', 'p', 'cbq');
    for (const fileName of ['Game.swz', 'Game.en.swz', 'Game.tr.swz']) {
        const chunks = parseSwz(path.join(swzDir, fileName)).chunks.filter((chunk) =>
            chunk.xml.includes('<BuildingTypes') || chunk.xml.includes('<AbilityTypes')
        );
        assert.equal(chunks.length, 2, `${fileName} should contain BuildingTypes and AbilityTypes`);
        for (const chunk of chunks) {
            assertXmlUpgradeTimesMatchRankSchedule(chunk.xml, `${fileName} chunk ${chunk.index}`);
        }
    }
}

function assertPetTimersMatchTierSchedule(): void {
    assert.equal(PetConfig.EGG_HATCH_TIMES[0], 3 * 24 * 60 * 60, 'magic eggs should hatch in three days');
    assert.equal(PetConfig.EGG_HATCH_TIMES[1], 5 * 24 * 60 * 60, 'rare eggs should hatch in five days');
    assert.equal(PetConfig.EGG_HATCH_TIMES[2], 7 * 24 * 60 * 60, 'legendary eggs should hatch in seven days');
    assert.equal(PetConfig.EGG_HATCH_MAX_TIME, 7 * 24 * 60 * 60, 'egg hatching should cap at seven days');
    assert.equal(Math.max(...PetConfig.TRAINING_TIME), 0, 'pet training should stay instant');
}

assertLooseHomeTimersMatchRankSchedule();
assertPackedGameTimersMatchRankSchedule();
assertPetTimersMatchTierSchedule();
console.log('home_time_reductions_regression: ok');
