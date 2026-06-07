import { NpcLoader } from '../data/NpcLoader';
import { GameData } from './GameData';
import { LevelConfig } from './LevelConfig';

const MOMENT_PREFIX = 'EnemyElements=';
const ELEMENT_ORDER = ['Fire', 'Ice', 'Air', 'Earth', 'Life', 'Death'];
const KNOWN_ELEMENTS = new Set(ELEMENT_ORDER);
const KINGDOM_TO_ELEMENT: Record<string, string> = {
    Draconic: 'Fire',
    Infernal: 'Air',
    Mythic: 'Ice',
    Sylvan: 'Life',
    Trog: 'Earth',
    Undead: 'Death'
};
const LEVEL_ELEMENT_FALLBACKS: Record<string, string> = {
    OMM_Mission1: 'Life',
    OMM_Mission1Hard: 'Life'
};

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
            const fallback = normalizeElement(LEVEL_ELEMENT_FALLBACKS[levelName]);
            return fallback || 'Unknown';
        }

        return sorted.map(([element]) => element).join('|');
    }

    static buildMomentParams(levelNameRaw: string | null | undefined, baseMoment: string): string {
        const levelName = LevelConfig.normalizeLevelName(levelNameRaw);
        const baseTokens = String(baseMoment ?? '')
            .split(',')
            .map((token) => token.trim())
            .filter((token) => token && token !== 'Normal' && !token.startsWith(MOMENT_PREFIX));

        if (!levelName || !LevelConfig.isDungeonLevel(levelName)) {
            return baseTokens.join(',');
        }

        baseTokens.push(`${MOMENT_PREFIX}${DungeonEntryDisplay.summarizeEnemyElements(levelName)}`);
        return baseTokens.join(',');
    }
}
