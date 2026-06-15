import * as fs from 'fs';
import * as path from 'path';
import { disassemble, parseAbc, parseSwf, type Instruction } from './swfPatchUtils';

type RawJson = Record<string, unknown>;

interface LevelRow {
    name: string;
    label: string;
    region: string;
    swf: string;
    mapId: number;
    baseId: number;
    isDungeon: boolean;
    isHard: boolean;
    dropKey: string;
}

interface GearRule {
    gearId: number;
    gearName: string;
    displayName: string;
    className: string;
    slot: string;
    rarity: string;
    realm: string;
    bossName: string;
    level: number;
    magicRune: string;
    powerRune: string;
    procRune: string;
    statRune: string;
}

interface DropMap {
    bossToDungeonKey: Record<string, string>;
    realmLevelToDungeonKeys: Record<string, string[]>;
}

interface CatalogItem {
    category: string;
    id: number;
    code: string;
    name: string;
    level: number | null;
    rank: number | null;
    rarity: string;
    className: string;
    type: string;
    realm: string;
    kingdom: string;
    source: string;
    dungeons: string[];
    dungeonKeys: string[];
    description: string;
    details: Record<string, string | number | boolean | null>;
}

interface CatalogData {
    generatedAt: string;
    counts: Record<string, number>;
    levels: LevelRow[];
    items: CatalogItem[];
    gearDrops: CatalogItem[];
    dungeons: Array<{
        name: string;
        label: string;
        region: string;
        level: number;
        hardLevel: number | null;
        gearCount: number;
        realms: string[];
        bosses: string[];
        gearIds: number[];
    }>;
}

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const serverDataDir = path.join(repoRoot, 'src', 'server', 'data');
const clientXmlDir = path.join(repoRoot, 'src', 'client', 'content', 'xml');
const dungeonBlitzSwfPath = path.join(repoRoot, 'src', 'client', 'content', 'localhost', 'p', 'cbp', 'DungeonBlitz.swf');
const outputDirs = [
    path.join(repoRoot, 'src', 'client', 'content', 'localhost', 'catalog'),
    path.join(repoRoot, 'docs', 'catalog')
];

function readJson<T>(filePath: string): T {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as T;
}

function decodeXml(value: string | null | undefined): string {
    return String(value ?? '')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .trim();
}

function xmlAttr(attrs: string, name: string): string {
    const match = attrs.match(new RegExp(`${name}="([^"]*)"`));
    return decodeXml(match?.[1] ?? '');
}

