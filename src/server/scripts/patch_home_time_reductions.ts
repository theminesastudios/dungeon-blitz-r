import * as fs from 'fs';
import * as path from 'path';
import { ensureBackup, parseSwz, writeSwz } from './swzPatchUtils';

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

function getOriginalAbilityRankOneTime(abilityId: number): number | null {
    if (abilityId >= 1 && abilityId <= 9) {
        return BASE_ABILITY_RANK_ONE_TIMES_SECONDS[abilityId - 1] ?? null;
    }
    if (abilityId >= 10 && abilityId <= 18) {
        return BASE_MAGE_RANK_ONE_TIMES_SECONDS[abilityId - 10] ?? null;
    }
    if (abilityId >= 19 && abilityId <= 27) {
        return BASE_PALADIN_RANK_ONE_TIMES_SECONDS[abilityId - 19] ?? null;
    }
    if (abilityId >= 28 && abilityId <= 117) {
        return MASTERCLASS_RANK_ONE_TIMES_SECONDS[(abilityId - 28) % 10] ?? null;
    }
    return null;
}

function getOriginalBuildingRankOneTime(buildingId: number): number | null {
    if (buildingId === 1 || buildingId === 2) {
        return 45;
    }
    if (buildingId === 13) {
        return 150;
    }
    if (buildingId >= 3 && buildingId <= 11) {
        return 120;
    }
    return null;
}
const DATA_FILES = [
    {
        label: 'BuildingTypes',
        xmlPath: path.join(ROOT, 'src', 'client', 'content', 'xml', 'BuildingTypes.xml'),
        jsonPath: path.join(ROOT, 'src', 'server', 'data', 'BuildingTypes.json'),
        prettyJson: true
    },
    {
        label: 'AbilityTypes',
        xmlPath: path.join(ROOT, 'src', 'client', 'content', 'xml', 'AbilityTypes.xml'),
        jsonPath: path.join(ROOT, 'src', 'server', 'data', 'AbilityTypes.json'),
        prettyJson: false
    }
];
const GAME_SWZ_FILES = ['Game.swz', 'Game.en.swz', 'Game.tr.swz'].map((fileName) =>
    path.join(ROOT, 'src', 'client', 'content', 'localhost', 'p', 'cbq', fileName)
);

function getRankUpgradeTime(kind: string, rank: unknown, typeId: unknown): string | null {
    const normalizedRank = Math.max(0, Math.round(Number(rank ?? 0)));
    const normalizedTypeId = Math.max(0, Math.round(Number(typeId ?? 0)));
    if (normalizedRank === 1) {
        const originalSeconds = kind === 'Building'
            ? getOriginalBuildingRankOneTime(normalizedTypeId)
            : getOriginalAbilityRankOneTime(normalizedTypeId);
        return originalSeconds === null ? null : String(originalSeconds);
    }

    const schedule = kind === 'Building' ? MODERN_BUILDING_UPGRADE_TIMES_SECONDS : MODERN_ABILITY_UPGRADE_TIMES_SECONDS;
    const seconds = schedule[normalizedRank];
    return seconds === undefined ? null : String(seconds);
}

function patchXmlUpgradeTimes(xml: string): { xml: string; changes: number } {
    let changes = 0;
    const inheritedTypeIds: Record<string, string | undefined> = {};
    const nextXml = xml.replace(/<(Building|Ability)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g, (block: string, kind: string) => {
        const rank = block.match(/<Rank>(\d+)<\/Rank>/)?.[1];
        const explicitTypeId = block.match(kind === 'Building'
            ? /<BuildingID>(\d+)<\/BuildingID>/
            : /<AbilityID>(\d+)<\/AbilityID>/)?.[1];
        if (explicitTypeId !== undefined) {
            inheritedTypeIds[kind] = explicitTypeId;
        }
        const typeId = explicitTypeId ?? inheritedTypeIds[kind];
        const upgradeTime = getRankUpgradeTime(kind, rank, typeId);
        if (upgradeTime === null) {
            return block;
        }

        return block.replace(/<UpgradeTime>(\d+)<\/UpgradeTime>/, (match, value: string) => {
            if (value === upgradeTime) {
                return match;
            }
            changes += 1;
            return `<UpgradeTime>${upgradeTime}</UpgradeTime>`;
        });
    });
    return { xml: nextXml, changes };
}

