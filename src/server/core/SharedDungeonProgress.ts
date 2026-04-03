import { GlobalState, SharedDungeonProgressState } from './GlobalState';
import { LevelConfig } from './LevelConfig';
import { getClientLevelScope, getScopeLevelName } from './LevelScope';
import { getPartyIdForClient } from './PartySync';
import { normalizeCharacterKey } from './SocialState';
import { EntityState } from './Entity';
import { GameData } from './GameData';

const SHARED_DUNGEON_PROGRESS_LEVELS = new Set<string>([
    'GoblinRiverDungeon',
    'GoblinRiverDungeonHard'
]);
const GOBLIN_RIVER_INITIAL_PROGRESS = 11;
const SHARED_DUNGEON_NON_HOSTILE_BEHAVIORS = new Set<string>([
    'Chest',
    'TreasureChest'
]);
const SHARED_DUNGEON_NON_HOSTILE_NAME_PATTERNS = [
    /chest/i,
    /\bbarrel\b/i,
    /\bcrate\b/i
];

function normalizeAuthorityToken(value: unknown): number {
    const token = Number(value ?? 0);
    return Number.isFinite(token) && token > 0 ? Math.round(token) : 0;
}

function normalizeMissionId(value: unknown): number {
    const missionId = Number(value ?? 0);
    return Number.isFinite(missionId) && missionId > 0 ? Math.round(missionId) : 0;
}

function normalizeMissionState(value: unknown): number {
    const missionState = Number(value ?? 0);
    if (!Number.isFinite(missionState)) {
        return 0;
    }

    return Math.max(0, Math.min(3, Math.round(missionState)));
}

function normalizeTrackerMissionProgress(value: unknown): number {
    const progress = Number(value ?? 0);
    if (!Number.isFinite(progress)) {
        return 0;
    }

    return Math.max(0, Math.round(progress));
}

function normalizeRoomId(value: unknown): number | undefined {
    const roomId = Number(value ?? -1);
    if (!Number.isFinite(roomId) || roomId < 0) {
        return undefined;
    }

    return Math.round(roomId);
}

function normalizeCutsceneUntil(value: unknown): number {
    const until = Number(value ?? 0);
    return Number.isFinite(until) && until > 0 ? Math.round(until) : 0;
}

function normalizeRoomPacketSequence(value: unknown): number {
    const seq = Number(value ?? 0);
    return Number.isFinite(seq) && seq > 0 ? Math.round(seq) : 0;
}

function normalizeRoomPacketSnapshots(
    value: Map<string, { packetId: number; roomId: number; payload: Buffer; seq: number }> | null | undefined
): Map<string, { packetId: number; roomId: number; payload: Buffer; seq: number }> {
    const snapshots = new Map<string, { packetId: number; roomId: number; payload: Buffer; seq: number }>();
    if (!value) {
        return snapshots;
    }

    for (const [key, snapshot] of value.entries()) {
        const packetId = Number(snapshot?.packetId ?? 0);
        const roomId = normalizeRoomId(snapshot?.roomId);
        const payload = snapshot?.payload ? Buffer.from(snapshot.payload) : null;
        const seq = normalizeRoomPacketSequence(snapshot?.seq);
        if (!packetId || roomId === undefined || !payload || !payload.length || !seq) {
            continue;
        }

        snapshots.set(String(key), {
            packetId: Math.round(packetId),
            roomId,
            payload,
            seq
        });
    }

    return snapshots;
}

function normalizeStartedRoomIds(value: Iterable<number> | null | undefined): Set<number> {
    const roomIds = new Set<number>();
    if (!value) {
        return roomIds;
    }

    for (const entry of value) {
        const roomId = normalizeRoomId(entry);
        if (roomId === undefined) {
            continue;
        }

        roomIds.add(roomId);
    }

    return roomIds;
}

function clampProgress(value: unknown): number {
    const progress = Number(value ?? 0);
    if (!Number.isFinite(progress)) {
        return 0;
    }

    return Math.max(0, Math.min(100, Math.round(progress)));
}

