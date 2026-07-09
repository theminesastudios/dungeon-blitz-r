import { Character, UserAccount } from '../database/Database';
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
    instanceId?: string;
    instanceCreatedAt?: number;
    partyId?: number;
    ownerToken?: number;
    ownerName?: string;
    missionId?: number;
    bossCanonicalId?: number;
    completionRequested?: boolean;
    bossDeathCommitted?: boolean;
    bossDead?: boolean;
    bossTombstoned?: boolean;
    bossRespawnBlocked?: boolean;
    bossDeathRoomId?: number;
    postDeathCutsceneStarted?: boolean;
    postDeathCutsceneFinished?: boolean;
    postDeathCutsceneStartedAt?: number;
    postDeathCutsceneFinishedAt?: number;
    postDeathCutsceneWatchdogArmed?: boolean;
    completionFinalized?: boolean;
    pendingCompletion?: boolean;
    postDeathCutsceneExpectedTokens?: Set<number>;
    postDeathCutsceneAckTokens?: Set<number>;
    statsDeliveredTokens?: Set<number>;
    trackedHostileIds?: Set<number>;
    defeatedHostileIds?: Set<number>;
    lastLoggedRequiredTotal?: number;
    lastLoggedRequiredDefeated?: number;
    lastLoggedRequiredProgress?: number;
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
    // Boss-intro close barrier (East Wing): tokens whose own client started
    // the intro cutscene (sent 0xA5 themselves) and tokens that closed it.
    // The shared intro only completes once every eligible active client has
    // closed, so an early finisher cannot tear down a late joiner's intro.
    introActiveClientTokens?: Set<number>;
    introClosedClientTokens?: Set<number>;
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

    private static accountMatchesIdentifier(account: UserAccount, identifier: string): boolean {
        const normalizedIdentifier = GlobalState.normalizeAccountIdentifier(identifier);
        if (!normalizedIdentifier) {
            return false;
        }
        if (GlobalState.normalizeAccountIdentifier(account.email) === normalizedIdentifier) {
            return true;
        }
        if (GlobalState.normalizeAccountIdentifier(account.discordEmail) === normalizedIdentifier) {
            return true;
        }
        return Array.isArray(account.emailAliases) &&
            account.emailAliases.some((alias) => GlobalState.normalizeAccountIdentifier(alias) === normalizedIdentifier);
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
