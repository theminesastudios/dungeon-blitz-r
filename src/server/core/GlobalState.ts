import { Character } from '../database/Database';
import { Client } from './Client';
import { normalizeCharacterKey, PartyGroup, PendingTeleport } from './SocialState';

export interface PendingTransfer {
    character: Character;
    craftTownHostCharacter?: Character;
    targetLevel: string;
    levelInstanceId?: string;
    previousLevel: string;
    userId: number;
    accountEmail?: string;
    newX?: number;
    newY?: number;
    newHasCoord?: boolean;
    syncAnchorStartedAt?: number;
    syncAnchorToken?: number;
    syncAnchorCharacterName?: string;
    syncEntryLevel?: string;
    syncEntryX?: number;
    syncEntryY?: number;
    syncEntryHasCoord?: boolean;
    syncRoomId?: number;
    syncStartedRoomIds?: number[];
    syncQuestProgress?: number;
    sourceDoorId?: number;
    sourceDoorLevel?: string;
    sourceDoorTargetLevel?: string;
    playSessionStartedAt?: number;
}

export type SharedDungeonProgressState = {
    progress: number;
    authorityToken: number;
    completionRequested?: boolean;
    trackedHostileIds?: Set<number>;
    defeatedHostileIds?: Set<number>;
    liveStatsByCharacter?: Map<string, {
        updatedAt: number;
        levelName: string;
        scoreMode: string;
        totalScore: number;
        kills: number;
        treasure: number;
        accuracy: number;
        deaths: number;
        timeBonus: number;
        resultBar: number;
        rank: number;
    }>;
};

export type SharedDungeonCutsceneState = {
    roomId: number;
    ownerToken: number;
    active: boolean;
    completed: boolean;
    startedAt: number;
    endedAt: number;
};

export type DeadHostileTombstone = {
    canonicalId: number;
    spawnKey: string;
    levelScope: string;
    levelName: string;
    roomId: number;
    enemyType: string;
    name: string;
    x: number;
    y: number;
    killedAt: number;
    killerToken: number;
    lootDropNonce: string;
    deathFinalizedAt: number;
    dead: true;
    destroyed: true;
    deathVersion: number;
};

export class GlobalState {
    // Token -> Pending Transfer
    static pendingWorld: Map<number, PendingTransfer> = new Map();
    static pendingExtended: Map<number, boolean> = new Map();
    static usedTransferTokens: Map<number, PendingTransfer> = new Map();
    
    // Token -> Client Session (Active)
    static sessionsByToken: Map<number, Client> = new Map();
    
    // UserId -> Client Session
    static sessionsByUserId: Map<number, Client> = new Map();

    // Character name -> Client Session
    static sessionsByCharacterName: Map<string, Client> = new Map();

    // Token -> Host Character (for House Visits)
    static houseVisits: Map<number, Character> = new Map();

    // Token -> Character Data (Persists across disconnects for transfers)
    static tokenChar: Map<number, { character: Character, userId: number }> = new Map();

    // Legacy transfer token -> latest active transfer token
    static transferTokenAliases: Map<number, number> = new Map();

    // PartyId -> PartyGroup
    static partyGroups: Map<number, PartyGroup> = new Map();

    // Normalized character name -> PartyId
    static partyByMember: Map<string, number> = new Map();

    // Current token -> social teleport override
    static pendingTeleports: Map<number, PendingTeleport> = new Map();

    // Level scope key -> Map<EntityId, EntityData>
    static levelEntities: Map<string, Map<number, any>> = new Map();
    static levelQuestProgress: Map<string, SharedDungeonProgressState> = new Map();
    static dungeonCutscenes: Map<string, SharedDungeonCutsceneState> = new Map();
    static deadServerAuthorityHostilesByScope: Map<string, Map<string, DeadHostileTombstone>> = new Map();
    static combatContributions: Map<string, Map<string, number>> = new Map();
    static entityLifeNonces: Map<string, number> = new Map();
    static entityLastRewardNonces: Map<string, number> = new Map();
    // Level Name -> LevelInstance (if needed) or just keys of levelEntities
    static levelRegistry: { [key: string]: any } = {};

    static getActiveSessionsByUserId(userId: number | null | undefined): Client[] {
        const normalizedUserId = Number(userId ?? 0);
        if (!Number.isFinite(normalizedUserId) || normalizedUserId <= 0) {
            return [];
        }

        const seen = new Set<Client>();
        const sessions: Client[] = [];
        for (const session of GlobalState.sessionsByToken.values()) {
            if (!session?.character || session.userId !== normalizedUserId || seen.has(session)) {
                continue;
            }

            seen.add(session);
            sessions.push(session);
        }

        return sessions;
    }

    static isSessionOpen(session: Client | null | undefined): session is Client {
        if (!session?.character) {
            return false;
        }

        const socket = (session as unknown as { socket?: { destroyed?: boolean; readyState?: string } }).socket;
        return !socket || (!socket.destroyed && socket.readyState === 'open');
    }

    private static hasActiveTokenIndex(session: Client): boolean {
        const token = Number((session as unknown as { token?: number }).token ?? 0);
        return token <= 0 || GlobalState.sessionsByToken.get(token) === session;
    }

    static getActiveSessionByCharacterName(name: unknown): Client | null {
        const characterKey = normalizeCharacterKey(name);
        if (!characterKey) {
            return null;
        }

        const indexed = GlobalState.sessionsByCharacterName.get(characterKey);
        if (
            indexed &&
            GlobalState.isSessionOpen(indexed) &&
            GlobalState.hasActiveTokenIndex(indexed) &&
            normalizeCharacterKey(indexed.character?.name) === characterKey
        ) {
            return indexed;
        }

        if (indexed && (!GlobalState.isSessionOpen(indexed) || !GlobalState.hasActiveTokenIndex(indexed))) {
            GlobalState.sessionsByCharacterName.delete(characterKey);
        }

        for (const session of GlobalState.sessionsByToken.values()) {
            if (
                GlobalState.isSessionOpen(session) &&
                normalizeCharacterKey(session.character?.name) === characterKey
            ) {
                GlobalState.sessionsByCharacterName.set(characterKey, session);
                return session;
            }
        }

        return null;
    }
}
