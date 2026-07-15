import { Client } from './Client';
import { EntityState, EntityTeam } from './Entity';
import { GlobalState } from './GlobalState';
import { getClientLevelScope, getScopeLevelName } from './LevelScope';

export type TutorialDungeonMechanicEvent =
    | 'early_chain_broken'
    | 'dummy_one_defeated'
    | 'dummy_two_defeated'
    | 'dummy_three_defeated'
    | 'tutorial_chest_opened'
    | 'boss_chest_opened'
    | 'boss_intro_started'
    | 'boss_wave_80'
    | 'boss_wave_50'
    | 'boss_wave_33'
    | 'boss_defeated'
    | 'anna_freed';

export type TutorialDungeonAuthorityRole =
    | 'early_chain'
    | 'dummy'
    | 'tutorial_chest'
    | 'boss'
    | 'boss_chest'
    | 'anna_chain'
    | 'anna';

export type TutorialDungeonObjectLifecycle = 'active' | 'destroyed' | 'opened';
export type TutorialDungeonCutscenePhase = 'not-started' | 'active' | 'completed';
export type TutorialDungeonCompletionPhase = 'running' | 'waiting-gates' | 'ready' | 'completed';

export type TutorialDungeonAuthorityEntity = {
    id: number;
    stableId: string;
    name: string;
    role: TutorialDungeonAuthorityRole;
    sourceRoom: string;
    sourceVar: string;
    roomId: number;
    x: number;
    y: number;
    requiredForCompletion?: boolean;
    boss?: boolean;
    displayName?: string;
};

export type TutorialDungeonWorldObjectState = {
    stableId: string;
    exportedId: number;
    entityType: string;
    role: TutorialDungeonAuthorityRole;
    roomId: number;
    sourceRoom: string;
    sourceVar: string;
    x: number;
    y: number;
    lifecycle: TutorialDungeonObjectLifecycle;
    version: number;
    updatedAt: number;
    actorToken: number;
};

export type TutorialDungeonWorldSnapshot = {
    levelScope: string;
    revision: number;
    objects: Record<string, TutorialDungeonWorldObjectState>;
    parrotFreed: boolean;
    annaFreed: boolean;
    room2GateOpen: boolean;
    room2CollisionDisabled: boolean;
    bossHp: number;
    bossMaxHp: number;
    bossHpVersion: number;
    bossDeathVersion: number;
    bossDefeated: boolean;
    bossTombstoned: boolean;
    bossWave80: boolean;
    bossWave50: boolean;
    bossWave33: boolean;
    cutscenePhase: TutorialDungeonCutscenePhase;
    cutsceneRoomId: number;
    completionPhase: TutorialDungeonCompletionPhase;
};

export type TutorialDungeonMechanicsState = {
    levelScope: string;
    revision: number;
    updatedAt: number;
    objects: Map<string, TutorialDungeonWorldObjectState>;
    earlyChainsBroken: boolean;
    parrotFreed: boolean;
    dummyOneDefeated: boolean;
    dummyTwoDefeated: boolean;
    dummyThreeDefeated: boolean;
    room2GateOpen: boolean;
    room2CollisionDisabled: boolean;
    tutorialChestOpened: boolean;
    bossChestOpened: boolean;
    bossIntroStarted: boolean;
    bossWave80: boolean;
    bossWave50: boolean;
    bossWave33: boolean;
    bossHp: number;
    bossMaxHp: number;
    bossHpVersion: number;
    bossDeathVersion: number;
    bossDefeated: boolean;
    bossTombstoned: boolean;
    annaFreed: boolean;
    cutscenePhase: TutorialDungeonCutscenePhase;
    cutsceneRoomId: number;
    completionPhase: TutorialDungeonCompletionPhase;
    defeatedEntityIds: Set<number>;
    rewardClaims: Set<string>;
    chestEligibleRecipients: Map<string, Set<string>>;
    events: TutorialDungeonMechanicEvent[];
};

export type TutorialDungeonObjectTransition = {
    accepted: boolean;
    dedupe: boolean;
    reason: string;
    authority: TutorialDungeonAuthorityEntity | null;
    previousState: TutorialDungeonObjectLifecycle | 'unknown';
    nextState: TutorialDungeonObjectLifecycle | 'unknown';
    revision: number;
    events: TutorialDungeonMechanicEvent[];
};

const TUTORIAL_DUNGEON = 'TutorialDungeon';

