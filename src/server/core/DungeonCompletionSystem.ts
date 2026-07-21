import type { Client } from './Client';
import { DungeonCompletionConditions } from './DungeonCompletionConditions';
import type {
    DungeonCompletionCondition,
    DungeonCompletionEvaluation,
    DungeonCompletionRunState
} from './DungeonCompletionTypes';
import { EntityState, EntityTeam } from './Entity';
import { GlobalState } from './GlobalState';
import { getClientLevelScope, getScopeLevelName } from './LevelScope';
import { getSharedDungeonProgressTotals } from './SharedDungeonProgress';
import { TutorialDungeonMechanics } from './TutorialDungeonMechanics';
import { getRoomBossAwareRoomId } from './RoomBossState';
import { LevelConfig } from './LevelConfig';

const CUTSCENE_OBJECTIVE_REORDER_TOLERANCE_MS = 15_000;

function getEntityId(entity: any): number {
    return Math.max(0, Math.round(Number(entity?.id ?? entity?.canonicalId ?? entity?.entId ?? entity?.EntityID ?? 0)));
}

function isDefeated(entity: any): boolean {
    return Boolean(entity?.dead || entity?.destroyed) ||
        Number(entity?.hp ?? 1) <= 0 ||
        Number(entity?.entState ?? EntityState.ACTIVE) === EntityState.DEAD ||
        Number(entity?.entState ?? EntityState.ACTIVE) === 6;
}

