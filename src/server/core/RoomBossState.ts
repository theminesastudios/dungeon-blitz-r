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