const AUTHORITY_ENTITIES: readonly TutorialDungeonAuthorityEntity[] = [
    {
        id: 3268190,
        stableId: 'TutorialDungeon|room:1|var:am_Chains|type:Chains02|id:3268190|pos:1327:1880',
        name: 'Chains02', role: 'early_chain', sourceRoom: 'a_Room_Tutorial_01', sourceVar: 'am_Chains',
        roomId: 1, x: 1327, y: 1880
    },
    {
        id: 4841054,
        stableId: 'TutorialDungeon|room:2|var:am_Dummy1|type:IntroDummy1|id:4841054|pos:4000:2099',
        name: 'IntroDummy1', role: 'dummy', sourceRoom: 'a_Room_Tutorial_02', sourceVar: 'am_Dummy1',
        roomId: 2, x: 4000, y: 2099
    },
    {
        id: 4906590,
        stableId: 'TutorialDungeon|room:2|var:am_Dummy2|type:IntroDummy2|id:4906590|pos:4000:2099',
        name: 'IntroDummy2', role: 'dummy', sourceRoom: 'a_Room_Tutorial_02', sourceVar: 'am_Dummy2',
        roomId: 2, x: 4000, y: 2099
    },
    {
        id: 4972126,
        stableId: 'TutorialDungeon|room:2|var:am_Dummy3|type:IntroDummy3|id:4972126|pos:4000:2099',
        name: 'IntroDummy3', role: 'dummy', sourceRoom: 'a_Room_Tutorial_02', sourceVar: 'am_Dummy3',
        roomId: 2, x: 4000, y: 2099
    },
    {
        id: 4709982,
        stableId: 'TutorialDungeon|room:5|var:am_WaveBoss|type:TreasureChestEmpty|id:4709982|pos:11228:2381',
        name: 'TreasureChestEmpty', role: 'tutorial_chest', sourceRoom: 'a_Room_Tutorial_05_ALT', sourceVar: 'am_WaveBoss',
        roomId: 5, x: 11228, y: 2381
    },
    {
        id: 3989086,
        stableId: 'TutorialDungeon|room:11|var:__id462_|type:TreasureChestEmpty|id:3989086|pos:22832:2959',
        name: 'TreasureChestEmpty', role: 'boss_chest', sourceRoom: 'a_Room_NRM02RGoblinCaveBoss', sourceVar: '__id462_',
        roomId: 11, x: 22832, y: 2959
    },
    {
        id: 3858014,
        stableId: 'TutorialDungeon|room:11|var:am_Anna|type:NPCAnna|id:3858014|pos:22716:2959',
        name: 'NPCAnna', role: 'anna', sourceRoom: 'a_Room_NRM02RGoblinCaveBoss', sourceVar: 'am_Anna',
        roomId: 11, x: 22716, y: 2959
    },
    {
        id: 3923550,
        stableId: 'TutorialDungeon|room:11|var:am_Boss|type:GoblinBoss1|id:3923550|pos:22695:2959',
        name: 'GoblinBoss1', role: 'boss', sourceRoom: 'a_Room_NRM02RGoblinCaveBoss', sourceVar: 'am_Boss',
        roomId: 11, x: 22695, y: 2959, requiredForCompletion: true, boss: true, displayName: 'Tag Ugo'
    },
    {
        id: 4054622,
        stableId: 'TutorialDungeon|room:11|var:am_Chains|type:Chains03|id:4054622|pos:22721:2959',
        name: 'Chains03', role: 'anna_chain', sourceRoom: 'a_Room_NRM02RGoblinCaveBoss', sourceVar: 'am_Chains',
        roomId: 11, x: 22721, y: 2959, requiredForCompletion: true
    }
] as const;

const AUTHORITY_BY_ID = new Map<number, TutorialDungeonAuthorityEntity>(
    AUTHORITY_ENTITIES.map((entry) => [entry.id, entry])
);
const AUTHORITY_BY_STABLE_ID = new Map<string, TutorialDungeonAuthorityEntity>(
    AUTHORITY_ENTITIES.map((entry) => [entry.stableId, entry])
);
const AUTHORITY_BY_NAME = new Map<string, TutorialDungeonAuthorityEntity[]>();
for (const entry of AUTHORITY_ENTITIES) {
    const key = normalizeName(entry.name);
    const bucket = AUTHORITY_BY_NAME.get(key) ?? [];
    bucket.push(entry);
    AUTHORITY_BY_NAME.set(key, bucket);
}