function xmlTag(block: string, tagName: string): string {
    const match = block.match(new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`, 'i'));
    return decodeXml(match?.[1] ?? '');
}

function parseXmlBlocks(xmlPath: string, tagName: string): Array<{ attrs: string; body: string }> {
    const xml = fs.readFileSync(xmlPath, 'utf8');
    const pattern = new RegExp(`<${tagName}\\s*([^>]*)>([\\s\\S]*?)<\\/${tagName}>`, 'gi');
    const blocks: Array<{ attrs: string; body: string }> = [];
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(xml)) !== null) {
        blocks.push({ attrs: match[1] ?? '', body: match[2] ?? '' });
    }
    return blocks;
}

function toNumber(value: unknown, fallback = 0): number {
    const numberValue = Number(value);
    return Number.isFinite(numberValue) ? numberValue : fallback;
}

function rarityLabel(value: unknown): string {
    const normalized = String(value ?? '').trim().toUpperCase();
    if (normalized === 'M') return 'Magic';
    if (normalized === 'R') return 'Rare';
    if (normalized === 'L') return 'Legendary';
    return String(value ?? '').trim();
}

function compactKey(value: string | null | undefined): string {
    return String(value ?? '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

function normalizeEntityName(value: string | null | undefined): string {
    return String(value ?? '').trim().replace(/Hard$/i, '');
}

function normalizeDropLevelKey(value: string | null | undefined): string {
    return compactKey(
        String(value ?? '')
            .trim()
            .replace(/^.*\//, '')
            .replace(/^a_Level_/i, '')
            .replace(/Hard$/i, '')
    );
}

function titleFromCode(value: string): string {
    return String(value || '')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function readInstructionOperand(instruction: Instruction | undefined, operandIndex = 0): number | null {
    const value = instruction?.operands?.[operandIndex]?.[1];
    return Number.isFinite(value) ? Number(value) : null;
}

function buildMissionDisplayNames(): Record<string, string> {
    const missions = readJson<Array<RawJson>>(path.join(serverDataDir, 'MissionTypes.json'));
    const names: Record<string, string> = {};
    for (const mission of missions) {
        const dungeon = String(mission.Dungeon ?? '').trim();
        const displayName = String(mission.DisplayName ?? '').trim();
        if (dungeon && displayName && !names[dungeon]) {
            names[dungeon] = displayName;
        }
    }
    return names;
}

function buildLevels(): LevelRow[] {
    const raw = readJson<Record<string, string>>(path.join(serverDataDir, 'level_config.json'));
    const missionNames = buildMissionDisplayNames();
    const levels: LevelRow[] = [];
    let region = 'World';

    for (const [name, spec] of Object.entries(raw)) {
        const regionMatch = name.match(/^-+(.+?)-+$/);
        if (regionMatch) {
            region = titleFromCode(regionMatch[1] ?? region);
            continue;
        }

        const parts = String(spec ?? '').trim().split(/\s+/);
        if (parts.length < 4) {
            continue;
        }

        const [swf = '', mapId = '0', baseId = '0', dungeonFlag = 'false', hardFlag = ''] = parts;
        const isDungeon = dungeonFlag.toLowerCase() === 'true' && name !== 'CraftTown' && name !== 'CraftTownTutorial';
        const isHard = hardFlag === 'Hard' || /Hard$/.test(name);
        const normalName = name.replace(/Hard$/, '');
        const displayName = missionNames[normalName] ?? missionNames[name] ?? titleFromCode(normalName);
        const hardSuffix = isHard ? ' (Hard)' : '';
        levels.push({
            name,
            label: `${displayName}${hardSuffix}`,
            region,
            swf,
            mapId: toNumber(mapId),
            baseId: toNumber(baseId),
            isDungeon,
            isHard,
            dropKey: normalizeDropLevelKey(name)
        });
    }

    return levels;
}

function extractDropMaps(): DropMap {
    const bossToDungeonKey: Record<string, string> = {};
    const realmLevelToDungeonKeys: Record<string, Set<string>> = {};

    if (!fs.existsSync(dungeonBlitzSwfPath)) {
        return { bossToDungeonKey, realmLevelToDungeonKeys: {} };
    }

    const swf = parseSwf(dungeonBlitzSwfPath);
    const abc = parseAbc(swf);
    for (const methodBody of abc.methodBodies.values()) {
        const code = swf.body.subarray(methodBody.codeStart, methodBody.codeStart + methodBody.codeLen);
        let instructions: Instruction[];
        try {
            instructions = disassemble(code, `catalog-drop-map:${methodBody.methodIdx}`);
        } catch {
            continue;
        }

        for (let index = 0; index + 3 < instructions.length; index += 1) {
            const mapInstruction = instructions[index];
            const keyInstruction = instructions[index + 1];
            const levelInstruction = instructions[index + 2];
            const setInstruction = instructions[index + 3];
            if (
                mapInstruction.opcode !== 0x60 ||
                keyInstruction.opcode !== 0x2c ||
                levelInstruction.opcode !== 0x2c ||
                setInstruction.opcode !== 0x61
            ) {
                continue;
            }

            const mapName = abc.multinameNames[readInstructionOperand(mapInstruction) ?? -1] ?? '';
            if (mapName !== 'var_22' && mapName !== 'var_32') {
                continue;
            }

            const sourceKey = abc.stringValues[readInstructionOperand(keyInstruction) ?? -1] ?? '';
            const levelName = abc.stringValues[readInstructionOperand(levelInstruction) ?? -1] ?? '';
            const dungeonKey = normalizeDropLevelKey(levelName);
            if (!sourceKey || !dungeonKey) {
                continue;
            }

            if (mapName === 'var_22') {
                bossToDungeonKey[compactKey(normalizeEntityName(sourceKey))] = dungeonKey;
            } else {
                const realmKey = compactKey(sourceKey);
                if (!realmLevelToDungeonKeys[realmKey]) {
                    realmLevelToDungeonKeys[realmKey] = new Set<string>();
                }
                realmLevelToDungeonKeys[realmKey].add(dungeonKey);
            }
        }
    }

    return {
        bossToDungeonKey,
        realmLevelToDungeonKeys: Object.fromEntries(
            Object.entries(realmLevelToDungeonKeys).map(([key, values]) => [key, [...values].sort()])
        )
    };
}

function parseGearRules(): GearRule[] {
    return parseXmlBlocks(path.join(clientXmlDir, 'GearTypes.xml'), 'Gear')
        .map(({ attrs, body }) => ({
            gearId: Math.round(toNumber(xmlAttr(attrs, 'GearID'))),
            gearName: xmlAttr(attrs, 'GearName'),
            displayName: xmlTag(body, 'DisplayName'),
            className: xmlTag(body, 'UsedBy'),
            slot: xmlAttr(attrs, 'Type'),
            rarity: xmlTag(body, 'Rarity'),
            realm: xmlTag(body, 'Realm'),
            bossName: normalizeEntityName(xmlTag(body, 'BossName')),
            level: Math.round(toNumber(xmlTag(body, 'Level'))),
            magicRune: xmlTag(body, 'MagicRune'),
            powerRune: xmlTag(body, 'PowerRune'),
            procRune: xmlTag(body, 'ProcRune'),
            statRune: xmlTag(body, 'StatRune')
        }))
        .filter((gear) => gear.gearId > 0);
}

function mapGearDungeons(gear: GearRule, dropMap: DropMap, dungeonByDropKey: Map<string, LevelRow[]>): LevelRow[] {
    const keys = new Set<string>();
    if (gear.bossName) {
        const bossDungeonKey = dropMap.bossToDungeonKey[compactKey(gear.bossName)];
        if (bossDungeonKey) {
            keys.add(bossDungeonKey);
        }
    } else if (gear.realm) {
        const realmLevelKey = compactKey(`${gear.realm}${Math.max(0, Math.round(gear.level))}`);
        for (const key of dropMap.realmLevelToDungeonKeys[realmLevelKey] ?? []) {
            keys.add(key);
        }
    }

    const rows: LevelRow[] = [];
    for (const key of keys) {
        for (const level of dungeonByDropKey.get(key) ?? []) {
            if (level.isDungeon) {
                rows.push(level);
            }
        }
    }
    return rows.sort((a, b) => a.baseId - b.baseId || Number(a.isHard) - Number(b.isHard) || a.label.localeCompare(b.label));
}

function buildMountItems(): CatalogItem[] {
    const mountIdByName = readJson<Record<string, number>>(path.join(serverDataDir, 'mount_ids.json'));
    return parseXmlBlocks(path.join(clientXmlDir, 'MountTypes.xml'), 'MountType')
        .map(({ attrs, body }) => {
            const code = xmlAttr(attrs, 'MountName');
            const id = Math.round(toNumber(xmlTag(body, 'MountID'), mountIdByName[code] ?? 0));
            return {
                category: 'Mount',
                id,
                code,
                name: xmlTag(body, 'DisplayName') || titleFromCode(code),
                level: Math.round(toNumber(xmlTag(body, 'MountLevel'))),
                rank: null,
                rarity: rarityLabel(xmlTag(body, 'DisplayRarity')),
                className: '',
                type: 'Mount',
                realm: '',
                kingdom: '',
                source: toNumber(xmlTag(body, 'IdolCost')) > 0 ? 'Royal Store' : '',
                dungeons: [],
                dungeonKeys: [],
                description: xmlTag(body, 'Description'),
                details: {
                    idolCost: Math.round(toNumber(xmlTag(body, 'IdolCost')))
                }
            };
        })
        .filter((item) => item.id > 0);
}

function buildPetItems(): CatalogItem[] {
    const pets = readJson<Array<RawJson>>(path.join(serverDataDir, 'pet_types.json'));
    return pets
        .map((pet) => ({
            category: 'Pet',
            id: Math.round(toNumber(pet.PetID)),
            code: String(pet.PetName ?? ''),
            name: String(pet.DisplayName ?? pet.PetName ?? ''),
            level: Math.round(toNumber(pet.PetLevel)),
            rank: null,
            rarity: rarityLabel(pet.DisplayRarity),
            className: String(pet.ClassType ?? ''),
            type: String(pet.PetPower ?? ''),
            realm: String(pet.Kingdom ?? ''),
            kingdom: String(pet.Kingdom ?? ''),
            source: toNumber(pet.IdolCost) > 0 ? 'Royal Store' : '',
            dungeons: [],
            dungeonKeys: [],
            description: String(pet.Description ?? ''),
            details: {
                color: String(pet.Color ?? ''),
                bonus: String(pet.BonusInfo ?? ''),
                itemFind: Boolean(pet.ItemFind),
                goldFind: Boolean(pet.GoldFind),
                craftFind: Boolean(pet.CraftFind),
                expBonus: Boolean(pet.ExpBonus),
                idolCost: Math.round(toNumber(pet.IdolCost))
            }
        }))
        .filter((item) => item.id > 0);
}

function buildDyeItems(): CatalogItem[] {
    const dyes = readJson<Record<string, { name?: string; color?: number; highlight?: number; shadow?: number; rarity?: string }>>(
        path.join(serverDataDir, 'DyeTypes.json')
    );
    return Object.entries(dyes)
        .map(([id, dye]) => {
            const color = toNumber(dye.color, -1);
            const colorHex = color >= 0 ? `#${color.toString(16).padStart(6, '0').toUpperCase()}` : '';
            return {
                category: 'Dye',
                id: Math.round(toNumber(id)),
                code: `Dye${id}`,
                name: String(dye.name ?? `Dye ${id}`),
                level: null,
                rank: null,
                rarity: rarityLabel(dye.rarity),
                className: '',
                type: 'Dye',
                realm: '',
                kingdom: '',
                source: '',
                dungeons: [],
                dungeonKeys: [],
                description: '',
                details: {
                    color: colorHex,
                    highlight: toNumber(dye.highlight, -1) >= 0 ? `#${toNumber(dye.highlight).toString(16).padStart(6, '0').toUpperCase()}` : '',
                    shadow: toNumber(dye.shadow, -1) >= 0 ? `#${toNumber(dye.shadow).toString(16).padStart(6, '0').toUpperCase()}` : ''
                }
            };
        })
        .filter((item) => item.id > 0);
}