function verifyXmlUpgradeTimes(xml: string, label: string): void {
    const inheritedTypeIds: Record<string, string | undefined> = {};
    for (const blockMatch of xml.matchAll(/<(Building|Ability)(?:\s[^>]*)?>[\s\S]*?<\/\1>/g)) {
        const block = blockMatch[0];
        const kind = blockMatch[1];
        const rank = block.match(/<Rank>(\d+)<\/Rank>/)?.[1];
        const explicitTypeId = block.match(kind === 'Building'
            ? /<BuildingID>(\d+)<\/BuildingID>/
            : /<AbilityID>(\d+)<\/AbilityID>/)?.[1];
        if (explicitTypeId !== undefined) {
            inheritedTypeIds[kind] = explicitTypeId;
        }
        const typeId = explicitTypeId ?? inheritedTypeIds[kind];
        const expected = getRankUpgradeTime(kind, rank, typeId);
        if (expected === null) {
            continue;
        }

        const actual = block.match(/<UpgradeTime>(\d+)<\/UpgradeTime>/)?.[1] ?? '';
        if (actual !== expected) {
            throw new Error(`${label} rank ${rank} keeps UpgradeTime ${actual}, expected ${expected}`);
        }
    }
}

function patchLooseXml(filePath: string, verify: boolean): number {
    const original = fs.readFileSync(filePath, 'utf8');
    if (verify) {
        verifyXmlUpgradeTimes(original, filePath);
        return 0;
    }

    const patched = patchXmlUpgradeTimes(original);
    if (patched.changes > 0) {
        fs.writeFileSync(filePath, patched.xml, 'utf8');
    }
    verifyXmlUpgradeTimes(patched.xml, filePath);
    return patched.changes;
}

function patchJson(filePath: string, label: string, pretty: boolean, verify: boolean): number {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Array<Record<string, unknown>>;
    const kind = label === 'BuildingTypes' ? 'Building' : 'Ability';
    let changes = 0;
    for (const entry of data) {
        const current = String(entry.UpgradeTime ?? '0');
        const expected = getRankUpgradeTime(
            kind,
            entry.Rank,
            kind === 'Building' ? entry.BuildingID : entry.AbilityID
        );
        if (expected !== null && expected !== current) {
            entry.UpgradeTime = expected;
            changes += 1;
        }
    }

    if (verify) {
        if (changes > 0) {
            throw new Error(`${filePath} keeps ${changes} UpgradeTime values outside the configured rank schedule`);
        }
        return 0;
    }

    if (changes > 0) {
        fs.writeFileSync(filePath, pretty ? `${JSON.stringify(data, null, 4)}\n` : JSON.stringify(data));
    }
    return changes;
}

function patchGameSwz(swzPath: string, verify: boolean): number {
    const ctx = parseSwz(swzPath);
    let changes = 0;
    let matchedChunks = 0;

    for (const chunk of ctx.chunks) {
        if (!chunk.xml.includes('<BuildingTypes') && !chunk.xml.includes('<AbilityTypes')) {
            continue;
        }
        matchedChunks += 1;
        if (verify) {
            verifyXmlUpgradeTimes(chunk.xml, `${swzPath} chunk ${chunk.index}`);
            continue;
        }

        const patched = patchXmlUpgradeTimes(chunk.xml);
        if (patched.changes > 0) {
            chunk.xml = patched.xml;
            changes += patched.changes;
        }
        verifyXmlUpgradeTimes(chunk.xml, `${swzPath} chunk ${chunk.index}`);
    }

    if (matchedChunks !== 2) {
        throw new Error(`${swzPath} should contain BuildingTypes and AbilityTypes chunks, found ${matchedChunks}`);
    }

    if (!verify && changes > 0) {
        ensureBackup(swzPath);
        writeSwz(ctx);
    }
    return changes;
}

function main(): void {
    const verify = process.argv.includes('--verify');
    let totalChanges = 0;

    for (const file of DATA_FILES) {
        totalChanges += patchLooseXml(file.xmlPath, verify);
        totalChanges += patchJson(file.jsonPath, file.label, file.prettyJson, verify);
    }
    for (const swzPath of GAME_SWZ_FILES) {
        totalChanges += patchGameSwz(swzPath, verify);
    }

    const mode = verify ? 'Verified' : 'Patched';
    console.log(`${mode} home timers by rank schedule (${totalChanges} changes)`);
}

main();