function normalizeName(value: unknown): string {
    return String(value ?? '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function getEntityId(entity: any): number {
    return Math.max(0, Math.round(Number(entity?.id ?? entity?.canonicalId ?? 0)));
}

function getEntityName(entity: any): string {
    return String(entity?.name ?? entity?.EntName ?? entity?.entName ?? entity?.characterName ?? entity?.character_name ?? '').trim();
}

function getEntityRoomId(entity: any, fallbackRoomId: number = 0): number {
    return Math.max(0, Math.round(Number(entity?.roomBossRoomId ?? entity?.roomId ?? entity?.room_id ?? fallbackRoomId ?? 0)));
}

function createObjectState(authority: TutorialDungeonAuthorityEntity): TutorialDungeonWorldObjectState {
    return {
        stableId: authority.stableId,
        exportedId: authority.id,
        entityType: authority.name,
        role: authority.role,
        roomId: authority.roomId,
        sourceRoom: authority.sourceRoom,
        sourceVar: authority.sourceVar,
        x: authority.x,
        y: authority.y,
        lifecycle: 'active',
        version: 0,
        updatedAt: 0,
        actorToken: 0
    };
}

function createState(levelScope: string): TutorialDungeonMechanicsState {
    return {
        levelScope,
        revision: 0,
        updatedAt: Date.now(),
        objects: new Map(AUTHORITY_ENTITIES.map((authority) => [authority.stableId, createObjectState(authority)])),
        earlyChainsBroken: false,
        parrotFreed: false,
        dummyOneDefeated: false,
        dummyTwoDefeated: false,
        dummyThreeDefeated: false,
        room2GateOpen: false,
        room2CollisionDisabled: false,
        tutorialChestOpened: false,
        bossChestOpened: false,
        bossIntroStarted: false,
        bossWave80: false,
        bossWave50: false,
        bossWave33: false,
        bossHp: 0,
        bossMaxHp: 0,
        bossHpVersion: 0,
        bossDeathVersion: 0,
        bossDefeated: false,
        bossTombstoned: false,
        annaFreed: false,
        cutscenePhase: 'not-started',
        cutsceneRoomId: 0,
        completionPhase: 'running',
        defeatedEntityIds: new Set<number>(),
        rewardClaims: new Set<string>(),
        chestEligibleRecipients: new Map<string, Set<string>>(),
        events: []
    };
}

function pushEvent(state: TutorialDungeonMechanicsState, event: TutorialDungeonMechanicEvent): TutorialDungeonMechanicEvent {
    state.events.push(event);
    return event;
}

function incrementRevision(state: TutorialDungeonMechanicsState): number {
    state.revision += 1;
    state.updatedAt = Date.now();
    return state.revision;
}

function formatLogFields(fields: Record<string, unknown>): string {
    return Object.entries(fields)
        .map(([key, value]) => `${key}=${String(value ?? '').replace(/\s+/g, '_')}`)
        .join(' ');
}

function getParticipantKey(client: Pick<Client, 'userId' | 'token' | 'character'>): string {
    const characterName = String(client.character?.name ?? '').trim().toLowerCase();
    const userId = Math.max(0, Math.round(Number(client.userId ?? 0)));
    if (userId > 0 && characterName) {
        return `${userId}:${characterName}`;
    }
    return characterName ? `character:${characterName}` : `token:${Math.max(0, Math.round(Number(client.token ?? 0)))}`;
}

export class TutorialDungeonMechanics {
    static readonly LEVEL_NAME = TUTORIAL_DUNGEON;
    static readonly TAG_UGO_BOSS_ID = 3923550;
    static readonly ANNA_CHAIN_ID = 4054622;
    static readonly EARLY_CHAIN_ID = 3268190;
    static readonly TUTORIAL_CHEST_ID = 4709982;
    static readonly BOSS_CHEST_ID = 3989086;
    static readonly REWARD_POLICY = 'once-per-eligible-player-at-first-open' as const;

    static isTutorialDungeon(levelNameOrScope: string | null | undefined): boolean {
        return getScopeLevelName(String(levelNameOrScope ?? '')) === TUTORIAL_DUNGEON ||
            String(levelNameOrScope ?? '').trim() === TUTORIAL_DUNGEON;
    }

    static getAuthorityEntities(): readonly TutorialDungeonAuthorityEntity[] {
        return AUTHORITY_ENTITIES;
    }

    static getAuthorityEntity(entityOrId: any, fallbackRoomId: number = 0): TutorialDungeonAuthorityEntity | null {
        if (typeof entityOrId === 'string' && AUTHORITY_BY_STABLE_ID.has(entityOrId)) {
            return AUTHORITY_BY_STABLE_ID.get(entityOrId) ?? null;
        }
        const stableId = String(entityOrId?.tutorialDungeonStableId ?? '').trim();
        if (stableId && AUTHORITY_BY_STABLE_ID.has(stableId)) {
            return AUTHORITY_BY_STABLE_ID.get(stableId) ?? null;
        }
        const id = typeof entityOrId === 'number' ? Math.max(0, Math.round(Number(entityOrId))) : getEntityId(entityOrId);
        if (id > 0 && AUTHORITY_BY_ID.has(id)) {
            return AUTHORITY_BY_ID.get(id) ?? null;
        }

        const name = typeof entityOrId === 'string' ? entityOrId : getEntityName(entityOrId);
        const candidates = AUTHORITY_BY_NAME.get(normalizeName(name)) ?? [];
        if (candidates.length === 1) {
            return candidates[0];
        }
        if (candidates.length > 1) {
            const roomId = getEntityRoomId(entityOrId, fallbackRoomId);
            const roomMatch = candidates.find((candidate) => candidate.roomId === roomId);
            if (roomMatch) {
                return roomMatch;
            }
            const x = Number(entityOrId?.x ?? NaN);
            const y = Number(entityOrId?.y ?? NaN);
            if (Number.isFinite(x) && Number.isFinite(y)) {
                return candidates.find((candidate) => Math.hypot(candidate.x - x, candidate.y - y) <= 400) ?? null;
            }
        }
        return null;
    }

    static isAuthorityEntity(levelNameOrScope: string | null | undefined, entityOrId: any): boolean {
        return TutorialDungeonMechanics.isTutorialDungeon(levelNameOrScope) &&
            Boolean(TutorialDungeonMechanics.getAuthorityEntity(entityOrId));
    }

    static isCompletionBoss(levelNameOrScope: string | null | undefined, entity: any): boolean {
        if (!TutorialDungeonMechanics.isTutorialDungeon(levelNameOrScope)) {
            return false;
        }
        const authority = TutorialDungeonMechanics.getAuthorityEntity(entity);
        if (authority?.role === 'boss') {
            return true;
        }
        const nameKey = normalizeName(getEntityName(entity));
        return nameKey === 'goblinboss1' || nameKey === 'tagugo';
    }

    static isAnnaRescueObjective(levelNameOrScope: string | null | undefined, entity: any): boolean {
        if (!TutorialDungeonMechanics.isTutorialDungeon(levelNameOrScope)) {
            return false;
        }
        const authority = TutorialDungeonMechanics.getAuthorityEntity(entity);
        return authority?.role === 'anna_chain' || normalizeName(getEntityName(entity)) === 'chains03';
    }

    static isTrackedChest(levelNameOrScope: string | null | undefined, entity: any, fallbackRoomId: number = 0): boolean {
        if (!TutorialDungeonMechanics.isTutorialDungeon(levelNameOrScope)) {
            return false;
        }
        const authority = TutorialDungeonMechanics.getAuthorityEntity(entity, fallbackRoomId);
        return authority?.role === 'tutorial_chest' || authority?.role === 'boss_chest';
    }

    static decorateNpc(levelName: string | null | undefined, npc: any): any {
        const authority = TutorialDungeonMechanics.getAuthorityEntity(npc);
        if (!TutorialDungeonMechanics.isTutorialDungeon(levelName) || !authority) {
            return npc;
        }
        return {
            ...npc,
            roomId: authority.roomId,
            room_id: authority.roomId,
            sourceRoom: authority.sourceRoom,
            sourceVar: authority.sourceVar,
            scripted: true,
            serverOnlyObjective: !authority.boss,
            tutorialDungeonAuthorityRole: authority.role,
            tutorialDungeonStableId: authority.stableId,
            requiredForClear: Boolean(authority.requiredForCompletion),
            boss: Boolean(authority.boss),
            roomBoss: Boolean(authority.boss),
            roomBossName: authority.displayName ?? '',
            displayName: authority.displayName ?? String(npc?.displayName ?? ''),
            clientSpawned: false
        };
    }

    static getState(levelScope: string | null | undefined): TutorialDungeonMechanicsState | null {
        const scope = String(levelScope ?? '').trim();
        if (!scope || !TutorialDungeonMechanics.isTutorialDungeon(scope)) {
            return null;
        }
        let state = GlobalState.tutorialDungeonWorldStates.get(scope);
        if (!state) {
            state = createState(scope);
            GlobalState.tutorialDungeonWorldStates.set(scope, state);
        }
        return state;
    }

    static getClientState(client: Client | null | undefined): TutorialDungeonMechanicsState | null {
        if (!client || !TutorialDungeonMechanics.isTutorialDungeon(client.currentLevel)) {
            return null;
        }
        return TutorialDungeonMechanics.getState(getClientLevelScope(client));
    }

    static getSnapshot(levelScope: string | null | undefined): TutorialDungeonWorldSnapshot | null {
        const state = TutorialDungeonMechanics.getState(levelScope);
        if (!state) {
            return null;
        }
        return {
            levelScope: state.levelScope,
            revision: state.revision,
            objects: Object.fromEntries(Array.from(state.objects.entries()).map(([key, value]) => [key, { ...value }])),
            parrotFreed: state.parrotFreed,
            annaFreed: state.annaFreed,
            room2GateOpen: state.room2GateOpen,
            room2CollisionDisabled: state.room2CollisionDisabled,
            bossHp: state.bossHp,
            bossMaxHp: state.bossMaxHp,
            bossHpVersion: state.bossHpVersion,
            bossDeathVersion: state.bossDeathVersion,
            bossDefeated: state.bossDefeated,
            bossTombstoned: state.bossTombstoned,
            bossWave80: state.bossWave80,
            bossWave50: state.bossWave50,
            bossWave33: state.bossWave33,
            cutscenePhase: state.cutscenePhase,
            cutsceneRoomId: state.cutsceneRoomId,
            completionPhase: state.completionPhase
        };
    }

    static serializeSnapshot(levelScope: string | null | undefined): string {
        const snapshot = TutorialDungeonMechanics.getSnapshot(levelScope);
        if (!snapshot) {
            return '';
        }
        const flag = (value: boolean): number => value ? 1 : 0;
        return [
            `revision=${snapshot.revision}`,
            `earlyChain=${flag(snapshot.objects[AUTHORITY_BY_ID.get(3268190)!.stableId]?.lifecycle === 'destroyed')}`,
            `parrotFreed=${flag(snapshot.parrotFreed)}`,
            `d1=${flag(snapshot.objects[AUTHORITY_BY_ID.get(4841054)!.stableId]?.lifecycle === 'destroyed')}`,
            `d2=${flag(snapshot.objects[AUTHORITY_BY_ID.get(4906590)!.stableId]?.lifecycle === 'destroyed')}`,
            `d3=${flag(snapshot.objects[AUTHORITY_BY_ID.get(4972126)!.stableId]?.lifecycle === 'destroyed')}`,
            `gate=${flag(snapshot.room2GateOpen && snapshot.room2CollisionDisabled)}`,
            `tutorialChest=${flag(snapshot.objects[AUTHORITY_BY_ID.get(4709982)!.stableId]?.lifecycle === 'opened')}`,
            `bossChest=${flag(snapshot.objects[AUTHORITY_BY_ID.get(3989086)!.stableId]?.lifecycle === 'opened')}`,
            `bossHp=${snapshot.bossHp}`,
            `bossMaxHp=${snapshot.bossMaxHp}`,
            `bossHpVersion=${snapshot.bossHpVersion}`,
            `bossDeathVersion=${snapshot.bossDeathVersion}`,
            `bossDead=${flag(snapshot.bossDefeated && snapshot.bossTombstoned)}`,
            `annaFreed=${flag(snapshot.annaFreed)}`,
            `w80=${flag(snapshot.bossWave80)}`,
            `w50=${flag(snapshot.bossWave50)}`,
            `w33=${flag(snapshot.bossWave33)}`,
            `cutscene=${snapshot.cutscenePhase}`,
            `completion=${snapshot.completionPhase}`
        ].join('|');
    }

    static resetState(levelScope: string | null | undefined): void {
        const scope = String(levelScope ?? '').trim();
        if (scope) {
            GlobalState.tutorialDungeonWorldStates.delete(scope);
        }
    }

    static getWorldObjectState(levelScope: string, entityOrStableId: any, fallbackRoomId: number = 0): TutorialDungeonWorldObjectState | null {
        const authority = TutorialDungeonMechanics.getAuthorityEntity(entityOrStableId, fallbackRoomId);
        return authority ? TutorialDungeonMechanics.getState(levelScope)?.objects.get(authority.stableId) ?? null : null;
    }

    static isWorldObjectResolved(levelScope: string, entityOrStableId: any, fallbackRoomId: number = 0): boolean {
        const objectState = TutorialDungeonMechanics.getWorldObjectState(levelScope, entityOrStableId, fallbackRoomId);
        return Boolean(objectState && objectState.lifecycle !== 'active');
    }

    static tagClientObject(entity: any, fallbackRoomId: number = 0): TutorialDungeonAuthorityEntity | null {
        const authority = TutorialDungeonMechanics.getAuthorityEntity(entity, fallbackRoomId);
        if (!authority || !entity || typeof entity !== 'object') {
            return authority;
        }
        entity.tutorialDungeonStableId = authority.stableId;
        entity.tutorialDungeonAuthorityRole = authority.role;
        entity.sourceRoom = authority.sourceRoom;
        entity.sourceVar = authority.sourceVar;
        return authority;
    }

    static findClientLocalObject(client: Client, stableId: string): any | null {
        for (const entity of client.entities.values()) {
            const authority = TutorialDungeonMechanics.getAuthorityEntity(entity, Number(client.currentRoomId ?? 0));
            if (authority?.stableId === stableId) {
                return entity;
            }
        }
        return null;
    }

    private static commitObjectTransition(
        client: Client,
        entity: any,
        validateRoom: boolean
    ): TutorialDungeonObjectTransition {
        const state = TutorialDungeonMechanics.getClientState(client);
        const authority = TutorialDungeonMechanics.getAuthorityEntity(entity, Number(client?.currentRoomId ?? 0));
        if (!state || !authority || authority.role === 'anna') {
            return { accepted: false, dedupe: false, reason: 'untracked_object', authority, previousState: 'unknown', nextState: 'unknown', revision: state?.revision ?? 0, events: [] };
        }

        const localEntityId = getEntityId(entity);
        const attachedLocalEntity = localEntityId > 0 ? client.entities.get(localEntityId) : null;
        if (
            validateRoom &&
            authority.role !== 'boss' &&
            (Math.max(0, Math.round(Number(client.currentRoomId ?? 0))) !== authority.roomId ||
                (getEntityRoomId(entity) > 0 && getEntityRoomId(entity) !== authority.roomId) ||
                !attachedLocalEntity || attachedLocalEntity !== entity ||
                String(attachedLocalEntity.tutorialDungeonStableId ?? authority.stableId) !== authority.stableId)
        ) {
            return { accepted: false, dedupe: false, reason: 'target_not_attached_in_room', authority, previousState: 'unknown', nextState: 'unknown', revision: state.revision, events: [] };
        }

        if (validateRoom && authority.role === 'dummy') {
            if (authority.id === 4906590 && !state.dummyOneDefeated) {
                return { accepted: false, dedupe: false, reason: 'dummy_one_pending', authority, previousState: 'active', nextState: 'active', revision: state.revision, events: [] };
            }
            if (authority.id === 4972126 && !state.dummyTwoDefeated) {
                return { accepted: false, dedupe: false, reason: 'dummy_two_pending', authority, previousState: 'active', nextState: 'active', revision: state.revision, events: [] };
            }
        }

        const objectState = state.objects.get(authority.stableId) ?? createObjectState(authority);
        state.objects.set(authority.stableId, objectState);
        const nextLifecycle: TutorialDungeonObjectLifecycle =
            authority.role === 'tutorial_chest' || authority.role === 'boss_chest' ? 'opened' : 'destroyed';
        if (objectState.lifecycle === nextLifecycle) {
            TutorialDungeonMechanics.logTransition(state, authority, objectState.lifecycle, nextLifecycle, client.token, 0, true, 'duplicate');
            return { accepted: false, dedupe: true, reason: 'duplicate', authority, previousState: objectState.lifecycle, nextState: nextLifecycle, revision: state.revision, events: [] };
        }

        const previousState = objectState.lifecycle;
        const events: TutorialDungeonMechanicEvent[] = [];
        objectState.lifecycle = nextLifecycle;
        objectState.version += 1;
        objectState.updatedAt = Date.now();
        objectState.actorToken = Math.max(0, Math.round(Number(client.token ?? 0)));
        state.defeatedEntityIds.add(authority.id);

        switch (authority.role) {
            case 'early_chain':
                state.earlyChainsBroken = true;
                state.parrotFreed = true;
                events.push(pushEvent(state, 'early_chain_broken'));
                break;
            case 'dummy':
                if (authority.id === 4841054) {
                    state.dummyOneDefeated = true;
                    events.push(pushEvent(state, 'dummy_one_defeated'));
                } else if (authority.id === 4906590) {
                    state.dummyTwoDefeated = true;
                    events.push(pushEvent(state, 'dummy_two_defeated'));
                } else if (authority.id === 4972126) {
                    state.dummyThreeDefeated = true;
                    state.room2GateOpen = true;
                    state.room2CollisionDisabled = true;
                    events.push(pushEvent(state, 'dummy_three_defeated'));
                }
                break;
            case 'tutorial_chest':
                state.tutorialChestOpened = true;
                state.chestEligibleRecipients.set(
                    authority.stableId,
                    new Set(Array.from(GlobalState.sessionsByToken.values())
                        .filter((session) => session.playerSpawned && Boolean(session.character) && getClientLevelScope(session) === state.levelScope)
                        .map(getParticipantKey))
                );
                events.push(pushEvent(state, 'tutorial_chest_opened'));
                break;
            case 'boss_chest':
                state.bossChestOpened = true;
                state.chestEligibleRecipients.set(
                    authority.stableId,
                    new Set(Array.from(GlobalState.sessionsByToken.values())
                        .filter((session) => session.playerSpawned && Boolean(session.character) && getClientLevelScope(session) === state.levelScope)
                        .map(getParticipantKey))
                );
                events.push(pushEvent(state, 'boss_chest_opened'));
                break;
            case 'boss':
                state.bossDefeated = true;
                state.bossTombstoned = true;
                state.bossHp = 0;
                events.push(pushEvent(state, 'boss_defeated'));
                break;
            case 'anna_chain':
                state.annaFreed = true;
                events.push(pushEvent(state, 'anna_freed'));
                break;
        }

        const revision = incrementRevision(state);
        TutorialDungeonMechanics.logTransition(state, authority, previousState, nextLifecycle, client.token, 0, false, 'accepted');
        return { accepted: true, dedupe: false, reason: 'accepted', authority, previousState, nextState: nextLifecycle, revision, events };
    }

    static commitClientObjectDefeat(client: Client, entity: any): TutorialDungeonObjectTransition {
        if (!client || !client.playerSpawned || !client.character ||
            !TutorialDungeonMechanics.isTutorialDungeon(client.currentLevel) ||
            !entity || entity.isPlayer || Number(entity.team ?? EntityTeam.ENEMY) !== EntityTeam.ENEMY) {
            return { accepted: false, dedupe: false, reason: 'invalid_actor_or_level', authority: null, previousState: 'unknown', nextState: 'unknown', revision: 0, events: [] };
        }
        return TutorialDungeonMechanics.commitObjectTransition(client, entity, true);
    }

    static noteEntityDefeated(client: Client, entity: any): TutorialDungeonMechanicEvent[] {
        if (!client || !TutorialDungeonMechanics.isTutorialDungeon(client.currentLevel) || !entity || entity.isPlayer) {
            return [];
        }
        const transition = TutorialDungeonMechanics.commitObjectTransition(client, entity, false);
        if (transition.accepted) {
            entity.dead = true;
            entity.hp = 0;
            entity.entState = EntityState.DEAD;
        }
        return transition.events;
    }

    static noteBossIntroStarted(client: Client, bossId: number, bossName: string): TutorialDungeonMechanicEvent[] {
        if (!TutorialDungeonMechanics.isTutorialDungeon(client.currentLevel) ||
            !TutorialDungeonMechanics.isCompletionBoss(client.currentLevel, { id: bossId, name: bossName })) {
            return [];
        }
        const state = TutorialDungeonMechanics.getClientState(client);
        if (!state || state.bossIntroStarted) {
            return [];
        }
        state.bossIntroStarted = true;
        state.cutscenePhase = 'active';
        state.cutsceneRoomId = Math.max(0, Math.round(Number(client.currentRoomId ?? 0)));
        incrementRevision(state);
        return [pushEvent(state, 'boss_intro_started')];
    }

    static noteBossHealth(client: Client, entity: any): TutorialDungeonMechanicEvent[] {
        if (!TutorialDungeonMechanics.isCompletionBoss(client.currentLevel, entity)) {
            return [];
        }
        const state = TutorialDungeonMechanics.getClientState(client);
        if (!state) {
            return [];
        }
        const maxHp = Math.max(0, Math.round(Number(entity?.maxHp ?? 0)));
        const hp = Math.max(0, Math.round(Number(entity?.hp ?? maxHp)));
        const hpVersion = Math.max(0, Math.round(Number(entity?.hpVersion ?? 0)));
        const deathVersion = Math.max(0, Math.round(Number(entity?.deathVersion ?? 0)));
        if (maxHp <= 0) {
            return [];
        }
        if (state.bossDefeated && hp > 0) {
            return [];
        }
        if (!Boolean(entity?.dead) && !Boolean(entity?.destroyed) && hpVersion < state.bossHpVersion) {
            return [];
        }

        const events: TutorialDungeonMechanicEvent[] = [];
        const ratio = hp / maxHp;
        if (hp > 0 && ratio <= 0.8 && !state.bossWave80) {
            state.bossWave80 = true;
            events.push(pushEvent(state, 'boss_wave_80'));
        }
        if (hp > 0 && ratio <= 0.5 && !state.bossWave50) {
            state.bossWave50 = true;
            events.push(pushEvent(state, 'boss_wave_50'));
        }
        if (hp > 0 && ratio <= 0.33 && !state.bossWave33) {
            state.bossWave33 = true;
            events.push(pushEvent(state, 'boss_wave_33'));
        }

        const bossDead = Boolean(entity?.dead) || Boolean(entity?.destroyed) || hp <= 0;
        const changed = state.bossHp !== hp || state.bossMaxHp !== maxHp ||
            state.bossHpVersion !== hpVersion || state.bossDeathVersion !== deathVersion ||
            state.bossDefeated !== bossDead || events.length > 0;
        if (!changed) {
            return events;
        }
        state.bossHp = hp;
        state.bossMaxHp = maxHp;
        state.bossHpVersion = hpVersion;
        state.bossDeathVersion = deathVersion;
        state.bossDefeated = bossDead;
        state.bossTombstoned = Boolean(entity?.destroyed) || Math.max(0, Number(entity?.deathFinalizedAt ?? 0)) > 0;
        const authority = AUTHORITY_BY_ID.get(TutorialDungeonMechanics.TAG_UGO_BOSS_ID)!;
        const objectState = state.objects.get(authority.stableId)!;
        objectState.lifecycle = bossDead ? 'destroyed' : 'active';
        objectState.version = Math.max(objectState.version, hpVersion, deathVersion);
        objectState.updatedAt = Date.now();
        objectState.actorToken = Math.max(0, Math.round(Number(client.token ?? 0)));
        if (bossDead && !state.events.includes('boss_defeated')) {
            events.push(pushEvent(state, 'boss_defeated'));
        }
        incrementRevision(state);
        return events;
    }

    static noteCutscenePhase(
        levelScope: string,
        roomId: number,
        phase: TutorialDungeonCutscenePhase,
        actorToken: number = 0
    ): boolean {
        const state = TutorialDungeonMechanics.getState(levelScope);
        const normalizedRoomId = Math.max(0, Math.round(Number(roomId ?? 0)));
        const isSamePhase = state?.cutscenePhase === phase && state.cutsceneRoomId === normalizedRoomId;
        const isCompletedRoomReplay = state?.cutsceneRoomId === normalizedRoomId &&
            state.cutscenePhase === 'completed' && phase !== 'completed';
        if (!state || isSamePhase || isCompletedRoomReplay) {
            return false;
        }
        const previous = `${state.cutscenePhase}:${state.cutsceneRoomId}`;
        state.cutscenePhase = phase;
        state.cutsceneRoomId = normalizedRoomId;
        incrementRevision(state);
        console.log(`[GoblinKidnappersAuthority] ${formatLogFields({
            scope: levelScope, stableObjectId: 'cutscene', previousState: previous,
            nextState: `${phase}:${state.cutsceneRoomId}`, revision: state.revision,
            actor: actorToken, recipients: 0, dedupe: false
        })}`);
        return true;
    }

    static noteCompletionPhase(
        levelScope: string,
        phase: TutorialDungeonCompletionPhase,
        actorToken: number = 0
    ): boolean {
        const state = TutorialDungeonMechanics.getState(levelScope);
        const phaseOrder: Record<TutorialDungeonCompletionPhase, number> = {
            running: 0,
            'waiting-gates': 1,
            ready: 2,
            completed: 3
        };
        if (!state || phaseOrder[phase] <= phaseOrder[state.completionPhase]) {
            return false;
        }
        const previous = state.completionPhase;
        state.completionPhase = phase;
        incrementRevision(state);
        console.log(`[GoblinKidnappersAuthority] ${formatLogFields({
            scope: levelScope, stableObjectId: 'completion', previousState: previous,
            nextState: phase, revision: state.revision, actor: actorToken,
            recipients: 0, dedupe: false
        })}`);
        return true;
    }

    static claimChestReward(
        levelScope: string,
        stableChestId: string,
        recipientKey: string,
        actorToken: number = 0
    ): { accepted: boolean; dedupe: boolean; rewardKey: string; openVersion: number; revision: number } {
        const state = TutorialDungeonMechanics.getState(levelScope);
        const authority = AUTHORITY_BY_STABLE_ID.get(stableChestId) ?? null;
        const objectState = authority ? state?.objects.get(stableChestId) ?? null : null;
        if (!state || !authority || !objectState ||
            (authority.role !== 'tutorial_chest' && authority.role !== 'boss_chest') ||
            objectState.lifecycle !== 'opened') {
            return { accepted: false, dedupe: false, rewardKey: '', openVersion: 0, revision: state?.revision ?? 0 };
        }
        const normalizedRecipient = String(recipientKey ?? '').trim().toLowerCase();
        const rewardKey = `${levelScope}:${stableChestId}:${objectState.version}:${normalizedRecipient}`;
        const eligibleRecipients = state.chestEligibleRecipients.get(stableChestId) ?? new Set<string>();
        if (!eligibleRecipients.has(normalizedRecipient)) {
            TutorialDungeonMechanics.logTransition(state, authority, 'opened', 'opened', actorToken, 0, true, 'reward_ineligible');
            return { accepted: false, dedupe: true, rewardKey, openVersion: objectState.version, revision: state.revision };
        }
        if (!normalizedRecipient || state.rewardClaims.has(rewardKey)) {
            TutorialDungeonMechanics.logTransition(state, authority, 'opened', 'opened', actorToken, 0, true, 'reward_duplicate');
            return { accepted: false, dedupe: true, rewardKey, openVersion: objectState.version, revision: state.revision };
        }
        state.rewardClaims.add(rewardKey);
        incrementRevision(state);
        TutorialDungeonMechanics.logTransition(state, authority, 'opened', 'opened', actorToken, 1, false, 'reward_granted');
        return { accepted: true, dedupe: false, rewardKey, openVersion: objectState.version, revision: state.revision };
    }

    static logSnapshotApplied(client: Client, stableId: string, recipients: number, dedupe: boolean): void {
        const state = TutorialDungeonMechanics.getClientState(client);
        if (!state) {
            return;
        }
        console.log(`[GoblinKidnappersAuthority] ${formatLogFields({
            scope: state.levelScope, stableObjectId: stableId, previousState: 'client-local',
            nextState: 'snapshot-applied', revision: state.revision, actor: client.token,
            recipients, dedupe
        })}`);
    }

    static logTransition(
        state: TutorialDungeonMechanicsState,
        authority: TutorialDungeonAuthorityEntity,
        previousState: string,
        nextState: string,
        actorToken: number,
        recipients: number,
        dedupe: boolean,
        result: string
    ): void {
        console.log(`[GoblinKidnappersAuthority] ${formatLogFields({
            scope: state.levelScope,
            stableObjectId: authority.stableId,
            previousState,
            nextState,
            revision: state.revision,
            actor: actorToken,
            recipients,
            dedupe,
            result
        })}`);
    }

    static markCanonicalDefeated(entity: any): void {
        if (!entity || entity.isPlayer || Number(entity.team ?? EntityTeam.ENEMY) !== EntityTeam.ENEMY) {
            return;
        }
        entity.dead = true;
        entity.hp = 0;
        entity.entState = EntityState.DEAD;
        entity.clientDefeatVerified = true;
    }
}
