import * as net from 'net';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { PacketRouter } from '../network/packetRouter';
import { UserAccount, Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import type { DungeonRunStats } from './DungeonRunStats';
import { clearStoredDungeonSnapshot } from './DungeonSnapshot';
import { LevelConfig } from './LevelConfig';
import { MovementAuthority, MovementAuthorityState } from './MovementAuthority';
import { CastRateAuthority, CastRateState } from './CastRateAuthority';
import { performance } from 'perf_hooks';
import { getActiveMovementPacketKey, mergeActiveMovementPackets } from '../network/movementPacket';
import { RegionPositionPersistence } from './RegionPositionPersistence';

const db = new JsonAdapter();
const SOCKET_POLICY_REQUEST = '<policy-file-request/>';
const SOCKET_POLICY_RESPONSE = `<?xml version="1.0"?>
<!DOCTYPE cross-domain-policy SYSTEM
  "http://www.adobe.com/xml/dtds/cross-domain-policy.dtd">
<cross-domain-policy>
  <allow-access-from domain="*" to-ports="1-65535" secure="false"/>
</cross-domain-policy>\0`;

export interface PendingLootDrop {
    gold?: number;
    health?: number;
    gear?: number;
    tier?: number;
    material?: number;
    dye?: number;
    __lootDropMetadata?: {
        lootdropId: number;
        lootDropNonce: string;
        sourceEnemyLootDropNonce: string;
        sourceEnemyCanonicalId: number;
        ownerToken: number;
        partyId: number;
        sharedScope: string;
        amount: number;
        type: string;
        reason: string;
        caller: string;
        collected: boolean;
        collectedBy: number;
    };
}

export interface KeepTutorialState {
    phase: number;
    bossDefeated: boolean;
    bossIntroForced: boolean;
    bossRecoveryArmed: boolean;
    forcedLastGuyId: number | null;
    bossEntitySeen: number | null;
    bossEntitySource: 'client' | 'fallback' | null;
    introSkitSent: boolean;
    bossMusicStarted: boolean;
    bossInfoSentIds: Set<number>;
    introTimers: NodeJS.Timeout[];
    recoverySpawnTimer: NodeJS.Timeout | null;
    recoveryActivateTimer: NodeJS.Timeout | null;
    bossWounded60: boolean;
    bossWounded30: boolean;
    helperEntityIds: number[];
    helperWaveActiveIds: number[];
    helperWaveRespawnTimer: NodeJS.Timeout | null;
    helperWaveCursor: number;
    helperWaveUseSmallNext: boolean;
}

interface SessionCleanupSnapshot {
    userId: number | null;
    token: number;
    authenticated: boolean;
    characterName: string;
    normalizedCharName: string;
}

type QueuedPacket = {
    packetId: number;
    data: Buffer;
    enqueuedAt: number;
    depthAtEnqueue: number;
    coalesceKey: string | null;
};

export function createKeepTutorialState(): KeepTutorialState {
    return {
        phase: 0,
        bossDefeated: false,
        bossIntroForced: false,
        bossRecoveryArmed: false,
        forcedLastGuyId: null,
        bossEntitySeen: null,
        bossEntitySource: null,
        introSkitSent: false,
        bossMusicStarted: false,
        bossInfoSentIds: new Set<number>(),
        introTimers: [],
        recoverySpawnTimer: null,
        recoveryActivateTimer: null,
        bossWounded60: false,
        bossWounded30: false,
        helperEntityIds: [],
        helperWaveActiveIds: [],
        helperWaveRespawnTimer: null,
        helperWaveCursor: 0,
        helperWaveUseSmallNext: false,
    };
}

export function clearKeepTutorialTimers(state: KeepTutorialState | null | undefined): void {
    if (!state) {
        return;
    }

    if (state.recoverySpawnTimer) {
        clearTimeout(state.recoverySpawnTimer);
        state.recoverySpawnTimer = null;
    }

    for (const timer of state.introTimers) {
        clearTimeout(timer);
    }
    state.introTimers = [];

    if (state.recoveryActivateTimer) {
        clearTimeout(state.recoveryActivateTimer);
        state.recoveryActivateTimer = null;
    }

    if (state.helperWaveRespawnTimer) {
        clearTimeout(state.helperWaveRespawnTimer);
        state.helperWaveRespawnTimer = null;
    }
}

export function clearClientSpawnFallbackTimer(client: Pick<Client, 'clientSpawnFallbackTimer'>): void {
    if (client.clientSpawnFallbackTimer) {
        clearTimeout(client.clientSpawnFallbackTimer);
        client.clientSpawnFallbackTimer = null;
    }
}

export class Client {
    private static readonly PENDING_TRANSFER_GRACE_MS = 15000;
    private static readonly DEFAULT_DEFERRED_CHARACTER_SAVE_MS = 150;
    private static readonly COMBAT_REWARD_DEFERRED_CHARACTER_SAVE_MS = 2500;
    private static readonly PENDING_LOOT_DEFERRED_CHARACTER_SAVE_MS = 750;
    private static readonly MAX_BUFFERED_PACKET_BYTES = 1024 * 1024;
    private static readonly MAX_QUEUED_PACKETS = 2048;
    private static readonly QUIET_SOCKET_ERROR_CODES = new Set([
        'ECONNABORTED',
        'ECONNRESET',
        'EPIPE'
    ]);

    public socket: net.Socket;
    public router: PacketRouter;
    private buffer: Buffer;
    private packetQueue: QueuedPacket[];
    private queuedMovementByKey: Map<string, QueuedPacket>;
    private packetQueueDrainActive: boolean;
    private packetQueueEnqueued: number;
    private packetQueueProcessed: number;
    private packetQueueCoalesced: number;
    private packetQueueMaxDepth: number;
    private outboundUncorkScheduled: boolean;
    private rawBytesIn: number;
    private rawBytesOut: number;

    // Session State
    public userId: number | null = null;
    public authenticated: boolean = false;
    public account: UserAccount | null = null;
    public characters: Character[] = [];
    public character: Character | null = null;
    public challengeStr: string = "";

    // Entity State
    //
    // token / currentLevel / levelInstanceId / currentRoomId are the four fields the session
    // indexes are derived from, so they write through to those indexes instead of relying on
    // every caller to remember `GlobalState.refreshSessionIndexes`. One missed refresh used to
    // leave a live player out of `sessionsByLevelScope` for the rest of the run: everything
    // fanned out over that index -- movement relay, combat, cutscenes, progress -- silently
    // skipped them, while their own lookups used their own scope and looked fine. The visible
    // result after a door was a party member drawn once and then frozen at the spot they were
    // seeded at, because the body arrived (visibility scans live sessions) but not one
    // movement packet ever followed it. Deriving the index on write makes that unrepresentable.
    private _token: number = 0;
    private _currentLevel: string = "";
    private _levelInstanceId: string = "";
    private _currentRoomId: number = -1;

    private reindexSession(): void {
        const { GlobalState } = require('./GlobalState') as typeof import('./GlobalState');
        GlobalState.refreshSessionIndexes(this);
    }

    public get token(): number {
        return this._token;
    }

    public set token(value: number) {
        if (this._token === value) {
            return;
        }
        this._token = value;
        this.reindexSession();
    }

    public get currentLevel(): string {
        return this._currentLevel;
    }

    public set currentLevel(value: string) {
        if (this._currentLevel === value) {
            return;
        }
        this._currentLevel = value;
        this.reindexSession();
    }

    public get levelInstanceId(): string {
        return this._levelInstanceId;
    }

    public set levelInstanceId(value: string) {
        if (this._levelInstanceId === value) {
            return;
        }
        this._levelInstanceId = value;
        this.reindexSession();
    }

    public get currentRoomId(): number {
        return this._currentRoomId;
    }

    public set currentRoomId(value: number) {
        if (this._currentRoomId === value) {
            return;
        }
        this._currentRoomId = value;
        this.reindexSession();
    }

    public clientEntID: number = 0;
    public entities: Map<number, any> = new Map();
    public craftTownHostCharacter: Character | null = null;
    public entryLevel: string = "";
    public entryX: number = 0;
    public entryY: number = 0;
    public entryHasCoord: boolean = false;
    public lastDoorId: number = -1;
    public lastDoorTargetLevel: string = "";
    public playerSpawned: boolean = false;
    public playSessionStartedAt: number = Date.now();
    public worldEnteredAt: number = Date.now();
    public partyMapX: number = 0;
    public partyMapY: number = 0;
    public syncAnchorStartedAt: number = 0;
    public syncAnchorToken: number = 0;
    public syncAnchorCharacterName: string = "";
    public syncQuestProgress: number | undefined;
    public pendingTransferUntil: number = 0;
    /** Armed by a party "Go to" transfer; consumed once by this session's first spawn. */
    public partyArrivalEffectPending: boolean = false;
    /**
     * While this is in the future, every screen that is handed this player's body plays the
     * arrival materialisation on it -- once each, tracked by `arrivalEffectSentToTokens`.
     *
     * Firing it per viewer, at the moment that viewer receives the body, is the only timing
     * that works: the traveller's own screen is behind a loading card, and a party member who
     * is still loading, or whose copy of the body was refused for being airborne, gets the
     * effect whenever their copy actually appears rather than missing it.
     */
    public arrivalEffectWindowUntil: number = 0;
    public arrivalEffectSentToTokens: Set<number> = new Set();
    public mountTransferGraceUntil: number = 0;
    public roomTransitionGraceUntil: number = 0;
    public movementAuthority: MovementAuthorityState = MovementAuthority.createState();
    public castRate: CastRateState = CastRateAuthority.createState();
    public startedRoomEvents: Set<string> = new Set();
    public knownEntityIds: Set<number> = new Set();
    /**
     * Which room each remote player body was last *drawn* in on this client.
     *
     * The client has no reader for `PKTTYPE_ENT_FULL_UPDATE` (0x08) at all -- it only ever
     * sends that packet -- so a remote body can be moved by exactly two things: relayed 0x07
     * deltas, or a fresh 0x0F spawn. A room change is a teleport that produces no deltas, so
     * unless the server re-seeds the body it stays in the room it was drawn in, forever.
     * Comparing this against the subject's current room is what tells the server the copy on
     * this screen is in the wrong room and has to be drawn again.
     */
    public drawnPlayerRoomIds: Map<number, number> = new Map();
    /**
     * What this screen currently shows for each other player's health bar, keyed by their entity
     * id.
     *
     * A party frame is driven by the HP deltas this client receives, so its bar is the sum of
     * whatever happened to arrive -- room filters, packets sent before the body was drawn, a
     * death announced as a state packet carrying no health. It drifts from the real figure and
     * nothing brought it back, which is why a member could be dead, or at a fifth of their
     * health, and still read as nearly full on somebody else's frame. The reconcile sweep
     * compares this against the owner's real health and sends the difference.
     */
    public partyFrameHpByEntityId: Map<number, number> = new Map();
    public entityIdAliases: Map<number, number> = new Map();
    public sharedEntityRemoteUpdateDeferredIds: Set<number> = new Set();
    public pendingLoot: Map<number, PendingLootDrop> = new Map();
    public processedRewardSources: Set<string> = new Set();
    public triggeredLevelStates: Set<string> = new Set();
    public dungeonRun: DungeonRunStats | null = null;
    public pendingMissionTurnIns: Set<number> = new Set();
    public authoritativeMaxHp: number = 100;
    /**
     * Defense, as the client reports it on packet 0xFC. Zero until the patched client sends
     * it -- a browser can serve a cached SWF older than the server, so nothing may assume it
     * is populated.
     */
    public authoritativeArmorClass: number = 0;
    /** Last mana the client reported over packet 0xCB. Diagnostic only -- never trusted. */
    public lastReportedMana: number = 0;
    public authoritativeCurrentHp: number = 100;
    public combatStatsDirty: boolean = false;
    public allowDirtyCombatStatsRegen: boolean = false;
    public lastCombatStatsRefreshRequestAt: number = 0;
    public lastCombatStatsSyncedAt: number = 0;
    public pendingRespawnRequest: { usePotion: boolean; requestedAt: number } | null = null;
    public pendingRespawnTimer: NodeJS.Timeout | null = null;
    public respawnPotionCharged: boolean = false;
    public lastCombatActivityAt: number = 0;
    public lastCombatRegenTickAt: number = 0;
    public enemyDeathRegenArmed: boolean = false;
    public activePotionDrainAtMs: number = 0;
    public clientSpawnConfirmed: boolean = false;
    public clientSpawnFallbackTimer: NodeJS.Timeout | null = null;
    public talentResearchTimer: NodeJS.Timeout | null = null;
    public keepTutorialState: KeepTutorialState | null = null;
    public goblinRiverBossIntroLockUntil: number = 0;
    public goblinRiverBossIntroUnlockTimer: NodeJS.Timeout | null = null;
    public pendingDungeonCompletionScope: string = "";
    public pendingDungeonCompletionRequestedAt: number = 0;
    public pendingDungeonCompletionLastSkitAt: number = 0;
    public pendingDungeonCompletionNotBeforeAt: number = 0;
    public pendingDungeonCompletionSettleMs: number = 0;
    public pendingDungeonCompletionPayload: Buffer | null = null;
    public pendingDungeonCompletionTimer: NodeJS.Timeout | null = null;
    public pendingDungeonCompletionFlushActive: boolean = false;
    public deferredCharacterSaveTimer: NodeJS.Timeout | null = null;
    public deferredCharacterSaveReason: string = "";
    private deferredCharacterSaveInFlight: Promise<void> | null = null;
    private deferredCharacterSaveGeneration: number = 0;
    public activeDungeonCutsceneScope: string = "";
    public activeDungeonCutsceneRoomId: number = 0;
    public activeDungeonCutsceneJoinedAtDialogIndex: number = 0;
    public activeDungeonCutsceneLocalDialogIndex: number = 0;
    public lastDungeonCutsceneStartScope: string = "";
    public lastDungeonCutsceneStartAt: number = 0;
    public lastDungeonCutsceneEndScope: string = "";
    public lastDungeonCutsceneEndAt: number = 0;

    constructor(socket: net.Socket, router: PacketRouter) {
        this.socket = socket;
        this.router = router;
        this.buffer = Buffer.alloc(0);
        this.packetQueue = [];
        this.queuedMovementByKey = new Map();
        this.packetQueueDrainActive = false;
        this.packetQueueEnqueued = 0;
        this.packetQueueProcessed = 0;
        this.packetQueueCoalesced = 0;
        this.packetQueueMaxDepth = 0;
        this.outboundUncorkScheduled = false;
        this.rawBytesIn = 0;
        this.rawBytesOut = 0;

        this.socket.on('data', (data: Buffer) => this.onData(data));
        this.socket.on('end', () => this.onEnd());
        this.socket.on('close', (hadError: boolean) => this.onClose(hadError));
        this.socket.on('error', (err: Error) => this.onError(err));
    }

    private onData(data: Buffer): void {
        this.rawBytesIn += data.length;
        this.buffer = Buffer.concat([this.buffer, data]);

        if (this.buffer.length > Client.MAX_BUFFERED_PACKET_BYTES) {
            console.warn(`[Client] Closing oversized buffered input bytes=${this.buffer.length} token=${this.token}`);
            this.buffer = Buffer.alloc(0);
            this.socket.destroy();
            return;
        }

        if (this.tryServeSocketPolicy()) {
            return;
        }
        
        while (this.buffer.length >= 4) {
            // Read Header
            const packetId = this.buffer.readUInt16BE(0);
            const length = this.buffer.readUInt16BE(2);
            const total = 4 + length;

            if (this.buffer.length < total) {
                break; // Wait for more data
            }

            const payload = Buffer.from(this.buffer.subarray(4, total));
            this.buffer = this.buffer.subarray(total);

            this.enqueuePacket(packetId, payload);
        }
    }

    private enqueuePacket(packetId: number, data: Buffer): void {
        const enqueuedAt = performance.now();
        const coalesceKey = getActiveMovementPacketKey(packetId, data);
        this.packetQueueEnqueued += 1;

        if (coalesceKey) {
            const queued = this.queuedMovementByKey.get(coalesceKey);
            if (queued) {
                const merged = mergeActiveMovementPackets(queued.data, data);
                if (merged) {
                    queued.data = merged;
                    queued.enqueuedAt = enqueuedAt;
                    this.packetQueueCoalesced += 1;
                    return;
                }
            }
        } else {
            // Ordered packets are barriers. A later movement update must not
            // be folded into a movement update that precedes combat/death.
            this.queuedMovementByKey.clear();
        }

        if (this.packetQueue.length >= Client.MAX_QUEUED_PACKETS) {
            console.warn(`[Client] Closing excessive packet queue count=${this.packetQueue.length} token=${this.token}`);
            this.buffer = Buffer.alloc(0);
            this.socket.destroy();
            return;
        }

        const queuedPacket: QueuedPacket = {
            packetId,
            data,
            enqueuedAt,
            depthAtEnqueue: this.packetQueue.length + 1,
            coalesceKey
        };
        this.packetQueue.push(queuedPacket);
        if (coalesceKey) {
            this.queuedMovementByKey.set(coalesceKey, queuedPacket);
        }
        this.packetQueueMaxDepth = Math.max(this.packetQueueMaxDepth, this.packetQueue.length);
        this.router.noteQueueDepth(this, this.packetQueue.length);
        void this.drainPacketQueue();
    }

    private async drainPacketQueue(): Promise<void> {
        if (this.packetQueueDrainActive) {
            return;
        }
        this.packetQueueDrainActive = true;
        try {
            while (this.packetQueue.length > 0) {
                const packet = this.packetQueue.shift();
                if (!packet) {
                    break;
                }
                if (packet.coalesceKey && this.queuedMovementByKey.get(packet.coalesceKey) === packet) {
                    this.queuedMovementByKey.delete(packet.coalesceKey);
                }
                await this.router.handle(this, packet.packetId, packet.data, {
                    enqueuedAt: packet.enqueuedAt,
                    depthAtEnqueue: packet.depthAtEnqueue
                });
                this.packetQueueProcessed += 1;
            }
        } catch (err) {
            console.error('[Client] Packet queue drain failed:', err);
        } finally {
            this.packetQueueDrainActive = false;
            if (this.packetQueue.length > 0) {
                void this.drainPacketQueue();
            }
        }
    }

    public getPacketQueueMetrics(): {
        enqueued: number;
        processed: number;
        coalesced: number;
        currentDepth: number;
        maxDepth: number;
    } {
        return {
            enqueued: this.packetQueueEnqueued,
            processed: this.packetQueueProcessed,
            coalesced: this.packetQueueCoalesced,
            currentDepth: this.packetQueue.length,
            maxDepth: this.packetQueueMaxDepth
        };
    }

    private tryServeSocketPolicy(): boolean {
        if (this.buffer.length === 0 || this.buffer[0] !== 0x3c) {
            return false;
        }

        const incoming = this.buffer.toString('utf8');
        if (!incoming.includes(SOCKET_POLICY_REQUEST)) {
            return false;
        }

        const addr = `${this.socket.remoteAddress}:${this.socket.remotePort}`;
        this.rawBytesOut += Buffer.byteLength(SOCKET_POLICY_RESPONSE);
        this.buffer = Buffer.alloc(0);
        console.log(`[Client] Served inline socket policy to ${addr}`);
        this.socket.end(SOCKET_POLICY_RESPONSE);
        return true;
    }

    private scheduleOutboundUncork(): void {
        if (this.outboundUncorkScheduled) {
            return;
        }

        this.outboundUncorkScheduled = true;
        this.socket.cork();
        process.nextTick(() => {
            this.outboundUncorkScheduled = false;
            if (!this.socket.destroyed) {
                this.socket.uncork();
            }
        });
    }

    public send(packetId: number, buffer: Buffer): void {
        const header = Buffer.alloc(4);
        header.writeUInt16BE(packetId, 0);
        header.writeUInt16BE(buffer.length, 2);
        const payload = Buffer.concat([header, buffer]);
        this.rawBytesOut += payload.length;
        this.scheduleOutboundUncork();
        this.socket.write(payload);
    }

    public sendBitBuffer(packetId: number, bb: BitBuffer): void {
        this.send(packetId, bb.toBuffer());
    }

    private resolveDeferredCharacterSaveDelay(reason: string, delayMs: number | undefined): number {
        if (delayMs !== undefined) {
            return Math.max(0, Math.round(Number(delayMs ?? 0)));
        }

        const normalizedReason = String(reason ?? '').trim().toLowerCase();
        if (
            normalizedReason === 'reward grant' ||
            normalizedReason === 'enemy kill mission progress'
        ) {
            return Client.COMBAT_REWARD_DEFERRED_CHARACTER_SAVE_MS;
        }

        if (normalizedReason === 'loot pickup' && this.pendingLoot.size > 0) {
            return Client.PENDING_LOOT_DEFERRED_CHARACTER_SAVE_MS;
        }

        return Client.DEFAULT_DEFERRED_CHARACTER_SAVE_MS;
    }

    public scheduleCharacterSave(reason: string, delayMs?: number): void {
        if (!this.userId || !this.character) {
            return;
        }

        this.deferredCharacterSaveGeneration += 1;
        this.deferredCharacterSaveReason = reason;
        if (this.deferredCharacterSaveTimer) {
            clearTimeout(this.deferredCharacterSaveTimer);
        }

        const safeDelay = this.resolveDeferredCharacterSaveDelay(reason, delayMs);
        this.deferredCharacterSaveTimer = setTimeout(() => {
            this.deferredCharacterSaveTimer = null;
            void this.flushDeferredCharacterSave(reason);
        }, safeDelay);
        this.deferredCharacterSaveTimer.unref?.();
    }

    public async flushCharacterSave(reason: string): Promise<void> {
        if (!this.userId || !this.character) {
            return;
        }

        this.deferredCharacterSaveGeneration += 1;
        this.deferredCharacterSaveReason = reason;
        if (this.deferredCharacterSaveTimer) {
            clearTimeout(this.deferredCharacterSaveTimer);
            this.deferredCharacterSaveTimer = null;
        }

        await this.flushDeferredCharacterSave(reason);
    }

    private async flushDeferredCharacterSave(reason: string): Promise<void> {
        if (this.deferredCharacterSaveInFlight) {
            await this.deferredCharacterSaveInFlight.catch(() => undefined);
        }

        const userId = this.userId;
        const character = this.character;
        const generation = this.deferredCharacterSaveGeneration;
        if (!userId || !character) {
            return;
        }

        const save = db.saveCharacterSnapshot(userId, character).then((characters) => {
            if (this.userId === userId && this.character === character) {
                this.characters = characters;
            }
        }).catch((err) => {
            console.error(`[Client] Deferred character save failed after ${this.deferredCharacterSaveReason || reason}:`, err);
        });
        this.deferredCharacterSaveInFlight = save;
        await save;
        if (this.deferredCharacterSaveInFlight === save) {
            this.deferredCharacterSaveInFlight = null;
        }

        if (generation !== this.deferredCharacterSaveGeneration && !this.deferredCharacterSaveTimer) {
            this.deferredCharacterSaveTimer = setTimeout(() => {
                this.deferredCharacterSaveTimer = null;
                void this.flushDeferredCharacterSave(this.deferredCharacterSaveReason || reason);
            }, 0);
            this.deferredCharacterSaveTimer.unref?.();
        }
    }

    public armPendingTransferGrace(durationMs: number = Client.PENDING_TRANSFER_GRACE_MS): void {
        this.pendingTransferUntil = Math.max(this.pendingTransferUntil, Date.now() + Math.max(0, durationMs));
    }

    private createSessionCleanupSnapshot(): SessionCleanupSnapshot {
        const characterName = String(this.character?.name ?? '').trim();

        return {
            userId: this.userId,
            token: this.token,
            authenticated: this.authenticated,
            characterName,
            normalizedCharName: characterName.toLowerCase()
        };
    }

    private hasReusableSessionState(): boolean {
        if (
            this.authenticated ||
            this.userId !== null ||
            this.character !== null ||
            this.characters.length > 0 ||
            this.token > 0 ||
            this.playerSpawned ||
            this.currentLevel.length > 0 ||
            this.entities.size > 0
        ) {
            return true;
        }

        const { GlobalState } = require('./GlobalState') as typeof import('./GlobalState');
        return (
            Array.from(GlobalState.sessionsByToken.values()).some((session) => session === this) ||
            Array.from(GlobalState.sessionsByUserId.values()).some((session) => session === this) ||
            Array.from(GlobalState.sessionsByCharacterName.values()).some((session) => session === this)
        );
    }

    private clearGameplayState(): void {
        this.token = 0;
        this.clientEntID = 0;
        this.entities.clear();
        this.currentLevel = "";
        this.levelInstanceId = "";
        this.entryLevel = "";
        this.entryX = 0;
        this.entryY = 0;
        this.entryHasCoord = false;
        this.currentRoomId = -1;
        this.lastDoorId = -1;
        this.lastDoorTargetLevel = "";
        this.playerSpawned = false;
        this.playSessionStartedAt = Date.now();
        this.partyMapX = 0;
        this.partyMapY = 0;
        this.syncAnchorStartedAt = 0;
        this.syncAnchorToken = 0;
        this.syncAnchorCharacterName = "";
        this.syncQuestProgress = undefined;
        this.pendingTransferUntil = 0;
        this.partyArrivalEffectPending = false;
        this.arrivalEffectWindowUntil = 0;
        this.arrivalEffectSentToTokens.clear();
        this.mountTransferGraceUntil = 0;
        this.roomTransitionGraceUntil = 0;
        MovementAuthority.reset(this, 'gameplay_state_clear');
        this.startedRoomEvents.clear();
        this.knownEntityIds.clear();
        this.entityIdAliases.clear();
        this.sharedEntityRemoteUpdateDeferredIds.clear();
        this.pendingLoot.clear();
        this.processedRewardSources.clear();
        this.dungeonRun = null;
        this.pendingMissionTurnIns.clear();
        this.authoritativeMaxHp = 100;
        this.authoritativeArmorClass = 0;
        this.authoritativeCurrentHp = 100;
        this.combatStatsDirty = false;
        this.allowDirtyCombatStatsRegen = false;
        this.lastCombatStatsRefreshRequestAt = 0;
        this.lastCombatStatsSyncedAt = 0;
        this.pendingRespawnRequest = null;
        if (this.pendingRespawnTimer) {
            clearTimeout(this.pendingRespawnTimer);
            this.pendingRespawnTimer = null;
        }
        this.respawnPotionCharged = false;
        this.lastCombatActivityAt = 0;
        this.lastCombatRegenTickAt = 0;
        this.enemyDeathRegenArmed = false;
        this.clientSpawnConfirmed = false;
        clearClientSpawnFallbackTimer(this);
        if (this.talentResearchTimer) {
            clearTimeout(this.talentResearchTimer);
            this.talentResearchTimer = null;
        }
        clearKeepTutorialTimers(this.keepTutorialState);
        this.keepTutorialState = null;
        if (this.goblinRiverBossIntroUnlockTimer) {
            clearTimeout(this.goblinRiverBossIntroUnlockTimer);
            this.goblinRiverBossIntroUnlockTimer = null;
        }
        this.goblinRiverBossIntroLockUntil = 0;
        this.pendingDungeonCompletionScope = "";
        this.pendingDungeonCompletionRequestedAt = 0;
        this.pendingDungeonCompletionLastSkitAt = 0;
        this.pendingDungeonCompletionNotBeforeAt = 0;
        this.pendingDungeonCompletionSettleMs = 0;
        this.pendingDungeonCompletionPayload = null;
        if (this.pendingDungeonCompletionTimer) {
            clearTimeout(this.pendingDungeonCompletionTimer);
            this.pendingDungeonCompletionTimer = null;
        }
        this.pendingDungeonCompletionFlushActive = false;
        this.activeDungeonCutsceneScope = "";
        this.activeDungeonCutsceneRoomId = 0;
        this.activeDungeonCutsceneJoinedAtDialogIndex = 0;
        this.activeDungeonCutsceneLocalDialogIndex = 0;
        this.lastDungeonCutsceneStartScope = "";
        this.lastDungeonCutsceneStartAt = 0;
        this.lastDungeonCutsceneEndScope = "";
        this.lastDungeonCutsceneEndAt = 0;
    }

    private clearIdentityState(): void {
        if (this.deferredCharacterSaveTimer) {
            clearTimeout(this.deferredCharacterSaveTimer);
            this.deferredCharacterSaveTimer = null;
        }
        this.deferredCharacterSaveReason = "";
        this.userId = null;
        this.authenticated = false;
        this.account = null;
        this.characters = [];
        this.character = null;
        this.challengeStr = "";
    }

    private isTransferInProgressOnClose(snapshot: SessionCleanupSnapshot): boolean {
        const { GlobalState } = require('./GlobalState') as typeof import('./GlobalState');
        const pendingWorldTransfer = Boolean(
            snapshot.userId &&
            snapshot.normalizedCharName &&
            Array.from(GlobalState.pendingWorld.values()).some((entry) =>
                entry.userId === snapshot.userId &&
                String(entry.character?.name ?? '').trim().toLowerCase() === snapshot.normalizedCharName
            )
        );

        if (pendingWorldTransfer) {
            return true;
        }

        return Boolean(
            snapshot.userId &&
            snapshot.normalizedCharName &&
            snapshot.token > 0 &&
            Date.now() < Number(this.pendingTransferUntil ?? 0)
        );
    }

    private preserveTransferRecoveryState(snapshot: SessionCleanupSnapshot): void {
        const { GlobalState } = require('./GlobalState') as typeof import('./GlobalState');
        if (!snapshot.userId || !this.character || snapshot.token <= 0) {
            return;
        }

        const currentLevel = String(this.currentLevel || this.character.CurrentLevel?.name || 'NewbieRoad');
        const previousLevel =
            LevelConfig.resolveDungeonEntryLevel(
                currentLevel,
                this.entryLevel || this.character.PreviousLevel?.name || currentLevel,
                this.character
            ) ||
            String(this.entryLevel || this.character.PreviousLevel?.name || currentLevel);
        const entryX = Number.isFinite(Number(this.entryX)) ? Math.round(Number(this.entryX)) : 0;
        const entryY = Number.isFinite(Number(this.entryY)) ? Math.round(Number(this.entryY)) : 0;
        const entity = this.clientEntID > 0 ? this.entities.get(this.clientEntID) : null;
        const newX = Number(entity?.x ?? this.character.CurrentLevel?.x ?? 0);
        const newY = Number(entity?.y ?? this.character.CurrentLevel?.y ?? 0);
        const newHasCoord = Number.isFinite(newX) && Number.isFinite(newY);
        const syncRoomId = Number.isFinite(Number(this.currentRoomId)) && this.currentRoomId >= 0
            ? Math.round(Number(this.currentRoomId))
            : undefined;
        const syncStartedRoomIds = Array.from(this.startedRoomEvents.values())
            .filter((key) => key.startsWith(`${currentLevel}:`))
            .map((key) => Number(key.substring(currentLevel.length + 1)))
            .filter((roomId) => Number.isFinite(roomId) && roomId >= 0)
            .map((roomId) => Math.round(roomId));

        GlobalState.tokenChar.set(snapshot.token, {
            character: this.character,
            userId: snapshot.userId
        });
        GlobalState.usedTransferTokens.set(snapshot.token, {
            character: this.character,
            craftTownHostCharacter: this.currentLevel === 'CraftTown'
                ? this.craftTownHostCharacter ?? undefined
                : undefined,
            userId: snapshot.userId,
            targetLevel: currentLevel,
            levelInstanceId: this.levelInstanceId,
            previousLevel,
            newX: newHasCoord ? Math.round(newX) : undefined,
            newY: newHasCoord ? Math.round(newY) : undefined,
            newHasCoord,
            syncAnchorStartedAt: this.syncAnchorStartedAt > 0 ? this.syncAnchorStartedAt : undefined,
            syncAnchorToken: this.syncAnchorToken > 0 ? this.syncAnchorToken : undefined,
            syncAnchorCharacterName: this.syncAnchorCharacterName || undefined,
            syncEntryLevel: previousLevel,
            syncEntryX: this.entryHasCoord ? entryX : undefined,
            syncEntryY: this.entryHasCoord ? entryY : undefined,
            syncEntryHasCoord: this.entryHasCoord,
            syncRoomId,
            syncStartedRoomIds,
            syncQuestProgress: Number.isFinite(Number(this.character.questTrackerState))
                ? Math.max(0, Math.min(100, Math.round(Number(this.character.questTrackerState))))
                : undefined,
            sourceDoorId: this.lastDoorId >= 0 ? Math.round(Number(this.lastDoorId)) : undefined,
            sourceDoorLevel: LevelConfig.normalizeLevelName(this.currentLevel) || undefined,
            sourceDoorTargetLevel: LevelConfig.normalizeLevelName(this.lastDoorTargetLevel) || undefined,
            playSessionStartedAt: Number.isFinite(this.playSessionStartedAt) && this.playSessionStartedAt > 0
                ? Math.round(this.playSessionStartedAt)
                : undefined
        });
    }

    private repairDungeonLocationBeforeSave(): void {
        if (!this.character) {
            return;
        }

        clearStoredDungeonSnapshot(this.character);

        const safeReturn = LevelConfig.resolveDungeonSafeReturn(
            this.currentLevel || this.character.CurrentLevel?.name,
            this.entryLevel || undefined,
            this.character,
            {
                x: this.entryX,
                y: this.entryY,
                hasCoord: this.entryHasCoord
            }
        );
        if (!safeReturn) {
            return;
        }

        this.character.CurrentLevel = {
            name: safeReturn.level,
            x: safeReturn.x,
            y: safeReturn.y
        };
    }

    private cleanupSessionState(snapshot: SessionCleanupSnapshot, transferInProgress: boolean): void {
        const { GlobalState } = require('./GlobalState') as typeof import('./GlobalState');
        const { EntityHandler } = require('../handlers/EntityHandler') as typeof import('../handlers/EntityHandler');
        const { SocialHandler } = require('../handlers/SocialHandler') as typeof import('../handlers/SocialHandler');

        EntityHandler.removeOwnedEntities(this);
        GlobalState.removeSessionIndexes(this);
        const removedTransferTokens = new Set<number>();

        const sessionTokens = new Set<number>();
        if (snapshot.token > 0) {
            sessionTokens.add(snapshot.token);
        }

        for (const [token, session] of Array.from(GlobalState.sessionsByToken.entries())) {
            if (session === this) {
                sessionTokens.add(token);
            }
        }

        for (const token of sessionTokens) {
            GlobalState.sessionsByToken.delete(token);

            if (!transferInProgress) {
                GlobalState.pendingTeleports.delete(token);
                GlobalState.pendingWorld.delete(token);
                GlobalState.pendingExtended.delete(token);
                GlobalState.usedTransferTokens.delete(token);
                GlobalState.tokenChar.delete(token);
                GlobalState.houseVisits.delete(token);
                removedTransferTokens.add(token);
            }
        }

        if (!transferInProgress && snapshot.userId && snapshot.normalizedCharName) {
            for (const [token, entry] of Array.from(GlobalState.pendingWorld.entries())) {
                const entryCharName = String(entry.character?.name ?? '').trim().toLowerCase();
                if (entry.userId !== snapshot.userId || entryCharName !== snapshot.normalizedCharName) {
                    continue;
                }

                GlobalState.pendingWorld.delete(token);
                GlobalState.pendingExtended.delete(token);
                GlobalState.usedTransferTokens.delete(token);
                GlobalState.tokenChar.delete(token);
                GlobalState.pendingTeleports.delete(token);
                GlobalState.houseVisits.delete(token);
                removedTransferTokens.add(token);
            }

            for (const [token, entry] of Array.from(GlobalState.tokenChar.entries())) {
                const entryCharName = String(entry.character?.name ?? '').trim().toLowerCase();
                if (entry.userId !== snapshot.userId || entryCharName !== snapshot.normalizedCharName) {
                    continue;
                }

                GlobalState.tokenChar.delete(token);
                GlobalState.pendingTeleports.delete(token);
                GlobalState.houseVisits.delete(token);
                removedTransferTokens.add(token);
            }

            for (const [token, entry] of Array.from(GlobalState.usedTransferTokens.entries())) {
                const entryCharName = String(entry.character?.name ?? '').trim().toLowerCase();
                if (entry.userId !== snapshot.userId || entryCharName !== snapshot.normalizedCharName) {
                    continue;
                }

                GlobalState.usedTransferTokens.delete(token);
                removedTransferTokens.add(token);
            }
        }

        if (!transferInProgress && removedTransferTokens.size > 0) {
            for (const token of removedTransferTokens) {
                GlobalState.transferTokenAliases.delete(token);
            }

            for (const [aliasToken, targetToken] of Array.from(GlobalState.transferTokenAliases.entries())) {
                if (removedTransferTokens.has(targetToken)) {
                    GlobalState.transferTokenAliases.delete(aliasToken);
                }
            }
        }

        for (const [userId, session] of Array.from(GlobalState.sessionsByUserId.entries())) {
            if (session === this) {
                GlobalState.sessionsByUserId.delete(userId);
            }
        }

        for (const [characterKey, session] of Array.from(GlobalState.sessionsByCharacterName.entries())) {
            if (session === this) {
                GlobalState.sessionsByCharacterName.delete(characterKey);
            }
        }

        SocialHandler.handleSessionClose(this, transferInProgress);

        if (!transferInProgress) {
            const { DungeonCompletionSystem } = require('./DungeonCompletionSystem') as typeof import('./DungeonCompletionSystem');
            DungeonCompletionSystem.releaseParticipant(this);
        }

        this.clearGameplayState();
        this.clearIdentityState();
    }

    public async resetForLoginCycle(reason: string, options?: { persistSnapshot?: boolean }): Promise<void> {
        if (!this.hasReusableSessionState()) {
            return;
        }

        const snapshot = this.createSessionCleanupSnapshot();
        const persistSnapshot = options?.persistSnapshot !== false;

        if (persistSnapshot && snapshot.userId && this.character) {
            if (this.deferredCharacterSaveTimer) {
                clearTimeout(this.deferredCharacterSaveTimer);
                this.deferredCharacterSaveTimer = null;
            }
            RegionPositionPersistence.record(
                this,
                this.clientEntID > 0 ? this.entities.get(this.clientEntID) : null,
                'disconnect',
                { force: true, persist: false }
            );
            RegionPositionPersistence.forget(this);
            this.repairDungeonLocationBeforeSave();
            await db.saveCharacterSnapshot(snapshot.userId, this.character).catch((err) => {
                console.error(`[Client] Failed to persist character before ${reason}:`, err);
            });
        }

        this.cleanupSessionState(snapshot, false);

        console.log(
            `[Client] Reset for ${reason}: userId=${snapshot.userId ?? 0} authenticated=${snapshot.authenticated} char=${snapshot.characterName || '(none)'} token=${snapshot.token}`
        );
    }

    private onEnd(): void {
        const addr = `${this.socket.remoteAddress}:${this.socket.remotePort}`;
        console.log(
            `[Client] Socket ended: ${addr} bytesIn=${this.rawBytesIn} bytesOut=${this.rawBytesOut} authenticated=${this.authenticated}`
        );
    }

    private onClose(hadError: boolean): void {
        const { GlobalState } = require('./GlobalState') as typeof import('./GlobalState');
        const addr = `${this.socket.remoteAddress}:${this.socket.remotePort}`;
        const snapshot = this.createSessionCleanupSnapshot();
        GlobalState.clients.delete(this);

        if (snapshot.userId && this.character) {
            if (this.deferredCharacterSaveTimer) {
                clearTimeout(this.deferredCharacterSaveTimer);
                this.deferredCharacterSaveTimer = null;
            }
            // Record where they actually were before the snapshot goes out. Without this the
            // only writers of CurrentLevel are the dungeon-return and transfer paths, so an
            // ordinary disconnect persisted a stale coordinate and the next login dropped the
            // player in mid-air. persist:false because the save on the next line covers it.
            RegionPositionPersistence.record(
                this,
                this.clientEntID > 0 ? this.entities.get(this.clientEntID) : null,
                'disconnect',
                { force: true, persist: false }
            );
            RegionPositionPersistence.forget(this);
            this.repairDungeonLocationBeforeSave();
            void db.saveCharacterSnapshot(snapshot.userId, this.character).catch((err) => {
                console.error('[Client] Failed to persist character on disconnect:', err);
            });
        }
        const transferInProgress = this.isTransferInProgressOnClose(snapshot);
        if (transferInProgress) {
            this.preserveTransferRecoveryState(snapshot);
        }

        this.cleanupSessionState(snapshot, transferInProgress);

        console.log(
            `[Client] Disconnected: ${addr} hadError=${hadError} bytesIn=${this.rawBytesIn} bytesOut=${this.rawBytesOut} authenticated=${snapshot.authenticated} token=${snapshot.token} char=${snapshot.characterName || '(none)'}`
        );
    }

    private onError(err: Error): void {
        const socketError = err as NodeJS.ErrnoException;
        if (socketError.code && Client.QUIET_SOCKET_ERROR_CODES.has(socketError.code)) {
            return;
        }

        const addr = `${this.socket.remoteAddress}:${this.socket.remotePort}`;
        console.error(`[Client] Error from ${addr}:`, err);
    }
}
