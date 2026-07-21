export type DungeonCompletionMode = 'bosses' | 'full-clear' | 'client-signal' | 'disabled';

export type DungeonCompletionEntityObjective = {
    names: string[];
    aliases?: string[];
    role: string;
};

export type DungeonCompletionCutsceneCondition = {
    requiredAfterObjectives: boolean;
};

export type DungeonCompletionCondition = {
    mode: DungeonCompletionMode;
    partyHostileSync?: 'all' | 'bosses-only' | 'none';
    bossGroups?: string[][];
    bossAliases?: Record<string, string>;
    entityObjectives?: DungeonCompletionEntityObjective[];
    cutscene?: DungeonCompletionCutsceneCondition;
    simultaneousBossWindowMs?: number;
    autoCompleteOnObjectives?: boolean;
    allowDefeatedBossProxyCopies?: boolean;
    requirePlayerDamageForClientBosses?: boolean;
    clientAuthorityBosses?: string[];
    requireRoomBossMarker?: boolean;
    allowVerifiedClientBossWithoutRoomBossMarker?: boolean;
    allowTerminalCanonicalBossWithoutRoomBossMarker?: boolean;
};

export type DungeonCompletionPhase =
    | 'running'
    | 'conditions-met'
    | 'waiting-gates'
    | 'ready'
    | 'finalizing'
    | 'completed';

export type DungeonCompletionCutsceneState = {
    roomId: number;
    startedAt: number;
    endedAt: number;
    startedSequence: number;
    endedSequence: number;
    completionEligibleAtStart: boolean;
};

export type DungeonCompletionRunState = {
    levelScope: string;
    levelName: string;
    phase: DungeonCompletionPhase;
    createdAt: number;
    updatedAt: number;
    defeatedBosses: Set<string>;
    defeatedBossAt: Map<string, number>;
    destroyedObjectives: Set<string>;
    defeatedHostileIds: Set<number>;
    processedDeathEvents: Set<string>;
    clientCompletionSignals: Map<string, number>;
    eventSequence: number;
    cutsceneRoomId: number;
    cutsceneStartedAt: number;
    cutsceneEndedAt: number;
    cutsceneStartedSequence: number;
    cutsceneEndedSequence: number;
    cutscenesByRoom: Map<number, DungeonCompletionCutsceneState>;
    objectiveRoomIds: Set<number>;
    objectivesMetAt: number;
    objectivesMetSequence: number;
    cutsceneFallbackReleasedAt: number;
    cutsceneFallbackSequence: number;
    cutsceneFallbackReason: '' | 'missing-start-timeout' | 'active-timeout' | 'close-observed';
    readyAt: number;
    finalizingParticipants: Set<string>;
    completedParticipants: Set<string>;
    enrolledParticipants: Set<string>;
    completionRequestCount: number;
};

export type DungeonCompletionEvaluation = {
    ready: boolean;
    phase: DungeonCompletionPhase;
    reason: string;
    objectivesMet: boolean;
    gateMet: boolean;
};