function buildMaterialItems(): CatalogItem[] {
    const materials = readJson<Array<RawJson>>(path.join(serverDataDir, 'Materials.json'));
    return materials
        .map((material) => ({
            category: 'Material',
            id: Math.round(toNumber(material.MaterialID)),
            code: String(material.MaterialName ?? ''),
            name: String(material.DisplayName ?? material.MaterialName ?? ''),
            level: null,
            rank: null,
            rarity: rarityLabel(material.Rarity),
            className: '',
            type: 'Material',
            realm: String(material.DropRealm ?? ''),
            kingdom: String(material.Kingdom ?? ''),
            source: String(material.FromRoyalStore ?? '').toLowerCase() === 'true' ? 'Royal Store' : 'Realm Drop',
            dungeons: [],
            dungeonKeys: [],
            description: '',
            details: {
                icon: String(material.IconName ?? '')
            }
        }))
        .filter((item) => item.id > 0);
}

function buildSpellItems(): CatalogItem[] {
    const abilities = readJson<Array<RawJson>>(path.join(serverDataDir, 'AbilityTypes.json'));
    return abilities
        .map((ability) => ({
            category: 'Spell',
            id: Math.round(toNumber(ability.AbilityID)),
            code: String(ability.AbilityName ?? ''),
            name: titleFromCode(String(ability.AbilityName ?? '')),
            level: null,
            rank: Math.round(toNumber(ability.Rank)),
            rarity: '',
            className: String(ability.Class ?? ability.BaseClass ?? ''),
            type: String(ability.Type ?? ''),
            realm: String(ability.Category ?? ''),
            kingdom: String(ability.BaseClass ?? ''),
            source: '',
            dungeons: [],
            dungeonKeys: [],
            description: '',
            details: {
                category: String(ability.Category ?? ''),
                baseClass: String(ability.BaseClass ?? ''),
                hotbar: String(ability.HotbarLocation ?? ''),
                goldCost: Math.round(toNumber(ability.GoldCost)),
                idolCost: Math.round(toNumber(ability.IdolCost)),
                upgradeSeconds: Math.round(toNumber(ability.UpgradeTime))
            }
        }))
        .filter((item) => item.id > 0 && item.code);
}

