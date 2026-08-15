import { Character, UserAccount } from '../database/Database';
import { Client } from './Client';
import type { DungeonCompletionRunState } from './DungeonCompletionTypes';
import type { TutorialDungeonMechanicsState } from './TutorialDungeonMechanics';
import {
    getAccountPrimaryCharacterName,
    normalizeCharacterKey,
    PartyGroup,
    PendingTeleport
} from './SocialState';
import { getClientLevelScope } from './LevelScope';

type SessionIndexSnapshot = {
    levelScope: string;
    partyId: number;
    roomId: number;
};

class IndexedSessionMap extends Map<number, Client> {
    override set(token: number, session: Client): this {
        const previous = super.get(token);
        if (previous && previous !== session) {
            GlobalState.removeSessionIndexes(previous);
        }
        super.set(token, session);
        GlobalState.refreshSessionIndexes(session);
        return this;
    }

    override delete(token: number): boolean {
        const session = super.get(token);
        const deleted = super.delete(token);
        if (deleted && session) {
            GlobalState.refreshSessionIndexes(session);
        }
        return deleted;
    }

    override clear(): void {
        const sessions = new Set(super.values());
        super.clear();
        for (const session of sessions) {
            GlobalState.removeSessionIndexes(session);
        }
    }

    replaceFrom(source: Map<number, Client>): void {
        if (source === this) {
            return;
        }
        this.clear();
        for (const [token, session] of source) {
            this.set(token, session);
        }
    }
}

export interface PendingTransfer {
    character: Character;
    craftTownHostCharacter?: Character;
    targetLevel: string;
    levelInstanceId?: string;
    previousLevel: string;
    userId: number;
    account?: UserAccount;
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
    pendingSince?: number;
    playSessionStartedAt?: number;
}