export function usesSharedDungeonProgress(levelName: string | null | undefined): boolean {
    const normalizedLevel = LevelConfig.normalizeLevelName(levelName);
    return Boolean(normalizedLevel) && SHARED_DUNGEON_PROGRESS_LEVELS.has(normalizedLevel);
}

export function getSharedDungeonProgressState(
    levelScope: string | null | undefined
): SharedDungeonProgressState | null {
    const scopeKey = String(levelScope ?? '').trim();
    if (!scopeKey) {
        return null;
    }

    const state = GlobalState.levelQuestProgress.get(scopeKey);
    if (!state) {
        return null;
    }

    state.progress = clampProgress(state.progress);
    state.authorityToken = normalizeAuthorityToken(state.authorityToken);
    state.trackedHostileIds ??= new Set<number>();
    state.defeatedHostileIds ??= new Set<number>();
    state.startedRoomIds = normalizeStartedRoomIds(state.startedRoomIds);
    state.roomPacketSnapshots = normalizeRoomPacketSnapshots(state.roomPacketSnapshots);
    state.roomPacketSequence = normalizeRoomPacketSequence(state.roomPacketSequence);
    state.trackerMissionId = normalizeMissionId(state.trackerMissionId);
    state.trackerMissionState = normalizeMissionState(state.trackerMissionState);
    state.trackerMissionProgress = normalizeTrackerMissionProgress(state.trackerMissionProgress);
    state.activeCutsceneRoomId = normalizeRoomId(state.activeCutsceneRoomId);
    state.activeCutsceneAllowInput = Boolean(state.activeCutsceneAllowInput);
    state.activeCutsceneUntil = normalizeCutsceneUntil(state.activeCutsceneUntil);

    if (!state.trackerMissionId || !state.trackerMissionState) {
        state.trackerMissionId = 0;
        state.trackerMissionState = 0;
        state.trackerMissionProgress = 0;
    }

    if (!state.activeCutsceneUntil) {
        state.activeCutsceneRoomId = undefined;
        state.activeCutsceneAllowInput = undefined;
        state.activeCutsceneUntil = 0;
    }

    return state;
}

export function getOrCreateSharedDungeonProgressState(
    levelScope: string | null | undefined
): SharedDungeonProgressState | null {
    const scopeKey = String(levelScope ?? '').trim();
    if (!scopeKey) {
        return null;
    }

    const existing = getSharedDungeonProgressState(scopeKey);
    if (existing) {
        return existing;
    }

    const created: SharedDungeonProgressState = {
        progress: 0,
        authorityToken: 0,
        trackedHostileIds: new Set<number>(),
        defeatedHostileIds: new Set<number>(),
        startedRoomIds: new Set<number>(),
        roomPacketSnapshots: new Map<string, { packetId: number; roomId: number; payload: Buffer; seq: number }>(),
        roomPacketSequence: 0,
        trackerMissionId: 0,
        trackerMissionState: 0,
        trackerMissionProgress: 0,
        activeCutsceneAllowInput: false,
        activeCutsceneUntil: 0
    };
    GlobalState.levelQuestProgress.set(scopeKey, created);
    return created;
}

function isSharedDungeonTrackedHostile(entity: any): boolean {
    if (!entity || entity.isPlayer) {
        return false;
    }

    if (!entity.clientSpawned || Number(entity.team ?? 0) !== 2) {
        return false;
    }

    const entName = String(entity?.name ?? '').trim();
    const entType = entName ? GameData.getEntType(entName) : null;
    const behavior = String(entType?.Behavior ?? '').trim();
    if (SHARED_DUNGEON_NON_HOSTILE_BEHAVIORS.has(behavior)) {
        return false;
    }

    if (
        SHARED_DUNGEON_NON_HOSTILE_NAME_PATTERNS.some((pattern) => pattern.test(entName)) &&
        (!entType || String(entType?.Realm ?? '').trim() === 'Object')
    ) {
        return false;
    }

    return true;
}