function buildGearItems(levels: LevelRow[], dropMap: DropMap): CatalogItem[] {
    const dungeonByDropKey = new Map<string, LevelRow[]>();
    for (const level of levels.filter((item) => item.isDungeon)) {
        const rows = dungeonByDropKey.get(level.dropKey) ?? [];
        rows.push(level);
        dungeonByDropKey.set(level.dropKey, rows);
    }

    return parseGearRules().map((gear) => {
        const dungeons = mapGearDungeons(gear, dropMap, dungeonByDropKey);
        const source = gear.bossName ? `Boss: ${gear.bossName}` : gear.realm ? `Realm: ${gear.realm}` : 'Global/Store';
        return {
            category: 'Gear',
            id: gear.gearId,
            code: gear.gearName,
            name: gear.displayName || titleFromCode(gear.gearName),
            level: gear.level || null,
            rank: null,
            rarity: rarityLabel(gear.rarity),
            className: gear.className,
            type: gear.slot,
            realm: gear.realm,
            kingdom: '',
            source,
            dungeons: dungeons.map((dungeon) => dungeon.label),
            dungeonKeys: dungeons.map((dungeon) => dungeon.name),
            description: '',
            details: {
                boss: gear.bossName,
                magicRune: gear.magicRune,
                powerRune: gear.powerRune,
                procRune: gear.procRune,
                statRune: gear.statRune
            }
        };
    });
}

