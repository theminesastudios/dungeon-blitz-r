import { Character } from '../database/Database';
import { Client } from './Client';

export interface PendingTransfer {
    character: Character;
    targetLevel: string;
    previousLevel: string;
    userId: number;
}

export class GlobalState {
    // Token -> Pending Transfer
    static pendingWorld: Map<number, PendingTransfer> = new Map();
    
    // Token -> Client Session (Active)
    static sessionsByToken: Map<number, Client> = new Map();
    
    // UserId -> Client Session
    static sessionsByUserId: Map<number, Client> = new Map();

    // Token -> Host Character (for House Visits)
    static houseVisits: Map<number, Character> = new Map();

    // Token -> Character Data (Persists across disconnects for transfers)
    static tokenChar: Map<number, { character: Character, userId: number }> = new Map();

    // Level Name -> Map<EntityId, EntityData>
    static levelEntities: Map<string, Map<number, any>> = new Map();
    // Level Name -> LevelInstance (if needed) or just keys of levelEntities
    static levelRegistry: { [key: string]: any } = {};
}