function isEntityDefeated(entity: any): boolean {
    return Boolean(entity?.dead) ||
        Number(entity?.hp ?? 1) <= 0 ||
        Number(entity?.entState ?? 0) === EntityState.DEAD;
}

export function resolveSharedDungeonProgressAuthorityToken(levelScope: string | null | undefined): number {
    const scopeKey = String(levelScope ?? '').trim();
    if (!scopeKey) {
        return 0;
    }

    const levelMap = GlobalState.levelEntities.get(scopeKey);
    const counts = new Map<number, number>();
    const partyCounts = new Map<number, number>();

    for (const entity of levelMap?.values() ?? []) {
        if (!isSharedDungeonTrackedHostile(entity)) {
            continue;
        }

        const ownerToken = normalizeAuthorityToken(entity.ownerToken);
        if (ownerToken <= 0) {
            continue;
        }

        counts.set(ownerToken, (counts.get(ownerToken) ?? 0) + 1);

        const ownerSession = GlobalState.sessionsByToken.get(ownerToken);
        const livePartyId = getPartyIdForClient(ownerSession);
        const storedPartyId = Number(entity?.ownerPartyId ?? 0);
        const partyId = livePartyId > 0 ? livePartyId : (storedPartyId > 0 ? storedPartyId : 0);
        if (partyId > 0) {
            partyCounts.set(partyId, (partyCounts.get(partyId) ?? 0) + 1);
        }
    }

    let bestPartyId = 0;
    let bestPartyCount = 0;
    for (const [partyId, count] of partyCounts.entries()) {
        if (count > bestPartyCount || (count === bestPartyCount && partyId < bestPartyId)) {
            bestPartyId = partyId;
            bestPartyCount = count;
        }
    }

    if (bestPartyId > 0) {
        const leaderKey = normalizeCharacterKey(GlobalState.partyGroups.get(bestPartyId)?.leader);
        if (leaderKey) {
            for (const session of GlobalState.sessionsByToken.values()) {
                if (
                    session?.playerSpawned &&
                    session.token > 0 &&
                    getClientLevelScope(session) === scopeKey &&
                    normalizeCharacterKey(session.character?.name) === leaderKey
                ) {
                    return session.token;
                }
            }
        }
    }

    let bestToken = 0;
    let bestCount = 0;
    for (const [ownerToken, count] of counts.entries()) {
        if (count > bestCount || (count === bestCount && ownerToken < bestToken)) {
            bestToken = ownerToken;
            bestCount = count;
        }
    }

    if (bestToken > 0) {
        return bestToken;
    }

    return normalizeAuthorityToken(getSharedDungeonProgressState(scopeKey)?.authorityToken);
}

export function hasSharedDungeonProgressHostiles(levelScope: string | null | undefined): boolean {
    const scopeKey = String(levelScope ?? '').trim();
    if (!scopeKey) {
        return false;
    }

    return getSharedDungeonProgressTotals(scopeKey).total > 0;
}

export function noteSharedDungeonHostileState(levelScope: string | null | undefined, entityId: number, entity: any): void {
    if (!entityId || !isSharedDungeonTrackedHostile(entity)) {
        return;
    }

    const state = getOrCreateSharedDungeonProgressState(levelScope);
    if (!state) {
        return;
    }

    state.trackedHostileIds?.add(entityId);
    if (isEntityDefeated(entity)) {
        state.defeatedHostileIds?.add(entityId);
    } else {
        state.defeatedHostileIds?.delete(entityId);
    }
}

export function noteSharedDungeonHostileDestroyed(levelScope: string | null | undefined, entityId: number, entity: any): void {
    if (!entityId || !isSharedDungeonTrackedHostile(entity)) {
        return;
    }

    const state = getOrCreateSharedDungeonProgressState(levelScope);
    if (!state) {
        return;
    }

    state.trackedHostileIds?.add(entityId);
    if (isEntityDefeated(entity)) {
        state.defeatedHostileIds?.add(entityId);
    }
}

