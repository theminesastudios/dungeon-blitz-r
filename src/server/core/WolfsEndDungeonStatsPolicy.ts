import doorMapData from '../data/door_map.json';
import { EntityState, EntityTeam } from './Entity';
import { GameData } from './GameData';
import { LevelConfig } from './LevelConfig';
import { sharesRoomIds } from './PartySync';

type DoorMapEntry = [[string, number], string];

export type DungeonStatsEntityClassification = {
    hostile: boolean;
    boss: boolean;
    chest: boolean;
    objective: boolean;
    treasureFallbackHostile: boolean;
};

const WOLFS_END_ENTRY_LEVELS = new Set<string>(['NewbieRoad', 'NewbieRoadHard']);
const WOLFS_END_LEVEL_ALIASES: Record<string, string> = {
    GoblinKidnappers: 'GoblinRiverDungeon',
    GoblinKidnappersHard: 'GoblinRiverDungeonHard'
};
const DIRECT_ENEMY_RANKS = new Set(['Minion', 'Lieutenant', 'MiniBoss', 'Boss']);
const EXCLUDED_NAME_PATTERN = /(dummy|parrot|chains|helper)/i;
const EXCLUDED_BEHAVIOR_PATTERN = /(dummy|npcdummy|parrot|chains|helper)/i;

function normalizeLevelAlias(levelName: string | null | undefined): string {
    const rawLevel = String(levelName ?? '').trim();
    if (!rawLevel) {
        return '';
    }

    const aliased = WOLFS_END_LEVEL_ALIASES[rawLevel] ?? rawLevel;
    return LevelConfig.normalizeLevelName(aliased) || aliased;
}

function buildWolfsEndDungeonSet(): Set<string> {
    const levels = new Set<string>();

    for (const entry of doorMapData as DoorMapEntry[]) {
        const [sourceDoor, targetRaw] = entry;
        const [sourceLevel, doorId] = sourceDoor;
        if (!WOLFS_END_ENTRY_LEVELS.has(sourceLevel) || Number(doorId) < 100) {
            continue;
        }

        const normalizedTarget = normalizeLevelAlias(targetRaw);
        if (normalizedTarget) {
            levels.add(normalizedTarget);
        }
    }

    levels.add('CraftTownTutorial');

    return levels;
}

const WOLFS_END_DUNGEON_LEVELS = buildWolfsEndDungeonSet();

function getPrimaryGoldDrop(entType: any): number {
    const rawGoldDrop = String(entType?.GoldDrop ?? '0').split(',')[0];
    const goldDrop = Number(rawGoldDrop ?? 0);
    return Number.isFinite(goldDrop) ? goldDrop : 0;
}

function isAmbientOrFakeEntity(name: string, behavior: string): boolean {
    return EXCLUDED_NAME_PATTERN.test(name) || EXCLUDED_BEHAVIOR_PATTERN.test(behavior);
}

function isTreasureChestEntity(name: string, behavior: string): boolean {
    return /treasurechest/i.test(name) || /questtreasurechest/i.test(name) || behavior === 'TreasureChest';
}

export function normalizeWolfsEndDungeonLevel(levelName: string | null | undefined): string {
    return normalizeLevelAlias(levelName);
}

export function isWolfsEndDungeonLevel(levelName: string | null | undefined): boolean {
    const normalizedLevel = normalizeWolfsEndDungeonLevel(levelName);
    return Boolean(normalizedLevel) && WOLFS_END_DUNGEON_LEVELS.has(normalizedLevel);
}

export function getWolfsEndDungeonLevels(): string[] {
    return Array.from(WOLFS_END_DUNGEON_LEVELS.values()).sort();
}

export function classifyDungeonStatsEntity(entity: any): DungeonStatsEntityClassification {
    if (!entity || entity.isPlayer) {
        return {
            hostile: false,
            boss: false,
            chest: false,
            objective: false,
            treasureFallbackHostile: false
        };
    }

    const name = String(entity?.name ?? '').trim();
    const entType = name ? GameData.getEntType(name) ?? {} : {};
    const behavior = String(entity?.behavior ?? entType?.Behavior ?? '').trim();
    const rank = String(entity?.entRank ?? entType?.EntRank ?? '').trim();
    const hitPoints = Number(entity?.maxHp ?? entity?.hp ?? entType?.HitPoints ?? 0);
    const team = Number(entity?.team ?? EntityTeam.UNKNOWN);
    const defeated = Boolean(entity?.dead) || Number(entity?.entState ?? 0) === EntityState.DEAD;
    const chest = isTreasureChestEntity(name, behavior);
    const objective = !chest && /Target|Objective/i.test(behavior);
    const hostile = !chest &&
        !objective &&
        team === EntityTeam.ENEMY &&
        !isAmbientOrFakeEntity(name, behavior) &&
        (
            DIRECT_ENEMY_RANKS.has(rank) ||
            hitPoints > 0.5 ||
            defeated ||
            Number(entType?.ExpMult ?? 0) > 0 ||
            getPrimaryGoldDrop(entType) > 0
        );
    const treasureFallbackHostile = hostile && (
        DIRECT_ENEMY_RANKS.has(rank) ||
        Number(entType?.ExpMult ?? 0) > 0 ||
        getPrimaryGoldDrop(entType) > 0
    );

    return {
        hostile,
        boss: hostile && (rank === 'Boss' || rank === 'MiniBoss'),
        chest,
        objective,
        treasureFallbackHostile
    };
}

export function isDungeonStatsHostile(entity: any): boolean {
    return classifyDungeonStatsEntity(entity).hostile;
}

export function isDungeonStatsTreasureFallbackHostile(entity: any): boolean {
    return classifyDungeonStatsEntity(entity).treasureFallbackHostile;
}

export function isDungeonStatsDefeated(entity: any): boolean {
    return Boolean(entity?.dead) ||
        Number(entity?.hp ?? 1) <= 0 ||
        Number(entity?.entState ?? 0) === EntityState.DEAD;
}

export function isDungeonStatsTargetableHostile(entity: any): boolean {
    return isDungeonStatsHostile(entity) &&
        !Boolean(entity?.untargetable) &&
        !isDungeonStatsDefeated(entity);
}

export function hasDungeonStatsCombatTarget(
    entities: Iterable<any>,
    currentRoomId?: number | null
): boolean {
    const roomId = Number(currentRoomId ?? -1);

    for (const entity of entities) {
        if (!isDungeonStatsTargetableHostile(entity)) {
            continue;
        }

        const entityRoomId = Number(entity?.roomId ?? -1);
        if (sharesRoomIds(roomId, entityRoomId)) {
            return true;
        }
    }

    return false;
}