export type SharedDungeonProgressState = {
    progress: number;
    authorityToken: number;
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
    dialogIndex: number;
    participantKeys?: Set<string>;
    closedParticipantKeys?: Set<string>;
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

export type PendingDiscordOAuthLogin = {
    account: UserAccount;
    remoteAddress: string;
    createdAt: number;
    expiresAt: number;
};

export class GlobalState {
    private static readonly PENDING_DISCORD_OAUTH_LOGIN_TTL_MS = 2 * 60 * 1000;

    // Connected clients, including clients that have not authenticated yet.
    static clients: Set<Client> = new Set();

    // Normalized remote address -> pending Discord OAuth account handoff.
    static pendingDiscordOAuthLogins: Map<string, PendingDiscordOAuthLogin> = new Map();

    // Token -> Pending Transfer
    static pendingWorld: Map<number, PendingTransfer> = new Map();
    static pendingExtended: Map<number, boolean> = new Map();
    static usedTransferTokens: Map<number, PendingTransfer> = new Map();
    
    // Token -> Client Session (Active)
    private static readonly indexedSessionsByToken = new IndexedSessionMap();
    private static readonly sessionIndexSnapshots = new WeakMap<Client, SessionIndexSnapshot>();
    private static readonly EMPTY_SESSION_SET: ReadonlySet<Client> = new Set<Client>();

    static get sessionsByToken(): Map<number, Client> {
        return GlobalState.indexedSessionsByToken;
    }

    static set sessionsByToken(source: Map<number, Client>) {
        GlobalState.indexedSessionsByToken.replaceFrom(source);
    }

    static sessionsByLevelScope: Map<string, Set<Client>> = new Map();
    static sessionsByPartyId: Map<number, Set<Client>> = new Map();
    static sessionsByRoom: Map<string, Map<number, Set<Client>>> = new Map();
    
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
    // Level scope -> the single authoritative completion state for that dungeon run.
    static dungeonCompletions: Map<string, DungeonCompletionRunState> = new Map();
    static dungeonCutscenes: Map<string, SharedDungeonCutsceneState> = new Map();
    // Scope-owned scripted world state. Visual Flash cues remain viewer-local proxies.
    static tutorialDungeonWorldStates: Map<string, TutorialDungeonMechanicsState> = new Map();
    static deadServerAuthorityHostilesByScope: Map<string, Map<string, DeadHostileTombstone>> = new Map();
    static combatContributions: Map<string, Map<string, number>> = new Map();
    static entityLifeNonces: Map<string, number> = new Map();
    static entityLastRewardNonces: Map<string, number> = new Map();
    // Level Name -> LevelInstance (if needed) or just keys of levelEntities
    static levelRegistry: { [key: string]: any } = {};

    private static deleteFromSessionSetIndex<K>(index: Map<K, Set<Client>>, key: K, session: Client): void {
        const sessions = index.get(key);
        if (!sessions) {
            return;
        }
        sessions.delete(session);
        if (sessions.size === 0) {
            index.delete(key);
        }
    }

    private static addToSessionSetIndex<K>(index: Map<K, Set<Client>>, key: K, session: Client): void {
        let sessions = index.get(key);
        if (!sessions) {
            sessions = new Set<Client>();
            index.set(key, sessions);
        }
        sessions.add(session);
    }

    static removeSessionIndexes(session: Client): void {
        const previous = GlobalState.sessionIndexSnapshots.get(session);
        if (!previous) {
            return;
        }

        if (previous.levelScope) {
            GlobalState.deleteFromSessionSetIndex(GlobalState.sessionsByLevelScope, previous.levelScope, session);
            if (previous.roomId >= 0) {
                const rooms = GlobalState.sessionsByRoom.get(previous.levelScope);
                if (rooms) {
                    GlobalState.deleteFromSessionSetIndex(rooms, previous.roomId, session);
                    if (rooms.size === 0) {
                        GlobalState.sessionsByRoom.delete(previous.levelScope);
                    }
                }
            }
        }
        if (previous.partyId > 0) {
            GlobalState.deleteFromSessionSetIndex(GlobalState.sessionsByPartyId, previous.partyId, session);
        }
        GlobalState.sessionIndexSnapshots.delete(session);
    }

    static refreshSessionIndexes(session: Client): void {
        GlobalState.removeSessionIndexes(session);

        const token = Math.max(0, Math.round(Number(session?.token ?? 0)));
        if (token <= 0 || GlobalState.indexedSessionsByToken.get(token) !== session) {
            return;
        }

        const levelScope = getClientLevelScope(session);
        const characterKey = normalizeCharacterKey(session.character?.name);
        const partyId = characterKey ? Math.max(0, Math.round(Number(GlobalState.partyByMember.get(characterKey) ?? 0))) : 0;
        const rawRoomId = Number(session.currentRoomId);
        const roomId = Number.isFinite(rawRoomId) && rawRoomId >= 0 ? Math.round(rawRoomId) : -1;

        if (levelScope) {
            GlobalState.addToSessionSetIndex(GlobalState.sessionsByLevelScope, levelScope, session);
            if (roomId >= 0) {
                let rooms = GlobalState.sessionsByRoom.get(levelScope);
                if (!rooms) {
                    rooms = new Map<number, Set<Client>>();
                    GlobalState.sessionsByRoom.set(levelScope, rooms);
                }
                GlobalState.addToSessionSetIndex(rooms, roomId, session);
            }
        }
        if (partyId > 0) {
            GlobalState.addToSessionSetIndex(GlobalState.sessionsByPartyId, partyId, session);
        }

        GlobalState.sessionIndexSnapshots.set(session, { levelScope, partyId, roomId });
    }

    static refreshSessionIndexesByCharacterName(name: unknown): void {
        const characterKey = normalizeCharacterKey(name);
        if (!characterKey) {
            return;
        }
        const session = GlobalState.sessionsByCharacterName.get(characterKey);
        if (session) {
            GlobalState.refreshSessionIndexes(session);
        }
    }

    static getSessionsInLevelScope(levelScope: string | null | undefined): ReadonlySet<Client> {
        return GlobalState.sessionsByLevelScope.get(String(levelScope ?? '')) ?? GlobalState.EMPTY_SESSION_SET;
    }

    static getSessionsInParty(partyId: number | null | undefined): ReadonlySet<Client> {
        const normalizedPartyId = Math.max(0, Math.round(Number(partyId ?? 0)));
        const indexed = GlobalState.sessionsByPartyId.get(normalizedPartyId);
        if (indexed || normalizedPartyId <= 0) {
            return indexed ?? GlobalState.EMPTY_SESSION_SET;
        }

        // Compatibility for tests and maintenance scripts that mutate the
        // legacy party maps directly. Runtime party flows refresh eagerly.
        for (const session of GlobalState.indexedSessionsByToken.values()) {
            const characterKey = normalizeCharacterKey(session.character?.name);
            if (Number(GlobalState.partyByMember.get(characterKey) ?? 0) === normalizedPartyId) {
                GlobalState.refreshSessionIndexes(session);
            }
        }
        return GlobalState.sessionsByPartyId.get(normalizedPartyId) ?? GlobalState.EMPTY_SESSION_SET;
    }

    static getSessionsInRoom(levelScope: string | null | undefined, roomId: number | null | undefined): ReadonlySet<Client> {
        const normalizedRoomId = Math.round(Number(roomId ?? -1));
        if (!Number.isFinite(normalizedRoomId) || normalizedRoomId < 0) {
            return GlobalState.EMPTY_SESSION_SET;
        }
        return GlobalState.sessionsByRoom.get(String(levelScope ?? ''))?.get(normalizedRoomId) ?? GlobalState.EMPTY_SESSION_SET;
    }

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

    static normalizeRemoteAddress(value: string | null | undefined): string {
        const address = String(value ?? '').trim();
        if (!address) {
            return '';
        }
        if (address.startsWith('::ffff:')) {
            return address.slice('::ffff:'.length);
        }
        return address === '::1' ? '127.0.0.1' : address;
    }

    static rememberDiscordOAuthLogin(remoteAddress: string | null | undefined, account: UserAccount): boolean {
        const normalizedAddress = GlobalState.normalizeRemoteAddress(remoteAddress);
        if (!normalizedAddress || !account?.user_id) {
            return false;
        }

        const now = Date.now();
        GlobalState.purgeExpiredDiscordOAuthLogins(now);
        GlobalState.pendingDiscordOAuthLogins.set(normalizedAddress, {
            account,
            remoteAddress: normalizedAddress,
            createdAt: now,
            expiresAt: now + GlobalState.PENDING_DISCORD_OAUTH_LOGIN_TTL_MS
        });
        return true;
    }

    static consumeDiscordOAuthLogin(
        remoteAddress: string | null | undefined,
        expectedIdentifier?: string | null
    ): PendingDiscordOAuthLogin | null {
        const normalizedAddress = GlobalState.normalizeRemoteAddress(remoteAddress);
        if (!normalizedAddress) {
            return null;
        }

        const now = Date.now();
        GlobalState.purgeExpiredDiscordOAuthLogins(now);
        const pending = GlobalState.pendingDiscordOAuthLogins.get(normalizedAddress);
        if (!pending || pending.expiresAt <= now) {
            GlobalState.pendingDiscordOAuthLogins.delete(normalizedAddress);
            return null;
        }

        if (expectedIdentifier && !GlobalState.accountMatchesIdentifier(pending.account, expectedIdentifier)) {
            return null;
        }

        GlobalState.pendingDiscordOAuthLogins.delete(normalizedAddress);
        return pending;
    }

    static peekDiscordOAuthLogin(remoteAddress: string | null | undefined): PendingDiscordOAuthLogin | null {
        const normalizedAddress = GlobalState.normalizeRemoteAddress(remoteAddress);
        if (!normalizedAddress) {
            return null;
        }

        const now = Date.now();
        GlobalState.purgeExpiredDiscordOAuthLogins(now);
        const pending = GlobalState.pendingDiscordOAuthLogins.get(normalizedAddress);
        if (!pending || pending.expiresAt <= now) {
            GlobalState.pendingDiscordOAuthLogins.delete(normalizedAddress);
            return null;
        }

        return pending;
    }

    private static purgeExpiredDiscordOAuthLogins(now: number = Date.now()): void {
        for (const [remoteAddress, pending] of GlobalState.pendingDiscordOAuthLogins.entries()) {
            if (pending.expiresAt <= now) {
                GlobalState.pendingDiscordOAuthLogins.delete(remoteAddress);
            }
        }
    }

    private static normalizeAccountIdentifier(value: unknown): string {
        return typeof value === 'string' ? value.trim().toLowerCase() : '';
    }

    static getAccountIdentityIdentifiers(account: Pick<UserAccount, 'email' | 'emailAliases' | 'discordEmail'> | null | undefined): Set<string> {
        const identifiers = new Set<string>();
        const add = (value: unknown): void => {
            const normalized = GlobalState.normalizeAccountIdentifier(value);
            if (normalized) {
                identifiers.add(normalized);
            }
        };

        add(account?.email);
        add(account?.discordEmail);
        if (Array.isArray(account?.emailAliases)) {
            for (const alias of account.emailAliases) {
                add(alias);
            }
        }

        return identifiers;
    }

    static accountsShareIdentity(
        left: Pick<UserAccount, 'email' | 'emailAliases' | 'discordEmail'> | null | undefined,
        right: Pick<UserAccount, 'email' | 'emailAliases' | 'discordEmail'> | null | undefined
    ): boolean {
        const leftIdentifiers = GlobalState.getAccountIdentityIdentifiers(left);
        if (leftIdentifiers.size === 0) {
            return false;
        }

        for (const identifier of GlobalState.getAccountIdentityIdentifiers(right)) {
            if (leftIdentifiers.has(identifier)) {
                return true;
            }
        }

        return false;
    }

    private static accountMatchesIdentifier(account: UserAccount, identifier: string): boolean {
        const normalizedIdentifier = GlobalState.normalizeAccountIdentifier(identifier);
        if (!normalizedIdentifier) {
            return false;
        }

        return GlobalState.getAccountIdentityIdentifiers(account).has(normalizedIdentifier);
    }

    static isClientConnectionOpen(session: Client | null | undefined): session is Client {
        if (!session) {
            return false;
        }

        const socket = (session as unknown as { socket?: { destroyed?: boolean; readyState?: string } }).socket;
        return !socket || (!socket.destroyed && socket.readyState !== 'closed');
    }

    static getOpenClients(): Client[] {
        const seen = new Set<Client>();
        const clients: Client[] = [];
        const add = (session: Client | null | undefined): void => {
            if (!GlobalState.isClientConnectionOpen(session) || seen.has(session)) {
                return;
            }

            seen.add(session);
            clients.push(session);
        };

        for (const client of GlobalState.clients) {
            add(client);
        }
        for (const session of GlobalState.sessionsByToken.values()) {
            add(session);
        }
        for (const session of GlobalState.sessionsByUserId.values()) {
            add(session);
        }
        for (const session of GlobalState.sessionsByCharacterName.values()) {
            add(session);
        }

        return clients;
    }

    static isSessionOpen(session: Client | null | undefined): session is Client {
        if (!session?.character) {
            return false;
        }

        return GlobalState.isClientConnectionOpen(session);
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

    /**
     * Finds the active session for an account by its primary character name. The
     * player may be online as a different character of the same account, so the
     * exact-name index is checked first and then every active session's account
     * roster is scanned for the primary name.
     */
    static getActiveSessionForAccount(name: unknown): Client | null {
        const direct = GlobalState.getActiveSessionByCharacterName(name);
        if (direct) {
            return direct;
        }

        const primaryKey = normalizeCharacterKey(name);
        if (!primaryKey) {
            return null;
        }

        for (const session of GlobalState.sessionsByToken.values()) {
            if (!GlobalState.isSessionOpen(session) || !session.character) {
                continue;
            }
            if (normalizeCharacterKey(getAccountPrimaryCharacterName(session.characters)) === primaryKey) {
                return session;
            }
        }

        return null;
    }
}
