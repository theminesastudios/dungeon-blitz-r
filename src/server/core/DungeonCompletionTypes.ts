export type DungeonCompletionMode = 'bosses' | 'objectives' | 'full-clear' | 'client-signal' | 'disabled';

export type DungeonCompletionEntityObjective = {
    names: string[];
    aliases?: string[];
    role: string;
    requiredCount?: number;
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
    requireBossesCurrentlyDefeated?: boolean;
    acceptRoomBossClearSignal?: boolean;
    // When acceptRoomBossClearSignal is true, only a boss-clear (0xAD) reported
    // from one of these rooms may complete the encounter. Needed by multi-part
    // fights like The Capstone, whose intermediate Nephit body has its own
    // BossFight: without scoping, that early clear would finish the dungeon
    // before the final fight ever starts.
    acceptRoomBossClearRooms?: number[];
    autoCompleteOnObjectives?: boolean;
    allowDefeatedBossProxyCopies?: boolean;
    requirePlayerDamageForClientBosses?: boolean;
    requireBossDefeatSignal?: boolean;
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
    // The skit opened over one of the run's bosses, so it is the boss scene
    // rather than an intro cinematic — true even while that boss is still
    // officially alive, which is the state it is in when the scene opens.
    bossSceneAtStart: boolean;
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
    destroyedObjectiveEntityIds: Map<string, Set<number>>;
    defeatedHostileIds: Set<number>;
    processedDeathEvents: Set<string>;
    clientCompletionSignals: Map<string, number>;
    roomBossClearSequence: number;
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