function normalizeEntityName(entity: any): string {
    return String(
        entity?.name ??
        entity?.EntName ??
        entity?.entName ??
        entity?.displayName ??
        ''
    )
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

const IGNORED_FULL_CLEAR_ENTITIES_BY_LEVEL: Record<string, ReadonlySet<string>> = {
    CH_MiniMission1: new Set([
        'vigilwaterfall',
        'vigilstraight'
    ]),

    CH_MiniMission2: new Set([
        'vigilmeteordown',
        'vigilflameup'
    ]),

    CH_MiniMission3: new Set([
        'vigilflameup',
        'vigilstraight'
    ]),

    CH_MiniMission4: new Set([
        'vigilstraight',
        'vigilflameup',
        'vigilflamedown'
    ]),

    CH_MiniMission5: new Set([
        'vigilflame',
        'vigilmeteordown'
    ]),

    CH_MiniMission6: new Set([
    ]),

    CH_MiniMission7: new Set([
        'vigilflameup',
        'vigilflamedown',
        'vigilstraight',
        'vigilflame',
        'greaterskeletonclub'
    ]),

    CH_MiniMission8: new Set([
        'yellowghostknight',
        'greaterskeletonsorcerer',
        'vigilmeteordown'
    ]),

    CH_MiniMission9: new Set([
        'greaterskeletonfist'
        
    ])
};

function isTrackableHostile(
    entity: any,
    levelName: string = ''
): boolean {
    if (
        !entity ||
        Boolean(entity.isPlayer) ||
        Number(entity.team ?? 0) !== EntityTeam.ENEMY ||
        Boolean(entity.untargetable)
    ) {
        return false;
    }

    const normalizedLevel = String(levelName ?? '').trim();
    const normalizedName = normalizeEntityName(entity);

    if (
        IGNORED_FULL_CLEAR_ENTITIES_BY_LEVEL[normalizedLevel]
            ?.has(normalizedName)
    ) {
        return false;
    }

    return true;
}

function createRunState(levelScope: string, levelName: string, now: number): DungeonCompletionRunState {
    return {
        levelScope,
        levelName,
        phase: 'running',
        createdAt: now,
        updatedAt: now,
        defeatedBosses: new Set<string>(),
        defeatedBossAt: new Map<string, number>(),
        destroyedObjectives: new Set<string>(),
        defeatedHostileIds: new Set<number>(),
        processedDeathEvents: new Set<string>(),
        clientCompletionSignals: new Map<string, number>(),
        eventSequence: 0,
        cutsceneRoomId: 0,
        cutsceneStartedAt: 0,
        cutsceneEndedAt: 0,
        cutsceneStartedSequence: 0,
        cutsceneEndedSequence: 0,
        cutscenesByRoom: new Map(),
        objectiveRoomIds: new Set(),
        objectivesMetAt: 0,
        objectivesMetSequence: 0,
        cutsceneFallbackReleasedAt: 0,
        cutsceneFallbackSequence: 0,
        cutsceneFallbackReason: '',
        readyAt: 0,
        finalizingParticipants: new Set<string>(),
        completedParticipants: new Set<string>(),
        enrolledParticipants: new Set<string>(),
        completionRequestCount: 0
    };
}

export class DungeonCompletionSystem {
    static getParticipantKey(client: Pick<Client, 'userId' | 'token' | 'character'>): string {
        const characterName = String(client.character?.name ?? '').trim().toLowerCase();
        const userId = Math.max(0, Math.round(Number(client.userId ?? 0)));
        if (userId > 0 && characterName) {
            return `${userId}:${characterName}`;
        }
        if (characterName) {
            return `character:${characterName}`;
        }
        return `token:${Math.max(0, Math.round(Number(client.token ?? 0)))}`;
    }

    static getState(levelScope: string | null | undefined): DungeonCompletionRunState | null {
        const scope = String(levelScope ?? '').trim();
        return scope ? GlobalState.dungeonCompletions.get(scope) ?? null : null;
    }

    static getOrCreateState(levelScope: string | null | undefined, now: number = Date.now()): DungeonCompletionRunState | null {
        const scope = String(levelScope ?? '').trim();
        const levelName = getScopeLevelName(scope);
        if (!scope || !levelName || !DungeonCompletionConditions.get(levelName)) {
            return null;
        }
        const existing = GlobalState.dungeonCompletions.get(scope);
        if (existing) {
            DungeonCompletionSystem.enrollActiveParticipants(existing);
            return existing;
        }
        const created = createRunState(scope, levelName, now);
        DungeonCompletionSystem.enrollActiveParticipants(created);
        GlobalState.dungeonCompletions.set(scope, created);
        return created;
    }

    private static enrollActiveParticipants(state: DungeonCompletionRunState): void {
        if (state.objectivesMetAt > 0) {
            return;
        }
        for (const session of GlobalState.sessionsByToken.values()) {
            if (session.playerSpawned && session.character && getClientLevelScope(session) === state.levelScope) {
                state.enrolledParticipants.add(DungeonCompletionSystem.getParticipantKey(session));
            }
        }
    }

    static reset(levelScope: string | null | undefined): void {
        const scope = String(levelScope ?? '').trim();
        if (scope) {
            GlobalState.dungeonCompletions.delete(scope);
        }
    }

    static releaseParticipant(client: Client): void {
        const levelScope = getClientLevelScope(client);
        if (!levelScope) {
            return;
        }

        const state = DungeonCompletionSystem.getState(levelScope);
        const participantKey = DungeonCompletionSystem.getParticipantKey(client);
        state?.finalizingParticipants.delete(participantKey);
        for (const [cutsceneKey, cutsceneState] of GlobalState.dungeonCutscenes.entries()) {
            if (!cutsceneKey.startsWith(`${levelScope}:`)) {
                continue;
            }
            cutsceneState.participantKeys?.delete(participantKey);
            cutsceneState.closedParticipantKeys?.delete(participantKey);
        }

        const hasActivePeer = [...GlobalState.sessionsByToken.values()].some((session) =>
            session !== client &&
            session.playerSpawned &&
            Boolean(session.character) &&
            getClientLevelScope(session) === levelScope
        );
        if (hasActivePeer) {
            return;
        }

        GlobalState.dungeonCompletions.delete(levelScope);
        GlobalState.levelQuestProgress.delete(levelScope);
        TutorialDungeonMechanics.resetState(levelScope);
        for (const key of [...GlobalState.dungeonCutscenes.keys()]) {
            if (key.startsWith(`${levelScope}:`)) {
                GlobalState.dungeonCutscenes.delete(key);
            }
        }
    }

    static noteEntityDefeated(levelScope: string, entity: any, now: number = Date.now()): boolean {
        const state = DungeonCompletionSystem.getOrCreateState(levelScope, now);
        if (!state || !entity || Boolean(entity.isPlayer) || !isDefeated(entity)) {
            return false;
        }

        const entityId = getEntityId(entity);
        const lifeNonce = Math.max(0, Math.round(Number(entity?.lifeNonce ?? entity?.deathVersion ?? 0)));
        const canonicalBoss = DungeonCompletionConditions.getCanonicalBossName(state.levelName, entity, state.levelScope);
        const objectiveRole = DungeonCompletionConditions.getObjectiveRole(state.levelName, entity);
        const eventIdentity = canonicalBoss || objectiveRole || String(entity?.name ?? entity?.EntName ?? 'hostile');
        const tutorialAuthority = TutorialDungeonMechanics.isTutorialDungeon(state.levelName)
            ? TutorialDungeonMechanics.getAuthorityEntity(entity)
            : null;
        const tutorialObjectVersion = tutorialAuthority
            ? TutorialDungeonMechanics.getWorldObjectState(state.levelScope, tutorialAuthority.stableId)?.version ?? 0
            : 0;
        const eventKey = tutorialAuthority
            ? `${eventIdentity}:${tutorialAuthority.stableId}:${tutorialObjectVersion}`
            : `${eventIdentity}:${entityId}:${lifeNonce}`;
        if (state.processedDeathEvents.has(eventKey)) {
            DungeonCompletionSystem.evaluate(levelScope, now);
            return false;
        }
        state.processedDeathEvents.add(eventKey);
        state.eventSequence += 1;
        state.updatedAt = now;

        if (entityId > 0 && isTrackableHostile(entity, state.levelName)) {
            state.defeatedHostileIds.add(entityId);
        }
        if (canonicalBoss) {
            state.defeatedBosses.add(canonicalBoss);
            const simultaneousWindowMs = DungeonCompletionConditions.getSimultaneousBossWindowMs(state.levelName);
            if (simultaneousWindowMs > 0 || !state.defeatedBossAt.has(canonicalBoss)) {
                state.defeatedBossAt.set(canonicalBoss, now);
            }
        }
        if (objectiveRole) {
            state.destroyedObjectives.add(objectiveRole);
        }
        if (canonicalBoss || objectiveRole) {
            const objectiveRoomId = getRoomBossAwareRoomId(entity);
            if (objectiveRoomId >= 0) {
                state.objectiveRoomIds.add(objectiveRoomId);
            }
        }
        DungeonCompletionSystem.evaluate(levelScope, now);
        return Boolean(canonicalBoss || objectiveRole || entityId > 0);
    }

    static noteClientCompletionSignal(
        levelScope: string,
        participantKey: string,
        completionPercent: number,
        now: number = Date.now()
    ): void {
        if (Math.max(0, Number(completionPercent ?? 0)) < 100) {
            return;
        }
        const state = DungeonCompletionSystem.getOrCreateState(levelScope, now);
        if (!state || !participantKey) {
            return;
        }
        state.eventSequence += 1;
        state.clientCompletionSignals.set(participantKey, state.eventSequence);
        state.updatedAt = now;
        DungeonCompletionSystem.evaluate(levelScope, now);
    }

    static noteCutsceneStart(
        levelScope: string,
        roomId: number,
        now: number = Date.now(),
        completionEligibleAtStart: boolean = false
    ): void {
        const state = DungeonCompletionSystem.getOrCreateState(levelScope, now);
        if (!state) {
            return;
        }
        state.cutsceneRoomId = Math.max(0, Math.round(Number(roomId ?? 0)));
        state.cutsceneStartedAt = now;
        state.cutsceneEndedAt = 0;
        state.eventSequence += 1;
        state.cutsceneStartedSequence = state.eventSequence;
        state.cutsceneEndedSequence = 0;
        state.cutscenesByRoom.set(state.cutsceneRoomId, {
            roomId: state.cutsceneRoomId,
            startedAt: now,
            endedAt: 0,
            startedSequence: state.cutsceneStartedSequence,
            endedSequence: 0,
            completionEligibleAtStart
        });
        state.updatedAt = now;
        DungeonCompletionSystem.evaluate(levelScope, now);
    }

    static noteCutsceneEnd(levelScope: string, roomId: number, now: number = Date.now()): boolean {
        const state = DungeonCompletionSystem.getOrCreateState(levelScope, now);
        if (!state) {
            return false;
        }
        const endedRoomId = Math.max(0, Math.round(Number(roomId ?? 0)));
        const activeRoomState = state.cutscenesByRoom.get(endedRoomId);
        if (!activeRoomState && state.cutsceneRoomId > 0 && endedRoomId > 0 && state.cutsceneRoomId !== endedRoomId) {
            return false;
        }
        state.eventSequence += 1;
        const roomState = activeRoomState ?? {
            roomId: endedRoomId,
            startedAt: now,
            endedAt: 0,
            startedSequence: state.eventSequence,
            endedSequence: 0,
            completionEligibleAtStart: false
        };
        roomState.endedAt = now;
        roomState.endedSequence = state.eventSequence;
        state.cutscenesByRoom.set(endedRoomId, roomState);
        if (state.cutsceneRoomId === endedRoomId || state.cutsceneRoomId === 0) {
            state.cutsceneRoomId = endedRoomId;
            state.cutsceneStartedAt = roomState.startedAt;
            state.cutsceneStartedSequence = roomState.startedSequence;
            state.cutsceneEndedAt = now;
            state.cutsceneEndedSequence = state.eventSequence;
        }
        state.updatedAt = now;
        return DungeonCompletionSystem.evaluate(levelScope, now).ready;
    }

    static canQueueCompletion(levelScope: string, now: number = Date.now()): boolean {
        const evaluation = DungeonCompletionSystem.evaluate(levelScope, now);
        return evaluation.ready || (
            evaluation.objectivesMet &&
            evaluation.reason === 'cutscene_gate_pending'
        );
    }

    static tryReleaseMissingCutsceneGate(
        levelScope: string,
        graceMs: number,
        now: number = Date.now()
    ): boolean {
        const state = DungeonCompletionSystem.getState(levelScope);
        const condition = state ? DungeonCompletionConditions.get(state.levelName) : null;
        const evaluation = DungeonCompletionSystem.evaluate(levelScope, now);
        if (
            !state ||
            !condition?.cutscene?.requiredAfterObjectives ||
            !evaluation.objectivesMet ||
            evaluation.reason !== 'cutscene_gate_pending' ||
            now < state.objectivesMetAt + Math.max(0, Math.round(Number(graceMs ?? 0)))
        ) {
            return evaluation.ready;
        }

        const hasActiveCutscene = [...state.cutscenesByRoom.values()].some((cutscene) =>
            cutscene.startedAt > 0 && cutscene.endedSequence < cutscene.startedSequence
        );
        if (hasActiveCutscene) {
            return false;
        }

        state.eventSequence += 1;
        state.cutsceneFallbackReleasedAt = now;
        state.cutsceneFallbackSequence = state.eventSequence;
        state.cutsceneFallbackReason = 'missing-start-timeout';
        state.updatedAt = now;
        return DungeonCompletionSystem.evaluate(levelScope, now).ready;
    }

    static forceReleaseActiveCutsceneGate(levelScope: string, now: number = Date.now()): boolean {
        const state = DungeonCompletionSystem.getState(levelScope);
        const condition = state ? DungeonCompletionConditions.get(state.levelName) : null;
        const evaluation = DungeonCompletionSystem.evaluate(levelScope, now);
        if (
            !state ||
            !condition?.cutscene?.requiredAfterObjectives ||
            !evaluation.objectivesMet ||
            evaluation.reason !== 'cutscene_gate_pending'
        ) {
            return evaluation.ready;
        }

        state.eventSequence += 1;
        state.cutsceneFallbackReleasedAt = now;
        state.cutsceneFallbackSequence = state.eventSequence;
        state.cutsceneFallbackReason = 'active-timeout';
        state.updatedAt = now;
        return DungeonCompletionSystem.evaluate(levelScope, now).ready;
    }

    static evaluate(levelScope: string, now: number = Date.now()): DungeonCompletionEvaluation {
        const state = DungeonCompletionSystem.getOrCreateState(levelScope, now);
        const condition = state ? DungeonCompletionConditions.get(state.levelName) : null;
        if (!state || !condition || condition.mode === 'disabled') {
            return { ready: false, phase: 'running', reason: 'disabled_or_unconfigured', objectivesMet: false, gateMet: false };
        }

        DungeonCompletionSystem.recoverDefeatedObjectivesFromScope(state, condition, now);
        const objectivesMet = DungeonCompletionSystem.areObjectivesMet(state, condition);
        if (!objectivesMet) {
            state.phase = 'running';
            return { ready: false, phase: state.phase, reason: 'objectives_pending', objectivesMet: false, gateMet: false };
        }
        if (state.objectivesMetAt <= 0) {
            state.objectivesMetAt = now;
            state.objectivesMetSequence = state.eventSequence;
        }
        const finalizationPhase = state.phase === 'finalizing' || state.phase === 'completed'
            ? state.phase
            : null;
        state.phase = finalizationPhase ?? 'conditions-met';

        const hasClientSignalAfterObjectives = [...state.clientCompletionSignals.values()]
            .some((signalSequence) => signalSequence >= state.objectivesMetSequence);
        if (condition.autoCompleteOnObjectives === false && !hasClientSignalAfterObjectives) {
            if (!finalizationPhase) {
                state.phase = 'waiting-gates';
            }
            return { ready: false, phase: state.phase, reason: 'client_completion_signal_pending', objectivesMet: true, gateMet: false };
        }

        const relevantCutscenes = [...state.cutscenesByRoom.values()];
        const activeSharedCutscene = relevantCutscenes.some((cutscene) =>
            cutscene.startedAt > 0 && cutscene.endedSequence < cutscene.startedSequence
        );
        let gateMet = !activeSharedCutscene;
        if (condition.cutscene?.requiredAfterObjectives) {
            const sharedCutsceneEnded = relevantCutscenes.some((cutscene) =>
                cutscene.startedAt > 0 &&
                cutscene.endedSequence >= cutscene.startedSequence &&
                cutscene.endedAt > 0 &&
                (
                    cutscene.endedSequence > state.objectivesMetSequence ||
                    (
                        cutscene.completionEligibleAtStart &&
                        cutscene.endedAt + CUTSCENE_OBJECTIVE_REORDER_TOLERANCE_MS >= state.objectivesMetAt
                    )
                )
            );
            const fallbackReleased =
                state.cutsceneFallbackReleasedAt > 0 &&
                state.cutsceneFallbackSequence > state.objectivesMetSequence;
            const fallbackOverridesActiveCutscene =
                fallbackReleased && state.cutsceneFallbackReason === 'active-timeout';
            gateMet =
                fallbackOverridesActiveCutscene ||
                (!activeSharedCutscene && (sharedCutsceneEnded || fallbackReleased));
        }
        if (!gateMet) {
            if (!finalizationPhase) {
                state.phase = 'waiting-gates';
            }
            return { ready: false, phase: state.phase, reason: 'cutscene_gate_pending', objectivesMet: true, gateMet: false };
        }

        state.phase = finalizationPhase ?? 'ready';
        if (state.readyAt <= 0) {
            state.readyAt = now;
        }
        state.updatedAt = now;
        return { ready: true, phase: state.phase, reason: 'ready', objectivesMet: true, gateMet: true };
    }

    static tryReserveFinalization(levelScope: string, participantKey: string): boolean {
        const state = DungeonCompletionSystem.getOrCreateState(levelScope);
        if (!state || !participantKey || !DungeonCompletionSystem.evaluate(levelScope).ready) {
            return false;
        }
        if (state.completedParticipants.has(participantKey) || state.finalizingParticipants.has(participantKey)) {
            return false;
        }
        state.finalizingParticipants.add(participantKey);
        state.completionRequestCount += 1;
        state.phase = 'finalizing';
        state.updatedAt = Date.now();
        return true;
    }

    static cancelFinalization(levelScope: string, participantKey: string): void {
        const state = DungeonCompletionSystem.getState(levelScope);
        state?.finalizingParticipants.delete(participantKey);
        if (state && state.phase === 'finalizing' && state.finalizingParticipants.size === 0) {
            state.phase = 'ready';
        }
    }

    static markFinalized(levelScope: string, participantKey: string): void {
        const state = DungeonCompletionSystem.getState(levelScope);
        if (!state || !participantKey) {
            return;
        }
        state.finalizingParticipants.delete(participantKey);
        state.completedParticipants.add(participantKey);
        state.updatedAt = Date.now();

        state.phase = [...state.enrolledParticipants].every((key) => state.completedParticipants.has(key))
            ? 'completed'
            : 'ready';
    }

    static hasFinalized(levelScope: string, participantKey: string): boolean {
        const state = DungeonCompletionSystem.getState(levelScope);
        return Boolean(state && (
            state.completedParticipants.has(participantKey) ||
            state.finalizingParticipants.has(participantKey)
        ));
    }

    static shouldAutoCompleteOnObjectives(levelName: string | null | undefined): boolean {
        return DungeonCompletionConditions.get(levelName)?.autoCompleteOnObjectives !== false;
    }

    private static recoverDefeatedObjectivesFromScope(
        state: DungeonCompletionRunState,
        condition: DungeonCompletionCondition,
        now: number
    ): void {
        const scopeEntities = [...(GlobalState.levelEntities.get(state.levelScope)?.values() ?? [])];
        if (Math.max(0, Number(condition.simultaneousBossWindowMs ?? 0)) > 0) {
            for (const entity of scopeEntities) {
                const canonicalBoss = DungeonCompletionConditions.getCanonicalBossName(state.levelName, entity, state.levelScope);
                if (canonicalBoss && !isDefeated(entity)) {
                    state.defeatedBosses.delete(canonicalBoss);
                    state.defeatedBossAt.delete(canonicalBoss);
                }
            }
        }

        for (const entity of scopeEntities) {
            if (!isDefeated(entity)) {
                continue;
            }
            const canonicalBoss = DungeonCompletionConditions.getCanonicalBossName(state.levelName, entity, state.levelScope);
			
            if (canonicalBoss) {
                state.defeatedBosses.add(canonicalBoss);
                if (!state.defeatedBossAt.has(canonicalBoss)) {
                    state.defeatedBossAt.set(canonicalBoss, now);
                }
            }
            const objectiveRole = DungeonCompletionConditions.getObjectiveRole(state.levelName, entity);
            if (objectiveRole) {
                state.destroyedObjectives.add(objectiveRole);
            }
            if (canonicalBoss || objectiveRole) {
                const objectiveRoomId = getRoomBossAwareRoomId(entity);
                if (objectiveRoomId >= 0) {
                    state.objectiveRoomIds.add(objectiveRoomId);
                }
            }
            const entityId = getEntityId(entity);
            if (entityId > 0 && isTrackableHostile(entity, state.levelName)) {
                state.defeatedHostileIds.add(entityId);
            }
        }

        if (condition.mode === 'bosses' && condition.requirePlayerDamageForClientBosses) {
            for (const canonicalBoss of [...state.defeatedBosses]) {
                const matchingEntity = [...(GlobalState.levelEntities.get(state.levelScope)?.values() ?? [])]
                    .find((entity) => DungeonCompletionConditions.getCanonicalBossName(state.levelName, entity, state.levelScope) === canonicalBoss);
                if (matchingEntity?.clientSpawned && !matchingEntity.playerDamageContributed) {
                    state.defeatedBosses.delete(canonicalBoss);
                    state.defeatedBossAt.delete(canonicalBoss);
                }
            }
        }
    }

    private static areObjectivesMet(state: DungeonCompletionRunState, condition: DungeonCompletionCondition): boolean {
        if (condition.mode === 'client-signal') {
            return state.clientCompletionSignals.size > 0;
        }
        if (condition.mode === 'full-clear') {
            const totals = getSharedDungeonProgressTotals(state.levelScope);

            const entities = [
                ...(GlobalState.levelEntities.get(state.levelScope)?.values() ?? [])
            ];

            const hostiles = entities.filter((entity) =>
                isTrackableHostile(entity, state.levelName)
            );
            const livingHostiles = hostiles.filter((entity) => !isDefeated(entity));

            console.log("========== FULL CLEAR DEBUG ==========");
            console.log("Level:", state.levelName);
            console.log("Scope:", state.levelScope);
            console.log("Shared totals:", {
                defeated: totals.defeated,
                total: totals.total
            });

            console.log(
                "All tracked hostiles:",
                hostiles.map((entity: any) => ({
                    id: getEntityId(entity),
                    name:
                        entity?.name ??
                        entity?.EntName ??
                        entity?.entName ??
                        entity?.displayName ??
                        "unknown",
                    hp: entity?.hp,
                    dead: entity?.dead,
                    destroyed: entity?.destroyed,
                    entState: entity?.entState,
                    team: entity?.team,
                    untargetable: entity?.untargetable,
                    defeated: isDefeated(entity)
                }))
            );

            console.log(
                "Living hostiles blocking completion:",
                livingHostiles.map((entity: any) => ({
                    id: getEntityId(entity),
                    name:
                        entity?.name ??
                        entity?.EntName ??
                        entity?.entName ??
                        entity?.displayName ??
                        "unknown",
                    hp: entity?.hp,
                    dead: entity?.dead,
                    destroyed: entity?.destroyed,
                    entState: entity?.entState,
                    team: entity?.team,
                    untargetable: entity?.untargetable
                }))
            );

            console.log("======================================");

            if (totals.total > 0) {
                return totals.defeated >= totals.total;
            }

            if (hostiles.length > 0) {
                return hostiles.every((entity) => isDefeated(entity));
            }

            return state.clientCompletionSignals.size > 0 &&
                state.defeatedHostileIds.size > 0;
        }
        if (condition.mode !== 'bosses') {
            return false;
        }

        for (const group of condition.bossGroups ?? []) {
            if (!group.some((bossName) => state.defeatedBosses.has(bossName))) {
                return false;
            }
        }
        for (const objective of condition.entityObjectives ?? []) {
            if (!state.destroyedObjectives.has(objective.role)) {
                return false;
            }
        }

        const simultaneousWindowMs = Math.max(0, Math.round(Number(condition.simultaneousBossWindowMs ?? 0)));
        if (simultaneousWindowMs > 0) {
            const times: number[] = [];
            for (const group of condition.bossGroups ?? []) {
                const groupTimes = group
                    .map((bossName) => state.defeatedBossAt.get(bossName) ?? 0)
                    .filter((time) => time > 0);
                if (!groupTimes.length) {
                    return false;
                }
                times.push(Math.max(...groupTimes));
            }
            if (Math.max(...times) - Math.min(...times) > simultaneousWindowMs) {
                return false;
            }
        }
        return true;
    }
}
