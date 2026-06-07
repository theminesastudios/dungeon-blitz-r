import { NpcLoader } from '../data/NpcLoader';
import dungeonEnemyElements from '../data/dungeon_enemy_elements.json';
import { GameData } from './GameData';
import { LevelConfig } from './LevelConfig';

const MOMENT_PREFIX = 'EnemyElements=';
const ELEMENT_ORDER = ['Fire', 'Ice', 'Air', 'Earth', 'Life', 'Death'];
const KNOWN_ELEMENTS = new Set(ELEMENT_ORDER);
const MAX_VISIBLE_ELEMENTS = 3;
const KINGDOM_TO_ELEMENT: Record<string, string> = {
    Draconic: 'Fire',
    Infernal: 'Air',
    Mythic: 'Ice',
    Sylvan: 'Life',
    Trog: 'Earth',
    Undead: 'Death'
};
const LEVEL_ELEMENT_FALLBACKS: Record<string, string[]> = {
    DreamDragonDungeon: ['Fire'],
    GhostBossDungeon: ['Death'],
    OMM_Mission1: ['Air', 'Earth'],
    OMM_Mission1Hard: ['Air', 'Earth'],
    SD_Mission2: ['Life', 'Air', 'Earth'],
    SD_Mission2Hard: ['Life', 'Air', 'Earth']
};
const LEVEL_PREFIX_ELEMENT_FALLBACKS: Array<[RegExp, string[]]> = [
    [/^NR_Tales/, ['Earth']],
    [/^SRN_Mission|^SwampRoadConnectionMission/, ['Fire', 'Earth']],
    [/^BT_Mission/, ['Fire', 'Life']],
    [/^CH_Mission|^CH_MiniMission/, ['Death', 'Earth']],
    [/^OMM_Mission/, ['Air', 'Earth']],
    [/^EG_Mission/, ['Life', 'Fire']],
    [/^AC_Mission/, ['Death', 'Air']],
    [/^SD_Mission|^SD_Tales/, ['Earth', 'Air']],
    [/^JC_Mission|^JC_Mini/, ['Fire', 'Ice']]
];

interface DungeonEnemyElementEntry {
    elements?: unknown[];
}

const DUNGEON_ENEMY_ELEMENTS = dungeonEnemyElements as Record<string, DungeonEnemyElementEntry | undefined>;

function normalizeElement(value: unknown): string {
    const raw = String(value ?? '').trim();
    if (!raw) {
        return '';
    }

    const normalized = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
    return KNOWN_ELEMENTS.has(normalized) ? normalized : '';
}

function resolveEnemyEntName(levelName: string, npcName: string): string {
    const isHard = levelName.endsWith('Hard');
    if (isHard && !npcName.endsWith('Hard') && GameData.getEntType(`${npcName}Hard`)) {
        return `${npcName}Hard`;
    }

    return npcName;
}

function isHostileEnemy(levelName: string, npc: any): boolean {
    if (!npc || Number(npc.team ?? 0) !== 2) {
        return false;
    }

    const name = resolveEnemyEntName(levelName, String(npc.name ?? '').trim());
    if (!name) {
        return false;
    }

    const entType = GameData.getEntType(name) ?? {};
    const behavior = String(entType.Behavior ?? '').trim();
    return !/TreasureChest|Ambient|Decoration/i.test(behavior);
}

function getFallbackElements(levelName: string): string[] {
    const baseLevelName = levelName.endsWith('Hard') ? levelName.slice(0, -4) : levelName;
    const exact = LEVEL_ELEMENT_FALLBACKS[levelName] ?? LEVEL_ELEMENT_FALLBACKS[baseLevelName];
    if (exact) {
        return exact;
    }

    for (const [pattern, elements] of LEVEL_PREFIX_ELEMENT_FALLBACKS) {
        if (pattern.test(baseLevelName)) {
            return elements;
        }
    }

    return [];
}

function getManifestElements(levelName: string): string[] {
    const baseLevelName = levelName.endsWith('Hard') ? levelName.slice(0, -4) : levelName;
    const entry = DUNGEON_ENEMY_ELEMENTS[levelName] ?? DUNGEON_ENEMY_ELEMENTS[baseLevelName];
    if (!entry || !Array.isArray(entry.elements)) {
        return [];
    }

    return entry.elements
        .map((element) => normalizeElement(element))
        .filter((element) => element)
        .slice(0, MAX_VISIBLE_ELEMENTS);
}

export class DungeonEntryDisplay {
    static readonly MOMENT_PREFIX = MOMENT_PREFIX;

    private static summarizeEnemyElements(levelName: string): string {
        const counts = new Map<string, number>();
        const npcs = NpcLoader.getRawNpcsForLevel(levelName);

        for (const npc of npcs) {
            if (!isHostileEnemy(levelName, npc)) {
                continue;
            }

            const entName = resolveEnemyEntName(levelName, String(npc.name ?? '').trim());
            const entType = GameData.getEntType(entName) ?? {};
            const element = normalizeElement(entType.Element) || normalizeElement(KINGDOM_TO_ELEMENT[String(entType.Kingdom ?? '')]);
            if (!element) {
                continue;
            }

            counts.set(element, (counts.get(element) ?? 0) + 1);
        }

        const sorted = Array.from(counts.entries()).sort((left, right) => {
            if (right[1] !== left[1]) {
                return right[1] - left[1];
            }
            const leftOrder = ELEMENT_ORDER.indexOf(left[0]);
            const rightOrder = ELEMENT_ORDER.indexOf(right[0]);
            return leftOrder - rightOrder;
        });

        if (sorted.length === 0) {
            const manifest = getManifestElements(levelName);
            if (manifest.length > 0) {
                return manifest.join('|');
            }

            const fallback = getFallbackElements(levelName)
                .map((element) => normalizeElement(element))
                .filter((element) => element);
            return fallback.length > 0 ? fallback.slice(0, MAX_VISIBLE_ELEMENTS).join('|') : '';
        }

        return sorted.slice(0, MAX_VISIBLE_ELEMENTS).map(([element]) => element).join('|');
    }

    static buildMomentParams(levelNameRaw: string | null | undefined, baseMoment: string): string {
        const levelName = LevelConfig.normalizeLevelName(levelNameRaw);
        const momentTokens = String(baseMoment ?? '')
            .split(',')
            .map((token) => token.trim())
            .filter((token) => token && !token.startsWith(MOMENT_PREFIX));

        if (!levelName || !LevelConfig.isDungeonLevel(levelName)) {
            return momentTokens.filter((token) => token !== 'Normal').join(',');
        }

        const baseTokens = momentTokens.length > 0 ? [...momentTokens] : ['Normal'];

        const elements = DungeonEntryDisplay.summarizeEnemyElements(levelName);
        if (elements) {
            baseTokens.push(`${MOMENT_PREFIX}${elements}`);
        }
        return baseTokens.join(',');
    }
}