export function getSharedDungeonProgressTotals(
    levelScope: string | null | undefined
): { total: number; defeated: number } {
    const scopeKey = String(levelScope ?? '').trim();
    if (!scopeKey) {
        return { total: 0, defeated: 0 };
    }

    const state = getOrCreateSharedDungeonProgressState(scopeKey);
    if (!state) {
        return { total: 0, defeated: 0 };
    }

    const tracked = state.trackedHostileIds ?? new Set<number>();
    const defeated = state.defeatedHostileIds ?? new Set<number>();
    const levelMap = GlobalState.levelEntities.get(scopeKey);

    for (const [entityId, entity] of levelMap?.entries() ?? []) {
        if (!isSharedDungeonTrackedHostile(entity)) {
            continue;
        }

        tracked.add(entityId);
        if (isEntityDefeated(entity)) {
            defeated.add(entityId);
        } else {
            defeated.delete(entityId);
        }
    }

    let defeatedCount = 0;
    for (const entityId of defeated.values()) {
        if (tracked.has(entityId)) {
            defeatedCount++;
        }
    }

    return {
        total: tracked.size,
        defeated: defeatedCount
    };
}

export function recomputeSharedDungeonProgress(levelScope: string | null | undefined): SharedDungeonProgressState | null {
    const state = getOrCreateSharedDungeonProgressState(levelScope);
    if (!state) {
        return null;
    }

    const totals = getSharedDungeonProgressTotals(levelScope);
    const levelName = getScopeLevelName(levelScope);
    let computedProgress = 0;
    if (usesSharedDungeonProgress(levelName)) {
        // Goblin River keeps the best live shared percent and only raises the floor
        // from canonical hostile state so tutorial-driven client progress never regresses.
        computedProgress = totals.total > 0
            ? clampProgress(GOBLIN_RIVER_INITIAL_PROGRESS + ((totals.defeated / totals.total) * (100 - GOBLIN_RIVER_INITIAL_PROGRESS)))
            : GOBLIN_RIVER_INITIAL_PROGRESS;
        state.progress = Math.max(state.progress, computedProgress);
        return state;
    }

    computedProgress = totals.total > 0
        ? clampProgress((totals.defeated / totals.total) * 100)
        : 0;
    state.progress = Math.max(state.progress, computedProgress);
    return state;
}

export function promoteSharedDungeonProgressState(
    levelScope: string | null | undefined,
    progress: number,
    authorityToken?: number
): SharedDungeonProgressState | null {
    const state = getOrCreateSharedDungeonProgressState(levelScope);
    if (!state) {
        return null;
    }

    state.progress = Math.max(state.progress, clampProgress(progress));
    const normalizedAuthorityToken = normalizeAuthorityToken(authorityToken);
    if (normalizedAuthorityToken > 0) {
        state.authorityToken = normalizedAuthorityToken;
    }

    return state;
}

export function setSharedDungeonProgressState(
    levelScope: string | null | undefined,
    progress: number,
    authorityToken?: number
): SharedDungeonProgressState | null {
    const state = getOrCreateSharedDungeonProgressState(levelScope);
    if (!state) {
        return null;
    }

    state.progress = clampProgress(progress);
    const normalizedAuthorityToken = normalizeAuthorityToken(authorityToken);
    if (normalizedAuthorityToken > 0) {
        state.authorityToken = normalizedAuthorityToken;
    }

    return state;
}

export function noteSharedDungeonStartedRoomIds(
    levelScope: string | null | undefined,
    roomIds: Iterable<number> | null | undefined
): SharedDungeonProgressState | null {
    const state = getOrCreateSharedDungeonProgressState(levelScope);
    if (!state) {
        return null;
    }

    const startedRoomIds = state.startedRoomIds ?? new Set<number>();
    for (const roomId of normalizeStartedRoomIds(roomIds)) {
        startedRoomIds.add(roomId);
    }
    state.startedRoomIds = startedRoomIds;
    return state;
}

