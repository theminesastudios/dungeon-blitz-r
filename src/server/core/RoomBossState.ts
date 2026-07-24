import { GlobalState } from './GlobalState';
import { getClientLevelScope } from './LevelScope';

type RoomBossMarker = {
    roomId: number;
    bossName: string;
};

const roomBossMarkersByScope = new Map<string, Map<number, RoomBossMarker>>();

function hasRoomBossMarker(entity: any): boolean {
    const roomBossRoomId = Number(entity?.roomBossRoomId ?? NaN);
    return Boolean(entity?.isRoomBoss) ||
        Boolean(entity?.roomBoss) ||
        (Number.isFinite(roomBossRoomId) && roomBossRoomId >= 0) ||
        String(entity?.roomBossName ?? '').trim().length > 0;
}

function markEntity(entity: any, roomId: number, bossName: string): void {
    if (!entity || typeof entity !== 'object') {
        return;
    }

    entity.isRoomBoss = true;
    entity.roomBoss = true;
    entity.roomBossRoomId = Math.max(0, Math.round(roomId));
    entity.roomBossName = bossName;
    if (!Number.isFinite(Number(entity.roomBossHomeX)) && Number.isFinite(Number(entity.x))) {
        entity.roomBossHomeX = Math.round(Number(entity.x));
    }
    if (!Number.isFinite(Number(entity.roomBossHomeY)) && Number.isFinite(Number(entity.y))) {
        entity.roomBossHomeY = Math.round(Number(entity.y));
    }
}

function getMarker(levelScope: string, bossId: number): RoomBossMarker | null {
    return roomBossMarkersByScope.get(levelScope)?.get(bossId) ?? null;
}

export function clearRoomBossState(): void {
    roomBossMarkersByScope.clear();
    openBossScenesByScope.clear();
}

export function getRoomBossAwareRoomId(entity: any, fallback: number = -1): number {
    const liveBossRoomId = Number(entity?.roomBossRoomId ?? NaN);
    if (Number.isFinite(liveBossRoomId) && liveBossRoomId >= 0) {
        return Math.round(liveBossRoomId);
    }

    const authoredRoomId = Number(entity?.roomId ?? NaN);
    if (Number.isFinite(authoredRoomId) && authoredRoomId >= 0) {
        return Math.round(authoredRoomId);
    }

    return Number.isFinite(fallback) && fallback >= 0 ? Math.round(fallback) : -1;
}

export function markRoomBossEntity(levelScope: string, bossId: number, roomId: number, bossName: string = ''): void {
    const normalizedBossId = Math.max(0, Math.round(Number(bossId ?? 0)));
    if (!levelScope || normalizedBossId <= 0) {
        return;
    }

    const normalizedRoomId = Math.max(0, Math.round(Number(roomId ?? 0)));
    const normalizedBossName = String(bossName ?? '').trim();

    let scopeMarkers = roomBossMarkersByScope.get(levelScope);
    if (!scopeMarkers) {
        scopeMarkers = new Map<number, RoomBossMarker>();
        roomBossMarkersByScope.set(levelScope, scopeMarkers);
    }
    scopeMarkers.set(normalizedBossId, {
        roomId: normalizedRoomId,
        bossName: normalizedBossName
    });

    markEntity(GlobalState.levelEntities.get(levelScope)?.get(normalizedBossId), normalizedRoomId, normalizedBossName);

    for (const session of GlobalState.sessionsByToken.values()) {
        if (!session.playerSpawned || getClientLevelScope(session) !== levelScope) {
            continue;
        }

        markEntity(session.entities?.get(normalizedBossId), normalizedRoomId, normalizedBossName);
    }
}

// BossFight announcing an encounter (0xAC) is the only moment the client tells
// us which entity it actually drives. Recording that opens a window in which any
// *further* boss cue a client produces is, by definition, a second copy: the
// motionless Tag Ugo that Dread Goblin Hideout leaves standing through the whole
// scene. The marker map alone could not express this, because the announced id
// often does not resolve to a shared entity at all.
type OpenBossScene = {
    roomId: number;
    bossId: number;
    bossName: string;
    openedAt: number;
};

const openBossScenesByScope = new Map<string, OpenBossScene>();

export function noteBossSceneOpened(
    levelScope: string,
    roomId: number,
    bossId: number,
    bossName: string = ''
): void {
    const scopeKey = String(levelScope ?? '').trim();
    if (!scopeKey) {
        return;
    }

    openBossScenesByScope.set(scopeKey, {
        roomId: Math.max(0, Math.round(Number(roomId ?? 0))),
        bossId: Math.max(0, Math.round(Number(bossId ?? 0))),
        bossName: String(bossName ?? '').trim(),
        openedAt: Date.now()
    });
}

export function getOpenBossScene(levelScope: string): OpenBossScene | null {
    return openBossScenesByScope.get(String(levelScope ?? '').trim()) ?? null;
}

export function clearOpenBossScene(levelScope: string): void {
    openBossScenesByScope.delete(String(levelScope ?? '').trim());
}

export function isRoomBossEntity(levelScope: string, entity: any): boolean {
    if (!levelScope || !entity || typeof entity !== 'object') {
        return false;
    }
    if (hasRoomBossMarker(entity)) {
        return true;
    }

    const entityId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
    if (entityId <= 0) {
        return false;
    }

    const marker = getMarker(levelScope, entityId);
    if (marker) {
        markEntity(entity, marker.roomId, marker.bossName);
        return true;
    }

    const levelEntity = GlobalState.levelEntities.get(levelScope)?.get(entityId);
    if (hasRoomBossMarker(levelEntity)) {
        if (levelEntity && levelEntity !== entity) {
            markEntity(entity, Number(levelEntity.roomBossRoomId ?? 0), String(levelEntity.roomBossName ?? ''));
        }
        return true;
    }

    for (const session of GlobalState.sessionsByToken.values()) {
        if (!session.playerSpawned || getClientLevelScope(session) !== levelScope) {
            continue;
        }
        const sessionEntity = session.entities?.get(entityId);
        if (hasRoomBossMarker(sessionEntity)) {
            if (sessionEntity && sessionEntity !== entity) {
                markEntity(entity, Number(sessionEntity.roomBossRoomId ?? 0), String(sessionEntity.roomBossName ?? ''));
            }
            return true;
        }
    }

    return false;
}
