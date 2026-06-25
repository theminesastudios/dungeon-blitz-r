import * as net from 'net';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { PacketRouter } from '../network/packetRouter';
import { UserAccount, Character } from '../database/Database';
import { JsonAdapter } from '../database/JsonAdapter';
import { DebugLogger } from './Debug';
import type { DungeonRunStats } from './DungeonRunStats';
import { clearStoredDungeonSnapshot } from './DungeonSnapshot';
import { LevelConfig } from './LevelConfig';

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
    private static readonly QUIET_SOCKET_ERROR_CODES = new Set([
        'ECONNABORTED',
        'ECONNRESET',
        'EPIPE'
    ]);

    public socket: net.Socket;
    public router: PacketRouter;
    private buffer: Buffer;
    private packetQueue: Promise<void>;
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
    public token: number = 0;
    public clientEntID: number = 0;
    public entities: Map<number, any> = new Map();
    public currentLevel: string = "";
    public craftTownHostCharacter: Character | null = null;
    public levelInstanceId: string = "";
    public entryLevel: string = "";
    public entryX: number = 0;
    public entryY: number = 0;
    public entryHasCoord: boolean = false;
    public currentRoomId: number = -1;
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
    public mountTransferGraceUntil: number = 0;
    public startedRoomEvents: Set<string> = new Set();
    public knownEntityIds: Set<number> = new Set();
    public entityIdAliases: Map<number, number> = new Map();
    public sharedEntityRemoteUpdateDeferredIds: Set<number> = new Set();
    public pendingLoot: Map<number, PendingLootDrop> = new Map();
    public processedRewardSources: Set<string> = new Set();
    public triggeredLevelStates: Set<string> = new Set();
    public dungeonRun: DungeonRunStats | null = null;
    public pendingMissionTurnIns: Set<number> = new Set();
    public authoritativeMaxHp: number = 100;
    public authoritativeCurrentHp: number = 100;
    public combatStatsDirty: boolean = false;
    public allowDirtyCombatStatsRegen: boolean = false;
    public lastCombatStatsRefreshRequestAt: number = 0;
    public lastCombatStatsSyncedAt: number = 0;
    public pendingRespawnRequest: { usePotion: boolean; requestedAt: number } | null = null;
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
    public forcedDungeonCompletionScope: string = "";
    public finalizingDungeonCompletionScope: string = "";
    public completedDungeonCompletionScope: string = "";
    public completedDungeonCompletionSentAt: number = 0;
    public pendingDungeonCompletionScope: string = "";
    public pendingDungeonCompletionRequestedAt: number = 0;
    public pendingDungeonCompletionLastSkitAt: number = 0;
    public pendingDungeonCompletionNotBeforeAt: number = 0;
    public pendingDungeonCompletionSettleMs: number = 0;
    public pendingDungeonCompletionPayload: Buffer | null = null;
    public pendingDungeonCompletionForceSharedScope: string = "";
    public pendingDungeonCompletionTimer: NodeJS.Timeout | null = null;
    public pendingDungeonCompletionFlushActive: boolean = false;
    public pendingDungeonCompletionWaitForCutsceneEnd: boolean = false;
    public deferredCharacterSaveTimer: NodeJS.Timeout | null = null;
    public deferredCharacterSaveReason: string = "";
    public activeDungeonCutsceneScope: string = "";
    public activeDungeonCutsceneRoomId: number = 0;
    public lastDungeonCutsceneStartScope: string = "";
    public lastDungeonCutsceneStartAt: number = 0;
    public lastDungeonCutsceneEndScope: string = "";
    public lastDungeonCutsceneEndAt: number = 0;

    constructor(socket: net.Socket, router: PacketRouter) {
        this.socket = socket;
        this.router = router;
        this.buffer = Buffer.alloc(0);
        this.packetQueue = Promise.resolve();
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
            DebugLogger.logPacket('IN', this, packetId, payload);

            this.packetQueue = this.packetQueue
                .then(() => this.router.handle(this, packetId, payload))
                .catch((err: unknown) => {
                    console.error(`[Client] Error handling packet 0x${packetId.toString(16)}:`, err);
                });
        }
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
        DebugLogger.logPacket('OUT', this, packetId, buffer);
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

        this.deferredCharacterSaveReason = reason;
        if (this.deferredCharacterSaveTimer) {
            clearTimeout(this.deferredCharacterSaveTimer);
        }

        const safeDelay = this.resolveDeferredCharacterSaveDelay(reason, delayMs);
        this.deferredCharacterSaveTimer = setTimeout(() => {
            this.deferredCharacterSaveTimer = null;
            const userId = this.userId;
            const character = this.character;
            if (!userId || !character) {
                return;
            }

            void db.saveCharacterSnapshot(userId, character).then((characters) => {
                if (this.userId === userId && this.character === character) {
                    this.characters = characters;
                }
            }).catch((err) => {
                console.error(`[Client] Deferred character save failed after ${this.deferredCharacterSaveReason || reason}:`, err);
            });
        }, safeDelay);
        this.deferredCharacterSaveTimer.unref?.();
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
        this.mountTransferGraceUntil = 0;
        this.startedRoomEvents.clear();
        this.knownEntityIds.clear();
        this.entityIdAliases.clear();
        this.sharedEntityRemoteUpdateDeferredIds.clear();
        this.pendingLoot.clear();
        this.processedRewardSources.clear();
        this.dungeonRun = null;
        this.pendingMissionTurnIns.clear();
        this.authoritativeMaxHp = 100;
        this.authoritativeCurrentHp = 100;
        this.combatStatsDirty = false;
        this.allowDirtyCombatStatsRegen = false;
        this.lastCombatStatsRefreshRequestAt = 0;
        this.lastCombatStatsSyncedAt = 0;
        this.pendingRespawnRequest = null;
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
        this.forcedDungeonCompletionScope = "";
        this.finalizingDungeonCompletionScope = "";
        this.completedDungeonCompletionScope = "";
        this.completedDungeonCompletionSentAt = 0;
        this.pendingDungeonCompletionScope = "";
        this.pendingDungeonCompletionRequestedAt = 0;
        this.pendingDungeonCompletionLastSkitAt = 0;
        this.pendingDungeonCompletionNotBeforeAt = 0;
        this.pendingDungeonCompletionSettleMs = 0;
        this.pendingDungeonCompletionPayload = null;
        this.pendingDungeonCompletionForceSharedScope = "";
        if (this.pendingDungeonCompletionTimer) {
            clearTimeout(this.pendingDungeonCompletionTimer);
            this.pendingDungeonCompletionTimer = null;
        }
        this.pendingDungeonCompletionFlushActive = false;
        this.pendingDungeonCompletionWaitForCutsceneEnd = false;
        this.activeDungeonCutsceneScope = "";
        this.activeDungeonCutsceneRoomId = 0;
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

        if (snapshot.userId && this.character) {
            if (this.deferredCharacterSaveTimer) {
                clearTimeout(this.deferredCharacterSaveTimer);
                this.deferredCharacterSaveTimer = null;
            }
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