export function noteSharedDungeonRoomPacketSnapshot(
    levelScope: string | null | undefined,
    packetId: number,
    roomId: number,
    payload: Buffer
): SharedDungeonProgressState | null {
    const state = getOrCreateSharedDungeonProgressState(levelScope);
    if (!state) {
        return null;
    }

    const normalizedRoomId = normalizeRoomId(roomId);
    const normalizedPacketId = Number(packetId ?? 0);
    if (normalizedRoomId === undefined || !Number.isFinite(normalizedPacketId) || normalizedPacketId <= 0) {
        return state;
    }

    const clonedPayload = payload ? Buffer.from(payload) : null;
    if (!clonedPayload || !clonedPayload.length) {
        return state;
    }

    const snapshots = state.roomPacketSnapshots ?? new Map<string, { packetId: number; roomId: number; payload: Buffer; seq: number }>();
    const seq = normalizeRoomPacketSequence(state.roomPacketSequence) + 1;
    snapshots.set(`seq:${seq}`, {
        packetId: Math.round(normalizedPacketId),
        roomId: normalizedRoomId,
        payload: clonedPayload,
        seq
    });

    state.roomPacketSnapshots = snapshots;
    state.roomPacketSequence = seq;
    return state;
}

export function getSharedDungeonRoomPacketSnapshots(
    levelScope: string | null | undefined
): Array<{ packetId: number; roomId: number; payload: Buffer; seq: number }> {
    const state = getSharedDungeonProgressState(levelScope);
    if (!state?.roomPacketSnapshots) {
        return [];
    }

    return Array.from(state.roomPacketSnapshots.values())
        .map((snapshot) => ({
            packetId: snapshot.packetId,
            roomId: snapshot.roomId,
            payload: Buffer.from(snapshot.payload),
            seq: snapshot.seq
        }))
        .sort((left, right) => left.seq - right.seq);
}

export function setSharedDungeonTrackerMissionSnapshot(
    levelScope: string | null | undefined,
    missionId: number,
    missionState: number,
    missionProgress: number
): SharedDungeonProgressState | null {
    const state = getOrCreateSharedDungeonProgressState(levelScope);
    if (!state) {
        return null;
    }

    const normalizedMissionId = normalizeMissionId(missionId);
    const normalizedMissionState = normalizeMissionState(missionState);
    state.trackerMissionId = normalizedMissionId;
    state.trackerMissionState = normalizedMissionState;
    state.trackerMissionProgress = normalizedMissionId > 0 && normalizedMissionState > 0
        ? normalizeTrackerMissionProgress(missionProgress)
        : 0;

    if (!normalizedMissionId || !normalizedMissionState) {
        state.trackerMissionId = 0;
        state.trackerMissionState = 0;
        state.trackerMissionProgress = 0;
    }

    return state;
}

export function clearSharedDungeonTrackerMissionSnapshot(
    levelScope: string | null | undefined
): SharedDungeonProgressState | null {
    return setSharedDungeonTrackerMissionSnapshot(levelScope, 0, 0, 0);
}

export function setSharedDungeonActiveCutscene(
    levelScope: string | null | undefined,
    roomId: number,
    allowInput: boolean,
    activeUntil: number
): SharedDungeonProgressState | null {
    const state = getOrCreateSharedDungeonProgressState(levelScope);
    if (!state) {
        return null;
    }

    state.activeCutsceneRoomId = normalizeRoomId(roomId);
    state.activeCutsceneAllowInput = Boolean(allowInput);
    state.activeCutsceneUntil = normalizeCutsceneUntil(activeUntil);

    if (!state.activeCutsceneUntil) {
        state.activeCutsceneRoomId = undefined;
        state.activeCutsceneAllowInput = undefined;
    }

    return state;
}

export function clearSharedDungeonActiveCutscene(
    levelScope: string | null | undefined
): SharedDungeonProgressState | null {
    const state = getOrCreateSharedDungeonProgressState(levelScope);
    if (!state) {
        return null;
    }

    state.activeCutsceneRoomId = undefined;
    state.activeCutsceneAllowInput = undefined;
    state.activeCutsceneUntil = 0;
    return state;
}
