import { Character } from '../database/Database';
import { LevelConfig } from './LevelConfig';

export type PersistentDungeonSnapshot = {
    levelName: string;
    levelInstanceId?: string;
    progress: number;
    deadSpawnKeys: string[];
    updatedAt: number;
};

const PERSISTENT_DUNGEON_SNAPSHOT_LEVELS = new Set<string>([
    'BT_Mission4',
    'BT_Mission4Hard',
    'GoblinRiverDungeon',
    'GoblinRiverDungeonHard'
]);

export function isPersistentDungeonSnapshotLevel(levelName: string | null | undefined): boolean {
    const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
    return Boolean(normalizedLevel) && PERSISTENT_DUNGEON_SNAPSHOT_LEVELS.has(normalizedLevel);
}

export function getDungeonSnapshotKey(levelName: string | null | undefined): string {
    return LevelConfig.normalizeLevelName(levelName) || String(levelName ?? '').trim();
}

function normalizeSnapshotInstanceId(value: unknown): string {
    return String(value ?? '').trim();
}

export function getDungeonSnapshotSpawnKey(entity: any): string {
    const explicit = String(entity?.spawnKey ?? '').trim();
    if (explicit) {
        return explicit;
    }

    const roomId = Math.round(Number(entity?.roomId ?? entity?.room_id ?? 0) || 0);
    const name = String(entity?.name ?? '').trim();
    const x = Math.round(Number(entity?.x ?? entity?.pos_x ?? 0) || 0);
    const y = Math.round(Number(entity?.y ?? entity?.pos_y ?? 0) || 0);
    const id = Math.round(Number(entity?.id ?? 0) || 0);
    return `${roomId}:${name}:${x}:${y}:${id}`;
}

export function getCharacterDungeonSnapshot(
    character: Character | null | undefined,
    levelName: string | null | undefined,
    create: boolean = false
): PersistentDungeonSnapshot | null {
    if (!character || !isPersistentDungeonSnapshotLevel(levelName)) {
        return null;
    }

    const key = getDungeonSnapshotKey(levelName);
    const snapshots = character.dungeonSnapshots && typeof character.dungeonSnapshots === 'object' && !Array.isArray(character.dungeonSnapshots)
        ? character.dungeonSnapshots as Record<string, PersistentDungeonSnapshot>
        : {};

    if (!character.dungeonSnapshots || typeof character.dungeonSnapshots !== 'object' || Array.isArray(character.dungeonSnapshots)) {
        character.dungeonSnapshots = snapshots;
    }

    let snapshot = snapshots[key];
    if (!snapshot && create) {
        snapshot = {
            levelName: key,
            levelInstanceId: '',
            progress: 0,
            deadSpawnKeys: [],
            updatedAt: Date.now()
        };
        snapshots[key] = snapshot;
    }

    if (!snapshot) {
        return null;
    }

    snapshot.levelName = key;
    if (Object.prototype.hasOwnProperty.call(snapshot, 'levelInstanceId')) {
        snapshot.levelInstanceId = normalizeSnapshotInstanceId(snapshot.levelInstanceId);
    }
    snapshot.progress = Math.max(0, Math.min(100, Math.round(Number(snapshot.progress ?? 0) || 0)));
    snapshot.deadSpawnKeys = Array.from(new Set(Array.isArray(snapshot.deadSpawnKeys) ? snapshot.deadSpawnKeys.map(String) : []));
    snapshot.updatedAt = Math.round(Number(snapshot.updatedAt ?? 0) || Date.now());
    return snapshot;
}

export function ensureCharacterDungeonSnapshotForInstance(
    character: Character | null | undefined,
    levelName: string | null | undefined,
    levelInstanceId: string | null | undefined
): boolean {
    const snapshot = getCharacterDungeonSnapshot(character, levelName, true);
    if (!snapshot) {
        return false;
    }

    const normalizedInstanceId = normalizeSnapshotInstanceId(levelInstanceId);
    if (snapshot.levelInstanceId === normalizedInstanceId) {
        return false;
    }

    snapshot.levelInstanceId = normalizedInstanceId;
    snapshot.progress = 0;
    snapshot.deadSpawnKeys = [];
    snapshot.updatedAt = Date.now();
    return true;
}

export function getCharacterDungeonDeadSpawnKeys(
    character: Character | null | undefined,
    levelName: string | null | undefined,
    levelInstanceId?: string | null | undefined
): Set<string> {
    if (levelInstanceId !== undefined) {
        ensureCharacterDungeonSnapshotForInstance(character, levelName, levelInstanceId);
    }

    return new Set(getCharacterDungeonSnapshot(character, levelName)?.deadSpawnKeys ?? []);
}

export function getReusableIncompleteDungeonSnapshotInstanceId(
    character: Character | null | undefined,
    levelName: string | null | undefined
): string {
    const snapshot = getCharacterDungeonSnapshot(character, levelName);
    if (!snapshot) {
        return '';
    }

    const progress = Math.max(0, Math.min(100, Math.round(Number(snapshot.progress ?? 0) || 0)));
    const hasPartialDefeats = Array.isArray(snapshot.deadSpawnKeys) && snapshot.deadSpawnKeys.length > 0;
    const instanceId = normalizeSnapshotInstanceId(snapshot.levelInstanceId);
    if (!instanceId || progress >= 100 || (!hasPartialDefeats && progress <= 0)) {
        return '';
    }

    return instanceId;
}

export function markCharacterDungeonEnemyDead(
    character: Character | null | undefined,
    levelName: string | null | undefined,
    entity: any,
    progress?: number,
    levelInstanceId?: string | null | undefined
): boolean {
    const snapshot = getCharacterDungeonSnapshot(character, levelName, true);
    if (!snapshot) {
        return false;
    }

    if (levelInstanceId !== undefined) {
        ensureCharacterDungeonSnapshotForInstance(character, levelName, levelInstanceId);
    }

    const spawnKey = getDungeonSnapshotSpawnKey(entity);
    if (!spawnKey) {
        return false;
    }

    const dead = new Set(snapshot.deadSpawnKeys);
    const previousSize = dead.size;
    dead.add(spawnKey);
    snapshot.deadSpawnKeys = Array.from(dead.values()).sort();
    if (Number.isFinite(Number(progress))) {
        snapshot.progress = Math.max(0, Math.min(100, Math.round(Number(progress))));
    }
    snapshot.updatedAt = Date.now();
    return dead.size !== previousSize;
}

export function updateCharacterDungeonSnapshotProgress(
    character: Character | null | undefined,
    levelName: string | null | undefined,
    progress: number,
    levelInstanceId?: string | null | undefined
): boolean {
    const snapshot = getCharacterDungeonSnapshot(character, levelName, true);
    if (!snapshot) {
        return false;
    }

    if (levelInstanceId !== undefined) {
        ensureCharacterDungeonSnapshotForInstance(character, levelName, levelInstanceId);
    }

    const nextProgress = Math.max(0, Math.min(100, Math.round(Number(progress ?? 0) || 0)));
    const changed = snapshot.progress !== nextProgress;
    snapshot.progress = nextProgress;
    snapshot.updatedAt = Date.now();
    return changed;
}
