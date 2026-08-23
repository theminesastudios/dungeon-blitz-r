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
        destroyedObjectiveEntityIds: new Map<string, Set<number>>(),
        defeatedHostileIds: new Set<number>(),
        processedDeathEvents: new Set<string>(),
        clientCompletionSignals: new Map<string, number>(),
        roomBossClearSequence: 0,
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

    // One line naming who buried a hostile, and how.
    //
    // A summon that dies the instant the boss conjures it reaches this function already
    // `dead/destroyed` with no hit ever recorded against it, and nothing in the logs says which
    // path put it there -- merging, a grave, a client destroy, or a health correction all end up
    // looking identical from here. The call stack is the one thing that separates them.
    //
    // Throttled to once per entity so a wave of summons cannot flood a run.
    private static readonly loggedDefeatProvenance = new Set<string>();

    private static logDefeatProvenance(levelScope: string, entity: any): void {
        const entityId = Math.max(0, Math.round(Number(entity?.id ?? 0)));
        const key = `${levelScope}:${entityId}`;
        if (entityId <= 0 || DungeonCompletionSystem.loggedDefeatProvenance.has(key)) {
            return;
        }
        DungeonCompletionSystem.loggedDefeatProvenance.add(key);

        const caller = String(new Error().stack ?? '')
            .split('\n')
            .slice(2, 8)
            .map((line) => line.trim().replace(/^at\s+/, ''))
            .join(' <- ');
        console.log(
            `[DefeatFrom] ${getScopeLevelName(levelScope)} id=${entityId} ` +
            `name=${String(entity?.name ?? '?')} hp=${String(entity?.hp ?? '?')}/${String(entity?.maxHp ?? '?')} ` +
            `dead=${Boolean(entity?.dead)} destroyed=${Boolean(entity?.destroyed)} ` +
            `clientSpawned=${Boolean(entity?.clientSpawned)} from: ${caller}`
        );
    }

    static noteEntityDefeated(levelScope: string, entity: any, now: number = Date.now()): boolean {
        const state = DungeonCompletionSystem.getOrCreateState(levelScope, now);
        if (!state || !entity || Boolean(entity.isPlayer) || !isDefeated(entity)) {
            return false;
        }

        DungeonCompletionSystem.logDefeatProvenance(levelScope, entity);

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

        // Every defeat that reaches the completion system funnels through here,
        // whatever handler reported it. MissionHandler's bossDeathDetected only
        // covers the kills routed via handleForcedDungeonBossCompletion, so a
        // boss dying on any other path left no trace at all. Diffing the two
        // tells you whether a missing boss kill never happened or merely
        // bypassed MissionHandler. Silence with DUNGEON_DIAG=0.
        if (String(process.env.DUNGEON_DIAG ?? '1').trim() !== '0') {
            try {
                console.log(`[DUNGEON-DIAG] defeatRegistered ${JSON.stringify({
                    level: state.levelName,
                    entityId,
                    entityName: String(entity?.name ?? entity?.EntName ?? ''),
                    names: [
                        entity?.name,
                        entity?.EntName,
                        entity?.entName,
                        entity?.characterName,
                        entity?.roomBossName,
                        entity?.displayName
                    ].filter((value) => String(value ?? '').trim().length > 0),
                    canonicalBoss,
                    objectiveRole,
                    maxHp: entity?.maxHp,
                    clientSpawned: Boolean(entity?.clientSpawned)
                })}`);
            } catch {
                console.log('[DUNGEON-DIAG] defeatRegistered <unserializable>');
            }
        }

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
            const destroyedIds = state.destroyedObjectiveEntityIds.get(objectiveRole) ?? new Set<number>();
            if (entityId > 0) {
                destroyedIds.add(entityId);
            }
            state.destroyedObjectiveEntityIds.set(objectiveRole, destroyedIds);
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

    static noteRoomBossClear(levelScope: string, roomId: number, now: number = Date.now()): boolean {
        const state = DungeonCompletionSystem.getOrCreateState(levelScope, now);
        const condition = state ? DungeonCompletionConditions.get(state.levelName) : null;
        if (
            !state ||
            !condition ||
            condition.mode !== 'bosses' ||
            !DungeonCompletionConditions.acceptsRoomBossClearSignal(state.levelName)
        ) {
            return false;
        }

        // BossFight sends this only after every boss slot in the room has
        // reached zero HP. Some cue-owned bosses never publish full entities to
        // the server, so this authored room signal is the only canonical proof
        // that the whole double-boss encounter has ended.
        state.eventSequence += 1;
        state.roomBossClearSequence = state.eventSequence;
        for (const group of condition.bossGroups ?? []) {
            const canonicalBoss = group[0];
            if (!canonicalBoss) {
                continue;
            }
            state.defeatedBosses.add(canonicalBoss);
            state.defeatedBossAt.set(canonicalBoss, now);
        }
        const normalizedRoomId = Math.max(0, Math.round(Number(roomId ?? 0)));
        if (normalizedRoomId > 0) {
            state.objectiveRoomIds.add(normalizedRoomId);
        }
        state.updatedAt = now;

        const evaluation = DungeonCompletionSystem.evaluate(levelScope, now);
        if (String(process.env.DUNGEON_DIAG ?? '1').trim() !== '0') {
            console.log(`[DUNGEON-DIAG] roomBossClearAccepted ${JSON.stringify({
                level: state.levelName,
                roomId: normalizedRoomId,
                defeatedBosses: [...state.defeatedBosses],
                objectivesMet: evaluation.objectivesMet,
                reason: evaluation.reason
            })}`);
        }
        return evaluation.objectivesMet;
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
        completionEligibleAtStart: boolean = false,
        bossSceneAtStart: boolean = false
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
            completionEligibleAtStart,
            bossSceneAtStart
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
            completionEligibleAtStart: false,
            // A close with no start on record says nothing about what the skit
            // was playing over, so it does not get the boss-scene exemption.
            bossSceneAtStart: false
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

    // True once a cutscene in this run has been seen to close: either the client
    // reported the skit ending, or a close was recognised late as the fallback
    // that released the gate. This is the "the dialogue is over" fact the rank
    // plate is meant to follow.
    //
    // Deliberately false for a run that never played a cutscene at all — those
    // still have closing chatter with nothing gating it, which is what the
    // skit-settle window is for. So this only ever removes a wait the cutscene
    // itself has already made unnecessary.
    static hasObservedCutsceneEnd(levelScope: string): boolean {
        const state = DungeonCompletionSystem.getState(levelScope);
        if (!state) {
            return false;
        }
        if (state.cutsceneFallbackReason === 'close-observed') {
            return true;
        }

        for (const cutscene of state.cutscenesByRoom.values()) {
            if (
                cutscene.startedAt > 0 &&
                cutscene.endedAt > 0 &&
                cutscene.endedSequence >= cutscene.startedSequence
            ) {
                return true;
            }
        }

        return false;
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

    // The caller's cinematic timeout is the hard safety net for a skit that never
    // reports its close. It must apply to every level that stalls on the cutscene
    // gate, not only the ones flagged `cutscene.requiredAfterObjectives`: a level
    // without that flag still blocks on an active cutscene, and used to have no
    // way out at all if the closing packet was lost (e.g. Ring of Fire).
    static forceReleaseActiveCutsceneGate(levelScope: string, now: number = Date.now()): boolean {
        const state = DungeonCompletionSystem.getState(levelScope);
        const evaluation = DungeonCompletionSystem.evaluate(levelScope, now);
        if (
            !state ||
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

    // An observed cutscene close is the client saying "the skit finished and the
    // cinematic is gone". Once the objectives are met there is nothing left the
    // gate can legitimately be waiting for, so the close releases it outright
    // instead of leaving the run to burn the 120s cinematic safety net. This
    // also covers a run whose shared state still carries a cutscene marked
    // active because its own close was booked against another room.
    static releaseCutsceneGateOnClose(levelScope: string, now: number = Date.now()): boolean {
        const state = DungeonCompletionSystem.getState(levelScope);
        const evaluation = DungeonCompletionSystem.evaluate(levelScope, now);
        if (
            !state ||
            !evaluation.objectivesMet ||
            evaluation.reason !== 'cutscene_gate_pending'
        ) {
            return evaluation.ready;
        }

        state.eventSequence += 1;
        state.cutsceneFallbackReleasedAt = now;
        state.cutsceneFallbackSequence = state.eventSequence;
        state.cutsceneFallbackReason = 'close-observed';
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
            DungeonCompletionSystem.logPendingObjectives(state, condition, now);
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
        // An `active-timeout` release means the caller waited out its cinematic
        // safety net, and a `close-observed` release means the client reported the
        // skit closing, so a cutscene still marked active is a lost/misrouted close
        // packet rather than a skit on screen. Both must be honoured even when the
        // level does not require a post-objective cutscene, otherwise the run stays
        // gated forever with no fallback.
        const activeCutsceneOverridden =
            state.cutsceneFallbackReleasedAt > 0 &&
            state.cutsceneFallbackSequence > state.objectivesMetSequence &&
            (
                state.cutsceneFallbackReason === 'active-timeout' ||
                state.cutsceneFallbackReason === 'close-observed'
            );
        let gateMet = !activeSharedCutscene || activeCutsceneOverridden;
        if (condition.cutscene?.requiredAfterObjectives) {
            // The ending skit usually closes after the last objective is
            // registered, and its sequence alone settles this. The reorder
            // tolerance is for when it does not, because the boss reports its own
            // death through the client and that packet can land after the close
            // that played over it — the skit that ended the run is then sequenced
            // before the run was complete.
            //
            // `completionEligibleAtStart` recognised that only when the run was
            // already completable as the skit opened. A boss scene never is: the
            // boss is officially alive when its own scene opens, which is why a
            // Dread run's real ending skit went uncounted and the dungeon sat out
            // the cutscene-start grace with its dialogue already over.
            // `bossSceneAtStart` covers that without widening the rule to intro
            // cinematics, which resolve no boss and stay excluded.
            const sharedCutsceneEnded = relevantCutscenes.some((cutscene) =>
                cutscene.startedAt > 0 &&
                cutscene.endedSequence >= cutscene.startedSequence &&
                cutscene.endedAt > 0 &&
                (
                    cutscene.endedSequence > state.objectivesMetSequence ||
                    (
                        (cutscene.completionEligibleAtStart || cutscene.bossSceneAtStart) &&
                        cutscene.endedAt + CUTSCENE_OBJECTIVE_REORDER_TOLERANCE_MS >= state.objectivesMetAt
                    )
                )
            );
            const fallbackReleased =
                state.cutsceneFallbackReleasedAt > 0 &&
                state.cutsceneFallbackSequence > state.objectivesMetSequence;
            const fallbackOverridesActiveCutscene = fallbackReleased && (
                state.cutsceneFallbackReason === 'active-timeout' ||
                state.cutsceneFallbackReason === 'close-observed'
            );
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

    // "I killed the boss and nothing happened" is otherwise invisible: the run
    // just sits on objectives_pending with no record of what it is still waiting
    // for. Name the missing bosses and objectives, and dump every boss-named
    // entity the scope holds with its life state, so a duplicate boss (two
    // entities, only one of them dying) is obvious from one line. Throttled so a
    // stuck run does not flood the log. Silence with DUNGEON_DIAG=0.
    private static lastPendingObjectiveLogAt = new Map<string, number>();

    private static logPendingObjectives(
        state: DungeonCompletionRunState,
        condition: DungeonCompletionCondition,
        now: number
    ): void {
        if (String(process.env.DUNGEON_DIAG ?? '1').trim() === '0' || condition.mode !== 'bosses') {
            return;
        }
        const lastLoggedAt = DungeonCompletionSystem.lastPendingObjectiveLogAt.get(state.levelScope) ?? 0;
        if (now - lastLoggedAt < 5_000) {
            return;
        }
        DungeonCompletionSystem.lastPendingObjectiveLogAt.set(state.levelScope, now);

        const missingBossGroups = (condition.bossGroups ?? [])
            .filter((group) => !group.some((bossName) => state.defeatedBosses.has(bossName)));
        const missingObjectives = (condition.entityObjectives ?? [])
            .filter((objective) => !state.destroyedObjectives.has(objective.role))
            .map((objective) => objective.role);
        if (!missingBossGroups.length && !missingObjectives.length) {
            return;
        }

        const bossNamedEntities = [...(GlobalState.levelEntities.get(state.levelScope)?.values() ?? [])]
            .filter((entity) => Boolean(
                DungeonCompletionConditions.getCanonicalBossName(state.levelName, entity, state.levelScope)
            ) || DungeonCompletionConditions.getObjectiveRole(state.levelName, entity))
            .map((entity: any) => ({
                id: getEntityId(entity),
                name: String(entity?.name ?? entity?.EntName ?? ''),
                canonical: DungeonCompletionConditions.getCanonicalBossName(state.levelName, entity, state.levelScope),
                role: DungeonCompletionConditions.getObjectiveRole(state.levelName, entity),
                hp: entity?.hp,
                maxHp: entity?.maxHp,
                dead: Boolean(entity?.dead),
                destroyed: Boolean(entity?.destroyed),
                entState: entity?.entState,
                roomId: entity?.roomId,
                clientSpawned: Boolean(entity?.clientSpawned),
                ownerToken: entity?.ownerToken,
                defeated: isDefeated(entity)
            }));

        try {
            console.log(`[DUNGEON-DIAG] objectivesPending ${JSON.stringify({
                level: state.levelName,
                scope: state.levelScope,
                missingBossGroups,
                missingObjectives,
                defeatedBosses: [...state.defeatedBosses],
                destroyedObjectives: [...state.destroyedObjectives],
                bossNamedEntities
            })}`);
        } catch {
            console.log('[DUNGEON-DIAG] objectivesPending <unserializable>');
        }
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
        if (
            state.roomBossClearSequence <= 0 &&
            (
                condition.requireBossesCurrentlyDefeated ||
                Math.max(0, Number(condition.simultaneousBossWindowMs ?? 0)) > 0
            )
        ) {
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
                const entityId = getEntityId(entity);
                const destroyedIds = state.destroyedObjectiveEntityIds.get(objectiveRole) ?? new Set<number>();
                if (entityId > 0) {
                    destroyedIds.add(entityId);
                }
                state.destroyedObjectiveEntityIds.set(objectiveRole, destroyedIds);
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
        if (condition.mode === 'objectives') {
            const objectives = condition.entityObjectives ?? [];
            const entities = [...(GlobalState.levelEntities.get(state.levelScope)?.values() ?? [])];
            return objectives.length > 0 && objectives.every((objective) => {
                const requiredCount = Math.max(1, Math.round(Number(objective.requiredCount ?? 1)));
                const destroyedCount = state.destroyedObjectiveEntityIds?.get(objective.role)?.size ?? 0;
                if (destroyedCount < requiredCount) {
                    return false;
                }
                return entities
                    .filter((entity) =>
                        DungeonCompletionConditions.getObjectiveRole(state.levelName, entity) === objective.role
                    )
                    .every((entity) => isDefeated(entity));
            });
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

            if (String(process.env.DUNGEON_DIAG ?? '0').trim() === '1') {
                console.log('[DUNGEON-DIAG] fullClearState', {
                    level: state.levelName,
                    scope: state.levelScope,
                    sharedTotals: {
                        defeated: totals.defeated,
                        total: totals.total
                    },
                    hostiles: hostiles.map((entity: any) => ({
                        id: getEntityId(entity),
                        name: entity?.name ?? entity?.EntName ?? entity?.entName ?? entity?.displayName ?? 'unknown',
                        hp: entity?.hp,
                        dead: entity?.dead,
                        destroyed: entity?.destroyed,
                        entState: entity?.entState,
                        defeated: isDefeated(entity)
                    })),
                    livingHostileIds: livingHostiles.map((entity) => getEntityId(entity))
                });
            }

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