function buildDungeonSummaries(levels: LevelRow[], gearItems: CatalogItem[]): CatalogData['dungeons'] {
    const byNormalName = new Map<string, LevelRow[]>();
    for (const level of levels.filter((item) => item.isDungeon)) {
        const normalName = level.name.replace(/Hard$/, '');
        const rows = byNormalName.get(normalName) ?? [];
        rows.push(level);
        byNormalName.set(normalName, rows);
    }

    return [...byNormalName.entries()].map(([normalName, rows]) => {
        const normal = rows.find((row) => !row.isHard) ?? rows[0];
        const hard = rows.find((row) => row.isHard);
        const relatedGear = gearItems.filter((gear) => gear.dungeonKeys.some((key) => key.replace(/Hard$/, '') === normalName));
        const gearIds = [...new Set(relatedGear.map((gear) => gear.id))].sort((a, b) => a - b);
        return {
            name: normalName,
            label: normal?.label.replace(/ \(Hard\)$/, '') ?? titleFromCode(normalName),
            region: normal?.region ?? '',
            level: normal?.baseId ?? 0,
            hardLevel: hard?.mapId ?? null,
            gearCount: gearIds.length,
            realms: [...new Set(relatedGear.map((gear) => gear.realm).filter(Boolean))].sort(),
            bosses: [
                ...new Set(
                    relatedGear
                        .map((gear) => String(gear.details.boss ?? ''))
                        .filter(Boolean)
                )
            ].sort(),
            gearIds
        };
    }).sort((a, b) => a.level - b.level || a.label.localeCompare(b.label));
}

function writeCatalogData(data: CatalogData): void {
    const serialized = `window.DB_CATALOG_DATA = ${JSON.stringify(data)};\n`;
    for (const outputDir of outputDirs) {
        fs.mkdirSync(outputDir, { recursive: true });
        fs.writeFileSync(path.join(outputDir, 'catalog-data.js'), serialized, 'utf8');
    }
}

function main(): void {
    const levels = buildLevels();
    const dropMap = extractDropMaps();
    const gearItems = buildGearItems(levels, dropMap);
    const items = [
        ...gearItems,
        ...buildMountItems(),
        ...buildPetItems(),
        ...buildDyeItems(),
        ...buildMaterialItems(),
        ...buildSpellItems()
    ];
    const data: CatalogData = {
        generatedAt: new Date().toISOString(),
        counts: items.reduce<Record<string, number>>((counts, item) => {
            counts[item.category] = (counts[item.category] ?? 0) + 1;
            return counts;
        }, {}),
        levels,
        items,
        gearDrops: gearItems.filter((gear) => gear.dungeons.length > 0),
        dungeons: buildDungeonSummaries(levels, gearItems)
    };

    writeCatalogData(data);
    console.log(
        `Catalog generated: ${data.items.length} items, ${data.gearDrops.length} mapped gear drops, ${data.dungeons.length} dungeons.`
    );
}

main();
