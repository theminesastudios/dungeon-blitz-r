import { Character } from '../database/Database';
import { Client } from './Client';
import { PartyGroup, PendingTeleport } from './SocialState';

export interface PendingTransfer {
    character: Character;
    targetLevel: string;
    levelInstanceId?: string;
    previousLevel: string;
    userId: number;
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
    static combatContributions: Map<string, Map<string, number>> = new Map();
    static entityLifeNonces: Map<string, number> = new Map();
    static entityLastRewardNonces: Map<string, number> = new Map();
    // Level Name -> LevelInstance (if needed) or just keys of levelEntities
    static levelRegistry: { [key: string]: any } = {};
}
